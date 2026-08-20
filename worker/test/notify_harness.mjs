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

/** A KV shim that counts every operation, so read claims can be asserted. */
export function kvShim(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    counts,
    store,
    async get(key, type) {
      counts.get++;
      const raw = store.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) { counts.put++; store.set(key, value); },
    async delete(key) { counts.delete++; store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      counts.list++;
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: names.map((name) => ({ name })), list_complete: true, cursor };
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
      const page = await kv.list({ prefix });
      return page.keys.map((k) => k.name.slice(prefix.length)).sort();
    },
    readPicks: async (fixtureId) => (await kvGet(`picks:${fixtureId}`)) || {},
    readSlate: (code, period) => kvGet(`custom_slate:${code}:${period}`),
    readPush: (uid) => kvGet(`push:${uid}`),
    dropPushToken: (uid) => kv.delete(`push:${uid}`),
    isMember: async (code, uid) => !!(await kvGet(`member:${code}:${uid}`)),
    periodsForFixture: async (fixtureId, codes) => {
      const out = new Map();
      for (const code of codes) {
        const hint = await kvGet(`slatefx:${fixtureId}:${code}`);
        if (hint?.period != null) out.set(code, String(hint.period));
      }
      return out;
    },
    membersByLeague: async (codes) => {
      const out = new Map();
      for (const code of codes) {
        const page = await kv.list({ prefix: `member:${code}:` });
        out.set(code, page.keys.map((k) => k.name.slice(`member:${code}:`.length)));
      }
      return out;
    },
  };
}

/** A league of `size` members, published on `fixtureIds`, ready to notify. */
export function seedLeague(seed, { code, size, fixtureIds, period = "7", offset = 0 }) {
  seed[`league:${code}`] = { code, name: `League ${code}` };
  seed[`custom_slate:${code}:${period}`] = { status: "published", fixtureIds, periodKey: period };
  for (const id of fixtureIds) seed[`slatefx:${id}:${code}`] = { period };
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
