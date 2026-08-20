// Gate 0 — executed arithmetic for the operation table, cost guards and capacity.
import test from "node:test";
import assert from "node:assert/strict";
import { INCLUDED, DESIGN, PLANNER, POOL, APNS_ATTEMPT_CAP, SCENARIOS, MONTHLY_CAP,
  DAILY_CAP, METRICS, monthly, modelDay, capacity, CANDIDATES }
  from "../docs/design/notify-budget.spec.mjs";

// --- C · caps -------------------------------------------------------------

test("C · every daily cap is monthly / 31, so the daily guard cannot breach the monthly one", () => {
  for (const [metric, cap] of Object.entries(MONTHLY_CAP)) {
    assert.ok(DAILY_CAP[metric] * DESIGN.DAYS <= cap,
      `${metric}: daily ${DAILY_CAP[metric]} x 31 exceeds monthly ${cap}`);
  }
});

test("C · every monthly cap sits inside the Paid included allowance", () => {
  for (const metric of METRICS) {
    if (metric === "apns_attempts") continue;              // Apple, not Cloudflare
    assert.ok(MONTHLY_CAP[metric] <= INCLUDED[metric],
      `${metric}: cap ${MONTHLY_CAP[metric]} exceeds included ${INCLUDED[metric]}`);
  }
});

test("C · queue accounting uses the documented 5-read retry ceiling and no DLQ", () => {
  assert.equal(DESIGN.QUEUE_READS_MAX, 5);
  assert.equal(modelDay({ planned: 45 }).queue_ops, 3);
  assert.equal(modelDay({ planned: 45, deliveriesPerMessage: 4 }).queue_ops, 7);
});

test("C · the planner reserves each message's unavoidable worst case before enqueueing", () => {
  assert.deepEqual(PLANNER.PER_MESSAGE_WORST_CASE,
    { queue_ops: 7, worker_requests: 4, do_requests: 8 });
});

// --- D · the planner's pick filter ---------------------------------------

test("D · the planner filters saved picks with one bounded read per fixture", () => {
  assert.equal(PLANNER.FILTERS_SAVED_PICKS, true);
  assert.equal(PLANNER.PICK_READS_PER_FIXTURE, 1);
  // Ten fixtures cost ten reads regardless of how many recipients there are.
  const cost = DESIGN.FIXTURES_PER_WINDOW * PLANNER.PICK_READS_PER_FIXTURE;
  assert.equal(cost, 10);
});

test("D · message counts follow PLANNED triples, not successful sends", () => {
  // Same candidate pool, different planned counts -> different message counts.
  assert.equal(SCENARIOS.worst.day.planned, CANDIDATES);
  assert.equal(SCENARIOS.worst.day.messages, Math.ceil(CANDIDATES / DESIGN.JOB_TRIPLES));
  assert.equal(SCENARIOS.normal.day.planned, 3_000);
  assert.equal(SCENARIOS.normal.day.messages, Math.ceil(3_000 / DESIGN.JOB_TRIPLES));
  // A wholesale-failure day sends nothing, yet its message count is unchanged.
  assert.equal(SCENARIOS.max_retry.day.messages, SCENARIOS.worst.day.messages);
});

// --- A · pools and capacity ----------------------------------------------

test("A · the pools sum to the hard ceiling", () => {
  assert.equal(POOL.apns_initial, 10_000);
  assert.equal(POOL.apns_retry, 5_000);
  assert.equal(APNS_ATTEMPT_CAP, 15_000);
});

test("A · capacity arithmetic is per ATTEMPT, and four deliveries means forty", () => {
  const oneEach = capacity(10, 1);
  assert.equal(oneEach.attempts_per_user, 10);
  assert.equal(oneEach.on_total_cap, 1_500);

  const allFour = capacity(10, 4);
  assert.equal(allFour.attempts_per_user, 40, "four deliveries across ten fixtures is forty attempts");
  assert.equal(allFour.on_total_cap, 375);

  // First delivery is protected by the INITIAL pool, not by the combined cap.
  assert.equal(oneEach.on_initial_pool, 1_000);
  assert.equal(allFour.on_initial_pool, 1_000, "retries must not change first-delivery capacity");
});

test("A · at 1,000 recipients the INITIAL pool is exactly consumed — no margin", () => {
  const day = SCENARIOS.worst.day;
  assert.equal(day.apns_initial, POOL.apns_initial);
  assert.equal(day.planned, POOL.apns_initial, "first attempts exactly fill the pool");
  // And the retry pool is what is left, not a 50% margin on the whole thing.
  assert.equal(POOL.apns_retry, 5_000);
});

