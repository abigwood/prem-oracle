// EXECUTABLE SPECIFICATION — the arithmetic authority for Gate 0.
//
// Every figure in the Gate-0 operation and budget tables is computed here, so
// the daily caps, the rolling-31-day caps and the normal/worst/max-retry
// columns cannot drift apart in prose. Verified by test/budget.test.mjs.

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
  JOB_TRIPLES: 45,          // triples per queue message
  JOB_KV_READS: 96,         // <=45 push + <=45 member + <=3 picks + <=3 slate
  MAX_RETRIES: 3,           // queue max_retries -> up to 4 deliveries
  /**
   * Documented: "A message that was retried 3 times (the default), fails
   * delivery on the fourth time ... would incur five (5) read operations."
   * Used as the read ceiling even though no DLQ is attached, which is the
   * conservative direction.
   */
  QUEUE_READS_MAX: 5,
  QUEUE_WRITE: 1,
  QUEUE_DELETE: 1,
  CRON_TICKS: 96,           // 15-minute cadence
  PLAN_DO_CALLS: 20,        // 10 fixtures x (lease + sweep)
  CONSUMER_CPU_MS: 10,
  CRON_CPU_MS: 50,
  DO_MEM_GB: 0.128,
  DO_CALL_MS: 10,
  DAYS: 31,
  APNS_ATTEMPT_CAP: 15_000, // per UTC day, FAILURES INCLUDED
};

const { JOB_TRIPLES, JOB_KV_READS, QUEUE_READS_MAX, QUEUE_WRITE, QUEUE_DELETE,
  CRON_TICKS, PLAN_DO_CALLS, CONSUMER_CPU_MS, CRON_CPU_MS, DO_MEM_GB, DO_CALL_MS,
  APNS_ATTEMPT_CAP } = DESIGN;

/**
 * One day of the notification path.
 *
 * `deliveriesPerMessage` models redelivery. The APNs budget is reserved BEFORE
 * each fetch, so once the cap is reached the remaining deliveries are acked and
 * dropped: they cost a queue read and a DO call, but no APNs fetch and no
 * authoritative KV reads. That early stop is why the max-retry column is not
 * simply four times the worst-shape one.
 */
export function modelDay({ eligible, deliveriesPerMessage = 1, cap = APNS_ATTEMPT_CAP }) {
  const messages = Math.ceil(eligible / JOB_TRIPLES);
  const deliveries = messages * deliveriesPerMessage;

  // Deliveries are served in order until the attempt budget runs out.
  const attempts = Math.min(deliveries * JOB_TRIPLES, cap);
  const workingDeliveries = Math.ceil(attempts / JOB_TRIPLES);
  const droppedDeliveries = deliveries - workingDeliveries;

  const queueReads = deliveriesPerMessage === 1 ? 1 : QUEUE_READS_MAX;
  const doCalls = deliveries * 2 + PLAN_DO_CALLS;   // (reserve+claim), (record|drop)

  return {
    apns_attempts: attempts,
    messages,
    deliveries,
    working_deliveries: workingDeliveries,
    dropped_deliveries: droppedDeliveries,
    queue_ops: messages * (QUEUE_WRITE + queueReads + QUEUE_DELETE),
    do_requests: doCalls,
    do_rows_written: attempts * 2 + deliveries,      // claim + outcome, plus budget rows
    do_rows_read: attempts * 5,
    do_duration_gbs: +(doCalls * DO_CALL_MS / 1000 * DO_MEM_GB).toFixed(2),
    worker_requests: CRON_TICKS + deliveries,
    worker_cpu_ms: deliveries * CONSUMER_CPU_MS + CRON_TICKS * CRON_CPU_MS,
    kv_reads: workingDeliveries * JOB_KV_READS,      // dropped deliveries read nothing
  };
}

/** 1,000 recipients. Worst shape = 10 due fixtures and nobody has picked. */
export const SCENARIOS = {
  normal: { day: modelDay({ eligible: 3_000 }), days: 20 },
  worst: { day: modelDay({ eligible: 10_000 }), days: DESIGN.DAYS },
  max_retry: { day: modelDay({ eligible: 10_000, deliveriesPerMessage: 4 }), days: DESIGN.DAYS },
};

/** Daily caps, each set at monthly / 31 so the daily guard cannot breach it. */
export const MONTHLY_CAP = {
  queue_ops: 232_500,
  do_requests: 232_500,
  do_rows_written: 1_488_000,
  do_rows_read: 4_960_000,
  do_duration_gbs: 9_920,
  worker_requests: 148_800,
  worker_cpu_ms: 1_798_000,
  kv_reads: 2_976_000,
  kv_writes: 17_980,
  apns_attempts: 465_000,
};
export const DAILY_CAP = Object.fromEntries(
  Object.entries(MONTHLY_CAP).map(([k, v]) => [k, Math.floor(v / DESIGN.DAYS)]));

export const KV_WRITES_PER_DAY = 357;   // slatefx: publishes, independent of sends

export const monthly = (name, metric) => {
  const { day, days } = SCENARIOS[name];
  return metric === "kv_writes" ? KV_WRITES_PER_DAY * DESIGN.DAYS : day[metric] * days;
};

export const METRICS = ["queue_ops", "do_requests", "do_rows_written", "do_rows_read",
  "do_duration_gbs", "worker_requests", "worker_cpu_ms", "kv_reads", "apns_attempts"];
