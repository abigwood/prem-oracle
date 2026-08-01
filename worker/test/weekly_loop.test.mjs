// v1.5 "The Weekly Loop" — the league creation wizard's schema, the one
// canonical period key, the draft → published lifecycle, and the weekly cycle
// of nudge, auto-publish and fallback.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {
  DEFAULT_FIXTURE_COUNT,
  MAX_FIXTURE_COUNT,
  MIN_FIXTURE_COUNT,
  comparePeriods,
  defaultScopeFor,
  isSetAndForget,
  leagueWeeklyRule,
  periodKeyForLeague,
  periodKeyOf,
  periodOpensAt,
  periodClosesAt,
  scopeCompetitions,
  validateWeeklyRule,
  windowKeyFor,
} from "../src/competitions.js";
import {
  buildSlateSnapshot,
  canAdvanceSlate,
  isDraftSlate,
  isPublishedSlate,
  normaliseSlate,
  preloadSelection,
  randomSelection,
  refreshSnapshot,
  slateStatus,
} from "../src/logic.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function memoryKV(store = new Map()) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || "" };
    },
  };
}

// ===========================================================================
// 1. The wizard's schema
// ===========================================================================

test("the weekly rule is a method, an EXPLICIT scope and a count", () => {
  const both = ["PL", "ELC"];
  assert.deepEqual(validateWeeklyRule({ method: "manual", competitionScope: "mixed", count: 6 }, both).rule,
    { method: "manual", competitionScope: "mixed", count: 6 });
  assert.deepEqual(validateWeeklyRule({ method: "allCompetition", competitionScope: "ELC", count: 6 }, both).rule,
    { method: "allCompetition", competitionScope: "ELC", count: 6 });
  assert.deepEqual(validateWeeklyRule({ method: "random", competitionScope: "mixed", count: 3 }, both).rule,
    { method: "random", competitionScope: "mixed", count: 3 });

  // "all" is never overloaded to mean "all of whichever boxes you ticked":
  // allCompetition has to name one, and allEligible cannot narrow.
  assert.equal(validateWeeklyRule({ method: "allCompetition", competitionScope: "mixed", count: 6 }, both).error,
    "allCompetition needs a single competition scope");
  assert.equal(validateWeeklyRule({ method: "allEligible", competitionScope: "PL", count: 6 }, both).error,
    "allEligible covers every competition the league plays");

  // A scope the league does not play is refused outright.
  assert.match(validateWeeklyRule({ method: "manual", competitionScope: "ELC", count: 6 }, ["PL"]).error,
    /competitionScope must be one of/);
  assert.match(validateWeeklyRule({ method: "manual", competitionScope: "mixed", count: 6 }, ["PL"]).error,
    /competitionScope must be one of/);
  assert.match(validateWeeklyRule({ method: "sideways", count: 6 }, both).error, /method must be one of/);
});

test("the count is one validation path: 1 to 20, default 6, floor 1", () => {
  assert.deepEqual([MIN_FIXTURE_COUNT, DEFAULT_FIXTURE_COUNT, MAX_FIXTURE_COUNT], [1, 6, 20]);
  const pl = ["PL"];
  assert.equal(validateWeeklyRule({ method: "random", count: 1 }, pl).rule.count, 1, "one fixture is a real week");
  assert.equal(validateWeeklyRule({ method: "random", count: 20 }, pl).rule.count, 20);
  assert.equal(validateWeeklyRule({ method: "random" }, pl).rule.count, 6, "the default");
  assert.match(validateWeeklyRule({ method: "random", count: 0 }, pl).error, /between 1 and 20/);
  assert.match(validateWeeklyRule({ method: "random", count: 21 }, pl).error, /between 1 and 20/);
  assert.match(validateWeeklyRule({ method: "random", count: 2.5 }, pl).error, /between 1 and 20/);
});

test("an omitted scope resolves to the league's own set, never to a guess", () => {
  assert.equal(defaultScopeFor(["PL"]), "PL");
  assert.equal(defaultScopeFor(["ELC"]), "ELC");
  assert.equal(defaultScopeFor(["PL", "ELC"]), "mixed");
  assert.equal(validateWeeklyRule({ method: "manual", count: 6 }, ["ELC"]).rule.competitionScope, "ELC");
  assert.equal(validateWeeklyRule({ method: "manual", count: 6 }, ["PL", "ELC"]).rule.competitionScope, "mixed");
});

