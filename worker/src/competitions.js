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
