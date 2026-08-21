// Slice 1 · F — the slate-index backfill. Built, tested, and NOT run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kvShim } from "./notify_harness.mjs";
import {
  verify, repair, runDirection, readChain, parseSlateKey, parseIndexKey,
  clampLimit, clampOps, MAX_OPS_PER_INVOCATION, MAX_LIST_LIMIT,
  cleanupOrphans, normalizeAllow, CleanupRefused, MAX_CLEANUP_KEYS,
  CLEANUP_OPS_PER_KEY, CHAIN_OPS_PER_CLEANUP, MANIFEST_OPS, MIN_CLEANUP_OPS,
  cleanupManifestKey, readCleanupManifest, AUTHORISED_CLEANUPS,
} from "../src/notify/backfill.js";
import worker from "../src/worker.js";

const SOURCE = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

/** A world where slates exist but the index was never written — the real case. */
function legacyWorld({
  leagues = [["AAA", ["f1", "f2"]]], indexed = false, pageSize = 1000, league = true,
} = {}) {
  const seed = { __meta: {} };
  for (const [code, fixtureIds] of leagues) {
    if (league) seed[`league:${code}`] = { code, name: code };
    seed[`custom_slate:${code}:7`] = { status: "published", fixtureIds, periodKey: "7" };
    if (indexed) {
      for (const id of fixtureIds) {
        seed[`slatefx:${id}:${code}`] = { period: "7" };
        seed.__meta[`slatefx:${id}:${code}`] = { period: "7" };
      }
    }
  }
  return { KV: kvShim(seed, { pageSize }) };
}

/** The product maximum: 1,000 published leagues, twenty fixtures each. */
function hugeWorld({ leagues = 1_000, fixtures = 20, indexed = false } = {}) {
  const ids = Array.from({ length: fixtures }, (_, i) => `f${String(i).padStart(2, "0")}`);
  return legacyWorld({
    leagues: Array.from({ length: leagues }, (_, i) => [`L${String(i).padStart(4, "0")}`, ids]),
    indexed, pageSize: 200,
  });
}

const indexKeys = (env) => [...env.KV.store.keys()].filter((k) => k.startsWith("slatefx:")).sort();

/** Drive a bounded operation to completion, counting invocations. */
async function driveRepair(env, options = {}) {
  let resume = null;
  let invocations = 0;
  let result;
  do {
    result = await repair(env, { ...options, ...(resume || {}) });
    invocations++;
    assert.ok(result.forward.ops <= result.forward.opsCap, "forward blew its budget");
    assert.ok(result.reverse.ops <= result.reverse.opsCap, "reverse blew its budget");
    resume = result.resume;
  } while (!result.done && invocations < 2_000);
  return { invocations, result };
}

async function driveVerify(env, options = {}) {
  let invocations = 0;
  let result;
  do {
    result = await verify(env, { ...options, restart: invocations === 0 });
    invocations++;
  } while (!result.complete && invocations < 5_000);
  return { invocations, result };
}

// --- key parsing ----------------------------------------------------------

test("F · slate and index keys parse back to their parts", () => {
  assert.deepEqual({ ...parseSlateKey("custom_slate:AAA:7") }, { code: "AAA", period: "7" });
  assert.deepEqual({ ...parseSlateKey("custom_slate:AAA:w2026-08-11") },
    { code: "AAA", period: "w2026-08-11" });
  assert.deepEqual({ ...parseIndexKey("slatefx:f1:AAA") }, { fixtureId: "f1", code: "AAA" });
  assert.deepEqual({ ...parseIndexKey("slatefx:PL:123:AAA") },
    { fixtureId: "PL:123", code: "AAA" });
});

// --- B · caller-supplied budgets are clamped ------------------------------

test("B · a request body may ask for less work, never for more", () => {
  assert.equal(clampOps(50), 50);
  assert.equal(clampOps(999_999), MAX_OPS_PER_INVOCATION);
  assert.equal(clampOps(undefined), MAX_OPS_PER_INVOCATION);
  assert.equal(clampOps(-1), MAX_OPS_PER_INVOCATION);
  assert.equal(clampOps("nonsense"), MAX_OPS_PER_INVOCATION);
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit(100_000), MAX_LIST_LIMIT);
  assert.ok(MAX_OPS_PER_INVOCATION < 1_000, "the cap must sit under the platform ceiling");
});

// --- B · the budget is counted in OPERATIONS, not pages -------------------

test("B · one invocation never exceeds its operation cap at the product maximum", async () => {
  const env = hugeWorld();
  const run = await runDirection(env, { direction: "forward", apply: true });
  assert.ok(run.ops <= MAX_OPS_PER_INVOCATION,
    `one invocation performed ${run.ops} operations`);
  assert.equal(run.done, false, "20,000 fixtures cannot finish in one budget");
  assert.ok(run.position, "no position to resume from");
});

test("B · the old page-based bound would have been thousands of operations", async () => {
  // 200 slates x 20 fixtures is 4,000 index lookups plus 400 record reads,
  // before a single write. The operation budget stops it long before that.
  const env = hugeWorld();
  const run = await runDirection(env, { direction: "forward", limit: 200 });
  assert.ok(run.ops <= MAX_OPS_PER_INVOCATION);
  assert.ok(run.scanned < 200, `a whole 200-key page was processed (${run.scanned} slates)`);
});

// --- B · resumption INSIDE a slate's fixture list -------------------------

