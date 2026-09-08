// The two share cards: what they say, when they may be shared, and what it
// costs to make one.
//
// A card is only worth sharing if it agrees with the panel it was made from —
// same players, same points, same medals, same ties — so these run the real
// builders from app.js against a canvas that records every call instead of
// painting, and read the result back as text.
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

/**
 * A const declaration, verbatim, to the next blank line — which for the run of
 * card metrics means the whole run of them, since they are written as one.
 */
function liftConst(name) {
  const start = APP.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`not found in app.js: ${name}`);
  return APP.slice(start, APP.indexOf("\n\n", start));
}

/** Everything drawn, in order: text, filled boxes, and the fonts used. */
function recorder() {
  const calls = { text: [], fills: [], strokes: [], fonts: [] };
  const ctx = {
    // v1.7 Slice C: the card is drawn in 1080-wide DESIGN units and fitted
    // into a square canvas. Recording the transform lets a bounds check ask
    // the only question that matters: where the text lands on the graphic.
    setTransform(a, b, c, d, e, f) { calls.transform = { a, b, c, d, e, f }; },
    set font(value) { calls.fonts.push(value); this._font = value; },
    get font() { return this._font; },
    fillStyle: "", strokeStyle: "", lineWidth: 0, textAlign: "left", textBaseline: "",
    fillText(text, x, y) { calls.text.push({ text: String(text), x, y, fill: this.fillStyle, font: this._font }); },
    // Every name is measured before it is drawn; 14px a character is close
    // enough to make the fitting code take its shrinking branches for real.
    measureText(text) { return { width: String(text).length * 14 }; },
    fillRect(x, y, w, h) { calls.fills.push({ x, y, w, h, fill: this.fillStyle }); },
    fill() { calls.fills.push({ path: true, fill: this.fillStyle }); },
    stroke() { calls.strokes.push({ stroke: this.strokeStyle, width: this.lineWidth }); },
    beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
  };
  return { ctx, calls };
}

/**
 * app.js's card builders, over a stub document. `requests` counts every way the
 * app can reach the network, so a card that quietly fetched anything would show
 * up as a number instead of a picture.
 */
