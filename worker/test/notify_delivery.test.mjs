// Slice 1 — every Gate-0 design guarantee, asserted about the PRODUCTION path.
import test from "node:test";
import assert from "node:assert/strict";
import { ledgerObject, kvShim, harnessDeps, seedLeague, triple, job }
  from "./notify_harness.mjs";
import { deliverJob, worstCaseReads, stillEligible } from "../src/notify/consumer.js";
import { POOL, LEASE_MS, MAX_ATTEMPTS, RETRY_DELAY_S, PER_MESSAGE_WORST_CASE, utcDay }
  from "../src/notify/ledger.js";
import { collapseId, reminderPayload, chooseLeagueCode, LOCK_SCREEN_LEAGUE }
  from "../src/notify/copy.js";

const T0 = Date.parse("2026-09-12T13:30:00Z");
const KICK = Date.parse("2026-09-12T14:00:00Z");
const DAY = utcDay(T0);
const env = {};

function world({ leagues = [["AAA", 2, ["f1"]]], now = T0, sendResult } = {}) {
  const seed = {};
  let offset = 0;
  for (const [code, size, fixtureIds] of leagues) {
    seedLeague(seed, { code, size, fixtureIds, offset });
    offset += size;
  }
  seed["picks:f1"] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const sends = [];
  const deps = harnessDeps({ kv, client: L.client, now: () => now, sends, sendResult });
  return { kv, L, sends, deps, seed };
}

const uid = (n) => `prem_u${String(n).padStart(5, "0")}`;

// --- delivery basics ------------------------------------------------------

