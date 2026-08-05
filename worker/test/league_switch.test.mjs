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

/** One line, verbatim — for the single-expression const arrows. */
function liftLine(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  return APP.slice(start, APP.indexOf("\n", start));
}

// --- 1. the league loaders --------------------------------------------------

const NICKS = { AAA: "Adam", BBB: "Biggers" };

/**
 * app.js's two loaders over a stub API, with a per-league delay so responses can
 * be made to arrive in the wrong order.
 */
function loaders({ delays = {}, roundDelays = {}, fail = false, cachedLeagues = {}, cachedRounds = {}, active = null } = {}) {
  const paints = [];
  const build = new Function("delays", "roundDelays", "paints", "shouldFail", "cachedLeagues", "cachedRounds", "active", `
    "use strict";
    let activeLeague = active, leagueState = null, roundState = null;
    let selectedPeriod = null, leagueTab = "matchday", leagueStates = { ...cachedLeagues };
    let leagueStateRequest = 0, roundStateRequest = 0;
    let navGeneration = 0;
    let currentView = "league";
    const API = "https://worker.test";
    const NICKS = ${JSON.stringify(NICKS)};

    const codeOf = (path) => /code=([A-Z]+)/.exec(path)[1];
    const periodOf = (path) => (/period=([^&]+)/.exec(path) || [])[1] ?? null;
    const api = (path) => new Promise((resolve, reject) => {
      const code = codeOf(path);
      const body = {
        code, name: code + " League", competitions: ["PL"], currentPeriod: 1,
        period: periodOf(path), rounds: true,
        table: [{ uid: "u1", nick: NICKS[code] }], podium: [], reveals: [], cabinet: [],
      };
      // Round and season can be made to arrive in either order.
      const wait = periodOf(path) != null ? (roundDelays[code] ?? 0) : (delays[code] ?? 0);
      setTimeout(() => (shouldFail ? reject(new Error("network down")) : resolve(body)), wait);
    });

    const uid = () => "u1";
    const bumpStamp = () => {};             // panel retention is measured in the browser
    const dropRetainedPanels = () => {};
    let seasonFlights = 0, roundFlights = 0;
    const countingApi = (path) => {
      if (path.includes("period=")) roundFlights++; else seasonFlights++;
      return api(path);
    };
    const rememberCompetition = () => false;
    const loadFixtures = async () => {};
    const saveLeagueName = () => {};
    const cacheLeagueState = (state) => { leagueStates = { ...leagueStates, [state.code]: state }; };
    const forgetLeagueState = () => {};
    const removeStoredLeague = () => {};
    const leagueSupportsRounds = () => true;
    const currentPeriodKey = () => 1;
    let roundStates = { ...cachedRounds };
    const leagueCodes = ["AAA", "BBB"];
    const localStorage = { setItem() {}, getItem: () => null };
    const STORAGE = { roundStates: "k" };
    ${liftLine("const roundCacheKey =")}
    ${lift("function cacheRoundState(code, period, state)")}
    ${lift("function cachedRoundState(code, period)")}
    // "Loading matchweek…" is drawn exactly when the matchday tab has no round
    // state, so a paint that records that is a paint of the loading screen.
    const render = () => paints.push({
      card: leagueState?.code ?? null,
      table: roundState?.code ?? null,
      period: selectedPeriod,
      loadingRound: leagueTab === "matchday" && !roundState,
    });

    const stateFlights = new Map();
    ${lift("function fetchState(path)").replace("api(path)", "countingApi(path)")}
    ${liftLine("const seasonStatePath =")}
    ${liftLine("const roundStatePath =")}
    ${lift("function hydrateCachedLeague()")}
    ${lift("async function loadLeagueState(generation = navGeneration, { roundStarted = false } = {})")}
    ${lift("async function refreshLeague(generation = navGeneration)")}
    ${lift("async function loadRoundState(generation = navGeneration)")}

    return {
      // The app's own startup tail: hydrate, paint, then refresh in parallel.
      startup: () => { hydrateCachedLeague(); render(); },
      startupRefresh: async () => { await refreshLeague(); render(); },
      /**
       * The COMPLETE production startup, both stages:
       *   1. hydrateIdentity() — /me resolves the active league, then refreshes
       *   2. the Promise.all(...).then(...) tail — launch tree, then render
       * Modelling only stage 1 hid a second refresh in stage 2; they run
       * sequentially, so coalescing could never merge them.
       */
      fullStartup: async ({ tailRefreshes = false } = {}) => {
        hydrateCachedLeague();
        render();                       // first paint, from cache
        await new Promise((r) => setTimeout(r, 1));   // stands in for /me
        if (activeLeague) await refreshLeague();      // stage 1: the one owner
        if (tailRefreshes) await refreshLeague();     // the bug, for comparison
        render();                       // stage 2 keeps its final render
      },
      // A standalone refresh, as publishing / the picker / a rename does it.
      standalone: async () => { await loadLeagueState(); render(); },
      // The league-pill switch, in the order setActiveLeague does it.
      switchTo: async (code) => {
        activeLeague = code;
        selectedPeriod = null;
        roundState = null;
        hydrateCachedLeague();
        render();
        await refreshLeague();
        render();   // setActiveLeague paints once the revalidation lands
      },
      // navigateToView's league branch.
      navigate: async () => {
        hydrateCachedLeague();
        if (leagueState) render();
        await refreshLeague();
        render();   // navigateToView paints once the revalidation lands
      },
      loadRound: () => { activeLeague = activeLeague || "AAA"; selectedPeriod = 1; return loadRoundState(); },
      flights: () => seasonFlights + roundFlights,
      seasonFlights: () => seasonFlights,
      roundFlights: () => roundFlights,
      inFlight: () => stateFlights.size,
      settled: () => ({
        pill: activeLeague,
        card: leagueState?.code ?? null,
        nick: leagueState?.table?.[0]?.nick ?? null,
        table: roundState?.code ?? null,
      }),
    };
  `);
  return { ...build(delays, roundDelays, paints, fail, cachedLeagues, cachedRounds, active), paints };
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

// --- 1b. coalescing ---------------------------------------------------------

test("opening a league twice at once makes ONE season request", async () => {
  // The launch path, the tab navigation and the league switch all used to ask
  // independently, and each paid the full server assembly.
  const app = loaders({ delays: { AAA: 40 } });
  await Promise.all([app.switchTo("AAA"), app.switchTo("AAA"), app.switchTo("AAA")]);
  assert.equal(app.seasonFlights(), 1, "three opens, one season request");
  assert.ok(app.roundFlights() <= 1, `and at most one round request, got ${app.roundFlights()}`);
  assert.deepEqual(app.settled(), { pill: "AAA", card: "AAA", nick: "Adam", table: "AAA" });
});

test("the ROUND request coalesces too, not just the season one", async () => {
  // It runs the same assembly server-side, so a duplicate costs just as much.
  const app = loaders({ delays: { AAA: 30 } });
  await Promise.all([app.loadRound(), app.loadRound(), app.loadRound()]);
  assert.equal(app.roundFlights(), 1, "three round loads, one request");
});

test("a season and a round request are different flights", async () => {
  const app = loaders({ delays: { AAA: 20 }, active: "AAA" });
  await app.switchTo("AAA");
  assert.equal(app.seasonFlights(), 1, "the season asked once");
  assert.equal(app.roundFlights(), 1, "the round asked once, separately");
});

test("two different leagues are not coalesced into one", async () => {
  const app = loaders({ delays: { AAA: 20, BBB: 20 } });
  await Promise.all([app.switchTo("AAA"), app.switchTo("BBB")]);
  assert.equal(app.seasonFlights(), 2, "one each, not shared");
});

test("a flight is released when it settles, so the next open refetches", async () => {
  const app = loaders({ delays: { AAA: 5 } });
  await app.switchTo("AAA");
  assert.equal(app.inFlight(), 0, "nothing left holding the map");
  await app.switchTo("AAA");
  assert.equal(app.seasonFlights(), 2, "a later open is a real request, not a stale promise");
});

test("a failed request is not cached as a flight", async () => {
  const app = loaders({ delays: { AAA: 5 }, fail: true });
  await app.switchTo("AAA");
  assert.equal(app.inFlight(), 0, "a failure must be retryable");
});

// --- 1c. the cached matchweek, behaviourally --------------------------------
//
// "Loading matchweek…" is drawn exactly when the matchday tab has no round
// state. Every test below asserts on what was PAINTED, not on what the source
// says, because a half-applied fix reads correct and behaves wrong.

const cachedSeason = (code) => ({
  code, name: `${code} League`, competitions: ["PL"], currentPeriod: 1,
  rounds: true, table: [{ uid: "u1", nick: NICKS[code] }],
});
const cachedRound = (code) => ({ code, period: 1, table: [{ uid: "u1", nick: NICKS[code] }] });
const warm = (code) => ({
  cachedLeagues: { [code]: cachedSeason(code) },
  cachedRounds: { [`${code}:1`]: cachedRound(code) },
});

// (a)
test("startup's FIRST paint carries the cached table, never the loading state", async () => {
  const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 50 }, roundDelays: { AAA: 50 } });
  app.startup();
  const first = app.paints[0];
  assert.ok(first, "startup painted");
  assert.equal(first.card, "AAA");
  assert.equal(first.table, "AAA", "the cached week is on screen at the first paint");
  assert.equal(first.period, 1, "and the week it belongs to was restored with it");
  assert.equal(first.loadingRound, false, "no Loading matchweek at any point");
});

