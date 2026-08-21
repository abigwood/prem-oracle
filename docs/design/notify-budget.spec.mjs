// EXECUTABLE SPECIFICATION — the arithmetic authority for Gate 0.
//
// It imports the PRODUCTION read-pricing rule and the PRODUCTION packer rather
// than restating them. An arithmetic authority that models a different
// architecture from the one that ships is not an authority; it is a second
// opinion that nobody checks.
import { worstCaseReads } from "../../worker/src/notify/consumer.js";
import { packJobs, JOB_TRIPLES } from "../../worker/src/notify/planner.js";
import { POOL, PER_MESSAGE_WORST_CASE } from "../../worker/src/notify/ledger.js";

export { POOL, PER_MESSAGE_WORST_CASE, JOB_TRIPLES };

/** Cloudflare Workers PAID included monthly allowances (from the pricing docs). */
export const INCLUDED = {
  queue_ops: 1_000_000,
  do_requests: 1_000_000,
  do_rows_written: 50_000_000,
  do_rows_read: 25_000_000_000,
  do_duration_gbs: 400_000,
  worker_requests: 10_000_000,
  worker_cpu_ms: 30_000_000,
  kv_reads: 10_000_000,
  kv_writes: 1_000_000,
};

export const DESIGN = {
  /** The product's maximum published round. */
  FIXTURES_PER_WINDOW: 20,
  RECIPIENTS: 1_000,
  MAX_RETRIES: 3,
  DELIVERIES: 4,
  QUEUE_READS_MAX: 5,          // documented ceiling for a retried message
  QUEUE_WRITE: 1,
  QUEUE_DELETE: 1,
  CRON_TICKS: 96,
  /** The initial plan and one late sweep. */
  PLAN_PASSES: 2,
  DO_CALLS_PER_DELIVERY: 3,
  DIAGNOSTIC_ROWS_PER_DAY: 40,
  CONSUMER_CPU_MS: 10,
  CRON_CPU_MS: 50,
  DO_MEM_GB: 0.128,
  DO_CALL_MS: 10,
  DAYS: 31,
};

const D = DESIGN;

/**
 * The distributions the read cost actually depends on.
 *
 * A job's reads are 2 per recipient plus one pick map per distinct fixture plus
 * one slate per distinct league/period — so the SAME thousand recipients cost
 * different amounts depending on how many leagues they are spread across. The
 * model has to carry that, because production does.
 */
export const DISTRIBUTIONS = {
  one_league: { leagues: 1, label: "1,000 recipients in one league" },
  fragmented: { leagues: 1_000, label: "1,000 recipients in 1,000 one-person leagues" },
  overlapping: { leagues: 10, overlap: 3, label: "overlapping membership, 10 leagues" },
};

/** Build the triples a planning window would produce for a distribution. */
export function planTriples({ leagues, fixtures = D.FIXTURES_PER_WINDOW, recipients = D.RECIPIENTS, plannedFraction = 1 }) {
  const triples = [];
  const planned = Math.round(recipients * plannedFraction);
  for (let f = 0; f < fixtures; f++) {
    for (let u = 0; u < planned; u++) {
      triples.push({
        uid: `u${String(u).padStart(5, "0")}`,
        fixtureId: `f${String(f).padStart(2, "0")}`,
        // Deterministic smallest-eligible selection puts each recipient in one
        // league; which one depends only on how the leagues are laid out.
        league: `L${String(u % leagues).padStart(4, "0")}`,
        period: "7",
      });
    }
  }
  return triples;
}

/**
 * One day, modelled from REAL packed jobs and REAL per-job read pricing.
 *
 * `deliveriesPerMessage` models redelivery. Reservations are dynamic: each
 * delivery asks for what its own job will read, and the pool refuses once it is
 * spent — which is exactly what production does, and the only way the totals
 * here can be trusted.
 */
