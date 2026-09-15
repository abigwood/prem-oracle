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
  let armed = null; // { op, match, skip } — fires once, after `skip` earlier matches
  const fireIfArmed = (op, key) => {
    if (armed && armed.op === op && key.includes(armed.match)) {
      if (armed.skip > 0) { armed.skip -= 1; return; }
      armed = null; throw new Error("crash");
    }
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
  return { kv, store, crashOn: (op, match, skip = 0) => { armed = { op, match, skip }; }, disarm: () => { armed = null; } };
}

/** A registrar namespace that can be told to fail the NEXT n calls of an op
 *  (release/purge), then behaves normally — for proving resumable teardown. */
function controllableRegistrar() {
  const real = registrarNamespace();
  const fail = { release: 0, purge: 0, begin: 0, commit: 0, classify: 0 };
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

/** The player-VISIBLE roster from /state — the ordinary read that must never
 *  show a provisional or released membership. */
async function stateNicks(env, code) {
  const res = await worker.fetch(new Request(`https://worker.test/state?code=${code}`), env);
  const body = await res.json();
  const byUid = {};
  for (const row of body.table || []) byUid[row.uid] = row.nick;
  return { table: body.table || [], byUid };
}

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

test("C · a competing different-name attempt by the same UID is refused, not superseding", async () => {
  // One safe in-flight attempt per uid: while an attempt is live, a second under
  // a DIFFERENT name is refused (inflight) rather than silently superseding it,
  // so the first attempt can still commit.
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 3_000_000;
  const first = await rpc("begin", { uid: "u1", nick: "Alpha", roster: [], now });
  const second = await rpc("begin", { uid: "u1", nick: "Bravo", roster: [], now });
  assert.equal(second.inflight, true, "a competing name silently superseded the active attempt");
  assert.equal(second.ok, false);
  // The first, un-superseded attempt still commits.
  assert.equal((await rpc("commit", { uid: "u1", norm: first.norm, fence: first.fence, now })).committed, true);
});

test("C · an identical retry converges on the SAME attempt (same fence)", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 3_100_000;
  const first = await rpc("begin", { uid: "u1", nick: "Alpha", roster: [], now });
  const again = await rpc("begin", { uid: "u1", nick: "Alpha", roster: [], now: now + 5 });
  assert.equal(again.fence, first.fence, "an identical retry minted a new fence instead of converging");
  // Either fence (they are equal) commits the one attempt; the other is idempotent.
  assert.equal((await rpc("commit", { uid: "u1", norm: first.norm, fence: first.fence, now })).committed, true);
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
  return { cr, env, store: cr.store, post };
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
  const first = await post("/account/delete", { uid: "u1" });
  assert.notEqual(first.status, 200, "account deletion completed despite a mid-teardown crash");
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
  const { post, env, store, code } = await withLeague({ registrar: ctl.namespace });
  ctl.failNext("commit", 2); // activation + its safe re-read both fail (unknown)
  const first = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.notEqual(first.status, 200);
  // The account and membership are PREPARED but the claim is not activated, so
  // the membership must not be player-visible — nothing surfaced despite the
  // prepared state.
  assert.ok(!(await stateNicks(env, code)).byUid.u1, "an unknown activation showed a provisional member");
  // Retry converges: activation lands, and the same account/membership/recovery
  // is confirmed and made visible.
  const before = store.has("user:u1") ? JSON.parse(store.get("user:u1")).recovery : null;
  const retry = await (await post("/join", { uid: "u1", code, nick: "Ferdinand" })).json();
  assert.equal((await stateNicks(env, code)).byUid.u1, "Ferdinand", "the member did not become visible on retry");
  assert.equal(recoveriesFor(store, "u1").length, 1, "not exactly one recovery after convergence");
  if (before) assert.equal(retry.recovery, before, "the recovery credential changed across the retry");
});

