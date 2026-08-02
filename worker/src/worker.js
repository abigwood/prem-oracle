import {
  appendSlateVersion,
  applySlates,
  buildFixtureIcs,
  buildReveals,
  buildSlateSnapshot,
  canAdvanceSlate,
  computeCabinet,
  computePodium,
  computeRoundTable,
  computeRoundWins,
  computeTable,
  computeTableWithMovement,
  fixturesByMatchweek,
  fixturesNeedingNotification,
  isDraftSlate,
  isEmptyDelta,
  isPublishedSlate,
  isVoided,
  matchLocked,
  makeCode,
  makeRecovery,
  normNick,
  normRecovery,
  normaliseResult,
  normaliseSlate,
  parsePickParam,
  preloadSelection,
  randomSelection,
  reconcileSlate,
  refreshSnapshot,
  roundComplete,
  roundStatus,
  roundWinners,
  slateDelta,
  slateFixtures,
  slateIsLocked,
  slateKey,
  slateLockAt,
  slateStatus,
  slateVersion,
  slateVersions,
  validFootballScore,
  validateSlate,
} from "./logic.js";
import { apnsConfigured, sendPush } from "./apns.js";
import { autoSettleResults, feedForCompetition } from "./results_feed.js";
import {
  COMPETITIONS,
  COMPETITION_CODES,
  DEFAULT_COMPETITION,
  FIXTURE_MODES,
  MAX_FIXTURE_COUNT,
  MIN_FIXTURE_COUNT,
  comparePeriods,
  competitionOfFixture,
  orderedPeriods,
  weekNumberOf,
  defaultScopeFor,
  effectiveFixtureCount,
  isCompetition,
  isMixedLeague,
  isSetAndForget,
  leagueCompetition,
  leagueCompetitions,
  leagueFixturePlan,
  leagueWeeklyRule,
  normaliseCompetition,
  periodKeyForLeague,
  periodKeyOf,
  periodOpensAt,
  poolByPeriod,
  resultsKey,
  scopeCompetitions,
  validateWeeklyRule,
  windowKeyFor,
  windowLabel,
} from "./competitions.js";
import { readMigration, readResults, resultsWriteKey, rollback, runStage } from "./migration.js";

// Fixtures, results and intel are cached per competition. Everything that used
// to be a single module-level slot is now keyed by competition code, which is
// what stops a Championship refresh from evicting the Premier League's cache.
const fixtureCaches = new Map();
const CACHE_MS = 60_000;

const cacheFor = (competition) => {
  const code = normaliseCompetition(competition);
  if (!fixtureCaches.has(code)) {
    fixtureCaches.set(code, { list: null, at: 0, intel: { teams: {}, modelVersion: null } });
  }
  return fixtureCaches.get(code);
};

const clearFixtureCache = (competition) => {
  if (competition) cacheFor(competition).list = null;
  else for (const cache of fixtureCaches.values()) cache.list = null;
};

const CORS_ALLOWLIST = ["https://abigwood.github.io", "premoracle://localhost", "capacitor://localhost"];

const allowedOrigin = (env, request) => {
  const origin = request?.headers.get("origin");
  if (!origin) return null;
  const allowlist = [...CORS_ALLOWLIST, env.ALLOWED_ORIGIN].filter(Boolean);
  return allowlist.includes(origin) ? origin : null;
};

const cors = (env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
});

