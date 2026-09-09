// Adam's build-25 ruling 2: once the week is published, My Picks shows the
// share control — whether or not this device has ever opened League.
//
// The screen must not wait for the table to do it. So these tests count
// requests exactly, check what is painted before anything resolves, and prove
// that a response for a league or a week the viewer has left cannot enable the
// control or draw a card.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { load, APP, sourceOf } from "./harness.mjs";

const SLATE = (period, ids) => ({ period, matchweek: Number(period), status: "published",
  fixtureIds: ids, count: ids.length });
const TABLE = [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1 }];
const round = (code, period, over = {}) => ({ code, period, matchday: Number(period),
  complete: false, slate: SLATE(period, ["f1"]), reveal: [], table: TABLE, ...over });

/**
 * My Picks' data layer, with the network under the test's control: every read
 * is counted, and each one is resolved or rejected when the test says so.
 */
function picksBox(over = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`);
  const { document } = dom.window;
  const reads = [];
  const box = load(["ensurePicksRound", "picksRoundUsable", "forgetPicksRound", "picksPeriod",
    "picksRoundKey", "shareRound", "sharePeriod", "revealUsable", "revealPeriod", "lockHorizonOf",
    "shareSurface", "shareCardState", "shareIconButton", "syncShareLabel", "normaliseView",
    "LEGACY_VIEWS", "weeklySharePublished", "weeklyShareStatus", "weeklyTerminalCount",
    "seasonShareFreshness", "matchweekLeagueState", "matchweekSlate", "cacheRoundState",
    "cachedRoundState", "roundCacheKey", "roundStatePath", "finalScore", "isVoidFixture", "isPostponed",
    "VOID_STATUSES", "noteMatchweekCountMismatch", "matchweekMismatchLines"], {
    document,
    API: "https://api.test",
    // Mutable module state: the sandbox owns it, the lifted functions use it.
    navGeneration: 0,
    render: () => {},
    revealState: null,
    revealLockHorizon: Infinity,
    picksRound: null,
    picksRoundFlights: new Map(),
    currentView: "picks",
    leagueTab: "matchday",
    activeLeague: "AAA",
    leagueCodes: ["AAA", "BBB"],
    leagueStates: {},
    roundStates: {},
    roundState: null,
    fixtures: [],
    selectedPeriod: null,
    matchweekCountMismatches: new Map(),
    currentPeriodKey: () => "7",
    periodLabel: (p) => `Matchweek ${p}`,
    seasonRounds: () => 38,
    leagueSupportsRounds: () => true,
    currentRoundReveal: () => null,
    uid: () => "u1",
    localStorage: { setItem: () => {}, getItem: () => null },
    STORAGE: { roundStates: "r" },
    leagueState: { code: "AAA", name: "Sunday Six", currentPeriod: "7",
      currentSlate: SLATE("7", ["f1"]) },
    fetchState: (path) => new Promise((resolve, reject) => {
      reads.push({ path, resolve, reject });
    }),
    ...over,
  });
  return {
    box, document, reads,
    reads_for: (code) => reads.filter((r) => r.path.includes(`code=${code}`)).length,
    mount: () => { document.getElementById("app").innerHTML =
      `<div class="pick-share">${box.shareIconButton({ code: "AAA" }, "weekly")}</div>`; },
    control: () => document.querySelector("[data-export-league-table]"),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// --- cached: no read at all ------------------------------------------------

test("P1 · a valid cached table paints at once, and is revalidated exactly once", () => {
  const app = picksBox({ roundStates: { "AAA:7": round("AAA", "7") } });
  app.box.ensurePicksRound();
  // The cache is on screen immediately — the control is enabled before any
  // answer comes back, so nothing waits on the network to look right.
  const share = app.box.shareCardState("weekly");
  assert.equal(share.ready, true, "a cached table did not enable the control");
  assert.match(share.label, /^Share Matchweek 7 standings$/);
  // And it is revalidated anyway. A round cached BEFORE kick-off is valid,
  // in-context and complete, and contains no mates' picks at all.
  assert.equal(app.reads.length, 1, "the cache was trusted and never rechecked");
});

test("P1 · the round this device already holds counts as the cache", () => {
  const app = picksBox({ currentRoundReveal: () => round("AAA", "7") });
  app.box.ensurePicksRound();
  assert.equal(app.box.shareCardState("weekly").ready, true, "the held round did not paint");
  assert.equal(app.reads.length, 1, "one revalidation, whatever is in hand");
});

// --- cold: exactly one read, and the shell paints first --------------------

test("P2 · a cold entry paints the control before the read resolves", () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  app.mount();
  const control = app.control();
  assert.ok(control, "the control was not painted while the table loaded");
  assert.equal(control.disabled, true, "a control that cannot act was left enabled");
  assert.equal(control.getAttribute("aria-disabled"), "true");
  assert.equal(control.getAttribute("aria-busy"), "true");
  assert.match(control.getAttribute("aria-label"), /Matchweek 7 standings are still loading/);
  // Icon only, even while loading.
  assert.ok(!/>[A-Za-z]/.test(control.innerHTML.replace(/<svg[\s\S]*<\/svg>/, "")));
});

test("P2 · a cold entry makes exactly one read", () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, `${app.reads.length} reads on entry`);
  assert.match(app.reads[0].path, /code=AAA/);
  assert.match(app.reads[0].path, /period=7/);
});

test("P2 · the control enables atomically when the table lands", async () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  app.mount();
  assert.equal(app.control().disabled, true);
  app.reads[0].resolve(round("AAA", "7"));
  await settle();
  const control = app.control();
  assert.equal(control.disabled, false, "the control did not enable");
  assert.equal(control.getAttribute("aria-disabled"), null, "it still reads as disabled");
  assert.equal(control.getAttribute("aria-busy"), null, "it still reads as busy");
  assert.equal(control.getAttribute("aria-label"), "Share Matchweek 7 standings");
  assert.equal(app.box.shareCardState("weekly").ready, true);
});

// --- delayed and repeated: one flight, joined ------------------------------

test("P3 · a second entry joins the read already running", async () => {
  const app = picksBox();
  const first = app.box.ensurePicksRound();
  const second = app.box.ensurePicksRound();
  const third = app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, `${app.reads.length} reads for three entries`);
  assert.equal(second, first, "a second entry started its own read");
  assert.equal(third, first);
  app.reads[0].resolve(round("AAA", "7"));
  await settle();
  // Once it has landed the flight is cleared, so a later entry is a new
  // entry: it paints what it holds and revalidates once, like any other.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 2, "a later entry did not revalidate");
});

test("P3 · while it is in flight the control stays honest, not hidden", () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  const share = app.box.shareCardState("weekly");
  assert.equal(share.ready, false);
  assert.equal(share.loading, true, "the control was hidden instead of shown loading");
  assert.ok(!share.hidden);
  assert.notEqual(app.box.shareIconButton({ code: "AAA" }, "weekly"), "");
});

// --- failed: honest, and retryable ----------------------------------------

test("P4 · a failed read leaves the control visible and disabled, not enabled", async () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  app.mount();
  app.reads[0].reject(new Error("offline"));
  await settle();
  const control = app.control();
  assert.ok(control, "the control vanished on failure");
  assert.equal(control.disabled, true, "a failed read enabled the control");
  assert.equal(control.getAttribute("aria-busy"), "true");
  assert.equal(app.box.shareCardState("weekly").ready, false);
  // The flight is released, so a later entry may try once more — but only once.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 2);
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 2, "a retry was duplicated");
});

// --- rapid switching: no bleed, no duplicates ------------------------------

test("P5 · switching league drops the old table at once and asks for the new one", async () => {
  const app = picksBox({ roundStates: { "AAA:7": round("AAA", "7") } });
  app.box.ensurePicksRound();
  assert.equal(app.box.shareCardState("weekly").ready, true);
  // The pill moves. Nothing of AAA's may survive into BBB's screen.
  app.box.evalIn(`
    activeLeague = "BBB";
    leagueState = { code: "BBB", name: "Bury", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f9"], count: 1 } };
    forgetPicksRound();
  `);
  assert.equal(app.box.shareCardState("weekly").ready, false, "AAA's table enabled BBB's control");
  assert.equal(app.box.shareRound("weekly"), null, "AAA's table answered for BBB");
  const aaaBefore = app.reads_for("AAA");
  app.box.ensurePicksRound();
  assert.equal(app.reads_for("BBB"), 1);
  assert.equal(app.reads_for("AAA"), aaaBefore, "the league we left was read again");
});

test("P5 · rapid switching makes one read per league, never two for one", () => {
  const app = picksBox();
  app.box.ensurePicksRound();                       // AAA
  app.box.evalIn(`activeLeague = "BBB";
    leagueState = { code: "BBB", name: "Bury", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f9"], count: 1 } };
    forgetPicksRound();`);
  app.box.ensurePicksRound();                       // BBB
  app.box.ensurePicksRound();                       // joins BBB's
  app.box.evalIn(`activeLeague = "AAA";
    leagueState = { code: "AAA", name: "Sunday Six", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f1"], count: 1 } };
    forgetPicksRound();`);
  app.box.ensurePicksRound();                       // AAA again, its flight was dropped
  assert.equal(app.reads_for("BBB"), 1, `${app.reads_for("BBB")} reads for BBB`);
  assert.equal(app.reads_for("AAA"), 2, "returning to a league did not re-ask after invalidation");
  assert.equal(app.reads.length, 3);
});

// --- stale responses -------------------------------------------------------

test("P6 · a response for the league we have left cannot enable the control", async () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  app.mount();
  app.box.evalIn(`
    activeLeague = "BBB";
    leagueState = { code: "BBB", name: "Bury", currentPeriod: "7",
      currentSlate: { period: "7", matchweek: 7, status: "published", fixtureIds: ["f9"], count: 1 } };
    forgetPicksRound();
  `);
  app.reads[0].resolve(round("AAA", "7"));          // AAA's answer, arriving late
  await settle();
  assert.equal(app.box.shareCardState("weekly").ready, false, "another league's table enabled the control");
  assert.equal(app.box.shareRound("weekly"), null, "another league's table was adopted");
  assert.equal(app.control().disabled, true);
});

test("P6 · a response for another week cannot enable the control", async () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  app.reads[0].resolve(round("AAA", "6"));          // last week's answer
  await settle();
  assert.equal(app.box.shareRound("weekly"), null, "last week's table answered for this week");
  assert.equal(app.box.shareCardState("weekly").ready, false);
});

test("P6 · the guard is the same rule the mates matrix uses", () => {
  const app = picksBox();
  const usable = app.box.picksRoundUsable;
  assert.equal(usable(round("AAA", "7"), "AAA", "7")?.code, "AAA");
  assert.equal(usable(round("BBB", "7"), "AAA", "7"), null, "another league passed");
  assert.equal(usable(round("AAA", "6"), "AAA", "7"), null, "another week passed");
  assert.equal(usable({ ...round("AAA", "7"), table: [] }, "AAA", "7"), null, "an empty table passed");
  assert.equal(usable({ error: "boom" }, "AAA", "7"), null, "an error passed");
  assert.equal(usable(null, "AAA", "7"), null);
});

// --- before publication ----------------------------------------------------

test("P7 · before the host publishes there is no control and no read", () => {
  const app = picksBox({ leagueState: { code: "AAA", name: "Sunday Six", currentPeriod: "7",
    currentSlate: null } });
  const share = app.box.shareCardState("weekly");
  assert.ok(!share.ready && !share.loading, "an unpublished week offered a weekly export");
  assert.equal(app.box.shareIconButton({ code: "AAA" }, "weekly"), "");
  // Nothing to load a table for, so nothing is asked.
  app.box.ensurePicksRound();
  assert.equal(app.reads.length, 1, "the read is for the league's own current week");
  // ...and even with the table in hand, an unpublished slate cannot share.
  app.reads[0].resolve(round("AAA", "7", { slate: null }));
  assert.equal(app.box.shareCardState("weekly").ready, false);
});

// --- the wiring ------------------------------------------------------------

test("P8 · the paint never waits for the table", () => {
  const nav = sourceOf("navigateToView");
  const picks = nav.slice(nav.indexOf('if (currentView === "picks")'));
  assert.match(picks, /\n    ensurePicksRound\(\);/, "the read is not started on entry");
  assert.ok(!/await ensurePicksRound/.test(picks), "the paint waits for the table");
  // And it is not the fixture list's business either.
  assert.ok(!sourceOf("picksView", "pickActionSummary", "pickCounts").includes("ensurePicksRound"));
});

test("P8 · a league change invalidates My Picks' table immediately", () => {
  assert.match(sourceOf("forgetRevealState"), /forgetPicksRound\(\);/);
  assert.match(sourceOf("forgetPicksRound"), /picksRound = null;/);
  assert.match(sourceOf("forgetPicksRound"), /picksRoundFlights\.clear\(\);/);
});

test("P8 · expanding a disclosure still asks for nothing", () => {
  for (const fn of ["expandPick", "pickRowBody", "fixtureRevealSection"]) {
    const src = sourceOf(fn);
    for (const banned of ["ensurePicksRound", "fetchState", "api(", "fetch("]) {
      assert.ok(!src.includes(banned), `${fn} reaches ${banned}`);
    }
  }
});

test("P8 · the loading control cannot be talked into drawing a card", () => {
  const app = picksBox();
  app.box.ensurePicksRound();
  // shareCardNow refuses on the same state the control reads.
  assert.match(sourceOf("shareCardNow"), /if \(!state \|\| state\.error \|\| !shareCardState\(surface\)\.ready\) return;/);
  assert.equal(app.box.shareCardState("weekly").ready, false);
});
