// Season League medals: gold, silver and bronze for every member.
//
// The tally rides alongside `wins` rather than replacing it, and it reuses the
// existing podium rules rather than restating them — so these tests are mostly
// about proving the rules still hold once they are counted across a season.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker from "../src/worker.js";
import { computePodiumTotals, computeRoundWins } from "../src/logic.js";

const member = (uid) => ({ uid, nick: uid, since: 0 });
const MEMBERS = ["a", "b", "c", "d"].map(member);

/**
 * One completed week. `scores` maps uid to the points that member should end
 * with, achieved by giving exact picks to the ones who should score.
 */
function week(period, scores, { complete = true } = {}) {
  const fixtures = Array.from({ length: 5 }, (_, i) => ({
    id: `pl-md${period}-${i}`,
    matchday: period,
    startAt: `2026-08-${String(10 + period).padStart(2, "0")}T12:00:00Z`,
    status: complete ? "complete" : "scheduled",
    result: complete ? [1, 0] : null,
  }));
  const picks = {};
  for (const fixture of fixtures) picks[fixture.id] = {};
  // Five exact picks are 25 points, so points/5 exact picks gets the target.
  for (const [uid, points] of Object.entries(scores)) {
    const exact = Math.round(points / 5);
    fixtures.forEach((fixture, i) => {
      picks[fixture.id][uid] = i < exact ? { p1: 1, p2: 0, ts: 1 } : { p1: 4, p2: 4, ts: 1 };
    });
  }
  return { fixtures, picks };
}

function season(weeks, members = MEMBERS) {
  const fixtures = [];
  const picks = {};
  for (const w of weeks) {
    fixtures.push(...w.fixtures);
    Object.assign(picks, w.picks);
  }
  return {
    totals: computePodiumTotals(members, fixtures, picks, {}, (m) => String(m.matchday)),
    wins: computeRoundWins(members, fixtures, picks, {}, (m) => String(m.matchday)),
  };
}

// --- accumulation ------------------------------------------------------------

test("medals accumulate across completed weeks", () => {
  const { totals } = season([
    week(1, { a: 25, b: 20, c: 15, d: 10 }),   // a gold, b silver, c bronze
    week(2, { a: 25, b: 20, c: 15, d: 10 }),
    week(3, { b: 25, a: 20, d: 15, c: 10 }),   // b gold, a silver, d bronze
  ]);
  assert.deepEqual(totals.a, { gold: 2, silver: 1, bronze: 0 });
  assert.deepEqual(totals.b, { gold: 1, silver: 2, bronze: 0 });
  assert.deepEqual(totals.c, { gold: 0, silver: 0, bronze: 2 });
  assert.deepEqual(totals.d, { gold: 0, silver: 0, bronze: 1 });
});

test("gold still matches wins exactly, so the old field keeps its meaning", () => {
  const { totals, wins } = season([
    week(1, { a: 25, b: 20, c: 15, d: 10 }),
    week(2, { b: 25, a: 20, c: 15, d: 10 }),
  ]);
  for (const uid of ["a", "b", "c", "d"]) {
    assert.equal(totals[uid].gold, wins[uid], `gold and wins disagree for ${uid}`);
  }
});

// --- the existing rules, once counted ---------------------------------------

test("a shared place is awarded to everybody who shares it", () => {
  const { totals } = season([week(1, { a: 25, b: 25, c: 15, d: 10 })]);
  assert.equal(totals.a.gold, 1);
  assert.equal(totals.b.gold, 1, "a tie for first is two golds, not a coin toss");
  // Both took first, so the next distinct score is third on count-back.
  assert.equal(totals.a.silver + totals.b.silver, 0);
});

test("a two-player league never invents a bronze", () => {
  const two = [member("a"), member("b")];
  const w = week(1, { a: 25, b: 15 });
  const totals = computePodiumTotals(two, w.fixtures, w.picks, {}, (m) => String(m.matchday));
  assert.deepEqual(totals.a, { gold: 1, silver: 0, bronze: 0 });
  assert.deepEqual(totals.b, { gold: 0, silver: 1, bronze: 0 });
  assert.equal(totals.a.bronze + totals.b.bronze, 0, "there is no third place to award");
});

test("a week nobody scored in awards nothing at all", () => {
  const { totals } = season([week(1, { a: 0, b: 0, c: 0, d: 0 })]);
  for (const uid of ["a", "b", "c", "d"]) {
    assert.deepEqual(totals[uid], { gold: 0, silver: 0, bronze: 0 }, uid);
  }
});

test("an unfinished week awards nothing until it completes", () => {
  const { totals } = season([week(1, { a: 25, b: 20, c: 15 }, { complete: false })]);
  assert.deepEqual(totals.a, { gold: 0, silver: 0, bronze: 0 });
});

