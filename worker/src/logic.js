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

function matchToCompleted(match) {
  return {
    id: match.id,
    startMs: Date.parse(match.lockAt || match.startAt) || 0,
    result: normaliseResult(match),
    voided: isVoided(match),
    matchday: match.matchday,
  };
}

// One matchday's standings. Same scoring/sort as the season table, restricted to
// fixtures of `matchday`. `completed` is the season-shaped array (each carrying a
// `matchday`), so callers reuse the mapping they already built.
export function computeRoundTable(members, completed, picksByMatch, matchday) {
  return computeTable(members, completed.filter((match) => match.matchday === matchday), picksByMatch);
}

// A round is complete once every non-void fixture has a result. Cancelled/abandoned
// fixtures (isVoided) are exempt; a postponed fixture is non-void without a result,
// so it keeps the round open until it is replayed.
export function roundComplete(roundFixtures) {
  return roundFixtures.length > 0 && roundFixtures.every((match) => normaliseResult(match) || isVoided(match));
}

// Human-facing completion label for one round's fixtures.
export function roundStatus(roundFixtures) {
  if (!roundFixtures.length) return "no fixtures";
  const pending = roundFixtures.filter((match) => !normaliseResult(match) && !isVoided(match));
  if (!pending.length) return "complete";
  const postponed = pending.filter((match) => String(match.status || "").toLowerCase() === "postponed");
  if (postponed.length === pending.length) {
    return `${postponed.length} ${postponed.length === 1 ? "fixture" : "fixtures"} pending`;
  }
  return "in progress";
}

// Winners of a completed round: every member sharing the top score (shared wins
// allowed). No winner while the round is incomplete or nobody has scored.
export function roundWinners(members, roundFixtures, picksByMatch) {
  if (!roundComplete(roundFixtures)) return [];
  const table = computeTable(members, roundFixtures.map(matchToCompleted), picksByMatch);
  const top = table.length ? table[0].pts : 0;
  if (top <= 0) return [];
  return table.filter((row) => row.pts === top).map((row) => row.uid);
}

export const PODIUM_PLACES = ["gold", "silver", "bronze"];

// Competition ranking on POINTS ONLY. The season table's exact/correct
// tie-breakers order rows for display but must never split a podium place:
// 9-9-7 is gold, gold, bronze; 9-7-7 is gold, silver, silver and no bronze;
// 9-9-9 is three golds. A zero score is never a podium finish, so a week where
// nobody scored awards nothing at all (matching roundWinners' suppression).
export function podiumFromTable(table, memberCount) {
  const rows = table || [];
  if (!rows.length || rows[0].pts <= 0) return [];
  // Explicit guard: a two-player league has a gold and a silver and no third
  // place — never assume a third player exists to fill the bronze slot.
  const places = Math.min(PODIUM_PLACES.length, memberCount);
  const podium = [];
  for (const row of rows) {
    if (row.pts <= 0) continue;
    const rank = rows.filter((other) => other.pts > row.pts).length + 1;
    if (rank > places) continue;
    podium.push({ uid: row.uid, nick: row.nick, pts: row.pts, rank, place: PODIUM_PLACES[rank - 1] });
  }
  return podium;
}

// The podium for one completed round, over whatever slate the round was played
// on (full card or a Custom Mix selection — the caller filters the fixtures).
export function computePodium(members, roundFixtures, picksByMatch) {
  if (!roundComplete(roundFixtures)) return [];
  return podiumFromTable(
    computeTable(members, roundFixtures.map(matchToCompleted), picksByMatch),
    members.length
  );
}

// ---------------------------------------------------------------------------
// Custom Mix slates
//
// A slate is one league's answer to "which fixtures does Matchweek N score?".
// The record is `{ mode, fixtureIds, lockedAt, setBy }` under
// custom_slate:<code>:<matchweek>, and intent is always stored, never inferred
// from the absence of a key: "custom" is a host selection, "full" is a host who
// deliberately chose the whole card, "fallback" is a host who never answered and
// had the full card unlocked for them. No record at all means a league that
// isn't running Custom Mix, which keeps every existing league untouched.
// ---------------------------------------------------------------------------

// v1.5 §9: one validation path for the weekly count — floor 1, ceiling 20,
// default 6. The 6–10 band this replaces is gone; no other floor exists.
export const SLATE_MIN = 1;
export const SLATE_MAX = 20;
export const SLATE_MODES = ["custom", "full", "fallback"];

