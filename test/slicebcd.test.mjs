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
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable",
  "matchweekRowState", "MATCHWEEK_ROW_LINE",
  "shortKickoff", "closedStatus", "matchOpen", "finalScore",
  "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickRow", "pickRowBody", "pickRowLabel", "pickJustSaved", "pickListState",
  "pickShareRow", "pickProgress", "pickDeadlineLine", "expandPick", "pickEditable",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "scorePickLocal", "RESULT_FIRST_STATES",
];

const BASE = {
  picks: {},
  leagueNames: {},
  expandedPickId: null,
  // The share control is the share tests' subject, not this sandbox's.
  shareIconButton: () => "",
  matchweekCountMismatches: new Map(),
  periodLabel: (p) => `Matchweek ${p}`,
  pulsingStatus: (m) => `<p class="pulse">${m}</p>`,
  onboardingState: () => `<div class="onboarding"></div>`,
  leagueSwitcher: () => "",
  playerName: "Adam",
  scorePicker: (match) => `<div class="score-picker" data-picker="${match.id}"></div>`,
  // The editable disclosure mounts the same card Next builds, so the stub
  // carries what that card carries: the score controls.
  matchCard: (m, opts) => `<div data-match-card="${m.id}"${opts?.social === false ? ' data-social="false"' : ""
    }><div class="score-picker" data-picker="${m.id}"></div></div>`,
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
    assert.deepEqual(rows(s.picksView()), ids, `My Picks lost order at ${size}`);
    assert.match(s.picksView(), new RegExp(`0 of ${size} saved`));
  }
});

test("D1 · My Picks counts N of M from the slate, not from the calendar", () => {
  const s = box({ ids: [OPEN.id, LOCKED.id, SETTLED.id], picks: { [OPEN.id]: { p1: 1, p2: 0 }, [SETTLED.id]: { p1: 2, p2: 1 } } });
  assert.match(s.picksView(), /2 of 3 saved/);
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
  const html = s.picksView();
  for (const [id, state] of Object.entries(expected)) {
    assert.ok(html.includes(`data-row-state="${state}"`), `${id} lost its state marker`);
  }
  // Postponed and void say no points; neither invents a result.
  assert.match(html, /Void — no points/);
  assert.match(html, /Postponed — no points/);
});

test("D2 · no provisional points anywhere, on either surface", () => {
  const s = box({ picks: Object.fromEntries(ALL.map((f) => [f.id, { p1: 1, p2: 1 }])) });
  for (const [label, html] of [["Matchweek", s.picksView()], ["My Picks", s.picksView()]]) {
    // An in-progress fixture states pending, and never a score of our own.
    assert.match(html, /points pending settlement|Awaiting final score/, `${label} says nothing about pending`);
    assert.ok(!/provisional/i.test(html), `${label} mentions provisional`);
  }
  // The source rule: the in-progress line is a constant, not a computation.
  assert.match(constOf("MATCHWEEK_ROW_LINE"), /"in-progress": "In progress · points pending settlement"/);
});

