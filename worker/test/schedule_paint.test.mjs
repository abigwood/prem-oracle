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

/** One line, verbatim — for single-expression const arrows. */
function liftLine(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  return APP.slice(start, APP.indexOf("\n", start));
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

// --- build 17: the League results island ------------------------------------

/**
 * A small, faithful element shim.
 *
 * The island now works in real DOM — createElement, replaceChildren,
 * insertAdjacentHTML, node identity — so a stub exposing only an innerHTML
 * setter cannot drive it, and weakening the assertions to suit a weaker stub
 * would test the stub rather than the app.
 */
function makeDom() {
  let innerHTMLWrites = 0;
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.attrs = {};
      this._text = "";
      this._class = "";
      this.classList = {
        toggle: (name, on) => { this._class = on ? name : ""; },
        add: (name) => { this._class = name; },
        remove: () => { this._class = ""; },
        contains: (name) => this._class.includes(name),
      };
    }
    get className() { return this._class; }
    set className(v) { this._class = v; }
    get textContent() { return this._text || this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._text = String(v); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    // Parsed as one opaque element per call — enough to count and to serialise.
    insertAdjacentHTML(_where, html) {
      const el = new El("section");
      el._text = String(html);
      el.parent = this;
      this.children.push(el);
    }
    set innerHTML(v) { innerHTMLWrites++; this._text = String(v); this.children = []; }
    get innerHTML() { return this.children.map((c) => c.outerHTML).join("") || this._text; }
    get outerHTML() {
      const tag = this.tagName.toLowerCase();
      const cls = this._class ? ` class="${this._class}"` : "";
      return `<${tag}${cls}>${this._text}${this.children.map((c) => c.outerHTML).join("")}</${tag}>`;
    }
  }
  return { El, writes: () => innerHTMLWrites };
}

