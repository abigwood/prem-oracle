import {
  buildReveals,
  computeRoundTable,
  computeRoundWins,
  computeTableWithMovement,
  fixturesNeedingNotification,
  isVoided,
  matchLocked,
  makeCode,
  makeRecovery,
  normNick,
  normRecovery,
  normaliseResult,
  roundComplete,
  roundStatus,
  roundWinners,
  validFootballScore,
} from "./logic.js";
import { apnsConfigured, sendPush } from "./apns.js";

let fixtureCache = null;
let fixtureCacheAt = 0;
const CACHE_MS = 60_000;

const cors = (env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
});
const json = (body, status, env) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(env) } });
const kvGet = (env, key) => env.KV.get(key, "json");
const kvPut = (env, key, value) => env.KV.put(key, JSON.stringify(value));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const leagueMemberPrefix = (code) => `member:${code}:`;
const leagueMemberKey = (code, uid) => `${leagueMemberPrefix(code)}${uid}`;

export function mergeResultOverlay(match, overlay) {
  if (!overlay) return match;
  const officialResult = normaliseResult(match);
  const merged = { ...match, ...overlay };
  const overlayResult = normaliseResult(merged);
  if ((officialResult || isVoided(match)) && !overlayResult && !isVoided(merged)) return match;
  return merged;
}

async function fixtures(env, fresh = false) {
  const now = Date.now();
  if (!fresh && fixtureCache && now - fixtureCacheAt < CACHE_MS) return fixtureCache;
  const response = await fetch(`${env.FIXTURES_URL}${fresh ? `?t=${now}` : ""}`, { cf: { cacheTtl: fresh ? 0 : 60 } });
  if (!response.ok) throw new Error(`fixture fetch ${response.status}`);
  const body = await response.json();
  const resultStore = (await kvGet(env, "results")) || {};
  fixtureCache = (body.fixtures || []).map((match) => {
    const persisted = resultStore[match.id];
    return mergeResultOverlay(match, persisted);
  });
  fixtureCacheAt = now;
  return fixtureCache;
}

async function getFixtures(env, request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  return json({ ok: true, fixtures: await fixtures(env, refresh), settlement: "manual" }, 200, env);
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

async function userPicks(env, uid) {
  if (!uid) return {};
  const matchList = await fixtures(env);
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
  const now = Date.now();
  await kvPut(env, `league:${code}`, {
    code, name, owner: uid,
    createdAt: now,
  });
  await kvPut(env, leagueMemberKey(code, uid), { nick: user.nickname || "Anon", since: now });
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await kvPut(env, `user:${uid}`, user);
  return json({ ok: true, code, name, recovery: user.recovery }, 200, env);
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
  let matchList;
  try { matchList = await fixtures(env); }
  catch { return json({ error: "cannot verify match start; pick not saved" }, 503, env); }
  const match = matchList.find((item) => String(item.id) === matchId);
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
  await kvPut(env, `push:${uid}`, {
    token,
    platform: String(body.platform || "ios").slice(0, 20),
    updatedAt: Date.now(),
  });
  return json({ ok: true }, 200, env);
}

async function state(env, url) {
  const code = String(url.searchParams.get("code") || "").toUpperCase();
  const league = await kvGet(env, `league:${code}`);
  if (!league) return json({ error: "league not found" }, 404, env);
  const matchList = await fixtures(env);
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
    const roundFixtures = matchList.filter((match) => match.matchday === md);
    const table = computeRoundTable(memberList, completed, picks, md).map((row, index) => ({ ...row, rank: index + 1 }));
    return json({
      code,
      name: league.name,
      owner: league.owner,
      matchday: md,
      table,
      status: roundStatus(roundFixtures),
      complete: roundComplete(roundFixtures),
      winners: roundWinners(memberList, roundFixtures, picks),
    }, 200, env);
  }

  const wins = computeRoundWins(memberList, matchList, picks);
  const unplayed = matchList.filter((match) => match.matchday != null && !normaliseResult(match) && !isVoided(match));
  const currentMatchday = unplayed.length ? Math.min(...unplayed.map((match) => match.matchday)) : null;
  const currentMatchdayFixtures = currentMatchday == null ? [] : matchList.filter((match) => match.matchday === currentMatchday);
  const currentMatchdayHasResults = currentMatchdayFixtures.some((match) => !!normaliseResult(match));
  return json({
    code,
    name: league.name,
    owner: league.owner,
    currentMatchday,
    currentMatchdayStatus: currentMatchday == null ? "complete" : roundStatus(currentMatchdayFixtures),
    currentMatchdayHasResults,
    table: computeTableWithMovement(memberList, completed, picks).map((row) => ({ ...row, wins: wins[row.uid] || 0 })),
    reveals: buildReveals(memberList, matchList, picks, Date.now()).slice(0, 20),
  }, 200, env);
}

