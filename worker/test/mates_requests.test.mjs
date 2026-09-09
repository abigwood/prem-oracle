// Mates' Picks — what it costs, and whose answer it paints.
//
// The 940-read incident is why this feature rides on an endpoint that was
// already being called. The rule that keeps it honest is bounded revalidation:
// one coalesced round read on entering the segment, one more only if a return
// to the foreground crossed a kick-off, and nothing at all otherwise. These
// count TOTAL requests across whole production sequences rather than per call.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  const end = APP.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated: ${startsWith}`);
  return APP.slice(start, end + 2);
}

function liftLine(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  return APP.slice(start, APP.indexOf("\n", start));
}

const HOUR = 60 * 60 * 1000;

/**
 * app.js's Mates' Picks loaders over a stub API, with a per-league delay so
 * two league switches can be made to land in the wrong order.
 */
function loaders({ delays = {}, cachedRounds = {}, horizon = null } = {}) {
  const calls = [];
  const build = new Function("delays", "calls", "cachedRounds", "horizonIn", `
    "use strict";
    let activeLeague = "AAA";
    let leagueState = { code: "AAA", currentPeriod: 3 };
    let picksRound = null;
    const picksRoundFlights = new Map();
    let picksRoundClaim = { generation: -1, key: "" };
    // My Picks' week is the league's current period, which this harness sets
    // on leagueState — the same source the shipped helper reads.
    const matchweekLeagueState = () => leagueState;
    const syncShareLabel = () => {};
    const currentRoundReveal = () => revealState;
    let revealState = null, revealLockHorizon = horizonIn === null ? Infinity : horizonIn;
    let navGeneration = 0, currentView = "picks", leagueTab = "matchday";
    const LEGACY_VIEWS = { schedule: "picks", today: "picks", mates: "picks" };
    const normaliseView = (view) => LEGACY_VIEWS[view] || view;
    let paintCount = 0;
    const render = () => { paintCount += 1; };
    let roundStates = { ...cachedRounds };
    // cacheRoundState keeps only leagues this device still belongs to, and
    // writes through to storage — both of which it needs to be told about.
    const leagueCodes = ["AAA", "BBB"];
    const STORAGE = { roundStates: "prem_oracle_round_states" };
    const localStorage = { setItem() {}, getItem: () => null };
    let leagueStamps = new Map();
    let retainedPanels = new Map();
    let mountedKey = null;
    const API = "https://worker.test";
    const document = { hidden: false };
    const uid = () => "u1";
    const panels = [];
    const showResultsPanel = async () => { panels.push(revealState && revealState.code); };
    const traceTap = () => {};

    const codeOf = (path) => /code=([A-Z]+)/.exec(path)[1];
    const api = (path) => {
      calls.push(path);
      const code = codeOf(path);
      return new Promise((resolve) => setTimeout(
        () => resolve({ code, period: 3, table: [{ uid: "u1", nick: code }], reveal: [
          { id: "f1", lockAt: new Date(Date.now() + 3600000).toISOString(), revealed: false, eligible: 2, lockedIn: 1 },
        ] }),
        delays[code] || 0));
    };

    const stateFlights = new Map();
    ${lift("function fetchState(path)")}
    ${liftLine("const roundStatePath =")}
    ${liftLine("const revealPeriod =")}
    ${lift("function revealUsable(state)")}
    // v1.7 consolidation: a league change also closes the open pick row.
    let expandedPickId = null;
    ${lift("function forgetRevealState()")}
    ${lift("function lockHorizonOf(state)")}
    ${lift("function cacheRoundState(code, period, state)")}
    ${lift("function cachedRoundState(code, period)")}
    ${liftLine("const roundCacheKey =")}
    ${liftLine("const stampFor =")}
    ${liftLine("const bumpStamp =")}
    ${lift("function dropRetainedPanels(code = null)")}
    ${lift("function picksRoundUsable(state, code = activeLeague, period = picksPeriod())")}
    ${liftLine("const picksRoundKey =")}
    ${liftLine("const picksPeriod =")}
    ${lift("function claimPicksRound(code, period)")}
    ${liftLine("const releasePicksRound =")}
    ${lift("function forgetPicksRound()")}
    ${lift("function ensurePicksRound()")}
    ${lift("async function refreshRevealOnForeground()")}

    return {
      enter: () => ensurePicksRound(),
      foreground: () => refreshRevealOnForeground(),
      // What a pill switch does to this state, in the order it does it.
      setLeague: (code) => { activeLeague = code; leagueState = { code, currentPeriod: 3 }; forgetRevealState(); },
      setHidden: (value) => { document.hidden = value; },
      setTab: (tab) => { leagueTab = tab; },
      setView: (view) => { currentView = view; },
      setHorizon: (value) => { revealLockHorizon = value; },
      horizon: () => revealLockHorizon,
      state: () => revealState,
      panels: () => panels,
      paints: () => paintCount,
      calls: () => calls,
    };
  `);
  return build(delays, calls, cachedRounds, horizon);
}

