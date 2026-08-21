// Slice 1 — the planner, at the product's maximum shape.
import test from "node:test";
import assert from "node:assert/strict";
import { ledgerObject, kvShim, harnessDeps, seedLeague, fixture } from "./notify_harness.mjs";
import {
  dueFixtures, triplesForFixture, packJobs, reserveForJobs, planWindow,
  JOB_TRIPLES, REMINDER_WINDOW_MS, slateFixtureKey,
} from "../src/notify/planner.js";
import { MAX_FIXTURES_PER_JOB } from "../src/notify/consumer.js";
import { POOL, PER_MESSAGE_WORST_CASE, utcDay } from "../src/notify/ledger.js";
import { deliverJob } from "../src/notify/consumer.js";

const T0 = Date.parse("2026-09-12T13:30:00Z");
const KICK = Date.parse("2026-09-12T14:00:00Z");
const DAY = utcDay(T0);
const env = {};
const uid = (n) => `prem_u${String(n).padStart(5, "0")}`;

// --- the window -----------------------------------------------------------

test("the 60-minute reminder window is preserved exactly", () => {
  assert.equal(REMINDER_WINDOW_MS, 60 * 60 * 1000);
  const inside = fixture("f1", new Date(T0 + 30 * 60_000).toISOString());
  const edge = fixture("f2", new Date(T0 + REMINDER_WINDOW_MS).toISOString());
  const beyond = fixture("f3", new Date(T0 + REMINDER_WINDOW_MS + 1).toISOString());
  const started = fixture("f4", new Date(T0 - 1).toISOString());
  assert.deepEqual(dueFixtures([inside, edge, beyond, started], T0).map((m) => m.id), ["f1", "f2"]);
});

// --- N1 · league selection -------------------------------------------------

const leaguesOf = (codes, period = "7") => codes.map((code) => ({ code, period }));

test("N1 · a recipient in several leagues is notified once, through the smallest code", () => {
  const codes = ["ZZZ", "AAA", "MMM"];
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagues: leaguesOf(codes),
    membership: new Map(codes.map((c) => [c, [uid(0)]])),
    picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 1, "one recipient produced more than one notification");
  assert.equal(triples[0].league, "AAA");
});

test("N1 · discovery order cannot change the league chosen", () => {
  const build = (codes) => triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagues: leaguesOf(codes),
    membership: new Map(codes.map((c) => [c, [uid(0)]])),
    picks: {}, competition: "PL",
  })[0].league;
  assert.equal(build(["ZZZ", "AAA", "MMM"]), build(["MMM", "ZZZ", "AAA"]));
  assert.equal(build(["ZZZ", "AAA", "MMM"]), "AAA");
});

test("N1 · every triple carries an explicit league code and period, never a default", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagues: leaguesOf(["QRS"], "12"),
    membership: new Map([["QRS", [uid(0), uid(1)]]]),
    picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 2);
  for (const t of triples) {
    assert.equal(t.league, "QRS");
    assert.equal(t.period, "12");
    assert.notEqual(t.league, "AAA", "the harness default leaked into production output");
  }
});

test("N1 · a league whose index entry carries no period produces no triple", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagues: [{ code: "QRS", period: undefined }],
    membership: new Map([["QRS", [uid(0)]]]),
    picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 0, "a triple was built without the period its slate read needs");
});

// --- the pick filter ------------------------------------------------------

test("the planner filters saved picks before creating any job", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagues: leaguesOf(["AAA"]),
    membership: new Map([["AAA", [uid(0), uid(1), uid(2)]]]),
    picks: { [uid(1)]: { p1: 1, p2: 0, ts: 1 } }, competition: "PL",
  });
  assert.deepEqual(triples.map((t) => t.uid), [uid(0), uid(2)]);
});

// --- C · packing ----------------------------------------------------------

