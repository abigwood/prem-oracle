// The settlement catch-up.
//
// Auto-settlement used to stop considering a fixture six hours after kick-off,
// with no path back. One missed run then held a league period open forever:
// roundComplete needs every fixture settled or void, and `postponed` is not
// void. Bury Legends (JJ38BD) sat on Week 4 with Week 5 already published,
// blocked on elc-2026-27-058-swansea-city-wrexham — 68 hours past kick-off and
// permanently outside the window.
//
// These tests hold the catch-up to its bounds as firmly as they hold it to its
// job: it must find the missed fixture, and it must not turn one run into a
// season scan or a second call on the official feed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  autoSettleResults, catchUpDue, catchUpPage, fixturesNeedingAutoSettle, footballDataResults,
  mapFootballDataTeam, planAutoSettle, CATCH_UP_LIMIT, CATCH_UP_INTERVAL_MS,
} from "../src/results_feed.js";
import { earliestUnplayedPeriod, roundComplete, roundStatus } from "../src/logic.js";
import { comparePeriods, windowKeyFor } from "../src/competitions.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A catch-up tick, so the widened path is the one under test unless a test
// deliberately picks an ordinary one.
const CATCH_UP_TICK = Date.parse("2026-09-08T11:00:00Z");
const ORDINARY_TICK = Date.parse("2026-09-08T11:20:00Z");

const at = (nowMs, hoursAgo) => new Date(nowMs - hoursAgo * HOUR).toISOString();
const fx = (id, o = {}) => ({
  id, player1: o.h || "Swansea City", player2: o.a || "Wrexham",
  startAt: o.startAt, ...(o.status ? { status: o.status } : {}), ...(o.result ? { result: o.result } : {}),
});

/** One feed fetch, counted, with whatever payload the test wants back. */
function provider(matches, { status = 200, body = null } = {}) {
  const calls = [];
  const env = {
    FOOTBALL_DATA_TOKEN: "test-token",
    // The module calls global fetch; the test swaps it for the duration.
    __calls: calls,
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (body ?? { matches }) };
  };
  return { env, calls, restore: () => { globalThis.fetch = original; } };
}

/** A football-data entry, in the shape the production mapping consumes. */
const feedMatch = (home, away, utcDate, h, a, status = "FINISHED") => ({
  status, utcDate,
  homeTeam: { name: home }, awayTeam: { name: away },
  score: { fullTime: { home: h, away: a } },
});

// --- the bound on how often it runs ---------------------------------------

test("S1 · the catch-up rides one tick an hour, and the fast path every tick", () => {
  assert.equal(catchUpDue(Date.parse("2026-09-08T11:00:00Z")), true, "the top of the hour");
  assert.equal(catchUpDue(Date.parse("2026-09-08T11:14:59Z")), true, "still the first cron tick");
  assert.equal(catchUpDue(Date.parse("2026-09-08T11:15:00Z")), false);
  assert.equal(catchUpDue(Date.parse("2026-09-08T11:30:00Z")), false);
  assert.equal(catchUpDue(Date.parse("2026-09-08T11:45:00Z")), false);
  assert.equal(catchUpDue(NaN), false, "an unusable clock must not trigger work");
  // One in four ticks of a */15 cron, so 24 catch-up passes a day.
  let due = 0;
  for (let t = 0; t < 96; t += 1) due += catchUpDue(Date.parse("2026-09-08T00:00:00Z") + t * 15 * 60 * 1000) ? 1 : 0;
  assert.equal(due, 24, `${due} catch-up ticks in a day`);
  assert.equal(CATCH_UP_INTERVAL_MS, HOUR);
});

test("S1 · cron drift does not switch the catch-up off", () => {
  // Cloudflare fires at or after the scheduled minute, never before, so the
  // tolerance that matters is lateness. Anything up to a whole cron period
  // late still lands in the hour's first slot.
  for (const late of ["11:00:00", "11:00:31", "11:02:00", "11:09:44", "11:14:58"]) {
    assert.equal(catchUpDue(Date.parse(`2026-09-08T${late}Z`)), true, `${late} was refused`);
  }
  // A missed hour is not a stuck fixture: eligibility never expires, so the
  // next hour's tick finds it.
  assert.equal(CATCH_UP_INTERVAL_MS, HOUR);
});

// --- what one run will look at --------------------------------------------