/**
 * Slates key on a period, not a matchweek number. For a single-competition
 * league the period IS the matchweek number, so every slate written before
 * windows existed keeps exactly the key it already has.
 */
export const slateKey = (code, period) => `custom_slate:${code}:${period}`;

// ---------------------------------------------------------------------------
// The draft → published lifecycle
//
// One way, once per period: draft → published → locked → settled. Nothing ever
// travels back up. A draft is the host's working copy and may be rewritten as
// often as they like; publishing freezes it, tells the league, and any later
// write to that period is a 409.
//
// A slate written before v1.5 has no `status` field at all. It reads as
// PUBLISHED — those weeks were played, members hold picks against them, and an
// existing league must never wake up with its history editable. The record on
// disk is not rewritten to say so; this is a read-boundary reading, like every
// other legacy normalisation in the codebase.
// ---------------------------------------------------------------------------

export const SLATE_STATUSES = ["draft", "published", "locked", "settled"];
const STATUS_RANK = Object.fromEntries(SLATE_STATUSES.map((status, index) => [status, index]));

/** The lifecycle status of a stored slate. Absent means published. */
export const slateStatus = (slate) => {
  if (!slate) return null;
  const stored = String(slate.status || "");
  return SLATE_STATUSES.includes(stored) ? stored : "published";
};

export const isPublishedSlate = (slate) => {
  const status = slateStatus(slate);
  return status != null && status !== "draft";
};

export const isDraftSlate = (slate) => slateStatus(slate) === "draft";

/** Reads a stored slate with its lifecycle status resolved, never rewriting it. */
export const normaliseSlate = (slate) => (slate ? { ...slate, status: slateStatus(slate) } : null);

/** True when `next` is a forward move. Publishing a published slate is not. */
export const canAdvanceSlate = (slate, next) => {
  if (!SLATE_STATUSES.includes(next)) return false;
  if (!slate) return next === "draft" || next === "published";
  return STATUS_RANK[next] > STATUS_RANK[slateStatus(slate)];
};

/**
 * What publishing freezes: the fixture ids, which competition each came from,
 * the kickoff times as they stood, the period key, and where the selection came
 * from. A later reschedule updates the times held here for display, but the id
 * list is the league's contract and is never quietly swapped.
 */
export function buildSlateSnapshot(fixtureIds, pool, periodKey, ruleSource) {
  const byId = new Map((pool || []).map((match) => [String(match.id), match]));
  return {
    periodKey: String(periodKey),
    ruleSource,
    takenAt: new Date().toISOString(),
    fixtures: (fixtureIds || []).map((id) => {
      const match = byId.get(String(id));
      return {
        id: String(id),
        competition: competitionOfSnapshotId(String(id)),
        kickoffAt: match?.startAt || match?.lockAt || null,
        label: match ? `${match.player1} v ${match.player2}` : null,
      };
    }),
  };
}

// Deliberately local rather than an import from competitions.js: logic.js is the
// pure-scoring module and has no competition registry dependency. Only the two
// namespaces that can appear in a slate need naming.
const competitionOfSnapshotId = (id) =>
  (id.startsWith("elc-") ? "ELC" : id.startsWith("cl-") ? "CL" : id.startsWith("pl-") ? "PL" : null);

/**
 * Folds a reschedule into a published snapshot. Kickoff times and labels are
 * refreshed and fixtures that have gone are marked unavailable, but the id list
 * itself is returned untouched — post-publish the league plays what it was
 * shown. Returns null when nothing moved.
 */
export function refreshSnapshot(snapshot, roundFixtures) {
  if (!snapshot?.fixtures?.length) return null;
  const byId = new Map((roundFixtures || []).map((match) => [String(match.id), match]));
  let changed = false;
  const fixtures = snapshot.fixtures.map((entry) => {
    const match = byId.get(String(entry.id));
    const kickoffAt = match?.startAt || match?.lockAt || entry.kickoffAt || null;
    const unavailable = !match || isVoided(match) || String(match.status || "").toLowerCase() === "postponed";
    const next = {
      ...entry,
      kickoffAt,
      label: match ? `${match.player1} v ${match.player2}` : entry.label,
      ...(unavailable ? { unavailable: true } : {}),
    };
    if (next.kickoffAt !== entry.kickoffAt || !!next.unavailable !== !!entry.unavailable) changed = true;
    return next;
  });
  return changed ? { ...snapshot, fixtures, revisedAt: new Date().toISOString() } : null;
}