test("A · a crash while preparing the account (before activation) shows nothing, converges on retry", async () => {
  // The account is prepared BEFORE the final activation. A crash mid-prepare
  // leaves the membership un-activated, so it is invisible; a retry finishes and
  // activates it, with exactly one recovery.
  const { cr, env, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  cr.crashOn("put", "user:u1"); // crash during account preparation, before activation
  const first = await post("/join", { uid: "u1", code, nick: "Ferdinand" });
  assert.equal(first.status, 500);
  assert.ok(!(await stateNicks(env, code)).byUid.u1, "an un-activated join was visible after a prepare crash");
  // Retry finishes prepare then the final activation; member visible, one recovery.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Ferdinand" })).status, 200);
  assert.equal((await stateNicks(env, code)).byUid.u1, "Ferdinand");
  assert.equal(recoveriesFor(store, "u1").length, 1);
});

test("A · a lost response after successful activation: an identical retry returns the same result", async () => {
  // Activation is the last mutation. If its response is lost, the operation is
  // complete; an identical retry returns the same account, membership and code.
  const { post, env, store, code } = await withLeague();
  const firstBody = await (await post("/join", { uid: "u1", code, nick: "Ferdinand" })).json();
  const retryBody = await (await post("/join", { uid: "u1", code, nick: "Ferdinand" })).json();
  assert.equal(retryBody.recovery, firstBody.recovery, "the recovery credential changed on an identical retry");
  assert.equal(recoveriesFor(store, "u1").length, 1, "a retry minted a second recovery");
  assert.equal((await stateNicks(env, code)).byUid.u1, "Ferdinand");
  assert.equal(memberNicks(store, code).filter((n) => n === "Ferdinand").length, 1, "a retry duplicated the membership");
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

// === FIFTH REVIEW ===========================================================

// --- A · recovery creation is crash-idempotent ------------------------------
// Exactly one user and one recovery mapping must remain after a crash at any
// boundary of account creation, followed by a retry.

const recoveriesFor = (store, uid) => [...store.keys()]
  .filter((k) => k.startsWith("recovery:") && JSON.parse(store.get(k)) === uid);

test("A · crash before the user write: retry mints exactly one user and one recovery", async () => {
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  cr.crashOn("put", "user:u1"); // the account write (after a confirmed commit)
  assert.equal((await post("/join", { uid: "u1", code, nick: "Vidic" })).status, 500);
  assert.equal(store.has("user:u1"), false);
  assert.deepEqual(recoveriesFor(store, "u1"), [], "a recovery mapping was left with no user");
  // Retry converges.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Vidic" })).status, 200);
  assert.equal(recoveriesFor(store, "u1").length, 1, "not exactly one recovery mapping");
  assert.equal(JSON.parse(store.get("user:u1")).recovery, recoveriesFor(store, "u1")[0].slice("recovery:".length));
});

test("A · crash after the user write, before the recovery mapping: retry repairs, no second code", async () => {
  // The exact reported bug: user carries code1, its lookup was never published;
  // a naive retry would mint code2. The fix repairs the lookup for code1.
  const { cr, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  cr.crashOn("put", "recovery:"); // the host's was written during setup; crash on u1's lookup publish
  assert.equal((await post("/join", { uid: "u1", code, nick: "Keane" })).status, 500);
  const chosen = JSON.parse(store.get("user:u1")).recovery; // code1 persisted in the user record
  assert.ok(chosen, "the selected recovery was not persisted before the lookup");
  assert.deepEqual(recoveriesFor(store, "u1"), [], "an unpublished code somehow had a lookup");
  // Retry: repairs the SAME code, never mints a second.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Keane" })).status, 200);
  assert.equal(recoveriesFor(store, "u1").length, 1, "retry minted a second recovery mapping");
  assert.equal(recoveriesFor(store, "u1")[0], `recovery:${chosen}`, "retry did not repair the original code");
  assert.equal(JSON.parse(store.get("user:u1")).recovery, chosen, "the user's recorded code changed");
});

test("A · crash after the recovery mapping, before the league link: retry converges", async () => {
  const { cr, env, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  // ensureUser writes user (put #1) then the lookup; the league link is put #2 to user:u1.
  cr.crashOn("put", "user:u1", 1);
  assert.equal((await post("/join", { uid: "u1", code, nick: "Scholes" })).status, 500);
  assert.equal(recoveriesFor(store, "u1").length, 1, "recovery was not exactly one after the mapping");
  // Retry converges: one user, one recovery, member visible with the league linked.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Scholes" })).status, 200);
  assert.equal(recoveriesFor(store, "u1").length, 1);
  assert.ok(JSON.parse(store.get("user:u1")).leagues.includes(code));
  assert.equal((await stateNicks(env, code)).byUid.u1, "Scholes");
});

// --- C · required interleaving evidence -------------------------------------
// join obtains its fence, teardown runs at a boundary, and the two complete in
// both orders. After every terminal sequence: at most one live member, one
// authoritative name holder, one recovery for a success and zero for an abandon,
// no provisional row in visible reads, no stranded fence.

test("C · join then kick-of-the-joining-UID, teardown wins: no live member, no stranded fence", async () => {
  // The join has activated; the owner then kicks that very UID. Teardown must
  // include the freshly-activated membership.
  const { post, env, store, code } = await withLeague();
  assert.equal((await post("/join", { uid: "u1", code, nick: "Park" })).status, 200);
  assert.equal((await post("/league/kick", { uid: "host", code, memberUid: "u1" })).status, 200);
  assert.ok(!(await stateNicks(env, code)).byUid.u1, "a kicked joiner is still visible");
  // No stranded fence: the name is reusable.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Park" })).status, 200);
});

test("C · join loses to a league deletion that fenced first: nothing visible, converges", async () => {
  // Raise the league fence via a stalled delete, then a concurrent join must not
  // activate; after the delete completes there is no ghost.
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  ctl.failNext("purge", 1);
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 503); // league fence up
  assert.equal((await post("/join", { uid: "u1", code, nick: "Ghost" })).status, 404, "a join activated during deletion");
  assert.equal(store.has("user:u1"), false);
  assert.deepEqual(recoveriesFor(store, "u1"), []);
  // Complete the deletion; no membership, no fence residue that a re-created code could inherit.
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
});

test("B · sole-owner account deletion — CLOSURE wins: the league closes and no join can revive it", async () => {
  const { post, env, store, code } = await withLeague();
  // Host is the sole member; deleting the host account closes the league.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.equal(store.has("user:host"), false);
  assert.equal(store.has(`league:${code}`), false, "the sole-owner league was not closed");
  // Every join to the closed league is refused — never a revival into an
  // ownerless league.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Latecomer" })).status, 404);
});

test("B · sole-owner account deletion — a JOIN that wins first receives succession, not closure", async () => {
  const { post, env, store, code } = await withLeague();
  // A fresh different UID commits BEFORE the owner's deletion linearises.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Heir" })).status, 200);
  // Now the sole(-ish) owner deletes their account; the committed member is the heir.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.ok(store.has(`league:${code}`), "the league was wrongly closed with a member present");
  assert.equal(JSON.parse(store.get(`league:${code}`)).owner, "u2", "succession did not pass to the winning member");
  assert.equal((await stateNicks(env, code)).byUid.u2, "Heir");
  assert.ok(!(await stateNicks(env, code)).byUid.host, "the departed owner is still visible");
  // The league is not fenced — a further join succeeds.
  assert.equal((await post("/join", { uid: "u3", code, nick: "Newcomer" })).status, 200);
});

test("B · a crash after the closure fence resumes to complete closure, no ownerless league", async () => {
  const { cr, env, store, post } = await seededCrashWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  // Crash while closing the sole-owner league (after the fence is raised).
  cr.crashOn("delete", `league:${code}`);
  assert.notEqual((await post("/account/delete", { uid: "host" })).status, 200);
  // The fence is up; a racing join cannot slip in.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Latecomer" })).status, 404);
  // Retry resumes and completes the closure.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.equal(store.has(`league:${code}`), false);
  assert.equal(store.has("user:host"), false);
});

test("C · final activation refused after prepare removes the whole attempt — no stranded recovery", async () => {
  // begin succeeds and the account + membership are PREPARED, but the FINAL
  // activation is refused (a teardown won). The attempt must remove everything it
  // created — member row, account and recovery — leaving nothing stranded.
  const refuse = commitVerdictRegistrar(() => ({ ok: true, committed: false, fenced: true }));
  const { post, env, store, code } = await withLeague({ registrar: refuse.namespace });
  refuse.failCommits(1);
  const res = await post("/join", { uid: "newbie", code, nick: "Berbatov" });
  assert.notEqual(res.status, 200, "a refused activation reported success");
  assert.equal(store.has("user:newbie"), false, "the attempt's account survived a refused activation");
  assert.deepEqual(recoveriesFor(store, "newbie"), [], "a recovery was stranded by a refused activation");
  assert.ok(!(await stateNicks(env, code)).byUid.newbie, "a refused join is visible");
  assert.equal(store.has(`member:${code}:newbie`), false, "the provisional row was not cleaned up");
  // The name was never activated, so a real joiner can take it.
  assert.equal((await post("/join", { uid: "u2", code, nick: "Berbatov" })).status, 200);
});

test("C · an EXISTING account joining a new league that is refused keeps its account", async () => {
  // The cleanup must remove only what the attempt owns. An existing account whose
  // NEW-league join is refused keeps its account, recovery and other leagues.
  const first = await withLeague();
  await first.post("/join", { uid: "u1", code: first.code, nick: "Established" });
  const before = JSON.parse(first.store.get("user:u1"));
  assert.ok(before.recovery);
  // A second league on the SAME store/registrar world, where activation is refused.
  const refuse = commitVerdictRegistrar(() => ({ ok: true, committed: false, fenced: true }));
  // Reuse the same KV store so u1's account persists; new registrar for the 2nd league.
  const env2 = { KV: memoryKV(first.store), LEAGUE_REGISTRAR: refuse.namespace };
  const post2 = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env2);
  const b = await (await post2("/league", { uid: "hostB", nickname: "HostB" })).json();
  refuse.failCommits(1);
  assert.notEqual((await post2("/join", { uid: "u1", code: b.code, nick: "Established" })).status, 200);
  const after = JSON.parse(first.store.get("user:u1"));
  assert.equal(after.recovery, before.recovery, "an existing account's recovery was destroyed");
  assert.ok(!after.leagues.includes(b.code), "the refused league link was not detached");
  assert.ok(after.leagues.includes(first.code), "an existing membership was lost");
});

// --- B · membership reads fail closed when the registrar cannot classify -----
// A player-visible roster must NEVER show a provisional or released row because
// the registrar is unavailable or returns garbage. The read fails closed
// (retryable) instead of falling back to the raw KV view.

test("B · /state fails closed when classify is unavailable — a provisional member never shows", async () => {
  const ctl = controllableRegistrar();
  const { post, env, store, code } = await withLeague({ registrar: ctl.namespace });
  // Create a PROVISIONAL member: a join whose activation stays unknown leaves a
  // hidden, not-yet-activated membership row in KV.
  ctl.failNext("commit", 2);
  await post("/join", { uid: "prov", code, nick: "Provisional" });
  assert.ok(store.has(`member:${code}:prov`), "test needs a provisional row present in KV");

  // Now the registrar cannot classify. /state must fail closed, not fall back.
  ctl.failNext("classify", 5);
  const res = await worker.fetch(new Request(`https://worker.test/state?code=${code}`), env);
  assert.equal(res.status, 503, "state read did not fail closed when classification was unavailable");
  const body = await res.json();
  assert.equal(body.retryable, true, "the failure was not advertised as retryable");
  assert.ok(!(body.table || []).some((r) => r.uid === "prov"), "a provisional member leaked into a failed-open read");
  assert.ok(!(body.reveals || []).some((r) => r.uid === "prov"), "a provisional member leaked into reveals");
});

test("B · /state fails closed when classify is MALFORMED — a released member never shows", async () => {
  // A released (kicked) member whose KV row lingers must not reappear when the
  // registrar answers classify with garbage.
  const real = registrarNamespace();
  let malform = false;
  const namespace = {
    idFromName: (name) => real.idFromName(name),
    get(id) {
      const inner = real.get(id);
      return {
        fetch: async (url, init) => {
          if (malform && JSON.parse(init.body).op === "classify") {
            return new Response(JSON.stringify({ ok: true, hide: "not-an-array" }), { status: 200 });
          }
          return inner.fetch(url, init);
        },
      };
    },
  };
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: namespace };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Cantona" });
  // Simulate a lingering released row: kick u1 (row removed + released), then
  // re-plant a stale KV row as an eventually-consistent read might.
  await post("/league/kick", { uid: "host", code, memberUid: "u1" });
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Cantona", since: 1 }));

  malform = true;
  const res = await worker.fetch(new Request(`https://worker.test/state?code=${code}`), env);
  assert.equal(res.status, 503, "state read trusted a malformed classification");
  const body = await res.json();
  assert.ok(!(body.table || []).some((r) => r.uid === "u1"), "a released member reappeared on a malformed classify");
});

test("B · with NO registrar bound at all, /state still serves (no provisional rows can exist)", async () => {
  // Fail-closed applies when the registrar is bound but unavailable — not when
  // none is configured, a world that has no provisional/released rows to hide.
  const store = new Map();
  const env = { KV: memoryKV(store) };
  store.set(`league:LEGACY`, JSON.stringify({ code: "LEGACY", name: "Legacy", owner: "h", members: ["h"] }));
  store.set(`member:LEGACY:h`, JSON.stringify({ nick: "Legacy Host", since: 1 }));
  const res = await worker.fetch(new Request("https://worker.test/state?code=LEGACY"), env);
  assert.equal(res.status, 200, "a registrar-less world should serve the KV roster directly");
  assert.ok((await res.json()).table.some((r) => r.nick === "Legacy Host"));
});

// --- C · one coherent survivor: the loser never erases or repaints the winner -

test("C · same UID, two different nicknames: one wins, the other is refused", async () => {
  const { post, env, store, code } = await withLeague();
  const rpc = rpcTo(env, code);
  // Attempt A for u1 "Alice" is in flight (a live pending claim).
  const a = await rpc("begin", { uid: "u1", nick: "Alice", roster: [], now: Date.now() });
  assert.ok(a.ok && a.fence);
  // A competing attempt for the SAME uid under a DIFFERENT name is refused.
  assert.notEqual((await post("/join", { uid: "u1", code, nick: "Bob" })).status, 200, "a competing name won");
  // A completes (its /join converges on the same attempt). Exactly one survivor.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Alice" })).status, 200);
  assert.equal((await stateNicks(env, code)).byUid.u1, "Alice");
  assert.notEqual((await stateNicks(env, code)).byUid.u1, "Bob");
  assert.equal(recoveriesFor(store, "u1").length, 1, "more than one recovery survived");
  assert.equal(memberNicks(store, code).filter((n) => normaliseJoinNick(n) === "bob").length, 0, "Bob materialised");
});

test("C · a losing attempt's stale write cannot repaint or erase the winner", async () => {
  const { post, env, store, code } = await withLeague();
  // The winner joins as "Bob".
  assert.equal((await post("/join", { uid: "u1", code, nick: "Bob" })).status, 200);
  const rec = JSON.parse(store.get("user:u1")).recovery;

  // A delayed LOSER clobbers the KV member row (different name + stale fence), as
  // a reordered provisional write would. The authoritative roster still shows Bob.
  store.set(`member:${code}:u1`, JSON.stringify({ nick: "Alice", since: 1, fence: "stale-fence" }));
  assert.equal((await stateNicks(env, code)).byUid.u1, "Bob", "a stale write repainted the winner");

  // Even if the loser's cleanup then deletes the (clobbered) row, the committed
  // winner is still shown from the registrar — never erased.
  store.delete(`member:${code}:u1`);
  assert.equal((await stateNicks(env, code)).byUid.u1, "Bob", "a losing cleanup erased the winner");

  // The winner's account and single recovery are untouched.
  assert.equal(JSON.parse(store.get("user:u1")).recovery, rec, "the winner's recovery changed");
  assert.equal(recoveriesFor(store, "u1").length, 1);
});

test("C · an expired attempt arriving after a newer attempt commits nothing of its own", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const t0 = 60_000_000;
  const stale = await rpc("begin", { uid: "u1", nick: "Alice", roster: [], now: t0 }); // will expire
  const later = t0 + TTL + 1;
  // A newer attempt (different name) is now allowed because the old one expired.
  const fresh = await rpc("begin", { uid: "u1", nick: "Bob", roster: [], now: later });
  assert.ok(fresh.ok && fresh.fence);
  assert.equal((await rpc("commit", { uid: "u1", norm: fresh.norm, fence: fresh.fence, now: later })).committed, true);
  // The stale attempt's delayed commit converts nothing (superseded/expired).
  assert.equal((await rpc("commit", { uid: "u1", norm: stale.norm, fence: stale.fence, now: later })).committed, false);
});

// --- A · league deletion trusts the registrar, not an eventually-consistent list

test("A · league deletion tears down a member a lagging KV list() omits (registrar is authoritative)", async () => {
  // A production-shaped KV whose list() drops one freshly-activated member while
  // get() still sees it — exactly the eventual-consistency gap. The registrar's
  // authoritative uid set must still drive teardown.
  const store = new Map();
  let hideFromList = null;
  const kv = {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && k !== hideFromList)
        .sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
  const env = { KV: kv, LEAGUE_REGISTRAR: registrarNamespace() };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);

  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  assert.equal((await post("/join", { uid: "u1", code, nick: "Freshly" })).status, 200);
  assert.ok(store.has(`member:${code}:u1`), "u1 is a real member (get sees it)");
  // The lagging list() omits u1 — but the registrar committed u1.
  hideFromList = `member:${code}:u1`;

  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  // u1's member row AND league link are gone despite the list() omission.
  assert.equal(store.has(`member:${code}:u1`), false, "the list()-omitted member row was orphaned");
  assert.ok(!(JSON.parse(store.get("user:u1")).leagues || []).includes(code), "the league link was orphaned on the user");
  assert.equal(store.has(`league:${code}`), false);
  // The registrar was purged: the code is free for a brand-new league to reuse.
  hideFromList = null;
  const reborn = await (await post("/league", { uid: "host2", nickname: "Host2" })).json();
  assert.ok(reborn.code, "could not create a new league after purge");
});

