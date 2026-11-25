// v1.8.1 (35) — the lock time reads "at" once, and the week status card is gone.
//
// 1. lockTimeLabel joined its own ", " onto Intl's output, and the League card
//    then turned ", " into " at ". Node's ICU joins en-GB date and time with
//    ", ", so the suites read correctly; WebKit's joins them with " at ", so the
//    phone read "locks Sat 28 Nov at at 15:00" (and My Picks "at , 15:00").
//    These run the real code against BOTH joiners.
// 2. The Weekly week card (roundBanner) is replaced by one line: the current
//    week's status rides on the lock line ("final", "N fixtures pending"); any
//    other week picked from the dropdown gets "Week 12 · final". A settled
//    week keeps its rostrum, and nothing else of the card survives.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { load, sourceOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const LOCK = "2026-11-28T15:00:00Z";
const PAST = new Date(Date.now() - 3600000).toISOString();
const FUTURE = new Date(Date.now() + 30 * 3600000).toISOString();
const text = (html) => new JSDOM(`<body>${html}</body>`).window.document.body.textContent.replace(/\s+/g, " ").trim();

/** An Intl whose en-GB date-time joiner is WebKit's " at " — the phone's. */
function webkitIntl() {
  class DateTimeFormat {
    constructor(locale, options) { this.real = new Intl.DateTimeFormat(locale, options); }
    formatToParts(date) {
      return this.real.formatToParts(date).map((p) =>
        (p.type === "literal" && p.value === ", " ? { ...p, value: " at " } : p));
    }
    format(date) { return this.formatToParts(date).map((p) => p.value).join(""); }
  }
  return { ...Intl, DateTimeFormat };
}

const ENGINES = { "Node ICU (\", \")": {}, "WebKit ICU (\" at \")": { Intl: webkitIntl() } };
const LINES = ["hostSlateControl", "lockLine", "slateLocked", "cardLockLine", "weekStatusWord", "lockWeekPrefix",
  "lockTimeLabel", "periodLabel", "periodLabelLong", "isWindowKey", "slateNotice"];

function box(stubs = {}) {
  return load(LINES, {
    uid: () => "host", weekNumberFor: () => 13, windowLabel: () => "", weekDateRange: () => "",
    awaitingSlate: () => false, setAndForgetActive: () => false, leagueState: { code: "AAA", name: "Burtons" },
    ...stubs,
  });
}
const card = (b, slate, status) => text(b.hostSlateControl({ code: "AAA", owner: "host", currentPeriod: "13",
  currentMatchdayStatus: status, currentSlate: { period: "13", ...slate } }));

for (const [engine, stubs] of Object.entries(ENGINES)) {
  test(`${engine}: the League card reads "at" once, and My Picks reads "Locks … at …"`, () => {
    const b = box({ ...stubs, slateForPeriod: () => ({ period: "13", status: "published", lockAt: LOCK, locked: false }),
      isLeagueHost: () => false });
    // Before 28 Nov the open line; the test clock may be past it, so pin "open" by
    // reading the label directly as well as through the card when it is open.
    assert.equal(b.lockTimeLabel({ lockAt: LOCK }), "Sat 28 Nov at 15:00");
    const open = card(b, { lockAt: FUTURE, locked: false }, "in progress");
    assert.match(open, /^Matchweek 13 · locks \w{3} \d{1,2} \w{3} at \d{2}:\d{2} Edit line-up$/);
    assert.doesNotMatch(open, /at\s+at|at\s*,/);
    const picks = text(b.slateNotice("13"));
    if (Date.parse(LOCK) > Date.now()) assert.equal(picks, "Locks Sat 28 Nov at 15:00");
    assert.doesNotMatch(picks, /at\s+at|at\s*,/);
  });
}

