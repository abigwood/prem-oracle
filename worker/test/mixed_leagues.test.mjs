import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {
  effectiveFixtureCount,
  isMixedLeague,
  leagueCompetitions,
  leagueFixturePlan,
  needsCompetitionUpgrade,
  periodKeyOf,
  poolByPeriod,
  windowKeyFor,
  windowLabel,
} from "../src/competitions.js";
import { validateSlate } from "../src/logic.js";

const HOUR = 60 * 60 * 1000;

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

// --- competition sets, read at the boundary ---------------------------------

test("all three record generations read as a competition set", () => {
  // Pre-v1.3: no competition field at all.
  assert.deepEqual(leagueCompetitions({ code: "AAA111", name: "Legacy" }), ["PL"]);
  // v1.3: a single competition string.
  assert.deepEqual(leagueCompetitions({ competition: "ELC", customMix: true }), ["ELC"]);
  // v1.6: the array.
  assert.deepEqual(leagueCompetitions({ competitions: ["PL", "ELC"] }), ["PL", "ELC"]);
  // Rubbish in the array falls back rather than throwing.
  assert.deepEqual(leagueCompetitions({ competitions: ["nope"] }), ["PL"]);
  assert.deepEqual(leagueCompetitions({ competitions: [] }), ["PL"]);
  assert.equal(isMixedLeague({ competitions: ["PL", "ELC"] }), true);
  assert.equal(isMixedLeague({ competition: "ELC" }), false);
  assert.equal(isMixedLeague({}), false);
});

test("legacy records are flagged for upgrade but never rewritten by a read", () => {
  assert.equal(needsCompetitionUpgrade({ competition: "ELC" }), true);
  assert.equal(needsCompetitionUpgrade({}), true);
  assert.equal(needsCompetitionUpgrade({ competitions: ["PL"] }), false);
});

test("the fixture plan maps the legacy customMix flag", () => {
  assert.deepEqual(leagueFixturePlan({ customMix: true }), { mode: "limited", limit: null });
  assert.deepEqual(leagueFixturePlan({}), { mode: "all", limit: null });
  assert.deepEqual(leagueFixturePlan({ fixtureMode: "limited", fixtureLimit: 8 }), { mode: "limited", limit: 8 });
  assert.deepEqual(leagueFixturePlan({ fixtureMode: "all" }), { mode: "all", limit: null });
  // v1.5 §9: the floor is one, so a limit of 2 is a real stored preference.
  assert.deepEqual(leagueFixturePlan({ fixtureMode: "limited", fixtureLimit: 2 }), { mode: "limited", limit: 2 });
  assert.deepEqual(leagueFixturePlan({ fixtureMode: "limited", fixtureLimit: 0 }), { mode: "limited", limit: null });
});

test("the configured count is a weekly default, not a cap", () => {
  const eight = effectiveFixtureCount({ weeklyRule: { method: "manual", competitionScope: "PL", count: 8 } }, 12);
  assert.equal(eight.default, 8, "the picker opens on the league default");
  assert.equal(eight.min, 1, "but the host may go down to a single fixture");
  assert.equal(eight.max, 12, "or up to the whole pool");
  assert.equal(eight.capped, false);

  // Blank round: only 5 available for a league whose default is 8.
  const short = effectiveFixtureCount({ weeklyRule: { method: "manual", competitionScope: "PL", count: 8 } }, 5);
  assert.equal(short.default, 5, "the default caps to the pool");
  assert.equal(short.max, 5);
  assert.equal(short.capped, true);

  // A one-fixture week is a one-fixture week, not an error.
  const tiny = effectiveFixtureCount({ weeklyRule: { method: "manual", competitionScope: "PL", count: 8 } }, 1);
  assert.deepEqual([tiny.min, tiny.max, tiny.default], [1, 1, 1]);

  // A rule that takes everything reports the pool, whatever its size.
  const all = effectiveFixtureCount({ weeklyRule: { method: "allEligible", competitionScope: "PL", count: 6 } }, 12);
  assert.deepEqual([all.mode, all.default, all.min, all.max], ["all", 12, 12, 12]);

  // A legacy Custom Mix league has no stored count: the v1.5 default of six.
  const legacy = effectiveFixtureCount({ customMix: true }, 12);
  assert.deepEqual([legacy.default, legacy.min, legacy.max], [6, 1, 12]);

  // A legacy league that DID store a count keeps it.
  const kept = effectiveFixtureCount({ fixtureMode: "limited", fixtureLimit: 4 }, 12);
  assert.equal(kept.default, 4);
});