test("a rule's scope decides which competitions it may draw from", () => {
  const mixed = { competitions: ["PL", "ELC"] };
  assert.deepEqual(scopeCompetitions({ method: "allEligible", competitionScope: "mixed" }, mixed), ["PL", "ELC"]);
  assert.deepEqual(scopeCompetitions({ method: "allCompetition", competitionScope: "ELC" }, mixed), ["ELC"]);
  assert.deepEqual(scopeCompetitions({ method: "random", competitionScope: "PL" }, mixed), ["PL"]);
  assert.deepEqual(scopeCompetitions({ method: "random", competitionScope: "mixed" }, mixed), ["PL", "ELC"]);
});

test("only manual needs a host; every other method is set-and-forget", () => {
  assert.equal(isSetAndForget({ method: "manual" }), false);
  for (const method of ["allEligible", "allCompetition", "random"]) {
    assert.equal(isSetAndForget({ method }), true, method);
  }
});

// --- legacy normalisation ---------------------------------------------------

test("legacy leagues normalise to manual at the READ boundary", () => {
  // Pre-v1.3: nothing but a name.
  assert.deepEqual(leagueWeeklyRule({ code: "OLD123", name: "Legacy", owner: "old" }),
    { method: "manual", competitionScope: "PL", count: 6, source: "legacy" });
  // v1.3 Custom Mix, no stored count: the v1.5 default.
  assert.deepEqual(leagueWeeklyRule({ competition: "ELC", customMix: true }),
    { method: "manual", competitionScope: "ELC", count: 6, source: "legacy" });
  // v1.4: the host's own count carries into the rule.
  assert.deepEqual(leagueWeeklyRule({ competitions: ["PL", "ELC"], fixtureMode: "limited", fixtureLimit: 4 }),
    { method: "manual", competitionScope: "mixed", count: 4, source: "legacy" });
  // v1.4 "all": still manual, because that is the binding normalisation — the
  // fallback is what keeps its full-card behaviour intact.
  assert.equal(leagueWeeklyRule({ competitions: ["PL"], fixtureMode: "all" }).method, "manual");
  // v1.5: read as stored.
  assert.deepEqual(leagueWeeklyRule({
    competitions: ["PL", "ELC"],
    weeklyRule: { method: "random", competitionScope: "mixed", count: 3 },
  }), { method: "random", competitionScope: "mixed", count: 3, source: "stored" });
});

test("reading a legacy league leaves the record byte-identical", () => {
  const record = { code: "OLD123", name: "Legacy", owner: "old", competition: "ELC", customMix: true, createdAt: 1 };
  const before = JSON.stringify(record);
  leagueWeeklyRule(record);
  periodKeyForLeague(record)({ matchday: 3 });
  assert.equal(JSON.stringify(record), before, "a read never writes back");
});

test("a stored rule with rubbish in it degrades rather than throwing", () => {
  const league = { competitions: ["PL"], weeklyRule: { method: "random", competitionScope: "ELC", count: 999 } };
  const rule = leagueWeeklyRule(league);
  assert.equal(rule.competitionScope, "PL", "a scope the league does not play falls back to its own");
  assert.equal(rule.count, MAX_FIXTURE_COUNT, "the count is clamped, not trusted");
  // allCompetition can never resolve to "mixed" — it would silently widen.
  assert.equal(leagueWeeklyRule({
    competitions: ["PL", "ELC"],
    weeklyRule: { method: "allCompetition", competitionScope: "mixed", count: 6 },
  }).competitionScope, "PL");
});

// ===========================================================================
// 2. periodKey — ONE definition
// ===========================================================================

test("the period key is inherited, not re-derived", () => {
  const fixture = { id: "pl-1", matchday: 7, startAt: "2026-08-15T14:00:00+01:00" };
  // The league-bound form and the raw form are the same function.
  assert.equal(periodKeyForLeague({ competitions: ["PL"] })(fixture), periodKeyOf(fixture, false));
  assert.equal(periodKeyForLeague({ competitions: ["PL", "ELC"] })(fixture), periodKeyOf(fixture, true));
  assert.equal(periodKeyForLeague({ competitions: ["PL"] })(fixture), "7");
  assert.equal(periodKeyForLeague({ competitions: ["PL", "ELC"] })(fixture), "w2026-08-11");
});

test("a window opens Tuesday morning and closes Monday midnight", () => {
  const opens = periodOpensAt("w2026-08-11");
  assert.equal(new Date(opens).toISOString(), "2026-08-11T00:00:00.000Z");
  assert.equal(new Date(periodClosesAt("w2026-08-11")).toISOString(), "2026-08-18T00:00:00.000Z");
  // A matchweek has no calendar opening of its own.
  assert.equal(periodOpensAt("7"), null);
  assert.equal(periodClosesAt("7"), null);
});