test("S2 · a fixture missed at seven hours is picked up, and only on a catch-up tick", () => {
  const now = CATCH_UP_TICK;
  const list = [fx("missed", { startAt: at(now, 7) })];
  assert.deepEqual(fixturesNeedingAutoSettle(list, {}, now, { catchUp: false }).map((m) => m.id), [],
    "the ordinary path reached past six hours");
  assert.deepEqual(fixturesNeedingAutoSettle(list, {}, now, { catchUp: true }).map((m) => m.id), ["missed"]);
});

test("S2 · the real 68-hour shape: Swansea City v Wrexham is reachable again", () => {
  const now = Date.parse("2026-09-08T11:00:00Z");
  const swansea = fx("elc-2026-27-058-swansea-city-wrexham", { startAt: "2026-09-05T15:00:00+01:00" });
  const age = (now - Date.parse(swansea.startAt)) / HOUR;
  assert.ok(age > 60 && age < 80, `the fixture is ${age.toFixed(1)}h old in this test`);
  assert.deepEqual(fixturesNeedingAutoSettle([swansea], {}, now, { catchUp: false }).map((m) => m.id), [],
    "the old rule would still be reaching it, so this test proves nothing");
  assert.deepEqual(fixturesNeedingAutoSettle([swansea], {}, now, { catchUp: true }).map((m) => m.id),
    ["elc-2026-27-058-swansea-city-wrexham"]);
});

test("S2 · the fast path is untouched by the correction", () => {
  const now = ORDINARY_TICK;
  const list = [fx("just-now", { startAt: at(now, 2) }), fx("stale", { startAt: at(now, 30) })];
  assert.deepEqual(fixturesNeedingAutoSettle(list, {}, now).map((m) => m.id), ["just-now"],
    "the default is still the recent window");
  // And a catch-up tick keeps the recent one as well as adding the stale one.
  const both = fixturesNeedingAutoSettle(list, {}, now, { catchUp: true }).map((m) => m.id);
  assert.deepEqual(both.sort(), ["just-now", "stale"]);
});

test("S3 · one run carries at most one page of twenty, in oldest-first order", () => {
  const now = CATCH_UP_TICK;
  const total = CATCH_UP_LIMIT + 12;
  const many = Array.from({ length: total }, (_, i) =>
    fx(`stale-${String(i).padStart(2, "0")}`, { startAt: at(now, 8 + i) }));
  const plan = planAutoSettle(many, {}, now, { catchUp: true });
  assert.equal(plan.eligible, total);
  assert.equal(plan.pages, Math.ceil(total / CATCH_UP_LIMIT));
  assert.ok(plan.considered <= CATCH_UP_LIMIT, `${plan.considered} carried, cap is ${CATCH_UP_LIMIT}`);
  assert.equal(plan.considered, Math.min(CATCH_UP_LIMIT, total - plan.page * CATCH_UP_LIMIT),
    "the page did not carry what that page holds");
  // The queue is oldest first, so page 0 starts at the oldest fixture.
  const zeroHour = now - (now % (CATCH_UP_INTERVAL_MS * plan.pages));
  const first = planAutoSettle(many, {}, zeroHour, { catchUp: true });
  assert.equal(first.page, 0);
  assert.equal(first.fixtures[0].id, `stale-${String(total - 1).padStart(2, "0")}`,
    "page 0 does not begin at the oldest unresolved fixture");
  const ages = first.fixtures.map((m) => zeroHour - Date.parse(m.startAt));
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a), "the page is not in oldest-first order");
});

test("S3 · there is no age ceiling: a fixture is eligible for as long as it is unresolved", () => {
  const now = CATCH_UP_TICK;
  // Sol's correction: a fortnight's ceiling only moved the point of permanent
  // abandonment. Nothing is ever aged out.
  const list = [
    fx("a-day", { startAt: at(now, 24) }),
    fx("a-fortnight-and-an-hour", { startAt: at(now, 24 * 14 + 1) }),
    fx("three-months", { startAt: at(now, 24 * 90) }),
    fx("a-whole-season", { startAt: at(now, 24 * 300) }),
  ];
  const taken = fixturesNeedingAutoSettle(list, {}, now, { catchUp: true }).map((m) => m.id);
  assert.deepEqual(taken.sort(), ["a-day", "a-fortnight-and-an-hour", "a-whole-season", "three-months"],
    "a fixture was aged out of eligibility");
  // The season the caller passes in is the only horizon there is.
  const plan = planAutoSettle(list, {}, now, { catchUp: true });
  assert.equal(plan.eligible, 4);
});

