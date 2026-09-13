// The league registrar — v1.8 Slice A, atomic display-name uniqueness.
//
// A league needs display names that are unique after trimming and case folding,
// and that uniqueness must hold under concurrent joins. Cloudflare KV has no
// compare-and-set, so a check-then-write against it is a race. A Durable Object
// is the only strongly consistent, single-threaded place in the stack — the
// same reason the notification ledger is one — so one registrar instance per
// league (idFromName(code)) serialises every claim, and the decision is atomic
// without a lock.
//
// The registrar is the AUTHORITY for which normalised names are held. It does
// not trust an eventually-consistent KV roster for that; the roster is used only
// to BACKFILL members who predate the registrar, additively and never
// destructively. Every live membership mutation — join, rename, kick, account
// and league deletion — routes through the registrar so its view stays true.
//
// A claim has a bounded lifecycle so an abandoned join cannot reserve a name
// forever:
//   pending   — an in-flight attempt holds the name for a short TTL;
//   committed — the membership write has completed (or a genuine member was
//               backfilled from the roster);
//   released  — the member was kicked or deleted; the name is free again, and a
//               stale roster can never resurrect the claim.
//
// Every begin() is a fresh ATTEMPT with an opaque fence. commit() converts a
// claim only when the uid, normalised name AND fence all still match the active
// pending attempt, it has not expired, and no other uid has since acquired the
// name. This fences out three races the first cut missed:
//   - an expired pending row must contest the name afresh, not be honoured as
//     an owned reservation (so an old retry after another UID wins is refused);
//   - a stale roster must never promote or rewrite an in-flight rename to a
//     different name;
//   - a delayed commit for an expired or superseded attempt must never convert
//     the claim, and its caller must not report success.
//
// The account UID is the identity throughout and is the table key. The display
// name is a per-league label the registrar arbitrates; it is never a key.

const PENDING_TTL_MS = 10 * 60 * 1000; // far longer than a join, short enough not to strand a name

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  uid   TEXT PRIMARY KEY,
  norm  TEXT NOT NULL,
  nick  TEXT NOT NULL,
  state TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  fence TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS claims_norm ON claims (norm);
