// Gate 0 — executed traces for the fenced claim/retry state machine and the
// APNs attempt budget. Real SQL from docs/design/notify-ledger.spec.mjs, run
// against real SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { ledger, LEASE_MS, MAX_ATTEMPTS, APNS_ATTEMPT_CAP, POOL, RETRY_DELAY_S,
  REMINDER_WINDOW_S, deliverMessage, PER_MESSAGE_WORST_CASE, DO_CALLS_PER_WORKING_DELIVERY,
  MAX_DELIVERIES } from "../docs/design/notify-ledger.spec.mjs";

const T0 = 1_800_000_000_000;
const KICK = T0 + 60 * 60 * 1000;
const ctx = { now: T0, kickoff: KICK };
const DAY = "2026-09-12";

// --- claim basics ---------------------------------------------------------

test("claim · first claim is granted, leased and fenced at generation 1", () => {
  const l = ledger();
  const [got] = l.claim("u1", "f1", ctx);
  assert.equal(got.claim_gen, 1);
  assert.equal(got.attempts, 1);
  const row = l.row("u1", "f1");
  assert.equal(row.state, "claimed");
  assert.equal(row.claim_until, T0 + LEASE_MS);
});

test("claim · concurrency: an active claim cannot be stolen", () => {
  const l = ledger();
  assert.equal(l.claim("u1", "f1", ctx).length, 1);
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + 1_000 }).length, 0);
  assert.equal(l.row("u1", "f1").attempts, 1, "a refused claim burned an attempt");
  assert.equal(l.row("u1", "f1").claim_gen, 1, "a refused claim bumped the fence");
});

test("claim · lease expiry reclaims and bumps the generation", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS - 1 }).length, 0, "stolen early");
  const [got] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });
  assert.equal(got.claim_gen, 2);
  assert.equal(got.attempts, 2);
});

test("claim · explicit failure is reclaimable at once, with a new generation", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  assert.equal(l.fail("u1", "f1", a.claim_gen), 1);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + 1 });
  assert.equal(b.claim_gen, 2);
});

test("claim · sent is terminal, past any lease and up to kick-off", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  assert.equal(l.sent("u1", "f1", a.claim_gen, T0 + 500), 1);
  for (const now of [T0 + 600, T0 + LEASE_MS + 1, KICK - 1]) {
    assert.equal(l.claim("u1", "f1", { ...ctx, now }).length, 0, `re-sent at +${now - T0}ms`);
  }
});

test("claim · nothing is claimed at or after kick-off", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.fail("u1", "f1", a.claim_gen);
  assert.equal(l.claim("u1", "f1", { ...ctx, now: KICK }).length, 0);
  assert.equal(l.claim("u1", "f1", { ...ctx, now: KICK + 1 }).length, 0);
});

test("claim · a lease can never outlive kick-off", () => {
  const l = ledger();
  const soon = T0 + 30_000;
  l.claim("u1", "f1", { now: T0, kickoff: soon });
  assert.equal(l.row("u1", "f1").claim_until, soon);
});

test("claim · one notification per user per fixture across overlapping leagues", () => {
  const l = ledger();
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "AAA" }).length, 1);
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "BBB" }).length, 0);
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "CCC" }).length, 0);
  assert.equal(l.row("u1", "f1").league, "AAA");
});

// --- B · fencing: the stale owner cannot touch the new claim ---------------

test("fence · a stale owner cannot mark the NEW claim sent", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);                       // Consumer A, gen 1
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });  // B reclaims, gen 2
  assert.equal(b.claim_gen, 2);
  assert.equal(l.sent("u1", "f1", a.claim_gen, T0 + LEASE_MS + 5), 0,
    "a stale consumer marked another consumer's claim sent");
  assert.equal(l.row("u1", "f1").state, "claimed", "B's live claim was mutated");
  assert.equal(l.sent("u1", "f1", b.claim_gen, T0 + LEASE_MS + 6), 1, "the real owner was blocked");
});

test("fence · a stale owner cannot mark the NEW claim failed", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });
  assert.equal(l.fail("u1", "f1", a.claim_gen), 0, "a stale consumer released B's claim");
  assert.equal(l.row("u1", "f1").state, "claimed");
  assert.equal(l.row("u1", "f1").claim_gen, b.claim_gen);
  assert.equal(l.fail("u1", "f1", b.claim_gen), 1);
});

test("fence · a stale owner cannot drop the NEW claim", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });
  assert.equal(l.drop("u1", "f1", a.claim_gen, "budget"), 0,
    "a stale consumer dropped another consumer's live claim");
  assert.equal(l.row("u1", "f1").state, "claimed");
  assert.equal(l.drop("u1", "f1", b.claim_gen, "budget"), 1);
  assert.equal(l.row("u1", "f1").drop_reason, "budget");
});

test("fence · the generation strictly increases and is never reused", () => {
  const l = ledger();
  const seen = [];
  let now = T0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const [g] = l.claim("u1", "f1", { ...ctx, now });
    seen.push(g.claim_gen);
    l.fail("u1", "f1", g.claim_gen);
    now += 1_000;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(new Set(seen).size, seen.length);
});

