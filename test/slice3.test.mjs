// v1.6.6 Slice 3 — binding acceptance tests W1-W9, F1-F7, A1.
// The movement arithmetic is executed against constructed weeks, because
// "the source says so" is not evidence that a table moved the right way.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, APP, sourceOf } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Every reduced-motion block joined, so a new one cannot hide an older rule. */
const reducedMotionCss = () => CSS.split("@media (prefers-reduced-motion: reduce)")
  .slice(1).map((block) => block.slice(0, block.indexOf("\n}"))).join("\n");

const D7 = ["VOID_STATUSES", "isVoidFixture", "isPostponed", "sharedRankByUid",
  "settlementWindows", "windowPointsByUid", "weeklyMovement", "weeklyMovementBadge"];

const SAT = "2026-09-12T14:00:00Z";
const SAT_LATE = "2026-09-12T16:30:00Z";
const SUN = "2026-09-13T14:00:00Z";

/** A reveal entry: one fixture, its kick-off, and what each player scored. */
const entry = (id, lockAt, points, { voided = false, settled = true } = {}) => ({
  id, lockAt, settled: voided ? false : settled, voided,
  picks: Object.entries(points).map(([uid, pts]) => ({ uid, nick: uid, pts })),
});

const pending = (id, lockAt) => ({ id, lockAt, settled: false, voided: false, picks: [] });

/** A table in the worker's order, so ranks line up with what the panel shows. */
const table = (points) => Object.entries(points)
  .map(([uid, pts]) => ({ uid, nick: uid, pts, exact: 0 }))
  .sort((a, b) => b.pts - a.pts || a.nick.localeCompare(b.nick))
  .map((row, i) => ({ ...row, rank: i + 1 }));

const plain = (v) => JSON.parse(JSON.stringify(v));

const env = (fixtures = {}) => ({ fixtureById: (id) => fixtures[String(id)] || { id, status: "scheduled" } });

// --- W5 / W1 --------------------------------------------------------------

test("W5 · no arrows before the first window completes", () => {
  const s = load(D7, env());
  const reveal = [entry("a", SAT, { u1: 5 }), pending("b", SAT)];
  assert.equal(s.weeklyMovement(table({ u1: 5, u2: 0 }), reveal).size, 0);
});

test("W1 · arrows are the change against the table before the latest window", () => {
  const s = load(D7, env());
  // Window 1 (Sat 14:00): u2 leads 5-0. Window 2 (Sun): u1 takes 7, u2 takes 0.
  const reveal = [
    entry("a", SAT, { u1: 0, u2: 5 }),
    entry("b", SUN, { u1: 7, u2: 0 }),
  ];
  const move = s.weeklyMovement(table({ u1: 7, u2: 5 }), reveal);
  assert.equal(move.get("u1"), 1, "u1 went 2nd -> 1st");
  assert.equal(move.get("u2"), -1, "u2 went 1st -> 2nd");
});

test("W1 · a player whose position did not change gets no movement", () => {
  const s = load(D7, env());
  const reveal = [
    entry("a", SAT, { u1: 5, u2: 0, u3: 0 }),
    entry("b", SUN, { u1: 1, u2: 1, u3: 1 }),
  ];
  const move = s.weeklyMovement(table({ u1: 6, u2: 1, u3: 1 }), reveal);
  assert.equal(move.get("u1"), 0);
});

// --- W2 -------------------------------------------------------------------

test("W2 · same-slot fixtures settling apart make ONE update, not three", () => {
  const s = load(D7, env());
  const full = [
    entry("a", SAT, { u1: 5, u2: 0 }),
    entry("b", SAT, { u1: 0, u2: 5 }),
    entry("c", SAT, { u1: 0, u2: 5 }),
  ];
  // Two of the three have landed: the window is not complete, so nothing moves.
  const partial = [full[0], full[1], pending("c", SAT)];
  assert.equal(s.weeklyMovement(table({ u1: 5, u2: 5 }), partial).size, 0,
    "the table moved before the window finished");
  // The last one lands and the whole window resolves in a single step.
  const move = s.weeklyMovement(table({ u1: 5, u2: 10 }), full);
  assert.ok(move.size > 0);
  assert.equal(move.get("u2"), 0, "u2 was already level-or-top before this week");
});

// --- W3 -------------------------------------------------------------------

test("W3 · tied players share a rank", () => {
  const s = load(D7, env());
  const ranks = s.sharedRankByUid([{ uid: "a", pts: 5 }, { uid: "b", pts: 5 }, { uid: "c", pts: 1 }]);
  assert.equal(ranks.get("a"), 1);
  assert.equal(ranks.get("b"), 1);
  assert.equal(ranks.get("c"), 3);
});