test("A · league deletion converges after a crash, recovering the same authoritative set", async () => {
  const cr = crashableKV();
  const env = { KV: cr.kv, LEAGUE_REGISTRAR: registrarNamespace() };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u1", code, nick: "Member" });
  cr.crashOn("delete", `league:${code}`); // crash mid teardown, after the intent + fence
  assert.notEqual((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.ok(cr.store.has(leagueIntent(code)), "the deletion intent (with the full set) was not recorded");
  // Retry recovers the same set from the intent and completes.
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.equal(cr.store.has(`member:${code}:u1`), false);
  assert.equal(cr.store.has(`league:${code}`), false);
});

// --- C · attempt-owned abort: a losing cleanup never releases or erases a winner

test("C · a losing /join's real cleanup removes only its own state; a committed member survives", async () => {
  // The winner is a real committed member with a member row, name, account link
  // and recovery. The loser's activation is forced to fail, so it runs the REAL
  // cleanup route (abort -> remove fence-owned state -> release). The winner is
  // untouched.
  const refuse = commitVerdictRegistrar(() => ({ ok: true, committed: false }));
  const { post, env, store, code } = await withLeague({ registrar: refuse.namespace });
  assert.equal((await post("/join", { uid: "u_win", code, nick: "Alpha" })).status, 200);
  const winnerRec = JSON.parse(store.get("user:u_win")).recovery;

  refuse.failCommits(1); // the loser's activation loses
  const res = await post("/join", { uid: "u_lose", code, nick: "Bravo" });
  assert.notEqual(res.status, 200, "the losing join reported success");

  // The winner survives entirely.
  assert.equal((await stateNicks(env, code)).byUid.u_win, "Alpha", "the winner's name was lost");
  assert.equal(JSON.parse(store.get(`member:${code}:u_win`)).nick, "Alpha", "the winner's member row was touched");
  assert.equal(JSON.parse(store.get("user:u_win")).recovery, winnerRec, "the winner's recovery changed");
  assert.equal(recoveriesFor(store, "u_win").length, 1);
  // The loser's own state is cleaned up.
  assert.equal(store.has(`member:${code}:u_lose`), false, "the loser's provisional row survived");
  assert.deepEqual(recoveriesFor(store, "u_lose"), [], "the loser stranded a recovery");
});

test("C · abort is refused once the attempt has committed (a winner) — cleanup releases nothing", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 70_000_000;
  const b = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now });
  await rpc("commit", { uid: "u1", norm: b.norm, fence: b.fence, now }); // u1 WON
  // A stray/late cleanup for the same fence must NOT be authorised.
  const ab = await rpc("abort", { uid: "u1", fence: b.fence, now });
  assert.equal(ab.authorised, false, "abort authorised cleanup of a committed winner");
  // And the winner is still the authoritative holder.
  assert.equal((await rpc("check", { uid: "u2", nick: "Name", roster: [], now })).available, false);
});

