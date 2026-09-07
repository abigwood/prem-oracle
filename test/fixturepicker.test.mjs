// Adam's v1.7 UX rider, part B: choosing fixtures must not throw the host back
// to the top of the list.
//
// The tap used to call render(), which rebuilds #pickerLayer from scratch. A
// new .picker-list is a new scroller at zero, so picking six fixtures meant six
// trips back down the week. These tests run the real handler against a real
// DOM and watch the scroller, the row, the counter and the publish gate.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { load, sourceOf } from "./harness.mjs";

const FIXTURES = Array.from({ length: 24 }, (_, i) => ({
  id: `f${i}`, player1: `Home ${i}`, player2: `Away ${i}`,
  startAt: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
}));

const NAMES = ["handlePickerClick", "togglePickerFixture", "markPickerRow", "syncPickerCounter",
  "pickerCounterLabel", "pickerReady", "pickerBounds", "fixturePickerView", "pickerRow"];

/**
 * The overlay as the host actually sees it: built by the real view function,
 * parsed by a real parser, scrolled to where a finger would have left it.
 */
function pickerBox({ selected = [], fixtures = FIXTURES, limit = 6 } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="pickerLayer"></div></body>`);
  const { document, CSS } = dom.window;
  const calls = { render: 0, api: 0 };
  const box = load(NAMES, {
    document,
    CSS,
    pickerOpen: true,
    pickerAmending: false,
    pickerConfirmOpen: false,
    pickerBusy: false,
    pickerPeriod: "7",
    pickerMode: "custom",
    pickerSelection: new Set(selected.map(String)),
    pickerFixtures: () => fixtures,
    pickerPreload: () => null,
    pickerUnavailable: [],
    pickerUnavailableNote: () => "",
    pickerConfirm: () => "",
    pickerKickoff: () => "Sat 15:00",
    competitionChip: () => "",
    competitionOfFixture: () => "PL",
    competitionMeta: () => ({ name: "Premier League", short: "PL" }),
    activeCompetitions: () => ["PL"],
    isMixedActive: () => false,
    DEFAULT_COMPETITION: "PL",
    DEFAULT_FIXTURE_COUNT: 6,
    MIN_FIXTURE_COUNT: 1,
    periodLabelLong: (p) => `Matchweek ${p}`,
    leagueState: { name: "Sunday Six", fixtureLimit: limit, weeklyRule: { count: limit } },
    // The two things a selection tap must never reach.
    render: () => { calls.render += 1; },
    api: async () => { calls.api += 1; return {}; },
    fetch: async () => { calls.api += 1; return {}; },
    surpriseSelection: () => new Set(),
    commitSlate: async () => {},
    saveSlateDraft: async () => {},
    closeFixturePicker: () => {},
    openFixturePicker: () => {},
    loadLeagueState: async () => {},
    countPhrase: (n, w) => `${n} ${w}`,
  });

  document.getElementById("pickerLayer").innerHTML = box.fixturePickerView();
  const list = document.querySelector(".picker-list");
  list.scrollTop = 420;

  return {
    box, document, calls, list,
    row: (id) => document.querySelector(`[data-picker-fixture="${id}"]`),
    counter: () => document.querySelector(".picker-counter strong").textContent,
    publish: () => document.querySelector("[data-picker-set]"),
    // A tap, delivered the way the document listener delivers one.
    tap: (node) => box.handlePickerClick({ target: node }),
    state: () => [...document.querySelectorAll("[data-picker-fixture]")].map((node) => ({
      id: node.dataset.pickerFixture,
      on: node.classList.contains("is-selected"),
      aria: node.getAttribute("aria-pressed"),
    })),
  };
}

// --- 5 · one tap changes one row -------------------------------------------

test("B5 · selecting a fixture keeps the scroller exactly where it was", async () => {
  const app = pickerBox();
  const listBefore = app.list;
  await app.tap(app.row("f11"));
  assert.equal(app.document.querySelector(".picker-list"), listBefore,
    "the list was rebuilt, which is what loses the position");
  assert.equal(app.list.scrollTop, 420, "the scroller jumped");
});

test("B5 · and changes only that row, the count and the action state", async () => {
  const app = pickerBox({ selected: ["f0", "f1"] });
  const before = app.state();
  const html = app.document.querySelector(".picker-list").innerHTML;
  await app.tap(app.row("f11"));
  const after = app.state();
  const changed = after.filter((row, i) => row.on !== before[i].on);
  assert.deepEqual(changed.map((row) => row.id), ["f11"], "more than one row moved");
  assert.equal(after.find((row) => row.id === "f11").aria, "true");
  assert.equal(app.counter(), "Select 1–24 · 3 selected");
  // Every other row's markup is untouched, in the same order.
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), "the fixtures were reordered");
  assert.notEqual(app.document.querySelector(".picker-list").innerHTML, html, "nothing changed at all");
});

test("B5 · the tapped row's own node survives the tap", async () => {
  const app = pickerBox();
  const node = app.row("f5");
  await app.tap(node);
  assert.equal(app.row("f5"), node, "the row was replaced rather than updated");
  assert.equal(node.classList.contains("is-selected"), true);
  assert.equal(node.getAttribute("aria-pressed"), "true");
});

// --- 6 and 7 · consecutively, in both directions ---------------------------

test("B6 · six consecutive selections never move the scroller", async () => {
  const app = pickerBox();
  for (const id of ["f3", "f4", "f9", "f12", "f18", "f23"]) {
    app.list.scrollTop = 420;   // where the finger left it before this tap
    await app.tap(app.row(id));
    assert.equal(app.list.scrollTop, 420, `tap on ${id} jumped`);
  }
  assert.equal(app.counter(), "Select 1–24 · 6 selected");
  assert.deepEqual(app.state().filter((row) => row.on).map((row) => row.id),
    ["f3", "f4", "f9", "f12", "f18", "f23"], "the wrong rows ended up selected");
});

test("B7 · deselecting never moves the scroller either", async () => {
  const app = pickerBox({ selected: ["f2", "f6", "f7", "f8"] });
  for (const id of ["f6", "f7"]) {
    await app.tap(app.row(id));
    assert.equal(app.list.scrollTop, 420, `deselecting ${id} jumped`);
  }
  assert.deepEqual(app.state().filter((row) => row.on).map((row) => row.id), ["f2", "f8"]);
  assert.equal(app.counter(), "Select 1–24 · 2 selected");
  for (const id of ["f6", "f7"]) {
    assert.equal(app.row(id).getAttribute("aria-pressed"), "false", `${id} still reads pressed`);
  }
});

test("B7 · selecting and deselecting the same row returns it exactly", async () => {
  const app = pickerBox();
  const before = app.state();
  await app.tap(app.row("f14"));
  await app.tap(app.row("f14"));
  assert.deepEqual(app.state(), before, "a round trip left something behind");
  assert.equal(app.list.scrollTop, 420);
});

// --- 8 · the maximum-selection rule, preserved -----------------------------

test("B8 · the publish gate follows the count, and the position holds", async () => {
  // A pool of three, so min and max are reachable in a couple of taps.
  const small = FIXTURES.slice(0, 3);
  const app = pickerBox({ fixtures: small });
  assert.equal(app.publish().disabled, true, "nothing selected, nothing to publish");
  await app.tap(app.row("f0"));
  assert.equal(app.publish().disabled, false, "one is inside the bounds");
  assert.equal(app.counter(), "Select 1–3 · 1 selected");
  await app.tap(app.row("f1"));
  await app.tap(app.row("f2"));
  assert.equal(app.publish().disabled, false, "the whole pool is the maximum, not over it");
  await app.tap(app.row("f0"));
  await app.tap(app.row("f1"));
  await app.tap(app.row("f2"));
  assert.equal(app.publish().disabled, true, "an empty selection is publishable");
  assert.equal(app.list.scrollTop, 420, "the bounds check moved the page");
  // Accessible state stayed truthful throughout.
  assert.deepEqual(app.state().map((row) => row.aria), ["false", "false", "false"]);
});

test("B8 · the counter and the gate cannot drift from the view that printed them", () => {
  const app = pickerBox();
  const bounds = app.box.pickerBounds(24);
  // The view and the live update read the same two functions.
  const view = sourceOf("fixturePickerView");
  assert.match(view, /pickerCounterLabel\(bounds, count\)/);
  assert.match(view, /pickerReady\(bounds, count\)/);
  const sync = sourceOf("syncPickerCounter");
  assert.match(sync, /pickerCounterLabel\(bounds, count\)/);
  assert.match(sync, /pickerReady\(bounds, count\)/);
  assert.equal(app.box.pickerCounterLabel(bounds, 6), "Select 1–24 · 6 selected");
  assert.equal(app.box.pickerReady(bounds, 0), false);
  assert.equal(app.box.pickerReady(bounds, 24), true);
  assert.equal(app.box.pickerReady(bounds, 25), false, "over the maximum is not ready");
});

// --- 9 · nothing global, nothing on the wire -------------------------------

test("B9 · a selection toggle calls no render and asks the network nothing", async () => {
  const app = pickerBox({ selected: ["f1"] });
  for (const id of ["f2", "f3", "f1", "f2"]) await app.tap(app.row(id));
  assert.equal(app.calls.render, 0, "the selection tap went through the global render path");
  assert.equal(app.calls.api, 0, "the selection tap asked the network something");
});

test("B9 · the handler's selection branch has no render() left in it", () => {
  const handler = sourceOf("handlePickerClick");
  const branch = handler.slice(handler.indexOf('closest("[data-picker-fixture]")'));
  assert.match(branch, /togglePickerFixture\(row\.dataset\.pickerFixture\)/);
  assert.doesNotMatch(branch, /render\(\)/, "the row branch still renders globally");
  // And the targeted path itself never reaches for a rebuild.
  for (const name of ["togglePickerFixture", "markPickerRow", "syncPickerCounter"]) {
    assert.doesNotMatch(sourceOf(name), /\brender\(|renderPickerLayer\(|innerHTML/,
      `${name} rebuilds instead of updating`);
  }
});

// --- 10 · desk timing ------------------------------------------------------

test("B10 · a tap is acknowledged well inside 100ms on a full week", async () => {
  // 60 fixtures is more than any real week offers.
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `g${i}`, player1: `Home ${i}`, player2: `Away ${i}`,
    startAt: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
  }));
  const app = pickerBox({ fixtures: many });
  const worst = [];
  for (const fixture of many) {
    const started = performance.now();
    await app.tap(app.row(fixture.id));
    worst.push(performance.now() - started);
  }
  const slowest = Math.max(...worst);
  assert.ok(slowest < 100, `slowest tap took ${slowest.toFixed(1)}ms`);
  // Reported so the number is in the evidence, not just the threshold.
  console.log(`      B10 · 60 taps, slowest ${slowest.toFixed(2)}ms, median ${
    worst.slice().sort((a, b) => a - b)[Math.floor(worst.length / 2)].toFixed(2)}ms`);
});
