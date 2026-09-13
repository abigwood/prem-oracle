// The league registrar — v1.8 Slice A, atomic display-name uniqueness.
//
// A league needs display names that are unique after trimming and case folding,
// and that uniqueness has to hold under concurrent joins: two people opening the
// same invite at the same moment and typing the same name must not both get it.
// Cloudflare KV has no compare-and-set, so a check-then-write against KV is a
// race. A Durable Object is the only strongly consistent, single-threaded place
// in this stack — the same reason the notification ledger is one — so one
// registrar instance per league (idFromName(code)) serialises every claim for
// that league and the decision is atomic without an explicit lock.
//
// The registrar owns the AUTHORITY for which normalised names are claimed. Its
// SQLite table is keyed by UID, so:
//   - a re-join by an account that already holds a name always succeeds (idempotent);
//   - EXISTING duplicate names are preserved untouched — two rows may share a
//     norm, and neither is rewritten;
//   - a NEW claim on a norm already held by a DIFFERENT uid is refused.
//
// The account UID is the identity throughout. The display name is a per-league
// usability label the registrar arbitrates; it is never an account key.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  uid  TEXT PRIMARY KEY,
  norm TEXT NOT NULL,
  nick TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_norm ON claims (norm);
`;

// The uniqueness key: trim, cap to the display limit, fold case, collapse inner
// whitespace. Mirrors normaliseJoinNick in logic.js — kept as a local copy so
// the Durable Object has no import surface beyond the platform.
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
   * Bring the registrar's view up to date with the members KV already holds.
   *
   * A registrar instance starts empty, and members may predate it, so the
   * worker passes the current roster. INSERT OR IGNORE by UID is idempotent and
   * additive: it teaches the registrar about existing members (including
   * pre-existing duplicates, which coexist because UID is the key) without ever
   * rewriting a claim it already made. It never DELETES — a claim the registrar
   * has made is authoritative even before that write is visible through a KV
   * list, which is exactly the read-after-write lag that makes KV unsafe here.
   */
  #seed(roster) {
    for (const m of roster || []) {
      if (!m?.uid) continue;
      const norm = normaliseJoinNick(m.nick);
      if (!norm) continue;
      this.sql.exec("INSERT OR IGNORE INTO claims (uid, norm, nick) VALUES (?, ?, ?)",
        m.uid, norm, String(m.nick));
    }
  }

  /**
   * Claim a display name for a uid, atomically. Single-threaded, so the read
   * and the write below cannot interleave with another claim for this league.
   */
  claim({ uid, nick, roster }) {
    uid = String(uid || "");
    if (!uid) return { ok: false, error: "uid required" };
    const norm = normaliseJoinNick(nick);
    if (!norm) return { ok: false, error: "name required" };
    this.#seed(roster);

    // Already yours (any spelling that folds to the same norm): idempotent.
    const mine = this.#rows("SELECT norm FROM claims WHERE uid = ?", uid)[0];
    if (mine && mine.norm === norm) {
      this.sql.exec("UPDATE claims SET nick = ? WHERE uid = ?", String(nick).trim().slice(0, 24), uid);
      return { ok: true, uid, nick: String(nick).trim().slice(0, 24), replayed: true };
    }

    // Held by someone else -> refuse, with alternatives, and no write at all.
    const other = this.#rows("SELECT uid FROM claims WHERE norm = ? AND uid != ?", norm, uid)[0];
    if (other) {
      const taken = new Set(this.#rows("SELECT norm FROM claims").map((r) => r.norm));
      return { ok: false, taken: true, error: "That name is taken in this league",
        suggestions: suggestFor(String(nick).trim(), (n) => !taken.has(n)) };
    }

    // Free (and not currently yours under a different spelling): claim it. UID
    // is the key, so this both inserts a new member and moves an existing one
    // from a previous name in a single statement.
    const display = String(nick).trim().slice(0, 24);
    this.sql.exec("INSERT INTO claims (uid, norm, nick) VALUES (?, ?, ?) "
      + "ON CONFLICT(uid) DO UPDATE SET norm = excluded.norm, nick = excluded.nick",
      uid, norm, display);
    return { ok: true, uid, nick: display };
  }

  /** Read-only: is this normalised name free for this uid to take? */
  check({ uid, nick, roster }) {
    this.#seed(roster);
    const norm = normaliseJoinNick(nick);
    if (!norm) return { available: false, error: "name required" };
    const mine = this.#rows("SELECT norm FROM claims WHERE uid = ?", String(uid || ""))[0];
    if (mine && mine.norm === norm) return { available: true, own: true };
    const other = this.#rows("SELECT uid FROM claims WHERE norm = ? AND uid != ?", norm, String(uid || ""))[0];
    if (!other) return { available: true };
    const taken = new Set(this.#rows("SELECT norm FROM claims").map((r) => r.norm));
    return { available: false, taken: true, suggestions: suggestFor(String(nick).trim(), (n) => !taken.has(n)) };
  }

  async fetch(request) {
    const { op, ...args } = await request.json();
    const handlers = {
      claim: () => this.claim(args),
      check: () => this.check(args),
    };
    const handler = handlers[op];
    if (!handler) return new Response(JSON.stringify({ error: `unknown op: ${op}` }), { status: 400 });
    return new Response(JSON.stringify(handler()), { headers: { "content-type": "application/json" } });
  }
}
