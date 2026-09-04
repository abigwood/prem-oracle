// v1.7 Slice A — the performance budget, measured rather than asserted.
//
// The old Schedule earned its shell the hard way: a mixed league's full board
// was nine hundred cards and the shell itself did not reach the DOM until
// 2908ms on Adam's phone. Matchweek draws at most a slate, so the risk is not
// the same — but the budget still has to be a number somebody ran, not a claim.
//
// These are wall-clock on a development machine, so they are reported as
// headroom against the target rather than as a device measurement. A device
// figure needs the device; the guard here is that the synchronous work is
// bounded by the SLATE and not by the calendar.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate",
  "matchweekFixtures", "matchweekHead", "matchweekContext", "matchweekEmpty",
  "matchweekView",
  // The REAL row builder, so the measurement is of work that ships.
  "fixtureRow", "shortKickoff",
];

/** A full mixed-competition season — the board the old surface had to walk. */
const SEASON = Array.from({ length: 900 }, (_, i) => ({
  id: `fx-${String(i + 1).padStart(4, "0")}`,
  player1: `Home ${i + 1}`, player2: `Away ${i + 1}`,
  matchday: Math.floor(i / 20) + 1,
  startAt: `2026-09-${String((i % 27) + 1).padStart(2, "0")}T14:00:00Z`,
}));

const SLATE_MAX = 20;   // worker/src/logic.js SLATE_MAX

const state = (code, ids) => ({
  code, name: `${code} League`, currentPeriod: "7",
  currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ids, count: ids.length },
  table: [],
});

function box(active, states, { fixtures = SEASON } = {}) {
  return load(NAMES, {
    fixtures,
    picks: Object.fromEntries(fixtures.slice(0, 40).map((f) => [f.id, { p1: 1, p2: 0 }])),
    activeLeague: active,
    leagueState: states[active] || null,
    leagueStates: states,
    leagueCodes: Object.keys(states),
    leagueNames: {},
    expandedFixtureId: null,
    periodLabel: (p) => `Matchweek ${p}`,
    pulsingStatus: (m) => m,
    onboardingState: () => "",
    leagueSwitcher: () => "",
    // Only reached for an EXPANDED row, and nothing is expanded here — the
    // heavy card is Slice B's problem, not the shell's.
    matchCard: () => "<div class=match-card></div>",
  });
}

/** Median of repeated runs — one sample on a shared machine is noise. */
function median(runs, fn) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

test("P1 · the maximum slate builds well inside the 50ms synchronous budget", () => {
  const ids = SEASON.slice(0, SLATE_MAX).map((f) => f.id);
  const s = box("AAA", { AAA: state("AAA", ids) });
  // Warm, then measure.
  s.matchweekView();
  const ms = median(21, () => s.matchweekView());
  console.log(`    max slate (${SLATE_MAX} fixtures, ${SEASON.length}-fixture calendar): ${ms.toFixed(2)}ms`);
  assert.ok(ms < 50, `${ms.toFixed(2)}ms exceeds the 50ms synchronous budget`);
});

test("P1 · cost tracks the SLATE, not the calendar behind it", () => {
  // The whole point of the change: a 900-fixture board and a 90-fixture board
  // cost the same, because neither is walked.
  const ids = SEASON.slice(0, SLATE_MAX).map((f) => f.id);
  const big = box("AAA", { AAA: state("AAA", ids) }, { fixtures: SEASON });
  const small = box("AAA", { AAA: state("AAA", ids) }, { fixtures: SEASON.slice(0, 90) });
  big.matchweekView(); small.matchweekView();
  const bigMs = median(21, () => big.matchweekView());
  const smallMs = median(21, () => small.matchweekView());
  console.log(`    900-fixture calendar ${bigMs.toFixed(2)}ms · 90-fixture calendar ${smallMs.toFixed(2)}ms`);
  // Generous bound: the point is "no calendar-sized term", not a micro-benchmark.
  assert.ok(bigMs < Math.max(smallMs * 6, 5),
    `a ten-fold calendar cost ${(bigMs / (smallMs || 1e-6)).toFixed(1)}x — the calendar is being walked`);
});

test("P2 · a league switch with a valid cache paints inside 250ms", () => {
  // The switch itself is synchronous: setActiveLeague hydrates from cache and
  // renders on the tap. What is measured here is that paint.
  const aaa = state("AAA", SEASON.slice(0, SLATE_MAX).map((f) => f.id));
  const bbb = state("BBB", SEASON.slice(40, 46).map((f) => f.id));
  const s = box("BBB", { AAA: aaa, BBB: bbb });
  s.matchweekView();
  const ms = median(21, () => s.matchweekView());
  console.log(`    cached-league paint: ${ms.toFixed(2)}ms`);
  assert.ok(ms < 250, `${ms.toFixed(2)}ms exceeds the 250ms retained-content target`);
});

test("P3 · the acknowledged shell costs nothing to build", () => {
  // No valid state for the selected league: the shell must be cheap, because
  // it is what answers the tap while the network runs.
  const s = box("CCC", { AAA: state("AAA", SEASON.slice(0, SLATE_MAX).map((f) => f.id)) });
  s.matchweekView();
  const ms = median(21, () => s.matchweekView());
  console.log(`    acknowledged shell: ${ms.toFixed(3)}ms`);
  assert.ok(ms < 5, `${ms.toFixed(2)}ms is too slow for a shell`);
  // And it really is the shell, not the league we left.
  assert.ok(!s.matchweekView().includes("AAA League"));
});

test("P4 · the empty state is cheaper still, and draws no cards", () => {
  const s = box("AAA", { AAA: state("AAA", []) });
  s.matchweekView();
  const ms = median(21, () => s.matchweekView());
  console.log(`    empty state: ${ms.toFixed(3)}ms`);
  assert.ok(ms < 5);
  assert.equal((s.matchweekView().match(/data-fixture-row=/g) || []).length, 0);
});
