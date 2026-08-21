/**
 * The slate-index backfill and self-heal.
 *
 * `slatefx:` keys are written by the publish and amend paths, which means every
 * slate published BEFORE this code existed has no reverse-index entry at all.
 * Those leagues would simply receive no reminders the moment the bindings were
 * enabled — silently, because an empty index is indistinguishable from a league
 * with nothing due. publishSlate() cannot repair them either: it returns early
 * on an already-published slate, which is exactly the case needing repair.
 *
 * Two directions, because they catch different failures:
 *
 *   forward   every published slate fixture should have an index key
 *             -> catches slates published before this code, and a slate write
 *                that succeeded while its index write did not
 *   reverse   every index key should name a fixture its league still publishes
 *             -> catches amendments and deletions that removed a fixture while
 *                the index write failed, which would keep offering dead work
 *
 * Everything else here is about staying inside one invocation. Bounding list
 * PAGES bounds nothing useful: a single 200-key page of twenty-fixture slates
 * is thousands of KV operations. So the budget is counted in OPERATIONS, the
 * position can stop partway through a slate's fixture list, and a verification
 * needing more than one invocation resumes as a CHAIN rather than starting
 * over — which is the only way `ready` is reachable on a large key space.
 */

const SLATE_PREFIX = "custom_slate:";
const INDEX_PREFIX = "slatefx:";
const CHAIN_KEY = "notify:index_chain";

/**
 * Server constants. A caller may ask for less, never more: the ceiling exists
 * to keep one invocation inside the platform's subrequest limit, and a request
 * body is not allowed to raise it.
 */
export const MAX_OPS_PER_INVOCATION = 800;
export const MAX_LIST_LIMIT = 200;

export const clampLimit = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIST_LIMIT) : MAX_LIST_LIMIT;
};
export const clampOps = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), MAX_OPS_PER_INVOCATION)
    : MAX_OPS_PER_INVOCATION;
};

const slateIndexKey = (fixtureId, code) => `${INDEX_PREFIX}${fixtureId}:${code}`;

/** custom_slate:<code>:<period> — the code cannot contain a colon. */
export function parseSlateKey(name) {
  const rest = name.slice(SLATE_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 0) return null;
  return { code: rest.slice(0, split), period: rest.slice(split + 1) };
}

/** slatefx:<fixtureId>:<leagueCode> — the league code is the final segment. */
export function parseIndexKey(name) {
  const rest = name.slice(INDEX_PREFIX.length);
  const split = rest.lastIndexOf(":");
  if (split < 0) return null;
  return { fixtureId: rest.slice(0, split), code: rest.slice(split + 1) };
}

class BudgetExhausted extends Error {}

/** Every KV operation goes through here, so the budget cannot be bypassed. */
function meter(env, budget) {
  const spend = () => {
    if (budget.ops >= budget.max) throw new BudgetExhausted();
    budget.ops++;
  };
  return {
    async get(key) { spend(); return env.KV.get(key, "json"); },
    async put(key, value, options) { spend(); return env.KV.put(key, value, options); },
    async del(key) { spend(); return env.KV.delete(key); },
    async list(options) { spend(); return env.KV.list(options); },
    /**
     * One index key's period, from its list METADATA — which is what the hot
     * path actually reads, so a key with a correct value and no metadata is
     * still invisible and still needs repair. One operation, not two.
     */
    async indexPeriod(key) {
      spend();
      const page = await env.KV.list({ prefix: key, limit: 1 });
      return page.keys.find((k) => k.name === key)?.metadata?.period ?? null;
    },
  };
}

const emptyCounts = () => ({
  scanned: 0, ok: 0, missing: 0, stale: 0, repaired: 0, removed: 0, orphaned: 0,
});

const addCounts = (into, from) => {
  for (const field of Object.keys(emptyCounts())) into[field] += from[field] ?? 0;
  return into;
};

/**
 * One direction, run until the operation budget runs out or the prefix ends.
 *
 * `position` is `{ cursor, key, offset }`: the KV list cursor, the KEY that was
 * being processed when the budget ran out, and how far into that slate's fixture
 * list we got.
 *
 * All three are needed. The cursor only identifies a page, so resuming with the
 * cursor alone replays the whole page; the key says where in the page to pick
 * up; and the offset says where inside that slate — without which a
 * twenty-fixture slate could never be stopped partway, which at the product
 * maximum is exactly where an invocation runs out of room.
 */