test("A · a working delivery sends, records and costs exactly three DO calls", async () => {
  const w = world();
  w.L.client.reset();
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { ack, stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(ack, true);
  assert.equal(stats.sent, 2);
  assert.equal(stats.attempted, 2);
  assert.deepEqual(w.L.client.calls, ["beginDelivery", "grantAttempts", "recordOutcomes"],
    "a working delivery must be exactly these three round trips");
  assert.equal(w.L.client.count(), 3);
  assert.equal(w.L.row(uid(0), "f1").state, "sent");
  assert.equal(w.sends.length, 2);
});

test("the reads reserved are the message's worst case, not what it used", async () => {
  const w = world();
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(stats.reads, worstCaseReads(2));
  assert.equal((await w.L.client.call("spent", { day: DAY })).kv_reads, worstCaseReads(2));
});

// --- eligibility rechecked immediately before APNs ------------------------

test("N2 · eligibility is rechecked at send time, not planning time", async () => {
  for (const [mutate, reason] of [
    [(w) => w.kv.store.set("picks:f1", JSON.stringify({ [uid(0)]: { p1: 1, p2: 0 } })), "already-picked"],
    [(w) => w.kv.store.delete(`push:${uid(0)}`), "no-token"],
    [(w) => w.kv.store.set(`push:${uid(0)}`, JSON.stringify({ token: "t", mute: ["PL"] })), "muted"],
    [(w) => w.kv.store.delete(`member:AAA:${uid(0)}`), "not-member"],
    [(w) => w.kv.store.set("custom_slate:AAA:7", JSON.stringify({ status: "published", fixtureIds: ["zz"] })), "amended-out"],
  ]) {
    const w = world();
    mutate(w);
    const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
    const { stats } = await deliverJob(job([t]), env, w.deps);
    assert.equal(stats.sent, 0, `${reason}: a notification was sent anyway`);
    assert.equal(w.sends.length, 0);
    assert.equal(w.L.row(uid(0), "f1").drop_reason, reason);
  }
});

test("N2 · a fixture that has kicked off is never notified", async () => {
  const w = world({ now: KICK });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const { stats } = await deliverJob(job([t]), env, w.deps);
  assert.equal(stats.sent, 0);
  assert.equal(w.sends.length, 0);
  assert.equal(w.L.row(uid(0), "f1").drop_reason, "past-kickoff");
});

// --- copy, collapse id and league code ------------------------------------

test("N1 · the lock screen says Your league and never a league name", async () => {
  const w = world();
  w.kv.store.set("league:AAA", JSON.stringify({ code: "AAA", name: "Dave's Banter League" }));
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await deliverJob(job([t]), env, w.deps);
  const [{ payload }] = w.sends;
  assert.equal(payload.aps.alert.title, LOCK_SCREEN_LEAGUE);
  const rendered = JSON.stringify(payload.aps);
  assert.ok(!rendered.includes("Banter"), "a user-created league name reached the lock screen");
  assert.ok(!rendered.includes("AAA"), "the league code reached the visible alert");
  // The code rides privately, where the tap handler can use it.
  assert.deepEqual(payload.po, { v: 1, f: "f1", l: "AAA" });
});

test("the collapse id is stable per user and fixture across attempts", async () => {
  const first = collapseId("f1");
  assert.equal(first, collapseId("f1"));
  assert.notEqual(first, collapseId("f2"));
  assert.ok(first.length <= 64);
  // It must not vary with the league, or a retry would stack rather than replace.
  const a = reminderPayload({ match: { id: "f1", player1: "H", player2: "A", startAt: "2026-09-12T14:00:00Z" }, leagueCode: "AAA" });
  const b = reminderPayload({ match: { id: "f1", player1: "H", player2: "A", startAt: "2026-09-12T14:00:00Z" }, leagueCode: "ZZZ" });
  assert.notEqual(a.po.l, b.po.l);
  assert.equal(collapseId(a.po.f), collapseId(b.po.f));
});

test("every send carries the collapse id and an expiry of kick-off", async () => {
  const w = world();
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await deliverJob(job([t]), env, w.deps);
  const [{ options }] = w.sends;
  assert.equal(options.collapseId, collapseId("f1"));
  assert.equal(options.expiration, Math.floor(KICK / 1000));
});

test("the payload refuses to be built without an explicit league code", () => {
  const match = { id: "f1", player1: "H", player2: "A", startAt: "2026-09-12T14:00:00Z" };
  assert.throws(() => reminderPayload({ match }), /explicit league code/);
  assert.throws(() => reminderPayload({ match, leagueCode: "" }), /explicit league code/);
});

test("N1 · league selection is deterministic and never a harness default", async () => {
  assert.equal(chooseLeagueCode(["ZZZ", "AAA", "MMM"]), "AAA");
  assert.equal(chooseLeagueCode(["MMM", "AAA", "ZZZ"]), "AAA", "order of discovery changed the answer");
  assert.equal(chooseLeagueCode([]), null);
  assert.equal(chooseLeagueCode(["BBB", "BBB"]), "BBB");
});

test("N1 · the selected league survives into the ledger row and the diagnostic", async () => {
  const w = world({ leagues: [["ZZZ", 1, ["f1"]], ["AAA", 1, ["f1"]]] });
  // The same person is in both; the planner chose AAA, and nothing may re-choose.
  w.kv.store.set(`member:AAA:${uid(0)}`, JSON.stringify({ nick: "x", since: 0 }));
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await deliverJob(job([t]), env, w.deps);
  assert.equal(w.L.row(uid(0), "f1").league, "AAA");
  assert.equal(w.sends[0].payload.po.l, "AAA");
});

// --- success-only marker semantics ----------------------------------------

test("N6 · only a successful delivery is marked sent; a failure stays retryable", async () => {
  const w = world({ sendResult: (token) => token.endsWith("00000")
    ? { ok: true, status: 200 } : { ok: false, status: 503 } });
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { ack, stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(stats.sent, 1);
  assert.equal(ack, false, "a failed send must not acknowledge the message");
  assert.equal(w.L.row(uid(0), "f1").state, "sent");
  assert.equal(w.L.row(uid(1), "f1").state, "failed");
});

test("N6 · redelivery re-sends only the unsent", async () => {
  const w = world({ sendResult: (token) => token.endsWith("00000")
    ? { ok: true, status: 200 } : { ok: false, status: 503 } });
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  await deliverJob(job(triples), env, w.deps);
  w.sends.length = 0;
  const again = await deliverJob(job(triples), env, w.deps);
  assert.equal(again.stats.attempted, 1, "a delivered recipient was notified twice");
  assert.equal(w.sends[0].token, `tok-${uid(1)}`);
});

test("N6 · a 410 drops the registration and never retries that recipient", async () => {
  const w = world({ sendResult: () => ({ ok: false, status: 410 }) });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const { ack } = await deliverJob(job([t]), env, w.deps);
  assert.equal(ack, true, "an unregistered device should not hold the message open");
  assert.equal(w.kv.store.has(`push:${uid(0)}`), false, "the stale token was kept");
  assert.equal(w.L.row(uid(0), "f1").drop_reason, "unregistered");
});

// --- pools ----------------------------------------------------------------

test("a first attempt draws INITIAL and a retry draws RETRY", async () => {
  const w = world({ sendResult: () => ({ ok: false, status: 503 }) });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const first = await deliverJob(job([t]), env, w.deps);
  assert.deepEqual(first.stats.pools, { apns_initial: 1, apns_retry: 0 });
  const second = await deliverJob(job([t]), env, w.deps);
  assert.deepEqual(second.stats.pools, { apns_initial: 0, apns_retry: 1 },
    "a retry was charged to first delivery");
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, 1);
  assert.equal(spent.apns_retry, 1);
});

test("a retry storm cannot consume INITIAL capacity", async () => {
  const w = world();
  // Exhaust RETRY before any first delivery is attempted.
  for (let i = 0; i < POOL.apns_retry + 500; i++) {
    await w.L.client.call("reserve", { day: DAY, metric: "apns_retry", want: 1 });
  }
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_retry, POOL.apns_retry);
  // First delivery still goes through.
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const { stats } = await deliverJob(job([t]), env, w.deps);
  assert.equal(stats.sent, 1, "a retry storm starved first delivery");
  assert.equal(stats.pools.apns_initial, 1);
});

