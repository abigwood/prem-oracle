// Gate 0 — executed traces for the fenced claim/retry state machine and the
// APNs attempt budget. Real SQL from docs/design/notify-ledger.spec.mjs, run
// against real SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { ledger, LEASE_MS, MAX_ATTEMPTS, APNS_ATTEMPT_CAP, POOL, RETRY_DELAY_S,
  REMINDER_WINDOW_S, deliverMessage, PER_MESSAGE_WORST_CASE } from "../docs/design/notify-ledger.spec.mjs";

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
  assert.equal(APNS_ATTEMPT_CAP, 15_000);
});

test("A · a first attempt draws INITIAL, every later one draws RETRY", () => {
  const l = ledger();
  const [a] = l.claim("u1", "f1", ctx);
  assert.equal(l.poolFor(a), "apns_initial");
  l.markTried("u1", "f1", a.claim_gen);
  l.fail("u1", "f1", a.claim_gen);
  const [b] = l.claim("u1", "f1", { ...ctx, now: T0 + 1 });
  assert.equal(l.poolFor(b), "apns_retry", "a retry drew from the first-attempt pool");
});

test("A · ADVERSARIAL: retries arriving first cannot consume first-attempt capacity", () => {
  const l = ledger();
  // 5,000 retry attempts land before any of the later first deliveries.
  let retriesTaken = 0;
  for (let i = 0; i < 8_000; i++) {
    if (l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted) retriesTaken++;
  }
  assert.equal(retriesTaken, POOL.apns_retry, "the retry pool was not capped at 5,000");

  // Every one of the 10,000 first attempts is still available afterwards.
  let firstTaken = 0;
  for (let i = 0; i < POOL.apns_initial; i++) {
    if (l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted) firstTaken++;
  }
  assert.equal(firstTaken, 10_000, "retries starved first delivery");

  const spent = l.spent(DAY);
  assert.equal(spent.apns_initial + spent.apns_retry, APNS_ATTEMPT_CAP,
    "total attempts exceeded the combined ceiling");
  assert.equal(l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted, 0);
  assert.equal(l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted, 0);
});

test("A · interleaved first attempts and retries never exceed either pool", () => {
  const l = ledger();
  let first = 0, retry = 0;
  for (let round = 0; round < 12_000; round++) {
    if (l.reserve({ day: DAY, pool: "apns_initial", want: 1 }).granted) first++;
    if (l.reserve({ day: DAY, pool: "apns_retry", want: 1 }).granted) retry++;
  }
  assert.equal(first, POOL.apns_initial);
  assert.equal(retry, POOL.apns_retry);
  assert.equal(first + retry, APNS_ATTEMPT_CAP);
});

test("A · the honest capacity arithmetic", () => {
  const FIXTURES = 10, DELIVERIES = 4;
  // One attempt each across ten fixtures.
  assert.equal(APNS_ATTEMPT_CAP / FIXTURES, 1_500);
  // All four deliveries across ten fixtures is FORTY attempts per user.
  assert.equal(APNS_ATTEMPT_CAP / (FIXTURES * DELIVERIES), 375);
  // The INITIAL pool is what actually protects first delivery.
  assert.equal(POOL.apns_initial / FIXTURES, 1_000);
  // At 1,000 users, first attempts exactly consume INITIAL; RETRY holds 5,000.
  assert.equal(1_000 * FIXTURES, POOL.apns_initial);
  assert.equal(POOL.apns_retry, 5_000);
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
  for (let i = 0; i < 2_000; i++) {
    const want = 96;
    if (l.reserve({ day: DAY, pool: "kv_reads", want }).granted === want) granted += want;
  }
  assert.equal(granted, POOL.kv_reads, `spent ${granted}, cap is ${POOL.kv_reads}`);
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
  // Once a message is on the queue its write is already charged and up to four
  // deliveries follow whatever the consumer decides.
  assert.deepEqual(PER_MESSAGE_WORST_CASE, { queue_ops: 7, worker_requests: 4, do_requests: 8 });
});
