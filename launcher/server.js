import http from "http";
import httpProxy from "http-proxy";
import { execFile } from "node:child_process";

const PORT = 8000;
const IDLE_SECONDS = +(process.env.IDLE_SECONDS || 600);
const START_TIMEOUT = +(process.env.START_TIMEOUT_SECONDS || 120);
const VLLM_API_KEY = process.env.VLLM_API_KEY || "";

const MAP = {}; // path prefix => {container, port}
for (const [k, v] of Object.entries(process.env)) {
  // ENV like MAP__coder__container, MAP__coder__port
  const m = k.match(/^MAP__([^_]+)__(container|port)$/);
  if (!m) continue;
  const key = m[1]; const field = m[2];
  MAP[key] ??= {};
  MAP[key][field] = v;
}

const proxy = httpProxy.createProxyServer({});
const lastHit = new Map(); // container -> timestamp
const ALL_CONTAINERS = new Set(
  Object.values(MAP)
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
async function isRunning(name){
  const out = await sh("docker", ["ps","--format","{{.Names}}"]);
  return out.split("\n").some(n=>n===name);
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
async function waitHealthy(host, port){
  const deadline = Date.now() + START_TIMEOUT*1000;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(`http://${host}:${port}/v1/models`, {
        headers: VLLM_API_KEY ? { "Authorization": `Bearer ${VLLM_API_KEY}` } : {}
      });
      if (ok.ok) return;
    } catch {}
    await new Promise(r=>setTimeout(r, 1000));
  }
  throw new Error("Backend not healthy in time");
}

// Idle reaper
setInterval(async ()=>{
  const t = now();
  for (const [container, ts] of Array.from(lastHit.entries())) {
    if (t - ts > IDLE_SECONDS) {
      try { await stopContainer(container); } catch {}
      lastHit.delete(container);
    }
  }
}, 30_000);

function pickTarget(urlPath){
  const seg = (urlPath.split("/")[1]||"").toLowerCase();
  return { seg, target: MAP[seg] }; // include the matched prefix
}

class Mutex {
  constructor() { this.locked = false; this.waiters = []; }
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

const startMutex = new Mutex();

async function ensureExclusive(container, port) {
  await startMutex.runExclusive(async () => {
    const running = await listRunningContainers();
    for (const name of running) {
      if (name !== container && ALL_CONTAINERS.has(name)) {
        await stopContainer(name);
        lastHit.delete(name);
      }
    }
    if (!running.includes(container)) {
      await startContainer(container);
      await waitHealthy(container, port);
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const picked = pickTarget(req.url);
    if (!picked || !picked.target) {
      res.writeHead(404); return res.end("unknown route");
    }
    const { seg, target } = picked;
    const { container, port } = target;

    // ensure only this backend is running
    await ensureExclusive(container, port);

    // strip the first path segment (/chat, /coder, /qwen7b)
    const original = req.url;
    const prefix = `/${seg}`;
    let rewritten = original.startsWith(prefix) ? original.slice(prefix.length) : original;
    if (!rewritten.startsWith("/")) rewritten = "/" + rewritten;
    req.url = rewritten; // e.g., "/v1/chat/completions"

    lastHit.set(container, now());

    // forward auth header (inject if missing)
    const headers = { ...req.headers };
    if (VLLM_API_KEY && !headers.authorization) {
      headers.authorization = `Bearer ${VLLM_API_KEY}`;
    }

    proxy.web(req, res, {
      target: `http://${container}:${port}`,
      headers
    });
  } catch (e) {
    res.writeHead(502); res.end(`launch error: ${e.message}`);
  }
});

server.listen(PORT, ()=>console.log(`launcher on :${PORT} → /coder|/chat|/qwen7b`));
