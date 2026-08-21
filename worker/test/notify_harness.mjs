// A production harness for the Slice 1 notification path.
//
// It runs the REAL NotifyLedger class over real SQLite, the real planner and
// the real consumer — only the platform is shimmed. The point is that a Gate-0
// guarantee proved here is proved about the code that ships, not about a model
// of it.
import { DatabaseSync } from "node:sqlite";
import { NotifyLedger } from "../src/notify/ledger.js";

/** The Durable Object SQL surface, over node:sqlite. Positional bindings. */
function sqlShim(db) {
  return {
    exec(query, ...binds) {
      const trimmed = query.trim();
      // The schema is several statements and takes no bindings.
      if (!binds.length && /;\s*\S/.test(trimmed.replace(/;\s*$/, ""))) {
        db.exec(trimmed);
        return { toArray: () => [] };
      }
      const statement = db.prepare(trimmed);
      const returns = /RETURNING|^\s*SELECT/i.test(trimmed);
      if (returns) {
        const rows = statement.all(...binds);
        return { toArray: () => rows, rowsWritten: rows.length };
      }
      const info = statement.run(...binds);
      return { toArray: () => [], rowsWritten: Number(info.changes ?? 0) };
    },
  };
}

/** A Durable Object context with synchronous transactions that really roll back. */
export function ledgerObject() {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const ctx = {
    storage: {
      sql: sqlShim(db),
      transactionSync(fn) {
        if (depth++ > 0) { try { return fn(); } finally { depth--; } }
        db.exec("BEGIN IMMEDIATE");
        try {
          const out = fn();
          db.exec("COMMIT");
          return out;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally { depth--; }
      },
    },
  };
  const ledger = new NotifyLedger(ctx);
  return {
    ledger,
    db,
    /**
     * The same call surface worker.js's ledgerClient exposes, without HTTP —
     * and instrumented the same way, ON THE CLIENT, so a call-count assertion
     * measures round trips that happened rather than a tally someone kept.
     */
    client: (() => {
      const calls = [];
      return {
        calls,
        count: () => calls.length,
        reset: () => { calls.length = 0; },
        async call(op, args = {}) {
          if (typeof ledger[op] !== "function") throw new Error(`unknown op: ${op}`);
          calls.push(op);
          return op === "spent" ? ledger.spent(args.day) : ledger[op](args);
        },
      };
    })(),
    row: (uid, fixtureId) =>
      db.prepare("SELECT * FROM delivery WHERE uid=? AND fixture_id=?").get(uid, fixtureId),
    drops: () => db.prepare("SELECT * FROM dropped_log ORDER BY fixture, reason").all(),
  };
}

/**
 * A KV shim that counts every operation and PAGINATES for real.
 *
 * The pagination matters as much as the counting: a shim that returns
 * everything in one page cannot tell a resumable scan from one that silently
 * restarts, and cannot prove a cursor is honoured at all.
 */
export function kvShim(seed = {}, { pageSize = 1000 } = {}) {
  const { __meta: seededMeta = {}, ...rest } = seed;
  const store = new Map(Object.entries(rest).map(([k, v]) => [k, JSON.stringify(v)]));
  const meta = new Map(Object.entries(seededMeta));
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  // Sorting the whole key space on every list turns a resumable scan of twenty
  // thousand keys into a quadratic one, which is a property of the shim and not
  // of the code under test. Cached, invalidated on any mutation.
  let sorted = null;
  let sortedSize = -1;
  const invalidate = () => { sorted = null; };
  const keysInOrder = () => {
    // Validated against the store's size, so a test that writes through
    // `store.set` directly — as several do — is still seen by list().
    if (!sorted || sortedSize !== store.size) {
      sorted = [...store.keys()].sort();
      sortedSize = store.size;
    }
    return sorted;
  };
  return {
    counts,
    store,
    meta,
    async get(key, type) {
      counts.get++;
      const raw = store.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      counts.put++;
      if (!store.has(key)) invalidate();
      store.set(key, value);
      if (options?.metadata) meta.set(key, options.metadata);
      else meta.delete(key);
    },
    async delete(key) { counts.delete++; store.delete(key); meta.delete(key); invalidate(); },
    setMeta(key, metadata) { meta.set(key, metadata); },
    async list({ prefix = "", cursor, limit = pageSize } = {}) {
      counts.list++;
      const all = keysInOrder();
      // Binary-search the prefix range rather than filtering the whole space.
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (all[mid] < prefix) lo = mid + 1; else hi = mid;
      }
      const names = [];
      for (let i = lo; i < all.length && all[i].startsWith(prefix); i++) names.push(all[i]);
      // The cursor is the last key returned, so a resumed scan continues from
      // after it rather than from the top.
      const start = cursor ? names.findIndex((n) => n > cursor) : 0;
      const from = start < 0 ? names.length : start;
      const slice = names.slice(from, from + limit);
      const last = slice[slice.length - 1];
      const complete = from + slice.length >= names.length;
      return {
        keys: slice.map((name) => ({ name, metadata: meta.get(name) })),
        list_complete: complete,
        cursor: complete ? undefined : last,
      };
    },
  };
}

