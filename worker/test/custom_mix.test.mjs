import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {
  applySlates,
  computeCabinet,
  computePodium,
  computeRoundWins,
  computeTable,
  podiumFromTable,
  reconcileSlate,
  slateFixtures,
  validateSlate,
} from "../src/logic.js";

const HOUR = 60 * 60 * 1000;

function memoryKV(store = new Map()) {
  return {
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || "" };
    },
  };
}

// Ten Matchweek-1 fixtures, kicking off an hour apart from `firstKickoff`.
function roundOf(count = 10, firstKickoff = Date.parse("2026-08-21T12:00:00Z"), matchday = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `pl-2026-27-md${matchday}-${String(index + 1).padStart(3, "0")}`,
    matchday,
    player1: `Home ${index + 1}`,
    player2: `Away ${index + 1}`,
    startAt: new Date(firstKickoff + index * HOUR).toISOString(),
  }));
}

const settle = (match, p1, p2) => ({ ...match, status: "complete", result: [p1, p2] });

const asCompleted = (match) => ({
  id: match.id,
  startMs: Date.parse(match.lockAt || match.startAt) || 0,
  result: Array.isArray(match.result) ? { p1: match.result[0], p2: match.result[1] } : null,
  voided: false,
  matchday: match.matchday,
});

// --- slate validation -------------------------------------------------------

test("custom slates validate size, membership and uniqueness", () => {
  const round = roundOf();
  const ids = round.map((match) => match.id);

  // v1.5 §9: one validation path — floor one, ceiling the pool. Five fixtures
  // is a perfectly ordinary week; only an empty selection is out of bounds.
  assert.equal(validateSlate("custom", ids.slice(0, 5), round).fixtureIds.length, 5);
  assert.equal(validateSlate("custom", ids.slice(0, 1), round).fixtureIds.length, 1, "a one-fixture week is legal");
  assert.equal(validateSlate("custom", [], round).error, "select between 1 and 10 fixtures");
  assert.equal(validateSlate("custom", [...ids, "pl-2026-27-md1-011"], round).error, "fixture not available this week: pl-2026-27-md1-011");
  assert.equal(validateSlate("custom", [ids[0], ids[0], ids[1], ids[2], ids[3], ids[4]], round).error, "fixtureIds must be unique");
  assert.equal(validateSlate("custom", ["pl-2026-27-md2-001", ...ids.slice(0, 5)], round).error, "fixture not available this week: pl-2026-27-md2-001");
  assert.equal(validateSlate("sideways", ids.slice(0, 6), round).error, "mode must be custom or full");
  assert.equal(validateSlate("custom", ids.slice(0, 6), []).error, "no fixtures available this week");

  // Both bounds inclusive, and the stored order is always kickoff order.
  assert.deepEqual(validateSlate("custom", ids.slice(0, 6), round).fixtureIds, ids.slice(0, 6));
  assert.deepEqual(validateSlate("custom", ids, round).fixtureIds, ids);
  assert.deepEqual(validateSlate("custom", [ids[4], ids[0], ids[7], ids[2], ids[9], ids[1]], round).fixtureIds,
    [ids[0], ids[1], ids[2], ids[4], ids[7], ids[9]]);
});

test("full mode records every fixture explicitly, whatever ids were sent", () => {
  const round = roundOf();
  assert.deepEqual(validateSlate("full", [], round).fixtureIds, round.map((match) => match.id));
  assert.deepEqual(validateSlate("full", undefined, round).fixtureIds, round.map((match) => match.id));
});

// --- scoring filter ---------------------------------------------------------

test("no slate scores the full card; a slate scores only its fixtures", () => {
  const round = roundOf();
  assert.equal(slateFixtures(null, round).length, 10);
  assert.equal(slateFixtures({ mode: "full", fixtureIds: round.map((m) => m.id) }, round).length, 10);
  const custom = { mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };
  assert.deepEqual(slateFixtures(custom, round).map((match) => match.id), custom.fixtureIds);
});

