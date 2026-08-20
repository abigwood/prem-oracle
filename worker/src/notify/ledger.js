/**
 * The notification ledger — Slice 1, D2.
 *
 * A SQLite-backed Durable Object is the only strongly consistent place in this
 * stack, and delivery needs one: a KV value cannot express a claim. Everything
 * here is the frozen Gate-0 design (docs/design/notify-ledger.spec.mjs) rendered
 * in the Durable Object SQL API, which takes positional bindings rather than the
 * named ones the specification is written with.
 *
 * Nothing here is reachable until the NOTIFY_LEDGER binding exists.
 */

/** ~80x the worst observed job, and far inside the 60-minute reminder window. */
export const LEASE_MS = 120_000;
/** Four queue deliveries plus one lease-expiry reclaim. */
export const MAX_ATTEMPTS = 5;
/** Redelivery must land AFTER a crashed consumer's lease has expired. */
export const RETRY_DELAY_S = 150;

/**
 * Two pools, so a retry can never consume capacity a recipient who has not yet
 * had a first attempt still needs. INITIAL is sized to the product's maximum
 * shape: 20 published fixtures times the required 1,000-recipient scale.
 *
 * FROZEN by the Gate-0 cost review. Raising any of these needs a fresh one.
 */
export const POOL = Object.freeze({
  apns_initial: 20_000,
  apns_retry: 5_000,
  kv_reads: 110_000,
  queue_ops: 7_500,
  do_requests: 7_500,
  worker_requests: 4_800,
});