test("the Tuesday–Monday boundary keeps a round on one side of itself", () => {
  // Monday night football settles the week it belongs to...
  assert.equal(windowKeyFor("2026-08-17T20:00:00+01:00"), "w2026-08-11");
  // ...and the very next morning opens the next one.
  assert.equal(windowKeyFor("2026-08-18T00:01:00+01:00"), "w2026-08-18");
  // 23:59 on the Monday is still the closing week; a minute later is not.
  assert.equal(windowKeyFor("2026-08-17T23:59:00+01:00"), "w2026-08-11");
  assert.equal(windowKeyFor("2026-08-18T00:00:00+01:00"), "w2026-08-18");
});

test("a Champions League midweek is ONE window, never two", () => {
  const tuesday = { id: "cl-1", startAt: "2026-10-20T20:00:00+01:00" };
  const wednesday = { id: "cl-2", startAt: "2026-10-21T20:00:00+01:00" };
  const keyOf = periodKeyForLeague({ competitions: ["PL", "CL"] });
  assert.equal(keyOf(tuesday), keyOf(wednesday));
  assert.equal(keyOf(tuesday), "w2026-10-20");
  // And the weekend that follows them is the same week again.
  assert.equal(keyOf({ id: "pl-9", startAt: "2026-10-24T15:00:00+01:00" }), "w2026-10-20");
});

test("periods order chronologically whether they are numbers or windows", () => {
  assert.deepEqual(["10", "2", "1"].sort(comparePeriods), ["1", "2", "10"]);
  assert.deepEqual(["w2026-09-01", "w2026-08-11"].sort(comparePeriods), ["w2026-08-11", "w2026-09-01"]);
});

// ===========================================================================
// 3. The draft → published lifecycle
// ===========================================================================

test("a slate with no status reads as PUBLISHED, and is not rewritten", () => {
  const legacy = { mode: "custom", fixtureIds: ["pl-1"], lockedAt: "2026-08-01T00:00:00Z" };
  const before = JSON.stringify(legacy);
  assert.equal(slateStatus(legacy), "published");
  assert.equal(isPublishedSlate(legacy), true);
  assert.equal(isDraftSlate(legacy), false);
  assert.equal(normaliseSlate(legacy).status, "published");
  assert.equal(JSON.stringify(legacy), before, "the read boundary never writes back");
  assert.equal(slateStatus(null), null);
});

test("the lifecycle only ever moves forward", () => {
  assert.equal(canAdvanceSlate(null, "draft"), true);
  assert.equal(canAdvanceSlate(null, "published"), true);
  assert.equal(canAdvanceSlate({ status: "draft" }, "published"), true);
  assert.equal(canAdvanceSlate({ status: "published" }, "locked"), true);
  assert.equal(canAdvanceSlate({ status: "locked" }, "settled"), true);
  // And never back.
  assert.equal(canAdvanceSlate({ status: "published" }, "draft"), false);
  assert.equal(canAdvanceSlate({ status: "published" }, "published"), false);
  assert.equal(canAdvanceSlate({ status: "settled" }, "locked"), false);
  // A legacy slate is published, so it cannot be dropped back to a draft.
  assert.equal(canAdvanceSlate({ mode: "custom" }, "draft"), false);
});

test("publishing snapshots ids, competition, kickoffs, period and rule source", () => {
  const pool = [
    { id: "pl-a", player1: "A", player2: "B", startAt: "2026-08-15T14:00:00+01:00" },
    { id: "elc-b", player1: "C", player2: "D", startAt: "2026-08-15T15:00:00+01:00" },
  ];
  const snapshot = buildSlateSnapshot(["pl-a", "elc-b"], pool, "w2026-08-11", "host");
  assert.equal(snapshot.periodKey, "w2026-08-11");
  assert.equal(snapshot.ruleSource, "host");
  assert.deepEqual(snapshot.fixtures.map((f) => f.competition), ["PL", "ELC"]);
  assert.deepEqual(snapshot.fixtures.map((f) => f.kickoffAt),
    ["2026-08-15T14:00:00+01:00", "2026-08-15T15:00:00+01:00"]);
  assert.deepEqual(snapshot.fixtures.map((f) => f.label), ["A v B", "C v D"]);
});

