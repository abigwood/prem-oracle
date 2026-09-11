// POST /admin/recovery-reset — the hardened, idempotent, audited credential
// reset, including Sol's A–D corrections: secret-keyed (HMAC) derivation,
// candidate-ownership on every attempt, strict identifier validation and
// account coherence, and contained generic errors.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { readFileSync } from "node:fs";
import { makeRecovery } from "../src/logic.js";

const SECRET = "test-recovery-admin-secret";
const UUID = () => crypto.randomUUID();

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

const call = (env, body, { auth = SECRET } = {}) =>
  worker.fetch(new Request("https://worker.test/admin/recovery-reset", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth == null ? {} : { authorization: `Bearer ${auth}` }) },
    body: JSON.stringify(body),
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

// Mirror of the worker's own HMAC derivation — same domain, same secret keying.
// A collision or a secret-keying test can compute the exact candidate; it also
// pins the derivation (change the domain or the keying and this fails loudly).
async function derive(secret, requestId, uid) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret ?? "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`prem-oracle/recovery-reset/v1\n${requestId}\n${uid}`)));
  return makeRecovery((n) => mac.subarray(0, n));
}

// Mirror of deriveResumeTag — a SEPARATE domain, so it is independent of the
// candidate. Lets the rotation test seed a claim's tag under one secret.
async function resumeTag(secret, requestId, uid) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret ?? "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`prem-oracle/recovery-reset-resume/v1\n${requestId}\n${uid}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

const recoveryFor = (store, uid) => [...store.entries()]
  .filter(([k]) => k.startsWith("recovery:"))
  .filter(([, v]) => JSON.parse(v) === uid)
  .map(([k]) => k.slice("recovery:".length));
const snapshot = (store) => [...store.entries()].sort();

// --- 1 · closed when the secret is not configured --------------------------

