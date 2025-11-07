import http from "http";
import httpProxy from "http-proxy";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const PORT = 8000;
const IDLE_SECONDS = +(process.env.IDLE_SECONDS || 600);
const START_TIMEOUT = +(process.env.START_TIMEOUT_SECONDS || 120);
const VLLM_API_KEY = process.env.VLLM_API_KEY || "";

const logger = {
  info: (...msg) => console.log(new Date().toISOString(), "[INFO]", ...msg),
  warn: (...msg) => console.warn(new Date().toISOString(), "[WARN]", ...msg),
  error: (...msg) => console.error(new Date().toISOString(), "[ERROR]", ...msg),
};

export function buildRouteMap(env = process.env) {
  const map = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^MAP__([^_]+)__(container|port|health|auth)$/);
    if (!m) continue;
    const key = m[1];
    const field = m[2];
    map[key] ??= {};
    map[key][field] = v;
  }
  return map;
}

const ROUTE_MAP = buildRouteMap();

const proxy = httpProxy.createProxyServer({});
const lastHit = new Map();
const trackedContainers = new Set(
  Object.values(ROUTE_MAP)
    .map((entry) => entry?.container)
    .filter(Boolean),
);

function now() { return Math.floor(Date.now()/1000); }
function sh(cmd, args=[]) {
  return new Promise((resolve,reject)=>{
    execFile(cmd,args,{maxBuffer:1024*1024},(e,stdout,stderr)=>{
      if(e) return reject(new Error(stderr||e.message));
      resolve(stdout.trim());
    });
  });
}
async function listRunningContainers(){
  const out = await sh("docker", ["ps","--format","{{.Names}}"]);
  return out ? out.split("\n").filter(Boolean) : [];
}
async function startContainer(name){
  await sh("docker", ["start", name]);
}
async function stopContainer(name){
  await sh("docker", ["stop", name]);
}
function normalizeHealthPath(path) {
  if (!path) return "/v1/models";
  return path.startsWith("/") ? path : `/${path}`;
}

async function waitHealthy(target){
  const { container: host, port, health, auth } = target;
  const path = normalizeHealthPath(health);
  const deadline = Date.now() + START_TIMEOUT*1000;
  while (Date.now() < deadline) {
    try {
      const headers = (VLLM_API_KEY && auth !== "passthrough")
        ? { "Authorization": `Bearer ${VLLM_API_KEY}` }
        : {};
      const ok = await fetch(`http://${host}:${port}${path}`, {
        headers,
      });
      if (ok.ok) {
        logger.info(`Backend ${host}:${port} healthy`);
        return;
      }
    } catch (err) {
      logger.warn(`Health probe failed for ${host}:${port}: ${err.message}`);
    }
    await new Promise(r=>setTimeout(r, 1000));
  }
  throw new Error("Backend not healthy in time");
}

function startIdleReaper() {
  return setInterval(async ()=>{
    const t = now();
    for (const [container, ts] of Array.from(lastHit.entries())) {
      if (t - ts > IDLE_SECONDS) {
        try {
          logger.info(`Idle timeout reached, stopping ${container}`);
          await stopContainer(container);
        } catch (err) {
          logger.warn(`Failed to stop idle container ${container}: ${err.message}`);
        }
        lastHit.delete(container);
      }
    }
  }, 30_000);
}

export function pickTarget(urlPath, map = ROUTE_MAP){
  const seg = (urlPath.split("/")[1]||"").toLowerCase();
  return { seg, target: map[seg] };
}

export class Mutex {
  constructor(loggerRef = logger) { this.locked = false; this.waiters = []; this.logger = loggerRef; }
  async runExclusive(fn) {
    await this._acquire();
    try { return await fn(); }
    finally { this._release(); }
  }
  _acquire() {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve)).then(()=>this._acquire());
  }
  _release() {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export function createEnsureExclusive({
  listRunningContainers: listFn,
  stopContainer: stopFn,
  startContainer: startFn,
  waitHealthy: waitFn,
  trackedContainers: tracked,
  lastHitMap,
  logger: loggerRef = logger,
}) {
  const startMutex = new Mutex(loggerRef);
  return async function ensureExclusive(target) {
    const { container, port, health } = target;
    await startMutex.runExclusive(async () => {
      loggerRef.info(`Ensuring exclusive access for ${container}`);
      const running = await listFn();
      for (const name of running) {
        if (name !== container && tracked.has(name)) {
          loggerRef.info(`Stopping ${name} before starting ${container}`);
          await stopFn(name);
          lastHitMap.delete(name);
        }
      }
      if (!running.includes(container)) {
        loggerRef.info(`Starting ${container} on port ${port}`);
        await startFn(container);
        await waitFn(target);
        loggerRef.info(`${container} ready on ${port}`);
      } else {
        loggerRef.info(`${container} already running; skipping start`);
      }
    });
  };
}

const ensureExclusive = createEnsureExclusive({
  listRunningContainers,
  stopContainer,
  startContainer,
  waitHealthy,
  trackedContainers,
  lastHitMap: lastHit,
  logger,
});

function rewritePath(original, seg) {
  const prefix = `/${seg}`;
  let rewritten = original.startsWith(prefix) ? original.slice(prefix.length) : original;
  if (!rewritten.startsWith("/")) rewritten = "/" + rewritten;
  return rewritten;
}

function createServer() {
  proxy.removeAllListeners("error");
  proxy.on("error", (err, req, res) => {
    logger.error(`Proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end(`launch error: ${err.message}`);
  });

  return http.createServer(async (req, res) => {
    const requestStart = Date.now();
    try {
      const picked = pickTarget(req.url);
      if (!picked || !picked.target) {
        res.writeHead(404); return res.end("unknown route");
      }
      const { seg, target } = picked;
      const { container, port } = target;
      logger.info(`Proxying ${req.method} ${req.url} via ${seg} (${container})`);

      await ensureExclusive(target);

      const rewritten = rewritePath(req.url, seg);
      req.url = rewritten;
      lastHit.set(container, now());

      const headers = { ...req.headers };
      const shouldInjectAuth = target?.auth !== "passthrough";
      if (shouldInjectAuth && VLLM_API_KEY && !headers.authorization) {
        headers.authorization = `Bearer ${VLLM_API_KEY}`;
      }

      proxy.web(req, res, {
        target: `http://${container}:${port}`,
        headers
      });

      res.once("finish", () => {
        logger.info(`Served ${seg} request in ${Date.now() - requestStart}ms`);
      });
    } catch (e) {
      logger.error(`Launcher error: ${e.message}`);
      res.writeHead(502); res.end(`launch error: ${e.message}`);
    }
  });
}

export function startServer() {
  const server = createServer();
  const timer = process.env.LAUNCHER_DISABLE_IDLE_REAPER ? null : startIdleReaper();
  server.once("close", () => {
    if (timer) clearInterval(timer);
  });
  const routes = Object.keys(ROUTE_MAP).sort();
  const prettyRoutes = routes.map((r) => `/${r}`).join(" ");
  server.listen(PORT, ()=>logger.info(`launcher on :${PORT} → ${prettyRoutes || "(no routes)"}`));
  return server;
}

if (process.argv[1] === path.resolve(__filename)) {
  startServer();
}
