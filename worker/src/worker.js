import {
  appendSlateVersion,
  applySlates,
  buildFixtureIcs,
  buildReveals,
  buildRoundReveal,
  buildSlateSnapshot,
  canAdvanceSlate,
  computeCabinet,
  computePodium,
  computeRoundTable,
  computePodiumTotals,
  computeTable,
  computeTableWithMovement,
  withSharedRank,
  fixturesByMatchweek,
  fixturesNeedingNotification,
  isDraftSlate,
  isEmptyDelta,
  isPublishedSlate,
  isVoided,
  matchLocked,
  makeCode,
  makeRecovery,
  DEFAULT_NICK,
  normNick,
  normaliseJoinNick,
  normRecovery,
  normaliseResult,
  normaliseSlate,
  parsePickParam,
  preloadSelection,
  randomSelection,
  reconcileSlate,
  refreshSnapshot,
  earliestUnplayedPeriod,
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
import { NotifyLedger, utcDay } from "./notify/ledger.js";
import { LeagueRegistrar } from "./league_registrar.js";
import {
  dueFixtures, planWindow, slateFixtureKey, slateFixturePrefix,
} from "./notify/planner.js";
import { deliverJob } from "./notify/consumer.js";
import {
  verify as verifySlateIndex, repair as repairSlateIndex,
  cleanupOrphans as cleanupOrphanSlates, CleanupRefused,
} from "./notify/backfill.js";
import { RETRY_DELAY_S as NOTIFY_RETRY_DELAY_S } from "./notify/ledger.js";
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
const json = (body, status, env, extraHeaders = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(env), ...extraHeaders } });

/**
 * A revision for a fixture list: it changes when anything a client would draw
 * changes, and not otherwise. Clients put it in the URL, so a changed feed
 * busts every cache at once while an unchanged one stays a hit.
 */
function fixtureRevision(list) {
  let hash = 2166136261;
  const bite = (text) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  };
  bite(String(list.length));
  for (const match of list) {
    bite(String(match.id));
    bite(String(match.status || ""));
    bite(String(match.startAt || ""));
    bite(String(match.result ? match.result.join("-") : ""));
  }
  return (hash >>> 0).toString(36);
}
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

/**
 * The published-slate reverse index: slatefx:<fixtureId>:<leagueCode>.
 *
 * One key per (fixture, league) pair, written only by the league that owns the
 * slate — so concurrent publishes touch disjoint keys and cannot lose each
 * other's updates. Discovery reads the league code out of the KEY NAME, so
 * finding "who published this fixture" costs a list and no value reads at all.
 *
 * It is a DISCOVERY HINT and never an authority: the consumer re-reads the real
 * slate before sending, so a stale entry costs a wasted job, never a wrong send.
 */
async function syncSlateFixtureIndex(env, code, { added = [], removed = [], period }) {
  if (!env.KV) return;
  const value = JSON.stringify({ period: String(period) });
  await Promise.all([
    // The period goes in the METADATA as well as the value. KV.list returns
    // metadata, so the planner learns which period each league published this
    // fixture in without a value read per league — which is the difference
    // between "per league = 0 reads" being true and being a wish.
    ...added.map((id) => env.KV.put(slateFixtureKey(String(id), code), value,
      { metadata: { period: String(period) } })),
    ...removed.map((id) => env.KV.delete(slateFixtureKey(String(id), code))),
  ]);
}

/**
 * Every league whose published slate lists this fixture, with the period it
 * published in — from ONE list, reading key names and metadata only.
 *
 * A key without metadata predates the metadata-carrying writes and is skipped
 * rather than chased with a value read: the backfill's verify pass reports
 * those, and the ship gate refuses to open while any remain.
 */