test("exhausting INITIAL drops the remainder terminally with a reason", async () => {
  const w = world({ leagues: [["AAA", 4, ["f1"]]] });
  await w.L.client.call("reserve", { day: DAY, metric: "apns_initial", want: POOL.apns_initial - 2 });
  const triples = [0, 1, 2, 3].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { ack, stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(ack, true, "budget exhaustion must ack, never retry");
  assert.equal(stats.attempted, 2);
  assert.equal(stats.dropped, 2);
  assert.equal(w.L.row(uid(3), "f1").state, "dropped");
  assert.equal(w.L.row(uid(3), "f1").drop_reason, "budget-exhausted");
  assert.ok(w.L.drops().some((d) => d.reason === "budget-exhausted" && d.uids === 2));
});

// --- fencing and crash boundaries -----------------------------------------

test("an active lease is not stolen, and the message retries rather than acks", async () => {
  const w = world();
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await w.L.client.call("beginDelivery", {
    day: DAY, want: 8, now: T0, triples: [{ ...t }],
  });   // another consumer holds the lease
  const { ack, stats } = await deliverJob(job([t]), env, w.deps);
  assert.equal(ack, false, "a live lease was acked away");
  assert.equal(stats.deferred, 1);
  assert.equal(stats.attempted, 0);
  assert.equal(w.sends.length, 0);
});

test("a stale generation cannot spend either pool", async () => {
  const w = world();
  const t = { uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK };
  const { claimed: [first] } = await w.L.client.call("beginDelivery",
    { day: DAY, want: 8, now: T0, triples: [t] });
  await w.L.client.call("beginDelivery",
    { day: DAY, want: 8, now: T0 + LEASE_MS, triples: [t] });   // reclaimed, gen 2
  const grants = await w.L.client.call("grantAttempts", {
    day: DAY, grants: [{ uid: t.uid, fixtureId: t.fixtureId, gen: first.claim_gen }],
  });
  assert.equal(grants[0].granted, false);
  assert.equal(grants[0].reason, "stale");
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, 0, "a stale owner spent first-delivery capacity");
  assert.equal(spent.apns_retry, 0);
});

