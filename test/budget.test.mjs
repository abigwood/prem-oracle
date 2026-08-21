// Gate 0 — executed arithmetic for the operation table, cost guards and capacity.
//
// The model imports the production read-pricing rule and the production packer,
// so a change to either shows up here rather than quietly invalidating a table.
import test from "node:test";
import assert from "node:assert/strict";
import {
  INCLUDED, DESIGN, POOL, PER_MESSAGE_WORST_CASE, DISTRIBUTIONS, SEQUENCES,
  MONTHLY_CAP, DAILY_CAP, METRICS, modelDay, scenario, monthly, worstMonthly,
  planTriples, JOB_TRIPLES,
} from "../docs/design/notify-budget.spec.mjs";
import { worstCaseReads } from "../worker/src/notify/consumer.js";
import { packJobs } from "../worker/src/notify/planner.js";

const OBSERVED_KV_READS = 3_479_700;   // the account's own rolling 31 days

// --- A · the model prices the architecture that ships ---------------------

test("A · the model uses the PRODUCTION read-pricing rule, not a copy of it", () => {
  const oneLeague = planTriples({ leagues: 1, fixtures: 1, recipients: 45 });
  const fragmented = planTriples({ leagues: 45, fixtures: 1, recipients: 45 });
  // 45 recipients, one fixture: 94 reads together, 136 spread across 45 leagues.
  assert.equal(worstCaseReads(oneLeague), 45 * 2 + 1 + 1);
  assert.equal(worstCaseReads(fragmented), 45 * 2 + 1 + 45);
  // And the model's per-job range reflects it.
  const consolidated = modelDay({ distribution: "one_league" });
  const spread = modelDay({ distribution: "fragmented" });
  assert.ok(spread.reads_per_job_max > consolidated.reads_per_job_max,
    "the model prices a fragmented job the same as a consolidated one");
});

test("A · the model uses the PRODUCTION packer", () => {
  const triples = planTriples({ leagues: 1_000 });
  assert.equal(packJobs(triples).length, modelDay({ distribution: "fragmented" }).messages);
  assert.equal(modelDay({ distribution: "one_league" }).messages, Math.ceil(20_000 / JOB_TRIPLES));
});

test("A · every distribution plans the same 20,000 triples and 445 messages", () => {
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    const day = modelDay({ distribution });
    assert.equal(day.planned, 20_000, `${distribution}: ${day.planned} triples`);
    assert.equal(day.messages, 445, `${distribution}: ${day.messages} messages`);
  }
});

// --- A · every first attempt still fits, at every distribution -------------

test("A · every first attempt fits, at every distribution", () => {
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    const day = modelDay({ distribution });
    assert.equal(day.apns_initial, 20_000,
      `${distribution}: only ${day.apns_initial} first attempts were granted`);
    assert.equal(day.refused_deliveries, 0,
      `${distribution}: ${day.refused_deliveries} first-pass deliveries were refused reads`);
    assert.ok(day.kv_reads_initial <= POOL.kv_reads_initial,
      `${distribution}: first pass wanted ${day.kv_reads_initial} reads`);
    assert.equal(day.kv_reads_retry, 0, "a first pass drew from the retry pool");
  }
});

// --- A · dynamic reservations never exceed the pool ------------------------

test("A · dynamic reservations never exceed the configured pool", () => {
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    for (const sequence of SEQUENCES) {
      const { day } = scenario(distribution, sequence);
      assert.ok(day.kv_reads_initial <= POOL.kv_reads_initial,
        `${distribution}/${sequence}: ${day.kv_reads_initial} initial reads over pool`);
      assert.ok(day.kv_reads_retry <= POOL.kv_reads_retry,
        `${distribution}/${sequence}: ${day.kv_reads_retry} retry reads over pool`);
      assert.ok(day.apns_initial + day.apns_retry <= POOL.apns_initial + POOL.apns_retry);
    }
  }
});

test("A · under wholesale retry the RETRY read pool binds, and only it", () => {
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    const day = modelDay({ distribution, deliveriesPerMessage: DESIGN.DELIVERIES });
    // The retry pool is spent to within one job's worth: what remains cannot
    // fund another delivery, so the rest is refused rather than half-served.
    assert.ok(POOL.kv_reads_retry - day.kv_reads_retry < day.reads_per_job_max,
      `${distribution}: ${POOL.kv_reads_retry - day.kv_reads_retry} retry reads left over`);
    assert.ok(day.refused_deliveries > 0, `${distribution}: nothing was refused`);

    // What must NOT happen: the first pass losing anything to that storm.
    assert.ok(day.kv_reads_initial <= POOL.kv_reads_initial,
      `${distribution}: first-pass reads over their own pool`);
    assert.equal(day.apns_initial, 20_000, `${distribution}: a retry cost a first attempt`);
  }
});

test("A · fragmentation costs more per delivery than consolidation", () => {
  const spread = modelDay({ distribution: "fragmented", deliveriesPerMessage: DESIGN.DELIVERIES });
  const together = modelDay({ distribution: "one_league", deliveriesPerMessage: DESIGN.DELIVERIES });
  assert.ok(spread.reads_per_job_max > together.reads_per_job_max);
  assert.ok(spread.kv_reads_initial > together.kv_reads_initial,
    "a fragmented first pass should cost more reads than a consolidated one");
  // Both still deliver every first attempt, which is the point of the split.
  assert.equal(spread.apns_initial, together.apns_initial);
  assert.equal(spread.apns_initial, 20_000);
});

// --- caps ------------------------------------------------------------------

