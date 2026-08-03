// Names: how a joiner gets one, and how a profile name reaches the leagues
// that never had one.
//
// Both of Adam's joiners were stored as "Anon" because nothing ever carried a
// name to the server: the join sent an empty profile name, and saving a profile
// name was a purely local act. These run the real endpoints.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { DEFAULT_NICK, normNick } from "../src/logic.js";

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

const HOUR = 3600000;
const round = (count = 6) => Array.from({ length: count }, (_, i) => ({
  id: `pl-2026-27-md1-${String(i + 1).padStart(3, "0")}`, matchday: 1,
  player1: `H${i}`, player2: `A${i}`,
  startAt: new Date(Date.now() + 10 * 24 * HOUR + i * HOUR).toISOString(),
}));

async function withFixtures(list, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: list }), { status: 200 });
  try { return await run(); } finally { globalThis.fetch = original; }
}
const post = (env) => (path, body) => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) }), env);
const get = (env) => (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

async function league(env, extra = {}) {
  const created = await (await post(env)("/league", {
    uid: "host", nickname: "Adam", name: "Burtons Premier",
    competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 4, ...extra,
  })).json();
  return created.code;
}
const nicks = async (env, code) =>
  (await (await get(env)(`/state?code=${code}`)).json()).table.map((r) => r.nick).sort();
const memberNick = async (store, code, uid) => JSON.parse(store.get(`member:${code}:${uid}`)).nick;

function setup() {
  const store = new Map();
  return { store, env: { FIXTURES_URL: "https://example.com/f.json", KV: memoryKV(store) } };
}

// --- joining ----------------------------------------------------------------

test("a joiner who gives a name is stored under it, not Anon", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    await post(env)("/join", { uid: "tom", code, nick: "Tom" });
    assert.equal(await memberNick(store, code, "tom"), "Tom");
    assert.deepEqual(await nicks(env, code), ["Adam", "Tom"]);
  });
});

test("a joiner with only a profile name is stored under that", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    await post(env)("/join", { uid: "tom", code, nickname: "Tom" });
    assert.equal(await memberNick(store, code, "tom"), "Tom");
  });
});

test("a league name beats the profile name for that league only", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    await post(env)("/join", { uid: "tom", code, nickname: "Thomas", nick: "Tommo" });
    assert.equal(await memberNick(store, code, "tom"), "Tommo", "the league name wins here");
    assert.equal(JSON.parse(store.get("user:tom")).nickname, "Thomas", "the profile keeps its own");
  });
});

test("only a joiner who offers nothing at all is Anon", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    await post(env)("/join", { uid: "tom", code });
    assert.equal(await memberNick(store, code, "tom"), DEFAULT_NICK);
  });
});

// --- the profile name reaching leagues ---------------------------------------

test("saving a profile name replaces Anon everywhere it is still Anon", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const a = await league(env);
    const b = await (await post(env)("/league", { uid: "host", nickname: "Adam", name: "BVW", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 4 })).json();
    await post(env)("/join", { uid: "tom", code: a });
    await post(env)("/join", { uid: "tom", code: b.code });
    assert.equal(await memberNick(store, a, "tom"), DEFAULT_NICK);
    assert.equal(await memberNick(store, b.code, "tom"), DEFAULT_NICK);

    const result = await (await post(env)("/profile", { uid: "tom", nickname: "Tom" })).json();
    assert.deepEqual(result.updated.sort(), [a, b.code].sort(), "both leagues were still default");
    assert.deepEqual(result.kept, []);
    assert.equal(await memberNick(store, a, "tom"), "Tom");
    assert.equal(await memberNick(store, b.code, "tom"), "Tom");
    assert.equal(JSON.parse(store.get("user:tom")).nickname, "Tom");
  });
});

test("a name the viewer chose for a league is never overwritten", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const a = await league(env);
    const b = await (await post(env)("/league", { uid: "host", nickname: "Adam", name: "BVW", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 4 })).json();
    await post(env)("/join", { uid: "tom", code: a });
    await post(env)("/join", { uid: "tom", code: b.code });
    // Tom names himself deliberately in one of them.
    await post(env)("/league/nick", { uid: "tom", code: b.code, nick: "Biggers" });

    const result = await (await post(env)("/profile", { uid: "tom", nickname: "Tom" })).json();
    assert.deepEqual(result.updated, [a], "only the one still on the default");
    assert.deepEqual(result.kept, [b.code]);
    assert.equal(await memberNick(store, a, "tom"), "Tom");
    assert.equal(await memberNick(store, b.code, "tom"), "Biggers", "a chosen name is untouchable");
  });
});

test("a second profile save does not reclaim a league renamed since", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const a = await league(env);
    await post(env)("/join", { uid: "tom", code: a });
    await post(env)("/profile", { uid: "tom", nickname: "Tom" });
    await post(env)("/league/nick", { uid: "tom", code: a, nick: "Biggers" });
    const again = await (await post(env)("/profile", { uid: "tom", nickname: "Thomas" })).json();
    assert.deepEqual(again.updated, []);
    assert.equal(await memberNick(store, a, "tom"), "Biggers");
  });
});

test("the propagation rule is the same DEFAULT_NICK the fallback uses", () => {
  // One definition, so the thing that creates "Anon" and the thing that
  // replaces it can never disagree about what it is.
  assert.equal(normNick(""), DEFAULT_NICK);
  assert.equal(normNick("   "), DEFAULT_NICK);
  assert.equal(normNick("Tom"), "Tom");
});

test("a profile save is refused without a name rather than storing Anon", async () => {
  const { env } = setup();
  const blank = await post(env)("/profile", { uid: "tom", nickname: "  " });
  assert.equal(blank.status, 400);
  assert.match((await blank.json()).error, /nickname required/);
});

// --- the member rename path --------------------------------------------------

test("a member who is not the host can rename themselves", async () => {
  // Confirmed against the live worker too: this path was never host-gated, so
  // a rename that never arrived was never refused — it was never sent.
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    await post(env)("/join", { uid: "tom", code });
    const result = await post(env)("/league/nick", { uid: "tom", code, nick: "Tom" });
    assert.equal(result.status, 200);
    assert.equal(await memberNick(store, code, "tom"), "Tom");
    // And the host is untouched by it.
    assert.equal(await memberNick(store, code, "host"), "Adam");
  });
});

test("renaming in one league leaves the same viewer's other leagues alone", async () => {
  const { env, store } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const a = await league(env);
    const b = await (await post(env)("/league", { uid: "host", nickname: "Adam", name: "BVW", competitions: ["PL"], fixtureMode: "limited", fixtureLimit: 4 })).json();
    await post(env)("/join", { uid: "tom", code: a, nick: "Tom" });
    await post(env)("/join", { uid: "tom", code: b.code, nick: "Tom" });
    await post(env)("/league/nick", { uid: "tom", code: a, nick: "Biggers" });
    assert.equal(await memberNick(store, a, "tom"), "Biggers");
    assert.equal(await memberNick(store, b.code, "tom"), "Tom");
  });
});

test("a stranger cannot rename themselves into a league they never joined", async () => {
  const { env } = setup();
  await withFixtures(round(), async () => {
    await get(env)("/fixtures?refresh=1");
    const code = await league(env);
    const result = await post(env)("/league/nick", { uid: "nobody", code, nick: "Sneak" });
    assert.equal(result.status, 404);
  });
});