const applyCors = (response, env, request) => {
  const origin = allowedOrigin(env, request);
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "origin");
  }
  return response;
};
const json = (body, status, env) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(env) } });
const appleAppSiteAssociation = () =>
  new Response(JSON.stringify({
    applinks: {
      apps: [],
      details: [{
        appID: "Y98F87NK7D.com.abigwood.premoracle",
        paths: ["/prem-oracle/*", "/prem-oracle/"],
      }],
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
const kvGet = (env, key) => env.KV.get(key, "json");
const kvPut = (env, key, value) => env.KV.put(key, JSON.stringify(value));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const leagueMemberPrefix = (code) => `member:${code}:`;
const leagueMemberKey = (code, uid) => `${leagueMemberPrefix(code)}${uid}`;
const CUSTOM_MIX_INDEX = "index:custom_mix";

// A league reads its slates when it publishes one every week (v1.5: any league
// with a stored weekly rule), when it is running Custom Mix, or when it ever
// has — turning the toggle off must never silently rewrite the history of weeks
// that were genuinely played on a curated slate.
//
// A legacy record has none of the three until its first slate is published, so
// it keeps exactly the v1.4 read profile until the weekly loop gives it one.
const slateAware = (league) =>
  !!league?.weeklyRule || league?.customMix === true || league?.hadSlates === true;

// Every PUBLISHED slate for a league. Drafts share the key space but are the
// host's working copy and must never reach a scoring path — this is the one
// choke point that keeps them out, so no caller has to remember.
async function readSlates(env, code, periods = null) {
  if (periods) {
    const rows = await Promise.all(periods.map(async (period) =>
      [String(period), await kvGet(env, slateKey(code, period))]));
    return Object.fromEntries(rows.filter(([, slate]) => isPublishedSlate(slate)));
  }
  if (!env.KV.list) return {};
  const prefix = `custom_slate:${code}:`;
  const slates = {};
  let cursor;
  for (;;) {
    const page = await env.KV.list({ prefix, cursor });
    const rows = await Promise.all(page.keys.map(async (key) =>
      // The suffix is the period: a matchweek number for a single-competition
      // league, a window key like w2026-08-11 for a mixed one. Kept as a string
      // either way, because parsing it as a number would silently drop windows.
      [key.name.slice(prefix.length), await kvGet(env, key.name)]));
    for (const [period, slate] of rows) {
      if (period && isPublishedSlate(slate)) slates[period] = slate;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return slates;
}

/** The published slate for one period, or null — drafts never qualify. */
async function readPublishedSlate(env, code, period) {
  const slate = await kvGet(env, slateKey(code, period));
  return isPublishedSlate(slate) ? slate : null;
}

async function updateCustomMixIndex(env, code, member) {
  const current = (await kvGet(env, CUSTOM_MIX_INDEX)) || [];
  const next = member ? [...new Set([...current, code])] : current.filter((entry) => entry !== code);
  if (next.length === current.length && next.every((entry, i) => entry === current[i])) return;
  await kvPut(env, CUSTOM_MIX_INDEX, next);
}

// Sends one alert to a specific set of members. Everything league-scoped rides
// the existing APNs path and the existing push:<uid> token records.
async function pushToUids(env, uids, message) {
  if (!apnsConfigured(env) || !uids?.length) return 0;
  // A plain string is the body on its own; an object carries a title too, which
  // is what lets an amendment announce itself as "Line-up updated" rather than
  // arriving as another anonymous line of text.
  const alert = typeof message === "string" ? message : { title: message.title, body: message.body };
  const payload = { aps: { alert, sound: "default" } };
  let sent = 0;
  await Promise.all([...new Set(uids)].map(async (uid) => {
    const record = await kvGet(env, `push:${uid}`);
    if (!record?.token) return;
    try {
      const response = await sendPush(record.token, payload, env);
      if (response.status === 410) await env.KV.delete(`push:${uid}`);
      else sent++;
    } catch { /* transient APNs failure; retried on the next cron tick */ }
  }));
  return sent;
}

const hostNick = (memberList, league) =>
  memberList.find((member) => member.uid === league.owner)?.nick || "Your host";

export function mergeResultOverlay(match, overlay) {
  if (!overlay) return match;
  const officialResult = normaliseResult(match);
  const merged = { ...match, ...overlay };
  const overlayResult = normaliseResult(merged);
  if ((officialResult || isVoided(match)) && !overlayResult && !isVoided(merged)) return match;
  return merged;
}

// The URL a competition's fixture feed lives at. Only the Premier League has a
// guaranteed one; a competition whose feed is not configured simply has no
// fixtures rather than breaking the request.
const fixturesUrlFor = (env, competition) => env[COMPETITIONS[normaliseCompetition(competition)].fixturesEnv] || null;

export const competitionConfigured = (env, competition) => !!fixturesUrlFor(env, competition);

async function fixtures(env, competition = DEFAULT_COMPETITION, fresh = false) {
  const code = normaliseCompetition(competition);
  const cache = cacheFor(code);
  const now = Date.now();
  if (!fresh && cache.list && now - cache.at < CACHE_MS) return cache.list;
  const url = fixturesUrlFor(env, code);
  if (!url) return [];
  const response = await fetch(`${url}${fresh ? `?t=${now}` : ""}`, { cf: { cacheTtl: fresh ? 0 : 60 } });
  if (!response.ok) throw new Error(`fixture fetch ${response.status}`);
  const body = await response.json();
  const resultStore = await currentResults(env, code);
  cache.list = (body.fixtures || []).map((match) => mergeResultOverlay(match, resultStore[match.id]));
  cache.intel = {
    teams: body.teams && typeof body.teams === "object" ? body.teams : {},
    modelVersion: body.modelVersion || null,
  };
  cache.at = now;
  return cache.list;
}

/** The effective results map for a competition at the current migration stage. */
async function currentResults(env, competition) {
  const { stage } = await readMigration(env);
  return readResults(env, normaliseCompetition(competition), stage);
}

/** Every configured competition's fixtures, for the id-addressed endpoints. */
async function allFixtures(env, fresh = false) {
  const lists = await Promise.all(COMPETITION_CODES
    .filter((code) => competitionConfigured(env, code))
    .map((code) => fixtures(env, code, fresh)));
  return lists.flat();
}

/**
 * Every fixture a league can draw on, across all its competitions. A
 * single-competition league gets exactly what it always got.
 */
async function leagueFixtures(env, league, fresh = false) {
  const competitions = leagueCompetitions(league).filter((code) => competitionConfigured(env, code));
  const lists = await Promise.all(competitions.map((code) => fixtures(env, code, fresh)));
  return lists.flat();
}

/**
 * Results for a league, unioned across its competitions. Each competition's
 * results come from its own key; a fixture id names which one covers it, so
 * there is never any ambiguity in the union.
 */
async function leagueResults(env, league) {
  const competitions = leagueCompetitions(league);
  const maps = await Promise.all(competitions.map((code) => currentResults(env, code)));
  return Object.assign({}, ...maps);
}

/** The period a fixture falls in for this league: matchweek, or window key. */
const leaguePeriodOf = (league) => {
  const mixed = isMixedLeague(league);
  return (fixture) => periodKeyOf(fixture, mixed);
};

/**
 * Locates one fixture by id. The id names its own competition, so this is a
 * single-feed lookup rather than a scan, and an id we do not own resolves to
 * nothing at all.
 */
async function findFixture(env, fixtureId) {
  const competition = competitionOfFixture(fixtureId);
  if (!competition) return { competition: null, match: null };
  const list = await fixtures(env, competition);
  return { competition, match: list.find((item) => String(item.id) === String(fixtureId)) || null };
}

async function getFixtures(env, request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("competition");
  if (requested && !isCompetition(requested)) return json({ error: "unknown competition" }, 400, env);
  const competition = normaliseCompetition(requested);
  const list = await fixtures(env, competition, url.searchParams.get("refresh") === "1");
  const cache = cacheFor(competition);
  return json({
    ok: true,
    competition,
    competitionName: COMPETITIONS[competition].name,
    fixtures: list,
    teams: cache.intel.teams,
    modelVersion: cache.intel.modelVersion,
    settlement: "manual",
  }, 200, env);
}

// GET /ics/<matchId>[?pick=2-1] — one fixture as a calendar event.
//
// The native app can't do a browser-style .ics download inside WKWebView, so it
// links here instead; iOS opens the URL itself and offers "Add to Calendar" off
// the back of the text/calendar content type. Deliberately not an attachment —
// a Content-Disposition download would give the user a file to manage rather
// than the add-event sheet.
async function fixtureIcs(env, url, path) {
  const matchId = decodeURIComponent(path.slice("/ics/".length));
  if (!matchId) return json({ error: "not found" }, 404, env);
  const { match } = await findFixture(env, matchId);
  if (!match) return json({ error: "not found" }, 404, env);
  const body = buildFixtureIcs(match, parsePickParam(url.searchParams.get("pick")));
  if (!body) return json({ error: "fixture has no start time" }, 409, env);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

async function uniqueRecovery(env) {
  for (let i = 0; i < 10; i++) {
    const code = makeRecovery(randomBytes);
    if (!(await kvGet(env, `recovery:${code}`))) return code;
  }
  throw new Error("could not allocate recovery code");
}

async function ensureUser(env, uid, nickname) {
  const user = (await kvGet(env, `user:${uid}`)) || { nickname: "", leagues: [] };
  if (nickname) user.nickname = normNick(nickname);
  if (!user.recovery) {
    user.recovery = await uniqueRecovery(env);
    await kvPut(env, `recovery:${user.recovery}`, uid);
  }
  await kvPut(env, `user:${uid}`, user);
  return user;
}

async function members(env, league) {
  const code = String(league.code || "").toUpperCase();
  const found = new Map();
  if (code && env.KV.list) {
    let cursor;
    do {
      const page = await env.KV.list({ prefix: leagueMemberPrefix(code), cursor });
      const rows = await Promise.all(page.keys.map(async (key) => {
        const value = await kvGet(env, key.name);
        const uid = key.name.slice(leagueMemberPrefix(code).length);
        return value ? { uid, ...value } : null;
      }));
      for (const row of rows) {
        if (row?.uid) found.set(row.uid, {
          uid: row.uid,
          nick: row.nick || "Anon",
          since: row.since || row.joinedAt || 0,
        });
      }
      cursor = page.cursor;
      if (page.list_complete) break;
    } while (cursor);
  }
  for (const uid of league.members || []) {
    if (found.has(uid)) continue;
    const user = await kvGet(env, `user:${uid}`);
    found.set(uid, {
      uid,
      nick: league.names?.[uid] || user?.nickname || "Anon",
      since: league.joinedAt?.[uid] || 0,
    });
  }
  return [...found.values()].sort((a, b) => (a.since || 0) - (b.since || 0) || a.nick.localeCompare(b.nick));
}

async function allPicks(env, ids) {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await kvGet(env, `picks:${id}`)) || {}])));
}

/**
 * The competitions a player actually plays, from their own league list.
 *
 * Costs one user read plus one read per league, and saves scanning every
 * fixture of a competition they have nothing in — which for a Premier League
 * player is 552 pointless KV reads on the Championship.
 */
async function userCompetitions(env, uid) {
  const user = await kvGet(env, `user:${uid}`);
  const codes = [...new Set(user?.leagues || [])];
  if (!codes.length) return [DEFAULT_COMPETITION];
  const leagues = await Promise.all(codes.map((code) => kvGet(env, `league:${code}`)));
  const competitions = [...new Set(leagues.filter(Boolean).map(leagueCompetition))];
  return competitions.length ? competitions : [DEFAULT_COMPETITION];
}

async function userPicks(env, uid) {
  if (!uid) return {};
  // A player's picks span every competition they play in — but only those. This
  // endpoint runs on every launch, so scanning a competition they have no
  // league in would be the chattiest per-user read in the whole app.
  const competitions = (await userCompetitions(env, uid)).filter((code) => competitionConfigured(env, code));
  const lists = await Promise.all(competitions.map((code) => fixtures(env, code)));
  const matchList = lists.flat();
  const picksByMatch = await allPicks(env, matchList.map((match) => match.id));
  return Object.fromEntries(Object.entries(picksByMatch)
    .map(([matchId, matchPicks]) => [matchId, matchPicks[uid]])
    .filter(([, pick]) => pick && pick.p1 != null && pick.p2 != null)
    .map(([matchId, pick]) => [matchId, { p1: pick.p1, p2: pick.p2, savedAt: pick.ts || Date.now() }]));
}

async function createLeague(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return json({ error: "uid required" }, 400, env);
  const user = await ensureUser(env, uid, body.nickname);
  let code;
  do code = makeCode(randomBytes); while (await kvGet(env, `league:${code}`));
  const name = String(body.name || "Saturday Super 6").trim().slice(0, 40);
  const setup = readLeagueSetup(env, body);
  if (setup.error) return json({ error: setup.error }, 400, env);
  const now = Date.now();
  await kvPut(env, `league:${code}`, {
    code, name, owner: uid,
    ...setup.record,
    createdAt: now,
  });
  if (setup.record.fixtureMode === "limited") await updateCustomMixIndex(env, code, true);
  await kvPut(env, leagueMemberKey(code, uid), { nick: user.nickname || "Anon", since: now });
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  return json({
    ok: true, code, name,
    ...setup.record,
    // Kept for older clients that still read a single competition string.
    competition: setup.record.competitions[0],
    customMix: setup.record.fixtureMode === "limited",
    recovery: user.recovery,
  }, 200, env);
}

/**
 * POST /league/weekly-rule — the host switches between picking each week and a
 * set-and-forget rule, at any time. Only the rule changes: periods already
 * published keep the slate they were published with, because members hold picks
 * against them.
 */
async function setWeeklyRule(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league host can change the weekly rule" }, 403, env);
  const validated = validateWeeklyRule(body.weeklyRule, leagueCompetitions(league));
  if (validated.error) return json({ error: validated.error }, 400, env);
  league.weeklyRule = validated.rule;
  // The legacy fields are kept in step so an older client reading this record
  // still sees a coherent league, but the rule is now the authority.
  league.fixtureMode = validated.rule.method === "allEligible" || validated.rule.method === "allCompetition"
    ? "all"
    : "limited";
  league.fixtureLimit = league.fixtureMode === "limited" ? validated.rule.count : null;
  await kvPut(env, `league:${code}`, league);
  await updateCustomMixIndex(env, code, league.fixtureMode === "limited");
  return json({ ok: true, code, weeklyRule: validated.rule }, 200, env);
}

/**
 * Validates the competition set and fixture plan a host submitted.
 *
 * At least one competition is required and both are allowed. `fixtureMode` is
 * an explicit stored intent: "all" plays the whole pool, "limited" plays a
 * fixed number the host chose. Neither is ever inferred from absence.
 */
function readLeagueSetup(env, body) {
  const requested = Array.isArray(body.competitions)
    ? body.competitions
    : body.competition != null ? [body.competition] : [DEFAULT_COMPETITION];
  const unknown = requested.find((code) => !isCompetition(code));
  if (unknown != null) return { error: "unknown competition" };
  const competitions = [...new Set(requested.map(String))];
  if (!competitions.length) return { error: "choose at least one competition" };
  const unavailable = competitions.find((code) =>
    code !== DEFAULT_COMPETITION && !competitionConfigured(env, code));
  if (unavailable) return { error: `${COMPETITIONS[unavailable].name} is not available yet` };

  // Legacy clients send customMix instead of a fixture mode.
  const requestedMode = body.fixtureMode != null
    ? String(body.fixtureMode)
    : body.customMix === true ? "limited" : "all";
  if (!FIXTURE_MODES.includes(requestedMode)) {
    return { error: `fixtureMode must be ${FIXTURE_MODES.join(" or ")}` };
  }
  let fixtureLimit = null;
  if (requestedMode === "limited" && body.fixtureLimit != null) {
    const limit = Number(body.fixtureLimit);
    if (!Number.isInteger(limit) || limit < MIN_FIXTURE_COUNT || limit > MAX_FIXTURE_COUNT) {
      return { error: `fixtureLimit must be a whole number between ${MIN_FIXTURE_COUNT} and ${MAX_FIXTURE_COUNT}` };
    }
    fixtureLimit = limit;
  }
  // COMPETITION_CODES order keeps the stored array stable regardless of the
  // order the client happened to tick the boxes in.
  const ordered = COMPETITION_CODES.filter((code) => competitions.includes(code));

  // The wizard's third step. A client that doesn't send one (an older build) is
  // a host who picks each week, with whatever count they set — which is exactly
  // what the legacy read boundary would have inferred anyway.
  const submitted = body.weeklyRule ?? {
    method: requestedMode === "limited" ? "manual" : "allEligible",
    competitionScope: defaultScopeFor(ordered),
    count: fixtureLimit ?? undefined,
  };
  const rule = validateWeeklyRule(submitted, ordered);
  if (rule.error) return { error: rule.error };
  return {
    record: {
      competitions: ordered,
      fixtureMode: requestedMode,
      fixtureLimit,
      weeklyRule: rule.rule,
    },
  };
}

// Hosts can turn Custom Mix on (or back off) after the league exists. Existing
// slates are never touched — `hadSlates` keeps already-played weeks scored on
// the slate they were actually played on.
async function setCustomMix(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  if (typeof body.enabled !== "boolean") return json({ error: "enabled must be true or false" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league host can change custom matchweek picks" }, 403, env);
  league.customMix = body.enabled;
  league.fixtureMode = body.enabled ? "limited" : "all";
  if (!body.enabled) league.fixtureLimit = null;
  await kvPut(env, `league:${code}`, league);
  await updateCustomMixIndex(env, code, body.enabled);
  return json({ ok: true, code, customMix: body.enabled, fixtureMode: league.fixtureMode }, 200, env);
}

/**
 * How a period is named to members. A window league counts its own weeks —
 * "Week 11" — matching the app exactly; a single-competition league keeps its
 * official matchweek. If the week ordering isn't to hand the date range is
 * still true, so it falls back to that rather than to "Week null".
 */
const periodLabelFor = (league, period, weekNo = null) => {
  if (!isMixedLeague(league)) return `Matchweek ${period}`;
  return weekNo == null ? `your week of ${windowLabel(period)}` : `Week ${weekNo}`;
};

const periodTitleFor = (league, period, weekNo = null) => {
  if (!isMixedLeague(league)) return `Matchweek ${period}`;
  return weekNo == null ? `Your week of ${windowLabel(period)}` : `Week ${weekNo}`;
};

/** Rejects a period that isn't shaped like one for this league. */
function readPeriod(league, body) {
  const period = String(body.period ?? body.matchweek ?? "").trim();
  if (!period) return { error: "period required" };
  if (!isMixedLeague(league)) {
    const matchweek = Number(period);
    if (!Number.isInteger(matchweek) || matchweek < 1) return { error: "matchweek required" };
  }
  return { period };
}

/**
 * Writes a published slate and tells the league. The one place a slate becomes
 * final, so publishing from the picker, from a set-and-forget rule and from the
 * fallback all snapshot the same things and all announce the same way.
 *
 * Idempotent by construction: it refuses to write over a slate that is already
 * published, so a background job that runs twice publishes once. `expected`
 * carries the record the caller read, and a mismatch means somebody else got
 * there first.
 */
async function publishSlate(env, league, period, { fixtureIds, mode, ruleSource, setBy, pool, weekNo = null, announce = true }) {
  const code = league.code;
  const existing = await kvGet(env, slateKey(code, period));
  if (isPublishedSlate(existing)) return { published: false, reason: "alreadyPublished", slate: normaliseSlate(existing) };
  if (!canAdvanceSlate(existing, "published")) {
    return { published: false, reason: "notAdvanceable", slate: normaliseSlate(existing) };
  }
  const now = new Date().toISOString();
  const snapshot = buildSlateSnapshot(fixtureIds, pool, period, ruleSource);
  const slate = {
    status: "published",
    version: 1,
    mode,
    fixtureIds,
    periodKey: String(period),
    ruleSource,
    snapshot,
    lockedAt: now,
    publishedAt: now,
    setBy: setBy || null,
    // The chain starts here. Every later amendment appends; nothing rewrites.
    versions: [{
      version: 1, fixtureIds, mode, ruleSource, snapshot,
      publishedAt: now, setBy: setBy || null, changed: null,
    }],
  };
  await kvPut(env, slateKey(code, period), slate);
  if (!league.hadSlates) {
    league.hadSlates = true;
    await kvPut(env, `league:${code}`, league);
  }
  if (!announce) return { published: true, slate };
  const memberList = await members(env, league);
  const audience = memberList.filter((member) => member.uid !== setBy).map((member) => member.uid);
  const label = periodLabelFor(league, period, weekNo);
  const who = setBy ? hostNick(memberList, league) : league.name;
  const body = setBy
    ? `${who} has set ${fixtureIds.length} fixtures for ${label}. Make your picks!`
    : `${fixtureIds.length} fixtures are live for ${label} in ${league.name}. Make your picks!`;
  await pushToUids(env, audience, body);
  return { published: true, slate };
}

/**
 * Amends a published line-up. Appends a version rather than rewriting one, so
 * what the league was asked to predict at any point stays on the record.
 *
 * Refused outright once the latest version has locked — Ashton's rule: the
 * first kickoff of that version freezes it, with no grace window and no
 * override. Members hold picks against fixtures that are under way.
 */
async function amendSlate(env, league, period, { fixtureIds, mode, setBy, pool, weekNo = null }) {
  const code = league.code;
  const existing = await kvGet(env, slateKey(code, period));
  if (!isPublishedSlate(existing)) return { amended: false, reason: "notPublished" };

  const lockAt = slateLockAt(existing, pool);
  if (slateIsLocked(existing, Date.now(), pool)) {
    return { amended: false, reason: "locked", lockAt, slate: normaliseSlate(existing) };
  }

  const delta = slateDelta(existing.fixtureIds, fixtureIds);
  if (isEmptyDelta(delta)) {
    return { amended: false, reason: "unchanged", slate: normaliseSlate(existing), delta };
  }

  const next = appendSlateVersion(existing, {
    fixtureIds,
    mode,
    ruleSource: "host-amend",
    snapshot: buildSlateSnapshot(fixtureIds, pool, period, "host-amend"),
    setBy,
  });
  await kvPut(env, slateKey(code, period), next);

  // One push per committed amendment, deduped on league + period + version so
  // a retry cannot double-notify.
  const memberList = await members(env, league);
  await pushOnce(
    env,
    `amend-v${next.version}`,
    code,
    period,
    memberList.filter((member) => member.uid !== setBy).map((member) => member.uid),
    { title: "Line-up updated", body: `${league.name}: ${describeDelta(delta)} — update your picks before kick-off.` }
  );
  return { amended: true, slate: next, delta, lockAt: slateLockAt(next, pool), weekNo };
}

/** "2 fixtures added, 1 removed" — the delta as a member reads it. */
function describeDelta(delta) {
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (delta.added.length) parts.push(`${count(delta.added.length, "fixture")} added`);
  if (delta.removed.length) parts.push(`${count(delta.removed.length, "fixture")} removed`);
  return parts.join(", ");
}

// POST /league/slate — the host's working copy, and the moment it goes live.
//
// `action` is the lifecycle step: "draft" saves the host's selection so the
// picker can be reopened, and may be rewritten as often as they like; "publish"
// (the default, and what every older client sends) freezes it, snapshots it and
// tells the league. Publishing is one-way — a later write to that period is a
// 409, because members already hold picks against it.
async function setSlate(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league host can set the fixtures" }, 403, env);
  const action = String(body.action || "publish");
  if (!["draft", "publish"].includes(action)) return json({ error: "action must be draft or publish" }, 400, env);

  // A mixed league keys on its own week window; a single-competition league
  // still keys on the official matchweek number, so existing slates are intact.
  const read = readPeriod(league, body);
  if (read.error) return json({ error: read.error }, 400, env);
  const { period } = read;

  const existing = await kvGet(env, slateKey(code, period));
  const matchList = await leagueFixtures(env, league);
  const byPeriod = poolByPeriod(matchList, league);
  const pool = byPeriod.get(period) || [];
  const weekNo = weekNumberOf(period, orderedPeriods(byPeriod));
  // The single validation path: floor one, ceiling the pool. The league's own
  // count is what the picker OPENS on — it is never a cap on the week the host
  // actually publishes, whatever rule the league normally runs on. A host who
  // opens the picker and takes six from a full-card league has overridden the
  // rule for that week, deliberately, and that is allowed.
  const bounds = { min: Math.min(MIN_FIXTURE_COUNT, pool.length), max: pool.length };
  const mode = String(body.mode || "custom");
  const validated = validateSlate(mode, body.fixtureIds, pool, bounds);
  if (validated.error) return json({ error: validated.error }, 400, env);

  // A published line-up can still be edited, right up to the first kickoff of
  // its latest version — an amendment appends a version rather than rewriting
  // one. After that moment it is frozen, and this is where that is enforced.
  if (isPublishedSlate(existing)) {
    if (action === "draft") {
      return json({ error: "this week is already published; edit the line-up instead", slate: normaliseSlate(existing) }, 409, env);
    }
    const amended = await amendSlate(env, league, period, {
      fixtureIds: validated.fixtureIds, mode, setBy: uid, pool, weekNo,
    });
    if (amended.reason === "locked") {
      return json({
        error: "the first fixture has kicked off — this week's line-up is final",
        lockAt: amended.lockAt ? new Date(amended.lockAt).toISOString() : null,
        slate: amended.slate,
      }, 409, env);
    }
    if (amended.reason === "unchanged") {
      return json({ ok: true, unchanged: true, code, period, slate: amended.slate }, 200, env);
    }
    if (!amended.amended) {
      return json({ error: "this matchweek's fixtures are already set", slate: amended.slate }, 409, env);
    }
    return json({
      ok: true, amended: true, code, period, matchweek: Number(period) || null,
      slate: amended.slate, changed: amended.delta,
      lockAt: amended.lockAt ? new Date(amended.lockAt).toISOString() : null,
    }, 200, env);
  }

  if (action === "draft") {
    const draft = {
      status: "draft",
      mode,
      fixtureIds: validated.fixtureIds,
      periodKey: String(period),
      ruleSource: "host-draft",
      savedAt: new Date().toISOString(),
      setBy: uid,
    };
    await kvPut(env, slateKey(code, period), draft);
    return json({ ok: true, code, period, matchweek: Number(period) || null, slate: draft }, 200, env);
  }

  const result = await publishSlate(env, league, period, {
    fixtureIds: validated.fixtureIds,
    mode,
    ruleSource: "host",
    setBy: uid,
    pool,
    weekNo,
  });
  if (!result.published) {
    return json({ error: "this matchweek's fixtures are already set", slate: result.slate }, 409, env);
  }
  return json({ ok: true, code, period, matchweek: Number(period) || null, slate: result.slate }, 200, env);
}

// Account deletion, and with it host succession: a league never ends up ownerless.
// Authority passes to the longest-standing remaining member (the member list is
// already ordered by join time), who is told they are now the host.
async function deleteAccount(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return json({ error: "uid required" }, 400, env);
  const user = await kvGet(env, `user:${uid}`);
  const codes = [...new Set(user?.leagues || [])];
  const succession = [];
  const closed = [];
  for (const code of codes) {
    const league = await kvGet(env, `league:${code}`);
    if (!league) continue;
    const remaining = (await members(env, league)).filter((member) => member.uid !== uid);
    await env.KV.delete(leagueMemberKey(code, uid));
    if (league.owner !== uid) continue;
    if (!remaining.length) {
      await env.KV.delete(`league:${code}`);
      await updateCustomMixIndex(env, code, false);
      closed.push(code);
      continue;
    }
    const heir = remaining[0];
    league.owner = heir.uid;
    league.members = (league.members || []).filter((entry) => entry !== uid);
    await kvPut(env, `league:${code}`, league);
    succession.push({ code, name: league.name, uid: heir.uid, nick: heir.nick });
  }
  if (user?.recovery) await env.KV.delete(`recovery:${user.recovery}`);
  await env.KV.delete(`push:${uid}`);
  await env.KV.delete(`user:${uid}`);
  for (const entry of succession) {
    await pushToUids(env, [entry.uid], `You're now the host of ${entry.name} — you pick the fixtures each matchweek.`);
  }
  return json({
    ok: true,
    uid,
    closed,
    succession: succession.map(({ code, uid: heirUid, nick }) => ({ code, owner: heirUid, nick })),
  }, 200, env);
}

async function joinLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  const user = await ensureUser(env, uid, body.nickname);
  const existing = await kvGet(env, leagueMemberKey(code, uid));
  await kvPut(env, leagueMemberKey(code, uid), {
    nick: user.nickname || existing?.nick || "Anon",
    since: existing?.since || league.joinedAt?.[uid] || Date.now(),
  });
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  return json({ ok: true, code, name: league.name, recovery: user.recovery }, 200, env);
}

async function deleteLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league owner can delete it" }, 403, env);
  const memberList = await members(env, league);
  await Promise.all(memberList.map(async ({ uid: memberUid }) => {
    const user = await kvGet(env, `user:${memberUid}`);
    if (!user?.leagues?.includes(code)) return;
    user.leagues = user.leagues.filter((entry) => entry !== code);
    await kvPut(env, `user:${memberUid}`, user);
  }));
  await Promise.all(memberList.map(({ uid: memberUid }) => env.KV.delete(leagueMemberKey(code, memberUid))));
  if (env.KV.list) {
    const slateKeys = await listAllKeys(env, `custom_slate:${code}:`);
    await Promise.all(slateKeys.map((key) => env.KV.delete(key)));
  }
  await updateCustomMixIndex(env, code, false);
  await env.KV.delete(`league:${code}`);
  return json({ ok: true, code }, 200, env);
}

async function kickMember(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  const memberUid = String(body.memberUid || "").trim();
  if (!uid || !code || !memberUid) return json({ error: "uid, code and memberUid required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league owner can remove members" }, 403, env);
  if (memberUid === league.owner) return json({ error: "the owner cannot be removed" }, 400, env);
  const existing = await kvGet(env, leagueMemberKey(code, memberUid));
  const legacyMember = (league.members || []).includes(memberUid);
  if (!existing && !legacyMember) return json({ error: "member not found" }, 404, env);
  league.members = (league.members || []).filter((entry) => entry !== memberUid);
  if (league.names) delete league.names[memberUid];
  if (league.joinedAt) delete league.joinedAt[memberUid];
  const user = await kvGet(env, `user:${memberUid}`);
  if (user?.leagues?.includes(code)) {
    user.leagues = user.leagues.filter((entry) => entry !== code);
  }
  await Promise.all([
    kvPut(env, `league:${code}`, league),
    env.KV.delete(leagueMemberKey(code, memberUid)),
    user ? kvPut(env, `user:${memberUid}`, user) : Promise.resolve(),
  ]);
  return json({ ok: true, code, removed: memberUid }, 200, env);
}

async function updateLeagueNick(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  if (!String(body.nick || "").trim()) return json({ error: "nick required" }, 400, env);
  const nick = normNick(body.nick);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  const existing = await kvGet(env, leagueMemberKey(code, uid));
  const legacyMember = (league.members || []).includes(uid);
  if (!existing && !legacyMember) return json({ error: "member not found" }, 404, env);
  const since = existing?.since || league.joinedAt?.[uid] || Date.now();
  await kvPut(env, leagueMemberKey(code, uid), { nick, since });
  // A legacy names[] override would otherwise shadow the member row.
  if (league.names && Object.prototype.hasOwnProperty.call(league.names, uid)) {
    delete league.names[uid];
    await kvPut(env, `league:${code}`, league);
  }
  return json({ ok: true, code, uid, nick }, 200, env);
}

async function restore(env, body) {
  const recovery = normRecovery(body.code);
  const uid = await kvGet(env, `recovery:${recovery}`);
  if (!uid) return json({ error: "recovery code not found" }, 404, env);
  const user = await kvGet(env, `user:${uid}`);
  return json({ ok: true, uid, nickname: user?.nickname || "", leagues: user?.leagues || [], recovery, picks: await userPicks(env, uid) }, 200, env);
}

async function getMe(env, url) {
  const uid = url.searchParams.get("uid") || "";
  const user = uid ? await kvGet(env, `user:${uid}`) : null;
  return json(user ? { uid, nickname: user.nickname, leagues: user.leagues || [], recovery: user.recovery } : { uid, leagues: [] }, 200, env);
}

async function getUserPicks(env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (!uid) return json({ error: "uid required" }, 400, env);
  return json({ uid, picks: await userPicks(env, uid) }, 200, env);
}

async function savePick(env, body) {
  const uid = String(body.uid || "").trim();
  const matchId = String(body.matchId || "").trim();
  const p1 = Number(body.p1);
  const p2 = Number(body.p2);
  if (!uid || !matchId) return json({ error: "uid and matchId required" }, 400, env);
  // The id names its competition; anything unnamespaced is not ours to store.
  if (!competitionOfFixture(matchId)) return json({ error: "match not found" }, 404, env);
  let match;
  try { ({ match } = await findFixture(env, matchId)); }
  catch { return json({ error: "cannot verify match start; pick not saved" }, 503, env); }
  if (!match) return json({ error: "match not found" }, 404, env);
  if (!match.player1 || !match.player2) return json({ error: "players not confirmed" }, 403, env);
  if (!validFootballScore(p1, p2)) return json({ error: "invalid football score" }, 400, env);
  if (matchLocked(match, Date.now()))
    return json({ error: "predictions are locked" }, 403, env);
  if (!match.startAt) {
    return json({ error: "fixture start information is unavailable; pick not saved" }, 503, env);
  }
  await ensureUser(env, uid, body.nickname);
  const picks = (await kvGet(env, `picks:${matchId}`)) || {};
  picks[uid] = { p1, p2, ts: Date.now() };
  await kvPut(env, `picks:${matchId}`, picks);
  return json({ ok: true, matchId, p1, p2 }, 200, env);
}

async function savePushToken(env, body) {
  const uid = String(body.uid || "").trim();
  const token = String(body.token || "").trim();
  if (!uid || !token) return json({ error: "uid and token required" }, 400, env);
  await ensureUser(env, uid, body.nickname);
  const existing = await kvGet(env, `push:${uid}`);
  await kvPut(env, `push:${uid}`, {
    token,
    platform: String(body.platform || "ios").slice(0, 20),
    // Re-registering a device must not silently un-mute a competition.
    mute: Array.isArray(existing?.mute) ? existing.mute : [],
    updatedAt: Date.now(),
  });
  return json({ ok: true }, 200, env);
}

// Per-competition notification preferences. Midweek Champions League nights and
// Saturday Championship cards must never erode the Premier League core, so a
// member can mute a whole competition without losing the others.
async function setNotificationPrefs(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return json({ error: "uid required" }, 400, env);
  if (!Array.isArray(body.mute)) return json({ error: "mute must be an array of competition codes" }, 400, env);
  const unknown = body.mute.filter((code) => !isCompetition(code));
  if (unknown.length) return json({ error: `unknown competition: ${unknown[0]}` }, 400, env);
  const record = await kvGet(env, `push:${uid}`);
  if (!record) return json({ error: "no push registration for this device" }, 404, env);
  const mute = [...new Set(body.mute)];
  await kvPut(env, `push:${uid}`, { ...record, mute, updatedAt: Date.now() });
  return json({ ok: true, uid, mute }, 200, env);
}

async function getNotificationPrefs(env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (!uid) return json({ error: "uid required" }, 400, env);
  const record = await kvGet(env, `push:${uid}`);
  return json({
    uid,
    registered: !!record?.token,
    mute: Array.isArray(record?.mute) ? record.mute : [],
    competitions: COMPETITION_CODES
      .filter((code) => competitionConfigured(env, code))
      .map((code) => ({ code, name: COMPETITIONS[code].name })),
  }, 200, env);
}

// Migration control surface. Secret-gated, and deliberately not wired to any
// automatic trigger: a stage only ever runs because somebody asked for it.
async function migrationAdmin(env, body) {
  if (!env.MIGRATION_SECRET || body.secret !== env.MIGRATION_SECRET) {
    return json({ error: "forbidden" }, 403, env);
  }
  if (body.action === "status") return json({ ok: true, ...(await readMigration(env)) }, 200, env);
  if (body.action === "rollback") return json({ ok: true, ...(await rollback(env)) }, 200, env);
  if (body.action !== "run") return json({ error: "action must be status, run or rollback" }, 400, env);
  try {
    const result = await runStage(env, String(body.stage || ""), { commit: body.commit === true });
    clearFixtureCache();
    return json({ ok: true, ...result }, 200, env);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 400, env);
  }
}

// A draft is the host's private working copy: it is reported so their own
// picker can reopen on it, but it is never presented as this week's slate.
const publicSlate = (slate, period, pool = null) => {
  if (!slate || !isPublishedSlate(slate)) return null;
  const lockAt = slateLockAt(slate, pool);
  const chain = slateVersions(slate);
  return {
    period,
    matchweek: Number(period) || null,
    status: slateStatus(slate),
    mode: slate.mode,
    fixtureIds: slate.fixtureIds,
    count: slate.fixtureIds.length,
    ruleSource: slate.ruleSource || null,
    setBy: slate.setBy || null,
    lockedAt: slate.lockedAt || null,
    publishedAt: slate.publishedAt || null,
    amendedAt: slate.amendedAt || null,
    snapshot: slate.snapshot || null,
    // The version chain, so the app can offer "Edit line-up" and say when the
    // line-up stops being editable.
    version: slateVersion(slate),
    versionCount: chain.length,
    changed: chain[chain.length - 1]?.changed || null,
    lockAt: lockAt == null ? null : new Date(lockAt).toISOString(),
    locked: lockAt != null && Date.now() >= lockAt,
  };
};

const publicDraft = (slate, period) => (isDraftSlate(slate) ? {
  period,
  status: "draft",
  mode: slate.mode,
  fixtureIds: slate.fixtureIds,
  count: slate.fixtureIds.length,
  savedAt: slate.savedAt || null,
} : null);

/**
 * What the picker opens on for a period.
 *
 * Two different kinds of carry-over, and they are not the same thing:
 *
 * - Within the period, the host's own DRAFT carries actual fixtures. Those are
 *   re-validated against the pool as it stands now, because a fixture can be
 *   postponed — or, in a mixed league, rescheduled clean out of the window —
 *   between saving a draft and coming back to it. Anything that has gone is
 *   returned as explicitly `unavailable` with a reason rather than silently
 *   dropped from the selection.
 * - Across periods, last week's SETTINGS carry: the count the host actually
 *   played, not its fixtures, which by definition belong to a week that is over.
 */
async function pickerPreload(env, league, period, pool, stored) {
  const bounds = effectiveFixtureCount(league, pool.length);
  const base = { min: bounds.min, max: bounds.max, poolSize: pool.length };
  const withCount = (count) => Math.max(bounds.min, Math.min(count, bounds.max));
  if (isPublishedSlate(stored)) {
    return { ...base, count: withCount(stored.fixtureIds.length), source: "published", fixtureIds: stored.fixtureIds, unavailable: [] };
  }
  if (isDraftSlate(stored)) {
    const carried = preloadSelection(stored.fixtureIds, pool);
    return { ...base, count: bounds.default, source: "draft", ...carried };
  }
  const empty = { ...base, count: bounds.default, source: "none", fixtureIds: [], unavailable: [] };
  if (!slateAware(league)) return empty;
  const slates = await readSlates(env, league.code);
  const earlier = Object.keys(slates)
    .filter((key) => comparePeriods(key, period) < 0)
    .sort(comparePeriods)
    .pop();
  if (!earlier) return empty;
  return {
    ...base,
    count: withCount(slates[earlier].fixtureIds.length),
    source: "lastWeek",
    from: earlier,
    fixtureIds: [],
    unavailable: [],
  };
}

async function state(env, url) {
  const code = String(url.searchParams.get("code") || "").toUpperCase();
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  const competitions = leagueCompetitions(league);
  const mixed = isMixedLeague(league);
  const plan = leagueFixturePlan(league);
  const keyOf = leaguePeriodOf(league);
  // Each competition's fixtures already carry their own results, so the union
  // below is a union of results:PL and results:ELC by construction.
  const matchList = await leagueFixtures(env, league);
  const memberList = await members(env, league);
  const picks = await allPicks(env, matchList.map((match) => match.id));
  const completed = matchList
    .map((match) => ({
      id: match.id,
      startMs: Date.parse(match.lockAt || match.startAt) || 0,
      result: normaliseResult(match),
      voided: isVoided(match),
      matchday: match.matchday,
      period: keyOf(match),
    }))
    .filter((match) => match.result || match.voided);

  const rule = leagueWeeklyRule(league);
  const identity = {
    competitions,
    competitionNames: competitions.map((entry) => COMPETITIONS[entry].name),
    mixed,
    weeklyRule: { method: rule.method, competitionScope: rule.competitionScope, count: rule.count },
    weeklyRuleSource: rule.source,
    setAndForget: isSetAndForget(rule),
    fixtureMode: plan.mode,
    fixtureLimit: plan.limit,
    // Retained for clients that predate the competitions array.
    competition: competitions[0],
    competitionName: COMPETITIONS[competitions[0]].name,
    customMix: plan.mode === "limited",
  };

  const byPeriod = poolByPeriod(matchList, league);
  const periodParam = url.searchParams.get("period") ?? url.searchParams.get("md");
  if (periodParam != null && String(periodParam).trim()) {
    const period = String(periodParam).trim();
    const stored = slateAware(league) ? await kvGet(env, slateKey(code, period)) : null;
    const slate = isPublishedSlate(stored) ? stored : null;
    const pool = byPeriod.get(period) || [];
    const roundFixtures = slateFixtures(slate, pool);
    const scoped = applySlates(completed.filter((match) => match.period === period),
      slate ? { [period]: slate } : {});
    const table = computeTable(memberList, scoped, picks).map((row, index) => ({ ...row, rank: index + 1 }));
    return json({
      code,
      name: league.name,
      owner: league.owner,
      ...identity,
      period,
      matchday: Number(period) || null,
      windowLabel: mixed ? windowLabel(period) : null,
      poolSize: pool.length,
      slate: publicSlate(slate, period, pool),
      draft: publicDraft(stored, period),
      preload: await pickerPreload(env, league, period, pool, stored),
      table,
      status: roundStatus(roundFixtures),
      complete: roundComplete(roundFixtures),
      winners: roundWinners(memberList, roundFixtures, picks),
      podium: computePodium(memberList, roundFixtures, picks),
    }, 200, env);
  }

  const slates = slateAware(league) ? await readSlates(env, code) : {};
  const scopedFixtures = applySlates(matchList.map((match) => ({ ...match, period: keyOf(match) })), slates);
  const scopedCompleted = applySlates(completed, slates);
  const wins = computeRoundWins(memberList, matchList, picks, slates, keyOf);
  const unplayed = scopedFixtures.filter((match) => match.period != null && !normaliseResult(match) && !isVoided(match));
  // "Current" is the earliest period still to be played. Window keys sort
  // chronologically as strings; matchweek numbers need numeric comparison —
  // comparePeriods is the shared ordering the period abstraction exposes.
  const currentPeriod = unplayed.length
    ? [...new Set(unplayed.map((match) => match.period))].sort(comparePeriods)[0]
    : null;
  const currentFixtures = currentPeriod == null ? [] : scopedFixtures.filter((match) => match.period === currentPeriod);
  const currentPool = currentPeriod == null ? [] : (byPeriod.get(currentPeriod) || []);
  const currentStored = currentPeriod != null && slateAware(league)
    ? await kvGet(env, slateKey(code, currentPeriod))
    : null;
  // The CURRENT period's slate is read directly rather than taken from the
  // listing above. KV.list is eventually consistent — it can lag a write by up
  // to a minute — and a host who has just published must not be told their
  // league is still waiting on them, nor be offered the picker again. The
  // listing is still right for every settled week, which is all the scoring
  // paths below use it for.
  const currentPublished = isPublishedSlate(currentStored)
    ? currentStored
    : (currentPeriod == null ? null : slates[currentPeriod] || null);
  const viewer = url.searchParams.get("uid") || "";
  return json({
    code,
    name: league.name,
    owner: league.owner,
    ...identity,
    currentPeriod,
    currentMatchday: currentPeriod == null ? null : (Number(currentPeriod) || null),
    currentWindowLabel: mixed && currentPeriod ? windowLabel(currentPeriod) : null,
    currentPoolSize: currentPool.length,
    currentFixtureCount: effectiveFixtureCount(league, currentPool.length),
    currentMatchdayStatus: currentPeriod == null ? "complete" : roundStatus(currentFixtures),
    currentMatchdayHasResults: currentFixtures.some((match) => !!normaliseResult(match)),
    currentSlate: currentPeriod == null ? null : publicSlate(currentPublished, currentPeriod, currentPool),
    currentDraft: currentPeriod == null ? null : publicDraft(currentStored, currentPeriod),
    // The launch decision tree turns on exactly this: is there a published
    // slate for the current period, or is the league still waiting on one?
    awaitingPublish: currentPeriod != null && !currentPublished,
    table: computeTableWithMovement(memberList, scopedCompleted, picks).map((row) => ({ ...row, wins: wins[row.uid] || 0 })),
    reveals: buildReveals(memberList, scopedFixtures, picks, Date.now()).slice(0, 20),
    cabinet: viewer ? computeCabinet(viewer, memberList, matchList, picks, slates, keyOf) : null,
  }, 200, env);
}

async function settle(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET) return json({ error: "forbidden" }, 403, env);
  if (!body.results || typeof body.results !== "object") return json({ error: "results object required" }, 400, env);
  // Settlement is competition-aware: each fixture id names the competition its
  // result belongs to, and a batch is written to those keys and no others.
  const matchList = await allFixtures(env, true);
  const validIds = new Set(matchList.map((match) => match.id));
  const touched = new Set();
  for (const matchId of Object.keys(body.results)) {
    const competition = competitionOfFixture(matchId);
    if (!competition) return json({ error: `fixture id is not namespaced: ${matchId}` }, 400, env);
    if (!validIds.has(matchId)) return json({ error: `unknown fixture: ${matchId}` }, 400, env);
    touched.add(competition);
  }
  const stores = Object.fromEntries(await Promise.all([...touched].map(async (competition) =>
    [competition, { ...(await currentResults(env, competition)) }])));
  for (const [matchId, overlay] of Object.entries(body.results)) {
    const next = stores[competitionOfFixture(matchId)];
    if (overlay === null) {
      delete next[matchId];
      continue;
    }
    const normalised = normaliseResult(overlay);
    const status = String(overlay?.status || (normalised ? "complete" : "")).toLowerCase();
    if (!normalised && !["postponed", "cancelled", "abandoned"].includes(status)) {
      return json({ error: `invalid result for fixture: ${matchId}` }, 400, env);
    }
    next[matchId] = {
      status,
      result: normalised ? [normalised.p1, normalised.p2] : null,
      lockAt: overlay.lockAt || new Date().toISOString(),
    };
  }
  const written = {};
  for (const [competition, next] of Object.entries(stores)) {
    // resultsWriteKey throws if anything ever resolves to the legacy key.
    await kvPut(env, resultsWriteKey(competition), next);
    clearFixtureCache(competition);
    written[resultsKey(competition)] = Object.keys(next).length;
  }
  return json({
    ok: true,
    competitions: [...touched],
    written,
    matches: Object.values(stores).reduce((total, store) => total + Object.keys(store).length, 0),
    settlement: "manual",
  }, 200, env);
}

