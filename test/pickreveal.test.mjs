// Build 22 physical-acceptance defects, executed against the real app.js.
//
// A. Weekly movement sat in a left-hand gutter as a filled 28px disc, because
//    the .round-standings override reset display and font but not width,
//    height, border-radius or background — so the circle survived it.
// B. A settled My Picks card from a FINISHED week rendered no reveal at all.
//    fixtureRevealSection() answers only "what is the ACTIVE league showing for
//    its CURRENT round?", so matchweek 1 got the empty string: no row, no
//    chevron, nothing in the document to tap. The same lookup would also have
//    shown the wrong league's members for a pick shared across two leagues.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const VIEWER = "u-me";

/** Arsenal 3-0 Coventry: settled, matchweek 1, in TWO leagues. */
const ARSENAL = {
  id: "pl-2026-27-001-arsenal-coventry-city",
  player1: "Arsenal", player2: "Coventry City",
  matchday: 1, startAt: "2026-08-21T19:00:00Z",
  result: { p1: 3, p2: 0 }, status: "complete",
};
/** Hull 2-0 Manchester United: settled, matchweek 2, the CURRENT week. */
const HULL = {
  id: "pl-2026-27-002-hull-city-manchester-united",
  player1: "Hull City", player2: "Manchester United",
  matchday: 2, startAt: "2026-08-22T11:30:00Z",
  result: { p1: 2, p2: 0 }, status: "complete",
};

const revealEntry = (fixture, picksList) => ({
  id: fixture.id,
  revealed: true,
  settled: true,
  result: fixture.result,
  lockedIn: picksList.length,
  eligible: picksList.length,
  picks: picksList,
});

/** A league's round payload for one week. */
const round = (code, period, fixture, picksList, table) => ({
  code, period, reveal: [revealEntry(fixture, picksList)], table,
});

const SUNDAY_TABLE = [
  { uid: VIEWER, nick: "You", pts: 12 },
  { uid: "u-sam", nick: "Sam", pts: 9 },
];
const BURY_TABLE = [
  { uid: VIEWER, nick: "You", pts: 12 },
  { uid: "u-kaz", nick: "Kaz", pts: 4 },
  { uid: "u-nia", nick: "Nia", pts: 2 },
];

const SUNDAY_MW1 = round("SUN123", "1", ARSENAL, [
  { uid: VIEWER, nick: "You", p1: 4, p2: 1, pts: 2, settled: true },
  { uid: "u-sam", nick: "Sam", p1: 2, p2: 0, pts: 2, settled: true },
], SUNDAY_TABLE);

const BURY_MW1 = round("BURY99", "1", ARSENAL, [
  { uid: VIEWER, nick: "You", p1: 4, p2: 1, pts: 2, settled: true },
  { uid: "u-kaz", nick: "Kaz", p1: 3, p2: 0, pts: 5, settled: true },
  { uid: "u-nia", nick: "Nia", p1: 1, p2: 1, pts: 0, settled: true },
], BURY_TABLE);

const SUNDAY_MW2 = round("SUN123", "2", HULL, [
  { uid: VIEWER, nick: "You", p1: 1, p2: 1, pts: 0, settled: true },
  { uid: "u-sam", nick: "Sam", p1: 2, p2: 0, pts: 5, settled: true },
], SUNDAY_TABLE);

const REVEAL_NAMES = [
  "revealStateFor", "pickRevealCard", "pickRevealCount", "pickRevealSection",
  "pickRevealBody", "PICK_REVEAL_UNESCAPED", "pickRevealPart", "pickRevealKey", "pickRevealDomId",
  "matesFixtureView", "matesCardBody", "matesRowList", "matesRow", "matesPickCell",
  "revealRows", "sharedRankByUid", "clientLockMs", "matesPointsCell",
  "MATES_STATE_LINE", "MATES_UNAVAILABLE", "MATES_ROWS_SHOWN",
];