test("C · abort is refused once a newer attempt has superseded the fence", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = 71_000_000;
  const first = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now });
  // The first attempt expires; a fresh attempt takes over with a new fence.
  const later = now + TTL + 1;
  const second = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now: later });
  assert.notEqual(second.fence, first.fence, "expected a fresh fence after expiry");
  // The stale attempt's abort is refused — it cannot disturb the newer attempt.
  assert.equal((await rpc("abort", { uid: "u1", fence: first.fence, now: later })).authorised, false);
  // The newer attempt can still commit.
  assert.equal((await rpc("commit", { uid: "u1", norm: second.norm, fence: second.fence, now: later })).committed, true);
});

// --- A · a pending prepared join and a legacy member are torn down by deletion --

test("A · league deletion tears down a PENDING prepared join and a LEGACY member", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  // A legacy member (pre-registrar): a raw KV row + account link, no DO claim.
  store.set(`member:${code}:legacy`, JSON.stringify({ nick: "Old Timer", since: 1 }));
  store.set("user:legacy", JSON.stringify({ nickname: "Old Timer", leagues: [code] }));
  // A pending prepared join: activation stays unknown, so a provisional row +
  // account link exist while the claim is not yet committed.
  ctl.failNext("commit", 2);
  await post("/join", { uid: "pend", code, nick: "Pending" });
  assert.ok(store.has(`member:${code}:pend`), "test needs a prepared pending row");

  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  // Both the legacy and the pending member rows AND their account links are gone.
  for (const u of ["legacy", "pend"]) {
    assert.equal(store.has(`member:${code}:${u}`), false, `${u} member row orphaned`);
    assert.ok(!(JSON.parse(store.get(`user:${u}`)).leagues || []).includes(code), `${u} league link orphaned`);
  }
  assert.equal(store.has(`league:${code}`), false);
});