test("fence · dropped is terminal and a stale owner cannot revive it", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.drop("u1", "f1", a.claim_gen, "past-kickoff");
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS + 1 }).length, 0);
  assert.equal(l.sent("u1", "f1", a.claim_gen, T0 + 9_999), 0);
  assert.equal(l.fail("u1", "f1", a.claim_gen), 0);
});

// --- B · attempts exhaustion becomes 'dropped', not an ambiguous 'failed' --

test("exhaust · MAX_ATTEMPTS transitions to dropped with a bounded diagnostic", () => {
  const l = ledger();
  let now = T0;
  let granted = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    const got = l.claim("u1", "f1", { ...ctx, now });
    if (got.length) { granted++; l.fail("u1", "f1", got[0].claim_gen); }
    now += 1_000;
  }
  assert.equal(granted, MAX_ATTEMPTS);
  assert.equal(l.row("u1", "f1").state, "failed", "before the sweep it is still failed");

  const swept = l.exhaust(now);
  assert.equal(swept.length, 1);
  assert.equal(l.row("u1", "f1").state, "dropped");
  assert.equal(l.row("u1", "f1").drop_reason, "attempts-exhausted");

  for (const row of swept) l.logDrop(DAY, row.fixture_id, "attempts-exhausted", 1, now);
  assert.deepEqual(l.drops().map((d) => [d.fixture, d.reason, d.uids]),
    [["f1", "attempts-exhausted", 1]]);
  // And it stays terminal.
  assert.equal(l.claim("u1", "f1", { ...ctx, now: now + LEASE_MS }).length, 0);
});

test("exhaust · the diagnostic is bounded: many uids collapse to one row", () => {
  const l = ledger();
  for (let i = 0; i < 500; i++) l.logDrop(DAY, "f1", "budget", 1, T0);
  const rows = l.drops();
  assert.equal(rows.length, 1, "the diagnostic grew per uid");
  assert.equal(rows[0].uids, 500, "the count was lost");
});

test("exhaust · a live lease is never swept out from under its owner", () => {
  const l = ledger();
  let now = T0;
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const [g] = l.claim("u1", "f1", { ...ctx, now });
    l.fail("u1", "f1", g.claim_gen);
    now += 1_000;
  }
  const [live] = l.claim("u1", "f1", { ...ctx, now });      // attempts now == MAX
  assert.equal(l.exhaust(now).length, 0, "the sweep stole a live claim");
  assert.equal(l.row("u1", "f1").state, "claimed");
  assert.equal(l.sent("u1", "f1", live.claim_gen, now), 1, "the owner could not finish");
});

// --- retry semantics ------------------------------------------------------

test("retry · redelivery re-sends only the unsent", () => {
  const l = ledger();
  const batch = ["u1", "u2", "u3"];
  const gens = Object.fromEntries(batch.map((uid) => [uid, l.claim(uid, "f1", ctx)[0].claim_gen]));
  l.sent("u1", "f1", gens.u1, T0 + 10);
  l.fail("u2", "f1", gens.u2);
  l.fail("u3", "f1", gens.u3);
  const again = batch.flatMap((uid) => l.claim(uid, "f1", { ...ctx, now: T0 + 20 }));
  assert.deepEqual(again.map((r) => r.uid), ["u2", "u3"]);
});

test("retry · crash after APNs but before recording is at-least-once, fenced", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  // APNs accepted; the consumer dies before SENT_SQL.
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS - 1 }).length, 0);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });
  assert.equal(b.claim_gen, 2, "the reclaim did not re-fence");
  // The zombie waking up later still cannot corrupt the new owner's row.
  assert.equal(l.sent("u1", "f1", a.claim_gen, T0 + LEASE_MS + 1), 0);
});

test("prune · clears past fixtures only", () => {
  const l = ledger();
  l.claim("u1", "past", { now: T0, kickoff: T0 + 1_000 });
  l.claim("u1", "future", ctx);
  assert.equal(l.prune(T0 + 2_000), 1);
  assert.equal(l.row("u1", "past"), undefined);
  assert.ok(l.row("u1", "future"));
});

// --- D · APNs ATTEMPT budget ---------------------------------------------

test("budget · a normal day reserves attempts and never reaches either pool cap", () => {
  const l = ledger();
  let total = 0;
  for (let job = 0; job < 67; job++) total += l.reserve({ day: DAY, pool: "apns_initial", want: 45 }).granted;
  assert.equal(total, 3_015);
  assert.ok(total < POOL.apns_initial);
});

test("budget · a partial grant is honoured at the boundary, not refused", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial - 10 });
  const edge = l.reserve({ day: DAY, pool: "apns_initial", want: 45 });
  assert.equal(edge.granted, 10, "the boundary job was refused instead of trimmed");
  assert.equal(edge.remaining, 0);
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
});

test("budget · 40 interleaved consumers cannot overshoot a pool", () => {
  const l = ledger();
  const consumers = Array.from({ length: 40 }, () => 0);
  for (let round = 0; round < 20; round++) {
    for (let c = 0; c < consumers.length; c++) {
      consumers[c] += l.reserve({ day: DAY, pool: "apns_initial", want: 45 }).granted;
    }
  }
  const total = consumers.reduce((a, b) => a + b, 0);
  assert.equal(total, POOL.apns_initial, `40 consumers spent ${total}, pool is ${POOL.apns_initial}`);
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
});

