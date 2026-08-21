// Slice 1 · F — the slate-index backfill. Built, tested, and NOT run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kvShim } from "./notify_harness.mjs";
import {
  verify, repair, runDirection, readChain, parseSlateKey, parseIndexKey,
  clampLimit, clampOps, MAX_OPS_PER_INVOCATION, MAX_LIST_LIMIT,
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
