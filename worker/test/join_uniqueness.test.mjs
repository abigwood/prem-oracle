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

function world({ registrar = true, kv } = {}) {
  const store = new Map();
  const env = { KV: kv || memoryKV(store) };
  // registrar: true -> a fresh real namespace; an object -> use it (a fault
  // injector); false -> no binding at all (the fail-closed path).
  if (registrar === true) env.LEAGUE_REGISTRAR = registrarNamespace();
  else if (registrar) env.LEAGUE_REGISTRAR = registrar;
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { store, env, post };
}

/** A KV that can be "armed" to THROW on the first write/delete whose key matches
 *  a substring — a faithful mid-handler crash (the worker's top-level catch
 *  turns it into a 500). Disarming restores normal operation for the retry. */
function crashableKV(store = new Map()) {
  let armed = null; // { op, match } — fires once
  const fireIfArmed = (op, key) => {
    if (armed && armed.op === op && key.includes(armed.match)) { armed = null; throw new Error("crash"); }
  };
  const kv = {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { fireIfArmed("put", key); store.set(key, value); },
    async delete(key) { fireIfArmed("delete", key); store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
  return { kv, store, crashOn: (op, match) => { armed = { op, match }; }, disarm: () => { armed = null; } };
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

/** A registrar that returns a caller-supplied commit VERDICT (a well-formed 200,
 *  not an error) for the next n commits — for proving definitive committed:false
 *  handling through a route. begin is left real, so the name is genuinely held. */
function commitVerdictRegistrar(verdict) {
  const real = registrarNamespace();
  let n = 0;
  const namespace = {
    idFromName: (name) => real.idFromName(name),
    get(id) {
      const inner = real.get(id);
      return {
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          if (body.op === "commit" && n > 0) {
            n -= 1;
            return new Response(JSON.stringify({ uid: body.uid, norm: body.norm, ...verdict(body) }),
              { status: 200, headers: { "content-type": "application/json" } });
          }
          return inner.fetch(url, init);
        },
      };
    },
  };
  return { namespace, failCommits: (count = 1) => { n += count; } };
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

// --- C/D · teardown is a resumable, crash-safe intent/outbox ----------------
// The live record is removed BEFORE the registrar side, so a crash between them
// leaves the name over-reserved (a concurrent join is refused), never a live
// member with no registrar authority. The intent lets a retry finish.

const kickIntent = (code, uid) => `intent:kick:${code}:${uid}`;
const leagueIntent = (code) => `intent:league:${code}`;
const accountIntent = (uid) => `intent:account:${uid}`;

test("C · a kick that stalls before release: member gone, name held, join refused, retry frees it", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  ctl.failNext("release", 1);
  const first = await post("/league/kick", { uid: "host", code, memberUid: "u1" });
  assert.equal(first.status, 503, "a kick reported success while the release was outstanding");
  // Live membership already removed; the name is still reserved (over-reservation).
  assert.equal(store.has(`member:${code}:u1`), false, "the live membership was not removed first");
  assert.ok(store.has(kickIntent(code, "u1")), "no resumable intent was recorded");
  // A concurrent join to the not-yet-released name is refused — never a duplicate.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 409,
    "the name was reusable before the release completed");
  // Retry resumes from the intent (member already gone) and completes.
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.ok(!store.has(kickIntent(code, "u1")), "the intent was not cleared on completion");
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 200, "the freed name was not reusable");
});

test("C · a league delete that stalls before purge: league gone, join refused, retry completes", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Neville" });
  ctl.failNext("purge", 1);
  const first = await post("/league/delete", { uid: "host", code });
  assert.equal(first.status, 503, "a delete reported success while the purge was outstanding");
  // The league is already inaccessible; the intent remains for the retry.
  assert.equal(store.has(`league:${code}`), false, "the live league was not made inaccessible first");
  assert.ok(store.has(leagueIntent(code)), "no resumable intent was recorded");
  // A concurrent join to the dying league is refused (respects the intent).
  assert.equal((await post("/join", { uid: "u9", code, nick: "Latecomer" })).status, 404,
    "a join repopulated a league being deleted");
  // Retry resumes (league record already gone) and completes the purge.
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.ok(!store.has(leagueIntent(code)), "the intent was not cleared on completion");
});

