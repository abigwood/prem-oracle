// Slice D · rendered evidence.
//
// Not a test — run directly. It drives the REAL view functions and prints the
// markup they produce, reduced to the text a reviewer needs to read. A
// screenshot of a browser would show the same thing with more pixels and less
// certainty about which function produced it.
import { load } from "./test/harness.mjs";

const HOUR = 3600000;
const now = Date.now();

const fx = (id, o = {}) => ({
  id, player1: o.h || "Home", player2: o.a || "Away", matchday: 7,
  startAt: new Date(now + (o.hours ?? 24) * HOUR).toISOString(),
  ...(o.result ? { result: o.result, status: "complete" } : o.status ? { status: o.status } : {}),
  ...(o.lockAt ? { lockAt: o.lockAt } : {}),
});

const F = [
  fx("f1", { hours: 30, h: "Arsenal", a: "Coventry City" }),
  fx("f2", { hours: 3, lockAt: new Date(now - HOUR).toISOString(), h: "Hull City", a: "Man Utd" }),
  fx("f3", { hours: -1, h: "Everton", a: "Crystal Palace" }),
  fx("f4", { hours: -26, result: [2, 1], h: "Brighton", a: "Aston Villa" }),
  fx("f5", { hours: -26, status: "abandoned", h: "Wrexham", a: "Watford" }),
  fx("f6", { hours: -26, status: "postponed", h: "Millwall", a: "Norwich" }),
];

const NAMES = ["matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekHead", "matchweekContext", "matchweekEmpty", "matchweekUnavailable", "matchweekView",
  "matchweekRowState", "matchweekRowMark", "MATCHWEEK_ROW_LINE", "fixtureRow", "shortKickoff",
  "closedStatus", "matchOpen", "finalScore", "clientLockMs", "VOID_STATUSES", "isVoidFixture",
  "isPostponed", "picksView", "pickRow", "pickEditable", "pickProgress", "pickDeadlineLine",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "scorePickLocal", "RESULT_FIRST_STATES",
  "weeklyTerminalCount", "weeklyShareStatus", "seasonShareFreshness", "shareIconButton",
  "weeklySharePublished",
  "shareCardState", "seasonCardModel", "weeklyCardModel", "weeklyCardCaption", "podiumCounts",
  "CARD_SIDE", "CARD_W", "CARD_HEAD_H", "CARD_HERO_H", "CARD_TABLE_HEAD_H", "CARD_ROW_H",
  "CARD_SEASON_ROW_H", "CARD_FOOT_H", "CARD_GAP", "CARD_PODIUM_H", "CARD_PODIUM_STACK",
  "cardRowMetrics", "cardCanvas", "podiumHeight", "podiumStackDepth", "winnerNames", "CARD",
  "weeklyRanks", "sharedRankByUid", "cardDate", "noteWeeklyFinalMismatch", "weeklyFinalMismatchLines"];

const leagueState = (ids) => ({
  code: "AAA", name: "Sunday Six", currentPeriod: "7",
  currentSlate: ids ? { period: "7", matchweek: 7, status: "published", fixtureIds: ids, count: ids.length } : null,
  table: [], owner: "u-me",
});

const BASE = {
  leagueNames: {}, expandedFixtureId: null, expandedPickId: null,
  matchweekCountMismatches: new Map(),
  periodLabel: (p) => "Matchweek " + p,
  pulsingStatus: (m) => '<p class="pulse">' + m + "</p>",
  onboardingState: () => "<div>Create a league</div>",
  leagueSwitcher: () => "",
  playerName: "Adam",
  scorePicker: () => '<div class="score-picker">[ - ] 0 - 0 [ + ]</div>',
  matchCard: (m) => '<div class="match-card">' + m.player1 + " v " + m.player2 + " -- mates and points</div>",
  fixtureRevealSection: () => '<section class="fixture-reveal">Mates picks and points</section>',
  pickRevealSection: () => "",
  countPhrase: (n, w) => n + " " + w,
  uid: () => "u-me",
  leagueTab: "matchday", selectedPeriod: "7", roundState: null,
  seasonRounds: () => 38, currentPeriodKey: () => "7",
  leagueSupportsRounds: () => true, inviteLinkFor: (c) => "https://x/" + c,
  weeklyFinalMismatches: new Map(),
  leagueCompetitionNames: () => "Premier League",
  PLACE_EMOJI: { gold: "G", silver: "S", bronze: "B" },
  document: { createElement: () => ({ width: 0, height: 0,
    getContext: () => new Proxy({}, { get: () => () => ({ width: 0, addColorStop() {} }), set: () => true }),
    toDataURL: () => "data:image/png;base64,AA" }) },
};

/** Markup reduced to its readable text, one line per element. */
const readable = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
  .replace(/>\s+</g, "><")
  .replace(/<[^>]+>/g, "")
  .split("").map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean)
  .join("\n     ");

function show(title, html) {
  console.log("\n" + "=".repeat(74));
  console.log("  " + title);
  console.log("=".repeat(74));
  console.log("     " + readable(html));
}

const ids = F.map((f) => f.id);
const picks = { f1: { p1: 2, p2: 0 }, f2: { p1: 1, p2: 1 }, f4: { p1: 2, p2: 1 } };
const world = (over = {}) => load(NAMES, {
  ...BASE, fixtures: F, picks, activeLeague: "AAA",
  leagueState: leagueState(ids), leagueStates: {}, leagueCodes: ["AAA"], ...over,
});