/**
 * Validates last week's settings against this period's pool.
 *
 * The picker pre-loads what the host chose last time. A fixture that has been
 * promoted out, postponed, or simply isn't on this week is reported as
 * explicitly unavailable rather than quietly dropped — the host is told what
 * moved, not handed a shorter list and left to notice.
 */
export function preloadSelection(previousIds, pool) {
  const available = new Map((pool || []).map((match) => [String(match.id), match]));
  const carried = [];
  const unavailable = [];
  for (const raw of previousIds || []) {
    const id = String(raw);
    const match = available.get(id);
    if (!match) {
      unavailable.push({ id, reason: "notInPool" });
      continue;
    }
    if (isVoided(match)) {
      unavailable.push({ id, reason: "voided", label: `${match.player1} v ${match.player2}` });
      continue;
    }
    if (String(match.status || "").toLowerCase() === "postponed") {
      unavailable.push({ id, reason: "postponed", label: `${match.player1} v ${match.player2}` });
      continue;
    }
    carried.push(id);
  }
  return { fixtureIds: carried, unavailable };
}

// Slate types the member-facing UI distinguishes: an unanswered fallback reads
// as a full card, because that is exactly what the league played.
export const slateType = (slate) => (slate?.mode === "custom" ? "custom" : "full");

export const byKickoffOrder = (a, b) =>
  (Date.parse(a.startAt || a.lockAt) || 0) - (Date.parse(b.startAt || b.lockAt) || 0) ||
  String(a.id).localeCompare(String(b.id));

/**
 * Validates a host submission against the pool actually available this period.
 *
 * `bounds` is `{ min, max }` for the week. The league's configured count is a
 * default the picker opens on, not a limit the host is held to, so the only
 * hard constraints are the floor (one fixture) and the size of the pool itself.
 * This is the single validation path: there is no separate rule for a random
 * week, a full week, or a short one.
 */
export function validateSlate(mode, fixtureIds, pool, bounds = null) {
  if (!pool.length) return { error: "no fixtures available this week" };
  const ordered = [...pool].sort(byKickoffOrder);
  if (mode === "full") return { fixtureIds: ordered.map((match) => String(match.id)) };
  if (mode !== "custom") return { error: "mode must be custom or full" };
  if (!Array.isArray(fixtureIds)) return { error: "fixtureIds must be an array" };
  const requested = fixtureIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (new Set(requested).size !== requested.length) return { error: "fixtureIds must be unique" };
  const available = new Map(ordered.map((match) => [String(match.id), match]));
  const unknown = requested.find((id) => !available.has(id));
  if (unknown) return { error: `fixture not available this week: ${unknown}` };

  const limits = bounds || { min: SLATE_MIN, max: SLATE_MAX };
  const max = Math.min(limits.max ?? SLATE_MAX, pool.length);
  const min = Math.min(limits.min ?? SLATE_MIN, max);
  if (requested.length < min || requested.length > max) {
    return { error: `select between ${min} and ${max} fixtures` };
  }
  const chosen = new Set(requested);
  return { fixtureIds: ordered.filter((match) => chosen.has(String(match.id))).map((match) => String(match.id)) };
}

/**
 * The fixtures a `random` weekly rule deals for one period.
 *
 * Seeded on the league code and the period key, so a background job that runs
 * twice produces byte-identical output rather than two different weeks. In a
 * mixed pool it guarantees one fixture from each competition that actually has
 * something on, then fills the rest, which is what stops a random Championship
 * week from quietly excluding the Premier League.
 */
