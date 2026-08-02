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
// v1.5 §9: ONE validation path for the weekly count — 1 to 20, default 6, floor
// 1. This supersedes the 6–10 band and the random-8 default that preceded it;
// nothing anywhere else may re-impose a different floor or ceiling.
export const MIN_FIXTURE_COUNT = 1;
export const MAX_FIXTURE_COUNT = 20;
export const DEFAULT_FIXTURE_COUNT = 6;

export function leagueFixturePlan(league) {
  const stored = String(league?.fixtureMode || "");
  if (FIXTURE_MODES.includes(stored)) {
    const limit = Number(league?.fixtureLimit);
    return {
      mode: stored,
      limit: stored === "limited" && Number.isInteger(limit) && limit >= MIN_FIXTURE_COUNT ? limit : null,
    };
  }
  return { mode: league?.customMix === true ? "limited" : "all", limit: null };
}

// ---------------------------------------------------------------------------
// The weekly rule
//
// A league answers one question every period: which fixtures does this week
// score? `weeklyRule` is the stored answer, and the scope is always explicit —
// "all" is never overloaded to mean "all of whichever competition you happen to
// have ticked". Reading it is a pure function of the record; nothing here ever
// writes.
//
//   { method: "manual",          competitionScope: "PL"|"ELC"|"mixed", count }
//   { method: "allEligible",     competitionScope: "mixed",            count }
//   { method: "allCompetition",  competitionScope: "PL"|"ELC",         count }
//   { method: "random",          competitionScope: "PL"|"ELC"|"mixed", count }
//
// `count` is the number of fixtures a random week deals, and the number the
// manual picker opens pre-set to. The all* methods take the whole scope, so the
// count rides along as the league's stated preference without governing them.
// ---------------------------------------------------------------------------

export const WEEKLY_METHODS = ["manual", "allEligible", "allCompetition", "random"];
export const MIXED_SCOPE = "mixed";

/** The scope a league covers when it hasn't named a narrower one. */
export const defaultScopeFor = (competitions) =>
  (competitions.length > 1 ? MIXED_SCOPE : competitions[0]);

export const isScopeValidFor = (scope, competitions) =>
  (scope === MIXED_SCOPE ? competitions.length > 1 : competitions.includes(scope));

export const clampCount = (value) => {
  const count = Number(value);
  if (!Number.isInteger(count)) return DEFAULT_FIXTURE_COUNT;
  return Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT, count));
};

/**
 * The weekly rule for a league, read at the boundary and never written back.
 *
 * A record that predates v1.5 has no `weeklyRule` at all. It normalises to
 * `manual` — the host keeps deciding each week, exactly as they do today — with
 * the count taken from whatever `fixtureLimit` they had already chosen. The
 * legacy `fixtureMode`/`fixtureLimit`/`customMix` fields stay on disk untouched;
 * this function is the only thing that interprets them.
 */
export function leagueWeeklyRule(league) {
  const competitions = leagueCompetitions(league);
  const fallbackScope = defaultScopeFor(competitions);
  const stored = league?.weeklyRule;
  if (stored && WEEKLY_METHODS.includes(String(stored.method))) {
    const method = String(stored.method);
    const scope = isScopeValidFor(String(stored.competitionScope), competitions)
      ? String(stored.competitionScope)
      : fallbackScope;
    return {
      method,
      // allCompetition never resolves to "mixed": a scope that cannot name one
      // competition falls back to the league's first, rather than silently
      // widening to everything the league plays.
      competitionScope: method === "allCompetition" && scope === MIXED_SCOPE ? competitions[0] : scope,
      count: clampCount(stored.count),
      source: "stored",
    };
  }
  const plan = leagueFixturePlan(league);
  // A league that has always played EVERY fixture keeps doing exactly that.
  // Since v1.5j the fallback deals a random N rather than the whole card, so
  // normalising these to `manual` would quietly shrink their week from ten
  // fixtures to six. `allEligible` is the honest reading of the intent they
  // already stored, and it is still a valid method — just no longer offered at
  // creation.
  if (plan.mode === "all") {
    return { method: "allEligible", competitionScope: fallbackScope, count: clampCount(DEFAULT_FIXTURE_COUNT), source: "legacy" };
  }
  return {
    method: "manual",
    competitionScope: fallbackScope,
    count: clampCount(plan.limit ?? DEFAULT_FIXTURE_COUNT),
    source: "legacy",
  };
}