test("S4 · settled, void, postponed and future fixtures are treated correctly", () => {
  const now = CATCH_UP_TICK;
  const list = [
    fx("settled-on-fixture", { startAt: at(now, 20), result: [1, 0] }),
    fx("void-abandoned", { startAt: at(now, 20), status: "abandoned" }),
    fx("void-cancelled", { startAt: at(now, 20), status: "cancelled" }),
    fx("postponed", { startAt: at(now, 20), status: "postponed" }),
    fx("future", { startAt: new Date(now + 5 * HOUR).toISOString() }),
    fx("genuinely-missed", { startAt: at(now, 20) }),
  ];
  const taken = fixturesNeedingAutoSettle(list, {}, now, { catchUp: true }).map((m) => m.id);
  // A postponed fixture is NOT void, so it is exactly the kind that holds a
  // period open — it must stay eligible until it is replayed or resolved.
  assert.deepEqual(taken.sort(), ["genuinely-missed", "postponed"]);
  assert.ok(!taken.includes("future"), "a fixture still to be played was considered");
});

test("S4 · a result already in the overlay is never worked on again", () => {
  const now = CATCH_UP_TICK;
  const list = [fx("done", { startAt: at(now, 20) }), fx("open", { startAt: at(now, 20) })];
  const overlay = { done: { status: "complete", result: [2, 2] } };
  assert.deepEqual(fixturesNeedingAutoSettle(list, overlay, now, { catchUp: true }).map((m) => m.id), ["open"]);
  const voidedOverlay = { done: { status: "abandoned" } };
  assert.deepEqual(fixturesNeedingAutoSettle(list, voidedOverlay, now, { catchUp: true }).map((m) => m.id), ["open"]);
});

// --- the official feed -----------------------------------------------------

test("S5 · one feed call per run, catch-up or not", async () => {
  const now = CATCH_UP_TICK;
  const list = Array.from({ length: 25 }, (_, i) => fx(`s${i}`, { startAt: at(now, 8 + i), h: "Swansea City", a: "Wrexham" }));
  const p = provider([]);
  try {
    const out = await autoSettleResults(p.env, list, {}, now, "ELC");
    assert.equal(p.calls.length, 1, `${p.calls.length} feed calls for one run`);
    assert.equal(out.diagnostics.catchUp, true);
    assert.equal(out.diagnostics.eligible, 25);
    assert.ok(out.diagnostics.considered <= CATCH_UP_LIMIT, "the run carried more than its bound");
    assert.ok(out.diagnostics.pages >= 2, "25 stale fixtures should need more than one page");
  } finally { p.restore(); }
});

test("S5 · nothing pending means no feed call at all", async () => {
  const now = CATCH_UP_TICK;
  const p = provider([]);
  try {
    const out = await autoSettleResults(p.env, [fx("future", { startAt: new Date(now + HOUR).toISOString() })], {}, now, "ELC");
    assert.equal(p.calls.length, 0, "the feed was called with nothing to settle");
    assert.equal(out.checked, false);
    assert.equal(out.settled, 0);
  } finally { p.restore(); }
});

test("S5 · a provider failure settles nothing, keeps the overlay, and says why", async () => {
  const now = CATCH_UP_TICK;
  const list = [fx("elc-2026-27-058-swansea-city-wrexham", { startAt: "2026-09-05T15:00:00+01:00" })];
  const before = { other: { status: "complete", result: [1, 1] } };
  for (const status of [500, 502, 403]) {
    const p = provider([], { status });
    try {
      const out = await autoSettleResults(p.env, list, before, now, "ELC");
      assert.equal(out.settled, 0, `HTTP ${status} settled something`);
      assert.deepEqual(out.results, before, `HTTP ${status} altered the overlay`);
      assert.match(out.diagnostics.providerError, new RegExp(String(status)),
        `HTTP ${status} was not reported`);
      // The page it was working on is still reported, so the next run's page
      // is calculable from the log rather than guessed.
      assert.equal(out.diagnostics.considered, 1);
      assert.deepEqual(out.diagnostics.consideredIds, ["elc-2026-27-058-swansea-city-wrexham"]);
    } finally { p.restore(); }
  }
  assert.deepEqual(before, { other: { status: "complete", result: [1, 1] } });
});

