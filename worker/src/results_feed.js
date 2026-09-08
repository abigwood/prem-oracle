import { isVoided, normaliseResult } from "./logic.js";

const FEED_BASE = "https://api.football-data.org/v4/competitions";
// The fast path: a fixture that has only just kicked off.
const RECENT_KICKOFF_MS = 6 * 60 * 60 * 1000;

// The catch-up path.
//
// A settlement run that missed a fixture used to miss it forever: after six
// hours it was never considered again. One unresolved fixture then holds its
// period open indefinitely, because roundComplete needs every fixture settled
// or void and `postponed` is not void — which is how Bury Legends sat on Week
// 4 with Week 5 already published (2026-09-08).
//
// So an unresolved PAST fixture stays eligible for a fortnight: long enough to
// outlast a feed outage, a rate limit or a gap in the cron, short enough that
// a season is never scanned. It is bounded three ways — by age, by how many
// fixtures one run will carry, and by how often the catch-up may run at all.
export const CATCH_UP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CATCH_UP_LIMIT = 20;
export const CATCH_UP_INTERVAL_MS = 60 * 60 * 1000;
// The cron period this worker is scheduled on (wrangler.toml: */15).
const CRON_PERIOD_MS = 15 * 60 * 1000;

/**
 * Whether this tick is the one that carries the catch-up.
 *
 * Stateless on purpose. "The first tick of the hour" is once an hour without a
 * timestamp to store, read back and keep correct, and a stored one would be a
 * write on every pass for a decision worth nothing. A changed cron period
 * degrades to more or fewer catch-up ticks per hour — never to none.
 */
export const catchUpDue = (nowMs, intervalMs = CATCH_UP_INTERVAL_MS, tickMs = CRON_PERIOD_MS) =>
  Number.isFinite(nowMs) && nowMs >= 0 && (nowMs % intervalMs) < tickMs;

export const FOOTBALL_DATA_TEAM_MAP = {
  "AFC Bournemouth": "AFC Bournemouth",
  Arsenal: "Arsenal",
  "Aston Villa": "Aston Villa",
  Brentford: "Brentford",
  "Brighton & Hove Albion": "Brighton & Hove Albion",
  Brighton: "Brighton & Hove Albion",
  "Brighton Hove Albion": "Brighton & Hove Albion",
  Chelsea: "Chelsea",
  "Coventry City": "Coventry City",
  Coventry: "Coventry City",
  "Crystal Palace": "Crystal Palace",
  Everton: "Everton",
  Fulham: "Fulham",
  "Hull City": "Hull City",
  Hull: "Hull City",
  "Ipswich Town": "Ipswich Town",
  Ipswich: "Ipswich Town",
  "Leeds United": "Leeds United",
  Leeds: "Leeds United",
  Liverpool: "Liverpool",
  "Manchester City": "Manchester City",
  ManCity: "Manchester City",
  "Man City": "Manchester City",
  "Manchester United": "Manchester United",
  ManU: "Manchester United",
  "Man United": "Manchester United",
  "Man Utd": "Manchester United",
  "Newcastle United": "Newcastle United",
  Newcastle: "Newcastle United",
  "Nottingham Forest": "Nottingham Forest",
  Sunderland: "Sunderland",
  "Tottenham Hotspur": "Tottenham Hotspur",
  Tottenham: "Tottenham Hotspur",
  Spurs: "Tottenham Hotspur",
};