/** app.js's results island over that shim, running the production helpers. */
function island({ buildMs = 0 } = {}) {
  const dom = makeDom();
  const build = new Function("dom", "buildMs", `
    "use strict";
    const { El } = dom;
    const events = [];
    const resultsEl = new El("div");
    const pickerEl = new El("div");
    const matchdaySeg = new El("button");
    let fixtureRevisions = { PL: "r1" };
    let matchdayPickerOpen = false;
    let apiCalls = 0;
    let roundCalls = [];
    let roundDelayMs = 0;
    let cachedRounds = {};
    let weekSelectionGeneration = 0;
    const cachedRoundState = (code, period) => cachedRounds[code + ":" + period] || null;
    const loadRoundState = async () => {
      const want = selectedPeriod;
      roundCalls.push(want);
      const wait = roundDelayMs;
      await new Promise((r) => setTimeoutOrig(r, wait));
      roundState = { code: activeLeague, period: want, matchday: want, fresh: true };
    };
    const currentPeriodKey = () => 1;
    const weekStrip = () => { apiCalls += 0; return "<weeks/>"; };
    const shareBtn = new El("button");
    const card = new El("section");
    const segs = ["matchday", "season"].map((t) => { const e = new El("button"); e.dataset = { roundTab: t }; return e; });
    const pills = ["AAA", "BBB"].map((c) => { const e = new El("button"); e.dataset = { league: c }; return e; });
    const document = {
      createElement: (tag) => new El(tag),
      querySelector: (sel) => (sel === "[data-league-results]" ? resultsEl
        : sel === "[data-export-league-table]" ? shareBtn
        : sel === ".league-card" ? card
        : sel === "[data-picker-island]" ? pickerEl
        : sel === '[data-round-tab="matchday"]' ? matchdaySeg : null),
      querySelectorAll: (sel) => (sel === "[data-round-tab]" ? segs : sel === "[data-league]" ? pills : []),
    };
    let renders = 0;
    const render = () => { renders++; };
    const requestAnimationFrame = (fn) => setTimeout(fn, 0);
    const setTimeoutOrig = setTimeout;
    const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeoutOrig(resolve, 0)));
    let activeLeague = "AAA", leagueTab = "matchday", selectedPeriod = 1, currentView = "league";
    let leagueState = { code: "AAA", name: "AAA League", owner: "someone", rounds: true };
    let roundState = { code: "AAA", period: 1, matchday: 1 };
    const leagueNames = { AAA: "AAA League", BBB: "BBB League" };
    const leagueStates = {};
    const uid = () => "u1";
    const escapeHTML = (v) => String(v ?? "");
    const leagueSupportsRounds = () => true;
    const weekNumberFor = () => 1;
    const periodLabel = (p) => "Matchweek " + p;
    const isMixedActive = () => true;   // Adam's shape: PL + ELC
    const traceTap = (name, detail) => events.push({ trace: name, ...detail });
    const seasonBanner = () => "<sbanner>";
    const trophyCabinet = () => "<cabinet>";
    const seasonTableHtml = () => { const t = Date.now(); while (Date.now() - t < buildMs) {} return "<stable>"; };
    const weekSeasonPicker = () => "<weeks>";
    const leagueRevealsHtml = () => "<reveals>";
    const pulsingStatus = (m) => '<p class="view-loading is-pulsing">' + m + "</p>";
    const roundBanner = () => "<rbanner>";
    const roundTableHtml = () => "<roundtable>";

    ${lift("const weekLabelFor = (period) => {")}
    const RETAINED_PANEL_LIMIT = 8;
    let retainedPanels = new Map();
    let panelGeneration = 0;
    let mountedKey = null;
    let mountedContext = null;
    let pickerGeneration = 0;
    const sameContext = (code, tab, period) =>
      mountedContext && mountedContext.code === code && mountedContext.tab === tab
      && String(mountedContext.period) === String(period);
    let leagueStamps = new Map();
    ${liftLine("const stampFor =")}
    ${liftLine("const bumpStamp =")}
    ${lift("function panelKey(tab, code = activeLeague, period = selectedPeriod)")}
    ${lift("function retainPanel(key, node)")}
    ${lift("function dropRetainedPanels(code = null)")}
    ${lift("function resultsNode()")}
    ${lift("function seasonStages(state, isOwner)")}
    ${lift("async function fillPanelProgressively(panel, capture)")}
    ${lift("async function showResultsPanel({ status } = {})")}
    ${lift("const pulsingNode = (message) => {")}
    ${lift("function syncShareLabel()")}
    ${lift("function mountResults()")}
    ${lift("function markSegment(tab)")}
    ${lift("function markLeaguePill(code)")}
    let retainedPickers = new Map();
    const pickerKey = () =>
      activeLeague + "|" + Object.values(fixtureRevisions).join(",") + "|" + (selectedPeriod ?? currentPeriodKey());
    ${lift("function pickerIsland()")}
    ${lift("function markPickerExpanded(open)")}
    ${lift("async function toggleWeeklyPicker()")}
    ${lift("function closeWeeklyPicker()")}
    ${lift("async function selectWeeklyPeriod(week)")}
    ${lift("function leagueCardShell(name, code)")}

    return {
      events, renders: () => renders,
      node: () => resultsEl,
      panelNode: () => resultsEl.firstElementChild,
      text: () => resultsEl.innerHTML,
      html: () => resultsEl.innerHTML,
      bumpTruth: () => bumpStamp(activeLeague),
      shareLabel: () => shareBtn.textContent,
      cardText: () => card.textContent,
      segState: () => segs.map((s) => ({ tab: s.dataset.roundTab, on: s.classList.contains("active"), aria: s.getAttribute("aria-selected") })),
      pillState: () => pills.map((p) => ({ code: p.dataset.league, on: p.classList.contains("active"), aria: p.getAttribute("aria-selected") })),
      setTab: (t) => { leagueTab = t; },
      setLeague: (c) => { activeLeague = c; leagueState = { code: c, name: c + " League", owner: "someone", rounds: true }; },
      setPeriod: (n) => { selectedPeriod = n; },
      bumpFor: (code) => bumpStamp(code),
      dropFor: (code) => dropRetainedPanels(code),
      retainedSize: () => retainedPanels.size,
      showResultsPanel, markSegment, markLeaguePill, mountResults,
      replaceCard: (code) => { card.replaceChildren(leagueCardShell(leagueNames[code] || code, code)); },
      toggleWeeklyPicker, closeWeeklyPicker, selectWeeklyPeriod,
      roundCalls: () => roundCalls.slice(),
      setRoundDelay: (ms) => { roundDelayMs = ms; },
      seedRound: (code, period) => { cachedRounds[code + ":" + period] = { code, period, matchday: period, cached: true }; },
      roundNow: () => roundState,
      pickerNode: () => pickerEl.firstElementChild,
      pickerOpen: () => matchdayPickerOpen,
      pickerAria: () => matchdaySeg.getAttribute("aria-expanded"),
      apiCalls: () => apiCalls,
      bumpRevision: () => { fixtureRevisions = { PL: "r2" }; },
    };
  `);
  return { ...build(dom, buildMs), writes: dom.writes };
}

// (E1) (E12)
test("the segment is marked, with aria, in the same task as the tap", () => {
  const app = island();
  app.markSegment("season");
  assert.deepEqual(app.segState(), [
    { tab: "matchday", on: false, aria: "false" },
    { tab: "season", on: true, aria: "true" },
  ]);
});

// (E2)
test("a pulsing shell is inserted before the panel is built", async () => {
  const app = island({ buildMs: 5 });
  app.setTab("season");
  const pending = app.showResultsPanel({ status: "Loading season…" });
  // Synchronously after the call, the shell is already in place.
  assert.match(app.html(), /is-pulsing/);
  assert.match(app.html(), /Loading season…/);
  await pending;
  const order = app.events.filter((e) => e.trace).map((e) => e.trace);
  assert.ok(order.indexOf("results-shell-inserted") < order.indexOf("panel-build-start"), order.join(" "));
  assert.ok(order.indexOf("results-shell-painted") < order.indexOf("panel-build-start"), order.join(" "));
});