`;

// The uniqueness key: trim, cap to the display limit, fold case, collapse inner
// whitespace. Mirrors normaliseJoinNick in logic.js — a local copy so the
// Durable Object has no import surface beyond the platform.
function normaliseJoinNick(value) {
  return String(value || "").trim().slice(0, 24).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Up to three free alternatives, numbered, checked against live claims. */
function suggestFor(display, isFree) {
  const base = String(display || "").trim().slice(0, 22) || "Player";
  const out = [];
  for (let n = 2; out.length < 3 && n < 60; n++) {
    const candidate = `${base} ${n}`.slice(0, 24);
    if (isFree(normaliseJoinNick(candidate))) out.push(candidate);
  }
  return out;
}

export class LeagueRegistrar {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  #rows(query, ...binds) { return this.sql.exec(query, ...binds).toArray(); }

  /** An opaque, unguessable fence for one attempt. */
  #fence() { return crypto.randomUUID(); }

  #row(uid) { return this.#rows("SELECT norm, nick, state, ts, fence FROM claims WHERE uid = ?", uid)[0]; }

  /**
   * Backfill members KV already holds — additive only.
   *
   * A registrar instance starts empty and members may predate it, so the worker
   * passes the current roster. Unknown members are inserted as committed. A
   * PENDING row is promoted to committed ONLY when the roster's normalised name
   * matches that pending claim — a stale roster still showing an old name must
   * never rewrite or commit a rename that is in flight to a different name. It
   * NEVER deletes and NEVER touches a released or committed row, so a lagging
   * roster cannot resurrect a kicked member's claim.
   */
  #reconcile(roster) {
    for (const m of roster || []) {
      if (!m?.uid) continue;
      const norm = normaliseJoinNick(m.nick);
      if (!norm) continue;
      this.sql.exec("INSERT OR IGNORE INTO claims (uid, norm, nick, state, ts, fence) VALUES (?, ?, ?, 'committed', 0, '')",
        m.uid, norm, String(m.nick));
      this.sql.exec("UPDATE claims SET state = 'committed' WHERE uid = ? AND state = 'pending' AND norm = ?",
        m.uid, norm);
    }
  }

  /** The uid, if any, that currently holds this norm — committed, or fresh pending. */
  #holder(norm, uid, now) {
    return this.#rows(
      "SELECT uid FROM claims WHERE norm = ? AND uid != ? "
      + "AND (state = 'committed' OR (state = 'pending' AND ts > ?)) LIMIT 1",
      norm, uid, now - PENDING_TTL_MS)[0];
  }

  #suggest(display, now) {
    const held = new Set(this.#rows(
      "SELECT norm FROM claims WHERE state = 'committed' OR (state = 'pending' AND ts > ?)",
      now - PENDING_TTL_MS).map((r) => r.norm));
    return suggestFor(display, (n) => !held.has(n));
  }

  /** Is this uid's own claim to `norm` still live (committed, or fresh pending)? */
  #ownsLive(row, norm, now) {
    if (!row || row.norm !== norm) return false;
    if (row.state === "committed") return true;
    return row.state === "pending" && row.ts > now - PENDING_TTL_MS;
  }

  /**
   * Reserve a name for a uid as a fresh PENDING attempt, atomically. Single-
   * threaded, so the conflict read and the write cannot interleave with another
   * begin. Returns an opaque fence the caller must present to commit().
   */
  begin({ uid, nick, roster, now = 0 }) {
    uid = String(uid || "");
    if (!uid) return { ok: false, error: "uid required" };
    const norm = normaliseJoinNick(nick);
    if (!norm) return { ok: false, error: "name required" };
    this.#reconcile(roster);
    const display = String(nick).trim().slice(0, 24);
    const mine = this.#row(uid);

    // Already committed to this exact name: a no-op success, no new attempt.
    if (mine && mine.state === "committed" && mine.norm === norm) {
      return { ok: true, own: true, committed: true, norm, nick: display, fence: mine.fence };
    }
    // A live (fresh) pending under this exact name: an idempotent retry. Issue a
    // NEW fence, superseding the prior attempt, and refresh the hold.
    if (mine && mine.state === "pending" && mine.norm === norm && mine.ts > now - PENDING_TTL_MS) {
      const fence = this.#fence();
      this.sql.exec("UPDATE claims SET ts = ?, nick = ?, fence = ? WHERE uid = ?", now, display, fence, uid);
      return { ok: true, own: true, norm, nick: display, fence };
    }

    // An EXPIRED pending row is not an owned reservation — contest the name.
    if (this.#holder(norm, uid, now)) {
      return { ok: false, taken: true, norm, error: "That name is taken in this league",
        suggestions: this.#suggest(display, now) };
    }

    // Free: reserve as a fresh pending attempt. UID is the key, so this both
    // inserts a new joiner and moves an existing member off a previous name.
    const fence = this.#fence();
    this.sql.exec("INSERT INTO claims (uid, norm, nick, state, ts, fence) VALUES (?, ?, ?, 'pending', ?, ?) "
      + "ON CONFLICT(uid) DO UPDATE SET norm = excluded.norm, nick = excluded.nick, "
      + "state = 'pending', ts = excluded.ts, fence = excluded.fence",
      uid, norm, display, now, fence);
    return { ok: true, norm, nick: display, fence };
  }

  /**
   * Convert a uid's pending attempt to committed — but only when it is still the
   * active, fresh attempt (uid + norm + fence all match, not expired) and no
   * other uid has acquired the name meanwhile. A stale, expired, superseded or
   * released attempt returns committed:false and changes nothing, so the caller
   * knows its fence lost authority and must not report success.
   */
  commit({ uid, norm, fence, now = 0 }) {
    uid = String(uid || "");
    const want = normaliseJoinNick(norm) || String(norm || "");
    const row = this.#row(uid);
    // Already committed to this name: idempotent success (a duplicate commit).
    if (row && row.state === "committed" && row.norm === want) return { ok: true, committed: true };

    const active = row && row.state === "pending" && row.norm === want
      && row.fence === String(fence || "") && row.ts > now - PENDING_TTL_MS;
    if (!active) return { ok: true, committed: false, reason: "superseded" };
    // The name may have been acquired by another uid since this attempt began.
    if (this.#holder(want, uid, now)) {
      return { ok: true, committed: false, taken: true, suggestions: this.#suggest(row.nick, now) };
    }
    this.sql.exec("UPDATE claims SET state = 'committed' WHERE uid = ? AND fence = ? AND state = 'pending'",
      uid, String(fence || ""));
    return { ok: true, committed: true };
  }

  /** Free a member's name — kick or deletion. Tombstoned so a stale roster
   *  cannot resurrect it; a released name is immediately reusable by anyone.
   *  Idempotent: releasing an already-released or absent uid is a success, so a
   *  retry after a failed teardown always converges. */
  release({ uid, now = 0 }) {
    const changed = this.sql.exec("UPDATE claims SET state = 'released', ts = ?, fence = '' WHERE uid = ? AND state != 'released'",
      now, String(uid || "")).rowsWritten;
    return { ok: true, released: (changed || 0) > 0 };
  }

  /** Drop every claim — league deletion. Idempotent. */
  purge() {
    this.sql.exec("DELETE FROM claims");
    return { ok: true, purged: true };
  }

  /** Read-only availability, for a live sheet check. */
  check({ uid, nick, roster, now = 0 }) {
    this.#reconcile(roster);
    const norm = normaliseJoinNick(nick);
    if (!norm) return { available: false, error: "name required" };
    if (this.#ownsLive(this.#row(String(uid || "")), norm, now)) return { available: true, own: true };
    if (!this.#holder(norm, String(uid || ""), now)) return { available: true };
    return { available: false, taken: true, suggestions: this.#suggest(String(nick).trim(), now) };
  }

  async fetch(request) {
    const { op, ...args } = await request.json();
    const handlers = {
      begin: () => this.begin(args),
      commit: () => this.commit(args),
      release: () => this.release(args),
      purge: () => this.purge(args),
      check: () => this.check(args),
    };
    const handler = handlers[op];
    if (!handler) return new Response(JSON.stringify({ error: `unknown op: ${op}` }), { status: 400 });
    return new Response(JSON.stringify(handler()), { headers: { "content-type": "application/json" } });
  }
}
