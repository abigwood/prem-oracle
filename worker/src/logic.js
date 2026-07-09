export const windowState = (startMs, nowMs) =>
  Number.isFinite(startMs) && nowMs < startMs ? "open" : "shut";

export function matchLocked(match, nowMs) {
  const status = String(match?.status || "").toLowerCase();
  if (normaliseResult(match) || isVoided(match)) return true;
  if (["live", "in progress", "completed", "complete", "finished"].includes(status)) return true;
  const lockMs = Date.parse(match?.lockAt || match?.startAt);
  return Number.isFinite(lockMs) && nowMs >= lockMs;
}

export function validFootballScore(p1, p2) {
  return [p1, p2].every(Number.isInteger) && p1 >= 0 && p1 <= 9 && p2 >= 0 && p2 <= 9;
}

export function scorePick(pick, actual, voided = false) {
  if (voided || !actual || actual.p1 == null || actual.p2 == null)
    return { pts: 0, exact: false, hit: false, settled: false };
  if (!pick || pick.p1 == null || pick.p2 == null)
    return { pts: 0, exact: false, hit: false, settled: true };
  if (pick.p1 === actual.p1 && pick.p2 === actual.p2)
    return { pts: 5, exact: true, hit: true, settled: true };
  const sign = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
  const predictedOutcome = sign(pick.p1, pick.p2);
  const actualOutcome = sign(actual.p1, actual.p2);
  if (predictedOutcome === 0 && actualOutcome === 0)
    return { pts: 2, exact: false, hit: true, settled: true };
  if (predictedOutcome === actualOutcome && pick.p1 - pick.p2 === actual.p1 - actual.p2)
    return { pts: 2, exact: false, hit: true, settled: true };
  if (predictedOutcome === actualOutcome)
    return { pts: 1, exact: false, hit: true, settled: true };
  return { pts: 0, exact: false, hit: false, settled: true };
}

export function pickValid(pick, startMs) {
  return !!pick && Number.isFinite(startMs) && Number.isFinite(pick.ts) && pick.ts < startMs;
}

export function computeTable(members, completed, picksByMatch) {
  const rows = members.map((member) => {
    let pts = 0;
    let exact = 0;
    let correct = 0;
    for (const match of completed) {
      if (member.since && match.startMs < member.since) continue;
      const raw = (picksByMatch[match.id] || {})[member.uid];
      const pick = pickValid(raw, match.startMs) ? raw : null;
      const result = scorePick(pick, match.result, match.voided);
      pts += result.pts;
      if (result.exact) exact++;
      if (result.hit) correct++;
    }
    return { uid: member.uid, nick: member.nick, pts, exact, correct };
  });
  rows.sort((a, b) =>
    b.pts - a.pts || b.exact - a.exact || b.correct - a.correct || a.nick.localeCompare(b.nick)
  );
  return rows;
}

export function computeTableWithMovement(members, completed, picksByMatch) {
  const table = computeTable(members, completed, picksByMatch);
  const orderedCompleted = [...completed].sort((a, b) =>
    (a.startMs || 0) - (b.startMs || 0) || String(a.id).localeCompare(String(b.id))
  );
  if (orderedCompleted.length < 2) {
    return table.map((row, index) => ({ ...row, rank: index + 1, previousRank: null, movement: 0 }));
  }
  const previousCompleted = orderedCompleted.slice(0, -1);
  const previousRanks = new Map(computeTable(members, previousCompleted, picksByMatch).map((row, index) => [row.uid, index + 1]));
  return table.map((row, index) => {
    const rank = index + 1;
    const previousRank = previousRanks.get(row.uid) || null;
    return { ...row, rank, previousRank, movement: previousRank ? previousRank - rank : 0 };
  });
}

export function buildReveals(members, matches, picksByMatch, nowMs) {
  return matches
    .filter((match) => matchLocked(match, nowMs))
    .map((match) => {
      const parsedLock = Date.parse(match.lockAt || match.startAt);
      const startMs = Number.isFinite(parsedLock) ? parsedLock : Number.MAX_SAFE_INTEGER;
      const eligible = members.filter((member) => !member.since || startMs >= member.since);
      const stored = picksByMatch[match.id] || {};
      if (!eligible.some((member) => stored[member.uid])) return null;
      const result = normaliseResult(match);
      const voided = isVoided(match);
      return {
        matchId: match.id,
        match: `${match.player1} v ${match.player2}`,
        player1: match.player1,
        player2: match.player2,
        startAt: match.lockAt || match.startAt,
        settled: !!result && !voided,
        voided,
        result,
        picks: eligible.map((member) => {
          const raw = stored[member.uid];
          const pick = pickValid(raw, startMs) ? raw : null;
          const scored = scorePick(pick, result, voided);
          return {
            uid: member.uid,
            nick: member.nick,
            asleep: !pick,
            p1: pick?.p1 ?? null,
            p2: pick?.p2 ?? null,
            ...scored,
          };
        }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (Date.parse(b.startAt) || 0) - (Date.parse(a.startAt) || 0));
}

export function normaliseResult(match) {
  const value = match?.result;
  let result = null;
  if (Array.isArray(value) && value.length === 2) result = { p1: Number(value[0]), p2: Number(value[1]) };
  if (value && value.p1 != null && value.p2 != null) result = { p1: Number(value.p1), p2: Number(value.p2) };
  if (!result) return null;
  if (!Number.isInteger(result.p1) || !Number.isInteger(result.p2)) return null;
  if (!validFootballScore(result.p1, result.p2)) return null;
  return result;
}

export const isVoided = (match) =>
  match?.void === true || ["walkover", "retired", "cancelled", "abandoned"].includes(String(match?.status || "").toLowerCase());

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeCode(bytes) {
  return Array.from(bytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const WORDS = "ace amber apple arena away badge ball basil berry bloom brave cedar chant clover comet crowd derby eagle final flint grass green hazel honey ivy league lemon lilac lime match mint noble olive oracle pace pearl pitch plum press rally robin score spark stand swift table topaz tulip winner".split(" ");
export function makeRecovery(bytes) {
  return Array.from(bytes(3), (b) => WORDS[b % WORDS.length]).join("-");
}

export const normRecovery = (value) =>
  String(value || "").toLowerCase().trim().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");

export const normNick = (value) => String(value || "").trim().slice(0, 24) || "Anon";