test("a reschedule updates the snapshot's metadata and never its fixture list", () => {
  const pool = [
    { id: "pl-a", player1: "A", player2: "B", startAt: "2026-08-15T14:00:00+01:00" },
    { id: "pl-b", player1: "C", player2: "D", startAt: "2026-08-15T15:00:00+01:00" },
  ];
  const snapshot = buildSlateSnapshot(["pl-a", "pl-b"], pool, "1", "host");

  // Nothing moved: nothing to write.
  assert.equal(refreshSnapshot(snapshot, pool), null);

  // A kickoff moves: the time updates, the list does not.
  const moved = [{ ...pool[0], startAt: "2026-08-16T14:00:00+01:00" }, pool[1]];
  const afterMove = refreshSnapshot(snapshot, moved);
  assert.deepEqual(afterMove.fixtures.map((f) => f.id), ["pl-a", "pl-b"]);
  assert.equal(afterMove.fixtures[0].kickoffAt, "2026-08-16T14:00:00+01:00");
  assert.ok(afterMove.revisedAt);

  // A fixture is postponed: it is MARKED, not swapped and not erased.
  const postponed = [{ ...pool[0], status: "postponed" }, pool[1]];
  const afterPostponement = refreshSnapshot(snapshot, postponed);
  assert.deepEqual(afterPostponement.fixtures.map((f) => f.id), ["pl-a", "pl-b"], "the list is the league's contract");
  assert.equal(afterPostponement.fixtures[0].unavailable, true);
  assert.equal(afterPostponement.fixtures[1].unavailable, undefined);
});

test("the picker pre-load reports what moved, rather than quietly losing it", () => {
  const pool = [
    { id: "pl-a", player1: "A", player2: "B", startAt: "2026-08-15T14:00:00+01:00" },
    { id: "pl-b", player1: "C", player2: "D", startAt: "2026-08-15T15:00:00+01:00", status: "postponed" },
    { id: "pl-c", player1: "E", player2: "F", startAt: "2026-08-15T16:00:00+01:00", status: "cancelled" },
  ];
  const out = preloadSelection(["pl-a", "pl-b", "pl-c", "pl-gone"], pool);
  assert.deepEqual(out.fixtureIds, ["pl-a"], "only what is genuinely still on carries");
  assert.deepEqual(out.unavailable.map((entry) => [entry.id, entry.reason]), [
    ["pl-b", "postponed"],
    ["pl-c", "voided"],
    ["pl-gone", "notInPool"],
  ]);
  // Every carried-over fixture is accounted for, one way or the other.
  assert.equal(out.fixtureIds.length + out.unavailable.length, 4);
});

test("a random selection is deterministic per league and period", () => {
  const pool = Array.from({ length: 10 }, (_, index) => ({
    id: `pl-${String(index + 1).padStart(2, "0")}`,
    startAt: new Date(Date.parse("2026-08-15T12:00:00Z") + index * HOUR).toISOString(),
  }));
  const first = randomSelection(pool, 4, "ABC123:1");
  assert.equal(first.length, 4);
  assert.deepEqual(randomSelection(pool, 4, "ABC123:1"), first, "a job that runs twice deals the same week");
  assert.notDeepEqual(randomSelection(pool, 4, "ABC123:2"), first, "a different week is a different deal");
  // Stored in kickoff order, whatever order it was dealt in.
  assert.deepEqual(first, [...first].sort());
  // A count larger than the pool takes the pool, and never fails.
  assert.equal(randomSelection(pool, 50, "ABC123:1").length, 10);
  assert.equal(randomSelection([], 4, "ABC123:1").length, 0);
});

test("a random mixed week never excludes a competition that has fixtures on", () => {
  const pool = [
    { id: "pl-1", startAt: "2026-08-15T12:00:00Z" },
    { id: "pl-2", startAt: "2026-08-15T13:00:00Z" },
    { id: "pl-3", startAt: "2026-08-15T14:00:00Z" },
    { id: "elc-1", startAt: "2026-08-15T15:00:00Z" },
  ];
  for (const seed of ["A:1", "B:2", "C:3", "D:4", "E:5"]) {
    const chosen = randomSelection(pool, 2, seed);
    assert.ok(chosen.some((id) => id.startsWith("elc-")), `${seed} kept the Championship`);
    assert.ok(chosen.some((id) => id.startsWith("pl-")), `${seed} kept the Premier League`);
  }
});

// ===========================================================================
// 4. Endpoints and the weekly loop
// ===========================================================================