// EFL Championship 2026/27. Kept as its own map rather than merged into the
// Premier League one: a feed name can then only ever resolve to a club in the
// competition being settled, so a Championship result has no route by which to
// reach a Premier League fixture even if the two ever shared a club name.
export const FOOTBALL_DATA_TEAM_MAP_ELC = {
  "Birmingham City": "Birmingham City",
  Birmingham: "Birmingham City",
  "Blackburn Rovers": "Blackburn Rovers",
  Blackburn: "Blackburn Rovers",
  "Bolton Wanderers": "Bolton Wanderers",
  Bolton: "Bolton Wanderers",
  "Bristol City": "Bristol City",
  Burnley: "Burnley",
  "Cardiff City": "Cardiff City",
  Cardiff: "Cardiff City",
  "Charlton Athletic": "Charlton Athletic",
  Charlton: "Charlton Athletic",
  "Derby County": "Derby County",
  Derby: "Derby County",
  "Lincoln City": "Lincoln City",
  Lincoln: "Lincoln City",
  Middlesbrough: "Middlesbrough",
  Boro: "Middlesbrough",
  Millwall: "Millwall",
  "Norwich City": "Norwich City",
  Norwich: "Norwich City",
  Portsmouth: "Portsmouth",
  "Preston North End": "Preston North End",
  Preston: "Preston North End",
  "Queens Park Rangers": "Queens Park Rangers",
  QPR: "Queens Park Rangers",
  "Sheffield United": "Sheffield United",
  "Sheffield Utd": "Sheffield United",
  Southampton: "Southampton",
  "Stoke City": "Stoke City",
  Stoke: "Stoke City",
  "Swansea City": "Swansea City",
  Swansea: "Swansea City",
  Watford: "Watford",
  "West Bromwich Albion": "West Bromwich Albion",
  "West Brom": "West Bromwich Albion",
  "West Bromwich": "West Bromwich Albion",
  "West Ham United": "West Ham United",
  "West Ham": "West Ham United",
  "Wolverhampton Wanderers": "Wolverhampton Wanderers",
  Wolves: "Wolverhampton Wanderers",
  Wrexham: "Wrexham",
};

// Which football-data.org competition each of ours maps to, and the name map to
// resolve its clubs with. A competition absent from here simply has no feed and
// is never auto-settled \u2014 which is the Champions League's position until its
// draw has happened.
export const COMPETITION_FEEDS = {
  PL: { feedCode: "PL", teams: FOOTBALL_DATA_TEAM_MAP },
  ELC: { feedCode: "ELC", teams: FOOTBALL_DATA_TEAM_MAP_ELC },
};

export const feedForCompetition = (competition) => COMPETITION_FEEDS[competition] || null;

const canonicalName = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(fc|afc|cf|the)\b/gi, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();

const lookupFor = (teams) => new Map(Object.entries(teams)
  .map(([feedName, fixtureName]) => [canonicalName(feedName), fixtureName]));

const LOOKUPS = Object.fromEntries(Object.entries(COMPETITION_FEEDS)
  .map(([code, feed]) => [code, lookupFor(feed.teams)]));

export function mapFootballDataTeam(name, competition = "PL") {
  return LOOKUPS[competition]?.get(canonicalName(name)) || null;
}

/**
 * What one settlement run will look at.
 *
 * The recent set is exactly what it always was, so the ordinary path is
 * unchanged and costs what it always cost. On a catch-up tick the stale set is
 * added: past fixtures still carrying no result and no void, oldest first —
 * the one holding a period open is the one that matters — and capped, so a
 * long outage cannot turn one run into a season scan.
 *
 * Nothing already settled or void is ever included, from the fixture itself or
 * from the results overlay, so a fixture is never worked on twice.
 */
export function fixturesNeedingAutoSettle(fixtures, results, nowMs = Date.now(), { catchUp = false } = {}) {
  const startOf = (match) => Date.parse(match.startAt || match.lockAt);
  const unresolved = (fixtures || []).filter((match) => {
    if (!match?.id || !match.player1 || !match.player2) return false;
    if (normaliseResult(match) || isVoided(match)) return false;
    if (results?.[match.id] && (normaliseResult(results[match.id]) || isVoided(results[match.id]))) return false;
    const startMs = startOf(match);
    if (!Number.isFinite(startMs)) return false;
    return startMs <= nowMs;                       // never a fixture still to be played
  });

  const recent = unresolved.filter((match) => nowMs - startOf(match) <= RECENT_KICKOFF_MS);
  if (!catchUp) return recent;

  const stale = unresolved
    .filter((match) => {
      const age = nowMs - startOf(match);
      return age > RECENT_KICKOFF_MS && age <= CATCH_UP_MAX_AGE_MS;
    })
    .sort((a, b) => startOf(a) - startOf(b))
    .slice(0, CATCH_UP_LIMIT);

  return [...recent, ...stale];
}

