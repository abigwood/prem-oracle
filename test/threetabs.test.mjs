// v1.7.1 — three navigation questions: My Picks, League, Rules.
//
// The existing suites still own their slices: matchweek.test.mjs the slate
// contract, mates_view/mates_requests the reveal's privacy and request
// discipline, consolidation.test.mjs the navigation shell. This file covers
// the simplification itself, in the order a real session meets it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, APP, sourceOf, constOf } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// --- 1 · the bar, and where the app opens ---------------------------------

test("T1 · the navigation is exactly My Picks, League, Rules", () => {
  const { document } = new JSDOM(HTML).window;
  const buttons = [...document.querySelectorAll(".bottom-nav button")];
  assert.equal(buttons.length, 3, "the bar is not three items");
  assert.deepEqual(buttons.map((b) => b.dataset.view), ["picks", "league", "rules"]);
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, "").trim()),
    ["My Picks", "League", "Rules"]);
  // Nothing in the shipped document offers the removed tab.
  for (const gone of ['data-view="today"', ">Next<", ">Matchweek<", ">Schedule<"]) {
    assert.ok(!HTML.includes(gone), `${gone} survives in the shell`);
  }
});

test("T1 · My Picks is the default landing screen", () => {
  assert.match(APP, /let currentView = "picks";/);
  // The launch tree no longer chooses a tab; it chooses what My Picks shows.
  assert.match(sourceOf("applyLaunchBranch"), /currentView = "picks";/);
  assert.ok(!APP.includes('currentView = "today"'), "something still opens Next");
  // And the document ships with My Picks marked active.
  const { document } = new JSDOM(HTML).window;
  assert.equal(document.querySelector(".bottom-nav button.active").dataset.view, "picks");
});

test("T1 · accessibility: the bar is labelled and its order is the tab order", () => {
  const { document } = new JSDOM(HTML).window;
  const nav = document.querySelector(".bottom-nav");
  assert.equal(nav.getAttribute("aria-label"), "Main navigation");
  const buttons = [...nav.querySelectorAll("button")];
  // Real buttons in document order: focus follows the visual order with no
  // tabindex of its own to get out of step.
  for (const button of buttons) {
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button");
    assert.ok(!button.hasAttribute("tabindex"), "a tab overrides the natural order");
    assert.ok(button.textContent.trim().length > 0, "a tab has no accessible name");
  }
  assert.match(CSS.slice(CSS.indexOf(".bottom-nav {")), /grid-template-columns: repeat\(3, 1fr\);/);
});

// --- 2 · every legacy route still lands somewhere real --------------------

test("T2 · every removed route resolves to My Picks, never to nothing", () => {
  const box = load(["normaliseView", "LEGACY_VIEWS"], {});
  for (const legacy of ["today", "schedule", "mates"]) {
    assert.equal(box.normaliseView(legacy), "picks", `${legacy} did not redirect`);
  }
  // The views that still exist are untouched by the map.
  for (const live of ["picks", "league", "rules"]) {
    assert.equal(box.normaliseView(live), live);
  }
  // An unknown id is not silently mapped; the renderer's fallback catches it.
  assert.equal(box.normaliseView("nonsense"), "nonsense");
  assert.match(APP, /const html = \(views\[normaliseView\(currentView\)\] \|\| picksView\)\(\);/);
});

test("T2 · the three doors a stored or sent route can arrive through", () => {
  assert.match(sourceOf("navigateToView"), /const view = normaliseView\(requested\);/);
  assert.match(sourceOf("markActiveTab"), /const active = normaliseView\(currentView\);/);
  assert.match(APP, /views\[normaliseView\(currentView\)\]/);
});

test("T2 · a link naming a removed view opens My Picks in its league context", () => {
  const box = load(["requestedView", "normaliseView", "LEGACY_VIEWS"], { URLSearchParams });
  for (const search of ["?view=mates", "?view=today", "?view=schedule", "?view=MATES"]) {
    assert.equal(box.requestedView(search), "picks", search);
  }
  assert.equal(box.requestedView("?view=league"), "league");
  assert.equal(box.requestedView(""), null, "a link naming nothing routes nothing");
  assert.equal(box.requestedView("?view=nonsense"), null, "an unknown view is refused");
  // The league on the same link is what selects the context, and it is read
  // by the code that already existed for invitations.
  assert.match(APP, /new URLSearchParams\(location\.search\)\.get\("league"\)/);
  assert.match(APP, /else if \(asked\) \{ launchRouted = true; currentView = asked; \}/);
});

test("T2 · notifications still open the fixture on My Picks", () => {
  const open = sourceOf("openNotificationTarget");
  assert.match(open, /await navigateToView\("picks"\)/);
  assert.match(open, /currentView = "picks";/, "the no-route fallback still lands somewhere");
  assert.ok(!open.includes('"today"'), "a notification can still reach Next");
  // The payload contract itself is untouched.
  const box = load(["readNotificationRoute", "safeParseJSON", "NOTIFY_PAYLOAD_VERSION"], {});
  assert.deepEqual(JSON.parse(JSON.stringify(
    box.readNotificationRoute({ po: { v: 1, f: "m1", l: "aaa" } }))),
    { fixtureId: "m1", league: "AAA" });
});

