// Slice 1 — the planner, at the product's maximum shape.
import test from "node:test";
import assert from "node:assert/strict";
import { ledgerObject, kvShim, harnessDeps, seedLeague, fixture } from "./notify_harness.mjs";
import {
  dueFixtures, triplesForFixture, packJobs, reserveForJobs, planWindow,
  JOB_TRIPLES, REMINDER_WINDOW_MS, slateFixtureKey,
} from "../src/notify/planner.js";
import { MAX_FIXTURES_PER_JOB, MAX_LEAGUES_PER_JOB } from "../src/notify/consumer.js";
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

const periods = (codes, period = "7") => new Map(codes.map((c) => [c, period]));

test("N1 · a recipient in several leagues is notified once, through the smallest code", () => {
  const codes = ["ZZZ", "AAA", "MMM"];
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: codes,
    membersByLeague: new Map(codes.map((c) => [c, [uid(0)]])),
    periodsByLeague: periods(codes), picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 1, "one recipient produced more than one notification");
  assert.equal(triples[0].league, "AAA");
});

test("N1 · discovery order cannot change the league chosen", () => {
  const build = (codes) => triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: codes,
    membersByLeague: new Map(codes.map((c) => [c, [uid(0)]])),
    periodsByLeague: periods(codes), picks: {}, competition: "PL",
  })[0].league;
  assert.equal(build(["ZZZ", "AAA", "MMM"]), build(["MMM", "ZZZ", "AAA"]));
  assert.equal(build(["ZZZ", "AAA", "MMM"]), "AAA");
});

test("N1 · every triple carries an explicit league code and period, never a default", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["QRS"],
    membersByLeague: new Map([["QRS", [uid(0), uid(1)]]]),
    periodsByLeague: periods(["QRS"], "12"), picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 2);
  for (const t of triples) {
    assert.equal(t.league, "QRS");
    assert.equal(t.period, "12");
    assert.notEqual(t.league, "AAA", "the harness default leaked into production output");
  }
});

test("N1 · a league with no known period produces no triple at all", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["QRS"],
    membersByLeague: new Map([["QRS", [uid(0)]]]),
    periodsByLeague: new Map(), picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 0, "a triple was built without the period its slate read needs");
});

// --- the pick filter ------------------------------------------------------

test("the planner filters saved picks before creating any job", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["AAA"],
    membersByLeague: new Map([["AAA", [uid(0), uid(1), uid(2)]]]),
    periodsByLeague: periods(["AAA"]),
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

test("C · no job exceeds 45 triples, three fixtures or three leagues", () => {
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
    assert.ok(new Set(j.triples.map((t) => t.league)).size <= MAX_LEAGUES_PER_JOB);
  }
  assert.equal(jobs.reduce((n, j) => n + j.triples.length, 0), triples.length,
    "packing lost or duplicated triples");
});

test("C · packing is deterministic", () => {
  const triples = Array.from({ length: 137 }, (_, i) => ({
    uid: uid(i), fixtureId: `f${i % 4}`, league: "AAA", period: "7",
  }));
  assert.deepEqual(packJobs(triples), packJobs(triples));
});

// --- N5 · discovery costs no value reads ----------------------------------

test("N5 · league discovery and membership read KEY NAMES only", async () => {
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 50, fixtureIds: ["f1"] });
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });

  const before = { ...kv.counts };
  const codes = await deps.leaguesForFixture("f1");
  const members = await deps.membersByLeague(codes);
  assert.deepEqual(codes, ["AAA"]);
  assert.equal(members.get("AAA").length, 50);
  assert.equal(kv.counts.get, before.get, "discovery performed a value read per member");
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
  // value reads are one picks: and one slatefx: per fixture, and nothing else.
  assert.equal(reads, 20 * 2, `the planner made ${reads} value reads for 20,000 pairs`);
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
  assert.equal(large, 2, "planning one fixture should cost one picks and one index read");
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
  assert.deepEqual(await deps.leaguesForFixture("f1"), ["AAA", "ZZZ"]);
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