test("S5 · rate limiting is reported, and the same page is retried next hour", async () => {
  const now = CATCH_UP_TICK;
  const list = [fx("swa-wre", { startAt: at(now, 68) })];
  const p = provider([], { status: 429 });
  try {
    const out = await autoSettleResults(p.env, list, {}, now, "ELC");
    assert.equal(out.settled, 0);
    assert.match(out.diagnostics.providerError, /429/);
  } finally { p.restore(); }
  // Nothing was written, so the fixture is still eligible on the next run.
  assert.equal(planAutoSettle(list, {}, now + HOUR, { catchUp: true }).eligible, 1);
});

test("S5 · a partial or malformed payload settles nothing", async () => {
  const now = CATCH_UP_TICK;
  const list = [fx("swa-wre", { startAt: at(now, 68) })];
  for (const body of [{}, { matches: null }, { matches: "nope" }]) {
    const p = provider([], { body });
    try {
      const out = await autoSettleResults(p.env, list, {}, now, "ELC");
      assert.equal(out.settled, 0, `a payload of ${JSON.stringify(body)} settled something`);
    } finally { p.restore(); }
  }
});

// --- name matching ---------------------------------------------------------

test("S6 · alias and canonical club names both resolve", () => {
  for (const name of ["Wrexham", "Wrexham AFC", "AFC Wrexham"]) {
    assert.equal(mapFootballDataTeam(name, "ELC"), "Wrexham", `${name} did not resolve`);
  }
  for (const name of ["Swansea City", "Swansea", "Swansea City AFC"]) {
    assert.equal(mapFootballDataTeam(name, "ELC"), "Swansea City", `${name} did not resolve`);
  }
  // A club of another competition cannot be matched into this one.
  assert.equal(mapFootballDataTeam("Arsenal", "ELC"), null);
  assert.equal(mapFootballDataTeam("Wrexham", "PL"), null);
});

test("S6 · a fixture two feed entries disagree about is left alone", async () => {
  const now = CATCH_UP_TICK;
  const list = [fx("swa-wre", { startAt: "2026-09-05T15:00:00+01:00" })];
  const p = provider([
    feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0),
    feedMatch("Swansea City AFC", "Wrexham AFC", "2026-09-05T14:00:00Z", 2, 1),
  ]);
  try {
    const out = await footballDataResults(p.env, list, "ELC");
    assert.deepEqual(out, {}, "a disputed score was written anyway");
  } finally { p.restore(); }
});

test("S6 · two of our fixtures sharing a key settle neither", async () => {
  const list = [
    { id: "one", player1: "Swansea City", player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" },
    { id: "two", player1: "Swansea City", player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" },
  ];
  const p = provider([feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)]);
  try {
    assert.deepEqual(await footballDataResults(p.env, list, "ELC"), {},
      "a score was guessed onto one of two indistinguishable fixtures");
  } finally { p.restore(); }
});

// --- the fixture that started this ------------------------------------------

test("S7 · the production mapping turns the reported 0-0 into this fixture's result", async () => {
  const swansea = {
    id: "elc-2026-27-058-swansea-city-wrexham",
    player1: "Swansea City", player2: "Wrexham",
    startAt: "2026-09-05T15:00:00+01:00",
  };
  const p = provider([
    feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0),
    feedMatch("Bristol City", "Millwall", "2026-09-05T14:00:00Z", 3, 1),   // unrelated, ignored
  ]);
  try {
    const out = await footballDataResults(p.env, [swansea], "ELC");
    assert.deepEqual(out["elc-2026-27-058-swansea-city-wrexham"]?.result, [0, 0],
      "the reported 0-0 did not reach the fixture");
    assert.equal(out["elc-2026-27-058-swansea-city-wrexham"].status, "complete");
    assert.equal(out["elc-2026-27-058-swansea-city-wrexham"].source, "football-data");
    assert.equal(Object.keys(out).length, 1, "an unrelated fixture was settled too");
  } finally { p.restore(); }
});