const round = (count = 10, firstKickoff = Date.parse("2026-08-21T12:00:00Z"), matchday = 1) =>
  Array.from({ length: count }, (_, index) => ({
    id: `pl-2026-27-md${matchday}-${String(index + 1).padStart(3, "0")}`,
    matchday,
    player1: `Home ${index + 1}`,
    player2: `Away ${index + 1}`,
    startAt: new Date(firstKickoff + index * HOUR).toISOString(),
  }));

function endpointEnv(store = new Map()) {
  return {
    env: { FIXTURES_URL: "https://example.com/fixtures.json", KV: memoryKV(store) },
    store,
  };
}

async function withFixtures(fixtureList, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: fixtureList }), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
  method: "POST", body: JSON.stringify(body),
}), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);
const prime = (env) => get(env)("/fixtures?refresh=1");

async function runScheduled(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

// --- wizard end to end ------------------------------------------------------

test("the wizard stores name, competitions and the weekly rule", async () => {
  const list = round();
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const created = await (await send("/league", {
      uid: "host", nickname: "Host", name: "Tuesday Club",
      competitions: ["PL"],
      fixtureMode: "limited",
      weeklyRule: { method: "random", competitionScope: "PL", count: 3 },
    })).json();
    assert.equal(created.name, "Tuesday Club");
    assert.deepEqual(created.weeklyRule, { method: "random", competitionScope: "PL", count: 3 });
    const stored = JSON.parse(store.get(`league:${created.code}`));
    assert.deepEqual(stored.weeklyRule, { method: "random", competitionScope: "PL", count: 3 });

    // A count of one is accepted — the wizard soft-confirms it, it is not an error.
    const single = await send("/league", {
      uid: "h2", name: "Short", competitions: ["PL"],
      weeklyRule: { method: "random", competitionScope: "PL", count: 1 },
    });
    assert.equal(single.status, 200);
    assert.equal((await single.json()).weeklyRule.count, 1);

    // A bad rule is refused before anything is written.
    const bad = await send("/league", {
      uid: "h3", name: "Bad", competitions: ["PL"],
      weeklyRule: { method: "allCompetition", competitionScope: "ELC", count: 6 },
    });
    assert.equal(bad.status, 400);
  });
});

test("a client that sends no rule at all still gets a coherent league", async () => {
  const list = round();
  const { env } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const manual = await (await send("/league", { uid: "a", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 5 })).json();
    assert.deepEqual(manual.weeklyRule, { method: "manual", competitionScope: "PL", count: 5 });
    const all = await (await send("/league", { uid: "b", competitions: ["PL"], fixtureMode: "all" })).json();
    assert.equal(all.weeklyRule.method, "allEligible");
  });
});

test("the host can switch manual to a rule and back at any time", async () => {
  const list = round();
  const { env } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();

    assert.equal((await send("/league/weekly-rule", { uid: "m2", code, weeklyRule: { method: "random", count: 4 } })).status, 403);
    const toRule = await send("/league/weekly-rule", { uid: "host", code, weeklyRule: { method: "random", competitionScope: "PL", count: 4 } });
    assert.equal(toRule.status, 200);
    assert.equal((await get(env)(`/state?code=${code}`)).status, 200);
    let state = await (await get(env)(`/state?code=${code}`)).json();
    assert.equal(state.weeklyRule.method, "random");
    assert.equal(state.setAndForget, true);

    const back = await send("/league/weekly-rule", { uid: "host", code, weeklyRule: { method: "manual", competitionScope: "PL", count: 2 } });
    assert.equal(back.status, 200);
    state = await (await get(env)(`/state?code=${code}`)).json();
    assert.equal(state.weeklyRule.method, "manual");
    assert.equal(state.weeklyRule.count, 2);
    assert.equal(state.setAndForget, false);

    assert.equal((await send("/league/weekly-rule", { uid: "host", code, weeklyRule: { method: "nope" } })).status, 400);
  });
});

// --- draft → publish --------------------------------------------------------