function cards({ native = false } = {}) {
  const build = new Function("recorderFactory", "stateIn", "roundIn", "tabIn", `
    "use strict";
    let requests = 0;
    let drawn = null;
    const canvases = [];
    const recorded = [];
    const fetch = () => { requests += 1; return Promise.reject(new Error("no fetch from a share card")); };
    const api = () => { requests += 1; return Promise.reject(new Error("no api call from a share card")); };
    const fetchState = api;
    const loadRoundState = api;
    const loadLeagueState = api;

    const document = {
      createElement: (tag) => {
        if (tag !== "canvas") return { href: "", download: "", click() {} };
        const made = recorderFactory();
        recorded.push(made.calls);
        const canvas = {
          width: 0, height: 0,
          getContext: () => made.ctx,
          toDataURL: () => "data:image/png;base64,UFJFTQ==",
        };
        canvases.push(canvas);
        return canvas;
      },
    };

    let leagueState = stateIn;
    let roundState = roundIn;
    let leagueTab = tabIn;
    let selectedPeriod = roundIn ? roundIn.period : null;
    let fixtures = [];
    const isNativeApp = () => ${native ? "true" : "false"};
    const WEB_BASE = "https://abigwood.github.io/prem-oracle/";
    const location = { origin: "https://abigwood.github.io", pathname: "/prem-oracle/" };
    const DEFAULT_COMPETITION = "PL";
    const COMPETITIONS = { PL: { name: "Premier League", short: "PL", rounds: 38 }, ELC: { name: "Championship", short: "ELC", rounds: 46 } };
    const competitionMeta = (code) => COMPETITIONS[code] || COMPETITIONS.PL;
    const seasonRounds = () => 38;
    const currentPeriodKey = () => "3";
    const isWindowKey = (key) => /^w\\d{4}-\\d{2}-\\d{2}$/.test(String(key || ""));
    const windowLabel = (key) => "window " + key;
    const weekNumberFor = () => 2;
    const periodLabel = (period) => (isWindowKey(period) ? "Week 2" : "Matchweek " + period);
    const PLACE_EMOJI = { gold: "🏆", silver: "🥈", bronze: "🥉" };
    const PLACE_NUMBER = { gold: "1", silver: "2", bronze: "3" };

    ${liftConst("CARD_W")}
    ${liftConst("CARD_COL")}
    ${liftConst("cardFont")}
    ${liftConst("cardDate")}
    ${liftConst("sentenceCase")}
    ${lift("function roundedRect(ctx, x, y, width, height, radius)")}
    ${lift("function fitText(ctx, text, maxWidth, fontFactory, maxSize, minSize)")}
    ${lift("function ellipsise(ctx, text, maxWidth)")}
    ${lift("function drawFitted(ctx, text, x, y, maxWidth,")}
    ${liftConst("CARD_W_PX")}
    ${lift("function cardRowMetrics(rows, { chrome, base, min = CARD_MIN_ROW })")}
    ${lift("function weeklyCardGeometry(rows)")}
    ${lift("function cardTableTop(after, tableHeight)")}
    ${lift("function cardCanvas(contentHeight)")}
    ${lift("function drawCardHeader(ctx, league, line, page = \"\")")}
    ${lift("function drawCardHero(ctx, y, model, height = CARD_HERO_H)")}
    ${lift("function drawCardTableHead(ctx, y)")}
    ${lift("function drawWeeklyRowBand(ctx, y, height, place)")}
    ${lift("function drawCardRowRule(ctx, y)")}
    ${lift("function drawCardRowPlate(ctx, y, height, index, place)")}
    ${lift("function cardHonoursWidth(ctx, counts, size)")}
    ${lift("function cardHonoursFit(ctx, cols, counts, m)")}
    ${lift("function drawCardHonours(ctx, x, y, counts, { size = 24 } = {})")}
    ${lift("function drawCardFooter(ctx, y, model)")}
    ${lift("function sharedRankByUid(table)")}
    ${liftConst("weeklyRanks")}
    // The harness already stubs seasonRounds/periodLabel above.
    const fixtureById = () => null;
    const weeklyFinalMismatches = new Map();
    const noteWeeklyFinalMismatch = () => {};
    ${lift("function weeklySharePublished(round, period)")}
    // v1.7 Slice C: the card models and the control now state how far through
    // the week they are, so the harness lifts that contract too.
    ${lift("function weeklyTerminalCount(round)")}
    ${lift("function weeklyShareStatus(round)")}
    ${lift("function seasonShareFreshness(state)")}
    ${lift("function weeklyCardModel(state, round)")}
    ${liftConst("cardPageRows")}
    ${liftConst("cardPageLabel")}
    ${lift("function weeklyCardPages(state, round)")}
    ${lift("function drawWeeklyPage(model, hero, m, page)")}
    ${lift("function drawWeeklyResultCard(state, round)")}
    ${lift("function seasonCardModel(state)")}
    ${lift("function seasonCardPages(state)")}
    ${lift("function drawSeasonPage(model, m, page)")}
    ${lift("function drawSeasonTableCard(state)")}
    ${lift("function seasonProgressLine(state)")}
    ${lift("function podiumCounts(row)")}
    ${lift("function winnerNames(round)")}
    ${lift("function leagueCompetitionNames(state)")}
    ${lift("function inviteLinkFor(code)")}
    ${lift("function weeklyCardCaption(state, round)")}
    ${lift("function leagueTableShareText(state)")}
    ${lift("function leagueSupportsRounds(state)")}
    ${lift("function weeklyCardReady()")}
    let currentView = "league";
    const normaliseView = (view) => (view === "schedule" ? "picks" : view);
    ${lift("function shareSurface()")}
    ${lift("function shareRound(surface = shareSurface())")}
    ${lift("function sharePeriod(surface = shareSurface())")}
    ${lift("function shareCardState(surface = shareSurface())")}

    return {
      weeklyModel: () => weeklyCardModel(leagueState, roundState),
      seasonModel: () => seasonCardModel(leagueState),
      drawWeekly: () => drawWeeklyResultCard(leagueState, roundState)[0],
      drawWeeklyPages: () => drawWeeklyResultCard(leagueState, roundState),
      drawSeason: () => drawSeasonTableCard(leagueState)[0],
      drawSeasonPages: () => drawSeasonTableCard(leagueState),
      shareState: () => shareCardState(),
      ready: () => weeklyCardReady(),
      captions: () => ({ weekly: roundState ? weeklyCardCaption(leagueState, roundState) : null, season: leagueTableShareText(leagueState) }),
      recorded: () => recorded,
      canvases: () => canvases,
      requests: () => requests,
    };
  `);
  return build;
}