// (b)
test("switching to a warm league paints its table in the same tick", async () => {
  const app = loaders({
    cachedLeagues: { AAA: cachedSeason("AAA"), BBB: cachedSeason("BBB") },
    cachedRounds: { "AAA:1": cachedRound("AAA"), "BBB:1": cachedRound("BBB") },
    active: "AAA", delays: { BBB: 60 }, roundDelays: { BBB: 60 },
  });
  app.startup();
  const before = app.paints.length;
  const pending = app.switchTo("BBB");
  const onSwitch = app.paints[before];
  assert.ok(onSwitch, "the switch painted synchronously");
  assert.equal(onSwitch.card, "BBB");
  assert.equal(onSwitch.table, "BBB", "BBB's cached week, not AAA's and not nothing");
  assert.equal(onSwitch.loadingRound, false);
  await pending;
  assert.ok(app.paints.every((paint) => !paint.loadingRound), "and never at any point after");
});

// (c)
test("one open makes ONE season and ONE round call, even when the round wins the race", async () => {
  // The round resolving first is what used to slip past coalescing: it had
  // left the in-flight map by the time the slow season response landed.
  const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 80 }, roundDelays: { AAA: 5 } });
  app.startup();
  await app.navigate();
  assert.equal(app.seasonFlights(), 1, `season calls: ${app.seasonFlights()}`);
  assert.equal(app.roundFlights(), 1, `round calls: ${app.roundFlights()}`);
});