test("a draft is rewritable, invisible to members, and does not score", async () => {
  const list = round();
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host", competitions: ["PL"], fixtureMode: "limited" })).json();
    await send("/join", { uid: "m2", code, nickname: "Two" });
    const ids = list.map((match) => match.id);

    const first = await send("/league/slate", { uid: "host", code, period: "1", action: "draft", fixtureIds: ids.slice(0, 4) });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).slate.status, "draft");

    // Rewritable, unlike a published slate.
    const second = await send("/league/slate", { uid: "host", code, period: "1", action: "draft", fixtureIds: ids.slice(0, 6) });
    assert.equal(second.status, 200);
    assert.deepEqual(JSON.parse(store.get(`custom_slate:${code}:1`)).fixtureIds, ids.slice(0, 6));

    // Members see no slate at all — a draft is the host's working copy.
    const state = await (await get(env)(`/state?code=${code}&period=1`)).json();
    assert.equal(state.slate, null, "a draft is never presented as this week's slate");
    assert.equal(state.draft.count, 6, "but the host's own picker can reopen on it");
    assert.equal(state.preload.source, "draft");

    // Publishing it is the forward move.
    const published = await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: ids.slice(0, 6) });
    assert.equal(published.status, 200);
    assert.equal((await published.json()).slate.status, "published");
    assert.equal((await (await get(env)(`/state?code=${code}&period=1`)).json()).slate.count, 6);
  });
});

test("publishing is one-way: a published week is a 409, forever", async () => {
  const list = round();
  const { env } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", competitions: ["PL"], fixtureMode: "limited" })).json();
    const ids = list.map((match) => match.id);

    assert.equal((await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: ids.slice(0, 6) })).status, 200);
    assert.equal((await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: ids.slice(0, 5) })).status, 409);
    // Nor can it be dropped back to a draft.
    const backwards = await send("/league/slate", { uid: "host", code, period: "1", action: "draft", fixtureIds: ids.slice(0, 3) });
    assert.equal(backwards.status, 409);
  });
});

test("a legacy slate is published, so an existing league never becomes editable", async () => {
  const list = round();
  const store = new Map([
    ["league:OLD123", JSON.stringify({ code: "OLD123", name: "Legacy", owner: "old", customMix: true, hadSlates: true })],
    ["member:OLD123:old", JSON.stringify({ nick: "Old", since: 0 })],
    // Exactly the shape v1.4 wrote: no status field at all.
    [`custom_slate:OLD123:1`, JSON.stringify({ mode: "custom", fixtureIds: list.slice(0, 6).map((m) => m.id), lockedAt: "2026-08-01T00:00:00Z", setBy: "old" })],
  ]);
  const before = store.get("custom_slate:OLD123:1");
  const { env } = endpointEnv(store);
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const rewrite = await send("/league/slate", { uid: "old", code: "OLD123", period: "1", fixtureIds: list.slice(0, 8).map((m) => m.id) });
    assert.equal(rewrite.status, 409, "a slate written before the lifecycle existed is still final");
    assert.equal(store.get("custom_slate:OLD123:1"), before, "and it is not rewritten to say so");

    const state = await (await get(env)("/state?code=OLD123&period=1")).json();
    assert.equal(state.slate.status, "published");
    assert.equal(state.slate.count, 6);
    assert.equal(state.draft, null);
  });
});

test("the picker pre-loads last week's count once a week has been played", async () => {
  const two = [...round(10, Date.parse("2026-08-21T12:00:00Z"), 1), ...round(10, Date.parse("2026-08-28T12:00:00Z"), 2)];
  const { env } = endpointEnv();
  await withFixtures(two, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();

    // Nothing played yet: the picker opens on the league's own count.
    let state = await (await get(env)(`/state?code=${code}&period=1`)).json();
    assert.equal(state.preload.source, "none");
    assert.equal(state.preload.count, 6);
    assert.deepEqual([state.preload.min, state.preload.max], [1, 10]);

    // Play a four-fixture week...
    await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: two.slice(0, 4).map((m) => m.id) });

    // ...and next week opens on four, carrying the SETTINGS, not the fixtures.
    state = await (await get(env)(`/state?code=${code}&period=2`)).json();
    assert.equal(state.preload.source, "lastWeek");
    assert.equal(state.preload.from, "1");
    assert.equal(state.preload.count, 4);
    assert.deepEqual(state.preload.fixtureIds, [], "last week's fixtures belong to last week");
    assert.deepEqual(state.preload.unavailable, []);
  });
});

test("a draft pre-load names the fixtures that have gone since it was saved", async () => {
  const list = round();
  const { env } = endpointEnv();
  const ids = list.map((match) => match.id);
  let code;
  await withFixtures(list, async () => {
    await prime(env);
    code = (await (await post(env)("/league", { uid: "host", competitions: ["PL"], fixtureMode: "limited" })).json()).code;
    await post(env)("/league/slate", { uid: "host", code, period: "1", action: "draft", fixtureIds: ids.slice(0, 5) });
  });

  const postponed = list.map((match, index) => (index === 1 ? { ...match, status: "postponed" } : match));
  await withFixtures(postponed, async () => {
    await prime(env);
    const state = await (await get(env)(`/state?code=${code}&period=1`)).json();
    assert.deepEqual(state.preload.fixtureIds, [ids[0], ids[2], ids[3], ids[4]]);
    assert.deepEqual(state.preload.unavailable.map((entry) => [entry.id, entry.reason]), [[ids[1], "postponed"]]);
  });
});