test("the current week's status rides on the lock line: locked, pending, final", () => {
  const b = box();
  assert.equal(card(b, { lockAt: PAST, locked: true }, "in progress"),
    "Matchweek 13 · line-up locked — the first fixture has kicked off.");
  assert.equal(card(b, { lockAt: PAST, locked: true }, "2 fixtures pending"), "Matchweek 13 · line-up locked · 2 fixtures pending");
  assert.equal(card(b, { lockAt: PAST, locked: true }, "1 fixture pending"), "Matchweek 13 · line-up locked · 1 fixture pending");
  assert.equal(card(b, { lockAt: PAST, locked: true }, "complete"), "Matchweek 13 · final");
  // An open week never claims a status, and the host keeps the edit.
  assert.match(card(b, { lockAt: FUTURE, locked: false }, "2 fixtures pending"), /^Matchweek 13 · locks .* Edit line-up$/);
  // A member never gets the edit; with no line-up yet, a member sees nothing new.
  const member = box({ uid: () => "member" });
  assert.doesNotMatch(card(member, { lockAt: FUTURE, locked: false }, "in progress"), /Edit line-up/);
  assert.equal(member.hostSlateControl({ code: "AAA", owner: "host", currentPeriod: "13", currentSlate: null }), "");
  // My Picks' notice is not given the status: its copy is unchanged.
  assert.match(sourceOf("slateNotice"), /\$\{lockLine\(published\)\}/);
});

function panel() {
  return load(["weekStatusLine", "weekStatusWord", "weekPodium", "podiumSteps", "podiumStep", "PLACE_NUMBER", "PLACE_EMOJI",
    "periodLabel", "periodLabelLong", "isWindowKey"], { weekNumberFor: (p) => Number(p), windowLabel: () => "", weekDateRange: () => "" });
}
const PODIUM = [{ uid: "u1", nick: "Adam", place: "gold", pts: 9 }, { uid: "u2", nick: "Tom", place: "silver", pts: 6 }];

test("a week picked from the dropdown gets one line; the current week gets none", () => {
  const p = panel();
  const state = { currentPeriod: "13" };
  assert.equal(text(p.weekStatusLine({ period: "12", complete: true, status: "complete" }, state)), "Matchweek 12 · final");
  assert.equal(text(p.weekStatusLine({ period: "11", complete: false, status: "1 fixture pending" }, state)), "Matchweek 11 · 1 fixture pending");
  // Not started or in progress, or no fixtures: nothing to say, so no line.
  assert.equal(p.weekStatusLine({ period: "14", complete: false, status: "in progress" }, state), "");
  assert.equal(p.weekStatusLine({ period: "15", complete: false, status: "no fixtures" }, state), "");
  // The current week is the lock line's to describe — never said twice.
  assert.equal(p.weekStatusLine({ period: "13", complete: true, status: "complete" }, state), "");
});

test("a settled week keeps its rostrum; nothing else of the card survives", () => {
  const p = panel();
  const settled = p.weekPodium({ complete: true, podium: PODIUM });
  const d = new JSDOM(`<body>${settled}</body>`).window.document;
  assert.ok(d.querySelector(".podium-steps"), "the rostrum went with the card");
  assert.deepEqual([...d.querySelectorAll(".podium-name")].map((n) => n.textContent), ["Adam", "Tom"]);
  assert.equal(p.weekPodium({ complete: false, podium: PODIUM }), "", "a rostrum before the week is settled");
  // The Weekly panel: status line, rostrum, table, share — no card, no "won by", no slate line.
  const fill = sourceOf("fillPanelProgressively");
  const weekly = fill.slice(fill.indexOf('if (tab === "matchday")'), fill.indexOf("return true;"));
  assert.match(weekly, /\$\{weekStatusLine\(roundState, state\)\}\$\{weekPodium\(roundState\)\}\$\{roundTableHtml\(roundState\)\}<div class="season-share">\$\{shareIconButton\(state, "weekly"\)\}<\/div>/);
  for (const gone of ["function roundBanner(", "function roundSlateLine(", "round-banner", "round-slate", "all fixtures settled", "Game ${md} of"]) {
    assert.ok(!APP.includes(gone), `still shipped: ${gone}`);
  }
  for (const gone of [".round-banner", ".round-slate"]) {
    assert.ok(!CSS.includes(gone), `still styled: ${gone}`);
  }
});