test("B · a scan can stop partway through a slate and resume exactly there", async () => {
  // One league, forty fixtures, and a budget that cannot cover them all.
  const env = legacyWorld({
    leagues: [["AAA", Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}`)]],
  });
  const first = await runDirection(env, { direction: "forward", apply: true, maxOps: 12 });
  assert.equal(first.done, false);
  assert.ok(first.position.offset > 0 && first.position.offset < 40,
    `stopped at offset ${first.position.offset}, which is not mid-slate`);
  const writtenFirst = indexKeys(env).length;
  assert.ok(writtenFirst > 0 && writtenFirst < 40);

  const second = await runDirection(env,
    { direction: "forward", apply: true, position: first.position, maxOps: 200 });
  assert.equal(second.done, true);
  assert.equal(indexKeys(env).length, 40, "resumption lost or duplicated fixtures");
  // The resumed run did not redo the fixtures the first one finished.
  assert.equal(second.repaired, 40 - writtenFirst);
});

test("B · forward and reverse carry independent positions", async () => {
  const env = hugeWorld({ leagues: 20, fixtures: 20, indexed: true });
  const f = await runDirection(env, { direction: "forward", maxOps: 30 });
  const r = await runDirection(env, { direction: "reverse", maxOps: 30 });
  assert.notDeepEqual(f.position, r.position,
    "the two prefixes produced the same position, which cannot be right");
  // Feeding one direction the other's position must not be how this works:
  // each is resumed only with its own.
  const fAgain = await runDirection(env,
    { direction: "forward", position: f.position, maxOps: 30 });
  assert.ok(fAgain.scanned > 0);
});

// --- B · the verification CHAIN -------------------------------------------

test("B · a chain that has not finished never reports ready", async () => {
  const env = hugeWorld({ leagues: 50, fixtures: 20, indexed: true });
  const first = await verify(env, { restart: true, maxOps: 40 });
  assert.equal(first.complete, false);
  assert.equal(first.ready, false);
  assert.match(first.verdict, /IN PROGRESS/);
});

test("B · a chain started at the beginning completes across invocations and CAN be ready", async () => {
  const env = hugeWorld({ leagues: 40, fixtures: 20, indexed: true });
  const { invocations, result } = await driveVerify(env, { maxOps: 200 });
  assert.ok(invocations > 1, "the chain finished in one call, so it proves nothing");
  assert.equal(result.complete, true);
  assert.equal(result.ready, true, result.verdict);
  assert.match(result.verdict, /READY/);
  // Every fixture really was inspected.
  assert.equal(result.forward.counts.ok, 40 * 20);
});

test("B · a dirty prefix cannot be escaped by continuing the chain", async () => {
  const env = hugeWorld({ leagues: 40, fixtures: 20, indexed: true });
  // Break the very first league only: everything after it is spotless.
  env.KV.store.delete("slatefx:f00:L0000");
  env.KV.meta.delete("slatefx:f00:L0000");
  const { result } = await driveVerify(env, { maxOps: 200 });
  assert.equal(result.complete, true);
  assert.equal(result.ready, false, "a chain walked past missing keys and reported ready");
  assert.equal(result.forward.counts.missing, 1);
  assert.match(result.verdict, /NOT READY/);
});

test("B · continuing without restart resumes the SAME chain rather than starting over", async () => {
  const env = hugeWorld({ leagues: 40, fixtures: 20, indexed: true });
  await verify(env, { restart: true, maxOps: 60 });
  const stored = await readChain(env);
  assert.ok(stored.forward.position, "the chain kept no position");
  const second = await verify(env, { maxOps: 60 });
  assert.equal(second.chain.invocations, 2);
  assert.ok(second.forward.counts.ok > stored.forward.counts.ok,
    "the second call re-scanned rather than continuing");
});

test("B · repair does NOT run a verification of its own", async () => {
  const env = legacyWorld();
  const before = { ...env.KV.counts };
  const result = await repair(env);
  assert.equal(result.forward.repaired, 2);
  assert.equal(result.verified, undefined, "repair ran an unbounded verification");
  assert.match(result.next, /verify with restart/);
  assert.ok(env.KV.counts.get + env.KV.counts.list - before.get - before.list < 40,
    "repair did far more work than repairing");
});

test("B · a repair invalidates any chain that ran before it", async () => {
  const env = legacyWorld();
  await verify(env, { restart: true });
  assert.ok(await readChain(env), "no chain was stored");
  await repair(env);
  assert.equal(await readChain(env), null, "a stale chain survived a repair");
});

// --- B · the executed worst shape ----------------------------------------

test("B · WORST SHAPE: 1,000 leagues x 20 fixtures repairs and then verifies ready", async () => {
  const env = hugeWorld();
  const { invocations, result } = await driveRepair(env);
  assert.equal(result.done, true);
  assert.ok(invocations > 10, `finished in ${invocations} invocations, which looks unbounded`);
  assert.equal(indexKeys(env).length, 1_000 * 20);

  const verified = await driveVerify(env, { maxOps: MAX_OPS_PER_INVOCATION });
  assert.equal(verified.result.ready, true, verified.result.verdict);
  assert.equal(verified.result.forward.counts.missing, 0);
  assert.equal(verified.result.reverse.counts.stale, 0);
  console.log(`\n  worst shape: 1,000 leagues x 20 fixtures`);
  console.log(`    repair invocations : ${invocations}`);
  console.log(`    verify invocations : ${verified.invocations}`);
  console.log(`    operation cap      : ${MAX_OPS_PER_INVOCATION} per invocation\n`);
});

test("B · a second repair over a healthy index writes nothing", async () => {
  const env = hugeWorld({ leagues: 30, fixtures: 20 });
  await driveRepair(env);
  const writes = env.KV.counts.put;
  const deletes = env.KV.counts.delete;
  const again = await driveRepair(env);
  assert.equal(env.KV.counts.put, writes, "the rerun wrote again");
  assert.equal(env.KV.counts.delete, deletes, "the rerun deleted something");
  assert.equal(again.result.forward.repaired, 0);
  assert.equal(again.result.reverse.removed, 0);
});

// --- correctness rules, unchanged ----------------------------------------

test("F · a slate published before this code has no index, and verify says so", async () => {
  const env = legacyWorld();
  const { result } = await driveVerify(env);
  assert.equal(result.forward.counts.missing, 2);
  assert.equal(result.ready, false);
  assert.equal(indexKeys(env).length, 0, "verify wrote something");
});

test("F · repair writes the period in BOTH the value and the metadata", async () => {
  const env = legacyWorld();
  await driveRepair(env);
  assert.deepEqual(JSON.parse(env.KV.store.get("slatefx:f1:AAA")), { period: "7" });
  assert.deepEqual(env.KV.meta.get("slatefx:f1:AAA"), { period: "7" });
});

test("F · a value-only legacy key is treated as missing and repaired", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.meta.delete("slatefx:f1:AAA");
  const before = await driveVerify(env);
  assert.equal(before.result.forward.counts.missing, 1);
  await driveRepair(env);
  assert.deepEqual(env.KV.meta.get("slatefx:f1:AAA"), { period: "7" });
  assert.equal((await driveVerify(env)).result.ready, true);
});

test("F · verify is read-only in every direction", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.set("slatefx:ghost:AAA", JSON.stringify({ period: "7" }));
  const before = { put: env.KV.counts.put, del: env.KV.counts.delete };
  const { result } = await driveVerify(env);
  // The chain write is the only put, and it is not an index write.
  assert.equal(env.KV.counts.delete, before.del, "verify deleted a key");
  assert.ok(env.KV.store.has("slatefx:ghost:AAA"), "verify removed a stale key");
  assert.equal(result.reverse.counts.stale, 1);
  assert.equal(result.ready, false);
});

test("F · a slate write whose index write failed is repaired", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.delete("slatefx:f2:AAA");
  env.KV.meta.delete("slatefx:f2:AAA");
  const { result } = await driveRepair(env);
  assert.equal(result.forward.repaired, 1);
  assert.deepEqual(indexKeys(env), ["slatefx:f1:AAA", "slatefx:f2:AAA"]);
});

test("F · an index key pointing at the wrong period is corrected", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.setMeta("slatefx:f1:AAA", { period: "6" });
  const { result } = await driveRepair(env);
  assert.equal(result.forward.repaired, 1);
  assert.deepEqual(env.KV.meta.get("slatefx:f1:AAA"), { period: "7" });
});

test("F · an amended-out fixture's index key is removed", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.set("custom_slate:AAA:7",
    JSON.stringify({ status: "published", fixtureIds: ["f1"], periodKey: "7" }));
  const { result } = await driveRepair(env);
  assert.equal(result.reverse.removed, 1);
  assert.deepEqual(indexKeys(env), ["slatefx:f1:AAA"]);
});

test("F · a deleted league's slate leaves no index behind", async () => {
  const env = legacyWorld({ indexed: true });
  env.KV.store.delete("custom_slate:AAA:7");
  const { result } = await driveRepair(env);
  assert.equal(result.reverse.removed, 2);
  assert.equal(indexKeys(env).length, 0);
});

test("F · a draft slate is never indexed", async () => {
  const env = { KV: kvShim({ "custom_slate:AAA:7": { status: "draft", fixtureIds: ["f1", "f2"] } }) };
  const { result } = await driveRepair(env);
  assert.equal(result.forward.repaired, 0, "a host's working copy reached the index");
  assert.equal(indexKeys(env).length, 0);
});

test("F · an orphaned slate is NOT indexed: the league record is the authority", async () => {
  const env = legacyWorld({ league: false });
  const { result } = await driveRepair(env);
  assert.equal(result.forward.orphaned, 1);
  assert.equal(result.forward.repaired, 0, "a deleted league was resurrected into the index");
  assert.equal(indexKeys(env).length, 0);
});

test("F · index keys of a deleted league are stale even when the slate survived", async () => {
  const env = legacyWorld({ indexed: true, league: false });
  const { result } = await driveRepair(env);
  assert.equal(result.reverse.removed, 2, "a deleted league's index keys were kept");
  assert.equal(indexKeys(env).length, 0);
});

test("F · an orphaned slate keeps the gate shut", async () => {
  const env = legacyWorld({ league: false });
  const { result } = await driveVerify(env);
  assert.equal(result.ready, false);
  assert.match(result.verdict, /orphaned/);
});

// --- it is built, not run -------------------------------------------------

test("F · the backfill is never called from the cron or the planner", () => {
  const scheduled = SOURCE.slice(SOURCE.indexOf("async scheduled(event, env, ctx)"));
  const block = scheduled.slice(0, scheduled.indexOf("async fetch("));
  assert.ok(!/verifySlateIndex|repairSlateIndex/.test(block), "the backfill runs on a schedule");
  const planner = SOURCE.slice(SOURCE.indexOf("async function planKickoffReminders"));
  assert.ok(!/verifySlateIndex|repairSlateIndex/.test(planner.slice(0, planner.indexOf("\n}"))));
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

  const ok = await post({ action: "verify", secret: "s3cret", restart: true });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.ready, false);
  assert.equal(indexKeys(env).length, 0, "a verify call wrote to the index");
});

test("F · the endpoint cannot be talked into a bigger budget", async () => {
  const env = { ...hugeWorld({ leagues: 200 }), MIGRATION_SECRET: "s3cret", ALLOWED_ORIGIN: "*" };
  const response = await worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "repair", secret: "s3cret", maxOps: 10_000_000, limit: 10_000_000,
    }),
  }), env);
  const payload = await response.json();
  assert.ok(payload.forward.opsCap <= MAX_OPS_PER_INVOCATION,
    `the caller raised the cap to ${payload.forward.opsCap}`);
  assert.ok(payload.forward.ops <= MAX_OPS_PER_INVOCATION);
});

test("F · with no secret configured the route is closed entirely", async () => {
  const env = { ...legacyWorld(), ALLOWED_ORIGIN: "*" };
  const response = await worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "repair", secret: "anything" }),
  }), env);
  assert.equal(response.status, 403);
});

// ==========================================================================
// B · driven ENTIRELY through /admin/slate-index, as an operator would
// ==========================================================================
//
// The direct-helper tests prove the algorithm. They do not prove the route
// carries the state the algorithm needs — and it did not: the continuation
// dropped forwardDone and reverseDone, so a finished direction restarted on
// every operator request and the pair could never complete together.

const SECRET = "s3cret";

function endpoint(env) {
  return async function post(body) {
    const response = await worker.fetch(new Request("https://w/admin/slate-index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET, ...body }),
    }), env);
    assert.equal(response.status, 200, `endpoint returned ${response.status}`);
    return response.json();
  };
}

test("B · ENDPOINT: ONE 1,000-league world, repaired AND verified through HTTP alone", async () => {
  // One environment for both halves. Measuring the repair on a thousand leagues
  // and the verification on sixty, then quoting the two figures together, is
  // not a measurement of anything.
  const env = { ...hugeWorld(), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const post = endpoint(env);

  // --- repair, one HTTP call at a time -----------------------------------
  let body = { action: "repair" };
  let repairCalls = 0;
  let result;
  const forwardDoneHistory = [];
  do {
    result = await post(body);
    repairCalls++;
    assert.ok(result.ops <= result.opsCap,
      `repair call ${repairCalls} performed ${result.ops} operations, cap ${result.opsCap}`);
    forwardDoneHistory.push(result.forward.done);
    body = { action: "repair", resume: result.resume };   // exactly as an operator would
  } while (!result.done && repairCalls < 5_000);

  assert.equal(result.done, true, `repair never finished in ${repairCalls} calls`);
  assert.equal(indexKeys(env).length, 1_000 * 20);
  const firstDone = forwardDoneHistory.indexOf(true);
  assert.ok(firstDone >= 0 && forwardDoneHistory.slice(firstDone).every(Boolean),
    "a completed direction restarted on a later request");

  // --- then verify THAT SAME repaired index, through the same endpoint ----
  let verified = await post({ action: "verify", restart: true });
  let verifyCalls = 1;
  while (!verified.complete && verifyCalls < 5_000) {
    // Readiness must be impossible until BOTH prefixes have finished.
    assert.equal(verified.ready, false,
      `call ${verifyCalls} reported ready with forward.done=${verified.forward.done} `
      + `reverse.done=${verified.reverse.done}`);
    assert.match(verified.verdict, /IN PROGRESS/);
    assert.ok(verified.ops <= verified.opsCap,
      `verify call ${verifyCalls} performed ${verified.ops} operations, cap ${verified.opsCap}`);
    verified = await post({ action: "verify" });
    verifyCalls++;
  }

  assert.equal(verified.complete, true, `verification never finished in ${verifyCalls} calls`);
  assert.equal(verified.ready, true, verified.verdict);
  assert.match(verified.verdict, /READY/);
  // The chain really did inspect every fixture of every league.
  assert.equal(verified.forward.counts.ok, 1_000 * 20);
  assert.equal(verified.forward.counts.missing, 0);
  assert.equal(verified.reverse.counts.stale, 0);
  assert.ok(verifyCalls > 1, "the chain finished in one call, so it proves nothing");

  console.log(`\n  ONE 1,000-league x 20-fixture world, driven entirely through HTTP:`);
  console.log(`    repair calls       : ${repairCalls}`);
  console.log(`    verification calls : ${verifyCalls}`);
  console.log(`    operation cap      : ${verified.opsCap} per invocation`);
  console.log(`    index keys written : ${indexKeys(env).length.toLocaleString()}\n`);
});

test("B · ENDPOINT: a repair invalidates the chain, so ready cannot be stale", async () => {
  const env = { ...legacyWorld({ indexed: true }), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const post = endpoint(env);
  const clean = await post({ action: "verify", restart: true });
  assert.equal(clean.ready, true);

  // Something changes; the operator repairs.
  env.KV.store.set("custom_slate:AAA:7",
    JSON.stringify({ status: "published", fixtureIds: ["f1", "f2", "f3"], periodKey: "7" }));
  await post({ action: "repair" });

  // Continuing the OLD chain must not resurrect the old verdict.
  const after = await post({ action: "verify" });
  assert.equal(after.chain.invocations, 1, "a stale chain survived the repair");
  assert.equal(after.ready, true, "the fresh chain should now be clean");
  assert.equal(indexKeys(env).length, 3);
});

test("B · ENDPOINT: the operation ceiling covers the WHOLE invocation", async () => {
  const env = { ...hugeWorld({ leagues: 100 }), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const post = endpoint(env);
  const before = { ...env.KV.counts };
  const result = await post({ action: "verify", restart: true });
  const actual = (env.KV.counts.get - before.get) + (env.KV.counts.put - before.put)
    + (env.KV.counts.list - before.list) + (env.KV.counts.delete - before.delete);
  // Including the chain's own read and write, not just the scanning.
  assert.ok(result.ops >= actual - 1 && result.ops <= result.opsCap,
    `reported ${result.ops}, actually performed ${actual}, cap ${result.opsCap}`);
  assert.ok(actual <= MAX_OPS_PER_INVOCATION,
    `the invocation performed ${actual} KV operations against a cap of ${MAX_OPS_PER_INVOCATION}`);
});

// --- the deleted resume key ------------------------------------------------

test("B · a deleted resume key does not carry its offset into a different slate", async () => {
  // Two leagues, each with many fixtures. Stop partway through the first.
  const ids = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const env = legacyWorld({ leagues: [["AAA", ids], ["BBB", ids]] });
  const first = await runDirection(env, { direction: "forward", apply: true, maxOps: 12 });
  assert.equal(first.position.key, "custom_slate:AAA:7");
  assert.ok(first.position.offset > 0 && first.position.offset < 30,
    `stopped at offset ${first.position.offset}`);
  const doneForAAA = indexKeys(env).filter((k) => k.endsWith(":AAA")).length;

  // The league is deleted between invocations; its slate key is gone.
  env.KV.store.delete("custom_slate:AAA:7");
  env.KV.store.delete("league:AAA");

  const second = await runDirection(env,
    { direction: "forward", apply: true, position: first.position, maxOps: 500 });
  assert.equal(second.done, true);
  // BBB must be indexed from its FIRST fixture, not from AAA's offset.
  const bbb = indexKeys(env).filter((k) => k.endsWith(":BBB")).sort();
  assert.equal(bbb.length, 30, `only ${bbb.length} of BBB's 30 fixtures were indexed`);
  assert.equal(bbb[0], "slatefx:f00:BBB", "the first fixtures of the next slate were skipped");
  // And AAA's partial keys are left for the reverse pass to clear.
  assert.ok(doneForAAA > 0);
});

test("B · a deleted resume key with an exact-match successor keeps its offset", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const env = legacyWorld({ leagues: [["AAA", ids]] });
  const first = await runDirection(env, { direction: "forward", apply: true, maxOps: 12 });
  const written = indexKeys(env).length;
  // The key is still there, so the offset applies and finished work is not redone.
  const second = await runDirection(env,
    { direction: "forward", apply: true, position: first.position, maxOps: 500 });
  assert.equal(second.repaired, 30 - written, "the resumed run redid finished fixtures");
  assert.equal(indexKeys(env).length, 30);
});

// ==========================================================================
// G · orphan cleanup — the only way out of the orphaned-slate gate
// ==========================================================================
//
// Production reached a state the operator could not leave: two published
// slates whose league records were gone, an index that was otherwise perfect,
// and a verdict that said "repair, then start a new chain" — which repair can
// never satisfy, because repair only COUNTS orphans.
//
// The readiness rule is not weakened here and no scan is allowed to delete
// anything. What may be deleted is fixed in code at deploy time; KV holds only
// progress, idempotency and audit, because an eventually-consistent read that
// returns nothing cannot be told apart from a key that never existed.

const CLEAN = readFileSync(new URL("../src/notify/backfill.js", import.meta.url), "utf8");

const ID = "test-cleanup";

/**
 * The deployment-scoped authority, for a synthetic world. Production tests use
 * the REAL table instead, by passing no override at all.
 */
const withTable = (...pairs) => ({ table: Object.fromEntries(pairs) });
const table1 = (id, authorised) => withTable([id, authorised]);

/** The real, code-authorised operation this correction exists to permit. */
const REAL_ID = "v166-b1-orphans-20260821";
const REAL_ALLOW = [
  { key: "custom_slate:CGALPR:1", code: "CGALPR" },
  { key: "custom_slate:XP926U:1", code: "XP926U" },
];

/**
 * A world with healthy leagues and orphans side by side, so every test can
 * check what was NOT touched as well as what was.
 */
function orphanWorld({
  orphans = ["OLD"], healthy = ["AAA"], drafts = [], indexed = true, period = "7",
} = {}) {
  const seed = { __meta: {} };
  const slate = (code, status) => {
    seed[`custom_slate:${code}:${period}`] = {
      status, fixtureIds: ["f1", "f2"], periodKey: period,
    };
  };
  for (const code of healthy) {
    seed[`league:${code}`] = { code, name: code };
    slate(code, "published");
    if (indexed) {
      for (const id of ["f1", "f2"]) {
        seed[`slatefx:${id}:${code}`] = { period };
        seed.__meta[`slatefx:${id}:${code}`] = { period };
      }
    }
  }
  // An orphan is a published slate with NO league record.
  for (const code of orphans) slate(code, "published");
  for (const code of drafts) slate(code, "draft");
  return { KV: kvShim(seed) };
}

/** Production's own shape: the two real orphans beside a live league. */
const prodWorld = (options = {}) =>
  orphanWorld({ orphans: ["CGALPR", "XP926U"], healthy: ["LIVE"], period: "1", ...options });

const slateKeys = (env) =>
  [...env.KV.store.keys()].filter((k) => k.startsWith("custom_slate:")).sort();

/**
 * The slate keys a run actually deleted. `counts.delete` is not that number:
 * a cleanup also deletes the chain key, so counting every delete would let a
 * chain invalidation stand in for a second deletion — which is precisely the
 * thing "exactly once" has to rule out.
 */
function watchSlateDeletes(env) {
  const deleted = [];
  const inner = env.KV.delete.bind(env.KV);
  env.KV.delete = async (key) => {
    if (String(key).startsWith("custom_slate:")) deleted.push(key);
    return inner(key);
  };
  return deleted;
}

/** Every mutating KV operation, in the order it was actually issued. */
function traceWrites(env) {
  const order = [];
  const put = env.KV.put.bind(env.KV);
  const del = env.KV.delete.bind(env.KV);
  env.KV.put = async (key, value, options) => { order.push(`put:${key}`); return put(key, value, options); };
  env.KV.delete = async (key) => { order.push(`del:${key}`); return del(key); };
  return order;
}

/** Fail the first delete of one exact key, once — a crash mid-cleanup. */
function crashOnDelete(env, key) {
  const inner = env.KV.delete.bind(env.KV);
  let armed = true;
  env.KV.delete = async (k) => {
    if (armed && k === key) { armed = false; throw new Error(`KV delete failed: ${k}`); }
    return inner(k);
  };
}

/**
 * Another Cloudflare location: same data, except the manifest this location
 * has not seen yet. KV is eventually consistent, so this is not a fault — it
 * is Tuesday.
 */
const forgetManifest = (env, id) => env.KV.store.delete(cleanupManifestKey(id));

/** Total KV operations the store itself saw. */
const opCount = (env) =>
  env.KV.counts.get + env.KV.counts.put + env.KV.counts.delete + env.KV.counts.list;

const writes = (env) => env.KV.counts.put + env.KV.counts.delete;

// --- 1 · ordinary repair never deletes an orphan --------------------------

test("G · default repair never deletes an orphan, however many times it runs", async () => {
  const env = orphanWorld({ orphans: ["OLD", "GONE"] });
  const before = slateKeys(env);
  const first = await driveRepair(env);
  const second = await driveRepair(env);
  assert.equal(first.result.forward.orphaned, 2, "the orphans were not even seen");
  assert.equal(second.result.forward.orphaned, 2);
  assert.deepEqual(slateKeys(env), before, "a repair deleted a slate");
  assert.equal(env.KV.counts.delete, 0, "a repair issued a delete");
});

test("G · nothing before the cleanup section can reach the deletion", () => {
  const banner = CLEAN.indexOf("// Orphan cleanup");
  assert.ok(banner > 0, "the cleanup section is not where the test thinks it is");
  const scanners = CLEAN.slice(0, banner);
  assert.ok(!scanners.includes("cleanupOrphans"),
    "runDirection, verify or repair reaches the cleanup");
  const calls = SOURCE.split("cleanupOrphanSlates(").length - 1;
  assert.equal(calls, 1, `cleanupOrphanSlates is called from ${calls} places`);
  const cron = SOURCE.slice(SOURCE.indexOf("async function scheduled"));
  assert.ok(!cron.includes("cleanupOrphanSlates"), "the cron can delete slates");
});

// --- 2 · the authority is in CODE ----------------------------------------

test("G · the deployment authorises exactly one cleanup, and exactly two keys", () => {
  assert.ok(Object.isFrozen(AUTHORISED_CLEANUPS));
  assert.deepEqual(Object.keys(AUTHORISED_CLEANUPS), [REAL_ID]);
  assert.deepEqual(AUTHORISED_CLEANUPS[REAL_ID].map((e) => ({ ...e })), REAL_ALLOW);
  assert.ok(Object.isFrozen(AUTHORISED_CLEANUPS[REAL_ID]));
});

test("G · the route never supplies an authority table of its own", () => {
  const at = SOURCE.indexOf("cleanupOrphanSlates(");
  const call = SOURCE.slice(at, SOURCE.indexOf("})) }, 200, env);", at));
  assert.ok(!/table/.test(call),
    "the request path can override the code-authorised table");
  assert.match(call, /id: body\.id/);
  assert.match(call, /allow: body\.allow/);
});

test("G · an unauthorised cleanup id is refused, with valid orphan keys and zero KV", async () => {
  const env = prodWorld();
  for (const id of ["v166-b1-orphans-20260822", "cleanup", "constructor", "toString",
    "V166-B1-ORPHANS-20260821"]) {
    const before = opCount(env);
    await assert.rejects(() => cleanupOrphans(env, { id, allow: REAL_ALLOW }), CleanupRefused,
      `id "${id}" was accepted`);
    assert.equal(opCount(env), before, `id "${id}" touched KV`);
  }
  assert.deepEqual(slateKeys(env), [
    "custom_slate:CGALPR:1", "custom_slate:LIVE:1", "custom_slate:XP926U:1",
  ]);
});

test("G · a submitted list that differs from the CODE list is refused before any KV", async () => {
  const env = prodWorld({ orphans: ["CGALPR", "XP926U", "OTHER"] });
  const mutations = [
    [...REAL_ALLOW, { key: "custom_slate:OTHER:1", code: "OTHER" }],       // wider
    [REAL_ALLOW[0]],                                                       // narrower
    [REAL_ALLOW[0], { key: "custom_slate:OTHER:1", code: "OTHER" }],        // substituted
    [{ key: "custom_slate:CGALPR:1", code: "XP926U" }, REAL_ALLOW[1]],      // recoded
    ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"],                     // undeclared
    [{ key: "custom_slate:LIVE:1", code: "LIVE" }],                         // a live league
  ];
  for (const allow of mutations) {
    const before = opCount(env);
    await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow }), CleanupRefused,
      `a mutated list was accepted: ${JSON.stringify(allow)}`);
    assert.equal(opCount(env), before, "a refused list read or wrote KV");
  }
  assert.deepEqual(slateKeys(env), [
    "custom_slate:CGALPR:1", "custom_slate:LIVE:1", "custom_slate:OTHER:1", "custom_slate:XP926U:1",
  ]);
});