async function leaguesForFixture(env, fixtureId) {
  if (!env.KV?.list) return [];
  const prefix = slateFixturePrefix(String(fixtureId));
  const found = [];
  let cursor;
  for (;;) {
    const page = await env.KV.list({ prefix, cursor });
    for (const key of page.keys) {
      const period = key.metadata?.period;
      if (period == null) continue;
      found.push({ code: key.name.slice(prefix.length), period: String(period) });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return found.sort((a, b) => a.code.localeCompare(b.code));
}

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
  const fresh = url.searchParams.get("refresh") === "1";
  const list = await fixtures(env, competition, fresh);
  const cache = cacheFor(competition);
  const revision = fixtureRevision(list);
  // 467KB was re-downloaded on every launch and every three-minute tick,
  // because the client cache-busted the URL and the response carried no
  // caching policy at all. Five minutes of freshness with a day of
  // stale-while-revalidate makes a launch a cache hit; the revision in the URL
  // is what lands a changed feed promptly rather than waiting out max-age.
  const headers = fresh
    ? { "cache-control": "no-store" }
    : { "cache-control": "public, max-age=300, stale-while-revalidate=86400", etag: `W/"${revision}"` };
  return json({
    ok: true,
    competition,
    competitionName: COMPETITIONS[competition].name,
    revision,
    fixtures: list,
    teams: cache.intel.teams,
    modelVersion: cache.intel.modelVersion,
    settlement: "manual",
  }, 200, env, headers);
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

// Crash-idempotent account creation. The selected recovery code is PERSISTED in
// the user record BEFORE its recovery lookup is published, so a crash between the
// two repairs the missing lookup for the already-chosen code on retry rather than
// minting a second one — and an unowned mapping is never left, because the user
// record (carrying the code) is always written first. Existing users and codes
// are preserved byte-for-byte.
async function ensureUser(env, uid, nickname) {
  const user = (await kvGet(env, `user:${uid}`)) || { nickname: "", leagues: [] };
  let dirty = false;
  if (nickname) {
    const n = normNick(nickname);
    if (user.nickname !== n) { user.nickname = n; dirty = true; }
  }
  if (!user.recovery) { user.recovery = await uniqueRecovery(env); dirty = true; }
  if (dirty) await kvPut(env, `user:${uid}`, user);      // persist the selection first
  if ((await kvGet(env, `recovery:${user.recovery}`)) !== uid) {
    await kvPut(env, `recovery:${user.recovery}`, uid);  // publish or repair the lookup
  }
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
  // The registrar is the authority on which memberships are LIVE: a provisional
  // (not-yet-activated) join and a released (torn-down) member are hidden from
  // ordinary reads even if their KV row still exists, so a provisional row is
  // never shown and no late write can resurrect a torn-down member (Slice A/B).
  if (registrarEnabled(env) && found.size) {
    try {
      const { hide } = await registrarCall(env, code, "classify", { uids: [...found.keys()] });
      for (const uid of hide || []) found.delete(uid);
    } catch { /* registrar unreachable: fall back to the KV view for this read */ }
  }
  return [...found.values()].sort((a, b) => (a.since || 0) - (b.since || 0) || a.nick.localeCompare(b.nick));
}

/** The raw set of member-row uids in KV, unfiltered by registrar liveness — for
 *  teardown, which must remove every row regardless of DO state. */
async function allMemberUids(env, code) {
  const uids = [];
  if (!(code && env.KV.list)) return uids;
  let cursor;
  do {
    const page = await env.KV.list({ prefix: leagueMemberPrefix(code), cursor });
    for (const key of page.keys) uids.push(key.name.slice(leagueMemberPrefix(code).length));
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  return uids;
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
  // Never reuse a code that is live OR has an outstanding deletion intent — a
  // reborn league must not inherit a half-purged registrar (Slice A/C).
  do code = makeCode(randomBytes);
  while ((await kvGet(env, `league:${code}`)) || (await kvGet(env, leagueIntentKey(code))));
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
  const hostNick = user.nickname || "Anon";
  await kvPut(env, leagueMemberKey(code, uid), { nick: hostNick, since: now });
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  // Seed the host's claim so the registrar is authoritative from creation. Best
  // effort: if it is unavailable the first join reconciles the host in from the
  // roster anyway, so league creation itself never fails closed (Slice A/D).
  if (registrarEnabled(env)) {
    try {
      const seed = await registrarCall(env, code, "begin", { uid, nick: hostNick, roster: [], now });
      if (seed.ok && !seed.committed) await registrarCall(env, code, "commit", { uid, norm: seed.norm, fence: seed.fence, now });
    } catch { /* reconciled from the roster on first join */ }
  }
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
  await syncSlateFixtureIndex(env, code, { added: fixtureIds, period });
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
  // The delta the amendment already computed is exactly the index delta.
  await syncSlateFixtureIndex(env, code, {
    added: delta.added, removed: delta.removed, period,
  });

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
  const intentKey = accountIntentKey(uid);
  const intent = await kvGet(env, intentKey);
  // Already fully gone and nothing outstanding: idempotent success.
  if (!user && !intent) return json({ ok: true, uid, closed: [], succession: [] }, 200, env);
  // Without atomic authority we cannot free the account's names, so we must not
  // erase it and silently skip cleanup — fail closed (Slice A/C).
  if (!registrarEnabled(env)) return teardownIncomplete(env, "account deletion");

  // The leagues to clean and the recovery to revoke come from the intent when
  // resuming (the user record may already be gone), else from the live user.
  const codes = intent?.codes ?? [...new Set(user?.leagues || [])];
  const recovery = intent?.recovery ?? user?.recovery ?? null;

  // 1 · Record the intent, carrying enough context (codes + recovery) to finish
  // every league's cleanup and revoke the credential even after the user record
  // is erased.
  await kvPut(env, intentKey, { op: "account", uid, codes, recovery, at: Date.now() });

  // 2 · Raise the DO teardown fence for this uid in EVERY league BEFORE any live
  // teardown — the atomic barrier that makes a concurrent /join or rename by
  // this uid refuse immediately in each league (Slice A/B). Fail closed if any
  // cannot; the intent lets a retry re-raise them.
  try { for (const code of codes) await registrarFenceMember(env, code, uid, "account"); }
  catch { return teardownIncomplete(env, "account deletion"); }

  // 3 · Per-league LIVE teardown — succession or closure, and drop the member
  // row. Idempotent, so a retry re-runs it harmlessly.
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

  // 4 · Release the account's name in every league — frees the name AND lifts
  // its fence. Idempotent; if any cannot complete, the intent (and the user
  // record) remain and the call is retryable.
  try { for (const code of codes) await registrarRelease(env, code, uid); }
  catch { return teardownIncomplete(env, "account deletion"); }

  // 5 · Only now erase the credential, push token and user record.
  if (recovery) await env.KV.delete(`recovery:${recovery}`);
  await env.KV.delete(`push:${uid}`);
  await env.KV.delete(`user:${uid}`);

  // 6 · Both sides done — clear the intent, then notify any new hosts.
  await env.KV.delete(intentKey);
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

/** The atomic registrar. Its ABSENCE is a broken configuration, not a mode: a
 *  named write must fail closed rather than proceed non-atomically (Slice A/A).
 *  Rollback is reverting this worker AND the config together, never deleting the
 *  binding under this code. */
const registrarEnabled = (env) => !!env.LEAGUE_REGISTRAR;

/** Operation-specific success shapes. A response that does not match one is
 *  malformed and must fail closed — an unrecognised begin or a commit with no
 *  boolean verdict cannot be trusted to mean "it worked". */
function validRegistrarShape(op, data) {
  if (!data || typeof data !== "object") return false;
  switch (op) {
    case "begin":
      // Either a refusal (taken / error) or a grant that carries the identity
      // (norm) needed to prove it is this operation's — plus a fence, unless it
      // is an already-committed idempotent grant.
      if (data.ok === false) return data.taken === true || typeof data.error === "string";
      if (data.ok !== true || typeof data.norm !== "string" || !data.norm) return false;
      return data.committed === true || typeof data.fence === "string";
    case "commit":
      // A trustworthy verdict, and on a positive verdict the identity to prove
      // it is this operation's — never a generic {ok:true}.
      if (typeof data.committed !== "boolean") return false;
      return data.committed === false || typeof data.norm === "string";
    case "release":
      return typeof data.released === "boolean";
    case "purge":
      return data.purged === true || data.ok === true;
    case "fenceMember":
    case "fenceLeague":
      return data.ok === true;
    case "classify":
      return Array.isArray(data.hide);
    case "check":
      return typeof data.available === "boolean";
    default:
      return data.ok === true;
  }
}

/** One RPC to a league's registrar instance. Throws on transport or shape
 *  failure so every caller can fail closed. */
async function registrarCall(env, code, op, args = {}) {
  const stub = env.LEAGUE_REGISTRAR.get(env.LEAGUE_REGISTRAR.idFromName(code));
  const response = await stub.fetch("https://league-registrar/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  if (!response.ok) throw new Error(`registrar ${op} failed: ${response.status}`);
  const data = await response.json();
  if (!validRegistrarShape(op, data)) throw new Error(`registrar ${op} malformed`);
  return data;
}

/** Free a member's name. NOT best-effort: throws on failure so the caller can
 *  refuse to report a final success while the release is still outstanding, and
 *  a retry (KV membership already gone) still finishes the registrar cleanup —
 *  release is idempotent on the uid. */
async function registrarRelease(env, code, uid) {
  await registrarCall(env, code, "release", { uid, now: Date.now() });
}

/** Raise the DO teardown fence for a member BEFORE their live teardown, so a
 *  concurrent begin/commit for that uid is refused atomically. Throws on
 *  failure so the caller can fail closed; idempotent, so a retry re-raises it. */
async function registrarFenceMember(env, code, uid, kind) {
  await registrarCall(env, code, "fenceMember", { uid, kind, now: Date.now() });
}

/** Raise the DO teardown fence for the whole league BEFORE its live teardown. */
async function registrarFenceLeague(env, code) {
  await registrarCall(env, code, "fenceLeague", { now: Date.now() });
}

/**
 * Commit a fenced attempt and return a TRUSTWORTHY verdict, re-reading once when
 * the first answer is missing/malformed/unavailable rather than guessing.
 *
 * commit is idempotent: an attempt that already committed re-reports committed;
 * one still validly pending commits on the re-read; a lost, expired or
 * superseded attempt reports committed:false. So a single re-read collapses the
 * common ambiguity (a lost response after an actual commit, or a transient blip)
 * into a definitive verdict. Only a persistently unreachable/garbage registrar
 * stays unknown, and then this returns null so the caller fails closed without
 * destroying a claim that may have committed (Slice A/A).
 */
async function resolveCommit(env, code, args) {
  const attempt = { uid: args.uid, norm: args.norm, fence: args.fence };
  // A verdict must be for THIS uid and name, or it does not represent our
  // operation and cannot be trusted (Slice A/D).
  const own = (verdict) => verdict && verdict.uid === args.uid && verdict.norm === args.norm ? verdict : null;
  try { const v = own(await registrarCall(env, code, "commit", { ...attempt, now: Date.now() })); if (v) return v; }
  catch { /* unknown — a safe idempotent re-read follows */ }
  try { return own(await registrarCall(env, code, "commit", { ...attempt, now: Date.now() })); }
  catch { return null; }
}

// --- resumable teardown outbox ---------------------------------------------
//
// A removal has two sides that cannot be made atomic: the live KV record
// (membership / league) and the registrar's authority over the name. If either
// side is done and the worker dies before the other, we must be able to finish
// the rest on a retry — even after the ordinary record is already gone.
//
// So every teardown first records a durable INTENT, then removes the live
// record, then releases/purges the registrar, and only clears the intent when
// BOTH sides are complete. The live record is removed BEFORE the registrar is
// touched, so a crash in between leaves the name over-reserved (safe) rather
// than a live member with no registrar authority (a duplicate waiting to
// happen). Joins and league creation refuse anything with an outstanding
// deletion intent, preferring temporary over-reservation to a duplicate.
const kickIntentKey = (code, uid) => `intent:kick:${code}:${uid}`;
const accountIntentKey = (uid) => `intent:account:${uid}`;
const leagueIntentKey = (code) => `intent:league:${code}`;

/** A retryable refusal used when a teardown cannot yet complete. */
const teardownIncomplete = (env, what) => json(
  { error: `Could not complete ${what} — please try again.`, retryable: true }, 503, env);

const registrarUnavailable = (env) => json(
  { error: "Joining is temporarily unavailable — please try again.", retryable: true }, 503, env);

async function joinLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  // A league with an outstanding deletion intent is on its way out — never let a
  // join repopulate it (Slice A/C).
  if (await kvGet(env, leagueIntentKey(code))) return json({ error: "league not found" }, 404, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);

  // Every new join needs one effective non-empty display name — nick, then the
  // legacy nickname field. A genuinely nameless request is refused with no
  // mutation: no anonymous uniqueness bypass (Slice A/B).
  const offered = String(body.nick || body.nickname || "").trim();
  if (!offered) return json({ error: "A display name is required to join." }, 400, env);

  // No atomic authority -> fail closed. A named join never proceeds without the
  // registrar; it changes nothing and is retryable (Slice A/A).
  if (!registrarEnabled(env)) return registrarUnavailable(env);

  const existing = await kvGet(env, leagueMemberKey(code, uid));
  const legacyMember = (league.members || []).includes(uid);
  const offeredNorm = normaliseJoinNick(offered);

  // /join is NOT a rename route. An existing member offering a DIFFERENT name is
  // delegated to the fenced rename operation, which restores the prior name on
  // any failure — the fresh-join path must never overwrite a live member
  // (Slice A/B). Offering the SAME name falls through to the idempotent path.
  if (existing || legacyMember) {
    const priorNorm = normaliseJoinNick(existing?.nick ?? league.names?.[uid] ?? "");
    if (priorNorm && priorNorm !== offeredNorm) {
      const renamed = await updateLeagueNick(env, { uid, code, nick: offered });
      if (renamed.status !== 200) return renamed;
      const account = await kvGet(env, `user:${uid}`);
      return json({ ok: true, code, name: league.name, recovery: account?.recovery }, 200, env);
    }
  }

  const roster = await members(env, league);

  // Phase 1 — reserve the name as a PENDING attempt, atomically. A taken name,
  // an active teardown fence, or a registrar failure/malformed answer all fail
  // closed with NOTHING written — no account, no recovery, no membership
  // (Slice A/A, A/B, A/E). The attempt's fence must be presented to commit.
  let begin;
  try { begin = await registrarCall(env, code, "begin", { uid, nick: offered, roster, now: Date.now() }); }
  catch { return registrarUnavailable(env); }
  if (begin.fenced) {
    // A teardown holds this scope: a deleted league reads as gone; a member
    // being removed is asked to retry once removal settles (Slice A/B).
    if (begin.scope === "league") return json({ error: "league not found" }, 404, env);
    return teardownIncomplete(env, "joining");
  }
  if (begin.taken) {
    return json({ error: begin.error || "That name is taken in this league", taken: true,
      suggestions: begin.suggestions || [] }, 409, env);
  }
  // The grant must be for the very uid + name we asked about (Slice A/D).
  if (!begin.ok || begin.uid !== uid || begin.norm !== offeredNorm) return registrarUnavailable(env);
  const wasMember = !!(existing || legacyMember);

  // Phase 2 — write the PROVISIONAL membership while the claim is still pending.
  // The registrar reports a not-yet-activated claim as hidden, so this row is
  // invisible to every member/state/league read until activation — and because
  // ACTIVATION (the commit) is the last authoritative step, there is no KV write
  // after it that a teardown could race (Slice A/B).
  await kvPut(env, leagueMemberKey(code, uid), {
    nick: normNick(offered),
    since: existing?.since || league.joinedAt?.[uid] || Date.now(),
  });

  // Phase 3 — ACTIVATE. commit is the single Durable-Object authority that
  // serialises final membership activation against teardown: it refuses if a
  // member/league teardown fence won first (so a membership is never activated
  // past a teardown), and if it wins the teardown that follows necessarily
  // includes this membership. Nothing is minted or made visible before this.
  //   unknown (null) after the safe re-read -> never success; the provisional
  //     row stays hidden and an identical retry converges (Slice A/A).
  //   committed:false -> a definitive loss; drop our provisional row and refuse.
  const commit = await resolveCommit(env, code, { uid, norm: begin.norm, fence: begin.fence });
  if (!commit) return registrarUnavailable(env);
  if (!commit.committed) {
    // Never delete an existing member's row; a fresh join's provisional row is
    // ours to remove (only while it is still the one we wrote).
    if (!wasMember) {
      const current = await kvGet(env, leagueMemberKey(code, uid));
      if (current && normaliseJoinNick(current.nick) === offeredNorm) await env.KV.delete(leagueMemberKey(code, uid));
    }
    if (commit.taken) {
      return json({ error: "That name is taken in this league", taken: true,
        suggestions: commit.suggestions || [] }, 409, env);
    }
    if (commit.fenced) return teardownIncomplete(env, "joining");
    return registrarUnavailable(env);
  }

  // Phase 4 — activated: the membership is now live (the registrar shows it).
  // Mint the account and recovery (crash-idempotent) and link the league. A
  // crash here leaves a live member without an account; an identical retry sees
  // begin -> already-committed and finishes this phase (Slice A/A).
  const user = await ensureUser(env, uid, body.nickname);
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  return json({ ok: true, code, name: league.name, recovery: user.recovery }, 200, env);
}

async function deleteLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  const intentKey = leagueIntentKey(code);
  const intent = await kvGet(env, intentKey);
  if (!league && !intent) return json({ error: "league not found" }, 404, env);
  // Owner authority comes from the league while it exists, else from the intent
  // recorded when the (now-removed) league was still readable.
  const owner = league ? league.owner : intent?.owner;
  if (uid !== owner) return json({ error: "only the league owner can delete it" }, 403, env);
  // Without atomic authority we cannot purge, so we must not erase the league and
  // silently skip cleanup — fail closed (Slice A/C).
  if (!registrarEnabled(env)) return teardownIncomplete(env, "deletion");

  // 1 · Record the deletion intent (owner + member uids) so a retry can finish
  // even after the league record is gone. Use the RAW KV rows, not the filtered
  // roster, so a provisional or released row is still torn down.
  const memberUids = [...new Set([...(await allMemberUids(env, code)), ...(intent?.members || [])])];
  await kvPut(env, intentKey, { op: "league", code, owner, members: memberUids, at: Date.now() });

  // 2 · Raise the DO league fence BEFORE any live teardown — the atomic barrier
  // that makes every concurrent begin (any join) refuse immediately, independent
  // of KV visibility (Slice A/B). Fail closed if it cannot; the intent lets a
  // retry re-raise it.
  try { await registrarFenceLeague(env, code); }
  catch { return teardownIncomplete(env, "deletion"); }

  // 3 · Make the league INACCESSIBLE — strip it from members, drop the member
  // rows and slates, and delete the league record. A crash here leaves the
  // registrar holding stale (orphaned) claims rather than a live league that
  // could repopulate a purged registrar; the intent lets a retry finish the
  // purge.
  await Promise.all(memberUids.map(async (memberUid) => {
    const user = await kvGet(env, `user:${memberUid}`);
    if (!user?.leagues?.includes(code)) return;
    user.leagues = user.leagues.filter((entry) => entry !== code);
    await kvPut(env, `user:${memberUid}`, user);
  }));
  await Promise.all(memberUids.map((memberUid) => env.KV.delete(leagueMemberKey(code, memberUid))));
  if (env.KV.list) {
    const slateKeys = await listAllKeys(env, `custom_slate:${code}:`);
    // Every fixture this league published stops being this league's business.
    const published = new Set();
    for (const key of slateKeys) {
      const slate = await kvGet(env, key);
      for (const id of slate?.fixtureIds || []) published.add(String(id));
    }
    await Promise.all([
      ...slateKeys.map((key) => env.KV.delete(key)),
      ...[...published].map((id) => env.KV.delete(slateFixtureKey(id, code))),
    ]);
  }
  await updateCustomMixIndex(env, code, false);
  await env.KV.delete(`league:${code}`);

  // 4 · Purge the registrar — drops every claim AND the league fence. Idempotent,
  // so a retry converges; if it cannot complete, the intent remains and the call
  // is retryable.
  try { await registrarCall(env, code, "purge"); }
  catch { return teardownIncomplete(env, "deletion"); }

  // 5 · Both sides done — clear the intent.
  await env.KV.delete(intentKey);
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
  // Without atomic authority we cannot free the name, so we must not tear the
  // membership down and silently skip cleanup — fail closed (Slice A/C).
  if (!registrarEnabled(env)) return teardownIncomplete(env, "removal");

  const intentKey = kickIntentKey(code, memberUid);
  const resuming = !!(await kvGet(env, intentKey));
  const existing = await kvGet(env, leagueMemberKey(code, memberUid));
  const legacyMember = (league.members || []).includes(memberUid);
  if (!existing && !legacyMember && !resuming) return json({ error: "member not found" }, 404, env);

  // 1 · Record the authorised removal intent (the durable retry context).
  await kvPut(env, intentKey, { op: "kick", code, uid: memberUid, at: Date.now() });

  // 2 · Raise the DO teardown fence for this member BEFORE any live teardown —
  // the atomic barrier that makes a concurrent /join or rename by this uid
  // refuse immediately, independent of KV visibility (Slice A/B). Fail closed if
  // it cannot be raised; the intent lets a retry re-raise it.
  try { await registrarFenceMember(env, code, memberUid, "kick"); }
  catch { return teardownIncomplete(env, "removal"); }

  // 3 · Remove the LIVE membership. A crash here leaves the name still reserved
  // and the fence still up (over-reservation, safe) rather than a live member
  // with no registrar authority; the intent lets a retry finish.
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

  // 4 · Release the name AND lift the fence, atomically. Idempotent, so a retry
  // after the membership is already gone still converges; if it cannot complete,
  // the intent and fence remain and the call is retryable — never a final
  // success with the release outstanding.
  try { await registrarRelease(env, code, memberUid); }
  catch { return teardownIncomplete(env, "removal"); }

  // 5 · Both sides done — clear the intent.
  await env.KV.delete(intentKey);
  return json({ ok: true, code, removed: memberUid }, 200, env);
}

// --- Admin: recovery-code reset -------------------------------------------
//
// A member who has lost BOTH their device and their recovery code is otherwise
// locked out for good — the code is the account's only credential and nothing
// stores a readable copy of it. This lets a maintainer mint them a fresh one.
// It is a RESET, never a disclosure of the old code: the old mapping is torn
// down in the same operation.
//
// Gated by its own secret (RECOVERY_ADMIN_SECRET) presented as a Bearer token,
// and idempotent on requestId so a lost response or a crash mid-way is safe to
// retry. The new code is DERIVED deterministically from (requestId, target
// uid), so a retry re-derives the same code and a second credential is
// impossible. Nothing but the recovery credential and one audit record is
// touched — picks, points, membership, nickname and history are left exactly
// as they were.
//
// KNOWN LIMITATION, inherent to the app today: this invalidates the recovery
// credential but does NOT revoke a device already signed in on the lost
// handset — device requests identify themselves by uid, with no server session
// to revoke. Resetting the code blocks new logins with the old code; it does
// not sign out a phone that is already in.

const RECOVERY_RESET_DOMAIN = "prem-oracle/recovery-reset/v1";
const RECOVERY_AUDIT_PREFIX = "recovery-reset:";
// A caller-generated UUID with valid version (1–5) and variant (8–b) nibbles,
// not merely 8-4-4-4-12 hex; and a league code in the app's own alphabet
// (makeCode: no I/O/0/1). exactNick is bounded to normNick()'s own 24, so an
// over-long value is refused rather than silently truncated into an "exact"
// match. The two free-text identifiers are length-bounded before use as keys.
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAGUE_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const MEMBER_UID_MAX = 128;
const EXACT_NICK_MAX = 24;
const EXACT_NICK_RAW_MAX = 256;
const RESUME_TAG_DOMAIN = "prem-oracle/recovery-reset-resume/v1";

/** Length-aware constant-time compare, so a wrong secret leaks no timing. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a ?? ""));
  const bb = enc.encode(String(b ?? ""));
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * The fresh code for a reset: three client-compatible words derived, not
 * randomised, from (requestId, target uid) — and KEYED BY THE ADMIN SECRET.
 *
 * HMAC-SHA-256 under RECOVERY_ADMIN_SECRET, not a plain hash, is the point: the
 * audit stores requestId and targetUid, so a plain hash of them would let
 * anyone who can read the audit recompute the live credential. Keying it by the
 * secret means the audit fields alone cannot reproduce the code. The output is
 * deterministic for a given (secret, requestId, uid), which is what makes a
 * retry idempotent and a second credential impossible while the secret holds.
 */
async function deriveRecoveryCandidate(secret, requestId, uid) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret ?? "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new TextEncoder().encode(`${RECOVERY_RESET_DOMAIN}\n${requestId}\n${uid}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return makeRecovery((n) => mac.subarray(0, n));
}

/**
 * A transient resume tag: HMAC-SHA-256 under the admin secret over a SEPARATE
 * domain and the same (requestId, uid). It is not the recovery candidate, not a
 * hash of it, and nothing that can reconstruct it — a different domain makes the
 * two HMACs independent. Stored on the started claim only, it lets a resume
 * detect a secret rotation (the recomputed tag will not match) and refuse
 * before deriving or writing any candidate. Removed at completion.
 */
async function deriveResumeTag(secret, requestId, uid) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret ?? "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${RESUME_TAG_DOMAIN}\n${requestId}\n${uid}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function recoveryReset(env, request, body) {
  const deny = (status, error) => json({ error }, status, env, { "cache-control": "no-store" });
  // Unconfigured or unauthenticated is indistinguishable from a route that is
  // not here: no hint about whether a league or member exists.
  if (!env.RECOVERY_ADMIN_SECRET) return deny(404, "not found");
  const header = request.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !safeEqual(presented, env.RECOVERY_ADMIN_SECRET)) return deny(404, "not found");

  // Past authentication, every unexpected failure is contained here and
  // answered generically — a KV error must not escape to the route catch,
  // which would drop the no-store header and echo internal detail.
  try {
    const requestId = String(body.requestId || "").trim();
    const leagueCode = String(body.leagueCode || "").trim().toUpperCase();
    const memberUid = String(body.memberUid || "").trim();
    const exactNickRaw = body.exactNick == null ? "" : String(body.exactNick);
    // Identifiers are validated and bounded before any of them is used as a key.
    if (!REQUEST_ID_RE.test(requestId)) return deny(400, "invalid requestId");
    if (!LEAGUE_CODE_RE.test(leagueCode)) return deny(400, "invalid leagueCode");
    if (memberUid.length > MEMBER_UID_MAX) return deny(400, "invalid memberUid");
    if (exactNickRaw.length > EXACT_NICK_RAW_MAX) return deny(400, "invalid exactNick");
    const exactNick = exactNickRaw.trim();
    // Bounded to normNick()'s own 24: an over-long nick is refused, never
    // truncated into a match it was not.
    if (exactNick.length > EXACT_NICK_MAX) return deny(400, "invalid exactNick");
    if (!memberUid && !exactNick) return deny(400, "memberUid or exactNick required");

    const league = await kvGet(env, `league:${leagueCode}`);
    if (!league) return deny(404, "target not found");

    // Resolution is bounded to THIS league's own membership enumeration,
    // through the canonical helper — no key-schema assumptions reproduced here.
    const roster = await members(env, league);
    let target = null;
    if (exactNick) {
      const want = normNick(exactNick);
      const matches = roster.filter((m) => normNick(m.nick) === want);
      if (matches.length !== 1) return deny(404, "target not found"); // unknown, or ambiguous nick
      target = matches[0];
    }
    if (memberUid) {
      const byUid = roster.find((m) => m.uid === memberUid);
      if (!byUid) return deny(404, "target not found");
      if (target && target.uid !== byUid.uid) return deny(409, "uid and nickname disagree");
      target = byUid;
    }
    const uid = target.uid;

    // The account must genuinely exist and be coherent for restore — a
    // credential is reset, never invented or reconstructed. It must carry the
    // named league, and its current code, if any, must actually be its own.
    const user = await kvGet(env, `user:${uid}`);
    if (!user || typeof user !== "object") return deny(409, "target account is not restorable");
    if (!Array.isArray(user.leagues) || !user.leagues.includes(leagueCode)) {
      return deny(409, "target account is not restorable");
    }
    const currentCode = user.recovery || null;
    if (currentCode) {
      const owner = await kvGet(env, `recovery:${currentCode}`);
      if (owner && owner !== uid) return deny(409, "target credential is inconsistent");
    }

    // Idempotency: the audit record, keyed by requestId, is also the claim. A
    // second call with the same requestId but a different target is refused.
    const auditKey = `${RECOVERY_AUDIT_PREFIX}${requestId}`;
    const prior = await kvGet(env, auditKey);
    if (prior && (prior.leagueCode !== leagueCode || prior.targetUid !== uid)) {
      return deny(409, "requestId already used for a different target");
    }
    // The started claim's timestamp is stable across every resume and the
    // completion; only the run that finishes stamps completedAt.
    const startedAt = (prior && prior.startedAt) || new Date().toISOString();

    const candidate = await deriveRecoveryCandidate(env.RECOVERY_ADMIN_SECRET, requestId, uid);
    // OWNERSHIP CHECK ON EVERY ATTEMPT — initial, resume and replay. A crash
    // right after the claim could let another account come to own the candidate
    // before the retry; writing over it would be a takeover.
    const holder = await kvGet(env, `recovery:${candidate}`);
    if (holder && holder !== uid) {
      return deny(409, "candidate collides with another account; retry with a new requestId");
    }

    const identity = {
      action: "recovery-reset", route: "/admin/recovery-reset", requestId,
      leagueCode, targetUid: uid, targetNick: target.nick, actor: "recovery-admin",
    };
    const success = (replayed) => json(
      { ok: true, requestId, leagueCode, memberUid: uid, recovery: candidate, replayed },
      200, env, { "cache-control": "no-store" });

    if (prior && prior.status === "completed") {
      // A completed replay is clean ONLY if the freshly derived candidate still
      // matches the account. A rotated secret makes it not — refuse rather than
      // mint a fresh, second credential. Both timestamps are left as they were.
      if (holder === uid && candidate === currentCode) return success(true);
      return deny(409, "operation cannot be replayed after a credential change");
    }
    if (prior) {
      // An incomplete op is resumed. Recompute the resume tag under the CURRENT
      // secret and constant-time compare it to the one stored at claim time,
      // BEFORE deriving or writing any candidate. A mismatch means the secret
      // was rotated since — refuse with zero mutation, which closes the window
      // where a crash between the mapping write and completion could otherwise
      // leave a second live credential.
      const tag = await deriveResumeTag(env.RECOVERY_ADMIN_SECRET, requestId, uid);
      if (!prior.resumeTag || !safeEqual(tag, prior.resumeTag)) {
        return deny(409, "operation cannot be safely resumed after a credential change");
      }
    } else {
      if (candidate === currentCode) {
        return deny(409, "candidate collides with the current code; retry with a new requestId");
      }
      // The started claim — written before any credential change — carries the
      // transient resume tag, and makes a same-requestId-different-target reuse
      // fail even across a crash.
      const resumeTag = await deriveResumeTag(env.RECOVERY_ADMIN_SECRET, requestId, uid);
      await kvPut(env, auditKey, { ...identity, status: "started", startedAt, resumeTag });
    }

    // Idempotent, crash-safe order — every step tolerates having run before.
    // New mapping first, so the account is reachable by the fresh code before
    // the old one is removed; no ordering leaves it unreachable.
    await kvPut(env, `recovery:${candidate}`, uid);
    // Remove the old mapping only if it is real, not the candidate, and still
    // this uid's — so a resume never deletes the new code or a mapping not ours.
    if (currentCode && currentCode !== candidate) {
      const owner = await kvGet(env, `recovery:${currentCode}`);
      if (owner === uid) await env.KV.delete(`recovery:${currentCode}`);
    }
    // Only the recovery field changes; every other byte carries through.
    if (user.recovery !== candidate) {
      user.recovery = candidate;
      await kvPut(env, `user:${uid}`, user);
    }
    // Finalise: required fields only — no resumeTag, no derivation material —
    // preserving the original startedAt and stamping completion.
    await kvPut(env, auditKey, { ...identity, status: "completed", startedAt, completedAt: new Date().toISOString() });

    return success(false);
  } catch {
    return deny(500, "server error");
  }
}

