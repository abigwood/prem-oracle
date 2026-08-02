// Behavioural tests for the week strip's anchoring, which lives in app.js.
//
// The rest of the strip is asserted by reading the source, which catches a
// rename but not a wrong answer — and a wrong answer is exactly what shipped
// first time round: offsetLeft was measured against the page rather than the
// strip, so the strip opened at an arbitrary mid-list position. That is a
// maths bug, so it is executed here rather than pattern-matched.
//
// app.js is a browser script, so centreWeekStrip is lifted out by name and run
// against a stub DOM providing only what it touches.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < APP.length; i++) {
    if (APP[i] === "{") { depth++; seen = true; }
    else if (APP[i] === "}") {
      depth--;
      if (seen && depth === 0) return APP.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${startsWith}`);
}

const CHIP = 100;   // chip width, px
const GAP = 8;
const VIEW = 402;   // strip's visible width

/**
 * A strip of `count` chips with the anchor at `anchorIndex`, scrolled to
 * `scrollLeft`. Rects are derived from scrollLeft the way a browser would, so
 * anchoring from an already-scrolled strip is exercised honestly.
 */
function makeStrip({ count, anchorIndex, scrollLeft = 0, clientWidth = VIEW }) {
  const strip = {
    clientWidth,
    scrollLeft,
    getBoundingClientRect: () => ({ left: 0, width: clientWidth }),
    querySelector: () => anchor,
    // Kept so a regression back to offsetLeft would measure the page, not the
    // strip — the exact mistake this test exists to catch.
    offsetLeft: 1000,
  };
  const anchor = {
    clientWidth: CHIP,
    offsetLeft: 1000 + anchorIndex * (CHIP + GAP),
    getBoundingClientRect: () => ({
      left: anchorIndex * (CHIP + GAP) - strip.scrollLeft,
      width: CHIP,
    }),
  };
  strip.chipCount = count;
  return strip;
}

function runCentre(strips) {
  const frames = [];
  const build = new Function("strips", "frames", `
    "use strict";
    const requestAnimationFrame = (fn) => frames.push(fn);
    const document = { querySelectorAll: () => strips };
    ${lift("function centreWeekStrip()")}
    return centreWeekStrip;
  `);
  const centre = build(strips, frames);
  centre();
  frames.forEach((fn) => fn());
  return strips;
}

/** Where the anchor's centre sits relative to the strip's centre, after run. */
const offCentre = (strip, anchorIndex) => {
  const chipCentre = anchorIndex * (CHIP + GAP) + CHIP / 2 - strip.scrollLeft;
  return Math.round(chipCentre - strip.clientWidth / 2);
};

test("the strip anchors the current week in the middle", () => {
  const strip = makeStrip({ count: 38, anchorIndex: 10 });
  runCentre([strip]);
  assert.equal(offCentre(strip, 10), 0, "the green chip is centred");
  assert.ok(strip.scrollLeft > 0, "and the strip has scrolled to get there");
});

test("re-anchors on reopen after the user has scrolled elsewhere", () => {
  // The user has swiped off to the far end of the season.
  const scrolledAway = makeStrip({ count: 38, anchorIndex: 10, scrollLeft: 3000 });
  assert.notEqual(offCentre(scrolledAway, 10), 0, "precondition: not centred");

  runCentre([scrolledAway]);
  assert.equal(offCentre(scrolledAway, 10), 0, "reopening puts the current week back in the middle");

  // And again from the other direction — scrolled behind the current week.
  const scrolledBack = makeStrip({ count: 38, anchorIndex: 10, scrollLeft: 0 });
  runCentre([scrolledBack]);
  const settled = scrolledBack.scrollLeft;
  assert.equal(offCentre(scrolledBack, 10), 0);
  // Anchoring twice is idempotent: a second paint must not drift.
  runCentre([scrolledBack]);
  assert.equal(scrolledBack.scrollLeft, settled, "a second anchor changes nothing");
});

test("anchoring is measured against the strip, not the page", () => {
  // offsetLeft on these stubs is deliberately 1000px out. A regression to
  // offsetLeft-based maths would land the strip a thousand pixels wrong.
  const strip = makeStrip({ count: 38, anchorIndex: 10 });
  runCentre([strip]);
  assert.ok(strip.scrollLeft < 1000, `scrollLeft ${strip.scrollLeft} betrays page-relative maths`);
  assert.equal(offCentre(strip, 10), 0);
});

test("an early week clamps to the start rather than scrolling negative", () => {
  const strip = makeStrip({ count: 38, anchorIndex: 0 });
  runCentre([strip]);
  // The browser clamps a negative assignment to 0; the maths must not depend
  // on that, so assert it never asks for a position past the start.
  assert.ok(strip.scrollLeft <= 0, "week one asks to sit at or before the start");
});

test("a strip with no anchor, or no width yet, is left alone", () => {
  const noAnchor = { clientWidth: VIEW, scrollLeft: 250, querySelector: () => null };
  runCentre([noAnchor]);
  assert.equal(noAnchor.scrollLeft, 250, "nothing to anchor on, nothing touched");

  const unlaidOut = makeStrip({ count: 38, anchorIndex: 10, scrollLeft: 250, clientWidth: 0 });
  runCentre([unlaidOut]);
  assert.equal(unlaidOut.scrollLeft, 250, "a strip with no width waits for a later paint");
});
