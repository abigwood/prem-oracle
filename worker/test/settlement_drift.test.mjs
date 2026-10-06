// Defence-in-depth: settlement tolerates a drifted kickoff DATE for a UNIQUE
// home|away pair, so a result still lands if schedule reconciliation hasn't yet
// corrected the feed — but fails closed the moment the pair is ambiguous on
// either side. Exact-date matching remains primary.
import test from "node:test";
import assert from "node:assert/strict";
import { footballDataResults } from "../src/results_feed.js";

const env = { FOOTBALL_DATA_TOKEN: "token" };
const fin = (home, away, utcDate, h, a) => ({
  status: "FINISHED", homeTeam: { name: home }, awayTeam: { name: away },
  utcDate, score: { fullTime: { home: h, away: a } },
});
async function withFeed(matches, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ matches }), { status: 200 });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test("drifted date, unique pair → settled via fallback", async () => {
  const fixtures = [{ id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: "2026-10-10T15:00:00+01:00" }];
  const res = await withFeed([fin("Arsenal", "Chelsea", "2026-10-11T13:00:00Z", 2, 1)],
    () => footballDataResults(env, fixtures, "PL"));
  assert.deepEqual(res["pl-1"]?.result, [2, 1], "a unique drifted match should still settle");
});

test("exact date still matches (primary path intact)", async () => {
  const fixtures = [{ id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: "2026-10-10T15:00:00+01:00" }];
  const res = await withFeed([fin("Arsenal", "Chelsea", "2026-10-10T14:00:00Z", 3, 0)],
    () => footballDataResults(env, fixtures, "PL"));
  assert.deepEqual(res["pl-1"]?.result, [3, 0]);
});

test("ambiguous on OUR side (two fixtures, same pair) → not settled by drift", async () => {
  const fixtures = [
    { id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: "2026-10-10T15:00:00+01:00" },
    { id: "pl-2", player1: "Arsenal", player2: "Chelsea", startAt: "2026-12-10T15:00:00+00:00" },
  ];
  const res = await withFeed([fin("Arsenal", "Chelsea", "2026-10-11T13:00:00Z", 2, 1)],
    () => footballDataResults(env, fixtures, "PL"));
  assert.equal(res["pl-1"], undefined, "must not guess between two same-pair fixtures");
  assert.equal(res["pl-2"], undefined);
});

test("ambiguous on PROVIDER side (two FINISHED entries, same pair) → not settled by drift", async () => {
  const fixtures = [{ id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: "2026-10-10T15:00:00+01:00" }];
  const res = await withFeed([
    fin("Arsenal", "Chelsea", "2026-10-11T13:00:00Z", 2, 1),
    fin("Arsenal", "Chelsea", "2026-10-18T13:00:00Z", 3, 0),
  ], () => footballDataResults(env, fixtures, "PL"));
  assert.equal(res["pl-1"], undefined, "two provider entries for one pair is ambiguous → refuse");
});

test("exact-date match wins even if a drifted entry for another fixture exists", async () => {
  const fixtures = [
    { id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: "2026-10-10T15:00:00+01:00" },
    { id: "pl-2", player1: "Everton", player2: "Fulham", startAt: "2026-10-10T15:00:00+01:00" },
  ];
  const res = await withFeed([
    fin("Arsenal", "Chelsea", "2026-10-10T14:00:00Z", 1, 1),   // exact date
    fin("Everton", "Fulham", "2026-10-12T19:00:00Z", 0, 2),    // drifted, unique
  ], () => footballDataResults(env, fixtures, "PL"));
  assert.deepEqual(res["pl-1"]?.result, [1, 1]);
  assert.deepEqual(res["pl-2"]?.result, [0, 2]);
});