/**
 * The profile display name, and the leagues it should reach.
 *
 * A league nick starts as the profile name and can then be overridden per
 * league. "Anon" is not a name anybody chose — it is what the server falls back
 * to when it was told nothing — so a later profile name is allowed to replace
 * it. Anything else was chosen deliberately and is never touched.
 */
async function setProfile(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return json({ error: "uid required" }, 400, env);
  if (!String(body.nickname || "").trim()) return json({ error: "nickname required" }, 400, env);
  const nickname = normNick(body.nickname);
  const user = (await kvGet(env, `user:${uid}`)) || { nickname: "", leagues: [] };
  user.nickname = nickname;
  if (!user.recovery) user.recovery = await uniqueRecovery(env);
  // Persist the user (with its selected recovery) BEFORE publishing the lookup,
  // so a crash repairs rather than mints a second code (crash-idempotent).
  await kvPut(env, `user:${uid}`, user);
  if ((await kvGet(env, `recovery:${user.recovery}`)) !== uid) {
    await kvPut(env, `recovery:${user.recovery}`, uid);
  }

  const updated = [];
  const kept = [];
  const unconfirmed = []; // propagations whose commit outcome is unknown
  for (const code of user.leagues || []) {
    const member = await kvGet(env, leagueMemberKey(code, uid));
    if (!member) continue;
    if (member.nick && member.nick !== DEFAULT_NICK) { kept.push(code); continue; }
    // The member is still Anon here — propagate the profile name, but only once
    // the registrar confirms it is free in this league. Without atomic authority
    // (broken config, or the name already taken) we leave the Anon row untouched
    // rather than mint a duplicate (Slice A/D, A/B).
    if (!registrarEnabled(env)) { kept.push(code); continue; }
    const league = await kvGet(env, `league:${code}`);
    const roster = league ? await members(env, league) : [];
    let claim;
    try { claim = await registrarCall(env, code, "begin", { uid, nick: nickname, roster, now: Date.now() }); }
    catch { unconfirmed.push(code); continue; }
    // A teardown fence, a taken name, or a grant for the wrong uid/name -> leave
    // the Anon row untouched; never propagate over a removal in progress
    // (Slice A/B, A/D).
    if (claim.fenced) { kept.push(code); continue; }
    if (!claim.ok || claim.taken || claim.uid !== uid || claim.norm !== normaliseJoinNick(nickname)) { kept.push(code); continue; }
    await kvPut(env, leagueMemberKey(code, uid), { ...member, nick: nickname });
    const commit = await resolveCommit(env, code, { uid, norm: claim.norm, fence: claim.fence });
    if (!commit) {
      // UNKNOWN even after a re-read: do NOT count it as propagated, and do NOT
      // restore a possibly-committed name. Leave the fenced pending + provisional
      // write so an identical retry converges, and mark the call retryable (A/A).
      unconfirmed.push(code);
      continue;
    }
    if (!commit.committed) {
      // Definitive loss — restore the Anon row, never a duplicate (Slice A/C).
      const current = await kvGet(env, leagueMemberKey(code, uid));
      if (current && normaliseJoinNick(current.nick) === claim.norm) {
        await kvPut(env, leagueMemberKey(code, uid), { ...member });
      }
      kept.push(code);
      continue;
    }
    updated.push(code);
  }
  // The profile name itself is saved (idempotently). If any propagation's commit
  // outcome is unknown, the call is retryable so the client finishes propagation
  // — never a 200 that implies a name landed when its commit was never confirmed
  // (Slice A/A).
  if (unconfirmed.length) {
    return json({ error: "Your name was saved, but syncing it to a league did not confirm — please try again.",
      retryable: true, uid, nickname, updated, kept, unconfirmed, recovery: user.recovery }, 503, env);
  }
  return json({ ok: true, uid, nickname, updated, kept, recovery: user.recovery }, 200, env);
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

  // A rename is a uniqueness contest exactly like a join, so it takes the same
  // atomic path: fail closed without the registrar, refuse a taken name with no
  // write, and only commit once the membership row carries the new name
  // (Slice A/A, A/D). Renaming to the name you already hold is idempotent.
  if (!registrarEnabled(env)) return registrarUnavailable(env);
  const roster = await members(env, league);
  const priorNick = existing?.nick ?? league.names?.[uid] ?? null;
  let begin;
  try { begin = await registrarCall(env, code, "begin", { uid, nick, roster, now: Date.now() }); }
  catch { return registrarUnavailable(env); }
  if (begin.fenced) {
    // A teardown of this member or league is in progress — refuse the rename
    // rather than write over a member being removed (Slice A/B).
    if (begin.scope === "league") return json({ error: "league not found" }, 404, env);
    return teardownIncomplete(env, "the rename");
  }
  if (begin.taken) {
    return json({ error: begin.error || "That name is taken in this league", taken: true,
      suggestions: begin.suggestions || [] }, 409, env);
  }
  // The grant must be for the very uid + name we asked about (Slice A/D).
  if (!begin.ok || begin.uid !== uid || begin.norm !== normaliseJoinNick(nick)) return registrarUnavailable(env);

  await kvPut(env, leagueMemberKey(code, uid), { nick, since });
  // A legacy names[] override would otherwise shadow the member row.
  if (league.names && Object.prototype.hasOwnProperty.call(league.names, uid)) {
    delete league.names[uid];
    await kvPut(env, `league:${code}`, league);
  }
  // Commit with our fence.
  //   committed:false -> another rename won the name (or our attempt expired):
  //     restore the member's PRIOR name so a crossed rename never leaves them
  //     holding a name they do not own, and refuse (Slice A/C). A stale roster
  //     cannot have committed a different name — reconciliation only promotes a
  //     pending claim of the SAME name (Slice A/B).
  //   unknown after a safe re-read -> do NOT report success and do NOT restore a
  //     possibly-committed rename: leave the member row on the new name and the
  //     fenced pending in place so an identical retry converges, and refuse
  //     retryably (Slice A/A).
  const commit = await resolveCommit(env, code, { uid, norm: begin.norm, fence: begin.fence });
  if (!commit) return registrarUnavailable(env);
  if (!commit.committed) {
    const current = await kvGet(env, leagueMemberKey(code, uid));
    if (current && normaliseJoinNick(current.nick) === begin.norm) {
      await kvPut(env, leagueMemberKey(code, uid), { nick: normNick(priorNick ?? DEFAULT_NICK), since });
    }
    if (commit.taken) {
      return json({ error: "That name is taken in this league", taken: true,
        suggestions: commit.suggestions || [] }, 409, env);
    }
    return registrarUnavailable(env);
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
/**
 * The slate-index backfill, behind the migration secret.
 *
 * Deliberately manual and deliberately NOT called from the cron. Every slate
 * published before the index existed has no key, so the index has to be
 * reconciled once and PROVED before the notification bindings are enabled —
 * an unverified index means some leagues silently get no reminders at all.
 *
 *   { action: "verify" }   read-only; the ship gate
 *   { action: "repair" }   writes missing keys, removes stale ones, re-verifies
 *
 * Both are resumable via `cursor` and safe to run again.
 */
async function slateIndexAdmin(env, body) {
  if (!env.MIGRATION_SECRET || body.secret !== env.MIGRATION_SECRET) {
    return json({ error: "forbidden" }, 403, env);
  }
  // A continuation is NOT merely a cursor: each direction carries a cursor, the
  // key it stopped on and how far into that slate's fixture list it got, PLUS
  // whether it has finished. Dropping the done flags is how a completed
  // direction silently restarts on the next operator request, so the whole
  // `resume` object is passed straight back in.
  //
  // `limit` and `maxOps` are clamped to server constants: a request body may
  // ask for less work, never for more.
  if (body.action === "verify") {
    // Verification is a CHAIN. It continues unless the caller explicitly
    // restarts it, and only a chain that ran from the start of both prefixes
    // can report ready.
    return json({ ok: true, ...(await verifySlateIndex(env, {
      restart: body.restart === true, at: Date.now(),
      limit: body.limit, maxOps: body.maxOps,
    })) }, 200, env);
  }
  if (body.action === "repair") {
    // Repair does NOT verify afterwards — a fresh full verification is
    // unbounded. It invalidates the chain, and the operator runs verify with
    // restart:true when the repair reports done.
    const resume = body.resume || {};
    return json({ ok: true, ...(await repairSlateIndex(env, {
      forward: resume.forward ?? null,
      reverse: resume.reverse ?? null,
      forwardDone: resume.forwardDone === true,
      reverseDone: resume.reverseDone === true,
      limit: body.limit,
      maxOps: body.maxOps,
    })) }, 200, env);
  }
  if (body.action === "cleanup-orphans") {
    // Its own action, so neither verify nor repair can reach it. What it may
    // delete is fixed in AUTHORISED_CLEANUPS at deploy time: the request names
    // an id and repeats the list, and both have to match the code before any
    // KV is touched. Nothing here can widen that — no table override is passed,
    // and there is no request field that could supply one. A refusal of the
    // whole request is a 400 and writes nothing.
    try {
      return json({ ok: true, ...(await cleanupOrphanSlates(env, {
        id: body.id,
        allow: body.allow,
        maxOps: body.maxOps,
      })) }, 200, env);
    } catch (error) {
      if (error instanceof CleanupRefused) return json({ error: String(error.message) }, 400, env);
      throw error;
    }
  }
  return json({ error: "action must be verify, repair or cleanup-orphans" }, 400, env);
}

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
  // ONE timestamp for the whole response. Gating fixture A at 14:59:59 and
  // fixture B at 15:00:00 inside the same answer would make the reveal depend
  // on how far down the list a fixture happened to sit.
  const serverNow = Date.now();
  const code = String(url.searchParams.get("code") || "").toUpperCase();
  const viewer = String(url.searchParams.get("uid") || "");
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
  const byPeriod = poolByPeriod(matchList, league);
  const periodParam = url.searchParams.get("period") ?? url.searchParams.get("md");
  const roundOnly = periodParam != null && String(periodParam).trim() !== "";

  const asCompleted = (list) => list
    .map((match) => ({
      id: match.id,
      startMs: Date.parse(match.lockAt || match.startAt) || 0,
      result: normaliseResult(match),
      voided: isVoided(match),
      matchday: match.matchday,
      period: keyOf(match),
    }))
    .filter((match) => match.result || match.voided);

  // A request for one week reads one week. It used to read a pick record for
  // every fixture in the season — 932 on a mixed league — to answer a question
  // about six of them, which is most of a 1,000-subrequest budget spent on
  // rows that get thrown away.
  const roundPeriod = roundOnly ? String(periodParam).trim() : null;
  const roundStored = roundOnly && slateAware(league)
    ? await kvGet(env, slateKey(code, roundPeriod))
    : null;
  const roundSlate = isPublishedSlate(roundStored) ? roundStored : null;
  const roundPool = roundOnly ? (byPeriod.get(roundPeriod) || []) : [];
  const roundFixtures = roundOnly ? slateFixtures(roundSlate, roundPool) : [];

  const pickIds = roundOnly
    ? [...new Set([...roundFixtures, ...roundPool].map((match) => match.id))]
    : matchList.map((match) => match.id);
  const picks = await allPicks(env, pickIds);
  const completed = asCompleted(roundOnly ? roundPool : matchList);

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

  if (roundOnly) {
    const period = roundPeriod;
    const stored = roundStored;
    const slate = roundSlate;
    const pool = roundPool;
    /**
     * Mates' Picks is ADDITIVE and nothing more.
     *
     * Released 1.6.4 clients call this endpoint without a uid at all, so an
     * unsigned or unrecognised request is a normal request — it gets the whole
     * round response it has always got, minus a field it has never seen. The
     * membership rule guards the new field; it is not a new door on the old one,
     * and it never turns a legacy call into a 403.
     */
    const viewerIsMember = !!viewer && memberList.some((member) => member.uid === viewer);
    const scoped = applySlates(completed.filter((match) => match.period === period),
      slate ? { [period]: slate } : {});
    // Ordered by the full tie-break, ranked on points alone — see withSharedRank.
    const table = withSharedRank(computeTable(memberList, scoped, picks));
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
      // Mates' Picks rides on the picks this branch has already read to score
      // the table, so the whole feature costs no additional KV read. The viewer
      // is checked against the CURRENT membership list: someone who was removed
      // is no longer in it, and never was is the same answer. Anyone else is
      // simply not sent the field — `includePicks` below is the second lock on
      // the same door, so a mistake here still cannot serialize a prediction.
      ...(viewerIsMember ? {
        reveal: buildRoundReveal({
          fixtures: roundFixtures,
          picksByMatch: picks,
          members: memberList,
          serverNow,
          includePicks: true,
        }),
      } : {}),
      // Only the answer that actually carries other people's predictions is
      // withheld from shared caches. A response without the field is the same
      // public round data it has always been, with the headers it always had.
    }, 200, env, viewerIsMember ? { "cache-control": "private, no-store" } : {});
  }

  const slates = slateAware(league) ? await readSlates(env, code) : {};
  const scopedFixtures = applySlates(matchList.map((match) => ({ ...match, period: keyOf(match) })), slates);
  const scopedCompleted = applySlates(completed, slates);
  // ONE aggregation pass. `wins` has always been the gold count, so it is
  // derived from these totals rather than walked for a second time — running
  // both was the same season twice for the same answer.
  const medals = computePodiumTotals(memberList, matchList, picks, slates, keyOf);
  // "Current" is the earliest period still to be played. Window keys sort
  // chronologically as strings; matchweek numbers need numeric comparison —
  // comparePeriods is the shared ordering the period abstraction exposes.
  const currentPeriod = earliestUnplayedPeriod(scopedFixtures, comparePeriods);
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

  // What this league is currently asking its members to predict, and what it
  // has ever stopped asking. My Predictions needs both: a pick is hidden only
  // when an amendment dropped its fixture AND no league still lists it, and
  // neither half is derivable from a slate's latest state alone — "dropped"
  // only exists in the version deltas.
  const allPublished = { ...slates };
  if (currentPeriod != null && isPublishedSlate(currentStored)) allPublished[currentPeriod] = currentStored;
  const lineupFixtureIds = [];
  const droppedFixtureIds = new Set();
  for (const slate of Object.values(allPublished)) {
    for (const id of slate.fixtureIds || []) lineupFixtureIds.push(String(id));
    for (const entry of slateVersions(slate)) {
      for (const id of entry.changed?.removed || []) droppedFixtureIds.add(String(id));
    }
  }
  const lineup = [...new Set(lineupFixtureIds)];
  // A fixture dropped and later re-added is not dropped: the league is asking
  // for it again, and the member's original pick stands.
  const dropped = [...droppedFixtureIds].filter((id) => !lineup.includes(id));
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
    lineupFixtureIds: lineup,
    droppedFixtureIds: dropped,
    table: computeTableWithMovement(memberList, scopedCompleted, picks).map((row) => ({
      ...row,
      wins: medals[row.uid]?.gold || 0,
      podiums: medals[row.uid] || { gold: 0, silver: 0, bronze: 0 },
    })),
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