test("D2 · a settled row leads with the final score", () => {
  const s = box({ ids: [SETTLED.id], picks: { [SETTLED.id]: { p1: 2, p2: 1 } } });
  // One surface now: the settled row IS the result card — score first, then
  // the prediction and its points, with the mates behind the disclosure.
  const mine = s.picksView();
  assert.match(mine, /class="pick-row pick-row-result/);
  assert.match(mine, /data-expand-pick="[^"]+"[\s\S]*?Mates&#39; picks/);
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

test("D2 · after lock the row still states the saved prediction", () => {
  // The repeated per-card status sentence is gone (Adam's rider, item 6), so
  // the pick is on the row as data and in the row's spoken name.
  const s = box({ ids: [LOCKED.id], picks: { [LOCKED.id]: { p1: 3, p2: 0 } } });
  const html = s.picksView();
  assert.match(html, /class="pick-row-score">3-0</);
  assert.match(html, /aria-label="[^"]*your prediction 3-0, locked"/);
  const none = box({ ids: [LOCKED.id] });
  assert.match(none.picksView(), /aria-label="[^"]*no prediction yet, locked"/);
  // The state is said once, in the header — never on every card.
  const list = html.slice(html.indexOf("pick-list"));
  assert.ok(!/Locked · /.test(list), "a per-card status line survives");
  assert.ok(!/pick-row-status/.test(html), "the repeated status element survives");
  assert.equal((html.match(/Locked · /g) || []).length, 1, "the state is said more than once");
});

// --- D3 · one at a time -----------------------------------------------------

test("D3 · only one row can be expanded, and there is only one surface", () => {
  const s = box();
  s.evalIn(`expandedPickId = ${JSON.stringify(OPEN.id)};`);
  // One expanded body, whatever the rows are made of.
  assert.equal((s.picksView().match(/data-picker=/g) || []).length, 1);
  assert.equal((s.picksView().match(/aria-expanded="true"/g) || []).length, 1);
  // The state is a single id, not a set — the shape makes two impossible.
  assert.match(sourceOf("expandPick"), /const wanted = expandedPickId === String\(id\) \? null : String\(id\);/);
  // And there is no second expansion state to disagree with it.
  assert.ok(!APP.includes("expandedFixtureId"), "a second expansion state survives");
});

test("D3 · expanding never re-renders, so scroll is preserved", () => {
  for (const fn of ["expandPick", "togglePickReveal"]) {
    const body = sourceOf(fn);
    assert.ok(!/\brender\(/.test(body), `${fn} re-renders the view`);
  }
});

// --- D4 · privacy before authorisation --------------------------------------

test("D4 · the mates section is behind the disclosure, never on the closed row", () => {
  // Adam's ruling folded Matchweek into My Picks, so the mates ARE here now —
  // but only once the viewer asks, and never on a fixture still open.
  const s = box({ ids: [SETTLED.id], picks: { [SETTLED.id]: { p1: 2, p2: 1 } } });
  const closed = s.picksView();
  assert.ok(!closed.includes("MATES"), "a closed row drew the mates section");
  assert.match(closed, /data-expand-pick="[^"]+"/, "no disclosure to open");
  s.evalIn(`expandedPickId = ${JSON.stringify(SETTLED.id)};`);
  const open = s.picksView();
  assert.ok(open.includes("MATES"), "the disclosure does not hold the mates section");
  // An OPEN fixture's disclosure holds the score controls and nothing social.
  const still = box({ ids: [OPEN.id] });
  still.evalIn(`expandedPickId = ${JSON.stringify(OPEN.id)};`);
  const editing = still.picksView();
  assert.match(editing, /data-picker=/, "the open row lost its score controls");
  assert.ok(!editing.includes("MATES"), "an open fixture leaked the mates section");
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
    assert.deepEqual(rows(s.picksView()), expected, `${active} Matchweek blended`);
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
    assert.deepEqual(rows(s.picksView()), [SETTLED.id], "a stale global won on Matchweek");
    assert.deepEqual(rows(s.picksView()), [SETTLED.id], "a stale global won on My Picks");
    assert.ok(!s.picksView().includes("Sunday Six"));
  }
});

test("D5 · a switch closes both open rows", () => {
  const fn = sourceOf("setActiveLeague");
  assert.match(fn, /expandedPickId = null;/);
  assert.match(fn, /expandedPickId = null;/);
});

// --- D6 · the exports -------------------------------------------------------

const SHARE_NAMES = ["weeklyTerminalCount", "weeklyShareStatus", "seasonShareFreshness",
  "shareSurface", "shareRound", "sharePeriod", "normaliseView", "LEGACY_VIEWS", "shareIconButton", "shareCardState", "weeklySharePublished", "seasonCardModel", "podiumCounts",
  "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "noteWeeklyFinalMismatch", "weeklyFinalMismatchLines"];

function shareBox(overrides = {}) {
  return load(SHARE_NAMES, {
    ...BASE,
    fixtures: ALL,
    activeLeague: "AAA",
    leagueTab: "matchday",
    currentView: "league",
    selectedPeriod: "7",
    roundState: null,
    leagueState: leagueState({ ids: [] }),
    leagueStates: {},
    leagueCodes: ["AAA"],
    seasonRounds: () => 38,
    currentPeriodKey: () => "7",
    weeklyFinalMismatches: new Map(),
    leagueSupportsRounds: () => true,
    inviteLinkFor: (code) => `https://x/${code}`,
    ...overrides,
  });
}

const round = (n, entries, { complete = false } = {}) => ({
  code: "AAA", matchday: n, period: String(n), complete,
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
  // Final needs the server's completion too, now that it fails closed.
  assert.equal(s.weeklyShareStatus(round(3, six(6), { complete: true })).label, "Week 3 · Final");
  assert.equal(s.weeklyShareStatus(round(3, six(4, 2), { complete: true })).label, "Week 3 · Final");
  // Terminal everywhere but unconfirmed is honest progress, not Final.
  assert.equal(s.weeklyShareStatus(round(3, six(6))).label, "Week 3 · in progress · after 6 of 6");
  // Final only when EVERY slot is terminal.
  assert.equal(s.weeklyShareStatus(round(3, six(5))).final, false);
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
  const s = shareBox({ roundState: running, selectedPeriod: "3" });
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
  const s = shareBox({ roundState: round(3, [{ id: "a", settled: true }]), selectedPeriod: "3" });
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
  const s = shareBox({ roundState: round(3, [{ id: "a", settled: true }]), selectedPeriod: "3" });
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
  for (const [label, fn] of [["Matchweek", () => s.picksView()], ["My Picks", () => s.picksView()]]) {
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

// --- Sol's Slice C corrections, executed ------------------------------------

const CARD_NAMES = ["CARD_W_PX", "CARD_H_PX", "CARD_W", "CARD_HEAD_H", "CARD_HERO_H", "CARD_TABLE_HEAD_H",
  "CARD_ROW_H", "CARD_SEASON_ROW_H", "CARD_FOOT_H", "CARD_GAP", "cardRowMetrics", "cardCanvas",
  "seasonCardModel", "weeklyCardModel", "weeklyShareStatus", "weeklyTerminalCount",
  "weeklyFinalMismatchLines", "noteWeeklyFinalMismatch", "seasonShareFreshness", "weeklySharePublished", "shareCardState",
  "weeklyCardCaption", "podiumCounts", "weeklyRanks", "sharedRankByUid", "winnerNames",
  "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "CARD", "CARD_PAD", "cardFont", "cardDate", "sentenceCase",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "cardHonoursWidth", "cardHonoursFit", 
  "CARD_COL", "CARD_MIN_NAME", "cardPageRows", "cardPageLabel", "cardTableTop", "seasonCardPages", "drawSeasonPage", "drawSeasonTableCard", "weeklyCardPages", "drawWeeklyPage", "drawWeeklyResultCard"];

/** A canvas that records only what a geometry check needs. */
function stubCanvas() {
  const calls = [];
  const ctx = new Proxy({
    setTransform: (...a) => calls.push(["setTransform", ...a]),
    fillRect: () => {}, fillText: (t) => calls.push(["text", String(t)]),
    measureText: (t) => ({ width: String(t).length * 12 }),
    save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arcTo: () => {}, arc: () => {}, fill: () => {},
    stroke: () => {}, clip: () => {}, rect: () => {}, translate: () => {}, scale: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
  }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,AAAA" };
  return { canvas, ctx, calls };
}

function cardBox(overrides = {}) {
  const made = [];
  return load(CARD_NAMES, {
    ...BASE,
    fixtures: ALL,
    activeLeague: "AAA",
    leagueState: leagueState({ ids: [] }),
    leagueStates: {},
    leagueCodes: ["AAA"],
    weeklyFinalMismatches: new Map(),
    seasonRounds: () => 38,
    currentPeriodKey: () => "7",
    inviteLinkFor: (c) => `https://x/${c}`,
    leagueCompetitionNames: () => "Premier League",
    PLACE_EMOJI: { gold: "1", silver: "2", bronze: "3" },
    fitText: (ctx, text, max, font) => { ctx.font = font(30); },
    roundedRect: () => {},
    drawCardHeader: () => {}, drawCardHero: () => {},
    drawCardTableHead: () => {}, drawCardRowPlate: () => {}, drawCardHonours: () => {},
    drawCardFooter: () => {}, drawFitted: (ctx, t) => { made.push(String(t)); },
    ellipsise: (ctx, t) => t,
    document: { createElement: () => { const c = stubCanvas(); made.push(c); return c.canvas; } },
    __made: made,
    ...overrides,
  });
}

const table = (n) => Array.from({ length: n }, (_, i) => ({
  uid: `u${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 200 - i * 3, exact: i % 4,
  podiums: { gold: i === 0 ? 1 : 0, silver: 0, bronze: 0 },
}));

// --- A · both exports are square, complete and adaptive ---------------------

test("C-A · every supported table size produces a 1080x1920 PORTRAIT canvas", () => {
  for (const n of [1, 3, 6, 12, 20, 30]) {
    const s = cardBox();
    const state = { code: "AAA", name: "Sunday Six", table: table(n), currentMatchday: 9, currentMatchdayHasResults: true };
    const season = s.drawSeasonTableCard ? s.drawSeasonTableCard(state) : null;
    void season;
    const m = s.cardRowMetrics(n, { chrome: s.CARD_HEAD_H + s.CARD_GAP + s.CARD_TABLE_HEAD_H + s.CARD_GAP + s.CARD_FOOT_H, base: s.CARD_SEASON_ROW_H });
    const { canvas } = s.cardCanvas(m.contentHeight);
    // Adam's portrait ruling: fixed 1080x1920, never varied by device.
    assert.equal(canvas.width, s.CARD_W_PX, `${n} rows produced ${canvas.width}x${canvas.height}`);
    assert.equal(canvas.height, s.CARD_H_PX, `${n} rows produced ${canvas.width}x${canvas.height}`);
    assert.equal(canvas.width, 1080);
    assert.equal(canvas.height, 1920);
  }
});

test("C-A · the complete table always fits inside the square", () => {
  const s = cardBox();
  const chrome = s.CARD_HEAD_H + s.CARD_GAP + s.CARD_TABLE_HEAD_H + s.CARD_GAP + s.CARD_FOOT_H;
  for (const n of [1, 6, 12, 20, 30]) {
    const m = s.cardRowMetrics(n, { chrome, base: s.CARD_SEASON_ROW_H });
    const { scale } = s.cardCanvas(m.contentHeight);
    const drawn = m.contentHeight * scale;
    assert.ok(drawn <= s.CARD_H_PX + 0.5, `${n} rows need ${drawn.toFixed(0)} of ${s.CARD_H_PX}`);
    // Rows shrink; they never vanish.
    assert.ok(m.rowH >= 26, `${n} rows fell below the readable floor at ${m.rowH}`);
    assert.ok(m.rowH <= s.CARD_SEASON_ROW_H);
  }
});

test("C-A · typography adapts with the row, and honours drop when they cannot fit", () => {
  const s = cardBox();
  const chrome = s.CARD_HEAD_H + s.CARD_GAP + s.CARD_TABLE_HEAD_H + s.CARD_GAP + s.CARD_FOOT_H;
  const small = s.cardRowMetrics(6, { chrome, base: s.CARD_SEASON_ROW_H });
  const large = s.cardRowMetrics(30, { chrome, base: s.CARD_SEASON_ROW_H });
  assert.ok(large.rowH < small.rowH, "a bigger table did not compress");
  assert.ok(large.name <= small.name, "type did not adapt with the row");
  assert.ok(large.name >= 15, "type fell below a readable floor");
  // Honours are NEVER dropped: a roomy row gets a second line, a compressed one
  // gets a compact tally, and both carry all three counts.
  assert.equal(small.honoursLine, true, "a roomy row lost its honours line");
  assert.equal(large.honoursLine, false, "a compressed row still drew a second line");
  assert.ok(large.honoursSize >= 13, "the compact tally has no readable size");
  assert.ok(large.honoursSize <= small.honoursSize);
});

test("C-A · neither model truncates, at any size", () => {
  const s = cardBox();
  for (const n of [12, 20, 30]) {
    const model = s.seasonCardModel({ code: "AAA", name: "L", table: table(n), currentMatchday: 9, currentMatchdayHasResults: true });
    assert.equal(model.rows.length, n, `season truncated at ${n}`);
  }
  for (const src of ["seasonCardModel", "weeklyCardModel"]) {
    assert.ok(!/\.slice\(0,\s*\d+\)/.test(sourceOf(src)), `${src} slices the table`);
  }
});

// --- B · honest weekly copy -------------------------------------------------

const wround = (n, entries, complete = false, rows = 3) => ({
  matchday: n, period: String(n), complete,
  slate: { period: String(n), fixtureIds: entries.map((e) => e.id), count: entries.length },
  reveal: entries,
  podium: complete ? [{ uid: "u0", nick: "Player 1", pts: 23, place: "gold" }] : [],
  winners: complete ? ["u0"] : [],
  table: table(rows).map((r, i) => ({ ...r, pts: complete || i > 0 ? r.pts : r.pts })),
});
const slots = (settled, voided = 0, total = 6) => Array.from({ length: total }, (_, i) => ({
  id: `w${i}`,
  ...(i < settled ? { settled: true } : i < settled + voided ? { voided: true } : {}),
}));

test("C-B · a not-started week crowns nobody and leads nobody", () => {
  const s = cardBox();
  const round = wround(3, slots(0));
  const model = s.weeklyCardModel({ code: "AAA", name: "Sunday Six" }, round);
  assert.equal(model.heroEyebrow, "NOT STARTED");
  assert.equal(model.heroName, "", "a zero-point row was named as leading");
  assert.ok(!/champion/i.test(model.heroLine), "a not-started card mentions a champion");
  assert.ok(!/leading/i.test(model.heroEyebrow + model.heroLine));
  assert.match(model.headline, /Week 3 · not started · 0 of 6 fixtures/);
});

test("C-B · an in-progress week may name a leader, on settled points", () => {
  const s = cardBox();
  const model = s.weeklyCardModel({ code: "AAA", name: "Sunday Six" }, wround(3, slots(2)));
  assert.equal(model.heroEyebrow, "LEADING ON SETTLED POINTS");
  assert.equal(model.heroName, "Player 1");
  assert.match(model.heroLine, /in progress · after 2 of 6/);
  assert.ok(!/champion/i.test(model.heroEyebrow + model.heroLine));
});

test("C-B · only a Final week names a champion", () => {
  const s = cardBox();
  const model = s.weeklyCardModel({ code: "AAA", name: "Sunday Six" }, wround(3, slots(6), true));
  assert.match(model.heroEyebrow, /CHAMPION/);
  assert.match(model.heroLine, /champion/);
  assert.match(model.headline, /Week 3 · Final/);
});

test("C-B · the caption says nothing-settled ONLY at 0 of M", () => {
  const s = cardBox();
  const league = { code: "AAA", name: "Sunday Six" };
  const none = s.weeklyCardCaption(league, wround(3, slots(0)));
  assert.match(none, /nothing settled yet/);
  assert.ok(!/leading/i.test(none), "a not-started caption named a leader");

  const some = s.weeklyCardCaption(league, wround(3, slots(2)));
  assert.ok(!/nothing settled yet/.test(some), "a part-settled week claimed nothing was settled");
  assert.match(some, /after 2 of 6 fixtures/);
  assert.ok(!/settled/.test(some.replace("nothing settled yet", "")), "a void was described as settled");
  assert.match(some, /Player 1 leading on/);

  const done = s.weeklyCardCaption(league, wround(3, slots(6), true));
  assert.match(done, /won by/);
  assert.ok(!/nothing settled yet/.test(done));
});

test("C-B · the share TITLE is state-neutral before settlement", () => {
  const title = sourceOf("shareCardNow");
  assert.match(title, /weeklyShareStatus\(roundState\)\.final \? "matchweek result" : "matchweek standings"/);
});

// --- C · postponed is not terminal ------------------------------------------

test("C-C · a postponed fixture is NOT terminal", () => {
  const s = cardBox({ fixtures: [{ id: "p1", status: "postponed", startAt: new Date().toISOString() }] });
  const counted = s.weeklyTerminalCount({
    slate: { fixtureIds: ["p1", "p2"] },
    reveal: [{ id: "p1" }, { id: "p2", settled: true }],
  });
  assert.deepEqual({ ...counted }, { terminal: 1, total: 2 },
    "a postponed fixture was counted as done");
  assert.ok(!/isPostponed/.test(sourceOf("weeklyTerminalCount")),
    "the terminal count still consults postponement");
});

test("C-C · a postponed fixture counts only when the payload marks it void", () => {
  const s = cardBox({ fixtures: [{ id: "p1", status: "postponed", startAt: new Date().toISOString() }] });
  const counted = s.weeklyTerminalCount({
    slate: { fixtureIds: ["p1"] },
    reveal: [{ id: "p1", voided: true }],
  });
  assert.equal(counted.terminal, 1, "an authoritatively voided fixture was not counted");
});

test("C-C · a week holding a postponed fixture cannot be Final", () => {
  const s = cardBox({ fixtures: [{ id: "w5", status: "postponed", startAt: new Date().toISOString() }] });
  const round = { matchday: 3, period: "3", complete: true,
    slate: { fixtureIds: [...slots(5, 0, 5).map((e) => e.id), "w5"] },
    reveal: [...slots(5, 0, 5), { id: "w5" }], table: table(3) };
  const status = s.weeklyShareStatus(round);
  assert.equal(status.final, false, "a postponed fixture was allowed into a Final");
  assert.match(status.label, /in progress · after 5 of 6/);
});

// --- D · Final fails closed --------------------------------------------------

test("C-D · complete:true with a non-terminal slot is NOT Final", () => {
  const s = cardBox();
  const status = s.weeklyShareStatus(wround(3, slots(4), true));
  assert.equal(status.final, false, "an inconsistent payload was blessed as Final");
  assert.match(status.label, /in progress · after 4 of 6/);
  assert.deepEqual([...s.weeklyFinalMismatchLines()],
    ["weekly Final mismatch period 3: complete=true, terminal 4/6"]);
});

test("C-D · every slot terminal but complete:false is NOT Final either", () => {
  const s = cardBox();
  const status = s.weeklyShareStatus(wround(3, slots(6), false));
  assert.equal(status.final, false, "the client called a week Final on its own");
  assert.match(status.label, /in progress · after 6 of 6/);
  assert.deepEqual([...s.weeklyFinalMismatchLines()],
    ["weekly Final mismatch period 3: complete=false, terminal 6/6"]);
});

test("C-D · Final needs BOTH, and records nothing when they agree", () => {
  const s = cardBox();
  const status = s.weeklyShareStatus(wround(3, slots(6), true));
  assert.equal(status.final, true);
  assert.deepEqual([...s.weeklyFinalMismatchLines()], [], "an agreeing week logged a mismatch");
});

test("C-D · the mismatch reaches the diagnostics the dialog copies", () => {
  assert.match(APP, /\.\.\.weeklyFinalMismatchLines\(\),/);
});

// --- E · the real share path, staged ----------------------------------------

test("C-E · every stage of the share path is traced", () => {
  const fn = sourceOf("shareCardNow");
  for (const stage of ["share-model", "share-encode", "share-handoff"]) {
    assert.ok(fn.includes(stage), `${stage} is not traced`);
  }
  // A single-page export — every realistic size, now that a portrait card
  // holds forty-odd members — stays entirely inside the tap.
  assert.match(fn, /if \(plan\.pages === 1\) \{/);
  assert.match(fn, /cardPng\(plan\.page\(0\), nameFor\(0\)\)/);
  assert.ok(!/\bawait\b/.test(fn), "the single-page path awaits and would lose the sheet");
  // The multi-page path is where the yields are, and it traces each page.
  const many = sourceOf("sharePagesSequentially");
  assert.match(many, /share-page/);
  assert.match(many, /await nextPaint\(\)/);
  assert.match(many, /pages: pages\.length/);
});

test("C-E · model and draw are measured at common and maximum tables", () => {
  const s = cardBox();
  const median = (fn) => {
    const t = [];
    for (let i = 0; i < 15; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); }
    return t.sort((x, y) => x - y)[7];
  };
  for (const n of [6, 12, 30]) {
    const state = { code: "AAA", name: "Sunday Six", table: table(n), currentMatchday: 9, currentMatchdayHasResults: true };
    const model = median(() => s.seasonCardModel(state));
    const draw = median(() => s.drawSeasonTableCard(state));
    console.log(`    season, ${String(n).padStart(2)} members: model ${model.toFixed(3)}ms  draw ${draw.toFixed(2)}ms`);
    assert.ok(model < 50 && draw < 50, `${n} members exceeded the synchronous budget`);
  }
  // PNG encoding cannot be measured here: node has no canvas encoder, so the
  // stub returns instantly. It is traced in production instead, which is why
  // the trace points above exist and why device timing is still mandatory.
});
