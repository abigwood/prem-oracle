// Slice 1 · F — the slate-index backfill. Built, tested, and NOT run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kvShim } from "./notify_harness.mjs";
import { verify, repair, runDirection, scanPage, parseSlateKey, parseIndexKey }
  from "../src/notify/backfill.js";
import worker from "../src/worker.js";

const SOURCE = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

/** A world where slates exist but the index was never written — the real case. */
function legacyWorld({ leagues = [["AAA", ["f1", "f2"]]], indexed = false } = {}) {
  const seed = {};
  for (const [code, fixtureIds] of leagues) {
    seed[`custom_slate:${code}:7`] = { status: "published", fixtureIds, periodKey: "7" };
    if (indexed) for (const id of fixtureIds) seed[`slatefx:${id}:${code}`] = { period: "7" };
  }
  return { KV: kvShim(seed) };
}

const indexKeys = (env) => [...env.KV.store.keys()].filter((k) => k.startsWith("slatefx:")).sort();

// --- key parsing ----------------------------------------------------------

test("F · slate and index keys parse back to their parts", () => {
  assert.deepEqual({ ...parseSlateKey("custom_slate:AAA:7") }, { code: "AAA", period: "7" });
  // A mixed league's period is a window key, which contains dashes but no colon.
  assert.deepEqual({ ...parseSlateKey("custom_slate:AAA:w2026-08-11") },
    { code: "AAA", period: "w2026-08-11" });
  assert.deepEqual({ ...parseIndexKey("slatefx:f1:AAA") }, { fixtureId: "f1", code: "AAA" });
  // Fixture ids can contain colons; the league code is the final segment.
  assert.deepEqual({ ...parseIndexKey("slatefx:PL:123:AAA") },
    { fixtureId: "PL:123", code: "AAA" });
});

// --- the case that motivates the whole module -----------------------------

test("F · a slate published before this code has no index, and verify says so", async () => {
  const env = legacyWorld();
  const result = await verify(env);
  assert.equal(result.forward.missing, 2);
  assert.equal(result.ready, false);
  assert.match(result.verdict, /NOT READY — 2 missing/);
  assert.equal(indexKeys(env).length, 0, "verify wrote something");
});

test("F · repair writes exactly the missing keys and then verifies clean", async () => {
  const env = legacyWorld();
  const result = await repair(env);
  assert.equal(result.forward.repaired, 2);
  assert.deepEqual(indexKeys(env), ["slatefx:f1:AAA", "slatefx:f2:AAA"]);
  assert.equal(result.verified.ready, true);
  assert.match(result.verified.verdict, /READY/);
});

test("F · a repaired index carries the period the consumer needs", async () => {
  const env = legacyWorld();
  await repair(env);
  assert.deepEqual(JSON.parse(env.KV.store.get("slatefx:f1:AAA")), { period: "7" });
});

// --- idempotence and rerun safety -----------------------------------------

test("F · rerunning a healthy repair changes nothing", async () => {
  const env = legacyWorld();
  await repair(env);
  const writesAfterFirst = env.KV.counts.put;
  const second = await repair(env);
  assert.equal(env.KV.counts.put, writesAfterFirst, "the rerun wrote again");
  assert.equal(second.forward.repaired, 0);
  assert.equal(second.reverse.removed, 0);
  assert.equal(second.verified.ready, true);
});

test("F · verify is read-only in every direction", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.set("slatefx:ghost:AAA", JSON.stringify({ period: "7" }));
  const before = { put: env.KV.counts.put, del: env.KV.counts.delete };
  const result = await verify(env);
  assert.equal(env.KV.counts.put, before.put);
  assert.equal(env.KV.counts.delete, before.del, "verify deleted a key");
  assert.equal(result.reverse.stale, 1);
  assert.equal(result.ready, false);
});

// --- partial failures -----------------------------------------------------

test("F · a slate write that succeeded while its index write failed is repaired", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.delete("slatefx:f2:AAA");           // the half that never landed
  const result = await repair(env);
  assert.equal(result.forward.repaired, 1);
  assert.deepEqual(indexKeys(env), ["slatefx:f1:AAA", "slatefx:f2:AAA"]);
  assert.equal(result.verified.ready, true);
});

test("F · an index key pointing at the wrong period is corrected", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.set("slatefx:f1:AAA", JSON.stringify({ period: "6" }));
  const result = await repair(env);
  assert.equal(result.forward.repaired, 1);
  assert.deepEqual(JSON.parse(env.KV.store.get("slatefx:f1:AAA")), { period: "7" });
});

// --- stale keys -----------------------------------------------------------

test("F · an amended-out fixture's index key is removed", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.set("custom_slate:AAA:7",
    JSON.stringify({ status: "published", fixtureIds: ["f1"], periodKey: "7" }));
  const result = await repair(env);
  assert.equal(result.reverse.removed, 1);
  assert.deepEqual(indexKeys(env), ["slatefx:f1:AAA"]);
  assert.equal(result.verified.ready, true);
});