const LEAGUE = {
  code: "ABC234",
  name: "Sunday Six",
  owner: "u1",
  currentMatchday: 4,
  currentMatchdayHasResults: false,
  competitions: ["PL"],
  table: [
    { uid: "u1", rank: 1, nick: "Adam", pts: 61, exact: 5, wins: 2, podiums: { gold: 2, silver: 1, bronze: 0 } },
    { uid: "u2", rank: 2, nick: "Bex", pts: 58, exact: 4, wins: 1, podiums: { gold: 1, silver: 0, bronze: 2 } },
    { uid: "u3", rank: 3, nick: "Cal", pts: 44, exact: 2, wins: 0, podiums: { gold: 0, silver: 2, bronze: 1 } },
  ],
};

/** The same week still running: published, part-terminal, not complete. */
const RUNNING_WEEK = () => ({
  ...SETTLED_WEEK,
  complete: false,
  status: "in-progress",
  winners: [],
  podium: [],
  slate: { period: "3", fixtureIds: ["m1", "m2", "m3", "m4", "m5", "m6"], count: 6 },
  reveal: [
    { id: "m1", settled: true }, { id: "m2", settled: true },
    { id: "m3", voided: true },
    { id: "m4" }, { id: "m5" }, { id: "m6" },
  ],
});

const SETTLED_WEEK = {
  period: "3",
  matchday: 3,
  complete: true,
  // Final needs the slots as well as the flag now that it fails closed.
  slate: { period: "3", fixtureIds: ["m1", "m2", "m3", "m4", "m5", "m6"], count: 6 },
  reveal: [
    { id: "m1", settled: true }, { id: "m2", settled: true }, { id: "m3", settled: true },
    { id: "m4", settled: true }, { id: "m5", settled: true }, { id: "m6", settled: true },
  ],
  status: "complete",
  winners: ["u1"],
  podium: [
    { uid: "u1", nick: "Adam", pts: 23, place: "gold" },
    { uid: "u2", nick: "Bex", pts: 19, place: "silver" },
    { uid: "u3", nick: "Cal", pts: 14, place: "bronze" },
  ],
  table: [
    { uid: "u1", rank: 1, nick: "Adam", pts: 23, exact: 3 },
    { uid: "u2", rank: 2, nick: "Bex", pts: 19, exact: 2 },
    { uid: "u3", rank: 3, nick: "Cal", pts: 14, exact: 1 },
  ],
};

const build = (state, round, tab, options) =>
  cards(options)(recorder, state, round, tab);

const texts = (calls) => calls.text.map((entry) => entry.text);

// --- gating ----------------------------------------------------------------

test("an unsettled week SHARES, and says how far through it is", () => {
  // v1.7 Slice C / M9: available from publication onward. The card carries the
  // honest state instead of the control withholding itself.
  const app = build(LEAGUE, RUNNING_WEEK(), "matchday");
  const state = app.shareState();
  assert.equal(state.ready, true, "an in-progress week refused to share");
  assert.match(state.label, /Share Matchweek \d+ standings/);
  assert.ok(!/shares once/.test(state.label));
});

test("a settled week offers its result by name", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday");
  assert.deepEqual(app.shareState(), { ready: true, label: "Share Matchweek 3 standings" });
});

