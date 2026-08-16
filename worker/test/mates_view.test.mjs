// Mates' Picks — the client half.
//
// The server decides what may be seen; this decides what is shown, in what
// order, and what it costs. Privacy is asserted twice over here: once on the
// view-model (level a) and once on the markup that reaches the document,
// accessible labels included (level b) — because "we don't render it" is not a
// privacy guarantee if the value is sitting in the page.
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

function liftConst(name) {
  const start = APP.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`not found in app.js: ${name}`);
  return APP.slice(start, APP.indexOf("\n\n", start));
}

const HOUR = 60 * 60 * 1000;
const VIEWER = "u1";

/** A round: `revealedCount` fixtures kicked off, the rest still to come. */
function roundState({ revealedCount = 1, total = 3, settled = 0, members = 3, period = "3" } = {}) {
  const nick = (index) => ["Adam", "Bex", "Cal", "Dee", "Eve", "Fin", "Gus", "Hal", "Ivy", "Jo"][index];
  const table = Array.from({ length: members }, (_, index) => ({
    uid: `u${index + 1}`, nick: nick(index), pts: 20 - index * 3, exact: 1, rank: index + 1,
  }));
  const reveal = Array.from({ length: total }, (_, index) => {
    const revealed = index < revealedCount;
    const isSettled = index < settled;
    const entry = {
      id: `f${index + 1}`,
      lockAt: new Date(Date.now() + (revealed ? -HOUR : HOUR * (index + 1))).toISOString(),
      revealed,
      eligible: members,
      lockedIn: members - 1,
    };
    if (!revealed) return entry;
    entry.settled = isSettled;
    entry.voided = false;
    entry.result = isSettled ? { p1: 2, p2: 1 } : null;
    entry.picks = table.map((row, seat) => (seat === members - 1
      ? { uid: row.uid, nick: row.nick, none: true, p1: null, p2: null, pts: isSettled ? 0 : null, exact: false, settled: isSettled }
      : { uid: row.uid, nick: row.nick, none: false, p1: seat, p2: 1, pts: isSettled ? (seat === 2 ? 5 : 1) : null, exact: isSettled && seat === 2, settled: isSettled }));
    return entry;
  });
  return { code: "AAA", period, table, reveal };
}

/** app.js's Mates' Picks builders over stubs. */
function view({ state = roundState(), ownPicks = {}, slate = null, viewer = VIEWER } = {}) {
  const build = new Function("stateIn", "ownPicksIn", "slateIn", "viewerIn", `
    "use strict";
    let requests = 0;
    const fetch = () => { requests += 1; return Promise.reject(new Error("no request from a view")); };
    const api = fetch;
    const fetchState = fetch;

    let matesState = stateIn;
    let leagueState = { code: "AAA", currentPeriod: stateIn ? stateIn.period : null, currentSlate: slateIn };
    let activeLeague = "AAA";
    const picks = ownPicksIn;
    const uid = () => viewerIn;
    const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
    const fixtureById = (id) => ({
      id, player1: "Home " + id, player2: "Away " + id,
      startAt: (stateIn && stateIn.reveal || []).find((e) => e.id === id)?.lockAt
        || new Date(Date.now() + 864e5).toISOString(),
    });

    ${liftConst("MATES_ROWS_SHOWN")}
    ${liftConst("MATES_STATE_LINE")}
    ${lift("function sharedRankByUid(table)")}
    ${lift("function revealRows(entry, table, viewerUid)")}
    ${lift("function matesFixtureView(fixture, entry, table, viewerUid)")}
    ${lift("function matesMatrix(state, viewerUid = uid())")}
    ${lift("function matesPickCell(row)")}
    ${lift("function matesPointsCell(row, card)")}
    ${lift("function matesRow(row, card)")}
    ${lift("function matesRowList(card)")}
    ${lift("function matesCardBody(card, viewerPicked)")}
    ${lift("function matesFixtureCard(card)")}
    ${lift("function matesHeader(matrix)")}
    ${lift("function slateForPeriod(period)")}
    ${lift("function fixtureRevealSection(match)")}
    ${lift("function lockHorizonOf(state)")}

    return {
      matrix: () => matesMatrix(matesState),
      html: () => matesMatrix(matesState).cards.map(matesFixtureCard).join(""),
      header: () => matesHeader(matesMatrix(matesState)),
      cardFor: (id) => matesMatrix(matesState).cards.find((card) => card.id === id),
      section: (id) => fixtureRevealSection(fixtureById(id)),
      horizon: () => lockHorizonOf(matesState),
      requests: () => requests,
    };
  `);
  return build(state, ownPicks, slate, viewer);
}