test("season totals accumulate across whatever each week's slate was", () => {
  const week1 = roundOf(10, Date.parse("2026-08-21T12:00:00Z"), 1).map((match) => settle(match, 1, 0));
  const week2 = roundOf(10, Date.parse("2026-08-28T12:00:00Z"), 2).map((match) => settle(match, 2, 2));
  const fixtures = [...week1, ...week2];
  const members = [{ uid: "a", nick: "Adam", since: 0 }, { uid: "b", nick: "Ben", since: 0 }];
  // Adam nails every fixture exactly; Ben only ever calls the winner.
  const picks = Object.fromEntries(fixtures.map((match) => [match.id, {
    a: { p1: match.result[0], p2: match.result[1], ts: 1 },
    b: match.matchday === 1 ? { p1: 3, p2: 0, ts: 1 } : { p1: 1, p2: 1, ts: 1 },
  }]));

  const slates = {
    1: { mode: "custom", fixtureIds: week1.slice(0, 6).map((match) => match.id) },
    2: { mode: "full", fixtureIds: week2.map((match) => match.id) },
  };
  const scoped = applySlates(fixtures.map(asCompleted), slates);
  // 6 curated week-1 fixtures + all 10 of week 2.
  assert.equal(scoped.length, 16);
  const table = computeTable(members, scoped, picks);
  assert.equal(table[0].uid, "a");
  assert.equal(table[0].pts, 16 * 5);
  assert.equal(table[1].pts, 6 * 1 + 10 * 2);

  // Without slates the same picks score the whole 20-fixture card.
  assert.equal(computeTable(members, fixtures.map(asCompleted), picks)[0].pts, 20 * 5);

  // Weekly wins are counted on the slate too.
  assert.deepEqual(computeRoundWins(members, fixtures, picks, slates), { a: 2, b: 0 });
});

// --- postponements ----------------------------------------------------------

test("a postponed slate fixture is dropped, never swapped, even before anything locks", () => {
  // v1.5 §9: publishing snapshots the fixture list, and a published slate is
  // never silently swapped afterwards. Before v1.5 a replacement was dealt in
  // while the slate was still fully unlocked; that is the behaviour this
  // removes — a league plays what it was shown, one fixture shorter.
  const now = Date.parse("2026-08-21T06:00:00Z");
  const round = roundOf();
  round[2] = { ...round[2], status: "postponed" };
  const slate = { status: "published", mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };

  const change = reconcileSlate(slate, round, now);
  assert.equal(change.reason, "dropped");
  assert.deepEqual(change.dropped, ["pl-2026-27-md1-003"]);
  assert.deepEqual(change.added, [], "nothing the members never saw is dealt in behind them");
  assert.equal(change.fixtureIds.length, 5);
  assert.deepEqual(change.fixtureIds, ["pl-2026-27-md1-001", "pl-2026-27-md1-002", "pl-2026-27-md1-004", "pl-2026-27-md1-005", "pl-2026-27-md1-006"]);
});

test("a draft is never reconciled — only a published slate is a contract", () => {
  const now = Date.parse("2026-08-21T06:00:00Z");
  const round = roundOf();
  round[2] = { ...round[2], status: "postponed" };
  const draft = { status: "draft", mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };
  assert.equal(reconcileSlate(draft, round, now), null);
});

test("after any slate fixture locks a postponement is removed, never replaced", () => {
  // Two hours in: fixtures 1 and 2 have kicked off, so members hold picks.
  const round = roundOf();
  const now = Date.parse(round[1].startAt) + 60 * 1000;
  round[4] = { ...round[4], status: "postponed" };
  const slate = { mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };

  const change = reconcileSlate(slate, round, now);
  assert.equal(change.reason, "locked");
  assert.deepEqual(change.dropped, ["pl-2026-27-md1-005"]);
  assert.deepEqual(change.added, []);
  // Fairness beats slate size: five fixtures is the right answer, not six.
  assert.equal(change.fixtureIds.length, 5);
});

