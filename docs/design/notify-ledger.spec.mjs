// EXECUTABLE SPECIFICATION — not shipped code, not Slice 1.
//
// The single design authority for the notification ledger. Every statement here
// is the SQL that will be used, run against real SQLite by test/ledger.test.mjs,
// so the traces are executed rather than asserted in prose. Nothing under
// worker/src or app.js imports it.
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ~80x the worst observed job, and far inside the 60-minute reminder window. */
export const LEASE_MS = 120_000;
/** Four queue deliveries plus one lease-expiry reclaim. */
export const MAX_ATTEMPTS = 5;
/**
 * APNs ATTEMPTS per UTC day — failures included, because failures cost too.
 *
 * Split into two pools so a retry can never consume capacity a recipient who
 * has not yet had a first attempt still needs. With ten fixtures and up to four
 * deliveries each, one user can absorb forty attempts; without the split, a
 * storm of retries early in the day would starve first delivery for everybody
 * planned later.
 */
export const POOL = {
  /**
   * First APNs attempt per (uid, fixture), sized to the PRODUCT'S MAXIMUM
   * SHAPE: the frozen authority's 20-fixture round, at the required
   * 1,000-recipient scale, is 20,000 first attempts. Sizing this to a
   * ten-fixture round protected only 500 recipients at that shape.
   */
  apns_initial: 20_000,
  apns_retry: 5_000,      // every attempt after the first, separately bounded
  kv_reads: 110_000,      // authoritative pre-send reads, reserved before reading
};
export const APNS_ATTEMPT_CAP = POOL.apns_initial + POOL.apns_retry;   // 15,000

/**
 * Redelivery must land AFTER a crashed consumer's lease has expired, or the
 * message comes back to a claim it still cannot take. 150s > LEASE_MS.
 */
export const RETRY_DELAY_S = 150;
/** The reminder window the whole sequence has to fit inside. */
export const REMINDER_WINDOW_S = 60 * 60;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery (
  uid         TEXT    NOT NULL,
  fixture_id  TEXT    NOT NULL,
  league      TEXT    NOT NULL,
  state       TEXT    NOT NULL,          -- 'claimed' | 'sent' | 'failed' | 'dropped'
  claim_gen   INTEGER NOT NULL,          -- fencing token: strictly increases per row
  claim_until INTEGER,                   -- epoch ms; meaningful only while 'claimed'
  attempts    INTEGER NOT NULL DEFAULT 0,
  apns_tried  INTEGER NOT NULL DEFAULT 0,   -- 0 until the first APNs fetch is reserved
  sent_at     INTEGER,
  drop_reason TEXT,
  kickoff_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, fixture_id)
);
CREATE INDEX IF NOT EXISTS delivery_kickoff ON delivery (kickoff_at);

