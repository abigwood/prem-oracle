import test from "node:test";
import assert from "node:assert/strict";
import worker, { mergeResultOverlay } from "../src/worker.js";

test("official completed result beats stale live overlay", () => {
  const official = { id: "m1", tour: "men", status: "complete", result: [2, 3], lockAt: "old" };
  const overlay = { status: "live", result: null, lockAt: "newer" };
  assert.deepEqual(mergeResultOverlay(official, overlay), official);
});

test("settlement overlay can still complete an unsettled fixture", () => {
  const official = { id: "m1", tour: "women", status: "live", result: null };
  const overlay = { status: "complete", result: [2, 0] };
  assert.deepEqual(mergeResultOverlay(official, overlay), { ...official, ...overlay });
});

test("fixtures endpoint declares manual settlement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [] }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/fixtures"), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).settlement, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual settlement preserves previous fixture results", async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    { id: "md1-001", player1: "Arsenal", player2: "Coventry City", startAt: "2026-08-21T20:00:00+01:00" },
    { id: "md2-001", player1: "Liverpool", player2: "Nottingham Forest", startAt: "2026-08-29T15:00:00+01:00" },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    SETTLE_SECRET: "test-secret",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  const settle = (results) => worker.fetch(new Request("https://worker.test/settle", {
    method: "POST",
    body: JSON.stringify({ secret: "test-secret", results }),
  }), env);
  try {
    let response = await settle({ "md1-001": { status: "complete", result: [2, 1] } });
    assert.equal(response.status, 200);
    response = await settle({ "md2-001": { status: "complete", result: [0, 0] } });
    assert.equal(response.status, 200);
    const results = JSON.parse(store.get("results"));
    assert.deepEqual(Object.keys(results).sort(), ["md1-001", "md2-001"]);
    assert.deepEqual(results["md1-001"].result, [2, 1]);
    assert.deepEqual(results["md2-001"].result, [0, 0]);
    assert.equal(results["md1-001"].status, "complete");
    assert.equal(results["md2-001"].status, "complete");
    assert.ok(results["md1-001"].lockAt);
    assert.ok(results["md2-001"].lockAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("push token endpoint stores native registration token", async () => {
  const store = new Map();
  const env = {
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  const response = await worker.fetch(new Request("https://worker.test/push-token", {
    method: "POST",
    body: JSON.stringify({ uid: "user-1", nickname: "Adam", token: "apns-token", platform: "ios" }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(store.get("push:user-1")).token, "apns-token");
});
