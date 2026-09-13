// v1.8 Slice A — safe one-step invitation joining, worker side.
//
// The whole point is that display-name uniqueness holds atomically in the
// worker, not merely in a client. These run the REAL LeagueRegistrar Durable
// Object over real SQLite (node:sqlite), wired into the real /join handler, so
// a guarantee proved here is proved about the code that ships.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";
import { LeagueRegistrar } from "../src/league_registrar.js";
import { normaliseJoinNick } from "../src/logic.js";

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

/** The Durable Object SQL surface over node:sqlite (positional bindings). */
function sqlShim(db) {
  return {
    exec(query, ...binds) {
      const trimmed = query.trim();
      if (!binds.length && /;\s*\S/.test(trimmed.replace(/;\s*$/, ""))) {
        db.exec(trimmed);
        return { toArray: () => [] };
      }
      const statement = db.prepare(trimmed);
      if (/RETURNING|^\s*SELECT/i.test(trimmed)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      const info = statement.run(...binds);
      return { toArray: () => [], rowsWritten: Number(info.changes ?? 0) };
    },
  };
}

/** A LEAGUE_REGISTRAR namespace: one real DO instance per league name. */
function registrarNamespace() {
  const instances = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      if (!instances.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        instances.set(id.name, new LeagueRegistrar({ storage: { sql: sqlShim(db) } }));
      }
      const inst = instances.get(id.name);
      return { fetch: (url, init) => inst.fetch(new Request(url, init)) };
    },
  };
}

function world({ registrar = true } = {}) {
  const store = new Map();
  const env = { KV: memoryKV(store) };
  if (registrar) env.LEAGUE_REGISTRAR = registrarNamespace();
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { store, env, post };
}

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
    body: JSON.stringify({ op: "claim", uid: "u1", nick: "Keeper", roster: [] }),
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

test("an offered-empty name keeps the v1.7.1 Anon fallback, unarbitrated", async () => {
  // No per-league nick and no profile name: old behaviour is a fallback nick,
  // and uniqueness is NOT arbitrated for the fallback.
  const { post, store, code } = await withLeague();
  const res = await post("/join", { uid: "u1", code });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(store.get(`member:${code}:u1`)).nick, "Anon");
});

// --- degraded mode: no registrar binding still refuses cross-uid duplicates -

test("without the registrar, the fallback still refuses a name held by another uid", async () => {
  const { post, store, code } = await withLeague({ registrar: false });
  assert.equal((await post("/join", { uid: "u1", code, nick: "Solo" })).status, 200);
  const res = await post("/join", { uid: "u2", code, nick: "solo" });
  assert.equal(res.status, 409, "the degraded path allowed a duplicate");
  assert.equal(store.has(`member:${code}:u2`), false);
  // A re-join by the holder is still fine.
  assert.equal((await post("/join", { uid: "u1", code, nick: "Solo" })).status, 200);
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