test("a locked slate drops below the minimum rather than silently adding", () => {
  const round = roundOf();
  const now = Date.parse(round[0].startAt) + 60 * 1000;
  const slate = { mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };
  const postponed = round.map((match, index) =>
    (index >= 1 && index <= 3 ? { ...match, status: "postponed" } : match));

  const change = reconcileSlate(slate, postponed, now);
  assert.deepEqual(change.added, []);
  assert.deepEqual(change.fixtureIds, ["pl-2026-27-md1-001", "pl-2026-27-md1-005", "pl-2026-27-md1-006"]);
});

test("a healthy slate is left alone, and full-card slates are never reconciled", () => {
  const round = roundOf();
  const slate = { mode: "custom", fixtureIds: round.slice(0, 6).map((match) => match.id) };
  assert.equal(reconcileSlate(slate, round, Date.parse("2026-08-21T06:00:00Z")), null);
  const postponedRound = round.map((match, index) => (index === 0 ? { ...match, status: "postponed" } : match));
  assert.equal(reconcileSlate({ mode: "full", fixtureIds: round.map((m) => m.id) }, postponedRound, 0), null);
});

// --- podium -----------------------------------------------------------------

const table = (...points) => points.map((pts, index) => ({
  uid: `u${index + 1}`, nick: `P${index + 1}`, pts, exact: 0, correct: 0,
}));

test("podium is competition ranking on points only", () => {
  assert.deepEqual(podiumFromTable(table(9, 9, 7), 3).map((entry) => entry.place), ["gold", "gold", "bronze"]);
  assert.deepEqual(podiumFromTable(table(9, 7, 7), 3).map((entry) => entry.place), ["gold", "silver", "silver"]);
  assert.deepEqual(podiumFromTable(table(9, 9, 9), 3).map((entry) => entry.place), ["gold", "gold", "gold"]);
  assert.deepEqual(podiumFromTable(table(9, 7, 5), 3).map((entry) => entry.place), ["gold", "silver", "bronze"]);
});

test("exact-score tie-breakers order the table but never split a podium place", () => {
  // Same points, different exact counts: the sort separates them, the podium doesn't.
  const ordered = [
    { uid: "a", nick: "Adam", pts: 9, exact: 3, correct: 5 },
    { uid: "b", nick: "Ben", pts: 9, exact: 1, correct: 5 },
    { uid: "c", nick: "Cal", pts: 7, exact: 0, correct: 4 },
  ];
  assert.deepEqual(podiumFromTable(ordered, 3).map((entry) => [entry.nick, entry.place]),
    [["Adam", "gold"], ["Ben", "gold"], ["Cal", "bronze"]]);
});

test("a dead week awards nothing, and a zero score is never a podium finish", () => {
  assert.deepEqual(podiumFromTable(table(0, 0, 0), 3), []);
  assert.deepEqual(podiumFromTable([], 3), []);
  assert.deepEqual(podiumFromTable(table(9, 0, 0), 3).map((entry) => entry.place), ["gold"]);
});

test("a two-player league awards gold and silver and never assumes a third", () => {
  assert.deepEqual(podiumFromTable(table(9, 7), 2).map((entry) => entry.place), ["gold", "silver"]);
  assert.deepEqual(podiumFromTable(table(9, 9), 2).map((entry) => entry.place), ["gold", "gold"]);
  // Even handed a longer table, a two-member league can only fill two places.
  assert.deepEqual(podiumFromTable(table(9, 7, 5), 2).map((entry) => entry.place), ["gold", "silver"]);
});

test("more than three players never produces a fourth podium place", () => {
  assert.deepEqual(podiumFromTable(table(9, 7, 7, 5), 4).map((entry) => entry.place), ["gold", "silver", "silver"]);
  assert.deepEqual(podiumFromTable(table(9, 9, 7, 7), 4).map((entry) => entry.place),
    ["gold", "gold", "bronze", "bronze"]);
});

test("no podium until every fixture on the slate is settled", () => {
  const members = [{ uid: "a", nick: "Adam", since: 0 }, { uid: "b", nick: "Ben", since: 0 }];
  const round = roundOf(6).map((match, index) => (index === 5 ? match : settle(match, 1, 0)));
  const picks = Object.fromEntries(round.map((match) => [match.id, { a: { p1: 1, p2: 0, ts: 1 } }]));
  assert.deepEqual(computePodium(members, round, picks), []);
  const complete = round.map((match) => settle(match, 1, 0));
  assert.deepEqual(computePodium(members, complete, picks).map((entry) => entry.place), ["gold"]);
});