// --- windows ----------------------------------------------------------------

test("windows run Tuesday to Monday in London time", () => {
  // v1.5 §9: the window opens on Tuesday morning, once Monday night football
  // has settled the round before it, and closes at Monday midnight.
  assert.equal(windowKeyFor("2026-08-11T19:00:00+01:00"), "w2026-08-11", "Tuesday opens its own window");
  assert.equal(windowKeyFor("2026-08-15T14:00:00+01:00"), "w2026-08-11", "Saturday sits in it");
  assert.equal(windowKeyFor("2026-08-16T15:00:00+01:00"), "w2026-08-11", "so does Sunday");
  assert.equal(windowKeyFor("2026-08-17T20:00:00+01:00"), "w2026-08-11", "Monday night football closes it");
  assert.equal(windowKeyFor("2026-08-18T19:45:00+01:00"), "w2026-08-18", "the next Tuesday starts a new one");
  assert.equal(windowKeyFor("not a date"), null);
});

test("a Champions League Tuesday and Wednesday share ONE window", () => {
  // Both matchdays of a European week sit at the head of the same window, so a
  // mixed league scores them together instead of splitting the week in two.
  assert.equal(windowKeyFor("2026-09-15T20:00:00+01:00"), windowKeyFor("2026-09-16T20:00:00+01:00"));
  assert.equal(windowKeyFor("2026-09-15T20:00:00+01:00"), "w2026-09-15");
  // And the Saturday that follows is still the same week.
  assert.equal(windowKeyFor("2026-09-19T15:00:00+01:00"), "w2026-09-15");
  // The Monday before them belongs to the week that is closing, not this one.
  assert.equal(windowKeyFor("2026-09-14T20:00:00+01:00"), "w2026-09-08");
});

test("a late Monday kickoff stays in its own week across the BST boundary", () => {
  // 22:00 UTC on Monday is 23:00 London in BST — still Monday, still that week.
  assert.equal(windowKeyFor("2026-08-17T22:00:00Z"), "w2026-08-11");
  // In GMT, 00:30 UTC Tuesday is 00:30 London Tuesday — the new week.
  assert.equal(windowKeyFor("2026-12-01T00:30:00Z"), "w2026-12-01");
});

test("window labels read as a human week", () => {
  assert.equal(windowLabel("w2026-08-11"), "Tue 11 – Mon 17 Aug");
  assert.equal(windowLabel("1"), "");
});

test("periods are matchweeks for a single competition and windows for a mix", () => {
  const fixture = { id: "pl-1-a-b", matchday: 7, startAt: "2026-08-15T14:00:00+01:00" };
  assert.equal(periodKeyOf(fixture, false), "7");
  assert.equal(periodKeyOf(fixture, true), "w2026-08-11");
});

// --- the mixed pool ---------------------------------------------------------

const mixedFixtures = [
  // Week of Tue 11 Aug: 2 PL + 3 ELC.
  { id: "pl-2026-27-001-a-b", matchday: 1, startAt: "2026-08-15T14:00:00+01:00", player1: "A", player2: "B" },
  { id: "pl-2026-27-002-c-d", matchday: 1, startAt: "2026-08-15T16:30:00+01:00", player1: "C", player2: "D" },
  { id: "elc-2026-27-001-e-f", matchday: 1, startAt: "2026-08-14T20:00:00+01:00", player1: "E", player2: "F" },
  { id: "elc-2026-27-002-g-h", matchday: 1, startAt: "2026-08-15T15:00:00+01:00", player1: "G", player2: "H" },
  { id: "elc-2026-27-003-i-j", matchday: 1, startAt: "2026-08-16T13:30:00+01:00", player1: "I", player2: "J" },
  // Week of Tue 18 Aug: ELC only — a week where one competition is dark.
  { id: "elc-2026-27-004-k-l", matchday: 2, startAt: "2026-08-22T15:00:00+01:00", player1: "K", player2: "L" },
];

