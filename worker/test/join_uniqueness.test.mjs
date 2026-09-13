// v1.8 Slice A — safe one-step invitation joining, worker side.
//
// The whole point is that display-name uniqueness holds atomically in the
// worker, not merely in a client. These run the REAL LeagueRegistrar Durable
// Object over real SQLite (node:sqlite), wired into the real /join handler, so
// a guarantee proved here is proved about the code that ships.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { normaliseJoinNick } from "../src/logic.js";
import { registrarNamespace } from "./registrar_harness.mjs";

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

function world({ registrar = true } = {}) {
  const store = new Map();
  const env = { KV: memoryKV(store) };
  // registrar: true -> a fresh real namespace; an object -> use it (a fault
  // injector); false -> no binding at all (the fail-closed path).
  if (registrar === true) env.LEAGUE_REGISTRAR = registrarNamespace();
  else if (registrar) env.LEAGUE_REGISTRAR = registrar;
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { store, env, post };
}

/** A registrar namespace that can be told to fail the NEXT n calls of an op
 *  (release/purge), then behaves normally — for proving resumable teardown. */
function controllableRegistrar() {
  const real = registrarNamespace();
  const fail = { release: 0, purge: 0, begin: 0, commit: 0 };
  const namespace = {
    idFromName: (name) => real.idFromName(name),
    get(id) {
      const inner = real.get(id);
      return {
        fetch: async (url, init) => {
          const op = JSON.parse(init.body).op;
          if (fail[op] > 0) { fail[op] -= 1; return new Response("{}", { status: 500 }); }
          return inner.fetch(url, init);
        },
      };
    },
  };
  return { namespace, failNext: (op, n = 1) => { fail[op] += n; } };
}

/** Direct RPC to a league's real registrar instance, for driving crash points. */
const rpcTo = (env, code) => {
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  return (op, args) => stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  }).then((r) => r.json());
};

async function withLeague(opts = {}) {
  const w = world(opts);
  const created = await (await w.post("/league", { uid: "host", nickname: "Host" })).json();
  return { ...w, code: created.code };
}

const memberNicks = (store, code) => [...store.keys()]
  .filter((k) => k.startsWith(`member:${code}:`))
  .map((k) => JSON.parse(store.get(k)).nick);

// --- available name: invitation through to a real membership ----------------

test("an available name joins in one call and lands the member", async () => {
  const { post, store, code } = await withLeague();
  const res = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, code);
  assert.ok(body.recovery, "a recovery code was returned");
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Ferdinand");
  assert.deepEqual((await env2leagues(store, "u1")), [code]);
});
async function env2leagues(store, uid) { return JSON.parse(store.get(`user:${uid}`)).leagues; }

// --- taken name: case and surrounding-space variants ------------------------

test("a taken name is refused — case and spacing do not evade it", async () => {
  const { post, store, code } = await withLeague();
  assert.equal((await post("/join", { uid: "u1", code, nick: "The Gift" })).status, 200);

  for (const variant of ["The Gift", "the gift", "  THE   GIFT  ", "tHe gIfT"]) {
    const res = await post("/join", { uid: "u2", code, nick: variant });
    assert.equal(res.status, 409, `variant ${JSON.stringify(variant)} was not refused`);
    const body = await res.json();
    assert.equal(body.taken, true);
    assert.ok(Array.isArray(body.suggestions) && body.suggestions.length > 0, "no suggestions offered");
  }
  // u2 never became a member, and no account/recovery was minted for it.
  assert.equal(store.has(`member:${code}:u2`), false, "a refused join left a partial membership");
  assert.equal(store.has("user:u2"), false, "a refused join minted an account");
  assert.deepEqual(memberNicks(store, code).sort(), ["Host", "The Gift"]);
});

// --- suggested alternatives are themselves free -----------------------------