test("C · an account delete across leagues that stalls before release: retry completes", async () => {
  const ctl = controllableRegistrar();
  const { post, store, env } = await withLeague({ registrar: ctl.namespace });
  // u1 joins two leagues; the account deletion must clean both.
  const a = await (await post("/league", { uid: "ha", nickname: "HA" })).json();
  const b = await (await post("/league", { uid: "hb", nickname: "HB" })).json();
  await post("/join", { uid: "u1", code: a.code, nick: "Keane" });
  await post("/join", { uid: "u1", code: b.code, nick: "Roy" });
  ctl.failNext("release", 1); // the FIRST league's release stalls
  const first = await post("/account/delete", { uid: "u1" });
  assert.equal(first.status, 503, "an account delete reported success while a release was outstanding");
  // The resume context is retained until every release lands.
  assert.ok(store.has(accountIntent("u1")), "no resumable account intent was recorded");
  assert.ok(store.has("user:u1"), "the user record — resume context — was erased before releases completed");
  // Retry resumes and completes; both names free again, account gone.
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 200);
  assert.ok(!store.has(accountIntent("u1")), "the intent was not cleared on completion");
  assert.equal(store.has("user:u1"), false);
  assert.equal((await post("/join", { uid: "u2", code: a.code, nick: "Keane" })).status, 200);
  assert.equal((await post("/join", { uid: "u3", code: b.code, nick: "Roy" })).status, 200);
});

test("C · lifecycle cleanup fails closed when the registrar binding is absent", async () => {
  // No binding at all: kick, league delete and account delete must refuse rather
  // than silently skip freeing the name / purging.
  const { post, store, code } = await withLeague({ registrar: false });
  // Seed a member and a league directly (join is itself fail-closed without a registrar).
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Ghost", since: 1 }));
  store.set("user:u1", JSON.stringify({ nickname: "Ghost", leagues: [code] }));
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 503);
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 503);
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 503);
});

test("B · an existing member's /join with a different name cannot retain it on commit failure", async () => {
  // /join must not be an unfenced rename. An existing member offering a new name
  // is delegated to the fenced rename, which restores the prior name when commit
  // definitively fails — the new name is never retained (Slice A/B).
  const commitFalse = commitVerdictRegistrar(() => ({ ok: true, committed: false }));
  const { post, store, code } = await withLeague({ registrar: commitFalse.namespace });
  await post("/join", { uid: "u1", code, nick: "Old" });
  commitFalse.failCommits(1);
  const res = await post("/join", { uid: "u1", code, nick: "New" });
  assert.notEqual(res.status, 200, "an existing member retained a new name through /join on commit failure");
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Old", "the prior name was not restored");
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

// --- A · an unknown commit outcome is never reported as success -------------
// A commit whose verdict is missing/malformed/unavailable (even after the safe
// re-read) must produce a retryable response, never HTTP 200 — across every
// commit caller. begin is real, so the fenced state is genuinely held and an
// identical retry converges once commit works.

test("A · a fresh join whose commit stays unknown refuses, then a retry converges", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  ctl.failNext("commit", 2); // both the commit and its safe re-read fail
  const first = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.notEqual(first.status, 200, "a fresh join reported success on an unknown commit");
  // Retry: commit now lands, join confirmed.
  const retry = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Ferdinand");
});

test("A · an existing member's /join rename whose commit stays unknown refuses, then converges", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Old" });
  ctl.failNext("commit", 2);
  const first = await post("/join", { uid: "u1", code, nick: "New" });
  assert.notEqual(first.status, 200, "an existing member's /join rename reported success on an unknown commit");
  const retry = await post("/join", { uid: "u1", code, nick: "New" });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "New");
});

