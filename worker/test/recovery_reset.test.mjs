// POST /admin/recovery-reset — the hardened, idempotent, audited credential
// reset. These pin the eighteen cases from the implementation brief: auth and
// non-disclosure, member resolution, the fail-closed refusals, the rotation
// itself and everything it must NOT touch, idempotency and crash-safety, the
// audit shape, cache headers, bounded I/O, and confinement to the worker.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { readFileSync } from "node:fs";
import { makeRecovery } from "../src/logic.js";

const SECRET = "test-recovery-admin-secret";

function memoryKV(store = new Map()) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

const call = (env, body, { auth = SECRET, method = "POST", path = "/admin/recovery-reset" } = {}) =>
  worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth == null ? {} : { authorization: `Bearer ${auth}` }) },
    body: JSON.stringify(body),
  }), env);

const plain = (env, body) => // a plain POST helper for /league, /join, /restore (no auth header)
  worker.fetch(new Request(`https://worker.test${body.__path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);

async function seeded({ secret = SECRET } = {}) {
  const store = new Map();
  const env = { KV: memoryKV(store), ...(secret == null ? {} : { RECOVERY_ADMIN_SECRET: secret }) };
  const post = (path, obj) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj),
  }), env);
  const code = (await (await post("/league", { uid: "owner", nickname: "Owner" })).json()).code;
  await post("/join", { uid: "gift", code, nickname: "The Gift" });
  await post("/join", { uid: "other", code, nickname: "Someone Else" });
  return { store, env, post, code };
}

// Mirror of the worker's own derivation, so the collision test can plant the
// exact candidate the endpoint will compute. Doubles as a spec-pin on the
// derivation: change the domain string and this fails loudly.
async function derive(requestId, uid) {
  const material = new TextEncoder().encode(`prem-oracle/recovery-reset/v1\n${requestId}\n${uid}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return makeRecovery((n) => digest.subarray(0, n));
}

const recoveryFor = (store, uid) => [...store.entries()]
  .filter(([k]) => k.startsWith("recovery:"))
  .filter(([, v]) => JSON.parse(v) === uid)
  .map(([k]) => k.slice("recovery:".length));

// --- 1 · closed when the secret is not configured --------------------------

test("1 · with no RECOVERY_ADMIN_SECRET the route is indistinguishable from absent", async () => {
  const { env, code } = await seeded({ secret: null });
  const res = await call(env, { requestId: "r1", leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// --- 2 · auth failures reveal no identity ----------------------------------

test("2 · missing, malformed and wrong auth all fail as 'not found'", async () => {
  const { env, code } = await seeded();
  for (const auth of [null, "", "not-a-bearer", "Bearer wrong", `Bearer ${SECRET}x`]) {
    const res = await call(env, { requestId: "r", leagueCode: code, exactNick: "The Gift" }, { auth });
    assert.equal(res.status, 404, `auth=${auth}`);
    assert.deepEqual(await res.json(), { error: "not found" }, `auth=${auth}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

// --- 3 · unknown league / nick / uid fail without mutation -----------------

test("3 · unknown league, nickname and uid fail, changing nothing", async () => {
  const { env, store, code } = await seeded();
  const snapshot = new Map(store);
  for (const body of [
    { requestId: "r", leagueCode: "ZZZZZZ", exactNick: "The Gift" },
    { requestId: "r", leagueCode: code, exactNick: "Nobody Here" },
    { requestId: "r", leagueCode: code, memberUid: "ghost" },
  ]) {
    const res = await call(env, body);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "target not found" });
  }
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort(), "state changed on a refusal");
});

// --- 4 · a duplicate exact nick fails closed -------------------------------

test("4 · two members with the same nick is refused, never a guess", async () => {
  const { env, post, store, code } = await seeded();
  await post("/join", { uid: "gift2", code, nickname: "The Gift" }); // a second "The Gift"
  const snapshot = new Map(store);
  const res = await call(env, { requestId: "r", leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "target not found" });
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort());
});

// --- 5 · uid and nick disagreement fails closed ----------------------------

test("5 · a uid and a nick that name different members is refused", async () => {
  const { env, store, code } = await seeded();
  const snapshot = new Map(store);
  const res = await call(env, { requestId: "r", leagueCode: code, memberUid: "other", exactNick: "The Gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "uid and nickname disagree" });
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort());
});

// --- 6 & 7 · the rotation works; the old code stops working ----------------

test("6/7 · the new code restores the same account; the old code no longer does", async () => {
  const { env, store, post, code } = await seeded();
  const before = (await env.KV.get("user:gift")).recovery;

  const res = await call(env, { requestId: "req-abc", leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.memberUid, "gift");
  assert.equal(body.replayed, false);
  assert.match(body.recovery, /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(body.recovery, await derive("req-abc", "gift"));
  assert.notEqual(body.recovery, before);

  // 6 · restore with the NEW code returns the same uid, leagues and picks.
  const restored = await (await post("/restore", { code: body.recovery })).json();
  assert.equal(restored.uid, "gift");
  assert.deepEqual(restored.leagues, [code]);
  // 7 · the OLD code is refused.
  assert.equal((await post("/restore", { code: before })).status, 404);
  // The mapping the new code resolves through points at gift, and only gift.
  assert.deepEqual(recoveryFor(store, "gift"), [body.recovery]);
});

// --- 8 · the user record changes only in its recovery field ----------------

test("8 · every field of the user record but recovery is untouched", async () => {
  const { env, code } = await seeded();
  const before = await env.KV.get("user:gift");
  const res = await call(env, { requestId: "r8", leagueCode: code, memberUid: "gift" });
  const newCode = (await res.json()).recovery;
  const after = await env.KV.get("user:gift");
  assert.equal(after.recovery, newCode);
  assert.deepEqual({ ...after, recovery: null }, { ...before, recovery: null });
});

// --- 9 · nothing else in the store moves -----------------------------------

test("9 · league, membership and picks are byte-identical after a reset", async () => {
  const { env, store, code } = await seeded();
  await env.KV.put("picks:gift", JSON.stringify({ "pl-1": { p1: 2, p2: 1 } }));
  const untouched = (k) => k === `league:${code}` || k.startsWith(`member:${code}:`) || k === "picks:gift" || k === "user:other";
  const before = new Map([...store.entries()].filter(([k]) => untouched(k)));
  await call(env, { requestId: "r9", leagueCode: code, memberUid: "gift" });
  const after = new Map([...store.entries()].filter(([k]) => untouched(k)));
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

// --- 10 · a mis-owned old mapping is a complete refusal --------------------

test("10 · an old mapping that points to another uid halts the whole thing", async () => {
  const { env, store, code } = await seeded();
  const gift = await env.KV.get("user:gift");
  // Corrupt the store: gift's recovery lookup points at someone else.
  store.set(`recovery:${gift.recovery}`, JSON.stringify("someone-else"));
  const snapshot = new Map(store);
  const res = await call(env, { requestId: "r10", leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "target credential is inconsistent" });
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort());
});

// --- 11 · a derived-candidate collision changes nothing --------------------

test("11 · a candidate already owned by another account refuses, no mutation", async () => {
  const { env, store, code } = await seeded();
  const candidate = await derive("r11", "gift");
  store.set(`recovery:${candidate}`, JSON.stringify("a-stranger")); // plant the clash
  const snapshot = new Map(store);
  const res = await call(env, { requestId: "r11", leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /collides with another account/);
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort());
});

// --- 12 · a crash after any stage completes to exactly one credential ------

function failingKV(store, failAt) {
  const base = memoryKV(store);
  let n = 0;
  return {
    get: base.get, list: base.list,
    async put(key, value) { if (++n === failAt) throw new Error("crash"); return base.put(key, value); },
    async delete(key) { if (++n === failAt) throw new Error("crash"); return base.delete(key); },
  };
}

test("12 · a crash at any mutation stage, retried, ends with one final code", async () => {
  for (let failAt = 1; failAt <= 5; failAt++) {
    const { store, code } = await seeded();
    const oldCode = JSON.parse(store.get("user:gift")).recovery;
    const expected = await derive("crash", "gift");

    // First attempt crashes at the failAt-th write/delete.
    const envFail = { KV: failingKV(store, failAt), RECOVERY_ADMIN_SECRET: SECRET };
    const crashed = await call(envFail, { requestId: "crash", leagueCode: code, memberUid: "gift" });
    assert.equal(crashed.status, 500, `failAt=${failAt} should have crashed`);

    // Retry with the same requestId on the same store, no failure this time.
    const envOk = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: SECRET };
    const done = await call(envOk, { requestId: "crash", leagueCode: code, memberUid: "gift" });
    assert.equal(done.status, 200, `failAt=${failAt} retry`);
    const body = await done.json();
    assert.equal(body.recovery, expected, `failAt=${failAt}: a different code was minted`);

    // Exactly one recovery mapping resolves to gift, and it is the new code.
    assert.deepEqual(recoveryFor(store, "gift"), [expected], `failAt=${failAt}: not exactly one credential`);
    assert.equal(JSON.parse(store.get("user:gift")).recovery, expected, `failAt=${failAt}: record not updated`);
    if (oldCode !== expected) assert.equal(store.has(`recovery:${oldCode}`), false, `failAt=${failAt}: old mapping survived`);
    assert.ok(JSON.parse(store.get("recovery-reset:crash")).completedAt, `failAt=${failAt}: audit not finalised`);
  }
});

// --- 13 · a replay returns the same code and never rotates twice -----------

test("13 · the same requestId replays the same code, replayed:true, one rotation", async () => {
  const { env, store, code } = await seeded();
  const first = await (await call(env, { requestId: "dup", leagueCode: code, memberUid: "gift" })).json();
  assert.equal(first.replayed, false);
  const second = await (await call(env, { requestId: "dup", leagueCode: code, memberUid: "gift" })).json();
  assert.equal(second.recovery, first.recovery);
  assert.equal(second.replayed, true);
  assert.deepEqual(recoveryFor(store, "gift"), [first.recovery], "a replay minted a second credential");
});

// --- 14 · a requestId cannot be reused for another target ------------------

test("14 · reusing a requestId for a different member is refused", async () => {
  const { env, store, code } = await seeded();
  await call(env, { requestId: "shared", leagueCode: code, memberUid: "gift" });
  const snapshot = new Map(store);
  const res = await call(env, { requestId: "shared", leagueCode: code, memberUid: "other" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /different target/);
  assert.deepEqual([...store.entries()].sort(), [...snapshot.entries()].sort(), "the reuse mutated state");
});

// --- 15 · the audit record holds the facts and no secrets ------------------

test("15 · the audit record carries the required fields and no credential", async () => {
  const { env, store, code } = await seeded();
  const body = await (await call(env, { requestId: "aud", leagueCode: code, memberUid: "gift" })).json();
  const audit = JSON.parse(store.get("recovery-reset:aud"));
  assert.equal(audit.action, "recovery-reset");
  assert.equal(audit.route, "/admin/recovery-reset");
  assert.equal(audit.requestId, "aud");
  assert.equal(audit.leagueCode, code);
  assert.equal(audit.targetUid, "gift");
  assert.equal(audit.targetNick, "The Gift");
  assert.equal(audit.actor, "recovery-admin");
  assert.ok(audit.completedAt);
  // No code, old or new, and no fingerprint of one, anywhere in the record.
  const serialised = JSON.stringify(audit);
  assert.ok(!serialised.includes(body.recovery), "the new code leaked into the audit");
  assert.equal(audit.recovery, undefined);
  assert.equal(audit.newCode, undefined);
  assert.equal(audit.oldCode, undefined);
  assert.ok(!/hash|fingerprint|digest|secret/i.test(serialised), "a credential fingerprint leaked");
});

// --- 16 · caching is disabled on success and error -------------------------

test("16 · every response is Cache-Control: no-store", async () => {
  const { env, code } = await seeded();
  const ok = await call(env, { requestId: "c1", leagueCode: code, memberUid: "gift" });
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const bad = await call(env, { requestId: "c2", leagueCode: code, memberUid: "ghost" });
  assert.equal(bad.headers.get("cache-control"), "no-store");
  const unauth = await call(env, { requestId: "c3", leagueCode: code, memberUid: "gift" }, { auth: "wrong" });
  assert.equal(unauth.headers.get("cache-control"), "no-store");
});

// --- 17 · reads and writes stay within the league and one user -------------

function spyKV(store) {
  const base = memoryKV(store);
  const reads = [], writes = [];
  return {
    reads, writes,
    async get(k, t) { reads.push(k); return base.get(k, t); },
    async put(k, v) { writes.push(k); return base.put(k, v); },
    async delete(k) { writes.push(k); return base.delete(k); },
    async list(o) { return base.list(o); },
  };
}

test("17 · a reset never reaches picks, results or another league", async () => {
  const { store, code } = await seeded();
  await store.set("picks:gift", JSON.stringify({ "pl-1": { p1: 1, p2: 0 } }));
  const kv = spyKV(store);
  const env = { KV: kv, RECOVERY_ADMIN_SECRET: SECRET };
  await call(env, { requestId: "b", leagueCode: code, memberUid: "gift" });

  const touched = [...kv.reads, ...kv.writes];
  assert.ok(touched.every((k) => !k.startsWith("picks:")), "a pick key was touched");
  assert.ok(touched.every((k) => !k.startsWith("results:")), "a results key was touched");
  assert.ok(kv.reads.filter((k) => k.startsWith("league:")).every((k) => k === `league:${code}`), "another league was read");
  // Writes are confined to the credential keys, the one user, and the audit.
  assert.ok(kv.writes.every((k) => /^(recovery:|user:|recovery-reset:)/.test(k)), `unexpected write: ${kv.writes}`);
  assert.ok(kv.writes.filter((k) => k.startsWith("user:")).every((k) => k === "user:gift"), "a second user was written");
});

// --- 18 · the change is confined to the worker -----------------------------

test("18 · no client, notification or settlement surface is involved", async () => {
  const wordirUrl = new URL("../src/worker.js", import.meta.url);
  const src = readFileSync(wordirUrl, "utf8");
  const fn = src.slice(src.indexOf("async function recoveryReset("), src.indexOf("\n}\n", src.indexOf("async function recoveryReset(")));
  for (const forbidden of ["pushToUids", "notify", "autoSettle", "planKickoff", "sendPush", "NOTIFY_QUEUE"]) {
    assert.ok(!fn.includes(forbidden), `the handler reaches into ${forbidden}`);
  }
  // The client bundle gained no knowledge of this maintenance route.
  const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.ok(!app.includes("recovery-reset"), "the admin route leaked into the client");
});
