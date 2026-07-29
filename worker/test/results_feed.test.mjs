import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { FOOTBALL_DATA_TEAM_MAP, autoSettleResults, feedForCompetition, fixturesNeedingAutoSettle, mapFootballDataTeam } from "../src/results_feed.js";

function memoryKV(store = new Map()) {
  return {
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || "" };
    },
  };
}

const fixtures = [
  { id: "pl-2026-27-001-arsenal-coventry-city", player1: "Arsenal", player2: "Coventry City", startAt: "2026-08-21T20:00:00+01:00" },
  { id: "hull-mun", player1: "Hull City", player2: "Manchester United", startAt: "2026-08-22T12:30:00+01:00" },
  { id: "eve-cry", player1: "Everton", player2: "Crystal Palace", startAt: "2026-08-22T15:00:00+01:00" },
  { id: "ips-sun", player1: "Ipswich Town", player2: "Sunderland", startAt: "2026-08-22T15:00:00+01:00" },
  { id: "nfo-lee", player1: "Nottingham Forest", player2: "Leeds United", startAt: "2026-08-22T15:00:00+01:00" },
  { id: "bre-tot", player1: "Brentford", player2: "Tottenham Hotspur", startAt: "2026-08-22T17:30:00+01:00" },
  { id: "bha-avl", player1: "Brighton & Hove Albion", player2: "Aston Villa", startAt: "2026-08-23T14:00:00+01:00" },
  { id: "mci-bou", player1: "Manchester City", player2: "AFC Bournemouth", startAt: "2026-08-23T14:00:00+01:00" },
  { id: "new-liv", player1: "Newcastle United", player2: "Liverpool", startAt: "2026-08-23T16:30:00+01:00" },
  { id: "ful-che", player1: "Fulham", player2: "Chelsea", startAt: "2026-08-24T20:00:00+01:00" },
];

function footballDataMatch({ home, away, utcDate, status = "FINISHED", homeGoals = 2, awayGoals = 1 }) {
  return {
    status,
    utcDate,
    homeTeam: { name: home },
    awayTeam: { name: away },
    score: { fullTime: { home: homeGoals, away: awayGoals } },
  };
}

test("all fixture team names have football-data mappings", () => {
  const fixtureTeams = new Set(fixtures.flatMap((match) => [match.player1, match.player2]));
  assert.equal(fixtureTeams.size, 20);
  for (const team of fixtureTeams) {
    assert.equal(mapFootballDataTeam(`${team} FC`), team);
  }
  for (const target of fixtureTeams) {
    assert.ok(Object.values(FOOTBALL_DATA_TEAM_MAP).includes(target), `${target} missing from map`);
  }
});

test("recent unfinished fixtures are the only auto-settle candidates", () => {
  const now = Date.parse("2026-08-22T17:00:00+01:00");
  const matches = [
    { id: "recent", player1: "Arsenal", player2: "Coventry City", startAt: "2026-08-22T15:00:00+01:00" },
    { id: "future", player1: "Hull City", player2: "Manchester United", startAt: "2026-08-22T18:00:00+01:00" },
    { id: "old", player1: "Everton", player2: "Crystal Palace", startAt: "2026-08-22T09:00:00+01:00" },
    { id: "done", player1: "Ipswich Town", player2: "Sunderland", startAt: "2026-08-22T15:00:00+01:00", result: [1, 0] },
  ];
  assert.deepEqual(fixturesNeedingAutoSettle(matches, {}, now).map((match) => match.id), ["recent"]);
});