test("G · with NO manifest visible, a mutated list is still refused with zero writes", async () => {
  // The eventual-consistency case: this location has never seen a manifest.
  // Under the old design that was read as permission to create one from the
  // request, which is exactly how a wider list got in.
  const env = prodWorld();
  assert.equal(await readCleanupManifest(env, REAL_ID), null, "the world was seeded with a manifest");
  const before = writes(env);
  await assert.rejects(() => cleanupOrphans(env, {
    id: REAL_ID, allow: [...REAL_ALLOW, { key: "custom_slate:LIVE:1", code: "LIVE" }],
  }), CleanupRefused);
  assert.equal(writes(env), before, "a refused request wrote to KV");
  assert.equal(await readCleanupManifest(env, REAL_ID), null, "a refused request created a manifest");
  assert.ok(env.KV.store.has("custom_slate:LIVE:1"));
});

test("G · a location that cannot see the manifest replays the SAME keys and no others", async () => {
  const env = prodWorld();
  await driveVerify(env);
  const deletedKeys = watchSlateDeletes(env);

  // Location A crashes partway through.
  crashOnDelete(env, "custom_slate:XP926U:1");
  await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW }),
    /KV delete failed/);
  assert.ok(!env.KV.store.has("custom_slate:CGALPR:1"), "the first deletion did not happen");
  assert.ok(await readCleanupManifest(env, REAL_ID), "location A wrote no manifest");

  // Location B has not replicated it yet.
  forgetManifest(env, REAL_ID);
  assert.equal(await readCleanupManifest(env, REAL_ID), null);

  // Every mutation is still refused there — the authority never travelled.
  for (const allow of [
    [...REAL_ALLOW, { key: "custom_slate:LIVE:1", code: "LIVE" }],
    [REAL_ALLOW[1]],
    [{ key: "custom_slate:LIVE:1", code: "LIVE" }],
  ]) {
    const before = writes(env);
    await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow }), CleanupRefused);
    assert.equal(writes(env), before);
  }

  // The exact authorised list replays safely: the key already gone is reported,
  // not deleted again, and the one that crashed is finished.
  const replay = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(replay.done, true);
  assert.equal(replay.deleted, 1);
  assert.equal(replay.already_absent, 1);
  assert.deepEqual(deletedKeys, ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"],
    `slates were deleted ${deletedKeys.length} times in total`);
  assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1"]);
});

