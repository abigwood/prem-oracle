// Competition registry.
//
// Everything that used to be implicitly "the Premier League" now carries a
// competition code. There are exactly three, and a fixture's competition is
// derived from its own id rather than stored alongside it — which is what makes
// the namespaced id convention load-bearing rather than cosmetic. A bare
// provider id (say "12345") has no competition and is rejected outright, so a
// Champions League result can never be written over a Premier League fixture.

export const COMPETITIONS = {
  PL: {
    code: "PL",
    name: "Premier League",
    short: "Premier League",
    idPrefix: "pl-",
    fixturesEnv: "FIXTURES_URL",
    rounds: 38,
    roundWord: "Matchweek",
  },
  ELC: {
    code: "ELC",
    name: "EFL Championship",
    short: "Championship",
    idPrefix: "elc-",
    fixturesEnv: "FIXTURES_URL_ELC",
    rounds: 46,
    roundWord: "Matchweek",
  },
  CL: {
    code: "CL",
    name: "UEFA Champions League",
    short: "Champions League",
    idPrefix: "cl-",
    fixturesEnv: "FIXTURES_URL_CL",
    rounds: 8,
    roundWord: "Matchweek",
  },
};

export const COMPETITION_CODES = Object.keys(COMPETITIONS);
export const DEFAULT_COMPETITION = "PL";

// Longest prefix first so "elc-" is never shadowed by a shorter sibling.
const BY_PREFIX = Object.values(COMPETITIONS).sort((a, b) => b.idPrefix.length - a.idPrefix.length);

export const isCompetition = (code) => Object.prototype.hasOwnProperty.call(COMPETITIONS, String(code || ""));

export const normaliseCompetition = (code) =>
  (isCompetition(code) ? String(code) : DEFAULT_COMPETITION);

// A league created before competitions existed is a Premier League league.
export const leagueCompetition = (league) => normaliseCompetition(league?.competition);

// ---------------------------------------------------------------------------
// Competition sets
//
// A league now selects one or more competitions. Three record generations exist
// in the wild and all three are read here without ever being rewritten:
//
//   {code, name, owner}                        pre-v1.3  -> ["PL"]
//   {competition: "ELC", customMix: true}      v1.3      -> ["ELC"]
//   {competitions: ["PL", "ELC"]}              v1.6      -> as stored
//
// Normalisation happens at the read boundary only. A legacy record is upgraded
// on disk exactly when its host saves the league, never as a side effect of
// somebody reading it.
// ---------------------------------------------------------------------------

export function leagueCompetitions(league) {
  const stored = league?.competitions;
  if (Array.isArray(stored)) {
    const valid = [...new Set(stored.filter(isCompetition))];
    if (valid.length) return valid;
  }
  return [leagueCompetition(league)];
}

export const isMixedLeague = (league) => leagueCompetitions(league).length > 1;

/** True when the record on disk predates the competitions array. */
export const needsCompetitionUpgrade = (league) => !Array.isArray(league?.competitions);

// ---------------------------------------------------------------------------
// Fixture mode
//
// "all" plays every fixture in the pool; "limited" plays a host-chosen number.
// Both are stored intents — never inferred from the absence of a field — and
// the legacy `customMix` boolean maps onto them at the read boundary:
//
//   customMix: true   -> { mode: "limited", limit: null }   host picks per week
//   customMix absent  -> { mode: "all",     limit: null }
//
// A null limit means no stored preference, so the picker opens on the standard
// default. A number is the host's own default. Either way it is only ever a
// starting point: see effectiveFixtureCount.
// ---------------------------------------------------------------------------

export const FIXTURE_MODES = ["all", "limited"];
export const MIN_FIXTURE_LIMIT = 3;
export const DEFAULT_FIXTURE_LIMIT = 8;

export function leagueFixturePlan(league) {
  const stored = String(league?.fixtureMode || "");
  if (FIXTURE_MODES.includes(stored)) {
    const limit = Number(league?.fixtureLimit);
    return {
      mode: stored,
      limit: stored === "limited" && Number.isInteger(limit) && limit >= MIN_FIXTURE_LIMIT ? limit : null,
    };
  }
  return { mode: league?.customMix === true ? "limited" : "all", limit: null };
}

/**
 * How many fixtures a league plays in a period.
 *
 * `fixtureLimit` is a default, not a cap: the picker opens pre-set to it and
 * the host is free to take more or fewer that week. The week's actual count is
 * simply however many fixtures ended up in its slate, so nothing per-week needs
 * storing. A pool smaller than the default caps the default gracefully — a
 * blank round or a run of postponements is not a fault.
 */
export function effectiveFixtureCount(league, poolSize) {
  const plan = leagueFixturePlan(league);
  if (plan.mode === "all") {
    return { mode: "all", default: poolSize, min: poolSize, max: poolSize, capped: false, plan };
  }
  const min = Math.min(MIN_FIXTURE_LIMIT, poolSize);
  const preferred = plan.limit ?? DEFAULT_FIXTURE_LIMIT;
  return {
    mode: "limited",
    default: Math.max(min, Math.min(preferred, poolSize)),
    min,
    max: poolSize,
    capped: preferred > poolSize,
    plan,
  };
}