// --- privacy, level (a): the view-model ------------------------------------

test("an unrevealed fixture's view-model holds no prediction and no name", () => {
  const app = view({ state: roundState({ revealedCount: 0, total: 3 }) });
  const matrix = app.matrix();
  assert.equal(matrix.revealed, 0);
  for (const card of matrix.cards) {
    assert.equal(card.state, "locked");
    assert.deepEqual(card.rows, [], "no rows exist to be rendered");
  }
  const wire = JSON.stringify(matrix.cards.map(({ fixture, ...rest }) => rest));
  for (const nick of ["Adam", "Bex", "Cal"]) {
    assert.doesNotMatch(wire, new RegExp(nick), `${nick} must not be in the view-model`);
  }
});

// --- privacy, level (b): the document --------------------------------------

test("an unrevealed fixture renders no prediction anywhere in its markup", () => {
  const app = view({ state: roundState({ revealedCount: 0, total: 2 }) });
  const html = app.html();
  assert.match(html, /Mates' picks reveal at kick-off/);
  for (const nick of ["Adam", "Bex", "Cal"]) {
    assert.doesNotMatch(html, new RegExp(nick), `${nick} must not reach the document`);
  }
  // No scoreline anywhere: not as text, not in a title, not in an aria-label.
  assert.doesNotMatch(html, /\d-\d/, "no scoreline in the markup");
  for (const attribute of html.match(/(aria-label|title|alt)="[^"]*"/g) || []) {
    assert.doesNotMatch(attribute, /\d-\d/, `an accessible label leaked a pick: ${attribute}`);
  }
});

test("the locked card still says how many are in, without saying what", () => {
  const app = view({ state: roundState({ revealedCount: 0, total: 1 }) });
  assert.match(app.html(), /2 of 3 locked in/);
});

test("a mixed week reveals only the fixtures that kicked off", () => {
  const app = view({ state: roundState({ revealedCount: 1, total: 3 }) });
  const [first, second, third] = app.matrix().cards;
  assert.equal(first.state, "revealed");
  assert.ok(first.rows.length);
  for (const card of [second, third]) {
    assert.equal(card.state, "locked");
    assert.deepEqual(card.rows, []);
  }
  // Saturday cannot spoil Sunday, in the document as well as the payload.
  const html = view({ state: roundState({ revealedCount: 1, total: 3 }) }).html();
  const sundayCard = html.slice(html.indexOf('data-mates-fixture="f2"'));
  assert.doesNotMatch(sundayCard.slice(0, sundayCard.indexOf("</article>")), /\d-\d/);
});

// --- the header counter ----------------------------------------------------

test("the header counts revealed fixtures out of the round", () => {
  assert.match(view({ state: roundState({ revealedCount: 3, total: 10 }) }).header(), /3 of 10 fixtures revealed/);
  assert.match(view({ state: roundState({ revealedCount: 1, total: 1 }) }).header(), /1 of 1 fixture revealed/);
});

// --- ordering --------------------------------------------------------------

test("you are pinned to the top and marked as you", () => {
  const app = view({ state: roundState({ revealedCount: 1, members: 4 }), viewer: "u3" });
  const rows = app.cardFor("f1").rows;
  assert.equal(rows[0].uid, "u3");
  assert.equal(rows[0].you, true);
  assert.match(app.html(), /class="mates-row is-you"/);
});

test("everyone else follows the week's rank order", () => {
  const app = view({ state: roundState({ revealedCount: 1, members: 4 }), viewer: "u4" });
  // u4 has no pick, so is pinned top as the viewer regardless; the rest rank.
  assert.deepEqual(app.cardFor("f1").rows.map((row) => row.uid), ["u4", "u1", "u2", "u3"]);
});

test("a tie shares its rank and sorts alphabetically inside it", () => {
  const state = roundState({ revealedCount: 1, members: 3 });
  // Bex and Cal level on points; Adam clear at the top.
  state.table = [
    { uid: "u1", nick: "Adam", pts: 20 },
    { uid: "u2", nick: "Cal", pts: 12 },
    { uid: "u3", nick: "Bex", pts: 12 },
  ];
  state.reveal[0].picks = [
    { uid: "u2", nick: "Cal", p1: 1, p2: 0, none: false },
    { uid: "u3", nick: "Bex", p1: 2, p2: 0, none: false },
    { uid: "u1", nick: "Adam", p1: 0, p2: 0, none: false },
  ];
  const rows = view({ state, viewer: "nobody" }).cardFor("f1").rows;
  assert.deepEqual(rows.map((row) => row.nick), ["Adam", "Bex", "Cal"]);
  assert.deepEqual(rows.map((row) => row.rank), [1, 2, 2], "the tied pair share second");
});

test("no pick sinks to the bottom however well its owner is doing", () => {
  const state = roundState({ revealedCount: 1, members: 3 });
  // The league leader is the one who forgot.
  state.reveal[0].picks = [
    { uid: "u1", nick: "Adam", none: true, p1: null, p2: null },
    { uid: "u2", nick: "Bex", none: false, p1: 1, p2: 1 },
    { uid: "u3", nick: "Cal", none: false, p1: 2, p2: 0 },
  ];
  const app = view({ state, viewer: "nobody" });
  assert.deepEqual(app.cardFor("f1").rows.map((row) => row.nick), ["Bex", "Cal", "Adam"]);
  const html = app.html();
  assert.match(html, /class="mates-row is-none"/);
  assert.match(html, /No pick/);
});

// --- settlement ------------------------------------------------------------

test("a settled fixture shows the score and points, exact ones marked", () => {
  const app = view({ state: roundState({ revealedCount: 1, settled: 1, members: 4 }) });
  const card = app.cardFor("f1");
  assert.equal(card.state, "settled");
  assert.deepEqual(card.result, { p1: 2, p2: 1 });
  const html = app.html();
  assert.match(html, /class="mates-score">2-1</);
  assert.match(html, /class="mates-pts is-exact">\+5</);
  assert.match(html, /class="mates-pts">\+1</);
});

test("kicked off but unsettled shows picks and no points at all", () => {
  const app = view({ state: roundState({ revealedCount: 1, settled: 0 }) });
  const html = app.html();
  assert.match(html, /Kicked off · Picks revealed/);
  assert.doesNotMatch(html, /mates-pts/, "no points before the engine has spoken");
  assert.doesNotMatch(html, /mates-score/, "and never a running score");
});

// --- big leagues -----------------------------------------------------------

test("a big league shows eight rows and offers the rest", () => {
  const app = view({ state: roundState({ revealedCount: 1, members: 10 }) });
  const html = app.html();
  assert.equal((html.match(/class="mates-row[ "]/g) || []).length, 10, "all ten are in the document");
  assert.match(html, /Show all 10/);
  // The tail is hidden by stylesheet rather than by rebuilding on tap.
  const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.mates-rows:not\(\.is-all\) \.mates-row:nth-child\(n\+9\)/);
});