// (E3)
test("a segment swap never calls the global render", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel({ status: "Loading season…" });
  assert.equal(app.renders(), 0, "the whole of #app must not be rebuilt to swap a table");
  const swap = lift("async function showResultsPanel({ status } = {})");
  // Not one global render, not even a fallback: the island owns its own node.
  assert.equal((swap.match(/\brender\(\)/g) || []).length, 0);
});

// (E4)
test("returning to a panel already built is an immediate retained hit", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel({ status: "Loading season…" });
  const before = app.events.length;
  await app.showResultsPanel({ status: "Loading season…" });
  const after = app.events.slice(before).filter((e) => e.trace).map((e) => e.trace);
  assert.deepEqual(after, ["panel-retained-hit"], "no shell, no rebuild");
  assert.match(app.html(), /stable/);
});

// (E5)
test("an uncached panel shows the acknowledgement, then the content", async () => {
  const app = island({ buildMs: 3 });
  app.setTab("season");
  const pending = app.showResultsPanel({ status: "Loading season…" });
  assert.match(app.html(), /Loading season…/, "acknowledged first");
  await pending;
  assert.match(app.html(), /sbanner/, "then the real panel");
  assert.doesNotMatch(app.html(), /is-pulsing/);
});

// (E6) (E7)
test("rapid alternating taps finish on the last selection, and stale work is discarded", async () => {
  const app = island({ buildMs: 4 });
  app.setTab("season");
  const first = app.showResultsPanel({ status: "Loading season…" });
  app.setTab("matchday");
  const second = app.showResultsPanel({ status: "Loading Week 1…" });
  await Promise.all([first, second]);
  assert.match(app.html(), /roundtable/, "the last tab wins");
  assert.ok(app.events.some((e) => e.trace === "panel-discarded"), "and the overtaken build said so");
});

// (d) — the claim my last report made, which was false
test("refreshing AAA leaves BBB as a REAL retained hit, not just an entry", async () => {
  // A single global stamp meant refreshing AAA changed the key BBB's panel was
  // filed under. The entry survived; nothing could ever find it again.
  const app = island();
  app.setTab("season");
  await app.showResultsPanel({ status: "Loading season…" });   // AAA built
  app.setLeague("BBB");
  await app.showResultsPanel({ status: "Loading season…" });   // BBB built

  app.bumpFor("AAA");
  app.dropFor("AAA");

  const before = app.events.length;
  await app.showResultsPanel({ status: "Loading season…" });   // still BBB
  const after = app.events.slice(before).filter((e) => e.trace).map((e) => e.trace);
  assert.deepEqual(after, ["panel-retained-hit"], `BBB should still be a hit, got ${after.join(" ")}`);
});

// (e)
test("an in-flight AAA build cannot write into or poison BBB", async () => {
  const app = island({ buildMs: 6 });
  app.setTab("season");
  const inFlight = app.showResultsPanel({ status: "Loading season…" });   // AAA
  app.setLeague("BBB");                                                   // pill switch
  await inFlight;
  assert.ok(
    app.events.some((e) => e.trace === "panel-discarded"),
    "the AAA job must abandon itself once the league changed",
  );
  // And nothing was filed under BBB's key by that job.
  const before = app.events.length;
  await app.showResultsPanel({ status: "Loading season…" });
  const after = app.events.slice(before).filter((e) => e.trace);
  assert.equal(after[0].trace, "panel-retained-miss", "BBB's cache was not poisoned by AAA's build");
});

// (E9)
test("a refresh drops only the affected league's retained panels", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel({ status: "Loading season…" });
  app.setLeague("BBB");
  await app.showResultsPanel({ status: "Loading season…" });
  assert.equal(app.retainedSize(), 2, "one panel per league");
  app.dropFor("AAA");
  assert.equal(app.retainedSize(), 1, "BBB's panel survives AAA's refresh");
});

test("a truth change invalidates the retained panel by key", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel({ status: "Loading season…" });
  app.bumpTruth();
  const before = app.events.length;
  await app.showResultsPanel({ status: "Loading season…" });
  const after = app.events.slice(before).filter((e) => e.trace).map((e) => e.trace);
  assert.ok(after.includes("panel-retained-miss"), "new truth, new panel");
});

// (E8)
test("the pill is marked in the same task, and never for two leagues at once", () => {
  const app = island();
  app.markLeaguePill("BBB");
  assert.deepEqual(app.pillState(), [
    { code: "AAA", on: false, aria: "false" },
    { code: "BBB", on: true, aria: "true" },
  ]);
});

// (a) (b)
test("the pill is acknowledged and painted before any global render", () => {
  const fn = lift("async function switchLeaguePill(code)");
  const mark = fn.indexOf("markLeaguePill(code)");
  const paint = fn.indexOf("await nextPaint()");
  const global = fn.indexOf("\n  render();");
  assert.ok(mark > 0 && paint > mark, "the mark comes first");
  assert.ok(global > paint, "and the global render only after a real paint");
  // Nothing awaited before the acknowledgement.
  const head = fn.slice(0, mark).replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(head, /\bawait\b/);
  // The click branch does no work of its own.
  const branch = APP.slice(APP.indexOf('const league = event.target.closest("[data-league]");'));
  assert.match(branch.slice(0, branch.indexOf("}")), /switchLeaguePill\(league\.dataset\.league\)/);
  assert.doesNotMatch(branch.slice(0, branch.indexOf("}")), /setActiveLeague/);
});