test("A · sole-owner account closure deletes slate reverse-index entries too", async () => {
  const { post, store, code } = await withLeague();
  // Seed a published slate and its reverse index, as a live league would have.
  store.set(`custom_slate:${code}:7`, JSON.stringify({ status: "published", fixtureIds: ["PL-99"] }));
  store.set(`slatefx:PL-99:${code}`, JSON.stringify({ some: "value" }));
  // Sole owner deletes their account -> the league closes.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.equal(store.has(`league:${code}`), false, "the sole-owner league did not close");
  assert.equal(store.has(`custom_slate:${code}:7`), false, "the slate survived closure");
  assert.equal(store.has(`slatefx:PL-99:${code}`), false, "the slate reverse-index survived closure");
});

// --- D · malformed authoritative registrar data fails closed ----------------

function malformedOp(op, badBody) {
  const real = registrarNamespace();
  return {
    idFromName: (name) => real.idFromName(name),
    get(id) {
      const inner = real.get(id);
      return {
        fetch: async (url, init) => {
          if (JSON.parse(init.body).op === op) return new Response(JSON.stringify(badBody), { status: 200 });
          return inner.fetch(url, init);
        },
      };
    },
  };
}

test("D · a malformed classify (members not valid identities) fails /state closed", async () => {
  const ns = malformedOp("classify", { ok: true, hide: [], members: [{ uid: "", nick: "x" }] });
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: ns };
  store.set(`league:L`, JSON.stringify({ code: "L", name: "L", owner: "h", members: ["h"] }));
  store.set(`member:L:h`, JSON.stringify({ nick: "Host", since: 1 }));
  const res = await worker.fetch(new Request("https://worker.test/state?code=L"), env);
  assert.equal(res.status, 503, "malformed authoritative membership data was trusted");
  assert.equal((await res.json()).retryable, true);
});