test("C · jobs pack ACROSS fixtures, matching the frozen 445-message model", () => {
  const triples = [];
  for (let f = 0; f < 20; f++) {
    for (let u = 0; u < 1_000; u++) {
      triples.push({ uid: uid(u), fixtureId: `f${f}`, league: "AAA", period: "7" });
    }
  }
  const jobs = packJobs(triples);
  assert.equal(jobs.length, Math.ceil(20_000 / JOB_TRIPLES));
  assert.equal(jobs.length, 445, "production packing must match the costed model");
  // Per-fixture packing would have produced 20 x ceil(1000/45) = 460.
  assert.notEqual(jobs.length, 460);
});

test("C · no job exceeds 45 triples or three fixtures, and none is lost", () => {
  const triples = [];
  for (let f = 0; f < 8; f++) {
    for (const code of ["AAA", "BBB", "CCC", "DDD"]) {
      for (let u = 0; u < 7; u++) {
        triples.push({ uid: uid(u), fixtureId: `f${f}`, league: code, period: "7" });
      }
    }
  }
  const jobs = packJobs(triples);
  for (const j of jobs) {
    assert.ok(j.triples.length <= JOB_TRIPLES, `job of ${j.triples.length} triples`);
    assert.ok(new Set(j.triples.map((t) => t.fixtureId)).size <= MAX_FIXTURES_PER_JOB);
  }
  assert.equal(jobs.reduce((n, j) => n + j.triples.length, 0), triples.length,
    "packing lost or duplicated triples");
});

test("C · leagues per job are deliberately unbounded, and priced instead", async () => {
  const { worstCaseReads } = await import("../src/notify/consumer.js");
  // 45 recipients, one fixture, forty-five one-person leagues.
  const fragmented = Array.from({ length: 45 }, (_, i) => ({
    uid: uid(i), fixtureId: "f1", league: `L${i}`, period: "7",
  }));
  assert.equal(packJobs(fragmented).length, 1, "a league bound split a single job");
  assert.equal(worstCaseReads(fragmented), 45 * 2 + 1 + 45);
  // The same 45 in one league costs less, and the reservation says so.
  const together = fragmented.map((t) => ({ ...t, league: "AAA" }));
  assert.equal(worstCaseReads(together), 45 * 2 + 1 + 1);
});

test("C · packing is deterministic", () => {
  const triples = Array.from({ length: 137 }, (_, i) => ({
    uid: uid(i), fixtureId: `f${i % 4}`, league: "AAA", period: "7",
  }));
  assert.deepEqual(packJobs(triples), packJobs(triples));
});

// --- N5 · discovery costs no value reads ----------------------------------

test("N5 · league discovery and membership read KEY NAMES AND METADATA only", async () => {
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 50, fixtureIds: ["f1"] });
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });

  const before = { ...kv.counts };
  const leagues = await deps.leaguesForFixture("f1");
  const { graph } = await deps.membershipGraph();
  assert.deepEqual(leagues, [{ code: "AAA", period: "7" }]);
  assert.equal(graph.get("AAA").length, 50);
  assert.equal(kv.counts.get, before.get, "discovery performed a value read");
  assert.equal(kv.counts.list - before.list, 2, "discovery should be two list calls");
});

// --- D · the reservation is atomic across every pool ----------------------

test("D · the planner books all three pools or none", async () => {
  const L = ledgerObject();
  const { affordable } = await reserveForJobs(L.client, DAY, 10);
  assert.equal(affordable, 10);
  const spent = await L.client.call("spent", { day: DAY });
  assert.equal(spent.do_requests, 10 * PER_MESSAGE_WORST_CASE.do_requests);
  assert.equal(spent.queue_ops, 10 * PER_MESSAGE_WORST_CASE.queue_ops);
  assert.equal(spent.worker_requests, 10 * PER_MESSAGE_WORST_CASE.worker_requests);
});

