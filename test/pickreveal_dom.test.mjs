// The settled My Picks disclosure, driven through a REAL DOM.
//
// The sibling suite proves the view-model: which league and which week a card
// answers from. It cannot prove the thing the device actually failed at —
// a button that is in the document and does nothing when pressed. That needs
// markup parsed by an HTML parser, a real click target, and a response that
// arrives after the tap rather than before it.
//
// So this renders the production markup, lets jsdom parse it, presses the
// button the parser produced, and holds the round response back until the test
// chooses to release it.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { load } from "./harness.mjs";

const VIEWER = "u-me";

/** Arsenal 3-0 Coventry: settled, matchweek 1 — HISTORIC — and in two leagues. */
const ARSENAL = {
  id: "pl-2026-27-001-arsenal-coventry-city",
  player1: "Arsenal", player2: "Coventry City",
  matchday: 1, startAt: "2026-08-21T19:00:00Z",
  result: { p1: 3, p2: 0 }, status: "complete",
};
const HULL = {
  id: "pl-2026-27-002-hull-city-manchester-united",
  player1: "Hull City", player2: "Manchester United",
  matchday: 2, startAt: "2026-08-22T11:30:00Z",
  result: { p1: 2, p2: 0 }, status: "complete",
};

const entry = (fixture, picksList) => ({
  id: fixture.id, revealed: true, settled: true, result: fixture.result,
  lockedIn: picksList.length, eligible: picksList.length, picks: picksList,
});

/** Sunday Six, matchweek 1: the viewer and Sam. */
const SUNDAY_MW1 = {
  code: "SUN123", period: "1",
  reveal: [entry(ARSENAL, [
    { uid: VIEWER, nick: "You", p1: 4, p2: 1, pts: 2, settled: true },
    { uid: "u-sam", nick: "Sam", p1: 2, p2: 0, pts: 2, settled: true },
  ])],
  table: [{ uid: VIEWER, nick: "You", pts: 12 }, { uid: "u-sam", nick: "Sam", pts: 9 }],
};

/** Bury Legends, matchweek 1: the SAME fixture, different members entirely. */
const BURY_MW1 = {
  code: "BURY99", period: "1",
  reveal: [entry(ARSENAL, [
    { uid: VIEWER, nick: "You", p1: 4, p2: 1, pts: 2, settled: true },
    { uid: "u-kaz", nick: "Kaz", p1: 3, p2: 0, pts: 5, settled: true },
    { uid: "u-nia", nick: "Nia", p1: 1, p2: 1, pts: 0, settled: true },
  ])],
  table: [
    { uid: VIEWER, nick: "You", pts: 12 },
    { uid: "u-kaz", nick: "Kaz", pts: 4 },
    { uid: "u-nia", nick: "Nia", pts: 2 },
  ],
};

const SUNDAY_MW2 = {
  code: "SUN123", period: "2",
  reveal: [entry(HULL, [
    { uid: VIEWER, nick: "You", p1: 1, p2: 1, pts: 0, settled: true },
    { uid: "u-sam", nick: "Sam", p1: 2, p2: 0, pts: 5, settled: true },
  ])],
  table: [{ uid: VIEWER, nick: "You", pts: 12 }, { uid: "u-sam", nick: "Sam", pts: 9 }],
};

const NAMES = [
  "PICK_REVEAL_UNESCAPED", "pickRevealPart", "pickRevealKey", "pickRevealDomId", "revealStateFor",
  "pickRevealCard", "pickRevealCount", "pickRevealSection", "pickRevealBody",
  "ensureRoundState", "togglePickReveal",
  "matesFixtureView", "matesCardBody", "matesRowList", "matesRow",
  "matesPickCell", "matesPointsCell", "revealRows", "sharedRankByUid", "clientLockMs",
  "MATES_STATE_LINE", "MATES_UNAVAILABLE", "MATES_ROWS_SHOWN",
];

/**
 * A live page: real parsing, real elements, and a round read the test releases
 * by hand so a tap can be observed BEFORE its answer arrives.
 */