test("D · a malformed fenceLeague (bad uids) fails league deletion closed, never an empty set", async () => {
  const ns = malformedOp("fenceLeague", { ok: true, fenced: true, uids: "nope", committed: [] });
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: ns };
  store.set(`league:L`, JSON.stringify({ code: "L", name: "L", owner: "h", members: ["h"] }));
  store.set(`member:L:h`, JSON.stringify({ nick: "Host", since: 1 }));
  const res = await worker.fetch(new Request("https://worker.test/league/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: "h", code: "L" }),
  }), env);
  assert.equal(res.status, 503, "a malformed fenceLeague was trusted");
  assert.ok(store.has("league:L"), "the league was erased on malformed authoritative data");
});

// === NINTH REVIEW ===========================================================

// --- A · abort cleanup is durably resumable across a crash at any boundary ---
// A world where the loser's activation always fails (so /join runs the real
// abort cleanup), with a crashable KV and an optionally-failing finishAbort.

function abortWorld({ failFinish = 0 } = {}) {
  const cr = crashableKV();
  const real = registrarNamespace();
  let finishFails = failFinish;
  const R = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const ns = {
    idFromName: (n) => real.idFromName(n),
    get(id) {
      const inner = real.get(id);
      return { fetch: async (url, init) => {
        const b = JSON.parse(init.body);
        if (b.op === "commit" && b.uid === "u_lose") return R({ ok: true, committed: false, uid: b.uid, norm: b.norm });
        if (b.op === "finishAbort" && finishFails > 0) { finishFails -= 1; return new Response("{}", { status: 500 }); }
        return inner.fetch(url, init);
      }};
    },
  };
  const env = { KV: cr.kv, LEAGUE_REGISTRAR: ns };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { cr, env, post, store: cr.store };
}

async function assertLoserCleanConverged(env, post, store, code) {
  // Retry until the abort cleanup has fully resumed (no intent left).
  for (let i = 0; i < 4 && store.has(`intent:abort:${code}:u_lose`); i++) {
    await post("/join", { uid: "u_lose", code, nick: "Bravo" });
  }
  assert.equal(store.has(`intent:abort:${code}:u_lose`), false, "a cleanup intent was stranded");
  assert.equal(store.has(`member:${code}:u_lose`), false, "a provisional member row was stranded");
  assert.deepEqual(recoveriesFor(store, "u_lose"), [], "a recovery credential was stranded");
  assert.equal(store.has("user:u_lose"), false, "an account was stranded");
  // No stranded fence: a different uid can take the freed name.
  assert.equal((await post("/join", { uid: "u_other", code, nick: "Bravo" })).status, 200, "the name was left fenced/reserved");
  // The pre-existing account is intact.
  assert.ok(store.has("user:u_keep"), "an existing account was destroyed by the loser's cleanup");
}

for (const boundary of [
  { name: "after abort authorisation (before provisional member deletion)", arm: (cr, code) => cr.crashOn("delete", `member:${code}:u_lose`) },
  { name: "after provisional member deletion (during account/recovery deletion)", arm: (cr, code) => cr.crashOn("delete", "user:u_lose") },
  { name: "at a failed finishAbort", arm: () => {}, failFinish: 1 },
]) {
  test(`A · abort cleanup converges after a crash ${boundary.name}`, async () => {
    const { cr, env, post, store } = abortWorld({ failFinish: boundary.failFinish || 0 });
    const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
    // A pre-existing account that must survive the loser's cleanup untouched.
    await post("/join", { uid: "u_keep", code, nick: "Keeper" });

    boundary.arm(cr, code);
    const first = await post("/join", { uid: "u_lose", code, nick: "Bravo" });
    assert.notEqual(first.status, 200, "the losing join reported success");
    assert.ok(store.has(`intent:abort:${code}:u_lose`), "no durable cleanup intent was recorded");
    cr.disarm();
    await assertLoserCleanConverged(env, post, store, code);
  });
}

test("A · a lost response after a successful abort finish converges (no duplicate cleanup)", async () => {
  const { cr, env, post, store } = abortWorld();
  const code = (await (await post("/league", { uid: "host", nickname: "Host" })).json()).code;
  await post("/join", { uid: "u_keep", code, nick: "Keeper" });
  // The abort completes fully (intent cleared) but imagine the HTTP response was
  // lost; an identical retry must be a clean no-op resume + fresh attempt.
  const first = await post("/join", { uid: "u_lose", code, nick: "Bravo" });
  assert.notEqual(first.status, 200);
  assert.equal(store.has(`intent:abort:${code}:u_lose`), false, "the finished cleanup left an intent");
  await assertLoserCleanConverged(env, post, store, code);
});