test("A · a wholesale-retry day is capped, and the unmet retries are visible", () => {
  const day = SCENARIOS.max_retry.day;
  assert.equal(day.apns_initial, 10_000, "retries ate into first delivery");
  assert.equal(day.apns_retry, 5_000);
  assert.equal(day.apns_attempts, APNS_ATTEMPT_CAP);
  // 10,000 planned x 3 further deliveries = 30,000 wanted, 5,000 granted.
  assert.equal(day.unmet_retry, 25_000);
});

// --- caps hold ------------------------------------------------------------

test("C+A · every max-retry DAY clears its daily cap", () => {
  const day = SCENARIOS.max_retry.day;
  for (const metric of METRICS) {
    assert.ok(day[metric] <= DAILY_CAP[metric],
      `${metric}: max-retry day ${day[metric]} exceeds daily cap ${DAILY_CAP[metric]}`);
  }
});

test("C+A · every max-retry MONTH clears its monthly cap", () => {
  for (const metric of METRICS) {
    const used = monthly("max_retry", metric);
    assert.ok(used <= MONTHLY_CAP[metric],
      `${metric}: max-retry month ${used} exceeds monthly cap ${MONTHLY_CAP[metric]}`);
  }
});

test("C · reads are reserved per delivery, so retry deliveries pay even when they drop", () => {
  const day = SCENARIOS.max_retry.day;
  const perDelivery = DESIGN.JOB_TRIPLES * DESIGN.KV_READS_PER_TRIPLE + DESIGN.KV_READS_FIXED;
  assert.equal(perDelivery, 96);
  assert.equal(day.kv_reads, day.deliveries * perDelivery,
    "the model quietly assumed dropped deliveries read nothing");
});

test("E · the feature plus observed account usage stays inside included KV reads", () => {
  const OBSERVED = 3_479_700;
  const worst = OBSERVED + monthly("max_retry", "kv_reads");
  assert.ok(worst < INCLUDED.kv_reads, `combined ${worst} exceeds included ${INCLUDED.kv_reads}`);
  const atCap = OBSERVED + MONTHLY_CAP.kv_reads;
  assert.ok(atCap < INCLUDED.kv_reads, `at the cap, combined ${atCap} exceeds included`);
});

test("E · Worker CPU is excluded from the Free-quota claim", () => {
  // Free CPU is a PER-INVOCATION execution limit, not a monthly metered
  // allowance, so it cannot be "below a Free-tier quota" in the sense the
  // other metrics are. Only Paid metered dimensions are claimed.
  const meteredMonthly = METRICS.filter((m) => m !== "apns_attempts" && m !== "worker_cpu_ms");
  for (const metric of meteredMonthly) {
    assert.ok(MONTHLY_CAP[metric] <= INCLUDED[metric]);
  }
  // CPU is still capped against its PAID included allowance, which is metered.
  assert.ok(MONTHLY_CAP.worker_cpu_ms <= INCLUDED.worker_cpu_ms);
});

test("the tables printed in the report are the tables computed here", () => {
  console.log(`\n  ${"metric".padEnd(18)}${"normal/mo".padStart(12)}${"worst/mo".padStart(12)}` +
    `${"maxretry/mo".padStart(13)}${"cap/day".padStart(10)}${"cap/mo".padStart(12)}${"margin".padStart(9)}`);
  for (const m of METRICS) {
    const [n, w, x] = ["normal", "worst", "max_retry"].map((s) => monthly(s, m));
    console.log(`  ${m.padEnd(18)}${n.toLocaleString().padStart(12)}${w.toLocaleString().padStart(12)}` +
      `${x.toLocaleString().padStart(13)}${DAILY_CAP[m].toLocaleString().padStart(10)}` +
      `${MONTHLY_CAP[m].toLocaleString().padStart(12)}${(MONTHLY_CAP[m] / x).toFixed(2).padStart(8)}x`);
  }
  const d = SCENARIOS.max_retry.day;
  console.log(`\n  max-retry day: ${d.planned.toLocaleString()} planned, ${d.messages} messages, ` +
    `${d.deliveries} deliveries, ${d.apns_initial.toLocaleString()} initial + ` +
    `${d.apns_retry.toLocaleString()} retry attempts, ${d.unmet_retry.toLocaleString()} retries unmet, ` +
    `${d.kv_reads.toLocaleString()} KV reads`);
  console.log(`  capacity: ${capacity(10, 1).on_total_cap} users at one attempt each; ` +
    `${capacity(10, 4).on_total_cap} at all four; ` +
    `${capacity(10, 1).on_initial_pool} protected by the INITIAL pool\n`);
  assert.ok(true);
});