// --- the weekly loop --------------------------------------------------------

test("a manual host is nudged once, with copy that matches their league", async () => {
  const list = round(10, Date.now() + 40 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", nickname: "Host", name: "Sunday Six", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();

    await runScheduled(env);
    // A single-competition league has a real matchweek number, so it is named.
    assert.ok(store.has(`notified:slate-open:${code}:1`));
    // Nothing was published on the host's behalf this far out.
    assert.equal(store.has(`custom_slate:${code}:1`), false);

    // A second tick is silent: dedupe is leagueId + periodKey + pushType.
    const keysBefore = [...store.keys()].filter((key) => key.startsWith("notified:")).length;
    await runScheduled(env);
    assert.equal([...store.keys()].filter((key) => key.startsWith("notified:")).length, keysBefore);
  });
});

test("a set-and-forget league publishes itself with no admin step", async () => {
  const list = round(10, Date.now() + 40 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", nickname: "Host", competitions: ["PL"],
      weeklyRule: { method: "random", competitionScope: "PL", count: 3 },
    })).json();
    await send("/join", { uid: "m2", code, nickname: "Two" });

    await runScheduled(env);
    const slate = JSON.parse(store.get(`custom_slate:${code}:1`));
    assert.equal(slate.status, "published");
    assert.equal(slate.ruleSource, "random");
    assert.equal(slate.fixtureIds.length, 3);
    assert.equal(slate.setBy, null, "nobody chose it");
    assert.ok(store.has(`notified:slate-published:${code}:1`));
    // The host is not nudged for a league that does not need them.
    assert.equal(store.has(`notified:slate-open:${code}:1`), false);

    // Idempotent: a second tick republishes nothing and re-deals nothing.
    const before = store.get(`custom_slate:${code}:1`);
    await runScheduled(env);
    assert.equal(store.get(`custom_slate:${code}:1`), before);
  });
});

test("an allCompetition rule publishes exactly the competition it names", async () => {
  const mixed = [
    { id: "pl-2026-27-001-a-b", matchday: 1, player1: "A", player2: "B", startAt: new Date(Date.now() + 40 * HOUR).toISOString() },
    { id: "pl-2026-27-002-c-d", matchday: 1, player1: "C", player2: "D", startAt: new Date(Date.now() + 41 * HOUR).toISOString() },
    { id: "elc-2026-27-001-e-f", matchday: 1, player1: "E", player2: "F", startAt: new Date(Date.now() + 42 * HOUR).toISOString() },
  ];
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/pl.json",
    FIXTURES_URL_ELC: "https://example.com/elc.json",
    KV: memoryKV(store),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    fixtures: mixed.filter((f) => f.id.startsWith(String(url).includes("elc") ? "elc-" : "pl-")),
  }), { status: 200 });
  try {
    await get(env)("/fixtures?competition=PL&refresh=1");
    await get(env)("/fixtures?competition=ELC&refresh=1");
    const { code } = await (await post(env)("/league", {
      uid: "host", competitions: ["PL", "ELC"],
      weeklyRule: { method: "allCompetition", competitionScope: "ELC", count: 6 },
    })).json();
    await runScheduled(env);
    const period = windowKeyFor(mixed[0].startAt);
    const slate = JSON.parse(store.get(`custom_slate:${code}:${period}`));
    assert.deepEqual(slate.fixtureIds, ["elc-2026-27-001-e-f"], "the scope is explicit, not inferred");
    assert.equal(slate.ruleSource, "allCompetition");
    // The snapshot names the competition each fixture came from.
    assert.deepEqual(slate.snapshot.fixtures.map((f) => f.competition), ["ELC"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- the fallback matrix ----------------------------------------------------

test("fallback: a VALID draft is published as-is, never discarded", async () => {
  const list = round(10, Date.now() + 20 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", nickname: "Host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();
    const chosen = list.slice(2, 6).map((match) => match.id);
    await send("/league/slate", { uid: "host", code, period: "1", action: "draft", fixtureIds: chosen });

    await runScheduled(env);
    const slate = JSON.parse(store.get(`custom_slate:${code}:1`));
    assert.equal(slate.status, "published");
    assert.deepEqual(slate.fixtureIds, chosen, "the host's own draft, exactly as they left it");
    assert.equal(slate.ruleSource, "auto-published:fallback-draft");
    assert.ok(store.has(`notified:auto-published:${code}:1`));
  });
});

test("fallback: an EMPTY draft is never published; the rule applies instead", async () => {
  const list = round(10, Date.now() + 20 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"],
      weeklyRule: { method: "random", competitionScope: "PL", count: 3 },
    })).json();
    // An empty draft, written straight to the store: the endpoint would refuse it.
    store.set(`custom_slate:${code}:1`, JSON.stringify({ status: "draft", mode: "custom", fixtureIds: [], setBy: "host" }));

    await runScheduled(env);
    const slate = JSON.parse(store.get(`custom_slate:${code}:1`));
    assert.equal(slate.status, "published");
    assert.equal(slate.fixtureIds.length, 3, "the weekly rule, not the empty draft");
    assert.equal(slate.ruleSource, "auto-published:random");
  });
});

