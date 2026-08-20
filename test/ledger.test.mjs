// Gate 0 blocker A — executed traces for the claim/retry state machine.
// Runs the real SQL from docs/design/notify-ledger.spec.mjs against real SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { ledger, LEASE_MS, MAX_ATTEMPTS } from "../docs/design/notify-ledger.spec.mjs";

const T0 = 1_800_000_000_000;
const KICK = T0 + 60 * 60 * 1000;          // kick-off one hour out
const ctx = { now: T0, kickoff: KICK };

test("A · a first claim is granted and leased", () => {
  const l = ledger();
  const got = l.claim("u1", "f1", ctx);
  assert.equal(got.length, 1);
  assert.equal(got[0].attempts, 1);
  const row = l.row("u1", "f1");
  assert.equal(row.state, "claimed");
  assert.equal(row.claim_until, T0 + LEASE_MS);
});

test("A · concurrency: an active claim cannot be stolen", () => {
  const l = ledger();
  assert.equal(l.claim("u1", "f1", ctx).length, 1);
  // A second consumer, one second later, while the lease is live.
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + 1_000 }).length, 0);
  assert.equal(l.row("u1", "f1").attempts, 1, "a refused claim still burned an attempt");
});

test("A · lease expiry: an abandoned claim becomes reclaimable", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  const justBefore = T0 + LEASE_MS - 1;
  assert.equal(l.claim("u1", "f1", { ...ctx, now: justBefore }).length, 0, "stolen early");
  const atExpiry = T0 + LEASE_MS;
  const got = l.claim("u1", "f1", { ...ctx, now: atExpiry });
  assert.equal(got.length, 1, "an expired lease was not reclaimable");
  assert.equal(got[0].attempts, 2);
  assert.equal(l.row("u1", "f1").claim_until, atExpiry + LEASE_MS);
});

test("A · explicit failure is reclaimable at once, without waiting out the lease", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  assert.equal(l.fail("u1", "f1"), 1);
  assert.equal(l.row("u1", "f1").state, "failed");
  const got = l.claim("u1", "f1", { ...ctx, now: T0 + 1 });
  assert.equal(got.length, 1, "a failed row waited for a lease it no longer holds");
  assert.equal(got[0].attempts, 2);
});

test("A · sent is terminal, and stays terminal past any lease", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  assert.equal(l.sent("u1", "f1", T0 + 500), 1);
  for (const now of [T0 + 600, T0 + LEASE_MS + 1, KICK - 1]) {
    assert.equal(l.claim("u1", "f1", { ...ctx, now }).length, 0, `re-sent at ${now - T0}ms`);
  }
  assert.equal(l.row("u1", "f1").state, "sent");
  assert.equal(l.row("u1", "f1").attempts, 1, "a terminal row was still counting attempts");
});

test("A · retry after partial failure re-sends only the unsent", () => {
  const l = ledger();
  const batch = ["u1", "u2", "u3"];
  for (const uid of batch) l.claim(uid, "f1", ctx);
  l.sent("u1", "f1", T0 + 10);          // delivered
  l.fail("u2", "f1");                   // transient APNs failure
  l.fail("u3", "f1");
  // The queue redelivers the whole message; the claim decides what is left.
  const again = batch.flatMap((uid) => l.claim(uid, "f1", { ...ctx, now: T0 + 20 }));
  assert.deepEqual(again.map((r) => r.uid), ["u2", "u3"],
    "a successful recipient was re-notified, or a failure was not retried");
});

test("A · crash after APNs but before recording: at-least-once, documented", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  // APNs accepted the push. The consumer dies here; nothing records 'sent'.
  const row = l.row("u1", "f1");
  assert.equal(row.state, "claimed");
  // Nothing can re-send while the lease stands.
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS - 1 }).length, 0);
  // Once it expires the work is reclaimable, so the user may receive a second
  // push. This is the unavoidable window; apns-collapse-id makes Apple replace
  // rather than stack it, so the lock screen still shows one notification.
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS }).length, 1);
});

test("A · attempts are capped, so a poisoned triple cannot cycle forever", () => {
  const l = ledger();
  let now = T0;
  let granted = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    if (l.claim("u1", "f1", { ...ctx, now }).length) granted++;
    l.fail("u1", "f1");
    now += 1_000;
  }
  assert.equal(granted, MAX_ATTEMPTS, `granted ${granted} claims, cap is ${MAX_ATTEMPTS}`);
  assert.equal(l.row("u1", "f1").attempts, MAX_ATTEMPTS);
});

test("A · a lease can never outlive kick-off", () => {
  const l = ledger();
  const soon = T0 + 30_000;             // kick-off in 30s, lease is 120s
  l.claim("u1", "f1", { now: T0, kickoff: soon });
  assert.equal(l.row("u1", "f1").claim_until, soon, "the lease outlived the fixture");
});

test("A · nothing is claimed once the fixture has kicked off", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  l.fail("u1", "f1");
  assert.equal(l.claim("u1", "f1", { ...ctx, now: KICK }).length, 0, "claimed at kick-off");
  assert.equal(l.claim("u1", "f1", { ...ctx, now: KICK + 1 }).length, 0, "claimed after kick-off");
});

test("A · dropped is terminal", () => {
  const l = ledger();
  l.claim("u1", "f1", ctx);
  assert.equal(l.drop("u1", "f1"), 1);
  assert.equal(l.claim("u1", "f1", { ...ctx, now: T0 + LEASE_MS + 1 }).length, 0);
  assert.equal(l.row("u1", "f1").state, "dropped");
});

test("A · the prune sweep clears the week, and only past fixtures", () => {
  const l = ledger();
  l.claim("u1", "past", { now: T0, kickoff: T0 + 1_000 });
  l.claim("u1", "future", ctx);
  assert.equal(l.prune(T0 + 2_000), 1);
  assert.equal(l.row("u1", "past"), undefined);
  assert.ok(l.row("u1", "future"));
});

test("A · one notification per user per fixture across overlapping leagues", () => {
  const l = ledger();
  // The same user reachable through three leagues; the primary key is (uid, fixture).
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "AAA" }).length, 1);
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "BBB" }).length, 0);
  assert.equal(l.claim("u1", "f1", { ...ctx, league: "CCC" }).length, 0);
  assert.equal(l.row("u1", "f1").league, "AAA", "a later league overwrote the chosen one");
});
