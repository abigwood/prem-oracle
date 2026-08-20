// Slice 1 — the planner, at the product's maximum shape.
import test from "node:test";
import assert from "node:assert/strict";
import { ledgerObject, kvShim, harnessDeps, seedLeague, fixture } from "./notify_harness.mjs";
import {
  dueFixtures, triplesForFixture, intoJobs, reserveForJobs, planFixture,
  JOB_TRIPLES, REMINDER_WINDOW_MS, slateFixtureKey,
} from "../src/notify/planner.js";
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
  const ids = dueFixtures([inside, edge, beyond, started], T0).map((m) => m.id);
  assert.deepEqual(ids, ["f1", "f2"]);
});

// --- league selection -----------------------------------------------------

test("a recipient in several leagues is notified once, through the smallest code", () => {
  const membersByLeague = new Map([
    ["ZZZ", [uid(0)]], ["AAA", [uid(0)]], ["MMM", [uid(0)]],
  ]);
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["ZZZ", "AAA", "MMM"], membersByLeague, picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 1, "one recipient produced more than one notification");
  assert.equal(triples[0].league, "AAA");
});

test("discovery order cannot change the league chosen", () => {
  const build = (codes) => triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: codes,
    membersByLeague: new Map(codes.map((c) => [c, [uid(0)]])),
    picks: {}, competition: "PL",
  })[0].league;
  assert.equal(build(["ZZZ", "AAA", "MMM"]), build(["MMM", "ZZZ", "AAA"]));
  assert.equal(build(["ZZZ", "AAA", "MMM"]), "AAA");
});

test("every triple carries an explicit league code, never a default", () => {
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["QRS"],
    membersByLeague: new Map([["QRS", [uid(0), uid(1)]]]),
    picks: {}, competition: "PL",
  });
  assert.equal(triples.length, 2);
  for (const t of triples) {
    assert.equal(t.league, "QRS");
    assert.notEqual(t.league, "AAA", "the harness default leaked into production output");
  }
});

// --- the pick filter ------------------------------------------------------

test("the planner filters saved picks before creating any job", () => {
  const membersByLeague = new Map([["AAA", [uid(0), uid(1), uid(2)]]]);
  const picks = { [uid(1)]: { p1: 1, p2: 0, ts: 1 } };
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["AAA"], membersByLeague, picks, competition: "PL",
  });
  assert.deepEqual(triples.map((t) => t.uid), [uid(0), uid(2)]);
});

test("message counts follow PLANNED triples, not eventual sends", () => {
  const members = Array.from({ length: 100 }, (_, i) => uid(i));
  const picks = Object.fromEntries(members.slice(0, 70).map((u) => [u, { p1: 0, p2: 0, ts: 1 }]));
  const triples = triplesForFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    leagueCodes: ["AAA"], membersByLeague: new Map([["AAA", members]]), picks, competition: "PL",
  });
  assert.equal(triples.length, 30);
  assert.equal(intoJobs(triples).length, Math.ceil(30 / JOB_TRIPLES));
});

test("a job never carries more than 45 triples", () => {
  const triples = Array.from({ length: 100 }, (_, i) => ({ uid: uid(i) }));
  const jobs = intoJobs(triples);
  assert.equal(jobs.length, 3);
  for (const j of jobs) assert.ok(j.triples.length <= JOB_TRIPLES);
  assert.equal(jobs.reduce((n, j) => n + j.triples.length, 0), 100);
});

// --- discovery costs no value reads ---------------------------------------