test("W3 · a dash unless the position actually changed", () => {
  const s = load(D7, env());
  assert.match(s.weeklyMovementBadge(0), /–/);
  assert.match(s.weeklyMovementBadge(0), /aria-label="No change"/);
});

// --- W4 / W7 --------------------------------------------------------------

test("W4 · the same inputs give the same arrows every time", () => {
  const reveal = [entry("a", SAT, { u1: 0, u2: 5 }), entry("b", SUN, { u1: 7, u2: 0 })];
  const rows = table({ u1: 7, u2: 5 });
  const first = load(D7, env()).weeklyMovement(rows, reveal);
  const second = load(D7, env()).weeklyMovement(rows, reveal);  // a "fresh install"
  assert.deepEqual(plain([...first.entries()].sort()), plain([...second.entries()].sort()));
});

test("W4 · movement is never read from or written to storage", () => {
  for (const name of ["settlementWindows", "windowPointsByUid", "weeklyMovement"]) {
    const src = sourceOf(name);
    assert.ok(!src.includes("localStorage"), `${name} touches storage`);
    assert.ok(!/\bapi\(|fetch\(/.test(src), `${name} makes a request`);
  }
  assert.ok(!APP.includes("prem_oracle_movement"));
});

test("W7 · drawing the weekly table asks for nothing new", () => {
  const src = sourceOf("roundTableHtml");
  assert.ok(!/\bapi\(|fetch\(/.test(src));
  // It reads the round it was handed, and nothing else.
  assert.match(src, /weeklyMovement\(round\.table, round\.reveal, slateIds\)/);
});

// --- W6 -------------------------------------------------------------------

test("W6 · the final window's arrows stay up for the rest of the week", () => {
  const s = load(D7, env());
  const reveal = [entry("a", SAT, { u1: 0, u2: 5 }), entry("b", SUN, { u1: 7, u2: 0 })];
  const move = s.weeklyMovement(table({ u1: 7, u2: 5 }), reveal);
  // Nothing else settles; recomputing later is the same call and the same answer.
  assert.equal(move.get("u1"), 1);
  assert.equal(s.weeklyMovement(table({ u1: 7, u2: 5 }), reveal).get("u1"), 1);
});

// --- W8 -------------------------------------------------------------------

test("W8 · movement is scoped to the slate", () => {
  const s = load(D7, env());
  const reveal = [
    entry("in", SAT, { u1: 0, u2: 5 }),
    entry("out", SAT_LATE, { u1: 99, u2: 0 }),   // not in this league's slate
  ];
  const windows = s.settlementWindows(reveal, new Set(["in"]));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].entries[0].id, "in");
});

// --- W9 -------------------------------------------------------------------

test("W9 · a postponed fixture does not block its window", () => {
  const s = load(D7, env({ p: { id: "p", status: "postponed" } }));
  const reveal = [entry("a", SAT, { u1: 5, u2: 0 }), pending("p", SAT)];
  const windows = s.settlementWindows(reveal);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].entries.length, 1, "the postponed fixture stayed in the window");
  assert.equal(windows[0].complete, true, "a postponed fixture blocked a finished window");
});

test("W9 · a rescheduled fixture joins the window of its NEW kick-off", () => {
  const s = load(D7, env());
  // Was Saturday, now Sunday: its entry carries the new lock time, and it lands
  // in the Sunday window without any special case.
  const reveal = [
    entry("a", SAT, { u1: 5, u2: 0 }),
    entry("moved", SUN, { u1: 0, u2: 5 }),
    entry("c", SUN, { u1: 0, u2: 1 }),
  ];
  const windows = s.settlementWindows(reveal);
  assert.deepEqual(plain(windows.map((w) => w.kickoff)), [SAT, SUN]);
  assert.deepEqual(plain(windows[1].entries.map((e) => e.id).sort()), ["c", "moved"]);
});

test("W9 · a VOID fixture is terminal for its window", () => {
  const s = load(D7, env({ v: { id: "v", status: "abandoned" } }));
  const reveal = [entry("a", SAT, { u1: 5 }), entry("v", SAT, {}, { voided: true })];
  const windows = s.settlementWindows(reveal);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].entries.length, 2, "the void fixture left the window");
  assert.equal(windows[0].complete, true, "a void fixture failed to be terminal");
});

test("W9 · a void fixture pays nobody", () => {
  const s = load(D7, env());
  const points = s.windowPointsByUid({
    entries: [entry("a", SAT, { u1: 5 }), entry("v", SAT, { u1: 99 }, { voided: true })],
  });
  assert.equal(points.get("u1"), 5);
});

// --- A1 -------------------------------------------------------------------