test("G · a stored manifest that disagrees with the code is refused, not overwritten", async () => {
  const env = prodWorld();
  const forged = JSON.stringify({
    id: REAL_ID,
    allow: [{ key: "custom_slate:LIVE:1", code: "LIVE" }],
    identity: ["custom_slate:LIVE:1|LIVE"],
    at: 0, status: "running", results: [], invocations: 1,
  });
  env.KV.store.set(cleanupManifestKey(REAL_ID), forged);

  await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW }),
    CleanupRefused);
  assert.equal(env.KV.store.get(cleanupManifestKey(REAL_ID)), forged,
    "the disagreeing manifest was overwritten");
  assert.deepEqual(slateKeys(env), [
    "custom_slate:CGALPR:1", "custom_slate:LIVE:1", "custom_slate:XP926U:1",
  ]);
});

// --- 3 · the allowlist is the whole authority -----------------------------

test("G · an unlisted orphan is untouched, and nothing outside the list is", async () => {
  const env = prodWorld({ orphans: ["CGALPR", "XP926U", "OTHER"] });
  const before = new Set(env.KV.store.keys());
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });

  assert.equal(result.deleted, 2);
  assert.ok(env.KV.store.has("custom_slate:OTHER:1"), "an unlisted orphan was deleted");
  const after = new Set(env.KV.store.keys());
  const removed = [...before].filter((k) => !after.has(k) && k.startsWith("custom_slate:"));
  assert.deepEqual(removed.sort(), ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"]);
});

