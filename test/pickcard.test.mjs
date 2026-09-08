// Adam's v1.7 My Picks full-editing-card correction.
//
// Tapping an editable fixture used to open a bare score stepper — a truncated
// version of a card that already existed. It now mounts the SAME card Next
// builds, from the same data and the same formatting, with one difference: an
// editable fixture has not locked, so nobody else's prediction may be on it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, APP, sourceOf } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const HOUR = 3600000;
const now = Date.now();

const fx = (id, o = {}) => ({
  id, player1: o.h || "Arsenal", player2: o.a || "Coventry City", matchday: 7,
  startAt: new Date(now + (o.hours ?? 30) * HOUR).toISOString(),
  venue: o.venue === null ? undefined : (o.venue || "Emirates Stadium"),
  broadcaster: o.broadcaster ?? "Sky Sports",
  ...(o.result ? { result: o.result, status: "complete" } : {}),
  ...(o.lockAt ? { lockAt: o.lockAt } : {}),
});
const OPEN = fx("f-open");
const LOCKED = fx("f-locked", { hours: 3, lockAt: new Date(now - HOUR).toISOString(), h: "Hull City", a: "Man Utd" });
const SETTLED = fx("f-settled", { hours: -26, result: [2, 1], h: "Brighton", a: "Aston Villa" });

const NAMES = ["picksView", "pickRow", "pickRowBody", "pickRowLabel", "pickJustSaved", "pickListState",
  "pickProgress", "pickDeadlineLine", "pickEditable", "expandPick", "matchCard", "matchIntelStrip",
  "resultText", "matchOpen", "isSettledCard", "resultState", "RESULT_FIRST_STATES",
  "matchweekLeagueState", "matchweekSlate", "matchweekSlots", "matchweekContext", "matchweekEmpty",
  "matchweekUnavailable", "matchweekLeagueName", "matchweekRowState", "MATCHWEEK_ROW_LINE",
  "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES", "closedStatus", "clientLockMs",
  "shortKickoff", "noteMatchweekCountMismatch", "matchweekMismatchLines"];

function cardBox({ picks = {}, fixtures = [OPEN, LOCKED, SETTLED], ids = null, over = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`);
  const { document } = dom.window;
  const calls = { api: 0, render: 0, fetch: 0 };
  const box = load(NAMES, {
    document,
    fixtures,
    picks,
    activeLeague: "AAA",
    leagueCodes: ["AAA"],
    leagueNames: {},
    leagueStates: {},
    playerName: "Adam",
    expandedPickId: null,
    matchweekCountMismatches: new Map(),
    leagueState: { code: "AAA", name: "Sunday Six", currentPeriod: "7",
      currentSlate: { period: "7", status: "published",
        fixtureIds: (ids || fixtures.map((f) => f.id)), count: (ids || fixtures).length } },
    periodLabel: (p) => `Matchweek ${p}`,
    pulsingStatus: (m) => `<p>${m}</p>`,
    onboardingState: () => "",
    leagueSwitcher: () => "",
    pickShareRow: () => "",
    // Everything the shared card is made of, stubbed once — so what this file
    // proves is that My Picks mounts THE CARD, not what the card is made of.
    calendarLink: (m) => ({ href: `#${m.id}`, download: `${m.id}.ics` }),
    matchTime: (m) => `Sat 12 Sept · 15:00`,
    teamBadge: (n) => `<i class="badge" data-badge="${n}"></i>`,
    weatherIntel: (m) => (m.venue ? { icon: "☀", temp: 18, desc: "Clear", provisional: false } : null),
    probabilityStrip: (m) => `<div class="prob-strip" data-prob="${m.id}"></div>`,
    formGuide: (m) => (m.venue ? `<div class="form-guide" data-form="${m.id}">WWDLW</div>`
      : `<p class="form-guide form-guide-empty">Form guide unavailable.</p>`),
    pickStatus: (m, pick) => `<p class="pick-status">Your pick ${pick.p1}-${pick.p2}</p>`,
    scorePicker: (m, open) => `<div class="score-picker" data-picker="${m.id}" data-open="${!!open}">
      <button type="button" data-score-step="p1,1" aria-label="Increase ${m.player1} score">＋</button>
      <span data-score-value="p1">0</span><span data-score-value="p2">0</span>
      <button type="button" data-lock-score="${m.id}">Save prediction</button></div>`,
    fixtureRevealSection: (m) => `<section class="fixture-reveal" data-reveal="${m.id}">MATES</section>`,
    resultCard: (m) => `<article class="result-card" data-match-card="${m.id}"></article>`,
    pickRevealSection: () => "",
    api: async () => { calls.api += 1; return {}; },
    fetch: async () => { calls.fetch += 1; return {}; },
    render: () => { calls.render += 1; },
    ...over,
  });
  document.getElementById("app").innerHTML = box.picksView();
  return { box, document, calls,
    row: (id) => document.querySelector(`[data-pick-row="${id}"]`),
    body: (id) => document.querySelector(`[data-pick-row="${id}"] .pick-row-body`) };
}