test("A · an existing account survives a failed-join cleanup (only the league link is dropped)", async () => {
  const { post, store, code, env } = await withLeague();
  // u1 is an established member of ANOTHER league too.
  const other = await (await post("/league", { uid: "hb", nickname: "HB" })).json();
  await post("/join", { uid: "u1", code: other.code, nick: "Established" });
  const rec = JSON.parse(store.get("user:u1")).recovery;
  // u1's join to THIS league loses activation, via a verdict registrar.
  const refuse = commitVerdictRegistrar(() => ({ ok: true, committed: false }));
  const env2 = { KV: env.KV, LEAGUE_REGISTRAR: refuse.namespace };
  const post2 = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env2);
  refuse.failCommits(1);
  assert.notEqual((await post2("/join", { uid: "u1", code, nick: "Fresh" })).status, 200);
  // The account, its recovery and the OTHER membership survive; only this league's link is gone.
  assert.equal(JSON.parse(store.get("user:u1")).recovery, rec, "an existing account's recovery was destroyed");
  assert.ok(JSON.parse(store.get("user:u1")).leagues.includes(other.code), "an existing membership was lost");
  assert.ok(!JSON.parse(store.get("user:u1")).leagues.includes(code), "the failed league link was not dropped");
});

// --- B · authoritative join time drives succession and survives a missing row -

test("B · succession selects the longest-standing member by authoritative since, even if its KV row is missing", async () => {
  const { post, store, code } = await withLeague();
  // Pin deterministic join times so 'since' — not a tie-breaker — decides.
  const lg = JSON.parse(store.get(`league:${code}`));
  lg.joinedAt = { u_early: 1000, u_late: 2000 };
  store.set(`league:${code}`, JSON.stringify(lg));
  await post("/join", { uid: "u_early", code, nick: "Zeb" });   // since 1000 (alphabetically LAST)
  await post("/join", { uid: "u_late", code, nick: "Abe" });    // since 2000 (alphabetically FIRST)
  // The longest-standing member's KV row is missing — its authoritative since (1000) must still win.
  store.delete(`member:${code}:u_early`);

  await post("/account/delete", { uid: "host" });
  assert.equal(JSON.parse(store.get(`league:${code}`)).owner, "u_early",
    "succession did not pick the longest-standing member from the authoritative since");
});

// --- B/D · malformed or inconsistent authoritative data fails closed ---------

test("D · a classify member with a non-finite since fails /state closed", async () => {
  const ns = malformedOp("classify", { ok: true, hide: [], members: [{ uid: "h", nick: "Host", since: -1 }] });
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: ns };
  store.set("league:L", JSON.stringify({ code: "L", name: "L", owner: "h", members: ["h"] }));
  store.set("member:L:h", JSON.stringify({ nick: "Host", since: 1 }));
  const res = await worker.fetch(new Request("https://worker.test/state?code=L"), env);
  assert.equal(res.status, 503, "a mistimed authoritative since was trusted");
});

test("D · a fenceLeague whose committed uid is not in the uid set fails deletion closed", async () => {
  const ns = malformedOp("fenceLeague", { ok: true, fenced: true, uids: ["h"], committed: [{ uid: "ghost", nick: "G", since: 1 }] });
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: ns };
  store.set("league:L", JSON.stringify({ code: "L", name: "L", owner: "h", members: ["h"] }));
  store.set("member:L:h", JSON.stringify({ nick: "Host", since: 1 }));
  const res = await worker.fetch(new Request("https://worker.test/league/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: "h", code: "L" }),
  }), env);
  assert.equal(res.status, 503, "an inconsistent committed/uid set was trusted");
  assert.ok(store.has("league:L"), "the league was erased on inconsistent data");
});

test("D · an ownerDeparture whose closing verdict contradicts its committed set fails closed", async () => {
  // closing:true but a committed OTHER member exists -> internally inconsistent.
  const ns = malformedOp("ownerDeparture",
    { ok: true, closing: true, uids: ["h", "other"], committed: [{ uid: "other", nick: "O", since: 1 }] });
  const store = new Map();
  const env = { KV: memoryKV(store), LEAGUE_REGISTRAR: ns };
  store.set("league:L", JSON.stringify({ code: "L", name: "L", owner: "h", members: ["h", "other"] }));
  store.set("member:L:h", JSON.stringify({ nick: "Host", since: 1 }));
  store.set("member:L:other", JSON.stringify({ nick: "Other", since: 2 }));
  store.set("user:h", JSON.stringify({ nickname: "Host", leagues: ["L"], recovery: "r" }));
  store.set("recovery:r", JSON.stringify("h"));
  const res = await worker.fetch(new Request("https://worker.test/account/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: "h" }),
  }), env);
  assert.equal(res.status, 503, "an inconsistent closing verdict was trusted");
  assert.ok(store.has("user:h"), "the account was erased on inconsistent data");
});

// === TENTH REVIEW ===========================================================

// --- A · teardown fences are operation-owned: abort never touches kick/account/league

