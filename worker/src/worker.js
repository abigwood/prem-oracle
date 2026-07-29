import {
  applySlates,
  buildFixtureIcs,
  buildReveals,
  computeCabinet,
  computePodium,
  computeRoundTable,
  computeRoundWins,
  computeTableWithMovement,
  fixturesByMatchweek,
  fixturesNeedingNotification,
  isVoided,
  matchLocked,
  makeCode,
  makeRecovery,
  normNick,
  normRecovery,
  normaliseResult,
  parsePickParam,
  reconcileSlate,
  roundComplete,
  roundStatus,
  roundWinners,
  slateFixtures,
  slateKey,
  validFootballScore,
  validateSlate,
} from "./logic.js";
import { apnsConfigured, sendPush } from "./apns.js";
import { autoSettleResults, feedForCompetition } from "./results_feed.js";
import {
  COMPETITIONS,
  COMPETITION_CODES,
  DEFAULT_COMPETITION,
  competitionOfFixture,
  isCompetition,
  leagueCompetition,
  normaliseCompetition,
  resultsKey,
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

// A league reads its slates when it is running Custom Mix, or ever has: turning
// the toggle off must never silently rewrite the history of weeks that were
// genuinely played on a curated slate. Every other league does zero extra KV
// reads and keeps exactly today's behaviour.
const slateAware = (league) => league?.customMix === true || league?.hadSlates === true;

async function readSlates(env, code, matchweeks = null) {
  if (matchweeks) {
    const rows = await Promise.all(matchweeks.map(async (matchweek) =>
      [matchweek, await kvGet(env, slateKey(code, matchweek))]));
    return Object.fromEntries(rows.filter(([, slate]) => slate));
  }
  if (!env.KV.list) return {};
  const prefix = `custom_slate:${code}:`;
  const slates = {};
  let cursor;
  for (;;) {
    const page = await env.KV.list({ prefix, cursor });
    const rows = await Promise.all(page.keys.map(async (key) =>
      [Number(key.name.slice(prefix.length)), await kvGet(env, key.name)]));
    for (const [matchweek, slate] of rows) {
      if (Number.isInteger(matchweek) && slate) slates[matchweek] = slate;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return slates;
}

async function updateCustomMixIndex(env, code, member) {
  const current = (await kvGet(env, CUSTOM_MIX_INDEX)) || [];
  const next = member ? [...new Set([...current, code])] : current.filter((entry) => entry !== code);
  if (next.length === current.length && next.every((entry, i) => entry === current[i])) return;
  await kvPut(env, CUSTOM_MIX_INDEX, next);
}

// Sends one alert to a specific set of members. Everything league-scoped rides
// the existing APNs path and the existing push:<uid> token records.
async function pushToUids(env, uids, body) {
  if (!apnsConfigured(env) || !uids?.length) return 0;
  const payload = { aps: { alert: body, sound: "default" } };
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

/** The fixtures a league actually plays. */
const leagueFixtures = (env, league, fresh = false) =>
  fixtures(env, leagueCompetition(league), fresh);

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
  const customMix = body.customMix === true;
  if (body.competition && !isCompetition(body.competition)) {
    return json({ error: "unknown competition" }, 400, env);
  }
  const competition = normaliseCompetition(body.competition);
  // The Premier League is always available; a second competition can only be
  // chosen once its feed is actually configured.
  if (competition !== DEFAULT_COMPETITION && !competitionConfigured(env, competition)) {
    return json({ error: `${COMPETITIONS[competition].name} is not available yet` }, 400, env);
  }
  const now = Date.now();
  await kvPut(env, `league:${code}`, {
    code, name, owner: uid,
    competition,
    customMix,
    createdAt: now,
  });
  if (customMix) await updateCustomMixIndex(env, code, true);
  await kvPut(env, leagueMemberKey(code, uid), { nick: user.nickname || "Anon", since: now });
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  return json({ ok: true, code, name, competition, customMix, recovery: user.recovery }, 200, env);
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
  await kvPut(env, `league:${code}`, league);
  await updateCustomMixIndex(env, code, body.enabled);
  return json({ ok: true, code, customMix: league.customMix }, 200, env);
}

// POST /league/slate — the host curates Matchweek N.
//
// `mode` is always stored explicitly: "custom" is a 6-10 fixture selection,
// "full" is a host who deliberately chose the whole card. A slate is immutable
// once set (409), because members may already hold picks against it.
async function setSlate(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  const matchweek = Number(body.matchweek);
  if (!uid || !code) return json({ error: "uid and code required" }, 400, env);
  if (!Number.isInteger(matchweek) || matchweek < 1) return json({ error: "matchweek required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  if (uid !== league.owner) return json({ error: "only the league host can set the fixtures" }, 403, env);
  if (!league.customMix) return json({ error: "custom matchweek picks are not enabled for this league" }, 400, env);
  const existing = await kvGet(env, slateKey(code, matchweek));
  if (existing) return json({ error: "this matchweek's fixtures are already set", slate: existing }, 409, env);

  const matchList = await leagueFixtures(env, league);
  const roundFixtures = matchList.filter((match) => match.matchday === matchweek);
  const mode = String(body.mode || "custom");
  const validated = validateSlate(mode, body.fixtureIds, roundFixtures);
  if (validated.error) return json({ error: validated.error }, 400, env);

  const slate = {
    mode,
    fixtureIds: validated.fixtureIds,
    lockedAt: new Date().toISOString(),
    setBy: uid,
  };
  await kvPut(env, slateKey(code, matchweek), slate);
  if (!league.hadSlates) {
    league.hadSlates = true;
    await kvPut(env, `league:${code}`, league);
  }

  const memberList = await members(env, league);
  await pushToUids(
    env,
    memberList.filter((member) => member.uid !== uid).map((member) => member.uid),
    `${hostNick(memberList, league)} has set ${slate.fixtureIds.length} fixtures for Matchweek ${matchweek}. Make your picks!`
  );
  return json({ ok: true, code, matchweek, slate }, 200, env);
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

const publicSlate = (slate, matchweek) => (slate ? {
  matchweek,
  mode: slate.mode,
  fixtureIds: slate.fixtureIds,
  count: slate.fixtureIds.length,
  setBy: slate.setBy || null,
  lockedAt: slate.lockedAt || null,
} : null);

async function state(env, url) {
  const code = String(url.searchParams.get("code") || "").toUpperCase();
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  const competition = leagueCompetition(league);
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
    }))
    .filter((match) => match.result || match.voided);

  const mdParam = url.searchParams.get("md");
  const md = mdParam == null ? null : Number(mdParam);
  if (md != null && Number.isInteger(md) && md > 0) {
    // Round view: one slate read, and only for a league that runs Custom Mix.
    const slate = slateAware(league) ? await kvGet(env, slateKey(code, md)) : null;
    const roundFixtures = slateFixtures(slate, matchList.filter((match) => match.matchday === md));
    const scoped = slate ? applySlates(completed, { [md]: slate }) : completed;
    const table = computeRoundTable(memberList, scoped, picks, md).map((row, index) => ({ ...row, rank: index + 1 }));
    return json({
      code,
      name: league.name,
      owner: league.owner,
      competition,
      competitionName: COMPETITIONS[competition].name,
      customMix: league.customMix === true,
      matchday: md,
      slate: publicSlate(slate, md),
      table,
      status: roundStatus(roundFixtures),
      complete: roundComplete(roundFixtures),
      winners: roundWinners(memberList, roundFixtures, picks),
      podium: computePodium(memberList, roundFixtures, picks),
    }, 200, env);
  }

  // Season view. Every week is scored on whatever slate it was played on, so a
  // season total accumulates across full cards and curated weeks alike.
  const slates = slateAware(league) ? await readSlates(env, code) : {};
  const scopedFixtures = applySlates(matchList, slates);
  const scopedCompleted = applySlates(completed, slates);
  const wins = computeRoundWins(memberList, matchList, picks, slates);
  const unplayed = scopedFixtures.filter((match) => match.matchday != null && !normaliseResult(match) && !isVoided(match));
  const currentMatchday = unplayed.length ? Math.min(...unplayed.map((match) => match.matchday)) : null;
  const currentMatchdayFixtures = currentMatchday == null
    ? []
    : scopedFixtures.filter((match) => match.matchday === currentMatchday);
  const currentMatchdayHasResults = currentMatchdayFixtures.some((match) => !!normaliseResult(match));
  const viewer = url.searchParams.get("uid") || "";
  return json({
    code,
    name: league.name,
    owner: league.owner,
    competition,
    competitionName: COMPETITIONS[competition].name,
    customMix: league.customMix === true,
    currentMatchday,
    currentMatchdayStatus: currentMatchday == null ? "complete" : roundStatus(currentMatchdayFixtures),
    currentMatchdayHasResults,
    currentSlate: currentMatchday == null ? null : publicSlate(slates[currentMatchday] || null, currentMatchday),
    table: computeTableWithMovement(memberList, scopedCompleted, picks).map((row) => ({ ...row, wins: wins[row.uid] || 0 })),
    reveals: buildReveals(memberList, scopedFixtures, picks, Date.now()).slice(0, 20),
    cabinet: viewer ? computeCabinet(viewer, memberList, matchList, picks, slates) : null,
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
function relevantMatchweeks(byMatchweek, nowMs) {
  let open = null;
  const live = [];
  for (const [matchweek, list] of byMatchweek) {
    const first = Math.min(...list.map(kickoffMs));
    if (!Number.isFinite(first)) continue;
    const entry = { matchweek, firstKickoff: first, fixtures: list };
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
  return { open, live };
}

async function remindHost(env, league, matchweek) {
  const key = `notified:slate-open:${league.code}:${matchweek}`;
  if (await env.KV.get(key)) return;
  await pushToUids(env, [league.owner], `Matchweek ${matchweek} is open — pick your fixtures for ${league.name}.`);
  await env.KV.put(key, "1", { expirationTtl: SLATE_NOTICE_TTL_S });
}

async function applyFallback(env, league, matchweek, roundFixtures) {
  const slate = {
    mode: "fallback",
    fixtureIds: [...roundFixtures].sort(byKickoff).map((match) => String(match.id)),
    lockedAt: new Date().toISOString(),
    setBy: null,
  };
  await kvPut(env, slateKey(league.code, matchweek), slate);
  if (!league.hadSlates) {
    league.hadSlates = true;
    await kvPut(env, `league:${league.code}`, league);
  }
  const memberList = await members(env, league);
  await pushToUids(
    env,
    memberList.map((member) => member.uid),
    `Matchweek ${matchweek} in ${league.name} is a full card — all ${slate.fixtureIds.length} fixtures are open. Get your picks in!`
  );
}

async function reconcilePostponements(env, league, slate, matchweek, roundFixtures, nowMs) {
  const change = reconcileSlate(slate, roundFixtures, nowMs);
  if (!change) return;
  await kvPut(env, slateKey(league.code, matchweek), {
    ...slate,
    fixtureIds: change.fixtureIds,
    revisedAt: new Date().toISOString(),
  });
  const byId = new Map(roundFixtures.map((match) => [String(match.id), match]));
  const gone = change.dropped.map((id) => fixtureLabel(byId.get(id))).join(", ");
  const body = change.added.length
    ? `${gone} was postponed in ${league.name} — ${change.added.map((id) => fixtureLabel(byId.get(id))).join(", ")} takes its place in Matchweek ${matchweek}.`
    : `${gone} was postponed and no longer counts in ${league.name}. Matchweek ${matchweek} now scores ${change.fixtureIds.length} fixtures.`;
  const memberList = await members(env, league);
  await pushToUids(env, memberList.map((member) => member.uid), body);
}

// Per-tick Custom Mix upkeep: remind an idle host, unlock the full card when the
// deadline arrives, and keep a live slate honest through postponements. Reads
// are proportional to the number of Custom Mix leagues, not to every league.
async function customMixMaintenance(env) {
  const codes = (await kvGet(env, CUSTOM_MIX_INDEX)) || [];
  if (!codes.length) return;
  const now = Date.now();
  // One fixture list per competition, shared by every league playing it.
  const weeksByCompetition = new Map();
  for (const code of codes) {
    const league = await kvGet(env, `league:${code}`);
    if (!league?.customMix || !league.owner) continue;
    const competition = leagueCompetition(league);
    if (!weeksByCompetition.has(competition)) {
      const list = await fixtures(env, competition);
      weeksByCompetition.set(competition, relevantMatchweeks(fixturesByMatchweek(list), now));
    }
    const { open, live } = weeksByCompetition.get(competition);
    if (!open && !live.length) continue;
    for (const week of live) {
      const slate = await kvGet(env, slateKey(code, week.matchweek));
      if (slate) await reconcilePostponements(env, league, slate, week.matchweek, week.fixtures, now);
    }
    if (!open) continue;
    const slate = await kvGet(env, slateKey(code, open.matchweek));
    if (slate) {
      await reconcilePostponements(env, league, slate, open.matchweek, open.fixtures, now);
    } else if (now >= open.firstKickoff - FALLBACK_LEAD_MS) {
      await applyFallback(env, league, open.matchweek, open.fixtures);
    } else {
      await remindHost(env, league, open.matchweek);
    }
  }
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
    ctx.waitUntil(customMixMaintenance(env));
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