test("a joiner's WINNING picks from before they joined award nothing", () => {
  // The weak version of this test gave the joiner no picks at all, which
  // proves nothing about the join-date rule. Here they have the best picks in
  // the league in week 1 — and were not a member when it kicked off.
  const weeks = [
    week(1, { a: 15, b: 10, c: 5, d: 0, late: 25 }),   // late would top week 1...
    week(2, { a: 10, b: 5, c: 0, d: 0, late: 25 }),    // ...and does top week 2
  ];
  const fixtures = weeks.flatMap((w) => w.fixtures);
  const picks = Object.assign({}, ...weeks.map((w) => w.picks));
  // Week 1 kicks off 11 Aug, week 2 on the 12th; they joined between the two.
  const late = { uid: "late", nick: "Late", since: Date.parse("2026-08-12T00:00:00Z") };
  const members = [...MEMBERS, late];
  const totals = computePodiumTotals(members, fixtures, picks, {}, (m) => String(m.matchday));

  assert.equal(totals.late.gold, 1, "the week they were there for counts");
  assert.equal(totals.late.gold + totals.late.silver + totals.late.bronze, 1,
    "and only that one: week 1's winning picks award nothing");

  // Proof the picks really were there and really would have won.
  const beforeOnly = computePodiumTotals(
    [...MEMBERS, { ...late, since: 0 }], fixtures, picks, {}, (m) => String(m.matchday),
  );
  assert.equal(beforeOnly.late.gold, 2, "with no join date those same picks win both weeks");
});

test("every member gets a row, including one who has never placed", () => {
  const { totals } = season([week(1, { a: 25, b: 20, c: 15, d: 0 })]);
  assert.ok("d" in totals, "a member with nothing still has a tally");
  assert.deepEqual(totals.d, { gold: 0, silver: 0, bronze: 0 });
});

test("the tally is one pass, not one per member", () => {
  // Counted by how often the period grouping is asked for the same fixture.
  let touches = 0;
  const w = week(1, { a: 25, b: 20, c: 15, d: 10 });
  computePodiumTotals(MEMBERS, w.fixtures, w.picks, {}, (m) => { touches++; return String(m.matchday); });
  assert.ok(touches <= w.fixtures.length * 2, `walked the fixtures ${touches} times for ${w.fixtures.length}`);
});

// --- the response, and how many passes made it ------------------------------

function memoryKV(store = new Map()) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

test("/state derives wins from the SAME gold total, in one pass", async () => {
  const weeks = [week(1, { host: 25, m1: 20, m2: 15 }), week(2, { host: 25, m1: 20, m2: 15 })];
  // The league is created at wall clock, so its members join NOW; the fixtures
  // are pushed past that rather than pinned to a date this test would outlive.
  const list = weeks.flatMap((w, i) => w.fixtures.map((f) => ({
    ...f, startAt: new Date(Date.now() + (10 + i) * 864e5).toISOString(),
  })));
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: list }), { status: 200 });
  try {
    await worker.fetch(new Request("https://w.test/fixtures?refresh=1"), env);
    const { code } = await (await worker.fetch(new Request("https://w.test/league", {
      method: "POST", body: JSON.stringify({ uid: "host", nickname: "Host", competitions: ["PL"], fixtureMode: "all" }),
    }), env)).json();
    for (const uid of ["m1", "m2"]) {
      await worker.fetch(new Request("https://w.test/join", { method: "POST", body: JSON.stringify({ uid, code, nick: uid }) }), env);
    }
    for (const [id, entry] of Object.entries(Object.assign({}, ...weeks.map((w) => w.picks)))) {
      store.set(`picks:${id}`, JSON.stringify(entry));
    }

    const state = await (await worker.fetch(new Request(`https://w.test/state?code=${code}`), env)).json();
    const host = state.table.find((row) => row.uid === "host");
    assert.ok(host, "the host is in the table");
    assert.deepEqual(host.podiums, { gold: 2, silver: 0, bronze: 0 });
    assert.equal(host.wins, host.podiums.gold, "wins IS the gold total, not a second count");
    for (const row of state.table) {
      assert.equal(row.wins, row.podiums.gold, `wins and gold disagree for ${row.uid}`);
      assert.ok("silver" in row.podiums && "bronze" in row.podiums);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("the /state path no longer runs a second aggregation", () => {
  const src = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function state(env, url"), src.indexOf("async function settle("));
  assert.ok(!fn.includes("computeRoundWins"), "one season pass, not two");
  assert.match(fn, /const medals = computePodiumTotals\(/);
  assert.match(fn, /wins: medals\[row\.uid\]\?\.gold \|\| 0,/);
  // Still exported, because other callers and tests use it.
  assert.equal(typeof computeRoundWins, "function");
});
