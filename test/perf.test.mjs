// v1.6.6 executed worst shapes. These build the real markup the app builds and
// time it, rather than asserting that it looks cheap.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const SYNC_BUDGET_MS = 50;

/** Rough DOM cost of a markup string: every element start tag. */
const tagCount = (html) => (html.match(/<[a-zA-Z]/g) || []).length;

const fixture = (league, week, n) => ({
  id: `${league}-${week}-${n}`,
  player1: `Home ${n}`, player2: `Away ${n}`,
  matchday: week,
  startAt: `2026-${String((week % 12) + 1).padStart(2, "0")}-1${n % 9}T14:00:00Z`,
  result: [n % 5, (n + 2) % 5],
  status: "finished",
});

/** A full season of picks for one league: 38 weeks x 10 fixtures. */
function season(code, weeks = 38, per = 10) {
  const list = [];
  for (let w = 1; w <= weeks; w++) for (let n = 0; n < per; n++) list.push(fixture(code, w, n));
  return list;
}

const NAMES = ["pickWeekKey", "pickWeekSummary", "pickWeekRow", "currentPickPeriod",
  "isCurrentPickWeek", "pickWeekGroups", "pickSection", "pickEntry", "matchCard",
  "resultCard", "resultState", "resultBadge", "resultPickLine", "finalScore",
  "scorePickLocal", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "RESULT_FIRST_STATES", "isSettledCard", "matchOpen", "scorePicker", "pickStatus",
  "resultText", "comparePeriods", "isWindowKey", "sharedLeagueNote"];

function harness(leagues) {
  const all = leagues.flatMap(([code]) => season(code));
  const picks = Object.fromEntries(all.map((f) => [f.id, { p1: 1, p2: 1 }]));
  const s = load(NAMES, {
    picks,
    fixtures: all,
    leagueCodes: leagues.map(([code]) => code),
    leagueState: { code: leagues[0][0], currentPeriod: 38, cabinet: { weeks: [] } },
    leagueStates: Object.fromEntries(leagues.map(([code]) => [code, {
      code, currentPeriod: 38,
      cabinet: { weeks: Array.from({ length: 37 }, (_, i) => ({ period: i + 1, pts: 12, place: i % 5 === 0 ? "gold" : null })) },
    }])),
    openPickWeeks: new Set(),
    PLACE_EMOJI: { gold: "🏆", silver: "🥈", bronze: "🥉" },
    collapsedPickSections: new Set(),
    countBusy: false,
    busyMatch: null,
    weekDateRange: (p) => `Week ${p}`,
    windowKeyFor: () => null,
    calendarLink: () => ({ href: "", download: "" }),
    matchIntelStrip: () => "",
    probabilityStrip: () => "",
    formGuide: () => "",
    matchTime: () => "15:00",
    teamBadge: () => "<i></i>",
    closedStatus: () => false,
    isMixedActive: () => false,
    escapeHTML: (v) => String(v ?? ""),
  });
  return { s, all };
}

test("FULL-SEASON My Picks: 38 folded weeks across 3 leagues", () => {
  const leagues = [["AAA"], ["BBB"], ["CCC"]];
  const { s, all } = harness(leagues);
  const contexts = leagues.map(([code]) => ({
    code, name: code,
    lineup: new Set(all.filter((f) => f.id.startsWith(code)).map((f) => String(f.id))),
    dropped: new Set(),
  }));

  let html = "";
  let worstSection = 0;
  const t0 = performance.now();
  for (const league of contexts) {
    const mine = all.filter((f) => league.lineup.has(String(f.id)));
    const groups = s.pickWeekGroups(mine, false);
    const t = performance.now();
    html += s.pickSection(league.name, null, groups, contexts, league.code);
    worstSection = Math.max(worstSection, performance.now() - t);
  }
  const initialMs = performance.now() - t0;

  const rows = (html.match(/data-lazy-week=/g) || []).length;
  const cards = (html.match(/class="match-card/g) || []).length;

  console.log(`  [worst shape] 3 leagues x 38 weeks x 10 fixtures = ${all.length} picks`);
  console.log(`  initial synchronous build : ${initialMs.toFixed(1)}ms (worst single section ${worstSection.toFixed(1)}ms)`);
  console.log(`  generated characters      : ${html.length.toLocaleString()}`);
  console.log(`  element start tags        : ${tagCount(html).toLocaleString()}`);
  console.log(`  folded summary rows       : ${rows}`);
  console.log(`  result cards built        : ${cards}`);

  // 3 leagues x 37 past weeks folded, 1 current week open each.
  assert.equal(rows, 111, "a past week was built instead of folded");
  assert.equal(cards, 30, "more than the three current weeks were built");
  assert.ok(worstSection < SYNC_BUDGET_MS,
    `a single section took ${worstSection.toFixed(1)}ms, over the ${SYNC_BUDGET_MS}ms budget`);
  assert.ok(initialMs < SYNC_BUDGET_MS * 3,
    `initial build took ${initialMs.toFixed(1)}ms`);
});

test("FULL-SEASON My Picks: expanding one historic week", () => {
  const leagues = [["AAA"], ["BBB"], ["CCC"]];
  const { s, all } = harness(leagues);
  const contexts = leagues.map(([code]) => ({
    code, name: code,
    lineup: new Set(all.filter((f) => f.id.startsWith(code)).map((f) => String(f.id))),
    dropped: new Set(),
  }));
  const mine = all.filter((f) => f.id.startsWith("AAA"));
  const week = s.pickWeekGroups(mine, false).find((g) => String(g.period) === "12");

  const t = performance.now();
  const body = week.matches
    .map((f) => s.pickEntry(f, s.sharedLeagueNote(f.id, contexts, "AAA")))
    .join("");
  const expandMs = performance.now() - t;

  console.log(`  expansion of one 10-fixture week : ${expandMs.toFixed(1)}ms, ${body.length.toLocaleString()} chars, ${tagCount(body)} tags`);
  assert.equal((body.match(/class="match-card/g) || []).length, 10);
  assert.ok(expandMs < SYNC_BUDGET_MS,
    `expansion took ${expandMs.toFixed(1)}ms, over the ${SYNC_BUDGET_MS}ms budget`);
});

test("worst shape: 20-fixture round, 12-member league weekly table", () => {
  const s = load(["sharedRankByUid", "settlementWindows", "windowPointsByUid",
    "weeklyMovement", "weeklyMovementBadge", "isPostponed", "isVoidFixture",
    "VOID_STATUSES"], { fixtureById: (id) => ({ id, status: "finished" }) });
  const members = Array.from({ length: 12 }, (_, i) => `u${i}`);
  const table = members.map((uid, i) => ({ uid, nick: uid, pts: 40 - i, exact: 0 }));
  const reveal = Array.from({ length: 20 }, (_, n) => ({
    id: `f${n}`,
    lockAt: `2026-09-1${Math.floor(n / 7)}T1${n % 7}:00:00Z`,
    settled: true, voided: false,
    picks: members.map((uid) => ({ uid, nick: uid, pts: (n + uid.length) % 6 })),
  }));
  const t = performance.now();
  const move = s.weeklyMovement(table, reveal, new Set(reveal.map((r) => r.id)));
  const ms = performance.now() - t;
  console.log(`  movement for 20 fixtures x 12 members : ${ms.toFixed(2)}ms`);
  assert.equal(move.size, 12);
  assert.ok(ms < SYNC_BUDGET_MS, `movement took ${ms.toFixed(1)}ms`);
});