// --- cabinet ----------------------------------------------------------------

test("the cabinet is derived from picks, results and each week's slate", () => {
  const week1 = roundOf(10, Date.parse("2026-08-21T12:00:00Z"), 1).map((match) => settle(match, 1, 0));
  const week2 = roundOf(10, Date.parse("2026-08-28T12:00:00Z"), 2).map((match) => settle(match, 2, 1));
  const week3 = roundOf(10, Date.parse("2026-09-04T12:00:00Z"), 3);
  const fixtures = [...week1, ...week2, ...week3];
  const members = [
    { uid: "a", nick: "Adam", since: 0 },
    { uid: "b", nick: "Ben", since: 0 },
    { uid: "c", nick: "Cal", since: 0 },
  ];
  // Week 1 finishes 1-0, week 2 finishes 2-1.
  const picks = Object.fromEntries(fixtures.map((match) => [match.id, {
    a: match.matchday === 1 ? { p1: 1, p2: 0, ts: 1 } : { p1: 0, p2: 2, ts: 1 },  // exact, then wrong
    b: match.matchday === 1 ? { p1: 0, p2: 1, ts: 1 } : { p1: 2, p2: 1, ts: 1 },  // wrong, then exact
    c: { p1: 3, p2: 0, ts: 1 },                                                   // winner only, both weeks
  }]));
  const slates = { 1: { mode: "custom", fixtureIds: week1.slice(0, 7).map((match) => match.id) } };

  const cabinet = computeCabinet("a", members, fixtures, picks, slates);
  assert.equal(cabinet.nick, "Adam");
  // Week 3 has no results, so it isn't a played week.
  assert.deepEqual(cabinet.weeks.map((week) => week.matchweek), [2, 1]);
  assert.deepEqual(cabinet.weeks.find((week) => week.matchweek === 1), {
    period: "1", matchweek: 1, place: "gold", rank: 1, pts: 35, slateType: "custom", fixtures: 7,
  });
  // A scoreless week is a played week, but never a podium finish.
  assert.deepEqual(cabinet.weeks.find((week) => week.matchweek === 2), {
    period: "2", matchweek: 2, place: null, rank: 3, pts: 0, slateType: "full", fixtures: 10,
  });
  assert.equal(cabinet.gold, 1);
  assert.equal(cabinet.silver, 0);
  assert.equal(cabinet.bronze, 0);
  assert.equal(cabinet.podiums, 1);

  const ben = computeCabinet("b", members, fixtures, picks, slates);
  assert.deepEqual(ben.weeks.map((week) => week.place), ["gold", null]);
  const cal = computeCabinet("c", members, fixtures, picks, slates);
  // Cal scores in both weeks but is beaten outright each time — second, twice.
  assert.deepEqual(cal.weeks.map((week) => week.place), ["silver", "silver"]);
  assert.equal(cal.silver, 2);
  assert.equal(cal.podiums, 2);

  assert.equal(computeCabinet("ghost", members, fixtures, picks, slates), null);
});

test("a mid-season joiner's cabinet starts at the week they joined", () => {
  const week1 = roundOf(2, Date.parse("2026-08-21T12:00:00Z"), 1).map((match) => settle(match, 1, 0));
  const week2 = roundOf(2, Date.parse("2026-08-28T12:00:00Z"), 2).map((match) => settle(match, 1, 0));
  const fixtures = [...week1, ...week2];
  const members = [
    { uid: "a", nick: "Adam", since: 0 },
    { uid: "late", nick: "Late", since: Date.parse("2026-08-25T00:00:00Z") },
  ];
  const picks = Object.fromEntries(fixtures.map((match) => [match.id, {
    a: { p1: 1, p2: 0, ts: 1 },
    late: { p1: 1, p2: 0, ts: 1 },
  }]));
  assert.deepEqual(computeCabinet("late", members, fixtures, picks, {}).weeks.map((week) => week.matchweek), [2]);
  assert.deepEqual(computeCabinet("a", members, fixtures, picks, {}).weeks.map((week) => week.matchweek), [2, 1]);
});

