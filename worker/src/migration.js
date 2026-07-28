// The results-split migration: one shared `results` object becomes one object
// per competition, without ever putting the original at risk.
//
// The plan is the doc's copy-verify-switch, expressed as seven stages that each
// run on their own and each emit evidence. Nothing here is automatic: a stage
// only advances when it is asked to, and every stage records what it saw so the
// parity gate can be reviewed before the next one runs.
//
// One deliberate departure from the written plan. The doc's bridge period
// dual-WRITES to both the legacy key and the competition key; the build brief
// forbids mutating the legacy key at all. The brief wins, because it is also
// the safer reading: the legacy object stays byte-identical to what it was
// before the migration started, which makes rollback a pure read-side switch
// with nothing to undo. "dual-write" therefore means writes go to the
// competition key while reads still union the legacy one.

import {
  COMPETITION_CODES,
  LEGACY_RESULTS_KEY,
  assertNotLegacyResultsKey,
  competitionOfFixture,
  hashResults,
  resultsKey,
  splitResultsByCompetition,
} from "./competitions.js";

export const MIGRATION_KEY = "migration:results-split";

export const STAGES = [
  "inventory",   // look, touch nothing
  "copy",        // legacy PL entries -> results:PL, original untouched
  "verify",      // per-fixture id/score/status equality, counts and hashes
  "dual-read",   // reads union both, behind the test route only
  "switch",      // reads prefer results:PL, legacy retained as fallback
  "dual-write",  // writes land on the competition key; legacy stays frozen
  "freeze",      // legacy is never read again, and still never deleted
];

export const STAGE_INDEX = Object.fromEntries(STAGES.map((stage, index) => [stage, index]));

const at = (stage) => STAGE_INDEX[stage] ?? -1;

export const isStage = (stage) => at(stage) >= 0;

/**
 * Which keys a read should consult, in precedence order.
 *
 * The competition key is always consulted first, from the very first stage.
 * That is forced by the rule that the legacy key is never written again: as
 * soon as this ships, every new settlement lands on the competition key, so a
 * read that consulted only the legacy object would lose it. The legacy object
 * supplies the history behind those writes until `copy` has duplicated it and
 * `verify` has proved the duplicate faithful — after which `freeze` drops it
 * from the read path entirely, still present but no longer consulted.
 *
 * So there are exactly two behavioural transitions here, `copy` and `freeze`.
 * The other stages are evidence gates, not switches: they exist to be reviewed,
 * not to change what a member sees.
 */
export function resultsReadKeys(stage, competition) {
  const key = resultsKey(competition);
  if (competition !== "PL") return [key];
  return at(stage) < at("freeze") ? [key, LEGACY_RESULTS_KEY] : [key];
}

/** Writes always land on the competition key. The legacy key is never a target. */
export function resultsWriteKey(competition) {
  return assertNotLegacyResultsKey(resultsKey(competition));
}

export async function readMigration(env) {
  return (await env.KV.get(MIGRATION_KEY, "json")) || { stage: "inventory", history: [] };
}

async function writeMigration(env, state) {
  await env.KV.put(MIGRATION_KEY, JSON.stringify(state));
}

const getJson = async (env, key) => (await env.KV.get(key, "json")) || null;

async function putJson(env, key, value) {
  assertNotLegacyResultsKey(key);
  await env.KV.put(key, JSON.stringify(value));
}

/**
 * Per-fixture comparison of two result maps. Compares id, score and status
 * rather than object identity, so a re-serialised copy still counts as equal
 * while any real divergence is named.
 */
export function diffResults(before, after) {
  const ids = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const differences = [];
  for (const id of ids) {
    const left = (before || {})[id];
    const right = (after || {})[id];
    if (!left) { differences.push({ id, reason: "only in target" }); continue; }
    if (!right) { differences.push({ id, reason: "missing from target" }); continue; }
    const score = (value) => JSON.stringify(value?.result ?? null);
    const status = (value) => String(value?.status ?? "");
    if (score(left) !== score(right)) {
      differences.push({ id, reason: "score differs", before: left.result, after: right.result });
    } else if (status(left) !== status(right)) {
      differences.push({ id, reason: "status differs", before: left.status, after: right.status });
    }
  }
  return { compared: ids.length, differences };
}

async function stageInventory(env) {
  const legacy = (await getJson(env, LEGACY_RESULTS_KEY)) || {};
  const { split, unknown } = splitResultsByCompetition(legacy);
  const existing = {};
  for (const code of COMPETITION_CODES) {
    const current = await getJson(env, resultsKey(code));
    if (current) existing[resultsKey(code)] = { entries: Object.keys(current).length, hash: hashResults(current) };
  }
  return {
    legacyKey: LEGACY_RESULTS_KEY,
    legacyEntries: Object.keys(legacy).length,
    legacyHash: hashResults(legacy),
    byCompetition: Object.fromEntries(
      COMPETITION_CODES.map((code) => [code, Object.keys(split[code]).length])
    ),
    unnamespaced: Object.keys(unknown),
    existingCompetitionKeys: existing,
  };
}

