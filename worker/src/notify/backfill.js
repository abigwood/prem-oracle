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
  // The key currently being worked on. The budget can run out on any operation,
  // including ones outside an inner try — without this the fallback resumes with
  // no key at all, which means starting the whole prefix again and never
  // finishing.
  let currentKey = null;

  const stop = (key, at) => { stopped = { cursor, key, offset: at }; };

  try {
    pages: for (;;) {
      const page = await kv.list({ prefix, cursor, limit: pageLimit });
      for (const key of page.keys) {
        currentKey = key.name;
        if (resumeAt) {
          if (key.name < resumeAt) continue;          // finished last time
          // The stored key may have been DELETED between invocations. If the
          // next key sorts after it, this is a different slate and the offset
          // belongs to a fixture list that is not this one — start it at zero
          // rather than skipping into the middle of it.
          if (key.name !== resumeAt) offset = 0;
          resumeAt = null;
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
    // Ran out somewhere without an inner handler — fetching a page, or reading
    // a slate or league record. Resume at the key it was on: re-reading it is
    // idempotent, and it is the only position that guarantees progress.
    if (!stopped) stopped = { cursor, key: currentKey, offset: 0 };
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

/**
 * The chain's own bookkeeping: one read at the start of a verify and one write
 * at the end, plus at most one delete when a repair invalidates it. They are
 * charged against the invocation ceiling like everything else, so the number in
 * the report is the whole invocation and not the scanning part of it.
 */
export const CHAIN_OPS_PER_VERIFY = 2;
export const CHAIN_OPS_PER_REPAIR = 1;

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

  // Split what is left AFTER the chain's own read and write, so the ceiling
  // covers the whole invocation rather than only its scanning.
  const scanBudget = Math.max(2, clampOps(options.maxOps) - CHAIN_OPS_PER_VERIFY);
  const perDirection = Math.max(2, Math.floor(scanBudget / 2));

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
  const ops = (chain.forward.ops ?? 0) + (chain.reverse.ops ?? 0) + CHAIN_OPS_PER_VERIFY;
  return {
    chain, forward: chain.forward, reverse: chain.reverse,
    ops, opsCap: clampOps(options.maxOps),
    ...chainVerdict(chain),
  };
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
  // Leave room for the chain invalidation this repair may have to perform.
  const scanBudget = Math.max(2, clampOps(options.maxOps) - CHAIN_OPS_PER_REPAIR);
  const perDirection = Math.max(2, Math.floor(scanBudget / 2));
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
    ops: forward.ops + reverse.ops + CHAIN_OPS_PER_REPAIR,
    opsCap: clampOps(options.maxOps),
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

// ---------------------------------------------------------------------------
// Orphan cleanup — narrow, allowlisted, manifested, and never automatic
// ---------------------------------------------------------------------------

/**
 * An orphan is a PUBLISHED slate whose `league:` record is gone. The forward
 * scan refuses to index one — correctly, because indexing it would resurrect a
 * league nobody plays — and `chainVerdict` refuses to report ready while one
 * exists. Between those two facts sits a state the operator cannot leave:
 * repair only COUNTS orphans, so "repair, then start a new chain" returns the
 * same verdict for ever.
 *
 * The way out is not to weaken the readiness rule, and not to let a scan delete
 * production data because one KV read could not see a league. It is to make the
 * deletion a separate, explicit, RECORDED act:
 *
 *   - it has its own action, so no repair or verify can reach it;
 *   - it deletes ONLY keys the operator listed by their exact full name;
 *   - it re-reads `league:<code>` immediately before every delete, so a league
 *     that has come back — or was never gone — is never destroyed on the
 *     strength of an earlier scan;
 *   - it writes a MANIFEST before it can delete anything, pinning the authorised
 *     list to a cleanup ID for every later invocation;
 *   - and it invalidates the verification chain before it can delete anything.
 *
 * The last two are orderings, not details.
 *
 * The manifest exists because a returned resume token only pins the allowlist
 * across a CLEAN return. A crash returns no token at all, so the retry was free
 * to present a longer list and have it honoured — the authorisation lived only
 * in the caller's hand, which is the one place a crash can empty. Now it lives
 * in KV under an operator-chosen ID, is written before any destruction, and is
 * kept after the run finishes so the same ID can never be reused for a wider
 * deletion.
 *
 * The chain invalidation is first for the same reason. Invalidating afterwards
 * left a window: a crash between a slate deletion and the invalidation strands a
 * chain that no longer describes the key space, and the retry finds the slate
 * already absent, so deletes nothing, so never invalidates. A stale `ready`
 * outlives the data it described.
 *
 * Everything it will not do is as important as what it will: a draft slate is
 * refused, because only a published one is counted as an orphan and only a
 * published one holds the gate shut.
 */

/** The allowlist is meant to be read by a person before it is sent. */
export const MAX_CLEANUP_KEYS = 50;

/** slate read, league recheck, delete. */
export const CLEANUP_OPS_PER_KEY = 3;
/** The one real KV delete that invalidates the chain. */
export const CHAIN_OPS_PER_CLEANUP = 1;
/** Manifest read, the pre-destruction write, and the progress write. */
export const MANIFEST_OPS = 3;
/**
 * The floor below which an invocation cannot do its bookkeeping AND one whole
 * key. A cap under this is refused rather than quietly raised, because raising
 * it would mean spending more operations than the figure we report.
 */
export const MIN_CLEANUP_OPS = MANIFEST_OPS + CHAIN_OPS_PER_CLEANUP + CLEANUP_OPS_PER_KEY;

const CLEANUP_PREFIX = "notify:cleanup:";
/** Constrained so an ID can never escape its own key space. */
const CLEANUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * THE AUTHORITY. Every cleanup this deployment is permitted to perform, by id,
 * with the exact keys it may delete.
 *
 * It is here rather than in KV because KV is eventually consistent and a read
 * that returns nothing is indistinguishable from a key that does not exist. A
 * retry routed to a location that has not yet seen the manifest would find no
 * record, and a design that treats an absent manifest as permission to create
 * one from the request would accept whatever list that request carried — which
 * is the widening a crash was supposed to make impossible.
 *
 * So the manifest is demoted to what it can be trusted for: progress,
 * idempotency and audit. What may be deleted is fixed at deploy time, and
 * authorising another cleanup means a reviewed code change and a deployment.
 */
export const AUTHORISED_CLEANUPS = Object.freeze({
  // v1.6.6 Phase B1. Two published slates left behind by an account deletion
  // that removed everything else: no league record, no members, no index keys.
  // They are the only thing holding the readiness gate shut.
  "v166-b1-orphans-20260821": Object.freeze([
    Object.freeze({ key: "custom_slate:CGALPR:1", code: "CGALPR" }),
    Object.freeze({ key: "custom_slate:XP926U:1", code: "XP926U" }),
  ]),
});

export const cleanupManifestKey = (id) => `${CLEANUP_PREFIX}${id}`;
export const readCleanupManifest = (env, id) => env.KV.get(cleanupManifestKey(id), "json");

/** A refusal of the WHOLE call: the request itself is not one we will act on. */
export class CleanupRefused extends Error {}

/**
 * One entry, normalised. A bare string is the key; the object form also names
 * the code, and the two must agree — which is the only way a typo in a
 * hand-written key is caught before it is acted on.
 */
function normalizeEntry(entry) {
  if (typeof entry === "string") return { key: entry, declared: null };
  if (entry && typeof entry === "object" && typeof entry.key === "string") {
    return { key: entry.key, declared: entry.code == null ? null : String(entry.code) };
  }
  return { key: null, declared: null };
}

/**
 * The identity of one entry: the exact key AND the code the operator declared
 * for it. Both, because a list that names the same keys under different codes
 * is a different authorisation.
 */
const entryIdentity = (entry, at) =>
  (entry.key == null ? `!malformed#${at}` : `${entry.key}|${entry.declared ?? ""}`);

/**
 * Sorted and de-duplicated, so the order a run works through is a property of
 * the SET and not of the order the operator happened to type it in — without
 * which a stored progress position means nothing.
 */
export function normalizeAllow(allow) {
  const list = Array.isArray(allow) ? allow : [];
  const seen = new Map();
  list.forEach((raw, at) => {
    const entry = normalizeEntry(raw);
    const id = entryIdentity(entry, at);
    if (!seen.has(id)) seen.set(id, { ...entry, id });
  });
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const sameIdentity = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((value, at) => value === b[at]);

/**
 * Delete allowlisted orphan slates. Bounded, resumable and idempotent.
 *
 * Idempotent because a key that is already gone is reported as `already_absent`
 * rather than deleted, so a retry — after a clean stop or after a crash —
 * deletes each authorised key at most once.
 */
export async function cleanupOrphans(
  env, { id, allow = [], maxOps } = {}, { table = AUTHORISED_CLEANUPS } = {},
) {
  // ---- authority is settled HERE, from code, before KV is touched at all ---
  // Everything in this block is free and refuses without reading or writing.
  const cleanupId = typeof id === "string" ? id.trim() : "";
  if (!CLEANUP_ID.test(cleanupId)) {
    throw new CleanupRefused(
      "a cleanup id is required, and must be 1-64 characters of [A-Za-z0-9._-]");
  }
  // hasOwn, not a plain lookup: "constructor" and "toString" are valid ids by
  // shape and would otherwise resolve to something on the prototype.
  if (!Object.hasOwn(table, cleanupId)) {
    throw new CleanupRefused(
      `cleanup id "${cleanupId}" is not authorised in this deployment; `
      + "authorising one is a reviewed code change");
  }
  const submitted = normalizeAllow(allow);
  if (!submitted.length) throw new CleanupRefused("the allowlist is empty");
  if (submitted.length > MAX_CLEANUP_KEYS) {
    throw new CleanupRefused(
      `allowlist has ${submitted.length} keys; the ceiling is ${MAX_CLEANUP_KEYS}`);
  }

  // The list that gets walked is the CODE list, never the request's. The
  // request still has to match it exactly — an operator who submits something
  // else is told so rather than quietly having it ignored.
  const entries = normalizeAllow(table[cleanupId]);
  const identity = entries.map((entry) => entry.id);
  if (!sameIdentity(submitted.map((entry) => entry.id), identity)) {
    throw new CleanupRefused(
      `the submitted allowlist does not match the ${identity.length} key(s) `
      + `authorised in code for "${cleanupId}"`);
  }

  const cap = clampOps(maxOps);
  if (cap < MIN_CLEANUP_OPS) {
    // Raising it silently is what let actual operations exceed the reported
    // cap. The cap we enforce and the cap we report are the same number.
    throw new CleanupRefused(
      `maxOps ${cap} is below the minimum of ${MIN_CLEANUP_OPS} for one key`);
  }
  const canonical = entries.map((entry) => ({ key: entry.key, code: entry.declared }));

  const budget = { ops: 0, max: cap };
  const kv = meter(env, budget);
  const manifestKey = cleanupManifestKey(cleanupId);

  // ---- the manifest is the authority, not the request ----------------------
  // ---- the manifest is progress, idempotency and audit. Not authority ------
  // An absent read is safe: KV is eventually consistent, so "no manifest" may
  // simply mean "not here yet". Starting over replays the SAME code-authorised
  // keys, and a key already deleted reports already_absent rather than being
  // deleted twice. A manifest that disagrees with the code is refused rather
  // than overwritten — it can only mean this deployment and the record were
  // written under different authority, and that is not ours to reconcile.
  const existing = await kv.get(manifestKey);
  if (existing && !sameIdentity(existing.identity, identity)) {
    throw new CleanupRefused(
      `the stored manifest for "${cleanupId}" records a different allowlist `
      + `(${existing.identity?.length ?? 0} keys, ${existing.status}); `
      + "refusing rather than overwriting it");
  }
  if (existing?.status === "complete") {
    // Terminal, and retained. Replaying it reads the record and does nothing
    // else — there is no deletion to perform and so nothing to invalidate.
    return {
      action: "cleanup-orphans",
      id: cleanupId,
      total: entries.length,
      at: existing.at,
      done: true,
      replay: true,
      status: "complete",
      deleted: 0,
      refused: 0,
      already_absent: 0,
      results: existing.results ?? [],
      chainInvalidated: false,
      ops: budget.ops,
      opsCap: cap,
      next: "This cleanup id is complete. Run verify with restart:true to begin a fresh chain.",
    };
  }

  const manifest = existing ?? {
    id: cleanupId,
    allow: canonical,
    identity,
    at: 0,
    status: "running",
    results: [],
    invocations: 0,
  };
  manifest.invocations = (manifest.invocations ?? 0) + 1;
  manifest.status = "running";

  // FIRST WRITE, before the chain and before any slate: from this point the
  // authorised list survives a crash, and a retry is bound to it.
  await kv.put(manifestKey, JSON.stringify(manifest));

  // THEN the chain, still before any slate can be deleted, and on every
  // invocation — including the retry after a crash, where the deletion has
  // already happened and there is nothing left to infer it from.
  await kv.del(CHAIN_KEY);

  let index = Number.isInteger(manifest.at) && manifest.at > 0
    ? Math.min(manifest.at, entries.length) : 0;
  const results = [];
  const refuse = (key, reason, code) => results.push({ key, code, outcome: "refused", reason });

  for (; index < entries.length; index++) {
    const entry = entries[index];

    // Shape first, because it costs nothing and a key we cannot parse is a key
    // we must not act on. Anything outside the slate prefix is refused here,
    // which is what keeps a `league:` or `slatefx:` name in the list inert.
    if (typeof entry.key !== "string" || !entry.key.startsWith(SLATE_PREFIX)) {
      refuse(entry.key ?? null, "malformed", null);
      continue;
    }
    const parsed = parseSlateKey(entry.key);
    if (!parsed?.code || !parsed.period) { refuse(entry.key, "malformed", null); continue; }
    if (entry.declared != null && entry.declared !== parsed.code) {
      refuse(entry.key, "mismatch", parsed.code);
      continue;
    }

    // From here the entry costs operations. Stop cleanly rather than starting
    // one we cannot finish — a half-checked key must never be deleted — and
    // keep back the progress write, without which the next invocation would
    // not know this one got here.
    if (budget.max - budget.ops < CLEANUP_OPS_PER_KEY + 1) break;

    const slate = await kv.get(entry.key);
    if (!slate) {
      results.push({ key: entry.key, code: parsed.code, outcome: "already_absent" });
      continue;
    }
    if (slate.status !== "published") { refuse(entry.key, "not_published", parsed.code); continue; }

    // The recheck, immediately before the delete. A scan minutes old is not
    // authority to destroy anything.
    const league = await kv.get(`league:${parsed.code}`);
    if (league) { refuse(entry.key, "league_exists", parsed.code); continue; }

    await kv.del(entry.key);
    results.push({
      key: entry.key, code: parsed.code, period: parsed.period, outcome: "deleted",
    });
  }

  const done = index >= entries.length;
  manifest.at = index;
  manifest.status = done ? "complete" : "running";
  manifest.results = [...(manifest.results ?? []), ...results];
  // The progress write. A crash before it costs only the pointer: the retry
  // re-walks from the last recorded position and finds the keys it already
  // deleted absent, which is why re-walking cannot delete anything twice.
  await kv.put(manifestKey, JSON.stringify(manifest));

  return {
    action: "cleanup-orphans",
    id: cleanupId,
    total: entries.length,
    at: index,
    done,
    replay: false,
    status: manifest.status,
    deleted: results.filter((r) => r.outcome === "deleted").length,
    refused: results.filter((r) => r.outcome === "refused").length,
    already_absent: results.filter((r) => r.outcome === "already_absent").length,
    results,
    manifest_results: manifest.results,
    // Always. Any cleanup ATTEMPT means the next verification has to be a fresh
    // one, whether or not this attempt found anything left to delete.
    chainInvalidated: true,
    ops: budget.ops,
    opsCap: cap,
    next: done
      ? "Cleanup complete. Run verify with restart:true to begin a fresh chain."
      : `Cleanup incomplete. Call again with id "${cleanupId}" and the SAME allowlist.`,
  };
}
