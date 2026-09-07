// Adam's v1.7 UX rider, part A: the Weekly dropdown opens on the week you are
// actually on.
//
// The strip has always MARKED the right chip. What it never did was scroll to
// it: `centreWeekStrip` was only ever called from the global render path, so a
// dropdown built into the picker island opened at Week 1 — in March.
import test from "node:test";
import assert from "node:assert/strict";
import { load, sourceOf } from "./harness.mjs";

/**
 * A strip that can be measured. Real layout is the one thing jsdom will not
 * give us, so the widths and rects are declared and the scroller is watched.
 */
function strip({ chips, anchor, width = 360, chipWidth = 96, gap = 8, laidOut = true }) {
  // A scroller clamps: no browser lets scrollLeft go negative or past the end.
  let scrolled = 0;
  const content = chips.length * (chipWidth + gap) - gap;
  const node = {
    className: "week-strip",
    get scrollLeft() { return scrolled; },
    set scrollLeft(value) {
      scrolled = Math.max(0, Math.min(value, Math.max(0, content - (laidOut ? width : 0))));
    },
    get clientWidth() { return laidOut ? width : 0; },
    getBoundingClientRect: () => ({ left: 0, width: laidOut ? width : 0 }),
    querySelector(selector) {
      if (selector !== "[data-week-anchor]") return null;
      const index = chips.indexOf(anchor);
      if (index < 0) return null;
      // Where that chip sits in the strip's own coordinates, offset by however
      // far the strip is currently scrolled.
      return {
        getBoundingClientRect: () => ({
          left: index * (chipWidth + gap) - node.scrollLeft,
          width: chipWidth,
        }),
      };
    },
  };
  return node;
}

/** A sandbox whose rAF runs on demand, so "after paint" is a thing we can do. */
function stripBox(strips, over = {}) {
  const frames = [];
  const box = load(["centreWeekStrip", "CENTRE_ATTEMPTS", "weekAnchorPeriod", "weekStrip"], {
    document: { querySelectorAll: (selector) => (selector === ".week-strip" ? strips : []) },
    // The weeks themselves are somebody else's test. What matters here is which
    // of them the strip opens on.
    periodsInOrder: () => Array.from({ length: 30 }, (_, i) => String(i + 1)),
    comparePeriods: (a, b) => Number(a) - Number(b),
    isWindowKey: () => false,
    periodLabel: (period) => `Matchweek ${period}`,
    WEEK_CONVENTION: "",
    weekDateRange: () => "",
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    currentPeriodKey: () => "1",
    leagueState: null,
    ...over,
  });
  box.paint = (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      const due = frames.splice(0, frames.length);
      due.forEach((fn) => fn());
    }
  };
  box.pending = () => frames.length;
  return box;
}

// --- 1 · a later active week is brought into view --------------------------

test("A1 · the first open at a later active week does not start at Week 1", () => {
  const chips = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const one = strip({ chips, anchor: "1" });
  const nineteen = strip({ chips, anchor: "19" });
  const box = stripBox([one, nineteen]);
  box.centreWeekStrip();
  box.paint();
  assert.equal(one.scrollLeft, 0, "week 1 is already at the leading edge");
  assert.ok(nineteen.scrollLeft > 0, "the strip never moved off Week 1");
  // Centred on the anchor: the chip's middle sits on the strip's middle.
  const centre = chips.indexOf("19") * (96 + 8) + 96 / 2 - nineteen.scrollLeft;
  assert.ok(Math.abs(centre - 360 / 2) < 1, `the chip landed at ${centre}, not the middle`);
});

test("A1 · the strip moves its own scroller, never the page", () => {
  const source = sourceOf("centreWeekStrip");
  assert.match(source, /strip\.scrollLeft \+=/, "the strip's own coordinates");
  assert.doesNotMatch(source, /scrollIntoView/, "scrollIntoView would drag the page too");
  assert.match(source, /getBoundingClientRect/, "measured from rects, not offsetLeft");
  assert.doesNotMatch(source, /offsetLeft/, "offsetLeft measures against the page");
});

test("A1 · opening the dropdown anchors the strip it just built", () => {
  const source = sourceOf("toggleWeeklyPicker");
  // Both paths: the one that builds a strip and the one that re-attaches a
  // retained one, which comes back with its scroller at zero.
  assert.equal((source.match(/centreWeekStrip\(\)/g) || []).length, 2,
    "a picker path was left unanchored");
  assert.ok(source.indexOf("centreWeekStrip()") < source.indexOf("picker-built"),
    "the strip is anchored as it is inserted");
});

// --- 2 · a deliberate historic selection is kept and shown ------------------

test("A2 · a valid historic selection is retained and brought into view", () => {
  const chips = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const box = stripBox([]);
  assert.equal(box.weekAnchorPeriod(chips, "6", "19"), "6", "the chosen week loses to the current one");
  const chosen = strip({ chips, anchor: "6" });
  const shown = stripBox([chosen]);
  shown.centreWeekStrip();
  shown.paint();
  assert.ok(chosen.scrollLeft > 0, "the chosen week was left off screen");
  const centre = 5 * (96 + 8) + 96 / 2 - chosen.scrollLeft;
  assert.ok(Math.abs(centre - 180) < 1, "the chosen week is not centred");
});