export function modelDay({ distribution, plannedFraction = 1, deliveriesPerMessage = 1 }) {
  const { leagues, overlap = 1 } = DISTRIBUTIONS[distribution];
  const triples = planTriples({ leagues: leagues * overlap, plannedFraction });
  const jobs = packJobs(triples);

  // Attempts, from the two pools.
  const planned = triples.length;
  const initial = Math.min(planned, POOL.apns_initial);
  const wantRetry = planned * (deliveriesPerMessage - 1);
  const retry = Math.min(wantRetry, POOL.apns_retry);
  const attempts = initial + retry;

  // Deliveries: the first pass, the retries the pool can fund, and one final
  // pass per message that returns and finds nothing left.
  const retryWorking = retry === 0 ? 0 : Math.ceil(retry / JOB_TRIPLES);
  const finalDropPass = deliveriesPerMessage > 1 ? jobs.length : 0;
  const deliveries = Math.min(jobs.length * deliveriesPerMessage,
    jobs.length + retryWorking + finalDropPass);

  /**
   * Reads, spent job by job against the pool until it refuses. Every delivery
   * reserves its OWN job's worst case, so a fragmented round costs more per
   * delivery than a consolidated one and the pool binds sooner.
   */
  let kvReads = 0;
  let refusedDeliveries = 0;
  const perJob = jobs.map((j) => worstCaseReads(j.triples));
  for (let d = 0; d < deliveries; d++) {
    const want = perJob[d % jobs.length];
    if (kvReads + want > POOL.kv_reads) { refusedDeliveries++; continue; }
    kvReads += want;
  }

  const doReserved = jobs.length * PER_MESSAGE_WORST_CASE.do_requests
    + D.FIXTURES_PER_WINDOW * D.PLAN_PASSES;
  const doCalls = deliveries * D.DO_CALLS_PER_DELIVERY + D.FIXTURES_PER_WINDOW * D.PLAN_PASSES;
  const claimed = Math.min(deliveries * JOB_TRIPLES, planned * deliveriesPerMessage);
  const droppedNoAttempt = Math.max(0, claimed - attempts);
  const queueReads = deliveriesPerMessage === 1 ? 1 : D.QUEUE_READS_MAX;

  return {
    distribution, planned,
    messages: jobs.length,
    deliveries,
    refused_deliveries: refusedDeliveries,
    reads_per_job_min: Math.min(...perJob),
    reads_per_job_max: Math.max(...perJob),
    apns_initial: initial,
    apns_retry: retry,
    apns_attempts: attempts,
    unmet_retry: wantRetry - retry,
    kv_reads: kvReads,
    queue_ops: jobs.length * (D.QUEUE_WRITE + queueReads + D.QUEUE_DELETE),
    do_requests: Math.max(doCalls, doReserved),
    do_calls_actual: doCalls,
    do_requests_reserved: doReserved,
    do_rows_written: claimed + attempts * 2 + droppedNoAttempt
      + deliveries * 2 + D.DIAGNOSTIC_ROWS_PER_DAY,
    do_rows_read: attempts * 5 + claimed,
    do_duration_gbs: +(doCalls * D.DO_CALL_MS / 1000 * D.DO_MEM_GB).toFixed(2),
    worker_requests: D.CRON_TICKS + deliveries,
    worker_cpu_ms: deliveries * D.CONSUMER_CPU_MS + D.CRON_TICKS * D.CRON_CPU_MS,
  };
}

/** normal / worst / max-retry, for each distribution. */
export const SEQUENCES = ["normal", "worst", "max_retry"];
export const sequenceOptions = {
  normal: { plannedFraction: 0.3, deliveriesPerMessage: 1, days: 20 },
  worst: { plannedFraction: 1, deliveriesPerMessage: 1, days: D.DAYS },
  max_retry: { plannedFraction: 1, deliveriesPerMessage: D.DELIVERIES, days: D.DAYS },
};

export function scenario(distribution, sequence) {
  const { days, ...options } = sequenceOptions[sequence];
  return { day: modelDay({ distribution, ...options }), days };
}

export const MONTHLY_CAP = {
  queue_ops: 232_500,
  do_requests: 232_500,
  do_rows_written: 4_000_000,
  do_rows_read: 6_200_000,
  do_duration_gbs: 9_920,
  worker_requests: 148_800,
  worker_cpu_ms: 1_798_000,
  kv_reads: POOL.kv_reads * D.DAYS,
  kv_writes: 35_960,
  apns_attempts: (POOL.apns_initial + POOL.apns_retry) * D.DAYS,
};
export const DAILY_CAP = Object.fromEntries(
  Object.entries(MONTHLY_CAP).map(([k, v]) => [k, Math.floor(v / D.DAYS)]));

export const KV_WRITES_PER_DAY = 714;

export const METRICS = ["queue_ops", "do_requests", "do_rows_written", "do_rows_read",
  "do_duration_gbs", "worker_requests", "worker_cpu_ms", "kv_reads", "apns_attempts"];

export function monthly(distribution, sequence, metric) {
  if (metric === "kv_writes") return KV_WRITES_PER_DAY * D.DAYS;
  const { day, days } = scenario(distribution, sequence);
  return day[metric] * days;
}

/** The worst month for a metric, across every distribution and sequence. */
export function worstMonthly(metric) {
  let worst = { value: 0, distribution: null, sequence: null };
  for (const distribution of Object.keys(DISTRIBUTIONS)) {
    for (const sequence of SEQUENCES) {
      const value = monthly(distribution, sequence, metric);
      if (value > worst.value) worst = { value, distribution, sequence };
    }
  }
  return worst;
}
