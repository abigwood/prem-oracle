import { isVoided, normaliseResult } from "./logic.js";

const FEED_BASE = "https://api.football-data.org/v4/competitions";
const RECENT_KICKOFF_MS = 6 * 60 * 60 * 1000;

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

export function fixturesNeedingAutoSettle(fixtures, results, nowMs = Date.now()) {
  return (fixtures || []).filter((match) => {
    if (!match?.id || !match.player1 || !match.player2) return false;
    if (normaliseResult(match) || isVoided(match)) return false;
    if (results?.[match.id] && (normaliseResult(results[match.id]) || isVoided(results[match.id]))) return false;
    const startMs = Date.parse(match.startAt || match.lockAt);
    if (!Number.isFinite(startMs)) return false;
    return startMs <= nowMs && nowMs - startMs <= RECENT_KICKOFF_MS;
  });
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

function indexFixtures(fixtures) {
  const indexed = new Map();
  for (const match of fixtures || []) {
    indexed.set(fixtureKey(match.player1, match.player2, match.startAt), match);
  }
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
  if (!env.FOOTBALL_DATA_TOKEN) return { checked: false, settled: 0, results: existingResults || {} };
  if (!feedForCompetition(competition)) return { checked: false, settled: 0, results: existingResults || {} };
  const pending = fixturesNeedingAutoSettle(fixtures, existingResults, nowMs);
  if (!pending.length) return { checked: false, settled: 0, results: existingResults || {} };

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

  return { checked: true, settled, results: next };
}