/**
 * The reveal layer over a chosen world. `activeLeague` is set to the WRONG
 * league on purpose in most cases: the card must answer from its own section.
 */
function world({ rounds = [], matesState = null, roundState = null, activeLeague = "OTHER1", now } = {}) {
  const roundStates = {};
  for (const state of rounds) roundStates[`${state.code}:${state.period}`] = state;
  return load(REVEAL_NAMES, {
    picks: { [ARSENAL.id]: { p1: 4, p2: 1 }, [HULL.id]: { p1: 1, p2: 1 } },
    fixtures: [ARSENAL, HULL],
    matesState,
    roundState,
    activeLeague,
    roundStates,
    cachedRoundState: (code, period) => roundStates[`${code}:${period}`] || null,
    uid: () => VIEWER,
    expandedPickReveal: null,
    Date: now ? class extends Date { static now() { return now; } } : Date,
  });
}

// --- A · weekly movement placement ---------------------------------------

test("A · the weekly row puts the arrow AFTER the name, in the season table's slot", () => {
  const box = load(["roundTableHtml", "weeklyRanks", "weeklyMovement", "weeklyMovementBadge",
    "sharedRankByUid", "settlementWindows", "windowPointsByUid",
    "VOID_STATUSES", "isVoidFixture", "isPostponed",
    "PLACE_EMOJI", "medalLine", "podiumCounts"], {
    slateForPeriod: () => null,
    fixtureById: () => null,
  });
  // A completed settlement window, so there is real movement to place: Bo's
  // 6 points in the last window take Bo from behind Ada to level-and-above.
  const reveal = [
    { id: "f1", lockAt: "2026-09-12T14:00:00Z", settled: true,
      picks: [{ uid: "a", pts: 9 }, { uid: "b", pts: 0 }] },
    { id: "f2", lockAt: "2026-09-13T14:00:00Z", settled: true,
      picks: [{ uid: "a", pts: 0 }, { uid: "b", pts: 6 }] },
  ];
  const html = box.roundTableHtml({
    period: "2",
    table: [{ uid: "b", nick: "Bo", pts: 6, exact: 0 }, { uid: "a", nick: "Ada", pts: 9, exact: 1 }],
    reveal,
  });
  assert.match(html, /class="movement/, "the fixture produced no movement to place");
  // One cell, name first and the movement after it — not a fourth column.
  // Every row: one player cell, the name, then the arrow — never the reverse.
  const cells = html.match(/<td class="player-cell">.*?<\/td>/g) || [];
  assert.equal(cells.length, 2);
  for (const cell of cells) {
    assert.match(cell, /^<td class="player-cell"><span class="player-name">\d+\. [^<]+<\/span><span class="movement /,
      `the arrow is not immediately after the name: ${cell}`);
  }
  assert.equal((html.match(/<th>/g) || []).length, 3, "a column was added to the weekly table");
  assert.equal((html.match(/<td/g) || []).length, 6, "each row must stay three cells");
  // And never before the rank, which is what made the gutter.
  assert.ok(!/<td[^>]*><span class="movement/.test(html),
    "the movement still leads the player cell");
});

test("A · the weekly override resets every circle property it inherits", () => {
  const css = CSS;
  const block = css.slice(css.indexOf(".round-standings .movement {"));
  const rule = block.slice(0, block.indexOf("}"));
  for (const prop of ["width", "height", "border-radius", "background"]) {
    assert.match(rule, new RegExp(`${prop}\\s*:`),
      `.round-standings .movement does not reset ${prop}, so the 28px disc survives`);
  }
  assert.match(rule, /width:\s*auto/);
  assert.match(rule, /border-radius:\s*0/);
  assert.match(rule, /background:\s*none/);
  // The player cell lines the arrows up down the column, as the season table does.
  assert.match(css, /\.round-standings \.player-cell \{[^}]*display:\s*flex/);
});

test("A · Up N / Down N / No change survive the move", () => {
  const box = load(["weeklyMovementBadge"]);
  assert.match(box.weeklyMovementBadge(3), /aria-label="Up 3 places"/);
  assert.match(box.weeklyMovementBadge(1), /aria-label="Up 1 place"/);
  assert.match(box.weeklyMovementBadge(-2), /aria-label="Down 2 places"/);
  assert.match(box.weeklyMovementBadge(-1), /aria-label="Down 1 place"/);
  assert.match(box.weeklyMovementBadge(0), /aria-label="No change"/);
});

// --- B · the Arsenal cross-league settled shape ---------------------------

test("B · REPRODUCTION: the old lookup gives a historic week nothing to draw", () => {
  // fixtureRevealSection() is bound to the ACTIVE league's CURRENT round. This
  // is the exact condition that made the tap silent, asserted rather than
  // described: matchweek 1 is not the current period, so it matches nothing.
  const box = world({ rounds: [SUNDAY_MW1, SUNDAY_MW2], activeLeague: "SUN123" });
  box.evalIn("globalThis.leagueState = { code: 'SUN123', currentPeriod: '2' };");
  const usable = load(["matesUsable", "matesPeriod"], {
    activeLeague: "SUN123",
    leagueState: { code: "SUN123", currentPeriod: "2" },
  });
  assert.equal(usable.matesUsable(SUNDAY_MW1), false, "the historic week was treated as current");
  assert.equal(usable.matesUsable(SUNDAY_MW2), true, "the current week must still be usable");
});

test("B · a settled HISTORIC card gets a disclosure row and a chevron", () => {
  const box = world({ rounds: [SUNDAY_MW1] });
  const html = box.pickRevealSection(ARSENAL, { code: "SUN123", period: "1" });
  assert.match(html, /data-pick-reveal="/, "no disclosure control was rendered");
  assert.match(html, /Mates&#39; picks|Mates' picks/);
  assert.match(html, /pick-reveal-chevron/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="pr-/);
  // One mate besides the viewer.
  assert.match(html, / · 1</);
});

test("B · the WORKING Hull shape keeps working, from its own week", () => {
  const box = world({ rounds: [SUNDAY_MW2] });
  const html = box.pickRevealSection(HULL, { code: "SUN123", period: "2" });
  assert.match(html, /data-pick-reveal="/);
  assert.match(html, / · 1</);
  const card = box.pickRevealCard(HULL, "SUN123", "2");
  assert.equal(card.state, "settled");
  const body = box.pickRevealBody(HULL, card);
  assert.match(body, /Picks &amp; points|Picks & points/);
  assert.match(body, /Sam/);
});

test("B · historic and current weeks BOTH resolve, and never to each other", () => {
  const box = world({ rounds: [SUNDAY_MW1, SUNDAY_MW2] });
  const mw1 = box.pickRevealCard(ARSENAL, "SUN123", "1");
  const mw2 = box.pickRevealCard(HULL, "SUN123", "2");
  assert.ok(mw1 && mw2);
  assert.equal(mw1.state, "settled");
  assert.equal(mw2.state, "settled");
  // Asking week 2 for week 1's fixture must not answer with week 2's rows.
  const crossed = box.pickRevealCard(ARSENAL, "SUN123", "2");
  assert.equal(crossed.state, "unavailable", "a fixture was answered out of the wrong week");
  assert.equal(crossed.rows.length, 0);
});

// --- B · no cross-league bleed --------------------------------------------

test("B · a pick shared across leagues shows each league's OWN members", () => {
  const box = world({ rounds: [SUNDAY_MW1, BURY_MW1], activeLeague: "SUN123" });
  const sunday = box.pickRevealCard(ARSENAL, "SUN123", "1");
  const bury = box.pickRevealCard(ARSENAL, "BURY99", "1");

  const nicks = (card) => [...card.rows].map((row) => row.nick).sort();
  assert.deepEqual(nicks(sunday), ["Sam", "You"]);
  assert.deepEqual(nicks(bury), ["Kaz", "Nia", "You"]);
  // The decisive one: Bury's card must not borrow the ACTIVE league's members.
  assert.ok(!nicks(bury).includes("Sam"), "the active league's member bled across");
  assert.ok(!nicks(sunday).includes("Kaz"), "another league's member bled across");
});

test("B · the active league never decides what a card shows", () => {
  for (const active of ["SUN123", "BURY99", "OTHER1", null]) {
    const box = world({ rounds: [SUNDAY_MW1, BURY_MW1], activeLeague: active });
    const bury = box.pickRevealCard(ARSENAL, "BURY99", "1");
    assert.deepEqual([...bury.rows].map((r) => r.nick).sort(), ["Kaz", "Nia", "You"],
      `activeLeague=${active} changed a card's answer`);
  }
});

test("B · a payload for the wrong league is refused even for the same fixture id", () => {
  // The one that hides: two leagues holding the very same fixture.
  const box = world({ rounds: [], matesState: BURY_MW1, activeLeague: "BURY99" });
  assert.equal(box.revealStateFor("SUN123", "1"), null,
    "another league's payload satisfied this league's card");
  assert.equal(box.revealStateFor("BURY99", "1"), BURY_MW1);
  assert.equal(box.revealStateFor("BURY99", "2"), null, "the wrong week was accepted");
});

// --- B · never a silent tap ------------------------------------------------

test("B · with NO data the control is still rendered, and says so when opened", () => {
  const box = world({ rounds: [] });
  const html = box.pickRevealSection(ARSENAL, { code: "SUN123", period: "1" });
  assert.match(html, /data-pick-reveal="/, "the control was hidden when data was missing");
  // No count is promised that cannot be kept.
  assert.match(html, /<span data-pick-reveal-count><\/span>/);
  assert.equal(box.pickRevealCard(ARSENAL, "SUN123", "1"), null);
  const body = box.pickRevealBody(ARSENAL, null);
  assert.match(body, /Picks unavailable/);
  assert.ok(body.trim().length > 0, "an unavailable card rendered nothing at all");
});

test("B · every settled card in a league section offers a control; the solo section does not", () => {
  const box = world({ rounds: [SUNDAY_MW1] });
  for (const reveal of [{ code: "SUN123", period: "1" }, { code: "BURY99", period: "1" }]) {
    assert.match(box.pickRevealSection(ARSENAL, reveal), /data-pick-reveal=/,
      `${reveal.code} got no control`);
  }
  // "Your other predictions" is not a league: there are no mates to disclose.
  assert.equal(box.pickRevealSection(ARSENAL, null), "");
  assert.equal(box.pickRevealSection(ARSENAL, { code: null, period: "1" }), "");
  assert.equal(box.pickRevealSection(ARSENAL, { code: "SUN123", period: null }), "");
});

test("B · the disclosure key is unique per league, week and fixture", () => {
  const box = world({ rounds: [] });
  const keys = new Set([
    box.pickRevealKey("SUN123", "1", ARSENAL.id),
    box.pickRevealKey("BURY99", "1", ARSENAL.id),
    box.pickRevealKey("SUN123", "2", ARSENAL.id),
    box.pickRevealKey("SUN123", "1", HULL.id),
  ]);
  assert.equal(keys.size, 4, "two different cards share a disclosure identity");
  // The id is the key with a prefix, not a mangling of it: a mangling would
  // collapse distinct keys onto one id and cross two cards' aria-controls.
  const key = box.pickRevealKey("SUN123", "w2026-08-18", ARSENAL.id);
  assert.equal(box.pickRevealDomId(key), `pr-${key}`);
  // The alphabet the encoding guarantees: no whitespace, quotes or ampersands,
  // so it is safe in an attribute and legal in an HTML5 id.
  assert.match(key, /^[A-Za-z0-9._%|-]+$/);
  for (const hostile of [["A|B", "1|2", "x y"], [`a"b`, "w&1", "<z>"], ["'", "\u0000", "\t"]]) {
    const encoded = box.pickRevealKey(...hostile);
    assert.match(encoded, /^[A-Za-z0-9._%|-]+$/, `unsafe key for ${JSON.stringify(hostile)}`);
  }
  // Injective: encoding escapes the separator, so parts cannot bleed together.
  assert.notEqual(box.pickRevealKey("A|B", "C", "D"), box.pickRevealKey("A", "B|C", "D"));
});

test("B · a zero-mate settled card still discloses, and explains itself", () => {
  const alone = round("SOLO01", "1", ARSENAL,
    [{ uid: VIEWER, nick: "You", p1: 4, p2: 1, pts: 2, settled: true }],
    [{ uid: VIEWER, nick: "You", pts: 2 }]);
  const box = world({ rounds: [alone] });
  const html = box.pickRevealSection(ARSENAL, { code: "SOLO01", period: "1" });
  assert.match(html, /data-pick-reveal=/);
  assert.match(html, / · 0</);
  const body = box.pickRevealBody(ARSENAL, box.pickRevealCard(ARSENAL, "SOLO01", "1"));
  assert.match(body, /No mate picks for this fixture/);
});

// --- B · the wiring that carries the context ------------------------------

test("B · the settled-card reveal is Matchweek's, and its context still threads", () => {
  // The defect was not in the reveal alone: the card was never told which
  // section it was in, so it could only ever ask about the active league.
  // v1.7 Slice B moved the social view off My Picks entirely (B10): the
  // personal surface draws settled cards with social:false, and the
  // league-and-week reveal now serves Matchweek. The threading it proved is
  // unchanged where it still applies.
  assert.match(APP, /function resultCard\(match, reveal = null, \{ social = true \} = \{\}\)/);
  assert.match(APP, /!social \? "" : reveal \? pickRevealSection\(match, reveal\) : fixtureRevealSection\(match\)/);
  assert.match(APP, /resultCard\(match, null, \{ social: false \}\)/);
  // And the tap is handled rather than falling through to nothing.
  assert.match(APP, /const pickReveal = event\.target\.closest\("\[data-pick-reveal\]"\);/);
  assert.match(APP, /^\s*togglePickReveal\(pickReveal\);$/m);
  // Never awaited: an await here would sit above the share branches and end
  // the user gesture that has to raise the iOS share sheet.
  assert.ok(!/await togglePickReveal/.test(APP), "the tap awaits before the share branches");
});

test("B · opening a card never re-renders, so the scroll position is kept", () => {
  const toggle = APP.slice(APP.indexOf("async function togglePickReveal"));
  const body = toggle.slice(0, toggle.indexOf("\n}"));
  assert.ok(!/\brender\(/.test(body), "togglePickReveal re-renders the view");
  assert.ok(!/loadRoundState\(/.test(body), "it drives the Weekly tab's loader, which renders");
  // One at a time, and built once.
  assert.match(body, /querySelectorAll\("\[data-pick-reveal\]"\)/);
  assert.match(body, /dataset\.built === "1"/);
  assert.match(body, /if \(card\) body\.dataset\.built = "1";/);
});

test("B · a fetch for a missing week never disturbs what the Weekly tab shows", () => {
  const ensure = APP.slice(APP.indexOf("async function ensureRoundState"));
  const body = ensure.slice(0, ensure.indexOf("\n}"));
  assert.ok(!/roundState =/.test(body), "ensureRoundState writes the module-level roundState");
  assert.ok(!/\brender\(/.test(body));
  assert.match(body, /cachedRoundState\(code, period\)/);
  assert.match(body, /cacheRoundState\(code, period, state\)/);
});