test("budget · each UTC day gets its own allowance, per pool", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial });
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
  assert.equal(l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted, 1, "pools are not independent");
  assert.equal(l.reserve({ day: "2026-09-13", pool: "apns_initial", want: 45 }).granted, 45);
});

test("budget · exhaustion drops the remaining work and records why", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial });
  const [a] = l.claim("u1", "f1", ctx);
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
  assert.equal(l.drop("u1", "f1", a.claim_gen, "budget-exhausted"), 1);
  l.logDrop(DAY, "f1", "budget-exhausted", 1, T0);
  assert.equal(l.row("u1", "f1").state, "dropped");
  assert.deepEqual(l.drops().map((d) => d.reason), ["budget-exhausted"]);
});

// ==========================================================================
// A · two pools: a retry can never starve a first attempt
// ==========================================================================

test("A · the pools sum to the hard ceiling and are separately capped", () => {
  assert.equal(POOL.apns_initial + POOL.apns_retry, APNS_ATTEMPT_CAP);
  assert.equal(POOL.apns_initial, 20_000, "INITIAL must cover 1,000 recipients x 20 fixtures");
  assert.equal(APNS_ATTEMPT_CAP, 25_000);
});

test("A · a first attempt draws INITIAL, every later one draws RETRY", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  assert.equal(l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY }).pool, "apns_initial");
  l.fail("u1", "f1", a.claim_gen);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + 1 });
  assert.equal(l.grantAttempt({ uid: "u1", fx: "f1", gen: b.claim_gen, day: DAY }).pool, "apns_retry",
    "a retry drew from the first-attempt pool");
});

test("A · ADVERSARIAL: retries arriving first cannot consume first-attempt capacity", () => {
  const l = ledger();
  // 5,000 retry attempts land before any of the later first deliveries.
  let retriesTaken = 0;
  for (let i = 0; i < 9_000; i++) {
    if (l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted) retriesTaken++;
  }
  assert.equal(retriesTaken, POOL.apns_retry, "the retry pool was not capped at 5,000");

  // Every one of the 10,000 first attempts is still available afterwards.
  let firstTaken = 0;
  for (let i = 0; i < POOL.apns_initial; i++) {
    if (l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted) firstTaken++;
  }
  assert.equal(firstTaken, POOL.apns_initial, "retries starved first delivery");
  assert.equal(firstTaken, 20_000);

  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial + spent.apns_retry, APNS_ATTEMPT_CAP,
    "total attempts exceeded the combined ceiling");
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
  assert.equal(l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted, 0);
});

test("A · interleaved first attempts and retries never exceed either pool", () => {
  const l = ledger();
  let first = 0, retry = 0;
  for (let round = 0; round < 21_000; round++) {
    if (l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted) first++;
    if (l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted) retry++;
  }
  assert.equal(first, POOL.apns_initial);
  assert.equal(retry, POOL.apns_retry);
  assert.equal(first + retry, APNS_ATTEMPT_CAP);
});

test("A · the honest capacity arithmetic at the MAXIMUM shape", () => {
  const FIXTURES = 20, DELIVERIES = 4;
  // The INITIAL pool is what protects first delivery, and it covers exactly
  // the required 1,000-recipient scale at a full 20-fixture round.
  assert.equal(POOL.apns_initial / FIXTURES, 1_000);
  assert.equal(1_000 * FIXTURES, POOL.apns_initial);
  // Four deliveries across twenty fixtures is EIGHTY attempts per user.
  assert.equal(FIXTURES * DELIVERIES, 80);
  assert.equal(Math.floor(APNS_ATTEMPT_CAP / 80), 312);
  // 10,000 recipients would want 200,000 first attempts: ten times the pool.
  assert.equal(10_000 * FIXTURES / POOL.apns_initial, 10);
});

// ==========================================================================
// B · crashed lease versus queue redelivery
// ==========================================================================

test("B · retry_delay outlives the lease and fits the reminder window", () => {
  assert.ok(RETRY_DELAY_S * 1000 > LEASE_MS,
    "a redelivery could land while the crashed lease is still live");
  // Four deliveries: three retry gaps plus one lease, well inside the window.
  const worst = 3 * RETRY_DELAY_S + LEASE_MS / 1000;
  assert.ok(worst < REMINDER_WINDOW_S,
    `the retry sequence takes ${worst}s, longer than the ${REMINDER_WINDOW_S}s window`);
  assert.equal(worst, 570);
});

test("B · a live claim from a crashed delivery is RETRIED, never acked away", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);                          // delivery 1 claims, then crashes
  // Delivery 2 arrives while the lease is still live.
  const out = deliverMessage(l, { day: DAY, now: T0 + 1_000, kickoff: KICK, triples: [["u1", "f1"]] });
  assert.equal(out.action, "retry", "the reminder was acked away while still owed");
  assert.equal(out.deferred, 1);
  assert.equal(out.attempted, 0);
  assert.equal(l.row("u1", "f1").state, "claimed");
});

