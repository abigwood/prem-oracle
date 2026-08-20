// EXECUTABLE SPECIFICATION — not shipped code, not Slice 1.
//
// Gate 0 blocker A: the previously described `INSERT ... ON CONFLICT DO NOTHING`
// returns only newly-inserted rows, so a row left `claimed` by a crash could
// never be reclaimed — which contradicted the retry trace built on top of it.
//
// This file is the corrected design, written as the real SQL it will become and
// run against real SQLite so the traces are executed rather than asserted from
// prose. It lives in docs/design because approving it is the point; nothing
// imports it from worker/src.
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery (
  uid         TEXT    NOT NULL,
  fixture_id  TEXT    NOT NULL,
  league      TEXT    NOT NULL,
  state       TEXT    NOT NULL,          -- 'claimed' | 'sent' | 'failed' | 'dropped'
  claim_until INTEGER,                   -- epoch ms; meaningful only while 'claimed'
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER,
  kickoff_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, fixture_id)
);
CREATE INDEX IF NOT EXISTS delivery_kickoff ON delivery (kickoff_at);
`;

/**
 * Take a bounded lease on (uid, fixture).
 *
 * Returns ONLY the rows this caller now owns. The four outcomes are decided by
 * the conflict clause rather than by application logic, so they hold under
 * concurrency without a transaction around them:
 *
 *   absent                         -> inserted, leased           (returned)
 *   'sent'                         -> matches nothing            (never returned: terminal)
 *   'dropped'                      -> matches nothing            (never returned: terminal)
 *   'claimed' and lease still live -> WHERE fails                (not returned: cannot be stolen)
 *   'claimed' and lease expired    -> re-leased, attempts + 1    (returned)
 *   'failed'                       -> re-leased, attempts + 1    (returned immediately)
 *
 * The lease is clamped to kick-off, so a lease can never outlive the window the
 * reminder is allowed to be delivered in.
 */
export const CLAIM_SQL = `
INSERT INTO delivery (uid, fixture_id, league, state, claim_until, attempts, kickoff_at)
VALUES (:uid, :fx, :league, 'claimed', MIN(:now + :lease, :kickoff), 1, :kickoff)
ON CONFLICT (uid, fixture_id) DO UPDATE SET
    state       = 'claimed',
    claim_until = MIN(:now + :lease, delivery.kickoff_at),
    attempts    = delivery.attempts + 1,
    league      = excluded.league
  WHERE (delivery.state = 'failed'
      OR (delivery.state = 'claimed' AND delivery.claim_until <= :now))
    AND delivery.attempts < :maxAttempts
    AND :now < delivery.kickoff_at
RETURNING uid, fixture_id, league, attempts;
`;

export const SENT_SQL = `
UPDATE delivery SET state = 'sent', sent_at = :now, claim_until = NULL
 WHERE uid = :uid AND fixture_id = :fx AND state = 'claimed';
`;

/** A transient failure: released at once so a retry need not wait out the lease. */
export const FAIL_SQL = `
UPDATE delivery SET state = 'failed', claim_until = NULL
 WHERE uid = :uid AND fixture_id = :fx AND state = 'claimed';
`;

/** Terminal give-up: attempts exhausted, budget exhausted, or past kick-off. */
export const DROP_SQL = `
UPDATE delivery SET state = 'dropped', claim_until = NULL
 WHERE uid = :uid AND fixture_id = :fx AND state IN ('claimed', 'failed');
`;

/** Rows whose fixture has kicked off are never reclaimed; the sweep removes them. */
export const PRUNE_SQL = `DELETE FROM delivery WHERE kickoff_at <= :now;`;

export const LEASE_MS = 120_000;      // ~80x the worst observed job; << the 60-min window
export const MAX_ATTEMPTS = 5;        // 4 queue deliveries + 1 lease-expiry reclaim

/** A tiny harness so the traces read as the sequence of events they describe. */
export function ledger() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const claim = db.prepare(CLAIM_SQL);
  const api = {
    claim: (uid, fx, { now, kickoff, league = "AAA" }) =>
      claim.all({ uid, fx, league, now, lease: LEASE_MS, kickoff, maxAttempts: MAX_ATTEMPTS }),
    sent: (uid, fx, now) => db.prepare(SENT_SQL).run({ uid, fx, now }).changes,
    fail: (uid, fx) => db.prepare(FAIL_SQL).run({ uid, fx }).changes,
    drop: (uid, fx) => db.prepare(DROP_SQL).run({ uid, fx }).changes,
    prune: (now) => db.prepare(PRUNE_SQL).run({ now }).changes,
    row: (uid, fx) => db.prepare("SELECT * FROM delivery WHERE uid=:uid AND fixture_id=:fx").get({ uid, fx }),
  };
  return api;
}