// --- 3 · the League segment is Weekly and Season, and nothing else --------

test("T3 · League offers Weekly and Season only", () => {
  const toggle = sourceOf("roundToggle");
  assert.match(toggle, />Weekly ▾</);
  assert.match(toggle, />Season</);
  // The rendered control, not the comment above it explaining the removal.
  const markup = toggle.slice(toggle.indexOf("return `"));
  assert.ok(!markup.includes("Mates"), "the Mates' Picks segment survived");
  assert.equal((toggle.match(/data-round-tab=/g) || []).length, 2, "the bar is not two segments");
  assert.ok(!APP.includes('data-round-tab="mates"'), "the segment is reachable somewhere else");
});

test("T3 · no full-slate matrix exists anywhere", () => {
  for (const gone of ["matesMatrix", "matesFixtureCard", "matesHeader", "matesAwaitingSlate"]) {
    assert.ok(!APP.includes(`function ${gone}(`), `${gone} survived`);
    assert.ok(!APP.includes(`${gone}(`), `${gone} is still called`);
  }
  assert.ok(!APP.includes('if (tab === "mates")'), "the matrix panel survived");
  assert.ok(!APP.includes('tab === "mates"'), "a panel still branches on the removed tab");
});

test("T3 · anything still naming the removed segment is answered with Weekly", () => {
  const box = load(["normaliseLeagueTab", "LEGACY_LEAGUE_TABS"], {});
  assert.equal(box.normaliseLeagueTab("mates"), "matchday");
  assert.equal(box.normaliseLeagueTab("season"), "season");
  assert.equal(box.normaliseLeagueTab("matchday"), "matchday");
  // Anything unrecognised is Weekly too — never a segment that is not there.
  for (const odd of [undefined, null, "", "nonsense"]) {
    assert.equal(box.normaliseLeagueTab(odd), "matchday", String(odd));
  }
  // And the live tab only ever changes through that door.
  // Normalised once, where it is read, so nothing downstream ever sees the
  // raw value — not the active marker, not the status, not the request.
  assert.match(APP, /const wanted = normaliseLeagueTab\(roundTab\.dataset\.roundTab\);/);
  const handler = APP.slice(APP.indexOf("const roundTab = event.target.closest"));
  const body = handler.slice(0, handler.indexOf("const roundMd ="));
  // Read once, on the line that normalises it, and never again.
  assert.equal((body.match(/roundTab\.dataset\.roundTab/g) || []).length, 1,
    "the raw value is read more than once");
  for (const downstream of ["markSegment(wanted)", 'wanted === "matchday"', 'wanted === "season"']) {
    assert.ok(body.includes(downstream), `${downstream} does not use the normalised tab`);
  }
});

// --- 4 · one list, counted once -------------------------------------------

const fx = (id, { hours = 6, result = null, h = "Arsenal", a = "Chelsea" } = {}) => ({
  id, player1: h, player2: a, matchday: 7,
  startAt: new Date(Date.now() + hours * 36e5).toISOString(),
  ...(result ? { result: { p1: result[0], p2: result[1] } } : {}),
});
const OPEN_A = fx("f-a");
const OPEN_B = fx("f-b", { h: "Spurs", a: "Everton" });
const LOCKED = fx("f-locked", { hours: -2, h: "Leeds", a: "Wolves" });