test("the pool is the selected competitions inside the window", () => {
  const mixed = poolByPeriod(mixedFixtures, { competitions: ["PL", "ELC"] });
  assert.deepEqual([...mixed.keys()].sort(), ["w2026-08-11", "w2026-08-18"]);
  assert.equal(mixed.get("w2026-08-11").length, 5);
  assert.equal(mixed.get("w2026-08-18").length, 1);

  // Deselecting a competition removes it from the pool entirely.
  const plOnly = poolByPeriod(mixedFixtures, { competitions: ["PL"] });
  assert.deepEqual([...plOnly.keys()], ["1"], "single competition keeps official matchweeks");
  assert.equal(plOnly.get("1").length, 2);

  const elcOnly = poolByPeriod(mixedFixtures, { competitions: ["ELC"] });
  assert.deepEqual([...elcOnly.keys()].sort(), ["1", "2"]);
  assert.equal(elcOnly.get("1").length, 3);
});

test("a legacy league's pool is unchanged by the window model", () => {
  const legacy = poolByPeriod(mixedFixtures, { code: "OLD123" });
  assert.deepEqual([...legacy.keys()], ["1"]);
  assert.deepEqual(legacy.get("1").map((f) => f.id), ["pl-2026-27-001-a-b", "pl-2026-27-002-c-d"]);
});

// --- slate validation against a pool and a limit -----------------------------

test("a host may take more or fewer than the default in any given week", () => {
  const pool = mixedFixtures.slice(0, 5);
  const ids = pool.map((f) => f.id);
  const bounds = effectiveFixtureCount({ fixtureMode: "limited", fixtureLimit: 4 }, pool.length);

  // The default is 4, but 3 and 5 are both perfectly valid this week.
  assert.equal(validateSlate("custom", ids.slice(0, 3), pool, bounds).fixtureIds.length, 3, "fewer");
  assert.equal(validateSlate("custom", ids.slice(0, 4), pool, bounds).fixtureIds.length, 4, "the default");
  assert.equal(validateSlate("custom", ids, pool, bounds).fixtureIds.length, 5, "more");

  // v1.5 §9: the floor is one fixture, so two is fine and one is fine.
  assert.equal(validateSlate("custom", ids.slice(0, 2), pool, bounds).fixtureIds.length, 2);
  assert.equal(validateSlate("custom", ids.slice(0, 1), pool, bounds).fixtureIds.length, 1, "a short week is a real week");
  // The pool is the only ceiling, and an empty selection is the only failure.
  assert.equal(validateSlate("custom", [], pool, bounds).error, "select between 1 and 5 fixtures");

  const shortPool = pool.slice(0, 2);
  const capped = effectiveFixtureCount({ fixtureMode: "limited", fixtureLimit: 4 }, shortPool.length);
  assert.equal(validateSlate("custom", shortPool.map((f) => f.id), shortPool, capped).fixtureIds.length, 2);
});

test("slates store in kickoff order across competitions", () => {
  const pool = mixedFixtures.slice(0, 5);
  const bounds = effectiveFixtureCount({ fixtureMode: "limited", fixtureLimit: 5 }, pool.length);
  const out = validateSlate("custom", [...pool.map((f) => f.id)].reverse(), pool, bounds);
  assert.deepEqual(out.fixtureIds, [
    "elc-2026-27-001-e-f",   // Fri 20:00
    "pl-2026-27-001-a-b",    // Sat 14:00
    "elc-2026-27-002-g-h",   // Sat 15:00
    "pl-2026-27-002-c-d",    // Sat 16:30
    "elc-2026-27-003-i-j",   // Sun 13:30
  ]);
});

// --- endpoints ---------------------------------------------------------------

const feeds = {
  pl: { fixtures: mixedFixtures.filter((f) => f.id.startsWith("pl-")) },
  elc: { fixtures: mixedFixtures.filter((f) => f.id.startsWith("elc-")) },
};

async function withFeeds(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify(String(url).includes("elc") ? feeds.elc : feeds.pl), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

function env(store = new Map()) {
  return {
    env: {
      FIXTURES_URL: "https://example.com/pl.json",
      FIXTURES_URL_ELC: "https://example.com/elc.json",
      KV: memoryKV(store),
    },
    store,
  };
}
const post = (e) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) }), e);
const get = (e) => (path) => worker.fetch(new Request(`https://worker.test${path}`), e);