test("1 · with no RECOVERY_ADMIN_SECRET the route is indistinguishable from absent", async () => {
  const { env, code } = await seeded({ secret: null });
  const res = await call(env, { requestId: UUID(), leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// --- 2 · auth failures reveal no identity ----------------------------------

test("2 · missing, malformed and wrong auth all fail as 'not found'", async () => {
  const { env, code } = await seeded();
  for (const auth of [null, "", "not-a-bearer", "Bearer wrong", `Bearer ${SECRET}x`]) {
    const res = await call(env, { requestId: UUID(), leagueCode: code, exactNick: "The Gift" }, { auth });
    assert.equal(res.status, 404, `auth=${auth}`);
    assert.deepEqual(await res.json(), { error: "not found" }, `auth=${auth}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

// --- 3 · unknown league / nick / uid fail without mutation -----------------

test("3 · unknown league, nickname and uid fail, changing nothing", async () => {
  const { env, store, code } = await seeded();
  const before = snapshot(store);
  for (const body of [
    { requestId: UUID(), leagueCode: "ZZZZZZ", exactNick: "The Gift" }, // valid format, no such league
    { requestId: UUID(), leagueCode: code, exactNick: "Nobody Here" },
    { requestId: UUID(), leagueCode: code, memberUid: "ghost" },
  ]) {
    const res = await call(env, body);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "target not found" });
  }
  assert.deepEqual(snapshot(store), before, "state changed on a refusal");
});

// --- 4 · a duplicate exact nick fails closed -------------------------------

test("4 · two members with the same nick is refused, never a guess", async () => {
  const { env, post, store, code } = await seeded();
  await post("/join", { uid: "gift2", code, nickname: "The Gift" });
  const before = snapshot(store);
  const res = await call(env, { requestId: UUID(), leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "target not found" });
  assert.deepEqual(snapshot(store), before);
});

// --- 5 · uid and nick disagreement fails closed ----------------------------

test("5 · a uid and a nick that name different members is refused", async () => {
  const { env, store, code } = await seeded();
  const before = snapshot(store);
  const res = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "other", exactNick: "The Gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "uid and nickname disagree" });
  assert.deepEqual(snapshot(store), before);
});

// --- 6 & 7 · the rotation works; the old code stops working ----------------

test("6/7 · the new code restores the same account; the old code no longer does", async () => {
  const { env, store, post, code } = await seeded();
  const rid = UUID();
  const before = (await env.KV.get("user:gift")).recovery;

  const res = await call(env, { requestId: rid, leagueCode: code, exactNick: "The Gift" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.memberUid, "gift");
  assert.equal(body.replayed, false);
  assert.match(body.recovery, /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(body.recovery, await derive(SECRET, rid, "gift"));
  assert.notEqual(body.recovery, before);

  const restored = await (await post("/restore", { code: body.recovery })).json();
  assert.equal(restored.uid, "gift");
  assert.deepEqual(restored.leagues, [code]);
  assert.equal((await post("/restore", { code: before })).status, 404);
  assert.deepEqual(recoveryFor(store, "gift"), [body.recovery]);
});

// --- 8 · the user record changes only in its recovery field ----------------

test("8 · every field of the user record but recovery is untouched", async () => {
  const { env, code } = await seeded();
  const beforeRec = await env.KV.get("user:gift");
  const res = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  const newCode = (await res.json()).recovery;
  const after = await env.KV.get("user:gift");
  assert.equal(after.recovery, newCode);
  assert.deepEqual({ ...after, recovery: null }, { ...beforeRec, recovery: null });
});

// --- 9 · nothing else in the store moves -----------------------------------

test("9 · league, membership and picks are byte-identical after a reset", async () => {
  const { env, store, code } = await seeded();
  await env.KV.put("picks:gift", JSON.stringify({ "pl-1": { p1: 2, p2: 1 } }));
  const untouched = (k) => k === `league:${code}` || k.startsWith(`member:${code}:`) || k === "picks:gift" || k === "user:other";
  const before = new Map([...store.entries()].filter(([k]) => untouched(k)));
  await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  const after = new Map([...store.entries()].filter(([k]) => untouched(k)));
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

// --- 10 · a mis-owned old mapping is a complete refusal --------------------

test("10 · an old mapping that points to another uid halts the whole thing", async () => {
  const { env, store, code } = await seeded();
  const gift = await env.KV.get("user:gift");
  store.set(`recovery:${gift.recovery}`, JSON.stringify("someone-else"));
  const before = snapshot(store);
  const res = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "target credential is inconsistent" });
  assert.deepEqual(snapshot(store), before);
});

// --- 11 · a derived-candidate collision (fresh) changes nothing ------------

test("11 · a candidate already owned by another account refuses, no mutation", async () => {
  const { env, store, code } = await seeded();
  const rid = UUID();
  const candidate = await derive(SECRET, rid, "gift");
  store.set(`recovery:${candidate}`, JSON.stringify("a-stranger"));
  const before = snapshot(store);
  const res = await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /collides with another account/);
  assert.deepEqual(snapshot(store), before);
});

// --- 12 · a crash after any stage: generic 500, then converges (also D) -----

function failingKV(store, failAt) {
  const base = memoryKV(store);
  let n = 0;
  return {
    get: base.get, list: base.list,
    async put(key, value) { if (++n === failAt) throw new Error(`crash writing ${key}`); return base.put(key, value); },
    async delete(key) { if (++n === failAt) throw new Error(`crash deleting ${key}`); return base.delete(key); },
  };
}

test("12 · a crash at any mutation stage is a generic 500, and a retry converges", async () => {
  for (let failAt = 1; failAt <= 5; failAt++) {  // claim, recovery, delete-old, user, finalize
    const { store, code } = await seeded();
    const rid = UUID();
    const oldCode = JSON.parse(store.get("user:gift")).recovery;
    const expected = await derive(SECRET, rid, "gift");

    const envFail = { KV: failingKV(store, failAt), RECOVERY_ADMIN_SECRET: SECRET };
    const crashed = await call(envFail, { requestId: rid, leagueCode: code, memberUid: "gift" });
    assert.equal(crashed.status, 500, `failAt=${failAt} should have crashed`);
    // D · contained: generic body, no-store, no key/secret/detail leaked.
    const crashBody = await crashed.json();
    assert.deepEqual(crashBody, { error: "server error" }, `failAt=${failAt} body`);
    assert.equal(crashed.headers.get("cache-control"), "no-store", `failAt=${failAt} no-store`);
    const text = JSON.stringify(crashBody);
    assert.ok(!text.includes("crash") && !text.includes("recovery:") && !text.includes(expected) && !text.includes(SECRET));

    // If the crash was after the claim write, it is a started record with a
    // stable startedAt and a resume tag.
    const startedClaim = store.has(`recovery-reset:${rid}`) ? JSON.parse(store.get(`recovery-reset:${rid}`)) : null;
    if (startedClaim) {
      assert.equal(startedClaim.status, "started", `failAt=${failAt}: claim not marked started`);
      assert.ok(startedClaim.resumeTag, `failAt=${failAt}: claim missing resume tag`);
    }

    const envOk = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: SECRET };
    const done = await call(envOk, { requestId: rid, leagueCode: code, memberUid: "gift" });
    assert.equal(done.status, 200, `failAt=${failAt} retry`);
    assert.equal((await done.json()).recovery, expected, `failAt=${failAt}: a different code was minted`);

    assert.deepEqual(recoveryFor(store, "gift"), [expected], `failAt=${failAt}: not exactly one credential`);
    assert.equal(JSON.parse(store.get("user:gift")).recovery, expected, `failAt=${failAt}: record not updated`);
    if (oldCode !== expected) assert.equal(store.has(`recovery:${oldCode}`), false, `failAt=${failAt}: old mapping survived`);
    const audit = JSON.parse(store.get(`recovery-reset:${rid}`));
    assert.equal(audit.status, "completed", `failAt=${failAt}: audit not completed`);
    assert.ok(audit.completedAt, `failAt=${failAt}: audit not finalised`);
    assert.equal(audit.mapped, undefined, `failAt=${failAt}: transient flag leaked into the final audit`);
    assert.equal(audit.resumeTag, undefined, `failAt=${failAt}: resume tag leaked into completed audit`);
    if (startedClaim) assert.equal(audit.startedAt, startedClaim.startedAt, `failAt=${failAt}: startedAt not preserved`);
  }
});

// --- 13 · a replay returns the same code and never rotates twice -----------

test("13 · the same requestId replays the same code, replayed:true, one rotation", async () => {
  const { env, store, code } = await seeded();
  const rid = UUID();
  const first = await (await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" })).json();
  assert.equal(first.replayed, false);
  const auditAfterFirst = JSON.parse(store.get(`recovery-reset:${rid}`));
  const second = await (await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" })).json();
  assert.equal(second.recovery, first.recovery);
  assert.equal(second.replayed, true);
  assert.deepEqual(recoveryFor(store, "gift"), [first.recovery], "a replay minted a second credential");
  // A replay preserves both timestamps — it does not rewrite the audit at all.
  const auditAfterReplay = JSON.parse(store.get(`recovery-reset:${rid}`));
  assert.equal(auditAfterReplay.startedAt, auditAfterFirst.startedAt);
  assert.equal(auditAfterReplay.completedAt, auditAfterFirst.completedAt);
});

// --- 14 · a requestId cannot be reused for another target ------------------

test("14 · reusing a requestId for a different member is refused", async () => {
  const { env, store, code } = await seeded();
  const rid = UUID();
  await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" });
  const before = snapshot(store);
  const res = await call(env, { requestId: rid, leagueCode: code, memberUid: "other" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /different target/);
  assert.deepEqual(snapshot(store), before, "the reuse mutated state");
});

// --- 15 · the audit record holds the facts and no secrets ------------------

test("15 · the audit record carries the required fields and no credential", async () => {
  const { env, store, code } = await seeded();
  const rid = UUID();
  const body = await (await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" })).json();
  const audit = JSON.parse(store.get(`recovery-reset:${rid}`));
  assert.deepEqual(Object.keys(audit).sort(),
    ["action", "actor", "completedAt", "leagueCode", "requestId", "route", "startedAt", "status", "targetNick", "targetUid"]);
  assert.equal(audit.status, "completed");
  assert.ok(audit.startedAt);
  assert.equal(audit.resumeTag, undefined);
  assert.equal(audit.action, "recovery-reset");
  assert.equal(audit.route, "/admin/recovery-reset");
  assert.equal(audit.requestId, rid);
  assert.equal(audit.leagueCode, code);
  assert.equal(audit.targetUid, "gift");
  assert.equal(audit.targetNick, "The Gift");
  assert.equal(audit.actor, "recovery-admin");
  const serialised = JSON.stringify(audit);
  assert.ok(!serialised.includes(body.recovery), "the new code leaked into the audit");
  assert.ok(!/hash|fingerprint|digest|secret/i.test(serialised), "a credential fingerprint leaked");
});

// --- 16 · caching is disabled on success and error -------------------------

test("16 · every response is Cache-Control: no-store", async () => {
  const { env, code } = await seeded();
  const ok = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const bad = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "ghost" });
  assert.equal(bad.headers.get("cache-control"), "no-store");
  const unauth = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" }, { auth: "wrong" });
  assert.equal(unauth.headers.get("cache-control"), "no-store");
  const invalid = await call(env, { requestId: "not-a-uuid", leagueCode: code, memberUid: "gift" });
  assert.equal(invalid.headers.get("cache-control"), "no-store");
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
  await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });

  const touched = [...kv.reads, ...kv.writes];
  assert.ok(touched.every((k) => !k.startsWith("picks:")), "a pick key was touched");
  assert.ok(touched.every((k) => !k.startsWith("results:")), "a results key was touched");
  assert.ok(kv.reads.filter((k) => k.startsWith("league:")).every((k) => k === `league:${code}`), "another league was read");
  assert.ok(kv.writes.every((k) => /^(recovery:|user:|recovery-reset:)/.test(k)), `unexpected write: ${kv.writes}`);
  assert.ok(kv.writes.filter((k) => k.startsWith("user:")).every((k) => k === "user:gift"), "a second user was written");
});

// --- 18 · the change is confined to the worker -----------------------------

test("18 · no client, notification or settlement surface is involved", async () => {
  const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const start = src.indexOf("async function recoveryReset(");
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  for (const forbidden of ["pushToUids", "notify", "autoSettle", "planKickoff", "sendPush", "NOTIFY_QUEUE"]) {
    assert.ok(!fn.includes(forbidden), `the handler reaches into ${forbidden}`);
  }
  const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.ok(!app.includes("recovery-reset"), "the admin route leaked into the client");
});

// --- A · the derivation is secret-keyed ------------------------------------

test("A · the code is keyed by the secret; audit fields alone cannot reproduce it", async () => {
  const rid = UUID();
  // Deterministic for the same (secret, requestId, uid).
  assert.equal(await derive(SECRET, rid, "gift"), await derive(SECRET, rid, "gift"));
  // A different secret, requestId or uid all change it.
  assert.notEqual(await derive(SECRET, rid, "gift"), await derive("other-secret", rid, "gift"));
  assert.notEqual(await derive(SECRET, rid, "gift"), await derive(SECRET, UUID(), "gift"));
  assert.notEqual(await derive(SECRET, rid, "gift"), await derive(SECRET, rid, "other"));

  // The live code from a reset equals the SECRET-keyed derivation, and NOT a
  // derivation from the audit fields (requestId, uid) without the secret.
  const { env, code } = await seeded();
  const body = await (await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" })).json();
  assert.equal(body.recovery, await derive(SECRET, rid, "gift"));
  assert.notEqual(body.recovery, await derive("a-guess", rid, "gift"), "a wrong secret reproduced the code");
  assert.notEqual(body.recovery, await derive("another-wrong-secret", rid, "gift"));
});

test("A · a completed replay after the secret is rotated refuses, no mutation", async () => {
  const { store, code } = await seeded();
  const rid = UUID();
  const envA = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: "secret-A" };
  const first = await (await call(envA, { requestId: rid, leagueCode: code, memberUid: "gift" }, { auth: "secret-A" })).json();
  const before = snapshot(store);
  // Secret rotated; the same requestId is replayed.
  const envB = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: "secret-B" };
  const res = await call(envB, { requestId: rid, leagueCode: code, memberUid: "gift" }, { auth: "secret-B" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cannot be replayed after a credential change/);
  assert.deepEqual(snapshot(store), before, "a rotated-secret replay mutated state");
  // The credential minted under secret-A is still the one and only live code.
  assert.deepEqual(recoveryFor(store, "gift"), [first.recovery]);
});

test("E · mapping written, not completed, secret rotated: retry refuses, no second code", async () => {
  const { store, code } = await seeded();
  const rid = UUID();
  // Attempt-1 under secret-A got as far as: a started claim (resume tag under
  // secret-A) and the candidate mapping written — but crashed before
  // completion. This is precisely the gap E names.
  const candA = await derive("secret-A", rid, "gift");
  const tagA = await resumeTag("secret-A", rid, "gift");
  store.set(`recovery:${candA}`, JSON.stringify("gift"));
  store.set(`recovery-reset:${rid}`, JSON.stringify({
    action: "recovery-reset", route: "/admin/recovery-reset", requestId: rid,
    leagueCode: code, targetUid: "gift", targetNick: "The Gift", actor: "recovery-admin",
    status: "started", startedAt: "2026-01-01T00:00:00.000Z", resumeTag: tagA,
  }));
  const before = snapshot(store);
  // The secret is rotated, then the same requestId is retried.
  const envB = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: "secret-B" };
  const res = await call(envB, { requestId: rid, leagueCode: code, memberUid: "gift" }, { auth: "secret-B" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cannot be safely resumed after a credential change/);
  assert.deepEqual(snapshot(store), before, "the rotated-secret resume mutated state");
  // The original candidate mapping remains; no secret-B credential was created.
  assert.equal(JSON.parse(store.get(`recovery:${candA}`)), "gift", "the original mapping was disturbed");
  const candB = await derive("secret-B", rid, "gift");
  assert.equal(store.has(`recovery:${candB}`), false, "a second credential was created");
});

test("F · the audit goes started -> completed, dropping the resume tag", async () => {
  const { store, code } = await seeded();
  const rid = UUID();
  // Stop right after the claim write (op1 = claim, op2 = recovery put fails).
  const envFail = { KV: failingKV(store, 2), RECOVERY_ADMIN_SECRET: SECRET };
  await call(envFail, { requestId: rid, leagueCode: code, memberUid: "gift" });
  const started = JSON.parse(store.get(`recovery-reset:${rid}`));
  assert.equal(started.status, "started");
  assert.ok(started.startedAt);
  assert.ok(started.resumeTag);
  assert.equal(started.completedAt, undefined);
  // Complete it; startedAt is preserved and the resume tag is gone.
  const envOk = { KV: memoryKV(store), RECOVERY_ADMIN_SECRET: SECRET };
  await call(envOk, { requestId: rid, leagueCode: code, memberUid: "gift" });
  const done = JSON.parse(store.get(`recovery-reset:${rid}`));
  assert.equal(done.status, "completed");
  assert.equal(done.startedAt, started.startedAt, "startedAt not preserved");
  assert.ok(done.completedAt);
  assert.equal(done.resumeTag, undefined, "the resume tag survived into the completed audit");
});

// --- B · candidate ownership is checked on every attempt -------------------

test("B · an incomplete claim whose candidate is now owned by another uid refuses", async () => {
  const { store, env, code } = await seeded();
  const rid = UUID();
  const candidate = await derive(SECRET, rid, "gift");
  // An incomplete claim exists (attempt-1 got as far as the claim)...
  store.set(`recovery-reset:${rid}`, JSON.stringify({
    action: "recovery-reset", route: "/admin/recovery-reset", requestId: rid,
    leagueCode: code, targetUid: "gift", targetNick: "The Gift", actor: "recovery-admin",
  }));
  // ...and, in the window before the retry, another account came to own the
  // candidate mapping.
  store.set(`recovery:${candidate}`, JSON.stringify("another-account"));
  const before = snapshot(store);
  const res = await call(env, { requestId: rid, leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /collides with another account/);
  assert.deepEqual(snapshot(store), before, "the retry overwrote another account or mutated the claim");
});

// --- C · identifiers are validated and bounded; accounts must be coherent ---

test("C · malformed or oversized identifiers are refused with no mutation", async () => {
  const { env, store, code } = await seeded();
  const before = snapshot(store);
  const cases = [
    { requestId: "not-a-uuid", leagueCode: code, memberUid: "gift" },
    { requestId: "x".repeat(400), leagueCode: code, memberUid: "gift" },
    { requestId: UUID(), leagueCode: "ABC123", memberUid: "gift" },   // '1' is not in the alphabet
    { requestId: UUID(), leagueCode: "TOOLONGCODE", memberUid: "gift" },
    { requestId: UUID(), leagueCode: code, memberUid: "u".repeat(200) },
    { requestId: UUID(), leagueCode: code, exactNick: "n".repeat(300) },
    // 8-4-4-4-12 hex, but an invalid version (6) and variant (1) nibble.
    { requestId: "12345678-1234-6234-1234-123456789012", leagueCode: code, memberUid: "gift" },
    // One character past normNick()'s 24 — refused, never truncated to match.
    { requestId: UUID(), leagueCode: code, exactNick: "n".repeat(25) },
  ];
  for (const body of cases) {
    const res = await call(env, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(snapshot(store), before, "a malformed request mutated state");
});

test("C · an account missing or not carrying the named league is refused", async () => {
  const { env, store, code } = await seeded();
  // leagues absent entirely.
  const u1 = await env.KV.get("user:gift"); delete u1.leagues; await env.KV.put("user:gift", JSON.stringify(u1));
  let before = snapshot(store);
  let res = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "target account is not restorable" });
  assert.deepEqual(snapshot(store), before);

  // leagues present but does not contain this league.
  const u2 = await env.KV.get("user:gift"); u2.leagues = ["OTHER1"]; await env.KV.put("user:gift", JSON.stringify(u2));
  before = snapshot(store);
  res = await call(env, { requestId: UUID(), leagueCode: code, memberUid: "gift" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "target account is not restorable" });
  assert.deepEqual(snapshot(store), before);
});