test("A2 · the strip marks and anchors the same chip", () => {
  const box = stripBox([], { currentPeriodKey: () => "19",
    leagueState: { currentPeriod: "19" } });
  const html = box.weekStrip("6", "data-round-md");
  const rows = html.split("<button").filter((chunk) => chunk.includes("data-round-md"));
  const selected = rows.filter((chunk) => chunk.includes("is-selected"));
  const anchored = rows.filter((chunk) => chunk.includes("data-week-anchor"));
  assert.equal(selected.length, 1, "exactly one chip is selected");
  assert.equal(anchored.length, 1, "exactly one chip is anchored");
  assert.equal(selected[0], anchored[0], "the marked chip is not the one scrolled to");
  assert.match(selected[0], /data-round-md="6"/);
  // And the current week is still identifiable, just not the anchor.
  assert.equal(rows.filter((chunk) => chunk.includes("is-current")).length, 1);
});

// --- 3 · a selection that is not real falls back to now --------------------

test("A3 · a missing, invalid or obsolete selection returns to the current week", () => {
  const box = stripBox([]);
  const chips = ["5", "6", "7", "8"];
  for (const [label, selected] of [
    ["missing", null],
    ["undefined", undefined],
    ["obsolete — trimmed from the board", "2"],
    ["from another league entirely", "31"],
    ["not a period at all", "banana"],
  ]) {
    assert.equal(box.weekAnchorPeriod(chips, selected, "7"), "7", `${label} should fall back`);
  }
  // And if even the current week is not on the strip, the first chip is.
  assert.equal(box.weekAnchorPeriod(chips, null, "99"), "5");
});

test("A3 · the fallback shows in the markup, not just the helper", () => {
  const box = stripBox([], { currentPeriodKey: () => "7", leagueState: { currentPeriod: "7" } });
  const html = box.weekStrip("999", "data-round-md");
  const anchored = html.split("<button").filter((chunk) => chunk.includes("data-week-anchor"));
  assert.equal(anchored.length, 1);
  assert.match(anchored[0], /data-round-md="7"/, "an obsolete selection anchored the strip");
});

// --- 4 · opening before layout is ready ------------------------------------

test("A4 · a strip with no width yet is anchored by a later paint", () => {
  const chips = Array.from({ length: 30 }, (_, i) => String(i + 1));
  let laidOut = false;
  const late = strip({ chips, anchor: "19", laidOut: false });
  Object.defineProperty(late, "clientWidth", { get: () => (laidOut ? 360 : 0) });
  const box = stripBox([late]);
  box.centreWeekStrip();
  box.paint();
  assert.equal(late.scrollLeft, 0, "an unlaid strip was given a nonsense offset");
  assert.ok(box.pending() > 0, "nothing was queued to try again after layout");
  laidOut = true;
  box.paint();
  assert.ok(late.scrollLeft > 0, "the strip was never anchored once it had a width");
});

test("A4 · retrying is bounded, so a hidden strip does not loop forever", () => {
  const chips = ["1", "2", "3"];
  const hidden = strip({ chips, anchor: "3", laidOut: false });
  const box = stripBox([hidden]);
  box.centreWeekStrip();
  for (let i = 0; i < box.CENTRE_ATTEMPTS + 3; i += 1) box.paint();
  assert.equal(hidden.scrollLeft, 0);
  assert.equal(box.pending(), 0, "the retry never gave up");
});

test("A4 · a strip with no anchor chip is left exactly where it is", () => {
  const chips = ["1", "2", "3"];
  const orphan = strip({ chips, anchor: "nope", width: 100 });
  orphan.scrollLeft = 140;
  const box = stripBox([orphan]);
  box.centreWeekStrip();
  box.paint(3);
  assert.equal(orphan.scrollLeft, 140, "a strip with nothing to anchor to was moved anyway");
  assert.equal(box.pending(), 0, "and it queued pointless retries");
});

// --- the weeks themselves are untouched ------------------------------------

test("A · no week is reordered, added or removed by anchoring", () => {
  const box = stripBox([], { currentPeriodKey: () => "19", leagueState: { currentPeriod: "19" } });
  const order = (selected) => box.weekStrip(selected, "data-round-md")
    .split("<button").slice(1)
    .map((chunk) => /data-round-md="([^"]+)"/.exec(chunk)?.[1]);
  const base = order("19");
  assert.ok(base.length > 1, "the strip has weeks on it");
  assert.deepEqual(order("6"), base, "choosing a historic week reordered the strip");
  assert.deepEqual(order(null), base, "an empty selection reordered the strip");
  assert.deepEqual(order("999"), base, "an obsolete selection reordered the strip");
});