async function stageCopy(env) {
  const legacy = (await getJson(env, LEGACY_RESULTS_KEY)) || {};
  const legacyHashBefore = hashResults(legacy);
  const { split, unknown } = splitResultsByCompetition(legacy);
  const written = {};
  for (const code of COMPETITION_CODES) {
    const entries = split[code];
    if (!Object.keys(entries).length) continue;
    const existing = (await getJson(env, resultsKey(code))) || {};
    // Additive: an entry already on the competition key is left as-is, because
    // it is by definition newer than the frozen legacy copy.
    const merged = { ...entries, ...existing };
    await putJson(env, resultsKey(code), merged);
    written[resultsKey(code)] = { entries: Object.keys(merged).length, hash: hashResults(merged) };
  }
  const legacyAfter = (await getJson(env, LEGACY_RESULTS_KEY)) || {};
  return {
    copied: Object.fromEntries(COMPETITION_CODES.map((code) => [code, Object.keys(split[code]).length])),
    skippedUnnamespaced: Object.keys(unknown),
    written,
    legacyUntouched: hashResults(legacyAfter) === legacyHashBefore,
    legacyHash: legacyHashBefore,
  };
}

async function stageVerify(env) {
  const legacy = (await getJson(env, LEGACY_RESULTS_KEY)) || {};
  const { split, unknown } = splitResultsByCompetition(legacy);
  const perCompetition = {};
  let clean = true;
  for (const code of COMPETITION_CODES) {
    const expected = split[code];
    if (!Object.keys(expected).length) continue;
    const actual = (await getJson(env, resultsKey(code))) || {};
    // Compare only what the legacy key claims; anything settled since the copy
    // legitimately exists on the competition key and not in the frozen source.
    const scoped = Object.fromEntries(Object.keys(expected).map((id) => [id, actual[id]]));
    const diff = diffResults(expected, scoped);
    perCompetition[code] = {
      expectedEntries: Object.keys(expected).length,
      actualEntries: Object.keys(actual).length,
      expectedHash: hashResults(expected),
      actualScopedHash: hashResults(scoped),
      compared: diff.compared,
      differences: diff.differences,
      match: diff.differences.length === 0 && hashResults(expected) === hashResults(scoped),
    };
    if (!perCompetition[code].match) clean = false;
  }
  return { perCompetition, unnamespaced: Object.keys(unknown), match: clean };
}

async function stageReadOnlyCheck(env, stage) {
  const evidence = {};
  for (const code of COMPETITION_CODES) {
    evidence[code] = resultsReadKeys(stage, code);
  }
  return { readKeys: evidence, writeKeys: Object.fromEntries(COMPETITION_CODES.map((code) => [code, resultsWriteKey(code)])) };
}

async function stageFreeze(env) {
  const legacy = (await getJson(env, LEGACY_RESULTS_KEY)) || {};
  return {
    legacyRetained: true,
    legacyEntries: Object.keys(legacy).length,
    legacyHash: hashResults(legacy),
    readKeys: Object.fromEntries(COMPETITION_CODES.map((code) => [code, resultsReadKeys("freeze", code)])),
    note: "legacy key is out of the read path and still present; it is never deleted",
  };
}

const RUNNERS = {
  inventory: stageInventory,
  copy: stageCopy,
  verify: stageVerify,
  "dual-read": (env) => stageReadOnlyCheck(env, "dual-read"),
  switch: (env) => stageReadOnlyCheck(env, "switch"),
  "dual-write": (env) => stageReadOnlyCheck(env, "dual-write"),
  freeze: stageFreeze,
};

/**
 * Runs one stage and records its evidence.
 *
 * `commit: false` (the default for the read-only stages) runs the checks and
 * reports without advancing the recorded stage, so a stage can be rehearsed as
 * often as needed before anything changes behaviour.
 */
export async function runStage(env, stage, { commit = false, now = null } = {}) {
  if (!isStage(stage)) throw new Error(`unknown migration stage: ${stage}`);
  const state = await readMigration(env);
  const evidence = await RUNNERS[stage](env);
  const entry = {
    stage,
    at: now || new Date().toISOString(),
    committed: !!commit,
    evidence,
  };
  if (commit) {
    state.stage = stage;
    state.history = [...(state.history || []), entry];
    await writeMigration(env, state);
  }
  return { stage, committed: !!commit, previousStage: state.stage, evidence };
}

/** Rollback is a read-side move: point reads back at the untouched legacy key. */
export async function rollback(env, { now = null } = {}) {
  const state = await readMigration(env);
  const from = state.stage;
  state.stage = "inventory";
  state.history = [...(state.history || []), {
    stage: "rollback",
    at: now || new Date().toISOString(),
    committed: true,
    evidence: { from, to: "inventory", legacyMutated: false },
  }];
  await writeMigration(env, state);
  return { rolledBackFrom: from, stage: state.stage };
}

/**
 * Reads the effective results map for one competition at the current stage.
 * Later keys in the read plan only fill gaps, so a competition-key entry always
 * beats the frozen legacy copy of the same fixture.
 */
export async function readResults(env, competition, stage) {
  const keys = resultsReadKeys(stage, competition);
  const merged = {};
  for (const key of [...keys].reverse()) {
    const value = (await env.KV.get(key, "json")) || {};
    for (const [fixtureId, entry] of Object.entries(value)) {
      // The legacy key is Premier League only; never let it leak into another
      // competition's view even if it somehow holds a foreign id.
      if (key === LEGACY_RESULTS_KEY && competitionOfFixture(fixtureId) !== competition) continue;
      merged[fixtureId] = entry;
    }
  }
  return merged;
}