// --- endpoints --------------------------------------------------------------

function endpointEnv(fixtureList, store = new Map()) {
  return {
    env: {
      FIXTURES_URL: "https://example.com/fixtures.json",
      KV: memoryKV(store),
    },
    store,
    fixtureList,
  };
}

async function withFixtures(fixtureList, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: fixtureList }), { status: 200 });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
  method: "POST",
  body: JSON.stringify(body),
}), env);

const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

// The worker caches fixtures for 60s in module scope; refresh=1 reloads them.
const primeFixtures = (env) => get(env)("/fixtures?refresh=1");

test("POST /league/slate is host-only, validated, and immutable once set", async () => {
  const round = roundOf();
  const { env } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const created = await (await send("/league", { uid: "host", nickname: "Host", customMix: true })).json();
    const code = created.code;
    assert.equal(created.customMix, true);
    await send("/join", { uid: "m2", code, nickname: "Two" });

    const ids = round.map((match) => match.id);
    const slate = (body) => send("/league/slate", { code, matchweek: 1, ...body });

    // Unknown league, non-host, bad matchweek and short slate are all refused.
    assert.equal((await send("/league/slate", { uid: "host", code: "ZZZZZZ", matchweek: 1, fixtureIds: ids.slice(0, 6) })).status, 404);
    const notHost = await slate({ uid: "m2", fixtureIds: ids.slice(0, 6) });
    assert.equal(notHost.status, 403);
    assert.equal((await notHost.json()).error, "only the league host can set the fixtures");
    assert.equal((await send("/league/slate", { uid: "host", code, fixtureIds: ids.slice(0, 6) })).status, 400);
    // v1.5 §9: the count is a weekly default, not a cap. The floor is one, so
    // the only ways to be out of bounds are an empty pick and a foreign id.
    const empty = await slate({ uid: "host", fixtureIds: [] });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, "select between 1 and 10 fixtures");
    assert.equal((await slate({ uid: "host", fixtureIds: [...ids, "pl-2026-27-md1-011"] })).status, 400);

    // Nothing above wrote anything.
    assert.equal(await env.KV.get(`custom_slate:${code}:1`), null);

    const ok = await slate({ uid: "host", mode: "custom", fixtureIds: ids.slice(0, 7) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.slate.mode, "custom");
    assert.deepEqual(body.slate.fixtureIds, ids.slice(0, 7));
    assert.equal(body.slate.setBy, "host");
    assert.ok(body.slate.lockedAt);
    assert.equal((await env.KV.get(`league:${code}`)).hadSlates, true);

    // v1.5k: a published week is amendable until its first kickoff, and an
    // amendment APPENDS a version rather than rewriting the one members hold
    // picks against.
    const amend = await slate({ uid: "host", mode: "custom", fixtureIds: ids.slice(0, 6) });
    assert.equal(amend.status, 200);
    const amended = await env.KV.get(`custom_slate:${code}:1`);
    assert.equal(amended.version, 2);
    assert.deepEqual(amended.fixtureIds, ids.slice(0, 6), "reads resolve to the latest version");
    assert.deepEqual(amended.versions[0].fixtureIds, ids.slice(0, 7), "version 1 still on the record");
  });
});

test("any host may publish a week, whatever rule their league runs on", async () => {
  const round = roundOf();
  const { env } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host" })).json();
    const ids = round.slice(0, 6).map((match) => match.id);

    // v1.5 §9: publishing is the one weekly act, and it belongs to the host of
    // every league. A rule league that hasn't auto-published yet is not a
    // league whose host is locked out of their own picker.
    const published = await send("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: ids });
    assert.equal(published.status, 200);
    assert.equal((await published.json()).slate.status, "published");

    assert.equal((await send("/league/custom-mix", { uid: "m2", code, enabled: true })).status, 403);
    assert.equal((await send("/league/custom-mix", { uid: "host", code, enabled: "yes" })).status, 400);
    const toggled = await send("/league/custom-mix", { uid: "host", code, enabled: true });
    assert.equal(toggled.status, 200);
    assert.deepEqual(await env.KV.get("index:custom_mix"), [code]);

    // Matchweek 1 is already published above, so this is the amendment path:
    // same fixtures, so nothing is appended.
    const again = await send("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: ids });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).unchanged, true);

    // Turning it off leaves played weeks scored on the slate they were played on.
    await send("/league/custom-mix", { uid: "host", code, enabled: false });
    assert.deepEqual(await env.KV.get("index:custom_mix"), []);
    assert.equal((await env.KV.get(`league:${code}`)).hadSlates, true);
  });
});