test("B · terminal triples are acked, not retried forever", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.sent("u1", "f1", a.claim_gen, T0 + 5);
  const [b] = l.claim("u2", "f1", ctx);
  l.drop("u2", "f1", b.claim_gen, "ineligible");
  const out = deliverMessage(l, { day: DAY, now: T0 + 10, kickoff: KICK,
    triples: [["u1", "f1"], ["u2", "f1"]] });
  assert.equal(out.action, "ack");
  assert.equal(out.attempted, 0, "a terminal triple was re-sent");
});

test("B · explicitly failed triples are reclaimed immediately on redelivery", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.markTried("u1", "f1", a.claim_gen);
  l.fail("u1", "f1", a.claim_gen);
  const out = deliverMessage(l, { day: DAY, now: T0 + 1, kickoff: KICK, triples: [["u1", "f1"]] });
  assert.equal(out.action, "ack");
  assert.equal(out.sent, 1, "a failed triple was not retried");
  assert.equal(l.spent(DAY).apns_retry, 1, "the retry did not draw from the retry pool");
});

test("B · PRODUCTION SEQUENCE: crash BEFORE APNs is not lost", () => {
  const l = ledger();
  // Delivery 1: claims, then the isolate dies before any fetch.
  l.claim("u1", "f1", ctx);
  // Delivery 2 at retry_delay: the lease has expired, so it is reclaimable.
  const now = T0 + RETRY_DELAY_S * 1000;
  assert.ok(now > T0 + LEASE_MS);
  const out = deliverMessage(l, { day: DAY, now, kickoff: KICK, triples: [["u1", "f1"]] });
  assert.equal(out.action, "ack");
  assert.equal(out.sent, 1, "the reminder was lost");
  assert.equal(l.row("u1", "f1").state, "sent");
  assert.equal(l.row("u1", "f1").claim_gen, 2, "the reclaim did not re-fence");
  // Nothing was delivered twice: only one attempt was ever reserved.
  assert.equal(l.spent(DAY).apns_initial, 1);
});

test("B · PRODUCTION SEQUENCE: crash AFTER APNs is at-least-once, not lost", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.reserve({ day: DAY, pool: "apns_initial", want: 1 });
  l.markTried("u1", "f1", a.claim_gen);
  // APNs accepted here. The isolate dies before SENT_SQL.
  const now = T0 + RETRY_DELAY_S * 1000;
  const out = deliverMessage(l, { day: DAY, now, kickoff: KICK, triples: [["u1", "f1"]] });
  assert.equal(out.action, "ack");
  assert.equal(out.sent, 1, "the reminder was lost");
  // The second attempt drew from RETRY, because the first was already tried.
  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial, 1);
  assert.equal(spent.apns_retry, 1, "a duplicate attempt was charged to first delivery");
  // The zombie cannot corrupt the row that replaced it.
  assert.equal(l.sent("u1", "f1", a.claim_gen, now + 1), 0);
});

// ==========================================================================
// C · budget ordering
// ==========================================================================

test("C · a budget-dropped delivery performs NO authoritative reads", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "kv_reads", want: POOL.kv_reads });   // exhaust it
  let reads = 0;
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK,
    triples: [["u1", "f1"], ["u2", "f1"]],
    eligible: () => { reads++; return true; },
  });
  assert.equal(out.action, "ack", "an unreadable message was retried instead of dropped");
  assert.equal(out.dropped, 2);
  assert.equal(out.reads, 0);
  assert.equal(reads, 0, "the eligibility check ran after the budget said no");
  assert.equal(out.attempted, 0);
});

test("C · the read allowance is reserved BEFORE any read, and kept if unused", () => {
  const l = ledger();
  // Two triples: worst case 2*2 + 6 = 10 reads reserved up front.
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK,
    triples: [["u1", "f1"], ["u2", "f1"]],
    eligible: (uid) => uid === "u1",          // u2 turns out ineligible
  });
  assert.equal(out.reads, 10, "the reservation was trimmed to what was used");
  assert.equal(l.spent(DAY).kv_reads, 10, "unused allowance was given back");
  assert.equal(out.attempted, 1);
  assert.equal(out.dropped, 1);
});

test("C · partial eligibility spends attempts only on the eligible", () => {
  const l = ledger();
  const triples = Array.from({ length: 45 }, (_, i) => [`u${i}`, "f1"]);
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK, triples,
    eligible: (uid) => Number(uid.slice(1)) % 3 === 0,
  });
  assert.equal(out.attempted, 15);
  assert.equal(out.dropped, 30);
  assert.equal(l.spent(DAY).apns_initial, 15);
});

test("C · a failed APNs call keeps its reservation", () => {
  const l = ledger();
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK,
    triples: [["u1", "f1"], ["u2", "f1"]],
    apns: (uid) => uid === "u1",
  });
  assert.equal(out.attempted, 2, "the failure was not counted as an attempt");
  assert.equal(out.sent, 1);
  assert.equal(l.spent(DAY).apns_initial, 2, "the failed call was refunded");
  assert.equal(out.action, "retry");
});

