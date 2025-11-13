import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteMap,
  pickTarget,
  Mutex,
  createEnsureExclusive,
  createAdminHandler,
  buildModelIndex,
  createOpenAIHandler,
} from "./server.js";

const noopLogger = { info() {}, warn() {}, error() {} };

test("buildRouteMap collects prefixed env vars", () => {
  const env = {
    MAP__chat__container: "sitechat",
    MAP__chat__port: "8002",
    MAP__coder__container: "coder3b",
    MAP__vision__health: "/healthz",
    MAP__vision__auth: "passthrough",
    MAP__vision__models: "vision-diffusion,sd15",
  };
  const map = buildRouteMap(env);
  assert.deepEqual(map.chat, { container: "sitechat", port: "8002" });
  assert.deepEqual(map.coder, { container: "coder3b" });
  assert.deepEqual(map.vision, { health: "/healthz", auth: "passthrough", models: ["vision-diffusion", "sd15"] });
});

test("pickTarget returns matching route metadata", () => {
  const map = {
    chat: { container: "sitechat", port: "8002" },
  };
  const picked = pickTarget("/chat/v1/models", map);
  assert.equal(picked.seg, "chat");
  assert.equal(picked.target.container, "sitechat");
});

test("Mutex serializes concurrent work", async () => {
  const mutex = new Mutex(noopLogger);
  const order = [];
  await Promise.all([
    mutex.runExclusive(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 25));
      order.push(2);
    }),
    mutex.runExclusive(async () => {
      order.push(3);
      order.push(4);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("ensureExclusive stops other containers before serving target", async () => {
  const calls = [];
  const ensureExclusive = createEnsureExclusive({
    listRunningContainers: async () => ["coder3b", "sitechat"],
    stopContainer: async (name) => calls.push(`stop:${name}`),
    startContainer: async (name) => calls.push(`start:${name}`),
    waitHealthy: async () => calls.push("wait"),
    trackedContainers: new Set(["coder3b", "sitechat"]),
    lastHitMap: new Map([["coder3b", Date.now()]]),
    startMetricsMap: new Map(),
    logger: noopLogger,
  });

  await ensureExclusive({ container: "sitechat", port: 8002, health: "/status" });
  assert.deepEqual(calls, ["stop:coder3b"]);
});

test("ensureExclusive starts target when not already running", async () => {
  const calls = [];
  const ensureExclusive = createEnsureExclusive({
    listRunningContainers: async () => ["coder3b"],
    stopContainer: async (name) => calls.push(`stop:${name}`),
    startContainer: async (name) => calls.push(`start:${name}`),
    waitHealthy: async (target) => calls.push(`wait:${target.health ?? "/v1/models"}`),
    trackedContainers: new Set(["coder3b", "sitechat"]),
    lastHitMap: new Map([["coder3b", Date.now()]]),
    startMetricsMap: new Map(),
    logger: noopLogger,
  });

  await ensureExclusive({ container: "sitechat", port: 8002 });
  assert.deepEqual(calls, ["stop:coder3b", "start:sitechat", "wait:/v1/models"]);
});

test("ensureExclusive skips start when target already running alone", async () => {
  const calls = [];
  const ensureExclusive = createEnsureExclusive({
    listRunningContainers: async () => ["sitechat"],
    stopContainer: async (name) => calls.push(`stop:${name}`),
    startContainer: async (name) => calls.push(`start:${name}`),
    waitHealthy: async () => calls.push("wait"),
    trackedContainers: new Set(["sitechat"]),
    lastHitMap: new Map(),
    startMetricsMap: new Map(),
    logger: noopLogger,
  });

  await ensureExclusive({ container: "sitechat", port: 8002 });
  assert.deepEqual(calls, []);
});

test("ensureExclusive records start metrics", async () => {
  const metrics = new Map();
  let current = 1_000;
  const ensureExclusive = createEnsureExclusive({
    listRunningContainers: async () => [],
    stopContainer: async () => {},
    startContainer: async () => {},
    waitHealthy: async () => {},
    trackedContainers: new Set(["sitechat"]),
    lastHitMap: new Map(),
    startMetricsMap: metrics,
    now: () => {
      const value = current;
      current += 50;
      return value;
    },
    logger: noopLogger,
  });

  await ensureExclusive({ container: "sitechat", port: 8002 });
  const meta = metrics.get("sitechat");
  assert.equal(meta.startCount, 1);
  assert.equal(meta.totalDurationMs, 50);
  assert.equal(meta.lastDurationMs, 50);
  assert.equal(meta.lastStartedAt, 1_050);
});

function createMockRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload = "") {
      this.body += payload;
      this.finished = true;
    },
  };
}