export function randomSelection(pool, count, seed) {
  const ordered = [...pool].sort(byKickoffOrder);
  const target = Math.max(1, Math.min(Number(count) || 1, ordered.length));
  if (!ordered.length) return [];
  // FNV-1a over the seed, then a xorshift walk. Deliberately not the runtime
  // RNG: the same league and period must always deal the same slate.
  let state = 0x811c9dc5;
  for (const char of String(seed)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  const shuffle = (list) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const byCompetition = new Map();
  for (const match of ordered) {
    const code = competitionOfSnapshotId(String(match.id)) || "PL";
    byCompetition.set(code, [...(byCompetition.get(code) || []), match]);
  }
  const taken = new Set();
  for (const [, group] of [...byCompetition.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (taken.size >= target) break;
    taken.add(String(shuffle(group)[0].id));
  }
  for (const match of shuffle(ordered)) {
    if (taken.size >= target) break;
    taken.add(String(match.id));
  }
  return ordered.filter((match) => taken.has(String(match.id))).map((match) => String(match.id));
}

// The fixtures a league actually scores for one matchweek. A league with no
// slate for that week keeps today's behaviour: the whole card.
export function slateFixtures(slate, roundFixtures) {
  if (!slate?.fixtureIds?.length) return roundFixtures;
  const allow = new Set(slate.fixtureIds.map(String));
  return roundFixtures.filter((match) => allow.has(String(match.id)));
}

// The period a scoring row belongs to. A mixed league stamps `period` on each
// row (a window key); everything else falls back to the matchweek number, so a
// single-competition league behaves exactly as it always has.
export const periodOf = (match) =>
  (match?.period != null ? String(match.period) : match?.matchday == null ? null : String(match.matchday));

// Season-wide version: every fixture whose own period slate includes it.
// Periods without a slate contribute their full pool, so a season total
// accumulates across whatever each period's slate happened to be.
export function applySlates(matches, slatesByPeriod) {
  const periods = Object.keys(slatesByPeriod || {});
  if (!periods.length) return matches;
  const allowByPeriod = new Map(periods
    .filter((period) => slatesByPeriod[period]?.fixtureIds?.length)
    .map((period) => [String(period), new Set(slatesByPeriod[period].fixtureIds.map(String))]));
  if (!allowByPeriod.size) return matches;
  return matches.filter((match) => {
    const allow = allowByPeriod.get(periodOf(match));
    return !allow || allow.has(String(match.id));
  });
}

/** Groups fixtures by period. Defaults to matchweek, which is the single-
 *  competition case; a mixed league passes a window-key function instead. */
export function groupByPeriod(fixtures, keyOf = periodOf) {
  const grouped = new Map();
  for (const match of fixtures) {
    const key = keyOf(match);
    if (key == null) continue;
    const list = grouped.get(key) || [];
    list.push(match);
    grouped.set(key, list);
  }
  return grouped;
}

export function fixturesByMatchweek(fixtures) {
  const byMatchweek = new Map();
  for (const match of fixtures) {
    if (match?.matchday == null) continue;
    const list = byMatchweek.get(match.matchday) || [];
    list.push(match);
    byMatchweek.set(match.matchday, list);
  }
  return byMatchweek;
}

// One member's Trophy Cabinet: the summary shelf plus a week-by-week history of
// played matchweeks. Derived entirely from picks, results and the slate records
// that already exist — deliberately no new stored state.
export function computeCabinet(uid, members, fixtures, picksByMatch, slatesByPeriod = {}, keyOf = periodOf) {
  const member = members.find((row) => row.uid === uid);
  if (!member) return null;
  const totals = { gold: 0, silver: 0, bronze: 0 };
  const weeks = [];
  // Most recent first. Window keys sort correctly as strings; matchweek numbers
  // are compared numerically so 10 still comes after 9.
  const ordered = [...groupByPeriod(fixtures, keyOf).entries()].sort((a, b) => {
    const [x, y] = [a[0], b[0]];
    const numeric = Number(x) - Number(y);
    return Number.isNaN(numeric) ? String(y).localeCompare(String(x)) : -numeric;
  });
  for (const [period, all] of ordered) {
    const slate = slatesByPeriod[period] || null;
    const roundFixtures = slateFixtures(slate, all);
    if (!roundComplete(roundFixtures)) continue;
    const completed = roundFixtures.map(matchToCompleted);
    // A member who joined mid-season has no claim on weeks that had already
    // kicked off — computeTable scores those as zero, which is not a played week.
    if (member.since && !completed.some((match) => match.startMs >= member.since)) continue;
    const table = computeTable(members, completed, picksByMatch);
    const row = table.find((entry) => entry.uid === uid);
    if (!row) continue;
    const award = podiumFromTable(table, members.length).find((entry) => entry.uid === uid) || null;
    if (award) totals[award.place] += 1;
    weeks.push({
      period,
      matchweek: Number.isNaN(Number(period)) ? null : Number(period),
      place: award?.place || null,
      rank: table.filter((other) => other.pts > row.pts).length + 1,
      pts: row.pts,
      slateType: slateType(slate),
      fixtures: roundFixtures.length,
    });
  }
  return {
    uid,
    nick: member.nick,
    ...totals,
    podiums: totals.gold + totals.silver + totals.bronze,
    weeks,
  };
}

// Per-uid tally of matchday wins across every complete round.
export function computeRoundWins(members, fixtures, picksByMatch, slatesByPeriod = {}, keyOf = periodOf) {
  const wins = Object.fromEntries(members.map((member) => [member.uid, 0]));
  for (const [period, all] of groupByPeriod(fixtures, keyOf)) {
    const roundFixtures = slateFixtures(slatesByPeriod[period] || null, all);
    for (const uid of roundWinners(members, roundFixtures, picksByMatch)) {
      if (uid in wins) wins[uid] += 1;
    }
  }
  return wins;
}

// Keeps a published slate honest when one of its fixtures is postponed.
//
// v1.5 §9: a published slate is a contract. Its fixture list is snapshotted at
// publish and is NEVER silently swapped afterwards — a fixture that goes is
// dropped and the league is told, but nothing the members never saw is dealt in
// behind them, whether or not anything has locked yet. (Before v1.5 a
// replacement was substituted while the slate was still fully unlocked; that is
// the behaviour this removes.)
export function reconcileSlate(slate, roundFixtures, nowMs) {
  if (!isPublishedSlate(slate) || slate?.mode !== "custom" || !slate.fixtureIds?.length) return null;
  const byId = new Map(roundFixtures.map((match) => [String(match.id), match]));
  const current = slate.fixtureIds.map(String);
  const dropped = current.filter((id) => {
    const match = byId.get(id);
    return !match || isVoided(match) || String(match.status || "").toLowerCase() === "postponed";
  });
  if (!dropped.length) return null;
  const kept = current.filter((id) => !dropped.includes(id));
  const anyLocked = current.some((id) => {
    const match = byId.get(id);
    return match && matchLocked(match, nowMs);
  });
  return { fixtureIds: kept, dropped, added: [], reason: anyLocked ? "locked" : "dropped" };
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

const icsStamp = (date) => date.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

const icsEscape = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

// Single-event VCALENDAR for one fixture. Served as text/calendar so iOS can
// hand it straight to its own "Add to Calendar" sheet — the native app has no
// way to trigger a browser-style .ics download. `pick` is the viewer's own
// prediction, kept so the native event body matches the web one.
export function buildFixtureIcs(match, pick = null) {
  if (!match) return null;
  const start = new Date(match.startAt);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 115 * 60000);
  const description = [
    match.round || (match.matchday ? `Matchweek ${match.matchday}` : ""),
    match.venue,
    match.broadcaster ? `UK TV: ${match.broadcaster}` : "",
    pick && validFootballScore(pick.p1, pick.p2)
      ? `Your prediction: ${match.player1} ${pick.p1}-${pick.p2} ${match.player2}`
      : "",
    "Prem Oracle fixture",
  ].filter(Boolean).join(" · ");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PremOracle//PremierLeague202627//EN",
    "BEGIN:VEVENT",
    `UID:${icsEscape(match.id)}@premoracle`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(`⚽ ${match.player1} v ${match.player2}`)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(match.venue || "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// "2-1" -> { p1: 2, p2: 1 }; anything else -> null.
export function parsePickParam(value) {
  const match = /^(\d)-(\d)$/.exec(String(value || ""));
  if (!match) return null;
  const pick = { p1: Number(match[1]), p2: Number(match[2]) };
  return validFootballScore(pick.p1, pick.p2) ? pick : null;
}

// Selects fixtures kicking off within the next `windowMs` (default 60 minutes)
// whose id is not already present in `notifiedIds`. Fixtures that have already
// started, lack a parseable start time, or have unconfirmed players are skipped.
export function fixturesNeedingNotification(matches, notifiedIds, nowMs, windowMs = 60 * 60 * 1000) {
  return (matches || []).filter((match) => {
    if (!match?.player1 || !match?.player2) return false;
    const startMs = Date.parse(match.startAt);
    if (!Number.isFinite(startMs)) return false;
    if (startMs < nowMs || startMs > nowMs + windowMs) return false;
    return !notifiedIds.has(String(match.id));
  });
}