test("a week whose table has not arrived yet is not shareable", () => {
  const app = build(LEAGUE, null, "matchday");
  assert.equal(app.shareState().ready, false);
  // Named from the selected week rather than left as "Matchweek null".
  assert.doesNotMatch(app.shareState().label, /null|undefined/);
});

test("a settled week with an errored payload is not shareable", () => {
  const app = build(LEAGUE, { ...SETTLED_WEEK, error: "League not found" }, "matchday");
  assert.equal(app.ready(), false);
});

test("the season table shares whenever it has rows", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "season");
  assert.equal(app.shareState().ready, true);
  // The season control now names its own freshness (M9).
  assert.match(app.shareState().label, /^Share season table, Updated /);
  const empty = build({ ...LEAGUE, table: [] }, SETTLED_WEEK, "season");
  assert.equal(empty.shareState().ready, false);
});

// --- data parity -----------------------------------------------------------

test("the weekly card carries the panel's rows, points and exacts", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday");
  const model = app.weeklyModel();
  assert.deepEqual(model.rows.map((row) => [row.rank, row.nick, row.pts, row.exact]),
    SETTLED_WEEK.table.map((row) => [row.rank, row.nick, row.pts, row.exact]));
  app.drawWeekly();
  const drawn = texts(app.recorded()[0]);
  for (const row of SETTLED_WEEK.table) {
    assert.ok(drawn.includes(row.nick), `${row.nick} is missing from the card`);
    assert.ok(drawn.includes(String(row.pts)), `${row.pts} pts is missing from the card`);
  }
  assert.ok(drawn.includes("Sunday Six"), "the league is named");
  // M9 fixes the card's state wording: Week N · Final for a finished week.
  assert.ok(drawn.some((text) => text.includes("Week 3 · Final")), "the header states the week");
});

test("the weekly card leads with the winner and the rostrum", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday");
  const model = app.weeklyModel();
  assert.equal(model.heroName, "Adam");
  assert.equal(model.heroLine, "Matchweek 3 champion · 23 pts");
  assert.deepEqual(model.podium.map((group) => group.place), ["gold", "silver", "bronze"]);
  app.drawWeekly();
  const drawn = texts(app.recorded()[0]);
  assert.ok(drawn.includes("🏆 Adam"), "the winner is drawn in the hero");
  // Second, first and third all have a block, and the winner's is the tallest.
  assert.deepEqual(["1", "2", "3"].filter((number) => drawn.includes(number)).length, 3);
});

test("medals follow the podium, not the row order", () => {
  // A tie for first: two golds, no silver — the rule the banner already keeps.
  const tied = {
    ...SETTLED_WEEK,
    winners: ["u1", "u2"],
    podium: [
      { uid: "u1", nick: "Adam", pts: 23, place: "gold" },
      { uid: "u2", nick: "Bex", pts: 23, place: "gold" },
      { uid: "u3", nick: "Cal", pts: 14, place: "bronze" },
    ],
    table: [
      { uid: "u1", rank: 1, nick: "Adam", pts: 23, exact: 3 },
      { uid: "u2", rank: 1, nick: "Bex", pts: 23, exact: 3 },
      { uid: "u3", rank: 3, nick: "Cal", pts: 14, exact: 1 },
    ],
  };
  const app = build(LEAGUE, tied, "matchday");
  const model = app.weeklyModel();
  assert.deepEqual(model.rows.map((row) => row.place), ["gold", "gold", "bronze"]);
  assert.deepEqual(model.podium.map((group) => group.place), ["gold", "bronze"]);
  assert.equal(model.heroName, "Adam & Bex");
  assert.equal(model.heroEyebrow, "JOINT MATCHWEEK CHAMPIONS");
  app.drawWeekly();
  const calls = app.recorded()[0];
  // The right edge of the standings rows, where the row medals live — the
  // rostrum draws its own, and those are counted separately.
  const rowMedals = calls.text.filter((entry) => entry.x === 962).map((entry) => entry.text);
  assert.deepEqual(rowMedals, ["🏆", "🏆", "🥉"], "both winners are medalled, and nobody takes the place below the tie");
  assert.equal(texts(calls).filter((text) => text === "🥈").length, 0, "no silver is drawn anywhere");
});

