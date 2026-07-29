import test from "node:test";
import assert from "node:assert/strict";
import worker, { mergeResultOverlay } from "../src/worker.js";

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

test("official completed result beats stale live overlay", () => {
  const official = { id: "m1", tour: "men", status: "complete", result: [2, 3], lockAt: "old" };
  const overlay = { status: "live", result: null, lockAt: "newer" };
  assert.deepEqual(mergeResultOverlay(official, overlay), official);
});

test("settlement overlay can still complete an unsettled fixture", () => {
  const official = { id: "m1", tour: "women", status: "live", result: null };
  const overlay = { status: "complete", result: [2, 0] };
  assert.deepEqual(mergeResultOverlay(official, overlay), { ...official, ...overlay });
});

test("fixtures endpoint declares manual settlement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [] }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/fixtures"), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).settlement, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serves apple app site association for universal links", async () => {
  const env = { KV: memoryKV(new Map()) };
  for (const path of ["/.well-known/apple-app-site-association", "/apple-app-site-association"]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await response.json();
    assert.deepEqual(body, {
      applinks: {
        apps: [],
        details: [{
          appID: "Y98F87NK7D.com.abigwood.premoracle",
          paths: ["/prem-oracle/*", "/prem-oracle/"],
        }],
      },
    });
  }
});