async function listAllKeys(env, prefix) {
  const names = [];
  let cursor;
  for (;;) {
    const page = await env.KV.list({ prefix, cursor });
    names.push(...page.keys.map((key) => key.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return names;
}

async function stats(env, url) {
  if (!env.STATS_SECRET || url.searchParams.get("secret") !== env.STATS_SECRET) return json({ error: "forbidden" }, 403, env);
  const [userKeys, leagueKeys, pickKeys] = await Promise.all([
    listAllKeys(env, "user:"),
    listAllKeys(env, "league:"),
    listAllKeys(env, "picks:"),
  ]);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const pickMaps = await Promise.all(pickKeys.map((key) => kvGet(env, key)));
  let picksSaved = 0;
  const activeUsers = new Set();
  for (const map of pickMaps) {
    if (!map || typeof map !== "object") continue;
    for (const [uid, pick] of Object.entries(map)) {
      picksSaved++;
      if (pick && Number(pick.ts) >= weekAgo) activeUsers.add(uid);
    }
  }
  return json({
    ok: true,
    users: userKeys.length,
    leagues: leagueKeys.length,
    picks: picksSaved,
    activeUsers: activeUsers.size,
  }, 200, env);
}

const NOTIFIED_TTL_S = 2 * 24 * 60 * 60;

const kickoffTime = (startAt) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })
    .format(new Date(startAt));

/** A member can mute a whole competition: push:<uid>.mute = ["ELC", ...]. */
const mutes = (record, competition) =>
  Array.isArray(record?.mute) && record.mute.includes(competition);

async function notifyKickoffs(env) {
  if (!apnsConfigured(env)) return;
  const now = Date.now();
  const matchList = await allFixtures(env);
  const notified = await env.KV.list({ prefix: "notified:" });
  const notifiedIds = new Set(notified.keys.map((key) => key.name.slice("notified:".length)));
  const pending = fixturesNeedingNotification(matchList, notifiedIds, now);
  if (!pending.length) return;

  const pushKeys = await env.KV.list({ prefix: "push:" });
  const tokens = (await Promise.all(pushKeys.keys.map(async (key) => {
    const record = await kvGet(env, key.name);
    return record?.token ? { uid: key.name.slice("push:".length), token: record.token, record } : null;
  }))).filter(Boolean);

  for (const match of pending) {
    const competition = competitionOfFixture(match.id) || DEFAULT_COMPETITION;
    const body = `⚽ ${match.player1} v ${match.player2} kicks off at ${kickoffTime(match.startAt)} — lock in your prediction!`;
    const payload = { aps: { alert: body, sound: "default" } };
    const audience = tokens.filter(({ record }) => !mutes(record, competition));
    await Promise.all(audience.map(async ({ uid, token }) => {
      try {
        const response = await sendPush(token, payload, env);
        if (response.status === 410) await env.KV.delete(`push:${uid}`);
      } catch { /* transient APNs failure; retried next cron tick */ }
    }));
    await env.KV.put(`notified:${match.id}`, "1", { expirationTtl: NOTIFIED_TTL_S });
  }
}

// A host who never answers must not ambush their league with a full card two
// hours before kick-off, so the fallback runs a clear day out: once the next
// matchweek is inside 24 hours and still has no slate, the whole card unlocks
// and every member is told.
const FALLBACK_LEAD_MS = 24 * 60 * 60 * 1000;
const SLATE_NOTICE_TTL_S = 60 * 24 * 60 * 60;
const PODIUM_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PLACE_EMOJI = { gold: "🏆", silver: "🥈", bronze: "🥉" };

const kickoffMs = (match) => Date.parse(match.startAt || match.lockAt) || Infinity;
const byKickoff = (a, b) => kickoffMs(a) - kickoffMs(b) || String(a.id).localeCompare(String(b.id));
const fixtureLabel = (match) => (match ? `${match.player1} v ${match.player2}` : "a fixture");

// The next matchweek to kick off. Schedule-driven rather than results-driven so
// a lingering postponement in an earlier week can't stall the host reminder.
// `open` is the next matchweek to kick off — reminder and fallback territory.
// `live` is anything already under way but not yet settled, where a fixture can
// still be postponed out of a slate members are actively picking.
function relevantPeriods(byPeriod, nowMs) {
  let open = null;
  const live = [];
  // The league's own week ordering, so a push can say "Week 11" rather than
  // reciting the dates.
  const ordered = orderedPeriods(byPeriod);
  for (const [period, list] of byPeriod) {
    const first = Math.min(...list.map(kickoffMs));
    if (!Number.isFinite(first)) continue;
    const entry = { period, matchweek: Number(period) || null, firstKickoff: first, fixtures: list };
    if (first > nowMs) {
      if (!open || first < open.firstKickoff) open = entry;
      continue;
    }
    if (roundComplete(list)) continue;
    // A week nobody has played for a fortnight is done with, whatever a stray
    // unsettled fixture says — don't re-read its slate on every tick forever.
    if (Math.max(...list.map(kickoffMs)) < nowMs - PODIUM_LOOKBACK_MS) continue;
    live.push(entry);
  }
  return { open, live, ordered };
}

/**
 * One push per league, per period, per kind. Every weekly-loop notification
 * goes through here, so "we already told them" is one rule rather than one per
 * call site — which is what makes a cron tick that runs twice harmless.
 */
async function pushOnce(env, pushType, leagueId, periodKey, uids, body) {
  const key = `notified:${pushType}:${leagueId}:${periodKey}`;
  if (await env.KV.get(key)) return false;
  await env.KV.put(key, "1", { expirationTtl: SLATE_NOTICE_TTL_S });
  await pushToUids(env, uids, body);
  return true;
}

/**
 * The host nudge when a period's pool opens.
 *
 * The copy splits on what the league actually runs on. A single-competition
 * league has a real matchweek number and is told it; a mixed league runs on a
 * window and has no number to give, so naming one would be a lie.
 */
async function remindHost(env, league, period, weekNo = null) {
  const body = isMixedLeague(league)
    ? `Set this week's fixtures for ${league.name}`
    : `Matchweek ${period} is open — set your fixtures`;
  void weekNo;   // the mixed copy deliberately says "this week", not a number
  await pushOnce(env, "slate-open", league.code, period, [league.owner], body);
}

/**
 * Resolves what a league publishes for one period without its host.
 *
 * Since v1.5j every league created in the app is `manual`: the host picks and
 * publishes each week, and if they don't, this deals them a random N from the
 * competitions they chose — competition-balanced in a mixed league, exactly as
 * the picker's dice does. N is the league's own weekly count, so a league that
 * plays six gets six, and a count at or above the pool takes the whole card.
 *
 * The other methods are no longer offered at creation but remain valid in the
 * data model, so leagues that already carry one keep behaving as they did.
 */
function resolveRuleSelection(rule, league, period, pool) {
  const scope = new Set(scopeCompetitions(rule, league));
  const scoped = pool.filter((match) => scope.has(competitionOfFixture(match.id)));
  const ordered = [...scoped].sort(byKickoff).map((match) => String(match.id));
  if (!ordered.length) return null;
  if (rule.method === "allEligible" || rule.method === "allCompetition") {
    return { fixtureIds: ordered, mode: "full", ruleSource: rule.method };
  }
  // Both `random` and the manual fallback deal the same way. Seeded on league
  // and period, so a job that runs twice deals the identical week.
  return {
    fixtureIds: randomSelection(scoped, rule.count, `${league.code}:${period}`),
    mode: "custom",
    ruleSource: rule.method === "random" ? "random" : "fallback-random",
  };
}

/** A set-and-forget league publishes itself the moment its pool opens. */
async function autoPublish(env, league, period, pool, weekNo = null) {
  const rule = leagueWeeklyRule(league);
  const selection = resolveRuleSelection(rule, league, period, pool);
  if (!selection?.fixtureIds.length) return null;
  const result = await publishSlate(env, league, period, {
    fixtureIds: selection.fixtureIds,
    mode: selection.mode,
    ruleSource: selection.ruleSource,
    setBy: null,
    pool,
    weekNo,
    announce: false,
  });
  if (!result.published) return result;
  await pushOnce(env, "slate-published", league.code, period, (await members(env, league)).map((member) => member.uid),
    `${selection.fixtureIds.length} fixtures are live for ${periodLabelFor(league, period, weekNo)} in ${league.name}. Make your picks!`);
  return result;
}

/**
 * The safety net, a clear day before the first ELIGIBLE kickoff of the period.
 *
 * Order of precedence, and it matters:
 *   1. Already published — do nothing at all.
 *   2. A valid, non-empty draft the host saved — publish exactly that. A draft
 *      is never discarded in favour of a rule.
 *   3. Anything else (no draft, or an empty/invalid one) — a random N from the
 *      league's own competitions, N being its weekly count. An empty draft is
 *      NEVER what gets published.
 */
async function applyFallback(env, league, period, roundFixtures, weekNo = null) {
  const stored = await kvGet(env, slateKey(league.code, period));
  if (isPublishedSlate(stored)) return { published: false, reason: "alreadyPublished" };

  let selection = null;
  if (isDraftSlate(stored)) {
    const bounds = effectiveFixtureCount(league, roundFixtures.length);
    const validated = validateSlate(stored.mode === "full" ? "full" : "custom", stored.fixtureIds, roundFixtures, bounds);
    if (!validated.error && validated.fixtureIds.length) {
      selection = { fixtureIds: validated.fixtureIds, mode: stored.mode, ruleSource: "fallback-draft" };
    }
  }
  if (!selection) {
    selection = resolveRuleSelection(leagueWeeklyRule(league), league, period, roundFixtures);
  }
  if (!selection?.fixtureIds.length) return { published: false, reason: "emptyPool" };

  const result = await publishSlate(env, league, period, {
    fixtureIds: selection.fixtureIds,
    mode: selection.mode,
    // Provenance: a member looking at this week can always tell nobody chose it.
    ruleSource: `auto-published:${selection.ruleSource}`,
    setBy: null,
    pool: roundFixtures,
    weekNo,
    announce: false,
  });
  if (!result.published) return result;
  const memberList = await members(env, league);
  await pushOnce(env, "auto-published", league.code, period, memberList.map((member) => member.uid),
    `${periodTitleFor(league, period, weekNo)} in ${league.name} is set — ${selection.fixtureIds.length} fixtures are open. Get your picks in!`);
  return result;
}

/**
 * Folds a reschedule into a PUBLISHED slate. Metadata and display only: kickoff
 * times move, a fixture that has gone is marked unavailable and stops scoring,
 * and nothing is ever swapped in behind the members.
 */
async function reconcilePostponements(env, league, slate, period, roundFixtures, nowMs, weekNo = null) {
  if (!isPublishedSlate(slate)) return;
  const change = reconcileSlate(slate, roundFixtures, nowMs);
  const snapshot = refreshSnapshot(slate.snapshot, roundFixtures);
  if (!change && !snapshot) return;
  await kvPut(env, slateKey(league.code, period), {
    ...slate,
    ...(change ? { fixtureIds: change.fixtureIds } : {}),
    ...(snapshot ? { snapshot } : {}),
    revisedAt: new Date().toISOString(),
  });
  if (!change) return;  // A time change alone is display; it is not news.
  const byId = new Map(roundFixtures.map((match) => [String(match.id), match]));
  const gone = change.dropped.map((id) => fixtureLabel(byId.get(id))).join(", ");
  const memberList = await members(env, league);
  await pushToUids(env, memberList.map((member) => member.uid),
    `${gone} was postponed and no longer counts in ${league.name}. ${periodTitleFor(league, period, weekNo)} now scores ${change.fixtureIds.length} fixtures.`);
}

/**
 * The weekly loop, once per cron tick.
 *
 * For every league: nudge a manual host when the pool opens, auto-publish a
 * set-and-forget league, run the fallback a day before the first eligible
 * kickoff, and keep already-published weeks honest through reschedules. Every
 * step is idempotent — publishing refuses to overwrite a published slate and
 * every push is deduped on leagueId + periodKey + pushType — because a cron
 * tick may be delivered more than once.
 */
export async function weeklyLoop(env, nowMs = Date.now()) {
  if (!env.KV.list) return;
  // The clock is a parameter so the weekly beat can be tested against a fixed
  // point. Every boundary here — pool-open, the fallback horizon — is a
  // weekday question, and a suite that asks it of "today" answers differently
  // on a Sunday than on a Wednesday.
  const now = nowMs;
  const codes = (await listAllKeys(env, "league:")).map((key) => key.slice("league:".length));
  if (!codes.length) return;
  // Keyed by the league's competition set, so leagues sharing a set share work.
  const periodsBySet = new Map();
  for (const code of codes) {
    const league = await kvGet(env, `league:${code}`);
    if (!league?.owner || !league.code) continue;
    const setKey = leagueCompetitions(league).join("+") + (isMixedLeague(league) ? ":w" : ":m");
    if (!periodsBySet.has(setKey)) {
      const list = await leagueFixtures(env, league);
      periodsBySet.set(setKey, relevantPeriods(poolByPeriod(list, league), now));
    }
    const { open, live, ordered } = periodsBySet.get(setKey);
    for (const week of live) {
      const slate = await readPublishedSlate(env, code, week.period);
      if (slate) {
        await reconcilePostponements(env, league, slate, week.period, week.fixtures, now,
          weekNumberOf(week.period, ordered));
      }
    }
    if (!open) continue;
    const openWeekNo = weekNumberOf(open.period, ordered);
    const slate = await readPublishedSlate(env, code, open.period);
    if (slate) {
      await reconcilePostponements(env, league, slate, open.period, open.fixtures, now, openWeekNo);
      continue;
    }
    const rule = leagueWeeklyRule(league);
    // The fallback deadline is a clear day before the first ELIGIBLE kickoff of
    // this league's period — the pool it can actually draw on, not the calendar.
    if (now >= open.firstKickoff - FALLBACK_LEAD_MS) {
      await applyFallback(env, league, open.period, open.fixtures, openWeekNo);
      continue;
    }
    if (isSetAndForget(rule)) {
      // Rule leagues publish as soon as the pool is open, with no admin step.
      if (periodIsOpen(open.period, now, open.firstKickoff)) {
        await autoPublish(env, league, open.period, open.fixtures, openWeekNo);
      }
      continue;
    }
    if (periodIsOpen(open.period, now, open.firstKickoff)) await remindHost(env, league, open.period, openWeekNo);
  }
}

/**
 * Has this period's pool opened?
 *
 * A window says so itself: it opens on its own Tuesday morning. A matchweek
 * carries no calendar of its own, so it takes the opening of the week its first
 * fixture falls in — which is the same Tuesday boundary, reached a different
 * way. Without that a matchweek counts as open the moment it becomes the next
 * round to kick off, which in pre-season is weeks early: hosts were nudged and
 * set-and-forget leagues published in the middle of August for a round that
 * starts at the end of it.
 */
function periodIsOpen(period, nowMs, firstKickoffMs) {
  const opens = periodOpensAt(period)
    ?? (Number.isFinite(firstKickoffMs) ? periodOpensAt(windowKeyFor(new Date(firstKickoffMs))) : null);
  return opens == null || nowMs >= opens;
}

const podiumMessage = (league, matchweek, podium) =>
  `Matchweek ${matchweek} podium in ${league.name}: ${podium.map((entry) => `${PLACE_EMOJI[entry.place]} ${entry.nick} ${entry.pts}`).join(" · ")}`;

// One podium announcement per league per matchweek, on the existing APNs path.
// The whole sweep is skipped unless the settled-fixture count has moved since
// last time, so idle ticks cost a single KV read rather than a pick scan.
async function podiumAnnouncements(env) {
  if (!env.KV.list) return;
  const now = Date.now();
  const everything = await allFixtures(env);
  const settled = everything.filter((match) => normaliseResult(match) || isVoided(match)).length;
  if ((await kvGet(env, "sweep:settled")) === settled) return;
  const leagueKeys = await listAllKeys(env, "league:");
  if (leagueKeys.length) {
    const picks = await allPicks(env, everything.map((match) => match.id));
    const roundsByCompetition = new Map();
    for (const key of leagueKeys) {
      const league = await kvGet(env, key);
      if (!league?.code) continue;
      const competition = leagueCompetition(league);
      if (!roundsByCompetition.has(competition)) {
        const list = await fixtures(env, competition);
        roundsByCompetition.set(competition, [...fixturesByMatchweek(list).entries()].sort((a, b) => b[0] - a[0]));
      }
      const byMatchweek = roundsByCompetition.get(competition);
      const slates = slateAware(league) ? await readSlates(env, league.code) : {};
      let target = null;
      for (const [matchweek, all] of byMatchweek) {
        const roundFixtures = slateFixtures(slates[matchweek] || null, all);
        if (!roundComplete(roundFixtures)) continue;
        // Only ever announce a week that has just wrapped, so switching this on
        // mid-season can never replay the whole back catalogue.
        if (Math.max(...roundFixtures.map(kickoffMs)) < now - PODIUM_LOOKBACK_MS) break;
        target = { matchweek, roundFixtures };
        break;
      }
      if (!target) continue;
      const noticeKey = `notified:podium:${league.code}:${target.matchweek}`;
      if (await env.KV.get(noticeKey)) continue;
      const memberList = await members(env, league);
      const podium = computePodium(memberList, target.roundFixtures, picks);
      await env.KV.put(noticeKey, "1", { expirationTtl: SLATE_NOTICE_TTL_S });
      if (!podium.length) continue;
      await pushToUids(env, memberList.map((member) => member.uid), podiumMessage(league, target.matchweek, podium));
    }
  }
  await kvPut(env, "sweep:settled", settled);
}

// Auto-settlement runs once per competition, entirely independently: each pass
// reads only its own competition's fixtures and results, resolves club names
// against only that competition's map, and writes only results:<competition>.
// A foreign id in the output is treated as a bug and aborts that competition's
// write rather than being filtered — silently dropping it would hide the fault.
//
// Each competition is isolated, so a Championship feed outage cannot stop the
// Premier League settling. A competition with no configured feed (the Champions
// League, until its draw) is skipped by autoSettleResults itself.
async function autoSettle(env) {
  if (!env.FOOTBALL_DATA_TOKEN) return;
  const outcomes = [];
  for (const competition of COMPETITION_CODES) {
    if (!competitionConfigured(env, competition)) continue;
    if (!feedForCompetition(competition)) continue;
    try {
      const matchList = await fixtures(env, competition, true);
      if (!matchList.length) continue;
      const current = await currentResults(env, competition);
      const settled = await autoSettleResults(env, matchList, current, Date.now(), competition);
      if (!settled.checked || settled.settled === 0) continue;
      const foreign = Object.keys(settled.results).filter((id) => competitionOfFixture(id) !== competition);
      if (foreign.length) {
        throw new Error(`auto-settlement produced foreign fixture ids: ${foreign.slice(0, 3).join(", ")}`);
      }
      await kvPut(env, resultsWriteKey(competition), settled.results);
      clearFixtureCache(competition);
      outcomes.push({ competition, settled: settled.settled });
    } catch (error) {
      // Isolated on purpose: one competition's feed failing must not stop the
      // others. The next cron tick retries.
      outcomes.push({ competition, error: String(error?.message || error) });
    }
  }
  return outcomes;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(notifyKickoffs(env));
    ctx.waitUntil(autoSettle(env));
    ctx.waitUntil(weeklyLoop(env));
    ctx.waitUntil(podiumAnnouncements(env));
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return applyCors(new Response(null, { headers: cors(env) }), env, request);
    return applyCors(await route(request, env), env, request);
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method === "GET") {
      if (path === "/.well-known/apple-app-site-association" || path === "/apple-app-site-association") return appleAppSiteAssociation();
      if (path === "/" || path === "/health") return json({ ok: true, service: "prem-oracle-window" }, 200, env);
      if (path === "/me") return await getMe(env, url);
      if (path === "/fixtures") return await getFixtures(env, request);
      if (path === "/picks") return await getUserPicks(env, url);
      if (path === "/notification-prefs") return await getNotificationPrefs(env, url);
      if (path === "/state") return await state(env, url);
      if (path === "/stats") return await stats(env, url);
      if (path.startsWith("/ics/")) return await fixtureIcs(env, url, path);
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (path === "/league") return await createLeague(env, body);
      if (path === "/join") return await joinLeague(env, body);
      if (path === "/league/delete") return await deleteLeague(env, body);
      if (path === "/league/kick") return await kickMember(env, body);
      if (path === "/league/nick") return await updateLeagueNick(env, body);
      if (path === "/league/slate") return await setSlate(env, body);
      if (path === "/league/weekly-rule") return await setWeeklyRule(env, body);
      if (path === "/league/custom-mix") return await setCustomMix(env, body);
      if (path === "/account/delete") return await deleteAccount(env, body);
      if (path === "/restore") return await restore(env, body);
      if (path === "/pick") return await savePick(env, body);
      if (path === "/push-token") return await savePushToken(env, body);
      if (path === "/notification-prefs") return await setNotificationPrefs(env, body);
      if (path === "/admin/migration") return await migrationAdmin(env, body);
      if (path === "/settle") return await settle(env, body);
    }
    return json({ error: "not found" }, 404, env);
  } catch (error) {
    return json({ error: "server error", detail: String(error?.message || error) }, 500, env);
  }
}
