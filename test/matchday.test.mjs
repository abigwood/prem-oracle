// v1.9 Slice 2 — "Matchday comes alive", the app's half.
//
// The reveal (P2/P3), the day's scorecard and Your results (D), results mode on
// My Picks, the two Matchday alerts switches and their one-time offers (A, F2),
// and the finished-row grey (F5). Every test drives the REAL functions out of
// app.js over a mounted DOM; the worker's half has its own suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, constOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const flush = () => new Promise((r) => setTimeout(r, 0));
const HOUR = 3600000;
const DAY = 24 * HOUR;

// --- routing: an alert tap and a link take the same road ------------------------

const ROUTE = ["NOTIFY_PAYLOAD_VERSION", "NOTIFY_MATCHDAY_VERSION", "UK_DATE_RE", "MATCHDAY_VIEWS",
  "matchdayRouteFromBlock", "matchdayRouteFromSearch", "safeParseJSON", "readNotificationRoute",
  "leagueCodeFromUrl", "requestedView", "LEGACY_VIEWS", "normaliseView", "linkRoute", "followLinkRoute"];

test("v:2 payloads route to the reveal and the scorecard; anything malformed is refused", () => {
  const s = load(ROUTE, { location: { href: "capacitor://localhost/", search: "" }, URL, URLSearchParams });
  assert.deepEqual(plain(s.readNotificationRoute({ po: { v: 2, k: "reveal", t: 1764342000000 } })), { view: "reveal", t: 1764342000000 });
  assert.deepEqual(plain(s.readNotificationRoute({ po: JSON.stringify({ v: 2, k: "results", d: "2026-11-28" }) })), { view: "scorecard", d: "2026-11-28" });
  for (const bad of [{ v: 2 }, { v: 2, k: "reveal" }, { v: 2, k: "reveal", t: "soon" }, { v: 2, k: "reveal", t: -5 },
    { v: 2, k: "results", d: "28/11/2026" }, { v: 2, k: "gossip", t: 1 }, { v: 3, k: "reveal", t: 1 }]) {
    assert.equal(s.readNotificationRoute({ po: bad }), null, JSON.stringify(bad));
  }
  // The same screens from a link, with no league named.
  const web = "https://abigwood.github.io/prem-oracle/";
  assert.deepEqual(plain(s.linkRoute(`${web}?view=reveal&t=1764342000000`)), { view: "reveal", t: 1764342000000 });
  assert.deepEqual(plain(s.linkRoute(`${web}?view=scorecard&d=2026-11-28`)), { view: "scorecard", d: "2026-11-28" });
  assert.deepEqual(plain(s.linkRoute(`${web}?view=results`)), { view: "results" });
  // Slice 1's league links are untouched.
  assert.deepEqual(plain(s.linkRoute(`${web}?league=swaf5m`)), { league: "SWAF5M", view: "picks" });
});

test("a tap goes through the Slice 1 router: followLinkRoute opens the matchday screen", async () => {
  const opened = [];
  const s = load(ROUTE, { location: { href: "capacitor://localhost/", search: "" }, URL, URLSearchParams,
    leagueCodes: ["AAA"], activeLeague: "AAA" });
  s.openMatchdayScreen = async (route) => { opened.push(plain(route)); };
  s.evalIn("var openMatchdayScreen = globalThis.openMatchdayScreen;");
  assert.equal(await s.followLinkRoute({ view: "reveal", t: 5 }), "matchday");
  assert.equal(await s.followLinkRoute({ view: "scorecard", d: "2026-11-28" }), "matchday");
  assert.deepEqual(opened, [{ view: "reveal", t: 5 }, { view: "scorecard", d: "2026-11-28" }]);
  // The notification handler hands v:2 to that same router, and nothing else.
  assert.match(sourceOf("openNotificationTarget"), /if \(MATCHDAY_VIEWS\.includes\(route\.view\)\) return `matchday:\$\{await followLinkRoute\(route\)\}`;/);
  // And an old build's unknown v already falls back to My Picks (N7) — unchanged.
  assert.match(sourceOf("openNotificationTarget"), /currentView = "picks"; render\(\{ scrollTop: true \}\); return "fallback:no-route";/);
});

test("E · a week-level notice opens that league's My Picks, with no card to find", async () => {
  const calls = [];
  const s = load(["openNotificationTarget", "MATCHDAY_VIEWS"], { leagueCodes: ["AAA", "BBB"], activeLeague: "AAA",
    render: () => {}, currentView: "league" });
  s.setActiveLeague = (code) => { calls.push(["switch", code]); s.activeLeague = code; };
  s.navigateToView = async (view) => { calls.push(["view", view]); };
  s.evalIn("var setActiveLeague = globalThis.setActiveLeague, navigateToView = globalThis.navigateToView;");
  assert.equal(await s.openNotificationTarget({ fixtureId: "", league: "BBB" }), "opened:league");
  assert.deepEqual(calls, [["switch", "BBB"], ["view", "picks"]]);
  assert.equal(await s.openNotificationTarget({ fixtureId: "", league: "ZZZ" }), "fallback:unknown-league");
});

// --- a mounted My Picks with the Slice 2 pieces real ----------------------------

const now = Date.now();
const fx = (id, { at, result = null, status = null, teams = ["Arsenal", "Coventry City"], matchday = 13 } = {}) => ({
  id, player1: teams[0], player2: teams[1], matchday, startAt: new Date(at).toISOString(),
  ...(result ? { result, status: "complete" } : status ? { status } : {}),
});
// A settled Saturday and Sunday in week 13, and week 14 still to come.
const SAT = Date.parse("2026-11-28T15:00:00Z");
const SUN = Date.parse("2026-11-29T16:30:00Z");
const W13 = [
  fx("pl-1", { at: SAT, result: [2, 2], teams: ["Fulham", "AFC Bournemouth"] }),
  fx("pl-2", { at: SAT, result: [3, 1], teams: ["Chelsea", "Brentford"] }),
  fx("pl-3", { at: SUN, result: [0, 1], teams: ["Everton", "Liverpool"] }),
];
const W14 = [fx("pl-4", { at: now + 5 * DAY, matchday: 14, teams: ["Leeds United", "Arsenal"] })];
const MY_PICKS = { "pl-1": { p1: 2, p2: 2 }, "pl-2": { p1: 1, p2: 0 }, "pl-3": { p1: 2, p2: 0 } };