test("C · wholesale failure: every attempt is charged and the message retries", () => {
  const l = ledger();
  const triples = Array.from({ length: 45 }, (_, i) => [`u${i}`, "f1"]);
  const out = deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples, apns: () => false });
  assert.equal(out.attempted, 45);
  assert.equal(out.sent, 0);
  assert.equal(out.action, "retry");
  assert.equal(l.spent(DAY).apns_initial, 45);
});

test("C · concurrent consumers cannot exceed the KV-read budget", () => {
  const l = ledger();
  let granted = 0;
  let full = 0;
  for (let i = 0; i < 3_000; i++) {
    const g = l.reserve({ day: DAY, pool: "kv_reads", want: 96 }).granted;
    granted += g;
    if (g === 96) full++;
  }
  // The pool is not a whole number of 96-read deliveries, so the last grant is
  // a partial one. What must hold is that the total is exactly the cap.
  assert.equal(granted, POOL.kv_reads, `spent ${granted}, cap is ${POOL.kv_reads}`);
  assert.equal(full, Math.floor(POOL.kv_reads / 96));
  assert.equal(l.reserve({ day: DAY, pool: "kv_reads", want: 1 }).granted, 0);
});

test("C · budget exhaustion mid-message drops the remainder under its own fence", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial - 3 });
  const triples = Array.from({ length: 10 }, (_, i) => [`u${i}`, "f1"]);
  const out = deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples });
  assert.equal(out.attempted, 3, "the pool boundary was overrun");
  assert.equal(out.dropped, 7);
  assert.equal(l.row("u9", "f1").drop_reason, "budget-exhausted");
  assert.equal(l.spent(DAY).apns_initial, POOL.apns_initial);
});

test("C · the planner reserves worst-case unavoidable cost before enqueueing", () => {
  // Four deliveries x three calls. Assuming some would be refused cheaply was
  // an average, not a bound.
  assert.deepEqual(PER_MESSAGE_WORST_CASE, { queue_ops: 7, worker_requests: 4, do_requests: 12 });
  assert.equal(MAX_DELIVERIES * DO_CALLS_PER_WORKING_DELIVERY, 12);
});

// ==========================================================================
// B · the atomic attempt grant
// ==========================================================================

test("B · one atomic step verifies the fence, picks the pool, reserves and marks", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  const g = l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY });
  assert.deepEqual({ ...g }, { granted: true, reason: null, pool: "apns_initial" });
  assert.equal(l.row("u1", "f1").apns_tried, 1, "the row was not marked in the same step");
  assert.equal(l.spent(DAY).apns_initial, 1);
});

test("B · a stale generation spends NOTHING", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });   // B reclaims
  assert.equal(b.claim_gen, 2);
  const stale = l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY });
  assert.equal(stale.granted, false);
  assert.equal(stale.reason, "stale");
  assert.deepEqual(l.spent(DAY), { apns_initial: 0, apns_retry: 0, kv_reads: 0 },
    "a stale owner spent budget");
  assert.equal(l.row("u1", "f1").apns_tried, 0, "a stale owner marked the row tried");
});

test("B · CRASH BOUNDARY: a crash inside the grant spends nothing", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  assert.throws(() => l.grantAttempt({
    uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY, failAfterReserve: true,
  }), /crash between reserve and mark/);
  // The rollback gave the slot back AND left the row unmarked, so the two can
  // never disagree — which was the whole defect.
  assert.equal(l.spent(DAY).apns_initial, 0, "INITIAL capacity was spent but not recorded");
  assert.equal(l.row("u1", "f1").apns_tried, 0);
  // The redelivery therefore still draws from INITIAL, exactly once.
  const retry = l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY });
  assert.equal(retry.pool, "apns_initial");
  assert.equal(l.spent(DAY).apns_initial, 1);
});

test("B · a grant refused for budget does not mark the row tried", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial });
  const [a] = l.claim("u1", "f1", ctx);
  const g = l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY });
  assert.equal(g.granted, false);
  assert.equal(g.reason, "budget");
  assert.equal(g.pool, "apns_initial");
  assert.equal(l.row("u1", "f1").apns_tried, 0, "a refused grant still marked the row");
});

test("B · concurrent grants cannot overshoot either pool", () => {
  const l = ledger();
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const [g] = l.claim(`u${i}`, "f1", ctx);
    rows.push([`u${i}`, g.claim_gen]);
  }
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial - 100 });
  let granted = 0;
  for (const [uid, gen] of rows) {
    if (l.grantAttempt({ uid, fx: "f1", gen, day: DAY }).granted) granted++;
  }
  assert.equal(granted, 100, "the pool boundary was overrun by concurrent grants");
  assert.equal(l.spent(DAY).apns_initial, POOL.apns_initial);
});

// ==========================================================================
// D · the true maximum production sequence
// ==========================================================================

const FIXTURES = 20;
const RECIPIENTS = 1_000;

/** Every planned triple for a full 20-fixture round at the required scale. */
function maximumShape() {
  const triples = [];
  for (let f = 0; f < FIXTURES; f++) {
    for (let u = 0; u < RECIPIENTS; u++) triples.push([`u${u}`, `f${f}`]);
  }
  return triples;
}