// --- entering the segment ---------------------------------------------------

test("entering Mates' Picks makes exactly one round request", async () => {
  const app = loaders();
  await app.enter();
  assert.equal(app.calls().length, 1);
  assert.match(app.calls()[0], /\/state\?code=AAA&period=3&uid=u1/);
});

test("the round read names its viewer, so the reveal can be filtered for them", () => {
  assert.match(liftLine("const roundStatePath ="), /uid=\$\{encodeURIComponent\(uid\(\)\)\}/);
});

test("two entries at once coalesce into one request", async () => {
  // Tapping the segment twice, or a Weekly read for the same week landing
  // alongside it, must not become two reads of the same thing.
  const app = loaders({ delays: { AAA: 15 } });
  await Promise.all([app.enter(), app.enter()]);
  assert.equal(app.calls().length, 1);
});

test("the league-switch branch asks once and no more", () => {
  // The segment that used to ask on entry is gone. What is left is the one
  // revalidation a league change owes the reveal.
  const body = lift("async function revalidateRevealAfterSwitch(code)");
  assert.equal((body.match(/ensurePicksRound\(\)/g) || []).length, 1, "one revalidation, not two");
  assert.doesNotMatch(body, /setInterval|setTimeout/, "and nothing that would keep asking");
  assert.ok(!APP.includes('if (wanted === "mates") {'), "the segment branch survived");
});

test("nothing anywhere polls for picks", () => {
  const mates = APP.slice(APP.indexOf("function ensurePicksRound()"), APP.indexOf("async function loadKnownLeagueNames"));
  assert.doesNotMatch(mates, /setInterval/, "no polling loop");
  assert.doesNotMatch(APP, /setInterval\([^)]*[Mm]ates/, "and nothing schedules one elsewhere");
});

// --- returning to the foreground -------------------------------------------

// The real sequence: a matrix is open, the phone goes in a pocket through a
// 15:00 kick-off, and comes back out.
async function watching(options = {}) {
  const app = loaders(options);
  await app.enter();
  return app;
}

test("a return that crossed a kick-off revalidates exactly once", async () => {
  const app = await watching();
  assert.equal(app.calls().length, 1, "the entry read");
  app.setHorizon(Date.now() - 1000);
  await app.foreground();
  assert.equal(app.calls().length, 2, "and one more for the crossing");
  // The horizon is consumed, so coming back again asks for nothing more.
  await app.foreground();
  assert.equal(app.calls().length, 2, "one crossing, one request");
});

test("a return that crossed nothing asks for nothing", async () => {
  const app = await watching();
  app.setHorizon(Date.now() + HOUR);
  await app.foreground();
  assert.equal(app.calls().length, 1, "still just the entry read");
});

test("a return to any other screen asks for nothing", async () => {
  for (const setup of [(app) => app.setView("league"), (app) => app.setHidden(true)]) {
    const app = await watching();
    setup(app);
    app.setHorizon(Date.now() - 1000);
    await app.foreground();
    assert.equal(app.calls().length, 1);
  }
});

test("a return after switching league cannot revalidate the league just left", async () => {
  // The horizon belonged to AAA. BBB has not been read yet, so there is
  // nothing it could have crossed.
  const app = await watching();
  app.setHorizon(Date.now() - 1000);
  app.setLeague("BBB");
  await app.foreground();
  assert.equal(app.calls().length, 1, "no read fires off the old league's horizon");
});

test("the horizon is reset from each answer, so the next kick-off is watched", async () => {
  const app = loaders();
  await app.enter();
  // The stub answers with one fixture locking an hour out.
  assert.ok(app.horizon() > Date.now(), "a future kick-off is now the thing being waited on");
  assert.ok(app.horizon() < Date.now() + 2 * HOUR);
});