test("G · a listed slate whose league still exists is REFUSED, not deleted", async () => {
  // The recheck at delete time: the code authorises the key, the live league
  // record still vetoes it.
  const env = prodWorld();
  env.KV.store.set("league:CGALPR", JSON.stringify({ code: "CGALPR", name: "back" }));
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(result.deleted, 1);
  const refused = result.results.find((r) => r.outcome === "refused");
  assert.deepEqual(refused, {
    key: "custom_slate:CGALPR:1", code: "CGALPR", outcome: "refused", reason: "league_exists",
  });
  assert.ok(env.KV.store.has("custom_slate:CGALPR:1"), "a live league's slate was deleted");
});

test("G · the league is re-read at DELETE time, not trusted from an earlier scan", async () => {
  const env = prodWorld();
  const scan = await driveVerify(env);
  assert.equal(scan.result.chain.forward.counts.orphaned, 2, "the scan did not see the orphans");

  env.KV.store.set("league:CGALPR", JSON.stringify({ code: "CGALPR" }));
  env.KV.store.set("league:XP926U", JSON.stringify({ code: "XP926U" }));
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(result.deleted, 0, "an out-of-date scan was treated as authority to delete");
  assert.deepEqual(result.results.map((r) => r.reason), ["league_exists", "league_exists"]);
  assert.deepEqual(slateKeys(env), [
    "custom_slate:CGALPR:1", "custom_slate:LIVE:1", "custom_slate:XP926U:1",
  ]);
});