test("A · a /league/nick whose commit stays unknown refuses, then a retry converges", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Old" });
  ctl.failNext("commit", 2);
  const first = await post("/league/nick", { uid: "u1", code, nick: "Fresh" });
  assert.notEqual(first.status, 200, "a rename reported success on an unknown commit");
  const retry = await post("/league/nick", { uid: "u1", code, nick: "Fresh" });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Fresh");
});

test("A · profile propagation whose commit stays unknown is retryable, then converges", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  // An Anon member exists (seeded straight into KV — join needs a name).
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Anon", since: 1 }));
  store.set("user:u1", JSON.stringify({ nickname: "", leagues: [code] }));
  ctl.failNext("commit", 2);
  const first = await post("/profile", { uid: "u1", nickname: "Tom" });
  assert.notEqual(first.status, 200, "profile propagation reported success on an unknown commit");
  assert.equal((await first.json()).retryable, true);
  // Retry: propagation confirmed.
  const retry = await post("/profile", { uid: "u1", nickname: "Tom" });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Tom");
});

// --- C · injected CRASHES (not just RPC errors) after every teardown boundary
// A crash is simulated by a KV op that throws mid-handler (the worker's
// top-level catch turns it into a 500). The durable intent lets a retry resume
// from wherever it stopped — even after the ordinary record is gone — and a
// concurrent join during the incomplete window is refused, never duplicated.

async function seededCrashWorld() {
  const cr = crashableKV();
  const env = { KV: cr.kv, LEAGUE_REGISTRAR: registrarNamespace() };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { cr, store: cr.store, post };
}

test("C · kick — crash mid live-removal: name stays held, join refused, retry completes", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  cr.crashOn("delete", `member:${code}:u1`); // crash while removing the live membership
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 500);
  assert.ok(store.has(kickIntent(code, "u1")), "the intent was not recorded before the crash");
  // The name was never released, so a concurrent join is refused (over-reservation).
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 409);
  // Retry (healthy KV) resumes and completes.
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.ok(!store.has(kickIntent(code, "u1")));
  assert.equal(store.has(`member:${code}:u1`), false);
  assert.equal((await post("/join", { uid: "u2", code, nick: "Cantona" })).status, 200, "the freed name was not reusable");
});

test("C · kick — crash after release, before clearing the intent: retry converges", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Keane" });
  cr.crashOn("delete", kickIntent(code, "u1")); // release has run; clearing the intent crashes
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 500);
  assert.ok(store.has(kickIntent(code, "u1")), "intent should still be present after a clear-time crash");
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.ok(!store.has(kickIntent(code, "u1")));
});

test("C · league delete — crash mid teardown: join refused, retry completes the purge", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Neville" });
  cr.crashOn("delete", `league:${code}`); // crash while making the league inaccessible
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 500);
  assert.ok(store.has(leagueIntent(code)), "the deletion intent was not recorded before the crash");
  // A join during the dying window is refused (respects the intent).
  assert.equal((await post("/join", { uid: "u9", code, nick: "Latecomer" })).status, 404);
  // Retry resumes (from the intent) and completes.
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.ok(!store.has(leagueIntent(code)));
  assert.equal(store.has(`league:${code}`), false);
});

test("C · account delete across leagues — crash mid teardown: retry resumes every league", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const a = await (await post("/league", { uid: "ha", nickname: "HA" })).json();
  const b = await (await post("/league", { uid: "hb", nickname: "HB" })).json();
  await post("/join", { uid: "u1", code: a.code, nick: "Keane" });
  await post("/join", { uid: "u1", code: b.code, nick: "Roy" });
  cr.crashOn("delete", `member:${a.code}:u1`); // crash mid per-league live teardown
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 500);
  assert.ok(store.has(accountIntent("u1")), "the account intent (resume context) was not recorded");
  assert.ok(store.has("user:u1"), "the user record was erased before cleanup completed");
  // Retry resumes across BOTH leagues and completes.
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 200);
  assert.ok(!store.has(accountIntent("u1")));
  assert.equal(store.has("user:u1"), false);
  assert.equal((await post("/join", { uid: "u2", code: a.code, nick: "Keane" })).status, 200);
  assert.equal((await post("/join", { uid: "u3", code: b.code, nick: "Roy" })).status, 200);
});