test("S7 · a run at 68 hours settles it, and never overwrites an authoritative one", async () => {
  const now = Date.parse("2026-09-08T11:00:00Z");
  const swansea = { id: "elc-2026-27-058-swansea-city-wrexham", player1: "Swansea City",
    player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" };
  const p = provider([feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)]);
  try {
    const out = await autoSettleResults(p.env, [swansea], {}, now, "ELC");
    assert.equal(out.checked, true);
    assert.equal(out.settled, 1);
    assert.deepEqual(out.results[swansea.id].result, [0, 0]);
  } finally { p.restore(); }
  // An existing authoritative result is never replaced, whatever the feed says.
  const held = { [swansea.id]: { status: "complete", result: [3, 3], source: "manual" } };
  const q = provider([feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)]);
  try {
    const out = await autoSettleResults(q.env, [swansea], held, now, "ELC");
    assert.equal(out.settled, 0, "an authoritative result was overwritten");
    assert.deepEqual(out.results[swansea.id].result, [3, 3]);
    assert.equal(q.calls.length, 0, "the feed was called for a fixture already settled");
  } finally { q.restore(); }
});

test("S8 · repeated runs are idempotent and stop asking", async () => {
  const now = Date.parse("2026-09-08T11:00:00Z");
  const swansea = { id: "elc-2026-27-058-swansea-city-wrexham", player1: "Swansea City",
    player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" };
  const feed = [feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)];
  let overlay = {};
  let totalCalls = 0;
  for (let run = 0; run < 4; run += 1) {
    const p = provider(feed);
    try {
      const out = await autoSettleResults(p.env, [swansea], overlay, now, "ELC");
      overlay = out.results;
      totalCalls += p.calls.length;
      assert.equal(out.settled, run === 0 ? 1 : 0, `run ${run + 1} settled ${out.settled}`);
    } finally { p.restore(); }
  }
  assert.deepEqual(overlay[swansea.id].result, [0, 0]);
  assert.equal(totalCalls, 1, `${totalCalls} feed calls across four runs — the first should be the only one`);
});

// --- and the league moves on -----------------------------------------------

test("S9 · Bury Legends advances to Week 5 once Week 4 is terminal", () => {
  // The published Week 4 slate, as production holds it, in its own window.
  const W4 = "w2026-09-01", W5 = "w2026-09-08";
  const week4 = [
    { id: "elc-2026-27-058-swansea-city-wrexham", period: W4, startAt: "2026-09-05T15:00:00+01:00" },
    { id: "pl-2026-27-024-brighton-hove-albion-leeds-united", period: W4, result: [1, 1] },
    { id: "pl-2026-27-027-nottingham-forest-tottenham-hotspur", period: W4, result: [2, 0] },
    { id: "pl-2026-27-028-hull-city-aston-villa", period: W4, result: [0, 3] },
    { id: "pl-2026-27-029-everton-manchester-united", period: W4, result: [1, 2] },
    { id: "pl-2026-27-030-arsenal-chelsea", period: W4, result: [2, 2] },
  ];
  const week5 = [
    { id: "elc-2026-27-061-blackburn-rovers-sheffield-united", period: W5 },
    { id: "pl-2026-27-035-liverpool-fulham", period: W5 },
  ];
  const all = [...week4, ...week5];

  // Before: one unresolved fixture pins the league to Week 4, however many
  // later weeks the host has published.
  assert.equal(roundComplete(week4), false);
  assert.equal(roundStatus(week4), "in progress");
  assert.equal(earliestUnplayedPeriod(all, comparePeriods), W4,
    "the league was not pinned to Week 4 to begin with");

  // After the catch-up settles it 0-0.
  const settled = all.map((m) => (m.id === "elc-2026-27-058-swansea-city-wrexham"
    ? { ...m, result: [0, 0] } : m));
  const week4After = settled.filter((m) => m.period === W4);
  assert.equal(roundComplete(week4After), true, "Week 4 is still not complete");
  assert.equal(roundStatus(week4After), "complete");
  assert.equal(earliestUnplayedPeriod(settled, comparePeriods), W5,
    "the league did not advance to Week 5");
});

test("S9 · the fixture really does sit in the window the league is stuck on", () => {
  assert.equal(windowKeyFor("2026-09-05T15:00:00+01:00"), "w2026-09-01");
  assert.equal(windowKeyFor("2026-09-08T11:00:00Z"), "w2026-09-08");
});