for (const kind of ["kick", "account"]) {
  test(`A · a join abort DEFERS to a foreign ${kind} fence and can neither overwrite nor lift it`, async () => {
    const { env, code } = await withLeague();
    const rpc = rpcTo(env, code);
    const now = Date.now();
    const b = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now });
    await rpc("fenceMember", { uid: "u1", kind, token: "OWNER-TOK", now });
    // abort must defer, not clobber the foreign fence.
    const ab = await rpc("abort", { uid: "u1", fence: b.fence, now });
    assert.equal(ab.authorised, false, `abort clobbered a ${kind} fence`);
    assert.equal(ab.deferred, true);
    // finishAbort must refuse — it may not lift a foreign fence.
    assert.equal((await rpc("finishAbort", { uid: "u1", fence: b.fence, now })).finished, false);
    // The foreign fence still blocks the uid.
    assert.equal((await rpc("begin", { uid: "u1", nick: "Other", roster: [], now })).fenced, true);
    // A release with the WRONG kind/token cannot lift it.
    await rpc("release", { uid: "u1", kind: "abort", token: "WRONG", now });
    assert.equal((await rpc("begin", { uid: "u1", nick: "Other", roster: [], now })).fenced, true,
      `a foreign release lifted the ${kind} fence`);
    // Only its own (kind, token) release lifts it.
    await rpc("release", { uid: "u1", kind, token: "OWNER-TOK", now });
    assert.notEqual((await rpc("begin", { uid: "u1", nick: "Fresh", roster: [], now })).fenced, true);
  });
}

test("A · a join abort DEFERS to a dominant league fence", async () => {
  const { env, code } = await withLeague();
  const rpc = rpcTo(env, code);
  const now = Date.now();
  const b = await rpc("begin", { uid: "u1", nick: "Name", roster: [], now });
  await rpc("fenceLeague", { roster: [], now });
  const ab = await rpc("abort", { uid: "u1", fence: b.fence, now });
  assert.equal(ab.deferred, true, "abort did not defer to the league fence");
  // The league fence still blocks every join, and finishAbort refuses.
  assert.equal((await rpc("finishAbort", { uid: "u1", fence: b.fence, now })).finished, false);
  assert.equal((await rpc("begin", { uid: "u2", nick: "X", roster: [], now })).fenced, true);
});

test("A · league deletion clears in-flight join-abort intents (so /join cannot resume once gone)", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  // A prepared pending join (unknown activation) leaves a provisional claim/row.
  ctl.failNext("commit", 2);
  await post("/join", { uid: "pend", code, nick: "Pending" });
  // An in-flight abort intent recorded for that pending uid.
  store.set(`intent:abort:${code}:pend`, JSON.stringify({ uid: "pend", code, fence: "F", wasMember: false, existedBefore: false }));
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  assert.equal(store.has(`intent:abort:${code}:pend`), false, "an abort intent survived league deletion");
  assert.equal(store.has(`member:${code}:pend`), false, "a pending provisional row survived league deletion");
});

// --- B · a prepared pending join is never a committed member ------------------

test("B · a prepared pending join does NOT keep a sole-owner league alive on account deletion", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  // A fully prepared pending join by u2 (activation stays unknown): provisional
  // row + account link exist, but the claim is never committed.
  ctl.failNext("commit", 2);
  await post("/join", { uid: "u2", code, nick: "Pending" });
  assert.ok(store.has(`member:${code}:u2`), "test needs a prepared pending row");
  // Host is the only COMMITTED member; deleting the host account must CLOSE the
  // league — a provisional row must not keep it alive or become the heir.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.equal(store.has(`league:${code}`), false, "a provisional row kept a sole-owner league alive");
});

test("B · ordinary league deletion includes a pending join but never treats it as committed", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  ctl.failNext("commit", 2);
  await post("/join", { uid: "u2", code, nick: "Pending" });
  assert.equal((await post("/league/delete", { uid: "host", code })).status, 200);
  // The pending join's row and account link are torn down (in the all-UID set).
  assert.equal(store.has(`member:${code}:u2`), false, "the pending row was orphaned by league deletion");
  assert.ok(!(JSON.parse(store.get("user:u2"))?.leagues || []).includes(code), "the pending account link was orphaned");
});

test("B · succession never picks a pending member as heir", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  await post("/join", { uid: "committed", code, nick: "Real" }); // a genuine committed member
  ctl.failNext("commit", 2);
  await post("/join", { uid: "pending", code, nick: "Ghosty" }); // stays pending
  // Delete the host account -> succession must go to the committed member.
  assert.equal((await post("/account/delete", { uid: "host" })).status, 200);
  assert.equal(JSON.parse(store.get(`league:${code}`)).owner, "committed", "a pending member became the heir");
});

// --- C · a present-but-stale KV row cannot override the authoritative since ---

test("C · succession ignores a present stale KV time and picks the true longest-standing member", async () => {
  const ctl = controllableRegistrar();
  const { post, store, code } = await withLeague({ registrar: ctl.namespace });
  const lg = JSON.parse(store.get(`league:${code}`));
  lg.joinedAt = { u_early: 1000, u_late: 2000 };
  store.set(`league:${code}`, JSON.stringify(lg));
  await post("/join", { uid: "u_early", code, nick: "Zeb" });  // authoritative since 1000
  await post("/join", { uid: "u_late", code, nick: "Abe" });   // authoritative since 2000
  // Clobber u_late's KV row to an EARLIER time than u_early — a stale write that
  // must NOT make it look like the longest-standing member.
  store.set(`member:${code}:u_late`, JSON.stringify({ nick: "Abe", since: 1, fence: "stale" }));

  await post("/account/delete", { uid: "host" });
  assert.equal(JSON.parse(store.get(`league:${code}`)).owner, "u_early",
    "a stale KV time overrode the authoritative since in succession");
});