// (d)
test("a known week revalidates in parallel on navigation, startup and pill switch", async () => {
  for (const [label, run] of [
    ["navigation", (app) => app.navigate()],
    ["pill switch", (app) => app.switchTo("AAA")],
    ["startup refresh", (app) => app.startupRefresh()],
  ]) {
    const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 60 }, roundDelays: { AAA: 60 } });
    app.startup();
    const started = Date.now();
    await run(app);
    const elapsed = Date.now() - started;
    assert.equal(app.seasonFlights(), 1, `${label}: one season call`);
    assert.equal(app.roundFlights(), 1, `${label}: one round call`);
    // Serial would be ~120ms; parallel finishes in about one delay.
    assert.ok(elapsed < 110, `${label}: took ${elapsed}ms, so they did not overlap`);
  }
});

// (e)
test("a cold unknown week asks the season first, then exactly one round", async () => {
  const app = loaders({ active: "AAA", delays: { AAA: 10 }, roundDelays: { AAA: 10 } });
  app.startup();
  const first = app.paints[0];
  // Nothing cached, so the acknowledged state is what shows — by contract.
  assert.equal(first.card, null, "no data to show yet");
  assert.equal(first.loadingRound, true, "which is the acknowledged pulsing state");
  await app.navigate();
  assert.equal(app.seasonFlights(), 1, "one season call");
  assert.equal(app.roundFlights(), 1, "and exactly one round call after it discovered the week");
  const settled = app.paints[app.paints.length - 1];
  assert.equal(settled.table, "AAA", "and it lands");
});

// (f)
test("a failed refresh leaves the cached week on screen", async () => {
  const app = loaders({ ...warm("AAA"), active: "AAA", fail: true });
  app.startup();
  await app.navigate();
  const last = app.paints[app.paints.length - 1];
  assert.equal(last.table, "AAA", "still showing what we had");
  assert.equal(last.loadingRound, false, "and not replaced by a loading state");
  assert.ok(app.paints.every((paint) => !paint.loadingRound));
});

// (g)
test("a superseded response caches but cannot repaint another league", async () => {
  const app = loaders({
    cachedLeagues: { AAA: cachedSeason("AAA"), BBB: cachedSeason("BBB") },
    cachedRounds: { "AAA:1": cachedRound("AAA"), "BBB:1": cachedRound("BBB") },
    active: "AAA", delays: { AAA: 80, BBB: 5 }, roundDelays: { AAA: 80, BBB: 5 },
  });
  app.startup();
  const slow = app.navigate();            // AAA, slow
  const quick = app.switchTo("BBB");      // overtakes it
  await Promise.all([slow, quick]);
  const settled = app.settled();
  assert.equal(settled.card, "BBB", "the league on screen is the one asked for last");
  assert.equal(settled.table, "BBB", "and so is its table");
  for (const paint of app.paints) {
    if (paint.card && paint.table) assert.equal(paint.card, paint.table, JSON.stringify(paint));
  }
});