function picksBox({ ids = ["f-a", "f-b"], picks = {}, code = "AAA", codes = ["AAA"] } = {}) {
  return load(["picksView", "pickActionSummary", "pickCounts", "pickRow", "pickRowBody",
    "pickRowLabel", "pickListState", "pickDeadlineLine", "pickEditable", "launchBranch",
    "matchweekLeagueState", "matchweekSlate", "matchweekSlots", "matchweekContext",
    "matchweekEmpty", "matchweekUnavailable", "matchweekLeagueName", "matchweekRowState",
    "MATCHWEEK_ROW_LINE", "isSettledCard", "slateForPeriod", "fixtureById",
    "noteMatchweekCountMismatch", "matchweekMismatchLines",
    "isPostponed", "isVoidFixture", "VOID_STATUSES", "finalScore", "resultState",
    "RESULT_FIRST_STATES", "pickJustSaved", "expandPick", "clientLockMs"], {
    fixtures: [OPEN_A, OPEN_B, LOCKED],
    picks,
    activeLeague: code,
    leagueCodes: codes,
    leagueNames: { AAA: "Sunday Six", BBB: "Bury Legends" },
    leagueState: { code, name: code === "AAA" ? "Sunday Six" : "Bury Legends",
      currentPeriod: "7", currentSlate: { period: "7", status: "published", fixtureIds: ids, count: ids.length } },
    leagueStates: {},
    matchweekCountMismatches: new Map(),
    expandedPickId: null,
    inviteCode: "",
    playerName: "Adam",
    currentPeriodKey: () => "7",
    periodOfFixture: (f) => (f?.matchday == null ? null : String(f.matchday)),
    periodLabel: (p) => `Matchweek ${p}`,
    matchOpen: (f) => Date.parse(f?.startAt || "") > Date.now(),
    picksDue: () => [],
    escapeHTML: (v) => String(v ?? ""),
    installNotice: () => "",
    slateNotice: () => "",
    hero: () => "",
    preseasonState: () => `<div class="preseason"></div>`,
    onboardingState: () => `<div class="onboarding">Create a league</div>`,
    leagueSwitcher: () => "",
    pulsingStatus: (t) => `<p class="pulse">${t}</p>`,
    matchCard: (m) => `<article data-match-card="${m.id}"></article>`,
    resultCard: (m) => `<article data-match-card="${m.id}"></article>`,
    fixtureRevealSection: () => "",
    shortKickoff: () => "Sat 15:00",
    pickShareRow: () => "",
    isLeagueHost: () => false,
  });
}

const rowIds = (html) => [...html.matchAll(/data-pick-row="([^"]+)"/g)].map((m) => m[1]);

test("T4 · the summary counts what is outstanding, and says so", () => {
  assert.match(picksBox().picksView(), /2 predictions still needed/);
  assert.match(picksBox({ picks: { "f-a": { p1: 1, p2: 0 } } }).picksView(),
    /1 prediction still needed/);
  assert.match(picksBox({ picks: { "f-a": { p1: 1, p2: 0 }, "f-b": { p1: 2, p2: 2 } } }).picksView(),
    /All 2 predictions are in ✓/);
});

test("T4 · a fixture that locked unpicked is never counted as done", () => {
  // Two open and picked, one locked and never picked: "all in" would be a
  // claim about a prediction that was never made.
  const box = picksBox({ ids: ["f-a", "f-b", "f-locked"],
    picks: { "f-a": { p1: 1, p2: 0 }, "f-b": { p1: 0, p2: 0 } } });
  const html = box.picksView();
  assert.doesNotMatch(html, /All 3 predictions are in/);
  assert.match(html, /2 of 3 predictions made · the rest have locked/);
});

test("T4 · one fixture in two leagues is one prediction, counted once", () => {
  // The same fixture id is on both leagues' slates. A pick belongs to the
  // FIXTURE, so making it satisfies both, and neither may count it twice.
  const shared = { ids: ["f-a", "f-b"] };
  const a = picksBox({ ...shared, code: "AAA", codes: ["AAA", "BBB"] });
  const b = picksBox({ ...shared, code: "BBB", codes: ["AAA", "BBB"] });
  assert.match(a.picksView(), /2 predictions still needed/);
  assert.match(b.picksView(), /2 predictions still needed/);

  const picked = { "f-a": { p1: 1, p2: 0 } };
  const a2 = picksBox({ ...shared, picks: picked, code: "AAA", codes: ["AAA", "BBB"] });
  const b2 = picksBox({ ...shared, picks: picked, code: "BBB", codes: ["AAA", "BBB"] });
  assert.match(a2.picksView(), /1 prediction still needed/, "the shared pick did not count in AAA");
  assert.match(b2.picksView(), /1 prediction still needed/, "the shared pick did not count in BBB");

  // And the counter itself is a set, so a slate naming a fixture twice is one.
  const twice = picksBox({ ids: ["f-a", "f-a", "f-b"] });
  const counts = twice.pickCounts(twice.matchweekSlots(twice.matchweekSlate()));
  assert.deepEqual({ ...counts }, { required: 2, made: 0, outstanding: 2 });
});

test("T4 · one list: no fixture card is ever drawn twice", () => {
  for (const ids of [["f-a"], ["f-a", "f-b"], ["f-a", "f-b", "f-a"]]) {
    const html = picksBox({ ids }).picksView();
    const drawn = rowIds(html);
    assert.equal(new Set(drawn).size, drawn.length, `${ids} drew a duplicate card`);
  }
  // The summary is a sentence, not a second list.
  const html = picksBox().picksView();
  assert.equal((html.match(/data-pick-list/g) || []).length, 1, "there is more than one list");
  assert.equal((html.match(/data-pick-summary/g) || []).length, 1, "there is more than one summary");
});

test("T4 · cards still needing a prediction are marked, without a second list", () => {
  const html = picksBox({ picks: { "f-a": { p1: 1, p2: 0 } } }).picksView();
  const needed = (html.match(/class="pick-row[^"]*is-needed/g) || []).length;
  assert.equal(needed, 1, "the outstanding card is not marked");
  assert.match(html, /1 prediction still needed/);
  // The number in the sentence is the number of marked cards.
  assert.equal(Number(/(\d+) prediction/.exec(html)[1]), needed);
});