const pick = (uid, nick, p1, p2, pts, exact = false) => ({ uid, nick, none: p1 == null, p1, p2, pts, exact, settled: true });
const ROUND13 = {
  code: "AAA", period: "13", matchday: 13, complete: true, status: "complete",
  slate: { period: "13", fixtureIds: ["pl-1", "pl-2", "pl-3"] },
  table: [{ uid: "u-me", nick: "Adam", pts: 7, exact: 1 }, { uid: "u-tom", nick: "Tom", pts: 7, exact: 0 },
    { uid: "u-sam", nick: "Sam", pts: 2, exact: 0 }],
  winners: ["u-me", "u-tom"],
  reveal: [
    { id: "pl-1", revealed: true, settled: true, result: { p1: 2, p2: 2 }, picks: [
      pick("u-tom", "Tom", 1, 1, 2), pick("u-me", "Adam", 2, 2, 5, true), pick("u-sam", "Sam", null, null, 0)] },
    { id: "pl-2", revealed: true, settled: true, result: { p1: 3, p2: 1 }, picks: [
      pick("u-me", "Adam", 1, 0, 1), pick("u-tom", "Tom", 3, 1, 5, true), pick("u-sam", "Sam", 2, 0, 2)] },
    { id: "pl-3", revealed: true, settled: true, result: { p1: 0, p2: 1 }, picks: [
      pick("u-me", "Adam", 2, 0, 0), pick("u-tom", "Tom", 0, 0, 0), pick("u-sam", "Sam", 1, 1, 0)] },
  ],
};
// Season after week 13: Adam 30 (was 23), Tom 28 (was 21), Sam 26 (was 24).
const SEASON = [{ uid: "u-me", nick: "Adam", pts: 30 }, { uid: "u-tom", nick: "Tom", pts: 28 }, { uid: "u-sam", nick: "Sam", pts: 26 }];

const PICKS_NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable", "matchweekRowState", "MATCHWEEK_ROW_LINE",
  "shortKickoff", "closedStatus", "matchOpen", "finalScore", "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickActionSummary", "pickCounts", "pickRow", "pickRowKickoff", "pickRowMark",
  "pickRowOutcome", "pickRowBody", "pickRowLabel", "PICK_SAVED_MS", "pickJustSaved", "pickListState",
  "pickShareRow", "pickDeadlineLine", "pickEditable", "picksLoadPhase",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard", "RESULT_FIRST_STATES",
  "TEAM_MARKERS", "TEAM_CODES", "teamInitials", "teamCode", "teamBadge",
  // Slice 2
  "MATCHDAY_VIEWS", "MATCHDAY_ROWS_SHOWN", "RESULTS_LINK_MS", "RESULTS_LINK_SEEN", "UK_DATE_RE",
  "ukDateOf", "ukNoon", "ukWeekday", "ukShortDate", "ukClock", "previousPeriod", "isWindowKey", "weekWording",
  "leagueStateFor", "roundIds", "roundSettled", "slateIdsOf", "pointsPill", "pointsWords", "matchdayRow", "matchdayRowList",
  "matchdayScreenView", "revealPairs", "revealScreenView", "revealCardView",
  "scorecardLeagues", "scorecardModel", "scorecardScreenView", "dayTableRow", "dayTableMore", "scorecardMatch", "weekCompleteBanner",
  "resultsSnapshot", "resultsCard", "resultsSummary", "resultsMoveBadge", "movementMark", "yourResultsBlock",
  "resultsModeFor", "resultsRoundFlights", "requestResultsRound", "resultsLinkSeenAt", "resultsSlimLink", "scorecardLinks",
  "scorecardPrefetched", "prefetchScorecards", "dayFullySettled", "usableRound",
  "ordinal", "ORDINALS", "alertOffer", "ALERT_OFFER_COPY", "byKickoffAsc", "sharedRankByUid",
];

const leagueState13 = (extra = {}) => ({
  code: "AAA", name: "Burtons Premier", mixed: false, currentPeriod: "14", awaitingPublish: true,
  currentSlate: null, table: SEASON, lineupFixtureIds: ["pl-1", "pl-2", "pl-3"], owner: "u-me", ...extra,
});

function mounted({ state = leagueState13(), rounds = { "AAA:13": ROUND13 }, fixtures = [...W13, ...W14],
  screen = null, native = true, prefs = { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true },
  storage = new Map(), codes = ["AAA"], states = {}, active = "AAA" } = {}) {
  const dom = new JSDOM(`<!doctype html><body><main id="app"></main></body>`);
  const { document } = dom.window;
  const fetched = [];
  const timers = [];        // deferred work (the scorecard prefetch) runs only when a test says so
  const b = load(PICKS_NAMES, {
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    picks: MY_PICKS, fixtures, document, API: "https://api.test",
    fixturesStatus: "ready", confirmedLeagues: new Set(["AAA"]), leagueLoadFailed: new Set(), picksLoadTimedOut: false,
    leagueNames: { AAA: "Burtons Premier" }, expandedPickId: null, activeLeague: active,
    leagueState: state, leagueStates: states, leagueCodes: codes, shareIconButton: () => "",
    matchweekCountMismatches: new Map(), periodLabel: (p) => `Matchweek ${p}`, pulsingStatus: (m) => m,
    picksDue: () => [], periodOfFixture: (f) => String(f.matchday), installNotice: () => "", slateNotice: () => "",
    preseasonState: () => "<div data-preseason></div>", launchBranch: () => "season", inviteCode: "",
    onboardingState: () => "", leagueSwitcher: () => "", playerName: "Adam",
    matchCard: (m) => `<article data-match-card="${m.id}"></article>`, countPhrase: (n, w) => `${n} ${w}`,
    uid: () => "u-me", matchdayScreen: screen,
    resultsModeFor: undefined, resultsSlimLink: undefined, scorecardLinks: undefined,
    cachedRoundState: (code, period) => rounds[`${code}:${period}`] || null,
    loadMatchdayRound: async (code, period) => { fetched.push(`${code}:${period}`); return rounds[`${code}:${period}`] || null; },
    render: () => {},
    isNativeApp: () => native,
    alertPrefs: prefs,
    windowKeyFor: (v) => v,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
  });
  const paint = () => { document.getElementById("app").innerHTML = b.picksView(); };
  paint();
  const text = () => document.getElementById("app").textContent.replace(/\s+/g, " ").trim();
  return { box: b, document, paint, text, fetched, storage, timers };
}

// --- results mode on My Picks ------------------------------------------------------

test("results mode · last week settled and the next not open: Your results first, then last week's finished rows", () => {
  const app = mounted();
  const block = app.document.querySelector("[data-results-mode] [data-your-results]");
  assert.ok(block, "no results block");
  // Summary: +7 across 1 league, 1 exact, 1 week won (a shared win is a win).
  assert.match(block.textContent.replace(/\s+/g, " "), /Matchweek 13 · settled Your results \+7 pts across 1 league · 1 exact score · 1 week won/);
  const card = block.querySelector("[data-results-league='AAA']");
  assert.match(card.textContent.replace(/\s+/g, " "), /Burtons Premier WEEK WINNER This week 1st · \+7 Season 1st ▲1/);
  assert.equal(card.dataset.resultsPeriod, "13");
  // Then the settled week's rows, each with the Slice 1 line, on the grey.
  const rows = [...app.document.querySelectorAll("[data-pick-list] [data-pick-row]")];
  assert.deepEqual(rows.map((r) => r.dataset.pickRow), ["pl-1", "pl-2", "pl-3"]);
  assert.ok(rows.every((r) => r.classList.contains("is-finished")));
  assert.equal(app.document.querySelectorAll("[data-pick-outcome]").length, 3);
  // The tab never moves: this IS My Picks, and its header still says what is true.
  assert.match(app.text(), /My Picks/);
  // Each finished day has its scorecard a tap away — web players included.
  assert.deepEqual([...app.document.querySelectorAll("[data-open-scorecard]")].map((b) => [b.dataset.openScorecard, b.textContent]),
    [["2026-11-28", "Saturday's scorecard ›"], ["2026-11-29", "Sunday's scorecard ›"]]);
});

