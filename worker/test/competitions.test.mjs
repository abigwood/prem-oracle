import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPETITION_CODES,
  DEFAULT_COMPETITION,
  LEGACY_RESULTS_KEY,
  assertNotLegacyResultsKey,
  competitionOfFixture,
  hashResults,
  isNamespacedFixtureId,
  leagueCompetition,
  normaliseCompetition,
  resultsKey,
  splitResultsByCompetition,
} from "../src/competitions.js";
import {
  MIGRATION_KEY,
  STAGES,
  diffResults,
  readMigration,
  readResults,
  resultsReadKeys,
  resultsWriteKey,
  rollback,
  runStage,
} from "../src/migration.js";

function memoryKV(store = new Map()) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      return type === "json" ? JSON.parse(store.get(key)) : store.get(key);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

const settled = (p1, p2) => ({ status: "complete", result: [p1, p2], lockAt: "2026-08-21T19:00:00Z" });

// --- competition codes ------------------------------------------------------

test("a fixture's competition comes from its own namespaced id", () => {
  assert.equal(competitionOfFixture("pl-2026-27-001-arsenal-coventry-city"), "PL");
  assert.equal(competitionOfFixture("elc-2026-27-001-wolves-blackburn"), "ELC");
  assert.equal(competitionOfFixture("cl-2026-001-real-madrid-arsenal"), "CL");
  // A bare provider id belongs to nothing and is never guessed at.
  assert.equal(competitionOfFixture("12345"), null);
  assert.equal(competitionOfFixture(""), null);
  assert.equal(competitionOfFixture(null), null);
  assert.equal(isNamespacedFixtureId("pl-x"), true);
  assert.equal(isNamespacedFixtureId("x"), false);
});

test("elc- is not shadowed by a shorter prefix", () => {
  // Guards the ordering in the prefix table: "elc-" must win over any sibling.
  assert.equal(competitionOfFixture("elc-2026-27-500-burnley-watford"), "ELC");
});

test("leagues without a competition are Premier League leagues", () => {
  assert.equal(DEFAULT_COMPETITION, "PL");
  assert.equal(leagueCompetition({ code: "ABC123" }), "PL");
  assert.equal(leagueCompetition({ competition: "ELC" }), "ELC");
  assert.equal(leagueCompetition({ competition: "nonsense" }), "PL");
  assert.equal(normaliseCompetition(undefined), "PL");
  assert.deepEqual(COMPETITION_CODES.sort(), ["CL", "ELC", "PL"]);
});

test("results keys are per competition and the legacy key is never a target", () => {
  assert.equal(resultsKey("PL"), "results:PL");
  assert.equal(resultsKey("ELC"), "results:ELC");
  assert.equal(resultsKey("bogus"), "results:PL");
  assert.equal(LEGACY_RESULTS_KEY, "results");
  assert.throws(() => assertNotLegacyResultsKey("results"), /frozen and never mutated/);
  assert.equal(assertNotLegacyResultsKey("results:PL"), "results:PL");
  for (const code of COMPETITION_CODES) assert.notEqual(resultsWriteKey(code), LEGACY_RESULTS_KEY);
});

test("splitting a flat results object keeps un-namespaced ids visible", () => {
  const { split, unknown } = splitResultsByCompetition({
    "pl-2026-27-001-a-b": settled(2, 1),
    "elc-2026-27-001-c-d": settled(0, 0),
    "9999": settled(1, 1),
  });
  assert.deepEqual(Object.keys(split.PL), ["pl-2026-27-001-a-b"]);
  assert.deepEqual(Object.keys(split.ELC), ["elc-2026-27-001-c-d"]);
  assert.deepEqual(Object.keys(split.CL), []);
  assert.deepEqual(Object.keys(unknown), ["9999"]);
});

test("the results hash ignores key order but not content", () => {
  const a = { x: settled(1, 0), y: settled(2, 2) };
  const b = { y: settled(2, 2), x: settled(1, 0) };
  assert.equal(hashResults(a), hashResults(b));
  assert.notEqual(hashResults(a), hashResults({ x: settled(1, 0), y: settled(2, 1) }));
  assert.match(hashResults({}), /^fnv1a32:[0-9a-f]{8}:0$/);
});

// --- read/write plan --------------------------------------------------------

