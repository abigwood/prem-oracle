/**
 * The cron planner — it plans, and it never sends.
 *
 * Its whole job is to turn "which fixtures kick off soon" into bounded queue
 * jobs without ever fanning out a read per member or per member-fixture. Two
 * shapes make that possible and both are read from KEY NAMES only:
 *
 *   slatefx:<fixtureId>:<leagueCode>   which leagues published this fixture
 *   member:<code>:<uid>                who is in those leagues
 *
 * Neither costs a value read, so discovery is a handful of list pages however
 * many recipients exist.
 */
import { PER_MESSAGE_WORST_CASE, utcDay } from "./ledger.js";
import { chooseLeagueCode } from "./copy.js";
import { MAX_FIXTURES_PER_JOB, MAX_LEAGUES_PER_JOB } from "./consumer.js";

/** Triples per queue message, so a consumer batch can never exceed 45 APNs. */
export const JOB_TRIPLES = 45;
/** The reminder window, preserved from the behaviour this replaces. */
export const REMINDER_WINDOW_MS = 60 * 60 * 1000;

export const slateFixtureKey = (fixtureId, code) => `slatefx:${fixtureId}:${code}`;
export const slateFixturePrefix = (fixtureId) => `slatefx:${fixtureId}:`;

/** Fixtures inside the reminder window that have not kicked off yet. */
export function dueFixtures(matches, now, windowMs = REMINDER_WINDOW_MS) {
  return (matches || []).filter((match) => {
    if (!match?.player1 || !match?.player2) return false;
    const startMs = Date.parse(match.startAt);
    if (!Number.isFinite(startMs)) return false;
    return startMs >= now && startMs <= now + windowMs;
  });
}

/**
 * Build the triples for one fixture.
 *
 * Every triple carries the league code the planner SELECTED — the
 * lexicographically smallest the recipient is eligible through. It is chosen
 * once, here, and then travels unchanged through the queue message, the
 * eligibility re-check, the ledger row, the notification payload and the
 * diagnostic. Nothing downstream is allowed to pick one for itself, because a
 * second guess is how a tap opens the wrong league.
 *
 * The PERIOD travels with it for a duller reason: without it the consumer would
 * have to read the index to find the slate, turning one authoritative read into
 * two on a budget that allows one.
 */
export function triplesForFixture({
  match, leagueCodes, membersByLeague, periodsByLeague, picks, competition,
}) {
  const kickoffAt = Date.parse(match.startAt);
  const byUid = new Map();
  for (const code of leagueCodes) {
    for (const uid of membersByLeague.get(code) || []) {
      // The planner's bounded pick filter: one picks:<fixtureId> read has
      // already told us who still owes a prediction, so nobody who has made
      // one is ever enqueued. The consumer re-reads it anyway — this is an
      // economy, not the correctness check.
      if (picks && picks[uid]) continue;
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(code);
    }
  }
  const triples = [];
  for (const [uid, codes] of byUid) {
    const league = chooseLeagueCode(codes);
    const period = periodsByLeague?.get(league);
    if (!league || period == null) continue;
    triples.push({
      uid,
      fixtureId: String(match.id),
      league,
      period: String(period),
      kickoffAt,
      competition,
      match: {
        id: String(match.id),
        player1: match.player1,
        player2: match.player2,
        startAt: match.startAt,
      },
    });
  }
  // Deterministic order, so two planners produce byte-identical jobs.
  return triples.sort((a, b) => a.uid.localeCompare(b.uid));
}

/**
 * Pack triples into jobs ACROSS fixtures.
 *
 * Packing per fixture leaves a part-full message at the end of every one of
 * them — twenty fixtures at a thousand recipients is 460 messages rather than
 * the 445 the cost model was built on, and at margins of 1.10x that difference
 * is not rounding. Packing across fixtures closes the gap.
 *
 * The bound the consumer depends on is enforced here and nowhere else: at most
 * three distinct fixtures and three distinct leagues per job, which is what
 * makes its fixed read cost a constant.
 */
export function packJobs(triples, {
  size = JOB_TRIPLES,
  maxFixtures = MAX_FIXTURES_PER_JOB,
  maxLeagues = MAX_LEAGUES_PER_JOB,
} = {}) {
  const jobs = [];
  let current = [];
  let fixtures = new Set();
  let leagues = new Set();
  const flush = () => {
    if (current.length) jobs.push({ v: 1, triples: current });
    current = [];
    fixtures = new Set();
    leagues = new Set();
  };
  for (const t of triples) {
    const wouldExceed = current.length >= size
      || (!fixtures.has(t.fixtureId) && fixtures.size >= maxFixtures)
      || (!leagues.has(t.league) && leagues.size >= maxLeagues);
    if (wouldExceed) flush();
    current.push(t);
    fixtures.add(t.fixtureId);
    leagues.add(t.league);
  }
  flush();
  return jobs;
}

/**
 * Book the messages ATOMICALLY across every pool their worst case will spend.
 *
 * Reserving each pool in turn means a short third pool leaves the first two
 * charged for messages that were never enqueued. One operation grants the same
 * whole-message count from all three, or grants none.
 */
export async function reserveForJobs(ledger, day, jobCount) {
  if (jobCount === 0) return { affordable: 0, refused: 0 };
  return ledger.call("reserveMessages", {
    day, count: jobCount, perMessage: { ...PER_MESSAGE_WORST_CASE },
  });
}

/**
 * One planning pass over every due fixture.
 *
 * Collects across fixtures first, packs once, reserves once, and returns the
 * jobs rather than sending them, so the cron path stays testable without a
 * queue. Whatever it could not fund is made TERMINAL — a triple the planner
 * merely declined to enqueue is a triple it will offer again next tick.
 */
export async function planWindow({ matches, competitionOf, ledger, deps, now }) {
  const day = utcDay(now);
  const all = [];
  const skipped = [];
  for (const match of matches) {
    const leagueCodes = await deps.leaguesForFixture(match.id);
    if (!leagueCodes.length) { skipped.push({ id: match.id, why: "no-league" }); continue; }
    const periodsByLeague = await deps.periodsForFixture(match.id, leagueCodes);
    const membersByLeague = await deps.membersByLeague(leagueCodes);
    const picks = await deps.readPicks(String(match.id));
    all.push(...triplesForFixture({
      match, leagueCodes, membersByLeague, periodsByLeague, picks,
      competition: competitionOf(match),
    }));
  }
  if (!all.length) return { jobs: [], triples: 0, refused: 0, skipped };

  const jobs = packJobs(all);
  const { affordable } = await reserveForJobs(ledger, day, jobs.length);
  const enqueued = jobs.slice(0, affordable);
  const unfunded = jobs.slice(affordable);
  if (unfunded.length) {
    // Never silently: what could not be funded stops being work, and is
    // counted where it can be read.
    await ledger.call("terminatePlanned", {
      day, now, reason: "plan-budget-exhausted",
      triples: unfunded.flatMap((job) => job.triples.map((t) => ({
        uid: t.uid, fixtureId: t.fixtureId, league: t.league, kickoffAt: t.kickoffAt,
      }))),
    });
  }
  return { jobs: enqueued, triples: all.length, refused: unfunded.length, skipped };
}