test("Use all 10 stores an explicit full week, distinct from a missing slate", async () => {
  const round = roundOf();
  const { env } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host", customMix: true })).json();
    const response = await send("/league/slate", { uid: "host", code, matchweek: 1, mode: "full" });
    assert.equal(response.status, 200);
    const stored = await env.KV.get(`custom_slate:${code}:1`);
    assert.equal(stored.mode, "full");
    assert.equal(stored.fixtureIds.length, 10);
    assert.equal(stored.setBy, "host");
  });
});

test("/state scores, ranks and reveals only the slate fixtures", async () => {
  const round = roundOf().map((match, index) => (index < 8 ? settle(match, 1, 0) : match));
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host", customMix: true })).json();
    await send("/join", { uid: "m2", code, nickname: "Two" });
    // Host calls every fixture exactly; Two only gets the last three right.
    for (const match of round) {
      store.set(`picks:${match.id}`, JSON.stringify({
        host: { p1: 1, p2: 0, ts: 1 },
        m2: Number(match.id.slice(-3)) >= 6 ? { p1: 1, p2: 0, ts: 1 } : { p1: 0, p2: 3, ts: 1 },
      }));
    }

    const withoutSlate = await (await get(env)(`/state?code=${code}&md=1`)).json();
    assert.equal(withoutSlate.slate, null);
    assert.equal(withoutSlate.table[0].pts, 40);
    assert.equal(withoutSlate.table[1].pts, 15);

    // Curate the three settled fixtures Two also called, plus three it missed.
    const ids = ["pl-2026-27-md1-001", "pl-2026-27-md1-002", "pl-2026-27-md1-003", "pl-2026-27-md1-006", "pl-2026-27-md1-007", "pl-2026-27-md1-008"];
    assert.equal((await send("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: ids })).status, 200);

    const round1 = await (await get(env)(`/state?code=${code}&md=1`)).json();
    assert.equal(round1.slate.mode, "custom");
    assert.equal(round1.slate.count, 6);
    assert.equal(round1.complete, true);
    assert.equal(round1.table[0].pts, 30);
    assert.equal(round1.table[1].pts, 15);
    assert.deepEqual(round1.podium.map((entry) => [entry.nick, entry.place]), [["Host", "gold"], ["Two", "silver"]]);
    assert.deepEqual(round1.winners, ["host"]);

    const season = await (await get(env)(`/state?code=${code}&uid=host`)).json();
    assert.equal(season.customMix, true);
    assert.equal(season.table[0].pts, 30);
    assert.equal(season.table[0].wins, 1);
    // Reveals are scoped to the slate as well.
    assert.deepEqual(season.reveals.map((reveal) => reveal.matchId).sort(), ids);
    assert.equal(season.cabinet.gold, 1);
    assert.deepEqual(season.cabinet.weeks, [
      { period: "1", matchweek: 1, place: "gold", rank: 1, pts: 30, slateType: "custom", fixtures: 6 },
    ]);
    // No uid, no cabinet — the payload only carries what the caller asked for.
    assert.equal((await (await get(env)(`/state?code=${code}`)).json()).cabinet, null);
  });
});

test("a league with no slate keeps exactly its existing behaviour", async () => {
  const round = roundOf().map((match) => settle(match, 1, 0));
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host" })).json();
    for (const match of round) store.set(`picks:${match.id}`, JSON.stringify({ host: { p1: 1, p2: 0, ts: 1 } }));
    const season = await (await get(env)(`/state?code=${code}&uid=host`)).json();
    assert.equal(season.customMix, false);
    assert.equal(season.currentSlate, null);
    assert.equal(season.table[0].pts, 50);
    assert.equal(season.cabinet.weeks[0].slateType, "full");
    assert.equal(season.cabinet.weeks[0].fixtures, 10);
  });
});