test("a tied week names both champions in the hero, with no rostrum to stack", () => {
  const tied = {
    ...SETTLED_WEEK,
    winners: ["u1", "u2"],
    podium: [
      { uid: "u1", nick: "Adam", pts: 23, place: "gold" },
      { uid: "u2", nick: "Bex", pts: 23, place: "gold" },
    ],
  };
  const app = build(LEAGUE, tied, "matchday");
  const model = app.weeklyModel();
  assert.equal(model.heroEyebrow, "JOINT MATCHWEEK CHAMPIONS");
  app.drawWeekly();
  const drawn = app.recorded()[0].text.map((entry) => entry.text);
  // v1.7 readability ruling: the export carries no rostrum, so a shared place
  // is a joint hero and two gold rows — never a stack of names on a block.
  assert.ok(drawn.some((text) => text.includes("Adam")), "the champions are named");
  assert.equal(drawn.filter((text) => text === "23 pts").length, 0,
    "a rostrum points line was drawn");
  // Both gold rows still carry their medal in the table.
  assert.equal(drawn.filter((text) => text === "🏆").length, 2,
    "both joint champions are marked in the standings");
});

test("a weekly card from an old worker draws no podium it was never sent", () => {
  const old = { ...SETTLED_WEEK, podium: undefined };
  const app = build(LEAGUE, old, "matchday");
  const model = app.weeklyModel();
  assert.deepEqual(model.podium, []);
  assert.deepEqual(model.rows.map((row) => row.place), [null, null, null]);
  // The winner is still known, because `winners` predates the podium.
  assert.equal(model.heroName, "Adam");
  assert.equal(model.heroLine, "Matchweek 3 champion · 23 pts");
  app.drawWeekly();
  const drawn = texts(app.recorded()[0]);
  assert.equal(drawn.filter((text) => text === "🥈" || text === "🥉").length, 0);
  // v1.7 readability ruling: no export draws a rostrum at all, so a payload
  // with a podium and one without produce the same square, at the same fit.
  const full = build(LEAGUE, SETTLED_WEEK, "matchday");
  full.drawWeekly();
  const lean = app.canvases()[0];
  const whole = full.canvases()[0];
  // Adam's portrait ruling: fixed 1080x1920, never varied by anything.
  assert.equal(lean.width, 1080, "the export is not 1080 wide");
  assert.equal(lean.height, 1920, "the export is not 1920 tall");
  assert.equal(lean.height, whole.height, "two exports came out different sizes");
  assert.equal(app.recorded()[0].transform?.a ?? 1, full.recorded()[0].transform?.a ?? 1,
    "a podium in the payload still changed the drawing");
});

// --- what a card costs -----------------------------------------------------

test("drawing either card makes no request", () => {
  const weekly = build(LEAGUE, SETTLED_WEEK, "matchday");
  weekly.drawWeekly();
  weekly.captions();
  assert.equal(weekly.requests(), 0);
  const season = build(LEAGUE, null, "season");
  season.drawSeason();
  season.captions();
  assert.equal(season.requests(), 0);
});

test("a card grows with its table rather than dropping players", () => {
  const twelve = {
    ...LEAGUE,
    table: Array.from({ length: 12 }, (_, index) => ({
      uid: `u${index}`, rank: index + 1, nick: `Player ${index + 1}`, pts: 60 - index, exact: 3, wins: 0,
    })),
  };
  const app = build(twelve, null, "season");
  app.drawSeason();
  const drawn = texts(app.recorded()[0]);
  assert.ok(drawn.includes("Player 12"), "the last player is on the card");
  assert.equal(app.seasonModel().rows.length, 12);
});

// --- the caption that travels with it --------------------------------------

test("both captions carry a joinable link and the league code", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday");
  const { weekly, season } = app.captions();
  for (const caption of [weekly, season]) {
    assert.match(caption, /ABC234/);
    assert.match(caption, /https:\/\/abigwood\.github\.io\/prem-oracle\/\?league=ABC234/);
  }
  assert.match(weekly, /Premier League Matchweek 3: won by Adam/);
});