test("A1 · movement is shape plus words, never colour alone", () => {
  const s = load(D7, env());
  assert.match(s.weeklyMovementBadge(3), /▲/);
  assert.match(s.weeklyMovementBadge(3), /aria-label="Up 3 places"/);
  assert.match(s.weeklyMovementBadge(1), /aria-label="Up 1 place"/);
  assert.match(s.weeklyMovementBadge(-2), /▼/);
  assert.match(s.weeklyMovementBadge(-2), /aria-label="Down 2 places"/);
  assert.match(s.weeklyMovementBadge(-1), /aria-label="Down 1 place"/);
  assert.match(s.weeklyMovementBadge(0), /aria-label="No change"/);
  for (const value of [3, -2, 0]) assert.match(s.weeklyMovementBadge(value), /role="img"/);
});

test("A1 · the three glyphs are distinguishable without colour", () => {
  const s = load(D7, env());
  const glyphs = [3, -2, 0].map((v) => s.weeklyMovementBadge(v).match(/>([^<]+)<\/span>/)[1]);
  assert.equal(new Set(glyphs).size, 3);
  // Colour is applied on top of the shape, not instead of it.
  assert.match(CSS, /\.round-standings \.movement-up \{ color: var\(--green\); \}/);
  assert.match(CSS, /\.round-standings \.movement-down \{ color: var\(--danger\); \}/);
});

// --- F1 / F2 --------------------------------------------------------------

test("F2 · the current week is per league, not per app", () => {
  const s = load(["currentPickPeriod", "isCurrentPickWeek"], {
    leagueState: { code: "AAA", currentPeriod: 7 },
    leagueStates: { BBB: { code: "BBB", currentPeriod: "w2026-09-08" } },
  });
  assert.equal(s.currentPickPeriod("AAA"), 7);
  assert.equal(s.currentPickPeriod("BBB"), "w2026-09-08");
  assert.equal(s.isCurrentPickWeek("AAA", 7), true);
  assert.equal(s.isCurrentPickWeek("AAA", 6), false);
  assert.equal(s.isCurrentPickWeek("BBB", "w2026-09-08"), true);
});

test("F1 · past weeks fold to a row and only the current week stays open", () => {
  const body = sourceOf("pickSection");
  assert.match(body, /isCurrentPickWeek\(code, group\.period\)/);
  assert.match(body, /: pickWeekRow\(group, code, body\);/);
  // The open week keeps the plain container it always had.
  assert.match(body, /<div class="pick-week">/);
});

// --- F3 -------------------------------------------------------------------

test("F3 · a summary row carries the week's points and its recorded medal", () => {
  const s = load(["pickWeekKey", "pickWeekSummary", "pickWeekRow"], {
    PLACE_EMOJI: { gold: "🏆", silver: "🥈", bronze: "🥉" },
    openPickWeeks: new Set(),
    leagueState: {
      code: "AAA",
      cabinet: { weeks: [
        { period: 6, pts: 12, place: "silver" },
        { period: 5, pts: 3, place: null },
      ] },
    },
  });
  assert.deepEqual({ ...s.pickWeekSummary("AAA", 6) }, { pts: 12, place: "silver" });
  const row = s.pickWeekRow({ period: 6, label: "Matchweek 6", matches: [] }, "AAA", "<cards>");
  assert.match(row, /Matchweek 6/);
  assert.match(row, /12 points/);
  assert.match(row, /🥈/);
});

test("F3 · a week with no medal shows none, rather than an empty slot", () => {
  const s = load(["pickWeekKey", "pickWeekSummary", "pickWeekRow"], {
    PLACE_EMOJI: { gold: "🏆", silver: "🥈", bronze: "🥉" },
    openPickWeeks: new Set(),
    leagueState: { code: "AAA", cabinet: { weeks: [{ period: 5, pts: 1, place: null }] } },
  });
  const row = s.pickWeekRow({ period: 5, label: "Matchweek 5", matches: [] }, "AAA", "");
  assert.match(row, /1 point<\/span>/);
  assert.ok(!row.includes("crown"));
  assert.ok(!/🏆|🥈|🥉/.test(row));
});

test("F3 · a week the cabinet does not know shows no invented score", () => {
  const s = load(["pickWeekKey", "pickWeekSummary", "pickWeekRow"], {
    PLACE_EMOJI: {}, openPickWeeks: new Set(),
    leagueState: { code: "AAA", cabinet: { weeks: [] } },
  });
  assert.deepEqual({ ...s.pickWeekSummary("AAA", 9) }, { pts: null, place: null });
  const row = s.pickWeekRow({ period: 9, label: "Matchweek 9", matches: [] }, "AAA", "");
  assert.ok(!/\d+ points?/.test(row));
});

// --- F4 -------------------------------------------------------------------

test("F4 · expansion state is keyed by league code and period", () => {
  const s = load(["pickWeekKey"]);
  assert.equal(s.pickWeekKey("AAA", 6), "AAA:6");
  assert.equal(s.pickWeekKey("BBB", 6), "BBB:6");
  assert.equal(s.pickWeekKey(null, 6), "__other:6");
  assert.notEqual(s.pickWeekKey("AAA", 6), s.pickWeekKey("BBB", 6));
});