test("D · a short pool cannot leave the others charged for messages never sent", async () => {
  const L = ledgerObject();
  // DO requests fund four messages; the other two pools could fund far more.
  await L.client.call("reserve", {
    day: DAY, metric: "do_requests",
    want: POOL.do_requests - 4 * PER_MESSAGE_WORST_CASE.do_requests,
  });
  const beforeQueue = (await L.client.call("spent", { day: DAY })).queue_ops;
  const { affordable, refused } = await reserveForJobs(L.client, DAY, 10);
  assert.equal(affordable, 4, "a half-funded message was enqueued");
  assert.equal(refused, 6);
  const spent = await L.client.call("spent", { day: DAY });
  assert.equal(spent.queue_ops - beforeQueue, 4 * PER_MESSAGE_WORST_CASE.queue_ops,
    "queue capacity was charged for messages the DO pool could not fund");
  assert.equal(spent.worker_requests, 4 * PER_MESSAGE_WORST_CASE.worker_requests);
});

test("D · charged capacity always equals affordable x per-message cost", async () => {
  for (const [reserved, expected] of [[0, 10], [POOL.do_requests, 0]]) {
    const L = ledgerObject();
    if (reserved) await L.client.call("reserve", { day: DAY, metric: "do_requests", want: reserved });
    const { affordable } = await reserveForJobs(L.client, DAY, 10);
    assert.equal(affordable, expected);
    const spent = await L.client.call("spent", { day: DAY });
    for (const [metric, cost] of Object.entries(PER_MESSAGE_WORST_CASE)) {
      const attributable = metric === "do_requests" ? spent[metric] - reserved : spent[metric];
      assert.equal(attributable, affordable * cost, `${metric} was over- or under-charged`);
    }
  }
});

test("D · concurrent planners cannot oversubscribe any pool", async () => {
  const L = ledgerObject();
  const capacity = Math.floor(POOL.do_requests / PER_MESSAGE_WORST_CASE.do_requests);
  let granted = 0;
  for (let planner = 0; planner < 40; planner++) {
    granted += (await reserveForJobs(L.client, DAY, 50)).affordable;
  }
  assert.equal(granted, capacity, `40 planners booked ${granted} messages, capacity is ${capacity}`);
  const spent = await L.client.call("spent", { day: DAY });
  for (const [metric, cost] of Object.entries(PER_MESSAGE_WORST_CASE)) {
    assert.ok(spent[metric] <= POOL[metric], `${metric} oversubscribed`);
    assert.equal(spent[metric], granted * cost);
  }
});

// --- E · a planner refusal is terminal ------------------------------------

test("E · what the planner cannot fund is TERMINALLY recorded", async () => {
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 90, fixtureIds: ["f1"] });
  seed["picks:f1"] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
  await L.client.call("reserve", {
    day: DAY, metric: "do_requests", want: POOL.do_requests - PER_MESSAGE_WORST_CASE.do_requests,
  });
  const result = await planWindow({
    matches: [fixture("f1", new Date(KICK).toISOString())],
    competitionOf: () => "PL", ledger: L.client, deps, now: T0,
  });
  assert.equal(result.triples, 90);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.refused, 1);
  // The unfunded 45 have real rows, not just a diagnostic line.
  const dropped = [...Array(90).keys()]
    .map((n) => L.row(uid(n), "f1")).filter((r) => r?.state === "dropped");
  assert.equal(dropped.length, 45, "the unfunded recipients have no terminal row");
  assert.ok(dropped.every((r) => r.drop_reason === "plan-budget-exhausted"));
  assert.ok(L.drops().some((d) => d.reason === "plan-budget-exhausted" && d.uids === 45));
});

test("E · a planner-dropped recipient cannot be replanned", async () => {
  const L = ledgerObject();
  const triples = [{ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK }];
  await L.client.call("terminatePlanned", { day: DAY, now: T0, triples });
  assert.equal(L.row(uid(0), "f1").state, "dropped");
  // A later delivery finds nothing to claim.
  const begun = await L.client.call("beginDelivery", { day: DAY, want: 8, now: T0 + 1, triples });
  assert.equal(begun.claimed.length, 0, "a planner-dropped triple was reclaimed");
  assert.equal(begun.deferred, 0);
});