test("the competition key is consulted first from the very first stage", () => {
  // Forced by the never-write-legacy rule: new settlements land on the
  // competition key immediately, so it can never be absent from a read.
  assert.deepEqual(resultsReadKeys("inventory", "PL"), ["results:PL", "results"]);
  assert.deepEqual(resultsReadKeys("copy", "PL"), ["results:PL", "results"]);
  assert.deepEqual(resultsReadKeys("verify", "PL"), ["results:PL", "results"]);
  assert.deepEqual(resultsReadKeys("dual-read", "PL"), ["results:PL", "results"]);
  assert.deepEqual(resultsReadKeys("switch", "PL"), ["results:PL", "results"]);
  assert.deepEqual(resultsReadKeys("dual-write", "PL"), ["results:PL", "results"]);
  // After the freeze the legacy key leaves the read path but still exists.
  assert.deepEqual(resultsReadKeys("freeze", "PL"), ["results:PL"]);
});

test("a non-PL competition never reads the legacy key at any stage", () => {
  for (const stage of STAGES) {
    assert.deepEqual(resultsReadKeys(stage, "ELC"), ["results:ELC"], stage);
    assert.deepEqual(resultsReadKeys(stage, "CL"), ["results:CL"], stage);
  }
});

test("a competition-key entry always beats the frozen legacy copy", async () => {
  const store = new Map([
    ["results", JSON.stringify({ "pl-1-a-b": settled(1, 0), "pl-2-c-d": settled(3, 3) })],
    ["results:PL", JSON.stringify({ "pl-1-a-b": settled(2, 2) })],
  ]);
  const env = { KV: memoryKV(store) };
  const merged = await readResults(env, "PL", "switch");
  assert.deepEqual(merged["pl-1-a-b"].result, [2, 2], "newer competition-key entry wins");
  assert.deepEqual(merged["pl-2-c-d"].result, [3, 3], "legacy fills the gap");
  const frozen = await readResults(env, "PL", "freeze");
  assert.deepEqual(Object.keys(frozen), ["pl-1-a-b"], "legacy is out of the read path");
});

test("a foreign id in the legacy key never leaks into another competition", async () => {
  const store = new Map([["results", JSON.stringify({ "elc-1-a-b": settled(1, 0) })]]);
  const env = { KV: memoryKV(store) };
  assert.deepEqual(await readResults(env, "ELC", "switch"), {});
});

// --- stages -----------------------------------------------------------------

function seededEnv() {
  const store = new Map([
    ["results", JSON.stringify({
      "pl-2026-27-001-a-b": settled(2, 1),
      "pl-2026-27-002-c-d": settled(0, 0),
      "elc-2026-27-001-e-f": settled(1, 3),
      "77777": settled(4, 4),
    })],
  ]);
  return { env: { KV: memoryKV(store) }, store };
}

test("inventory reports the legacy key without touching it", async () => {
  const { env, store } = seededEnv();
  const before = store.get("results");
  const { evidence } = await runStage(env, "inventory");
  assert.equal(evidence.legacyEntries, 4);
  assert.deepEqual(evidence.byCompetition, { PL: 2, ELC: 1, CL: 0 });
  assert.deepEqual(evidence.unnamespaced, ["77777"]);
  assert.equal(store.get("results"), before, "inventory is read-only");
  // Uncommitted stages leave the recorded stage alone.
  assert.equal((await readMigration(env)).stage, "inventory");
  assert.equal(store.has(MIGRATION_KEY), false);
});

test("copy writes competition keys and leaves the legacy object byte-identical", async () => {
  const { env, store } = seededEnv();
  const before = store.get("results");
  const { evidence } = await runStage(env, "copy", { commit: true });
  assert.equal(evidence.legacyUntouched, true);
  assert.deepEqual(evidence.copied, { PL: 2, ELC: 1, CL: 0 });
  assert.deepEqual(evidence.skippedUnnamespaced, ["77777"]);
  assert.equal(store.get("results"), before, "legacy is byte-identical after the copy");
  assert.deepEqual(Object.keys(JSON.parse(store.get("results:PL"))).sort(),
    ["pl-2026-27-001-a-b", "pl-2026-27-002-c-d"]);
  assert.deepEqual(Object.keys(JSON.parse(store.get("results:ELC"))), ["elc-2026-27-001-e-f"]);
  assert.equal((await readMigration(env)).stage, "copy");
});

