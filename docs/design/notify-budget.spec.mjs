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
  /**
   * Reserved before sendBatch, because enqueueing makes these unavoidable.
   * do_requests is FOUR deliveries x THREE calls: an earlier value of 8 assumed
   * some deliveries would be refused cheaply, which is an average, not a bound.
   */
  PER_MESSAGE_WORST_CASE: { queue_ops: 7, worker_requests: 4, do_requests: 12 },
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
  /**
   * The PRODUCT'S MAXIMUM SHAPE. The frozen authority's executed worst case is
   * a 20-fixture round, and league rules permit up to 20 published fixtures.
   * Modelling ten understated every downstream figure by half.
   */
  FIXTURES_PER_WINDOW: 20,
  CONSUMER_CPU_MS: 10,
  CRON_CPU_MS: 50,
  DO_CALLS_PER_DELIVERY: 3,
  DIAGNOSTIC_ROWS_PER_DAY: 40,
  DO_MEM_GB: 0.128,
  DO_CALL_MS: 10,
  DAYS: 31,
};

/**
 * Two pools, so a retry can never starve a recipient's first attempt.
 * INITIAL is sized to the maximum shape: 20 fixtures x 1,000 recipients.
 */
export const POOL = {
  apns_initial: 20_000,
  apns_retry: 5_000,
  kv_reads: 110_000,
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

  // Attempts, drawn from the pool each one belongs in.
  const initial = Math.min(planned, POOL.apns_initial);
  const wantRetry = planned * (deliveriesPerMessage - 1);
  const retry = Math.min(wantRetry, POOL.apns_retry);
  const attempts = initial + retry;

  /**
   * Deliveries. A message whose remainder is budget-dropped is ACKED, so it
   * stops coming back: redelivery is bounded by the retry budget, not by
   * max_retries alone. The ceiling modelled is the first pass, plus the retry
   * deliveries the pool can actually fund, plus one final pass per message
   * that returns and finds nothing left — capped by max_retries throughout.
   */
  const retryWorking = Math.ceil(retry / D.JOB_TRIPLES);
  const finalDropPass = deliveriesPerMessage > 1 ? messages : 0;
  const deliveries = Math.min(messages * deliveriesPerMessage,
    messages + retryWorking + finalDropPass);

  // Reads are reserved per delivery, capped by their own pool.
  const affordableDeliveries = Math.min(deliveries, Math.floor(POOL.kv_reads / readsPerDelivery));
  const kvReads = affordableDeliveries * readsPerDelivery;

  /**
   * Durable Object calls. A WORKING delivery is three round trips:
   *   1. reserve the read allowance and claim the batch
   *   2. the batched atomic attempt grants, after eligibility
   *   3. record sent/failed/dropped outcomes, after APNs
   * A delivery refused its read allowance costs one.
   */
  const doCalls = deliveries * D.DO_CALLS_PER_DELIVERY + D.FIXTURES_PER_WINDOW * 2;
  /**
   * What the DO-request BUDGET actually holds. The planner books each message's
   * unavoidable worst case up front and, as with reads, does not hand back what
   * goes unused — so the cap is checked against the reservation, not the calls.
   */
  const doReserved = messages * PLANNER.PER_MESSAGE_WORST_CASE.do_requests
    + D.FIXTURES_PER_WINDOW * 2;

  /**
   * Rows written. The old `attempts * 2 + deliveries` understated the case
   * where work is claimed and then dropped without an APNs attempt at all.
   * Every write is now named:
   */
  const claimed = Math.min(deliveries * D.JOB_TRIPLES, planned * deliveriesPerMessage);
  const droppedNoAttempt = Math.max(0, claimed - attempts);
  const rowsWritten =
      claimed                       // claims and reclaims
    + attempts                      // apns_tried
    + attempts                      // sent | failed outcome
    + droppedNoAttempt              // dropped outcome, no attempt made
    + deliveries * 2                // budget rows: read reservation + attempt grants
    + D.DIAGNOSTIC_ROWS_PER_DAY;    // bounded dropped_log

  const queueReads = deliveriesPerMessage === 1 ? 1 : D.QUEUE_READS_MAX;

  return {
    planned, messages, deliveries, claimed, dropped_no_attempt: droppedNoAttempt,
    apns_initial: initial,
    apns_retry: retry,
    apns_attempts: attempts,
    unmet_retry: wantRetry - retry,
    queue_ops: messages * (D.QUEUE_WRITE + queueReads + D.QUEUE_DELETE),
    do_requests: Math.max(doCalls, doReserved),
    do_calls_actual: doCalls,
    do_requests_reserved: doReserved,
    do_rows_written: rowsWritten,
    do_rows_read: attempts * 5 + claimed,
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
export const RECIPIENTS = 1_000;
export const CANDIDATES = RECIPIENTS * D.FIXTURES_PER_WINDOW;    // 20,000
export const SCENARIOS = {
  normal: { day: modelDay({ planned: Math.round(CANDIDATES * 0.3) }), days: 20 },
  worst: { day: modelDay({ planned: CANDIDATES }), days: D.DAYS },
  max_retry: { day: modelDay({ planned: CANDIDATES, deliveriesPerMessage: D.DELIVERIES }), days: D.DAYS },
};

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
  apns_attempts: APNS_ATTEMPT_CAP * D.DAYS,
};
export const DAILY_CAP = Object.fromEntries(
  Object.entries(MONTHLY_CAP).map(([k, v]) => [k, Math.floor(v / D.DAYS)]));

export const KV_WRITES_PER_DAY = 714;   // 20 fixtures per slate, not 10

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
