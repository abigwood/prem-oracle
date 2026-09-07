// v1.7 Slice D — executed acceptance for Slices B and C.
//
// Slice A's suite owns the shell contract (which league, which week, what the
// empty state says). This owns what B and C added: the compact card states, the
// one-at-a-time expansions, and the two square exports — including the things
// that must NEVER appear, which are the assertions worth having.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, constOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const HOUR = 3600000;
const now = Date.now();

/** A fixture in a chosen state, at a chosen distance from now. */
const fx = (id, { hours = 24, result = null, status = null, teams = ["Home", "Away"] } = {}) => ({
  id, player1: teams[0], player2: teams[1], matchday: 7,
  startAt: new Date(now + hours * HOUR).toISOString(),
  ...(result ? { result, status: status || "complete" } : status ? { status } : {}),
});

const OPEN = fx("f-open", { hours: 48 });
// Locked: past the lock boundary the reveal gate uses, not yet kicked off.
const LOCKED = { ...fx("f-locked", { hours: 3 }), lockAt: new Date(now - HOUR).toISOString() };
const IN_PLAY = fx("f-inplay", { hours: -1 });
const SETTLED = fx("f-settled", { hours: -26, result: [2, 1] });
const VOID = fx("f-void", { hours: -26, status: "abandoned" });
const POSTPONED = fx("f-post", { hours: -26, status: "postponed" });
const ALL = [OPEN, LOCKED, IN_PLAY, SETTLED, VOID, POSTPONED];

const leagueState = ({ code = "AAA", name = "Sunday Six", period = "7", ids, count = null } = {}) => ({
  code, name, currentPeriod: period,
  currentSlate: ids === null ? null
    : { period, matchweek: Number(period) || null, status: "published", fixtureIds: ids, count: count ?? ids.length },
  table: [], owner: "u-me",
});

const VIEW_NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekHead", "matchweekContext", "matchweekEmpty", "matchweekUnavailable",
  "matchweekView", "matchweekRowState", "matchweekRowMark", "MATCHWEEK_ROW_LINE",
  "fixtureRow", "shortKickoff", "closedStatus", "matchOpen", "finalScore",
  "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickRow", "pickProgress", "pickDeadlineLine", "expandPick", "pickEditable",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "scorePickLocal", "RESULT_FIRST_STATES",
];

const BASE = {
  picks: {},
  leagueNames: {},
  expandedFixtureId: null,
  expandedPickId: null,
  matchweekCountMismatches: new Map(),
  periodLabel: (p) => `Matchweek ${p}`,
  pulsingStatus: (m) => `<p class="pulse">${m}</p>`,
  onboardingState: () => `<div class="onboarding"></div>`,
  leagueSwitcher: () => "",
  playerName: "Adam",
  scorePicker: (match) => `<div class="score-picker" data-picker="${match.id}"></div>`,
  matchCard: (m) => `<div data-match-card="${m.id}"></div>`,
  fixtureRevealSection: () => `<section class="fixture-reveal">MATES</section>`,
  pickRevealSection: () => "",
  countPhrase: (n, word) => `${n} ${word}`,
  uid: () => "u-me",
};

function box(overrides = {}) {
  const { ids = ALL.map((f) => f.id), picks = {}, ...rest } = overrides;
  return load(VIEW_NAMES, {
    ...BASE,
    fixtures: ALL,
    picks,
    activeLeague: "AAA",
    leagueState: leagueState({ ids }),
    leagueStates: {},
    leagueCodes: ["AAA"],
    ...rest,
  });
}

const rows = (html) => [...html.matchAll(/data-(?:fixture-row|pick-row|matchweek-unavailable)="([^"]+)"/g)]
  .map((m) => m[1]);

// --- D1 · slate sizes -------------------------------------------------------