/** Booked before sendBatch, because enqueueing makes these unavoidable. */
export const PER_MESSAGE_WORST_CASE = Object.freeze({
  queue_ops: 7,          // 1 write + 5 documented retry reads + 1 delete
  worker_requests: 4,    // four deliveries
  do_requests: 12,       // four deliveries times three calls
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery (
  uid         TEXT    NOT NULL,
  fixture_id  TEXT    NOT NULL,
  league      TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  claim_gen   INTEGER NOT NULL,
  claim_until INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  apns_tried  INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER,
  drop_reason TEXT,
  kickoff_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, fixture_id)
);
CREATE INDEX IF NOT EXISTS delivery_kickoff ON delivery (kickoff_at);
CREATE TABLE IF NOT EXISTS budget (
  day TEXT NOT NULL, metric TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
CREATE TABLE IF NOT EXISTS dropped_log (
  day TEXT NOT NULL, fixture TEXT NOT NULL, reason TEXT NOT NULL,
  uids INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
  PRIMARY KEY (day, fixture, reason)
);
`;

const CLAIM = `
INSERT INTO delivery (uid, fixture_id, league, state, claim_gen, claim_until,
                      attempts, kickoff_at)
VALUES (?1, ?2, ?3, 'claimed', 1, MIN(?4 + ?5, ?6), 1, ?6)
ON CONFLICT (uid, fixture_id) DO UPDATE SET
    state       = 'claimed',
    claim_gen   = delivery.claim_gen + 1,
    claim_until = MIN(?4 + ?5, delivery.kickoff_at),
    attempts    = delivery.attempts + 1,
    league      = excluded.league
  WHERE (delivery.state = 'failed'
      OR (delivery.state = 'claimed' AND delivery.claim_until <= ?4))
    AND delivery.attempts < ?7
    AND ?4 < delivery.kickoff_at
RETURNING uid, fixture_id, league, claim_gen, attempts, apns_tried;
`;

/**
 * Make a triple terminally dropped, safely.
 *
 * Used by BOTH refusal paths — the consumer's read-budget refusal and the
 * planner's pre-enqueue refusal — because both have to stop work that would
 * otherwise be planned again, and both must leave alone anything they do not
 * own: `sent`, an existing `dropped`, and another consumer's LIVE fenced claim
 * all fail the conflict clause untouched.
 */
const TERMINATE = `
INSERT INTO delivery (uid, fixture_id, league, state, claim_gen, claim_until,
                      attempts, kickoff_at, drop_reason)
VALUES (?1, ?2, ?3, 'dropped', 1, NULL, 0, ?5, ?6)
ON CONFLICT (uid, fixture_id) DO UPDATE SET
    state       = 'dropped',
    claim_until = NULL,
    drop_reason = ?6
  WHERE delivery.state = 'failed'
     OR (delivery.state = 'claimed' AND delivery.claim_until <= ?4)
RETURNING uid, fixture_id;
`;

const SENT = `UPDATE delivery SET state='sent', sent_at=?4, claim_until=NULL
   WHERE uid=?1 AND fixture_id=?2 AND state='claimed' AND claim_gen=?3`;
const FAIL = `UPDATE delivery SET state='failed', claim_until=NULL
   WHERE uid=?1 AND fixture_id=?2 AND state='claimed' AND claim_gen=?3`;
const DROP = `UPDATE delivery SET state='dropped', claim_until=NULL, drop_reason=?4
   WHERE uid=?1 AND fixture_id=?2 AND state='claimed' AND claim_gen=?3`;
const MARK_TRIED = `UPDATE delivery SET apns_tried=1
   WHERE uid=?1 AND fixture_id=?2 AND state='claimed' AND claim_gen=?3`;
// claim_until is part of this row's identity for disposition(): without it a
// live lease reads as claimable, and a redelivery acks away a reminder that is
// still owed. Selected once, used by both callers.
const OWNER = `SELECT state, claim_gen, apns_tried, claim_until
   FROM delivery WHERE uid=?1 AND fixture_id=?2`;
const EXHAUST = `
UPDATE delivery SET state='dropped', claim_until=NULL, drop_reason='attempts-exhausted'
 WHERE attempts >= ?2 AND (state='failed' OR (state='claimed' AND claim_until <= ?1))
RETURNING uid, fixture_id, league, attempts`;
const PRUNE = `DELETE FROM delivery WHERE kickoff_at <= ?1`;
const LOG_DROP = `
INSERT INTO dropped_log (day, fixture, reason, uids, at) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (day, fixture, reason) DO UPDATE SET uids = dropped_log.uids + ?4, at = ?5`;
const BUDGET_GET = `SELECT used FROM budget WHERE day=?1 AND metric=?2`;
const BUDGET_SET = `INSERT INTO budget (day, metric, used) VALUES (?1, ?2, ?3)
   ON CONFLICT (day, metric) DO UPDATE SET used = ?3`;

/** The UTC day a budget belongs to. Budgets are per calendar day, not rolling. */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export class NotifyLedger {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  #rows(query, ...binds) { return this.sql.exec(query, ...binds).toArray(); }

  #used(day, metric) {
    return this.#rows(BUDGET_GET, day, metric)[0]?.used ?? 0;
  }

  /**
   * Reserve from a named pool. Partial grants are deliberate: a job asking for
   * 45 with 10 left takes 10 and drops the rest, rather than failing at the
   * boundary. The Durable Object is single-threaded, so this is atomic against
   * every other consumer without an explicit transaction.
   */
  reserve({ day, metric, want }) {
    const cap = POOL[metric];
    if (cap == null) throw new Error(`unknown budget pool: ${metric}`);
    const used = this.#used(day, metric);
    const granted = Math.max(0, Math.min(want, cap - used));
    if (granted > 0) this.sql.exec(BUDGET_SET, day, metric, used + granted);
    return { granted, used: used + granted, remaining: cap - (used + granted) };
  }

  /** Terminally drop a batch, with the conflict guard both refusal paths need. */
  #terminate({ day, now, triples, reason }) {
    const byFixture = {};
    let dropped = 0;
    for (const t of triples) {
      const hit = this.#rows(TERMINATE, t.uid, t.fixtureId, t.league, now, t.kickoffAt, reason);
      if (hit.length) {
        dropped++;
        byFixture[t.fixtureId] = (byFixture[t.fixtureId] || 0) + 1;
      }
    }
    for (const [fixture, uids] of Object.entries(byFixture)) {
      this.sql.exec(LOG_DROP, day, fixture, reason, uids, now);
    }
    return { dropped, byFixture };
  }

  /**
   * CALL ONE of a delivery: reserve the reads, claim the batch, and report what
   * is owed on everything not claimed — all in one round trip.
   *
   * These were three separate RPCs, and the per-triple disposition made it up
   * to forty-eight. A delivery's Durable Object cost has to be a fixed three
   * calls or the pre-enqueue reservation is fiction, so they are one.
   *
   * If the read allowance is refused, the refusal is made TERMINAL inside this
   * same transaction: reporting a triple as dropped is not dropping it.
   */
  beginDelivery({ day, want, triples, now }) {
    return this.ctx.storage.transactionSync(() => {
      const used = this.#used(day, "kv_reads");
      if (used + want > POOL.kv_reads) {
        const { dropped, byFixture } = this.#terminate({
          day, now, triples, reason: "kv-read-budget-exhausted",
        });
        return { refused: true, granted: 0, dropped, byFixture, claimed: [], deferred: 0 };
      }
      this.sql.exec(BUDGET_SET, day, "kv_reads", used + want);
      const claimed = [];
      const owned = new Set();
      for (const t of triples) {
        const got = this.#rows(CLAIM,
          t.uid, t.fixtureId, t.league, now, LEASE_MS, t.kickoffAt, MAX_ATTEMPTS);
        if (got.length) { claimed.push(got[0]); owned.add(`${t.uid}|${t.fixtureId}`); }
      }
      // Anything not claimed: is it finished, or is somebody else still holding
      // it? Only the second means this message must come back.
      let deferred = 0;
      for (const t of triples) {
        if (owned.has(`${t.uid}|${t.fixtureId}`)) continue;
        const row = this.#rows(OWNER, t.uid, t.fixtureId)[0];
        if (row && row.state === "claimed" && row.claim_until > now) deferred++;
      }
      return { refused: false, granted: want, dropped: 0, byFixture: {}, claimed, deferred };
    });
  }

  /**
   * The planner's refusal, made terminal.
   *
   * A message the planner could not fund is work that will otherwise be offered
   * again on the next tick. It has no claim and no generation, so it cannot go
   * through recordOutcomes — it needs the same insert-or-safely-update the read
   * refusal uses.
   */
  terminatePlanned({ day, now, triples, reason = "plan-budget-exhausted" }) {
    return this.ctx.storage.transactionSync(() => this.#terminate({ day, now, triples, reason }));
  }

  /**
   * ATOMIC multi-pool reservation for whole messages.
   *
   * Reserving each pool separately means a short third pool leaves the first
   * two charged for messages that were never enqueued. Either the same whole
   * count is funded from every pool, or nothing is.
   */
  reserveMessages({ day, count, perMessage }) {
    return this.ctx.storage.transactionSync(() => {
      const metrics = Object.entries(perMessage).filter(([, cost]) => cost > 0);
      const affordable = metrics.reduce((limit, [metric, cost]) => {
        const remaining = POOL[metric] - this.#used(day, metric);
        return Math.min(limit, Math.floor(remaining / cost));
      }, count);
      const granted = Math.max(0, Math.min(count, affordable));
      if (granted > 0) {
        for (const [metric, cost] of metrics) {
          this.sql.exec(BUDGET_SET, day, metric, this.#used(day, metric) + granted * cost);
        }
      }
      return { affordable: granted, refused: count - granted };
    });
  }

  /**
   * Permission to make ONE APNs fetch each — fenced, pool-selecting and atomic.
   *
   * Reserving and then separately marking the row tried is two writes with a
   * gap: a crash in that gap spends INITIAL without recording it, and the
   * redelivery spends INITIAL again. One transaction, or neither.
   */
  grantAttempts({ day, grants }) {
    return this.ctx.storage.transactionSync(() => grants.map(({ uid, fixtureId, gen }) => {
      const row = this.#rows(OWNER, uid, fixtureId)[0];
      if (!row || row.state !== "claimed" || row.claim_gen !== gen) {
        return { uid, fixtureId, granted: false, reason: "stale", pool: null };
      }
      const pool = row.apns_tried ? "apns_retry" : "apns_initial";
      const used = this.#used(day, pool);
      if (used + 1 > POOL[pool]) {
        return { uid, fixtureId, granted: false, reason: "budget", pool };
      }
      this.sql.exec(BUDGET_SET, day, pool, used + 1);
      this.sql.exec(MARK_TRIED, uid, fixtureId, gen);
      return { uid, fixtureId, granted: true, reason: null, pool };
    }));
  }

  /** Record every outcome of one delivery in a single round trip. */
  recordOutcomes({ day, now, outcomes }) {
    return this.ctx.storage.transactionSync(() => {
      const drops = {};
      for (const o of outcomes) {
        if (o.result === "sent") this.sql.exec(SENT, o.uid, o.fixtureId, o.gen, now);
        else if (o.result === "failed") this.sql.exec(FAIL, o.uid, o.fixtureId, o.gen);
        else {
          const reason = o.reason || "dropped";
          this.sql.exec(DROP, o.uid, o.fixtureId, o.gen, reason);
          const key = `${o.fixtureId} ${reason}`;
          drops[key] = (drops[key] || 0) + 1;
        }
      }
      for (const [key, uids] of Object.entries(drops)) {
        const [fixture, reason] = key.split(" ");
        this.sql.exec(LOG_DROP, day, fixture, reason, uids, now);
      }
      return { recorded: outcomes.length };
    });
  }

  /** Attempts exhausted becomes terminal, never an ambiguous `failed` row. */
  sweep({ day, now }) {
    return this.ctx.storage.transactionSync(() => {
      const swept = this.#rows(EXHAUST, now, MAX_ATTEMPTS);
      const byFixture = {};
      for (const row of swept) byFixture[row.fixture_id] = (byFixture[row.fixture_id] || 0) + 1;
      for (const [fixture, uids] of Object.entries(byFixture)) {
        this.sql.exec(LOG_DROP, day, fixture, "attempts-exhausted", uids, now);
      }
      this.sql.exec(PRUNE, now);
      return { swept: swept.length };
    });
  }

  /** Who is still owed a reminder for a fixture — the planner's sweep pass. */
  unsent({ fixtureId, uids }) {
    return uids.filter((uid) => {
      const row = this.#rows(OWNER, uid, fixtureId)[0];
      return !(row && (row.state === "sent" || row.state === "dropped"));
    });
  }

  spent(day) {
    return Object.fromEntries(Object.keys(POOL).map((m) => [m, this.#used(day, m)]));
  }

  /** The Durable Object entry point. One RPC per call, by design. */
  async fetch(request) {
    const { op, ...args } = await request.json();
    const handlers = {
      reserve: () => this.reserve(args),
      beginDelivery: () => this.beginDelivery(args),
      terminatePlanned: () => this.terminatePlanned(args),
      reserveMessages: () => this.reserveMessages(args),
      grantAttempts: () => this.grantAttempts(args),
      recordOutcomes: () => this.recordOutcomes(args),
      sweep: () => this.sweep(args),
      unsent: () => this.unsent(args),
      spent: () => this.spent(args.day),
    };
    const handler = handlers[op];
    if (!handler) {
      return new Response(JSON.stringify({ error: `unknown op: ${op}` }), { status: 400 });
    }
    return new Response(JSON.stringify(handler()), {
      headers: { "content-type": "application/json" },
    });
  }
}