test("E · planner terminalisation leaves sent, dropped and live claims alone", async () => {
  const L = ledgerObject();
  const mk = (n) => ({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const { claimed } = await L.client.call("beginDelivery",
    { day: DAY, want: 12, now: T0, triples: [mk(0), mk(1)] });
  await L.client.call("recordOutcomes", {
    day: DAY, now: T0,
    outcomes: [{ uid: uid(0), fixtureId: "f1", gen: claimed[0].claim_gen, result: "sent" }],
  });
  // uid(1) keeps a LIVE lease; uid(2) has no row at all.
  const liveGen = claimed[1].claim_gen;
  const { dropped } = await L.client.call("terminatePlanned", {
    day: DAY, now: T0, triples: [mk(0), mk(1), mk(2)],
  });
  assert.equal(dropped, 1, "a sent row or a live claim was overwritten");
  assert.equal(L.row(uid(0), "f1").state, "sent");
  assert.equal(L.row(uid(1), "f1").state, "claimed");
  assert.equal(L.row(uid(1), "f1").claim_gen, liveGen);
  assert.equal(L.row(uid(2), "f1").drop_reason, "plan-budget-exhausted");
});

test("E · planner terminalisation is atomic", async () => {
  const L = ledgerObject();
  const triples = [{ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK }];
  // A failure inside the transaction must leave no row and no diagnostic.
  const original = L.ledger.sql.exec.bind(L.ledger.sql);
  let calls = 0;
  L.ledger.sql.exec = (...args) => {
    if (++calls > 1 && /dropped_log/.test(String(args[0]))) throw new Error("crash mid-terminalise");
    return original(...args);
  };
  assert.throws(() => L.ledger.terminatePlanned({ day: DAY, now: T0, triples }), /crash mid-terminalise/);
  L.ledger.sql.exec = original;
  assert.equal(L.row(uid(0), "f1"), undefined, "a partial terminalisation was committed");
  assert.equal(L.drops().length, 0);
});

// --- the maximum shape ----------------------------------------------------

async function maximumWorld() {
  const fixtures = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 1_000, fixtureIds: fixtures });
  for (const id of fixtures) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const sends = [];
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends });
  const matches = fixtures.map((id) => fixture(id, new Date(KICK).toISOString()));
  return { kv, L, sends, deps, matches };
}

test("MAXIMUM SHAPE: 20 fixtures x 1,000 recipients packs to 445 messages", async () => {
  const w = await maximumWorld();
  const result = await planWindow({
    matches: w.matches, competitionOf: () => "PL", ledger: w.L.client, deps: w.deps, now: T0,
  });
  assert.equal(result.triples, 20_000);
  assert.equal(result.jobs.length, 445, "production packing drifted from the costed model");
  assert.equal(result.refused, 0);
  const spent = await w.L.client.call("spent", { day: DAY });
  for (const metric of ["do_requests", "queue_ops", "worker_requests"]) {
    assert.ok(spent[metric] <= POOL[metric], `${metric} over cap at the maximum shape`);
  }
});

test("MAXIMUM SHAPE: every one of the 20,000 first attempts is granted", async () => {
  const w = await maximumWorld();
  const { jobs } = await planWindow({
    matches: w.matches, competitionOf: () => "PL", ledger: w.L.client, deps: w.deps, now: T0,
  });
  let attempted = 0;
  for (const j of jobs) attempted += (await deliverJob(j, env, w.deps)).stats.attempted;
  assert.equal(attempted, 20_000, "some first attempts were refused at the maximum shape");
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, POOL.apns_initial, "INITIAL was not exactly consumed");
  assert.equal(spent.apns_retry, 0, "first delivery drew from the retry pool");
  assert.ok(spent.kv_reads <= POOL.kv_reads, `KV reads ${spent.kv_reads} over pool`);
  assert.equal(w.sends.length, 20_000);
});