export async function runDirection(env, {
  direction = "forward", position = null, limit, maxOps, apply = false,
} = {}) {
  const budget = { ops: 0, max: clampOps(maxOps) };
  const kv = meter(env, budget);
  const pageLimit = clampLimit(limit);
  const counts = emptyCounts();
  const prefix = direction === "forward" ? SLATE_PREFIX : INDEX_PREFIX;

  let cursor = position?.cursor ?? undefined;
  let offset = position?.offset ?? 0;
  // The key we were partway through. Everything before it in the resumed page
  // is already finished and must not be redone.
  let resumeAt = position?.key ?? null;
  let done = false;
  let stopped = null;

  const stop = (key, at) => { stopped = { cursor, key, offset: at }; };

  try {
    pages: for (;;) {
      const page = await kv.list({ prefix, cursor, limit: pageLimit });
      for (const key of page.keys) {
        if (resumeAt) {
          if (key.name < resumeAt) continue;          // finished last time
          resumeAt = null;                            // this is where we stopped
        } else {
          offset = 0;
        }
        if (direction === "forward") {
          const parsed = parseSlateKey(key.name);
          if (!parsed) { offset = 0; continue; }
          const slate = await kv.get(key.name);
          // Drafts are the host's working copy and were never published.
          if (slate?.status !== "published") { offset = 0; counts.scanned++; continue; }
          // The LEAGUE RECORD is the authority, not the slate that outlived it:
          // a half-finished deletion leaves a published slate behind, and
          // indexing it would resurrect a league nobody plays.
          const league = await kv.get(`league:${parsed.code}`);
          if (!league) { counts.orphaned++; offset = 0; counts.scanned++; continue; }

          const fixtures = slate.fixtureIds || [];
          for (let i = offset; i < fixtures.length; i++) {
            const indexKey = slateIndexKey(String(fixtures[i]), parsed.code);
            let period;
            try {
              period = await kv.indexPeriod(indexKey);
            } catch (error) {
              if (!(error instanceof BudgetExhausted)) throw error;
              // Stop HERE, partway through this slate, and say exactly where.
              stop(key.name, i);
              break pages;
            }
            if (period === String(parsed.period)) { counts.ok++; continue; }
            counts.missing++;
            if (!apply) continue;
            try {
              await kv.put(indexKey, JSON.stringify({ period: String(parsed.period) }),
                { metadata: { period: String(parsed.period) } });
              counts.repaired++;
            } catch (error) {
              if (!(error instanceof BudgetExhausted)) throw error;
              stop(key.name, i);
              break pages;
            }
          }
          counts.scanned++;
        } else {
          const parsed = parseIndexKey(key.name);
          if (!parsed) continue;
          try {
            const hint = await kv.get(key.name);
            const league = await kv.get(`league:${parsed.code}`);
            const slate = hint?.period == null
              ? null
              : await kv.get(`${SLATE_PREFIX}${parsed.code}:${hint.period}`);
            // A key whose league record is gone is stale even if its slate
            // survived, and metadata must match: the hot path reads metadata.
            const listed = !!league
              && slate?.status === "published"
              && (slate.fixtureIds || []).map(String).includes(String(parsed.fixtureId))
              && key.metadata?.period === String(hint.period);
            counts.scanned++;
            if (listed) { counts.ok++; continue; }
            counts.stale++;
            if (apply) { await kv.del(key.name); counts.removed++; }
          } catch (error) {
            if (!(error instanceof BudgetExhausted)) throw error;
            // The reverse direction has no inner list, so it resumes AT the
            // key it was on and re-examines it: reads are idempotent.
            stop(key.name, 0);
            break pages;
          }
        }
      }
      if (page.list_complete) { done = true; break; }
      cursor = page.cursor;
      offset = 0;
      resumeAt = null;
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    // Ran out fetching the next page: resume from the cursor, nothing part-done.
    if (!stopped) stopped = { cursor, key: null, offset: 0 };
  }

  return {
    direction,
    ...counts,
    ops: budget.ops,
    opsCap: budget.max,
    done,
    position: done ? null : (stopped ?? { cursor, key: null, offset: 0 }),
  };
}

// ---------------------------------------------------------------------------
// The verification chain
// ---------------------------------------------------------------------------

/**
 * A verification that spans invocations.
 *
 * One invocation cannot scan a large key space inside a safe operation budget,
 * and a scan that resumes from a cursor can only speak for the suffix it saw.
 * So the chain is persisted: it records that it STARTED AT THE BEGINNING of
 * both prefixes and accumulates as it goes. `ready` comes from the finished
 * chain, never from a single call.
 */
const freshChain = (startedAt) => ({
  startedAt,
  forward: { position: null, counts: emptyCounts(), done: false },
  reverse: { position: null, counts: emptyCounts(), done: false },
  invocations: 0,
});

export const readChain = (env) => env.KV.get(CHAIN_KEY, "json");
const writeChain = (env, chain) => env.KV.put(CHAIN_KEY, JSON.stringify(chain));

export function chainVerdict(chain) {
  const { forward, reverse } = chain;
  const complete = forward.done && reverse.done;
  const clean = forward.counts.missing === 0
    && reverse.counts.stale === 0
    && forward.counts.orphaned === 0;
  if (!complete) {
    return {
      complete, clean, ready: false,
      verdict: "IN PROGRESS — this chain started at the beginning of both prefixes and has "
        + "not finished; call verify again to continue it",
    };
  }
  return clean
    ? {
      complete, clean, ready: true,
      verdict: "READY — a complete chain from the start of both prefixes found every "
        + "published slate fixture indexed and no index key stale",
    }
    : {
      complete, clean, ready: false,
      verdict: `NOT READY — ${forward.counts.missing} missing, ${reverse.counts.stale} stale, `
        + `${forward.counts.orphaned} orphaned slate(s); repair, then start a new chain`,
    };
}

/**
 * Continue — or start — the verification chain. Read-only, and bounded.
 *
 * `restart: true` throws the old chain away and begins again, which is what a
 * repair requires: a chain that ran before a write cannot speak for what came
 * after it.
 */
export async function verify(env, { restart = false, at = 0, ...options } = {}) {
  const existing = restart ? null : await readChain(env);
  const chain = existing ?? freshChain(at);
  chain.invocations = (chain.invocations ?? 0) + 1;

  // Split the budget between the directions so one cannot starve the other.
  const perDirection = Math.max(2, Math.floor(clampOps(options.maxOps) / 2));

  for (const direction of ["forward", "reverse"]) {
    const leg = chain[direction];
    if (leg.done) continue;
    const run = await runDirection(env, {
      ...options, direction, position: leg.position, maxOps: perDirection, apply: false,
    });
    addCounts(leg.counts, run);
    leg.position = run.position;
    leg.done = run.done;
    leg.ops = run.ops;
  }

  await writeChain(env, chain);
  return { chain, forward: chain.forward, reverse: chain.reverse, ...chainVerdict(chain) };
}

/**
 * It does NOT verify afterwards. A fresh full verification is unbounded, and
 * running one automatically is precisely how a repair invocation would blow its
 * budget. It invalidates the chain instead, so the next verify starts a new
 * one — the only chain that can honestly speak for a repaired index.
 */
const finished = (direction) => ({
  direction, ...emptyCounts(), ops: 0, opsCap: 0, done: true, position: null,
});

/**
 * Repair, bounded by the same operation budget.
 *
 * A direction that has already finished is SKIPPED rather than restarted. A
 * null position means both "start from the beginning" and "nothing left to do",
 * so the two are told apart by an explicit done flag — without which a finished
 * forward pass restarts every invocation and the pair never completes together.
 */
export async function repair(env, {
  forward: fPos = null, reverse: rPos = null,
  forwardDone = false, reverseDone = false, ...options
} = {}) {
  const perDirection = Math.max(2, Math.floor(clampOps(options.maxOps) / 2));
  const forward = forwardDone
    ? finished("forward")
    : await runDirection(env,
      { ...options, direction: "forward", position: fPos, maxOps: perDirection, apply: true });
  const reverse = reverseDone
    ? finished("reverse")
    : await runDirection(env,
      { ...options, direction: "reverse", position: rPos, maxOps: perDirection, apply: true });

  // Any write makes every earlier verification stale.
  if (forward.repaired || reverse.removed) await env.KV.delete(CHAIN_KEY);

  const done = forward.done && reverse.done;
  return {
    forward,
    reverse,
    done,
    resume: done ? null : {
      forward: forward.position,
      reverse: reverse.position,
      forwardDone: forward.done,
      reverseDone: reverse.done,
    },
    next: done
      ? "Repair complete. Run verify with restart:true to begin a fresh chain."
      : "Repair incomplete. Call repair again with the resume positions.",
  };
}
