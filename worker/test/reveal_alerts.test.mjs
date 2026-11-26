// v1.9 Slice 2 — the reveal alert, /reveal-slot, the matchday-results alert,
// the lock-screen privacy fix and the new notification prefs.
//
// The REAL RevealSlot class runs over real SQLite (node:sqlite); the real
// worker runs the planner, the confirm-and-seal alarm, the fan-out and the
// queue consumer; sendPush signs with a real P-256 key and is intercepted at
// fetch. Only the platform (KV, the queue, the alarm clock) is shimmed.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, {
  planRevealSlots, planMatchdayResults, deliverAlertJob, weekSetMessage, postponedMessage, podiumMessage,
} from "../src/worker.js";
import {
  RevealSlot, slotName, dayName, ukDate, ukMidnightMs, resultsDeadlineMs, ukWeekday,
  REVEAL_EXPIRY_MS,
} from "../src/reveal.js";
import { _resetTokenCache } from "../src/apns.js";
import { kvShim } from "./notify_harness.mjs";
import { sqlShim } from "./registrar_harness.mjs";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const FEED = "https://feed.test/pl.json";
const MIN = 60_000;

async function pem() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}
const KEY = await pem();

/** A REVEAL_SLOT namespace: one real RevealSlot per name, alarms recorded. */
function slotNamespace() {
  const instances = new Map();
  const alarms = new Map();
  const ns = {
    env: null,
    alarms,
    idFromName(name) { return { name }; },
    instance(name) {
      if (!instances.has(name)) {
        const db = new DatabaseSync(":memory:");
        const ctx = {
          storage: {
            sql: sqlShim(db),
            transactionSync(fn) {
              db.exec("BEGIN IMMEDIATE");
              try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
            },
            async setAlarm(at) { alarms.set(name, at); },
            async getAlarm() { return alarms.get(name) ?? null; },
          },
        };
        instances.set(name, new RevealSlot(ctx, ns.env));
      }
      return instances.get(name);
    },
    get(id) {
      const inst = ns.instance(id.name);
      return { fetch: (url, init) => inst.fetch(new Request(url, init)) };
    },
  };
  return ns;
}

const fx = (n, startMs, extra = {}) => ({
  id: `pl-2026-27-${String(n).padStart(3, "0")}-home${n}-away${n}`,
  player1: `Home ${n}`, player2: `Away ${n}`, startAt: new Date(startMs).toISOString(), matchday: 13,
  venue: "Somewhere", ...extra,
});

/**
 * A world: the feed, the leagues (published period 13), members, push records
 * and picks. Returns env, the namespace, the queue and the APNs log.
 */
function world({ fixtures, leagues, push = {}, picks = {}, apnsStatus = () => 200 }) {
  const seed = { __meta: {} };
  for (const league of leagues) {
    seed[`league:${league.code}`] = { code: league.code, name: league.name || `Secret ${league.code} Club`, owner: league.members[0].uid };
    seed[`custom_slate:${league.code}:13`] = league.slate || { status: "published", fixtureIds: league.fixtureIds, periodKey: "13" };
    for (const id of league.fixtureIds) {
      seed[`slatefx:${id}:${league.code}`] = { period: "13" };
      seed.__meta[`slatefx:${id}:${league.code}`] = { period: "13" };
    }
    for (const m of league.members) seed[`member:${league.code}:${m.uid}`] = { nick: m.nick || m.uid, since: m.since ?? 1 };
  }
  for (const [uid, record] of Object.entries(push)) seed[`push:${uid}`] = record;
  for (const [id, map] of Object.entries(picks)) seed[`picks:${id}`] = map;
  const kv = kvShim(seed);
  const ns = slotNamespace();
  const queued = [];
  const apns = [];
  const state = { fixtures, feedStatus: 200 };
  const env = {
    KV: kv, FIXTURES_URL: FEED, REVEAL_SLOT: ns,
    NOTIFY_QUEUE: { async send(job) { queued.push(structuredClone(job)); } },
    APNS_KEY: KEY, APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "Y98F87NK7D",
  };
  ns.env = env;
  const fetcher = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith(FEED)) {
      if (state.feedStatus !== 200) return new Response("down", { status: state.feedStatus });
      return new Response(JSON.stringify({ fixtures: state.fixtures }), { status: 200 });
    }
    if (href.startsWith("https://api.push.apple.com/")) {
      const body = JSON.parse(init.body);
      const token = href.split("/").pop();
      apns.push({ token, headers: init.headers, body });
      return new Response("", { status: apnsStatus(token) });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return { env, kv, ns, queued, apns, state, fetcher };
}