// --- 5 · My Picks owns every launch state ---------------------------------

test("T5 · no league at all gets the welcome, never a calendar", () => {
  const html = picksBox({ codes: [] }).picksView();
  assert.match(html, /class="onboarding"/);
  assert.ok(!html.includes("data-pick-row"), "a fixture was drawn with no league");
});

test("T5 · an unpublished slate gets the two lines and ZERO cards", () => {
  const box = load(["picksView", "pickActionSummary", "pickCounts", "matchweekLeagueState",
    "matchweekSlate", "matchweekContext", "matchweekEmpty", "matchweekLeagueName",
    "launchBranch", "slateForPeriod"], {
    fixtures: [OPEN_A, OPEN_B],
    picks: {}, activeLeague: "AAA", leagueCodes: ["AAA"], leagueNames: {},
    leagueState: { code: "AAA", name: "Sunday Six", currentPeriod: "7", currentSlate: null },
    leagueStates: {}, matchweekCountMismatches: new Map(), inviteCode: "", playerName: "Adam",
    currentPeriodKey: () => "7", periodOfFixture: (f) => String(f.matchday),
    matchOpen: () => true, picksDue: () => [], escapeHTML: (v) => String(v ?? ""),
    installNotice: () => "", slateNotice: () => "", hero: () => "",
    preseasonState: () => `<div class="preseason"></div>`, onboardingState: () => "",
    leagueSwitcher: () => "", pulsingStatus: (t) => `<p>${t}</p>`,
  });
  const html = box.picksView();
  assert.match(html, /No league fixtures selected yet\./);
  assert.match(html, /Waiting on your host to publish this week/);
  assert.ok(!html.includes("data-pick-row"), "an unpublished slate drew fixture cards");
});

test("T5 · nothing pickable yet is preseason, and still not a calendar", () => {
  const box = picksBox({ ids: [] });
  const html = box.picksView();
  assert.ok(!html.includes("data-pick-row"), "preseason drew fixture cards");
  // The whole competition calendar is never the fallback, in any state.
  const view = sourceOf("picksView");
  assert.ok(!view.includes("fixtures.filter"), "My Picks falls back to the calendar");
  assert.ok(!view.includes("fixtures.slice"), "My Picks falls back to the calendar");
});

// --- 6 · the reveal, without ever visiting League -------------------------