function page({ cached = [] } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { document } = dom.window;
  const roundStates = {};
  for (const state of cached) roundStates[`${state.code}:${state.period}`] = state;

  const flights = [];
  const box = load(NAMES, {
    document,
    API: "https://worker.test",
    picks: { [ARSENAL.id]: { p1: 4, p2: 1 }, [HULL.id]: { p1: 1, p2: 1 } },
    fixtures: [ARSENAL, HULL],
    revealState: null,
    roundState: null,
    // Deliberately the WRONG league: a card must answer from its own section.
    activeLeague: "OTHER1",
    expandedPickReveal: null,
    uid: () => VIEWER,
    cachedRoundState: (code, period) => roundStates[`${code}:${period}`] || null,
    cacheRoundState: (code, period, state) => {
      if (state && !state.error) roundStates[`${code}:${period}`] = state;
    },
    roundStatePath: (code, period) => `/state?code=${code}&period=${period}`,
    fetchState: (path) => new Promise((resolve, reject) => flights.push({ path, resolve, reject })),
  });

  return {
    box, document, flights,
    /** Draw one card's disclosure and let the parser build it. */
    mount(fixture, reveal) {
      document.body.insertAdjacentHTML("beforeend",
        `<div class="pick-entry">${box.pickRevealSection(fixture, reveal)}</div>`);
    },
    button(reveal, fixture = ARSENAL) {
      const key = box.pickRevealKey(reveal.code, reveal.period, fixture.id);
      return document.querySelector(`[data-pick-reveal="${key.replace(/"/g, '\\"')}"]`);
    },
    bodyOf(button) {
      return document.getElementById(button.getAttribute("aria-controls"));
    },
    /** Release the pending round read, then let the continuation run. */
    async release(state, at = 0) {
      const flight = flights[at];
      assert.ok(flight, "no round read was in flight");
      flight.resolve(state);
      await flight.promiseSettled?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    async settle() { await new Promise((r) => setTimeout(r, 0)); },
  };
}

// --- the encoded key through a real parser --------------------------------

test("DOM · the encoded key survives HTML attribute parsing exactly", () => {
  const p = page();
  // Parts chosen to break a naive encoding: a quote, an ampersand, a space, a
  // less-than, and the separator character itself.
  const hostile = { code: `A"B&C`, period: `w|2026 08<18`, id: `fx'1|2` };
  const key = p.box.pickRevealKey(hostile.code, hostile.period, hostile.id);
  assert.match(key, /^[A-Za-z0-9._%|-]+$/, `key left the safe alphabet: ${key}`);

  p.document.body.insertAdjacentHTML("beforeend",
    p.box.pickRevealSection({ ...ARSENAL, id: hostile.id },
      { code: hostile.code, period: hostile.period }));
  const button = p.document.querySelector("[data-pick-reveal]");
  assert.ok(button, "the parser produced no button");
  // Byte for byte, out of the parser and back through dataset.
  assert.equal(button.dataset.pickReveal, key);
  assert.equal(button.dataset.revealCode, hostile.code);
  assert.equal(button.dataset.revealPeriod, hostile.period);
  assert.equal(button.dataset.revealFixture, hostile.id);
  // And the body it controls is findable by the id it was given.
  const body = p.document.getElementById(button.getAttribute("aria-controls"));
  assert.ok(body, "aria-controls did not resolve to an element");
  assert.equal(body.id, p.box.pickRevealDomId(key));
});

test("DOM · two cards that differ only in league get different ids", () => {
  const p = page();
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  p.mount(ARSENAL, { code: "BURY99", period: "1" });
  const buttons = [...p.document.querySelectorAll("[data-pick-reveal]")];
  assert.equal(buttons.length, 2);
  const ids = buttons.map((b) => b.getAttribute("aria-controls"));
  assert.equal(new Set(ids).size, 2, "two cards share one body id");
  for (const id of ids) assert.ok(p.document.getElementById(id));
});

// --- the production sequence, tapped ---------------------------------------

test("DOM · a collapsed HISTORIC card acknowledges the tap immediately, then fills", async () => {
  const p = page();                                   // nothing cached
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  const button = p.button({ code: "SUN123", period: "1" });
  assert.ok(button, "no disclosure was rendered for a historic settled card");
  const body = p.bodyOf(button);

  // Collapsed to begin with.
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(body.hasAttribute("hidden"), true);
  assert.equal(body.innerHTML, "");

  // The tap. Not awaited — that is how the app calls it, so that the gesture
  // is not spent before the share branches below it in the same handler.
  const tap = p.box.togglePickReveal(button);

  // IMMEDIATE acknowledgement: before any response, in the same turn.
  assert.equal(button.getAttribute("aria-expanded"), "true", "the tap was not acknowledged");
  assert.equal(body.hasAttribute("hidden"), false);
  assert.match(body.textContent, /Loading mates/, "the card showed nothing while it waited");
  assert.equal(p.flights.length, 1, "the historic week was not requested");
  assert.match(p.flights[0].path, /code=SUN123&period=1/);

  // The delayed historic round answer.
  p.flights[0].resolve(SUNDAY_MW1);
  await tap;

  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(body.hasAttribute("hidden"), false);
  // The right league's mates, and the settled points.
  assert.match(body.textContent, /Picks & points/);
  assert.match(body.textContent, /Sam/);
  assert.match(body.textContent, /You/);
  assert.ok(!body.textContent.includes("Kaz"), "another league's member appeared");
  assert.match(body.textContent, /\+2/, "settled points are missing");
  // The count on the row is filled in once it can be kept.
  assert.match(button.textContent, /·\s*1/);
});

test("DOM · a cached historic week paints on the tap, with no request at all", async () => {
  const p = page({ cached: [SUNDAY_MW1] });
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  const button = p.button({ code: "SUN123", period: "1" });
  const body = p.bodyOf(button);
  // The count is known before the tap, because the week is already in hand.
  assert.match(button.textContent, /·\s*1/);

  const tap = p.box.togglePickReveal(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(body.textContent, /Sam/, "a cached week did not paint on the tap");
  assert.equal(p.flights.length, 0, "a cached week was fetched anyway");
  await tap;
});

// --- one at a time ---------------------------------------------------------

test("DOM · opening a second card closes the first", async () => {
  const p = page({ cached: [SUNDAY_MW1, SUNDAY_MW2] });
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  p.mount(HULL, { code: "SUN123", period: "2" });
  const first = p.button({ code: "SUN123", period: "1" }, ARSENAL);
  const second = p.button({ code: "SUN123", period: "2" }, HULL);

  await p.box.togglePickReveal(first);
  assert.equal(first.getAttribute("aria-expanded"), "true");
  assert.equal(p.bodyOf(first).hasAttribute("hidden"), false);

  await p.box.togglePickReveal(second);
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assert.equal(p.bodyOf(second).hasAttribute("hidden"), false);
  assert.equal(first.getAttribute("aria-expanded"), "false", "the first card stayed open");
  assert.equal(p.bodyOf(first).hasAttribute("hidden"), true);
  // Closed, not discarded: the work it did is still there.
  assert.match(p.bodyOf(first).textContent, /Sam/);
});

test("DOM · close and reopen repaints nothing and refetches nothing", async () => {
  const p = page();
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  const button = p.button({ code: "SUN123", period: "1" });
  const body = p.bodyOf(button);

  const first = p.box.togglePickReveal(button);
  p.flights[0].resolve(SUNDAY_MW1);
  await first;
  assert.equal(p.flights.length, 1);
  const painted = body.innerHTML;
  assert.equal(body.dataset.built, "1");

  await p.box.togglePickReveal(button);                 // close
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(body.hasAttribute("hidden"), true);
  assert.equal(body.innerHTML, painted, "closing discarded the body");

  await p.box.togglePickReveal(button);                 // reopen
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(body.hasAttribute("hidden"), false);
  assert.equal(body.innerHTML, painted, "reopening rebuilt a body it already had");
  assert.equal(p.flights.length, 1, "reopening issued a second request");
});

// --- a late answer must never land on the wrong card ----------------------

test("DOM · a response arriving after the card was CLOSED cannot repaint it", async () => {
  const p = page();
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  const button = p.button({ code: "SUN123", period: "1" });
  const body = p.bodyOf(button);

  const tap = p.box.togglePickReveal(button);           // opens, request in flight
  assert.match(body.textContent, /Loading mates/);
  await p.box.togglePickReveal(button);                 // viewer closes it again
  assert.equal(button.getAttribute("aria-expanded"), "false");

  p.flights[0].resolve(SUNDAY_MW1);                     // ... and only now it lands
  await tap;

  assert.equal(button.getAttribute("aria-expanded"), "false", "a late answer reopened the card");
  assert.equal(body.hasAttribute("hidden"), true);
  assert.ok(!body.textContent.includes("Sam"), "a closed card was repainted");
  // Nothing was marked built, so asking again genuinely asks again.
  assert.notEqual(body.dataset.built, "1");
});

test("DOM · a response for a SUPERSEDED card cannot repaint it, or the new one", async () => {
  const p = page({ cached: [SUNDAY_MW2] });
  p.mount(ARSENAL, { code: "SUN123", period: "1" });     // historic, uncached
  p.mount(HULL, { code: "SUN123", period: "2" });        // current, cached
  const first = p.button({ code: "SUN123", period: "1" }, ARSENAL);
  const second = p.button({ code: "SUN123", period: "2" }, HULL);

  const slow = p.box.togglePickReveal(first);            // in flight
  assert.equal(p.flights.length, 1);
  await p.box.togglePickReveal(second);                  // supersedes it
  const secondPainted = p.bodyOf(second).innerHTML;

  p.flights[0].resolve(SUNDAY_MW1);                      // the stale answer lands
  await slow;

  assert.equal(first.getAttribute("aria-expanded"), "false");
  assert.equal(p.bodyOf(first).hasAttribute("hidden"), true);
  assert.ok(!p.bodyOf(first).textContent.includes("Sam"),
    "the superseded card was painted after it lost the floor");
  // And the card that DID have the floor is untouched by the other's answer.
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assert.equal(p.bodyOf(second).innerHTML, secondPainted, "the live card was repainted");
});

// --- the cross-league case, through the DOM -------------------------------

test("DOM · the same fixture in two leagues shows each league's own members", async () => {
  const p = page({ cached: [SUNDAY_MW1, BURY_MW1] });
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  p.mount(ARSENAL, { code: "BURY99", period: "1" });
  const sunday = p.button({ code: "SUN123", period: "1" });
  const bury = p.button({ code: "BURY99", period: "1" });

  await p.box.togglePickReveal(sunday);
  const sundayText = p.bodyOf(sunday).textContent;
  await p.box.togglePickReveal(bury);
  const buryText = p.bodyOf(bury).textContent;

  assert.match(sundayText, /Sam/);
  assert.ok(!sundayText.includes("Kaz"), "Bury's member appeared under Sunday Six");
  assert.match(buryText, /Kaz/);
  assert.match(buryText, /Nia/);
  assert.ok(!buryText.includes("Sam"), "Sunday Six's member appeared under Bury Legends");
  // Neither borrowed the ACTIVE league, which is a third league entirely.
  assert.equal(p.flights.length, 0);
});

// --- a tap is never silent -------------------------------------------------

test("DOM · a week that cannot be supplied says so, and stays retryable", async () => {
  const p = page();
  p.mount(ARSENAL, { code: "SUN123", period: "1" });
  const button = p.button({ code: "SUN123", period: "1" });
  const body = p.bodyOf(button);

  const tap = p.box.togglePickReveal(button);
  p.flights[0].reject(new Error("offline"));
  await tap;

  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(body.hasAttribute("hidden"), false);
  assert.match(body.textContent, /Picks unavailable/, "the tap was answered with nothing");
  assert.notEqual(body.dataset.built, "1", "an unavailable card cached a dead end");

  // Retryable: close, reopen, and it asks again rather than sitting on the failure.
  await p.box.togglePickReveal(button);
  const retry = p.box.togglePickReveal(button);
  assert.equal(p.flights.length, 2, "reopening after a failure did not retry");
  p.flights[1].resolve(SUNDAY_MW1);
  await retry;
  assert.match(body.textContent, /Sam/);
});