test("D1 · both surfaces render minimum, common and maximum slates", () => {
  for (const size of [1, 3, 6, 20]) {
    const ids = Array.from({ length: size }, (_, i) => `s-${i}`);
    const fixtures = ids.map((id, i) => fx(id, { hours: 24 + i }));
    const s = load(VIEW_NAMES, {
      ...BASE, fixtures, activeLeague: "AAA",
      leagueState: leagueState({ ids }), leagueStates: {}, leagueCodes: ["AAA"],
    });
    assert.deepEqual(rows(s.matchweekView()), ids, `Matchweek lost order at ${size}`);
    assert.deepEqual(rows(s.picksView()), ids, `My Picks lost order at ${size}`);
    assert.match(s.matchweekView(), new RegExp(`${size} selected game`));
    assert.match(s.picksView(), new RegExp(`0 of ${size} complete`));
  }
});

test("D1 · My Picks counts N of M from the slate, not from the calendar", () => {
  const s = box({ ids: [OPEN.id, LOCKED.id, SETTLED.id], picks: { [OPEN.id]: { p1: 1, p2: 0 }, [SETTLED.id]: { p1: 2, p2: 1 } } });
  assert.match(s.picksView(), /2 of 3 complete/);
  const progress = s.pickProgress(s.matchweekSlots(s.matchweekSlate()));
  assert.deepEqual({ ...progress }, { complete: 2, total: 3 });
});

// --- D2 · the six card states ----------------------------------------------

test("D2 · every card state resolves, and says exactly one honest line", () => {
  const s = box();
  const expected = {
    [OPEN.id]: "open", [LOCKED.id]: "locked", [IN_PLAY.id]: "in-progress",
    [SETTLED.id]: "settled", [VOID.id]: "void", [POSTPONED.id]: "postponed",
  };
  for (const fixture of ALL) {
    assert.equal(s.matchweekRowState(fixture), expected[fixture.id], `${fixture.id} resolved wrongly`);
  }
  const html = s.matchweekView();
  for (const [id, state] of Object.entries(expected)) {
    assert.ok(html.includes(`data-row-state="${state}"`), `${id} lost its state marker`);
  }
  // Postponed and void say no points; neither invents a result.
  assert.match(html, /Void — no points/);
  assert.match(html, /Postponed — no points/);
});

test("D2 · no provisional points anywhere, on either surface", () => {
  const s = box({ picks: Object.fromEntries(ALL.map((f) => [f.id, { p1: 1, p2: 1 }])) });
  for (const [label, html] of [["Matchweek", s.matchweekView()], ["My Picks", s.picksView()]]) {
    // An in-progress fixture states pending, and never a score of our own.
    assert.match(html, /points pending settlement|Awaiting final score/, `${label} says nothing about pending`);
    assert.ok(!/provisional/i.test(html), `${label} mentions provisional`);
  }
  // The source rule: the in-progress line is a constant, not a computation.
  assert.match(constOf("MATCHWEEK_ROW_LINE"), /"in-progress": "In progress · points pending settlement"/);
});