test("manual settlement preserves previous fixture results", async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    { id: "pl-2026-27-001-arsenal-coventry-city", player1: "Arsenal", player2: "Coventry City", startAt: "2026-08-21T20:00:00+01:00" },
    { id: "pl-2026-27-002-hull-city-manchester-united", player1: "Liverpool", player2: "Nottingham Forest", startAt: "2026-08-29T15:00:00+01:00" },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    SETTLE_SECRET: "test-secret",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  const settle = (results) => worker.fetch(new Request("https://worker.test/settle", {
    method: "POST",
    body: JSON.stringify({ secret: "test-secret", results }),
  }), env);
  try {
    let response = await settle({ "pl-2026-27-001-arsenal-coventry-city": { status: "complete", result: [2, 1] } });
    assert.equal(response.status, 200);
    response = await settle({ "pl-2026-27-002-hull-city-manchester-united": { status: "complete", result: [0, 0] } });
    assert.equal(response.status, 200);
    const results = JSON.parse(store.get("results:PL"));
    assert.deepEqual(Object.keys(results).sort(), ["pl-2026-27-001-arsenal-coventry-city", "pl-2026-27-002-hull-city-manchester-united"]);
    assert.deepEqual(results["pl-2026-27-001-arsenal-coventry-city"].result, [2, 1]);
    assert.deepEqual(results["pl-2026-27-002-hull-city-manchester-united"].result, [0, 0]);
    assert.equal(results["pl-2026-27-001-arsenal-coventry-city"].status, "complete");
    assert.equal(results["pl-2026-27-002-hull-city-manchester-united"].status, "complete");
    assert.ok(results["pl-2026-27-001-arsenal-coventry-city"].lockAt);
    assert.ok(results["pl-2026-27-002-hull-city-manchester-united"].lockAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual settle deletes a fixture result when passed null", async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    { id: "pl-2026-27-001-arsenal-coventry-city", player1: "Arsenal", player2: "Coventry City", startAt: "2026-08-21T20:00:00+01:00" },
    { id: "pl-2026-27-002-hull-city-manchester-united", player1: "Liverpool", player2: "Nottingham Forest", startAt: "2026-08-29T15:00:00+01:00" },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    SETTLE_SECRET: "test-secret",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  const settle = (results) => worker.fetch(new Request("https://worker.test/settle", {
    method: "POST",
    body: JSON.stringify({ secret: "test-secret", results }),
  }), env);
  try {
    await settle({ "pl-2026-27-001-arsenal-coventry-city": { status: "complete", result: [2, 1] } });
    await settle({ "pl-2026-27-002-hull-city-manchester-united": { status: "complete", result: [0, 0] } });
    assert.deepEqual(Object.keys(JSON.parse(store.get("results:PL"))).sort(), ["pl-2026-27-001-arsenal-coventry-city", "pl-2026-27-002-hull-city-manchester-united"]);

    const response = await settle({ "pl-2026-27-001-arsenal-coventry-city": null });
    assert.equal(response.status, 200);
    const results = JSON.parse(store.get("results:PL"));
    assert.deepEqual(Object.keys(results), ["pl-2026-27-002-hull-city-manchester-united"]);
    assert.deepEqual(results["pl-2026-27-002-hull-city-manchester-united"].result, [0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can kick a member without affecting the league or others", async () => {
  const store = new Map();
  const env = { KV: memoryKV(store) };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);

  const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
  const code = created.code;
  await post("/join", { uid: "m2", code, nickname: "Two" });
  await post("/join", { uid: "m3", code, nickname: "Three" });

  const leagues = async (uid) => (await env.KV.get(`user:${uid}`))?.leagues || [];
  const memberUids = () => [...store.keys()]
    .filter((key) => key.startsWith(`member:${code}:`))
    .map((key) => key.slice(`member:${code}:`.length))
    .sort();

  // Unknown league -> 404.
  assert.equal((await post("/league/kick", { uid: "owner", code: "ZZZZZZ", memberUid: "m2" })).status, 404);
  // Non-owner -> 403.
  const forbidden = await post("/league/kick", { uid: "m2", code, memberUid: "m3" });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "only the league owner can remove members");
  // Kicking the owner -> 400.
  const ownerKick = await post("/league/kick", { uid: "owner", code, memberUid: "owner" });
  assert.equal(ownerKick.status, 400);
  assert.equal((await ownerKick.json()).error, "the owner cannot be removed");
  // Unknown member -> 404.
  const missing = await post("/league/kick", { uid: "owner", code, memberUid: "ghost" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "member not found");

  // All the failed attempts left the roster intact.
  assert.deepEqual(memberUids(), ["m2", "m3", "owner"]);

  // Owner kicks m2 -> 200, gone from league + its own list, others untouched.
  const response = await post("/league/kick", { uid: "owner", code, memberUid: "m2" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, code, removed: "m2" });
  assert.deepEqual(memberUids(), ["m3", "owner"]);
  assert.equal(store.has(`member:${code}:m2`), false);
  assert.deepEqual(await leagues("m2"), []);
  assert.deepEqual(await leagues("m3"), [code]);
  assert.deepEqual(await leagues("owner"), [code]);
});

test("owner can delete a league, stripping the code from every member", async () => {
  const store = new Map();
  const env = { KV: memoryKV(store) };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);

  const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
  const code = created.code;
  await post("/join", { uid: "m2", nickname: "Two" });
  await post("/join", { uid: "m2", code, nickname: "Two" });
  await post("/join", { uid: "m3", code, nickname: "Three" });

  const leagues = async (uid) => (await env.KV.get(`user:${uid}`))?.leagues || [];
  assert.deepEqual(await leagues("owner"), [code]);
  assert.ok((await leagues("m2")).includes(code));
  assert.ok((await leagues("m3")).includes(code));

  // Unknown code -> 404.
  assert.equal((await post("/league/delete", { uid: "owner", code: "ZZZZZZ" })).status, 404);
  // Non-owner -> 403 and the league survives.
  const forbidden = await post("/league/delete", { uid: "m2", code });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "only the league owner can delete it");
  assert.ok(await env.KV.get(`league:${code}`));

  // Owner delete -> 200, league gone, code stripped from every member.
  const response = await post("/league/delete", { uid: "owner", code });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, code });
  assert.equal(await env.KV.get(`league:${code}`), null);
  assert.equal([...store.keys()].some((key) => key.startsWith(`member:${code}:`)), false);
  assert.deepEqual(await leagues("owner"), []);
  assert.deepEqual(await leagues("m2"), []);
  assert.deepEqual(await leagues("m3"), []);
});