test("crash before APNs loses nothing: redelivery after the lease sends once", async () => {
  const w = world();
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await w.L.client.call("beginDelivery",
    { day: DAY, want: 8, now: T0, triples: [t] });   // claimed, then died
  const spentBefore = await w.L.client.call("spent", { day: DAY });
  assert.equal(spentBefore.apns_initial, 0, "an attempt was charged before permission");

  const later = T0 + RETRY_DELAY_S * 1000;
  assert.ok(later > T0 + LEASE_MS, "retry_delay must outlive the lease");
  const w2 = { ...w, deps: harnessDeps({ kv: w.kv, client: w.L.client, now: () => later, sends: w.sends }) };
  const { stats } = await deliverJob(job([t]), env, w2.deps);
  assert.equal(stats.sent, 1, "the reminder was lost");
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, 1);
  assert.equal(spent.apns_retry, 0);
});

test("crash after permission is at-least-once, charged to RETRY, and collapsed", async () => {
  const w = world();
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  const { claimed: [row] } = await w.L.client.call("beginDelivery",
    { day: DAY, want: 8, now: T0, triples: [t] });
  await w.L.client.call("grantAttempts", {
    day: DAY, grants: [{ uid: t.uid, fixtureId: t.fixtureId, gen: row.claim_gen }],
  });
  // APNs accepted here; the isolate died before recordOutcomes.
  const later = T0 + RETRY_DELAY_S * 1000;
  const deps = harnessDeps({ kv: w.kv, client: w.L.client, now: () => later, sends: w.sends });
  const { stats } = await deliverJob(job([t]), env, deps);
  assert.equal(stats.sent, 1, "the reminder was lost");
  const spent = await w.L.client.call("spent", { day: DAY });
  assert.equal(spent.apns_initial, 1, "a duplicate was charged to first delivery");
  assert.equal(spent.apns_retry, 1);
  // The duplicate carries the same collapse id, so Apple replaces rather than stacks.
  assert.equal(w.sends[0].options.collapseId, collapseId("f1"));
});

test("attempts are capped and exhaustion is swept to a terminal drop", async () => {
  const w = world({ sendResult: () => ({ ok: false, status: 503 }) });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await deliverJob(job([t]), env, w.deps);
  assert.equal(w.L.row(uid(0), "f1").attempts, MAX_ATTEMPTS);
  await w.L.client.call("sweep", { day: DAY, now: T0 + 1 });
  assert.equal(w.L.row(uid(0), "f1").state, "dropped");
  assert.equal(w.L.row(uid(0), "f1").drop_reason, "attempts-exhausted");
});

// --- KV refusal is terminal -----------------------------------------------

