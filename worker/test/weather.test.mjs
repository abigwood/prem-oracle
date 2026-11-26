// v1.9 Slice 2 §B — live match weather from Apple WeatherKit.
//
// The rule under test is Adam's: ALWAYS FREE. Exactly two fetches in a
// fixture's life, server-side only, behind a hard monthly cap, and with no
// secrets nothing happens at all. Every test drives the REAL pass against an
// in-memory KV and a recording fake WeatherKit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { dailyWeather } from "../src/worker.js";
import {
  STADIUMS, buildWeatherToken, dueForecasts, isDailyPassTick, ukParts,
  weatherCallsKey, weatherKey, weatherPass, mergeWeather, usableWeather,
} from "../src/weather.js";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const b64urlDecode = (value) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function p8() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function memoryKV(store = new Map()) {
  const ops = [];
  return {
    store, ops,
    async get(key, type) {
      ops.push(["get", key]);
      if (!store.has(key)) return null;
      return type === "json" ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { ops.push(["put", key]); store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

/** A fake WeatherKit: answers the kick-off hour it was asked for, and records every call. */
function fakeWeatherKit({ status = 200, temp = 11.4, code = "Rain" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, auth: init?.headers?.authorization });
    if (status !== 200) return new Response("nope", { status });
    const start = u.searchParams.get("hourlyStart");
    return new Response(JSON.stringify({
      forecastHourly: { hours: [{ forecastStart: start, temperature: temp, conditionCode: code }] },
    }), { status: 200 });
  };
  return { calls, fetchImpl };
}

let ENV_KEY;
async function env(extra = {}) {
  ENV_KEY ||= (await p8()).pem;
  return { WEATHERKIT_KEY: ENV_KEY, WEATHERKIT_KEY_ID: "KEYID12345", WEATHERKIT_SERVICE_ID: "com.abigwood.premoracle.weather", KV: memoryKV(), ...extra };
}

const match = (id, venue, startAt) => ({ id, venue, startAt, player1: "A", player2: "B" });
const QUARTER = 15 * 60 * 1000;
const slotOf = (call) => `${call.url.pathname}|${call.url.searchParams.get("hourlyStart")}`;

test("the 06:00 tick is the only one that may fetch, in GMT and in BST", () => {
  // BST: 05:00Z is 06:00 UK. GMT: 06:00Z is 06:00 UK.
  assert.equal(isDailyPassTick(Date.parse("2026-08-20T05:00:00Z")), true);
  assert.equal(isDailyPassTick(Date.parse("2026-08-20T06:00:00Z")), false);
  assert.equal(isDailyPassTick(Date.parse("2026-11-20T06:00:00Z")), true);
  assert.equal(isDailyPassTick(Date.parse("2026-11-20T05:45:00Z")), false);
  assert.equal(isDailyPassTick(Date.parse("2026-11-20T06:15:00Z")), false);
  let ticks = 0;
  for (let t = Date.parse("2026-10-01T00:00:00Z"); t < Date.parse("2026-11-01T00:00:00Z"); t += QUARTER) {
    if (isDailyPassTick(t)) ticks++;
  }
  assert.equal(ticks, 31, "one tick a day, across the October DST change");
});

test("exactly two fetches per fixture across simulated weeks of */15 ticks — DST and duplicated ticks included", async () => {
  const e = await env();
  const wk = fakeWeatherKit();
  // Kick-offs either side of the 25 Oct 2026 clock change, at awkward hours,
  // two of them sharing a ground and a kick-off hour (one call between them).
  const list = [
    match("f1", "Emirates Stadium", "2026-10-24T14:00:00Z"),
    match("f2", "Emirates Stadium", "2026-10-24T14:30:00Z"),   // same ground, same hour as f1
    match("f3", "Anfield", "2026-10-25T16:30:00Z"),            // clock-change day
    match("f4", "Old Trafford", "2026-10-31T20:00:00Z"),       // 20:00 GMT: 7.58 days out at 06:00
    match("f5", "The Den", "2026-11-01T12:00:00Z"),            // the Sunday the clocks have just gone back
    match("f6", "bet365 Stadium", "2026-11-03T12:30:00Z"),
    match("f7", "Nowhere Park", "2026-10-28T15:00:00Z"),        // unknown venue: never fetched
  ];
  for (let t = Date.parse("2026-10-10T00:00:00Z"); t < Date.parse("2026-11-05T00:00:00Z"); t += QUARTER) {
    await weatherPass(e, { PL: list }, t, { fetchImpl: wk.fetchImpl });
    await weatherPass(e, { PL: list }, t, { fetchImpl: wk.fetchImpl });   // a duplicated delivery
  }
  const bySlot = new Map();
  for (const call of wk.calls) bySlot.set(slotOf(call), (bySlot.get(slotOf(call)) || 0) + 1);
  // Six known fixtures, f1 and f2 sharing a slot: five slots, two calls each.
  assert.equal(bySlot.size, 5);
  for (const [slot, n] of bySlot) assert.equal(n, 2, `${slot} fetched ${n} times`);
  assert.equal(wk.calls.length, 10);
  // The store keeps what is still to come, and forgets fixtures three days
  // after kick-off, so it never grows past a fortnight's worth.
  const store = JSON.parse(e.KV.store.get(weatherKey("PL")));
  assert.deepEqual(Object.keys(store).sort(), ["f4", "f5", "f6"]);
  for (const id of ["f4", "f5", "f6"]) {
    assert.deepEqual(store[id].passes, ["week", "day"], id);
    assert.equal(store[id].weather.temp, 11);
    assert.equal(store[id].weather.icon, "🌧");
  }
  assert.ok(wk.calls.every((c) => /^Bearer /.test(c.auth)));
});

test("catch-up: a fixture first seen 1–6 days out gets its first forecast at the next 06:00, then the matchday one — still two calls", async () => {
  const e = await env();
  const wk = fakeWeatherKit();
  // This weekend's game: the pass first sees it on Friday (e.g. it was added late,
  // or build 36 only looked exactly seven days out).
  const list = [match("late", "Pride Park Stadium", "2026-11-28T15:00:00Z"), match("tue", "Anfield", "2026-12-01T20:00:00Z")];
  for (let t = Date.parse("2026-11-27T00:00:00Z"); t < Date.parse("2026-12-02T00:00:00Z"); t += QUARTER) {
    await weatherPass(e, { ELC: list }, t, { fetchImpl: wk.fetchImpl });
  }
  assert.equal(wk.calls.length, 4, "two fixtures, two calls each");
  const store = JSON.parse(e.KV.store.get(weatherKey("ELC")));
  assert.deepEqual(store.tue.passes, ["week", "day"]);
});

test("a week pass, then a day pass, each one call — and a pass is claimed before its call", async () => {
  const e = await env();
  const wk = fakeWeatherKit({ status: 500 });
  const list = [match("m1", "Villa Park", "2026-11-28T15:00:00Z")];
  const weekTick = Date.parse("2026-11-21T06:00:00Z");
  const stats = await weatherPass(e, { PL: list }, weekTick, { fetchImpl: wk.fetchImpl });
  assert.equal(stats.calls, 1);
  assert.equal(stats.errors, 1);
  // The failed call still spent the pass: no retry on the next tick, or the next day.
  await weatherPass(e, { PL: list }, weekTick, { fetchImpl: wk.fetchImpl });
  await weatherPass(e, { PL: list }, Date.parse("2026-11-22T06:00:00Z"), { fetchImpl: wk.fetchImpl });
  assert.equal(wk.calls.length, 1);
  assert.equal(JSON.parse(e.KV.store.get(weatherCallsKey("2026-11"))), 1, "a failed call is still counted");
});

test("an error keeps the last stored forecast", async () => {
  const e = await env();
  const list = [match("m1", "Villa Park", "2026-11-28T15:00:00Z")];
  await weatherPass(e, { PL: list }, Date.parse("2026-11-21T06:00:00Z"), { fetchImpl: fakeWeatherKit({ temp: 7 }).fetchImpl });
  const failing = fakeWeatherKit({ status: 503 });
  const stats = await weatherPass(e, { PL: list }, Date.parse("2026-11-28T06:00:00Z"), { fetchImpl: failing.fetchImpl });
  assert.equal(failing.calls.length, 1);
  assert.equal(stats.errors, 1);
  const store = JSON.parse(e.KV.store.get(weatherKey("PL")));
  assert.equal(store.m1.weather.temp, 7, "the week-out forecast survived the failed morning call");
  assert.deepEqual(store.m1.passes, ["week", "day"]);
});

test("the monthly cap stops calls, and a capped fixture keeps what it had", async () => {
  const e = await env({ WEATHERKIT_MONTHLY_CAP: "1" });
  const wk = fakeWeatherKit();
  const list = [
    match("a", "Anfield", "2026-11-28T15:00:00Z"),
    match("b", "Elland Road", "2026-11-28T15:00:00Z"),
    match("c", "Turf Moor", "2026-11-28T17:30:00Z"),
  ];
  const stats = await weatherPass(e, { PL: list }, Date.parse("2026-11-21T06:00:00Z"), { fetchImpl: wk.fetchImpl });
  assert.equal(wk.calls.length, 1);
  assert.equal(stats.capped, 2);
  // Already at the cap this month: nothing more, whatever is owed.
  e.KV.store.set(weatherCallsKey("2026-11"), "3000");
  const e2 = { ...e, WEATHERKIT_MONTHLY_CAP: undefined };
  const more = fakeWeatherKit();
  await weatherPass(e2, { PL: list }, Date.parse("2026-11-28T06:00:00Z"), { fetchImpl: more.fetchImpl });
  assert.equal(more.calls.length, 0, "the default 3,000 cap was ignored");
});

test("absent secrets: no fetch, no KV read, no weather on /fixtures", async () => {
  for (const missing of ["WEATHERKIT_KEY", "WEATHERKIT_KEY_ID", "WEATHERKIT_SERVICE_ID"]) {
    const e = await env({ [missing]: undefined });
    const wk = fakeWeatherKit();
    const stats = await weatherPass(e, { PL: [match("m1", "Anfield", "2026-11-28T15:00:00Z")] },
      Date.parse("2026-11-21T06:00:00Z"), { fetchImpl: wk.fetchImpl });
    assert.equal(wk.calls.length, 0, missing);
    assert.equal(stats.calls, 0);
    assert.deepEqual(e.KV.ops, [], `${missing}: the pass touched KV`);
    assert.equal(await dailyWeather(e, Date.parse("2026-11-21T06:00:00Z")), null);
  }
  // A stored forecast is not served while the feature is off.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [match("m1", "Anfield", "2026-11-28T15:00:00Z")] }), { status: 200 });
  try {
    const kv = memoryKV();
    kv.store.set(weatherKey("PL"), JSON.stringify({ m1: { passes: ["week"], weather: { icon: "☀️", temp: 9, desc: "Clear", at: "x" } } }));
    const off = { FIXTURES_URL: "https://example.com/f.json", KV: kv };
    const body = await (await worker.fetch(new Request("https://w.test/fixtures?competition=PL&refresh=1"), off)).json();
    assert.equal(body.fixtures[0].weather, undefined);
    assert.ok(!kv.ops.some(([, key]) => key.startsWith("weather:")), "read weather:<COMP> with the feature off");
    // On: the same stored forecast rides on the fixture the client already fetches.
    const on = { ...(await env()), FIXTURES_URL: "https://example.com/f.json", KV: kv };
    const served = await (await worker.fetch(new Request("https://w.test/fixtures?competition=PL&refresh=1&wx=1"), on)).json();
    assert.deepEqual(served.fixtures[0].weather, { icon: "☀️", temp: 9, desc: "Clear", at: "x" });
    assert.notEqual(served.revision, body.revision, "a forecast must move the revision");
    // 1.8.1 and the web on main ask without wx=1: they draw match.weather with
    // no Apple Weather mark, so they are sent exactly what they got before —
    // no weather field, and the revision a forecast cannot move.
    const old = await (await worker.fetch(new Request("https://w.test/fixtures?competition=PL&refresh=1"), on)).json();
    assert.equal("weather" in old.fixtures[0], false);
    assert.equal(old.revision, body.revision);
    // And the 1.9 client always asks with it.
    assert.match(readFileSync(new URL("../../app.js", import.meta.url), "utf8"), /const query = \[`competition=\$\{code\}`, "wx=1"\];/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only a whole forecast is ever served: no null-as-0°C, no missing icon or words", async () => {
  const m = match("m1", "Anfield", "2026-11-28T15:00:00Z");
  const served = (weather) => mergeWeather([m], { m1: { weather } })[0].weather;
  for (const bad of [{ temp: null, icon: "☀️", desc: "Clear" }, { temp: "9", icon: "☀️", desc: "Clear" },
    { temp: 9, desc: "Clear" }, { temp: 9, icon: "☀️" }, { temp: NaN, icon: "☀️", desc: "Clear" }, null]) {
    assert.equal(served(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(served({ temp: 0, icon: "❄️", desc: "Snow", at: "x" }), { temp: 0, icon: "❄️", desc: "Snow", at: "x" });
  assert.equal(usableWeather({ temp: -2, icon: "❄️", desc: "Snow" }), true);
});

test("only the 06:00 tick reaches WeatherKit, and only for fixtures 1–7 days out with no forecast yet, and today's", async () => {
  const list = [
    match("today", "Anfield", "2026-11-28T15:00:00Z"),
    match("week", "Anfield", "2026-12-05T15:00:00Z"),
    match("six", "Anfield", "2026-12-04T15:00:00Z"),
    match("eight", "Anfield", "2026-12-06T15:00:00Z"),
    match("gone", "Anfield", "2026-11-28T05:00:00Z"),
  ];
  const due = dueForecasts(list, {}, Date.parse("2026-11-28T06:00:00Z"));
  assert.deepEqual(due.map((d) => [d.match.id, d.pass]), [["today", "day"], ["week", "week"], ["six", "week"]]);
  // Already forecast (or already tried) — never owed a first forecast again.
  const tried = dueForecasts(list, { six: { passes: ["week"] }, week: { weather: { temp: 1 } } }, Date.parse("2026-11-28T06:00:00Z"));
  assert.deepEqual(tried.map((d) => d.match.id), ["today"]);
  const e = await env();
  const wk = fakeWeatherKit();
  await weatherPass(e, { PL: list }, Date.parse("2026-11-28T09:00:00Z"), { fetchImpl: wk.fetchImpl });
  assert.equal(wk.calls.length, 0);
  assert.equal(ukParts(Date.parse("2026-07-01T23:30:00Z")).date, "2026-07-02");
});

test("the WeatherKit token: ES256, kid, id = TEAM.SERVICE, iss/sub/iat/exp — and it verifies", async () => {
  const { pem, publicKey } = await p8();
  const nowMs = 1_790_000_000_000;
  const token = await buildWeatherToken({ WEATHERKIT_KEY: pem, WEATHERKIT_KEY_ID: "ABCDE12345", WEATHERKIT_SERVICE_ID: "com.example.wx" }, nowMs);
  const [h, c, s] = token.split(".");
  assert.deepEqual(JSON.parse(b64urlDecode(h)), { alg: "ES256", kid: "ABCDE12345", id: "Y98F87NK7D.com.example.wx" });
  const iat = Math.floor(nowMs / 1000);
  assert.deepEqual(JSON.parse(b64urlDecode(c)), { iss: "Y98F87NK7D", sub: "com.example.wx", iat, exp: iat + 3600 });
  const sig = b64urlDecode(s);
  assert.equal(sig.length, 64);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, new TextEncoder().encode(`${h}.${c}`)));
});

test("the request asks for the kick-off hour's hourly forecast at the ground", async () => {
  const e = await env();
  const wk = fakeWeatherKit();
  await weatherPass(e, { PL: [match("m", "Portman Road", "2026-11-28T15:30:00Z")] }, Date.parse("2026-11-28T06:00:00Z"), { fetchImpl: wk.fetchImpl });
  const { url } = wk.calls[0];
  assert.equal(url.origin, "https://weatherkit.apple.com");
  assert.equal(url.pathname, `/api/v1/weather/en_GB/${STADIUMS["Portman Road"][0]}/${STADIUMS["Portman Road"][1]}`);
  assert.equal(url.searchParams.get("dataSets"), "forecastHourly");
  assert.equal(url.searchParams.get("hourlyStart"), "2026-11-28T15:00:00.000Z");
  assert.equal(url.searchParams.get("hourlyEnd"), "2026-11-28T16:00:00.000Z");
});

test("every venue in both fixture feeds has coordinates", () => {
  for (const feed of ["data/fixtures.json", "data/fixtures-elc.json"]) {
    const venues = new Set(JSON.parse(read(feed)).fixtures.map((m) => m.venue).filter(Boolean));
    assert.ok(venues.size > 15, feed);
    for (const venue of venues) {
      const coords = STADIUMS[venue];
      assert.ok(coords, `${feed}: no coordinates for ${venue}`);
      const [lat, lon] = coords;
      assert.ok(lat > 49.9 && lat < 55.9 && lon > -5.8 && lon < 1.8, `${venue} is not in England or Wales`);
    }
  }
});

test("WeatherKit is reached from the worker only — never from the app", () => {
  for (const file of ["app.js", "sw.js", "index.html"]) {
    const text = read(file);
    const hits = text.match(/weatherkit\.apple\.com[^"'`\s]*/g) || [];
    assert.ok(hits.every((h) => h === "weatherkit.apple.com/legal-attribution.html"), `${file} calls WeatherKit: ${hits}`);
  }
  assert.doesNotMatch(read("wrangler.toml".replace(/^/, "worker/")), /WEATHERKIT_KEY\s*=/, "a secret in the repo");
});