test("T6 · a fresh launch can reveal a kicked-off fixture from My Picks alone", () => {
  // ensurePicksRound is My Picks' own read, and its answer is adopted as the
  // reveal — so nothing about the comparison depends on the League tab.
  const fn = sourceOf("ensurePicksRound");
  assert.match(fn, /if \(revealUsable\(state\)\) \{/, "My Picks' read does not feed the reveal");
  assert.match(fn, /revealState = state;/);
  assert.match(fn, /revealLockHorizon = lockHorizonOf\(state\);/);
  // And the reveal considers that read when it looks for a payload.
  assert.match(sourceOf("currentRoundReveal"), /\[revealState, picksRound, roundState, cached\]/);
  // Entering My Picks is what starts it, unawaited.
  const nav = sourceOf("navigateToView");
  assert.match(nav, /ensurePicksRound\(\);/);
  assert.ok(!nav.includes("await ensurePicksRound"), "the paint waits for the read");
});

test("T6 · the reveal's freshness now watches My Picks", () => {
  const fn = sourceOf("refreshRevealOnForeground");
  assert.match(fn, /normaliseView\(currentView\) !== "picks"/);
  assert.ok(!fn.includes('leagueTab'), "the reveal still watches the removed segment");
  assert.match(fn, /if \(Date\.now\(\) < revealLockHorizon\) return;/);
  assert.match(fn, /revealLockHorizon = Infinity;/);
  assert.match(sourceOf("revalidateRevealAfterSwitch"), /normaliseView\(currentView\) !== "picks"/);
});

test("T6 · privacy before lock, and no bleed between leagues", () => {
  // The one context rule still gates every path that can draw a prediction.
  const rule = sourceOf("revealUsable");
  assert.match(rule, /state\.code === activeLeague/);
  assert.match(rule, /String\(state\.period\) === String\(period\)/);
  for (const caller of ["ensurePicksRound", "refreshRevealOnForeground", "currentRoundReveal"]) {
    assert.match(sourceOf(caller), /revealUsable/, caller);
  }
  // One reader, so there is one place the rule can be asked from.
  assert.ok(!APP.includes("async function loadRevealState"), "a second round reader survived");
  // A league change drops the held payload before anything can repaint.
  const forget = sourceOf("forgetRevealState");
  assert.match(forget, /revealState = null;/);
  assert.match(forget, /forgetPicksRound\(\);/);
  assert.match(forget, /expandedPickId = null;/);
  for (const switcher of ["setActiveLeague", "switchLeaguePill"]) {
    assert.match(sourceOf(switcher), /forgetRevealState\(\)/, switcher);
  }
  // And a locked fixture's section carries no prediction at all.
  assert.match(sourceOf("fixtureRevealSection"), /card\.state === "locked"/);
  const locked = sourceOf("fixtureRevealSection");
  const branch = locked.slice(locked.indexOf('card.state === "locked"'), locked.indexOf("return `<section class=\"fixture-reveal\">\n    <p"));
  assert.ok(!branch.includes("matesCardBody"), "a locked fixture renders picks");
});

// --- 7 · performance and interaction --------------------------------------

test("T7 · expanding a fixture is a DOM edit, not a global render", () => {
  const expand = sourceOf("expandPick");
  assert.ok(!expand.includes("render("), "expanding a card rebuilds the screen");
  assert.ok(!expand.includes("fetch("), "expanding a card asks the network");
  assert.ok(!expand.includes("api("), "expanding a card asks the network");
});

test("T7 · arriving at My Picks resets the scroller before content is added", () => {
  const nav = sourceOf("navigateToView");
  const at = nav.indexOf('if (view === "picks" && currentView !== "picks")');
  const body = nav.slice(at, nav.indexOf("\n  }", at));
  assert.match(body, /expandedPickId = null;/);
  assert.match(body, /appScroller\(\)/, "the scroller is not reset");
  assert.match(body, /scrollTo/);
  assert.ok(at < nav.indexOf("render({ scrollTop: true })"),
    "content is added before the scroller is reset");
});

test("T7 · nothing polls, and the removed segment left no timer behind", () => {
  assert.equal((APP.match(/setInterval/g) || []).length, 1, "a new timer appeared");
  const reveal = APP.slice(APP.indexOf("async function loadRevealState"),
    APP.indexOf("async function loadKnownLeagueNames"));
  assert.ok(!reveal.includes("setInterval"), "the reveal polls");
  assert.ok(!reveal.includes("setTimeout"), "the reveal schedules a retry");
});

test("T7 · My Picks still makes at most one coalesced round read", () => {
  const fn = sourceOf("ensurePicksRound");
  // What is held paints at once, and is revalidated anyway.
  assert.match(fn, /if \(held\) picksRound = held;/);
  assert.ok(!fn.includes("if (held) {"), "a cached round short-circuits the revalidation");
  assert.match(fn, /const flying = picksRoundFlights\.get\(key\);/);
  assert.match(fn, /if \(flying\) return flying;/);
  assert.match(fn, /if \(code !== activeLeague \|\| String\(period\) !== String\(picksPeriod\(\)\)\) return;/);
});

// --- 8 · Sol's report-gate findings, in production sequence ---------------

/**
 * The read layer with the network under the test's control. Mirrors the
 * picksround harness, kept here so these findings read as one sequence.
 */
function readBox({ cached = null, code = "AAA", codes = ["AAA", "BBB"], view = "picks" } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`);
  const reads = [];
  const round = (c, period, reveal) => ({
    code: c, period, matchday: Number(period),
    table: [{ uid: "u1", nick: "Adam", pts: 12, exact: 1 }],
    ...(reveal ? { reveal } : {}),
  });
  const box = load(["ensurePicksRound", "picksRoundUsable", "forgetPicksRound", "picksPeriod",
    "picksRoundKey", "claimPicksRound", "releasePicksRound", "revalidateRevealAfterSwitch", "revealUsable", "revealPeriod", "lockHorizonOf", "currentRoundReveal",
    "cacheRoundState", "cachedRoundState", "roundCacheKey", "roundStatePath",
    "matchweekLeagueState", "matchweekSlate", "syncShareLabel", "shareCardState",
    "shareSurface", "shareRound", "sharePeriod", "shareIconButton", "normaliseView",
    "LEGACY_VIEWS", "weeklySharePublished", "weeklyShareStatus", "weeklyTerminalCount",
    "seasonShareFreshness", "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
    "noteMatchweekCountMismatch", "matchweekMismatchLines"], {
    document: dom.window.document,
    API: "https://api.test",
    navGeneration: 0,
    render: () => {},
    picksRound: null,
    picksRoundFlights: new Map(),
    picksRoundClaim: { generation: -1, key: "" },
    revealState: null,
    revealLockHorizon: Infinity,
    roundState: null,
    roundStates: cached ? { [`${code}:7`]: cached } : {},
    currentView: view,
    leagueTab: "matchday",
    activeLeague: code,
    leagueCodes: codes,
    leagueStates: {},
    fixtures: [],
    selectedPeriod: null,
    matchweekCountMismatches: new Map(),
    currentPeriodKey: () => "7",
    periodLabel: (p) => `Matchweek ${p}`,
    uid: () => "u1",
    leagueState: { code, name: code === "AAA" ? "Sunday Six" : "Bury Legends",
      currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f1"], count: 1 } },
    fetchState: (path) => new Promise((resolve, reject) => reads.push({ path, resolve, reject })),
    api: (path) => new Promise((resolve, reject) => reads.push({ path, resolve, reject })),
    escapeHTML: (v) => String(v ?? ""),
  });
  return { box, reads, round,
    readsFor: (c) => reads.filter((r) => r.path.includes(`code=${c}`)).length };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A · the pre-lock cache that would otherwise never be revalidated ---------

test("A1 · a cold launch on a pre-lock cache paints it, then asks exactly once", async () => {
  // The exact shape Sol names: a valid, in-context round captured BEFORE
  // kick-off, so it carries an empty reveal. Nothing about it is stale by the
  // old test — and it contains none of the picks the viewer came back for.
  const app = readBox({});
  const preLock = app.round("AAA", "7", []);
  app.box.cacheRoundState("AAA", "7", preLock);

  app.box.ensurePicksRound();
  // It is adopted at once: the table is in hand before any answer lands.
  assert.ok(app.box.evalIn("picksRound"), "the cache did not paint");
  // And exactly one revalidation is in flight for it.
  assert.equal(app.reads.length, 1, `${app.reads.length} reads for one entry`);
  assert.match(app.reads[0].path, /code=AAA/);
  assert.match(app.reads[0].path, /period=7/);

  // The answer carries the picks the cache could not have had.
  app.reads[0].resolve(app.round("AAA", "7", [{ id: "f1", lockAt: "2020-01-01T00:00:00Z",
    settled: false, picks: [{ uid: "u2", nick: "Bex", p1: 1, p2: 0 }] }]));
  await settle();
  assert.equal(app.reads.length, 1, "a second read was issued");
  assert.ok(app.box.currentRoundReveal(), "the reveal never arrived");
  assert.equal(app.box.currentRoundReveal().reveal.length, 1);
});

test("A2 · a warm entry with a valid cache still revalidates exactly once", () => {
  const app = readBox({});
  app.box.cacheRoundState("AAA", "7", app.round("AAA", "7", []));
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1);
});

test("A3 · an entry with no cache acknowledges first, then asks exactly once", () => {
  const app = readBox({});
  assert.equal(app.box.evalIn("picksRound"), null, "an empty entry claimed a table");
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1);
});

test("A4 · the share table and the reveal are served by the same request", async () => {
  const app = readBox({});
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1);
  app.reads[0].resolve(app.round("AAA", "7", [{ id: "f1", lockAt: "2020-01-01T00:00:00Z",
    settled: true, picks: [{ uid: "u2", nick: "Bex", p1: 1, p2: 0, pts: 5 }] }]));
  await settle();
  // One answer, both consumers.
  assert.ok(app.box.evalIn("picksRound"), "the share table did not land");
  assert.ok(app.box.currentRoundReveal(), "the reveal did not land");
  assert.equal(app.reads.length, 1, "the two consumers cost two requests");
});

test("A5 · an answer for a context we have left cannot repaint it", async () => {
  // Left the league.
  const gone = readBox({});
  gone.box.ensurePicksRound();
  gone.box.evalIn(`activeLeague = "BBB";
    leagueState = { code: "BBB", name: "Bury Legends", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f9"], count: 1 } };
    forgetPicksRound();`);
  gone.reads[0].resolve(gone.round("AAA", "7", []));
  await settle();
  assert.equal(gone.box.evalIn("picksRound"), null, "AAA's answer landed under BBB");

  // Left the screen: the generation moved on while the read was in flight.
  const away = readBox({});
  away.box.ensurePicksRound();
  away.box.evalIn("navGeneration += 1;");
  away.reads[0].resolve(away.round("AAA", "7", []));
  await settle();
  assert.equal(away.box.evalIn("picksRound"), null, "a stale generation repainted");
});

test("A6 · entry asks, and nothing schedules a second ask", () => {
  const fn = sourceOf("ensurePicksRound");
  assert.ok(!fn.includes("setInterval"), "the entry read polls");
  assert.ok(!fn.includes("setTimeout"), "the entry read schedules a retry");
  // The boot path owes the same one revalidation a tab entry does.
  assert.match(APP, /if \(normaliseView\(currentView\) === "picks"\) ensurePicksRound\(\);/);
});

// B · no competition calendar, in any state -------------------------------

test("B1 · preseason renders the league's own state and zero fixtures", () => {
  const box = picksBox({ ids: [] });
  const html = box.picksView();
  assert.ok(!html.includes("data-pick-row"), "preseason drew fixture cards");
  assert.ok(!html.includes("proof-row"), "preseason drew calendar rows");
  // None of the calendar's fixtures reach the screen by any route.
  for (const name of ["Arsenal", "Chelsea", "Spurs", "Everton", "Leeds", "Wolves"]) {
    assert.ok(!html.includes(name), `${name} came from the competition calendar`);
  }
});

test("B1 · the loading and unpublished states carry no fixtures either", () => {
  const noSlate = picksBox({ ids: [] }).picksView();
  assert.ok(!noSlate.includes("data-match-card"), "an unpublished slate drew a card");
  // And the renderer that used to do it is gone entirely.
  assert.ok(!APP.includes("function preseasonRow"), "the calendar row survived");
  assert.ok(!APP.includes("proof-of-life"), "the calendar list survived");
  const state = sourceOf("preseasonState");
  assert.ok(!state.includes("fixtures"), "preseason still reads the calendar");
  assert.ok(!state.includes("teamBadge"), "preseason still draws badges");
  assert.match(state, /The season hasn’t started for this league\./);
});

// C · a link naming a league the viewer already plays ----------------------

test("C1 · a linked membership is selected before My Picks renders", () => {
  // The boot order, read from the source: the switch happens instead of the
  // ordinary first paint, so nothing of the stored league is drawn first.
  const boot = APP.slice(APP.indexOf("Promise.all([loadFixtures(), hydrateIdentity()])"));
  const body = boot.slice(0, boot.indexOf("registerServiceWorker()"));
  assert.match(body, /const linked = inviteCode && leagueCodes\.includes\(inviteCode\) && inviteCode !== activeLeague/);
  assert.match(body, /if \(linked\) setActiveLeague\(linked\);/);
  assert.match(body, /else render\(\);/);
  // Selected before the paint, not after it.
  assert.ok(body.indexOf("if (linked) setActiveLeague(linked);") < body.indexOf("ensurePicksRound()"));
  // A membership is never sent to the join flow.
  assert.match(body, /if \(inviteCode && !leagueCodes\.includes\(inviteCode\)\) \{ launchRouted = true; currentView = "league"; \}/);
});

test("C1 · the switch takes the ordinary safe path, with all its guards", () => {
  const fn = sourceOf("setActiveLeague");
  assert.match(fn, /forgetRevealState\(\)/, "the held round is not dropped");
  assert.match(fn, /localStorage\.setItem\(STORAGE\.activeLeague, activeLeague\)/, "not persisted");
  assert.match(fn, /hydrateCachedLeague\(\)/, "the cache is not hydrated");
  assert.match(fn, /revalidateRevealAfterSwitch\(/, "no revalidation is owed");
});

test("C2 · each removed route opens My Picks on the linked league", () => {
  const box = load(["requestedView", "normaliseView", "LEGACY_VIEWS"], { URLSearchParams });
  for (const view of ["mates", "today", "schedule"]) {
    assert.equal(box.requestedView(`?league=BBB&view=${view}`), "picks", view);
  }
  // And the league on that link is a membership, so it is selected rather
  // than offered as an invitation.
  const app = readBox({ code: "BBB", codes: ["AAA", "BBB"] });
  assert.equal(app.box.picksPeriod(), "7");
  app.box.ensurePicksRound();
  assert.equal(app.readsFor("BBB"), 1, "the linked league was not read");
  assert.equal(app.readsFor("AAA"), 0, "the stored league was read anyway");
});

test("C2 · the stored league's names and picks never paint under the linked one", async () => {
  const app = readBox({ code: "BBB", codes: ["AAA", "BBB"] });
  // AAA's round is in cache from the previous session. It must not be usable.
  app.box.cacheRoundState("AAA", "7", app.round("AAA", "7", [{ id: "f1",
    lockAt: "2020-01-01T00:00:00Z", settled: true,
    picks: [{ uid: "u9", nick: "SomebodyFromAAA", p1: 3, p2: 3, pts: 5 }] }]));
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "the linked league was not revalidated exactly once");
  assert.equal(app.box.currentRoundReveal(), null, "AAA's round was adopted under BBB");
  assert.equal(app.box.evalIn("picksRound"), null, "AAA's table landed under BBB");
  // Even AAA's own answer, arriving late, is refused for BBB.
  app.reads[0].resolve(app.round("AAA", "7", []));
  await settle();
  assert.equal(app.box.currentRoundReveal(), null, "a foreign answer was adopted");
});

// --- 9 · one entry, one round read (Sol's closing finding) ---------------
//
// The flight map is cleared when a read SETTLES, so a fast answer landing
// before the awaited prefetch work finished left the second ensure point with
// nothing to join. fetchState could not help: it folds requests that are in
// the air together, not one that has already landed. The claim outlives the
// flight, and these are the sequences that proved it was needed.

test("R1 · a fast first answer does not let the second ensure point ask again", async () => {
  const app = readBox({});
  // navigateToView's first ensure point.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1);
  // The answer lands while the prefetch work is still going.
  app.reads[0].resolve(app.round("AAA", "7", []));
  await settle();
  // ...and the second ensure point runs, after the prefetch resolves.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "one entry issued two round reads");
});

test("R2 · an unknown period claims nothing, so the later attempt still asks", () => {
  const app = readBox({});
  // The early attempt: the league's own state has not named a period yet.
  app.box.evalIn(`leagueState = { code: "AAA", name: "Sunday Six", currentPeriod: null,
    currentSlate: null };`);
  assert.equal(app.box.ensurePicksRound(), null, "a read was started with no week");
  assert.equal(app.reads.length, 0);
  // The season answer names it, and the later attempt gets its one chance.
  app.box.evalIn(`leagueState = { code: "AAA", name: "Sunday Six", currentPeriod: "7",
    currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f1"], count: 1 } };`);
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "the week arriving did not buy a read");
  // And only one.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "the later attempt asked twice");
});

test("R3 · a linked-league startup reads the linked league once, and the stored one never", async () => {
  // Stored AAA, link names BBB. The boot path and setActiveLeague's delayed
  // reveal refresh both reach the same context; between them, one read.
  const app = readBox({ code: "BBB", codes: ["AAA", "BBB"] });
  app.box.ensurePicksRound();                       // the boot path
  assert.equal(app.reads.length, 1);
  // BBB's round answers before the season refresh has finished.
  app.reads[0].resolve(app.round("BBB", "7", []));
  await settle();
  // ...and then the delayed switch revalidation runs.
  await app.box.revalidateRevealAfterSwitch("BBB");
  assert.equal(app.readsFor("BBB"), 1, "the linked league was read twice");
  assert.equal(app.readsFor("AAA"), 0, "the stored league was read at all");
});

test("R4 · a same-tab entry is one read", () => {
  const app = readBox({});
  app.box.ensurePicksRound();
  app.box.ensurePicksRound();
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1);
});