test("the native caption links to the public site, never to the shell's origin", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday", { native: true });
  assert.match(app.captions().weekly, /https:\/\/abigwood\.github\.io\/prem-oracle\/\?league=ABC234/);
  assert.doesNotMatch(app.captions().weekly, /premoracle:\/\//);
});

// --- the drawing itself ----------------------------------------------------

test("the card is 1080 wide and drawn on the dark brand", () => {
  const app = build(LEAGUE, SETTLED_WEEK, "matchday");
  app.drawWeekly();
  assert.equal(app.canvases()[0].width, 1080);
  const fills = app.recorded()[0].fills;
  assert.equal(fills[0].fill, "#180020", "the page is filled dark before anything is drawn on it");
  assert.ok(fills.some((fill) => fill.fill === "#38003C"), "the header band is the brand purple");
  assert.ok(fills.some((fill) => fill.fill === "#00FF87"), "the brand green rules it off");
});

test("nothing is drawn off the edge of either card", () => {
  const wide = {
    ...LEAGUE,
    table: Array.from({ length: 8 }, (_, index) => ({
      uid: `u${index}`, rank: index + 1, nick: `Player ${index + 1}`, pts: 60 - index, exact: 3,
      podiums: { gold: index, silver: 0, bronze: 1 },
    })),
  };
  for (const [round, tab, draw] of [[SETTLED_WEEK, "matchday", "drawWeekly"], [null, "season", "drawSeason"]]) {
    const app = build(wide, round, tab);
    app[draw]();
    const { width, height } = app.canvases()[0];
    assert.equal(width, 1080, "the export is not 1080 wide");
    assert.equal(height, 1920, "the export is not 1920 tall");
    const k = app.recorded()[0].transform?.a ?? 1;
    for (const entry of app.recorded()[0].text) {
      assert.ok(entry.y * k > 0 && entry.y * k <= height,
        `"${entry.text}" lands at y=${(entry.y * k).toFixed(0)} on a ${height}px card`);
      assert.ok(entry.x * k >= 0 && entry.x * k <= width,
        `"${entry.text}" lands at x=${(entry.x * k).toFixed(0)} on a ${width}px card`);
    }
    for (const fill of app.recorded()[0].fills) {
      if (fill.path) continue;
      assert.ok((fill.y + fill.h) * k <= height + 1, `a block runs past the bottom of the card`);
    }
  }
});

test("a long name is cut to its column instead of running over the points", () => {
  const long = {
    ...LEAGUE,
    table: [{ uid: "u1", rank: 1, nick: "Bartholomew Fotheringay-Smythe the Third", pts: 61, exact: 5, wins: 1 }],
  };
  const app = build(long, null, "season");
  app.drawSeason();
  const drawn = texts(app.recorded()[0]);
  assert.ok(drawn.some((text) => text.startsWith("Bartholomew")), "the name is drawn");
  assert.ok(!drawn.includes(long.table[0].nick), "and it was shortened to fit");
  assert.ok(drawn.some((text) => text.endsWith("…")));
});

// --- delivery --------------------------------------------------------------

/**
 * The share itself, over stubs that record where the PNG went. The canvas is
 * already proven above, so this one draws a token card and follows the file.
 */
