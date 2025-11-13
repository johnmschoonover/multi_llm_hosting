import http from "http";
import httpProxy from "http-proxy";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const PORT = 8000;
const IDLE_SECONDS = +(process.env.IDLE_SECONDS || 600);
const START_TIMEOUT = +(process.env.START_TIMEOUT_SECONDS || 120);
const VLLM_API_KEY = process.env.VLLM_API_KEY || "";
const DOCKER_SOCKET = process.env.DOCKER_HOST_SOCKET || "/var/run/docker.sock";
const PREWARM_ROUTES = (process.env.PREWARM_ROUTES || "")
  .split(",")
  .map((token) => token.trim().toLowerCase())
  .filter(Boolean);
const SERVER_STARTED_AT = Math.floor(Date.now() / 1000);
const JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MiB
const JSON_BODY_TIMEOUT_MS = 10_000;

const logger = {
  info: (...msg) => console.log(new Date().toISOString(), "[INFO]", ...msg),
  warn: (...msg) => console.warn(new Date().toISOString(), "[WARN]", ...msg),
  error: (...msg) => console.error(new Date().toISOString(), "[ERROR]", ...msg),
};

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function buildRouteMap(env = process.env) {
  const map = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^MAP__([^_]+)__(container|port|health|auth|models)$/);
    if (!m) continue;
    const key = m[1];
    const field = m[2];
    map[key] ??= {};
    map[key][field] = field === "models" ? parseList(v) : v;
  }
  return map;
}

const ROUTE_MAP = buildRouteMap();

const proxy = httpProxy.createProxyServer({});
const lastHit = new Map();
export const startMetrics = new Map();
const trackedContainers = new Set(
  Object.values(ROUTE_MAP)
    .map((entry) => entry?.container)
    .filter(Boolean),
);

function defaultModelsForRoute(route, meta = {}) {
  if (Array.isArray(meta.models) && meta.models.length) {
    return meta.models;
  }
  if (meta.container) return [meta.container];
  return [route];
}

export function buildModelIndex(routeMap, { logger: loggerRef = logger } = {}) {
  const modelToRoute = new Map();
  const metadata = [];
  for (const [route, meta] of Object.entries(routeMap)) {
    const finalModels = defaultModelsForRoute(route, meta);
    meta.models = finalModels;
    for (const modelId of finalModels) {
      if (modelToRoute.has(modelId)) {
        const previous = modelToRoute.get(modelId);
        loggerRef.warn(`Model ${modelId} already mapped to /${previous}; overriding to /${route}`);
      }
      modelToRoute.set(modelId, route);
      metadata.push({
        id: modelId,
        route,
        container: meta.container,
        ownedBy: meta.container || "lazy-launcher",
      });
    }
  }
  return { modelToRoute, metadata };
}

const { modelToRoute: MODEL_TO_ROUTE, metadata: MODEL_METADATA } = buildModelIndex(ROUTE_MAP, { logger });

function now() { return Math.floor(Date.now() / 1000); }

