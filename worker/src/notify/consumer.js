/**
 * The queue consumer — one delivery of one reminder job.
 *
 * The ORDERING here is the specification, not a description of it. Each step
 * exists because the step before it would otherwise have spent something it
 * could not account for:
 *
 *   1. reserve the WORST-CASE KV-read allowance, before any KV read
 *   2. if refused, ack and drop TERMINALLY, having read nothing
 *   3. authoritative eligibility — token, mute, membership, pick, slate
 *   4. reserve the exact APNs attempt from the correct pool, before the fetch
 *   5. a failed fetch keeps its reservation: failures cost what they cost
 *   6. unused read allowance stays consumed; conservative beats optimistic
 *
 * Three Durable Object round trips for a working delivery, one for a refused
 * one, and never a fourth.
 */
import { utcDay } from "./ledger.js";
import { reminderPayload, collapseId, apnsExpiration } from "./copy.js";

/** Per-triple reads: push:<uid> and member:<code>:<uid>. */
export const KV_READS_PER_TRIPLE = 2;
/** Per-message reads: up to 3 picks: and up to 3 custom_slate:. */
export const KV_READS_FIXED = 6;

export const worstCaseReads = (count) => count * KV_READS_PER_TRIPLE + KV_READS_FIXED;

/**
 * Is this recipient still owed this reminder?
 *
 * Every value here is read at SEND time, not planning time. D2 requires the
 * re-check immediately before APNs precisely because the interesting failures
 * happen in between: a pick saved, a mute set, a member removed, a fixture
 * amended out of the slate.
 */
export async function stillEligible(deps, triple) {
  const { uid, fixtureId, league, competition } = triple;
  const push = await deps.readPush(uid);
  if (!push?.token) return { ok: false, reason: "no-token" };
  if (Array.isArray(push.mute) && push.mute.includes(competition)) return { ok: false, reason: "muted" };
  if (!(await deps.isMember(league, uid))) return { ok: false, reason: "not-member" };
  const picks = await deps.readPicks(fixtureId);
  if (picks && picks[uid]) return { ok: false, reason: "already-picked" };
  if (!(await deps.stillInSlate(league, fixtureId))) return { ok: false, reason: "amended-out" };
  return { ok: true, token: push.token };
}

/**
 * Deliver one job. Returns { ack } — false means the queue should redeliver.
 *
 * A triple held by another consumer's LIVE lease yields ack:false. Acking there
 * would silently lose that reminder, and the lease means it cannot be reclaimed
 * yet; RETRY_DELAY_S is longer than the lease, so the redelivery finds it gone.
 */
export async function deliverJob(job, env, deps) {
  const now = deps.now();
  const day = utcDay(now);
  const ledger = deps.ledger();
  const triples = job.triples || [];
  const stats = {
    attempted: 0, sent: 0, dropped: 0, deferred: 0, terminated: 0,
    reads: 0, doCalls: 0, pools: { apns_initial: 0, apns_retry: 0 },
  };
  if (!triples.length) return { ack: true, stats };

  // 1. Worst-case read allowance for the whole message, before touching KV.
  //    2. A refusal is made TERMINAL inside that same transaction, so the work
  //    genuinely stops rather than being reported as stopped and replanned.
  const reserve = await ledger.call("reserveReadsOrTerminate", {
    day, want: worstCaseReads(triples.length), now,
    triples: triples.map((t) => ({
      uid: t.uid, fixtureId: t.fixtureId, league: t.league, kickoffAt: t.kickoffAt,
    })),
  });
  stats.doCalls++;
  if (reserve.refused) {
    stats.dropped = reserve.dropped;
    stats.terminated = reserve.dropped;
    return { ack: true, stats };
  }
  stats.reads = reserve.granted;                       // 6. consumed either way

  const claimed = await ledger.call("claim", {
    now,
    triples: triples.map((t) => ({
      uid: t.uid, fixtureId: t.fixtureId, league: t.league, kickoffAt: t.kickoffAt,
    })),
  });
  const owned = new Map(claimed.map((row) => [`${row.uid}|${row.fixture_id}`, row]));

  let ack = true;
  const unclaimed = triples.filter((t) => !owned.has(`${t.uid}|${t.fixtureId}`));
  for (const t of unclaimed) {
    const how = await ledger.call("disposition", { uid: t.uid, fixtureId: t.fixtureId, now });
    if (how === "retry") { stats.deferred++; ack = false; }
  }

  // 3. Authoritative eligibility, on reads already paid for.
  const eligible = [];
  const outcomes = [];
  for (const t of triples) {
    const row = owned.get(`${t.uid}|${t.fixtureId}`);
    if (!row) continue;
    if (now >= t.kickoffAt) {
      outcomes.push({ ...t, gen: row.claim_gen, result: "dropped", reason: "past-kickoff" });
      stats.dropped++;
      continue;
    }
    const check = await stillEligible(deps, t);
    if (!check.ok) {
      outcomes.push({ ...t, gen: row.claim_gen, result: "dropped", reason: check.reason });
      stats.dropped++;
      continue;
    }
    eligible.push({ ...t, gen: row.claim_gen, token: check.token });
  }

  // 4. The exact attempts: one fenced atomic step that verifies each fence,
  //    picks the pool from the row's own history, reserves and marks.
  let grants = [];
  if (eligible.length) {
    grants = await ledger.call("grantAttempts", {
      day,
      grants: eligible.map((t) => ({ uid: t.uid, fixtureId: t.fixtureId, gen: t.gen })),
    });
    stats.doCalls++;
  }
  const granted = new Map(grants.map((g) => [`${g.uid}|${g.fixtureId}`, g]));

  for (const t of eligible) {
    const grant = granted.get(`${t.uid}|${t.fixtureId}`);
    if (!grant?.granted) {
      outcomes.push({
        ...t, result: "dropped",
        reason: grant?.reason === "stale" ? "stale-owner" : "budget-exhausted",
      });
      stats.dropped++;
      continue;
    }
    stats.pools[grant.pool]++;
    stats.attempted++;                                 // 5. spent either way

    const payload = reminderPayload({ match: t.match, leagueCode: t.league });
    let delivered = false;
    try {
      const response = await deps.sendPush(t.token, payload, env, {
        collapseId: collapseId(t.fixtureId),
        expiration: apnsExpiration(t.kickoffAt),
      });
      if (response.status === 410) {
        await deps.dropPushToken(t.uid);
        outcomes.push({ ...t, result: "dropped", reason: "unregistered" });
        stats.dropped++;
        continue;
      }
      delivered = response.ok;
    } catch {
      delivered = false;                               // transient; retried
    }
    if (delivered) { outcomes.push({ ...t, result: "sent" }); stats.sent++; }
    else { outcomes.push({ ...t, result: "failed" }); ack = false; }
  }

  if (outcomes.length) {
    await ledger.call("recordOutcomes", {
      day, now,
      outcomes: outcomes.map((o) => ({
        uid: o.uid, fixtureId: o.fixtureId, gen: o.gen, result: o.result, reason: o.reason,
      })),
    });
    stats.doCalls++;
  }
  return { ack, stats };
}