test("the suggestions offered are actually available names", async () => {
  const { post, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Striker" });
  const body = await (await post("/join", { uid: "u2", code, nick: "Striker" })).json();
  assert.ok(body.suggestions.length >= 1);
  // Each suggestion, offered by a fresh uid, must succeed.
  for (const [i, name] of body.suggestions.entries()) {
    const res = await post("/join", { uid: `s${i}`, code, nick: name });
    assert.equal(res.status, 200, `suggested "${name}" was not free`);
  }
});

// --- concurrency: only one of two identical joins wins ----------------------

test("concurrent same-name joins: exactly one succeeds", async () => {
  const { post, store, code } = await withLeague();
  const contenders = ["a", "b", "c", "d", "e"];
  const results = await Promise.all(contenders.map((u) => post("/join", { uid: u, code, nick: "Captain" })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, `expected one win, got ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, contenders.length - 1);
  // Exactly one member carries the name (besides the host).
  assert.equal(memberNicks(store, code).filter((n) => normaliseJoinNick(n) === "captain").length, 1);
});

// --- retry / crash-interruption safety --------------------------------------

test("a repeated identical join is idempotent — one membership, no error", async () => {
  const { post, store, code } = await withLeague();
  const a = await post("/join", { uid: "u1", code, nick: "Rooney" });
  const b = await post("/join", { uid: "u1", code, nick: "Rooney" });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, "a retry of one's own join was refused");
  assert.equal(memberNicks(store, code).filter((n) => n === "Rooney").length, 1);
  const bodyB = await b.json();
  assert.equal(bodyB.recovery, (await a.json()).recovery, "the retry minted a second recovery credential");
});

test("a claim without its membership write completes on retry, no duplicate", async () => {
  // Simulate a crash AFTER the atomic claim but BEFORE the member write: the
  // registrar holds u1's name, KV has no membership yet.
  const { post, env, store, code } = await withLeague();
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  const claimed = await (await stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "begin", uid: "u1", nick: "Keeper", roster: [], now: Date.now() }),
  })).json();
  assert.equal(claimed.ok, true);
  assert.equal(store.has(`member:${code}:u1`), false, "no membership yet");

  // The retry (same uid, same name) sees its own held claim and completes.
  const res = await post("/join", { uid: "u1", code, nick: "Keeper" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Keeper");
  // And a DIFFERENT uid still cannot take the half-claimed name.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Keeper" })).status, 409);
});

// --- existing duplicate-name league compatibility ---------------------------

test("pre-existing duplicate names are preserved and never rewritten", async () => {
  const { post, store, code } = await withLeague();
  // Two members already share a name, as could exist from before v1.8. Written
  // straight to KV; the registrar learns them from the roster it is seeded with.
  store.set(`member:${code}:old1`, JSON.stringify({ nick: "Legend", since: 1 }));
  store.set(`member:${code}:old2`, JSON.stringify({ nick: "Legend", since: 2 }));

  // Either existing "Legend" may re-join with their own name — idempotent.
  assert.equal((await post("/join", { uid: "old1", code, nick: "Legend" })).status, 200);
  assert.equal((await post("/join", { uid: "old2", code, nick: "Legend" })).status, 200);
  // Both are still "Legend"; nothing was rewritten.
  assert.deepEqual(memberNicks(store, code).filter((n) => n === "Legend"), ["Legend", "Legend"]);
  // But a NEW third "Legend" is refused.
  assert.equal((await post("/join", { uid: "u3", code, nick: "Legend" })).status, 409);
});

// --- unknown / deleted league, and unpublished slate ------------------------

test("joining an unknown or deleted league fails honestly", async () => {
  const { post, env, store } = await withLeague();
  assert.equal((await post("/join", { uid: "u1", code: "ZZZZZZ", nick: "Nobody" })).status, 404);
  // Delete a real league, then a join fails 404 with no membership written.
  const created = await (await post("/league", { uid: "h2", nickname: "H2" })).json();
  await post("/league/delete", { uid: "h2", code: created.code });
  const res = await post("/join", { uid: "u1", code: created.code, nick: "Late" });
  assert.equal(res.status, 404);
  assert.equal(store.has(`member:${created.code}:u1`), false);
});

test("an unpublished slate does not block joining (join precedes any slate)", async () => {
  // A freshly created league has no published slate yet; a member can still join.
  const { post, code } = await withLeague();
  assert.equal((await post("/join", { uid: "u1", code, nick: "Early Bird" })).status, 200);
});

// --- multi-league: a name taken in one league is free in another ------------

test("uniqueness is per-league — the same name is free in a different league", async () => {
  const { post } = await withLeague();
  const A = await (await post("/league", { uid: "ha", nickname: "HA" })).json();
  const B = await (await post("/league", { uid: "hb", nickname: "HB" })).json();
  assert.equal((await post("/join", { uid: "u1", code: A.code, nick: "Same Name" })).status, 200);
  // Different uid, different league, same name — allowed.
  assert.equal((await post("/join", { uid: "u2", code: B.code, nick: "Same Name" })).status, 200);
  // Same league, different uid — refused.
  assert.equal((await post("/join", { uid: "u3", code: A.code, nick: "Same Name" })).status, 409);
});

// --- backward compatibility with the v1.7.1 client --------------------------

test("the v1.7.1 request shape still joins", async () => {
  // The shipped client sends {uid, nickname, nick, code}; an available name works.
  const { post, store, code } = await withLeague();
  const res = await post("/join", { uid: "u1", nickname: "Adam", nick: "Adam", code });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Adam");
});

test("a nameless join is refused with no mutation — no anonymous bypass (Slice A/B)", async () => {
  // No per-league nick and no profile name. The old fallback minted an
  // unarbitrated "Anon"; that is exactly the anonymous uniqueness bypass the
  // review closed. A genuinely nameless request now refuses and writes nothing.
  const { post, store, code } = await withLeague();
  const res = await post("/join", { uid: "u1", code });
  assert.equal(res.status, 400);
  assert.equal(store.has(`member:${code}:u1`), false, "a nameless join wrote a membership");
  assert.equal(store.has("user:u1"), false, "a nameless join minted an account");
});

// --- no atomic authority: fail closed, never proceed non-atomically ---------

test("without the registrar a named join fails closed with 503 and no mutation (Slice A/A)", async () => {
  // The registrar's absence is a broken configuration, not a degraded mode. A
  // named join must not proceed non-atomically; it refuses, retryably, and
  // mints no account, recovery or membership.
  const { post, store, code } = await withLeague({ registrar: false });
  const res = await post("/join", { uid: "u1", code, nick: "Solo" });
  assert.equal(res.status, 503, "a named join proceeded without atomic authority");
  const body = await res.json();
  assert.equal(body.retryable, true, "the 503 did not advertise itself as retryable");
  assert.equal(store.has(`member:${code}:u1`), false, "a fail-closed join wrote a membership");
  assert.equal(store.has("user:u1"), false, "a fail-closed join minted an account");
});

// --- UID remains identity ---------------------------------------------------

test("the display name is never the account key — UID is", async () => {
  const { post, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Handle" });
  // Membership and account are keyed by uid; the nick is only a field.
  assert.ok(store.has(`member:${code}:u1`) && store.has("user:u1"));
  assert.ok(![...store.keys()].some((k) => k.includes("Handle") || k.toLowerCase().includes("handle")),
    "a nickname leaked into a key");
});

// --- lifecycle across the whole membership surface (Slice A/D) ---------------
//
// Every path that changes who holds a name routes through the registrar, so its
// authority never drifts from KV: a rename is a contest, a removed member frees
// the name (and a stale roster cannot resurrect it), and a deleted league drops
// every claim.

test("D · a rename to a name another member holds is refused, and nothing changes", async () => {
  const { post, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Beckham" });
  await post("/join", { uid: "u2", code, nick: "Scholes" });
  const res = await post("/league/nick", { uid: "u2", code, nick: "Beckham" });
  assert.equal(res.status, 409, "a colliding rename was allowed");
  assert.deepEqual((await res.json()).suggestions?.length > 0, true, "no alternatives were offered");
  assert.equal(JSON.parse(store.get(`member:${code}:u2`)).nick, "Scholes", "the rename wrote anyway");
});

test("D · a rename to a free name succeeds and the old name frees up", async () => {
  const { post, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Giggs" });
  assert.equal((await post("/league/nick", { uid: "u1", code, nick: "Ryan" })).status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Ryan");
  // The vacated name is now available to someone else.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Giggs" })).status, 200);
});

test("D · a kicked member's name is reusable, by a newcomer or the returning member", async () => {
  const { post, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.equal(store.has(`member:${code}:u1`), false, "the membership survived the kick");
  // A brand-new member may take the freed name...
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 200);
  // ...and once it is taken again, a third cannot.
  assert.equal((await post("/join", { uid: "u3", code, nick: "Cantona" })).status, 409);
});

test("D · an account deletion frees its names for reuse in each league", async () => {
  const { post, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Keane" });
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 200);
  assert.equal(store.has(`member:${code}:u1`), false, "the membership survived deletion");
  assert.equal((await post("/join", { uid: "u2", code, nick: "Keane" })).status, 200, "the freed name was not reusable");
});

test("D · deleting a league purges its claims, so its codes can be reused elsewhere", async () => {
  const { post, env, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Neville" });
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  // The registrar instance for that code holds nothing — a check on the same
  // name comes back available (the DO storage was purged).
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  const avail = await (await stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "check", uid: "someone-else", nick: "Neville", roster: [], now: Date.now() }),
  })).json();
  assert.equal(avail.available, true, "a purged registrar still held a claim");
});

test("D · a stale KV roster listing a released member never resurrects the claim", async () => {
  // The dangerous read-after-write lag: a member is kicked (released in the
  // registrar and gone from KV in production) but a lagging roster still lists
  // them. Reconciliation must NOT revive that released claim, so the freed name
  // stays free for the next joiner.
  const { post, env, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Charlton" });
  await post("/league/kick", { uid: "host", code, memberUid: "u1" });

  // Simulate the lag: re-plant the kicked member's row straight into KV, as an
  // eventually-consistent roster read would still surface.
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Charlton", since: 1 }));

  // A different member claims the name; the stale u1 row must not block it, and
  // reconciliation must not resurrect u1's released claim.
  const res = await post("/join", { uid: "u2", code, nick: "Charlton" });
  assert.equal(res.status, 200, "a released claim was resurrected by a stale roster");
  assert.equal(JSON.parse(store.get(`member:${code}:u2`)).nick, "Charlton");
});

// --- C · every crash point converges, and abandonment cannot strand a name --

test("C · a crash after the membership write but before commit still yields one member", async () => {
  // The registrar holds u1 as pending and the membership is already written,
  // but the commit never landed. A different uid is still blocked (the pending
  // claim is live), and the next roster reconciliation promotes u1's genuine
  // membership so its name is permanent.
  const { post, env, store, code } = await withLeague();
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  const rpc = (op, args) => stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  }).then((r) => r.json());

  await rpc("begin", { uid: "u1", nick: "Solskjaer", roster: [], now: Date.now() });
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Solskjaer", since: 1 })); // membership written, commit lost
  // A different uid cannot take the pending name.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Solskjaer" })).status, 409);
  // A reconcile (any join carries the roster) promotes u1's real membership.
  await post("/join", { uid: "u3", code, nick: "Sheringham" });
  const state = await rpc("check", { uid: "u2", nick: "Solskjaer", roster: [], now: Date.now() });
  assert.equal(state.available, false, "u1's genuine membership was not committed by reconcile");
});

test("C · an abandoned pending claim expires and no longer reserves the name", async () => {
  const { env, code } = await withLeague();
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  const rpc = (op, args) => stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  }).then((r) => r.json());

  const t0 = 1_000_000;
  await rpc("begin", { uid: "u1", nick: "Berbatov", roster: [], now: t0 });
  // Within the TTL, another uid is blocked.
  assert.equal((await rpc("begin", { uid: "u2", nick: "Berbatov", roster: [], now: t0 + 1000 })).taken, true);
  // Long past the TTL, the abandoned pending claim no longer reserves the name.
  const late = await rpc("begin", { uid: "u2", nick: "Berbatov", roster: [], now: t0 + 11 * 60 * 1000 });
  assert.equal(late.ok, true, "an abandoned pending claim reserved the name forever");
  assert.equal(late.taken, undefined);
});

// === SECOND REVIEW — fence, expiry and resumable teardown =================
// Directly reproduces the three correctness blockers, then proves them closed.

const TTL = 10 * 60 * 1000;

test("A · an expired owner's replay contests afresh — another UID's win refuses it", async () => {
  // The exact sequence from the review.
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const t0 = 1_000_000;
  // 1. u1 begins "Name".
  const b1 = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now: t0 });
  assert.equal(b1.ok, true);
  // 2. u1's pending claim expires. 3. u2 begins and commits "Name".
  const later = t0 + TTL + 1;
  const b2 = await rpc("begin", { uid: "u2", nick: "Name", roster: [], now: later });
  assert.equal(b2.ok, true, "u2 could not take the expired name");
  assert.equal((await rpc("commit", { uid: "u2", norm: b2.norm, fence: b2.fence, now: later })).committed, true);
  // 4. u1 retries "Name". 5. It must be the normal taken refusal, not own:true.
  const b1retry = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now: later });
  assert.equal(b1retry.own, undefined, "an expired pending row was honoured as an owned reservation");
  assert.equal(b1retry.taken, true, "the old UID was not refused after another won the name");
});

test("C · a delayed commit for an expired, reallocated attempt never converts", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const t0 = 2_000_000;
  const b1 = await rpc("begin", { uid: "u1", nick: "Keeper", roster: [], now: t0 });
  const later = t0 + TTL + 1;
  const b2 = await rpc("begin", { uid: "u2", nick: "Keeper", roster: [], now: later });
  await rpc("commit", { uid: "u2", norm: b2.norm, fence: b2.fence, now: later });
  // u1's original commit finally lands — expired AND reallocated to u2.
  const late = await rpc("commit", { uid: "u1", norm: b1.norm, fence: b1.fence, now: later });
  assert.equal(late.committed, false, "a delayed commit converted an expired, reallocated claim");
});

test("C · a second different rename by the same UID fences out the first commit", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 3_000_000;
  const first = await rpc("begin", { uid: "u1", nick: "Alpha", roster: [], now });
  const second = await rpc("begin", { uid: "u1", nick: "Bravo", roster: [], now });
  assert.equal((await rpc("commit", { uid: "u1", norm: first.norm, fence: first.fence, now })).committed, false,
    "the superseded first attempt still committed");
  assert.equal((await rpc("commit", { uid: "u1", norm: second.norm, fence: second.fence, now })).committed, true);
});

test("C · a stale commit after release never resurrects the name", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 4_000_000;
  const b = await rpc("begin", { uid: "u1", nick: "Cantona", roster: [], now });
  await rpc("commit", { uid: "u1", norm: b.norm, fence: b.fence, now });
  await rpc("release", { uid: "u1", now });
  const stale = await rpc("commit", { uid: "u1", norm: b.norm, fence: b.fence, now });
  assert.equal(stale.committed, false, "a stale commit resurrected a released claim");
  // And the name is genuinely free for a newcomer.
  assert.equal((await rpc("check", { uid: "u2", nick: "Cantona", roster: [], now })).available, true);
});

test("C · an ordinary idempotent retry still commits", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 5_000_000;
  const b1 = await rpc("begin", { uid: "u1", nick: "Solskjaer", roster: [], now });
  await rpc("commit", { uid: "u1", norm: b1.norm, fence: b1.fence, now });
  // Same uid, same name again: idempotent success, and commit still lands.
  const b2 = await rpc("begin", { uid: "u1", nick: "Solskjaer", roster: [], now });
  assert.equal(b2.ok, true);
  assert.equal((await rpc("commit", { uid: "u1", norm: b2.norm, fence: b2.fence, now })).committed, true);
});

test("B · a stale reconcile during a crossed rename cancels neither, allocates once", async () => {
  // u1 and u2 are members; u1 has a rename to "New" in flight (a live pending
  // attempt). u2 then renames to "New" through the REAL /league/nick route,
  // whose begin reconciles a roster that still shows u1 as "Old".
  const { post, env, store, code } = await withLeague();
  await post("/join", { uid: "u1", code, nick: "Old" });
  await post("/join", { uid: "u2", code, nick: "Other" });
  const rpc = rpcTo(env, code);
  // Real time, because the contesting request goes through the worker, which
  // stamps its own Date.now(); a fake clock would make u1's claim look expired.
  const now = Date.now();
  // u1's rename to "New" is in flight: a live pending attempt, KV still "Old".
  const u1new = await rpc("begin", { uid: "u1", nick: "New", roster: [], now });
  assert.equal(u1new.ok, true);

  // u2 renames to "New" through the route — its begin reconciles the stale
  // roster (u1 still "Old"). The stale row must NOT promote/rewrite u1's active
  // rename, and u2 must NOT win the name.
  const res = await post("/league/nick", { uid: "u2", code, nick: "New" });
  assert.equal(res.status, 409, "u2 won a name still held by u1's in-flight rename");
  assert.equal(JSON.parse(store.get(`member:${code}:u2`)).nick, "Other", "u2's membership was rewritten");

  // u1's active attempt survived the stale reconcile and can still commit.
  assert.equal((await rpc("commit", { uid: "u1", norm: u1new.norm, fence: u1new.fence, now })).committed, true,
    "the stale reconcile cancelled u1's active rename");
});

// --- D · teardown is resumable and idempotent across registrar failure ------

test("D · a kick whose release fails refuses, and a retry completes it", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  ctl.failNext("release", 1);
  const first = await post("/league/kick", { uid: "host", code, memberUid: "u1" });
  assert.equal(first.status, 503, "a kick reported success while the release was outstanding");
  assert.equal(store.has(`member:${code}:u1`), true, "the membership was torn down before the name was freed");
  // Retry: release succeeds, member removed, name reusable.
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.equal(store.has(`member:${code}:u1`), false);
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 200, "the freed name was not reusable");
});

test("D · a league delete whose purge fails refuses, and a retry completes it", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Neville" });
  ctl.failNext("purge", 1);
  const first = await post("/league/delete", { uid: "host", code });
  assert.equal(first.status, 503, "a delete reported success while the purge was outstanding");
  assert.equal(store.has(`league:${code}`), true, "the league record was erased before the purge landed");
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.equal(store.has(`league:${code}`), false);
});

test("D · an account delete whose release fails keeps the user record for the retry", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Keane" });
  ctl.failNext("release", 1);
  const first = await post("/account/delete", { uid: "u1" });
  assert.equal(first.status, 503, "an account delete reported success while a release was outstanding");
  assert.equal(store.has("user:u1"), true, "the user record — the resume context — was erased on failure");
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 200);
  assert.equal(store.has("user:u1"), false);
  assert.equal((await post("/join", { uid: "u2", code, nick: "Keane" })).status, 200, "the freed name was not reusable");
});

// --- E · a malformed registrar answer fails closed --------------------------

test("E · a malformed begin fails the join closed, writing nothing", async () => {
  // A namespace whose begin returns a 200 with an unrecognised shape.
  const real = registrarNamespace();
  const namespace = {
    idFromName: (name) => real.idFromName(name),
    get(id) {
      const inner = real.get(id);
      return {
        fetch: async (url, init) => {
          const op = JSON.parse(init.body).op;
          if (op === "begin") return new Response(JSON.stringify({ surprise: true }), { status: 200 });
          return inner.fetch(url, init);
        },
      };
    },
  };
  const { post, store, code } = await withLeague({ registrar: namespace });
  const res = await post("/join", { uid: "u1", code, nick: "Ghost" });
  assert.equal(res.status, 503, "a malformed begin was trusted");
  assert.equal(store.has(`member:${code}:u1`), false, "a malformed begin still wrote a membership");
  assert.equal(store.has("user:u1"), false, "a malformed begin still minted an account");
});