test("a league of eight needs no Show all", () => {
  assert.doesNotMatch(view({ state: roundState({ revealedCount: 1, members: 8 }) }).html(), /Show all/);
});

// --- empty states and fallbacks --------------------------------------------

test("your own locked pick is acknowledged rather than left blank", () => {
  const app = view({ state: roundState({ revealedCount: 0, total: 1 }), ownPicks: { f1: { p1: 1, p2: 0 } } });
  assert.match(app.html(), /Your pick is locked\. Mates' picks reveal at kick-off\./);
  assert.doesNotMatch(app.html(), /1-0/, "acknowledged, not echoed back as a scoreline");
});

test("a kicked-off fixture nobody else picked says so plainly", () => {
  const state = roundState({ revealedCount: 1, members: 1 });
  state.reveal[0].picks = [{ uid: VIEWER, nick: "Adam", p1: 1, p2: 0, none: false }];
  assert.match(view({ state }).html(), /No mate picks for this fixture\./);
});

test("an old worker's answer is unavailable after kick-off, normal before it", () => {
  // No reveal field at all: the client's own clock decides which it is.
  const slate = { period: "3", fixtureIds: ["past", "future"] };
  const state = { code: "AAA", period: "3", table: roundState().table };
  const app = new Function("stateIn", "slateIn", `
    "use strict";
    let matesState = stateIn;
    let leagueState = { code: "AAA", currentPeriod: "3", currentSlate: slateIn };
    let activeLeague = "AAA";
    const picks = {};
    const uid = () => "u1";
    const escapeHTML = (v) => String(v ?? "");
    const fixtureById = (id) => ({
      id, player1: "H", player2: "A",
      startAt: new Date(Date.now() + (id === "past" ? -3600000 : 3600000)).toISOString(),
    });
    ${liftConst("MATES_ROWS_SHOWN")}
    ${liftConst("MATES_STATE_LINE")}
    ${lift("function sharedRankByUid(table)")}
    ${lift("function revealRows(entry, table, viewerUid)")}
    ${lift("function matesFixtureView(fixture, entry, table, viewerUid)")}
    ${lift("function matesMatrix(state, viewerUid = uid())")}
    ${lift("function matesPickCell(row)")}
    ${lift("function matesPointsCell(row, card)")}
    ${lift("function matesRow(row, card)")}
    ${lift("function matesRowList(card)")}
    ${lift("function matesCardBody(card, viewerPicked)")}
    ${lift("function matesFixtureCard(card)")}
    ${lift("function slateForPeriod(period)")}
    return { cards: () => matesMatrix(matesState).cards, html: () => matesMatrix(matesState).cards.map(matesFixtureCard).join("") };
  `)(state, slate);

  const [past, future] = app.cards();
  assert.equal(past.state, "unavailable", "after kick-off, we cannot say — and say so");
  assert.equal(future.state, "locked", "before it, nothing is wrong at all");
  const html = app.html();
  assert.match(html, /Picks unavailable — refresh or update the app\./);
  assert.match(html, /Mates' picks reveal at kick-off/);
  assert.doesNotMatch(html, /\d-\d/, "and never a stale or invented pick");
});

// --- the fixture card ------------------------------------------------------

test("an expanded fixture card carries the same gated section", () => {
  const app = view({ state: roundState({ revealedCount: 1, total: 2 }) });
  assert.match(app.section("f1"), /Kicked off · Picks revealed/);
  assert.match(app.section("f2"), /Mates' picks reveal at kick-off · 2 of 3 locked in/);
  assert.doesNotMatch(app.section("f2"), /\d-\d/);
});

test("a fixture outside the current round gets no section rather than an empty one", () => {
  assert.equal(view({ state: roundState() }).section("not-in-this-round"), "");
});

test("expanding a fixture asks for nothing", () => {
  const app = view({ state: roundState({ revealedCount: 2, total: 4 }) });
  for (const id of ["f1", "f2", "f3", "f4"]) app.section(id);
  app.html();
  assert.equal(app.requests(), 0, "the card is drawn from what is already in memory");
});

// --- the freshness horizon -------------------------------------------------

test("the horizon is the next kick-off still ahead", () => {
  const state = roundState({ revealedCount: 1, total: 3 });
  const horizon = view({ state }).horizon();
  const nextLock = Math.min(...state.reveal.filter((entry) => !entry.revealed).map((entry) => Date.parse(entry.lockAt)));
  assert.equal(horizon, nextLock);
});

test("a round with every fixture kicked off has no horizon left to cross", () => {
  assert.equal(view({ state: roundState({ revealedCount: 3, total: 3 }) }).horizon(), Infinity);
});

// --- performance, worst shape ----------------------------------------------

test("the worst shape builds well inside a frame", () => {
  // Spec §10: twenty fixtures by a first-eight of member rows, and no
  // synchronous task over 50ms.
  const state = roundState({ revealedCount: 20, total: 20, settled: 10, members: 12 });
  const app = view({ state });
  const started = process.hrtime.bigint();
  const matrix = app.matrix();
  const html = app.html();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(matrix.cards.length, 20);
  assert.ok(html.length > 1000);
  assert.ok(ms < 50, `building the worst-shape matrix took ${ms.toFixed(1)}ms`);
});

test("the matrix is built in bounded chunks, not one blocking pass", () => {
  const branch = APP.slice(APP.indexOf('if (tab === "mates") {'));
  const body = branch.slice(0, branch.indexOf('if (tab === "matchday")'));
  assert.match(body, /index \+= 4/, "four cards at a time");
  assert.match(body, /await nextPaint\(\)/, "with a real paint between chunks");
  assert.match(body, /stale\(\)/, "and abandoned if the screen has moved on");
});