test("verify passes on a clean copy and names any divergence", async () => {
  const { env, store } = seededEnv();
  await runStage(env, "copy", { commit: true });
  let evidence = (await runStage(env, "verify")).evidence;
  assert.equal(evidence.match, true);
  assert.equal(evidence.perCompetition.PL.match, true);
  assert.equal(evidence.perCompetition.PL.expectedHash, evidence.perCompetition.PL.actualScopedHash);

  // Corrupt one score on the target and the verify stage must catch it.
  const corrupted = JSON.parse(store.get("results:PL"));
  corrupted["pl-2026-27-001-a-b"] = settled(9, 9);
  store.set("results:PL", JSON.stringify(corrupted));
  evidence = (await runStage(env, "verify")).evidence;
  assert.equal(evidence.match, false);
  assert.deepEqual(evidence.perCompetition.PL.differences, [
    { id: "pl-2026-27-001-a-b", reason: "score differs", before: [2, 1], after: [9, 9] },
  ]);
});

test("a result settled after the copy does not fail verification", async () => {
  const { env, store } = seededEnv();
  await runStage(env, "copy", { commit: true });
  const live = JSON.parse(store.get("results:PL"));
  live["pl-2026-27-003-new-fixture"] = settled(1, 1);
  store.set("results:PL", JSON.stringify(live));
  const { evidence } = await runStage(env, "verify");
  assert.equal(evidence.match, true, "verification is scoped to what legacy claims");
  assert.equal(evidence.perCompetition.PL.actualEntries, 3);
  assert.equal(evidence.perCompetition.PL.expectedEntries, 2);
});

test("every stage runs on its own and records evidence in order", async () => {
  const { env } = seededEnv();
  for (const stage of STAGES) await runStage(env, stage, { commit: true, now: `2026-07-28T00:00:0${STAGES.indexOf(stage)}Z` });
  const state = await readMigration(env);
  assert.equal(state.stage, "freeze");
  assert.deepEqual(state.history.map((entry) => entry.stage), STAGES);
  assert.ok(state.history.every((entry) => entry.committed && entry.evidence));
  await assert.rejects(() => runStage(env, "teleport"), /unknown migration stage/);
});

test("freeze retains the legacy key and drops it from the read path", async () => {
  const { env, store } = seededEnv();
  const before = store.get("results");
  for (const stage of STAGES) await runStage(env, stage, { commit: true });
  const { evidence } = await runStage(env, "freeze");
  assert.equal(evidence.legacyRetained, true);
  assert.equal(evidence.legacyEntries, 4);
  assert.deepEqual(evidence.readKeys.PL, ["results:PL"]);
  assert.equal(store.get("results"), before, "the legacy key is never deleted or rewritten");
  assert.equal(store.has("results"), true);
});

test("rollback is a read-side move that leaves the legacy key untouched", async () => {
  const { env, store } = seededEnv();
  const before = store.get("results");
  for (const stage of STAGES) await runStage(env, stage, { commit: true });
  const result = await rollback(env, { now: "2026-07-28T01:00:00Z" });
  assert.equal(result.rolledBackFrom, "freeze");
  assert.equal(result.stage, "inventory");
  assert.deepEqual(resultsReadKeys((await readMigration(env)).stage, "PL"), ["results:PL", "results"]);
  assert.equal(store.get("results"), before, "rollback has nothing to undo");
  const history = (await readMigration(env)).history;
  assert.equal(history.at(-1).stage, "rollback");
  assert.equal(history.at(-1).evidence.legacyMutated, false);
});

test("no stage can ever write the legacy key", async () => {
  const { env, store } = seededEnv();
  const guarded = {
    ...env.KV,
    async put(key, value) {
      if (key === "results") throw new Error("attempted write to the legacy results key");
      return memoryKV(store).put(key, value);
    },
    async delete(key) {
      if (key === "results") throw new Error("attempted delete of the legacy results key");
      return store.delete(key);
    },
  };
  const strict = { KV: { ...guarded, get: env.KV.get, list: env.KV.list } };
  for (const stage of STAGES) await runStage(strict, stage, { commit: true });
  await rollback(strict);
  assert.equal(store.has("results"), true);
});

test("diffResults names missing, extra and divergent entries", () => {
  const before = { a: settled(1, 0), b: settled(2, 2), c: settled(0, 1) };
  const after = { a: settled(1, 0), b: settled(2, 3), d: settled(5, 5) };
  const { compared, differences } = diffResults(before, after);
  assert.equal(compared, 4);
  assert.deepEqual(differences.map((d) => [d.id, d.reason]), [
    ["b", "score differs"],
    ["c", "missing from target"],
    ["d", "only in target"],
  ]);
  assert.deepEqual(diffResults({ a: settled(1, 0) }, { a: { ...settled(1, 0), lockAt: "different" } }).differences, [],
    "a re-serialised copy with a different lockAt is still the same result");
});
