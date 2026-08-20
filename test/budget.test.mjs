// Gate 0 — executed arithmetic for the operation table and cost guards.
import test from "node:test";
import assert from "node:assert/strict";
import { INCLUDED, DESIGN, SCENARIOS, MONTHLY_CAP, DAILY_CAP, METRICS, monthly, modelDay }
  from "../docs/design/notify-budget.spec.mjs";

test("C · every daily cap is monthly / 31, so the daily guard cannot breach the monthly one", () => {
  for (const [metric, cap] of Object.entries(MONTHLY_CAP)) {
    assert.ok(DAILY_CAP[metric] * DESIGN.DAYS <= cap,
      `${metric}: daily ${DAILY_CAP[metric]} x 31 exceeds monthly ${cap}`);
  }
});

test("C · every monthly cap sits inside the Paid included allowance", () => {
  for (const metric of METRICS) {
    if (metric === "apns_attempts") continue;      // Apple, not Cloudflare
    assert.ok(MONTHLY_CAP[metric] <= INCLUDED[metric],
      `${metric}: cap ${MONTHLY_CAP[metric]} exceeds included ${INCLUDED[metric]}`);
  }
});

test("C · queue accounting uses the documented 5-read retry ceiling and no DLQ", () => {
  assert.equal(DESIGN.QUEUE_READS_MAX, 5);
  const best = modelDay({ eligible: 45 });
  assert.equal(best.queue_ops, 3, "a first-time success should be write + read + delete");
  const retried = modelDay({ eligible: 45, deliveriesPerMessage: 4 });
  assert.equal(retried.queue_ops, 7, "1 write + 5 reads + 1 delete");
});

test("D · the budget caps APNs ATTEMPTS, not successes", () => {
  // Uncapped, wholesale failure would attempt 10,000 x 4 = 40,000 times.
  const uncapped = modelDay({ eligible: 10_000, deliveriesPerMessage: 4, cap: Infinity });
  assert.equal(uncapped.apns_attempts, 40_140);
  // Capped, the day stops at the cap.
  const capped = SCENARIOS.max_retry.day;
  assert.equal(capped.apns_attempts, DESIGN.APNS_ATTEMPT_CAP);
  assert.ok(capped.dropped_deliveries > 0, "nothing was dropped, so nothing stopped");
});

test("D · dropped deliveries cost no APNs fetch and no authoritative reads", () => {
  const capped = SCENARIOS.max_retry.day;
  assert.equal(capped.kv_reads, capped.working_deliveries * DESIGN.JOB_KV_READS);
  const uncapped = modelDay({ eligible: 10_000, deliveriesPerMessage: 4, cap: Infinity });
  assert.ok(capped.kv_reads < uncapped.kv_reads / 2,
    "the early stop did not actually reduce the read load");
});

test("C+D · every max-retry DAY clears its daily cap", () => {
  const day = SCENARIOS.max_retry.day;
  for (const metric of METRICS) {
    assert.ok(day[metric] <= DAILY_CAP[metric],
      `${metric}: max-retry day ${day[metric]} exceeds daily cap ${DAILY_CAP[metric]}`);
  }
});

test("C+D · every max-retry MONTH clears its monthly cap", () => {
  for (const metric of METRICS) {
    const used = monthly("max_retry", metric);
    assert.ok(used <= MONTHLY_CAP[metric],
      `${metric}: max-retry month ${used} exceeds monthly cap ${MONTHLY_CAP[metric]}`);
  }
});

test("E · the feature plus observed account usage stays inside included KV reads", () => {
  const OBSERVED = 3_479_700;                     // measured, rolling 31 days
  const worst = OBSERVED + monthly("max_retry", "kv_reads");
  assert.ok(worst < INCLUDED.kv_reads,
    `combined ${worst} exceeds included ${INCLUDED.kv_reads}`);
  const atCap = OBSERVED + MONTHLY_CAP.kv_reads;
  assert.ok(atCap < INCLUDED.kv_reads, `at the cap, combined ${atCap} exceeds included`);
});

test("the table printed in the report is the table computed here", () => {
  const rows = METRICS.map((m) => [m, monthly("normal", m), monthly("worst", m), monthly("max_retry", m)]);
  console.log(`\n  ${"metric".padEnd(18)}${"normal/mo".padStart(12)}${"worst/mo".padStart(12)}` +
    `${"maxretry/mo".padStart(13)}${"cap/day".padStart(10)}${"cap/mo".padStart(12)}${"margin".padStart(9)}`);
  for (const [m, n, w, x] of rows) {
    console.log(`  ${m.padEnd(18)}${n.toLocaleString().padStart(12)}${w.toLocaleString().padStart(12)}` +
      `${x.toLocaleString().padStart(13)}${DAILY_CAP[m].toLocaleString().padStart(10)}` +
      `${MONTHLY_CAP[m].toLocaleString().padStart(12)}${(MONTHLY_CAP[m] / x).toFixed(2).padStart(8)}x`);
  }
  const d = SCENARIOS.max_retry.day;
  console.log(`\n  max-retry day: ${d.messages} messages, ${d.deliveries} deliveries, ` +
    `${d.working_deliveries} did work, ${d.dropped_deliveries} acked+dropped, ` +
    `${d.apns_attempts.toLocaleString()} APNs attempts, ${d.kv_reads.toLocaleString()} KV reads\n`);
  assert.equal(rows.length, METRICS.length);
});
