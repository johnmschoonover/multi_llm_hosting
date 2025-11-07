import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteMap,
  pickTarget,
  Mutex,
  createEnsureExclusive,
} from "./server.js";

const noopLogger = { info() {}, warn() {}, error() {} };

test("buildRouteMap collects prefixed env vars", () => {
  const env = {
    MAP__chat__container: "sitechat",
    MAP__chat__port: "8002",
    MAP__coder__container: "coder3b",
  };
  const map = buildRouteMap(env);
  assert.deepEqual(map.chat, { container: "sitechat", port: "8002" });
  assert.deepEqual(map.coder, { container: "coder3b" });
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
    logger: noopLogger,
  });

  await ensureExclusive("sitechat", 8002);
  assert.deepEqual(calls, ["stop:coder3b"]);
});

test("ensureExclusive starts target when not already running", async () => {
  const calls = [];
  const ensureExclusive = createEnsureExclusive({
    listRunningContainers: async () => ["coder3b"],
    stopContainer: async (name) => calls.push(`stop:${name}`),
    startContainer: async (name) => calls.push(`start:${name}`),
    waitHealthy: async () => calls.push("wait"),
    trackedContainers: new Set(["coder3b", "sitechat"]),
    lastHitMap: new Map([["coder3b", Date.now()]]),
    logger: noopLogger,
  });

  await ensureExclusive("sitechat", 8002);
  assert.deepEqual(calls, ["stop:coder3b", "start:sitechat", "wait"]);
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
    logger: noopLogger,
  });

  await ensureExclusive("sitechat", 8002);
  assert.deepEqual(calls, []);
});