test("the pill path takes the league's identity with it before painting", () => {
  const fn = lift("async function switchLeaguePill(code)");
  const paint = fn.indexOf("await nextPaint()");
  for (const claim of ["activeLeague = code;", "selectedPeriod = null;", "roundState = null;", "hydrateCachedLeague();"]) {
    assert.ok(fn.indexOf(claim) > 0 && fn.indexOf(claim) < paint, `${claim} must happen before the paint`);
  }
  // Any panel job for the league just left is void.
  assert.ok(fn.indexOf("panelGeneration++") < paint);
});

// (g)
test("the share label always matches the visible tab", () => {
  const fn = lift("function syncShareLabel()");
  assert.match(fn, /leagueTab === "matchday"/);
  assert.match(fn, /Share table to WhatsApp/);
  // Called on every path that changes what is on screen.
  const swap = lift("async function showResultsPanel({ status } = {})");
  assert.equal((swap.match(/syncShareLabel\(\)/g) || []).length, 2, "retained hit AND fresh build");
  const pill = lift("async function switchLeaguePill(code)");
  assert.ok((pill.match(/syncShareLabel\(\)/g) || []).length >= 2, "and after a pill switch");
});

// --- build 18: the weekly picker island (F4-F11) -----------------------------

// F4
test("opening and closing the dropdown renders nothing globally and asks nothing", async () => {
  const app = island();
  const before = app.renders();
  await app.toggleWeeklyPicker();
  assert.equal(app.pickerOpen(), true);
  assert.equal(app.pickerAria(), "true", "and says so");
  await app.toggleWeeklyPicker();
  assert.equal(app.pickerOpen(), false);
  assert.equal(app.pickerAria(), "false");
  assert.equal(app.renders(), before, "the League screen is not rebuilt to show a list of weeks");
  assert.equal(app.apiCalls(), 0, "and nothing is fetched");
  assert.equal(app.pickerNode(), null, "closing empties the container");
});

// F5
test("reopening the dropdown reuses the exact same node", async () => {
  const app = island();
  await app.toggleWeeklyPicker();
  const first = app.pickerNode();
  assert.ok(first, "built once");
  const writesAfterBuild = app.writes();
  await app.toggleWeeklyPicker();     // shut
  await app.toggleWeeklyPicker();     // open again
  assert.strictEqual(app.pickerNode(), first, "the SAME element must come back");
  assert.equal(app.writes(), writesAfterBuild, "and nothing is reparsed");
});

test("a changed fixture revision rebuilds the picker rather than reusing it", async () => {
  const app = island();
  await app.toggleWeeklyPicker();
  const first = app.pickerNode();
  await app.toggleWeeklyPicker();
  app.bumpRevision();
  await app.toggleWeeklyPicker();
  assert.notStrictEqual(app.pickerNode(), first, "new fixtures, new picker");
});

test("an unbuilt picker acknowledges before it is built", async () => {
  const app = island();
  const pending = app.toggleWeeklyPicker();
  assert.match(app.pickerNode()?.className ?? "", /is-pulsing/, "acknowledged in the tap task");
  await pending;
  assert.match(app.pickerNode()?.className ?? "", /picker-weeks/, "then the real picker");
});

// F9 F10
test("a refresh never removes a valid panel, and swaps atomically when ready", async () => {
  const app = island({ buildMs: 3 });
  app.setTab("season");
  await app.showResultsPanel();
  const original = app.panelNode();
  assert.ok(original, "something valid is on screen");

  app.bumpFor("AAA");                 // truth refreshed
  const pending = app.showResultsPanel();
  // Still showing the old panel while the new one is built offscreen.
  assert.strictEqual(app.panelNode(), original, "valid content must not be removed mid-refresh");
  assert.ok(app.events.some((e) => e.trace === "results-kept-visible"), "and it says it kept it");
  await pending;
  assert.notStrictEqual(app.panelNode(), original, "replaced only once complete");
  assert.ok(app.events.some((e) => e.trace === "panel-swapped"), "in one atomic swap");
});

test("a loader appears only when there is nothing valid to keep", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel();
  const shells = app.events.filter((e) => e.trace === "results-shell-inserted").length;
  assert.equal(shells, 1, "the first, uncached visit gets one");
  app.bumpFor("AAA");
  await app.showResultsPanel();
  assert.equal(
    app.events.filter((e) => e.trace === "results-shell-inserted").length,
    shells,
    "and a refresh over valid content gets none",
  );
});

// F11
test("rapid tab changes during a refresh still land on the final choice", async () => {
  const app = island({ buildMs: 4 });
  app.setTab("season");
  const a = app.showResultsPanel();
  app.setTab("matchday");
  const b = app.showResultsPanel();
  await Promise.all([a, b]);
  assert.match(app.text(), /roundtable/, "the last tab wins");
});