test("results mode · the next week opens: picks win, with a slim 'Matchweek 13 results ›' for 24 hours", () => {
  const open = leagueState13({ awaitingPublish: false,
    currentSlate: { period: "14", matchweek: 14, status: "published", fixtureIds: ["pl-4"], count: 1 } });
  const storage = new Map();
  const app = mounted({ state: open, storage });
  assert.equal(app.document.querySelector("[data-results-mode]"), null, "results above picks still to make");
  assert.deepEqual([...app.document.querySelectorAll("[data-pick-row]")].map((r) => r.dataset.pickRow), ["pl-4"]);
  const link = app.document.querySelector("[data-open-results]");
  assert.equal(link?.textContent, "Matchweek 13 results ›");
  // ABOVE the rows, as one line.
  assert.ok(link.compareDocumentPosition(app.document.querySelector("[data-pick-list]")) & 4);
  // A day after this device first showed it, it is gone.
  const key = [...storage.keys()].find((k) => k.startsWith("prem_oracle_results_link_seen:AAA:13"));
  assert.ok(key, "the first sighting was not recorded");
  storage.set(key, String(Date.now() - 25 * HOUR));
  app.paint();
  assert.equal(app.document.querySelector("[data-open-results]"), null);
  storage.set(key, String(Date.now() - 23 * HOUR));
  app.paint();
  assert.ok(app.document.querySelector("[data-open-results]"));
});

test("results mode · next published before the last settled: picks throughout, no results", () => {
  const unsettled = { ...ROUND13, complete: false, status: "1 fixture pending" };
  const open = leagueState13({ awaitingPublish: false,
    currentSlate: { period: "14", matchweek: 14, status: "published", fixtureIds: ["pl-4"], count: 1 } });
  const app = mounted({ state: open, rounds: { "AAA:13": unsettled } });
  assert.equal(app.document.querySelector("[data-results-mode]"), null);
  assert.equal(app.document.querySelector("[data-open-results]"), null);
  // Not yet open either, still no results: an unsettled week has none to show.
  const waiting = mounted({ rounds: { "AAA:13": unsettled } });
  assert.equal(waiting.document.querySelector("[data-results-mode]"), null);
});

test("results mode · the first week of a season has no last week: the normal screen", () => {
  const app = mounted({ state: leagueState13({ currentPeriod: "1" }), rounds: {} });
  assert.equal(app.document.querySelector("[data-results-mode]"), null);
  assert.deepEqual(app.fetched, [], "asked the server for week 0");
  assert.equal(app.box.previousPeriod("1"), null);
  assert.equal(app.box.previousPeriod("w2026-12-01"), "w2026-11-24");
});

test("results mode · not held yet: the normal screen, and ONE read for last week", async () => {
  const app = mounted({ rounds: {} });
  assert.equal(app.document.querySelector("[data-results-mode]"), null);
  app.paint();
  await flush();
  assert.deepEqual(app.fetched, ["AAA:13"], "one read, however many paints");
});

test("results mode · every league gets its card: a league whose last week is not held is fetched, once", async () => {
  const states = { BBB: { code: "BBB", name: "Bravo", currentPeriod: "14", table: SEASON, lineupFixtureIds: ["pl-1"] } };
  const app = mounted({ codes: ["AAA", "BBB"], states });
  assert.equal(app.document.querySelectorAll("[data-results-league]").length, 1);
  app.paint();
  await flush();
  assert.deepEqual(app.fetched, ["BBB:13"]);
});

test("results mode · web is the same as iOS — nothing in it asks which platform this is", () => {
  const web = mounted({ native: false });
  assert.ok(web.document.querySelector("[data-results-mode] [data-your-results]"));
  for (const fn of ["resultsModeFor", "resultsSlimLink", "yourResultsBlock", "scorecardLinks", "resultsSnapshot", "resultsCard"]) {
    assert.doesNotMatch(sourceOf(fn), /isNativeApp|Capacitor/, fn);
  }
});

// --- Your results: places and movement, ties included ------------------------------

test("Your results · places come from the server tables; movement is season vs season-minus-this-week, shared ranks", () => {
  const app = mounted();
  const card = (season, table, me = "u-me") => app.box.resultsCard({ code: "AAA", name: "X", table: season },
    { ...ROUND13, table, winners: [] }, "13", me);
  // Up: 23 → 30 overtakes Sam's 24.
  assert.equal(card(SEASON, ROUND13.table).seasonMove, 1);
  // Down: Sam scores 10 this week and passes.
  const down = card([{ uid: "u-sam", pts: 34 }, { uid: "u-me", pts: 30 }], [{ uid: "u-sam", pts: 10 }, { uid: "u-me", pts: 0 }]);
  assert.deepEqual([down.seasonRank, down.seasonMove], [2, -1]);
  // Unchanged.
  const same = card([{ uid: "u-me", pts: 30 }, { uid: "u-tom", pts: 20 }], [{ uid: "u-me", pts: 3 }, { uid: "u-tom", pts: 3 }]);
  assert.deepEqual([same.seasonRank, same.seasonMove], [1, 0]);
  // Ties share a place: level on 30 is joint 1st, both now and before.
  const tied = card([{ uid: "u-me", pts: 30 }, { uid: "u-tom", pts: 30 }], [{ uid: "u-me", pts: 5 }, { uid: "u-tom", pts: 5 }]);
  assert.deepEqual([tied.seasonRank, tied.weekRank, tied.seasonMove], [1, 1, 0]);
  // Pulling level from behind is a move up into a shared place.
  const caught = card([{ uid: "u-me", pts: 30 }, { uid: "u-tom", pts: 30 }], [{ uid: "u-me", pts: 8 }, { uid: "u-tom", pts: 0 }]);
  assert.deepEqual([caught.seasonRank, caught.seasonMove], [1, 1]);
  // Points are the round table's, never a recount.
  assert.equal(card(SEASON, [{ uid: "u-me", pts: 99 }]).weekPts, 99);
  // A league the viewer has no row in (joined after it) has no card.
  assert.equal(card(SEASON, [{ uid: "u-tom", pts: 1 }]), null);
});

test("Your results · the summary across leagues: points summed, exact scores counted once per fixture", () => {
  const app = mounted();
  const a = { weekPts: 7, winner: true, exactIds: new Set(["pl-1"]) };
  const b = { weekPts: 4, winner: false, exactIds: new Set(["pl-1", "pl-9"]) };
  assert.deepEqual(plain(app.box.resultsSummary([a, b])), { leagues: 2, pts: 11, exact: 2, won: 1 });
});

// --- the day's scorecard ------------------------------------------------------------

function scorecard(opts = {}) {
  const extra = Array.from({ length: 10 }, (_, i) => ({ uid: `u-x${i}`, nick: `Mate ${String.fromCharCode(65 + i)}` }));
  const big = {
    ...ROUND13,
    reveal: ROUND13.reveal.map((entry) => ({ ...entry, picks: [...entry.picks,
      ...extra.map((m, i) => pick(m.uid, m.nick, i % 3, 0, entry.id === "pl-1" ? (i % 3 === 2 ? 0 : 1) : 0))] })),
  };
  const screen = { view: "scorecard", d: "2026-11-28", status: "ready", league: "AAA",
    leagues: [{ code: "AAA", name: "Burtons Premier", period: "13", ids: ["pl-1", "pl-2"] }],
    rounds: { AAA: opts.round || big } };
  return mounted({ screen, ...opts });
}