test("F4 · an opened week renders open and the tap is persisted", () => {
  const s = load(["pickWeekKey", "pickWeekSummary", "pickWeekRow"], {
    PLACE_EMOJI: {}, openPickWeeks: new Set(["AAA:6"]),
    leagueState: { code: "AAA", cabinet: { weeks: [] } },
  });
  assert.match(s.pickWeekRow({ period: 6, label: "Matchweek 6", matches: [] }, "AAA", ""),
    /data-pick-week="AAA:6" open>/);
  assert.match(APP, /openPickWeeks\.add\(key\);/);
  assert.match(APP, /openPickWeeks\.delete\(key\);/);
  assert.match(APP, /pickWeeks: "prem_oracle_pick_weeks",/);
});

// --- F5 -------------------------------------------------------------------

test("F5 · a finished week folds as a unit at rollover", () => {
  const s = load(["currentPickPeriod", "isCurrentPickWeek"], {
    leagueState: { code: "AAA", currentPeriod: 7 }, leagueStates: {},
  });
  // Week 6 was current last week and is not now: every fixture in it folds
  // together, because the whole group is drawn by one branch.
  assert.equal(s.isCurrentPickWeek("AAA", 6), false);
  assert.equal(s.isCurrentPickWeek("AAA", 7), true);
});

test("F5 · obsolete expansion state is ignored and pruned", () => {
  // A key for a league this device no longer plays is dropped on the next write.
  const src = sourceOf("persistPickWeeks");
  assert.match(src, /const live = new Set\(\[\.\.\.leagueCodes, "__other"\]\);/);
  assert.match(src, /if \(!live\.has\(key\.slice\(0, key\.lastIndexOf\(":"\)\)\)\) openPickWeeks\.delete\(key\);/);
  // And a stale key for a week that is current again cannot open a folded row,
  // because the current week is never drawn as one.
  assert.match(sourceOf("pickSection"), /isCurrentPickWeek\(code, group\.period\)/);
});

// --- F6 -------------------------------------------------------------------

test("F6 · folding never deletes: every historic pick is still rendered", () => {
  const s = load(["pickWeekKey", "pickWeekSummary", "pickWeekRow"], {
    PLACE_EMOJI: {}, openPickWeeks: new Set(),
    leagueState: { code: "AAA", cabinet: { weeks: [] } },
  });
  const row = s.pickWeekRow({ period: 4, label: "Matchweek 4", matches: [] }, "AAA",
    "<article>pick-1</article><article>pick-2</article>");
  assert.match(row, /pick-1/);
  assert.match(row, /pick-2/);
  // A closed <details> still holds its content; nothing was dropped to fold it.
  assert.ok(!row.includes(" open>"));
  const section = sourceOf("pickSection");
  assert.ok(!section.includes(".slice("), "the section truncates weeks");
  assert.ok(!/\.filter\(.*period/.test(section), "the section drops weeks");
});

// --- F7 -------------------------------------------------------------------

test("F7 · expanding a week asks for nothing", () => {
  for (const name of ["pickWeekRow", "pickWeekSummary", "pickSection", "persistPickWeeks"]) {
    const src = sourceOf(name);
    assert.ok(!/\bapi\(|fetch\(|loadRoundState|loadLeagueState/.test(src),
      `${name} makes a request`);
  }
  // The summary reads the cabinet the league state already carries.
  assert.match(sourceOf("pickWeekSummary"), /state\?\.cabinet\?\.weeks/);
  // And the toggle handler only records the tap.
  const toggle = APP.slice(APP.indexOf('const week = event.target.closest?.("[data-pick-week]");'));
  const body = toggle.slice(0, toggle.indexOf("const settings ="));
  assert.ok(!/\bapi\(|fetch\(|render\(/.test(body));
});

// --- A2 (folding half) ----------------------------------------------------

test("A2 · a folded week is a real disclosure widget", () => {
  const row = sourceOf("pickWeekRow");
  assert.match(row, /<details class="pick-week pick-week-folded" data-pick-week=/);
  assert.match(row, /<summary class="pick-week-summary">/);
  assert.match(reducedMotionCss(), /\.pick-week-summary::after \{ transition: none; \}/);
});

test("W7 · a round with no reveal draws no arrows and does not throw", () => {
  const s = load(D7, env());
  // A non-member response, or a 1.6.4-era cached round, simply has no reveal.
  for (const reveal of [undefined, null, []]) {
    assert.equal(s.weeklyMovement(table({ u1: 5, u2: 1 }), reveal).size, 0);
  }
  assert.equal(s.weeklyMovement([], [entry("a", SAT, { u1: 5 })]).size, 0);
});