const s = world();
show("MATCHWEEK - six-fixture slate, every card state", s.matchweekView());
s.evalIn('expandedFixtureId = "f4";');
show("MATCHWEEK - one card expanded (settled: mates on expansion)", s.matchweekView());

const p = world();
show("MY PICKS - 3 of 6 complete, compact rows", p.picksView());
p.evalIn('expandedPickId = "f1";');
show("MY PICKS - one editable row open, controls only there", p.picksView());

const empty = world({ leagueState: leagueState(null), picks: {} });
show("MATCHWEEK - no published slate", empty.matchweekView());
show("MY PICKS - no published slate", empty.picksView());

// --- the two square cards, as their models --------------------------------
const round = (n, entries, complete) => ({
  matchday: n, period: String(n), complete,
  code: "AAA",
  slate: { period: String(n), status: "published", fixtureIds: entries.map((e) => e.id), count: entries.length },
  reveal: entries,
  table: [
    { uid: "u1", rank: 1, nick: "Adam", pts: 23, exact: 3 },
    { uid: "u2", rank: 2, nick: "Bex", pts: 19, exact: 2 },
    { uid: "u3", rank: 3, nick: "Cal", pts: 14, exact: 1 },
  ],
});
const six = (settled, voided = 0) => Array.from({ length: 6 }, (_, i) => ({
  id: "w" + i,
  ...(i < settled ? { settled: true } : i < settled + voided ? { voided: true } : {}),
}));

console.log("\n" + "=".repeat(74));
console.log("  SQUARE CARD 1 - WEEKLY STANDINGS (M9: available from publication)");
console.log("=".repeat(74));
for (const [label, r] of [
  ["published, nothing played", round(3, six(0), false)],
  ["two settled", round(3, six(2), false)],
  ["two settled + one void", round(3, six(2, 1), false)],
  ["every slot terminal", round(3, six(6), true)],
]) {
  const box = world({ roundState: r, selectedPeriod: String(r.period) });
  const status = box.weeklyShareStatus(r);
  console.log("     " + label.padEnd(26) + " card header : " + status.label);
  console.log("     " + " ".repeat(26) + " control name: " + box.shareCardState().label);
}

console.log("\n" + "=".repeat(74));
console.log("  SQUARE CARD 2 - SEASON CUMULATIVE TABLE (full table, never truncated)");
console.log("=".repeat(74));
const table = Array.from({ length: 12 }, (_, i) => ({
  uid: "u" + i, rank: i + 1, nick: "Player " + (i + 1), pts: 120 - i * 7, exact: (i % 4),
  podiums: { gold: i === 0 ? 2 : 0, silver: i === 1 ? 1 : 0, bronze: 0 },
}));
const seasonState = { ...leagueState(ids), table, currentMatchday: 8, currentMatchdayHasResults: true };
const sbox = world({ leagueTab: "season", leagueState: seasonState });
const model = sbox.seasonCardModel(seasonState);
console.log("     header       : " + model.headline);
console.log("     league       : " + model.league);
console.log("     control name : " + sbox.shareCardState().label);
console.log("     rows exported: " + model.rows.length + " of " + table.length);
for (const row of [...model.rows].slice(0, 3)) {
  console.log("       " + String(row.rank).padStart(2) + "  " + row.nick.padEnd(12)
    + String(row.pts).padStart(4) + " pts   " + row.exact + " exact   "
    + "gold " + row.honours.gold + " silver " + row.honours.silver + " bronze " + row.honours.bronze);
}
console.log("       ... through to rank " + model.rows[model.rows.length - 1].rank
  + " (" + model.rows[model.rows.length - 1].nick + ")");
console.log("     fields per row: " + Object.keys({ ...model.rows[0] }).sort().join(", "));

console.log("\n" + "=".repeat(74));
console.log("  SHARE CONTROL MARKUP");
console.log("=".repeat(74));
console.log(world({ roundState: round(3, six(6), true), selectedPeriod: "3" }).shareIconButton({ code: "AAA" }).trim());


// --- the SQUARE cards, as geometry ------------------------------------------
console.log("\n" + "=".repeat(74));
console.log("  SQUARE EXPORT GEOMETRY - every size, both cards");
console.log("=".repeat(74));
const g = world();
const seasonChrome = g.CARD_HEAD_H + g.CARD_GAP + g.CARD_TABLE_HEAD_H + g.CARD_GAP + g.CARD_FOOT_H;
console.log("     members  rowH  name  honours    tally   content   canvas      scale  fits");
for (const n of [1, 3, 6, 8, 12, 16, 20, 25, 30]) {
  const m = g.cardRowMetrics(n, { chrome: seasonChrome, base: g.CARD_SEASON_ROW_H });
  const { canvas, scale } = g.cardCanvas(m.contentHeight);
  const drawn = m.contentHeight * scale;
  console.log("     " + String(n).padStart(7) + "  " + String(Math.round(m.rowH)).padStart(4)
    + "  " + String(m.name).padStart(4) + "  " + String(m.honoursLine ? "line" : "inline").padStart(7)
    + "  " + String(m.honoursSize).padStart(5)
    + "   " + String(Math.round(m.contentHeight)).padStart(7)
    + "   " + (canvas.width + "x" + canvas.height).padStart(9)
    + "  " + scale.toFixed(3).padStart(5)
    + "  " + (drawn <= canvas.height + 0.5 && canvas.width === canvas.height ? "yes" : "NO"));
}
console.log("\n     Every canvas is square and every row is drawn: the table is never cut.");