test("simultaneous joins write independent member keys", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [] }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: memoryKV(store),
  };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);
  try {
    const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
    const code = created.code;
    const joiners = Array.from({ length: 6 }, (_, index) => ({
      uid: `member-${index + 1}`,
      nickname: `Member ${index + 1}`,
    }));

    const responses = await Promise.all(joiners.map((body) => post("/join", { ...body, code })));
    assert.deepEqual(responses.map((response) => response.status), Array(joiners.length).fill(200));

    const memberKeys = [...store.keys()]
      .filter((key) => key.startsWith(`member:${code}:`))
      .map((key) => key.slice(`member:${code}:`.length))
      .sort();
    assert.deepEqual(memberKeys, ["member-1", "member-2", "member-3", "member-4", "member-5", "member-6", "owner"]);
    assert.equal((await env.KV.get(`league:${code}`)).members, undefined);

    const state = await (await worker.fetch(new Request(`https://worker.test/state?code=${code}`), env)).json();
    assert.deepEqual(state.table.map((row) => row.uid).sort(), memberKeys);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state reports when the current matchday has settled fixtures", async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    { id: "pl-2026-27-001-arsenal-coventry-city", matchday: 1, player1: "Arsenal", player2: "Chelsea", startAt: "2026-08-21T20:00:00+01:00", status: "complete", result: [2, 1] },
    { id: "md1-002", matchday: 1, player1: "Everton", player2: "Leeds United", startAt: "2026-08-22T15:00:00+01:00", status: "upcoming", result: null },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures }), { status: 200 });
  const store = new Map([
    ["league:ROUND1", JSON.stringify({ code: "ROUND1", name: "Round League", owner: "owner" })],
    ["member:ROUND1:owner", JSON.stringify({ nick: "Owner", since: 0 })],
  ]);
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: memoryKV(store),
  };
  try {
    await worker.fetch(new Request("https://worker.test/fixtures?refresh=1"), env);
    let state = await (await worker.fetch(new Request("https://worker.test/state?code=ROUND1"), env)).json();
    assert.equal(state.currentMatchday, 1);
    assert.equal(state.currentMatchdayStatus, "in progress");
    assert.equal(state.currentMatchdayHasResults, true);

    fixtures[0].status = "upcoming";
    fixtures[0].result = null;
    await worker.fetch(new Request("https://worker.test/fixtures?refresh=1"), env);
    state = await (await worker.fetch(new Request("https://worker.test/state?code=ROUND1"), env)).json();
    assert.equal(state.currentMatchday, 1);
    assert.equal(state.currentMatchdayStatus, "in progress");
    assert.equal(state.currentMatchdayHasResults, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state still reads legacy embedded league members", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [] }), { status: 200 });
  const store = new Map([
    ["league:LEGACY", JSON.stringify({
      code: "LEGACY",
      name: "Legacy League",
      owner: "owner",
      members: ["owner", "m2"],
      names: { owner: "Owner", m2: "Two" },
      joinedAt: { owner: 1, m2: 2 },
    })],
  ]);
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: memoryKV(store),
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/state?code=LEGACY"), env);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.table.map((row) => row.uid).sort(), ["m2", "owner"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stats endpoint reports totals and weekly actives behind STATS_SECRET", async () => {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const store = new Map([
    ["user:u1", JSON.stringify({ nickname: "A" })],
    ["user:u2", JSON.stringify({ nickname: "B" })],
    ["user:u3", JSON.stringify({ nickname: "C" })],
    ["league:ABC", JSON.stringify({ code: "ABC" })],
    ["league:XYZ", JSON.stringify({ code: "XYZ" })],
    ["picks:m1", JSON.stringify({ u1: { p1: 1, p2: 0, ts: now - 1000 }, u2: { p1: 2, p2: 2, ts: now - week - 1000 } })],
    ["picks:m2", JSON.stringify({ u1: { p1: 0, p2: 0, ts: now - 2000 }, u3: { p1: 1, p2: 1, ts: now - 100 } })],
    // Unrelated prefixes must not be counted.
    ["push:u1", JSON.stringify({ token: "t" })],
    ["recovery:ace-ball-mint", JSON.stringify("u1")],
    ["results", JSON.stringify({})],
  ]);
  const env = {
    STATS_SECRET: "s3cret",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
      async list({ prefix = "", cursor } = {}) {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true, cursor: cursor || "" };
      },
    },
  };

  const forbidden = await worker.fetch(new Request("https://worker.test/stats"), env);
  assert.equal(forbidden.status, 403);

  const wrongSecret = await worker.fetch(new Request("https://worker.test/stats?secret=nope"), env);
  assert.equal(wrongSecret.status, 403);

  const response = await worker.fetch(new Request("https://worker.test/stats?secret=s3cret"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.users, 3);
  assert.equal(data.leagues, 2);
  assert.equal(data.picks, 4);
  assert.equal(data.activeUsers, 2);
});