/** True when the rule publishes on its own, with no host step. */
export const isSetAndForget = (rule) => rule.method !== "manual";

/** The competitions a rule actually draws from. */
export function scopeCompetitions(rule, league) {
  const competitions = leagueCompetitions(league);
  if (rule.method === "allCompetition") {
    return competitions.includes(rule.competitionScope) ? [rule.competitionScope] : [competitions[0]];
  }
  if (rule.competitionScope !== MIXED_SCOPE && competitions.includes(rule.competitionScope)) {
    return [rule.competitionScope];
  }
  return competitions;
}

/**
 * Validates a submitted rule against the league's own competition set. Returns
 * `{ error }` or `{ rule }`; the scope is required to be nameable, never
 * inferred from the method.
 */
export function validateWeeklyRule(input, competitions) {
  if (input == null) return { error: "weeklyRule required" };
  const method = String(input.method || "");
  if (!WEEKLY_METHODS.includes(method)) {
    return { error: `weeklyRule.method must be one of ${WEEKLY_METHODS.join(", ")}` };
  }
  const count = Number(input.count ?? DEFAULT_FIXTURE_COUNT);
  if (!Number.isInteger(count) || count < MIN_FIXTURE_COUNT || count > MAX_FIXTURE_COUNT) {
    return { error: `weeklyRule.count must be a whole number between ${MIN_FIXTURE_COUNT} and ${MAX_FIXTURE_COUNT}` };
  }
  const scope = input.competitionScope == null
    ? defaultScopeFor(competitions)
    : String(input.competitionScope);
  if (!isScopeValidFor(scope, competitions)) {
    return { error: `weeklyRule.competitionScope must be one of ${[...competitions, ...(competitions.length > 1 ? [MIXED_SCOPE] : [])].join(", ")}` };
  }
  if (method === "allCompetition" && scope === MIXED_SCOPE) {
    return { error: "allCompetition needs a single competition scope" };
  }
  if (method === "allEligible" && competitions.length > 1 && scope !== MIXED_SCOPE) {
    return { error: "allEligible covers every competition the league plays" };
  }
  return { rule: { method, competitionScope: scope, count } };
}

/**
 * How many fixtures a league plays in a period.
 *
 * The weekly count is a default, not a cap: the picker opens pre-set to it and
 * the host is free to take more or fewer that week, down to one and up to the
 * whole pool. The week's actual count is simply however many fixtures ended up
 * in its published slate, so nothing per-week needs storing. A pool smaller
 * than the default caps the default gracefully — a blank round or a run of
 * postponements is not a fault.
 *
 * A rule that takes the whole scope reports the pool itself, so the picker and
 * the auto-publisher agree on what "all" meant that week.
 */
export function effectiveFixtureCount(league, poolSize) {
  const rule = leagueWeeklyRule(league);
  if (rule.method === "allEligible" || rule.method === "allCompetition") {
    return { mode: "all", default: poolSize, min: poolSize, max: poolSize, capped: false, rule };
  }
  const min = Math.min(MIN_FIXTURE_COUNT, poolSize);
  return {
    mode: rule.method === "random" ? "random" : "limited",
    default: Math.max(min, Math.min(rule.count, poolSize)),
    min,
    max: poolSize,
    capped: rule.count > poolSize,
    rule,
  };
}

