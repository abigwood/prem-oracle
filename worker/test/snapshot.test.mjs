// League snapshots: the derived Trophy Cabinet must equal the assembled one,
// exactly, for everybody — not just the winners.
//
// The snapshot stores the league's settled history once; the worker filters a
// viewer's cabinet out of it in memory so the /state contract is unchanged. If
// that derivation and computeCabinet() ever disagree, members see a wrong
// history that looks authoritative, which is worse than a slow one.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { computeCabinet } from "../src/logic.js";

const HOUR = 3600000;

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

/** A season of weeks, all settled, with a known scoreline per fixture. */
const season = (weeks, perWeek, firstKickoff) =>
  Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: perWeek }, (_, i) => ({
      id: `pl-2026-27-md${w + 1}-${String(i + 1).padStart(3, "0")}`,
      matchday: w + 1,
      player1: `H${w}${i}`, player2: `A${w}${i}`,
      startAt: new Date(firstKickoff + w * 7 * 24 * HOUR + i * HOUR).toISOString(),
      status: "complete",
      result: [i % 3, i % 2],
    }))).flat();

async function withFixtures(list, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: list }), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = original; }
}
const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) }), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

/**
 * Builds a league whose weeks are settled and whose members have real picks,
 * then returns everything both paths need.
 */
async function settledLeague({ weeks = 4, perWeek = 5, joiners = {} } = {}) {
  const firstKickoff = Date.parse("2026-08-11T12:00:00Z");
  const list = season(weeks, perWeek, firstKickoff);
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) };
  let code;
  await withFixtures(list, async () => {
    await get(env)("/fixtures?refresh=1");
    code = (await (await post(env)("/league", {
      uid: "host", nickname: "Adam", competitions: ["PL"], fixtureMode: "all",
    })).json()).code;
    for (const [uid, nick] of Object.entries({ m1: "Ben", m2: "Cara", m3: "Dev" })) {
      await post(env)("/join", { uid, code, nick });
    }
    // Mid-season joiners: backdate or forward-date membership deliberately.
    for (const [uid, sinceWeek] of Object.entries(joiners)) {
      const key = `member:${code}:${uid}`;
      const row = JSON.parse(store.get(key));
      store.set(key, JSON.stringify({ ...row, since: firstKickoff + sinceWeek * 7 * 24 * HOUR }));
    }
    // Everyone predicts; the host is best, m3 never scores.
    const picksOf = { host: (m) => m.result, m1: (m) => [m.result[0], m.result[1] + 1], m2: () => [1, 1], m3: () => [9, 9] };
    for (const match of list) {
      const entry = {};
      for (const [uid, fn] of Object.entries(picksOf)) {
        const [p1, p2] = fn(match);
        entry[uid] = { p1, p2, ts: 1 };
      }
      store.set(`picks:${match.id}`, JSON.stringify(entry));
    }
  });
  return { env, store, code, list, firstKickoff };
}

/** computeCabinet's own answer, assembled the slow way, for comparison. */
async function assembledCabinet(env, store, code, list, uid) {
  const members = [...store.keys()]
    .filter((k) => k.startsWith(`member:${code}:`))
    .map((k) => ({ uid: k.slice(`member:${code}:`.length), ...JSON.parse(store.get(k)) }))
    .map((row) => ({ uid: row.uid, nick: row.nick || "Anon", since: row.since || 0 }));
  const picksByMatch = Object.fromEntries(list.map((m) => [m.id, JSON.parse(store.get(`picks:${m.id}`) || "{}")]));
  return computeCabinet(uid, members, list, picksByMatch, {}, (match) => String(match.matchday));
}

// --- parity ------------------------------------------------------------------

test("the derived cabinet equals the assembled one for a winner", async () => {
  const { env, store, code, list } = await settledLeague();
  await withFixtures(list, async () => {
    const state = await (await get(env)(`/state?code=${code}&uid=host`)).json();
    const assembled = await assembledCabinet(env, store, code, list, "host");
    assert.deepEqual(state.cabinet, assembled, "byte-for-byte, including every week");
    assert.ok(state.cabinet.gold > 0, "the host wins weeks, so this is a real comparison");
  });
});

test("...and for a member who never reaches the podium", async () => {
  const { env, store, code, list } = await settledLeague();
  await withFixtures(list, async () => {
    const state = await (await get(env)(`/state?code=${code}&uid=m3`)).json();
    const assembled = await assembledCabinet(env, store, code, list, "m3");
    assert.deepEqual(state.cabinet, assembled);
    // Every week they played is listed, podium or not — which is the point:
    // a cabinet is a history, not a trophy shelf.
    assert.ok(state.cabinet.weeks.length > 0, "the weeks they played are listed");
    assert.ok(state.cabinet.weeks.some((w) => w.place === null), "including weeks with no place");
    for (const week of state.cabinet.weeks) assert.ok(Number.isInteger(week.rank), "each with a rank");
  });
});