CREATE TABLE IF NOT EXISTS budget (
  day    TEXT    NOT NULL,
  metric TEXT    NOT NULL,
  used   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- Bounded diagnostic: one row per (day, fixture, reason), counted not listed,
-- so a bad day cannot turn the diagnostic into the storage problem.
CREATE TABLE IF NOT EXISTS dropped_log (
  day     TEXT    NOT NULL,
  fixture TEXT    NOT NULL,
  reason  TEXT    NOT NULL,
  uids    INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL,
  PRIMARY KEY (day, fixture, reason)
);
`;

// ---------------------------------------------------------------------------
// Claim — the only way to acquire ownership
// ---------------------------------------------------------------------------

/**
 * Take a bounded, FENCED lease on (uid, fixture).
 *
 * Every grant — initial or reclaim — bumps `claim_gen`, and every mutation below
 * requires the generation it was granted. That is what stops a consumer whose
 * lease expired from reaching into the claim that replaced it: its token is one
 * generation behind and matches nothing.
 *
 *   absent                         -> inserted, gen 1            (returned)
 *   'sent'                         -> matches nothing            (terminal)
 *   'dropped'                      -> matches nothing            (terminal)
 *   'claimed' and lease still live -> WHERE fails                (cannot be stolen)
 *   'claimed' and lease expired    -> re-leased, gen + 1         (returned)
 *   'failed'                       -> re-leased, gen + 1         (returned at once)
 *
 * The lease is clamped to kick-off, so it can never outlive the window the
 * reminder is allowed to be delivered in.
 */
export const CLAIM_SQL = `
INSERT INTO delivery (uid, fixture_id, league, state, claim_gen, claim_until, attempts, kickoff_at)
VALUES (:uid, :fx, :league, 'claimed', 1, MIN(:now + :lease, :kickoff), 1, :kickoff)
ON CONFLICT (uid, fixture_id) DO UPDATE SET
    state       = 'claimed',
    claim_gen   = delivery.claim_gen + 1,
    claim_until = MIN(:now + :lease, delivery.kickoff_at),
    attempts    = delivery.attempts + 1,
    league      = excluded.league
  WHERE (delivery.state = 'failed'
      OR (delivery.state = 'claimed' AND delivery.claim_until <= :now))
    AND delivery.attempts < :maxAttempts
    AND :now < delivery.kickoff_at
RETURNING uid, fixture_id, league, claim_gen, attempts, apns_tried;
`;

/**
 * The disposition of a triple a consumer could NOT claim. Distinguishing these
 * is what stops a redelivery from either losing a reminder or spinning on one.
 *
 *   'terminal'  sent or dropped        -> nothing owed, contributes to the ack
 *   'retry'     claimed, lease LIVE    -> a crashed delivery still owns it;
 *                                         come back after the lease, never ack
 *   'absent'    no row                 -> claimable; only ever a race
 */
export const DISPOSITION_SQL = `
SELECT state, claim_until, apns_tried FROM delivery
 WHERE uid = :uid AND fixture_id = :fx;
`;

export function disposition(row, now) {
  if (!row) return "absent";
  if (row.state === "sent" || row.state === "dropped") return "terminal";
  if (row.state === "claimed" && row.claim_until > now) return "retry";
  return "claimable";
}

// ---------------------------------------------------------------------------
// Mutations — all fenced on claim_gen
// ---------------------------------------------------------------------------

export const SENT_SQL = `
UPDATE delivery SET state = 'sent', sent_at = :now, claim_until = NULL
 WHERE uid = :uid AND fixture_id = :fx
   AND state = 'claimed' AND claim_gen = :gen;
`;

/** Transient failure: released at once so a retry need not wait out the lease. */
export const FAIL_SQL = `
UPDATE delivery SET state = 'failed', claim_until = NULL
 WHERE uid = :uid AND fixture_id = :fx
   AND state = 'claimed' AND claim_gen = :gen;
`;

/** Records that an APNs fetch has been reserved, so the next one is a retry. */
export const MARK_TRIED_SQL = `
UPDATE delivery SET apns_tried = 1
 WHERE uid = :uid AND fixture_id = :fx AND state = 'claimed' AND claim_gen = :gen;
`;

export const BUDGET_READ_SQL = `SELECT used FROM budget WHERE day = :day AND metric = :metric;`;
export const BUDGET_SET_SQL = `
INSERT INTO budget (day, metric, used) VALUES (:day, :metric, :used)
ON CONFLICT (day, metric) DO UPDATE SET used = :used;
`;

const OWNER_SQL = `
SELECT state, claim_gen, apns_tried FROM delivery WHERE uid = :uid AND fixture_id = :fx;
`;

/**
 * Permission to make ONE APNs fetch — fenced, pool-selecting and atomic.
 *
 * Reserving from a pool and then separately marking the row tried is two
 * writes with a gap between them. A crash in that gap spends INITIAL capacity
 * without recording that it was spent, and the redelivery spends INITIAL
 * again — which is exactly the first-attempt protection the pools exist for.
 *
 * So it is one transaction: verify the fence, choose the pool from apns_tried,
 * reserve exactly one slot, set apns_tried, commit. Either all of it happened
 * or none of it did. A stale generation spends nothing at all.
 *
 * `failAfterReserve` exists only so a test can crash inside the transaction and
 * assert the rollback gives the slot back.
 */
export function grantAttempt(db, { uid, fx, gen, day, failAfterReserve = false }) {
  const row = db.prepare(OWNER_SQL).get({ uid, fx });
  if (!row || row.state !== "claimed" || row.claim_gen !== gen) {
    return { granted: false, reason: "stale", pool: null };
  }
  const pool = row.apns_tried ? "apns_retry" : "apns_initial";
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = db.prepare(BUDGET_READ_SQL).get({ day, metric: pool })?.used ?? 0;
    if (before + 1 > POOL[pool]) { db.exec("ROLLBACK"); return { granted: false, reason: "budget", pool }; }
    db.prepare(BUDGET_SET_SQL).run({ day, metric: pool, used: before + 1 });
    if (failAfterReserve) throw new Error("crash between reserve and mark");
    db.prepare(MARK_TRIED_SQL).run({ uid, fx, gen });
    db.exec("COMMIT");
    return { granted: true, reason: null, pool };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Terminal give-up by the current owner: budget exhausted, past kick-off, etc. */
export const DROP_SQL = `
UPDATE delivery SET state = 'dropped', claim_until = NULL, drop_reason = :reason
 WHERE uid = :uid AND fixture_id = :fx
   AND state = 'claimed' AND claim_gen = :gen;
`;

/**
 * Attempts exhausted -> 'dropped', never left as an ambiguous 'failed'.
 * Unfenced by design: this is the sweep, not an owner, and it only touches rows
 * that no live lease covers.
 */
export const EXHAUST_SQL = `
UPDATE delivery SET state = 'dropped', claim_until = NULL, drop_reason = 'attempts-exhausted'
 WHERE attempts >= :maxAttempts
   AND (state = 'failed' OR (state = 'claimed' AND claim_until <= :now))
RETURNING uid, fixture_id, league, attempts;
`;

export const PRUNE_SQL = `DELETE FROM delivery WHERE kickoff_at <= :now;`;

export const LOG_DROP_SQL = `
INSERT INTO dropped_log (day, fixture, reason, uids, at)
VALUES (:day, :fixture, :reason, :uids, :at)
ON CONFLICT (day, fixture, reason) DO UPDATE SET uids = dropped_log.uids + :uids, at = :at;
`;

// ---------------------------------------------------------------------------
// Budget — reserved BEFORE the work, so failures pay for themselves
// ---------------------------------------------------------------------------



/**
 * The whole reservation runs inside one Durable Object call, and a Durable
 * Object is single-threaded, so read-compute-write here is atomic with respect
 * to every other consumer. Two consumers cannot both see the same remaining
 * headroom and both spend it.
 *
 * Partial grants are deliberate: a consumer asking for 45 attempts with 10 left
 * gets 10 and drops the rest, rather than the whole job failing at the boundary.
 */
export function reserve(db, { day, metric, want, cap }) {
  const row = db.prepare(BUDGET_READ_SQL).get({ day, metric });
  const used = row?.used ?? 0;
  const granted = Math.max(0, Math.min(want, cap - used));
  if (granted > 0) db.prepare(BUDGET_SET_SQL).run({ day, metric, used: used + granted });
  return { granted, used: used + granted, remaining: cap - (used + granted) };
}

// ---------------------------------------------------------------------------
// Harness, so the traces read as the sequence of events they describe
// ---------------------------------------------------------------------------

export function ledger() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const claim = db.prepare(CLAIM_SQL);
  return {
    db,
    claim: (uid, fx, { now, kickoff, league = "AAA" }) =>
      claim.all({ uid, fx, league, now, lease: LEASE_MS, kickoff, maxAttempts: MAX_ATTEMPTS }),
    sent: (uid, fx, gen, now) => db.prepare(SENT_SQL).run({ uid, fx, gen, now }).changes,
    fail: (uid, fx, gen) => db.prepare(FAIL_SQL).run({ uid, fx, gen }).changes,
    drop: (uid, fx, gen, reason = "budget") => db.prepare(DROP_SQL).run({ uid, fx, gen, reason }).changes,
    exhaust: (now) => db.prepare(EXHAUST_SQL).all({ now, maxAttempts: MAX_ATTEMPTS }),
    logDrop: (day, fixture, reason, uids, at) =>
      db.prepare(LOG_DROP_SQL).run({ day, fixture, reason, uids, at }).changes,
    drops: () => db.prepare("SELECT * FROM dropped_log ORDER BY fixture").all(),
    prune: (now) => db.prepare(PRUNE_SQL).run({ now }).changes,
    /** Reserve from a named pool. The pool decides the cap; callers cannot widen it. */
    reserve: ({ day, pool, want }) => reserve(db, { day, metric: pool, want, cap: POOL[pool] }),
    /** First APNs fetch for this row draws INITIAL; every later one draws RETRY. */
    poolFor: (row) => (row.apns_tried ? "apns_retry" : "apns_initial"),
    markTried: (uid, fx, gen) => db.prepare(MARK_TRIED_SQL).run({ uid, fx, gen }).changes,
    /** The single fenced atomic step: fence check + pool choice + reserve + mark. */
    grantAttempt: (opts) => grantAttempt(db, opts),
    disposition: (uid, fx, now) =>
      disposition(db.prepare(DISPOSITION_SQL).get({ uid, fx }), now),
    spent: (day) => Object.fromEntries(Object.keys(POOL).map((m) => [m,
      db.prepare("SELECT used FROM budget WHERE day=:day AND metric=:m").get({ day, m })?.used ?? 0])),
    row: (uid, fx) =>
      db.prepare("SELECT * FROM delivery WHERE uid=:uid AND fixture_id=:fx").get({ uid, fx }),
  };
}

// ---------------------------------------------------------------------------
// The production consumer sequence
// ---------------------------------------------------------------------------

/**
 * One queue delivery, in the order the budget guarantees depend on.
 *
 * The ordering is the specification, not a description of it:
 *
 *   1. reserve the WORST-CASE KV-read allowance for this message, before any read
 *   2. if it is unavailable, ack and drop WITHOUT reading anything
 *   3. only then perform the authoritative eligibility checks
 *   4. reserve the exact APNs attempt from the correct pool immediately before fetch
 *   5. a failed fetch keeps its reservation — failures cost what they cost
 *   6. unused KV allowance stays consumed; conservative beats optimistic
 *
 * Return is `ack` or `retry`. A triple still held by a LIVE lease from a crashed
 * delivery yields `retry`: acking would silently lose that reminder, and the
 * lease means it cannot be reclaimed yet. RETRY_DELAY_S exceeds LEASE_MS so the
 * redelivery lands after the lease has gone.
 */
export function deliverMessage(l, {
  day, now, kickoff, triples,
  kvReadsPerTriple = 2,          // <=45 push + <=45 member, per triple
  kvReadsFixed = 6,              // <=3 picks + <=3 slate, per message
  eligible = () => true,         // authoritative check, run only after step 1
  apns = () => true,             // true = APNs accepted
}) {
  const out = {
    action: "ack", attempted: 0, sent: 0, dropped: 0, reads: 0, deferred: 0,
    stale: 0, budget_refused: 0, claimed: 0, do_calls: 0,
    pools: { apns_initial: 0, apns_retry: 0 },
  };

  // 1. Worst-case read allowance for the whole message, before touching KV.
  const wantReads = triples.length * kvReadsPerTriple + kvReadsFixed;
  const readGrant = l.reserve({ day, pool: "kv_reads", want: wantReads });
  out.do_calls++;                                      // call 1: reserve + claim batch
  if (readGrant.granted < wantReads) {
    // 2. Not enough: ack and drop, having read nothing at all.
    out.dropped = triples.length;
    return out;
  }
  out.reads = readGrant.granted;                       // 6. consumed regardless

  for (const [uid, fx] of triples) {
    const claimed = l.claim(uid, fx, { now, kickoff });
    if (claimed.length) out.claimed++;
    if (!claimed.length) {
      const how = l.disposition(uid, fx, now);
      if (how === "retry") { out.deferred++; out.action = "retry"; }
      continue;                                        // terminal: nothing owed
    }
    const [row] = claimed;

    // 3. Authoritative eligibility, on reads already paid for.
    if (!eligible(uid, fx)) {
      l.drop(uid, fx, row.claim_gen, "ineligible");
      out.dropped++;
      continue;
    }

    // 4. The exact attempt: ONE fenced atomic step that verifies the fence,
    //    picks the pool, reserves the slot and marks the row tried.
    const grant = l.grantAttempt({ uid, fx, gen: row.claim_gen, day });
    if (!grant.granted) {
      l.drop(uid, fx, row.claim_gen, grant.reason === "stale" ? "stale-owner" : "budget-exhausted");
      out.dropped++;
      out[grant.reason === "stale" ? "stale" : "budget_refused"]++;
      continue;
    }
    out.pools[grant.pool]++;
    out.attempted++;                                   // 5. reserved, spent either way

    if (apns(uid, fx)) { l.sent(uid, fx, row.claim_gen, now); out.sent++; }
    else { l.fail(uid, fx, row.claim_gen); out.action = "retry"; }
  }
  // A working delivery costs THREE Durable Object round trips, not two:
  //   1. reserve the read allowance and claim the batch
  //   2. the batched atomic attempt grants, after eligibility
  //   3. record the sent/failed/dropped outcomes, after APNs
  if (out.claimed > 0) out.do_calls += 2;
  return out;
}

/**
 * What the PLANNER must reserve before `sendBatch`, not after.
 *
 * Once a message is enqueued its worst-case cost is unavoidable: Cloudflare has
 * already charged the write, and up to four deliveries with their reads and
 * deletes follow whatever the consumer decides. Reserving afterwards would be
 * checking a bill that has already been run up.
 */
export const PER_MESSAGE_WORST_CASE = {
  queue_ops: 7,          // 1 write + 5 reads (documented ceiling) + 1 delete
  worker_requests: 4,    // up to four deliveries
  do_requests: 8,        // (reserve+claim) and (record|drop) per delivery
};