// ---------------------------------------------------------------------------
// "Your Week" windows
//
// Premier League matchweeks and Championship rounds never align — Matchweek 8
// against Round 12 — so a league drawing on both cannot use either as its unit.
// It runs on its own calendar window instead, and every fixture kicking off
// inside that window is eligible.
//
// The window is TUESDAY to MONDAY (v1.5 §9). It opens on Tuesday morning, once
// Monday night football has settled the Premier League round, and closes at
// Monday midnight. That is what puts a whole round on one side of the boundary
// rather than splitting Monday's game away from the Saturday it belongs to —
// and it is what keeps a Champions League Tuesday and Wednesday in ONE window
// instead of two, because both sit at the head of the same week.
//
// This replaces the Monday–Sunday window that shipped in v1.4. No mixed-league
// period runs before 14 Aug 2026, so no stored window key changes meaning.
//
// Single-competition leagues are untouched: they keep official matchweeks.
// ---------------------------------------------------------------------------

const LONDON = "Europe/London";
// Offsets back to the window's opening Tuesday. Monday is six days in, at the
// very end of its own week — never the start of the next one.
const WEEKDAY_INDEX = { Tue: 0, Wed: 1, Thu: 2, Fri: 3, Sat: 4, Sun: 5, Mon: 6 };

function londonParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${byType.year}-${byType.month}-${byType.day}`, weekday: byType.weekday };
}

/** The Tuesday-anchored window key a kickoff falls in, e.g. "w2026-08-11". */
export function windowKeyFor(value) {
  const parts = londonParts(value);
  if (!parts) return null;
  const offset = WEEKDAY_INDEX[parts.weekday];
  if (offset == null) return null;
  const [year, month, day] = parts.date.split("-").map(Number);
  const tuesday = new Date(Date.UTC(year, month - 1, day - offset));
  return `w${tuesday.toISOString().slice(0, 10)}`;
}

export const isWindowKey = (key) => /^w\d{4}-\d{2}-\d{2}$/.test(String(key || ""));

/** Human label for a window: "Tue 11 – Mon 17 Aug". */
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
 * THE period key. One definition, inherited by everything with a weekly beat:
 * host nudges, drafts, published slates, the fallback, pick locks and the
 * Schedule tab's grouping all call this rather than deriving a week of their
 * own. If a caller needs to know "which week is this?", it asks here.
 *
 * An official matchweek number for a single-competition league; a Tuesday-to-
 * Monday window key for a mixed one. Existing matchweek-numbered slate keys are
 * untouched by construction.
 */
export function periodKeyOf(fixture, mixed) {
  if (!mixed) return fixture?.matchday == null ? null : String(fixture.matchday);
  return windowKeyFor(fixture?.startAt || fixture?.lockAt);
}

/** The same definition, bound to one league. */
export const periodKeyForLeague = (league) => {
  const mixed = isMixedLeague(league);
  return (fixture) => periodKeyOf(fixture, mixed);
};

/**
 * When a window opens for picking: Tuesday 00:00 London, the morning after
 * Monday night football settled the round before it. A matchweek period has no
 * calendar opening of its own — it opens when it becomes the next round to kick
 * off — so this returns null and callers fall back to that rule.
 */
export function periodOpensAt(period) {
  if (!isWindowKey(period)) return null;
  return Date.parse(`${String(period).slice(1)}T00:00:00Z`) || null;
}

/** Midnight at the end of the window's Monday — the moment it closes. */
export function periodClosesAt(period) {
  const opens = periodOpensAt(period);
  return opens == null ? null : opens + 7 * 86400000;
}

/**
 * A league's own periods in order. Week 1 is its opening window, and every
 * week after it is the next number — the same counting the app shows, derived
 * from the same pool, so a push and the screen agree.
 */
export const orderedPeriods = (byPeriod) => [...byPeriod.keys()].sort(comparePeriods);

/** Which week of this league's season a period is, or null if unknown. */
export function weekNumberOf(period, ordered) {
  const index = (ordered || []).indexOf(String(period));
  return index < 0 ? null : index + 1;
}

/** Orders periods chronologically: window keys as strings, matchweeks as numbers. */
export function comparePeriods(a, b) {
  const numeric = Number(a) - Number(b);
  return Number.isNaN(numeric) ? String(a).localeCompare(String(b)) : numeric;
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