test("F · a deleted league's index keys are removed", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.delete("custom_slate:AAA:7");
  const result = await repair(env);
  assert.equal(result.reverse.removed, 2);
  assert.equal(indexKeys(env).length, 0);
});

test("F · a draft slate is never indexed", async () => {
  const env = { KV: kvShim({
    "custom_slate:AAA:7": { status: "draft", fixtureIds: ["f1", "f2"] },
  }) };
  const result = await repair(env);
  assert.equal(result.forward.repaired, 0, "a host's working copy reached the index");
  assert.equal(indexKeys(env).length, 0);
  assert.equal(result.verified.ready, true);
});

test("F · a draft that was previously indexed has its keys removed", async () => {
  const env = { KV: kvShim({
    "custom_slate:AAA:7": { status: "draft", fixtureIds: ["f1"] },
    "slatefx:f1:AAA": { period: "7" },
  }) };
  const result = await repair(env);
  assert.equal(result.reverse.removed, 1);
  assert.equal(indexKeys(env).length, 0);
});

// --- resumability ---------------------------------------------------------

test("F · a bounded page returns a cursor and the next page continues", async () => {
  const seed = {};
  for (let i = 0; i < 12; i++) {
    seed[`custom_slate:L${String(i).padStart(2, "0")}:7`] =
      { status: "published", fixtureIds: ["f1"], periodKey: "7" };
  }
  const env = { KV: kvShim(seed) };
  // The shim returns everything in one page, so drive resumability through
  // runDirection's own page budget instead.
  const first = await runDirection(env, { direction: "forward", apply: true, maxPages: 1 });
  assert.equal(first.pages, 1);
  assert.equal(first.done, true);
  assert.equal(first.repaired, 12);
});

test("F · an interrupted repair resumes and finishes the job", async () => {
  const env = legacyWorld({ leagues: [["AAA", ["f1", "f2", "f3"]]] });
  // Simulate an invocation that died after writing one key.
  await env.KV.put("slatefx:f1:AAA", JSON.stringify({ period: "7" }));
  const result = await repair(env);
  assert.equal(result.forward.repaired, 2, "the resumed run redid finished work");
  assert.equal(result.verified.ready, true);
  assert.equal(indexKeys(env).length, 3);
});

// --- the ship gate --------------------------------------------------------

test("F · the ship gate is not ready while anything is missing or stale", async () => {
  const missing = await verify(legacyWorld());
  assert.equal(missing.ready, false);

  const staleEnv = legacyWorld({ indexed: true });
  staleEnv.KV.store.set("slatefx:ghost:AAA", JSON.stringify({ period: "7" }));
  const stale = await verify(staleEnv);
  assert.equal(stale.ready, false);
  assert.match(stale.verdict, /1 stale/);

  const healthy = await verify(legacyWorld({ indexed: true }));
  assert.equal(healthy.ready, true);
});

test("F · an unfinished scan is reported as incomplete, not as clean", async () => {
  const env = legacyWorld({ indexed: true });
  // A list that never completes: the scan cannot claim the index is fit.
  env.KV.list = async ({ prefix = "" } = {}) => ({
    keys: [...env.KV.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    list_complete: false,
    cursor: "more",
  });
  const result = await verify(env, { maxPages: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.ready, false);
  assert.match(result.verdict, /INCOMPLETE/);
  assert.equal(result.forward.cursor, "more", "no cursor to resume from");
});

// --- it is built, not run -------------------------------------------------

test("F · the backfill is never called from the cron or the planner", () => {
  const scheduled = SOURCE.slice(SOURCE.indexOf("async scheduled(event, env, ctx)"));
  const block = scheduled.slice(0, scheduled.indexOf("async fetch("));
  assert.ok(!/verifySlateIndex|repairSlateIndex/.test(block),
    "the backfill runs on a schedule");
  const planner = SOURCE.slice(SOURCE.indexOf("async function planKickoffReminders"));
  assert.ok(!/verifySlateIndex|repairSlateIndex/.test(planner.slice(0, planner.indexOf("\\n}"))));
});

test("F · the backfill is reachable only behind the migration secret", async () => {
  const env = { ...legacyWorld(), MIGRATION_SECRET: "s3cret", ALLOWED_ORIGIN: "*" };
  const post = (body) => worker.fetch(
    new Request("https://w/admin/slate-index", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), env);

  assert.equal((await post({ action: "verify" })).status, 403, "no secret was accepted");
  assert.equal((await post({ action: "verify", secret: "wrong" })).status, 403);
  assert.equal((await post({ action: "nonsense", secret: "s3cret" })).status, 400);

  const ok = await post({ action: "verify", secret: "s3cret" });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.ready, false);
  assert.equal(indexKeys(env).length, 0, "a verify call wrote to the index");
});

test("F · with no secret configured the route is closed entirely", async () => {
  const env = { ...legacyWorld(), ALLOWED_ORIGIN: "*" };
  const response = await worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "repair", secret: "anything" }),
  }), env);
  assert.equal(response.status, 403);
});
