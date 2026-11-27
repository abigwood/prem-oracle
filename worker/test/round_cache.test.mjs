// v1.9 build 38 — the settled-week cache on /state?code&period.
//
// Drives the real handler end to end. The promises: a settled week is served
// from ONE record without re-reading picks; it is byte-for-byte the answer a
// cold compute gives; the member check and `private, no-store` are unchanged;
// a renamed player never shows an old name; and a corrected result, a slate
// change, or anyone joining, leaving or being removed recomputes the week.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { roundFingerprint, relabelNicks } from "../src/worker.js";
import { registrarNamespace } from "./registrar_harness.mjs";

const HOUR = 60 * 60 * 1000;

function memoryKV(store = new Map()) {
  const reads = [];
  return {
    reads,
    async get(key) { reads.push(key); return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || "" };
    },
  };
}

const settledRound = (scores = [[2, 1], [0, 0]]) => scores.map(([a, b], i) => ({
  id: `pl-2026-27-md1-00${i + 1}`, matchday: 1, player1: `Home ${i}`, player2: `Away ${i}`,
  startAt: new Date(Date.now() - (10 - i) * HOUR).toISOString(), status: "FINISHED", result: [a, b],
}));

let feed = settledRound();
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: feed }), { status: 200 });
test.after(() => { globalThis.fetch = realFetch; });

const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) }), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

async function league() {
  feed = settledRound();
  const store = new Map();
  const kv = memoryKV(store);
  const env = { FIXTURES_URL: "https://example.com/fixtures.json", KV: kv, LEAGUE_REGISTRAR: registrarNamespace() };
  await get(env)("/fixtures?refresh=1");
  const send = post(env);
  const { code } = await (await send("/league", { uid: "host", nickname: "Host" })).json();
  await send("/join", { uid: "m2", code, nickname: "Two" });
  await env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code)).fetch("https://league-registrar/rpc",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge" }) });
  const founded = Date.now() - 30 * 24 * HOUR;
  for (const uid of ["host", "m2"]) {
    const key = `member:${code}:${uid}`;
    store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)), since: founded }));
  }
  const ts = Date.now() - 20 * HOUR;
  store.set(`picks:${feed[0].id}`, JSON.stringify({ host: { p1: 2, p2: 1, ts }, m2: { p1: 0, p2: 0, ts } }));
  store.set(`picks:${feed[1].id}`, JSON.stringify({ host: { p1: 1, p2: 1, ts }, m2: { p1: 0, p2: 0, ts } }));
  return { env, store, kv, code, send };
}

const ask = async (env, code, uid) => {
  const response = await get(env)(`/state?code=${code}&period=1${uid ? `&uid=${uid}` : ""}`);
  return { response, body: await response.json() };
};
const picksReads = (kv) => kv.reads.filter((key) => key.startsWith("picks:")).length;

test("a settled week is written once and then served from the record, without re-reading picks", async () => {
  const { env, kv, store, code } = await league();
  const cold = await ask(env, code, "host");
  assert.equal(cold.body.complete, true);
  assert.ok(store.has(`roundcache:${code}:1`), "the settled week was not cached");
  kv.reads.length = 0;
  const warm = await ask(env, code, "host");
  assert.equal(picksReads(kv), 0, "a cached week re-read picks");
  assert.deepEqual(warm.body, cold.body, "the cached answer differs from a cold compute");
  assert.equal(warm.response.headers.get("cache-control"), "private, no-store");
});

test("an unsettled week is never cached", async () => {
  const { env, store, code } = await league();
  feed = [settledRound()[0], { ...settledRound()[1], status: "SCHEDULED", result: null, startAt: new Date(Date.now() + 5 * HOUR).toISOString() }];
  await get(env)("/fixtures?refresh=1");
  const { body } = await ask(env, code, "host");
  assert.equal(body.complete, false);
  assert.equal(store.has(`roundcache:${code}:1`), false);
});