test("MAXIMUM SHAPE ADVERSARIAL: a retry storm cannot starve first delivery", async () => {
  const w = await maximumWorld();
  for (let i = 0; i < 9_000; i++) {
    await w.L.client.call("reserve", { day: DAY, metric: "apns_retry", want: 1 });
  }
  assert.equal((await w.L.client.call("spent", { day: DAY })).apns_retry, POOL.apns_retry);
  const { jobs } = await planWindow({
    matches: w.matches, competitionOf: () => "PL", ledger: w.L.client, deps: w.deps, now: T0,
  });
  let attempted = 0;
  for (const j of jobs) attempted += (await deliverJob(j, env, w.deps)).stats.attempted;
  assert.equal(attempted, 20_000, "a retry storm starved first delivery");
});

test("MAXIMUM SHAPE: actual KV reads never exceed what was reserved", async () => {
  const w = await maximumWorld();
  const { jobs } = await planWindow({
    matches: w.matches, competitionOf: () => "PL", ledger: w.L.client, deps: w.deps, now: T0,
  });
  const before = w.kv.counts.get;
  let reserved = 0;
  for (const j of jobs) reserved += (await deliverJob(j, env, w.deps)).stats.reads;
  const actual = w.kv.counts.get - before;
  assert.ok(actual <= reserved, `spent ${actual} reads against ${reserved} reserved`);
});

// --- N5 · the read-plan claim, counted ------------------------------------

test("N5 · the cron performs ZERO per-member and per-member-fixture reads", async () => {
  const w = await maximumWorld();
  const before = { ...w.kv.counts };
  await planWindow({
    matches: w.matches, competitionOf: () => "PL", ledger: w.L.client, deps: w.deps, now: T0,
  });
  const reads = w.kv.counts.get - before.get;
  // 20 fixtures x 1,000 recipients = 20,000 candidate pairs. The planner's
  // ONLY value read is one picks: per fixture — the period now arrives as list
  // metadata, so there is no index read per league either.
  assert.equal(reads, 20, `the planner made ${reads} value reads for 20,000 pairs`);
  assert.ok(reads < 1_000, "the planner is nowhere near a per-recipient read profile");
});

test("N5 · planner reads do not grow with the number of recipients", async () => {
  const cost = async (size) => {
    const seed = {};
    seedLeague(seed, { code: "AAA", size, fixtureIds: ["f1"] });
    seed["picks:f1"] = {};
    const kv = kvShim(seed);
    const L = ledgerObject();
    const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
    const before = kv.counts.get;
    await planWindow({
      matches: [fixture("f1", new Date(KICK).toISOString())],
      competitionOf: () => "PL", ledger: L.client, deps, now: T0,
    });
    return kv.counts.get - before;
  };
  const [small, large] = [await cost(10), await cost(1_000)];
  assert.equal(small, large, `10 recipients cost ${small} reads, 1,000 cost ${large}`);
  assert.equal(large, 1, "planning one fixture should cost exactly one picks read");
});

// --- the index ------------------------------------------------------------

test("the slate index key carries the league in its NAME", () => {
  assert.equal(slateFixtureKey("f1", "AAA"), "slatefx:f1:AAA");
});

test("a fixture in two leagues yields both codes, sorted", async () => {
  const seed = {};
  seedLeague(seed, { code: "ZZZ", size: 1, fixtureIds: ["f1"] });
  seedLeague(seed, { code: "AAA", size: 1, fixtureIds: ["f1"], offset: 1 });
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
  assert.deepEqual(await deps.leaguesForFixture("f1"),
    [{ code: "AAA", period: "7" }, { code: "ZZZ", period: "7" }]);
});

// --- C · production packing and the costed model must agree ---------------