/** Split into queue messages of 45 triples, as the planner would. */
const intoMessages = (triples, size = 45) => {
  const out = [];
  for (let i = 0; i < triples.length; i += size) out.push(triples.slice(i, i + size));
  return out;
};

test("D · MAXIMUM SHAPE: all 20,000 first attempts are protected", () => {
  const l = ledger();
  const messages = intoMessages(maximumShape());
  assert.equal(messages.length, 445);
  let attempted = 0, sent = 0, dropped = 0;
  for (const triples of messages) {
    const out = deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples });
    attempted += out.attempted; sent += out.sent; dropped += out.dropped;
  }
  assert.equal(attempted, RECIPIENTS * FIXTURES, "some first attempts were refused");
  assert.equal(sent, 20_000);
  assert.equal(dropped, 0);
  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial, POOL.apns_initial, "INITIAL was not exactly consumed");
  assert.equal(spent.apns_retry, 0, "first delivery drew from the retry pool");
  assert.ok(spent.kv_reads <= POOL.kv_reads, `KV reads ${spent.kv_reads} exceeded the pool`);
});

test("D · ADVERSARIAL: retries arriving first cannot consume INITIAL", () => {
  const l = ledger();
  // A retry storm from an earlier window lands before the round is planned.
  for (let i = 0; i < 9_000; i++) l.reserve({ day: DAY, pool: "apns_retry", want: 1 });
  assert.equal(l.spent(DAY).apns_retry, POOL.apns_retry);

  // Every first attempt of the full 20-fixture round still succeeds.
  let attempted = 0;
  for (const triples of intoMessages(maximumShape())) {
    attempted += deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples }).attempted;
  }
  assert.equal(attempted, 20_000, "a retry storm starved first delivery");
  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial + spent.apns_retry, APNS_ATTEMPT_CAP);
});

test("D · wholesale APNs failure respects RETRY, KV and every cap", () => {
  const l = ledger();
  const messages = intoMessages(maximumShape());
  // First pass: everything fails at APNs.
  let firstAttempts = 0;
  for (const triples of messages) {
    firstAttempts += deliverMessage(l, {
      day: DAY, now: T0, kickoff: KICK, triples, apns: () => false,
    }).attempted;
  }
  assert.equal(firstAttempts, 20_000);
  assert.equal(l.spent(DAY).apns_initial, POOL.apns_initial);

  // Redelivery: every retry now draws from RETRY, and stops at its cap.
  let retryAttempts = 0, retryDropped = 0;
  for (const triples of messages) {
    const out = deliverMessage(l, {
      day: DAY, now: T0 + 1_000, kickoff: KICK, triples, apns: () => false,
    });
    retryAttempts += out.attempted; retryDropped += out.dropped;
  }
  assert.equal(retryAttempts, POOL.apns_retry, "the retry pool was overrun");
  assert.ok(retryDropped > 0, "nothing was dropped once the retry pool ran out");
  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial + spent.apns_retry, APNS_ATTEMPT_CAP);
  assert.ok(spent.kv_reads <= POOL.kv_reads, `KV reads ${spent.kv_reads} exceeded the pool`);
});

test("D · crash between claim and APNs permission loses nothing", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);                       // claimed, then the isolate dies
  assert.equal(l.spent(DAY).apns_initial, 0, "an attempt was charged before permission");
  const out = deliverMessage(l, {
    day: DAY, now: T0 + RETRY_DELAY_S * 1000, kickoff: KICK, triples: [["u1", "f1"]],
  });
  assert.equal(out.sent, 1, "the reminder was lost");
  assert.equal(l.spent(DAY).apns_initial, 1, "the redelivery did not draw from INITIAL");
  assert.equal(l.spent(DAY).apns_retry, 0);
});

test("D · crash immediately after permission but before fetch", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.grantAttempt({ uid: "u1", fx: "f1", gen: a.claim_gen, day: DAY });   // permission taken
  // The isolate dies here: no fetch happened, but the attempt is spent. That is
  // the deliberate trade — a reservation that could be handed back would let a
  // crash loop spend INITIAL forever.
  assert.equal(l.spent(DAY).apns_initial, 1);
  assert.equal(l.row("u1", "f1").apns_tried, 1);
  const out = deliverMessage(l, {
    day: DAY, now: T0 + RETRY_DELAY_S * 1000, kickoff: KICK, triples: [["u1", "f1"]],
  });
  assert.equal(out.sent, 1, "the reminder was lost");
  // The redelivery is correctly a RETRY, not a second first attempt.
  assert.equal(l.spent(DAY).apns_initial, 1, "a redelivery was charged to first delivery");
  assert.equal(l.spent(DAY).apns_retry, 1);
});

test("D · a stale consumer cannot spend either pool", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS });        // B reclaims
  for (const gen of [a.claim_gen, a.claim_gen + 5, 0]) {
    assert.equal(l.grantAttempt({ uid: "u1", fx: "f1", gen, day: DAY }).granted, false);
  }
  assert.deepEqual(l.spent(DAY), { apns_initial: 0, apns_retry: 0, kv_reads: 0 });
});

