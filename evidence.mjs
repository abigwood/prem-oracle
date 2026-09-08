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
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable", "picksView",
  "matchweekRowState", "MATCHWEEK_ROW_LINE", "shortKickoff",
  "closedStatus", "matchOpen", "finalScore", "clientLockMs", "VOID_STATUSES", "isVoidFixture",
  "isPostponed", "picksView", "pickRow", "pickEditable", "pickProgress", "pickDeadlineLine",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "pickRowBody", "pickRowLabel", "pickJustSaved", "pickListState", "pickShareRow",
  "shareSurface", "shareRound", "sharePeriod", "normaliseView", "LEGACY_VIEWS",
  "picksPeriod", "picksRoundUsable",
  "scorePickLocal", "RESULT_FIRST_STATES",
  "weeklyTerminalCount", "weeklyShareStatus", "seasonShareFreshness", "shareIconButton",
  "weeklySharePublished",
  "shareCardState", "seasonCardModel", "weeklyCardModel", "weeklyCardCaption", "podiumCounts",
  "CARD_SIDE", "CARD_W", "CARD_HEAD_H", "CARD_HERO_H", "CARD_TABLE_HEAD_H", "CARD_ROW_H",
  "CARD_SEASON_ROW_H", "CARD_FOOT_H", "CARD_GAP",
  "cardRowMetrics", "weeklyCardGeometry", "cardCanvas", "winnerNames", "CARD", "CARD_PAD", "CARD_COL",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "CARD_MIN_NAME",
  "CARD_HERO_MIN", "CARD_RULE_H",
  "cardPageRows", "cardPageLabel", "cardHonoursFit", "cardHonoursWidth",
  "weeklyRanks", "sharedRankByUid", "cardDate", "noteWeeklyFinalMismatch", "weeklyFinalMismatchLines"];

const leagueState = (ids) => ({
  code: "AAA", name: "Sunday Six", currentPeriod: "7",
  currentSlate: ids ? { period: "7", matchweek: 7, status: "published", fixtureIds: ids, count: ids.length } : null,
  table: [], owner: "u-me",
});