async function settle(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET) return json({ error: "forbidden" }, 403, env);
  if (!body.results || typeof body.results !== "object") return json({ error: "results object required" }, 400, env);
  const matchList = await fixtures(env, true);
  const validIds = new Set(matchList.map((match) => match.id));
  const next = { ...((await kvGet(env, "results")) || {}) };
  for (const [matchId, overlay] of Object.entries(body.results)) {
    if (!validIds.has(matchId)) return json({ error: `unknown fixture: ${matchId}` }, 400, env);
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
  await kvPut(env, "results", next);
  fixtureCache = null;
  return json({ ok: true, matches: Object.keys(next).length, settlement: "manual" }, 200, env);
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

async function notifyKickoffs(env) {
  if (!apnsConfigured(env)) return;
  const now = Date.now();
  const matchList = await fixtures(env);
  const notified = await env.KV.list({ prefix: "notified:" });
  const notifiedIds = new Set(notified.keys.map((key) => key.name.slice("notified:".length)));
  const pending = fixturesNeedingNotification(matchList, notifiedIds, now);
  if (!pending.length) return;

  const pushKeys = await env.KV.list({ prefix: "push:" });
  const tokens = (await Promise.all(pushKeys.keys.map(async (key) => {
    const record = await kvGet(env, key.name);
    return record?.token ? { uid: key.name.slice("push:".length), token: record.token } : null;
  }))).filter(Boolean);

  for (const match of pending) {
    const body = `⚽ ${match.player1} v ${match.player2} kicks off at ${kickoffTime(match.startAt)} — lock in your prediction!`;
    const payload = { aps: { alert: body, sound: "default" } };
    await Promise.all(tokens.map(async ({ uid, token }) => {
      try {
        const response = await sendPush(token, payload, env);
        if (response.status === 410) await env.KV.delete(`push:${uid}`);
      } catch { /* transient APNs failure; retried next cron tick */ }
    }));
    await env.KV.put(`notified:${match.id}`, "1", { expirationTtl: NOTIFIED_TTL_S });
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(notifyKickoffs(env));
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET") {
        if (path === "/" || path === "/health") return json({ ok: true, service: "prem-oracle-window" }, 200, env);
        if (path === "/me") return await getMe(env, url);
        if (path === "/fixtures") return await getFixtures(env, request);
        if (path === "/picks") return await getUserPicks(env, url);
        if (path === "/state") return await state(env, url);
        if (path === "/stats") return await stats(env, url);
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (path === "/league") return await createLeague(env, body);
        if (path === "/join") return await joinLeague(env, body);
        if (path === "/league/delete") return await deleteLeague(env, body);
        if (path === "/league/kick") return await kickMember(env, body);
        if (path === "/restore") return await restore(env, body);
        if (path === "/pick") return await savePick(env, body);
        if (path === "/push-token") return await savePushToken(env, body);
        if (path === "/settle") return await settle(env, body);
      }
      return json({ error: "not found" }, 404, env);
    } catch (error) {
      return json({ error: "server error", detail: String(error?.message || error) }, 500, env);
    }
  },
};