// --- scheduled maintenance --------------------------------------------------

async function runScheduled(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

async function customMixLeague(env, { customMix = true } = {}) {
  const send = post(env);
  const { code } = await (await send("/league", { uid: "host", nickname: "Host", customMix })).json();
  await send("/join", { uid: "m2", code, nickname: "Two" });
  return code;
}

test("the inactive-host fallback waits until 24h out, not two hours", async () => {
  const round = roundOf(10, Date.now() + 25 * HOUR);
  const { env } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const code = await customMixLeague(env);

    // 25 hours out: the host is reminded, and nothing is unlocked.
    await runScheduled(env);
    assert.equal(await env.KV.get(`custom_slate:${code}:1`), null);
    assert.ok(await env.KV.get(`notified:slate-open:${code}:1`));
  });

  const closer = roundOf(10, Date.now() + 23 * HOUR);
  await withFixtures(closer, async () => {
    await primeFixtures(env);
    const code = (await env.KV.get("index:custom_mix"))[0];

    // Inside 24 hours with still no slate, the week is dealt for the host.
    // v1.5j: that is a random N on the league's own count — the same deal the
    // picker's dice would have made — rather than the whole card.
    await runScheduled(env);
    const slate = await env.KV.get(`custom_slate:${code}:1`);
    assert.equal(slate.status, "published");
    assert.equal(slate.setBy, null, "nobody chose it");
    assert.equal(slate.fixtureIds.length, 6, "the league's weekly count");
    assert.match(slate.ruleSource, /fallback-random/);
    assert.equal((await env.KV.get(`league:${code}`)).hadSlates, true);
  });
});

test("a host who has set a slate is never overridden by the fallback", async () => {
  const round = roundOf(10, Date.now() + 2 * HOUR);
  const { env } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const code = await customMixLeague(env);
    const ids = round.slice(0, 6).map((match) => match.id);
    await post(env)("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: ids });

    await runScheduled(env);
    const slate = await env.KV.get(`custom_slate:${code}:1`);
    assert.equal(slate.mode, "custom");
    assert.deepEqual(slate.fixtureIds, ids);
  });
});

test("the scheduled sweep trims a postponement and never swaps one in", async () => {
  const round = roundOf(10, Date.now() + 20 * HOUR);
  const { env } = endpointEnv(round);
  const ids = round.slice(0, 6).map((match) => match.id);
  let code;
  await withFixtures(round, async () => {
    await primeFixtures(env);
    code = await customMixLeague(env);
    await post(env)("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: ids });
  });

  // Still 20 hours out and nothing locked — but the slate is PUBLISHED, so the
  // postponed fixture is dropped rather than replaced. Snapshot integrity: the
  // league plays the six it was shown, minus the one that went.
  const postponed = round.map((match, index) => (index === 1 ? { ...match, status: "postponed" } : match));
  await withFixtures(postponed, async () => {
    await primeFixtures(env);
    await runScheduled(env);
    const slate = await env.KV.get(`custom_slate:${code}:1`);
    assert.deepEqual(slate.fixtureIds, ["pl-2026-27-md1-001", "pl-2026-27-md1-003", "pl-2026-27-md1-004", "pl-2026-27-md1-005", "pl-2026-27-md1-006"]);
    assert.ok(slate.revisedAt);
    // The snapshot still holds all six, with the casualty marked rather than erased.
    assert.equal(slate.snapshot.fixtures.length, 6);
    assert.equal(slate.snapshot.fixtures.find((f) => f.id === "pl-2026-27-md1-002").unavailable, true);
  });

  // Once the week is under way a further postponement is likewise removed.
  const started = roundOf(10, Date.now() - 2 * HOUR)
    .map((match, index) => (index === 3 ? { ...match, status: "postponed" } : match));
  await withFixtures(started, async () => {
    await primeFixtures(env);
    await runScheduled(env);
    const slate = await env.KV.get(`custom_slate:${code}:1`);
    assert.deepEqual(slate.fixtureIds, ["pl-2026-27-md1-001", "pl-2026-27-md1-003", "pl-2026-27-md1-005", "pl-2026-27-md1-006"]);
  });
});

test("a podium is announced once per league per matchweek", async () => {
  const round = roundOf(6, Date.now() - 6 * HOUR).map((match) => settle(match, 1, 0));
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const code = await customMixLeague(env, { customMix: false });
    for (const match of round) {
      store.set(`picks:${match.id}`, JSON.stringify({
        host: { p1: 1, p2: 0, ts: 1 },
        m2: { p1: 2, p2: 0, ts: 1 },
      }));
    }
    await runScheduled(env);
    assert.ok(await env.KV.get(`notified:podium:${code}:1`));
    assert.equal(await env.KV.get("sweep:settled"), 6);

    // A second tick with nothing newly settled does no work at all.
    store.delete(`notified:podium:${code}:1`);
    await runScheduled(env);
    assert.equal(await env.KV.get(`notified:podium:${code}:1`), null);
  });
});

