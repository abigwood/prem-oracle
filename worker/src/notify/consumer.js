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
 * EXACTLY three Durable Object round trips for a working delivery, one for a
 * refused one. Never a fourth, and never one per triple — the reservation is
 * only meaningful if the real call count is the one it was sized against.
 */
import { utcDay } from "./ledger.js";
import { reminderPayload, collapseId, apnsExpiration } from "./copy.js";

/** Per-recipient reads: push:<uid> and member:<code>:<uid>. Nothing else. */
export const KV_READS_PER_TRIPLE = 2;

/**
 * A job spans at most three fixtures. Leagues are NOT bounded, deliberately.
 *
 * Capping leagues per job looked like it made the fixed read cost a constant,
 * but it only did so for leagues that are large. A thousand one-person leagues
 * hits the cap after three triples, turning 445 messages into 6,680 — more than
 * the queue and Durable Object pools can fund, so most of the round would
 * simply never be planned. The bound was buying a tidy constant at the price of
 * the product working for small leagues.
 */
export const MAX_FIXTURES_PER_JOB = 3;

/**
 * What a job will read, from the JOB'S OWN COMPOSITION rather than a global
 * worst case: two per recipient, one pick map per distinct fixture, one slate
 * per distinct (league, period). A job of 45 in one league reads 94; the same
 * 45 spread across 45 one-person leagues reads 136 — and says so before it
 * starts, rather than discovering it halfway through.
 */
export function worstCaseReads(triples) {
  const list = Array.isArray(triples) ? triples : [];
  const fixtures = new Set();
  const contexts = new Set();
  for (const t of list) {
    fixtures.add(t.fixtureId);
    contexts.add(`${t.league}|${t.period}`);
  }
  return list.length * KV_READS_PER_TRIPLE + fixtures.size + contexts.size;
}

/**
 * The shared context a job's recipients are all judged against.
 *
 * Loaded ONCE per message and then held in memory. Reading the pick map or the
 * published slate per recipient would be five reads each against a reservation
 * of two, which is the gap between what the budget was told and what it spent.
 */
async function loadContext(deps, triples) {
  const picks = new Map();
  const slates = new Map();
  for (const t of triples) {
    if (!picks.has(t.fixtureId)) picks.set(t.fixtureId, await deps.readPicks(t.fixtureId));
    // The period rides in the triple, chosen by the planner, so the slate is
    // one read rather than a hint read plus a slate read.
    const key = `${t.league}|${t.period}`;
    if (!slates.has(key)) slates.set(key, await deps.readSlate(t.league, t.period));
  }
  return { picks, slates };
}

/**
 * Is this recipient still owed this reminder?
 *
 * Every per-recipient value here is read at SEND time, not planning time. D2
 * requires the re-check immediately before APNs precisely because the
 * interesting failures happen in between: a pick saved, a mute set, a member
 * removed, a fixture amended out of the slate.
 */
export async function stillEligible(deps, context, triple) {
  const { uid, fixtureId, league, competition, period } = triple;
  const push = await deps.readPush(uid);
  if (!push?.token) return { ok: false, reason: "no-token" };
  if (Array.isArray(push.mute) && push.mute.includes(competition)) return { ok: false, reason: "muted" };
  if (!(await deps.isMember(league, uid))) return { ok: false, reason: "not-member" };
  const picks = context.picks.get(fixtureId);
  if (picks && picks[uid]) return { ok: false, reason: "already-picked" };
  const slate = context.slates.get(`${league}|${period}`);
  const listed = slate?.status === "published"
    && (slate.fixtureIds || []).map(String).includes(String(fixtureId));
  if (!listed) return { ok: false, reason: "amended-out" };
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
    reads: 0, pools: { apns_initial: 0, apns_retry: 0 },
  };
  if (!triples.length) return { ack: true, stats };

  const identity = (t) => ({
    uid: t.uid, fixtureId: t.fixtureId, league: t.league, kickoffAt: t.kickoffAt,
  });

  // CALL 1 — reserve, claim and resolve dispositions, in one round trip. A
  // refusal is made terminal inside that same transaction.
  const begun = await ledger.call("beginDelivery", {
    day, want: worstCaseReads(triples), now, triples: triples.map(identity),
  });
  if (begun.refused) {
    stats.dropped = begun.dropped;
    stats.terminated = begun.dropped;
    return { ack: true, stats };
  }
  stats.reads = begun.granted;                         // 6. consumed either way
  stats.deferred = begun.deferred;
  let ack = begun.deferred === 0;

  const owned = new Map(begun.claimed.map((row) => [`${row.uid}|${row.fixture_id}`, row]));

  // 3. Authoritative eligibility, on reads already paid for and loaded once.
  const context = await loadContext(deps, triples.filter((t) => owned.has(`${t.uid}|${t.fixtureId}`)));
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
    const check = await stillEligible(deps, context, t);
    if (!check.ok) {
      outcomes.push({ ...t, gen: row.claim_gen, result: "dropped", reason: check.reason });
      stats.dropped++;
      continue;
    }
    eligible.push({ ...t, gen: row.claim_gen, token: check.token });
  }

  // CALL 2 — the exact attempts: one fenced atomic step that verifies each
  // fence, picks the pool from the row's own history, reserves and marks.
  let grants = [];
  if (eligible.length) {
    grants = await ledger.call("grantAttempts", {
      day,
      grants: eligible.map((t) => ({ uid: t.uid, fixtureId: t.fixtureId, gen: t.gen })),
    });
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

  // CALL 3 — every outcome of this delivery, in one round trip.
  if (outcomes.length) {
    await ledger.call("recordOutcomes", {
      day, now,
      outcomes: outcomes.map((o) => ({
        uid: o.uid, fixtureId: o.fixtureId, gen: o.gen, result: o.result, reason: o.reason,
      })),
    });
  }
  return { ack, stats };
}
