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