// --- host succession --------------------------------------------------------

test("deleting the host's account hands the league to the longest-standing member", async () => {
  const round = roundOf();
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host", customMix: true })).json();
    // Join order is the succession order.
    await send("/join", { uid: "second", code, nickname: "Second" });
    await send("/join", { uid: "third", code, nickname: "Third" });
    store.set(`member:${code}:second`, JSON.stringify({ nick: "Second", since: 1000 }));
    store.set(`member:${code}:third`, JSON.stringify({ nick: "Third", since: 2000 }));

    const response = await send("/account/delete", { uid: "host" });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).succession, [{ code, owner: "second", nick: "Second" }]);

    const league = await env.KV.get(`league:${code}`);
    assert.equal(league.owner, "second");
    assert.equal(store.has(`member:${code}:host`), false);
    assert.equal(store.has(`user:host`), false);

    // The new host can now set the slate; the old one is simply gone.
    const ids = round.slice(0, 6).map((match) => match.id);
    assert.equal((await send("/league/slate", { uid: "third", code, matchweek: 1, fixtureIds: ids })).status, 403);
    assert.equal((await send("/league/slate", { uid: "second", code, matchweek: 1, fixtureIds: ids })).status, 200);
  });
});

test("deleting the only member's account closes the league behind them", async () => {
  const round = roundOf();
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "solo", nickname: "Solo", customMix: true })).json();
    const response = await send("/account/delete", { uid: "solo" });
    assert.deepEqual((await response.json()).closed, [code]);
    assert.equal(store.has(`league:${code}`), false);
    assert.deepEqual(await env.KV.get("index:custom_mix"), []);
  });
});

test("a member deleting their account leaves the league and its host alone", async () => {
  const round = roundOf();
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host" })).json();
    await send("/join", { uid: "leaver", code, nickname: "Leaver" });
    const response = await send("/account/delete", { uid: "leaver" });
    assert.deepEqual((await response.json()).succession, []);
    assert.equal((await env.KV.get(`league:${code}`)).owner, "host");
    assert.equal(store.has(`member:${code}:leaver`), false);
    assert.equal((await send("/account/delete", {})).status, 400);
  });
});

test("deleting a league removes its slates and its Custom Mix index entry", async () => {
  const round = roundOf();
  const { env, store } = endpointEnv(round);
  await withFixtures(round, async () => {
    await primeFixtures(env);
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", nickname: "Host", customMix: true })).json();
    await send("/league/slate", { uid: "host", code, matchweek: 1, fixtureIds: round.slice(0, 6).map((m) => m.id) });
    assert.ok(store.has(`custom_slate:${code}:1`));
    await send("/league/delete", { uid: "host", code });
    assert.equal(store.has(`custom_slate:${code}:1`), false);
    assert.deepEqual(await env.KV.get("index:custom_mix"), []);
  });
});