// ---------------------------------------------------------------------------
// "Your Week" windows
//
// Premier League matchweeks and Championship rounds never align — Matchweek 8
// against Round 12 — so a league drawing on both cannot use either as its unit.
// It runs on its own Monday-to-Sunday calendar week instead, and every fixture
// kicking off inside that window is eligible.
//
// Single-competition leagues are untouched: they keep official matchweeks.
// ---------------------------------------------------------------------------

const LONDON = "Europe/London";
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function londonParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${byType.year}-${byType.month}-${byType.day}`, weekday: byType.weekday };
}

/** The Monday-anchored window key a kickoff falls in, e.g. "w2026-08-10". */
export function windowKeyFor(value) {
  const parts = londonParts(value);
  if (!parts) return null;
  const offset = WEEKDAY_INDEX[parts.weekday];
  if (offset == null) return null;
  const [year, month, day] = parts.date.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day - offset));
  return `w${monday.toISOString().slice(0, 10)}`;
}

export const isWindowKey = (key) => /^w\d{4}-\d{2}-\d{2}$/.test(String(key || ""));

/** Human label for a window: "Mon 10 – Sun 16 Aug". */
export function windowLabel(key) {
  if (!isWindowKey(key)) return "";
  const start = new Date(`${String(key).slice(1)}T12:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86400000);
  const fmt = (date, withMonth) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", ...(withMonth ? { month: "short" } : {}),
  }).format(date);
  return `${fmt(start, start.getUTCMonth() !== end.getUTCMonth())} – ${fmt(end, true)}`;
}

/**
 * The period a fixture belongs to for a given league: an official matchweek
 * number for a single-competition league, a window key for a mixed one. This is
 * the value slates key on, which is why an existing matchweek-numbered slate
 * key keeps working untouched.
 */
export function periodKeyOf(fixture, mixed) {
  if (!mixed) return fixture?.matchday == null ? null : String(fixture.matchday);
  return windowKeyFor(fixture?.startAt || fixture?.lockAt);
}

/** Every fixture from the selected competitions, grouped by period. */
export function poolByPeriod(fixtures, league) {
  const competitions = leagueCompetitions(league);
  const mixed = competitions.length > 1;
  const allowed = new Set(competitions);
  const grouped = new Map();
  for (const fixture of fixtures || []) {
    const competition = competitionOfFixture(fixture?.id);
    if (!competition || !allowed.has(competition)) continue;
    const key = periodKeyOf(fixture, mixed);
    if (key == null) continue;
    const list = grouped.get(key) || [];
    list.push(fixture);
    grouped.set(key, list);
  }
  return grouped;
}

/**
 * The competition a fixture id belongs to, or null if the id is not one of
 * ours. Null is a hard error at every call site that writes: we never guess.
 */
export function competitionOfFixture(fixtureId) {
  const id = String(fixtureId || "");
  const match = BY_PREFIX.find((competition) => id.startsWith(competition.idPrefix));
  return match ? match.code : null;
}

export const isNamespacedFixtureId = (fixtureId) => competitionOfFixture(fixtureId) !== null;

// ---------------------------------------------------------------------------
// Results keys
//
// The legacy key is the one dangerous object in the store: it predates
// competitions and holds every settled Premier League fixture. It is read
// during the bridge and frozen afterwards, but it is NEVER written and NEVER
// deleted — enforced by assertNotLegacyResultsKey at every write path.
// ---------------------------------------------------------------------------

export const LEGACY_RESULTS_KEY = "results";
export const resultsKey = (competition) => `results:${normaliseCompetition(competition)}`;

export function assertNotLegacyResultsKey(key) {
  if (String(key) === LEGACY_RESULTS_KEY) {
    throw new Error("refusing to write the legacy results key: it is frozen and never mutated");
  }
  return key;
}

/**
 * Splits a flat results object into one map per competition. Entries whose id
 * is not namespaced are returned under `unknown` so the migration can report
 * them rather than silently dropping or misfiling them.
 */
export function splitResultsByCompetition(results) {
  const split = Object.fromEntries(COMPETITION_CODES.map((code) => [code, {}]));
  const unknown = {};
  for (const [fixtureId, value] of Object.entries(results || {})) {
    const competition = competitionOfFixture(fixtureId);
    if (competition) split[competition][fixtureId] = value;
    else unknown[fixtureId] = value;
  }
  return { split, unknown };
}

// Stable content hash for parity evidence: key order must not matter.
export function hashResults(results) {
  const canonical = JSON.stringify(Object.entries(results || {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => [key, value]));
  // FNV-1a, 32-bit. Enough to detect any accidental divergence in a store this
  // size, and dependency-free inside the worker runtime.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${Object.keys(results || {}).length}`;
}