test("leagues are creatable for one competition, the other, or both", async () => {
  const { env: e } = env();
  await withFeeds(async () => {
    await get(e)("/fixtures?competition=PL&refresh=1");
    await get(e)("/fixtures?competition=ELC&refresh=1");
    const send = post(e);

    const plOnly = await (await send("/league", { uid: "h1", name: "PL", competitions: ["PL"], fixtureMode: "all" })).json();
    assert.deepEqual(plOnly.competitions, ["PL"]);
    assert.equal(plOnly.fixtureMode, "all");

    const elcOnly = await (await send("/league", { uid: "h2", name: "ELC", competitions: ["ELC"], fixtureMode: "limited", fixtureLimit: 3 })).json();
    assert.deepEqual(elcOnly.competitions, ["ELC"]);
    assert.equal(elcOnly.fixtureLimit, 3);

    const both = await (await send("/league", { uid: "h3", name: "Mix", competitions: ["ELC", "PL"], fixtureMode: "limited", fixtureLimit: 4 })).json();
    assert.deepEqual(both.competitions, ["PL", "ELC"], "stored in a stable order regardless of tick order");
    assert.equal(both.customMix, true, "older clients still see a boolean");
  });
});

test("zero competitions is refused, as is an unknown one or a bad limit", async () => {
  const { env: e } = env();
  await withFeeds(async () => {
    const send = post(e);
    assert.equal((await (await send("/league", { uid: "x", competitions: [] })).json()).error, "choose at least one competition");
    assert.equal((await (await send("/league", { uid: "x", competitions: ["PL", "XYZ"] })).json()).error, "unknown competition");
    assert.match((await (await send("/league", { uid: "x", competitions: ["PL"], fixtureMode: "some" })).json()).error, /fixtureMode must be/);
    // v1.5 §9: one validation path, 1 to 20. Two is now perfectly legal; zero
    // and twenty-one are not.
    assert.equal((await (await send("/league", { uid: "x2", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 2 })).status), 200);
    assert.match((await (await send("/league", { uid: "x", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 0 })).json()).error, /between 1 and 20/);
    assert.match((await (await send("/league", { uid: "x", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 21 })).json()).error, /between 1 and 20/);
  });
});

