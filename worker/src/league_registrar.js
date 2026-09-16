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
  uid       TEXT PRIMARY KEY,
  norm      TEXT NOT NULL,
  nick      TEXT NOT NULL,
  state     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  fence     TEXT NOT NULL DEFAULT '',
  activated INTEGER NOT NULL DEFAULT 0,
  since     INTEGER NOT NULL DEFAULT 0,
  pnorm     TEXT NOT NULL DEFAULT '',
  pnick     TEXT NOT NULL DEFAULT '',
  pfence    TEXT NOT NULL DEFAULT '',
  pts       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS claims_norm ON claims (norm);
CREATE TABLE IF NOT EXISTS teardowns (
  scope TEXT NOT NULL,
  kind  TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT '',
  ts    INTEGER NOT NULL,
  PRIMARY KEY (scope, kind, token)
);
`;
// A teardown fence lives HERE, in the single-threaded DO — not in eventually
// consistent KV — so it is the immediate concurrency barrier: while a member is
// being kicked/deleted, or a league deleted, begin/rename/profile/commit for the
// affected scope refuse atomically, even if the KV intent has not yet become
// visible. The KV intent is the durable retry context; this is the exclusion.
const memberScope = (uid) => `member:${String(uid || "")}`;
const LEAGUE_SCOPE = "league";

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

  #row(uid) { return this.#rows("SELECT norm, nick, state, ts, fence, activated, since, pnorm, pnick, pfence, pts FROM claims WHERE uid = ?", uid)[0]; }

  /**
   * Backfill members KV already holds — BACKFILL-ONLY, for a uid the registrar
   * has never seen (a pre-v1.8 legacy member). It NEVER promotes, rewrites,
   * activates or resurrects an existing pending, released, committed or
   * teardown-owned claim from KV evidence: raw provisional KV rows must not
   * become committed members, and final commit(uid, norm, fence) is the only
   * activation route. A lagging roster therefore cannot resurrect a kicked
   * member or activate a never-committed join.
   */
  #reconcile(roster) {
    for (const m of roster || []) {
      if (!m?.uid) continue;
      const norm = normaliseJoinNick(m.nick);
      if (!norm) continue;
      const since = Number.isFinite(m.since) && m.since >= 0 ? Math.floor(m.since) : 0;
      // INSERT OR IGNORE: a uid already known to the registrar (any state) is
      // left exactly as it is; only a genuinely unknown legacy uid is inserted.
      this.sql.exec("INSERT OR IGNORE INTO claims (uid, norm, nick, state, ts, fence, activated, since) VALUES (?, ?, ?, 'committed', 0, '', 1, ?)",
        m.uid, norm, String(m.nick), since);
    }
  }

  /** The uid, if any, that currently holds this norm — as a committed name, a
   *  fresh first-join pending name, OR a fresh in-flight rename reservation. */
  #holder(norm, uid, now) {
    const fresh = now - PENDING_TTL_MS;
    return this.#rows(
      "SELECT uid FROM claims WHERE uid != ? AND ("
      + "(state = 'committed' AND norm = ?) "
      + "OR (state = 'pending' AND norm = ? AND ts > ?) "
      + "OR (pnorm = ? AND pts > ?)) LIMIT 1",
      uid, norm, norm, fresh, norm, fresh)[0];
  }

  #suggest(display, now) {
    const fresh = now - PENDING_TTL_MS;
    const held = new Set();
    for (const r of this.#rows("SELECT norm, state, ts FROM claims WHERE state = 'committed' OR (state = 'pending' AND ts > ?)", fresh)) held.add(r.norm);
    for (const r of this.#rows("SELECT pnorm FROM claims WHERE pnorm != '' AND pts > ?", fresh)) held.add(r.pnorm);
    return suggestFor(display, (n) => !held.has(n));
  }

  /** An active teardown fence blocks the whole league, or one member's scope.
   *  Each fence is owned by (kind, token); several may coexist on one scope, and
   *  ANY of them blocks begin/commit. */
  #leagueFenced() { return this.#rows("SELECT 1 FROM teardowns WHERE scope = ? LIMIT 1", LEAGUE_SCOPE).length > 0; }
  #memberFenced(uid) { return this.#rows("SELECT 1 FROM teardowns WHERE scope = ? LIMIT 1", memberScope(uid)).length > 0; }
  /** Is a FOREIGN (non-abort) teardown active on a member's scope? A join abort
   *  must defer to a kick/account teardown rather than touch it. */
  #foreignMemberTeardown(uid) {
    return this.#rows("SELECT 1 FROM teardowns WHERE scope = ? AND kind != 'abort' LIMIT 1", memberScope(uid)).length > 0;
  }

  /** Is this uid's own claim to `norm` still live (committed, or fresh pending)? */
  #ownsLive(row, norm, now) {
    if (!row || row.norm !== norm) return false;
    if (row.state === "committed") return true;
    return row.state === "pending" && row.ts > now - PENDING_TTL_MS;
  }

  #fresh(ts, now) { return ts > now - PENDING_TTL_MS; }
  /** An established member is committed (activated) — INCLUDING while a rename is
   *  in flight, because a rename keeps the committed name and reserves the new one
   *  separately. A never-activated first-join pending is NOT established. */
  #established(row) { return !!row && row.state === "committed"; }

  /**
   * Reserve a name atomically. Two distinct shapes:
   *   FIRST JOIN (uid not yet an established member) — reserves the name as a
   *     never-activated pending claim (activated=0). commit activates it.
   *   RENAME (uid already committed/established) — keeps the committed name held
   *     and reserves the NEW name separately in the pending-rename fields, so a
   *     failed or expired rename cannot lose the old name to another player.
   * Returns an opaque fence the caller presents to commit().
   */
  begin({ uid, nick, roster, now = 0 }) {
    uid = String(uid || "");
    if (!uid) return { ok: false, error: "uid required" };
    const norm = normaliseJoinNick(nick);
    if (!norm) return { ok: false, error: "name required" };
    if (this.#leagueFenced()) return { ok: false, fenced: true, scope: "league", error: "league is being deleted" };
    if (this.#memberFenced(uid)) return { ok: false, fenced: true, scope: "member", error: "removal in progress" };
    this.#reconcile(roster);
    const display = String(nick).trim().slice(0, 24);
    const mine = this.#row(uid);

    if (this.#established(mine)) {
      // --- RENAME (or no-op) of an established member ---
      if (mine.norm === norm) return { ok: true, own: true, committed: true, uid, norm, nick: display, fence: mine.fence };
      // One in-flight rename per member.
      if (mine.pnorm && this.#fresh(mine.pts, now)) {
        if (mine.pnorm === norm) {
          this.sql.exec("UPDATE claims SET pts = ?, pnick = ? WHERE uid = ?", now, display, uid);
          return { ok: true, own: true, uid, norm, nick: display, fence: mine.pfence };
        }
        return { ok: false, inflight: true, uid, error: "a name change is already in progress for this account" };
      }
      if (this.#holder(norm, uid, now)) {
        return { ok: false, taken: true, uid, norm, error: "That name is taken in this league",
          suggestions: this.#suggest(display, now) };
      }
      // Reserve the NEW name separately; the committed name stays held.
      const fence = this.#fence();
      this.sql.exec("UPDATE claims SET pnorm = ?, pnick = ?, pfence = ?, pts = ? WHERE uid = ?",
        norm, display, fence, now, uid);
      return { ok: true, uid, norm, nick: display, fence, rename: true };
    }

    // --- FIRST JOIN ---
    // ONE safe in-flight attempt per uid: an identical retry converges on the
    // same fence; a different name refuses rather than supersede the attempt.
    if (mine && mine.state === "pending" && this.#fresh(mine.ts, now)) {
      if (mine.norm === norm) {
        this.sql.exec("UPDATE claims SET ts = ? WHERE uid = ?", now, uid);
        return { ok: true, own: true, uid, norm, nick: mine.nick, fence: mine.fence };
      }
      return { ok: false, inflight: true, uid, error: "a join is already in progress for this account" };
    }
    if (this.#holder(norm, uid, now)) {
      return { ok: false, taken: true, uid, norm, error: "That name is taken in this league",
        suggestions: this.#suggest(display, now) };
    }
    const fence = this.#fence();
    this.sql.exec("INSERT INTO claims (uid, norm, nick, state, ts, fence, activated, pnorm, pnick, pfence, pts) "
      + "VALUES (?, ?, ?, 'pending', ?, ?, 0, '', '', '', 0) "
      + "ON CONFLICT(uid) DO UPDATE SET norm = excluded.norm, nick = excluded.nick, "
      + "state = 'pending', ts = excluded.ts, fence = excluded.fence, activated = 0, "
      + "pnorm = '', pnick = '', pfence = '', pts = 0",
      uid, norm, display, now, fence);
    return { ok: true, uid, norm, nick: display, fence };
  }

  /**
   * Convert a fenced attempt to committed. A FIRST-JOIN commit activates the
   * pending claim; a RENAME commit adopts the reserved new name and releases the
   * old one in the same row. Either only succeeds while it is the still-active,
   * fresh attempt (fence matches, not expired) and the name is not held by
   * another uid — else committed:false, changing nothing.
   */
  commit({ uid, norm, fence, since, now = 0 }) {
    uid = String(uid || "");
    fence = String(fence || "");
    const want = normaliseJoinNick(norm) || String(norm || "");
    if (this.#leagueFenced() || this.#memberFenced(uid)) {
      return { ok: true, committed: false, uid, norm: want, fenced: true };
    }
    const row = this.#row(uid);
    if (!row) return { ok: true, committed: false, uid, norm: want, reason: "absent" };
    // Idempotent: already committed to this exact name (first join or a rename
    // that already adopted it).
    if (row.state === "committed" && row.norm === want) return { ok: true, committed: true, uid, norm: want };

    // RENAME commit: the reserved new name for an established member.
    if (this.#established(row) && row.pnorm === want && row.pfence === fence && this.#fresh(row.pts, now)) {
      if (this.#holder(want, uid, now)) {
        return { ok: true, committed: false, uid, norm: want, taken: true, suggestions: this.#suggest(row.pnick, now) };
      }
      // Adopt the new name and drop the reservation; the old name is released.
      this.sql.exec("UPDATE claims SET norm = ?, nick = ?, pnorm = '', pnick = '', pfence = '', pts = 0 WHERE uid = ? AND pfence = ?",
        want, row.pnick, uid, fence);
      return { ok: true, committed: true, uid, norm: want };
    }

    // FIRST-JOIN commit: activate the never-activated pending claim.
    if (row.state === "pending" && row.norm === want && row.fence === fence && this.#fresh(row.ts, now)) {
      if (this.#holder(want, uid, now)) {
        return { ok: true, committed: false, uid, norm: want, taken: true, suggestions: this.#suggest(row.nick, now) };
      }
      const joinTs = Number.isFinite(since) && since >= 0 ? Math.floor(since) : (row.since || now);
      this.sql.exec("UPDATE claims SET state = 'committed', activated = 1, since = ? WHERE uid = ? AND fence = ? AND state = 'pending'",
        joinTs, uid, fence);
      return { ok: true, committed: true, uid, norm: want };
    }

    return { ok: true, committed: false, uid, norm: want, reason: "superseded" };
  }

  /** Cancel an in-flight rename reservation (a failed/expired rename), keeping
   *  the member committed under their existing name. Only drops the reservation
   *  matching this fence, so it never touches a newer rename or a live claim. */
  cancelRename({ uid, fence, now = 0 }) {
    uid = String(uid || "");
    fence = String(fence || "");
    const changed = this.sql.exec("UPDATE claims SET pnorm = '', pnick = '', pfence = '', pts = 0 WHERE uid = ? AND pfence = ?",
      uid, fence).rowsWritten;
    return { ok: true, cancelled: (changed || 0) > 0, uid, fence };
  }

  /** Fence a member's scope for a HARD teardown (kick / account deletion), owned
   *  by (kind, token). Each operation installs its OWN row: a kick and an account
   *  deletion of the same uid coexist and neither overwrites the other. It is
   *  idempotent for its own (kind, token), and only its own release — matching
   *  (kind, token) — lifts it. */
  fenceMember({ uid, kind = "kick", token = "", now = 0 }) {
    this.sql.exec("INSERT OR REPLACE INTO teardowns (scope, kind, token, ts) VALUES (?, ?, ?, ?)",
      memberScope(uid), String(kind), String(token), now);
    return { ok: true, fenced: true, uid: String(uid || ""), kind: String(kind), token: String(token) };
  }

  /** Every uid the registrar knows a claim for — pending, committed OR released
   *  — the authoritative teardown set. Committed members alone drive succession. */
  #allClaimUids() { return this.#rows("SELECT uid FROM claims").map((r) => r.uid); }
  #committedMembers() { return this.#rows("SELECT uid, nick, since FROM claims WHERE state = 'committed'"); }

  /** Fence the whole league BEFORE its live teardown. Reconciles the caller's raw
   *  roster FIRST (so pre-v1.8 legacy members are backfilled and included), then
   *  atomically raises the fence and returns BOTH the full known-uid set (for
   *  teardown — pending, committed and released, so a prepared pending join is
   *  never left orphaned) and the committed-only set (for succession decisions).
   *  The caller never has to trust an eventually-consistent KV list. Idempotent. */
  fenceLeague({ roster, now = 0 } = {}) {
    this.#reconcile(roster);
    this.sql.exec("INSERT OR REPLACE INTO teardowns (scope, kind, token, ts) VALUES (?, 'league', '', ?)", LEAGUE_SCOPE, now);
    return { ok: true, fenced: true, uids: this.#allClaimUids(), committed: this.#committedMembers() };
  }

  /** Lift the whole-league fence — used when a closure decision resolves instead
   *  to succession, so the league lives on. Idempotent. */
  unfenceLeague() {
    this.sql.exec("DELETE FROM teardowns WHERE scope = ?", LEAGUE_SCOPE);
    return { ok: true, unfenced: true };
  }

  /**
   * Owner departure (account deletion) — the CLOSE-vs-succeed decision and the
   * fence handoff in ONE atomic step, so there is never an unfenced gap and no
   * retry path that forgets to lift the league fence.
   *
   * Reconciles the raw roster first (legacy + pending included), then:
   *   - no other committed member  -> CLOSING: the whole-league fence stays up so
   *     every later join is refused; the caller purges (which clears it).
   *   - another committed member   -> SUCCESSION: the whole-league fence is
   *     CONVERTED, in place, into a teardown fence on the departing uid — the
   *     league keeps living for others, but the departing account cannot rejoin
   *     while its row is being removed. No gap either way.
   * Returns the full known-uid set and the committed members regardless.
   */
  ownerDeparture({ uid, roster, token = "", now = 0 }) {
    uid = String(uid || "");
    this.#reconcile(roster);
    const committed = this.#committedMembers();
    const uids = this.#allClaimUids();
    const others = committed.filter((m) => m.uid !== uid);
    if (others.length === 0) {
      // CLOSING — raise (or keep) the whole-league fence. Idempotent, so an
      // account-deletion retry resumes its own closure; a foreign league deletion
      // that also holds it is likewise closing this league, so this is safe.
      this.sql.exec("INSERT OR REPLACE INTO teardowns (scope, kind, token, ts) VALUES (?, 'league', '', ?)", LEAGUE_SCOPE, now);
      return { ok: true, closing: true, uids, committed };
    }
    // SUCCESSION — the league lives on for other members, so the whole-league
    // fence must be converted to a fence on the departing uid. A succession never
    // leaves a league fence up, so a league fence here belongs to a FOREIGN league
    // deletion (dominant) — defer to it rather than lift it.
    if (this.#leagueFenced()) return { ok: true, deferred: true, uids: [], committed: [] };
    this.sql.exec("INSERT OR REPLACE INTO teardowns (scope, kind, token, ts) VALUES (?, 'account', ?, ?)",
      memberScope(uid), String(token), now);
    return { ok: true, closing: false, uids, committed };
  }

  /** Free a member's name — kick or deletion — and lift ONLY this operation's own
   *  teardown fence (matching kind + token), never another operation's. Tombstoned
   *  so a stale roster cannot resurrect it; a released name is immediately
   *  reusable. Idempotent, so a retry after a failed teardown always converges. */
  release({ uid, kind = "kick", token = "", now = 0 }) {
    uid = String(uid || "");
    kind = String(kind);
    token = String(token);
    // Ownership check: this release completes ONLY through its own fence — the
    // exact (scope, kind, token) it raised. A wrong or absent token must not
    // change a live claim.
    const owns = this.#rows("SELECT 1 FROM teardowns WHERE scope = ? AND kind = ? AND token = ? LIMIT 1",
      memberScope(uid), kind, token).length > 0;
    if (owns) {
      const changed = this.sql.exec(
        "UPDATE claims SET state = 'released', ts = ?, fence = '', pnorm = '', pnick = '', pfence = '', pts = 0 "
        + "WHERE uid = ? AND state != 'released'", now, uid).rowsWritten;
      this.sql.exec("DELETE FROM teardowns WHERE scope = ? AND kind = ? AND token = ?", memberScope(uid), kind, token);
      return { ok: true, completed: true, released: (changed || 0) > 0, uid, kind, token };
    }
    // No owning fence. A release whose work is already done (fence lifted, claim
    // tombstoned) is an idempotent success; otherwise this operation does not own
    // the scope and must change nothing.
    const row = this.#row(uid);
    if (row && row.state === "released") return { ok: true, completed: true, released: false, uid, kind, token };
    return { ok: true, completed: false, released: false, uid, kind, token };
  }

  /**
   * Authorise cleanup of a FAILED join attempt, attempt-owned and race-free.
   * Aborts only when this uid's row is still the pending attempt with this exact
   * fence AND no FOREIGN teardown owns the scope. It never replaces, converts or
   * lifts a kick/account/league teardown — if one owns the scope it DEFERS
   * (authorised:false, deferred:true), leaving the durable intent to converge
   * after the winning teardown. Otherwise it installs a soft abort fence keyed by
   * the join fence, blocking begin/commit for the uid while cleanup runs.
   */
  abort({ uid, fence, now = 0 }) {
    uid = String(uid || "");
    fence = String(fence || "");
    const row = this.#row(uid);
    const state = row ? row.state : "absent";
    const ownsPending = row && row.state === "pending" && row.fence === fence;
    if (!ownsPending) return { ok: true, authorised: false, uid, fence, state };
    // A dominant league deletion, or a FOREIGN hard member teardown (kick /
    // account), owns the scope: defer — never overwrite or touch their fence.
    if (this.#leagueFenced() || this.#foreignMemberTeardown(uid)) {
      return { ok: true, authorised: false, deferred: true, uid, fence, state };
    }
    this.sql.exec("INSERT OR REPLACE INTO teardowns (scope, kind, token, ts) VALUES (?, 'abort', ?, ?)",
      memberScope(uid), fence, now);
    return { ok: true, authorised: true, uid, fence, state };
  }

  /** Finish an attempt-owned abort. Idempotent and strictly own-scoped: it lifts
   *  ONLY this abort's own fence (kind='abort', token=fence) — never a
   *  kick/account/league fence — and tombstones the claim ONLY while it is still
   *  this pending attempt, so it can never release a winner. Echoes uid + fence. */
  finishAbort({ uid, fence, now = 0 }) {
    uid = String(uid || "");
    fence = String(fence || "");
    // Always lift ONLY this abort's own fence (kind='abort', token=fence) — never
    // a foreign kick/account/league fence. Idempotent.
    this.sql.exec("DELETE FROM teardowns WHERE scope = ? AND kind = 'abort' AND token = ?", memberScope(uid), fence);
    // Complete (tombstone the pending claim) ONLY when it is still this attempt's
    // AND no foreign teardown owns the scope — never complete THROUGH another
    // operation's fence, and never release a winner.
    const row = this.#row(uid);
    if (row && row.state === "pending" && row.fence === fence
        && !this.#leagueFenced() && !this.#foreignMemberTeardown(uid)) {
      this.sql.exec("UPDATE claims SET state = 'released', ts = ?, fence = '' WHERE uid = ? AND fence = ? AND state = 'pending'",
        now, uid, fence);
      return { ok: true, finished: true, uid, fence };
    }
    return { ok: true, finished: false, uid, fence };
  }

  /** Drop every claim and every fence — league deletion. Idempotent. */
  purge() {
    this.sql.exec("DELETE FROM claims");
    this.sql.exec("DELETE FROM teardowns");
    return { ok: true, purged: true };
  }

  /**
   * The authoritative visibility verdict for a set of uids: which must be HIDDEN
   * from ordinary member/state/league reads. This makes the DO — not a racy KV
   * write — the source of truth for whether a membership is live: a first-join
   * claim not yet activated (provisional) and a released (torn-down) claim are
   * both hidden, so no provisional row is ever shown and no late write can make a
   * released member reappear. A uid the DO has never seen is legacy and stays
   * visible (KV is its only record).
   */
  classify({ uids }) {
    // The authoritative committed roster: the registrar's word on who is a live
    // member and under exactly which display name. Callers OVERLAY this so a
    // stale/clobbered KV row can never repaint or resurrect a member.
    const members = this.#committedMembers();
    const committed = new Set(members.map((m) => m.uid));
    const hide = [];
    for (const uid of uids || []) {
      const key = String(uid || "");
      if (committed.has(key)) continue; // committed -> authoritative, shown
      const row = this.#row(key);
      if (!row) continue; // unknown to the DO -> legacy member, visible
      if (row.state === "released") hide.push(uid);
      else if (row.state === "pending" && !row.activated) hide.push(uid); // a first join, not yet activated
    }
    return { ok: true, hide, members };
  }

  /** Read-only availability, for a live sheet check. */
  check({ uid, nick, roster, now = 0 }) {
    if (this.#leagueFenced()) return { available: false, fenced: true };
    if (this.#memberFenced(String(uid || ""))) return { available: false, fenced: true };
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
      classify: () => this.classify(args),
      fenceMember: () => this.fenceMember(args),
      fenceLeague: () => this.fenceLeague(args),
      unfenceLeague: () => this.unfenceLeague(args),
      ownerDeparture: () => this.ownerDeparture(args),
      abort: () => this.abort(args),
      finishAbort: () => this.finishAbort(args),
      cancelRename: () => this.cancelRename(args),
    };
    const handler = handlers[op];
    if (!handler) return new Response(JSON.stringify({ error: `unknown op: ${op}` }), { status: 400 });
    return new Response(JSON.stringify(handler()), { headers: { "content-type": "application/json" } });
  }
}
