// Adam's v1.7 corrective pass: the executed tests the brief names, for the
// parts the existing suites did not already cover.
//
// test/matchweek.test.mjs owns the slate contract, test/slicebcd.test.mjs the
// row states, test/presentation.test.mjs the exported cards. This file covers
// the navigation, the redirect, the two Season disclosures and the share
// controls' presentation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, APP, sourceOf, constOf } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// --- 1 · the four-item navigation ------------------------------------------

test("N1 · the bar is Next, My Picks, League, Rules — in that order", () => {
  const dom = new JSDOM(HTML);
  const buttons = [...dom.window.document.querySelectorAll(".bottom-nav button")];
  assert.deepEqual(buttons.map((b) => b.dataset.view), ["today", "picks", "league", "rules"]);
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, "").trim()),
    ["Next", "My Picks", "League", "Rules"]);
});

test("N1 · the four items divide the bar evenly", () => {
  const nav = CSS.slice(CSS.indexOf(".bottom-nav {"), CSS.indexOf("}", CSS.indexOf(".bottom-nav {")));
  assert.match(nav, /grid-template-columns: repeat\(4, 1fr\);/,
    "the bar still divides in five, or unevenly");
  // Every item is a real target, and the active one is marked.
  assert.match(CSS, /\.bottom-nav button \{[^}]*height: 52px/);
  assert.match(CSS, /\.bottom-nav button\.active \{/);
});

test("N1 · the bar is a labelled navigation landmark and every item is a button", () => {
  const dom = new JSDOM(HTML);
  const nav = dom.window.document.querySelector(".bottom-nav");
  assert.equal(nav.tagName, "NAV");
  assert.equal(nav.getAttribute("aria-label"), "Main navigation");
  for (const button of nav.querySelectorAll("button")) {
    assert.equal(button.getAttribute("type"), "button");
    // The emoji is decoration; the word is the name.
    assert.ok(button.textContent.replace(/[^A-Za-z]/g, "").length > 0, "an item has no words");
  }
});

// --- 2 · Matchweek is absent, not merely hidden ----------------------------

test("N2 · nothing in the shipped markup or styles offers Matchweek as a tab", () => {
  assert.ok(!/data-view="schedule"/.test(HTML));
  assert.ok(!/>Matchweek<\/button>/.test(HTML));
  // And the view it pointed at cannot be rendered.
  const views = APP.slice(APP.indexOf("const views = {"));
  assert.ok(!views.slice(0, 200).includes("schedule:"));
});

// --- 3 · the old route still lands somewhere ------------------------------

test("N3 · every door translates the legacy view id", () => {
  assert.equal(constOf("LEGACY_VIEWS"), 'const LEGACY_VIEWS = { schedule: "picks" };');
  // The three places a stored or sent `schedule` can arrive.
  assert.match(sourceOf("navigateToView"), /const view = normaliseView\(requested\);/);
  assert.match(APP, /const html = \(views\[normaliseView\(currentView\)\] \|\| todayView\)\(\);/);
  assert.match(sourceOf("markActiveTab"), /const active = normaliseView\(currentView\);/);
});

test("N3 · a stale cached shell's Matchweek button still navigates", async () => {
  // An installed client can be serving yesterday's index.html with the old tab
  // in it. Its tap must land on My Picks rather than on nothing.
  const box = load(["normaliseView", "LEGACY_VIEWS"], {});
  assert.equal(box.normaliseView("schedule"), "picks");
  assert.equal(box.normaliseView("picks"), "picks");
  assert.equal(box.normaliseView("league"), "league");
  assert.equal(box.normaliseView(undefined), undefined);
});

test("N3 · a notification for a fixture opens it on My Picks", () => {
  const src = sourceOf("openNotificationTarget");
  assert.match(src, /await navigateToView\("picks"\);/);
  assert.match(src, /\[data-pick-row="\$\{cssEscape\(fixtureId\)\}"\]/);
  assert.match(src, /expandPick\(fixtureId\)/);
});

// --- 7 · a fresh launch --------------------------------------------------

test("N7 · a launch that is waiting on the week opens My Picks", () => {
  assert.match(sourceOf("applyLaunchBranch"),
    /currentView = launchBranch\(\) === "awaiting" \? "picks" : "today";/);
  // And the shell it shows is literal — it computes nothing.
  const shells = APP.slice(APP.indexOf("const VIEW_SHELLS = {"), APP.indexOf("const loadingLine ="));
  const picks = shells.slice(shells.indexOf("picks:"), shells.indexOf("league:"));
  for (const computed of ["weekStrip(", "periodsInOrder(", "matchweekSlate(", "pickRow(", "fixtures"]) {
    assert.ok(!picks.includes(computed), `the shell calls ${computed}`);
  }
  assert.match(picks, /<h2>My Picks<\/h2>/);
});

// --- 9 and 10 · what a disclosure and a paint must NOT do ------------------

test("N9 · expanding a row makes no request and no global render", () => {
  const fn = sourceOf("expandPick");
  for (const banned of ["api(", "fetch(", "render(", "loadRoundState", "loadMatesState"]) {
    assert.ok(!fn.includes(banned), `expandPick reaches ${banned}`);
  }
  // The mates section it mounts reads what the device already holds.
  const section = sourceOf("fixtureRevealSection");
  for (const banned of ["api(", "fetch(", "await"]) {
    assert.ok(!section.includes(banned), `the mates section reaches ${banned}`);
  }
  assert.match(section, /currentRoundReveal\(\)/);
});

test("N10 · one row builder, one card builder, one expansion state", () => {
  assert.equal((APP.match(/function pickRow\(/g) || []).length, 1);
  assert.equal((APP.match(/function matchCard\(/g) || []).length, 1);
  assert.equal((APP.match(/let expandedPickId/g) || []).length, 1);
  assert.ok(!APP.includes("expandedFixtureId"), "a second expansion state survives");
  // An expansion builds exactly what a first paint would have.
  assert.match(sourceOf("expandPick"), /pickRowBody\(fixture, pickEditable\(fixture\)\)/);
  assert.match(sourceOf("pickRow"), /pickRowBody\(match, editable\)/);
});

test("N10 · the consolidation added no second round read", () => {
  // My Picks shares the round the device already holds; it does not fetch one
  // to put a share control on screen.
  const round = sourceOf("shareRound");
  assert.match(round, /currentRoundReveal\(\)/);
  for (const banned of ["api(", "fetch(", "await", "loadRoundState"]) {
    assert.ok(!round.includes(banned), `shareRound reaches ${banned}`);
  }
});

// --- 11 and 12 · the share controls ---------------------------------------

function shareBox(over = {}) {
  return load(["shareIconButton", "shareCardState", "shareSurface", "shareRound", "sharePeriod",
    "normaliseView", "LEGACY_VIEWS", "weeklySharePublished", "seasonShareFreshness",
    "weeklyShareStatus", "weeklyTerminalCount", "finalScore", "isVoidFixture", "isPostponed",
    "VOID_STATUSES"], {
    currentView: "league",
    leagueTab: "season",
    activeLeague: "AAA",
    selectedPeriod: "3",
    roundState: null,
    matesState: null,
    fixtures: [],
    leagueSupportsRounds: () => true,
    currentPeriodKey: () => "3",
    periodLabel: (p) => `Matchweek ${p}`,
    seasonRounds: () => 38,
    cachedRoundState: () => null,
    matesPeriod: () => "3",
    matesUsable: () => false,
    matchweekLeagueState: () => ({ code: "AAA", currentPeriod: "3" }),
    leagueState: { code: "AAA", name: "Sunday Six", table: [{ uid: "u1", nick: "Adam", pts: 12 }],
      currentMatchday: 8, currentMatchdayHasResults: true },
    ...over,
  });
}

test("N11 · the control is an icon; its words are its accessible name", () => {
  const s = shareBox();
  const html = s.shareIconButton({ code: "AAA" }, "season");
  assert.match(html, /class="share-icon"/);
  assert.match(html, /<svg/);
  assert.match(html, /aria-hidden="true"/, "the glyph is announced");
  assert.match(html, /aria-label="Share season table, Updated through Matchweek 8"/);
  // No words in the pixels: strip the two attributes that hold the name and
  // nothing readable is left.
  const visible = html.replace(/aria-label="[^"]*"/g, "").replace(/title="[^"]*"/g, "");
  assert.ok(!/>[A-Za-z]/.test(visible.replace(/<svg[\s\S]*<\/svg>/, "")), "the control shows text");
  assert.ok(!/Updated through/.test(visible), "the freshness is printed beside the icon");
});

test("N11 · the target is 44x44 and cannot wrap or collide", () => {
  const icon = CSS.slice(CSS.indexOf(".share-icon {"), CSS.indexOf("}", CSS.indexOf(".share-icon {")));
  assert.match(icon, /width: 44px/);
  assert.match(icon, /height: 44px/);
  assert.match(icon, /place-items: center/);
  // A fixed square cannot reflow with the text size, so a larger setting moves
  // the layout around it rather than through it.
  assert.ok(!/font-size/.test(icon), "the control is sized by text");
  // The loading state keeps the same box, so nothing moves when it enables.
  assert.match(CSS, /\.share-icon\[disabled\] \{[^}]*cursor: default/);
  for (const row of [".pick-share", ".season-share"]) {
    const block = CSS.slice(CSS.indexOf(`${row} {`), CSS.indexOf("}", CSS.indexOf(`${row} {`)));
    assert.match(block, /display: flex/);
    assert.match(block, /justify-content: flex-end/);
  }
});

test("N11 · one presentation component serves all three surfaces", () => {
  assert.equal((APP.match(/function shareIconButton\(/g) || []).length, 1);
  assert.equal((APP.match(/class="share-icon"/g) || []).length, 1);
  for (const call of ['shareIconButton(state, "weekly")', 'shareIconButton(state, "season")']) {
    assert.ok(APP.includes(call), `${call} is missing`);
  }
});

test("N11 · a surface with nothing to share renders no control at all", () => {
  const s = shareBox({ leagueTab: "mates" });
  assert.equal(s.shareCardState().hidden, true);
  assert.equal(s.shareIconButton({ code: "AAA" }), "");
  const empty = shareBox({ leagueState: { code: "AAA", name: "Sunday Six", table: [] } });
  assert.equal(empty.shareIconButton({ code: "AAA" }, "season"), "");
});

test("N12 · the Season control sits under the standings and above the mates' section", () => {
  const stages = sourceOf("seasonStages");
  const order = ["banner", "cabinet", "standings", "share", "reveals"]
    .map((name) => stages.indexOf(`"${name}"`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the stages are out of order");
  assert.ok(order.every((at) => at > 0), "a stage is missing");
  assert.match(stages, /shareIconButton\(state, "season"\)/);
  // And it is no longer at the bottom of the league card.
  const view = sourceOf("leagueView");
  assert.ok(!view.includes("shareIconButton"), "the control is still in the card shell");
});

// --- 15 and 16 · the two Season disclosures -------------------------------

function seasonBox(over = {}) {
  return load(["seasonSection", "seasonSectionOpen", "seasonSectionKey", "seasonOpenSections",
    "toggleSeasonSection", "SEASON_SECTIONS", "leagueRevealsHtml", "revealsListHtml",
    "cabinetWeeksHtml", "trophyCabinet", "cabinetWeek"], {
    activeLeague: "AAA",
    leagueState: null,
    escapeHTML: (v) => String(v ?? ""),
    revealCard: (r) => `<div class="reveal-card">${r.player1}</div>`,
    cabinetWeek: (w) => `<li>${w.period}</li>`,
    PLACE_EMOJI: { gold: "G", silver: "S", bronze: "B" },
    ...over,
  });
}

const REVEALS = { reveals: [{ player1: "Arsenal" }, { player1: "Everton" }] };
const CABINET = { cabinet: { nick: "Adam", gold: 1, silver: 0, bronze: 0, podiums: 1,
  weeks: [{ period: "1" }, { period: "2" }] } };

test("N15 · both sections arrive collapsed and build nothing", () => {
  const s = seasonBox({ leagueState: { ...REVEALS, ...CABINET } });
  const reveals = s.leagueRevealsHtml(REVEALS);
  assert.match(reveals, /aria-expanded="false"/);
  assert.ok(!reveals.includes("reveal-card"), "the collapsed section built its cards");
  const cabinet = s.trophyCabinet(CABINET);
  assert.match(cabinet, /data-season-fold="weeks"/);
  assert.match(cabinet, /aria-expanded="false"/);
  assert.ok(!cabinet.includes("<li>"), "the collapsed section built its weeks");
  // The cabinet itself is untouched and visible.
  assert.match(cabinet, /trophy cabinet/);
  assert.match(cabinet, /cabinet-shelf/);
});

test("N15 · the two sections are independent, and keyed per league", () => {
  const s = seasonBox();
  assert.equal(s.seasonSectionOpen("reveals"), false);
  assert.equal(s.seasonSectionOpen("weeks"), false);
  s.evalIn(`seasonOpenSections.add(seasonSectionKey("reveals"));`);
  assert.equal(s.seasonSectionOpen("reveals"), true);
  assert.equal(s.seasonSectionOpen("weeks"), false, "opening one opened the other");
  // Another league's page starts closed, whatever this one is doing.
  s.evalIn(`activeLeague = "BBB";`);
  assert.equal(s.seasonSectionOpen("reveals"), false, "one league's choice leaked into another's");
  s.evalIn(`activeLeague = "AAA";`);
  assert.equal(s.seasonSectionOpen("reveals"), true, "the choice was lost on the way back");
});

test("N16 · expanding is a DOM edit: no render, no rebuild, no scrolling", () => {
  const fn = sourceOf("toggleSeasonSection");
  for (const banned of ["render(", "mountResults(", "scrollTo", "scrollIntoView", "api(", "fetch("]) {
    assert.ok(!fn.includes(banned), `toggleSeasonSection reaches ${banned}`);
  }
  assert.match(fn, /body\.innerHTML = opening \? \(SEASON_SECTIONS\[name\]\?\.\(leagueState\) \?\? ""\) : "";/);
  assert.match(fn, /head\.setAttribute\("aria-expanded", opening \? "true" : "false"\)/);
});

test("N16 · the content is built on first expansion, against the live DOM", () => {
  const dom = new JSDOM(`<!doctype html><body></body>`);
  const { document, CSS: cssApi } = dom.window;
  const s = seasonBox({ document, CSS: cssApi, leagueState: { ...REVEALS, ...CABINET } });
  document.body.innerHTML = s.leagueRevealsHtml(REVEALS);
  const section = document.querySelector('[data-season-fold="reveals"]');
  const body = section.querySelector("[data-season-fold-body]");
  const head = section.querySelector("[data-season-toggle]");
  assert.equal(body.innerHTML, "", "the collapsed body was built anyway");
  assert.equal(head.getAttribute("aria-expanded"), "false");

  s.toggleSeasonSection("reveals");
  assert.ok(body.innerHTML.includes("reveal-card"), "expansion built nothing");
  assert.equal(head.getAttribute("aria-expanded"), "true");
  assert.equal(section.classList.contains("is-open"), true);
  // The same nodes: nothing around it was replaced, so the scroller cannot move.
  assert.equal(document.querySelector('[data-season-fold="reveals"]'), section);
  assert.equal(section.querySelector("[data-season-fold-body]"), body);

  s.toggleSeasonSection("reveals");
  assert.equal(body.innerHTML, "", "collapsing left the markup built");
  assert.equal(head.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector('[data-season-fold="reveals"]'), section);
});

test("N16 · the head is a real 44pt target with a name and a state", () => {
  const s = seasonBox();
  const html = s.seasonSection("reveals", "Mates' results and scoring", () => "X");
  assert.match(html, /<button type="button" class="season-fold-head" data-season-toggle="reveals"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="season-reveals"/);
  assert.match(html, /Mates' results and scoring/);
  const head = CSS.slice(CSS.indexOf(".season-fold-head {"), CSS.indexOf("}", CSS.indexOf(".season-fold-head {")));
  assert.match(head, /min-height: 44px/);
});

// --- 17 · the state is said once ------------------------------------------

test("N17 · the week's state is on the header, never repeated on every card", () => {
  assert.ok(!APP.includes("pick-row-status"), "the repeated status element survives");
  assert.ok(!APP.includes("fixture-row-state"), "the repeated state element survives");
  const view = sourceOf("picksView");
  assert.match(view, /pickListState\(slots\)/);
  const row = sourceOf("pickRow");
  assert.ok(!row.includes("MATCHWEEK_ROW_LINE"), "the row still prints the week's state");
  // A saved confirmation is brief, not furniture.
  assert.match(constOf("PICK_SAVED_MS"), /const PICK_SAVED_MS = 4000;/);
  assert.match(constOf("pickJustSaved"), /Date\.now\(\) - pick\.savedAt < PICK_SAVED_MS/);
});

// --- 6 · the four states, on the consolidated card, against a real DOM -----

const HOUR = 3600000;
const now = Date.now();
const fx = (id, o = {}) => ({
  id, player1: o.h || "Home", player2: o.a || "Away", matchday: 7,
  startAt: new Date(now + (o.hours ?? 24) * HOUR).toISOString(),
  ...(o.result ? { result: o.result, status: "complete" } : {}),
  ...(o.lockAt ? { lockAt: o.lockAt } : {}),
});
const OPEN = fx("f-open", { hours: 30, h: "Arsenal", a: "Coventry" });
const LOCKED = fx("f-locked", { hours: 3, lockAt: new Date(now - HOUR).toISOString(), h: "Hull", a: "Man Utd" });
const SETTLED = fx("f-settled", { hours: -26, result: [2, 1], h: "Brighton", a: "Villa" });

function journeyBox(picks = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`);
  const { document, CSS: cssApi } = dom.window;
  const requests = { api: 0 };
  const box = load(["picksView", "pickRow", "pickRowBody", "pickRowLabel", "pickJustSaved",
    "pickListState", "pickProgress", "pickDeadlineLine", "pickEditable", "expandPick",
    "matchweekLeagueState", "matchweekSlate", "matchweekSlots", "matchweekContext",
    "matchweekEmpty", "matchweekUnavailable", "matchweekLeagueName", "matchweekRowState",
    "MATCHWEEK_ROW_LINE", "isSettledCard", "resultState", "RESULT_FIRST_STATES",
    "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES", "matchOpen",
    "closedStatus", "clientLockMs", "shortKickoff",
    "noteMatchweekCountMismatch", "matchweekMismatchLines"], {
    document,
    CSS: cssApi,
    fixtures: [OPEN, LOCKED, SETTLED],
    picks,
    activeLeague: "AAA",
    leagueCodes: ["AAA"],
    leagueNames: {},
    leagueStates: {},
    playerName: "Adam",
    expandedPickId: null,
    matchweekCountMismatches: new Map(),
    leagueState: { code: "AAA", name: "Sunday Six", currentPeriod: "7",
      currentSlate: { period: "7", status: "published", count: 3,
        fixtureIds: [OPEN.id, LOCKED.id, SETTLED.id] } },
    periodLabel: (p) => `Matchweek ${p}`,
    pulsingStatus: (m) => `<p>${m}</p>`,
    onboardingState: () => "",
    leagueSwitcher: () => "",
    scorePicker: (m) => `<div class="score-picker" data-picker="${m.id}"></div>`,
    // The editable disclosure mounts the same card Next builds.
    matchCard: (m, opts) => `<article class="match-card" data-match-card="${m.id}"${
      opts?.social === false ? ' data-social="false"' : ""}><div class="score-picker" data-picker="${m.id}"></div></article>`,
    resultCard: (m) => `<article class="result-card" data-match-card="${m.id}"><div class="result-score">2–1</div><p class="result-pick">Your pick 2-1 · 5 points</p></article>`,
    fixtureRevealSection: (m) => `<section class="fixture-reveal" data-reveal="${m.id}">MATES</section>`,
    pickShareRow: () => "",
    api: async () => { requests.api += 1; return {}; },
  });
  document.getElementById("app").innerHTML = box.picksView();
  return { box, document, requests,
    row: (id) => document.querySelector(`[data-pick-row="${id}"]`) };
}

test("J6 · before kick-off the row is editable and says nothing about anybody else", () => {
  const app = journeyBox();
  const row = app.row(OPEN.id);
  assert.equal(row.dataset.rowState, "open");
  assert.equal(row.querySelector("[data-expand-pick]").getAttribute("aria-expanded"), "false");
  app.box.expandPick(OPEN.id);
  const body = row.querySelector(".pick-row-body");
  assert.ok(body.innerHTML.includes("score-picker"), "the score controls did not mount");
  assert.ok(!body.innerHTML.includes("MATES"), "an open fixture leaked the mates section");
  assert.equal(app.requests.api, 0);
});

test("J6 · after lock the pick is retained and the mates section is what opens", () => {
  const app = journeyBox({ [LOCKED.id]: { p1: 3, p2: 0 } });
  const row = app.row(LOCKED.id);
  assert.equal(row.dataset.rowState, "locked");
  assert.match(row.innerHTML, /class="pick-row-score">3-0</, "the saved pick was lost");
  assert.match(row.querySelector("[data-expand-pick]").getAttribute("aria-label"),
    /your prediction 3-0, locked/);
  app.box.expandPick(LOCKED.id);
  const body = row.querySelector(".pick-row-body");
  assert.ok(body.innerHTML.includes("MATES"), "the mates section did not mount after lock");
  assert.ok(!body.innerHTML.includes("score-picker"), "a locked fixture still offered controls");
  assert.equal(app.requests.api, 0, "opening the disclosure asked the network something");
});

test("J6 · a settled row leads with the score, with the mates behind the disclosure", () => {
  const app = journeyBox({ [SETTLED.id]: { p1: 2, p2: 1 } });
  const row = app.row(SETTLED.id);
  assert.equal(row.dataset.rowState, "settled");
  const html = row.innerHTML;
  assert.ok(html.indexOf("result-score") < html.indexOf("result-pick"), "the pick leads the score");
  assert.ok(html.indexOf("result-score") < html.indexOf("data-expand-pick"), "the mates lead the score");
  assert.ok(!html.includes("MATES"), "a closed settled row drew the mates section");
  app.box.expandPick(SETTLED.id);
  assert.ok(row.querySelector(".pick-row-body").innerHTML.includes("MATES"));
  assert.equal(app.requests.api, 0);
});

test("J6 · one disclosure at a time, across all three states", () => {
  const app = journeyBox({ [LOCKED.id]: { p1: 1, p2: 1 } });
  const open = (id) => app.box.expandPick(id);
  const bodies = () => [OPEN.id, LOCKED.id, SETTLED.id]
    .map((id) => app.row(id).querySelector(".pick-row-body").innerHTML)
    .filter(Boolean).length;
  open(OPEN.id);
  assert.equal(bodies(), 1);
  open(LOCKED.id);
  assert.equal(bodies(), 1, "two rows were open at once");
  open(SETTLED.id);
  assert.equal(bodies(), 1);
  open(SETTLED.id);
  assert.equal(bodies(), 0, "tapping the open row again did not close it");
  assert.equal(app.requests.api, 0);
});

test("J6 · the week's state is said once, above the list", () => {
  const app = journeyBox({ [OPEN.id]: { p1: 1, p2: 0 } });
  const head = app.document.querySelector(".section-head").textContent;
  assert.match(head, /1 of 3 saved/);
  // One fixture still open, two past it.
  assert.match(head, /1 of 3 still open/);
  const list = app.document.querySelector(".pick-list").innerHTML;
  assert.ok(!/still open/.test(list), "the state is repeated on the cards");
  assert.ok(!/edit until kick-off/.test(list), "the state is repeated on the cards");
});
