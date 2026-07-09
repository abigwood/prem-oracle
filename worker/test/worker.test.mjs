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

test("manual settle deletes a fixture result when passed null", async () => {
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
    await settle({ "md1-001": { status: "complete", result: [2, 1] } });
    await settle({ "md2-001": { status: "complete", result: [0, 0] } });
    assert.deepEqual(Object.keys(JSON.parse(store.get("results"))).sort(), ["md1-001", "md2-001"]);

    const response = await settle({ "md1-001": null });
    assert.equal(response.status, 200);
    const results = JSON.parse(store.get("results"));
    assert.deepEqual(Object.keys(results), ["md2-001"]);
    assert.deepEqual(results["md2-001"].result, [0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can kick a member without affecting the league or others", async () => {
  const store = new Map();
  const env = {
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);

  const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
  const code = created.code;
  await post("/join", { uid: "m2", code, nickname: "Two" });
  await post("/join", { uid: "m3", code, nickname: "Three" });

  const leagues = async (uid) => (await env.KV.get(`user:${uid}`))?.leagues || [];
  const league = () => env.KV.get(`league:${code}`);

  // Unknown league -> 404.
  assert.equal((await post("/league/kick", { uid: "owner", code: "ZZZZZZ", memberUid: "m2" })).status, 404);
  // Non-owner -> 403.
  const forbidden = await post("/league/kick", { uid: "m2", code, memberUid: "m3" });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "only the league owner can remove members");
  // Kicking the owner -> 400.
  const ownerKick = await post("/league/kick", { uid: "owner", code, memberUid: "owner" });
  assert.equal(ownerKick.status, 400);
  assert.equal((await ownerKick.json()).error, "the owner cannot be removed");
  // Unknown member -> 404.
  const missing = await post("/league/kick", { uid: "owner", code, memberUid: "ghost" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "member not found");

  // All the failed attempts left the roster intact.
  assert.deepEqual((await league()).members.sort(), ["m2", "m3", "owner"]);

  // Owner kicks m2 -> 200, gone from league + its own list, others untouched.
  const response = await post("/league/kick", { uid: "owner", code, memberUid: "m2" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, code, removed: "m2" });
  const after = await league();
  assert.deepEqual(after.members.sort(), ["m3", "owner"]);
  assert.equal(after.names.m2, undefined);
  assert.equal(after.joinedAt.m2, undefined);
  assert.deepEqual(await leagues("m2"), []);
  assert.deepEqual(await leagues("m3"), [code]);
  assert.deepEqual(await leagues("owner"), [code]);
});

test("owner can delete a league, stripping the code from every member", async () => {
  const store = new Map();
  const env = {
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);

  const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
  const code = created.code;
  await post("/join", { uid: "m2", nickname: "Two" });
  await post("/join", { uid: "m2", code, nickname: "Two" });
  await post("/join", { uid: "m3", code, nickname: "Three" });

  const leagues = async (uid) => (await env.KV.get(`user:${uid}`))?.leagues || [];
  assert.deepEqual(await leagues("owner"), [code]);
  assert.ok((await leagues("m2")).includes(code));
  assert.ok((await leagues("m3")).includes(code));

  // Unknown code -> 404.
  assert.equal((await post("/league/delete", { uid: "owner", code: "ZZZZZZ" })).status, 404);
  // Non-owner -> 403 and the league survives.
  const forbidden = await post("/league/delete", { uid: "m2", code });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "only the league owner can delete it");
  assert.ok(await env.KV.get(`league:${code}`));

  // Owner delete -> 200, league gone, code stripped from every member.
  const response = await post("/league/delete", { uid: "owner", code });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, code });
  assert.equal(await env.KV.get(`league:${code}`), null);
  assert.deepEqual(await leagues("owner"), []);
  assert.deepEqual(await leagues("m2"), []);
  assert.deepEqual(await leagues("m3"), []);
});

test("stats endpoint reports totals and weekly actives behind STATS_SECRET", async () => {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const store = new Map([
    ["user:u1", JSON.stringify({ nickname: "A" })],
    ["user:u2", JSON.stringify({ nickname: "B" })],
    ["user:u3", JSON.stringify({ nickname: "C" })],
    ["league:ABC", JSON.stringify({ code: "ABC" })],
    ["league:XYZ", JSON.stringify({ code: "XYZ" })],
    ["picks:m1", JSON.stringify({ u1: { p1: 1, p2: 0, ts: now - 1000 }, u2: { p1: 2, p2: 2, ts: now - week - 1000 } })],
    ["picks:m2", JSON.stringify({ u1: { p1: 0, p2: 0, ts: now - 2000 }, u3: { p1: 1, p2: 1, ts: now - 100 } })],
    // Unrelated prefixes must not be counted.
    ["push:u1", JSON.stringify({ token: "t" })],
    ["recovery:ace-ball-mint", JSON.stringify("u1")],
    ["results", JSON.stringify({})],
  ]);
  const env = {
    STATS_SECRET: "s3cret",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
      async list({ prefix = "", cursor } = {}) {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true, cursor: cursor || "" };
      },
    },
  };

  const forbidden = await worker.fetch(new Request("https://worker.test/stats"), env);
  assert.equal(forbidden.status, 403);

  const wrongSecret = await worker.fetch(new Request("https://worker.test/stats?secret=nope"), env);
  assert.equal(wrongSecret.status, 403);

  const response = await worker.fetch(new Request("https://worker.test/stats?secret=s3cret"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.users, 3);
  assert.equal(data.leagues, 2);
  assert.equal(data.picks, 4);
  assert.equal(data.activeUsers, 2);
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
