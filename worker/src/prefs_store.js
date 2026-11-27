/**
 * v1.9 build 37 — PrefsStore: the strongly consistent home of push:<uid>.
 *
 * The bug it fixes: /notification-prefs, /push-token and the APNs 410 path all
 * did read-modify-write on KV push:<uid>. KV is eventually consistent (~60s),
 * so two writes close together lost a field — ticking "Mates' picks revealed"
 * asks iOS, registers the device, and the token save then wrote back a stale
 * copy without `reveal`. A GET soon after could also answer stale.
 *
 * Now one Durable Object per uid (idFromName(uid)) holds the record in SQLite,
 * applies every write in order (an explicit queue: a DO can interleave
 * requests while it awaits KV), and mirrors the WHOLE record to KV push:<uid>
 * after each write. Every reader (reminder planner, reveal/results fan-out,
 * consumer) keeps reading KV push:<uid> unchanged; only writers moved here.
 *
 * Choices (reveal, results, offers) are last-writer-wins on the client's
 * `updatedAt`: a write older than the stored choice is ignored and the answer
 * says what is stored. Offers only ever go false -> true. Mute is a whole list
 * sent whole by every build, applied as sent.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prefs (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  record TEXT NOT NULL
);
`;

/** A client clock may run fast; never let a future-dated choice lock others out. */
const clampTime = (t, now) => (Number.isFinite(t) && t > 0 ? Math.min(t, now) : now);

/**
 * Pure. Apply a validated prefs body to a record. Returns { record, stale }.
 * `stale` means the body's choice is older than the stored one, so its
 * reveal/results were not applied (offers and mute still are: offers only
 * grow, and mute is not part of the choice clock).
 */
export function applyPrefs(record, body, now = Date.now()) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
  const next = { ...(record || {}) };
  if (!Array.isArray(next.mute)) next.mute = [];
  if (has("mute")) next.mute = [...new Set(body.mute)];
  const touchesChoice = has("reveal") || has("results");
  const sentAt = Number(body.updatedAt);
  const stale = touchesChoice && Number.isFinite(sentAt) && sentAt > 0
    && Number.isFinite(next.choiceAt) && sentAt < next.choiceAt;
  if (touchesChoice && !stale) {
    for (const key of ["reveal", "results"]) {
      if (!has(key)) continue;
      if (body[key]) next[key] = true; else delete next[key];
    }
    next.choiceAt = clampTime(sentAt, now);
  }
  if (has("offers")) {
    const merged = { ...(next.offers || {}) };
    for (const key of ["reveal", "results"]) if (body.offers[key] === true) merged[key] = true;
    if (Object.keys(merged).length) next.offers = merged;
    if (!touchesChoice && !Number.isFinite(next.choiceAt)) next.choiceAt = clampTime(sentAt, now);
  }
  next.updatedAt = now;
  return { record: next, stale };
}

export class PrefsStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.chain = Promise.resolve();
  }

  #read() {
    const row = this.sql.exec("SELECT record FROM prefs WHERE id = 1").toArray()[0];
    return row ? JSON.parse(row.record) : undefined;
  }

  #write(record) {
    this.sql.exec("INSERT INTO prefs (id, record) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      JSON.stringify(record));
  }

  /** First touch only: adopt what KV holds (written before this store existed). */
  async #current(uid) {
    const stored = this.#read();
    if (stored !== undefined) return stored;
    const raw = await this.env.KV.get(`push:${uid}`);
    let seed = null;
    try { seed = raw ? JSON.parse(raw) : null; } catch { seed = null; }
    this.#write(seed || {});
    return seed || {};
  }

  async #mirror(uid, record) {
    const key = `push:${uid}`;
    if (!record || record.erased || !Object.keys(record).length) await this.env.KV.delete(key);
    else await this.env.KV.put(key, JSON.stringify(record));
  }

  /** One op at a time, in arrival order. */
  #serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async op(uid, name, args = {}, now = Date.now()) {
    return this.#serial(async () => {
      let record = await this.#current(uid);
      if (record.erased && name !== "erase") record = {};
      if (name === "get") return { record: record.erased ? {} : record };
      let stale = false;
      if (name === "prefs") {
        ({ record, stale } = applyPrefs(record, args.body || {}, now));
      } else if (name === "token") {
        record = { ...record, token: String(args.token), platform: String(args.platform || "ios").slice(0, 20), updatedAt: now };
        if (!Array.isArray(record.mute)) record.mute = [];
      } else if (name === "dropToken") {
        // Only the token APNs refused: a newer registration must survive an old 410.
        if (record.token && (!args.token || record.token === args.token)) {
          record = { ...record };
          delete record.token;
          delete record.platform;
          record.updatedAt = now;
        }
      } else if (name === "erase") {
        record = { erased: true };
      } else {
        throw new Error(`unknown op ${name}`);
      }
      this.#write(record);
      await this.#mirror(uid, record);
      return { record: record.erased ? {} : record, stale };
    });
  }

  async fetch(request) {
    try {
      const { uid, op, ...args } = await request.json();
      if (!uid || !op) return new Response(JSON.stringify({ error: "uid and op required" }), { status: 400 });
      return new Response(JSON.stringify(await this.op(String(uid), op, args)), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error?.message || error) }), { status: 500 });
    }
  }
}
