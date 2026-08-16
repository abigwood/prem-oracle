// Mates' Picks — the round endpoint itself.
//
// The gate is unit-tested next door; this drives the real handler end to end,
// because the promise is about what comes back over the wire to a particular
// asker, and that is decided by the request as a whole: who signed it, whether
// they are still in the league, and what the clock said when it was answered.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const HOUR = 60 * 60 * 1000;
const AHEAD = 10 * 24 * HOUR;

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

/** Two fixtures: one that kicked off an hour ago, one still days away. */
function round({ matchday = 1 } = {}) {
  return [
    { id: `pl-2026-27-md${matchday}-001`, matchday, player1: "Arsenal", player2: "Chelsea",
      startAt: new Date(Date.now() - HOUR).toISOString() },
    { id: `pl-2026-27-md${matchday}-002`, matchday, player1: "Spurs", player2: "Everton",
      startAt: new Date(Date.now() + AHEAD).toISOString() },
  ];
}

async function withFixtures(fixtureList, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: fixtureList }), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
  method: "POST", body: JSON.stringify(body),
}), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

/**
 * A league of three with picks on the kicked-off fixture, ready to ask about.
 *
 * The three founders are backdated a month. A league created at the wall clock
 * has members who joined AFTER any fixture that has already kicked off, and the
 * eligibility rule would then correctly omit every one of them — which is the
 * right answer to the wrong question for most of these tests.
 */
async function league(fixtures) {
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/fixtures.json", KV: memoryKV(store) };
  await get(env)("/fixtures?refresh=1");
  const send = post(env);
  const { code } = await (await send("/league", { uid: "host", nickname: "Host" })).json();
  await send("/join", { uid: "m2", code, nickname: "Two" });
  await send("/join", { uid: "m3", code, nickname: "Three" });
  const founded = Date.now() - 30 * 24 * HOUR;
  for (const uid of ["host", "m2", "m3"]) {
    const key = `member:${code}:${uid}`;
    const row = JSON.parse(store.get(key));
    store.set(key, JSON.stringify({ ...row, since: founded }));
  }
  const ts = Date.now() - 2 * HOUR;
  store.set(`picks:${fixtures[0].id}`, JSON.stringify({
    host: { p1: 2, p2: 1, ts }, m2: { p1: 0, p2: 0, ts },
  }));
  store.set(`picks:${fixtures[1].id}`, JSON.stringify({
    host: { p1: 3, p2: 3, ts }, m2: { p1: 1, p2: 4, ts }, m3: { p1: 2, p2: 2, ts },
  }));
  return { env, store, code, send };
}

const reveal = async (env, code, uid, matchday = 1) =>
  (await (await get(env)(`/state?code=${code}&period=${matchday}${uid ? `&uid=${uid}` : ""}`)).json()).reveal;

test("a member sees kicked-off picks and nothing from the fixture still to come", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const entries = await reveal(env, code, "host");
    assert.equal(entries.length, 2);

    const [kickedOff, upcoming] = entries;
    assert.equal(kickedOff.revealed, true);
    // Content, not order: ordering is a presentation rule the client owns
    // (rank, viewer pinned, ties alphabetical) and is tested there.
    assert.deepEqual([...kickedOff.picks].map((row) => [row.nick, row.p1, row.p2]).sort(),
      [["Host", 2, 1], ["Three", null, null], ["Two", 0, 0]]);
    assert.equal(kickedOff.picks.find((row) => row.nick === "Three").none, true,
      "Three was eligible and did not pick");

    assert.equal(upcoming.revealed, false);
    assert.equal(upcoming.picks, undefined);
    // The counter can say how many are in without saying what they are.
    assert.equal(upcoming.lockedIn, 3);
    assert.equal(upcoming.eligible, 3);
    assert.doesNotMatch(JSON.stringify(upcoming), /"p1"|"p2"/);
  });
});

// --- backward compatibility -------------------------------------------------
//
// Released 1.6.4 clients call this endpoint with no uid whatsoever. The
// membership rule guards the new field ONLY: it must never change, reject or
// diminish the round response those clients already depend on. This is what
// makes a worker-first deploy safe.

/** Everything the round response has always promised, by key. */
const LEGACY_CONTRACT = ["code", "name", "owner", "period", "matchday", "windowLabel",
  "poolSize", "slate", "draft", "preload", "table", "status", "complete", "winners", "podium",
  "competitions", "competitionNames", "mixed", "weeklyRule", "fixtureMode", "fixtureLimit"];

test("an old client with no uid gets the whole legacy response and no reveal", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const response = await get(env)(`/state?code=${code}&period=1`);
    assert.equal(response.status, 200, "never a 403 merely for being old");
    const body = await response.json();
    for (const key of LEGACY_CONTRACT) assert.ok(key in body, `${key} still answered`);
    assert.equal(body.reveal, undefined, "and no field it has never seen");
    assert.equal(body.table.length, 3, "with the table it came for");
    assert.doesNotMatch(JSON.stringify(body), /"p1":|"p2":/, "no predictions anywhere in it");
  });
});