// === FOURTH REVIEW ==========================================================

// --- A · a fresh join never mints identity before the commit is confirmed ---

test("A · a definitive commit loss leaves no user, recovery, membership or link", async () => {
  const commitFalse = commitVerdictRegistrar(() => ({ ok: true, committed: false }));
  const { post, store, code } = await withLeague({ registrar: commitFalse.namespace });
  commitFalse.failCommits(1);
  const res = await post("/join", { uid: "u1", code, nick: "Ghost" });
  assert.notEqual(res.status, 200, "a lost commit reported success");
  assert.equal(store.has(`member:${code}:u1`), false, "a visible membership was left behind");
  assert.equal(store.has("user:u1"), false, "a user record was minted");
  const recoveries = [...store.keys()].filter((k) => k.startsWith("recovery:"));
  assert.deepEqual(recoveries.filter((k) => JSON.parse(store.get(k)) === "u1"), [],
    "an orphaned recovery credential was minted");
});

test("A · an unknown commit leaves no visible membership and converges on retry", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  ctl.failNext("commit", 2); // commit + safe re-read both fail
  const first = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.notEqual(first.status, 200);
  assert.equal(store.has(`member:${code}:u1`), false, "an unknown commit left a visible membership");
  assert.equal(store.has("user:u1"), false, "an unknown commit minted a user");
  // Retry converges: commit lands, identity now minted.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Ferdinand" })).status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Ferdinand");
  assert.ok(store.has("user:u1"));
});

test("A · commit success then a crash before account creation converges on retry", async () => {
  // The DO commits, but the worker dies before minting the account (a KV crash
  // on the user write). Nothing visible yet; a retry sees begin -> already
  // committed and finishes.
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  cr.crashOn("put", "user:u1"); // crash right after the confirmed commit, at account creation
  const first = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.equal(first.status, 500);
  assert.equal(store.has("user:u1"), false, "the account was created before commit was confirmed");
  // Retry: begin -> already committed, account + membership finalised.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Ferdinand" })).status, 200);
  assert.ok(store.has("user:u1"));
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Ferdinand");
});

test("A · another member taking an expired name cannot resurrect an abandoned attempt", async () => {
  const { post, env, store, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const t0 = 50_000_000;
  // u1 reserves the name but never commits (abandoned); it expires.
  await rpc("begin", { uid: "u1", nick: "Phantom", roster: [], now: t0 });
  // u2 takes the freed name for real.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Phantom" })).status, 200);
  // u1's abandoned attempt cannot become a member — no membership, no user.
  assert.equal(store.has(`member:${code}:u1`), false);
  assert.equal(store.has("user:u1"), false);
  // And only ONE member holds the name.
  assert.equal(memberNicks(store, code).filter((n) => normaliseJoinNick(n) === "phantom").length, 1);
});

// --- B · the teardown fence lives in the DO, not only KV --------------------

test("B · same UID cannot rejoin during a kick (DO fence), and can once it completes", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  ctl.failNext("release", 1); // kick stalls after the fence is raised and the row removed
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 503);
  // The DO fence is active: u1's own rejoin is refused, recreating nothing.
  const rejoin = await post("/join", { uid: "u1", code, nick: "Cantona" });
  assert.notEqual(rejoin.status, 200, "same UID rejoined during a kick");
  assert.equal(store.has(`member:${code}:u1`), false, "the rejoin recreated the membership");
  // Complete the kick, then u1 may rejoin (no stranded fence).
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.equal((await post("/join", { uid: "u1", code, nick: "Cantona" })).status, 200);
});