/** The deps object worker.js builds, over the shims. */
export function harnessDeps({ kv, client, now, sends, sendResult = () => ({ ok: true, status: 200 }) }) {
  const kvGet = (key) => kv.get(key, "json");
  return {
    now: () => now(),
    ledger: () => client,
    sendPush: async (token, payload, _env, options) => {
      sends.push({ token, payload, options });
      return sendResult(token, payload, options);
    },
    leaguesForFixture: async (fixtureId) => {
      const prefix = `slatefx:${fixtureId}:`;
      const found = [];
      let cursor;
      for (;;) {
        const page = await kv.list({ prefix, cursor });
        for (const key of page.keys) {
          const period = key.metadata?.period;
          if (period == null) continue;
          found.push({ code: key.name.slice(prefix.length), period: String(period) });
        }
        if (page.list_complete) break;
        cursor = page.cursor;
      }
      return found.sort((a, b) => a.code.localeCompare(b.code));
    },
    readPicks: async (fixtureId) => (await kvGet(`picks:${fixtureId}`)) || {},
    readSlate: (code, period) => kvGet(`custom_slate:${code}:${period}`),
    readPush: (uid) => kvGet(`push:${uid}`),
    dropPushToken: (uid) => kv.delete(`push:${uid}`),
    isMember: async (code, uid) => !!(await kvGet(`member:${code}:${uid}`)),
    membershipGraph: async () => {
      const graph = new Map();
      let cursor;
      let pages = 0;
      for (;;) {
        const page = await kv.list({ prefix: "member:", cursor });
        pages++;
        for (const key of page.keys) {
          const rest = key.name.slice("member:".length);
          const split = rest.indexOf(":");
          if (split < 0) continue;
          const code = rest.slice(0, split);
          if (!graph.has(code)) graph.set(code, []);
          graph.get(code).push(rest.slice(split + 1));
        }
        if (page.list_complete) break;
        cursor = page.cursor;
      }
      return { graph, pages };
    },
  };
}

/** A league of `size` members, published on `fixtureIds`, ready to notify. */
export function seedLeague(seed, { code, size, fixtureIds, period = "7", offset = 0 }) {
  seed[`league:${code}`] = { code, name: `League ${code}` };
  seed[`custom_slate:${code}:${period}`] = { status: "published", fixtureIds, periodKey: period };
  for (const id of fixtureIds) {
    seed[`slatefx:${id}:${code}`] = { period };
    (seed.__meta ||= {})[`slatefx:${id}:${code}`] = { period };
  }
  for (let i = 0; i < size; i++) {
    const uid = `prem_u${String(offset + i).padStart(5, "0")}`;
    seed[`member:${code}:${uid}`] = { nick: uid, since: 0 };
    seed[`push:${uid}`] = { token: `tok-${uid}`, platform: "ios", mute: [] };
  }
  return seed;
}

export const fixture = (id, startAt) => ({
  id, player1: `Home ${id}`, player2: `Away ${id}`, startAt, matchday: 7,
});

/** A job as the planner builds it, for tests that drive the consumer directly. */
export const job = (triples) => ({ v: 1, triples });

export const triple = ({ uid, fixtureId, league, kickoffAt, competition = "PL", period = "7" }) => ({
  uid, fixtureId, league, kickoffAt, competition, period,
  match: { id: fixtureId, player1: `Home ${fixtureId}`, player2: `Away ${fixtureId}`,
    startAt: new Date(kickoffAt).toISOString() },
});
