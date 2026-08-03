// Switching leagues, and the two bugs Adam hit on build 10.
//
// Both are timing faults, so both are executed rather than grepped: the league
// loaders are run against a stubbed API whose responses arrive out of order, and
// the share call is run against a stubbed plugin that records whether it was
// reached before the function returned.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

/**
 * A top-level function, verbatim. Brace-counting cannot be used here: these
 * take destructured parameters, whose closing brace would end the count early.
 * Every top-level function in app.js closes on an unindented `}`.
 */
function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  const end = APP.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated: ${startsWith}`);
  return APP.slice(start, end + 2);
}

// --- 1. the league loaders --------------------------------------------------

const NICKS = { AAA: "Adam", BBB: "Biggers" };

/**
 * app.js's two loaders over a stub API, with a per-league delay so responses can
 * be made to arrive in the wrong order.
 */
function loaders({ delays = {} } = {}) {
  const paints = [];
  const build = new Function("delays", "paints", `
    "use strict";
    let activeLeague = null, leagueState = null, roundState = null;
    let selectedPeriod = null, leagueTab = "matchday", leagueStates = {};
    let leagueStateRequest = 0, roundStateRequest = 0;
    const API = "https://worker.test";
    const NICKS = ${JSON.stringify(NICKS)};

    const codeOf = (path) => /code=([A-Z]+)/.exec(path)[1];
    const periodOf = (path) => (/period=([^&]+)/.exec(path) || [])[1] ?? null;
    const api = (path) => new Promise((resolve) => {
      const code = codeOf(path);
      const body = {
        code, name: code + " League", competitions: ["PL"], currentPeriod: 1,
        period: periodOf(path), rounds: true,
        table: [{ uid: "u1", nick: NICKS[code] }], podium: [], reveals: [], cabinet: [],
      };
      setTimeout(() => resolve(body), delays[code] ?? 0);
    });

    const uid = () => "u1";
    const rememberCompetition = () => false;
    const loadFixtures = async () => {};
    const saveLeagueName = () => {};
    const cacheLeagueState = (state) => { leagueStates = { ...leagueStates, [state.code]: state }; };
    const forgetLeagueState = () => {};
    const removeStoredLeague = () => {};
    const leagueSupportsRounds = () => true;
    const currentPeriodKey = () => 1;
    const render = () => paints.push({ card: leagueState?.code ?? null, table: roundState?.code ?? null });

    ${lift("async function loadLeagueState()")}
    ${lift("async function loadRoundState()")}

    return {
      switchTo: (code) => { activeLeague = code; return loadLeagueState(); },
      settled: () => ({
        pill: activeLeague,
        card: leagueState?.code ?? null,
        nick: leagueState?.table?.[0]?.nick ?? null,
        table: roundState?.code ?? null,
      }),
    };
  `);
  return { ...build(delays, paints), paints };
}

test("the slower of two league switches never paints over the newer one", async () => {
  // Adam's phone: the first league's /state crawls, the second's is quick.
  const app = loaders({ delays: { AAA: 40, BBB: 1 } });
  const first = app.switchTo("AAA");
  const second = app.switchTo("BBB");
  await Promise.all([first, second]);

  assert.deepEqual(app.settled(), {
    pill: "BBB", card: "BBB", nick: "Biggers", table: "BBB",
  }, "the league on screen must be the one the pill says");
});

test("the card and its table are never from different leagues", async () => {
  const app = loaders({ delays: { AAA: 40, BBB: 1 } });
  await Promise.all([app.switchTo("AAA"), app.switchTo("BBB")]);
  const { card, table } = app.settled();
  assert.equal(card, table, "one league's name over another league's rows is the reported bug");
  // Every intermediate paint agreed with itself too, so the wrong nickname was
  // never even briefly on screen.
  for (const paint of app.paints) {
    if (paint.card && paint.table) assert.equal(paint.card, paint.table, JSON.stringify(paint));
  }
});

test("switching back and forth lands on whichever league was asked for last", async () => {
  const app = loaders({ delays: { AAA: 30, BBB: 10 } });
  const runs = [app.switchTo("AAA"), app.switchTo("BBB"), app.switchTo("AAA")];
  await Promise.all(runs);
  assert.deepEqual(app.settled(), { pill: "AAA", card: "AAA", nick: "Adam", table: "AAA" });
});

test("an unraced switch still loads normally", async () => {
  const app = loaders();
  await app.switchTo("AAA");
  assert.deepEqual(app.settled(), { pill: "AAA", card: "AAA", nick: "Adam", table: "AAA" });
  await app.switchTo("BBB");
  assert.deepEqual(app.settled(), { pill: "BBB", card: "BBB", nick: "Biggers", table: "BBB" });
});

// --- 2. renaming in one league ----------------------------------------------

function renamer() {
  const build = new Function(`
    "use strict";
    let leagueState = { code: "AAA", table: [{ uid: "u1", nick: "Adam" }], reveals: [], cabinet: [] };
    let roundState = { code: "BBB", table: [{ uid: "u1", nick: "Biggers" }], podium: [{ uid: "u1", nick: "Biggers" }] };
    let leagueStates = {
      AAA: { code: "AAA", table: [{ uid: "u1", nick: "Adam" }] },
      BBB: { code: "BBB", table: [{ uid: "u1", nick: "Biggers" }] },
    };
    const cacheLeagueState = (state) => { leagueStates = { ...leagueStates, [state.code]: state }; };
    ${lift("function applyNickLocally(code, memberUid, nick)")}
    return {
      rename: applyNickLocally,
      nicks: () => ({
        live: leagueState.table[0].nick,
        round: roundState.table[0].nick,
        podium: roundState.podium[0].nick,
        cachedAAA: leagueStates.AAA.table[0].nick,
        cachedBBB: leagueStates.BBB.table[0].nick,
      }),
    };
  `);
  return build();
}

test("a rename in one league leaves every other league's name alone", () => {
  const app = renamer();
  app.rename("AAA", "u1", "Bigwood");
  assert.deepEqual(app.nicks(), {
    live: "Bigwood",       // the league renamed
    round: "Biggers",      // a round table belonging to another league
    podium: "Biggers",
    cachedAAA: "Bigwood",  // and the cache the pills paint from
    cachedBBB: "Biggers",
  });
});

test("a rename does reach the round table when it is that league's", () => {
  const app = renamer();
  app.rename("BBB", "u1", "Bigwood");
  const nicks = app.nicks();
  assert.equal(nicks.round, "Bigwood", "same league, so the round table follows");
  assert.equal(nicks.podium, "Bigwood");
  assert.equal(nicks.live, "Adam", "and the other league is untouched");
  assert.equal(nicks.cachedAAA, "Adam");
});

// --- 2b. the confirmation banner --------------------------------------------

function switcher() {
  const build = new Function(`
    "use strict";
    let activeLeague = "AAA", selectedPeriod = null, roundState = null, leagueState = null;
    let flashMessage = "", flashTone = "success";
    let leagueStates = { AAA: { code: "AAA" }, BBB: { code: "BBB" } };
    const STORAGE = { activeLeague: "k" };
    const localStorage = { setItem() {}, removeItem() {} };
    const leagueSupportsRounds = () => false;
    const currentPeriodKey = () => 1;
    const render = () => {};
    ${lift("function setFlash(message, tone = \"success\")")}
    ${lift("function clearFlash()")}
    ${lift("function setActiveLeague(code, refresh = true)")}
    return {
      flash: (m) => setFlash(m),
      switchTo: (code) => setActiveLeague(code, false),
      banner: () => flashMessage,
    };
  `);
  return build();
}

test("a rename confirmation does not follow you to the next league", () => {
  // Adam's exact steps: rename in one league, then tap the other pill. The
  // banner says "in this league", so carrying it over reads as the new
  // league's name — which is what was reported.
  const app = switcher();
  app.switchTo("BBB");
  app.flash("Now showing as Biggers in this league");
  assert.equal(app.banner(), "Now showing as Biggers in this league");
  app.switchTo("AAA");
  assert.equal(app.banner(), "", "the confirmation belonged to the league just left");
});

test("a flash for the league you are already on survives a no-op switch", () => {
  const app = switcher();
  app.flash("Joined Sunday Six");
  app.switchTo("AAA"); // already active
  assert.equal(app.banner(), "Joined Sunday Six");
});

// --- 4. repaints and taps ---------------------------------------------------

/**
 * app.js's renderer over a stub document, with the pointer listeners it installs
 * captured so a tap can be played through them.
 */
function renderer() {
  const build = new Function(`
    "use strict";
    const writes = [];
    const listeners = {};
    const timers = [];
    let view = "A";
    const app = { set innerHTML(v) { writes.push(v); }, get innerHTML() { return writes[writes.length - 1]; } };
    const document = {
      getElementById: (id) => (id === "app" ? app : { textContent: "" }),
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    };
    const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const requestAnimationFrame = () => {};
    let currentView = "today";
    const todayView = () => view;
    const scheduleView = todayView, picksView = todayView, leagueView = todayView, rulesView = todayView;
    const renderPickerLayer = () => {};
    const playerInitial = () => "A";
    const centreWeekStrip = () => { centred++; };
    let centred = 0;

    let renderedHTML = null;
    let tapInProgress = false;
    let heldRender = null;
    ${lift("function flushHeldRender()")}
    ${lift("function render(options = {})")}

    // Install the pointer listeners exactly as app.js does.
    document.addEventListener("pointerdown", () => { tapInProgress = true; setTimeout(flushHeldRender, 500); }, true);
    document.addEventListener("pointercancel", flushHeldRender, true);
    document.addEventListener("pointerup", () => setTimeout(flushHeldRender, 0), true);

    const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
    const runTimers = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
    return {
      render, flushHeldRender,
      setView: (v) => { view = v; },
      writes: () => writes.slice(),
      centred: () => centred,
      pointerDown: () => fire("pointerdown"),
      pointerUp: () => { fire("pointerup"); runTimers(); },
      pointerCancel: () => fire("pointercancel"),
    };
  `);
  return build();
}

test("a repaint that changes nothing does not touch the DOM", () => {
  const app = renderer();
  app.render();
  app.render();
  app.render();
  assert.equal(app.writes().length, 1, "three renders, one write");
  // And a strip nobody rebuilt is not yanked back to centre.
  assert.equal(app.centred(), 1);
});

test("a repaint that changes something still lands", () => {
  const app = renderer();
  app.render();
  app.setView("B");
  app.render();
  assert.deepEqual(app.writes(), ["A", "B"]);
  assert.equal(app.centred(), 2);
});

test("a repaint asked for mid-tap is held until the tap is delivered", () => {
  const app = renderer();
  app.render();                    // initial paint
  app.pointerDown();
  app.setView("B");
  app.render();                    // would have replaced the button under the finger
  assert.deepEqual(app.writes(), ["A"], "nothing was replaced while the finger was down");
  app.pointerUp();
  assert.deepEqual(app.writes(), ["A", "B"], "and it lands once the tap is over");
});

test("only the newest held repaint is applied", () => {
  const app = renderer();
  app.render();
  app.pointerDown();
  app.setView("B"); app.render();
  app.setView("C"); app.render();
  app.pointerUp();
  assert.deepEqual(app.writes(), ["A", "C"]);
});

test("a cancelled or abandoned tap still releases the repaint", () => {
  const cancelled = renderer();
  cancelled.render();
  cancelled.pointerDown();
  cancelled.setView("B"); cancelled.render();
  cancelled.pointerCancel();
  assert.deepEqual(cancelled.writes(), ["A", "B"], "a cancelled tap must not freeze the screen");

  // A finger held down past the watchdog also releases it.
  const held = renderer();
  held.render();
  held.pointerDown();
  held.setView("B"); held.render();
  held.flushHeldRender();
  assert.deepEqual(held.writes(), ["A", "B"]);
});

// --- 3. the share sheet -----------------------------------------------------

/** app.js's share path over a stubbed Capacitor. */
function sharer({ native = true, plugin = true, webShare = false } = {}) {
  const calls = [];
  const build = new Function("calls", "native", "plugin", "webShare", `
    "use strict";
    const WEB_BASE = "https://premoracle.app/";
    const isNativeApp = () => native;
    const whatsappUrlFor = (text) => "whatsapp://send?text=" + encodeURIComponent(text);
    const location = { origin: "https://premoracle.app", pathname: "/", set href(v) { calls.push({ via: "whatsapp", url: v }); } };
    const window = { Capacitor: plugin ? { Plugins: { Share: {
      share: (options) => { calls.push({ via: "plugin", options, returned: false }); return Promise.resolve(); },
    } } } : {} };
    const navigator = webShare ? { share: (options) => { calls.push({ via: "webshare", options }); return Promise.resolve(); } } : {};
    ${lift("function inviteLinkFor(code)")}
    ${lift("function shareNow({ title, text, url })")}
    ${lift("function leagueInvite(code)")}
    return { invite: (code) => shareNow(leagueInvite(code)) };
  `);
  return { ...build(calls, native, plugin, webShare), calls };
}

test("the share sheet is reached before the handler returns", () => {
  // The whole point: iOS only presents the sheet from inside the tap, so the
  // plugin must have been called by the time shareNow() hands control back.
  const app = sharer();
  app.invite("VL4353");
  assert.equal(app.calls.length, 1, "nothing was deferred to a later tick");
  assert.equal(app.calls[0].via, "plugin");
});

test("the invite carries the league code and a joinable link", () => {
  const app = sharer();
  app.invite("VL4353");
  const { options } = app.calls[0];
  assert.equal(options.url, "https://premoracle.app/?league=VL4353");
  assert.match(options.text, /Join my Prem Oracle league VL4353/);
  assert.match(options.text, /https:\/\/premoracle\.app\/\?league=VL4353/);
  assert.equal(options.dialogTitle, options.title, "the sheet is titled");
});

test("the web falls back to navigator.share, then to WhatsApp", () => {
  const web = sharer({ native: false, plugin: false, webShare: true });
  web.invite("VL4353");
  assert.equal(web.calls[0].via, "webshare");

  const bare = sharer({ native: false, plugin: false, webShare: false });
  bare.invite("VL4353");
  assert.equal(bare.calls[0].via, "whatsapp", "a browser with neither still shares");
  assert.match(bare.calls[0].url, /^whatsapp:/);
});

test("nothing is awaited before the share branch runs", () => {
  // Structural, because the ordering is the fix: everything below the share
  // branch awaits async handlers, and an await ends the tap.
  const listener = APP.slice(APP.indexOf('document.addEventListener("click", async (event) => {'));
  const upToShare = listener.slice(0, listener.indexOf("shareNow(leagueInvite("));
  assert.ok(upToShare.length < 900, "the share branch must be at the top of the handler");
  const code = upToShare.replace(/\/\/[^\n]*/g, ""); // comments may say the word
  assert.equal(/\bawait\b/.test(code), false, "an await before the share call loses the user gesture");
});