test("R5 · leaving during the request caches the answer and repaints nothing", async () => {
  const app = readBox({});
  app.box.ensurePicksRound();
  app.box.evalIn("navGeneration += 1;");            // the viewer moved on
  app.reads[0].resolve(app.round("AAA", "7", [{ id: "f1", lockAt: "2020-01-01T00:00:00Z",
    settled: true, picks: [{ uid: "u2", nick: "Bex", p1: 1, p2: 0, pts: 5 }] }]));
  await settle();
  assert.equal(app.box.evalIn("picksRound"), null, "a stale answer repainted");
  // Cached, though — the work is not thrown away.
  assert.ok(app.box.cachedRoundState("AAA", "7"), "the answer was not cached");
});

test("R6 · a genuine later entry gets a new generation and one new read", async () => {
  const app = readBox({});
  app.box.ensurePicksRound();
  app.reads[0].resolve(app.round("AAA", "7", []));
  await settle();
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "the same entry asked twice");
  // A real navigation to My Picks bumps the generation.
  app.box.evalIn("navGeneration += 1;");
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 2, "a later entry could not revalidate");
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 2, "the later entry asked twice");
});

test("R7 · a crossed kick-off releases the claim, and takes it exactly once", () => {
  // The one case where an entry legitimately asks again: the foreground
  // return that crossed a boundary the screen was waiting on.
  const fn = sourceOf("refreshRevealOnForeground");
  assert.match(fn, /releasePicksRound\(\);/);
  assert.match(fn, /await ensurePicksRound\(\);/);
  assert.match(fn, /revealLockHorizon = Infinity;/, "one crossing, one revalidation");
  // And there is one reader, so there is one place a read can come from.
  assert.match(sourceOf("revalidateRevealAfterSwitch"), /await ensurePicksRound\(\);/);
  assert.ok(!APP.includes("async function loadRevealState"), "a second reader survived");
  // The endpoint is read elsewhere for other screens — loadRoundState is the
  // Weekly tab's browsed week, ensureRoundState the cabinet's — but nothing
  // on My Picks reads it except the coordinator.
  for (const path of ["revalidateRevealAfterSwitch", "refreshRevealOnForeground"]) {
    assert.ok(!sourceOf(path).includes("fetchState"), `${path} reads the endpoint itself`);
    assert.match(sourceOf(path), /ensurePicksRound\(\)/, path);
  }
  assert.equal((sourceOf("ensurePicksRound").match(/fetchState\(/g) || []).length, 1);
});

test("R8 · a league switch is a new context, and gets its own single read", () => {
  const app = readBox({});
  app.box.ensurePicksRound();
  assert.equal(app.readsFor("AAA"), 1);
  // The pill moves. Same generation, different context: one more read, for
  // the new league only.
  app.box.evalIn(`activeLeague = "BBB";
    leagueState = { code: "BBB", name: "Bury Legends", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f9"], count: 1 } };
    forgetPicksRound();`);
  app.box.ensurePicksRound();
  assert.equal(app.readsFor("BBB"), 1, "the new league was not read");
  assert.equal(app.readsFor("AAA"), 1, "the old league was read again");
  app.box.ensurePicksRound();
  assert.equal(app.readsFor("BBB"), 1, "the new league was read twice");
});