/**
 * Slice 1, D2 — the planner, and the switch that decides whether it runs.
 *
 * The new path needs a queue and a Durable Object namespace. Neither exists
 * until the configuration step, which is gated on Adam's approval and a
 * read-only billing check. So the switch is the BINDINGS: with them the D2 path
 * runs, without them the worker keeps doing exactly what it does today. That is
 * X1's "degrades to current behaviour", and it means this code can land, be
 * reviewed and be tested long before any infrastructure is enabled.
 */
const notifyEnabled = (env) => !!(env.NOTIFY_QUEUE && env.NOTIFY_LEDGER);

/**
 * One RPC per call to the single global ledger object. The object is a
 * singleton by name: delivery state has to be strongly consistent across every
 * consumer, which is the whole reason it is not in KV.
 */
export function ledgerClient(env, name = "notify-ledger") {
  const stub = env.NOTIFY_LEDGER.get(env.NOTIFY_LEDGER.idFromName(name));
  // The counter is on the CLIENT, so what it reports is the number of round
  // trips that actually happened rather than the number the caller believes it
  // made. A hand-incremented tally is exactly the evidence a call-count claim
  // must not rest on.
  const calls = [];
  return {
    calls,
    count: () => calls.length,
    async call(op, args = {}) {
      calls.push(op);
      const response = await stub.fetch("https://notify-ledger/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...args }),
      });
      if (!response.ok) throw new Error(`ledger ${op} failed: ${response.status}`);
      return response.json();
    },
  };
}