test("D · when a cap prevents work the remainder is acked, recorded and counted", () => {
  const l = ledger();
  l.reserve({ day: DAY, pool: "apns_initial", want: POOL.apns_initial - 20 });
  const triples = Array.from({ length: 45 }, (_, i) => [`u${i}`, "f1"]);
  const out = deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples });

  assert.equal(out.action, "ack", "the message was retried instead of acknowledged");
  assert.equal(out.attempted, 20);
  assert.equal(out.dropped, 25);

  // Terminally recorded, not left ambiguous.
  for (let i = 20; i < 45; i++) {
    const row = l.row(`u${i}`, "f1");
    assert.equal(row.state, "dropped", `u${i} was not terminally recorded`);
    assert.equal(row.drop_reason, "budget-exhausted");
  }
  // And diagnostically counted, in one bounded row.
  l.logDrop(DAY, "f1", "budget-exhausted", out.dropped, T0);
  const drops = l.drops();
  assert.equal(drops.length, 1);
  assert.equal(drops[0].uids, 25);
});

// ==========================================================================
// A · the pre-enqueue reservation must cover FOUR fully-working deliveries
// ==========================================================================

test("A · ADVERSARIAL: all four deliveries do complete work, reservation covers it", () => {
  const l = ledger();
  const triples = Array.from({ length: 45 }, (_, i) => [`u${i}`, "f1"]);
  let calls = 0;
  // Every delivery claims, grants and records — the full three-call sequence,
  // four times, which is the case the old value of 8 did not cover.
  for (let delivery = 0; delivery < MAX_DELIVERIES; delivery++) {
    const out = deliverMessage(l, {
      day: DAY, now: T0 + delivery * (LEASE_MS + 1), kickoff: KICK, triples,
      apns: () => false,                       // keep every triple retryable
    });
    assert.equal(out.do_calls, DO_CALLS_PER_WORKING_DELIVERY,
      `delivery ${delivery + 1} did not do the full three-call sequence`);
    calls += out.do_calls;
  }
  assert.equal(calls, 12, `four working deliveries cost ${calls} calls`);
  assert.ok(calls <= PER_MESSAGE_WORST_CASE.do_requests,
    `the pre-enqueue reservation of ${PER_MESSAGE_WORST_CASE.do_requests} does not cover ${calls}`);
  assert.equal(PER_MESSAGE_WORST_CASE.do_requests, calls, "the reservation is not tight");
});

test("A · mixed working and refused deliveries stay inside the reservation", () => {
  const l = ledger();
  const triples = Array.from({ length: 45 }, (_, i) => [`m${i}`, "f2"]);
  let calls = 0;
  // Two full deliveries, then the read budget runs out for the rest.
  for (let delivery = 0; delivery < 2; delivery++) {
    calls += deliverMessage(l, {
      day: DAY, now: T0 + delivery * (LEASE_MS + 1), kickoff: KICK, triples, apns: () => false,
    }).do_calls;
  }
  l.reserve({ day: DAY, pool: "kv_reads", want: POOL.kv_reads });
  for (let delivery = 2; delivery < MAX_DELIVERIES; delivery++) {
    const out = deliverMessage(l, {
      day: DAY, now: T0 + delivery * (LEASE_MS + 1), kickoff: KICK, triples,
    });
    assert.equal(out.do_calls, 1, "a refused delivery cost more than one call");
    calls += out.do_calls;
  }
  assert.equal(calls, 8);
  assert.ok(calls <= PER_MESSAGE_WORST_CASE.do_requests);
});

// ==========================================================================
// B · a read-budget refusal is TERMINAL, not merely reported
// ==========================================================================

/** Exhaust the read pool so the next delivery is refused. */
const starveReads = (l) => l.reserve({ day: DAY, pool: "kv_reads", want: POOL.kv_reads });

test("B1 · first-delivery triples with no rows become terminally dropped", () => {
  const l = ledger();
  starveReads(l);
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK, triples: [["u1", "f1"], ["u2", "f1"]],
  });
  assert.equal(out.action, "ack");
  assert.equal(out.terminated, 2);
  for (const uid of ["u1", "u2"]) {
    const row = l.row(uid, "f1");
    assert.equal(row.state, "dropped", `${uid} was reported dropped but has no row`);
    assert.equal(row.drop_reason, "kv-read-budget-exhausted");
  }
});

test("B2 · failed and lease-expired rows become terminally dropped", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  l.fail("u1", "f1", a.claim_gen);                       // failed
  l.claim("u2", "f1", ctx);                              // claimed, will expire
  starveReads(l);
  const out = deliverMessage(l, {
    day: DAY, now: T0 + LEASE_MS + 1, kickoff: KICK, triples: [["u1", "f1"], ["u2", "f1"]],
  });
  assert.equal(out.terminated, 2);
  assert.equal(l.row("u1", "f1").state, "dropped");
  assert.equal(l.row("u2", "f1").state, "dropped");
});