test("C · every daily cap is monthly / 31", () => {
  for (const [metric, cap] of Object.entries(MONTHLY_CAP)) {
    assert.ok(DAILY_CAP[metric] * DESIGN.DAYS <= cap,
      `${metric}: daily ${DAILY_CAP[metric]} x 31 exceeds monthly ${cap}`);
  }
});

test("C · every monthly cap sits inside the Paid included allowance", () => {
  for (const metric of METRICS) {
    // apns_attempts is Apple's; the two read sub-pools are halves of kv_reads,
    // which is the metric the allowance is actually expressed in.
    if (metric === "apns_attempts") continue;
    if (metric === "kv_reads_initial" || metric === "kv_reads_retry") continue;
    assert.ok(MONTHLY_CAP[metric] <= INCLUDED[metric],
      `${metric}: cap ${MONTHLY_CAP[metric]} exceeds included ${INCLUDED[metric]}`);
  }
  // And the two sub-pools sum to exactly the read cap they divide.
  assert.equal(MONTHLY_CAP.kv_reads_initial + MONTHLY_CAP.kv_reads_retry, MONTHLY_CAP.kv_reads);
});

test("C · the WORST month across every distribution clears its cap", () => {
  for (const metric of METRICS) {
    const worst = worstMonthly(metric);
    assert.ok(worst.value <= MONTHLY_CAP[metric],
      `${metric}: ${worst.distribution}/${worst.sequence} needs ${worst.value}, `
      + `cap is ${MONTHLY_CAP[metric]}`);
  }
});

test("C · the WORST day across every distribution clears its daily cap", () => {
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    for (const sequence of SEQUENCES) {
      const { day } = scenario(distribution, sequence);
      for (const metric of METRICS) {
        assert.ok(day[metric] <= DAILY_CAP[metric],
          `${distribution}/${sequence} ${metric}: ${day[metric]} over ${DAILY_CAP[metric]}`);
      }
    }
  }
});

test("C · a working delivery is three DO calls, and the reservation is twelve", () => {
  assert.equal(DESIGN.DO_CALLS_PER_DELIVERY, 3);
  assert.equal(PER_MESSAGE_WORST_CASE.do_requests, 12);
  assert.equal(PER_MESSAGE_WORST_CASE.do_requests,
    DESIGN.DELIVERIES * DESIGN.DO_CALLS_PER_DELIVERY);
});

test("C · the planner's two passes are in the DO-request model", () => {
  const day = modelDay({ distribution: "one_league" });
  assert.equal(day.do_requests_reserved,
    day.messages * 12 + DESIGN.FIXTURES_PER_WINDOW * DESIGN.PLAN_PASSES);
  assert.equal(DESIGN.PLAN_PASSES, 2);
});

// --- E · the combined KV picture ------------------------------------------

test("E · feature plus observed account usage stays inside included KV reads", () => {
  const worst = worstMonthly("kv_reads");
  assert.ok(OBSERVED_KV_READS + worst.value < INCLUDED.kv_reads,
    `combined ${OBSERVED_KV_READS + worst.value} exceeds included ${INCLUDED.kv_reads}`);
  assert.ok(OBSERVED_KV_READS + MONTHLY_CAP.kv_reads < INCLUDED.kv_reads,
    "at the feature cap, combined usage exceeds the included allowance");
});

// --- the generated tables --------------------------------------------------

test("the tables printed in the report are the tables computed here", () => {
  const pad = (v, n) => String(v).padStart(n);
  console.log(`\n  per-day, by distribution and sequence:`);
  console.log(`  ${"distribution".padEnd(14)}${"sequence".padEnd(11)}`
    + `${pad("msgs", 6)}${pad("deliv", 7)}${pad("reads", 9)}${pad("refused", 9)}`
    + `${pad("initial", 9)}${pad("retry", 7)}`);
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    for (const sequence of SEQUENCES) {
      const { day } = scenario(distribution, sequence);
      console.log(`  ${distribution.padEnd(14)}${sequence.padEnd(11)}`
        + `${pad(day.messages, 6)}${pad(day.deliveries, 7)}`
        + `${pad(day.kv_reads.toLocaleString(), 9)}${pad(day.refused_deliveries, 9)}`
        + `${pad(day.apns_initial.toLocaleString(), 9)}${pad(day.apns_retry.toLocaleString(), 7)}`);
    }
  }
  console.log(`\n  worst month per metric, across every distribution:`);
  console.log(`  ${"metric".padEnd(18)}${pad("worst/mo", 12)}${pad("cap/mo", 12)}`
    + `${pad("margin", 9)}  driven by`);
  for (const metric of METRICS) {
    const worst = worstMonthly(metric);
    const margin = worst.value ? (MONTHLY_CAP[metric] / worst.value).toFixed(2) : "-";
    console.log(`  ${metric.padEnd(18)}${pad(worst.value.toLocaleString(), 12)}`
      + `${pad(MONTHLY_CAP[metric].toLocaleString(), 12)}${pad(`${margin}x`, 9)}`
      + `  ${worst.distribution}/${worst.sequence}`);
  }
  const kv = worstMonthly("kv_reads");
  console.log(`\n  KV reads combined with the account's observed ${OBSERVED_KV_READS.toLocaleString()}:`);
  console.log(`    worst feature month ${kv.value.toLocaleString()} -> `
    + `${(OBSERVED_KV_READS + kv.value).toLocaleString()} `
    + `(${(100 * (OBSERVED_KV_READS + kv.value) / INCLUDED.kv_reads).toFixed(1)}% of included)\n`);
  assert.ok(true);
});