// --- Sol's correction: rotation, not an age ceiling -------------------------
//
// A fortnight's ceiling only moved the point of permanent abandonment. What
// replaces it is a deterministic rotation, and these are the properties that
// have to hold for that to be a real guarantee rather than a nicer number.

test("R1 · the page advances by one an hour and wraps deterministically", () => {
  const base = Date.parse("2026-09-08T00:00:00Z");
  const pages = 4;
  const seen = [];
  for (let h = 0; h < 9; h += 1) seen.push(catchUpPage(base + h * HOUR, pages));
  assert.deepEqual(seen, [0, 1, 2, 3, 0, 1, 2, 3, 0], "the rotation is not a clean wrap");
  // The same clock always gives the same page, on any instance, with nothing
  // stored — two workers cannot disagree about whose turn it is.
  assert.equal(catchUpPage(base + 5 * HOUR, pages), catchUpPage(base + 5 * HOUR, pages));
  assert.equal(catchUpPage(base, 0), 0, "no pages must not divide by zero");
  assert.equal(catchUpPage(base, 1), 0);
});

test("R2 · an unmatchable oldest fixture cannot starve the ones behind it", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  // One fixture the provider will never match, sitting at the head of the
  // queue because it is the oldest, plus a page and a half behind it.
  const cursed = fx("cursed-oldest", { startAt: at(now, 24 * 200) });
  const rest = Array.from({ length: CATCH_UP_LIMIT + 5 }, (_, i) =>
    fx(`later-${String(i).padStart(2, "0")}`, { startAt: at(now, 10 + i) }));
  const all = [cursed, ...rest];

  const reached = new Set();
  const pages = planAutoSettle(all, {}, now, { catchUp: true }).pages;
  for (let h = 0; h < pages; h += 1) {
    for (const m of planAutoSettle(all, {}, now + h * HOUR, { catchUp: true }).fixtures) reached.add(m.id);
  }
  assert.equal(reached.size, all.length, "some fixtures were never reached");
  assert.ok(reached.has("cursed-oldest"));
  assert.ok(reached.has(`later-${String(CATCH_UP_LIMIT + 4).padStart(2, "0")}`),
    "the newest unresolved fixture was starved by the oldest");
});

test("R3 · every unresolved fixture is considered within ceil(N/20) hourly runs", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  for (const N of [1, 19, 20, 21, 45, 100, 380]) {
    const all = Array.from({ length: N }, (_, i) =>
      fx(`f-${String(i).padStart(3, "0")}`, { startAt: at(now, 8 + i) }));
    const bound = Math.ceil(N / CATCH_UP_LIMIT);
    const reached = new Set();
    for (let h = 0; h < bound; h += 1) {
      for (const m of planAutoSettle(all, {}, now + h * HOUR, { catchUp: true }).fixtures) reached.add(m.id);
    }
    assert.equal(reached.size, N,
      `N=${N}: ${reached.size} of ${N} reached in the calculable bound of ${bound} run(s)`);
  }
});

test("R3 · the bound is reported, so an operator can calculate the wait", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const all = Array.from({ length: 45 }, (_, i) => fx(`f-${i}`, { startAt: at(now, 8 + i) }));
  const plan = planAutoSettle(all, {}, now, { catchUp: true });
  assert.equal(plan.eligible, 45);
  assert.equal(plan.pages, 3, "45 stale fixtures is three pages of twenty");
  // Longest wait for any one fixture = pages hours.
  assert.equal(plan.pages * (CATCH_UP_INTERVAL_MS / HOUR), 3);
});

test("R4 · a page that settles shrinks the queue without stranding anyone", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const all = Array.from({ length: 30 }, (_, i) => fx(`f-${String(i).padStart(2, "0")}`, { startAt: at(now, 8 + i) }));
  // Settle whatever the first two hours reach, then check the rest still get a turn.
  const overlay = {};
  for (let h = 0; h < 2; h += 1) {
    for (const m of planAutoSettle(all, overlay, now + h * HOUR, { catchUp: true }).fixtures) {
      overlay[m.id] = { status: "complete", result: [0, 0] };
    }
  }
  const left = planAutoSettle(all, overlay, now + 2 * HOUR, { catchUp: true });
  const remaining = all.filter((m) => !overlay[m.id]).map((m) => m.id);
  assert.equal(left.eligible, remaining.length);
  const reached = new Set();
  for (let h = 2; h < 2 + Math.max(1, left.pages); h += 1) {
    for (const m of planAutoSettle(all, overlay, now + h * HOUR, { catchUp: true }).fixtures) reached.add(m.id);
  }
  for (const id of remaining) assert.ok(reached.has(id), `${id} was stranded after the queue shrank`);
});