test("C · the production packer produces exactly the message count Gate 0 costed", async () => {
  const { SCENARIOS } = await import("../../docs/design/notify-budget.spec.mjs");
  const triples = [];
  for (let f = 0; f < 20; f++) {
    for (let u = 0; u < 1_000; u++) {
      triples.push({ uid: uid(u), fixtureId: `f${f}`, league: "AAA", period: "7" });
    }
  }
  const produced = packJobs(triples).length;
  assert.equal(produced, SCENARIOS.worst.day.messages,
    `production packs ${produced} messages, the cost model assumes ${SCENARIOS.worst.day.messages}`);
});

test("C · the model's normal shape also matches the packer", async () => {
  const { SCENARIOS } = await import("../../docs/design/notify-budget.spec.mjs");
  const planned = SCENARIOS.normal.day.planned;
  const triples = Array.from({ length: planned }, (_, i) => ({
    uid: uid(i), fixtureId: `f${i % 20}`, league: "AAA", period: "7",
  }));
  // Sorted by fixture, as the planner emits them.
  triples.sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.uid.localeCompare(b.uid));
  assert.equal(packJobs(triples).length, SCENARIOS.normal.day.messages);
});

// ==========================================================================
// A · the bound must hold however the 1,000 recipients are DISTRIBUTED
// ==========================================================================
//
// Every earlier maximum-shape test used one league, so a per-league cost would
// have been invisible in all of them. These five shapes are the same 1,000
// recipients arranged five ways; the read profile must not care which.

const FIXTURES_20 = Array.from({ length: 20 }, (_, i) => `f${i}`);

/**
 * @param leagues  how many leagues the 1,000 recipients are spread across
 * @param overlap  how many leagues each recipient belongs to
 */
function distributedWorld({ leagues, overlap = 1, recipients = 1_000, fixtures = FIXTURES_20 }) {
  const seed = { __meta: {} };
  const codes = Array.from({ length: leagues }, (_, i) => `L${String(i).padStart(4, "0")}`);
  for (const code of codes) {
    seed[`league:${code}`] = { code, name: code };
    seed[`custom_slate:${code}:7`] = { status: "published", fixtureIds: fixtures, periodKey: "7" };
    for (const id of fixtures) {
      seed[`slatefx:${id}:${code}`] = { period: "7" };
      seed.__meta[`slatefx:${id}:${code}`] = { period: "7" };
    }
  }
  for (let i = 0; i < recipients; i++) {
    const who = uid(i);
    seed[`push:${who}`] = { token: `tok-${who}`, platform: "ios", mute: [] };
    for (let o = 0; o < overlap; o++) {
      const code = codes[(i + o * Math.floor(leagues / Math.max(overlap, 1))) % leagues];
      seed[`member:${code}:${who}`] = { nick: who, since: 0 };
    }
  }
  for (const id of fixtures) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const sends = [];
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends });
  return {
    kv, L, sends, deps, codes,
    matches: fixtures.map((id) => fixture(id, new Date(KICK).toISOString())),
  };
}

async function measure(world) {
  const before = { ...world.kv.counts };
  const rpcBefore = world.L.client.count();
  const result = await planWindow({
    matches: world.matches, competitionOf: () => "PL",
    ledger: world.L.client, deps: world.deps, now: T0,
  });
  return {
    ...result,
    gets: world.kv.counts.get - before.get,
    lists: world.kv.counts.list - before.list,
    rpcs: world.L.client.count() - rpcBefore,
  };
}

test("A · 1,000 recipients in ONE league", async () => {
  const m = await measure(distributedWorld({ leagues: 1 }));
  assert.equal(m.triples, 20_000);
  assert.equal(m.gets, 20, "one picks read per fixture and nothing else");
  assert.equal(m.jobs.length, 445);
  assert.equal(m.membershipPages, 1);
});