// --- build 18 final: context, not just truth ---------------------------------

test("a panel for a DIFFERENT week is never held on screen under the new one", async () => {
  const app = island({ buildMs: 3 });
  app.setTab("season");
  await app.showResultsPanel();
  const seasonPanel = app.panelNode();

  // Same league, different tab: the old answer is not stale content, it is the
  // wrong table, so it must not be kept visible.
  app.setTab("matchday");
  const pending = app.showResultsPanel();
  assert.notStrictEqual(app.panelNode(), seasonPanel, "the season panel must not linger");
  await pending;
  assert.ok(
    app.events.some((e) => e.trace === "results-shell-inserted"),
    "an unrelated context gets the acknowledgement, not the previous panel",
  );
});

test("only a same-context refresh keeps the visible panel", async () => {
  const app = island({ buildMs: 3 });
  app.setTab("season");
  await app.showResultsPanel();
  const original = app.panelNode();
  app.bumpFor("AAA");                       // same league, tab and week
  const pending = app.showResultsPanel();
  assert.strictEqual(app.panelNode(), original, "kept while the replacement builds");
  await pending;
  assert.ok(app.events.some((e) => e.trace === "results-kept-visible"));
});

test("a different period does not count as the same context", async () => {
  const app = island();
  app.setTab("matchday");
  await app.showResultsPanel();
  app.setPeriod(7);
  const pending = app.showResultsPanel();
  assert.ok(
    app.events.filter((e) => e.trace === "results-kept-visible").length === 0,
    "week 7 must not sit under week 1's panel",
  );
  await pending;
});

test("the picker generation discards an open job overtaken by close then reopen", async () => {
  const app = island();
  const first = app.toggleWeeklyPicker();   // open
  app.closeWeeklyPicker();                  // shut before it built
  await first;
  assert.ok(app.events.some((e) => e.trace === "picker-discarded"), "the first job abandoned");
  assert.equal(app.pickerNode(), null, "and nothing was inserted after the close");
});

test("the retained picker key carries the selected week", () => {
  // The current week is highlighted inside the picker, so the highlight would
  // go stale as the week rolled over while the revision stayed the same.
  const key = liftLine("const pickerKey = () =>");
  const body = APP.slice(APP.indexOf("const pickerKey = () =>"), APP.indexOf(";", APP.indexOf("const pickerKey = () =>") + 30));
  assert.match(body, /selectedPeriod \?\? currentPeriodKey\(\)/);
  assert.match(body, /fixtureRevisions/);
  assert.match(body, /activeLeague/);
});

// F7 — behavioural
test("a cached week paints before the request, and still refreshes exactly once", async () => {
  const app = island();
  app.seedRound("AAA", 3);
  app.setRoundDelay(20);
  const pending = app.selectWeeklyPeriod(3);

  // Synchronously after the call the cached week is already the round state.
  assert.equal(app.roundNow()?.period, 3, "week 3's own cache, not the previous week");
  assert.equal(app.roundNow()?.cached, true);
  assert.deepEqual(app.roundCalls(), [], "nothing requested yet");

  await pending;
  assert.deepEqual(app.roundCalls(), [3], "exactly one refresh, cache hit or not");
  assert.equal(app.roundNow()?.fresh, true, "and the fresh answer replaced it");
});

// F8 — behavioural
test("an uncached week acknowledges first and never shows the previous week", async () => {
  const app = island();
  app.seedRound("AAA", 2);
  app.setRoundDelay(15);
  await app.selectWeeklyPeriod(2);          // week 2 is on screen
  const week2Panel = app.panelNode();

  const pending = app.selectWeeklyPeriod(5);   // nothing cached for 5
  assert.equal(app.roundNow(), null, "week 2's table is cleared, not reused");
  assert.notStrictEqual(app.panelNode(), week2Panel, "and its panel is not left up");
  await pending;
  assert.deepEqual(app.roundCalls(), [2, 5], "one refresh each");
  assert.equal(app.roundNow()?.period, 5);
});

test("rapid week changes with reversed responses finish on the LAST week", async () => {
  const app = island();
  app.setRoundDelay(30);
  const two = app.selectWeeklyPeriod(2);
  app.setRoundDelay(2);
  const three = app.selectWeeklyPeriod(3);
  await Promise.all([two, three]);
  assert.equal(app.roundNow()?.period, 3, "week 3 was chosen last, so week 3 wins");
  assert.ok(
    app.events.some((e) => e.trace === "week-selection-discarded"),
    "and the overtaken selection said so rather than repainting",
  );
});

test("a stale week response cannot change the share label", async () => {
  const app = island();
  app.setRoundDelay(25);
  const two = app.selectWeeklyPeriod(2);
  app.setRoundDelay(1);
  const three = app.selectWeeklyPeriod(3);
  await Promise.all([two, three]);
  assert.match(app.shareLabel(), /Share Matchweek 3 result/, `got ${app.shareLabel()}`);
});