test("CORS echoes allowlisted origins and marks the response as origin-varying", async () => {
  const env = { KV: memoryKV(new Map()) };
  const health = (origin) => worker.fetch(new Request("https://worker.test/health", {
    headers: origin ? { origin } : {},
  }), env);

  for (const origin of ["https://abigwood.github.io", "premoracle://localhost", "capacitor://localhost"]) {
    const response = await health(origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("vary"), "origin");
  }

  // Env-configured origin is also allowlisted.
  const envResponse = await worker.fetch(new Request("https://worker.test/health", {
    headers: { origin: "https://staging.example.com" },
  }), { ...env, ALLOWED_ORIGIN: "https://staging.example.com" });
  assert.equal(envResponse.headers.get("access-control-allow-origin"), "https://staging.example.com");
  assert.equal(envResponse.headers.get("vary"), "origin");

  // Unknown origin is not echoed; falls back to the default.
  const rejected = await health("https://evil.example.com");
  assert.equal(rejected.headers.get("access-control-allow-origin"), "*");
  assert.equal(rejected.headers.get("vary"), null);

  // No Origin header keeps the previous default behaviour.
  const noOrigin = await health(null);
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), "*");
  assert.equal(noOrigin.headers.get("vary"), null);
});

test("OPTIONS preflight is origin-aware for the native app scheme", async () => {
  const env = { KV: memoryKV(new Map()) };
  const preflight = await worker.fetch(new Request("https://worker.test/push-token", {
    method: "OPTIONS",
    headers: { origin: "premoracle://localhost" },
  }), env);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "premoracle://localhost");
  assert.equal(preflight.headers.get("vary"), "origin");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");

  const noOrigin = await worker.fetch(new Request("https://worker.test/push-token", { method: "OPTIONS" }), env);
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), "*");
  assert.equal(noOrigin.headers.get("vary"), null);
});

