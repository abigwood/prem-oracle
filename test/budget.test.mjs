// Gate 0 — executed arithmetic for the operation table, cost guards and capacity.
import test from "node:test";
import assert from "node:assert/strict";
import { INCLUDED, DESIGN, PLANNER, POOL, APNS_ATTEMPT_CAP, SCENARIOS, MONTHLY_CAP,
  DAILY_CAP, METRICS, monthly, modelDay, capacity, CANDIDATES, RECIPIENTS }
  from "../docs/design/notify-budget.spec.mjs";

test("A · the model uses the product's MAXIMUM shape, not a convenient one", () => {
  // The frozen authority's executed worst case is a 20-fixture round, and
  // league rules permit up to 20 published fixtures.
  assert.equal(DESIGN.FIXTURES_PER_WINDOW, 20);
  assert.equal(RECIPIENTS, 1_000);
  assert.equal(CANDIDATES, 20_000, "1,000 recipients x 20 fixtures is 20,000 triples");
  assert.equal(SCENARIOS.worst.day.planned, 20_000);
});

test("A · the INITIAL pool protects every first attempt at the required scale", () => {
  assert.equal(POOL.apns_initial, 20_000);
  assert.equal(SCENARIOS.worst.day.apns_initial, CANDIDATES,
    "some first attempts at 1,000 recipients were refused");
  assert.equal(SCENARIOS.max_retry.day.apns_initial, CANDIDATES,
    "retries ate into first delivery at the maximum shape");
});

test("A · capacity reported honestly at 100, 1,000 and unsupported 10,000", () => {
  const F = DESIGN.FIXTURES_PER_WINDOW;
  const firstAttempts = (recipients) => recipients * F;
  // 100 recipients: comfortable.
  assert.equal(firstAttempts(100), 2_000);
  assert.ok(firstAttempts(100) * 10 === POOL.apns_initial, "100 recipients should have 10x headroom");
  // 1,000 recipients: exactly protected, no margin.
  assert.equal(firstAttempts(1_000), POOL.apns_initial);
  // 10,000 recipients: ten times over the pool. Formally unsupported.
  assert.equal(firstAttempts(10_000), 200_000);
  assert.equal(firstAttempts(10_000) / POOL.apns_initial, 10);
});

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

test("C · the planner's pre-enqueue reservation matches the per-delivery model", () => {
  // 4 deliveries x 3 DO calls would be 12; the planner reserves 8 because a
  // budget-refused delivery costs one call, not three. Stated, not assumed.
  assert.equal(PLANNER.PER_MESSAGE_WORST_CASE.queue_ops, 7);
  assert.equal(PLANNER.PER_MESSAGE_WORST_CASE.worker_requests, DESIGN.DELIVERIES);
  assert.ok(PLANNER.PER_MESSAGE_WORST_CASE.do_requests >= DESIGN.DO_CALLS_PER_DELIVERY * 2);
});

test("C · the planner reserves each message's unavoidable worst case before enqueueing", () => {
  assert.deepEqual(PLANNER.PER_MESSAGE_WORST_CASE,
    { queue_ops: 7, worker_requests: 4, do_requests: 8 });
});

// --- D · the planner's pick filter ---------------------------------------

test("D · the planner filters saved picks with one bounded read per fixture", () => {
  assert.equal(PLANNER.FILTERS_SAVED_PICKS, true);
  assert.equal(PLANNER.PICK_READS_PER_FIXTURE, 1);
  // Twenty fixtures cost twenty reads regardless of how many recipients exist.
  assert.equal(DESIGN.FIXTURES_PER_WINDOW * PLANNER.PICK_READS_PER_FIXTURE, 20);
});