test("A · 1,000 recipients across THREE leagues", async () => {
  const m = await measure(distributedWorld({ leagues: 3 }));
  assert.equal(m.triples, 20_000);
  assert.equal(m.gets, 20, "the read cost grew with the number of leagues");
  assert.equal(m.jobs.length, 445);
});

test("A · 1,000 recipients across 100 leagues", async () => {
  const m = await measure(distributedWorld({ leagues: 100 }));
  assert.equal(m.triples, 20_000);
  assert.equal(m.gets, 20, "the read cost grew with the number of leagues");
  // 20 slatefx lists + the membership scan. Nothing per league.
  assert.ok(m.lists <= 20 + 5, `discovery took ${m.lists} list calls`);
});

test("A · 1,000 recipients across 1,000 ONE-PERSON leagues", async () => {
  const world = distributedWorld({ leagues: 1_000 });
  const m = await measure(world);
  assert.equal(m.triples, 20_000);
  // The shape that would have exposed a per-league read: 1,000 leagues x 20
  // fixtures is 20,000 index gets under the old design. It is still 20.
  assert.equal(m.gets, 20, `1,000 leagues cost ${m.gets} value reads`);
  assert.equal(m.membershipPages, 1, "the membership scan fragmented per league");
  assert.equal(m.jobs.length, 445);
  const spent = await world.L.client.call("spent", { day: DAY });
  for (const metric of ["do_requests", "queue_ops", "worker_requests"]) {
    assert.ok(spent[metric] <= POOL[metric], `${metric} over cap at 1,000 leagues`);
  }
});

test("A · overlapping membership: recipients in several eligible leagues", async () => {
  const world = distributedWorld({ leagues: 10, overlap: 3 });
  const m = await measure(world);
  // Still one notification each: overlap is deduplicated at planning time.
  assert.equal(m.triples, 20_000, "overlap produced duplicate notifications");
  assert.equal(m.gets, 20);
  // And every triple names the smallest of that recipient's eligible codes.
  const { jobs } = m;
  const sample = jobs[0].triples[0];
  const eligible = world.codes.filter((code) =>
    world.kv.store.has(`member:${code}:${sample.uid}`));
  assert.equal(sample.league, [...eligible].sort()[0],
    "overlap broke smallest-eligible-league selection");
});

test("A · the read profile is IDENTICAL across all five distributions", async () => {
  const shapes = [
    ["one league", { leagues: 1 }],
    ["three leagues", { leagues: 3 }],
    ["100 leagues", { leagues: 100 }],
    ["1,000 leagues", { leagues: 1_000 }],
    ["overlapping", { leagues: 10, overlap: 3 }],
  ];
  const profiles = [];
  for (const [label, options] of shapes) {
    const m = await measure(distributedWorld(options));
    profiles.push([label, m.gets, m.jobs.length, m.triples]);
  }
  const [, gets, messages, triples] = profiles[0];
  for (const [label, g, j, t] of profiles) {
    assert.equal(g, gets, `${label}: ${g} value reads against ${gets}`);
    assert.equal(j, messages, `${label}: ${j} messages against ${messages}`);
    assert.equal(t, triples, `${label}: ${t} triples against ${triples}`);
  }
  console.log(`\n  planner read profile, 1,000 recipients x 20 fixtures:`);
  for (const [label, g, j] of profiles) {
    console.log(`    ${label.padEnd(16)} ${String(g).padStart(3)} value reads, ${j} messages`);
  }
});

test("A · an index key with no metadata is skipped, not chased with a read", async () => {
  const seed = { __meta: {} };
  seed["league:AAA"] = { code: "AAA", name: "AAA" };
  seed["custom_slate:AAA:7"] = { status: "published", fixtureIds: ["f1"], periodKey: "7" };
  seed["slatefx:f1:AAA"] = { period: "7" };        // value only: a legacy key
  seed["member:AAA:" + uid(0)] = { nick: "x", since: 0 };
  seed[`push:${uid(0)}`] = { token: "t", mute: [] };
  seed["picks:f1"] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
  const before = kv.counts.get;
  const leagues = await deps.leaguesForFixture("f1");
  assert.deepEqual(leagues, [], "a metadata-less key was followed with a value read");
  assert.equal(kv.counts.get, before, "discovery read a value to recover the period");
});