/** Everything the planner and consumer need from KV, in one place. */
function notifyDeps(env, nowMs) {
  return {
    now: () => nowMs ?? Date.now(),
    ledger: () => ledgerClient(env),
    // Injected rather than imported, so a test can drive delivery outcomes
    // without reaching for module mocking.
    sendPush,
    leaguesForFixture: (fixtureId) => leaguesForFixture(env, fixtureId),
    readPicks: async (fixtureId) => (await kvGet(env, `picks:${fixtureId}`)) || {},
    readSlate: (code, period) => kvGet(env, slateKey(code, period)),
    readPush: (uid) => kvGet(env, `push:${uid}`),
    dropPushToken: (uid) => env.KV.delete(`push:${uid}`),
    isMember: async (code, uid) => !!(await kvGet(env, leagueMemberKey(code, uid))),
    /**
     * The whole membership graph, in bounded pages, ONCE per planning window.
     *
     * Listing per league is one request per league, which at a thousand
     * one-person leagues is a thousand requests to learn a thousand facts. One
     * scan of the `member:` prefix costs pages proportional to total
     * memberships instead — independent of how those memberships are
     * distributed, which is the only shape that holds however the product is
     * actually used. Key names only; no value read anywhere in it.
     */
    membershipGraph: async () => {
      const graph = new Map();
      let cursor;
      let pages = 0;
      for (;;) {
        const page = await env.KV.list({ prefix: "member:", cursor });
        pages++;
        for (const key of page.keys) {
          const rest = key.name.slice("member:".length);
          const split = rest.indexOf(":");
          if (split < 0) continue;
          const code = rest.slice(0, split);
          if (!graph.has(code)) graph.set(code, []);
          graph.get(code).push(rest.slice(split + 1));
        }
        if (page.list_complete) break;
        cursor = page.cursor;
      }
      return { graph, pages };
    },
  };
}