test("A · a read-budget refusal reads nothing, sends nothing and costs one DO call", async () => {
  const w = world();
  await w.L.client.call("reserve", { day: DAY, metric: "kv_reads", want: POOL.kv_reads });
  const before = { ...w.kv.counts };
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  w.L.client.reset();
  const { ack, stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(ack, true);
  assert.deepEqual(w.L.client.calls, ["beginDelivery"],
    "a refused delivery must be one round trip, terminalising included");
  assert.equal(stats.reads, 0);
  assert.equal(w.sends.length, 0);
  assert.equal(w.kv.counts.get, before.get, "the refused delivery read KV");
});

test("a read-budget refusal is TERMINAL, not merely reported", async () => {
  const w = world();
  await w.L.client.call("reserve", { day: DAY, metric: "kv_reads", want: POOL.kv_reads });
  const triples = [0, 1].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { stats } = await deliverJob(job(triples), env, w.deps);
  assert.equal(stats.terminated, 2);
  for (const n of [0, 1]) {
    assert.equal(w.L.row(uid(n), "f1").state, "dropped");
    assert.equal(w.L.row(uid(n), "f1").drop_reason, "kv-read-budget-exhausted");
  }
  assert.ok(w.L.drops().some((d) => d.reason === "kv-read-budget-exhausted" && d.uids === 2));
});

test("a terminally dropped triple is never replanned into an attempt", async () => {
  const w = world();
  await w.L.client.call("reserve", { day: DAY, metric: "kv_reads", want: POOL.kv_reads });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await deliverJob(job([t]), env, w.deps);
  // Budget frees up; the work must still be finished with.
  w.L.db.prepare("UPDATE budget SET used = 0 WHERE metric = 'kv_reads'").run();
  const again = await deliverJob(job([t]), env, w.deps);
  assert.equal(again.stats.attempted, 0, "a terminally dropped triple was replanned");
  assert.equal(w.sends.length, 0);
});

test("a refusal leaves sent, dropped and live-claimed rows untouched", async () => {
  const w = world({ leagues: [["AAA", 3, ["f1"]]] });
  const done = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  await deliverJob(job([done]), env, w.deps);                       // -> sent
  const live = { uid: uid(1), fixtureId: "f1", league: "AAA", kickoffAt: KICK };
  const { claimed: [liveRow] } = await w.L.client.call("beginDelivery",
    { day: DAY, want: 8, now: T0, triples: [live] });

  await w.L.client.call("reserve", { day: DAY, metric: "kv_reads", want: POOL.kv_reads });
  const triples = [0, 1, 2].map((n) => triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const { stats } = await deliverJob(job(triples), env, w.deps);

  assert.equal(w.L.row(uid(0), "f1").state, "sent", "a delivered row was overwritten");
  const stillLive = w.L.row(uid(1), "f1");
  assert.equal(stillLive.state, "claimed", "another consumer's live claim was stolen");
  assert.equal(stillLive.claim_gen, liveRow.claim_gen);
  assert.equal(w.L.row(uid(2), "f1").drop_reason, "kv-read-budget-exhausted");
  assert.equal(stats.terminated, 1, "only the safe triple should have been terminalised");
});

// --- the reservation --------------------------------------------------------

test("the pre-enqueue reservation covers four fully-working deliveries", () => {
  assert.deepEqual({ ...PER_MESSAGE_WORST_CASE },
    { queue_ops: 7, worker_requests: 4, do_requests: 12 });
});

test("A · four working deliveries of one message cost exactly twelve real RPCs", async () => {
  const w = world({ sendResult: () => ({ ok: false, status: 503 }) });
  const t = triple({ uid: uid(0), fixtureId: "f1", league: "AAA", kickoffAt: KICK });
  w.L.client.reset();
  for (let i = 0; i < 4; i++) await deliverJob(job([t]), env, w.deps);
  assert.equal(w.L.client.count(), PER_MESSAGE_WORST_CASE.do_requests,
    `four deliveries made ${w.L.client.count()} round trips`);
  assert.equal(w.L.client.count(), 12);
});

test("A · a 45-triple job still costs three RPCs, not one per triple", async () => {
  const w = world({ leagues: [["AAA", 45, ["f1"]]] });
  const triples = Array.from({ length: 45 }, (_, n) =>
    triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  w.L.client.reset();
  await deliverJob(job(triples), env, w.deps);
  assert.equal(w.L.client.count(), 3, "the per-triple disposition RPC is back");
});

test("A · unclaimed triples cost no extra round trip", async () => {
  const w = world({ leagues: [["AAA", 3, ["f1"]]] });
  const triples = [0, 1, 2].map((n) =>
    triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  // Two are already held by another consumer.
  await w.L.client.call("beginDelivery",
    { day: DAY, want: 12, now: T0, triples: triples.slice(0, 2) });
  w.L.client.reset();
  const { ack } = await deliverJob(job(triples), env, w.deps);
  assert.equal(ack, false, "live leases must hold the message open");
  assert.equal(w.L.client.count(), 3);
});

// --- eligibility helper in isolation ---------------------------------------

test("stillEligible reports the first failing reason and stops", async () => {
  const w = world();
  w.kv.store.delete(`push:${uid(0)}`);
  const context = { picks: new Map(), slates: new Map() };
  const result = await stillEligible(w.deps, context, {
    uid: uid(0), fixtureId: "f1", league: "AAA", competition: "PL", period: "7",
  });
  assert.deepEqual({ ...result }, { ok: false, reason: "no-token" });
});

// --- B · actual KV reads never exceed what was reserved --------------------

test("B · 45 recipients cost exactly two reads each plus the fixed context", async () => {
  const w = world({ leagues: [["AAA", 45, ["f1"]]] });
  const triples = Array.from({ length: 45 }, (_, n) =>
    triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const before = w.kv.counts.get;
  const { stats } = await deliverJob(job(triples), env, w.deps);
  const actual = w.kv.counts.get - before;
  assert.equal(stats.sent, 45);
  assert.ok(actual <= stats.reads,
    `spent ${actual} reads against a reservation of ${stats.reads}`);
  // Two per recipient, one picks, one slate.
  assert.equal(actual, 45 * 2 + 2);
});

test("B · three fixtures and three leagues load their context once each", async () => {
  const seed = {};
  for (const [i, code] of ["AAA", "BBB", "CCC"].entries()) {
    seedLeague(seed, { code, size: 5, fixtureIds: ["f1", "f2", "f3"], offset: i * 5 });
  }
  for (const id of ["f1", "f2", "f3"]) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const sends = [];
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends });
  const triples = [];
  for (const [i, code] of ["AAA", "BBB", "CCC"].entries()) {
    for (const id of ["f1", "f2", "f3"]) {
      triples.push(triple({ uid: uid(i * 5), fixtureId: id, league: code, kickoffAt: KICK }));
    }
  }
  const before = kv.counts.get;
  const { stats } = await deliverJob(job(triples), env, deps);
  const actual = kv.counts.get - before;
  assert.ok(actual <= stats.reads, `spent ${actual} against a reservation of ${stats.reads}`);
  // 9 triples x 2, plus 3 distinct fixtures and 3 distinct (league, period).
  assert.equal(actual, 9 * 2 + 3 + 3);
});

test("B · overlapping recipients on one fixture read the pick map once", async () => {
  const w = world({ leagues: [["AAA", 20, ["f1"]]] });
  const triples = Array.from({ length: 20 }, (_, n) =>
    triple({ uid: uid(n), fixtureId: "f1", league: "AAA", kickoffAt: KICK }));
  const before = w.kv.counts.get;
  const { stats } = await deliverJob(job(triples), env, w.deps);
  const actual = w.kv.counts.get - before;
  assert.equal(actual, 20 * 2 + 2, "the pick map or slate was read per recipient");
  assert.ok(actual <= stats.reads);
});

test("B · a job at the documented bound never exceeds its reservation", async () => {
  const seed = {};
  for (const [i, code] of ["AAA", "BBB", "CCC"].entries()) {
    seedLeague(seed, { code, size: 15, fixtureIds: ["f1", "f2", "f3"], offset: i * 15 });
  }
  for (const id of ["f1", "f2", "f3"]) seed[`picks:${id}`] = {};
  const kv = kvShim(seed);
  const L = ledgerObject();
  const deps = harnessDeps({ kv, client: L.client, now: () => T0, sends: [] });
  // 45 triples spread over the maximum three fixtures and three leagues.
  const triples = [];
  for (const [i, code] of ["AAA", "BBB", "CCC"].entries()) {
    for (const [j, id] of ["f1", "f2", "f3"].entries()) {
      for (let k = 0; k < 5; k++) {
        triples.push(triple({ uid: uid(i * 15 + j * 5 + k), fixtureId: id, league: code, kickoffAt: KICK }));
      }
    }
  }
  assert.equal(triples.length, 45);
  const before = kv.counts.get;
  const { stats } = await deliverJob(job(triples), env, deps);
  const actual = kv.counts.get - before;
  assert.equal(stats.reads, worstCaseReads(45));
  assert.ok(actual <= stats.reads, `spent ${actual} against ${stats.reads}`);
});