test("FINISHED football-data match settles from scheduled cron", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-08-21T22:30:00+01:00");
  const store = new Map([["results", JSON.stringify({})]]);
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    FOOTBALL_DATA_TOKEN: "token",
    KV: memoryKV(store),
  };
  const ctx = { waits: [], waitUntil(promise) { this.waits.push(promise); } };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://example.com/fixtures.json")) {
      return new Response(JSON.stringify({ fixtures: [fixtures[0]] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      matches: [footballDataMatch({
        home: "Arsenal FC",
        away: "Coventry City FC",
        utcDate: "2026-08-21T19:00:00Z",
        homeGoals: 3,
        awayGoals: 1,
      })],
    }), { status: 200 });
  };

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    worker.scheduled({}, env, ctx);
    await Promise.all(ctx.waits);
    assert.ok(calls.some((url) => url.includes("api.football-data.org/v4/competitions/PL/matches?season=2026")));
    const results = JSON.parse(store.get("results:PL"));
    assert.deepEqual(results["pl-2026-27-001-arsenal-coventry-city"].result, [3, 1]);
    assert.equal(results["pl-2026-27-001-arsenal-coventry-city"].status, "complete");
    assert.equal(results["pl-2026-27-001-arsenal-coventry-city"].source, "football-data");
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("in-play football-data match does not settle", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-08-21T21:30:00+01:00");
  const env = { FOOTBALL_DATA_TOKEN: "token" };
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith("https://api.football-data.org"));
    return new Response(JSON.stringify({
      matches: [footballDataMatch({
        home: "Arsenal FC",
        away: "Coventry City FC",
        utcDate: "2026-08-21T19:00:00Z",
        status: "IN_PLAY",
      })],
    }), { status: 200 });
  };
  try {
    const settled = await autoSettleResults(env, [fixtures[0]], {}, now);
    assert.equal(settled.checked, true);
    assert.equal(settled.settled, 0);
    assert.deepEqual(settled.results, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual result and void are never overwritten by auto-settle", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-08-22T17:00:00+01:00");
  const env = { FOOTBALL_DATA_TOKEN: "token" };
  globalThis.fetch = async () => new Response(JSON.stringify({
    matches: [
      footballDataMatch({ home: "Everton FC", away: "Crystal Palace FC", utcDate: "2026-08-22T14:00:00Z", homeGoals: 3, awayGoals: 0 }),
      footballDataMatch({ home: "Ipswich Town FC", away: "Sunderland AFC", utcDate: "2026-08-22T14:00:00Z", homeGoals: 2, awayGoals: 1 }),
    ],
  }), { status: 200 });
  try {
    const existing = {
      "eve-cry": { status: "complete", result: [1, 1], lockAt: "manual" },
      "ips-sun": { status: "abandoned", result: null, lockAt: "manual" },
    };
    const settled = await autoSettleResults(env, [fixtures[2], fixtures[3]], existing, now);
    assert.equal(settled.settled, 0);
    assert.deepEqual(settled.results, existing);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no football-data token is a no-op", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("football-data should not be called without a token");
  };
  try {
    const settled = await autoSettleResults({}, [fixtures[0]], {}, Date.parse("2026-08-21T22:30:00+01:00"));
    assert.equal(settled.checked, false);
    assert.equal(settled.settled, 0);
    assert.deepEqual(settled.results, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- competition-scoped settlement (v1.3) -----------------------------------

test("club names resolve only within the competition being settled", () => {
  // A Championship club is invisible to the Premier League map and vice versa,
  // so a feed name has no route into the wrong competition's fixtures.
  assert.equal(mapFootballDataTeam("Wrexham", "ELC"), "Wrexham");
  assert.equal(mapFootballDataTeam("Wrexham", "PL"), null);
  assert.equal(mapFootballDataTeam("Arsenal", "PL"), "Arsenal");
  assert.equal(mapFootballDataTeam("Arsenal", "ELC"), null);
  // Short forms and the FC/AFC suffixes both canonicalise.
  assert.equal(mapFootballDataTeam("Wolves", "ELC"), "Wolverhampton Wanderers");
  assert.equal(mapFootballDataTeam("Wolverhampton Wanderers FC", "ELC"), "Wolverhampton Wanderers");
  assert.equal(mapFootballDataTeam("West Brom", "ELC"), "West Bromwich Albion");
  assert.equal(mapFootballDataTeam("QPR", "ELC"), "Queens Park Rangers");
  assert.equal(mapFootballDataTeam("Spurs", "PL"), "Tottenham Hotspur");
  // An unknown competition resolves nothing rather than falling back to PL.
  assert.equal(mapFootballDataTeam("Arsenal", "CL"), null);
});

test("every Championship club in the fixture list is mappable", async () => {
  const { readFileSync } = await import("node:fs");
  const data = JSON.parse(readFileSync(new URL("../../data/fixtures-elc.json", import.meta.url), "utf8"));
  const clubs = [...new Set(data.fixtures.flatMap((fx) => [fx.player1, fx.player2]))];
  assert.equal(clubs.length, 24);
  for (const club of clubs) {
    assert.equal(mapFootballDataTeam(club, "ELC"), club, `unmappable: ${club}`);
  }
});

test("only competitions with a configured feed are auto-settled", () => {
  assert.ok(feedForCompetition("PL"));
  assert.equal(feedForCompetition("PL").feedCode, "PL");
  assert.ok(feedForCompetition("ELC"));
  assert.equal(feedForCompetition("ELC").feedCode, "ELC");
  // The Champions League has no feed until its draw has happened.
  assert.equal(feedForCompetition("CL"), null);
});

test("a competition without a feed settles nothing", async () => {
  const fixtures = [{ id: "cl-2026-001-a-b", player1: "A", player2: "B", startAt: new Date().toISOString() }];
  const outcome = await autoSettleResults({ FOOTBALL_DATA_TOKEN: "t" }, fixtures, {}, Date.now(), "CL");
  assert.deepEqual(outcome, { checked: false, settled: 0, results: {} });
});

test("the Championship feed is queried on its own competition path", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ matches: [] }), { status: 200 });
  };
  try {
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [{ id: "elc-2026-27-001-wrexham-burnley", player1: "Wrexham", player2: "Burnley", startAt: start }];
    await autoSettleResults({ FOOTBALL_DATA_TOKEN: "t" }, fixtures, {}, Date.now(), "ELC");
    assert.equal(seen.length, 1);
    assert.match(seen[0], /\/v4\/competitions\/ELC\/matches/);
    assert.doesNotMatch(seen[0], /competitions\/PL\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Championship result settles onto its own fixture id only", async () => {
  const originalFetch = globalThis.fetch;
  const start = new Date(Date.now() - 60 * 60 * 1000);
  globalThis.fetch = async () => new Response(JSON.stringify({
    matches: [{
      status: "FINISHED",
      utcDate: start.toISOString(),
      homeTeam: { name: "Wrexham AFC" },
      awayTeam: { name: "Burnley FC" },
      score: { fullTime: { home: 2, away: 1 } },
    }],
  }), { status: 200 });
  try {
    const fixtures = [{ id: "elc-2026-27-001-wrexham-burnley", player1: "Wrexham", player2: "Burnley", startAt: start.toISOString() }];
    const outcome = await autoSettleResults({ FOOTBALL_DATA_TOKEN: "t" }, fixtures, {}, Date.now(), "ELC");
    assert.equal(outcome.settled, 1);
    assert.deepEqual(Object.keys(outcome.results), ["elc-2026-27-001-wrexham-burnley"]);
    assert.deepEqual(outcome.results["elc-2026-27-001-wrexham-burnley"].result, [2, 1]);
    assert.ok(Object.keys(outcome.results).every((id) => id.startsWith("elc-")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