function dockerRequest(pathname, {
  method = "GET",
  body,
  headers = {},
  allowedStatus,
} = {}) {
  const payload = typeof body === "string" ? body : body ? JSON.stringify(body) : null;
  const reqHeaders = { ...headers };
  if (payload) {
    reqHeaders["Content-Type"] ??= "application/json";
    reqHeaders["Content-Length"] = Buffer.byteLength(payload);
  }
  const validStatus = allowedStatus || [200, 201, 202, 204];
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      path: pathname,
      method,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (validStatus.includes(status)) {
          resolve({ statusCode: status, body: text });
          return;
        }
        reject(new Error(`Docker API ${method} ${pathname} failed: ${status} ${text}`));
      });
    });
    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function listRunningContainers() {
  const filters = encodeURIComponent(JSON.stringify({ status: ["running"] }));
  const { body } = await dockerRequest(`/containers/json?filters=${filters}`);
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return parsed
      .map((item) => (item.Names?.[0] || "").replace(/^\//, ""))
      .filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to parse Docker list response: ${err.message}`);
  }
}

async function startContainer(name) {
  const encoded = encodeURIComponent(name);
  await dockerRequest(`/containers/${encoded}/start`, {
    method: "POST",
    allowedStatus: [204, 304],
  });
}

async function stopContainer(name) {
  const encoded = encodeURIComponent(name);
  await dockerRequest(`/containers/${encoded}/stop`, {
    method: "POST",
    allowedStatus: [204, 304],
  });
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
  startMetricsMap = startMetrics,
  now: nowFn = () => Date.now(),
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
        const startedAt = nowFn();
        await startFn(container);
        await waitFn(target);
        const finishedAt = nowFn();
        const duration = finishedAt - startedAt;
        loggerRef.info(`${container} ready on ${port} after ${duration}ms`);
        const existing = startMetricsMap.get(container) || {
          totalDurationMs: 0,
          startCount: 0,
        };
        const updated = {
          totalDurationMs: existing.totalDurationMs + duration,
          startCount: existing.startCount + 1,
          lastDurationMs: duration,
          lastStartedAt: finishedAt,
        };
        startMetricsMap.set(container, updated);
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
  startMetricsMap: startMetrics,
  logger,
});

function rewritePath(original, seg) {
  const prefix = `/${seg}`;
  let rewritten = original.startsWith(prefix) ? original.slice(prefix.length) : original;
  if (!rewritten.startsWith("/")) rewritten = "/" + rewritten;
  return rewritten;
}

function normalizeRoutes(routeMap) {
  return Object.entries(routeMap).map(([route, meta]) => ({
    route,
    container: meta.container,
    port: meta.port,
    health: normalizeHealthPath(meta.health),
    auth: meta.auth || "inject", // default behavior injects auth
    models: meta.models || [],
  }));
}

function respondJson(res, statusCode, payload) {
  if (!res.headersSent) {
    res.writeHead(statusCode, { "content-type": "application/json" });
  }
  res.end(JSON.stringify(payload));
}

export function readRequestBody(req, {
  limit = JSON_BODY_LIMIT_BYTES,
  timeoutMs = JSON_BODY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      const err = new Error("body_timeout");
      err.code = "BODY_TIMEOUT";
      reject(err);
      req.destroy(err);
    }, timeoutMs);
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        cleanup();
        const err = new Error("body_too_large");
        err.code = "BODY_TOO_LARGE";
        err.limit = limit;
        reject(err);
        req.destroy(err);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err) => {
      if (done) return;
      cleanup();
      reject(err);
    };
    const onAborted = () => {
      if (done) return;
      cleanup();
      const err = new Error("body_aborted");
      err.code = "BODY_ABORTED";
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function prepareForwardHeaders(originalHeaders = {}, bodyLength, target) {
  const headers = { ...(originalHeaders || {}) };
  delete headers.host;
  delete headers["content-length"];
  headers.host = target.container;
  headers["content-length"] = bodyLength;
  const shouldInjectAuth = target?.auth !== "passthrough";
  if (shouldInjectAuth && VLLM_API_KEY && !headers.authorization) {
    headers.authorization = `Bearer ${VLLM_API_KEY}`;
  }
  return headers;
}

function forwardOpenAIRequest({
  method,
  path,
  bodyBuffer,
  headers,
  target,
  res,
}) {
  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      hostname: target.container,
      port: target.port,
      path,
      method,
      headers,
    }, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      }
      proxyRes.pipe(res);
      proxyRes.on("end", resolve);
    });
    proxyReq.on("error", (err) => reject(err));
    res.once("close", () => proxyReq.destroy());
    proxyReq.end(bodyBuffer);
  });
}

export function createOpenAIHandler({
  routeMap = ROUTE_MAP,
  modelToRoute = MODEL_TO_ROUTE,
  metadata = MODEL_METADATA,
  ensureExclusiveFn = ensureExclusive,
  lastHitMap = lastHit,
  readBody = readRequestBody,
  forwardRequest = forwardOpenAIRequest,
  logger: loggerRef = logger,
  now: nowFn = now,
} = {}) {
  const modelsPayload = {
    object: "list",
    data: metadata.map((entry) => ({
      object: "model",
      id: entry.id,
      created: SERVER_STARTED_AT,
      owned_by: entry.ownedBy,
    })),
  };

  async function handleProxy(req, res, forwardSuffix, search = "") {
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (err?.code === "BODY_TOO_LARGE") {
        respondJson(res, 413, { error: { message: "body_too_large" } });
      } else if (err?.code === "BODY_TIMEOUT") {
        respondJson(res, 408, { error: { message: "body_timeout" } });
      } else if (err?.code === "BODY_ABORTED") {
        respondJson(res, 400, { error: { message: "request_aborted" } });
      } else {
        respondJson(res, 400, { error: { message: "body_read_failed" } });
      }
      return true;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody || "{}");
    } catch (err) {
      respondJson(res, 400, { error: { message: "invalid_json" } });
      return true;
    }
    const modelId = parsed?.model;
    if (!modelId || typeof modelId !== "string") {
      respondJson(res, 400, { error: { message: "missing_model" } });
      return true;
    }
    const route = modelToRoute.get(modelId);
    if (!route) {
      respondJson(res, 400, { error: { message: `unknown_model:${modelId}` } });
      return true;
    }
    const target = routeMap[route];
    if (!target) {
      respondJson(res, 502, { error: { message: "route_unavailable" } });
      return true;
    }
    try {
      await ensureExclusiveFn(target);
    } catch (err) {
      loggerRef.error(`Failed to ensure exclusive access for ${route}: ${err.message}`);
      respondJson(res, 502, { error: { message: "launcher_busy" } });
      return true;
    }
    lastHitMap.set(target.container, nowFn());
    const bodyBuffer = Buffer.from(rawBody, "utf8");
    const headers = prepareForwardHeaders(req.headers || {}, bodyBuffer.length, target);
    const path = `${forwardSuffix}${search || ""}`;
    try {
      await forwardRequest({
        method: req.method || "POST",
        path,
        bodyBuffer,
        headers,
        target,
        res,
      });
    } catch (err) {
      loggerRef.error(`OpenAI proxy error (${route}): ${err.message}`);
      respondJson(res, 502, { error: { message: "openai_proxy_failed" } });
      return true;
    }
    return true;
  }

  return async function openAIHandler(req, res) {
    if (!req.url) return false;
    const { pathname, search } = new URL(req.url, "http://launcher.local");
    if (req.method === "GET" && pathname === "/openai/v1/models") {
      respondJson(res, 200, modelsPayload);
      return true;
    }
    if (req.method === "POST" && pathname === "/openai/v1/chat/completions") {
      return handleProxy(req, res, "/v1/chat/completions", search);
    }
    if (req.method === "POST" && pathname === "/openai/v1/images/generations") {
      return handleProxy(req, res, "/v1/images/generations", search);
    }
    return false;
  };
}

export function createAdminHandler({
  routeMap = ROUTE_MAP,
  listRunningContainers: listFn = listRunningContainers,
  lastHitMap = lastHit,
  startMetricsMap = startMetrics,
  logger: loggerRef = logger,
} = {}) {
  const normalizedRoutes = normalizeRoutes(routeMap);
  return async function adminHandler(req, res) {
    if (!req.url) return false;
    const { pathname } = new URL(req.url, "http://launcher.local");
    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", routes: normalizedRoutes.length }));
      return true;
    }
    if (req.method === "GET" && pathname === "/routes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ routes: normalizedRoutes }));
      return true;
    }
    if (req.method === "GET" && pathname === "/stats") {
      try {
        const running = await listFn();
        const hits = Object.fromEntries(
          Array.from(lastHitMap.entries()).map(([container, ts]) => [
            container,
            new Date(ts * 1000).toISOString(),
          ]),
        );
        const metrics = Object.fromEntries(
          Array.from(startMetricsMap.entries()).map(([container, meta]) => [
            container,
            {
              averageDurationMs:
                meta.startCount > 0 ? meta.totalDurationMs / meta.startCount : 0,
              lastDurationMs: meta.lastDurationMs ?? null,
              lastStartedAt: meta.lastStartedAt
                ? new Date(meta.lastStartedAt).toISOString()
                : null,
              startCount: meta.startCount,
            },
          ]),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            runningContainers: running,
            lastHits: hits,
            startMetrics: metrics,
          }),
        );
        return true;
      } catch (err) {
        loggerRef.warn(`Failed to build stats response: ${err.message}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stats_unavailable" }));
        return true;
      }
    }
    return false;
  };
}