test("B · same UID cannot rejoin during account deletion, and can once it completes", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Keane" });
  ctl.failNext("release", 1);
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 503);
  const rejoin = await post("/join", { uid: "u1", code, nick: "Keane" });
  assert.notEqual(rejoin.status, 200, "same UID rejoined during account deletion");
  assert.equal((await post("/account/delete", { uid: "u1" })).status, 200);
  // After completion, the name is free for anyone (no stranded fence).
  assert.equal((await post("/join", { uid: "u2", code, nick: "Keane" })).status, 200);
});

test("B · during a stalled release: same UID fenced (503), a different UID over-reserved (409)", async () => {
  const ctl = controllableRegistrar();
  const { post, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Vidic" });
  ctl.failNext("release", 1);
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 503);
  // Same UID: refused by the member fence.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Vidic" })).status, 503);
  // Different UID: refused because the name is still held (over-reservation).
  assert.equal((await post("/join", { uid: "u2", code, nick: "Vidic" })).status, 409);
});

test("B · a rename during the member's removal is refused by the fence", async () => {
  const ctl = controllableRegistrar();
  const { post, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Ronaldo" });
  ctl.failNext("release", 1);
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 503);
  // u1 tries to rename mid-removal — the DO fence refuses it.
  assert.notEqual((await post("/league/nick", { uid: "u1", code, nick: "CR7" })).status, 200);
});

test("B · profile propagation skips a league where the member is being removed", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  // u1 is an Anon member (seeded), being kicked.
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Anon", since: 1 }));
  store.set("user:u1", JSON.stringify({ nickname: "", leagues: [code] }));
  ctl.failNext("release", 1);
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 503);
  // u1 sets a profile name; propagation must not write into the fenced league.
  const res = await post("/profile", { uid: "u1", nickname: "Tom" });
  const body = await res.json();
  assert.ok(!(body.updated || []).includes(code), "propagated a name into a league mid-removal");
});

test("B · every join during a league deletion is refused (DO fence), including a fresh UID", async () => {
  const ctl = controllableRegistrar();
  const { post, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "u1", code, nick: "Giggs" });
  ctl.failNext("purge", 1); // deletion stalls after the league fence is raised
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 503);
  // The league fence refuses every join, existing or brand-new.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Giggs" })).status, 404);
  assert.equal((await post("/join", { uid: "u9", code, nick: "Rookie" })).status, 404);
});

test("B · the DO fence is the barrier even when the KV intent is not visible", async () => {
  // Raise the fence DIRECTLY in the registrar, writing NO KV intent — production
  // KV lag. The join must still be refused, proving the DO (not KV) is the barrier.
  const { post, env, store, code } = await withLeague();
  const rpc = rpcTo(env, code);
  await rpc("fenceLeague", { now: Date.now() });
  assert.equal(store.has(leagueIntent(code)), false, "test invariant: no KV intent written");
  assert.equal((await post("/join", { uid: "u1", code, nick: "Anyone" })).status, 404,
    "a join slipped through while only the DO league fence was active");
  // A member fence with no KV intent likewise blocks that uid's join.
  const other = await (await post("/league", { uid: "hb", nickname: "HB" })).json();
  const rpc2 = rpcTo(env, other.code);
  await rpc2("fenceMember", { uid: "u1", kind: "kick", now: Date.now() });
  assert.notEqual((await post("/join", { uid: "u1", code: other.code, nick: "Someone" })).status, 200,
    "a member-fenced UID joined while only the DO fence was active");
});

test("B · crash after the DO fence, before live removal: rejoin still refused, retry completes", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Scholes" });
  // Crash immediately after the fence is raised — at the first live-removal write.
  cr.crashOn("put", `league:${code}`);
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 500);
  // The DO fence is already up, so u1 cannot rejoin during the incomplete teardown.
  assert.notEqual((await post("/join", { uid: "u1", code, nick: "Scholes" })).status, 200);
  // Retry completes with no stranded fence.
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.ok(!store.has(kickIntent(code, "u1")));
  assert.equal((await post("/join", { uid: "u1", code, nick: "Scholes" })).status, 200);
});
