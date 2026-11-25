// v1.8.1 — one effective lock for the lock copy and both Edit line-up controls.
//
// A published slate fetched before its lock moment keeps `locked: false` until
// it is refetched. The League card's lock line already read that as locked;
// the two Edit line-up controls (League card, My Picks notice) still offered
// to edit. slateLocked() is now the single answer: the server's flag, or a
// valid lockAt that has passed. These run the REAL functions and read the DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { load, sourceOf } from "./harness.mjs";

const HOUR = 3600000;
const at = (h) => new Date(Date.now() + h * HOUR).toISOString();
const SHAPES = {
  "stale flag, past lockAt": { locked: false, lockAt: at(-0.5) },
  "server flag set": { locked: true, lockAt: at(-2) },
  "still open": { locked: false, lockAt: at(30) },
};
const read = (html) => {
  const d = new JSDOM(`<body>${html}</body>`).window.document;
  return { text: d.body.textContent.replace(/\s+/g, " ").trim(),
    edit: d.querySelector("[data-amend]"), line: d.querySelector(".lock-line") };
};

// --- the League card --------------------------------------------------------------

function leagueCard(slate) {
  const box = load(["hostSlateControl", "lockLine", "slateLocked", "cardLockLine", "weekStatusWord", "lockWeekPrefix", "lockTimeLabel",
    "periodLabel", "periodLabelLong", "isWindowKey"], {
    uid: () => "host", weekNumberFor: () => 13, windowLabel: () => "", weekDateRange: () => "",
  });
  return read(box.hostSlateControl({ code: "AAA", owner: "host", currentPeriod: "13", currentSlate: { period: "13", ...slate } }));
}

test("League card: a stale false flag with a past lockAt reads locked and offers no edit", () => {
  const r = leagueCard(SHAPES["stale flag, past lockAt"]);
  assert.equal(r.text, "Matchweek 13 · line-up locked — the first fixture has kicked off.");
  assert.ok(r.line.classList.contains("is-locked"));
  assert.equal(r.edit, null, "Edit line-up was offered after the lock moment");
});

test("League card: the server flag still locks, and an open week still offers the edit", () => {
  const locked = leagueCard(SHAPES["server flag set"]);
  assert.match(locked.text, /line-up locked/);
  assert.equal(locked.edit, null);
  const open = leagueCard(SHAPES["still open"]);
  assert.match(open.text, /^Matchweek 13 · locks /);
  assert.equal(open.edit?.textContent, "Edit line-up", "an open week lost its edit control");
});

// --- My Picks ----------------------------------------------------------------------

function myPicksNotice(slate, { host = true } = {}) {
  const published = { period: "13", status: "published", fixtureIds: ["a"], ...slate };
  const box = load(["slateNotice", "lockLine", "slateLocked", "lockTimeLabel"], {
    slateForPeriod: () => published,
    isLeagueHost: () => host,
    awaitingSlate: () => false,
    setAndForgetActive: () => false,
    leagueState: { code: "AAA", name: "Burtons Premier" },
  });
  return read(box.slateNotice("13"));
}

test("My Picks: a stale false flag with a past lockAt reads locked and offers no edit", () => {
  const r = myPicksNotice(SHAPES["stale flag, past lockAt"]);
  assert.equal(r.text, "Line-up locked — the first fixture has kicked off.");
  assert.ok(r.line.classList.contains("is-locked"));
  assert.doesNotMatch(r.text, /^Locks /, "a passed lock time was offered as upcoming");
  assert.equal(r.edit, null, "Edit line-up was offered after the lock moment");
});

test("My Picks: the server flag still locks; an open week keeps the host's edit and its deadline", () => {
  const locked = myPicksNotice(SHAPES["server flag set"]);
  assert.match(locked.text, /^Line-up locked/);
  assert.equal(locked.edit, null);
  const open = myPicksNotice(SHAPES["still open"]);
  assert.match(open.text, /^Locks \w{3} \d{1,2} \w{3} at \d{2}:\d{2}/, "My Picks' own wording changed");
  assert.equal(open.edit?.textContent, "Edit line-up");
  // A member never gets the edit, open or not.
  assert.equal(myPicksNotice(SHAPES["still open"], { host: false }).edit, null);
});

// --- one answer ------------------------------------------------------------------------

test("slateLocked is the single answer: flag OR a valid lockAt at or before now", () => {
  const box = load(["slateLocked"], {});
  assert.equal(box.slateLocked(null), false);
  assert.equal(box.slateLocked({ locked: true }), true);
  assert.equal(box.slateLocked({ locked: false, lockAt: at(-0.01) }), true);
  assert.equal(box.slateLocked({ locked: false, lockAt: at(1) }), false);
  assert.equal(box.slateLocked({ locked: false, lockAt: "not a date" }), false, "an unreadable time invents no lock");
  assert.equal(box.slateLocked({ locked: false }), false);
  // Every lock decision in the copy and both edit controls goes through it.
  for (const fn of ["lockLine", "cardLockLine", "slateNotice", "hostSlateControl"]) {
    assert.match(sourceOf(fn), /slateLocked\(/, `${fn} decides "locked" on its own`);
    assert.doesNotMatch(sourceOf(fn), /[.!]locked\b(?!\s*—)|slate\.locked|published\.locked/, `${fn} still reads the bare flag`);
  }
});