test("fallback: a manual league with no draft falls back to last week's count", async () => {
  const two = [
    ...round(10, Date.now() - 5 * DAY, 1),
    ...round(10, Date.now() + 20 * HOUR, 2),
  ];
  const { env, store } = endpointEnv();
  await withFixtures(two, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();
    // Last week they played four.
    store.set(`custom_slate:${code}:1`, JSON.stringify({
      status: "published", mode: "custom", fixtureIds: two.slice(0, 4).map((m) => m.id), setBy: "host",
    }));

    await runScheduled(env);
    const slate = JSON.parse(store.get(`custom_slate:${code}:2`));
    assert.equal(slate.fixtureIds.length, 4, "the count they last actually played");
    assert.equal(slate.ruleSource, "auto-published:fallback-lastUsed");
  });
});

test("fallback: a manual league that has never played gets the whole card", async () => {
  // This is what keeps a legacy fixtureMode:"all" league behaving exactly as it
  // always has — normalised to manual, never nudged into a shorter week.
  const list = round(10, Date.now() + 20 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();

    await runScheduled(env);
    const slate = JSON.parse(store.get(`custom_slate:${code}:1`));
    assert.equal(slate.fixtureIds.length, 10, "the full card, not a guess at six");
    assert.equal(slate.mode, "fallback");
    assert.equal(slate.ruleSource, "auto-published:fallback-full");
  });
});

test("fallback: an already-published week is left completely alone", async () => {
  const list = round(10, Date.now() + 20 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", competitions: ["PL"], fixtureMode: "limited" })).json();
    const chosen = list.slice(0, 3).map((match) => match.id);
    await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: chosen });
    const before = store.get(`custom_slate:${code}:1`);

    await runScheduled(env);
    assert.equal(store.get(`custom_slate:${code}:1`), before, "the host answered; the net does nothing");
    assert.equal(store.has(`notified:auto-published:${code}:1`), false);
  });
});

test("fallback: running the whole sweep twice publishes exactly once", async () => {
  const list = round(10, Date.now() + 20 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(list, async () => {
    await prime(env);
    const send = post(env);
    const { code } = await (await send("/league", {
      uid: "host", competitions: ["PL"],
      weeklyRule: { method: "random", competitionScope: "PL", count: 5 },
    })).json();

    await runScheduled(env);
    const first = store.get(`custom_slate:${code}:1`);
    const notices = [...store.keys()].filter((key) => key.startsWith("notified:")).sort();

    await runScheduled(env);
    await runScheduled(env);
    assert.equal(store.get(`custom_slate:${code}:1`), first, "byte-identical after three sweeps");
    assert.deepEqual([...store.keys()].filter((key) => key.startsWith("notified:")).sort(), notices);
  });
});

test("the fallback measures from the first ELIGIBLE kickoff of the period", async () => {
  // 30 hours out is outside the day's grace; the host is nudged, not overridden.
  const far = round(10, Date.now() + 30 * HOUR);
  const { env, store } = endpointEnv();
  await withFixtures(far, async () => {
    await prime(env);
    const { code } = await (await post(env)("/league", {
      uid: "host", competitions: ["PL"], fixtureMode: "limited",
      weeklyRule: { method: "manual", competitionScope: "PL", count: 6 },
    })).json();
    await runScheduled(env);
    assert.equal(store.has(`custom_slate:${code}:1`), false);
    assert.ok(store.has(`notified:slate-open:${code}:1`));
  });
});