// --- the planning lease: a fixture is planned twice a day, not eight times ---

test("planner · a fixture due on four consecutive ticks is planned twice", async () => {
  const world = distributedWorld({ leagues: 1, recipients: 90, fixtures: ["f1"] });
  const run = () => planWindow({
    matches: world.matches, competitionOf: () => "PL",
    ledger: world.L.client, deps: world.deps, now: T0,
  });
  const first = await run();
  assert.equal(first.jobs.length, 2, "90 recipients should be two messages");

  // The sweep: nobody has been sent to yet, so it re-plans the same people.
  const second = await run();
  assert.equal(second.jobs.length, 2);

  // Ticks three and four find the lease spent and plan nothing at all.
  const third = await run();
  const fourth = await run();
  assert.equal(third.jobs.length, 0, "a third planning pass ran");
  assert.equal(fourth.jobs.length, 0);
  assert.ok(third.skipped.some((s) => s.why === "already-planned"));
});

test("planner · the sweep carries only those still unsent", async () => {
  const world = distributedWorld({ leagues: 1, recipients: 90, fixtures: ["f1"] });
  const run = () => planWindow({
    matches: world.matches, competitionOf: () => "PL",
    ledger: world.L.client, deps: world.deps, now: T0,
  });
  const first = await run();
  // Deliver the first message only; the second message's people stay unsent.
  await deliverJob(first.jobs[0], env, world.deps);

  const sweep = await run();
  assert.equal(sweep.triples, 45, "the sweep re-planned people already notified");
  const sweptUids = new Set(sweep.jobs.flatMap((j) => j.triples.map((t) => t.uid)));
  const sentUids = first.jobs[0].triples.map((t) => t.uid);
  for (const done of sentUids) {
    assert.ok(!sweptUids.has(done), `${done} was already sent to and was swept anyway`);
  }
});

test("planner · a fresh UTC day gets fresh passes", async () => {
  const world = distributedWorld({ leagues: 1, recipients: 45, fixtures: ["f1"] });
  const at = (now) => planWindow({
    matches: world.matches, competitionOf: () => "PL",
    ledger: world.L.client, deps: world.deps, now,
  });
  await at(T0);
  await at(T0);
  assert.equal((await at(T0)).jobs.length, 0);
  const tomorrow = T0 + 24 * 60 * 60 * 1000;
  assert.ok((await at(tomorrow)).jobs.length > 0, "the next day inherited the spent lease");
});

test("planner · the whole day's planning cost, counted", async () => {
  const world = distributedWorld({ leagues: 1_000 });
  const before = { ...world.kv.counts };
  const rpcBefore = world.L.client.count();
  // Four cron ticks across the window; the lease makes two of them no-ops.
  for (let tick = 0; tick < 4; tick++) {
    await planWindow({
      matches: world.matches, competitionOf: () => "PL",
      ledger: world.L.client, deps: world.deps, now: T0,
    });
  }
  const gets = world.kv.counts.get - before.get;
  const lists = world.kv.counts.list - before.list;
  const rpcs = world.L.client.count() - rpcBefore;
  console.log(`\n  planner, one full day at the maximum shape (1,000 leagues):`);
  console.log(`    KV value reads : ${gets}`);
  console.log(`    KV list calls  : ${lists}`);
  console.log(`    ledger RPCs    : ${rpcs}\n`);
  // Two passes x 20 fixtures = 40 picks reads. Nothing per league, nothing
  // per recipient, and nothing at all on the two leaseless ticks.
  assert.equal(gets, 40, `the day cost ${gets} value reads`);
  assert.ok(lists <= 2 * (20 + 2) + 2, `the day cost ${lists} list calls`);
});