test("G · malformed and mismatched keys are refused", async () => {
  const env = orphanWorld({ orphans: ["OLD"], healthy: ["AAA"] });
  const allow = [
    "league:OLD",                                  // not a slate key at all
    "slatefx:f1:AAA",                              // an index key
    "custom_slate:OLD",                            // no period
    "custom_slate::7",                             // no code
    "",                                            // empty
    42,                                            // not a string
    { code: "OLD" },                               // no key
    { key: "custom_slate:OLD:7", code: "AAA" },    // key and code disagree
  ];
  const before = new Set(env.KV.store.keys());
  const deletedKeys = watchSlateDeletes(env);
  const result = await cleanupOrphans(env, { id: ID, allow }, table1(ID, allow));

  assert.equal(result.deleted, 0, `${result.deleted} keys were deleted`);
  assert.equal(result.refused, 8, `${result.refused} of 8 entries were refused`);
  assert.deepEqual(result.results.map((r) => r.reason).sort(), [
    "malformed", "malformed", "malformed", "malformed", "malformed", "malformed",
    "malformed", "mismatch",
  ]);
  const after = new Set(env.KV.store.keys());
  assert.deepEqual([...before].filter((k) => !after.has(k)), [], "a malformed entry removed a key");
  assert.deepEqual(deletedKeys, [], `${deletedKeys.length} slates were deleted`);
});

test("G · a draft slate is refused even when its league is gone", async () => {
  // Only a PUBLISHED orphan is counted, and only a published one holds the
  // gate shut. Anything wider than the gate is outside this mechanism.
  const env = orphanWorld({ orphans: [], drafts: ["DRAFT"] });
  const allow = ["custom_slate:DRAFT:7"];
  const result = await cleanupOrphans(env, { id: ID, allow }, table1(ID, allow));
  assert.equal(result.deleted, 0);
  assert.equal(result.results[0].reason, "not_published");
  assert.ok(env.KV.store.has("custom_slate:DRAFT:7"));
});

// --- 4 · whole-call refusals, which must write NOTHING --------------------

test("G · an oversized allowlist is refused whole, and writes nothing", async () => {
  const env = orphanWorld({ orphans: ["OLD"] });
  const allow = Array.from({ length: MAX_CLEANUP_KEYS + 1 }, (_, i) => `custom_slate:X${i}:7`);
  const before = writes(env);
  await assert.rejects(() => cleanupOrphans(env, { id: ID, allow }, table1(ID, allow)),
    CleanupRefused);
  assert.equal(writes(env), before, "a refused request wrote to KV");
  assert.ok(env.KV.store.has("custom_slate:OLD:7"));
});

test("G · an empty allowlist is refused, so an id cannot be burnt on nothing", async () => {
  const env = orphanWorld({ orphans: ["OLD"] });
  const before = writes(env);
  await assert.rejects(
    () => cleanupOrphans(env, { id: ID, allow: [] }, table1(ID, ["custom_slate:OLD:7"])),
    CleanupRefused);
  assert.equal(writes(env), before);
  assert.equal(await readCleanupManifest(env, ID), null, "an empty run created a manifest");
});

test("G · a missing or unusable cleanup id is refused, and writes nothing", async () => {
  const env = orphanWorld({ orphans: ["OLD"] });
  const allow = ["custom_slate:OLD:7"];
  for (const id of [undefined, "", "   ", 42, "has space", "colon:inside", "a".repeat(65)]) {
    const before = writes(env);
    await assert.rejects(() => cleanupOrphans(env, { id, allow }, table1(ID, allow)),
      CleanupRefused, `id ${JSON.stringify(id)} was accepted`);
    assert.equal(writes(env), before, `id ${JSON.stringify(id)} wrote to KV`);
  }
  assert.ok(env.KV.store.has("custom_slate:OLD:7"));
});

test("G · an undersized maxOps is REFUSED, not silently raised", async () => {
  // Raising it silently is what let actual operations exceed the reported cap.
  const env = prodWorld();
  for (const maxOps of [1, 2, 3, 4, 5, 6]) {
    const before = writes(env);
    await assert.rejects(
      () => cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW, maxOps }),
      CleanupRefused, `maxOps ${maxOps} was accepted`);
    assert.equal(writes(env), before, `maxOps ${maxOps} wrote to KV before refusing`);
  }
  assert.equal(await readCleanupManifest(env, REAL_ID), null);

  const ok = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW, maxOps: MIN_CLEANUP_OPS });
  assert.equal(ok.opsCap, MIN_CLEANUP_OPS);
  assert.ok(ok.ops <= ok.opsCap, `${ok.ops} operations against a cap of ${ok.opsCap}`);
});

// --- 5 · the operation count is the whole invocation ----------------------

test("G · reported ops are the REAL KV operations: manifest, chain and slates", async () => {
  const env = prodWorld();
  await driveVerify(env);
  const before = opCount(env);
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  const spent = opCount(env) - before;

  // manifest read + manifest write + chain delete + 2 keys x 3 + progress write.
  assert.equal(spent, MANIFEST_OPS + CHAIN_OPS_PER_CLEANUP + 2 * CLEANUP_OPS_PER_KEY);
  assert.equal(result.ops, spent, `reported ${result.ops}, KV saw ${spent}`);
  assert.ok(result.ops <= result.opsCap);
});

