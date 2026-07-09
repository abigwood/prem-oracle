import test from "node:test";
import assert from "node:assert/strict";
import { buildReveals, computeTable, computeTableWithMovement, fixturesNeedingNotification, normaliseResult, scorePick, validFootballScore, windowState } from "../src/logic.js";

test("football scores validate from 0-0 to 9-9", () => {
  assert.equal(validFootballScore(0, 0), true);
  assert.equal(validFootballScore(3, 2), true);
  assert.equal(validFootballScore(9, 9), true);
  assert.equal(validFootballScore(10, 0), false);
  assert.equal(validFootballScore(-1, 1), false);
});

test("window is open strictly before scheduled start", () => {
  assert.equal(windowState(1000, 999), "open");
  assert.equal(windowState(1000, 1000), "shut");
});

test("football scoring is 5 exact, 2 draw or goal difference, 1 winner", () => {
  assert.deepEqual(scorePick({ p1: 3, p2: 1 }, { p1: 3, p2: 1 }).pts, 5);
  assert.deepEqual(scorePick({ p1: 1, p2: 1 }, { p1: 2, p2: 2 }).pts, 2);
  assert.deepEqual(scorePick({ p1: 2, p2: 0 }, { p1: 3, p2: 1 }).pts, 2);
  assert.deepEqual(scorePick({ p1: 3, p2: 0 }, { p1: 3, p2: 2 }).pts, 1);
  assert.deepEqual(scorePick({ p1: 3, p2: 2 }, { p1: 1, p2: 3 }).pts, 0);
});

test("football results normalise without tennis caps", () => {
  assert.deepEqual(normaliseResult({ tour: "prem", result: [3, 0] }), { p1: 3, p2: 0 });
  assert.deepEqual(normaliseResult({ tour: "prem", result: { p1: 0, p2: 3 } }), { p1: 0, p2: 3 });
  assert.deepEqual(normaliseResult({ tour: "prem", result: [9, 9] }), { p1: 9, p2: 9 });
  assert.equal(normaliseResult({ tour: "prem", result: [10, 0] }), null);
});

test("standings reject post-start picks and sort by points", () => {
  const members = [{ uid: "a", nick: "Adam", since: 0 }, { uid: "b", nick: "Ben", since: 0 }];
  const completed = [{ id: "m1", startMs: 1000, result: { p1: 3, p2: 1 }, voided: false }];
  const picks = { m1: { a: { p1: 3, p2: 1, ts: 999 }, b: { p1: 3, p2: 1, ts: 1000 } } };
  const rows = computeTable(members, completed, picks);
  assert.equal(rows[0].nick, "Adam");
  assert.equal(rows[0].pts, 5);
  assert.equal(rows[1].pts, 0);
});

test("standings include movement after the latest completed match", () => {
  const members = [{ uid: "a", nick: "Adam", since: 0 }, { uid: "b", nick: "Ben", since: 0 }, { uid: "c", nick: "Aaron", since: 0 }];
  const completed = [
    { id: "m1", startMs: 1000, result: { p1: 2, p2: 0 }, voided: false },
    { id: "m2", startMs: 2000, result: { p1: 0, p2: 2 }, voided: false },
  ];
  const picks = {
    m1: {
      a: { p1: 2, p2: 0, ts: 900 },
      b: { p1: 2, p2: 1, ts: 900 },
      c: { p1: 0, p2: 2, ts: 900 },
    },
    m2: {
      a: { p1: 2, p2: 0, ts: 1900 },
      b: { p1: 0, p2: 2, ts: 1900 },
      c: { p1: 0, p2: 2, ts: 1900 },
    },
  };
  const rows = computeTableWithMovement(members, completed, picks);
  assert.deepEqual(rows.map((row) => [row.nick, row.rank, row.previousRank, row.movement]), [
    ["Ben", 1, 2, 1],
    ["Aaron", 2, 3, 1],
    ["Adam", 3, 1, -2],
  ]);
});

test("kick-off notifier selects only imminent, un-notified, confirmed fixtures", () => {
  const now = Date.parse("2026-08-21T18:00:00Z");
  const min = 60 * 1000;
  const matches = [
    { id: "soon", player1: "Arsenal", player2: "Chelsea", startAt: new Date(now + 30 * min).toISOString() },
    { id: "edge", player1: "Spurs", player2: "Fulham", startAt: new Date(now + 60 * min).toISOString() },
    { id: "far", player1: "Everton", player2: "Leeds", startAt: new Date(now + 90 * min).toISOString() },
    { id: "started", player1: "Villa", player2: "Wolves", startAt: new Date(now - 5 * min).toISOString() },
    { id: "done", player1: "Brentford", player2: "Luton", startAt: new Date(now + 20 * min).toISOString() },
    { id: "tbc", player1: "Newcastle", player2: null, startAt: new Date(now + 25 * min).toISOString() },
    { id: "nodate", player1: "Palace", player2: "Brighton", startAt: undefined },
  ];
  const notified = new Set(["done"]);
  const picked = fixturesNeedingNotification(matches, notified, now).map((match) => match.id);
  assert.deepEqual(picked.sort(), ["edge", "soon"]);
});

test("reveals stay hidden before start and expose all members after start", () => {
  const members = [{ uid: "a", nick: "Adam", since: 0 }, { uid: "b", nick: "Ben", since: 0 }];
  const matches = [{ id: "m1", player1: "One", player2: "Two", startAt: "1970-01-01T00:00:01.000Z", result: null, tour: "prem", status: "upcoming" }];
  const picks = { m1: { a: { p1: 2, p2: 0, ts: 999 } } };
  assert.equal(buildReveals(members, matches, picks, 999).length, 0);
  matches[0].result = [2, 0];
  matches[0].status = "complete";
  const reveals = buildReveals(members, matches, picks, 1000);
  assert.equal(reveals[0].picks.length, 2);
  assert.equal(reveals[0].picks[1].asleep, true);
});