// --- 1 and 2 · the same card as Next --------------------------------------

test("C1 · an editable fixture expands to the whole Next card, not a stepper", () => {
  const app = cardBox();
  app.box.expandPick(OPEN.id);
  const body = app.body(OPEN.id).innerHTML;
  // Everything the brief lists.
  assert.match(body, /data-match-card="f-open"/, "it is not the shared card");
  assert.match(body, /data-badge="Arsenal"/, "no home team presentation");
  assert.match(body, /data-badge="Coventry City"/, "no away team presentation");
  assert.match(body, /Sat 12 Sept · 15:00/, "no date and kick-off");
  assert.match(body, /venue-pill/, "no venue");
  assert.match(body, /Emirates Stadium/);
  assert.match(body, /data-form="f-open"/, "no form guide");
  assert.match(body, /data-prob="f-open"/, "no fixture context");
  assert.match(body, /data-picker="f-open"/, "no score selectors");
  assert.match(body, /data-lock-score="f-open"/, "no save action");
  assert.match(body, /Predictions open/, "no lock state");
});

test("C2 · it is literally the same renderer Next uses, not a copy", () => {
  // One function builds it, and My Picks calls that function.
  assert.equal((APP.match(/^function matchCard\(/gm) || []).length, 1, "a second card renderer exists");
  assert.match(sourceOf("pickRowBody"), /matchCard\(match, \{ social: false \}\)/);
  // The body is byte-identical to what Next would build, but for the social
  // section — which is the privacy boundary, not a presentation difference.
  const app = cardBox();
  const mine = app.box.pickRowBody(OPEN, true);
  const next = app.box.matchCard(OPEN, { social: false });
  assert.equal(mine, next, "My Picks and Next disagree about the same fixture");
  // And Next's own card is the same thing plus the social section.
  const social = app.box.matchCard(OPEN);
  assert.equal(social.replace(/<section class="fixture-reveal"[\s\S]*?<\/section>/, ""), next);
});

// --- 3 · the existing prediction ------------------------------------------

test("C3 · an existing prediction is shown on the expanded card", () => {
  const app = cardBox({ picks: { [OPEN.id]: { p1: 2, p2: 1 } } });
  app.box.expandPick(OPEN.id);
  const body = app.body(OPEN.id).innerHTML;
  assert.match(body, /Your pick 2-1/, "the saved prediction is not on the card");
  assert.match(body, /data-picker="f-open"/, "the selectors are missing");
  // The row's own summary still carries it too.
  assert.match(app.row(OPEN.id).innerHTML, /class="pick-row-score">2-1</);
});

// --- 4 · editing in place --------------------------------------------------

test("C4 · the score controls are live and open, with no navigation", () => {
  const app = cardBox();
  app.box.expandPick(OPEN.id);
  assert.match(app.body(OPEN.id).innerHTML, /data-open="true"/, "the picker is not editable");
  // Nothing about expanding navigates or renders globally.
  assert.equal(app.calls.render, 0, "expanding rendered globally");
  assert.equal(app.calls.api, 0);
  const expand = sourceOf("expandPick");
  for (const banned of ["navigateToView", "currentView =", "render(", "scrollTo", "scrollIntoView"]) {
    assert.ok(!expand.includes(banned), `expandPick reaches ${banned}`);
  }
});

test("C4 · a score step edits retained DOM, never the whole page", () => {
  // The stepper writes into the value it finds and returns; the save is the
  // only thing that goes further.
  const handler = APP.slice(APP.indexOf('const step = event.target.closest("[data-score-step]");'));
  const branch = handler.slice(0, handler.indexOf('if (event.target.closest("[data-lock-score]"))'));
  assert.match(branch, /value\.textContent = Math\.max\(0, Math\.min\(9,/);
  assert.ok(!branch.includes("render("), "a score step renders the page");
  assert.ok(!branch.includes("scrollTo"), "a score step moves the scroller");
});

// --- 5 · one at a time -----------------------------------------------------

test("C5 · opening a second card closes the first", () => {
  const app = cardBox({ fixtures: [OPEN, fx("f-open2", { h: "Everton", a: "Fulham" }), LOCKED, SETTLED] });
  app.box.expandPick(OPEN.id);
  assert.ok(app.body(OPEN.id).innerHTML.includes("data-match-card"), "the first did not open");
  app.box.expandPick("f-open2");
  assert.equal(app.body(OPEN.id).innerHTML, "", "the first card stayed mounted");
  assert.ok(app.body("f-open2").innerHTML.includes("data-match-card"), "the second did not open");
  assert.equal(
    app.document.querySelectorAll("[data-pick-row] .pick-row-body [data-match-card]").length, 1,
    "two cards are mounted at once");
  // And the accessible state follows.
  assert.equal(app.row(OPEN.id).querySelector("[data-expand-pick]").getAttribute("aria-expanded"), "false");
  assert.equal(app.row("f-open2").querySelector("[data-expand-pick]").getAttribute("aria-expanded"), "true");
});

// --- 6 · zero requests -----------------------------------------------------

test("C6 · expanding makes no request of any kind", () => {
  const app = cardBox({ picks: { [OPEN.id]: { p1: 1, p2: 1 } } });
  for (const id of [OPEN.id, LOCKED.id, SETTLED.id, OPEN.id]) app.box.expandPick(id);
  assert.equal(app.calls.api, 0, "expanding asked the API something");
  assert.equal(app.calls.fetch, 0, "expanding fetched something");
  assert.equal(app.calls.render, 0, "expanding rendered globally");
  // The card is built from what the app already holds.
  for (const fn of ["matchCard", "matchIntelStrip", "pickRowBody"]) {
    const src = sourceOf(fn);
    for (const banned of ["await ", "api(", "fetch("]) {
      assert.ok(!src.includes(banned), `${fn} reaches ${banned}`);
    }
  }
});

// --- 7 · locked and settled ------------------------------------------------

test("C7 · a locked fixture never regains editing controls", () => {
  const app = cardBox({ picks: { [LOCKED.id]: { p1: 3, p2: 0 } } });
  app.box.expandPick(LOCKED.id);
  const body = app.body(LOCKED.id).innerHTML;
  assert.ok(!body.includes("data-picker="), "a locked fixture offered score controls");
  assert.ok(!body.includes("data-lock-score"), "a locked fixture offered a save action");
  assert.match(body, /data-reveal="f-locked"/, "the mates section is what a locked row opens");
  assert.equal(app.box.pickEditable(LOCKED), false);
});

test("C7 · a settled fixture opens the mates section, not an editor", () => {
  const app = cardBox({ picks: { [SETTLED.id]: { p1: 2, p2: 1 } } });
  app.box.expandPick(SETTLED.id);
  const body = app.body(SETTLED.id).innerHTML;
  assert.ok(!body.includes("data-picker="), "a settled fixture offered score controls");
  assert.match(body, /data-reveal="f-settled"/);
  // The row still leads with its result, unchanged by this correction.
  assert.match(app.row(SETTLED.id).className, /pick-row-result/);
});

test("C7 · the editable branch is the only one that mounts a card", () => {
  const body = sourceOf("pickRowBody");
  assert.match(body, /return editable \? matchCard\(match, \{ social: false \}\) : fixtureRevealSection\(match\);/);
  // pickEditable is the one gate, shared with the row's own state.
  assert.match(sourceOf("pickRow"), /const editable = pickEditable\(match\);/);
  assert.match(sourceOf("expandPick"), /pickRowBody\(fixture, pickEditable\(fixture\)\)/);
});

// --- 8 · honest fallbacks --------------------------------------------------

test("C8 · missing venue or form leaves the card usable and honest", () => {
  const bare = fx("f-bare", { venue: null, broadcaster: null });
  const app = cardBox({ fixtures: [bare, LOCKED, SETTLED] });
  app.box.expandPick("f-bare");
  const body = app.body("f-bare").innerHTML;
  assert.ok(!body.includes("venue-pill"), "a venue pill was drawn with no venue");
  assert.match(body, /Form guide unavailable\./, "no honest fallback for the form guide");
  // The point of the card still works.
  assert.match(body, /data-picker="f-bare"/, "the prediction became unusable");
  assert.match(body, /data-lock-score="f-bare"/);
  assert.match(body, /Predictions open/);
  // The intel strip is empty rather than absent or apologetic.
  assert.match(sourceOf("matchIntelStrip"), /\$\{match\.venue \? /);
});

// --- 9 · league switching --------------------------------------------------

test("C9 · a league switch cannot leave another league's card open", () => {
  assert.match(sourceOf("forgetMatesState"), /expandedPickId = null;/);
  assert.match(sourceOf("setActiveLeague"), /expandedPickId = null;/);
  // And a rebuilt list carries no mounted card until one is asked for.
  const app = cardBox();
  app.box.expandPick(OPEN.id);
  assert.ok(app.body(OPEN.id).innerHTML.includes("data-match-card"));
  app.box.evalIn(`expandedPickId = null;`);
  app.document.getElementById("app").innerHTML = app.box.picksView();
  assert.equal(app.document.querySelectorAll(".pick-row-body [data-match-card]").length, 0,
    "a card survived into a fresh paint");
});

// --- 10 · accessibility ----------------------------------------------------

test("C10 · the disclosure, the controls and the save action are all named", () => {
  const app = cardBox({ picks: { [OPEN.id]: { p1: 2, p2: 1 } } });
  const head = app.row(OPEN.id).querySelector("[data-expand-pick]");
  assert.equal(head.getAttribute("aria-expanded"), "false");
  assert.equal(head.getAttribute("aria-controls"), `pk-${OPEN.id}`);
  assert.match(head.getAttribute("aria-label"), /Arsenal against Coventry City, your prediction 2-1, editable until kick-off/);
  assert.equal(app.body(OPEN.id).id, `pk-${OPEN.id}`, "the body is not what aria-controls names");

  app.box.expandPick(OPEN.id);
  assert.equal(head.getAttribute("aria-expanded"), "true", "the expanded state is not announced");
  const body = app.body(OPEN.id).innerHTML;
  assert.match(body, /aria-label="Increase Arsenal score"/, "the stepper is unnamed");
  assert.match(body, /Save prediction/, "the save action is unnamed");
  // The row control is a real target.
  const headCss = CSS.slice(CSS.indexOf(".pick-row-head {"), CSS.indexOf("}", CSS.indexOf(".pick-row-head {")));
  assert.match(headCss, /min-height: 44px/);
});

test("C10 · the card is announced as one region per fixture", () => {
  const app = cardBox();
  app.box.expandPick(OPEN.id);
  // Scoped to the disclosures: a settled row's result card is also a
  // match-card, and it is not what this is about.
  const cards = app.document.querySelectorAll(".pick-row-body [data-match-card]");
  assert.equal(cards.length, 1, "more than one disclosure holds a card");
  assert.equal(cards[0].dataset.matchCard, OPEN.id, "the card is not the one that was tapped");
});