test("R5 · provider failure then recovery: the same fixture is settled next hour", async () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const swansea = { id: "elc-2026-27-058-swansea-city-wrexham", player1: "Swansea City",
    player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" };
  const good = [feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)];

  const down = provider([], { status: 503 });
  let overlay = {};
  try {
    const out = await autoSettleResults(down.env, [swansea], overlay, now, "ELC");
    assert.equal(out.settled, 0);
    assert.match(out.diagnostics.providerError, /503/);
    overlay = out.results;
  } finally { down.restore(); }
  assert.deepEqual(overlay, {}, "a failed run wrote something");

  const back = provider(good);
  try {
    const out = await autoSettleResults(back.env, [swansea], overlay, now + HOUR, "ELC");
    assert.equal(out.settled, 1, "recovery did not settle the fixture");
    assert.deepEqual(out.results[swansea.id].result, [0, 0]);
    assert.equal(out.diagnostics.providerError, null);
    assert.equal(back.calls.length, 1);
  } finally { back.restore(); }
});

test("R6 · the diagnostics carry everything the review asked for", async () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const all = Array.from({ length: 25 }, (_, i) =>
    fx(`f-${String(i).padStart(2, "0")}`, { startAt: at(now, 8 + i), h: "Swansea City", a: "Wrexham" }));
  const p = provider([]);
  try {
    const out = await autoSettleResults(p.env, all, {}, now, "ELC");
    const d = out.diagnostics;
    for (const key of ["competition", "catchUp", "eligible", "pages", "page", "considered",
                       "consideredIds", "settled", "providerError"]) {
      assert.ok(key in d, `the diagnostics have no ${key}`);
    }
    assert.equal(d.competition, "ELC");
    assert.equal(d.catchUp, true);
    assert.equal(d.eligible, 25);
    assert.equal(d.pages, 2);
    assert.ok(d.page === 0 || d.page === 1);
    assert.equal(d.considered, d.consideredIds.length);
    assert.equal(d.settled, 0);
    assert.equal(d.providerError, null);
  } finally { p.restore(); }
  // And the worker records them whether or not anything was written.
  const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(src, /if \(settled\.diagnostics\) outcomes\.push\(\{ competition, \.\.\.settled\.diagnostics \}\);/);
  assert.ok(src.indexOf("outcomes.push({ competition, ...settled.diagnostics })")
    < src.indexOf("if (!settled.checked || settled.settled === 0) continue;"),
    "the diagnostics are recorded only when something was written");
});

test("R7 · idempotent across a full rotation, one request per run", async () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const swansea = { id: "elc-2026-27-058-swansea-city-wrexham", player1: "Swansea City",
    player2: "Wrexham", startAt: "2026-09-05T15:00:00+01:00" };
  const others = Array.from({ length: 24 }, (_, i) =>
    ({ id: `elc-filler-${i}`, player1: "Bristol City", player2: "Millwall",
       startAt: at(now, 20 + i) }));
  const all = [swansea, ...others];
  const feed = [feedMatch("Swansea City", "Wrexham", "2026-09-05T14:00:00Z", 0, 0)];
  let overlay = {};
  let settledTotal = 0;
  let calls = 0;
  const pages = planAutoSettle(all, {}, now, { catchUp: true }).pages;
  for (let h = 0; h < pages + 2; h += 1) {
    const p = provider(feed);
    try {
      const out = await autoSettleResults(p.env, all, overlay, now + h * HOUR, "ELC");
      overlay = out.results;
      settledTotal += out.settled;
      calls += p.calls.length;
      assert.ok(p.calls.length <= 1, "a run made more than one request");
    } finally { p.restore(); }
  }
  assert.equal(settledTotal, 1, `the fixture was settled ${settledTotal} times`);
  assert.deepEqual(overlay[swansea.id].result, [0, 0]);
  assert.ok(calls <= pages + 2, `${calls} requests across ${pages + 2} runs`);
});