test("G · under EVERY accepted cap, real operations stay inside the reported one", async () => {
  for (let maxOps = MIN_CLEANUP_OPS; maxOps <= MIN_CLEANUP_OPS + 8; maxOps++) {
    const env = prodWorld();
    let invocations = 0;
    let result;
    do {
      const before = opCount(env);
      result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW, maxOps });
      const spent = opCount(env) - before;
      invocations++;
      assert.equal(result.opsCap, maxOps, "the reported cap is not the requested one");
      assert.equal(result.ops, spent, `maxOps ${maxOps}: reported ${result.ops}, KV saw ${spent}`);
      assert.ok(spent <= maxOps, `maxOps ${maxOps}: invocation ${invocations} really spent ${spent}`);
    } while (!result.done && invocations < 30);
    assert.equal(result.done, true, `maxOps ${maxOps} never finished`);
    assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1"]);
  }
});

test("G · the endpoint cannot be talked into a bigger budget", async () => {
  const env = { ...prodWorld(), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const payload = await endpoint(env)({
    action: "cleanup-orphans", id: REAL_ID, allow: REAL_ALLOW, maxOps: 10_000_000,
  });
  assert.ok(payload.opsCap <= MAX_OPS_PER_INVOCATION, `the caller raised the cap to ${payload.opsCap}`);
  assert.ok(payload.ops <= payload.opsCap);
});

// --- 6 · ordering: manifest, then chain, then anything destructive --------

test("G · the manifest is persisted BEFORE the chain and before any slate delete", async () => {
  const env = prodWorld();
  await driveVerify(env);
  assert.ok(await readChain(env), "no chain to invalidate");

  const order = traceWrites(env);
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(result.deleted, 2);

  const manifestAt = order.indexOf(`put:${cleanupManifestKey(REAL_ID)}`);
  const chainAt = order.indexOf("del:notify:index_chain");
  const firstSlate = order.findIndex((op) => op.startsWith("del:custom_slate:"));
  assert.equal(manifestAt, 0, `the first write was ${order[0]}, not the manifest`);
  assert.ok(chainAt > manifestAt, "the chain went before the manifest was persisted");
  assert.ok(firstSlate > chainAt, "a slate was deleted before the chain was invalidated");
  assert.equal(order.filter((op) => op === "del:notify:index_chain").length, 1,
    "the chain was invalidated more than once in a single invocation");
});

test("G · the chain is invalidated even when every deletion is then REFUSED", async () => {
  // A cleanup attempt is a reason to reverify whatever it concluded. Tying
  // invalidation to deleted > 0 is exactly the inference that fails after a
  // crash, where the retry finds nothing left to delete.
  const env = prodWorld();
  env.KV.store.set("league:CGALPR", JSON.stringify({ code: "CGALPR" }));
  env.KV.store.set("league:XP926U", JSON.stringify({ code: "XP926U" }));
  await driveVerify(env);
  assert.ok(await readChain(env));

  const result = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(result.deleted, 0);
  assert.equal(result.chainInvalidated, true);
  assert.equal(await readChain(env), null, "a refused cleanup left the old chain alive");
});

test("G · a crash DURING the first slate delete leaves the chain gone and the manifest written",
  async () => {
    const env = prodWorld();
    await driveVerify(env);
    assert.ok(await readChain(env), "no chain to strand");

    crashOnDelete(env, "custom_slate:CGALPR:1");
    await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW }),
      /KV delete failed/);

    assert.equal(await readChain(env), null,
      "the crash stranded the chain the cleanup was about to invalidate");
    const manifest = await readCleanupManifest(env, REAL_ID);
    assert.ok(manifest, "the crash left no manifest");
    assert.equal(manifest.status, "running");
    assert.deepEqual(manifest.identity,
      ["custom_slate:CGALPR:1|CGALPR", "custom_slate:XP926U:1|XP926U"]);
    assert.ok(env.KV.store.has("custom_slate:CGALPR:1"), "the slate went despite the failed delete");
  });

test("G · a crash after the FIRST of two deletions retries idempotently", async () => {
  const env = prodWorld({ indexed: false });
  await driveRepair(env);
  const before = await driveVerify(env);
  assert.equal(before.result.chain.forward.counts.orphaned, 2);

  const deletedKeys = watchSlateDeletes(env);
  crashOnDelete(env, "custom_slate:XP926U:1");
  await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW }),
    /KV delete failed/);
  assert.ok(!env.KV.store.has("custom_slate:CGALPR:1"), "the first deletion did not happen");
  assert.equal(await readChain(env), null, "a stale chain survived a partial cleanup");

  const retry = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(retry.done, true);
  assert.equal(retry.status, "complete");
  assert.equal(retry.deleted, 1);
  assert.equal(retry.already_absent, 1);
  assert.deepEqual(deletedKeys, ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"],
    `slates were deleted ${deletedKeys.length} times in total`);

  const after = await driveVerify(env, {});
  assert.equal(after.result.chain.forward.counts.orphaned, 0);
});

// --- 7 · a completed id is terminal ---------------------------------------

test("G · a completed cleanup id cannot be reused for another list", async () => {
  const env = prodWorld({ orphans: ["CGALPR", "XP926U", "OTHER"] });
  const done = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(done.status, "complete");
  assert.equal((await readCleanupManifest(env, REAL_ID)).status, "complete");

  for (const allow of [
    [...REAL_ALLOW, { key: "custom_slate:OTHER:1", code: "OTHER" }],
    [{ key: "custom_slate:OTHER:1", code: "OTHER" }],
    [{ key: "custom_slate:LIVE:1", code: "LIVE" }],
  ]) {
    await assert.rejects(() => cleanupOrphans(env, { id: REAL_ID, allow }), CleanupRefused,
      `a completed id was reused for ${JSON.stringify(allow)}`);
  }
  assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1", "custom_slate:OTHER:1"]);
});