/** Run with fetch swapped, and the fixture cache refreshed from this feed. */
async function within(w, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = w.fetcher;
  _resetTokenCache();
  try {
    await worker.fetch(new Request("https://w.test/fixtures?refresh=1"), w.env);
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function deliverAll(w) {
  const results = [];
  for (const body of w.queued.splice(0)) {
    const message = { body, attempts: 1, acked: false, retried: false,
      ack() { this.acked = true; }, retry() { this.retried = true; } };
    await worker.queue({ messages: [message] }, w.env);
    results.push(message);
  }
  return results;
}

const get = (w, path) => worker.fetch(new Request(`https://w.test${path}`), w.env);
const post = (w, path, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), w.env);

/** A slot that locked ~90 s ago, on a whole minute. */
const lockedSlot = () => Math.floor((Date.now() - 90_000) / MIN) * MIN;

const mem = (...uids) => uids.map((uid) => ({ uid, nick: `Nick-${uid}` }));

// --- P1: the reveal alert ---------------------------------------------------

test("one seal → one alert per player, batched across leagues and fixtures; N counts distinct fixtures", async () => {
  const T = lockedSlot();
  const f1 = fx(1, T); const f2 = fx(2, T);
  const w = world({
    fixtures: [f1, f2],
    leagues: [
      { code: "AAAAAA", fixtureIds: [f1.id, f2.id], members: mem("u1", "u2", "u3") },
      { code: "BBBBBB", fixtureIds: [f1.id], members: mem("u1", "u4") },
    ],
    push: {
      u1: { token: "t1", reveal: true }, u2: { token: "t2", reveal: true },
      u3: { token: "t3" },                       // default off
      u4: { token: "t4", reveal: true },
    },
    picks: { [f1.id]: { u1: { p1: 2, p2: 1, ts: T - MIN } } },
  });
  await within(w, async () => {
    const planned = await planRevealSlots(w.env, T - 20 * MIN);
    assert.equal(planned.slots, 1);
    assert.equal(w.ns.alarms.get(slotName(T)), T + 75_000, "alarm at lock + 75 s");
    // A second cron pass over the same slot is the same alarm.
    await planRevealSlots(w.env, T - 5 * MIN);
    assert.equal(w.ns.alarms.size, 1);

    await w.ns.instance(slotName(T)).alarm();
    assert.equal(w.queued.length, 1, "one job");
    const [job] = w.queued;
    assert.equal(job.kind, "reveal");
    assert.deepEqual(job.recipients.map((r) => [r.uid, r.fixtures, r.codes]),
      [["u1", 2, ["AAAAAA", "BBBBBB"]], ["u2", 2, ["AAAAAA"]], ["u4", 1, ["BBBBBB"]]]);

    const delivered = await deliverAll(w);
    assert.ok(delivered.every((m) => m.acked));
    assert.equal(w.apns.length, 3, "one push per opted-in player, none for the default-off one");
    const byToken = Object.fromEntries(w.apns.map((a) => [a.token, a]));
    assert.equal(byToken.t1.body.aps.alert.title, "2 matches kicked off");
    assert.equal(byToken.t4.body.aps.alert.title, "1 match kicked off");
    const status = w.ns.instance(slotName(T)).status();
    for (const a of w.apns) {
      assert.equal(a.body.aps.alert.body, "Picks are locked. See what your mates went for.");
      assert.deepEqual(a.body.po, { v: 2, k: "reveal", t: T });
      assert.equal(a.headers["apns-collapse-id"], `po-rv-${T}`);
      assert.equal(a.headers["apns-expiration"], String(Math.floor((status.sealedAt + REVEAL_EXPIRY_MS) / 1000)));
      // No picks, scores, names or league names on the lock screen.
      const text = JSON.stringify(a.body.aps);
      for (const leak of ["Nick-", "Secret", "AAAAAA", "BBBBBB", "Home", "Away", "2-1", "u1"]) {
        assert.ok(!text.includes(leak), `${leak} on the lock screen: ${text}`);
      }
    }

    // Redelivery of the same job, and a second alarm, send nothing more.
    w.queued.push(structuredClone(job));
    await deliverAll(w);
    await w.ns.instance(slotName(T)).alarm();
    assert.equal(w.queued.length, 0, "a fanned slot does not fan out again");
    assert.equal(w.apns.length, 3, "a redelivered job sent twice");
  });
});

test("a failed send is retried, then sends exactly once", async () => {
  const T = lockedSlot();
  const f1 = fx(1, T);
  let fail = true;
  const w = world({
    fixtures: [f1], leagues: [{ code: "AAAAAA", fixtureIds: [f1.id], members: mem("u1") }],
    push: { u1: { token: "t1", reveal: true } },
    apnsStatus: () => (fail ? 500 : 200),
  });
  await within(w, async () => {
    await planRevealSlots(w.env, T - 10 * MIN);
    await w.ns.instance(slotName(T)).alarm();
    const job = structuredClone(w.queued[0]);
    const [first] = await deliverAll(w);
    assert.equal(first.retried, true);
    fail = false;
    w.queued.push(job, structuredClone(job));
    await deliverAll(w);
    assert.equal(w.apns.filter((a) => a.headers["apns-collapse-id"] === `po-rv-${T}`).length, 2, "one failed + one sent");
    assert.equal(w.ns.instance(slotName(T)).claims()[0].state, "sent");
  });
});

for (const [name, mutate] of [
  ["a moved kick-off", (w, f) => { w.state.fixtures = [{ ...f, startAt: new Date(Date.parse(f.startAt) + 30 * MIN).toISOString() }]; }],
  ["a postponed fixture", (w, f) => { w.state.fixtures = [{ ...f, status: "postponed" }]; }],
  ["a void fixture", (w, f) => { w.state.fixtures = [{ ...f, status: "abandoned" }]; }],
  ["an unpublished slate", (w) => { w.kv.store.set("custom_slate:AAAAAA:13", JSON.stringify({ status: "draft", fixtureIds: [] })); }],
  ["a slate amended out", (w) => { w.kv.store.set("custom_slate:AAAAAA:13", JSON.stringify({ status: "published", fixtureIds: ["pl-2026-27-099-x-y"] })); }],
  ["a read failure", (w) => { w.state.feedStatus = 503; }],
]) {
  test(`confirm refuses on ${name}: no seal, no send, /reveal-slot stays 409`, async () => {
    const T = lockedSlot();
    const f1 = fx(1, T);
    const w = world({
      fixtures: [f1], leagues: [{ code: "AAAAAA", fixtureIds: [f1.id], members: mem("u1") }],
      push: { u1: { token: "t1", reveal: true } },
      picks: { [f1.id]: { u1: { p1: 1, p2: 0, ts: T - MIN } } },
    });
    await within(w, async () => {
      await planRevealSlots(w.env, T - 10 * MIN);
      mutate(w, f1);
      await w.ns.instance(slotName(T)).alarm();
      assert.equal(w.ns.instance(slotName(T)).status().state, "unconfirmed");
      assert.equal(w.queued.length, 0);
      w.state.feedStatus = 200;
      const response = await get(w, `/reveal-slot?uid=u1&t=${T}`);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.deepEqual(body, { locked: false });
      // Never retried into sending later.
      await w.ns.instance(slotName(T)).alarm();
      assert.equal(w.queued.length, 0);
    });
  });
}

test("before lock the alarm only re-arms; past lock + 10 min nothing is ever sent", async () => {
  const future = Math.ceil((Date.now() + 5 * MIN) / MIN) * MIN;
  const stale = Math.floor((Date.now() - 11 * MIN) / MIN) * MIN;
  const fa = fx(1, future); const fb = fx(2, stale);
  const w = world({
    fixtures: [fa, fb],
    leagues: [{ code: "AAAAAA", fixtureIds: [fa.id, fb.id], members: mem("u1") }],
    push: { u1: { token: "t1", reveal: true } },
  });
  await within(w, async () => {
    await planRevealSlots(w.env, future - 20 * MIN);
    await w.ns.instance(slotName(future)).alarm();          // fired early
    assert.equal(w.ns.instance(slotName(future)).status().state, "armed");
    assert.equal(w.ns.alarms.get(slotName(future)), future + 75_000);
    assert.equal((await get(w, `/reveal-slot?uid=u1&t=${future}`)).status, 409);

    await planRevealSlots(w.env, stale - 20 * MIN);
    await w.ns.instance(slotName(stale)).alarm();           // fired late
    assert.equal(w.ns.instance(slotName(stale)).status().state, "expired");
    assert.equal(w.queued.length, 0);
  });
});

test("the consumer re-checks: switched off, removed from the league, or token gone → nothing sent", async () => {
  const T = lockedSlot();
  const f1 = fx(1, T);
  const w = world({
    fixtures: [f1], leagues: [{ code: "AAAAAA", fixtureIds: [f1.id], members: mem("u1", "u2", "u3", "u4") }],
    push: {
      u1: { token: "t1", reveal: true }, u2: { token: "t2", reveal: true },
      u3: { token: "t3", reveal: true }, u4: { token: "t4", reveal: true },
    },
  });
  await within(w, async () => {
    await planRevealSlots(w.env, T - 10 * MIN);
    await w.ns.instance(slotName(T)).alarm();
    // Between plan and send:
    w.kv.store.set("push:u1", JSON.stringify({ token: "t1", reveal: false }));
    w.kv.store.delete("member:AAAAAA:u2");
    w.kv.store.set("push:u3", JSON.stringify({ reveal: true }));
    await deliverAll(w);
    assert.deepEqual(w.apns.map((a) => a.token), ["t4"]);
    const reasons = Object.fromEntries(w.ns.instance(slotName(T)).claims().map((c) => [c.key, c.reason || c.state]));
    assert.equal(reasons[`rv:u1:${T}`], "off");
    assert.equal(reasons[`rv:u2:${T}`], "not-member");
    assert.equal(reasons[`rv:u3:${T}`], "no-token");
  });
});

test("an alert past its 20-minute expiry is dropped, never sent stale", async () => {
  const w = world({ fixtures: [], leagues: [{ code: "AAAAAA", fixtureIds: [], members: mem("u1") }],
    push: { u1: { token: "t1", reveal: true } } });
  const sends = [];
  const result = await deliverAlertJob(
    { v: 2, kind: "reveal", t: 1, sealedAt: Date.now() - 21 * MIN, recipients: [{ uid: "u1", fixtures: 1, codes: ["AAAAAA"] }] },
    w.env,
    { now: () => Date.now(), revealSlot: () => { throw new Error("no claim for a stale job"); },
      readPush: async () => ({ token: "t1", reveal: true }), isMember: async () => true,
      sendPush: async (...a) => { sends.push(a); return { ok: true, status: 200 }; }, dropPushToken: async () => {} },
  );
  assert.equal(result.ack, true);
  assert.equal(sends.length, 0);
});

// --- P2/P3: /reveal-slot ----------------------------------------------------

test("/reveal-slot: you first, honest no-picks, late joiners out, +more above 8, private no-store", async () => {
  const T = lockedSlot();
  const f1 = fx(1, T); const f2 = fx(2, T);
  const big = ["me", ...Array.from({ length: 10 }, (_, i) => `m${String(i).padStart(2, "0")}`)];
  const w = world({
    fixtures: [f1, f2],
    leagues: [
      { code: "AAAAAA", name: "Big League", fixtureIds: [f1.id],
        members: [...big.map((uid) => ({ uid, nick: uid === "me" ? "Zed" : `Mate ${uid}`, since: 1 })),
          { uid: "late", nick: "Late", since: T + 1 }] },
      { code: "CCCCCC", name: "Other", fixtureIds: [f2.id], members: mem("stranger") },
    ],
    push: {},
    picks: {
      [f1.id]: {
        me: { p1: 2, p2: 2, ts: T - MIN },
        m00: { p1: 1, p2: 0, ts: T - MIN },
        m01: { p1: 3, p2: 1, ts: T + 1 },                  // saved after lock: not valid
        late: { p1: 0, p2: 0, ts: T - MIN },
      },
      [f2.id]: { stranger: { p1: 4, p2: 4, ts: T - MIN } },
    },
  });
  await within(w, async () => {
    const before = await get(w, `/reveal-slot?uid=me&t=${T}`);
    assert.equal(before.status, 409, "no seal yet");
    assert.deepEqual(await before.json(), { locked: false });

    await planRevealSlots(w.env, T - 10 * MIN);
    await w.ns.instance(slotName(T)).alarm();

    const response = await get(w, `/reveal-slot?uid=me&t=${T}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.t, T);
    assert.equal(body.lockAt, new Date(T).toISOString());
    assert.deepEqual(body.leagues.map((l) => l.code), ["AAAAAA"], "a league the viewer is not in leaked");
    const [league] = body.leagues;
    assert.equal(league.weekLabel, "Matchweek 13");
    assert.equal(league.mixed, false);
    const [card] = league.fixtures;
    assert.equal(card.total, 11, "late joiner excluded");
    assert.equal(card.rows.length, 8);
    assert.equal(card.more, 3);
    assert.deepEqual(card.rows[0], { uid: "me", nick: "Zed", you: true, p1: 2, p2: 2, noPick: false });
    const m01 = card.rows.find((r) => r.uid === "m01");
    assert.deepEqual([m01.p1, m01.p2, m01.noPick], [null, null, true], "a pick saved after lock is not shown");
    assert.ok(card.rows.slice(1).every((r) => !r.you));
    assert.ok(!JSON.stringify(body).includes("Late"));
    assert.ok(!JSON.stringify(body).includes("stranger"), "another league's member leaked");

    const outsider = await (await get(w, `/reveal-slot?uid=nobody&t=${T}`)).json();
    assert.deepEqual(outsider.leagues, []);
    assert.equal((await get(w, "/reveal-slot?uid=me&t=abc")).status, 400);
    assert.equal((await get(w, `/reveal-slot?t=${T}`)).status, 400);
  });
});

test("/reveal-slot refuses a seal whose lock is still in the future", async () => {
  const future = Date.now() + 10 * MIN;
  const w = world({ fixtures: [], leagues: [{ code: "AAAAAA", fixtureIds: [], members: mem("u1") }] });
  const inst = w.ns.instance(slotName(future));
  inst.sql.exec("INSERT INTO slot (id, slot_ms, state, fixtures, pairs, sealed_at) VALUES (1, ?1, 'sealed', '[]', ?2, ?3)",
    future, JSON.stringify([{ code: "AAAAAA", period: "13", fixtureId: "pl-x" }]), Date.now());
  const response = await get(w, `/reveal-slot?uid=u1&t=${future}`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { locked: false });
});

test("without the REVEAL_SLOT binding nothing plans and /reveal-slot is 409", async () => {
  const w = world({ fixtures: [], leagues: [{ code: "AAAAAA", fixtureIds: [], members: mem("u1") }] });
  delete w.env.REVEAL_SLOT;
  assert.deepEqual(await planRevealSlots(w.env, Date.now()), { slots: 0 });
  assert.deepEqual(await planMatchdayResults(w.env, Date.now()), { days: 0 });
  assert.equal((await get(w, `/reveal-slot?uid=u1&t=${Date.now()}`)).status, 409);
});

test("KV budget: 3 fixtures × 4 leagues × 10 members stays inside the plan's counts", async () => {
  const T = lockedSlot();
  const fixtures = [fx(1, T), fx(2, T), fx(3, T)];
  const leagues = ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD"].map((code, i) => ({
    code, fixtureIds: fixtures.map((f) => f.id),
    members: Array.from({ length: 10 }, (_, j) => ({ uid: `p${i}${j}`, nick: `P${i}${j}` })),
  }));
  const push = {};
  leagues.flatMap((l) => l.members).slice(0, 35).forEach((m) => { push[m.uid] = { token: `t-${m.uid}`, reveal: true }; });
  const w = world({ fixtures, leagues, push });
  await within(w, async () => {
    const reset = () => Object.keys(w.kv.counts).forEach((k) => { w.kv.counts[k] = 0; });
    reset();
    await planRevealSlots(w.env, T - 10 * MIN);
    const plan = { ...w.kv.counts };
    reset();
    await w.ns.instance(slotName(T)).alarm();
    const seal = { ...w.kv.counts };
    reset();
    await deliverAll(w);
    const send = { ...w.kv.counts };
    // Plan: one slatefx list per due fixture, no writes.
    assert.deepEqual([plan.list, plan.put], [3, 0]);
    // Confirm + fan-out: ~90 reads, 8 lists, no KV writes (seal and claims are DO SQLite).
    assert.ok(seal.get <= 95, `confirm+fan-out read ${seal.get}`);
    assert.ok(seal.list <= 8, `confirm+fan-out listed ${seal.list}`);
    assert.equal(seal.put, 0);
    // Send: one push read and one member read per recipient.
    assert.equal(w.apns.length, 35);
    assert.ok(send.get <= 70, `send read ${send.get}`);
    assert.equal(send.put, 0);
    console.log(`  KV per slot — plan ${JSON.stringify(plan)}, confirm+fan-out ${JSON.stringify(seal)}, send ${JSON.stringify(send)}`);
  });
});

// --- D: the matchday-results alert -----------------------------------------

/** Fixtures kicking off today (UK) at 01:00, 02:00, … so they share a UK date. */
function todayFixtures(n, extra = {}) {
  const D = ukDate(Date.now());
  const base = ukMidnightMs(D) + 60 * MIN;
  return { D, list: Array.from({ length: n }, (_, i) => fx(10 + i, base + i * 60 * MIN, extra[i] || {})) };
}

test("results: one alert per player per day across leagues, only once their last fixture is settled", async () => {
  const { D, list } = todayFixtures(4, {
    0: { status: "complete", result: [2, 1] },
    1: { status: "complete", result: [1, 1] },
    2: {},                                              // unsettled
    3: { status: "postponed" },
  });
  const [f1, f2, f3, f4] = list;
  const later = fx(30, Date.now() + 3 * 86400_000);    // League C's week goes on after today
  const lock = (f) => Date.parse(f.startAt);
  const w = world({
    fixtures: [...list, later],
    leagues: [
      { code: "AAAAAA", fixtureIds: [f1.id, f2.id], members: mem("u1", "u2", "u3") },
      { code: "BBBBBB", fixtureIds: [f1.id], members: mem("u2") },
      { code: "CCCCCC", fixtureIds: [f3.id, f4.id, later.id], members: mem("u1") },
    ],
    push: {
      u1: { token: "t1", results: true }, u2: { token: "t2", results: true }, u3: { token: "t3" },
    },
    picks: {
      [f1.id]: { u1: { p1: 2, p2: 1, ts: lock(f1) - MIN }, u2: { p1: 1, p2: 0, ts: lock(f1) - MIN } },
      [f2.id]: { u2: { p1: 0, p2: 0, ts: lock(f2) - MIN }, u1: { p1: 3, p2: 3, ts: lock(f2) + MIN } },
    },
  });
  await within(w, async () => {
    await planMatchdayResults(w.env, Date.now());
    await deliverAll(w);
    // u1 still has f3 unsettled in League C; u3 never opted in.
    assert.deepEqual(w.apns.map((a) => a.token), ["t2"]);
    const [a2] = w.apns;
    assert.equal(a2.body.aps.alert.title, `${ukWeekday(D)}'s results are in`);
    // u2: f1 1-0 v 2-1 = same goal difference (2), f2 0-0 v 1-1 = draw (2), f1 counted once across A and B.
    // League A (f1, f2) and League B (f1) are both complete: the week-complete variant.
    assert.equal(a2.body.aps.alert.body,
      "You scored +4 today — and Matchweek 13 is complete. See everyone's picks, points and the tables.");
    assert.deepEqual(a2.body.po, { v: 2, k: "results", d: D });
    assert.equal(a2.headers["apns-collapse-id"], `po-mr-${D}`);
    assert.ok(Number(a2.headers["apns-expiration"]) <= Math.floor(resultsDeadlineMs(D) / 1000));
    assert.ok(!/Secret|Nick-|AAAAAA/.test(JSON.stringify(a2.body.aps)));

    // Nothing new settled: an idle tick plans nothing.
    await planMatchdayResults(w.env, Date.now());
    assert.equal(w.queued.length, 0);

    // f3 settles: u1 is now owed one (postponed f4 is excluded), and u2 is not sent again.
    w.state.fixtures = w.state.fixtures.map((f) => (f.id === f3.id ? { ...f, status: "complete", result: [0, 0] } : f));
    await worker.fetch(new Request("https://w.test/fixtures?refresh=1"), w.env);
    await planMatchdayResults(w.env, Date.now());
    const jobs = structuredClone(w.queued);
    await deliverAll(w);
    assert.deepEqual(w.apns.map((a) => a.token), ["t2", "t1"]);
    // u1: f1 exact (5), f2 pick was after lock (0), f3 no pick (0); C's week is not complete.
    assert.equal(w.apns[1].body.aps.alert.body, "You scored +5 from 3 matches. See everyone's picks and points.");

    // Redelivery is idempotent.
    w.queued.push(...jobs);
    await deliverAll(w);
    assert.equal(w.apns.length, 2);
    const claims = w.ns.instance(dayName(D)).claims().map((c) => [c.key, c.state]);
    assert.deepEqual(claims, [[`mr:u1:${D}`, "sent"], [`mr:u2:${D}`, "sent"]]);
  });
});

test("results: void fixtures are excluded and do not hold the day; 1 match is singular", async () => {
  const { list } = todayFixtures(2, { 0: { status: "complete", result: [1, 0] }, 1: { status: "abandoned" } });
  const [f1, f2] = list;
  const w = world({
    fixtures: list,
    leagues: [{ code: "AAAAAA", fixtureIds: [f1.id, f2.id], members: mem("u1") }],
    push: { u1: { token: "t1", results: true } },
    picks: { [f1.id]: { u1: { p1: 1, p2: 0, ts: Date.parse(f1.startAt) - MIN } } },
  });
  await within(w, async () => {
    await planMatchdayResults(w.env, Date.now());
    await deliverAll(w);
    assert.equal(w.apns.length, 1);
    assert.equal(w.apns[0].body.aps.alert.body,
      "You scored +5 today — and Matchweek 13 is complete. See everyone's picks, points and the tables.");
  });
});

test("results: a job past 23:59 UK + 2 h is dropped, not sent stale", async () => {
  const sends = [];
  const result = await deliverAlertJob(
    { v: 2, kind: "results", d: "2026-11-20", deadline: Date.now() - 1,
      recipients: [{ uid: "u1", pts: 3, matches: 2, codes: ["AAAAAA"] }] },
    {},
    { now: () => Date.now(), revealSlot: () => { throw new Error("claimed a stale job"); },
      readPush: async () => ({ token: "t", results: true }), isMember: async () => true,
      sendPush: async (...a) => { sends.push(a); return { ok: true, status: 200 }; }, dropPushToken: async () => {} },
  );
  assert.equal(result.ack, true);
  assert.equal(sends.length, 0);
  // And the deadline itself is 23:59 UK on the day plus two hours, DST-aware.
  assert.equal(new Date(resultsDeadlineMs("2026-11-28")).toISOString(), "2026-11-29T01:59:00.000Z");
  assert.equal(new Date(resultsDeadlineMs("2026-08-22")).toISOString(), "2026-08-23T00:59:00.000Z");
  assert.equal(ukWeekday("2026-11-28"), "Saturday");
});

// --- E: lock-screen privacy for the slate notices ---------------------------

test("E · 'the week is set' and 'Line-up updated' never put the league name on the lock screen", async () => {
  const start = Date.now() + 3 * 86400_000;
  const f1 = fx(1, start); const f2 = fx(2, start + 2 * 3600_000);
  const w = world({ fixtures: [f1, f2], leagues: [], push: { u2: { token: "t2" } } });
  w.kv.store.set("league:SECRET", JSON.stringify({ code: "SECRET", name: "The Secret Society", owner: "host" }));
  w.kv.store.set("member:SECRET:host", JSON.stringify({ nick: "Hosty", since: 1 }));
  w.kv.store.set("member:SECRET:u2", JSON.stringify({ nick: "Two", since: 1 }));
  await within(w, async () => {
    const published = await post(w, "/league/slate", { uid: "host", code: "SECRET", period: "13", mode: "custom", fixtureIds: [f1.id] });
    assert.equal(published.status, 200, await published.clone().text());
    const amended = await post(w, "/league/slate", { uid: "host", code: "SECRET", period: "13", mode: "custom", fixtureIds: [f1.id, f2.id] });
    assert.equal(amended.status, 200, await amended.clone().text());
  });
  assert.equal(w.apns.length, 2);
  const [set, lineup] = w.apns.map((a) => a.body);
  assert.deepEqual(set.aps.alert, { title: "Your league", body: "Matchweek 13 is set — 1 fixture is open. Get your picks in!" });
  assert.deepEqual(lineup.aps.alert, { title: "Line-up updated", body: "Your league: 1 fixture added — update your picks before kick-off." });
  for (const body of [set, lineup]) {
    assert.deepEqual(body.po, { v: 1, l: "SECRET" }, "the tap must still open that league");
    assert.ok(!/Secret Society|Hosty/.test(JSON.stringify(body.aps)));
  }
  assert.deepEqual(weekSetMessage("Week 4", 6), { title: "Your league", body: "Week 4 is set — 6 fixtures are open. Get your picks in!" });
  // Every publish path says it the same way: host, set-and-forget, fallback.
  assert.equal(SOURCE.match(/weekSetMessage\(periodTitleFor\(league, period, weekNo\)/g).length, 3);
  for (const fn of ["async function autoPublish(", "async function applyFallback(", "async function publishSlate("]) {
    const body = SOURCE.slice(SOURCE.indexOf(fn), SOURCE.indexOf("\n}\n", SOURCE.indexOf(fn)));
    assert.ok(!/pushToUids[^;]*league\.name|pushOnce[^;]*league\.name/.test(body), `${fn} still names the league`);
  }
});

test("lock screen · the postponement, podium and host notices say 'Your league', never its name", () => {
  assert.deepEqual(postponedMessage("Arsenal v Chelsea", "Matchweek 13", 5), {
    title: "Your league", body: "Arsenal v Chelsea was postponed and no longer counts. Matchweek 13 now scores 5 fixtures." });
  assert.equal(postponedMessage("A v B", "Week 4", 1).body, "A v B was postponed and no longer counts. Week 4 now scores 1 fixture.");
  assert.deepEqual(podiumMessage(13, [{ place: "gold", nick: "Tom", pts: 12 }, { place: "silver", nick: "Sam", pts: 9 }]), {
    title: "Your league", body: "Matchweek 13 podium: 🏆 Tom 12 · 🥈 Sam 9" });
  // Each one carries the league code privately, so the tap opens that league.
  assert.match(SOURCE, /postponedMessage\(gone, periodTitleFor\(league, period, weekNo\), change\.fixtureIds\.length\), leagueRoute\(league\.code\)\)/);
  assert.match(SOURCE, /podiumMessage\(target\.matchweek, podium\), leagueRoute\(league\.code\)\)/);
  // And no push anywhere in the worker is built from a league's name.
  for (const call of SOURCE.matchAll(/(?:pushToUids|pushOnce)\([\s\S]*?\);/g)) {
    assert.doesNotMatch(call[0], /league\.name/, call[0].slice(0, 80));
  }
  for (const fn of ["async function remindHost(", "async function reconcilePostponements(", "async function podiumAnnouncements(", "export function postponedMessage(", "export const podiumMessage"]) {
    const body = SOURCE.slice(SOURCE.indexOf(fn), SOURCE.indexOf("\n}\n", SOURCE.indexOf(fn)) + 3);
    assert.ok(body.length > 20, fn);
    assert.doesNotMatch(body.replace(/\/\/.*|\*.*$/gm, ""), /league\.name/, fn);
  }
});

// --- Prefs ------------------------------------------------------------------

test("prefs: default off, independent fields, created before a token, kept across re-registration", async () => {
  const w = world({ fixtures: [], leagues: [] });
  const fresh = await (await get(w, "/notification-prefs?uid=u9")).json();
  assert.equal(fresh.registered, false);
  assert.deepEqual([fresh.reveal, fresh.results, fresh.offers, fresh.mute], [false, false, { reveal: false, results: false }, []]);

  let r = await post(w, "/notification-prefs", { uid: "u9", reveal: true });
  assert.equal(r.status, 200, "a choice made before APNs registration is kept");
  let body = await r.json();
  assert.deepEqual([body.reveal, body.results, body.registered], [true, false, false]);
  r = await post(w, "/notification-prefs", { uid: "u9", offers: { results: true } });
  body = await r.json();
  assert.deepEqual(body.offers, { reveal: false, results: true });
  r = await post(w, "/notification-prefs", { uid: "u9", offers: { reveal: true } });
  assert.deepEqual((await r.json()).offers, { reveal: true, results: true }, "offers only ever go to true");

  // The token arrives: nothing chosen is lost.
  await post(w, "/notification-prefs", { uid: "u9", mute: ["ELC"] });
  const original = globalThis.fetch;
  assert.equal((await post(w, "/push-token", { uid: "u9", token: "tok" })).status, 200);
  globalThis.fetch = original;
  const after = await (await get(w, "/notification-prefs?uid=u9")).json();
  assert.deepEqual([after.registered, after.reveal, after.results, after.mute, after.offers],
    [true, true, false, ["ELC"], { reveal: true, results: true }]);
  // Turning one off leaves the other and reminders alone.
  body = await (await post(w, "/notification-prefs", { uid: "u9", reveal: false, results: true })).json();
  assert.deepEqual([body.reveal, body.results, body.mute], [false, true, ["ELC"]]);
  assert.equal(JSON.parse(w.kv.store.get("push:u9")).token, "tok");

  // Validation.
  for (const bad of [{ uid: "u9" }, { uid: "u9", reveal: "yes" }, { uid: "u9", results: 1 },
    { uid: "u9", offers: { reveal: false } }, { uid: "u9", offers: { other: true } }, { uid: "u9", mute: "PL" },
    { uid: "u9", mute: ["XX"] }, { reveal: true }]) {
    assert.equal((await post(w, "/notification-prefs", bad)).status, 400, JSON.stringify(bad));
  }
});

test("the reveal module never reads reminder consent, and old payloads stay v1", () => {
  const reveal = readFileSync(new URL("../src/reveal.js", import.meta.url), "utf8");
  assert.ok(!/notifyAsk|mute/.test(reveal));
  // Reminder payloads are untouched: still v1 with a fixture.
  assert.match(readFileSync(new URL("../src/notify/copy.js", import.meta.url), "utf8"), /export const PAYLOAD_VERSION = 1;/);
  assert.equal(typeof RevealSlot, "function");
  assert.match(SOURCE, /export \{ RevealSlot \};/);
});