test("scorecard · the day's table: day points, shared ranks, YOU highlighted, 8 then '+ N more mates' in place", () => {
  const app = scorecard();
  const model = app.box.scorecardModel(app.box.matchdayScreen);
  // Saturday only: Adam 5+1, Tom 2+5, Sam 0+2 — Adam and Tom joint 1st on 6? No: 6 and 7.
  assert.deepEqual(plain(model.table.slice(0, 3).map((r) => [r.nick, r.pts, r.rank])), [["Tom", 7, 1], ["Adam", 6, 2], ["Sam", 2, 3]]);
  const table = app.document.querySelector("[data-md-rows='table']");
  const rows = [...table.querySelectorAll(".md-row")];
  assert.equal(rows.length, 13);
  assert.equal(rows.filter((r) => !r.classList.contains("is-extra")).length, 8);
  assert.ok(table.querySelector(".md-row.is-you").textContent.includes("YOU"));
  assert.equal(app.document.querySelector("[data-md-more='table']").textContent, "+ 5 more mates");
  assert.match(app.text(), /Sat 28 Nov · Matchweek 13 Saturday's scorecard/);
});

test("scorecard · each match: FT score, the viewer first, then the top 8 mates by points, honest 'No pick'", () => {
  const app = scorecard();
  const block = app.document.querySelector("[data-scorecard-match='pl-1']");
  assert.match(block.querySelector(".md-match-head").textContent.replace(/\s+/g, " "), /2-2\s*FT/);
  const rows = [...block.querySelectorAll(".md-row")];
  assert.ok(rows[0].classList.contains("is-you"), "the viewer is not first");
  assert.equal(rows[0].querySelector(".pick-pill").textContent, "+5 exact");
  assert.ok(rows[0].querySelector(".pick-pill-exact"));
  // Then by that match's points: Tom +2 ahead of the +1s, the 0s and the no-pick last-but-honest.
  const visible = rows.filter((r) => !r.classList.contains("is-extra")).map((r) => r.querySelector(".md-nick").textContent.trim());
  assert.equal(visible.length, 9, "viewer + 8");
  assert.equal(visible[1], "Tom");
  const sam = rows.find((r) => r.textContent.includes("Sam"));
  assert.match(sam.textContent, /No pick/);
  assert.equal(sam.getAttribute("aria-label"), "Sam, no pick, 0 points");
  assert.equal(sam.querySelector(".pick-pill-none").textContent, "0");
  assert.equal(block.querySelector("[data-md-more]").textContent, "+ 4 more mates");
  // A miss is a grey 0, a right result a purple +N.
  const p2 = app.document.querySelector("[data-scorecard-match='pl-2']");
  assert.equal(p2.querySelector(".md-row.is-you .pick-pill-result").textContent, "+1");
  const miss = mounted({ screen: { ...app.box.matchdayScreen, d: "2026-11-29",
    leagues: [{ code: "AAA", name: "B", period: "13", ids: ["pl-3"] }], rounds: { AAA: ROUND13 } } });
  assert.equal(miss.document.querySelector(".md-row.is-you .pick-pill-miss").textContent, "0");
});

test("scorecard · only the server's revealed picks are shown — a late joiner it left out is not invented", () => {
  const app = scorecard({ round: ROUND13 });
  const names = [...app.document.querySelectorAll("[data-scorecard-match='pl-1'] .md-nick")].map((n) => n.textContent.trim());
  assert.deepEqual(names.sort(), ["Adam YOU", "Sam", "Tom"].sort());
  const hidden = { ...ROUND13, reveal: [{ id: "pl-1", revealed: false }, ROUND13.reveal[1]] };
  const locked = scorecard({ round: hidden });
  assert.equal(locked.document.querySelectorAll("[data-scorecard-match='pl-1'] .md-row").length, 0);
});

test("scorecard · the week-completing day carries the banner to Your results; an earlier day does not", () => {
  const sunday = mounted({ screen: { view: "scorecard", d: "2026-11-29", status: "ready", league: "AAA",
    leagues: [{ code: "AAA", name: "B", period: "13", ids: ["pl-3"] }], rounds: { AAA: ROUND13 } } });
  const banner = sunday.document.querySelector(".md-banner[data-open-results]");
  assert.ok(banner, "no banner on the day the week completed");
  assert.equal(banner.textContent.replace(/\s+/g, " ").trim(), "MATCHWEEK 13 COMPLETE +7 pts · 1 week won Your weekly and season places · See ›");
  assert.equal(scorecard().document.querySelector(".md-banner"), null, "Saturday did not complete the week");
  const open = mounted({ screen: { view: "scorecard", d: "2026-11-29", status: "ready", league: "AAA",
    leagues: [{ code: "AAA", name: "B", period: "13", ids: ["pl-3"] }], rounds: { AAA: { ...ROUND13, complete: false } } } });
  assert.equal(open.document.querySelector(".md-banner"), null);
});

test("scorecard · leagues that played that day, as chips; default the league on screen, else the lowest code", () => {
  const states = {
    BBB: { code: "BBB", name: "Bravo", lineupFixtureIds: ["pl-1"], mixed: false },
    CCC: { code: "CCC", name: "Charlie", lineupFixtureIds: ["pl-3"], mixed: false },
  };
  const app = mounted({ codes: ["CCC", "BBB", "AAA"], states, active: "AAA" });
  const sat = app.box.scorecardLeagues("2026-11-28");
  // CCC published only Sunday's game, so it is not a Saturday league.
  assert.deepEqual(plain(sat.map((l) => [l.code, l.period, l.ids.join()])), [["AAA", "13", "pl-1,pl-2"], ["BBB", "13", "pl-1"]]);
  assert.deepEqual(plain(app.box.scorecardLeagues("2026-11-29").map((l) => l.code)), ["AAA", "CCC"]);
  // Mixed leagues key on their window.
  states.BBB.mixed = true;
  assert.equal(app.box.scorecardLeagues("2026-11-28")[1].period, W13[0].startAt);
  assert.match(sourceOf("loadScorecardScreen"), /screen\.league = \(leagues\.find\(\(league\) => league\.code === activeLeague\) \|\| leagues\[0\]\)\.code;/);
});

// --- the reveal ---------------------------------------------------------------------

const SLOT = Date.parse("2026-11-28T15:00:00Z");
const revealRow = (uid, nick, p1, p2, you = false) => ({ uid, nick, you, p1, p2, noPick: p1 == null });
const REVEAL_ONE = {
  t: SLOT, lockAt: new Date(SLOT).toISOString(), sealedAt: new Date(SLOT + 75000).toISOString(),
  leagues: [{ code: "AAA", name: "Burtons Premier", mixed: false, period: "13", weekLabel: "Matchweek 13", fixtures: [
    { id: "pl-1", player1: "Fulham", player2: "AFC Bournemouth", startAt: new Date(SLOT).toISOString(), total: 12, more: 4,
      rows: [revealRow("u-me", "Adam", 2, 2, true), revealRow("u-tom", "Tom", 1, 1), revealRow("u-sam", "Sam", null, null)] },
  ] }],
};
const REVEAL_TWO = { ...REVEAL_ONE, leagues: [REVEAL_ONE.leagues[0],
  { ...REVEAL_ONE.leagues[0], code: "BBB", name: "Bravo", weekLabel: "Week 9" }] };

function revealApp(answer, { native = true, prefs } = {}) {
  const calls = [];
  const app = mounted({ native, prefs, screen: null });
  app.box.api = async (path) => { calls.push(path); if (answer instanceof Error) throw answer; return answer; };
  app.box.evalIn("var api = globalThis.api;");
  for (const name of ["loadRevealScreen", "shareRevealNow", "drawRevealCard"]) {
    app.box.evalIn(`${sourceOf(name)}\nglobalThis.${name} = ${name};`);
  }
  return { ...app, calls };
}

test("reveal · one pair opens its card: YOU first, 'No pick' plainly, '+ N more mates', share live after the 200", async () => {
  const app = revealApp(REVEAL_ONE);
  const screen = { view: "reveal", t: SLOT, status: "loading" };
  app.box.matchdayScreen = screen;
  await app.box.loadRevealScreen(screen);
  assert.deepEqual(app.calls, [`/reveal-slot?uid=u-me&t=${SLOT}`]);
  assert.equal(screen.pair, "AAA|pl-1");
  app.paint();
  const rows = [...app.document.querySelectorAll("[data-reveal-rows] .md-row")];
  assert.ok(rows[0].classList.contains("is-you") && rows[0].textContent.includes("YOU"));
  assert.match(rows[2].textContent, /No pick/);
  assert.equal(rows[2].getAttribute("aria-label"), "Sam, no pick");
  assert.equal(app.document.querySelector(".md-more-note").textContent, "+ 4 more mates");
  assert.match(app.text(), /Burtons Premier · Matchweek 13/);
  assert.equal(app.document.querySelector("[data-reveal-share]").disabled, false);
  // A reveal carries no points: nothing has finished.
  assert.equal(app.document.querySelectorAll("[data-reveal-rows] .pick-pill").length, 0);
});

test("reveal · several pairs open the hub, grouped by LEAGUE — one fixture in two leagues is two cards", async () => {
  const app = revealApp(REVEAL_TWO);
  const screen = { view: "reveal", t: SLOT, status: "loading" };
  app.box.matchdayScreen = screen;
  await app.box.loadRevealScreen(screen);
  assert.equal(screen.pair, undefined);
  app.paint();
  const leagues = [...app.document.querySelectorAll("[data-reveal-league]")];
  assert.deepEqual(leagues.map((l) => l.querySelector(".md-league-head").textContent.trim()),
    ["Burtons Premier · Matchweek 13", "Bravo · Week 9"]);
  assert.deepEqual(leagues.map((l) => [...l.querySelectorAll("[data-reveal-pair]")].map((b) => b.dataset.revealPair)),
    [["AAA|pl-1"], ["BBB|pl-1"]]);
  assert.equal(app.document.querySelector(".section-head .eyebrow").textContent, "Just kicked off");
  assert.equal(app.document.querySelector(".section-head .pick-summary").textContent, "Picks locked at 15:00");
});

test("reveal · a 409 or a failure is the Slice 1 failure card — no picks, no cache, no share", async () => {
  for (const failure of [new Error("not locked yet"), new Error("Request failed (500)")]) {
    const app = revealApp(failure);
    const screen = { view: "reveal", t: SLOT, status: "loading" };
    app.box.matchdayScreen = screen;
    app.box.loadMatchdayScreen = undefined;
    app.box.evalIn(`${sourceOf("loadMatchdayScreen")}\nglobalThis.loadMatchdayScreen = loadMatchdayScreen;`);
    await app.box.loadMatchdayScreen(screen);
    assert.equal(screen.status, "failed");
    app.paint();
    assert.ok(app.document.querySelector("[data-picks-load-failed]"));
    assert.equal(app.document.querySelector("[data-reveal-share], .md-row"), null);
  }
  // Never drawn from anything but this call's answer.
  for (const fn of ["loadRevealScreen", "revealScreenView", "revealCardView", "shareRevealNow", "drawRevealCard"]) {
    assert.doesNotMatch(sourceOf(fn), /cachedRoundState|localStorage|leagueStates|roundStates/, fn);
  }
});

test("reveal · share is refused unless this session's /reveal-slot answered 200", () => {
  const shared = [];
  const app = mounted({ screen: { view: "reveal", t: SLOT, status: "ready", data: REVEAL_ONE, pair: "AAA|pl-1", shareable: false } });
  app.box.shareCardFile = (pages) => shared.push(pages);
  app.box.evalIn(`var shareCardFile = globalThis.shareCardFile;\n${sourceOf("shareRevealNow")}\nglobalThis.shareRevealNow = shareRevealNow;`);
  assert.equal(app.document.querySelector("[data-reveal-share]").disabled, true);
  app.box.shareRevealNow("AAA|pl-1");
  assert.deepEqual(shared, []);
  assert.match(sourceOf("loadRevealScreen"), /screen\.shareable = true;/);
  assert.equal(sourceOf("loadRevealScreen").indexOf("screen.shareable = true") > sourceOf("loadRevealScreen").indexOf("await api("), true);
});

test("320pt · reveal and scorecard rows never wrap: names ellipsise, picks and pills hold their width", () => {
  const rule = (sel) => {
    const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `no rule for ${sel}`);
    return m[2];
  };
  assert.match(rule(".md-row"), /grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(rule(".md-nick"), /min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
  assert.match(rule(".md-pick"), /white-space: nowrap/);
  assert.match(rule(".md-pill"), /white-space: nowrap/);
});

// --- Matchday alerts: settings and offers --------------------------------------------

const PROFILE = HTML.slice(HTML.indexOf('<dialog id="profileDialog">'), HTML.indexOf("</dialog>", HTML.indexOf('<dialog id="profileDialog">')) + 9);

function settings({ native = true, permission = "granted", answer = {}, afterAsk = "granted", api: apiStub = null, prefs = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${PROFILE}</body>`);
  const { document } = dom.window;
  const posts = [];
  const asked = [];
  const storage = new Map();
  const push = {
    checkPermissions: async () => ({ receive: permission }),
    requestPermissions: async () => { asked.push("request"); permission = afterAsk; return { receive: afterAsk }; },
    register: async () => { asked.push("register"); },
  };
  const box = load(["storeAlertPrefs", "mergedOffers", "applyAlertPrefs", "changeAlertPrefs", "syncAlertPrefs", "loadAlertPrefs", "pushPlugin", "pushPermission", "ensurePushPermission",
    "setAlertPref", "retireAlertOffer", "ALERT_OFFER_COPY", "alertOffer", "ALERT_SWITCHES", "renderMatchdayAlerts",
    "syncAlertCheckboxes", "renderNotificationsDenied"], {
    document, API: "https://api.test", STORAGE: { alertPrefs: "ap", notifyAsk: "ask" },
    readJSON: () => null, isNativeApp: () => native,
    alertPrefs: prefs || { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: false, updatedAt: 0, dirty: false },
    alertPrefsRev: 0, alertPrefsSync: null, alertPrefsAgain: false,
    window: { capacitorPushNotifications: { PushNotifications: push } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    api: apiStub ? (path, body) => { if (body) posts.push(plain(body)); return apiStub(path, body); } : async (path, body) => {
      if (body) { posts.push(plain(body)); return { reveal: false, results: false, offers: {}, ...answer, ...body, offers: { ...(answer.offers || {}), ...(body.offers || {}) } }; }
      return { reveal: false, results: false, offers: { reveal: false, results: false }, ...answer };
    },
  });
  return { box, document, posts, asked, storage };
}

test("Profile · 'Matchday alerts': two boxes, both OFF by default, on native only; reminders untouched", async () => {
  const s = settings();
  await s.box.renderMatchdayAlerts();
  await flush();
  const wrap = s.document.getElementById("matchdayAlerts");
  assert.equal(wrap.hidden, false);
  const rows = [...wrap.querySelectorAll(".notif-row")].map((r) => `${r.querySelector(".notif-label").textContent} ${r.querySelector("small").textContent}`);
  assert.deepEqual(rows, ["Mates' picks revealed One alert per kick-off time, after picks lock",
    "Matchday results Scorecard after your last game each day"]);
  assert.deepEqual([...wrap.querySelectorAll("[data-alert-pref]")].map((b) => b.checked), [false, false]);
  assert.match(wrap.querySelector(".eyebrow").textContent, /^Matchday alerts$/);
  // The reminder boxes are exactly as they were, and no reminders switch was added.
  assert.match(HTML, /<p class="notif-hint">Kick-off reminders, per competition\.<\/p>/);
  assert.doesNotMatch(HTML + APP, /Deadline reminders/);
  const web = settings({ native: false });
  await web.box.renderMatchdayAlerts();
  assert.equal(web.document.getElementById("matchdayAlerts").hidden, true);
});

test("Profile · iOS notifications denied: the message, the Settings button, and every box disabled", async () => {
  const s = settings({ permission: "denied" });
  s.document.getElementById("notificationPrefsList").innerHTML = `<input type="checkbox" data-notif-competition="PL">`;
  await s.box.renderMatchdayAlerts();
  const note = s.document.getElementById("notificationsDenied");
  assert.equal(note.hidden, false);
  assert.equal(note.querySelector("p").textContent,
    "Notifications are off for Prem Oracle in your iPhone Settings, so no reminders or alerts can reach you.");
  assert.equal(note.querySelector("[data-open-ios-settings]").textContent, "Open iPhone Settings");
  assert.ok([...s.document.querySelectorAll("[data-alert-pref], [data-notif-competition]")].every((b) => b.disabled));
  assert.match(sourceOf("openIosSettings"), /"app-settings:"/);
});

test("Profile · ticking a box when iOS was never asked asks on that tap, then saves the whole state", async () => {
  const s = settings({ permission: "prompt" });
  await s.box.renderMatchdayAlerts();
  assert.equal(await s.box.setAlertPref("reveal", true), true);
  await flush();
  assert.deepEqual(s.asked, ["request", "register"]);
  assert.equal(s.posts.length, 1);
  const { updatedAt, ...sent } = s.posts[0];
  assert.deepEqual(sent, { uid: "u1", offers: { reveal: false, results: false }, reveal: true, results: false });
  assert.ok(updatedAt > 0, "a choice carries when it was made");
  assert.equal(s.document.querySelector("[data-alert-pref='reveal']").checked, true);
  // Refused at the prompt: nothing saved, the box falls back.
  const no = settings({ permission: "prompt", afterAsk: "denied" });
  await no.box.renderMatchdayAlerts();
  no.document.querySelector("[data-alert-pref='results']").checked = true;
  assert.equal(await no.box.setAlertPref("results", true), false);
  assert.deepEqual(no.posts, []);
  assert.equal(no.document.querySelector("[data-alert-pref='results']").checked, false);
  // Turning one off never asks anything.
  const off = settings({ permission: "prompt" });
  await off.box.setAlertPref("reveal", false);
  assert.deepEqual(off.asked, []);
});

test("Profile · reminder consent is never reused: the switches read no reminder state, and set none", () => {
  for (const fn of ["setAlertPref", "ensurePushPermission", "renderMatchdayAlerts", "alertOffer", "retireAlertOffer"]) {
    const src = sourceOf(fn);
    assert.doesNotMatch(src, /notifyAsk|mutedCompetitions|maybeOfferReminders|requestReminders/, fn);
  }
  assert.doesNotMatch(sourceOf("setAlertPref"), /mute/);
});

test("offers · once, in context: native, prefs known, switch off, never accepted or dismissed", () => {
  const html = (prefs, native = true) => mounted({ prefs, native }).box.alertOffer("reveal");
  const base = { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true };
  assert.match(html(base), /Get this the moment picks lock\?[\s\S]*data-alert-offer-on="reveal"[\s\S]*data-alert-offer-dismiss="reveal"/);
  assert.equal(html({ ...base, reveal: true }), "", "offered to somebody who already has it");
  assert.equal(html({ ...base, offers: { reveal: true } }), "", "offered again after Turn on or ×");
  assert.equal(html({ ...base, loaded: false }), "", "offered before the server said what is set");
  assert.equal(html(base, false), "", "offered on the web, where no alert can arrive");
  assert.match(mounted({ prefs: base }).box.alertOffer("results"), /Get the scorecard after every matchday\?/);
});

test("offers · Turn on or × retires it on the server, with the prefs (so a reinstall keeps it)", async () => {
  const s = settings();
  await s.box.retireAlertOffer("results");
  // Never chosen on this device: only the offers go, so a dismissal cannot
  // switch off an alert another device turned on.
  assert.deepEqual(s.posts, [{ uid: "u1", offers: { reveal: false, results: true } }]);
  assert.equal(s.box.alertPrefs.offers.results, true);
  // Turn on ticks the very same Profile switch, then retires the offer.
  assert.match(APP, /setAlertPref\(kind, true\)\.finally\(\(\) => retireAlertOffer\(kind\)\);/);
  // The offers sit under the first reveal card and the scorecard.
  assert.match(sourceOf("revealCardView"), /\$\{alertOffer\("reveal"\)\}/);
  assert.match(sourceOf("scorecardScreenView"), /\$\{alertOffer\("results"\)\}/);
});

// --- build 37 · the boxes stick ---------------------------------------------------

/** An api whose answers the test releases one by one. */
function gatedApi(serverFor) {
  const pending = [];
  const fn = (path, body) => new Promise((resolve, reject) => pending.push({ path, body: plain(body), resolve, reject }));
  fn.pending = pending;
  fn.answer = async (i = 0) => { const p = pending.splice(i, 1)[0]; p.resolve(serverFor(p)); await flush(); await flush(); };
  fn.fail = async (i = 0) => { const p = pending.splice(i, 1)[0]; p.reject(new Error("offline")); await flush(); await flush(); };
  return fn;
}
const boxes = (s) => [...s.document.querySelectorAll("[data-alert-pref]")].map((b) => b.checked);
const echo = ({ body }) => ({ ...body, offers: { reveal: false, results: false, ...(body?.offers || {}) }, stale: false });

test("build 37 · rapid tick of both boxes: one save in flight, the second carries both, nothing unticks", async () => {
  const api = gatedApi(({ body }) => echo({ body }));
  const s = settings({ api, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 0, dirty: false } });
  await s.box.renderMatchdayAlerts();
  api.pending.length = 0; // the render's own GET is not under test here
  await s.box.setAlertPref("reveal", true);
  await s.box.setAlertPref("results", true);
  assert.equal(api.pending.length, 1, "two saves in flight at once");
  assert.deepEqual(boxes(s), [true, true]);
  // The first answer only knows about reveal — it must not untick results.
  await api.answer();
  assert.deepEqual(boxes(s), [true, true], "an in-flight answer unticked the other box");
  assert.equal(api.pending.length, 1, "the newer choice was never sent");
  assert.deepEqual([api.pending[0].body.reveal, api.pending[0].body.results], [true, true], "latest save is the whole state");
  await api.answer();
  assert.deepEqual(boxes(s), [true, true]);
  assert.equal(s.box.alertPrefs.dirty, false);
  assert.equal(api.pending.length, 0);
});

test("build 37 · tick, close, reopen within 5s / 60s: a stale GET never unticks a box", async () => {
  const api = gatedApi(({ path, body }) => body ? echo({ body })
    : { reveal: false, results: false, offers: { reveal: false, results: false }, updatedAt: 1 }); // stale server copy
  const s = settings({ api, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 0, dirty: false } });
  await s.box.renderMatchdayAlerts(); api.pending.length = 0;
  await s.box.setAlertPref("reveal", true);
  await s.box.setAlertPref("results", true);
  await api.answer(); await api.answer();
  for (const label of ["5s", "60s"]) {
    await s.box.renderMatchdayAlerts();            // reopen Profile: renders from local, then GETs
    assert.deepEqual(boxes(s), [true, true], `reopen ${label} painted unticked`);
    await api.answer();                            // the stale GET arrives
    assert.deepEqual(boxes(s), [true, true], `a stale GET (${label}) unticked a box`);
  }
});

test("build 37 · a GET answering while a save is in flight is ignored", async () => {
  const api = gatedApi(({ body }) => body ? echo({ body }) : { reveal: false, results: false, offers: {}, updatedAt: 9e15 });
  const s = settings({ api, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 0, dirty: false } });
  await s.box.renderMatchdayAlerts();               // GET pending (index 0)
  await s.box.setAlertPref("reveal", true);         // POST pending (index 1)
  await api.answer(0);                              // the GET lands first, claiming to be newer
  assert.deepEqual(boxes(s), [true, false], "the device's own newer choice was overwritten");
});

test("build 37 · another device chose later: the server's newer choice is adopted", async () => {
  const api = gatedApi(({ body }) => body ? { reveal: false, results: true, offers: {}, updatedAt: 9e15, stale: true } : null);
  const s = settings({ api, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 5, dirty: false } });
  await s.box.renderMatchdayAlerts(); api.pending.length = 0;
  await s.box.setAlertPref("reveal", true);
  await api.answer();
  assert.deepEqual(boxes(s), [false, true]);
  // And a fresh GET from a newer device is adopted on open.
  const api2 = gatedApi(() => ({ reveal: true, results: true, offers: {}, updatedAt: 100 }));
  const t = settings({ api: api2, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 50, dirty: false } });
  await t.box.renderMatchdayAlerts();
  await api2.answer();
  assert.deepEqual(boxes(t), [true, true]);
});

test("build 37 · offline tick: kept ticked, sent on the next open instead of a GET, and on reconnect", async () => {
  const api = gatedApi(({ body }) => echo({ body }));
  const s = settings({ api, prefs: { reveal: false, results: false, offers: { reveal: false, results: false }, loaded: true, updatedAt: 0, dirty: false } });
  await s.box.renderMatchdayAlerts(); api.pending.length = 0;
  await s.box.setAlertPref("reveal", true);
  await api.fail();                                  // offline
  assert.deepEqual(boxes(s), [true, false]);
  assert.equal(s.box.alertPrefs.dirty, true);
  assert.equal(JSON.parse(s.storage.get("ap")).dirty, true, "the unsaved choice survives a relaunch");
  await s.box.renderMatchdayAlerts();                // reopen: must POST the choice, not GET over it
  assert.equal(api.pending.length, 1);
  assert.equal(api.pending[0].body.reveal, true);
  await api.answer();
  assert.equal(s.box.alertPrefs.dirty, false);
  assert.match(APP, /addEventListener\("online", \(\) => \{ if \(alertPrefs\.dirty\) syncAlertPrefs\(\); \}\)/);
});

// --- F5 · the finished row's grey ---------------------------------------------------

test("F5 · a SETTLED row is grey (#ECEFF4 / #DCE1E8); open, locked, in-play, void and postponed stay white", () => {
  const rows = [
    fx("open", { at: now + 2 * DAY }), { ...fx("locked", { at: now + HOUR }), lockAt: new Date(now - HOUR).toISOString() },
    fx("live", { at: now - HOUR }), fx("done", { at: now - DAY, result: [1, 0] }),
    fx("void", { at: now - DAY, status: "abandoned" }), fx("pp", { at: now - DAY, status: "postponed" }),
  ];
  const state = leagueState13({ currentPeriod: "13", awaitingPublish: false,
    currentSlate: { period: "13", matchweek: 13, status: "published", fixtureIds: rows.map((r) => r.id), count: rows.length } });
  const app = mounted({ state, fixtures: rows, rounds: {} });
  const grey = [...app.document.querySelectorAll("[data-pick-row]")].filter((r) => r.classList.contains("is-finished")).map((r) => r.dataset.pickRow);
  assert.deepEqual(grey, ["done"]);
  const rule = /\.pick-row\.is-finished \{([^}]*)\}/.exec(CSS)[1];
  assert.match(rule, /background: #ECEFF4;/);
  assert.match(rule, /border-color: #DCE1E8;/);
  // Muted text on the grey is darkened so it keeps 4.5:1 (#475569 is 6.6:1; #64748B would be 4.1:1).
  assert.match(CSS, /\.pick-row\.is-finished \.pick-row-you \{ color: #475569; \}/);
  const contrast = (a, b) => {
    const lum = (h) => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  assert.ok(contrast("#475569", "#ECEFF4") >= 4.5);
  assert.ok(contrast("#17202A", "#ECEFF4") >= 4.5);
});

// --- build 38 · the scorecard opens fast ------------------------------------------

const settledReveal = (ids, extra = {}) => ids.map((id) => ({ id, settled: true, voided: false, picks: [], ...extra }));
const DAY_LEAGUES = [
  { code: "AAA", name: "A", period: "13", ids: ["pl-1", "pl-2"] },
  { code: "BBB", name: "B", period: "13", ids: ["pl-1"] },
];

function loaderBox({ copies = {}, network = {}, hang = false, gate = null } = {}) {
  const calls = [];
  const renders = [];
  const box = load(["loadScorecardScreen", "dayFullySettled", "usableRound"], {
    loadFixturesForLeagues: async () => {},
    scorecardLeagues: () => DAY_LEAGUES,
    activeLeague: "AAA",
    cachedRoundState: (code, period) => copies[`${code}:${period}`] || null,
    loadMatchdayRound: (code, period) => {
      calls.push(`${code}:${period}`);
      if (hang && code !== "AAA") return new Promise(() => {});      // never answers
      return (gate || Promise.resolve()).then(() => network[`${code}:${period}`] || null);
    },
    ensureResultsRounds: () => (hang ? new Promise(() => {}) : Promise.resolve(0)),
    matchdayScreenView: () => JSON.stringify(box.matchdayScreen?.rounds || {}),
    render: () => renders.push(1),
  });
  return { box, calls, renders };
}

test("build 38 · a fully settled day draws from the device copy with no request at all", async () => {
  const copies = { "AAA:13": { reveal: settledReveal(["pl-1", "pl-2"]) }, "BBB:13": { reveal: settledReveal(["pl-1"]) } };
  const { box, calls } = loaderBox({ copies });
  const screen = { view: "scorecard", d: "2026-11-24", league: "AAA" };
  box.matchdayScreen = screen;
  await box.loadScorecardScreen(screen);
  await screen.settling;
  assert.equal(screen.status, "ready");
  assert.equal(screen.from, "device");
  assert.deepEqual(calls, [], "a settled day asked the network");
});

test("build 38 · a day not fully settled when saved draws at once, then refreshes quietly and repaints only if changed", async () => {
  const copies = { "AAA:13": { reveal: [{ id: "pl-1", settled: true, picks: [] }, { id: "pl-2", revealed: true }] } };
  const network = { "AAA:13": { reveal: settledReveal(["pl-1", "pl-2"]) }, "BBB:13": { reveal: settledReveal(["pl-1"]) } };
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const { box, calls, renders } = loaderBox({ copies, network, gate });
  const screen = { view: "scorecard", d: "2026-11-24", league: "AAA", paintedView: "" };
  box.matchdayScreen = screen;
  await box.loadScorecardScreen(screen);
  assert.equal(screen.status, "ready");
  assert.equal(screen.from, "device+refresh");
  assert.equal(screen.rounds.AAA, copies["AAA:13"], "did not draw the device copy first");
  open();
  await screen.settling;
  assert.deepEqual(calls.sort(), ["AAA:13", "BBB:13"]);
  assert.equal(screen.rounds.AAA, network["AAA:13"]);
  assert.equal(renders.length, 1, "the quiet refresh did not repaint the changed screen");
});

test("build 38 · first open waits only for the chosen league — never for other leagues or the banner", async () => {
  const network = { "AAA:13": { reveal: settledReveal(["pl-1", "pl-2"]) } };
  const { box } = loaderBox({ network, hang: true });
  const screen = { view: "scorecard", d: "2026-11-24", league: "AAA" };
  box.matchdayScreen = screen;
  const done = await Promise.race([box.loadScorecardScreen(screen).then(() => "loaded"), new Promise((r) => setTimeout(() => r("blocked"), 200))]);
  assert.equal(done, "loaded", "the screen waited on another league or the banner");
  assert.equal(screen.status, "ready");
  assert.equal(screen.from, "network");
});

test("build 38 · My Picks prefetches each settled day once per league+day, one request per week, none when held", () => {
  const app = mounted();
  app.box.scorecardPrefetched.clear();
  app.fetched.length = 0;
  app.timers.length = 0;
  const legs = [{ code: "AAA", name: "A", period: "99", ids: ["pl-1"] }];   // a week the device does not hold
  app.box.scorecardLeagues = () => legs;
  app.box.prefetchScorecards(["2026-11-28", "2026-11-29"]);  // two days, same week
  app.box.prefetchScorecards(["2026-11-28", "2026-11-29"]);  // a repaint
  assert.equal(app.timers.length, 1, "prefetch ran during the paint or was scheduled twice");
  app.timers[0]();
  assert.deepEqual(app.fetched, ["AAA:99"], "not one request for the week");
  // A day the device already holds settled is not fetched at all.
  const held = mounted({ rounds: { "AAA:13": ROUND13, "AAA:99": { reveal: settledReveal(["pl-1"]) } } });
  held.box.scorecardPrefetched.clear(); held.timers.length = 0;
  held.box.scorecardLeagues = () => legs;
  held.box.prefetchScorecards(["2026-11-30"]);
  assert.equal(held.timers.length, 0);
  assert.match(sourceOf("scorecardLinks"), /prefetchScorecards\(done\);/);
});

test("build 38 · the diagnostics timer: last ten opens, tap to content, and nothing identifying", () => {
  const box = load(["noteScorecardOpen", "scorecardOpenLines"], { scorecardOpens: [], clockMs: () => 1000 });
  for (let i = 0; i < 12; i++) box.noteScorecardOpen({ status: "ready", openedAt: 1000 - (i + 1) * 10, from: i % 2 ? "device" : "network" });
  box.noteScorecardOpen({ status: "failed", openedAt: 0 });
  assert.equal(box.scorecardOpens.length, 10);
  const lines = box.scorecardOpenLines();
  assert.equal(lines[1], "scorecard opens — ms tap to content (newest last):");
  assert.equal(lines.at(-1), "  120 ms  device");
  assert.doesNotMatch(lines.join("\n"), /uid|AAA|2026/);
  assert.match(sourceOf("diagnosticsText"), /\.\.\.scorecardOpenLines\(\)/);
  assert.match(sourceOf("loadMatchdayScreen"), /noteScorecardOpen\(screen\)/);
});

test("build 38 · day share card: 'TUESDAY'S TOP SCORER' / '2 pts'; tie: 'TUESDAY'S JOINT TOP SCORERS'", () => {
  const cards = [];
  const box = load(["shareScorecardNow"], {
    ukWeekday: () => "Tuesday", ukShortDate: () => "24 Nov",
    inviteLinkFor: (c) => `https://x/${c}`,
    weeklyCardGeometry: () => ({ hero: 1, m: { pages: 1 } }),
    drawWeeklyPage: (card) => { cards.push(card); return {}; },
    cardPng: () => ({}), shareCardFile: () => {},
  });
  const run = (table) => {
    box.matchdayScreen = { view: "scorecard", status: "ready", d: "2026-11-24" };
    box.scorecardModel = () => ({ league: { name: "L", code: "AAA", period: "13" }, table });
    box.shareScorecardNow();
    return cards.at(-1);
  };
  const one = run([{ nick: "Adam", pts: 2, rank: 1 }, { nick: "Bex", pts: 1, rank: 2 }]);
  assert.deepEqual([one.heroEyebrow, one.heroName, one.heroLine], ["TUESDAY'S TOP SCORER", "Adam", "2 pts"]);
  const tie = run([{ nick: "Adam", pts: 2, rank: 1 }, { nick: "Bex", pts: 2, rank: 1 }]);
  assert.deepEqual([tie.heroEyebrow, tie.heroName, tie.heroLine], ["TUESDAY'S JOINT TOP SCORERS", "Adam & Bex", "2 pts"]);
  const none = run([{ nick: "Adam", pts: 0, rank: 1 }]);
  assert.deepEqual([none.heroEyebrow, none.heroName, none.heroLine], ["TUESDAY'S TOP SCORER", "Nobody", "0 pts"]);
  assert.doesNotMatch(JSON.stringify([one, tie, none].map((c) => c.heroEyebrow + c.heroLine)), /Week|Matchweek/);
});
