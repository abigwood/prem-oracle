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
    let matesState = null, matesRequest = 0, matesLockHorizon = horizonIn === null ? Infinity : horizonIn;
    let navGeneration = 0, currentView = "league", leagueTab = "mates";
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
    const showResultsPanel = async () => { panels.push(matesState && matesState.code); };
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
    ${liftLine("const matesPeriod =")}
    ${lift("function lockHorizonOf(state)")}
    ${lift("function cacheRoundState(code, period, state)")}
    ${lift("function cachedRoundState(code, period)")}
    ${liftLine("const roundCacheKey =")}
    ${liftLine("const stampFor =")}
    ${liftLine("const bumpStamp =")}
    ${lift("function dropRetainedPanels(code = null)")}
    ${lift("async function loadMatesState(generation = navGeneration)")}
    ${lift("async function refreshMatesOnForeground()")}

    return {
      enter: () => loadMatesState(),
      foreground: () => refreshMatesOnForeground(),
      setLeague: (code) => { activeLeague = code; leagueState = { code, currentPeriod: 3 }; matesState = null; },
      setHidden: (value) => { document.hidden = value; },
      setTab: (tab) => { leagueTab = tab; },
      setHorizon: (value) => { matesLockHorizon = value; },
      horizon: () => matesLockHorizon,
      state: () => matesState,
      panels: () => panels,
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

test("the segment branch asks once and no more", () => {
  const branch = APP.slice(APP.indexOf('if (wanted === "mates") {'));
  const body = branch.slice(0, branch.indexOf("if (!needsRound) return;"));
  assert.equal((body.match(/loadMatesState\(\)/g) || []).length, 1, "one revalidation, not two");
  assert.doesNotMatch(body, /setInterval|setTimeout/, "and nothing that would keep asking");
});

test("nothing anywhere polls for picks", () => {
  const mates = APP.slice(APP.indexOf("async function loadMatesState"), APP.indexOf("async function loadKnownLeagueNames"));
  assert.doesNotMatch(mates, /setInterval/, "no polling loop");
  assert.doesNotMatch(APP, /setInterval\([^)]*[Mm]ates/, "and nothing schedules one elsewhere");
});

// --- returning to the foreground -------------------------------------------

test("a return that crossed a kick-off revalidates exactly once", async () => {
  const app = loaders({ horizon: Date.now() - 1000 });
  await app.foreground();
  assert.equal(app.calls().length, 1);
  // The horizon is consumed, so coming back again asks for nothing more.
  await app.foreground();
  assert.equal(app.calls().length, 1, "one crossing, one request");
});

test("a return that crossed nothing asks for nothing", async () => {
  const app = loaders({ horizon: Date.now() + HOUR });
  await app.foreground();
  assert.equal(app.calls().length, 0);
});

test("a return to any other screen asks for nothing", async () => {
  for (const setup of [(app) => app.setTab("season"), (app) => app.setHidden(true)]) {
    const app = loaders({ horizon: Date.now() - 1000 });
    setup(app);
    await app.foreground();
    assert.equal(app.calls().length, 0);
  }
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

test("the matrix is filed under the round it shows, not the week being browsed", () => {
  const key = lift("function panelKey(tab, code = activeLeague, period = selectedPeriod)");
  assert.match(key, /tab === "mates" \? `m\$\{matesPeriod\(\)\}`/);
});

// --- period behaviour -------------------------------------------------------

test("Mates' Picks reads the current round, never the week being browsed", () => {
  assert.match(liftLine("const matesPeriod ="), /leagueState\?\.currentPeriod/);
  const loader = lift("async function loadMatesState(generation = navGeneration)");
  assert.doesNotMatch(loader, /selectedPeriod/, "the Weekly selection is not consulted");
});

test("opening Mates' Picks leaves the Weekly selection exactly where it was", () => {
  // Returning to Weekly has to restore the week the viewer had browsed to, so
  // nothing on the Mates path may write selectedPeriod or roundState.
  const branch = APP.slice(APP.indexOf('if (wanted === "mates") {'));
  const body = branch.slice(0, branch.indexOf("if (!needsRound) return;"));
  assert.doesNotMatch(body, /selectedPeriod =/);
  assert.doesNotMatch(body, /roundState =/);
  const loader = lift("async function loadMatesState(generation = navGeneration)");
  assert.doesNotMatch(loader, /roundState =/, "and the Weekly state is never overwritten");
  assert.match(loader, /matesState =/, "Mates' Picks keeps its own");
});