// --- the whole sequence -----------------------------------------------------

test("a full visit — enter, look around, expand cards, leave — is one request", async () => {
  const app = loaders();
  await app.enter();                       // entering the segment
  app.state();                             // reading the matrix
  app.state();                             // expanding a fixture card
  app.state();                             // and another
  await app.foreground();                  // coming back with nothing crossed
  assert.equal(app.calls().length, 1, "one round read for the whole visit");
});

// --- league switching -------------------------------------------------------

test("a slow league's answer cannot paint over the league now showing", async () => {
  const app = loaders({ delays: { AAA: 30, BBB: 1 } });
  const slow = app.enter();                // AAA, still in flight
  app.setLeague("BBB");
  await app.enter();                       // BBB lands first
  await slow;
  assert.equal(app.state().code, "BBB", "the league on screen wins");
  assert.ok(!app.panels().includes("AAA"), "and AAA never painted");
});

test("each league's matrix is cached under its own key", async () => {
  const app = loaders({ delays: { AAA: 1, BBB: 1 } });
  await app.enter();
  app.setLeague("BBB");
  await app.enter();
  assert.equal(app.state().code, "BBB");
  assert.deepEqual(app.calls().map((path) => /code=([A-Z]+)/.exec(path)[1]), ["AAA", "BBB"],
    "two leagues are two reads, never one shared answer");
});

// --- the real switch sequence -----------------------------------------------
//
// loadRevealState() on its own is not the production path. A pill tap forgets
// the old league, restores the new one's cached season state, paints, and only
// then — behind a season request that can be slow — revalidates. These drive
// the actual switchers so a cached matrix is proved to reach the screen ahead
// of the network rather than behind it.
function switching({ seasonDelay = 0, roundDelay = 0, cachedRounds = {}, cachedLeagues = {}, tab = "matchday", view = "picks" } = {}) {
  const calls = [];
  const paints = [];
  const build = new Function("seasonDelay", "roundDelay", "calls", "paints", "cachedRounds", "cachedLeagues", "tab", "view", `
    "use strict";
    let activeLeague = "AAA";
    // v1.7: a real switch closes the open Matchweek card.
    let expandedPickId = null;
    let leagueTab = tab;
    let selectedPeriod = null, roundState = null;
    let leagueStates = { ...cachedLeagues };
    let leagueState = leagueStates.AAA || null;
    let roundStates = { ...cachedRounds };
    let picksRound = null;
    const picksRoundFlights = new Map();
    let picksRoundClaim = { generation: -1, key: "" };
    // My Picks' week is the league's current period, which this harness sets
    // on leagueState — the same source the shipped helper reads.
    const matchweekLeagueState = () => leagueState;
    let revealState = null, revealLockHorizon = Infinity;
    let navGeneration = 0, currentView = view, panelGeneration = 0, mountedKey = null;
    const LEGACY_VIEWS = { schedule: "picks", today: "picks", mates: "picks" };
    const normaliseView = (view) => LEGACY_VIEWS[view] || view;
    let leagueStamps = new Map(), retainedPanels = new Map();
    const leagueCodes = ["AAA", "BBB"];
    const leagueNames = {};
    const STORAGE = { activeLeague: "a", roundStates: "r" };
    const localStorage = { setItem() {}, getItem: () => null, removeItem() {} };
    const API = "https://worker.test";
    const uid = () => "u1";
    const document = { hidden: false, querySelector: () => null };
    const traceTap = () => {};
    const markLeaguePill = () => {};
    const closeWeeklyPicker = () => {};
    const syncShareLabel = () => {};
    const clearFlash = () => {};
    const currentPeriodKey = () => 3;
    const nextPaint = () => Promise.resolve();
    const render = () => { paints.push({ what: "render", showing: revealState && revealState.code }); };
    const showResultsPanel = async () => { paints.push({ what: "panel", showing: revealState && revealState.code }); };
    // The season read: deliberately slow, so anything that waits for it shows.
    const refreshLeague = () => new Promise((resolve) => setTimeout(() => {
      calls.push("season:" + activeLeague);
      leagueState = { code: activeLeague, currentPeriod: 3, name: activeLeague };
      leagueStates[activeLeague] = leagueState;
      resolve();
    }, seasonDelay));
    const api = (path) => {
      calls.push(path);
      const code = /code=([A-Z]+)/.exec(path)[1];
      return new Promise((resolve) => setTimeout(() => resolve({
        code, period: 3, fresh: true,
        table: [{ uid: "u1", nick: code }],
        reveal: [{ id: "f1", lockAt: new Date(Date.now() + 3600000).toISOString(), revealed: false, eligible: 2, lockedIn: 1 }],
      }), roundDelay));
    };

    const stateFlights = new Map();
    ${lift("function fetchState(path)")}
    ${liftLine("const roundStatePath =")}
    ${liftLine("const revealPeriod =")}
    ${lift("function revealUsable(state)")}
    ${lift("function currentRoundReveal()")}
    ${lift("function forgetRevealState()")}
    ${lift("function hydrateRevealState()")}
    ${lift("function lockHorizonOf(state)")}
    ${lift("function cacheRoundState(code, period, state)")}
    ${lift("function cachedRoundState(code, period)")}
    ${liftLine("const roundCacheKey =")}
    ${liftLine("const stampFor =")}
    ${liftLine("const bumpStamp =")}
    ${lift("function dropRetainedPanels(code = null)")}
    ${lift("function hydrateCachedLeague()")}
    ${lift("function picksRoundUsable(state, code = activeLeague, period = picksPeriod())")}
    ${liftLine("const picksRoundKey =")}
    ${liftLine("const picksPeriod =")}
    ${lift("function claimPicksRound(code, period)")}
    ${liftLine("const releasePicksRound =")}
    ${lift("function forgetPicksRound()")}
    ${lift("function ensurePicksRound()")}
    ${lift("async function revalidateRevealAfterSwitch(code)")}
    ${lift("async function switchLeaguePill(code)")}
    ${lift("function setActiveLeague(code, refresh = true)")}

    return {
      pill: (code) => switchLeaguePill(code),
      choose: (code) => setActiveLeague(code),
      state: () => revealState,
      period: () => revealPeriod(),
      horizon: () => revealLockHorizon,
      calls: () => calls,
      paints: () => paints,
      roundCalls: () => calls.filter((call) => call.startsWith("/state")),
    };
  `);
  return build(seasonDelay, roundDelay, calls, paints, cachedRounds, cachedLeagues, tab, view);
}

