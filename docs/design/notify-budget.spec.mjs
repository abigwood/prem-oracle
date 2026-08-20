// EXECUTABLE SPECIFICATION — the arithmetic authority for Gate 0.
//
// Every figure in the Gate-0 operation, budget and capacity tables is computed
// here, so caps, scenarios and capacity claims cannot drift apart in prose.
// Verified by test/budget.test.mjs.

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

/**
 * The planner filters saved picks BEFORE creating jobs.
 *
 * It costs one bounded `picks:<fixtureId>` read per due fixture — ten reads for
 * a ten-fixture window, independent of how many recipients there are — and it
 * is the difference between enqueueing work for everybody and enqueueing it for
 * the people who still owe a prediction. Queue message counts below are
 * therefore based on PLANNED triples, never on successful APNs sends.
 *
 * The consumer still re-reads picks authoritatively before sending: this filter
 * is an economy, not the correctness check (D2 requires the re-check).
 */
export const PLANNER = {
  FILTERS_SAVED_PICKS: true,
  PICK_READS_PER_FIXTURE: 1,
  /** Reserved before sendBatch, because enqueueing makes these unavoidable. */
  PER_MESSAGE_WORST_CASE: { queue_ops: 7, worker_requests: 4, do_requests: 8 },
};

export const DESIGN = {
  JOB_TRIPLES: 45,
  KV_READS_PER_TRIPLE: 2,       // push: + member:
  KV_READS_FIXED: 6,            // <=3 picks: + <=3 custom_slate: per message
  MAX_RETRIES: 3,
  DELIVERIES: 4,
  QUEUE_READS_MAX: 5,           // documented ceiling for a retried message
  QUEUE_WRITE: 1,
  QUEUE_DELETE: 1,
  CRON_TICKS: 96,
  FIXTURES_PER_WINDOW: 10,
  CONSUMER_CPU_MS: 10,
  CRON_CPU_MS: 50,
  DO_MEM_GB: 0.128,
  DO_CALL_MS: 10,
  DAYS: 31,
};

/** Two pools, so a retry can never starve a recipient's first attempt. */
export const POOL = {
  apns_initial: 10_000,
  apns_retry: 5_000,
  kv_reads: 96_000,
};
export const APNS_ATTEMPT_CAP = POOL.apns_initial + POOL.apns_retry;

const D = DESIGN;
const readsPerDelivery = D.JOB_TRIPLES * D.KV_READS_PER_TRIPLE + D.KV_READS_FIXED;  // 96

/**
 * One day of the notification path.
 *
 * `planned` is the triple count AFTER the planner's pick filter. `deliveries`
 * models redelivery; the conservative ceiling assumes every message is
 * delivered the full four times even though a message whose remainder is
 * budget-dropped is acked and stops coming back.
 *
 * Ordering matters to the arithmetic: a delivery reserves its worst-case KV
 * read allowance BEFORE any read, so a retry delivery that then finds no APNs
 * budget has still spent its reads. That is deliberate — correctness over
 * optimistic accounting — and it is why KV reads, not attempts, is the metric
 * that binds first.
 */
export function modelDay({ planned, deliveriesPerMessage = 1 }) {
  const messages = Math.ceil(planned / D.JOB_TRIPLES);
  const deliveries = messages * deliveriesPerMessage;

  // Attempts, drawn from the pool each one belongs in.
  const wantInitial = planned;
  const initial = Math.min(wantInitial, POOL.apns_initial);
  const wantRetry = planned * (deliveriesPerMessage - 1);
  const retry = Math.min(wantRetry, POOL.apns_retry);

  // Reads are reserved per delivery, capped by their own pool.
  const affordableDeliveries = Math.min(deliveries, Math.floor(POOL.kv_reads / readsPerDelivery));
  const kvReads = affordableDeliveries * readsPerDelivery;

  const attempts = initial + retry;
  const doCalls = deliveries * 2 + D.FIXTURES_PER_WINDOW * 2;
  const queueReads = deliveriesPerMessage === 1 ? 1 : D.QUEUE_READS_MAX;

  return {
    planned, messages, deliveries,
    apns_initial: initial,
    apns_retry: retry,
    apns_attempts: attempts,
    unmet_retry: wantRetry - retry,
    queue_ops: messages * (D.QUEUE_WRITE + queueReads + D.QUEUE_DELETE),
    do_requests: doCalls,
    do_rows_written: attempts * 2 + deliveries,
    do_rows_read: attempts * 5,
    do_duration_gbs: +(doCalls * D.DO_CALL_MS / 1000 * D.DO_MEM_GB).toFixed(2),
    worker_requests: D.CRON_TICKS + deliveries,
    worker_cpu_ms: deliveries * D.CONSUMER_CPU_MS + D.CRON_TICKS * D.CRON_CPU_MS,
    kv_reads: kvReads,
  };
}

/**
 * 1,000 recipients, ten due fixtures.
 * normal      — the planner's pick filter leaves ~30% of candidates planned
 * worst       — nobody has saved a pick, so every candidate is planned
 * max_retry   — worst shape, every message delivered the full four times
 */
export const CANDIDATES = 10_000;
export const SCENARIOS = {
  normal: { day: modelDay({ planned: 3_000 }), days: 20 },
  worst: { day: modelDay({ planned: CANDIDATES }), days: D.DAYS },
  max_retry: { day: modelDay({ planned: CANDIDATES, deliveriesPerMessage: D.DELIVERIES }), days: D.DAYS },
};

export const MONTHLY_CAP = {
  queue_ops: 232_500,
  do_requests: 232_500,
  do_rows_written: 1_488_000,
  do_rows_read: 4_960_000,
  do_duration_gbs: 9_920,
  worker_requests: 148_800,
  worker_cpu_ms: 1_798_000,
  kv_reads: POOL.kv_reads * D.DAYS,
  kv_writes: 17_980,
  apns_attempts: APNS_ATTEMPT_CAP * D.DAYS,
};
export const DAILY_CAP = Object.fromEntries(
  Object.entries(MONTHLY_CAP).map(([k, v]) => [k, Math.floor(v / D.DAYS)]));

export const KV_WRITES_PER_DAY = 357;

export const monthly = (name, metric) => {
  const { day, days } = SCENARIOS[name];
  return metric === "kv_writes" ? KV_WRITES_PER_DAY * D.DAYS : day[metric] * days;
};

export const METRICS = ["queue_ops", "do_requests", "do_rows_written", "do_rows_read",
  "do_duration_gbs", "worker_requests", "worker_cpu_ms", "kv_reads", "apns_attempts"];

/**
 * Capacity, stated honestly.
 *
 * With ten fixtures and up to four deliveries, ONE user can absorb forty
 * attempts — which is why the earlier "10 attempts per user" figure, and the
 * 50%-margin claim built on it, were wrong.
 */
export const capacity = (plannedFixturesPerUser, deliveries = 1) => ({
  attempts_per_user: plannedFixturesPerUser * deliveries,
  on_total_cap: Math.floor(APNS_ATTEMPT_CAP / (plannedFixturesPerUser * deliveries)),
  on_initial_pool: Math.floor(POOL.apns_initial / plannedFixturesPerUser),
});