test("D2 · a settled row leads with the final score", () => {
  const s = box({ ids: [SETTLED.id], picks: { [SETTLED.id]: { p1: 2, p2: 1 } } });
  const mw = s.matchweekView();
  assert.match(mw, /fixture-row-final">2<span class="result-sep">–<\/span>1/);
  // And on My Picks the settled row is the result card: score first, then the
  // prediction and its points (B8).
  const mine = s.picksView();
  const scoreAt = mine.indexOf("result-score");
  const pickAt = mine.indexOf("result-pick");
  assert.ok(scoreAt > -1 && pickAt > scoreAt, "the prediction is not beneath the score");
  assert.match(mine, /result-card/);
});

test("D2 · My Picks shows controls only on the open row, and never after lock", () => {
  const s = box({ ids: [OPEN.id, LOCKED.id, SETTLED.id] });
  const closed = s.picksView();
  assert.ok(!closed.includes("score-picker"), "controls appear before anything is expanded");

  s.evalIn(`expandedPickId = ${JSON.stringify(OPEN.id)};`);
  const openRow = s.picksView();
  assert.equal((openRow.match(/data-picker=/g) || []).length, 1, "more than one row has controls");
  assert.match(openRow, new RegExp(`data-picker="${OPEN.id}"`));

  // A locked row cannot produce controls even when it is the expanded id.
  s.evalIn(`expandedPickId = ${JSON.stringify(LOCKED.id)};`);
  assert.ok(!s.picksView().includes("score-picker"), "a locked row offered controls");
});

test("D2 · after lock My Picks states the saved prediction plainly", () => {
  const s = box({ ids: [LOCKED.id], picks: { [LOCKED.id]: { p1: 3, p2: 0 } } });
  assert.match(s.picksView(), /Locked · your pick 3-0/);
  const none = box({ ids: [LOCKED.id] });
  assert.match(none.picksView(), /Locked · no pick made/);
});

// --- D3 · one at a time -----------------------------------------------------

test("D3 · only one row can be expanded on each surface", () => {
  const s = box();
  s.evalIn(`expandedFixtureId = ${JSON.stringify(OPEN.id)}; expandedPickId = ${JSON.stringify(OPEN.id)};`);
  assert.equal((s.matchweekView().match(/data-match-card=/g) || []).length, 1);
  assert.equal((s.picksView().match(/data-picker=/g) || []).length, 1);
  // The state is a single id, not a set — the shape makes two impossible.
  assert.match(sourceOf("expandPick"), /const wanted = expandedPickId === String\(id\) \? null : String\(id\);/);
  assert.match(sourceOf("expandFixture"), /const wanted = expandedFixtureId === String\(id\) \? null : String\(id\);/);
});

test("D3 · expanding never re-renders, so scroll is preserved", () => {
  for (const fn of ["expandPick", "expandFixture", "togglePickReveal"]) {
    const body = sourceOf(fn);
    assert.ok(!/\brender\(/.test(body), `${fn} re-renders the view`);
  }
});

// --- D4 · privacy before authorisation --------------------------------------

test("D4 · My Picks carries no mates section at all (B10)", () => {
  const s = box({ ids: [SETTLED.id], picks: { [SETTLED.id]: { p1: 2, p2: 1 } } });
  const mine = s.picksView();
  assert.ok(!mine.includes("MATES"), "the personal surface drew the mates section");
  assert.ok(!mine.includes("fixture-reveal"), "the personal surface drew a reveal");
  assert.match(mine, /pick-social-link/, "and it does not say where the social view is");
  // Matchweek still has it.
  s.evalIn(`expandedFixtureId = ${JSON.stringify(SETTLED.id)};`);
  assert.match(s.matchweekView(), /data-match-card=/);
});

test("D4 · a pre-lock card exposes no mate values, by construction", () => {
  // The client cannot invent them: the reveal comes from the server payload,
  // and matesFixtureView refuses to build rows without a revealed entry.
  const s = load(["matesFixtureView", "revealRows", "sharedRankByUid", "clientLockMs"], {
    ...BASE, fixtures: ALL, picks: {},
  });
  const view = s.matesFixtureView(OPEN, undefined, [], "u-me");
  assert.equal(view.state, "locked");
  assert.deepEqual([...view.rows], []);
  const unrevealed = s.matesFixtureView(LOCKED, { id: LOCKED.id, revealed: false, lockedIn: 2, eligible: 3 }, [], "u-me");
  assert.equal(unrevealed.state, "locked");
  assert.deepEqual([...unrevealed.rows], [], "rows were built without server authorisation");
});

// --- D5 · multi-league ------------------------------------------------------

test("D5 · overlapping fixtures across leagues never blend", () => {
  const shared = [LOCKED.id, SETTLED.id];
  const aaa = leagueState({ code: "AAA", name: "Sunday Six", ids: [OPEN.id, ...shared] });
  const bbb = leagueState({ code: "BBB", name: "Bury Legends", ids: [...shared, VOID.id] });
  for (const [active, state, expected] of [
    ["AAA", aaa, [OPEN.id, ...shared]],
    ["BBB", bbb, [...shared, VOID.id]],
  ]) {
    const s = load(VIEW_NAMES, {
      ...BASE, fixtures: ALL, picks: {}, activeLeague: active,
      leagueState: state, leagueStates: { AAA: aaa, BBB: bbb }, leagueCodes: ["AAA", "BBB"],
    });
    assert.deepEqual(rows(s.matchweekView()), expected, `${active} Matchweek blended`);
    assert.deepEqual(rows(s.picksView()), expected, `${active} My Picks blended`);
  }
});

test("D5 · rapid switching lands on the final selection, on both surfaces", () => {
  const aaa = leagueState({ code: "AAA", name: "Sunday Six", ids: [OPEN.id] });
  const bbb = leagueState({ code: "BBB", name: "Bury Legends", ids: [SETTLED.id] });
  for (const stale of [aaa, bbb, null, { code: "AAA", error: "x" }]) {
    const s = load(VIEW_NAMES, {
      ...BASE, fixtures: ALL, picks: {}, activeLeague: "BBB",
      leagueState: stale, leagueStates: { AAA: aaa, BBB: bbb }, leagueCodes: ["AAA", "BBB"],
    });
    assert.deepEqual(rows(s.matchweekView()), [SETTLED.id], "a stale global won on Matchweek");
    assert.deepEqual(rows(s.picksView()), [SETTLED.id], "a stale global won on My Picks");
    assert.ok(!s.picksView().includes("Sunday Six"));
  }
});

test("D5 · a switch closes both open rows", () => {
  const fn = sourceOf("setActiveLeague");
  assert.match(fn, /expandedFixtureId = null;/);
  assert.match(fn, /expandedPickId = null;/);
});

// --- D6 · the exports -------------------------------------------------------

const SHARE_NAMES = ["weeklyTerminalCount", "weeklyShareStatus", "seasonShareFreshness",
  "shareIconButton", "shareCardState", "seasonCardModel", "podiumCounts",
  "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES"];

function shareBox(overrides = {}) {
  return load(SHARE_NAMES, {
    ...BASE,
    fixtures: ALL,
    activeLeague: "AAA",
    leagueTab: "matchday",
    selectedPeriod: "7",
    roundState: null,
    leagueState: leagueState({ ids: [] }),
    leagueStates: {},
    leagueCodes: ["AAA"],
    seasonRounds: () => 38,
    currentPeriodKey: () => "7",
    leagueSupportsRounds: () => true,
    inviteLinkFor: (code) => `https://x/${code}`,
    ...overrides,
  });
}

const round = (n, entries, { complete = false } = {}) => ({
  matchday: n, period: String(n), complete,
  slate: { period: String(n), fixtureIds: entries.map((e) => e.id), count: entries.length },
  reveal: entries,
  table: [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1 }],
});

test("D6 · weekly export states 0 of M, X of M and Final", () => {
  const six = (settled, voided = 0) => Array.from({ length: 6 }, (_, i) => ({
    id: `w-${i}`,
    ...(i < settled ? { settled: true } : i < settled + voided ? { voided: true } : {}),
  }));
  const s = shareBox();
  assert.equal(s.weeklyShareStatus(round(3, six(0))).label, "Week 3 · not started · 0 of 6 fixtures");
  assert.equal(s.weeklyShareStatus(round(3, six(2))).label, "Week 3 · in progress · after 2 of 6");
  // A VOID advances the count and contributes no points.
  assert.equal(s.weeklyShareStatus(round(3, six(2, 1))).label, "Week 3 · in progress · after 3 of 6");
  assert.equal(s.weeklyShareStatus(round(3, six(6))).label, "Week 3 · Final");
  assert.equal(s.weeklyShareStatus(round(3, six(4, 2))).label, "Week 3 · Final");
  // Final only when EVERY slot is terminal.
  assert.equal(s.weeklyShareStatus(round(3, six(5))).final, false);
});

test("D6 · the server's own completion is the authority for Final", () => {
  const s = shareBox();
  const partial = round(3, [{ id: "a", settled: true }, { id: "b" }], { complete: true });
  assert.equal(s.weeklyShareStatus(partial).final, true,
    "a round the server calls complete was not Final");
  assert.match(sourceOf("weeklyShareStatus"), /round\?\.complete === true/);
});

test("D6 · a void is terminal but scores nothing", () => {
  const s = shareBox();
  const counted = s.weeklyTerminalCount(round(3, [
    { id: "a", settled: true }, { id: "b", voided: true }, { id: "c" },
  ]));
  assert.deepEqual({ ...counted }, { terminal: 2, total: 3 });
});

test("D6 · weekly sharing is offered from publication, not settlement", () => {
  const running = round(3, [{ id: "a", settled: true }, { id: "b" }]);
  const s = shareBox({ roundState: running });
  const state = s.shareCardState();
  assert.equal(state.ready, true, "an unsettled week refused to share");
  assert.match(state.label, /^Share Matchweek 3 standings$/);
  assert.ok(!/shares once/.test(state.label));
});

test("D6 · the season control names its freshness", () => {
  const s = shareBox({
    leagueTab: "season",
    leagueState: { ...leagueState({ ids: [] }), table: [{ uid: "u1", nick: "Adam", pts: 4 }], currentMatchday: 5, currentMatchdayHasResults: false },
  });
  assert.match(s.shareCardState().label, /^Share season table, Updated through Matchweek 4$/);
  assert.equal(s.seasonShareFreshness({ currentMatchday: 5, currentMatchdayHasResults: true }), "Updated through Matchweek 5");
  assert.equal(s.seasonShareFreshness({ currentMatchday: 1, currentMatchdayHasResults: false }), "Updated before Matchweek 1");
});

test("D6 · the season card exports the WHOLE table, never a top five", () => {
  const table = Array.from({ length: 30 }, (_, i) => ({
    uid: `u${i}`, rank: i + 1, nick: `Player ${i}`, pts: 100 - i, exact: i % 4,
  }));
  const s = shareBox({ leagueTab: "season", leagueState: { ...leagueState({ ids: [] }), table, currentMatchday: 9, currentMatchdayHasResults: true } });
  const model = s.seasonCardModel({ ...leagueState({ ids: [] }), table, currentMatchday: 9, currentMatchdayHasResults: true });
  assert.equal(model.rows.length, 30, "the season card truncated the table");
  assert.deepEqual([...model.rows].map((r) => r.rank), table.map((r) => r.rank));
  assert.match(sourceOf("seasonCardModel"), /\(state\.table \|\| \[\]\)\.map/);
  assert.ok(!/slice\(0,\s*\d+\)/.test(sourceOf("seasonCardModel")), "the season model slices");
});

test("D6 · the share control is an icon with a precise name and a 44pt target", () => {
  const s = shareBox({ roundState: round(3, [{ id: "a", settled: true }]) });
  const html = s.shareIconButton({ code: "AAA" });
  assert.match(html, /class="share-icon"/);
  assert.match(html, /<svg/);
  assert.match(html, /aria-label="Share Matchweek 3 standings"/);
  assert.match(html, /aria-hidden="true"/, "the glyph is not hidden from readers");
  // No text label inside the control.
  assert.ok(!/>Share</.test(html.replace(/aria-label="[^"]*"/g, "").replace(/title="[^"]*"/g, "")));
  assert.match(CSS, /\.share-icon \{[^}]*width:\s*44px/);
  assert.match(CSS, /\.share-icon \{[^}]*height:\s*44px/);
});

test("D6 · exporting makes no network request", () => {
  for (const fn of ["shareCardNow", "weeklyCardModel", "seasonCardModel",
    "weeklyShareStatus", "seasonShareFreshness", "weeklyTerminalCount"]) {
    const body = sourceOf(fn);
    assert.ok(!/\bfetch\(|\bapi\(|XMLHttpRequest/.test(body), `${fn} reaches the network`);
  }
  assert.match(sourceOf("shareCardNow"), /cardPng\(/);
});

test("D6 · the cards carry names and settled points, never predictions", () => {
  const table = [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 2 }];
  const s = shareBox({ leagueState: { ...leagueState({ ids: [] }), table } });
  const model = s.seasonCardModel({ ...leagueState({ ids: [] }), table, currentMatchday: 3, currentMatchdayHasResults: true });
  const text = JSON.stringify(model);
  for (const forbidden of ["\"p1\"", "\"p2\"", "recovery", "pushToken"]) {
    assert.ok(!text.includes(forbidden), `the season card carries ${forbidden}`);
  }
  assert.deepEqual(Object.keys({ ...model.rows[0] }).sort(), ["exact", "honours", "nick", "pts", "rank"]);
});

// --- D7 · the DOM, for real -------------------------------------------------

test("D7 · sharing is a real 44x44 button that opens the sheet and keeps state", () => {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`);
  const { document } = dom.window;
  const s = shareBox({ roundState: round(3, [{ id: "a", settled: true }]) });
  document.getElementById("app").innerHTML = s.shareIconButton({ code: "AAA" });
  const button = document.querySelector("[data-export-league-table]");
  assert.ok(button, "the parser produced no control");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("aria-label"), "Share Matchweek 3 standings");
  assert.equal(button.dataset.exportLeagueTable, "AAA");
  // The delegated handler answers it, synchronously, above every await.
  const handler = APP.slice(APP.indexOf('document.addEventListener("click", async (event) => {'));
  const head = handler.slice(0, handler.indexOf("const leagueCountStep"));
  assert.match(head, /data-export-league-table/);
  assert.ok(!/await/.test(head.replace(/\/\/[^\n]*/g, "")),
    "an await precedes the share branch, which would end the gesture");
});

test("D7 · cancelling or completing a share changes no screen state", () => {
  // shareCardFile draws, hands the file over and returns. It sets no view
  // state, so there is nothing for a cancel to leave behind.
  const body = sourceOf("shareCardFile");
  for (const mutation of ["currentView =", "render(", "expandedFixtureId =", "expandedPickId =",
    "activeLeague =", "leagueTab ="]) {
    assert.ok(!body.includes(mutation), `shareCardFile mutates ${mutation}`);
  }
  assert.ok(!sourceOf("shareCardNow").includes("render("), "shareCardNow re-renders");
});

// --- D8 · worst shape -------------------------------------------------------

test("D8 · the worst supported shape stays inside the synchronous budget", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `w-${i}`);
  const fixtures = ids.map((id, i) => fx(id, { hours: i % 3 === 0 ? -26 : 24 + i, result: i % 3 === 0 ? [1, 0] : null }));
  const picks = Object.fromEntries(ids.map((id) => [id, { p1: 1, p2: 1 }]));
  const s = load(VIEW_NAMES, {
    ...BASE, fixtures, picks, activeLeague: "AAA",
    leagueState: leagueState({ ids }), leagueStates: {}, leagueCodes: ["AAA"],
  });
  for (const [label, fn] of [["Matchweek", () => s.matchweekView()], ["My Picks", () => s.picksView()]]) {
    fn();
    const times = [];
    for (let i = 0; i < 21; i++) { const t = performance.now(); fn(); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    const ms = times[10];
    console.log(`    ${label} at 20 fixtures: ${ms.toFixed(2)}ms`);
    assert.ok(ms < 50, `${label} took ${ms.toFixed(2)}ms`);
  }
});

test("D8 · a 30-member season card is built without truncation", () => {
  const table = Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, rank: i + 1, nick: `Player ${i}`, pts: 90 - i, exact: 1 }));
  const s = shareBox({ leagueTab: "season" });
  const t0 = performance.now();
  const model = s.seasonCardModel({ ...leagueState({ ids: [] }), table, currentMatchday: 20, currentMatchdayHasResults: true });
  const ms = performance.now() - t0;
  console.log(`    season card model, 30 members: ${ms.toFixed(2)}ms`);
  assert.equal(model.rows.length, 30);
  assert.ok(ms < 50);
});