test("openai handler lists models and proxies chat completions", async () => {
  const routeMap = {
    chat: { container: "chat-svc", port: 8002, auth: "inject", models: ["chat-general"] },
    vision: { container: "vision", port: 8188, auth: "passthrough", models: ["vision-diffusion"] },
  };
  const { modelToRoute, metadata } = buildModelIndex(routeMap, { logger: noopLogger });
  const ensureCalls = [];
  const lastHitMap = new Map();
  const forwardCalls = [];
  const handler = createOpenAIHandler({
    routeMap,
    modelToRoute,
    metadata,
    ensureExclusiveFn: async (target) => ensureCalls.push(target.container),
    lastHitMap,
    readBody: async () => JSON.stringify({ model: "chat-general", messages: [] }),
    forwardRequest: async ({ path, bodyBuffer, headers, target, res }) => {
      forwardCalls.push({ path, payload: bodyBuffer.toString("utf8"), headers, target: target.container });
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"resp"}');
    },
    logger: noopLogger,
    now: () => 123,
  });

  const modelsRes = createMockRes();
  await handler({ method: "GET", url: "/openai/v1/models" }, modelsRes);
  assert.equal(modelsRes.statusCode, 200);
  const modelsPayload = JSON.parse(modelsRes.body);
  assert.equal(modelsPayload.object, "list");
  assert.equal(modelsPayload.data.length, 2);

  const req = { method: "POST", url: "/openai/v1/chat/completions?stream=false", headers: {} };
  const res = createMockRes();
  await handler(req, res);
  assert.deepEqual(ensureCalls, ["chat-svc"]);
  assert.equal(lastHitMap.get("chat-svc"), 123);
  assert.equal(forwardCalls.length, 1);
  assert.equal(forwardCalls[0].path, "/v1/chat/completions?stream=false");
  assert.equal(forwardCalls[0].payload, JSON.stringify({ model: "chat-general", messages: [] }));
});

test("openai handler rejects unknown models", async () => {
  const routeMap = {
    chat: { container: "chat-svc", port: 8002, auth: "inject", models: ["chat-general"] },
  };
  const { modelToRoute, metadata } = buildModelIndex(routeMap, { logger: noopLogger });
  const handler = createOpenAIHandler({
    routeMap,
    modelToRoute,
    metadata,
    readBody: async () => JSON.stringify({ model: "missing" }),
    logger: noopLogger,
  });
  const res = createMockRes();
  await handler({ method: "POST", url: "/openai/v1/chat/completions" }, res);
  assert.equal(res.statusCode, 400);
  const payload = JSON.parse(res.body);
  assert.ok(payload.error.message.includes("unknown_model"));
});

test("admin handler surfaces route metadata", async () => {
  const handler = createAdminHandler({
    routeMap: {
      chat: { container: "chat-svc", port: 8001, health: "/live", auth: "passthrough" },
    },
    listRunningContainers: async () => ["chat-svc"],
    lastHitMap: new Map([["chat-svc", 123]]),
    startMetricsMap: new Map([["chat-svc", { totalDurationMs: 1000, startCount: 2, lastDurationMs: 600, lastStartedAt: 2000 }]]),
    logger: noopLogger,
  });

  const routesRes = createMockRes();
  const routesHandled = await handler({ method: "GET", url: "/routes" }, routesRes);
  assert.equal(routesHandled, true);
  assert.equal(routesRes.statusCode, 200);
  const payload = JSON.parse(routesRes.body);
  assert.equal(payload.routes[0].route, "chat");
  assert.equal(payload.routes[0].health, "/live");

  const statsRes = createMockRes();
  const statsHandled = await handler({ method: "GET", url: "/stats" }, statsRes);
  assert.equal(statsHandled, true);
  assert.equal(statsRes.statusCode, 200);
  const stats = JSON.parse(statsRes.body);
  assert.deepEqual(stats.runningContainers, ["chat-svc"]);
  assert.ok(stats.lastHits["chat-svc"].includes("1970"));
  assert.equal(stats.startMetrics["chat-svc"].startCount, 2);
  assert.equal(Math.round(stats.startMetrics["chat-svc"].averageDurationMs), 500);

  const healthRes = createMockRes();
  const healthHandled = await handler({ method: "GET", url: "/healthz" }, healthRes);
  assert.equal(healthHandled, true);
  assert.equal(healthRes.statusCode, 200);
  const health = JSON.parse(healthRes.body);
  assert.equal(health.status, "ok");
});
