// v1.9 build 37 — the Matchday alerts tick-boxes must stick.
//
// The REAL PrefsStore runs over real SQLite, behind the REAL worker routes, on
// a KV that is deliberately stale: a read returns what was true when the test
// last called settle(), never a write made since. That is worse than
// production KV (~60s), so anything that passes here does not depend on it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { PrefsStore } from "../src/worker.js";
import { applyPrefs } from "../src/prefs_store.js";
import { sqlShim } from "./registrar_harness.mjs";

/** Eventually consistent KV: writes land in `truth`; reads see `visible`. */
function staleKv(seed = {}) {
  const truth = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  let visible = new Map(truth);
  return {
    truth,
    settle() { visible = new Map(truth); },
    async get(key, type) {
      const raw = visible.has(key) ? visible.get(key) : null;
      if (raw === null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) { truth.set(key, String(value)); },
    async delete(key) { truth.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...visible.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
    record(uid) { const raw = truth.get(`push:${uid}`); return raw ? JSON.parse(raw) : null; },
  };
}

function prefsNamespace() {
  const instances = new Map();
  const ns = {
    env: null,
    instances,
    idFromName(name) { return { name }; },
    get(id) {
      if (!instances.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        instances.set(id.name, new PrefsStore({ storage: { sql: sqlShim(db) } }, ns.env));
      }
      const inst = instances.get(id.name);
      return { fetch: (url, init) => inst.fetch(new Request(url, init)) };
    },
  };
  return ns;
}

function world(seed = {}) {
  const kv = staleKv(seed);
  const ns = prefsNamespace();
  const env = { KV: kv, PREFS_STORE: ns, ALLOWED_ORIGIN: "https://abigwood.github.io" };
  ns.env = env;
  return { env, kv, ns };
}

const post = async (w, path, body) => {
  const response = await worker.fetch(new Request(`https://w${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), w.env);
  return { status: response.status, body: await response.json() };
};
const getPrefs = async (w, uid) => (await worker.fetch(new Request(`https://w/notification-prefs?uid=${uid}`), w.env)).json();

test("rapid tick of both boxes, with the device registering in between: both stick", async () => {
  const w = world();
  // The real sequence: tick 1 asks iOS, which registers; tick 2 follows at once.
  const answers = await Promise.all([
    post(w, "/notification-prefs", { uid: "u1", reveal: true, results: false, offers: { reveal: false, results: false }, updatedAt: 1000 }),
    post(w, "/push-token", { uid: "u1", token: "tok-1" }),
    post(w, "/notification-prefs", { uid: "u1", reveal: true, results: true, offers: { reveal: false, results: false }, updatedAt: 1001 }),
  ]);
  assert.ok(answers.every((a) => a.status === 200));
  const mirror = w.kv.record("u1");
  assert.deepEqual([mirror.reveal, mirror.results, mirror.token], [true, true, "tok-1"], "the senders' copy has both");
  const read = await getPrefs(w, "u1");
  assert.deepEqual([read.reveal, read.results, read.registered], [true, true, true]);
});

test("partial posts (build 36 shape) in quick succession lose nothing either", async () => {
  const w = world();
  await Promise.all([
    post(w, "/notification-prefs", { uid: "u2", reveal: true }),
    post(w, "/notification-prefs", { uid: "u2", results: true }),
    post(w, "/push-token", { uid: "u2", token: "t" }),
    post(w, "/notification-prefs", { uid: "u2", mute: ["ELC"] }),
  ]);
  const read = await getPrefs(w, "u2");
  assert.deepEqual([read.reveal, read.results, read.mute, read.registered], [true, true, ["ELC"], true]);
});

test("tick, close, reopen within 5s and within 60s: the GET is never stale", async () => {
  const w = world({ "push:u3": { token: "t", mute: [] } });
  w.kv.settle();
  await post(w, "/notification-prefs", { uid: "u3", reveal: true, results: true, offers: { reveal: false, results: false }, updatedAt: 5000 });
  // KV has not caught up (settle() not called) — the reopen reads the store.
  assert.equal(await w.kv.get("push:u3", "json").then((r) => r.reveal), undefined, "KV really is stale here");
  for (let i = 0; i < 3; i++) {
    const read = await getPrefs(w, "u3");
    assert.deepEqual([read.reveal, read.results, read.updatedAt], [true, true, 5000]);
  }
  w.kv.settle();
  const later = await getPrefs(w, "u3");
  assert.deepEqual([later.reveal, later.results], [true, true]);
});

test("re-registration (stale KV) never switches an alert off or un-mutes", async () => {
  const w = world({ "push:u4": { token: "old", mute: [] } });
  w.kv.settle();
  await post(w, "/notification-prefs", { uid: "u4", reveal: true, results: true, mute: ["ELC"], updatedAt: 10 });
  for (let i = 0; i < 3; i++) await post(w, "/push-token", { uid: "u4", token: `new-${i}` });
  const r = w.kv.record("u4");
  assert.deepEqual([r.reveal, r.results, r.mute, r.token], [true, true, ["ELC"], "new-2"]);
});

test("two devices: the newer choice wins; an older one is refused and told what is stored", async () => {
  const w = world();
  const a = await post(w, "/notification-prefs", { uid: "u5", reveal: true, results: false, updatedAt: 2000 });
  assert.equal(a.body.stale, false);
  const b = await post(w, "/notification-prefs", { uid: "u5", reveal: false, results: true, updatedAt: 1500 });
  assert.equal(b.body.stale, true);
  assert.deepEqual([b.body.reveal, b.body.results, b.body.updatedAt], [true, false, 2000], "B is told A's newer choice");
  const c = await post(w, "/notification-prefs", { uid: "u5", reveal: true, results: true, updatedAt: 2500 });
  assert.deepEqual([c.body.stale, c.body.reveal, c.body.results], [false, true, true]);
});

test("offline tick then reconnect: the late post still applies when it is the newest", async () => {
  const w = world();
  await post(w, "/notification-prefs", { uid: "u6", reveal: false, results: false, updatedAt: 100 });
  // Ticked at 200 while offline; delivered later.
  const late = await post(w, "/notification-prefs", { uid: "u6", reveal: true, results: false, updatedAt: 200 });
  assert.deepEqual([late.body.stale, late.body.reveal], [false, true]);
});

test("a fast client clock cannot lock other devices out", async () => {
  const w = world();
  const future = Date.now() + 86_400_000;
  const a = await post(w, "/notification-prefs", { uid: "u7", reveal: true, updatedAt: future });
  assert.ok(a.body.updatedAt <= Date.now(), "clamped to the server clock");
  const b = await post(w, "/notification-prefs", { uid: "u7", reveal: false, updatedAt: Date.now() + 1 });
  assert.equal(b.body.reveal, false);
});

test("full-state posts: offers false never un-answers an offer", async () => {
  const w = world();
  await post(w, "/notification-prefs", { uid: "u8", offers: { reveal: true } });
  const r = await post(w, "/notification-prefs", { uid: "u8", reveal: true, results: false, offers: { reveal: false, results: false }, updatedAt: 9 });
  assert.deepEqual(r.body.offers, { reveal: true, results: false });
});

test("a 410 drops only the refused token and keeps every choice; a newer token survives an old 410", async () => {
  const w = world();
  await post(w, "/push-token", { uid: "u9", token: "A" });
  await post(w, "/notification-prefs", { uid: "u9", reveal: true, mute: ["ELC"], updatedAt: 1 });
  await post(w, "/push-token", { uid: "u9", token: "B" });
  const client = w.ns.get(w.ns.idFromName("u9"));
  await client.fetch("https://x/rpc", { method: "POST", body: JSON.stringify({ uid: "u9", op: "dropToken", token: "A" }) });
  assert.equal(w.kv.record("u9").token, "B");
  await client.fetch("https://x/rpc", { method: "POST", body: JSON.stringify({ uid: "u9", op: "dropToken", token: "B" }) });
  const r = w.kv.record("u9");
  assert.deepEqual([r.token, r.reveal, r.mute], [undefined, true, ["ELC"]]);
});

test("first touch adopts the existing KV record (build 36 users keep their ticks)", async () => {
  const w = world({ "push:u10": { token: "t", mute: ["ELC"], reveal: true, offers: { results: true } } });
  w.kv.settle();
  const read = await getPrefs(w, "u10");
  assert.deepEqual([read.reveal, read.results, read.mute, read.offers, read.registered],
    [true, false, ["ELC"], { reveal: false, results: true }, true]);
});

test("erase removes the record and a later read does not resurrect it from stale KV", async () => {
  const w = world({ "push:u11": { token: "t", reveal: true } });
  w.kv.settle();
  await getPrefs(w, "u11");
  const client = w.ns.get(w.ns.idFromName("u11"));
  await client.fetch("https://x/rpc", { method: "POST", body: JSON.stringify({ uid: "u11", op: "erase" }) });
  assert.equal(w.kv.truth.has("push:u11"), false);
  const read = await getPrefs(w, "u11");
  assert.deepEqual([read.reveal, read.registered], [false, false]);
});

test("validation: updatedAt must be a number; empty offers alone is refused", async () => {
  const w = world();
  assert.equal((await post(w, "/notification-prefs", { uid: "v", reveal: true, updatedAt: "now" })).status, 400);
  assert.equal((await post(w, "/notification-prefs", { uid: "v", offers: { reveal: false } })).status, 400);
});

test("applyPrefs is pure and ignores an older choice", () => {
  const base = { reveal: true, choiceAt: 50 };
  const { record, stale } = applyPrefs(base, { reveal: false, updatedAt: 40 }, 100);
  assert.equal(stale, true);
  assert.equal(record.reveal, true);
  assert.deepEqual(base, { reveal: true, choiceAt: 50 });
});