function delivery({ native = false, canShareFiles = true, plugins = ["Filesystem", "Share"] } = {}) {
  const build = new Function("nativeIn", "canShareFilesIn", "pluginsIn", `
    "use strict";
    const log = [];
    const available = new Set(pluginsIn);
    const Filesystem = {
      writeFile: (options) => { log.push(["write", options.path, options.directory, options.data]); return Promise.resolve({ uri: "" }); },
      getUri: (options) => { log.push(["uri", options.path, options.directory]); return Promise.resolve({ uri: "file:///cache/" + options.path }); },
    };
    const Share = { share: (options) => { log.push(["capacitor-share", options]); return Promise.resolve({}); } };
    const window = { Capacitor: { Plugins: {} } };
    if (available.has("Filesystem")) window.Capacitor.Plugins.Filesystem = Filesystem;
    if (available.has("Share")) window.Capacitor.Plugins.Share = Share;

    const navigator = {
      canShare: (data) => canShareFilesIn && Array.isArray(data && data.files),
      share: (data) => { log.push(["web-share", data]); return Promise.resolve(); },
    };
    const URL = { createObjectURL: () => "blob:card", revokeObjectURL: () => {} };
    const setTimeout = () => {};
    const atob = (value) => Buffer.from(value, "base64").toString("binary");
    class File {
      constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; }
    }
    const document = {
      createElement: () => ({ href: "", download: "", set click(v) {}, click() { log.push(["download", this.download]); } }),
    };
    const isNativeApp = () => nativeIn;
    const shareNow = (options) => { log.push(["text-only", options]); };

    const canvas = { toDataURL: () => "data:image/png;base64,UFJFTQ==" };

    ${lift("function cardPng(canvas, filename)")}
    ${lift("function downloadCard(png)")}
    ${lift("async function shareCardNatively(pages, { title, text })")}
    ${lift("function shareCardFile(pages, { title, text })")}

    return {
      png: () => cardPng(canvas, "prem-oracle-matchweek.png"),
      send: () => shareCardFile([cardPng(canvas, "prem-oracle-matchweek.png")], { title: "Sunday Six", text: "join us" }),
      sendPages: (n) => shareCardFile(
        Array.from({ length: n }, (_, i) => cardPng(canvas, "prem-oracle-season-table-" + (i + 1) + "-of-" + n + ".png")),
        { title: "Sunday Six", text: "join us" }),
      log: () => log,
    };
  `);
  return build(native, canShareFiles, plugins);
}

test("the PNG is built without awaiting anything", () => {
  const png = delivery().png();
  assert.equal(png.filename, "prem-oracle-matchweek.png");
  assert.equal(png.base64, "UFJFTQ==");
  assert.equal(png.file.type, "image/png");
  assert.deepEqual([...png.file.parts[0]], [...Buffer.from("PREM")], "the bytes are the picture's own");
});

test("native writes the card to the cache and shares the file", async () => {
  const app = delivery({ native: true });
  app.send();
  await new Promise((resolve) => setImmediate(resolve));
  const log = app.log();
  assert.deepEqual(log[0], ["write", "prem-oracle-matchweek.png", "CACHE", "UFJFTQ=="]);
  assert.deepEqual(log[1], ["uri", "prem-oracle-matchweek.png", "CACHE"]);
  assert.equal(log[2][0], "capacitor-share");
  assert.deepEqual(log[2][1].files, ["file:///cache/prem-oracle-matchweek.png"]);
  assert.equal(log[2][1].text, "join us");
  assert.ok(!log.some((entry) => entry[0] === "web-share"), "the native shell never touches navigator.share");
});

test("a native build missing the filesystem still shares the words", async () => {
  const app = delivery({ native: true, plugins: ["Share"] });
  app.send();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.log().map((entry) => entry[0]), ["text-only"]);
});

test("the web shares the file itself when it can", () => {
  const app = delivery({ native: false });
  app.send();
  const [kind, data] = app.log()[0];
  assert.equal(kind, "web-share");
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].name, "prem-oracle-matchweek.png");
});

test("a browser with no file share downloads the card instead", () => {
  const app = delivery({ native: false, canShareFiles: false });
  app.send();
  assert.deepEqual(app.log(), [["download", "prem-oracle-matchweek.png"]]);
});

test("every footer says who made it and how to join", () => {
  for (const [state, round, tab, draw] of [[LEAGUE, SETTLED_WEEK, "matchday", "drawWeekly"], [LEAGUE, null, "season", "drawSeason"]]) {
    const app = build(state, round, tab);
    app[draw]();
    const drawn = texts(app.recorded()[0]);
    assert.ok(drawn.includes("PREM ORACLE"));
    assert.ok(drawn.includes(" · Score Predictor"));
    assert.ok(drawn.includes("Think you can call it?"));
    assert.ok(drawn.some((text) => text.includes("Join league ABC234") && text.includes("?league=ABC234")));
  }
});