const adminHandler = createAdminHandler({
  routeMap: ROUTE_MAP,
  listRunningContainers,
  lastHitMap: lastHit,
  startMetricsMap: startMetrics,
  logger,
});

const openAIHandler = createOpenAIHandler({
  routeMap: ROUTE_MAP,
  modelToRoute: MODEL_TO_ROUTE,
  metadata: MODEL_METADATA,
  ensureExclusiveFn: ensureExclusive,
  lastHitMap: lastHit,
  logger,
});

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
      if (await adminHandler(req, res)) {
        return;
      }
      if (await openAIHandler(req, res)) {
        return;
      }
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
  if (PREWARM_ROUTES.length) {
    (async () => {
      for (const route of PREWARM_ROUTES) {
        const target = ROUTE_MAP[route];
        if (!target) {
          logger.warn(`Skipping unknown prewarm route: ${route}`);
          continue;
        }
        try {
          logger.info(`Prewarming /${route}`);
          await ensureExclusive(target);
          lastHit.set(target.container, now());
          logger.info(`Prewarm complete for /${route}`);
        } catch (err) {
          logger.warn(`Prewarm failed for /${route}: ${err.message}`);
        }
      }
    })();
  }
  return server;
}

if (process.argv[1] === path.resolve(__filename)) {
  startServer();
}