test("selecting a week closes the picker and voids its pending build", async () => {
  const app = island();
  const opening = app.toggleWeeklyPicker();
  await app.selectWeeklyPeriod(4);
  await opening;
  assert.equal(app.pickerOpen(), false);
  assert.equal(app.pickerAria(), "false");
  assert.equal(app.pickerNode(), null, "the island is empty and nothing arrived late");
});

test("building a full week picker scans the fixture list ONCE, not once per week", () => {
  // weekStrip called periodLabel per chip, which called weekNumberFor, which
  // rescanned and re-sorted every fixture. Thirty-eight weeks of nine hundred
  // fixtures is what produced 3.5 seconds of synchronous build.
  let scans = 0;
  const build = new Function(`
    "use strict";
    let scanCount = 0;
    let fixtures = Array.from({ length: 932 }, (_, i) => ({ id: "f" + i, week: Math.floor(i / 25) + 1 }));
    const periodOfFixture = (f) => { scanCount++; return "w" + String(f.week).padStart(2, "0"); };
    const comparePeriods = (a, b) => String(a).localeCompare(String(b));
    const isWindowKey = () => true;
    let periodIndexCache = { source: null, list: [], index: new Map() };
    ${lift("function periodIndex()")}
    ${lift("function periodsInOrder()")}
    ${lift("function weekNumberFor(period)")}
    return {
      drawAll: () => { const all = periodsInOrder(); return all.map((p) => weekNumberFor(p)); },
      scans: () => scanCount,
      total: () => fixtures.length,
      reload: () => { fixtures = fixtures.slice(); },
    };
  `);
  const app = build();
  const numbers = app.drawAll();
  scans = app.scans();

  assert.deepEqual(numbers.slice(0, 3), [1, 2, 3], "week numbers still come out right");
  assert.equal(scans, app.total(), `one pass over the fixtures, got ${scans} for ${app.total()} fixtures`);

  // Drawing again costs nothing at all.
  app.drawAll();
  assert.equal(app.scans(), scans, "a second draw reuses the prepared index");

  // A new fixture list invalidates it, because the array identity changed.
  app.reload();
  app.drawAll();
  assert.equal(app.scans(), scans * 2, "and a reloaded feed is prepared afresh");
});

test("the Weekly League dropdown still reaches every week", () => {
  // The dead matchdayPicker() is gone; this exercises the live opener.
  assert.ok(!APP.includes("function matchdayPicker("), "dead path removed");
  const opener = lift("async function toggleWeeklyPicker()");
  assert.match(opener, /weekStrip\(selectedPeriod \?\? currentPeriodKey\(\), "data-round-md"\)/);
  const strip = lift("function weekStrip(selected, attribute, only = null)");
  // No trimming unless a caller asks for it, so the picker offers the lot.
  assert.match(strip, /const periods = only && only\.length \? only : periodsInOrder\(\);/);
});

test("the segments say what they are, and the dropdown reports its state", () => {
  const toggle = lift("function roundToggle()");
  assert.match(toggle, />Weekly League ▾</);
  assert.match(toggle, />Season League</);
  assert.match(toggle, /aria-expanded="\$\{matchdayPickerOpen\}"/);
  assert.match(toggle, /aria-selected="\$\{leagueTab === "matchday"\}"/);
  assert.match(toggle, /aria-selected="\$\{leagueTab === "season"\}"/);
});

// --- build 17 completion: real DOM, real staging -----------------------------

test("a retained hit returns the very same node, with no innerHTML parsing", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel();
  const first = app.panelNode();
  const writesAfterBuild = app.writes();

  app.setTab("matchday");
  await app.showResultsPanel();
  app.setTab("season");
  await app.showResultsPanel();

  assert.strictEqual(app.panelNode(), first, "the SAME element must come back, not a copy");
  assert.equal(app.writes(), writesAfterBuild, "a retained hit parses no HTML at all");
});

test("Season is built in bounded stages, yielding between every one", async () => {
  const app = island();
  app.setTab("season");
  await app.showResultsPanel();
  const chunks = app.events.filter((e) => e.trace === "chunk").map((e) => e.stage);
  // No "weeks": the month calendar cost 8,185 chars and 3.5s of synchronous
  // build to duplicate navigation the Weekly League dropdown already owns.
  assert.deepEqual(chunks, ["banner", "cabinet", "standings", "reveals"]);
  assert.equal(app.panelNode().children.length, 4);
  const fn = lift("async function fillPanelProgressively(panel, capture)");
  assert.match(fn, /await nextPaint\(\);/, "and it yields between them");
});

test("a period change between chunks stops the job dead", async () => {
  const app = island({ buildMs: 4 });
  app.setTab("season");
  const pending = app.showResultsPanel();
  app.setPeriod(9);                       // the week moved under it
  await pending;
  assert.ok(app.events.some((e) => e.trace === "panel-discarded"), "it must abandon");
  assert.equal(app.retainedSize(), 0, "and cache nothing");
});