test("a mixed league slates, locks and scores on its own week window", async () => {
  const { env: e, store } = env();
  await withFeeds(async () => {
    await get(e)("/fixtures?competition=PL&refresh=1");
    await get(e)("/fixtures?competition=ELC&refresh=1");
    const send = post(e);
    const { code } = await (await send("/league", {
      uid: "host", nickname: "Host", name: "Mixed", competitions: ["PL", "ELC"],
      fixtureMode: "limited", fixtureLimit: 4,
    })).json();
    await send("/join", { uid: "m2", code, nickname: "Two" });

    // The state reports the window, not a matchweek.
    const season = await (await get(e)(`/state?code=${code}`)).json();
    assert.deepEqual(season.competitions, ["PL", "ELC"]);
    assert.equal(season.mixed, true);
    assert.equal(season.currentPeriod, "w2026-08-11");
    assert.equal(season.currentWindowLabel, "Tue 11 – Mon 17 Aug");
    assert.equal(season.currentPoolSize, 5);
    assert.equal(season.currentFixtureCount.default, 4, "opens on the league default");
    assert.equal(season.currentFixtureCount.max, 5, "but the whole pool is available");

    // Slate keys on the window.
    const ids = ["elc-2026-27-001-e-f", "pl-2026-27-001-a-b", "elc-2026-27-002-g-h", "pl-2026-27-002-c-d"];
    const set = await send("/league/slate", { uid: "host", code, period: "w2026-08-11", mode: "custom", fixtureIds: ids });
    assert.equal(set.status, 200);
    assert.ok(store.has(`custom_slate:${code}:w2026-08-11`), "keyed on the window, not a matchweek");

    // The same league may take a different count next week — nothing per-week
    // is stored, the slate's own length is the count.
    // A different week can take a different count, and a one-fixture week is a
    // one-fixture slate — the floor collapses onto the pool rather than failing.
    const nextWeek = await send("/league/slate", {
      uid: "host", code, period: "w2026-08-18", mode: "custom",
      fixtureIds: ["elc-2026-27-004-k-l"],
    });
    assert.equal(nextWeek.status, 200, "the pool is the only ceiling, and the floor gives way to it");
    assert.equal((await nextWeek.json()).slate.fixtureIds.length, 1);

    // Immutability survives the move to windows.
    const rewrite = await send("/league/slate", { uid: "host", code, period: "w2026-08-11", mode: "custom", fixtureIds: ids });
    assert.equal(rewrite.status, 409);

    // Results land in both competition keys and the table unions them.
    store.set("results:PL", JSON.stringify({
      "pl-2026-27-001-a-b": { status: "complete", result: [2, 1] },
      "pl-2026-27-002-c-d": { status: "complete", result: [0, 0] },
    }));
    store.set("results:ELC", JSON.stringify({
      "elc-2026-27-001-e-f": { status: "complete", result: [1, 0] },
      "elc-2026-27-002-g-h": { status: "complete", result: [3, 1] },
    }));
    for (const [id, pick] of [
      ["pl-2026-27-001-a-b", { p1: 2, p2: 1 }],
      ["pl-2026-27-002-c-d", { p1: 0, p2: 0 }],
      ["elc-2026-27-001-e-f", { p1: 1, p2: 0 }],
      ["elc-2026-27-002-g-h", { p1: 0, p2: 3 }],
    ]) {
      store.set(`picks:${id}`, JSON.stringify({ host: { ...pick, ts: 1 }, m2: { p1: 9, p2: 9, ts: 1 } }));
    }
    await get(e)("/fixtures?competition=PL&refresh=1");
    await get(e)("/fixtures?competition=ELC&refresh=1");

    const round = await (await get(e)(`/state?code=${code}&period=w2026-08-11`)).json();
    assert.equal(round.complete, true, "every slate fixture settled, across both competitions");
    // Three exact (15) plus one wrong outcome (0).
    assert.equal(round.table[0].pts, 15);
    assert.equal(round.table[0].nick, "Host");
    // Two's blanket 9-9 is a draw prediction, and pl-002 finished 0-0 — a
    // correct draw is 2 points, so they take silver on a Premier League
    // fixture while the gold was won across both competitions.
    assert.deepEqual(round.podium.map((p) => p.place), ["gold", "silver"]);
    assert.equal(round.table[1].pts, 2);
    assert.equal(round.windowLabel, "Tue 11 – Mon 17 Aug");

    const cabinet = await (await get(e)(`/state?code=${code}&uid=host`)).json();
    assert.equal(cabinet.cabinet.gold, 1);
    assert.equal(cabinet.cabinet.weeks[0].period, "w2026-08-11");
    assert.equal(cabinet.cabinet.weeks[0].matchweek, null, "a window has no matchweek number");
  });
});

test("a legacy single-competition league loads and scores unchanged, with no write-back", async () => {
  const store = new Map([
    // Exactly the shape live production holds: no competition, no customMix.
    ["league:OLD123", JSON.stringify({ code: "OLD123", name: "Legacy", owner: "old", createdAt: 1 })],
    ["member:OLD123:old", JSON.stringify({ nick: "Old", since: 0 })],
    ["results:PL", JSON.stringify({ "pl-2026-27-001-a-b": { status: "complete", result: [2, 1] } })],
    ["picks:pl-2026-27-001-a-b", JSON.stringify({ old: { p1: 2, p2: 1, ts: 1 } })],
  ]);
  const before = store.get("league:OLD123");
  const { env: e } = env(store);
  await withFeeds(async () => {
    await get(e)("/fixtures?competition=PL&refresh=1");
    const season = await (await get(e)("/state?code=OLD123&uid=old")).json();
    assert.deepEqual(season.competitions, ["PL"]);
    assert.equal(season.mixed, false);
    assert.equal(season.fixtureMode, "all");
    assert.equal(season.currentPeriod, "1", "official matchweeks, not windows");
    assert.equal(season.table[0].pts, 5);
    // The read must not have upgraded the stored record.
    assert.equal(store.get("league:OLD123"), before, "legacy record untouched by a read");
  });
});