const BASE = {
  leagueNames: {}, expandedPickId: null,
  currentView: "picks", currentRoundReveal: () => null, matesState: null,
  leagueSupportsRounds: () => true, picksRound: null, picksRoundFlights: new Map(),
  cachedRoundState: () => null, roundStates: {}, API: null,
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
const world = ({ active = "AAA", ...over } = {}) => load(NAMES, {
  ...BASE, fixtures: F, picks, activeLeague: active,
  leagueState: leagueState(ids), leagueStates: {}, leagueCodes: ["AAA"], ...over,
});

import { readFileSync } from "node:fs";
const INDEX = readFileSync(new URL("./index.html", import.meta.url), "utf8");
console.log("\n" + "=".repeat(74));
console.log("  BOTTOM NAVIGATION - four items, evenly divided");
console.log("=".repeat(74));
const NAV = INDEX.slice(INDEX.indexOf("<nav class=\"bottom-nav\""), INDEX.indexOf("</nav>"));
for (const button of NAV.split("<button").slice(1)) {
  const view = /data-view="([^"]+)"/.exec(button)?.[1];
  const label = (/<\/span>([^<]*)</.exec(button)?.[1] || "").trim();
  const icon = (/<span>([^<]*)<\/span>/.exec(button)?.[1] || "").trim();
  console.log(`     ${String(view).padEnd(8)} ${icon}  ${label}`);
}
console.log("     " + /grid-template-columns: repeat\((\d)/.exec(
  readFileSync(new URL("./styles.css", import.meta.url), "utf8")
    .slice(readFileSync(new URL("./styles.css", import.meta.url), "utf8").indexOf(".bottom-nav {")))?.[0]);

const s = world();
show("MY PICKS - six-fixture slate, every row state", s.picksView());
s.evalIn('expandedPickId = "f4";');
show("MY PICKS - a settled row expanded (mates behind the disclosure)", s.picksView());

const p = world();
show("MY PICKS - partly locked, 3 of 6 saved", p.picksView());
p.evalIn('expandedPickId = "f1";');
show("MY PICKS - one editable row open, controls only there", p.picksView());

// Two leagues, one shared fixture id: each must show only its own.
const shared = world({
  leagueState: leagueState(["f1", "f2"]),
  leagueCodes: ["AAA", "BBB"],
  leagueNames: { AAA: "Sunday Six", BBB: "Bury Boys" },
  leagueSwitcher: () => '<div class="league-switcher"><button data-league="AAA">Sunday Six</button><button data-league="BBB">Bury Boys</button></div>',
});
show("MY PICKS - two leagues, showing AAA's two-fixture slate", shared.picksView());
const other = world({
  active: "BBB",
  leagueState: { code: "BBB", name: "Bury Boys", currentPeriod: "7",
    currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f2", "f5"], count: 2 },
    table: [], owner: "u-me" },
  leagueCodes: ["AAA", "BBB"],
  leagueNames: { AAA: "Sunday Six", BBB: "Bury Boys" },
  leagueSwitcher: () => '<div class="league-switcher"><button data-league="AAA">Sunday Six</button><button data-league="BBB">Bury Boys</button></div>',
});
show("MY PICKS - switched to BBB: its own slate, its own name, no bleed", other.picksView());

const empty = world({ leagueState: leagueState(null), picks: {} });
show("MY PICKS - no published slate (the honest empty state)", empty.picksView());

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
// One component, three surfaces. The season control is what the League page
// shows under its standings; the weekly one is what My Picks shows under its
// list, and it appears only when this device already holds the week's table.
const seasonControl = world({
  leagueTab: "season", currentView: "league",
  leagueState: { ...leagueState(ids), table: [{ uid: "u1", nick: "Adam", pts: 12 }],
    currentMatchday: 8, currentMatchdayHasResults: true },
});
console.log("  SEASON (League page, under the standings):");
console.log(seasonControl.shareIconButton({ code: "AAA" }, "season").trim());
// My Picks shows the control from publication. Cold, it says it is loading and
// cannot be pressed; when the table lands it enables, atomically.
const loadingControl = world({
  currentView: "picks", selectedPeriod: "7",
  picksRound: null, picksRoundFlights: new Map(), currentRoundReveal: () => null,
});
console.log("\n  WEEKLY (My Picks, cold — published, table not yet in hand):");
console.log(loadingControl.shareIconButton({ code: "AAA" }, "weekly").trim()
  || "  (nothing rendered — this would be the defect)");
const weekControl = world({
  currentView: "picks", selectedPeriod: "7",
  picksRound: null, picksRoundFlights: new Map(),
  currentRoundReveal: () => round(7, six(6), true),
});
console.log("\n  WEEKLY (My Picks, table in hand):");
console.log(weekControl.shareIconButton({ code: "AAA" }, "weekly").trim() || "  (hidden)");
const unpublished = world({
  currentView: "picks", selectedPeriod: "7", leagueState: leagueState(null),
  picksRound: null, picksRoundFlights: new Map(), currentRoundReveal: () => null,
});
console.log("\n  WEEKLY (My Picks, before the host publishes):");
console.log(unpublished.shareIconButton({ code: "AAA" }, "weekly").trim()
  || "  (no control at all — there is no week to export yet)");


// --- the SQUARE cards, as geometry ------------------------------------------
console.log("\n" + "=".repeat(74));
console.log("  SQUARE EXPORT GEOMETRY - the SEASON card, every size");
console.log("=".repeat(74));
const g = world();
const seasonChrome = g.CARD_HEAD_H + g.CARD_GAP + g.CARD_TABLE_HEAD_H + g.CARD_GAP + g.CARD_FOOT_H;
console.log("     members  pages  perPage  rowH  name  rank  pts  2nd  honours  tally  content  scale  floors");
for (const n of [1, 3, 6, 8, 12, 16, 20, 25, 30, 36, 40]) {
  const m = g.cardRowMetrics(n, { chrome: seasonChrome, base: g.CARD_SEASON_ROW_H });
  const { canvas, scale } = g.cardCanvas(m.contentHeight);
  const primary = Math.min(m.name, m.number, m.points) * scale;
  const secondary = Math.min(m.second, m.honoursSize) * scale;
  console.log("     " + String(n).padStart(7) + "  " + String(m.pages).padStart(5)
    + "  " + String(m.rowsPerPage).padStart(7) + "  " + String(Math.round(m.rowH)).padStart(4)
    + "  " + String(m.name).padStart(4) + "  " + String(m.number).padStart(4)
    + "  " + String(m.points).padStart(3) + "  " + String(m.second).padStart(3)
    + "  " + String(m.honoursLine ? "line" : "inline").padStart(7)
    + "  " + String(m.honoursSize).padStart(5)
    + "  " + String(Math.round(m.contentHeight)).padStart(7)
    + "  " + scale.toFixed(3).padStart(5)
    + "  " + (primary >= 18 - 0.001 && secondary >= 15 - 0.001
      && canvas.width === canvas.height && scale >= 1 ? "yes" : "NO"));
}
console.log("\n     Every canvas is square, every member is drawn, and no figure is drawn");
console.log("     below 18px (names, ranks, points) or 15px (secondary figures, honours).");

console.log("\n" + "=".repeat(74));
console.log("  SQUARE EXPORT GEOMETRY - the WEEKLY card, hero and table together");
console.log("=".repeat(74));
console.log("     members  hero  pages  perPage  rowH  name  rank  pts  2nd  content  scale  floors");
for (const n of [1, 3, 6, 8, 10, 11, 12, 13, 16, 20, 25, 30, 40]) {
  const { hero, m } = g.weeklyCardGeometry(n);
  const { canvas, scale } = g.cardCanvas(m.contentHeight);
  const primary = Math.min(m.name, m.number, m.points) * scale;
  const secondary = m.second * scale;
  console.log("     " + String(n).padStart(7) + "  " + String(Math.round(hero)).padStart(4)
    + "  " + String(m.pages).padStart(5) + "  " + String(m.rowsPerPage).padStart(7)
    + "  " + String(Math.round(m.rowH)).padStart(4)
    + "  " + String(m.name).padStart(4) + "  " + String(m.number).padStart(4)
    + "  " + String(m.points).padStart(3) + "  " + String(m.second).padStart(3)
    + "  " + String(Math.round(m.contentHeight)).padStart(7)
    + "  " + scale.toFixed(3).padStart(5)
    + "  " + (primary >= 18 - 0.001 && secondary >= 15 - 0.001
      && canvas.width === canvas.height && scale >= 1 ? "yes" : "NO"));
}
console.log("\n     Eleven members fit ONE square: the hero gives up the room the table");
console.log("     needs, down to a floor of " + g.CARD_HERO_MIN + "px, and nothing shrinks below the type floors.");

// --- the Season page's two folded sections ---------------------------------
console.log("\n" + "=".repeat(74));
console.log("  SEASON SECTIONS - collapsed by default, opened on request");
console.log("=".repeat(74));
const REVEALS = { reveals: [{ player1: "Arsenal", player2: "Coventry", settled: true, result: { p1: 2, p2: 0 },
  picks: [{ nick: "Adam", p1: 2, p2: 0, pts: 5, settled: true }, { nick: "Bex", p1: 1, p2: 0, pts: 2, settled: true }] }] };
const CABINET = { cabinet: { nick: "Adam", gold: 2, silver: 1, bronze: 0, podiums: 3,
  weeks: [{ period: "6", place: "gold", pts: 21 }, { period: "5", place: "silver", pts: 18 }] } };
const folds = load(["seasonSection", "seasonSectionOpen", "seasonSectionKey", "seasonOpenSections",
  "SEASON_SECTIONS", "leagueRevealsHtml", "revealsListHtml", "cabinetWeeksHtml", "trophyCabinet",
  "PLACE_EMOJI"], {
  activeLeague: "AAA", leagueState: { ...REVEALS, ...CABINET }, fixtures: F,
  revealCard: (r) => `<div class="reveal-card">${r.player1} v ${r.player2}: ${
    r.picks.map((p) => `${p.nick} ${p.p1}-${p.p2} (+${p.pts})`).join(", ")}</div>`,
  cabinetWeek: (w) => `<li>Week ${w.period}: ${w.place}, ${w.pts} pts</li>`,
  periodLabel: (p) => `Matchweek ${p}`,
});
show("SEASON - both sections closed (nothing built behind them)", 
  folds.trophyCabinet(CABINET) + folds.leagueRevealsHtml(REVEALS));
folds.evalIn(`seasonOpenSections.add(seasonSectionKey("reveals"));`);
folds.evalIn(`seasonOpenSections.add(seasonSectionKey("weeks"));`);
show("SEASON - both open (the same nodes, filled in place)",
  folds.trophyCabinet(CABINET) + folds.leagueRevealsHtml(REVEALS));