test("refreshed truth between chunks stops the job dead", async () => {
  const app = island({ buildMs: 4 });
  app.setTab("season");
  const pending = app.showResultsPanel();
  app.bumpFor("AAA");                     // a refresh landed mid-build
  await pending;
  const discarded = app.events.filter((e) => e.trace === "panel-discarded");
  assert.ok(discarded.length, "it must abandon");
  assert.equal(app.retainedSize(), 0, "and must not re-enter the cache under the old stamp");
});

test("the global League view never builds a Season panel", () => {
  const view = APP.slice(APP.indexOf("function leagueView()"), APP.indexOf("function rulesView()"));
  assert.match(view, /<div class="league-results" data-league-results><\/div>/);
  for (const heavy of ["seasonTableHtml", "trophyCabinet", "seasonBanner", "weekSeasonPicker", "leagueRevealsHtml", "roundTableHtml"]) {
    assert.ok(!view.replace(/\/\/[^\n]*/g, "").includes(heavy), `leagueView must not call ${heavy}`);
  }
  // And the old all-at-once builder is gone, so nothing can call it back.
  assert.ok(!APP.includes("function resultsPanel("), "the blocking path must not exist");
});

test("a pill switch replaces the whole league card, not just the results", async () => {
  const app = island();
  app.replaceCard("BBB");
  const text = app.cardText();
  assert.match(text, /BBB League/, "the new league's name");
  assert.match(text, /BBB/, "and its code");
  assert.doesNotMatch(text, /AAA/, "never the league just left");
  assert.match(text, /Loading league…/);
});

test("the share label follows the visible tab through a swap", async () => {
  const app = island();
  app.setTab("matchday");
  await app.showResultsPanel();
  assert.match(app.shareLabel(), /Share Matchweek 1 result/);
  app.setTab("season");
  await app.showResultsPanel();
  assert.equal(app.shareLabel(), "Share table to WhatsApp");
});

// (E10)
test("toggling Week and Season makes no API call", () => {
  const handler = APP.slice(APP.indexOf('const roundTab = event.target.closest("[data-round-tab]");'));
  const branch = handler.slice(0, handler.indexOf('const roundMd = event.target.closest'));
  // The only network call is the round read, and only when the week is stale.
  assert.match(branch, /const needsRound = wanted === "matchday"/);
  assert.match(branch, /if \(!needsRound\) return;/);
  // Season never fetches.
  assert.doesNotMatch(branch.slice(branch.indexOf('wanted === "season"')), /loadLeagueState|fetchState/);
});

test("the segment is acknowledged before any awaited work", () => {
  const handler = APP.slice(APP.indexOf('const roundTab = event.target.closest("[data-round-tab]");'));
  const branch = handler.slice(0, handler.indexOf('const roundMd = event.target.closest'));
  const mark = branch.indexOf("markSegment(wanted)");
  assert.ok(mark > 0, "the segment is marked in this branch");
  assert.ok(mark < branch.indexOf("showResultsPanel("), "before any panel work");
  // Nothing is awaited before the mark. (Awaits AFTER it, inside the
  // revalidation callback, are exactly where they belong.)
  const head = branch.slice(0, mark).replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(head, /\bawait\b/);
});

test("the week chip is marked and the picker shut before anything is awaited", () => {
  const fn = lift("async function selectWeeklyPeriod(week)");
  const head = fn.slice(0, fn.indexOf("await")).replace(/\/\/[^\n]*/g, "");
  for (const immediate of ["chip.classList.toggle", "closeWeeklyPicker();", "markSegment(\"matchday\")", "roundState = cached"]) {
    assert.ok(head.includes(immediate), `${immediate} must happen before the first await`);
  }
});

// --- the shell --------------------------------------------------------------