const fixtureSeason = (fixtures) => {
  const firstStart = (fixtures || [])
    .map((match) => Date.parse(match?.startAt || match?.lockAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return Number.isFinite(firstStart) ? new Date(firstStart).getUTCFullYear() : new Date().getUTCFullYear();
};

const fixtureKey = (home, away, date) =>
  `${canonicalName(home)}|${canonicalName(away)}|${String(date || "").slice(0, 10)}`;

/**
 * Our fixtures, keyed by the same home|away|date the feed will be reduced to.
 *
 * Two fixtures sharing that key cannot be told apart, so NEITHER is indexed: a
 * settlement that guesses which of two fixtures a score belongs to is worse
 * than one that waits.
 */
function indexFixtures(fixtures) {
  const indexed = new Map();
  const ambiguous = new Set();
  for (const match of fixtures || []) {
    const key = fixtureKey(match.player1, match.player2, match.startAt);
    if (indexed.has(key)) { ambiguous.add(key); continue; }
    indexed.set(key, match);
  }
  for (const key of ambiguous) indexed.delete(key);
  return indexed;
}

async function fetchFootballDataMatches(env, fixtures, competition) {
  const feed = feedForCompetition(competition);
  if (!feed) throw new Error(`no results feed configured for ${competition}`);
  const url = new URL(`${FEED_BASE}/${feed.feedCode}/matches`);
  url.searchParams.set("season", String(fixtureSeason(fixtures)));
  const response = await fetch(url.toString(), {
    headers: { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN },
  });
  if (!response.ok) throw new Error(`football-data fetch ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.matches) ? body.matches : [];
}

export async function footballDataResults(env, fixtures, competition = "PL") {
  const indexedFixtures = indexFixtures(fixtures);
  const feedMatches = await fetchFootballDataMatches(env, fixtures, competition);
  const results = {};
  // A fixture two feed entries disagree about is dropped and stays dropped.
  const disputed = new Set();

  for (const item of feedMatches) {
    if (item?.status !== "FINISHED") continue;
    // Names resolve against this competition's map only, so a club that is not
    // in it cannot be matched at all.
    const home = mapFootballDataTeam(item.homeTeam?.name || item.homeTeam?.shortName, competition);
    const away = mapFootballDataTeam(item.awayTeam?.name || item.awayTeam?.shortName, competition);
    if (!home || !away) continue;
    const score = item.score?.fullTime;
    if (!Number.isInteger(score?.home) || !Number.isInteger(score?.away)) continue;
    const fixture = indexedFixtures.get(fixtureKey(home, away, item.utcDate));
    if (!fixture) continue;
    if (disputed.has(fixture.id)) continue;
    const held = results[fixture.id];
    if (held && (held.result[0] !== score.home || held.result[1] !== score.away)) {
      // Two FINISHED entries, two different scores, one fixture. Neither is
      // authoritative, so nothing is written and the next run tries again.
      disputed.add(fixture.id);
      delete results[fixture.id];
      continue;
    }
    results[fixture.id] = {
      status: "complete",
      result: [score.home, score.away],
      lockAt: new Date().toISOString(),
      source: "football-data",
    };
  }

  return results;
}

export async function autoSettleResults(env, fixtures, existingResults, nowMs = Date.now(), competition = "PL") {
  const idle = { checked: false, settled: 0, results: existingResults || {} };
  if (!env.FOOTBALL_DATA_TOKEN) return idle;
  if (!feedForCompetition(competition)) return idle;
  // The catch-up widens WHAT is eligible, never how often the feed is called:
  // one request per competition per run, and only when something is pending.
  const catchUp = catchUpDue(nowMs);
  const pending = fixturesNeedingAutoSettle(fixtures, existingResults, nowMs, { catchUp });
  if (!pending.length) return { ...idle, catchUp };

  const feedResults = await footballDataResults(env, fixtures, competition);
  const pendingIds = new Set(pending.map((match) => match.id));
  const next = { ...(existingResults || {}) };
  let settled = 0;

  for (const [matchId, overlay] of Object.entries(feedResults)) {
    if (!pendingIds.has(matchId)) continue;
    if (next[matchId] && (normaliseResult(next[matchId]) || isVoided(next[matchId]))) continue;
    next[matchId] = overlay;
    settled++;
  }

  return { checked: true, settled, results: next, catchUp, considered: pending.length };
}