test("privacy unchanged: non-members and unsigned requests get no reveal and the old headers, cached or not", async () => {
  const { env, code } = await league();
  for (let pass = 0; pass < 2; pass++) {                      // cold, then from the record
    const member = await ask(env, code, "m2");
    assert.ok(Array.isArray(member.body.reveal) && member.body.reveal.length, "a member lost the reveal");
    assert.equal(member.response.headers.get("cache-control"), "private, no-store");
    for (const uid of ["stranger", ""]) {
      const other = await ask(env, code, uid);
      assert.equal(other.response.status, 200);
      assert.equal("reveal" in other.body, false, `pass ${pass}: ${uid || "unsigned"} got the reveal`);
      assert.notEqual(other.response.headers.get("cache-control"), "private, no-store");
      assert.ok(!JSON.stringify(other.body).includes('"p1":2,"p2":1,"ts"'), "a prediction leaked");
    }
  }
});

test("a renamed player never shows an old name — names come from the live member list", async () => {
  const { env, store, code } = await league();
  await ask(env, code, "host");                                // cache written with "Two"
  const key = `member:${code}:m2`;
  store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)), nick: "Renamed" }));
  const { body } = await ask(env, code, "host");
  const text = JSON.stringify(body);
  assert.ok(!text.includes('"Two"'), "an old name survived in the cached week");
  assert.equal(body.table.find((row) => row.uid === "m2").nick, "Renamed");
  for (const row of body.reveal.flatMap((fixture) => fixture.rows || fixture.picks || [])) {
    if (row.uid === "m2") assert.equal(row.nick, "Renamed");
  }
});

test("a corrected result recomputes the week", async () => {
  const { env, kv, code } = await league();
  const before = (await ask(env, code, "host")).body;
  feed = settledRound([[2, 1], [1, 1]]);                       // late correction: 0-0 -> 1-1
  await get(env)("/fixtures?refresh=1");
  kv.reads.length = 0;
  const after = (await ask(env, code, "host")).body;
  assert.ok(picksReads(kv) > 0, "served a stale cached week after a correction");
  assert.notDeepEqual(after.table, before.table);
  assert.equal(after.table.find((row) => row.uid === "host").pts > before.table.find((row) => row.uid === "host").pts, true);
});

test("a member leaving or being removed, or someone joining, recomputes the week", async () => {
  const { env, store, kv, code, send } = await league();
  await ask(env, code, "host");
  store.delete(`member:${code}:m2`);                           // left / removed
  kv.reads.length = 0;
  const left = (await ask(env, code, "host")).body;
  assert.ok(picksReads(kv) > 0);
  assert.equal(left.table.some((row) => row.uid === "m2"), false, "a removed member is still in the cached table");
  // And a removed member can no longer read the reveal from the cached record.
  assert.equal("reveal" in (await ask(env, code, "m2")).body, false);
  await send("/join", { uid: "m4", code, nickname: "Four" });
  kv.reads.length = 0;
  await ask(env, code, "host");
  assert.ok(picksReads(kv) > 0, "a join did not recompute");
});

test("the fingerprint covers results, voids, slate and membership; relabel touches only {uid, nick}", () => {
  const fx = [{ id: "a", result: [1, 0], startAt: "2026-11-28T15:00:00Z" }];
  const m = [{ uid: "u1", since: 1 }];
  const base = roundFingerprint("1", fx, null, m);
  assert.notEqual(roundFingerprint("1", [{ ...fx[0], result: [1, 1] }], null, m), base);
  assert.notEqual(roundFingerprint("1", [{ ...fx[0], status: "POSTPONED" }], null, m), base);
  assert.notEqual(roundFingerprint("1", fx, { status: "published", fixtureIds: ["a"] }, m), base);
  assert.notEqual(roundFingerprint("1", fx, null, [...m, { uid: "u2", since: 2 }]), base);
  assert.notEqual(roundFingerprint("1", fx, null, [{ uid: "u1", since: 5 }]), base);
  assert.equal(roundFingerprint("1", fx, null, [{ uid: "u1", since: 1, nick: "Any" }]), base, "names must not be in the fingerprint");
  const out = relabelNicks({ table: [{ uid: "u1", nick: "Old", pts: 3 }], label: { nick: "keep" } }, new Map([["u1", "New"]]));
  assert.deepEqual(out, { table: [{ uid: "u1", nick: "New", pts: 3 }], label: { nick: "keep" } });
});

test("the settled-week cache never uses the Cache API", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /caches\.default|caches\.open/);
});