test("an unsigned response is byte-identical to the one before the feature", async () => {
  // The strongest form of "unchanged": the legacy answer and the answer to the
  // same request with a stranger's uid differ in nothing at all.
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const legacy = await (await get(env)(`/state?code=${code}&period=1`)).json();
    const stranger = await (await get(env)(`/state?code=${code}&period=1&uid=nobody`)).json();
    assert.deepEqual(stranger, legacy);
  });
});

test("a non-member or unknown uid gets no reveal field at all", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    for (const asker of ["stranger", "", "%20", "null"]) {
      const body = await (await get(env)(`/state?code=${code}&period=1&uid=${asker}`)).json();
      assert.equal(body.reveal, undefined, `"${asker}" gets no reveal field`);
      assert.ok(body.table, "but still gets the round");
      assert.doesNotMatch(JSON.stringify(body), /"p1":|"p2":/);
    }
  });
});

test("a removed member drops back to the legacy response", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code, send } = await league(fixtures);
    await send("/league/kick", { uid: "host", code, memberUid: "m2" });
    const body = await (await get(env)(`/state?code=${code}&period=1&uid=m2`)).json();
    assert.equal(body.status !== undefined, true, "the round still answers");
    assert.equal(body.reveal, undefined, "with no reveal field");
    assert.doesNotMatch(JSON.stringify(body), /"p1":|"p2":/);
  });
});

test("only the answer carrying predictions is withheld from shared caches", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const legacy = await get(env)(`/state?code=${code}&period=1`);
    assert.equal(legacy.headers.get("cache-control"), null,
      "an unsigned round is the same public data it always was");
    const member = await get(env)(`/state?code=${code}&period=1&uid=host`);
    assert.equal(member.headers.get("cache-control"), "private, no-store");
  });
});

test("a removed member stops receiving picks on the next request", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code, send } = await league(fixtures);
    assert.ok((await reveal(env, code, "m2"))[0].picks, "a member while they are one");

    const kicked = await send("/league/kick", { uid: "host", code, memberUid: "m2" });
    assert.equal(kicked.status, 200);

    assert.equal(await reveal(env, code, "m2"), undefined, "and nothing once removed");
    assert.ok((await reveal(env, code, "host"))[0].picks, "while the rest of the league is unaffected");
  });
});

test("a member who joined after kick-off is omitted from that fixture only", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code, send } = await league(fixtures);
    // Joins now — after the first fixture kicked off, before the second.
    await send("/join", { uid: "late", code, nickname: "Latecomer" });

    const [kickedOff, upcoming] = await reveal(env, code, "host");
    assert.equal(kickedOff.picks.some((row) => row.uid === "late"), false,
      "omitted from the fixture that locked before they arrived");
    assert.equal(kickedOff.eligible, 3);
    assert.doesNotMatch(JSON.stringify(kickedOff), /Latecomer/, "not even as No pick");
    assert.equal(upcoming.eligible, 4, "but counted for the fixture still to come");
  });
});

test("the response carrying picks is nobody else's to cache", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const response = await get(env)(`/state?code=${code}&period=1&uid=host`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
});

test("the season response is unchanged — Mates' Picks is weekly only", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const season = await (await get(env)(`/state?code=${code}&uid=host`)).json();
    assert.equal(season.reveal, undefined, "no reveal field on the season branch");
    assert.ok(season.table, "and everything it already returned is still there");
  });
});

test("adding the reveal costs no extra KV reads", async () => {
  // The 940-read incident is the reason this feature rides on the round
  // endpoint at all. Counting the reads is the only way that stays true.
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    let reads = 0;
    const counted = { ...env, KV: { ...env.KV, get: (key) => { reads += 1; return env.KV.get(key); } } };

    await get(counted)(`/state?code=${code}&period=1`);
    const withoutViewer = reads;
    reads = 0;
    await get(counted)(`/state?code=${code}&period=1&uid=host`);
    const withViewer = reads;

    assert.equal(withViewer, withoutViewer,
      "serializing the reveal reads nothing the scoring pass had not already read");
  });
});

test("the round table and podium are untouched by the addition", async () => {
  const fixtures = round();
  await withFixtures(fixtures, async () => {
    const { env, code } = await league(fixtures);
    const body = await (await get(env)(`/state?code=${code}&period=1&uid=host`)).json();
    for (const key of ["code", "name", "owner", "period", "matchday", "table", "status", "complete", "winners", "podium"]) {
      assert.ok(key in body, `${key} still answered`);
    }
    assert.equal(body.table.length, 3);
  });
});