/** Let the un-awaited refresh chain finish, as the app leaves it to. */
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const BBB_SEASON = { AAA: { code: "AAA", currentPeriod: 3 }, BBB: { code: "BBB", currentPeriod: 3 } };
const BBB_ROUND = {
  "BBB:3": { code: "BBB", period: 3, table: [{ uid: "u1", nick: "BBB" }], reveal: [
    { id: "f1", lockAt: new Date(Date.now() + 2 * HOUR).toISOString(), revealed: false, eligible: 2, lockedIn: 2 },
  ] },
};

test("a cached matrix paints ahead of a slow season request, and revalidates once", async () => {
  const app = switching({ seasonDelay: 40, cachedLeagues: BBB_SEASON, cachedRounds: BBB_ROUND });
  const switched = app.pill("BBB");
  // Before any network has answered: AAA is gone and BBB's cache is up.
  assert.equal(app.state().code, "BBB", "the cached matrix is in hand immediately");
  assert.deepEqual(app.roundCalls(), [], "and nothing has been asked for yet");
  await switched;
  await settle();
  assert.equal(app.roundCalls().length, 1, "exactly one round revalidation");
  assert.match(app.roundCalls()[0], /code=BBB/);
  assert.ok(!app.paints().some((paint) => paint.showing === "AAA"), "AAA never painted");
  assert.ok(app.horizon() > Date.now(), "and the cached round set its own horizon");
});

test("with no cache, only the acknowledged shell shows — and still one read", async () => {
  const app = switching({ seasonDelay: 20, cachedLeagues: BBB_SEASON });
  const switched = app.pill("BBB");
  assert.equal(app.state(), null, "nothing drawable, so the panel shows its shell");
  await switched;
  await settle();
  assert.equal(app.roundCalls().length, 1);
  assert.equal(app.state().code, "BBB");
  assert.ok(!app.paints().some((paint) => paint.showing === "AAA"));
});

