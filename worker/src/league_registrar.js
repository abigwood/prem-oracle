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
//   pending   — an in-flight join holds the name for a short TTL;
//   committed — the membership write has completed (or a genuine member was
//               backfilled from the roster);
//   released  — the member was kicked or deleted; the name is free again, and a
//               stale roster can never resurrect the claim.
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
  ts    INTEGER NOT NULL
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

  /**
   * Backfill members KV already holds — additive only.
   *
   * A registrar instance starts empty and members may predate it, so the worker
   * passes the current roster. Unknown members are inserted as committed; a
   * pending row for a member who now has a real membership is promoted to
   * committed. It NEVER deletes and NEVER touches a released row, so a stale
   * roster that still lists a kicked member cannot resurrect that claim — the
   * exact read-after-write lag that makes KV unsafe as the authority.
   */
  #reconcile(roster) {
    for (const m of roster || []) {
      if (!m?.uid) continue;
      const norm = normaliseJoinNick(m.nick);
      if (!norm) continue;
      this.sql.exec("INSERT OR IGNORE INTO claims (uid, norm, nick, state, ts) VALUES (?, ?, ?, 'committed', 0)",
        m.uid, norm, String(m.nick));
      this.sql.exec("UPDATE claims SET norm = ?, nick = ?, state = 'committed' WHERE uid = ? AND state = 'pending'",
        norm, String(m.nick), m.uid);
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

  /**
   * Reserve a name for a uid as PENDING, atomically. Single-threaded, so the
   * conflict read and the write cannot interleave with another begin.
   */
  begin({ uid, nick, roster, now = 0 }) {
    uid = String(uid || "");
    if (!uid) return { ok: false, error: "uid required" };
    const norm = normaliseJoinNick(nick);
    if (!norm) return { ok: false, error: "name required" };
    this.#reconcile(roster);
    const display = String(nick).trim().slice(0, 24);

    // Already yours (and not a released tombstone): idempotent, refresh pending.
    const mine = this.#rows("SELECT norm, state FROM claims WHERE uid = ?", uid)[0];
    if (mine && mine.state !== "released" && mine.norm === norm) {
      if (mine.state === "pending") this.sql.exec("UPDATE claims SET ts = ?, nick = ? WHERE uid = ?", now, display, uid);
      return { ok: true, norm, nick: display, own: true };
    }

    if (this.#holder(norm, uid, now)) {
      return { ok: false, taken: true, norm, error: "That name is taken in this league",
        suggestions: this.#suggest(display, now) };
    }

    // Free: reserve as pending. UID is the key, so this both inserts a new
    // joiner and moves an existing member off a previous name in one statement.
    this.sql.exec("INSERT INTO claims (uid, norm, nick, state, ts) VALUES (?, ?, ?, 'pending', ?) "
      + "ON CONFLICT(uid) DO UPDATE SET norm = excluded.norm, nick = excluded.nick, state = 'pending', ts = excluded.ts",
      uid, norm, display, now);
    return { ok: true, norm, nick: display };
  }

  /** Promote a uid's pending claim to committed once its membership is written. */
  commit({ uid, norm }) {
    const changed = this.sql.exec("UPDATE claims SET state = 'committed' WHERE uid = ? AND norm = ?",
      String(uid || ""), normaliseJoinNick(norm) || String(norm || "")).rowsWritten;
    return { ok: true, committed: (changed || 0) > 0 };
  }

  /** Free a member's name — kick or deletion. Tombstoned so a stale roster
   *  cannot resurrect it; a released name is immediately reusable by anyone. */
  release({ uid, now = 0 }) {
    const changed = this.sql.exec("UPDATE claims SET state = 'released', ts = ? WHERE uid = ?",
      now, String(uid || "")).rowsWritten;
    return { ok: true, released: (changed || 0) > 0 };
  }

  /** Drop every claim — league deletion. */
  purge() {
    this.sql.exec("DELETE FROM claims");
    return { ok: true };
  }

  /** Read-only availability, for a live sheet check. */
  check({ uid, nick, roster, now = 0 }) {
    this.#reconcile(roster);
    const norm = normaliseJoinNick(nick);
    if (!norm) return { available: false, error: "name required" };
    const mine = this.#rows("SELECT norm, state FROM claims WHERE uid = ?", String(uid || ""))[0];
    if (mine && mine.state !== "released" && mine.norm === norm) return { available: true, own: true };
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