test("B3 · sent, already-dropped and LIVE claims are left untouched", () => {
  const l = ledger();
  const [a] = l.claim("sentUser", "f1", ctx);
  l.sent("sentUser", "f1", a.claim_gen, T0 + 5);
  const [b] = l.claim("dropUser", "f1", ctx);
  l.drop("dropUser", "f1", b.claim_gen, "ineligible");
  const [c] = l.claim("liveUser", "f1", ctx);            // another consumer, lease LIVE

  starveReads(l);
  const out = deliverMessage(l, {
    day: DAY, now: T0 + 10, kickoff: KICK,
    triples: [["sentUser", "f1"], ["dropUser", "f1"], ["liveUser", "f1"]],
  });
  assert.equal(out.terminated, 0, "a terminal or live row was overwritten");
  assert.equal(out.untouched, 3);
  assert.equal(l.row("sentUser", "f1").state, "sent");
  assert.equal(l.row("dropUser", "f1").drop_reason, "ineligible", "a drop reason was overwritten");
  const live = l.row("liveUser", "f1");
  assert.equal(live.state, "claimed", "another consumer's live claim was stolen");
  assert.equal(live.claim_gen, c.claim_gen);
  assert.equal(live.claim_until, T0 + LEASE_MS, "the live lease was cleared");
});

test("B4 · terminally dropped triples cannot be reclaimed or replanned", () => {
  const l = ledger();
  starveReads(l);
  deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples: [["u1", "f1"]] });
  assert.equal(l.row("u1", "f1").state, "dropped");
  // Not reclaimable at any later time inside the window.
  for (const now of [T0 + 1, T0 + LEASE_MS + 1, KICK - 1]) {
    assert.equal(l.claim("u1", "f1", { ...ctx, now }).length, 0, `reclaimed at +${now - T0}`);
  }
  // And a later delivery with read budget available still does no work for it.
  const l2 = ledger();
  starveReads(l2);
  deliverMessage(l2, { day: DAY, now: T0, kickoff: KICK, triples: [["u1", "f1"]] });
  l2.db.prepare("UPDATE budget SET used = 0 WHERE metric = 'kv_reads'").run();
  let apns = 0;
  const again = deliverMessage(l2, {
    day: DAY, now: T0 + 20, kickoff: KICK, triples: [["u1", "f1"]], apns: () => { apns++; return true; },
  });
  assert.equal(again.attempted, 0, "a terminally dropped triple was replanned into an attempt");
  assert.equal(apns, 0);
});

test("B5 · the bounded diagnostic records the exact dropped count, per fixture", () => {
  const l = ledger();
  starveReads(l);
  const triples = [...Array.from({ length: 30 }, (_, i) => [`u${i}`, "f1"]),
    ...Array.from({ length: 15 }, (_, i) => [`v${i}`, "f2"])];
  const out = deliverMessage(l, { day: DAY, now: T0, kickoff: KICK, triples });
  assert.equal(out.terminated, 45);
  const drops = l.drops();
  assert.equal(drops.length, 2, "the diagnostic is not one bounded row per fixture");
  assert.deepEqual(drops.map((d) => [d.fixture, d.reason, d.uids]),
    [["f1", "kv-read-budget-exhausted", 30], ["f2", "kv-read-budget-exhausted", 15]]);
});

test("B6 · a crash during reserve-plus-terminalise is atomic", () => {
  const l = ledger();
  starveReads(l);
  const triples = [["u1", "f1"], ["u2", "f1"]];
  assert.throws(() => l.reserveReadsOrTerminate({
    day: DAY, want: 96, triples, now: T0, kickoff: KICK, failMidway: true,
  }), /crash during reserve-and-terminalise/);
  // Neither the drops nor the diagnostic survived the rollback.
  assert.equal(l.row("u1", "f1"), undefined, "a partial terminalisation was committed");
  assert.equal(l.row("u2", "f1"), undefined);
  assert.equal(l.drops().length, 0, "a diagnostic survived a rolled-back transaction");
  // And the retry completes cleanly.
  const ok = l.reserveReadsOrTerminate({ day: DAY, want: 96, triples, now: T0, kickoff: KICK });
  assert.equal(ok.refused, true);
  assert.equal(ok.dropped, 2);
  assert.equal(l.drops()[0].uids, 2);
});

test("B7 · the refusal path performs zero reads, zero eligibility and zero APNs", () => {
  const l = ledger();
  starveReads(l);
  let eligibility = 0, apns = 0;
  const before = l.spent(DAY).kv_reads;
  const out = deliverMessage(l, {
    day: DAY, now: T0, kickoff: KICK,
    triples: Array.from({ length: 45 }, (_, i) => [`u${i}`, "f1"]),
    eligible: () => { eligibility++; return true; },
    apns: () => { apns++; return true; },
  });
  assert.equal(eligibility, 0, "the eligibility check ran on a refused delivery");
  assert.equal(apns, 0, "APNs was called on a refused delivery");
  assert.equal(out.reads, 0);
  assert.equal(l.spent(DAY).kv_reads, before, "the refused delivery consumed read budget");
  assert.equal(out.do_calls, 1, "terminalising cost an extra Durable Object call");
  assert.deepEqual(out.pools, { apns_initial: 0, apns_retry: 0 });
});
