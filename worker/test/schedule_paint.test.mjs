// The Schedule tab: acknowledging the tap, and not building what nobody asked
// to see.
//
// On a mixed league the board is nine hundred-odd fixtures. Building every
// week's cards to show the one open week put fifty thousand nodes in the
// document and wedged the main thread for most of a second, so the tap went
// unanswered — nav highlight included — until it was all done. These run the
// real functions from app.js against a stub document.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

/** A top-level function, verbatim. Closes on an unindented `}`. */
function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  const end = APP.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated: ${startsWith}`);
  return APP.slice(start, end + 2);
}

/** A single-expression arrow const, verbatim. */
function liftConst(name) {
  const start = APP.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`not found in app.js: ${name}`);
  const end = APP.indexOf("\n\n", start);
  return APP.slice(start, end);
}

const WEEKS = 38;
const PER_WEEK = 10;
const fixtures = Array.from({ length: WEEKS * PER_WEEK }, (_, i) => {
  const week = Math.floor(i / PER_WEEK) + 1;
  return {
    id: `pl-w${week}-${i}`, matchday: week,
    player1: `H${i}`, player2: `A${i}`,
    startAt: `2026-08-${String(10 + (i % 20)).padStart(2, "0")}T12:00:00Z`,
    date: `2026-08-${String(10 + (i % 20)).padStart(2, "0")}`,
  };
});

/** app.js's schedule builders over stubs, with matchCard counted rather than run. */
function board({ open = new Set(["md-1"]), filter = "all", current = "1" } = {}) {
  const build = new Function("fixturesIn", "openIn", "filterIn", "current", `
    "use strict";
    let fixtures = fixturesIn;
    let openScheduleDates = openIn;
    let matchdayFilter = filterIn;
    let currentView = "schedule";
    let built = [];
    let heavy = [];
    const traceTap = () => {};   // the trace is measured in the browser, not here
    const escapeHTML = (v) => String(v ?? "");
    const matchCard = (f) => { heavy.push(f.id); return '<div data-match-card="' + f.id + '"></div>'; };
    const picks = {};
    let expandedFixtureId = null;
    const shortKickoff = () => "Sat 21 Aug 15:00";
    ${lift("function fixtureRow(fixture)").replace("const id = String(fixture.id);", "const id = String(fixture.id); built.push(id);")}
    const periodOfFixture = (f) => f.matchday;
    const comparePeriods = (a, b) => Number(a) - Number(b);
    const periodLabel = (p) => "Matchweek " + p;
    const isWindowKey = () => false;
    const weekDateRange = (p) => "range " + p;
    const dateLabel = (d) => String(d);
    const countPhrase = (n, word) => n + " " + word;
    const currentPeriodKey = () => current;
    const visiblePickedFixtures = () => [];

    ${lift("function byPeriod(list)")}
    ${lift("function periodIsOpen(period, current)")}
    ${lift("function groupedPeriods(list, currentPeriod = null)")}
    ${lift("function dayBody(period, matches, open)")}
    ${lift("function fillDayBody(card)")}

    return {
      html: () => { built = []; heavy = []; const h = groupedPeriods(fixtures, current); return { h, built: built.slice(), heavy: heavy.slice() }; },
      fill: (card) => { built = []; heavy = []; fillDayBody(card); return built.slice(); },
    };
  `);
  return build(fixtures, open, filter, current);
}

// A minimal stand-in for the one <details> fillDayBody touches.
function fakeCard(period) {
  const body = {
    dataset: { lazyBody: String(period) },
    innerHTML: "",
    removeAttribute(name) { if (name === "data-lazy-body") delete this.dataset.lazyBody; },
  };
  return { querySelector: (sel) => (sel === "[data-lazy-body]" && body.dataset.lazyBody ? body : null), body };
}

// --- what gets built --------------------------------------------------------

test("only the open week's cards are built", () => {
  const { h, built } = board().html();
  assert.equal(built.length, PER_WEEK, "one week's worth, not the whole season");
  assert.ok(built.every((id) => id.startsWith("pl-w1-")), "and it is the open week's");
  // Every other week is still listed, just not furnished.
  assert.equal((h.match(/data-day-card=/g) || []).length, WEEKS);
  assert.equal((h.match(/data-lazy-body=/g) || []).length, WEEKS - 1);
});

test("the summary still counts a week it has not built", () => {
  const { h } = board().html();
  // Thirty-eight weeks of ten, whether or not their cards exist yet.
  assert.equal((h.match(/10 fixtures/g) || []).length, WEEKS);
});

test("a closed week costs a stub, not a card", () => {
  const { h } = board().html();
  const closed = h.slice(h.indexOf('data-day-card="md-2"'));
  const body = closed.slice(closed.indexOf('<div class="day-body"'), closed.indexOf("</details>"));
  assert.match(body, /data-lazy-body="2"/);
  assert.doesNotMatch(body, /data-match-card/);
});

test("opening a week builds exactly that week", () => {
  const app = board();
  app.html();
  const card = fakeCard(7);
  const built = app.fill(card);
  assert.equal(built.length, PER_WEEK);
  assert.ok(built.every((id) => id.startsWith("pl-w7-")), built.slice(0, 3).join());
  // Rows, not prediction cards — the heavy markup is mounted on a tap.
  assert.match(card.body.innerHTML, /data-fixture-row="pl-w7-/);
  assert.doesNotMatch(card.body.innerHTML, /data-match-card/);
});

test("a week is built once and not again", () => {
  const app = board();
  app.html();
  const card = fakeCard(7);
  assert.equal(app.fill(card).length, PER_WEEK);
  assert.equal(app.fill(card).length, 0, "the stub is gone, so there is nothing left to fill");
});

test("every week's cards are reachable, none are lost", () => {
  const app = board();
  const { built } = app.html();
  const all = new Set(built);
  for (let week = 2; week <= WEEKS; week++) for (const id of app.fill(fakeCard(week))) all.add(id);
  assert.equal(all.size, fixtures.length, "expanding every week accounts for every fixture");
});

// --- which week starts open -------------------------------------------------

test("with no history the current week is the open one", () => {
  const { built } = board({ open: new Set(), current: "5" }).html();
  assert.ok(built.every((id) => id.startsWith("pl-w5-")));
});

test("once the viewer has chosen, their choice wins", () => {
  const { built } = board({ open: new Set(["md-9"]), current: "5" }).html();
  assert.ok(built.every((id) => id.startsWith("pl-w9-")), "not the current week");
});

test("filtering to a week opens it, so it is never an empty row", () => {
  // The click handler adds the filtered week to the open set; the rule that
  // decides what is open is then the ordinary one.
  const handler = APP.slice(APP.indexOf('const filter = event.target.closest("[data-filter]");'));
  const branch = handler.slice(0, handler.indexOf("const league = event.target.closest"));
  assert.match(branch, /if \(matchdayFilter !== "all"\) openScheduleDates\.add\(`md-\$\{matchdayFilter\}`\);/);
  const { built } = board({ open: new Set(["md-12"]), filter: "12", current: "1" }).html();
  assert.ok(built.every((id) => id.startsWith("pl-w12-")));
});

// --- reference-first Schedule ------------------------------------------------

test("navigation builds NO prediction cards, only rows", () => {
  const { h, built, heavy } = board().html();
  assert.equal(heavy.length, 0, "matchCard() must not run during navigation");
  assert.ok(built.length > 0, "but the open week's rows are there");
  assert.doesNotMatch(h, /data-match-card/);
  assert.match(h, /data-fixture-row=/);
});

test("a row says when and who, and nothing heavier", () => {
  const row = lift("function fixtureRow(fixture)");
  assert.match(row, /fixture-row-when/);
  assert.match(row, /fixture-row-teams/);
  // The card is mounted only for the fixture being looked at.
  assert.match(row, /\$\{open \? matchCard\(fixture\) : ""\}/);
  // And it announces itself as expandable.
  assert.match(row, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(row, /aria-controls="fx-/);
});

test("only one rich card is ever mounted", () => {
  const fn = lift("function expandFixture(id)");
  // Opening another unmounts the previous, and collapsing removes the markup
  // rather than merely hiding it.
  assert.match(fn, /body\.innerHTML = "";/);
  assert.match(fn, /body\.innerHTML = fixture \? matchCard\(fixture\) : "";/);
  assert.match(fn, /head\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(fn, /head\.setAttribute\("aria-expanded", "true"\)/);
  // A DOM edit, not a re-render: browsing never rebuilds the board.
  assert.doesNotMatch(fn, /\brender\(/);
});

test("tapping the same fixture again closes it", () => {
  const fn = lift("function expandFixture(id)");
  assert.match(fn, /const wanted = expandedFixtureId === String\(id\) \? null : String\(id\);/);
});

test("the board opens on the current week and the two after it", () => {
  const fn = lift("function scheduleWindow(periods, current)");
  assert.match(fn, /periods\.slice\(start, start \+ SCHEDULE_WEEKS_SHOWN\)/);
  assert.match(APP, /const SCHEDULE_WEEKS_SHOWN = 3;/);
  // A filter or an explicit reveal opts out of the window.
  assert.match(fn, /if \(scheduleFullSeason \|\| matchdayFilter !== "all"\) return periods;/);
});

test("the week selector is trimmed to what the board is showing", () => {
  const strip = lift("function weekStrip(selected, attribute, only = null)");
  assert.match(strip, /const periods = only && only\.length \? only : periodsInOrder\(\);/);
  const view = APP.slice(APP.indexOf("function scheduleView()"), APP.indexOf("// --- My Predictions"));
  assert.match(view, /scheduleFilters\(shown\)/);
  assert.match(view, /data-full-season/);
});

test("arriving at Schedule resets the scroller BEFORE content is added", () => {
  const nav = lift("async function navigateToView(view)");
  const reset = nav.indexOf("appScroller()?.scrollTo({ top: 0 })");
  assert.ok(reset > 0, "the scroller is put back");
  assert.ok(reset < nav.indexOf("render({ scrollTop: true })"), "before the board is built");
  assert.match(nav, /scheduleFullSeason = false;/);
  assert.match(nav, /expandedFixtureId = null;/);
});

test("expanding and revealing answer on the tap, before any await", () => {
  const listener = APP.slice(APP.indexOf('document.addEventListener("click", async (event) => {'));
  const head = listener.slice(0, listener.indexOf("const leagueCountStep"));
  const code = head.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /\bawait\b/);
  assert.match(code, /expandFixture\(expand\.dataset\.expandFixture\)/);
  assert.match(code, /scheduleFullSeason = true/);
});

test("a nav tap's trace survives the taps used to report it", () => {
  // Opening the profile and tapping Copy diagnostics are two more taps; a
  // plain ring would push the interesting one out before it could be read.
  assert.match(APP, /const NAV_TRACE_HISTORY = 6;/);
  const fn = lift("function traceInput(name, event, detail = {})");
  assert.match(fn, /const navView = tapTrace\.find\(\(step\) => step\.view\)\?\.view;/);
  assert.match(fn, /navTaps\.push\(\{ view: navView, steps: tapTrace \}\);/);
  const diag = lift("function diagnosticsText()");
  assert.match(diag, /nav → \$\{entry\.view\}/);
});

// --- the shell --------------------------------------------------------------

test("every tab has a shell it can show before doing any work", () => {
  const shells = APP.slice(APP.indexOf("const VIEW_SHELLS = {"), APP.indexOf("const loadingLine ="));
  for (const view of ["schedule", "picks", "league", "today", "rules"]) {
    assert.match(shells, new RegExp(`\\b${view}:`), `${view} has no shell`);
  }
  // The Schedule shell is the header and filters — no fixture cards.
  assert.match(shells, /schedule: \(\) => `\$\{scheduleHead\(\)\}\$\{scheduleFilters\(\)\}\$\{loadingLine\("Loading fixtures…"\)\}`/);
  assert.doesNotMatch(shells, /groupedPeriods/);
});

test("the shell is painted, and the highlight moved, before the view is built", () => {
  const nav = lift("async function navigateToView(view)");
  const shellAt = nav.indexOf("paintShell(view)");
  const renderAt = nav.indexOf("render({ scrollTop: true })");
  assert.ok(shellAt > 0 && renderAt > shellAt, "the shell must come first");
  // And a real gap between them, or the browser never gets to draw it.
  assert.match(nav, /if \(paintShell\(view\)\) await nextPaint\(\);/);
  assert.ok(nav.indexOf("await nextPaint()") < renderAt);

  const paint = lift("function paintShell(view)");
  assert.match(paint, /app\.innerHTML = shell\(\);/);
  assert.match(paint, /markActiveTab\(\);/);
  // The shell is not the view, so the render that follows must not be deduped.
  assert.match(paint, /renderedHTML = null;/);
});

test("the shell waits for a frame AND a task, not just a promise", () => {
  // A microtask would resolve before the browser had a chance to draw, which
  // is the whole point of the pause.
  const line = liftConst("nextPaint");
  assert.match(line, /requestAnimationFrame/);
  assert.match(line, /setTimeout\(/);
  // And it records the moment the shell actually reaches the glass, which is
  // the number a slow-tap report needs.
  assert.match(line, /traceTap\("shell-painted"/);
});

test("the tap-hold from build 11 cannot swallow the shell", () => {
  // paintShell writes to the DOM directly rather than through render(), which
  // is held for the length of a tap — and a tab tap is a tap.
  const paint = lift("function paintShell(view)");
  assert.doesNotMatch(paint, /\brender\(/);
  assert.match(paint, /const app = document\.getElementById\("app"\);/);
});

// --- nothing else changed ---------------------------------------------------

test("a lazily built card is the same card", () => {
  // Both paths call the one matchCard, so calendar links, TV info and score
  // controls cannot differ between them.
  const body = lift("function dayBody(period, matches, open)");
  assert.match(body, /matches\.map\(fixtureRow\)\.join\(""\)/);
  const fill = lift("function fillDayBody(card)");
  assert.match(fill, /matches\.map\(fixtureRow\)\.join\(""\)/);
  assert.equal((APP.match(/function matchCard\(/g) || []).length, 1, "one card builder, one behaviour");
});

test("expanding still records the week, so it survives a repaint", () => {
  const toggle = APP.slice(APP.indexOf('document.addEventListener("toggle"'));
  const branch = toggle.slice(toggle.indexOf('const card = event.target.closest?.("[data-day-card]")'), toggle.indexOf("}, true);"));
  assert.match(branch, /fillDayBody\(card\);/);
  assert.match(branch, /openScheduleDates\.add\(card\.dataset\.dayCard\);/);
  assert.match(branch, /openScheduleDates\.delete\(card\.dataset\.dayCard\);/);
  // Built on the way open, before it is recorded — order matters only in that
  // both must happen.
  assert.ok(branch.indexOf("fillDayBody") < branch.indexOf("openScheduleDates.add"));
});

test("the whole list is walked once, not once per week", () => {
  // The old shape filtered the full list inside a map over every period, which
  // is thirty-eight scans of nine hundred fixtures before a card is even built.
  const group = lift("function groupedPeriods(list, currentPeriod = null)");
  assert.doesNotMatch(group, /list\.filter/);
  assert.match(group, /byPeriod\(list\)/);
  const grouper = lift("function byPeriod(list)");
  assert.match(grouper, /for \(const fixture of list\)/);
});