// (h) the standalone contract -------------------------------------------------

test("a standalone loadLeagueState with a known week still refreshes the round", async () => {
  // Publishing, an amendment, closing the picker, a rename, a kick and startup
  // all call it alone. Inferring "somebody already asked" from a known week
  // stopped every one of them refreshing the table they had just changed.
  const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 5 }, roundDelays: { AAA: 5 } });
  app.startup();
  await app.standalone();
  assert.equal(app.seasonFlights(), 1, "one season read");
  assert.equal(app.roundFlights(), 1, "and the week it owns is refreshed exactly once");
});

test("a publish-style standalone refresh cannot leave the Matchweek stale", async () => {
  const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 5 }, roundDelays: { AAA: 5 } });
  app.startup();
  await app.standalone();
  const settled = app.settled();
  assert.equal(settled.table, "AAA", "the week is on screen");
  assert.ok(app.paints.every((paint) => !paint.loadingRound), "and was never blanked to do it");
});

test("only refreshLeague may claim the round is already started", async () => {
  // The claim is explicit, never inferred: exactly one round request either way.
  const parallel = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 60 }, roundDelays: { AAA: 5 } });
  parallel.startup();
  await parallel.startupRefresh();
  assert.equal(parallel.roundFlights(), 1, "round finished first, still only one request");
  assert.equal(parallel.seasonFlights(), 1);
});

// (i) the complete startup sequence ------------------------------------------

test("a warm complete startup makes one season and one round request, in parallel", async () => {
  const app = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 60 }, roundDelays: { AAA: 60 } });
  const started = Date.now();
  await app.fullStartup();
  const elapsed = Date.now() - started;
  assert.equal(app.seasonFlights(), 1, `season requests across the WHOLE launch: ${app.seasonFlights()}`);
  assert.equal(app.roundFlights(), 1, `round requests across the WHOLE launch: ${app.roundFlights()}`);
  assert.ok(elapsed < 110, `took ${elapsed}ms, so the two did not overlap`);
  assert.ok(app.paints.every((paint) => !paint.loadingRound), "and the cached week was never blanked");
});

test("a cold complete startup makes one season, then one round after discovery", async () => {
  const app = loaders({ active: "AAA", delays: { AAA: 10 }, roundDelays: { AAA: 10 } });
  await app.fullStartup();
  assert.equal(app.seasonFlights(), 1, "one season request for the whole launch");
  assert.equal(app.roundFlights(), 1, "and one round request, after the week was discovered");
  assert.equal(app.settled().table, "AAA", "and the week lands");
});

test("no second refresh happens once identity hydration has settled", async () => {
  // The regression this guards: hydrateIdentity() awaited its refresh and the
  // startup tail then ran another. Sequential, so nothing could coalesce them.
  const owned = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 5 }, roundDelays: { AAA: 5 } });
  await owned.fullStartup();

  const doubled = loaders({ ...warm("AAA"), active: "AAA", delays: { AAA: 5 }, roundDelays: { AAA: 5 } });
  await doubled.fullStartup({ tailRefreshes: true });

  assert.equal(owned.seasonFlights(), 1);
  assert.equal(doubled.seasonFlights(), 2, "the harness can still see the old shape, so this test can fail");
  assert.ok(owned.seasonFlights() < doubled.seasonFlights(), "one owner, not two");
  assert.ok(owned.roundFlights() < doubled.roundFlights(), "for the round as well");
  // And the source has exactly one startup refresh site.
  assert.equal((APP.match(/if \(activeLeague\) await refreshLeague\(\);/g) || []).length, 1);
  assert.doesNotMatch(APP, /refreshLeague\(\)\.then\(render\);\n  \}/, "the tail no longer refreshes");
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
    const cachedRoundState = () => null;
    const refreshLeague = async () => {};
    ${lift("function hydrateCachedLeague()")}
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
    let mountedKey = null;
    const mountResults = () => {};   // the island is exercised in schedule_paint
    let tapInProgress = false;
    let heldRender = null;
    const traceTap = () => {};   // the trace is measured in the browser, not here
    ${lift("function flushHeldRender(releasedBy)")}
    ${lift("function render(options = {})")}

    // Install the pointer listeners exactly as app.js does.
    document.addEventListener("pointerdown", () => { tapInProgress = true; setTimeout(() => flushHeldRender("watchdog-500ms"), 500); }, true);
    document.addEventListener("pointercancel", () => flushHeldRender("pointercancel"), true);
    document.addEventListener("pointerup", () => setTimeout(() => flushHeldRender("pointerup"), 0), true);

    const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
    const runTimers = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
    return {
      render, flushHeldRender: () => flushHeldRender("test"),
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