test("G · replaying a completed id with the SAME list deletes nothing", async () => {
  const env = prodWorld();
  const first = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(first.deleted, 2);

  const deletedKeys = watchSlateDeletes(env);
  const replay = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(replay.replay, true);
  assert.equal(replay.done, true);
  assert.equal(replay.deleted, 0);
  assert.deepEqual(deletedKeys, [], "a replay deleted something");
  // The terminal record is retained for audit.
  assert.deepEqual(replay.results.map((r) => r.outcome), ["deleted", "deleted"]);
  assert.deepEqual(replay.results.map((r) => r.key),
    ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"]);
});

test("G · each authorised key is deleted EXACTLY once, across every replay", async () => {
  const env = prodWorld();
  const deletedKeys = watchSlateDeletes(env);
  await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  forgetManifest(env, REAL_ID);
  await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.deepEqual(deletedKeys, ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"],
    `keys were deleted ${deletedKeys.length} times`);
});

test("G · the allowlist is ordered by its CONTENT, so a stored position means the same thing", () => {
  const a = normalizeAllow(["custom_slate:B:7", "custom_slate:A:7", "custom_slate:B:7"]);
  const b = normalizeAllow(["custom_slate:A:7", "custom_slate:B:7"]);
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
  assert.equal(a.length, 2, "a duplicate entry survived normalisation");
});

test("G · the same SET in a different order is the same authorisation", async () => {
  const env = prodWorld();
  const reordered = [REAL_ALLOW[1], REAL_ALLOW[0], REAL_ALLOW[1]];
  const result = await cleanupOrphans(env, { id: REAL_ID, allow: reordered });
  assert.equal(result.done, true);
  assert.equal(result.deleted, 2);
  assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1"]);
});

// --- 8 · and only then is the gate open ----------------------------------

test("G · after cleanup a FRESH complete chain reaches ready:true", async () => {
  const env = prodWorld({ indexed: false });

  const repaired = await driveRepair(env);
  assert.equal(repaired.result.forward.repaired, 2);
  const blocked = await driveVerify(env);
  assert.equal(blocked.result.complete, true);
  assert.equal(blocked.result.ready, false);
  assert.equal(blocked.result.chain.forward.counts.missing, 0);
  assert.equal(blocked.result.chain.reverse.counts.stale, 0);
  assert.equal(blocked.result.chain.forward.counts.orphaned, 2);

  const cleanup = await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(cleanup.deleted, 2);

  const open = await driveVerify(env);
  assert.equal(open.result.complete, true);
  assert.equal(open.result.chain.forward.counts.missing, 0);
  assert.equal(open.result.chain.reverse.counts.stale, 0);
  assert.equal(open.result.chain.forward.counts.orphaned, 0);
  assert.equal(open.result.ready, true, open.result.verdict);
});

test("G · ready:true needs ALL THREE at zero — one orphan out of scope is enough to hold it", async () => {
  const env = prodWorld({ orphans: ["CGALPR", "XP926U", "OTHER"], indexed: false });
  await driveRepair(env);
  await cleanupOrphans(env, { id: REAL_ID, allow: REAL_ALLOW });
  const still = await driveVerify(env);
  assert.equal(still.result.complete, true);
  assert.equal(still.result.chain.forward.counts.orphaned, 1);
  assert.equal(still.result.ready, false, "an unauthorised orphan opened the gate");

  // A missing index entry alone also holds it shut, with no orphan in sight.
  const missing = orphanWorld({ orphans: [], healthy: ["AAA"], indexed: false });
  const shut = await driveVerify(missing);
  assert.equal(shut.result.chain.forward.counts.orphaned, 0);
  assert.ok(shut.result.chain.forward.counts.missing > 0);
  assert.equal(shut.result.ready, false);
});

// --- 9 · the route --------------------------------------------------------

test("G · ENDPOINT: cleanup is behind the migration secret and nothing else", async () => {
  const env = { ...prodWorld(), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const noSecret = await worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "cleanup-orphans", id: REAL_ID, allow: REAL_ALLOW }),
  }), env);
  assert.equal(noSecret.status, 403);

  const raw = (body) => worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, ...body }),
  }), env);
  assert.equal((await raw({ action: "cleanup-orphan", allow: [] })).status, 400,
    "a near-miss action name was accepted");
  assert.equal((await raw({ action: "cleanup-orphans", allow: REAL_ALLOW })).status, 400,
    "a cleanup with no id was accepted");
  assert.equal((await raw({ action: "cleanup-orphans", id: "made-up", allow: REAL_ALLOW })).status,
    400, "an unauthorised id was accepted");
  assert.deepEqual(slateKeys(env), [
    "custom_slate:CGALPR:1", "custom_slate:LIVE:1", "custom_slate:XP926U:1",
  ]);
});

test("G · ENDPOINT: after a crashed cleanup, ready still needs a fresh 0/0/0 chain", async () => {
  const env = { ...prodWorld({ indexed: false }), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const post = endpoint(env);

  let repairResult = await post({ action: "repair" });
  while (!repairResult.done) repairResult = await post({ action: "repair", resume: repairResult.resume });
  let blocked = await post({ action: "verify", restart: true });
  while (!blocked.complete) blocked = await post({ action: "verify" });
  assert.equal(blocked.ready, false);
  assert.match(blocked.verdict, /2 orphaned/);

  // Crash partway through the authorised cleanup.
  crashOnDelete(env, "custom_slate:XP926U:1");
  const crashed = await worker.fetch(new Request("https://w/admin/slate-index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, action: "cleanup-orphans", id: REAL_ID, allow: REAL_ALLOW }),
  }), env);
  assert.equal(crashed.status, 500, "a failed KV delete was reported as success");
  assert.equal(await readChain(env), null, "the crashed cleanup left a chain behind");

  // The retry cannot be widened over HTTP, with or without a visible manifest.
  for (const seen of [true, false]) {
    if (!seen) forgetManifest(env, REAL_ID);
    const widened = await worker.fetch(new Request("https://w/admin/slate-index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: SECRET, action: "cleanup-orphans", id: REAL_ID,
        allow: [...REAL_ALLOW, { key: "custom_slate:LIVE:1", code: "LIVE" }],
      }),
    }), env);
    assert.equal(widened.status, 400, `manifest visible=${seen}: a wider list was accepted`);
    assert.match((await widened.json()).error, /does not match the 2 key\(s\) authorised in code/);
  }

  // One orphan left: a complete chain still refuses to open the gate.
  let still = await post({ action: "verify", restart: true });
  while (!still.complete) still = await post({ action: "verify" });
  assert.equal(still.forward.counts.orphaned, 1);
  assert.equal(still.ready, false, "one remaining orphan opened the gate");

  const finished = await post({ action: "cleanup-orphans", id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(finished.deleted, 1);
  assert.equal(finished.already_absent, 1);
  assert.equal(finished.done, true);
  assert.equal(finished.chainInvalidated, true);
  assert.equal(await readChain(env), null);

  let fresh = await post({ action: "verify", restart: true });
  while (!fresh.complete) fresh = await post({ action: "verify" });
  assert.equal(fresh.forward.counts.missing, 0);
  assert.equal(fresh.reverse.counts.stale, 0);
  assert.equal(fresh.forward.counts.orphaned, 0);
  assert.equal(fresh.ready, true, fresh.verdict);
  assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1"]);
});

test("G · ENDPOINT: the whole operator sequence, over HTTP alone", async () => {
  const env = { ...prodWorld({ indexed: false }), MIGRATION_SECRET: SECRET, ALLOWED_ORIGIN: "*" };
  const post = endpoint(env);

  let repairResult = await post({ action: "repair" });
  while (!repairResult.done) repairResult = await post({ action: "repair", resume: repairResult.resume });

  let verifyResult = await post({ action: "verify", restart: true });
  while (!verifyResult.complete) verifyResult = await post({ action: "verify" });
  assert.equal(verifyResult.ready, false);
  assert.match(verifyResult.verdict, /2 orphaned/);

  const cleaned = await post({ action: "cleanup-orphans", id: REAL_ID, allow: REAL_ALLOW });
  assert.equal(cleaned.deleted, 2);
  assert.equal(cleaned.done, true);
  assert.equal(cleaned.chainInvalidated, true);
  assert.deepEqual(cleaned.results.map((r) => r.key),
    ["custom_slate:CGALPR:1", "custom_slate:XP926U:1"]);

  let fresh = await post({ action: "verify", restart: true });
  while (!fresh.complete) fresh = await post({ action: "verify" });
  assert.equal(fresh.ready, true, fresh.verdict);
  assert.equal(fresh.forward.counts.orphaned, 0);
  assert.deepEqual(slateKeys(env), ["custom_slate:LIVE:1"]);
});