test("league discovery and membership read KEY NAMES only", async () => {
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

// --- the pre-enqueue reservation ------------------------------------------

test("the planner books each message's unavoidable worst case before enqueueing", async () => {
  const L = ledgerObject();
  const { affordable, asked } = await reserveForJobs(L.client, DAY, 10);
  assert.equal(affordable, 10);
  assert.equal(asked.do_requests, 10 * PER_MESSAGE_WORST_CASE.do_requests);
  assert.equal(asked.queue_ops, 10 * PER_MESSAGE_WORST_CASE.queue_ops);
  const spent = await L.client.call("spent", { day: DAY });
  assert.equal(spent.do_requests, 120);
  assert.equal(spent.queue_ops, 70);
  assert.equal(spent.worker_requests, 40);
});

test("only whole messages are enqueued when the budget runs short", async () => {
  const L = ledgerObject();
  // Leave room for exactly four messages' worth of DO requests.
  await L.client.call("reserve", {
    day: DAY, metric: "do_requests", want: POOL.do_requests - 4 * PER_MESSAGE_WORST_CASE.do_requests,
  });
  const { affordable } = await reserveForJobs(L.client, DAY, 10);
  assert.equal(affordable, 4, "a half-funded message was enqueued");
});

test("what the planner cannot fund is terminally recorded, never silently lost", async () => {
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 90, fixtureIds: ["f1"] });
  seed["picks:f1"] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
  // Room for one message only.
  await L.client.call("reserve", {
    day: DAY, metric: "do_requests", want: POOL.do_requests - PER_MESSAGE_WORST_CASE.do_requests,
  });
  const result = await planFixture({
    match: fixture("f1", new Date(KICK).toISOString()),
    competition: "PL", env, ledger: L.client, deps, now: T0,
  });
  assert.equal(result.triples, 90);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.refused, 1);
  const drops = L.drops();
  assert.ok(drops.some((d) => d.reason === "plan-budget-exhausted" && d.uids === 45),
    "the unfunded message vanished without a diagnostic");
});

// --- the maximum shape ----------------------------------------------------

test("MAXIMUM SHAPE: 20 fixtures x 1,000 recipients plans 20,000 protected triples", async () => {
  const fixtures = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 1_000, fixtureIds: fixtures });
  for (const id of fixtures) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });

  let planned = 0;
  let jobs = 0;
  for (const id of fixtures) {
    const result = await planFixture({
      match: fixture(id, new Date(KICK).toISOString()),
      competition: "PL", env, ledger: L.client, deps, now: T0,
    });
    planned += result.triples;
    jobs += result.jobs.length;
    assert.equal(result.refused, 0, `fixture ${id} could not be funded`);
  }
  assert.equal(planned, 20_000, "the maximum shape did not plan every first attempt");
  assert.equal(jobs, 20 * Math.ceil(1_000 / JOB_TRIPLES));

  const spent = await L.client.call("spent", { day: DAY });
  assert.ok(spent.do_requests <= POOL.do_requests, `DO requests ${spent.do_requests} over cap`);
  assert.ok(spent.queue_ops <= POOL.queue_ops, `queue ops ${spent.queue_ops} over cap`);
  assert.ok(spent.worker_requests <= POOL.worker_requests,
    `worker requests ${spent.worker_requests} over cap`);
});

test("MAXIMUM SHAPE: every one of the 20,000 first attempts is granted", async () => {
  const fixtures = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 1_000, fixtureIds: fixtures });
  for (const id of fixtures) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const sends = [];
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends });

  let attempted = 0;
  for (const id of fixtures) {
    const { jobs } = await planFixture({
      match: fixture(id, new Date(KICK).toISOString()),
      competition: "PL", env, ledger: L.client, deps, now: T0,
    });
    for (const j of jobs) attempted += (await deliverJob(j, env, deps)).stats.attempted;
  }
  assert.equal(attempted, 20_000, "some first attempts were refused at the maximum shape");
  const spent = await L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, POOL.apns_initial, "INITIAL was not exactly consumed");
  assert.equal(spent.apns_retry, 0, "first delivery drew from the retry pool");
  assert.ok(spent.kv_reads <= POOL.kv_reads, `KV reads ${spent.kv_reads} over pool`);
  assert.equal(sends.length, 20_000);
});

test("MAXIMUM SHAPE ADVERSARIAL: a retry storm cannot starve first delivery", async () => {
  const fixtures = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const seed = {};
  seedLeague(seed, { code: "AAA", size: 1_000, fixtureIds: fixtures });
  for (const id of fixtures) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });

  // 9,000 retry reservations arrive before the round is planned at all.
  for (let i = 0; i < 9_000; i++) {
    await L.client.call("reserve", { day: DAY, metric: "apns_retry", want: 1 });
  }
  assert.equal((await L.client.call("spent", { day: DAY })).apns_retry, POOL.apns_retry);

  let attempted = 0;
  for (const id of fixtures) {
    const { jobs } = await planFixture({
      match: fixture(id, new Date(KICK).toISOString()),
      competition: "PL", env, ledger: L.client, deps, now: T0,
    });
    for (const j of jobs) attempted += (await deliverJob(j, env, deps)).stats.attempted;
  }
  assert.equal(attempted, 20_000, "a retry storm starved first delivery");
  const spent = await L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial + spent.apns_retry, POOL.apns_initial + POOL.apns_retry);
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
