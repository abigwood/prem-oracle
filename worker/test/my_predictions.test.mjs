// My Predictions: which picks are shown, and how they are sectioned.
//
// The visibility rule has real consequences — a pick vanishing from a user's
// own record is not something to assert by grepping — so the functions are
// lifted out of app.js and executed against stub state, in the same style as
// the dice and week-strip tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker from "../src/worker.js";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < APP.length; i++) {
    if (APP[i] === "{") { depth++; seen = true; }
    else if (APP[i] === "}") {
      depth--;
      if (seen && depth === 0) return APP.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${startsWith}`);
}

/** app.js's visibility logic, with only the globals it touches. */
function harness({ picks = {}, fixtures = [], contexts = [] } = {}) {
  const build = new Function("picks", "fixtures", "extraFixtures", `
    "use strict";
    const escapeHTML = (v) => String(v ?? "");
    ${lift("const byKickoffAsc = (a, b) =>")}
    ${lift("const fixtureById = (id) =>")}
    ${lift("function hiddenPickIds(contexts = leaguePickContexts())")}
    ${lift("function visiblePickedFixtures(hidden = hiddenPickIds())")}
    ${lift("function sharedLeagueNote(fixtureId, contexts, thisCode)")}
    return { hiddenPickIds, visiblePickedFixtures, sharedLeagueNote };
  `);
  const api = build(picks, fixtures, {});
  return {
    hidden: () => api.hiddenPickIds(contexts),
    visible: () => api.visiblePickedFixtures(api.hiddenPickIds(contexts)),
    note: (id, code) => api.sharedLeagueNote(id, contexts, code),
  };
}

const fixture = (id, hour = 12) => ({ id, matchday: 1, player1: "A", player2: "B", startAt: `2026-08-15T${String(hour).padStart(2, "0")}:00:00Z` });
const league = (code, name, lineup, dropped = []) => ({
  code, name, lineup: new Set(lineup.map(String)), dropped: new Set(dropped.map(String)),
});

// --- the visibility rule ----------------------------------------------------

test("a pick dropped by an amendment, and asked for by nobody, is hidden", () => {
  const all = ["pl-1", "pl-2", "pl-3"].map((id) => fixture(id));
  const h = harness({
    picks: { "pl-1": {}, "pl-2": {}, "pl-3": {} },
    fixtures: all,
    contexts: [league("AAA", "Sunday Six", ["pl-1", "pl-2"], ["pl-3"])],
  });
  assert.deepEqual([...h.hidden()], ["pl-3"]);
  assert.deepEqual(h.visible().map((f) => f.id), ["pl-1", "pl-2"]);
});

test("a dropped fixture that was re-added is shown again, pick intact", () => {
  const all = ["pl-1", "pl-2"].map((id) => fixture(id));
  const picks = { "pl-1": { p1: 2, p2: 1 }, "pl-2": { p1: 0, p2: 0 } };
  // Dropped at v2...
  const droppedOnly = harness({ picks, fixtures: all, contexts: [league("AAA", "L", ["pl-1"], ["pl-2"])] });
  assert.deepEqual(droppedOnly.visible().map((f) => f.id), ["pl-1"]);
  // ...and put back at v3: the league lists it again, so it is not dropped.
  const readded = harness({ picks, fixtures: all, contexts: [league("AAA", "L", ["pl-1", "pl-2"], ["pl-2"])] });
  assert.deepEqual(readded.visible().map((f) => f.id), ["pl-1", "pl-2"]);
  // And the prediction that comes back is the one originally made.
  assert.deepEqual(picks["pl-2"], { p1: 0, p2: 0 }, "the stored pick was never touched");
});

test("a viewer with no leagues sees every pick they have made", () => {
  const all = ["pl-1", "pl-2", "pl-3"].map((id) => fixture(id));
  const h = harness({ picks: { "pl-1": {}, "pl-2": {}, "pl-3": {} }, fixtures: all, contexts: [] });
  assert.equal(h.hidden().size, 0);
  assert.deepEqual(h.visible().map((f) => f.id), ["pl-1", "pl-2", "pl-3"]);
});

test("a pick on a fixture no league ever listed is never hidden", () => {
  const all = ["pl-1", "pl-solo"].map((id) => fixture(id));
  const h = harness({
    picks: { "pl-1": {}, "pl-solo": {} },
    fixtures: all,
    contexts: [league("AAA", "L", ["pl-1"], ["pl-9"])],
  });
  assert.equal(h.hidden().has("pl-solo"), false, "never in a line-up, so never dropped");
  assert.deepEqual(h.visible().map((f) => f.id), ["pl-1", "pl-solo"]);
});

test("one league dropping it does not hide it while another still asks", () => {
  const all = ["pl-1", "pl-shared"].map((id) => fixture(id));
  const h = harness({
    picks: { "pl-1": {}, "pl-shared": {} },
    fixtures: all,
    contexts: [
      league("AAA", "Sunday Six", ["pl-1"], ["pl-shared"]),   // dropped it
      league("BBB", "Tuesday Club", ["pl-shared"]),           // still wants it
    ],
  });
  assert.equal(h.hidden().size, 0, "still asked for, so still shown");
  assert.deepEqual(h.visible().map((f) => f.id), ["pl-1", "pl-shared"]);
});

test("both leagues dropping it hides it once", () => {
  const all = ["pl-1", "pl-shared"].map((id) => fixture(id));
  const h = harness({
    picks: { "pl-1": {}, "pl-shared": {} },
    fixtures: all,
    contexts: [
      league("AAA", "Sunday Six", ["pl-1"], ["pl-shared"]),
      league("BBB", "Tuesday Club", ["pl-1"], ["pl-shared"]),
    ],
  });
  assert.deepEqual([...h.hidden()], ["pl-shared"]);
});

// --- sections ---------------------------------------------------------------

test("a fixture in two line-ups is noted as shared, in both directions", () => {
  const contexts = [
    league("AAA", "Sunday Six", ["pl-shared", "pl-1"]),
    league("BBB", "Tuesday Club", ["pl-shared"]),
  ];
  const h = harness({ contexts });
  assert.match(h.note("pl-shared", "AAA"), /Also in Tuesday Club/);
  assert.match(h.note("pl-shared", "BBB"), /Also in Sunday Six/);
  assert.match(h.note("pl-shared", "AAA"), /one pick counts in both/);
  assert.equal(h.note("pl-1", "AAA"), "", "a fixture only one league wants carries no note");
});

// --- what the worker hands the app -----------------------------------------

// Fixtures sit a clear stretch in the future, not on a fixed date. A league is
// created at the wall clock, so a fixed date silently turns the host into a
// member who joined AFTER the week — scoring zero and locking the slate — the
// moment the real date passes it.
const AHEAD = 10 * 24 * 60 * 60 * 1000;
const round = (count = 10, firstKickoff = Date.now() + AHEAD) =>
  Array.from({ length: count }, (_, index) => ({
    id: `pl-2026-27-md1-${String(index + 1).padStart(3, "0")}`,
    matchday: 1, player1: `H${index}`, player2: `A${index}`,
    startAt: new Date(firstKickoff + index * 3600000).toISOString(),
  }));

function memoryKV(store = new Map()) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" || type === undefined ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

async function withFixtures(list, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: list }), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = original; }
}
const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) }), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

test("/state reports the line-up and what amendments dropped", async () => {
  const list = round(10, Date.now() + 20 * 3600000);
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) };
  await withFixtures(list, async () => {
    await get(env)("/fixtures?refresh=1");
    const send = post(env);
    const { code } = await (await send("/league", { uid: "host", competitions: ["PL"], fixtureMode: "limited" })).json();
    const ids = list.map((m) => m.id);

    await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: ids.slice(0, 6) });
    let state = await (await get(env)(`/state?code=${code}`)).json();
    assert.deepEqual(state.lineupFixtureIds.sort(), ids.slice(0, 6).sort());
    assert.deepEqual(state.droppedFixtureIds, [], "nothing dropped before an amendment");

    // Amend: drop the first two, add two more.
    await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: ids.slice(2, 8) });
    state = await (await get(env)(`/state?code=${code}`)).json();
    assert.deepEqual(state.lineupFixtureIds.sort(), ids.slice(2, 8).sort());
    assert.deepEqual(state.droppedFixtureIds.sort(), [ids[0], ids[1]].sort());

    // Put one back: it stops being dropped, because the league asks for it again.
    await send("/league/slate", { uid: "host", code, period: "1", fixtureIds: [ids[0], ...ids.slice(2, 8)] });
    state = await (await get(env)(`/state?code=${code}`)).json();
    assert.ok(state.lineupFixtureIds.includes(ids[0]));
    assert.deepEqual(state.droppedFixtureIds, [ids[1]], "only the one still unasked-for");
  });
});

test("a league that has never amended reports nothing dropped", async () => {
  const list = round(10, Date.now() + 20 * 3600000);
  const store = new Map();
  const env = { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) };
  await withFixtures(list, async () => {
    await get(env)("/fixtures?refresh=1");
    const { code } = await (await post(env)("/league", { uid: "host", competitions: ["PL"], fixtureMode: "limited" })).json();
    await post(env)("/league/slate", { uid: "host", code, period: "1", fixtureIds: list.slice(0, 4).map((m) => m.id) });
    const state = await (await get(env)(`/state?code=${code}`)).json();
    assert.deepEqual(state.droppedFixtureIds, []);
    assert.equal(state.lineupFixtureIds.length, 4);
  });
});
