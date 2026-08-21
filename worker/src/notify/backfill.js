/**
 * The slate-index backfill and self-heal.
 *
 * `slatefx:` keys are written by the publish and amend paths, which means every
 * slate published BEFORE this code existed has no reverse-index entry at all.
 * Those leagues would simply receive no reminders the moment the bindings were
 * enabled — silently, because an empty index is indistinguishable from a league
 * with nothing due. publishSlate() cannot repair them either: it returns early
 * on an already-published slate, which is exactly the case that needs repairing.
 *
 * So the index needs one deliberate reconciliation before it can be trusted,
 * and a way to prove it worked. This module is that, and it is NOT wired to run
 * automatically: it is invoked, once, behind the admin secret, and its verify
 * pass is the ship gate in front of enabling NOTIFY_QUEUE and NOTIFY_LEDGER.
 *
 * Two directions, because they catch different failures:
 *
 *   forward   every published slate fixture should have an index key
 *             -> catches slates published before this code, and a slate write
 *                that succeeded while its index write did not
 *   reverse   every index key should name a fixture its league still publishes
 *             -> catches amendments and deletions that removed a fixture while
 *                the index write failed, which would keep offering dead work
 */

const SLATE_PREFIX = "custom_slate:";
const INDEX_PREFIX = "slatefx:";

/** Default page size. Bounded so one invocation cannot run away. */
export const DEFAULT_LIMIT = 200;

const slateIndexKey = (fixtureId, code) => `${INDEX_PREFIX}${fixtureId}:${code}`;

/** A single key's list metadata. KV exposes it only through list. */
async function indexMetadata(env, key) {
  const page = await env.KV.list({ prefix: key, limit: 1 });
  return page.keys.find((k) => k.name === key)?.metadata ?? null;
}

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

/**
 * One bounded page of either direction.
 *
 * Returns the work it found and, when `apply` is set, the work it did. The
 * cursor is KV's own, so a resumed run continues rather than restarting — a
 * full scan of a large key space is not something to redo from the top because
 * an invocation ran out of time.
 */
export async function scanPage(env, {
  direction = "forward", cursor, limit = DEFAULT_LIMIT, apply = false,
} = {}) {
  const prefix = direction === "forward" ? SLATE_PREFIX : INDEX_PREFIX;
  const page = await env.KV.list({ prefix, cursor, limit });
  const found = { scanned: 0, ok: 0, missing: 0, stale: 0, repaired: 0, removed: 0, orphaned: 0 };
  const detail = [];

  for (const key of page.keys) {
    found.scanned++;
    if (direction === "forward") {
      const parsed = parseSlateKey(key.name);
      if (!parsed) continue;
      const slate = await env.KV.get(key.name, "json");
      // Drafts are the host's working copy and were never published, so they
      // must not appear in an index that means "this league is asking for it".
      if (slate?.status !== "published") continue;
      // The LEAGUE RECORD is the authority, not the slate that outlived it. A
      // half-finished deletion can leave a published slate behind; indexing it
      // would resurrect a league nobody plays into the notification path.
      const league = await env.KV.get(`league:${parsed.code}`, "json");
      if (!league) { found.orphaned++; continue; }
      for (const id of slate.fixtureIds || []) {
        const indexKey = slateIndexKey(String(id), parsed.code);
        const existing = await env.KV.get(indexKey, "json");
        const meta = await indexMetadata(env, indexKey);
        // Both must be right: the hot path reads the METADATA, so a key whose
        // value is correct but whose metadata is missing is still invisible.
        if (existing?.period === String(parsed.period) && meta?.period === String(parsed.period)) {
          found.ok++;
          continue;
        }
        found.missing++;
        detail.push({ key: indexKey, action: "write", period: String(parsed.period) });
        if (apply) {
          await env.KV.put(indexKey, JSON.stringify({ period: String(parsed.period) }),
            { metadata: { period: String(parsed.period) } });
          found.repaired++;
        }
      }
    } else {
      const parsed = parseIndexKey(key.name);
      if (!parsed) continue;
      const hint = await env.KV.get(key.name, "json");
      const league = await env.KV.get(`league:${parsed.code}`, "json");
      const slate = hint?.period == null
        ? null
        : await env.KV.get(`${SLATE_PREFIX}${parsed.code}:${hint.period}`, "json");
      // A key whose league record is gone is stale even if its slate survived.
      const listed = !!league
        && slate?.status === "published"
        && (slate.fixtureIds || []).map(String).includes(String(parsed.fixtureId))
        && key.metadata?.period === String(hint.period);
      if (listed) { found.ok++; continue; }
      found.stale++;
      detail.push({ key: key.name, action: "delete" });
      if (apply) { await env.KV.delete(key.name); found.removed++; }
    }
  }

  return {
    direction,
    ...found,
    detail: detail.slice(0, 50),          // bounded: a report, not a dump
    cursor: page.list_complete ? null : page.cursor,
    done: !!page.list_complete,
  };
}