test("push token endpoint stores native registration token", async () => {
  const store = new Map();
  const env = {
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  const response = await worker.fetch(new Request("https://worker.test/push-token", {
    method: "POST",
    body: JSON.stringify({ uid: "user-1", nickname: "Adam", token: "apns-token", platform: "ios" }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(store.get("push:user-1")).token, "apns-token");
});

test("fixtures endpoint exposes the teams intel block and model version", async () => {
  const originalFetch = globalThis.fetch;
  const teams = {
    Arsenal: { rating: 92, form: "LWWWWW" },
    "Hull City": { rating: 50, form: "DLDDLW" },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ fixtures: [], teams, modelVersion: "1.1.0" }), { status: 200 });
  const store = new Map();
  const env = {
    FIXTURES_URL: "https://example.com/fixtures.json",
    KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  try {
    // refresh=1 bypasses the module-level fixtures cache.
    const response = await worker.fetch(new Request("https://worker.test/fixtures?refresh=1"), env);
    const body = await response.json();
    assert.deepEqual(body.teams, teams);
    assert.equal(body.modelVersion, "1.1.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /league/nick updates only that league's member row with normNick rules", async () => {
  const store = new Map();
  const env = { KV: memoryKV(store) };
  const post = (path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }), env);

  const created = await (await post("/league", { uid: "owner", nickname: "Owner" })).json();
  const code = created.code;
  await post("/join", { uid: "m2", code, nickname: "Two" });

  const memberNick = (uid) => store.has(`member:${code}:${uid}`)
    ? JSON.parse(store.get(`member:${code}:${uid}`)).nick
    : null;
  const globalNick = async (uid) => (await env.KV.get(`user:${uid}`))?.nickname;

  // Validation.
  assert.equal((await post("/league/nick", { uid: "m2", code })).status, 400); // no nick
  assert.equal((await post("/league/nick", { code, nick: "X" })).status, 400); // no uid
  assert.equal((await post("/league/nick", { uid: "m2", code: "ZZZZZZ", nick: "X" })).status, 404); // no league
  assert.equal((await post("/league/nick", { uid: "ghost", code, nick: "X" })).status, 404); // not a member
  assert.equal((await post("/league/nick", { uid: "m2", code, nick: "   " })).status, 400); // whitespace only

  // Happy path: trims, caps to normNick rules, updates only this member row.
  const long = "  " + "N".repeat(40) + "  ";
  const response = await post("/league/nick", { uid: "m2", code, nick: long });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.nick, "N".repeat(24)); // trimmed + capped at 24
  assert.equal(memberNick("m2"), "N".repeat(24));
  assert.equal(memberNick("owner"), "Owner"); // other member untouched
  assert.equal(await globalNick("m2"), "Two"); // global default name unchanged
});

test("ics endpoint serves one fixture as text/calendar", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = {
    id: "pl-md1-ars-cov",
    player1: "Arsenal",
    player2: "Coventry City",
    startAt: "2026-08-21T20:00:00+01:00",
    venue: "Emirates Stadium",
    matchday: 1,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [fixture] }), { status: 200 });
  const env = { FIXTURES_URL: "https://example.com/fixtures.json?ics-test", KV: memoryKV(new Map()) };
  try {
    // The fixture list is memoised module-wide; force a refresh so this test
    // doesn't read a list cached by an earlier one.
    await worker.fetch(new Request("https://worker.test/fixtures?refresh=1"), env);
    const response = await worker.fetch(new Request(`https://worker.test/ics/${fixture.id}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    // No attachment disposition: iOS should offer "Add to Calendar", not a download.
    assert.equal(response.headers.get("content-disposition"), null);
    const body = await response.text();
    assert.ok(body.startsWith("BEGIN:VCALENDAR"));
    assert.ok(body.includes("SUMMARY:⚽ Arsenal v Coventry City"));
    assert.ok(!body.includes("Your prediction"));

    const withPick = await worker.fetch(new Request(`https://worker.test/ics/${fixture.id}?pick=3-1`), env);
    assert.ok((await withPick.text()).includes("Your prediction: Arsenal 3-1 Coventry City"));

    const missing = await worker.fetch(new Request("https://worker.test/ics/not-a-fixture"), env);
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/picks scans only the competitions the player actually plays", async () => {
  const originalFetch = globalThis.fetch;
  const pl = [{ id: "pl-2026-27-001-a-b", matchday: 1, player1: "A", player2: "B", startAt: "2026-08-21T19:00:00Z" }];
  const elc = [{ id: "elc-2026-27-001-c-d", matchday: 1, player1: "C", player2: "D", startAt: "2026-08-14T19:00:00Z" }];
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    fixtures: String(url).includes("elc") ? elc : pl,
  }), { status: 200 });

  const store = new Map();
  const reads = [];
  const base = memoryKV(store);
  const env = {
    FIXTURES_URL: "https://example.com/pl.json",
    FIXTURES_URL_ELC: "https://example.com/elc.json",
    KV: { ...base, async get(key, type) { reads.push(key); return base.get(key, type); } },
  };
  try {
    // The fixture cache is module-level and shared across tests in this file,
    // so prime both competitions from these feeds before asserting on reads.
    await worker.fetch(new Request("https://worker.test/fixtures?competition=PL&refresh=1"), env);
    await worker.fetch(new Request("https://worker.test/fixtures?competition=ELC&refresh=1"), env);

    // A Premier-League-only player.
    store.set("user:plonly", JSON.stringify({ nickname: "PL", leagues: ["AAAAAA"] }));
    store.set("league:AAAAAA", JSON.stringify({ code: "AAAAAA", name: "PL league", owner: "plonly", competition: "PL" }));
    reads.length = 0;
    await worker.fetch(new Request("https://worker.test/picks?uid=plonly"), env);
    assert.ok(reads.some((k) => k === "picks:pl-2026-27-001-a-b"), "reads its own competition's picks");
    assert.ok(!reads.some((k) => k.startsWith("picks:elc-")), "never touches Championship picks");

    // A Championship-only player.
    store.set("user:elconly", JSON.stringify({ nickname: "ELC", leagues: ["BBBBBB"] }));
    store.set("league:BBBBBB", JSON.stringify({ code: "BBBBBB", name: "ELC league", owner: "elconly", competition: "ELC" }));
    reads.length = 0;
    await worker.fetch(new Request("https://worker.test/picks?uid=elconly"), env);
    assert.ok(reads.some((k) => k === "picks:elc-2026-27-001-c-d"), "reads its own competition's picks");
    assert.ok(!reads.some((k) => k.startsWith("picks:pl-")), "never touches Premier League picks");

    // Someone in both pays for both, and only then.
    store.set("user:both", JSON.stringify({ nickname: "Both", leagues: ["AAAAAA", "BBBBBB"] }));
    reads.length = 0;
    await worker.fetch(new Request("https://worker.test/picks?uid=both"), env);
    assert.ok(reads.some((k) => k.startsWith("picks:pl-")));
    assert.ok(reads.some((k) => k.startsWith("picks:elc-")));

    // A player with no leagues at all falls back to the default competition.
    store.set("user:none", JSON.stringify({ nickname: "None", leagues: [] }));
    reads.length = 0;
    await worker.fetch(new Request("https://worker.test/picks?uid=none"), env);
    assert.ok(reads.some((k) => k.startsWith("picks:pl-")));
    assert.ok(!reads.some((k) => k.startsWith("picks:elc-")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
