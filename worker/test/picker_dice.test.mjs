// Behavioural tests for the two picker functions that live in app.js.
//
// Everything else about the picker is asserted by reading the source, which
// catches a rename but not a wrong answer. These two carry real rules — the
// dice must cover every competition it can, honour the count the host dialled,
// and never fail when a competition is dark — so they are executed rather than
// pattern-matched. app.js is a browser script, so the functions under test are
// lifted out by name and evaluated with the handful of globals they close over.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

/** Slices a top-level declaration out of app.js by its opening line. */
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

// `leagueState` is the only mutable global these read; the rest are constants.
const harness = new Function(`
  "use strict";
  let leagueState = null;
  const DEFAULT_COMPETITION = "PL";
  const SURPRISE_COUNT = 8;
  const MIN_FIXTURE_LIMIT = 3;
  ${lift("const competitionOfFixture = (id) =>")}
  ${lift("function pickerBounds(poolSize)")}
  ${lift("const shuffled = (list) =>")}
  ${lift("function surpriseSelection(list, wanted)")}
  return {
    setLeague: (value) => { leagueState = value; },
    pickerBounds,
    surpriseSelection,
    competitionOfFixture,
  };
`)();

const fixture = (id) => ({ id, startAt: "2026-08-15T14:00:00+01:00" });
const pool = (pl, elc) => [
  ...Array.from({ length: pl }, (_, i) => fixture(`pl-2026-27-${i}-a-b`)),
  ...Array.from({ length: elc }, (_, i) => fixture(`elc-2026-27-${i}-c-d`)),
];
const competitionsIn = (ids) => new Set([...ids].map(harness.competitionOfFixture));

// --- bounds -----------------------------------------------------------------

test("the league default opens the week but never caps it", () => {
  harness.setLeague({ fixtureMode: "limited", fixtureLimit: 6 });
  const bounds = harness.pickerBounds(17);
  assert.equal(bounds.default, 6, "opens on the league default");
  assert.equal(bounds.min, 3, "the host may go down to three");
  assert.equal(bounds.max, 17, "or take the whole pool");
  assert.equal(bounds.capped, false);
});

test("a short week caps the default and says it was capped", () => {
  harness.setLeague({ fixtureMode: "limited", fixtureLimit: 8 });
  const bounds = harness.pickerBounds(5);
  assert.deepEqual([bounds.default, bounds.min, bounds.max, bounds.capped], [5, 3, 5, true]);
});

test("a pool below the floor collapses the range onto it rather than erroring", () => {
  harness.setLeague({ fixtureMode: "limited", fixtureLimit: 8 });
  assert.deepEqual(
    (({ default: d, min, max }) => [d, min, max])(harness.pickerBounds(2)),
    [2, 2, 2]
  );
});

test("an all-fixtures league has no range at all", () => {
  harness.setLeague({ fixtureMode: "all" });
  const bounds = harness.pickerBounds(12);
  assert.deepEqual([bounds.mode, bounds.default, bounds.min, bounds.max], ["all", 12, 12, 12]);
});

test("a league with no stored preference opens on the standard default", () => {
  harness.setLeague({ fixtureMode: "limited", fixtureLimit: null });
  assert.equal(harness.pickerBounds(17).default, 8);
});

// --- the dice ---------------------------------------------------------------

test("the dice deals exactly the count it is asked for", () => {
  const list = pool(10, 7);
  for (const wanted of [3, 6, 8, 17]) {
    assert.equal(harness.surpriseSelection(list, wanted).size, wanted, `asked for ${wanted}`);
  }
});

test("the dice covers every competition present, over many rolls", () => {
  const list = pool(10, 7);
  // Smallest interesting case: two competitions, three slots.
  for (let roll = 0; roll < 200; roll++) {
    const picked = harness.surpriseSelection(list, 3);
    assert.equal(picked.size, 3);
    assert.deepEqual([...competitionsIn(picked)].sort(), ["ELC", "PL"],
      "every roll includes at least one from each");
  }
});

test("a dark competition is filled from the other, never an error", () => {
  const elcOnly = pool(0, 6);
  const picked = harness.surpriseSelection(elcOnly, 4);
  assert.equal(picked.size, 4);
  assert.deepEqual([...competitionsIn(picked)], ["ELC"]);

  const plOnly = pool(6, 0);
  assert.deepEqual([...competitionsIn(harness.surpriseSelection(plOnly, 4))], ["PL"]);
});

test("the dice never exceeds the pool, and never returns nothing", () => {
  const tiny = pool(1, 1);
  assert.equal(harness.surpriseSelection(tiny, 8).size, 2, "asked for more than exists");
  assert.equal(harness.surpriseSelection(pool(1, 0), 5).size, 1);
  // A count of zero is unreachable from the app — the caller substitutes the
  // league default before calling — so the guard falls back to the standard
  // default rather than dealing an empty slate.
  assert.equal(harness.surpriseSelection(tiny, 0).size, 2, "zero falls back, capped by the pool");
  assert.equal(harness.surpriseSelection(pool(10, 7), 0).size, 8, "and that fallback is the standard default");
});

test("one slot cannot cover two competitions, and does not try", () => {
  const list = pool(4, 4);
  const picked = harness.surpriseSelection(list, 1);
  assert.equal(picked.size, 1, "the count wins over the coverage guarantee");
});

test("the dice actually varies", () => {
  const list = pool(10, 7);
  const seen = new Set();
  for (let roll = 0; roll < 60; roll++) {
    seen.add([...harness.surpriseSelection(list, 6)].sort().join(","));
  }
  assert.ok(seen.size > 1, "60 rolls produced more than one slate");
});

test("no fixture is ever dealt twice", () => {
  const list = pool(10, 7);
  for (let roll = 0; roll < 100; roll++) {
    const picked = [...harness.surpriseSelection(list, 9)];
    assert.equal(new Set(picked).size, picked.length);
    assert.ok(picked.every((id) => list.some((entry) => entry.id === id)), "only real fixtures");
  }
});
