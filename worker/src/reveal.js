/**
 * v1.9 Slice 2 — the RevealSlot Durable Object and the copy for the two new
 * alerts it guards: "mates' picks revealed" (one per kick-off slot) and
 * "matchday results" (one per UK calendar day).
 *
 * One instance per slot (`slot:<slotMs>`) and one per UK day (`day:<ukDate>`),
 * so every slot owns its own alarm and its own idempotency claims. Nothing here
 * reads KV: the work an alarm does — confirming the lock against the live feed
 * and the slates, then fanning out — lives in worker.js, and reaches this class
 * through `RevealSlot.handlers`, which worker.js installs when it loads. Same
 * script, same isolate, so in production the handler is always there; when it
 * is not (a test that never imported worker.js) an alarm does nothing at all.
 *
 * States of a slot, in order:
 *   armed        planned by the cron; alarm set for slotMs + 75 s
 *   sealed       the server confirmed the lock; /reveal-slot may now answer
 *   fanned       alerts enqueued
 *   unconfirmed  a read failed or nothing could be confirmed — never sends
 *   expired      the alarm fired past slotMs + 10 min — never sends
 */

/** Alarm offset after the lock: "1–2 minutes after the server confirms lock". */
export const CONFIRM_AFTER_MS = 75_000;
/** Past this, a slot sends nothing: a missed alert beats a stale one. */
export const SEND_WINDOW_MS = 10 * 60 * 1000;
/** APNs expiry for a reveal alert, from the moment of sealing. */
export const REVEAL_EXPIRY_MS = 20 * 60 * 1000;
/** The planner arms slots whose lock is this close. Two cron passes see each. */
export const PLAN_AHEAD_MS = 30 * 60 * 1000;
/** A claim held by a consumer that died is reclaimable after this. */
export const CLAIM_LEASE_MS = 120_000;
/** Recipients per queue message — the same bound the reminder jobs use. */
export const ALERT_JOB_SIZE = 45;
/** A day's results alert is dropped after 23:59 UK on that day plus two hours. */
export const RESULTS_GRACE_MS = 2 * 60 * 60 * 1000;
/** And it never lingers on Apple's side longer than this either. */
export const RESULTS_EXPIRY_MS = 2 * 60 * 60 * 1000;

export const ALERT_PAYLOAD_VERSION = 2;

export const slotName = (slotMs) => `slot:${Number(slotMs)}`;
export const dayName = (ukDate) => `day:${ukDate}`;
export const revealKey = (uid, slotMs) => `rv:${uid}:${Number(slotMs)}`;
export const resultsAlertKey = (uid, ukDate) => `mr:${uid}:${ukDate}`;
export const revealCollapseId = (slotMs) => `po-rv-${Number(slotMs)}`;
export const resultsCollapseId = (ukDate) => `po-mr-${ukDate}`;

// --- UK calendar ------------------------------------------------------------

const UK = "Europe/London";

/** "YYYY-MM-DD" for the UK calendar day an instant falls on. */
export function ukDate(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: UK, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** London's offset from UTC at an instant, in ms (0 or 3,600,000). */
function ukOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (type) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant UK midnight begins on a "YYYY-MM-DD" date. DST-aware. */
export function ukMidnightMs(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - ukOffsetMs(guess - 3 * 3600_000);
}

/** The UK date one day before. */
export function previousUkDate(date) {
  return ukDate(ukMidnightMs(date) - 3600_000);
}

/** When a day's results alert stops being worth sending: 23:59 UK + 2 h. */
export function resultsDeadlineMs(date) {
  const nextDay = ukDate(ukMidnightMs(date) + 26 * 3600_000);
  return ukMidnightMs(nextDay) - 60_000 + RESULTS_GRACE_MS;
}

/** "Saturday" for a UK date. */
export function ukWeekday(date) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: UK })
    .format(new Date(ukMidnightMs(date) + 12 * 3600_000));
}

// --- Copy -------------------------------------------------------------------
//
// Lock-screen rule (D2, restated for 1.9): never a league name, never a mate's
// name, never a pick. The reveal alert says nothing but how many matches
// locked; the results alert carries the player's OWN points (approved by Adam,
// 26 Nov) and nothing about anybody else.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function revealPayload({ slotMs, fixtures }) {
  return {
    aps: {
      alert: {
        title: `${plural(fixtures, "match", "matches")} kicked off`,
        body: "Picks are locked. See what your mates went for.",
      },
      sound: "default",
    },
    po: { v: ALERT_PAYLOAD_VERSION, k: "reveal", t: Number(slotMs) },
  };
}

