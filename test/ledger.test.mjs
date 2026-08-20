// Gate 0 — executed traces for the fenced claim/retry state machine and the
// APNs attempt budget. Real SQL from docs/design/notify-ledger.spec.mjs, run
// against real SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { ledger, LEASE_MS, MAX_ATTEMPTS, APNS_ATTEMPT_CAP } from "../docs/design/notify-ledger.spec.mjs";

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

test("budget · a normal day reserves attempts and never reaches the cap", () => {
  const l = ledger();
  let total = 0;
  for (let job = 0; job < 67; job++) total += l.reserve({ day: DAY, want: 45 }).granted;
  assert.equal(total, 3_015);
  assert.ok(total < APNS_ATTEMPT_CAP);
});

test("budget · wholesale failure consumes budget: failures pay for themselves", () => {
  const l = ledger();
  // Every job fails all 45 sends and is redelivered four times.
  let attempts = 0;
  let stopped = 0;
  for (let delivery = 0; delivery < 235 * 4; delivery++) {
    const { granted } = l.reserve({ day: DAY, want: 45 });
    if (granted === 0) { stopped++; continue; }     // acked and dropped, no fetch
    attempts += granted;
  }
  assert.equal(attempts, APNS_ATTEMPT_CAP, "the cap was overshot or undershot");
  assert.ok(stopped > 0, "the day never actually stopped");
  // 15,000 / 45 = 333.33 -> 333 full jobs plus one partial grant of 15.
  assert.equal(Math.ceil(APNS_ATTEMPT_CAP / 45), 334);
});

test("budget · a partial grant is honoured at the boundary, not refused", () => {
  const l = ledger();
  l.reserve({ day: DAY, want: APNS_ATTEMPT_CAP - 10 });
  const edge = l.reserve({ day: DAY, want: 45 });
  assert.equal(edge.granted, 10, "the boundary job was refused instead of trimmed");
  assert.equal(edge.remaining, 0);
  assert.equal(l.reserve({ day: DAY, want: 1 }).granted, 0);
});

test("budget · concurrent consumers cannot overshoot the cap", () => {
  const l = ledger();
  // Interleaved reservations, as separate consumers would issue them. The
  // Durable Object is single-threaded, so each reserve() is atomic.
  const consumers = Array.from({ length: 40 }, () => 0);
  let round = 0;
  while (round < 20) {
    for (let c = 0; c < consumers.length; c++) consumers[c] += l.reserve({ day: DAY, want: 45 }).granted;
    round++;
  }
  const total = consumers.reduce((a, b) => a + b, 0);
  assert.equal(total, APNS_ATTEMPT_CAP, `40 consumers spent ${total}, cap is ${APNS_ATTEMPT_CAP}`);
  assert.equal(l.reserve({ day: DAY, want: 1 }).granted, 0);
});

test("budget · each UTC day gets its own allowance", () => {
  const l = ledger();
  l.reserve({ day: DAY, want: APNS_ATTEMPT_CAP });
  assert.equal(l.reserve({ day: DAY, want: 1 }).granted, 0);
  assert.equal(l.reserve({ day: "2026-09-13", want: 45 }).granted, 45);
});

test("budget · exhaustion drops the remaining work and records why", () => {
  const l = ledger();
  l.reserve({ day: DAY, want: APNS_ATTEMPT_CAP });
  const [a] = l.claim("u1", "f1", ctx);
  const { granted } = l.reserve({ day: DAY, want: 1 });
  assert.equal(granted, 0);
  // No fetch happens. The owner drops its own claim, fenced, and logs it.
  assert.equal(l.drop("u1", "f1", a.claim_gen, "budget-exhausted"), 1);
  l.logDrop(DAY, "f1", "budget-exhausted", 1, T0);
  assert.equal(l.row("u1", "f1").state, "dropped");
  assert.deepEqual(l.drops().map((d) => d.reason), ["budget-exhausted"]);
});