test("the league switcher route behaves identically to the pill", async () => {
  const app = switching({ seasonDelay: 30, cachedLeagues: BBB_SEASON, cachedRounds: BBB_ROUND });
  app.choose("BBB");
  assert.equal(app.state().code, "BBB", "cache paints before the network");
  await settle();
  assert.equal(app.roundCalls().length, 1, "exactly one round revalidation");
  assert.equal(app.state().code, "BBB");
  assert.equal(app.state().fresh, true, "and the answer replaces the cache");
});

test("a refreshed season that moves the round discards the cached one", async () => {
  // The cache is for period 3; the refreshed season says the league has moved
  // on to 4. The stale matrix must not paint under the new period.
  const stale = { "BBB:3": { code: "BBB", period: 3, table: [], reveal: [] } };
  const app = switching({
    seasonDelay: 10,
    cachedLeagues: { AAA: { code: "AAA", currentPeriod: 3 }, BBB: { code: "BBB", currentPeriod: 3 } },
    cachedRounds: stale,
  });
  const switched = app.pill("BBB");
  assert.equal(app.state().period, 3, "the cached period paints while it is current");
  await switched;
  await settle();
  // The season refresh in this harness confirms period 3, so to exercise the
  // move we ask again with the league now on a different round.
  const moved = switching({
    seasonDelay: 0,
    cachedLeagues: { AAA: { code: "AAA", currentPeriod: 3 }, BBB: { code: "BBB", currentPeriod: 9 } },
    cachedRounds: stale,
  });
  moved.pill("BBB");
  assert.equal(moved.state(), null, "a round that is no longer current is not drawable");
});

test("neither route ever issues two round reads", async () => {
  for (const drive of [(app) => app.pill("BBB"), (app) => app.choose("BBB")]) {
    const app = switching({ seasonDelay: 5, cachedLeagues: BBB_SEASON, cachedRounds: BBB_ROUND });
    await drive(app);
    await settle();
    assert.equal(app.roundCalls().length, 1);
  }
});

test("a league change away from My Picks reads no round at all", async () => {
  // The revalidation belongs to the screen the reveal is on. Switching league
  // while looking at the League table asks for nothing on its behalf.
  const app = switching({ seasonDelay: 5, tab: "season", view: "league",
    cachedLeagues: BBB_SEASON, cachedRounds: BBB_ROUND });
  await app.pill("BBB");
  await settle();
  assert.deepEqual(app.roundCalls(), [], "a screen that is not showing asks for nothing");
});