export function resultsPayload({ date, pts, matches, weekLabel = null }) {
  const body = weekLabel
    ? `You scored +${pts} today — and ${weekLabel} is complete. See everyone's picks, points and the tables.`
    : `You scored +${pts} from ${plural(matches, "match", "matches")}. See everyone's picks and points.`;
  return {
    aps: { alert: { title: `${ukWeekday(date)}'s results are in`, body }, sound: "default" },
    po: { v: ALERT_PAYLOAD_VERSION, k: "results", d: String(date) },
  };
}

/** Pack recipients into queue messages of at most ALERT_JOB_SIZE. */
export function packAlertJobs(base, recipients, size = ALERT_JOB_SIZE) {
  const jobs = [];
  for (let i = 0; i < recipients.length; i += size) {
    jobs.push({ ...base, recipients: recipients.slice(i, i + size) });
  }
  return jobs;
}

// --- The Durable Object -----------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  slot_ms    INTEGER,
  state      TEXT    NOT NULL,
  fixtures   TEXT    NOT NULL DEFAULT '[]',
  pairs      TEXT,
  sealed_at  INTEGER,
  reason     TEXT,
  settled    INTEGER
);
CREATE TABLE IF NOT EXISTS claim (
  key        TEXT    PRIMARY KEY,
  state      TEXT    NOT NULL,
  gen        INTEGER NOT NULL DEFAULT 1,
  until      INTEGER,
  sent_at    INTEGER,
  reason     TEXT
);
`;

export class RevealSlot {
  /**
   * Installed by worker.js: { confirm(env, slot, now) -> {pairs} | throws,
   * fanOut(env, seal, now) }. Kept off the instance so the class stays free of
   * KV and can be driven over real SQLite in tests.
   */
  static handlers = null;

  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  #rows(query, ...binds) { return this.sql.exec(query, ...binds).toArray(); }

  #tx(fn) {
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(fn) : fn();
  }

  #slot() {
    const row = this.#rows("SELECT * FROM slot WHERE id = 1")[0];
    if (!row) return null;
    return {
      slotMs: row.slot_ms,
      state: row.state,
      fixtures: JSON.parse(row.fixtures || "[]"),
      pairs: row.pairs ? JSON.parse(row.pairs) : null,
      sealedAt: row.sealed_at,
      reason: row.reason,
      settled: row.settled,
    };
  }

  #setState(state, extra = {}) {
    this.sql.exec(
      "UPDATE slot SET state = ?1, reason = COALESCE(?2, reason), pairs = COALESCE(?3, pairs), sealed_at = COALESCE(?4, sealed_at) WHERE id = 1",
      state, extra.reason ?? null, extra.pairs ? JSON.stringify(extra.pairs) : null, extra.sealedAt ?? null,
    );
  }

  /**
   * The planner's call. Idempotent: the same slot armed twice is one alarm,
   * and a fixture seen on the second pass is folded into the first.
   */
  async arm({ slotMs, fixtureIds }) {
    const ids = (fixtureIds || []).map(String);
    const current = this.#slot();
    if (current && current.state !== "armed") return { state: current.state, armed: false };
    const fixtures = [...new Set([...(current?.fixtures || []), ...ids])].sort();
    if (!current) {
      this.sql.exec("INSERT INTO slot (id, slot_ms, state, fixtures) VALUES (1, ?1, 'armed', ?2)",
        Number(slotMs), JSON.stringify(fixtures));
    } else {
      this.sql.exec("UPDATE slot SET fixtures = ?1 WHERE id = 1", JSON.stringify(fixtures));
    }
    const at = Number(slotMs) + CONFIRM_AFTER_MS;
    const existing = await this.ctx.storage.getAlarm?.();
    if (existing == null || existing !== at) await this.ctx.storage.setAlarm?.(at);
    return { state: "armed", armed: true, fixtures, alarmAt: at };
  }

  /**
   * The alarm: confirm, then seal, then fan out. Every failure is silence.
   */
  async alarm() {
    const handlers = RevealSlot.handlers;
    const slot = this.#slot();
    if (!handlers || !slot) return;
    const now = handlers.now ? handlers.now() : Date.now();
    if (slot.state === "armed") {
      if (now > slot.slotMs + SEND_WINDOW_MS) { this.#setState("expired", { reason: "past-window" }); return; }
      if (now < slot.slotMs) {
        // (a) The server's own clock has not reached the lock. Come back.
        await this.ctx.storage.setAlarm?.(slot.slotMs + CONFIRM_AFTER_MS);
        return;
      }
      let confirmed;
      try {
        confirmed = await handlers.confirm(this.env, slot, now);
      } catch (error) {
        this.#setState("unconfirmed", { reason: `read-failed: ${String(error?.message || error).slice(0, 120)}` });
        return;
      }
      if (!confirmed?.pairs?.length) {
        this.#setState("unconfirmed", { reason: confirmed?.reason || "nothing-confirmed" });
        return;
      }
      this.#setState("sealed", { pairs: confirmed.pairs, sealedAt: now });
    }
    const sealed = this.#slot();
    if (sealed.state !== "sealed") return;
    if (now > sealed.slotMs + SEND_WINDOW_MS) { this.#setState("fanned", { reason: "past-window" }); return; }
    // A throw here leaves the slot sealed, so the platform's alarm retry
    // fans out again — claims make a second enqueue harmless.
    await handlers.fanOut(this.env, {
      slotMs: sealed.slotMs, pairs: sealed.pairs, sealedAt: sealed.sealedAt,
    }, now);
    this.#setState("fanned");
  }

  /** The seal, or null. /reveal-slot reads only this. */
  seal() {
    const slot = this.#slot();
    if (!slot || !["sealed", "fanned"].includes(slot.state)) return { sealed: false };
    return { sealed: true, slotMs: slot.slotMs, pairs: slot.pairs, sealedAt: slot.sealedAt };
  }

  status() { return this.#slot(); }

  /**
   * A day instance remembers how many of the day's fixtures were settled the
   * last time it looked, so an idle tick costs one call and no member reads.
   */
  dayCheck({ settled }) {
    const row = this.#slot();
    return { changed: !row || row.settled !== Number(settled) };
  }

  /** Written only after a scan completed, so a scan that threw is retried next tick. */
  daySeen({ settled }) {
    return this.#tx(() => {
      if (!this.#slot()) this.sql.exec("INSERT INTO slot (id, state, settled) VALUES (1, 'day', ?1)", Number(settled));
      else this.sql.exec("UPDATE slot SET settled = ?1 WHERE id = 1", Number(settled));
      return { ok: true };
    });
  }

  /** Keys not already sent or dropped — so the planner skips settled work. */
  pending({ keys }) {
    return (keys || []).filter((key) => {
      const row = this.#rows("SELECT state FROM claim WHERE key = ?1", key)[0];
      return !(row && (row.state === "sent" || row.state === "dropped"));
    });
  }

  /**
   * Claim keys for one delivery. A key already sent or dropped is never
   * granted again; a key under another consumer's live lease is `held`.
   */
  claim({ keys, now }) {
    return this.#tx(() => {
      const granted = [];
      const held = [];
      for (const key of keys || []) {
        const row = this.#rows("SELECT * FROM claim WHERE key = ?1", key)[0];
        if (!row) {
          this.sql.exec("INSERT INTO claim (key, state, gen, until) VALUES (?1, 'claimed', 1, ?2)",
            key, now + CLAIM_LEASE_MS);
          granted.push({ key, gen: 1 });
          continue;
        }
        if (row.state === "sent" || row.state === "dropped") continue;
        if (row.state === "claimed" && row.until > now) { held.push(key); continue; }
        const gen = row.gen + 1;
        this.sql.exec("UPDATE claim SET state = 'claimed', gen = ?2, until = ?3 WHERE key = ?1",
          key, gen, now + CLAIM_LEASE_MS);
        granted.push({ key, gen });
      }
      return { granted, held };
    });
  }

  /** Outcomes, fenced on the generation the claim granted. */
  record({ outcomes, now }) {
    return this.#tx(() => {
      let applied = 0;
      for (const o of outcomes || []) {
        const state = o.result === "sent" ? "sent" : o.result === "dropped" ? "dropped" : "failed";
        const info = this.sql.exec(
          "UPDATE claim SET state = ?2, sent_at = CASE WHEN ?2 = 'sent' THEN ?4 ELSE sent_at END, reason = ?5, until = NULL WHERE key = ?1 AND gen = ?3",
          o.key, state, o.gen, now, o.reason ?? null,
        );
        applied += info.rowsWritten ?? 0;
      }
      return { applied };
    });
  }

  claims() { return this.#rows("SELECT * FROM claim ORDER BY key"); }

  async fetch(request) {
    const { op, ...args } = await request.json();
    const handlers = {
      arm: () => this.arm(args),
      seal: () => this.seal(),
      status: () => this.status(),
      dayCheck: () => this.dayCheck(args),
      daySeen: () => this.daySeen(args),
      pending: () => this.pending(args),
      claim: () => this.claim(args),
      record: () => this.record(args),
    };
    const handler = handlers[op];
    if (!handler) return new Response(JSON.stringify({ error: `unknown op: ${op}` }), { status: 400 });
    return new Response(JSON.stringify(await handler()), { headers: { "content-type": "application/json" } });
  }
}
