import {
  buildReveals,
  computeTableWithMovement,
  isVoided,
  matchLocked,
  makeCode,
  makeRecovery,
  normNick,
  normRecovery,
  normaliseResult,
  validFootballScore,
} from "./logic.js";

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
  const users = await Promise.all((league.members || []).map((uid) => kvGet(env, `user:${uid}`)));
  return (league.members || []).map((uid, index) => ({
    uid,
    nick: league.names?.[uid] || users[index]?.nickname || "Anon",
    since: league.joinedAt?.[uid] || 0,
  }));
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
    code, name, owner: uid, members: [uid],
    names: { [uid]: user.nickname || "Anon" },
    joinedAt: { [uid]: now },
    createdAt: now,
  });
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
  if (!league.members.includes(uid)) league.members.push(uid);
  league.names ||= {};
  league.joinedAt ||= {};
  league.names[uid] = user.nickname || "Anon";
  league.joinedAt[uid] ||= Date.now();
  user.leagues = [...new Set([...(user.leagues || []), code])];
  await Promise.all([kvPut(env, `league:${code}`, league), kvPut(env, `user:${uid}`, user)]);
  return json({ ok: true, code, name: league.name, recovery: user.recovery }, 200, env);
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
    }))
    .filter((match) => match.result || match.voided);
  return json({
    code,
    name: league.name,
    owner: league.owner,
    table: computeTableWithMovement(memberList, completed, picks),
    reveals: buildReveals(memberList, matchList, picks, Date.now()).slice(0, 20),
  }, 200, env);
}

async function settle(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET) return json({ error: "forbidden" }, 403, env);
  if (!body.results || typeof body.results !== "object") return json({ error: "results object required" }, 400, env);
  const matchList = await fixtures(env, true);
  const validIds = new Set(matchList.map((match) => match.id));
  const next = {};
  for (const [matchId, overlay] of Object.entries(body.results)) {
    if (!validIds.has(matchId)) return json({ error: `unknown fixture: ${matchId}` }, 400, env);
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

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.resolve());
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
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (path === "/league") return await createLeague(env, body);
        if (path === "/join") return await joinLeague(env, body);
        if (path === "/restore") return await restore(env, body);
        if (path === "/pick") return await savePick(env, body);
        if (path === "/settle") return await settle(env, body);
      }
      return json({ error: "not found" }, 404, env);
    } catch (error) {
      return json({ error: "server error", detail: String(error?.message || error) }, 500, env);
    }
  },
};