/**
 * Run a direction to completion, a page at a time.
 *
 * `maxPages` keeps a single invocation bounded; the returned cursor lets the
 * next one carry on. Running it twice is safe and is the point: the second run
 * of a healthy index writes nothing and reports zero missing and zero stale,
 * which is the only evidence that the first one finished the job.
 */
export async function runDirection(env, {
  direction = "forward", cursor = undefined, limit = DEFAULT_LIMIT, apply = false, maxPages = 25,
} = {}) {
  const total = {
    direction, scanned: 0, ok: 0, missing: 0, stale: 0, repaired: 0, removed: 0, orphaned: 0,
    fromStart: cursor === undefined || cursor === null,
  };
  let next = cursor;
  let pages = 0;
  let done = false;
  while (pages < maxPages) {
    const page = await scanPage(env, { direction, cursor: next, limit, apply });
    for (const field of ["scanned", "ok", "missing", "stale", "repaired", "removed", "orphaned"]) {
      total[field] += page[field];
    }
    pages++;
    next = page.cursor;
    done = page.done;
    if (done) break;
  }
  return { ...total, pages, cursor: next, done };
}

/**
 * The ship gate.
 *
 * Verification only: it writes nothing. The index is fit to enable bindings
 * against when both directions complete with nothing missing and nothing stale.
 * Anything else means some league would silently receive no reminders, or the
 * planner would keep offering fixtures nobody is being asked to predict.
 */
export async function verify(env, options = {}) {
  // Two prefixes, two independent cursors. One cursor cannot resume the other:
  // a position in `custom_slate:` means nothing in `slatefx:`.
  const { forwardCursor, reverseCursor, ...shared } = options;
  const forward = await runDirection(env,
    { ...shared, direction: "forward", cursor: forwardCursor, apply: false });
  const reverse = await runDirection(env,
    { ...shared, direction: "reverse", cursor: reverseCursor, apply: false });

  const complete = forward.done && reverse.done;
  const fromStart = forward.fromStart && reverse.fromStart;
  const clean = forward.missing === 0 && reverse.stale === 0 && forward.orphaned === 0;

  /**
   * `ready` requires a FRESH COMPLETE scan of both prefixes.
   *
   * A resumed scan can only speak for the suffix it saw. Without this, a run
   * started from a cursor could walk a clean tail and report the index fit to
   * ship while missing keys sat in front of it — the one failure mode this
   * whole gate exists to prevent.
   */
  const ready = complete && fromStart && clean;
  const verdict = !fromStart
    ? "NOT A SHIP GATE — this scan resumed from a cursor and can only speak for the "
      + "suffix it saw; re-run from the start of both prefixes before deciding"
    : !complete
      ? "INCOMPLETE — the scan did not finish; resume from the cursors, then re-run from the start"
      : clean
        ? "READY — a complete scan from the start of both prefixes found every published "
          + "slate fixture indexed and no index key stale"
        : `NOT READY — ${forward.missing} missing, ${reverse.stale} stale, `
          + `${forward.orphaned} orphaned slate(s); repair, then verify again`;

  return { forward, reverse, complete, fromStart, clean, ready, verdict };
}

/**
 * Repair, then verify.
 *
 * Idempotent by construction: forward writes only what is absent or wrong, and
 * reverse deletes only what no published slate lists. A rerun after a clean run
 * changes nothing, and a rerun after a partial one continues from where the
 * cursor left off.
 */
export async function repair(env, options = {}) {
  const { forwardCursor, reverseCursor, ...shared } = options;
  const forward = await runDirection(env,
    { ...shared, direction: "forward", cursor: forwardCursor, apply: true });
  const reverse = await runDirection(env,
    { ...shared, direction: "reverse", cursor: reverseCursor, apply: true });
  // The verification after a repair always starts fresh: the point of it is to
  // speak for the whole index, not for the part this invocation happened to
  // touch. A repair that ran from a cursor still gets a full verdict.
  return {
    forward,
    reverse,
    resume: forward.done && reverse.done
      ? null
      : { forwardCursor: forward.cursor, reverseCursor: reverse.cursor },
    verified: await verify(env, shared),
  };
}