/**
 * The D2 planning pass. Plans, enqueues, and sends nothing itself.
 *
 * Everything that decides WHO is notified is settled here from bounded reads;
 * everything that decides whether they still SHOULD be is re-read by the
 * consumer immediately before APNs, because that is the only moment at which
 * the answer is not already stale.
 */
async function planKickoffReminders(env, nowMs = Date.now()) {
  if (!notifyEnabled(env) || !apnsConfigured(env)) return { planned: 0, jobs: 0 };
  const day = utcDay(nowMs);
  const ledger = ledgerClient(env);
  const deps = notifyDeps(env, nowMs);
  const due = dueFixtures(await allFixtures(env), nowMs);
  const result = await planWindow({
    matches: due,
    competitionOf: (match) => competitionOfFixture(match.id) || DEFAULT_COMPETITION,
    ledger, deps, now: nowMs,
  });
  for (const job of result.jobs) await env.NOTIFY_QUEUE.send(job);
  await ledger.call("sweep", { day, now: nowMs });
  return { planned: result.triples, jobs: result.jobs.length, refused: result.refused };
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
  if (change) {
    await syncSlateFixtureIndex(env, league.code, { removed: change.dropped, period });
  }
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
      // Recorded whether or not anything was written: the catch-up's page,
      // what it looked at and why it settled nothing are the diagnostics an
      // operator needs when a league is still sitting on an old week.
      if (settled.diagnostics) outcomes.push({ competition, ...settled.diagnostics });
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
  async scheduled(event, env, ctx) {
    // Cron events carry the moment they were meant to fire. Using it rather than
    // the wall clock keeps a delayed sweep judging the week it was scheduled for.
    const nowMs = event?.scheduledTime ?? Date.now();
    // One or the other, never both: the D2 planner replaces the broadcast the
    // moment its infrastructure exists, and nothing changes until it does.
    ctx.waitUntil(notifyEnabled(env) ? planKickoffReminders(env, nowMs) : notifyKickoffs(env));
    ctx.waitUntil(autoSettle(env));
    ctx.waitUntil(weeklyLoop(env, nowMs));
    ctx.waitUntil(podiumAnnouncements(env));
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return applyCors(new Response(null, { headers: cors(env) }), env, request);
    return applyCors(await route(request, env), env, request);
  },
  /**
   * The queue consumer. max_batch_size is 1, so one batch is one job and a
   * consumer batch can never exceed 45 APNs requests.
   *
   * A message is acked when nothing is still owed, and retried when something
   * is — a transient APNs failure, or a triple another consumer's live lease
   * still holds. Acking there would silently lose the reminder.
   */
  async queue(batch, env) {
    const deps = notifyDeps(env);
    for (const message of batch.messages) {
      try {
        // Cloudflare's own delivery counter: attempt 1 is a first delivery,
        // anything higher is a retry and draws from the retry read pool.
        const { ack } = await deliverJob(message.body, env, deps,
          { attempt: message.attempts ?? 1 });
        if (ack) message.ack();
        else message.retry({ delaySeconds: NOTIFY_RETRY_DELAY_S });
      } catch {
        // Fail closed: no ack, so the queue redelivers rather than losing it.
        message.retry({ delaySeconds: NOTIFY_RETRY_DELAY_S });
      }
    }
  },
};

export { NotifyLedger };
export { LeagueRegistrar };

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
      if (path === "/profile") return await setProfile(env, body);
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
      if (path === "/admin/slate-index") return await slateIndexAdmin(env, body);
      if (path === "/settle") return await settle(env, body);
      if (path === "/admin/recovery-reset") return await recoveryReset(env, request, body);
    }
    return json({ error: "not found" }, 404, env);
  } catch (error) {
    return json({ error: "server error", detail: String(error?.message || error) }, 500, env);
  }
}