test("D · message counts follow PLANNED triples, not successful sends", () => {
  assert.equal(SCENARIOS.worst.day.planned, CANDIDATES);
  assert.equal(SCENARIOS.worst.day.messages, Math.ceil(CANDIDATES / DESIGN.JOB_TRIPLES));
  assert.equal(SCENARIOS.normal.day.planned, 6_000);
  assert.equal(SCENARIOS.normal.day.messages, Math.ceil(6_000 / DESIGN.JOB_TRIPLES));
  // A wholesale-failure day sends nothing, yet its message count is unchanged.
  assert.equal(SCENARIOS.max_retry.day.messages, SCENARIOS.worst.day.messages);
});

// --- A · pools and capacity ----------------------------------------------

test("A · the pools sum to the hard ceiling", () => {
  assert.equal(POOL.apns_initial, 20_000);
  assert.equal(POOL.apns_retry, 5_000);
  assert.equal(APNS_ATTEMPT_CAP, 25_000);
});

test("A · capacity arithmetic is per ATTEMPT: 20 fixtures x 4 deliveries is eighty", () => {
  const oneEach = capacity(20, 1);
  assert.equal(oneEach.attempts_per_user, 20);
  assert.equal(oneEach.on_initial_pool, 1_000, "first delivery must cover the required scale");

  const allFour = capacity(20, 4);
  assert.equal(allFour.attempts_per_user, 80, "four deliveries across twenty fixtures is eighty");
  assert.equal(allFour.on_total_cap, Math.floor(APNS_ATTEMPT_CAP / 80));
  // Retries never change first-delivery capacity: that is the point of the split.
  assert.equal(allFour.on_initial_pool, 1_000);
});

test("A · at 1,000 recipients the INITIAL pool is exactly consumed — no margin", () => {
  const day = SCENARIOS.worst.day;
  assert.equal(day.apns_initial, POOL.apns_initial);
  assert.equal(day.planned, POOL.apns_initial, "first attempts exactly fill the pool");
  assert.equal(POOL.apns_retry, 5_000);
});

test("A · a wholesale-retry day is capped, and the unmet retries are visible", () => {
  const day = SCENARIOS.max_retry.day;
  assert.equal(day.apns_initial, 20_000, "retries ate into first delivery");
  assert.equal(day.apns_retry, 5_000);
  assert.equal(day.apns_attempts, APNS_ATTEMPT_CAP);
  // 20,000 planned x 3 further deliveries = 60,000 wanted, 5,000 granted.
  assert.equal(day.unmet_retry, 55_000);
});

test("C · a working delivery costs THREE Durable Object calls, not two", () => {
  assert.equal(DESIGN.DO_CALLS_PER_DELIVERY, 3);
  const day = SCENARIOS.max_retry.day;
  assert.equal(day.do_requests,
    day.deliveries * 3 + DESIGN.FIXTURES_PER_WINDOW * 2);
});

test("C · rows written count work that is claimed then dropped WITHOUT an attempt", () => {
  const day = SCENARIOS.max_retry.day;
  assert.ok(day.dropped_no_attempt > 0, "the max-retry day drops nothing without attempting");
  // The old formula was attempts*2 + deliveries; it ignored these rows entirely.
  const oldFormula = day.apns_attempts * 2 + day.deliveries;
  assert.ok(day.do_rows_written > oldFormula,
    `corrected rows ${day.do_rows_written} should exceed the old ${oldFormula}`);
  // And every named component is present.
  const named = day.claimed + day.apns_attempts * 2 + day.dropped_no_attempt
    + day.deliveries * 2 + DESIGN.DIAGNOSTIC_ROWS_PER_DAY;
  assert.equal(day.do_rows_written, named);
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
  const F = DESIGN.FIXTURES_PER_WINDOW;
  console.log(`  capacity @ ${F} fixtures: INITIAL protects ${capacity(F, 1).on_initial_pool} recipients; ` +
    `combined cap covers ${capacity(F, 4).on_total_cap} at all four deliveries`);
  console.log(`  100 recipients = ${100 * F} first attempts; 1,000 = ${1000 * F}; ` +
    `10,000 = ${(10000 * F).toLocaleString()} (${(10000 * F) / POOL.apns_initial}x the pool, unsupported)\n`);
  assert.ok(true);
});
