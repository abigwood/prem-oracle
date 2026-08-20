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
 */
export function triplesForFixture({ match, leagueCodes, membersByLeague, picks, competition }) {
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
    if (!league) continue;
    triples.push({
      uid,
      fixtureId: String(match.id),
      league,
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

export function intoJobs(triples, size = JOB_TRIPLES) {
  const jobs = [];
  for (let i = 0; i < triples.length; i += size) {
    jobs.push({ v: 1, triples: triples.slice(i, i + size) });
  }
  return jobs;
}

/**
 * Book each message's UNAVOIDABLE worst case before `sendBatch`.
 *
 * Once a message is on the queue Cloudflare has already charged its write, and
 * up to four deliveries with their reads, deletes and Durable Object calls
 * follow whatever the consumer decides. Reserving afterwards would be checking
 * a bill that has already been run up — so the planner reserves first and only
 * enqueues what it could pay for.
 */
export async function reserveForJobs(ledger, day, jobCount) {
  const asked = {
    queue_ops: jobCount * PER_MESSAGE_WORST_CASE.queue_ops,
    worker_requests: jobCount * PER_MESSAGE_WORST_CASE.worker_requests,
    do_requests: jobCount * PER_MESSAGE_WORST_CASE.do_requests,
  };
  const granted = {};
  for (const [metric, want] of Object.entries(asked)) {
    granted[metric] = (await ledger.call("reserve", { day, metric, want })).granted;
  }
  // Whole messages only: a half-funded message would enqueue work whose worst
  // case is not covered, which is the thing the reservation exists to prevent.
  const affordable = Math.min(...Object.entries(asked).map(([metric, want]) =>
    want === 0 ? jobCount : Math.floor(granted[metric] / (want / jobCount))));
  return { affordable: Math.max(0, Math.min(jobCount, affordable)), asked, granted };
}

/**
 * One planning pass. Returns what it enqueued rather than sending anything, so
 * the cron path stays testable without a queue.
 */
export async function planFixture({ match, competition, env, ledger, deps, now }) {
  const day = utcDay(now);
  const leagueCodes = await deps.leaguesForFixture(match.id);
  if (!leagueCodes.length) return { jobs: [], triples: 0, skipped: "no-league" };

  const membersByLeague = await deps.membersByLeague(leagueCodes);
  const picks = await deps.readPicks(String(match.id));
  const triples = triplesForFixture({ match, leagueCodes, membersByLeague, picks, competition });
  if (!triples.length) return { jobs: [], triples: 0, skipped: "nobody-owes" };

  const jobs = intoJobs(triples);
  const { affordable } = await reserveForJobs(ledger, day, jobs.length);
  const enqueued = jobs.slice(0, affordable);
  const refused = jobs.length - enqueued.length;
  if (refused > 0) {
    // Never silently: what could not be funded is counted where it can be read.
    await ledger.call("recordOutcomes", {
      day, now,
      outcomes: jobs.slice(affordable).flatMap((job) => job.triples.map((t) => ({
        uid: t.uid, fixtureId: t.fixtureId, gen: 0, result: "dropped", reason: "plan-budget-exhausted",
      }))),
    });
  }
  return { jobs: enqueued, triples: triples.length, refused };
}