test("...and for a mid-season joiner, whose earlier weeks stay hidden", async () => {
  const { env, store, code, list } = await settledLeague({ weeks: 4, joiners: { m2: 2 } });
  await withFixtures(list, async () => {
    const state = await (await get(env)(`/state?code=${code}&uid=m2`)).json();
    const assembled = await assembledCabinet(env, store, code, list, "m2");
    assert.deepEqual(state.cabinet, assembled);
    assert.ok(state.cabinet.weeks.length < 4, `joined late, so fewer weeks: ${state.cabinet.weeks.length}`);
    assert.ok(state.cabinet.weeks.length > 0, "but not none");
  });
});

test("every member's cabinet agrees, not just the ones we thought to check", async () => {
  const { env, store, code, list } = await settledLeague({ weeks: 5, joiners: { m1: 1, m2: 3 } });
  await withFixtures(list, async () => {
    for (const uid of ["host", "m1", "m2", "m3"]) {
      const state = await (await get(env)(`/state?code=${code}&uid=${uid}`)).json();
      const assembled = await assembledCabinet(env, store, code, list, uid);
      assert.deepEqual(state.cabinet, assembled, `cabinet mismatch for ${uid}`);
    }
  });
});

test("a viewer who is not a member gets no cabinet, from either path", async () => {
  const { env, store, code, list } = await settledLeague();
  await withFixtures(list, async () => {
    const state = await (await get(env)(`/state?code=${code}&uid=stranger`)).json();
    assert.equal(state.cabinet, await assembledCabinet(env, store, code, list, "stranger"));
    assert.equal(state.cabinet, null);
  });
});

// --- the snapshot itself -----------------------------------------------------

test("a new league writes its snapshot at creation", async () => {
  const list = season(2, 4, Date.now() + 10 * 24 * HOUR);
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) };
  await withFixtures(list, async () => {
    await get(env)("/fixtures?refresh=1");
    const { code } = await (await post(env)("/league", { uid: "host", nickname: "Adam", competitions: ["PL"], fixtureMode: "all" })).json();
    const snap = JSON.parse(store.get(`snapshot:${code}`) || "null");
    assert.ok(snap, "a missing snapshot should be near-impossible");
    assert.equal(snap.trigger, "creation");
    assert.equal(snap.code, code);
    assert.ok(snap.computedAt > 0, "and it is stamped");
    const meta = JSON.parse(store.get(`snapmeta:${code}`) || "null");
    assert.ok(meta, "with a record of what was built");
    assert.equal(meta.version, snap.version);
  });
});

test("the snapshot carries every member's row per settled week", async () => {
  const { env, store, code, list } = await settledLeague({ weeks: 3, perWeek: 4 });
  await withFixtures(list, async () => {
    await post(env)("/league/nick", { uid: "m1", code, nick: "Ben" });   // any trigger
    const snap = JSON.parse(store.get(`snapshot:${code}`));
    assert.equal(snap.history.length, 3, "three settled weeks");
    for (const week of snap.history) {
      assert.equal(week.rows.length, 4, "all four members, not just the podium");
      assert.ok(week.rows.some((r) => r.place), "and the podium is marked on the rows");
      assert.ok(week.lastKickoffMs > 0, "with what the join-date filter needs");
      assert.equal(week.fixtures, 4);
    }
    // Most recent first, like the cabinet reads.
    const periods = snap.history.map((w) => Number(w.period));
    assert.deepEqual(periods, [...periods].sort((a, b) => b - a));
  });
});

test("the /state contract is unchanged by snapshot serving", async () => {
  // Build 12 clients must not notice. The shape is compared field for field.
  const { env, code, list } = await settledLeague({ weeks: 2 });
  await withFixtures(list, async () => {
    const state = await (await get(env)(`/state?code=${code}&uid=host`)).json();
    for (const field of [
      "code", "name", "owner", "competitions", "mixed", "weeklyRule", "fixtureMode",
      "currentPeriod", "currentSlate", "currentDraft", "awaitingPublish",
      "lineupFixtureIds", "droppedFixtureIds", "table", "reveals", "cabinet",
    ]) {
      assert.ok(field in state, `/state lost the ${field} field`);
    }
    assert.ok(Array.isArray(state.table));
    assert.ok(state.table.every((row) => "uid" in row && "pts" in row && "rank" in row && "wins" in row));
  });
});