test("every tab has a shell it can show before doing any work", () => {
  const shells = APP.slice(APP.indexOf("const VIEW_SHELLS = {"), APP.indexOf("const loadingLine ="));
  for (const view of ["schedule", "picks", "league", "today", "rules"]) {
    assert.match(shells, new RegExp(`\\b${view}:`), `${view} has no shell`);
  }
  // The Schedule shell is the header and filters — no fixture cards.
  // Literal markup only: the shell that called scheduleFilters() -> weekStrip()
  // -> periodsInOrder() took 2908ms to reach the DOM on a real phone.
  assert.match(shells, /pulsingStatus\("Loading schedule…"\)/);
  for (const computed of ["scheduleFilters(", "weekStrip(", "periodsInOrder(", "groupedPeriods(", "fixtureRow("]) {
    assert.ok(!shells.replace(/\/\/[^\n]*/g, "").includes(computed), `shell must not call ${computed}`);
  }
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
  assert.match(paint, /app\.innerHTML = html;/);
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

// --- build 16: acknowledgement before work ----------------------------------

test("navigation is handled before any unrelated awaited branch", () => {
  const listener = APP.slice(APP.indexOf('document.addEventListener("click", async (event) => {'));
  const head = listener.slice(0, listener.indexOf('const nav = event.target.closest("[data-view]")'));
  const code = head.replace(/\/\/[^\n]*/g, "");
  assert.equal(/\bawait\b/.test(code), false, "an await before nav delays the tap that opens the heaviest screen");
  // The gesture-sensitive branches that genuinely must be first are still first.
  assert.match(code, /data-share-league/);
  assert.match(code, /data-expand-fixture/);
});

test("the tab is marked and the shell inserted before the board is built", () => {
  const nav = lift("async function navigateToView(view)");
  const shell = nav.indexOf("paintShell(view)");
  const board = nav.indexOf('traceTap("board-build-start"');
  assert.ok(shell > 0 && board > shell, "the board must come after the shell");
  // And a real yield between them, or the shell never reaches the glass.
  assert.ok(nav.indexOf("await nextPaint()") > shell);
  assert.ok(nav.indexOf("await nextPaint()") < board);
  const paint = lift("function paintShell(view)");
  assert.match(paint, /markActiveTab\(\);/);
});

test("arriving at Schedule resets the scroller before the shell", () => {
  const nav = lift("async function navigateToView(view)");
  assert.ok(nav.indexOf("appScroller()?.scrollTo({ top: 0 })") < nav.indexOf("paintShell(view)"));
});

// --- build 16: the stale-render race ----------------------------------------

test("every navigation takes a generation", () => {
  const nav = lift("async function navigateToView(view)");
  assert.match(nav, /const generation = \+\+navGeneration;/);
  assert.match(APP, /const navCurrent = \(generation, view\) => generation === navGeneration && view === currentView;/);
  // Checked after every await, not just the first.
  assert.ok((nav.match(/navCurrent\(generation, view\)/g) || []).length >= 3);
});

test("a superseded response may cache but must not paint", () => {
  const loader = lift("async function loadLeagueState(generation = navGeneration, { roundStarted = false } = {})");
  assert.match(loader, /generation !== navGeneration \|\| view !== currentView/);
  // Cached first, painted only if still current.
  assert.ok(loader.indexOf("cacheLeagueState(state);") < loader.indexOf("if (superseded()) return;\n    leagueState = state;"));
});

test("a late round response cannot repaint a screen that has moved on", () => {
  const loader = lift("async function loadRoundState(generation = navGeneration)");
  assert.match(loader, /generation !== navGeneration \|\| view !== currentView/);
  assert.match(loader, /if \(!superseded\(\)\) render\(\);/);
});

// --- build 16: the cached matchweek -----------------------------------------

test("startup restores league, period and round together", () => {
  const fn = lift("function hydrateCachedLeague()");
  assert.match(fn, /leagueState = cached;/);
  assert.match(fn, /selectedPeriod = cached\.currentPeriod \?\? currentPeriodKey\(\);/);
  assert.match(fn, /const round = cachedRoundState\(activeLeague, selectedPeriod\);/);
  assert.match(fn, /if \(round\) roundState = round;/);
  assert.match(APP, /^hydrateCachedLeague\(\);$/m, "and it runs at startup");
});

test("League navigation paints from cache before it asks for anything", () => {
  const nav = lift("async function navigateToView(view)");
  const branch = nav.slice(nav.indexOf('if (currentView === "league")'));
  assert.ok(branch.indexOf("hydrateCachedLeague();") < branch.indexOf("refreshLeague(generation)"));
  assert.match(branch, /if \(leagueState\) \{ render\(\); traceTap\("cached-league-painted", \{\}\); \}/);
});

test("a valid cached week is never replaced by a loading state", () => {
  const loader = lift("async function loadRoundState(generation = navGeneration)");
  assert.match(loader, /\} else if \(showingAnotherWeek && !cached\) \{/);
  // A failed refresh leaves what is on screen alone.
  assert.match(loader, /if \(!cached\) roundState = \{ error: error\.message \};/);
});

test("season and round revalidate in parallel when the week is known", () => {
  const nav = lift("async function navigateToView(view)");
  // One place decides parallel vs serial, shared by navigation, startup and
  // the league-pill switch.
  const refresh = lift("async function refreshLeague(generation = navGeneration)");
  assert.match(refresh, /const knownPeriod = selectedPeriod != null && leagueTab === "matchday";/);
  assert.match(refresh, /await Promise\.all\(\[/);
  assert.match(refresh, /loadLeagueState\(generation, \{ roundStarted: knownPeriod \}\),/);
  assert.match(refresh, /knownPeriod \? loadRoundState\(generation\) : Promise\.resolve\(\),/);
  // The claim is explicit. Inferring it from a known week was wrong: every
  // standalone caller has a known week and none of them start a round read.
  const from = APP.indexOf("async function loadLeagueState(generation = navGeneration, { roundStarted = false } = {})");
  const loader = APP.slice(from, APP.indexOf("async function refreshLeague", from));
  assert.match(loader, /if \(leagueTab === "matchday" && !roundStarted\) \{/);
  assert.doesNotMatch(loader, /periodKnownAtStart/);
});

test("the separated timings are all traced", () => {
  for (const point of [
    "nav-enter", "shell-build-start", "shell-build-end", "shell-inserted",
    "shell-painted", "board-build-start", "board-build-end", "cached-league-painted",
  ]) {
    assert.ok(APP.includes(`traceTap("${point}"`), `missing trace point: ${point}`);
  }
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