test("both routes hydrate from cache and revalidate through the same two helpers", () => {
  for (const route of ["async function switchLeaguePill(code)", "function setActiveLeague(code, refresh = true)"]) {
    const fn = lift(route);
    assert.match(fn, /forgetRevealState\(\)/, route);
    assert.match(fn, /hydrateRevealState\(\)/, route);
    assert.match(fn, /revalidateRevealAfterSwitch\(/, route);
    // Cache first, network second — in that order, in the source.
    assert.ok(fn.indexOf("hydrateRevealState()") < fn.indexOf("revalidateRevealAfterSwitch("), route);
    assert.ok(fn.indexOf("forgetRevealState()") < fn.indexOf("hydrateRevealState()"), route);
  }
  // The cached adoption is the context rule's own answer, and costs nothing.
  const hydrate = lift("function hydrateRevealState()");
  assert.match(hydrate, /currentRoundReveal\(\)/);
  assert.match(hydrate, /lockHorizonOf/);
  for (const banned of ["await", "fetch", "api(", "ensurePicksRound"]) {
    assert.ok(!hydrate.includes(banned), `hydrating from cache must not ${banned}`);
  }
});

// --- cross-league privacy ---------------------------------------------------
//
// Two leagues can contain the very same fixture, so "has this payload got an
// entry for this fixture?" is not a safe question to draw from. The only safe
// one is "is this payload THIS league's CURRENT round?", asked at the moment of
// drawing rather than trusted from whenever it was fetched.

test("switching league drops the old league's picks before anything can paint", async () => {
  const app = await watching();
  assert.equal(app.state().code, "AAA");
  app.setLeague("BBB");
  assert.equal(app.state(), null, "AAA's reveal is not drawable for one frame");
});

test("a slow new league leaves the shell up, never the old league's matrix", async () => {
  const app = await watching({ delays: { BBB: 30 } });
  app.setLeague("BBB");
  const pending = app.enter();
  // Mid-flight: nothing at all is drawable, which is what the shell means.
  assert.equal(app.state(), null);
  await pending;
  assert.equal(app.state().code, "BBB");
  assert.ok(!app.panels().includes("AAA"), "AAA never reached a panel under BBB");
});

test("a stale answer for the league just left cannot repaint or be adopted", async () => {
  const app = loaders({ delays: { AAA: 30, BBB: 1 } });
  const slow = app.enter();          // AAA, in flight
  app.setLeague("BBB");
  await app.enter();                 // BBB lands first
  await slow;                        // AAA lands late
  assert.equal(app.state().code, "BBB", "the league on screen still wins");
  assert.ok(!app.panels().includes("AAA"));
});

test("a valid cache for the new league paints before its single revalidation", async () => {
  const app = loaders({
    delays: { BBB: 30 },
    cachedRounds: { "BBB:3": { code: "BBB", period: 3, table: [{ uid: "u1", nick: "BBB" }], reveal: [] } },
  });
  app.setLeague("BBB");
  const pending = app.enter();
  assert.equal(app.state()?.code, "BBB", "the cached matrix is up immediately");
  await pending;
  assert.equal(app.calls().length, 1, "and it still revalidates exactly once");
});

test("a cache belonging to another league is never adopted", async () => {
  const app = loaders({
    delays: { BBB: 30 },
    cachedRounds: { "AAA:3": { code: "AAA", period: 3, table: [{ uid: "u9", nick: "Adam" }], reveal: [] } },
  });
  app.setLeague("BBB");
  const pending = app.enter();
  assert.equal(app.state(), null, "AAA's cache is not BBB's to show");
  await pending;
  assert.equal(app.state().code, "BBB");
});

test("the context rule is one rule, asked wherever a pick could be drawn", () => {
  const rule = lift("function revealUsable(state)");
  assert.match(rule, /state\.code === activeLeague/);
  assert.match(rule, /String\(state\.period\) === String\(period\)/);
  // Every path that can put a name or a prediction on screen goes through it.
  for (const caller of ["function ensurePicksRound()",
                        "async function refreshRevealOnForeground()",
                        "function currentRoundReveal()"]) {
    assert.match(lift(caller), /revealUsable/, caller);
  }
  // The panel that used to draw the matrix is gone; the section that draws a
  // card is the last place a pick becomes markup, and it asks the same rule.
  assert.match(lift("function fixtureRevealSection(match)"), /currentRoundReveal\(\)/);
  assert.ok(!APP.includes('if (tab === "mates") {'), "the matrix panel survived");
  // And both routes that change the active league forget it on the way.
  for (const switcher of ["function setActiveLeague(code, refresh = true)",
                          "async function switchLeaguePill(code)"]) {
    assert.match(lift(switcher), /forgetRevealState\(\)/, switcher);
  }
});

test("the retained panels are filed under the week being browsed, and nothing else", () => {
  // The mates scope went with the segment; Weekly is the only tab whose
  // panel depends on a period at all.
  const key = lift("function panelKey(tab, code = activeLeague, period = selectedPeriod)");
  assert.match(key, /const scope = tab === "matchday" \? period : "-";/);
  assert.ok(!key.includes("mates"), "the removed segment still has a panel scope");
});

// --- period behaviour -------------------------------------------------------

test("the reveal reads the current round, never the week being browsed", () => {
  assert.match(liftLine("const revealPeriod ="), /leagueState\?\.currentPeriod/);
  const loader = lift("function ensurePicksRound()");
  assert.doesNotMatch(loader, /selectedPeriod/, "the Weekly selection is not consulted");
});

test("opening Mates' Picks leaves the Weekly selection exactly where it was", () => {
  // Returning to Weekly has to restore the week the viewer had browsed to, so
  // nothing on the Mates path may write selectedPeriod or roundState.
  const branch = APP.slice(APP.indexOf('if (wanted === "mates") {'));
  const body = branch.slice(0, branch.indexOf("if (!needsRound) return;"));
  assert.doesNotMatch(body, /selectedPeriod =/);
  assert.doesNotMatch(body, /roundState =/);
  const loader = lift("function ensurePicksRound()");
  assert.doesNotMatch(loader, /roundState =/, "and the Weekly state is never overwritten");
  assert.match(loader, /revealState =/, "Mates' Picks keeps its own");
});
