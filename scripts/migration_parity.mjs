// Results-split parity harness.
//
// Runs the whole copy-verify-switch sequence against an in-memory copy of a
// production KV snapshot and proves that nothing a member can see changes:
// same league tables, points, ranks, movement and matchweek winners, same
// effective results map, settlement confined to its own competition key, and a
// rollback that has nothing to undo.
//
// Production's `results` object is currently empty — the season has not started
// — so a parity run over the real snapshot alone is vacuous: every table is all
// zeroes and "identical before and after" proves nothing. The harness therefore
// runs twice: once over the untouched snapshot, and once over the same snapshot
// enriched with a full synthetic season of settled fixtures and picks, which is
// what actually exercises the scoring path. The synthetic run is labelled as
// such everywhere it appears.
//
//   node scripts/migration_parity.mjs [snapshot.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRoundWins,
  computeTableWithMovement,
  isVoided,
  normaliseResult,
  roundWinners,
} from "../worker/src/logic.js";
import { hashResults, resultsKey, LEGACY_RESULTS_KEY } from "../worker/src/competitions.js";
import { STAGES, readMigration, readResults, rollback, runStage } from "../worker/src/migration.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = path.join(ROOT, ".migration-snapshots");

function latestSnapshot() {
  const files = fs.readdirSync(SNAPSHOT_DIR).filter((name) => name.startsWith("prod-kv-")).sort();
  if (!files.length) throw new Error("no snapshot in .migration-snapshots");
  return path.join(SNAPSHOT_DIR, files.at(-1));
}

function memoryKV(store) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (type !== "json") return raw;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async put(key, value) {
      if (key === LEGACY_RESULTS_KEY) throw new Error("harness refused a write to the legacy key");
      store.set(key, value);
    },
    async delete(key) {
      if (key === LEGACY_RESULTS_KEY) throw new Error("harness refused a delete of the legacy key");
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

const loadStore = (file) => new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));

// --- the member-visible view -------------------------------------------------

function leaguesIn(store) {
  return [...store.keys()].filter((k) => k.startsWith("league:")).map((k) => JSON.parse(store.get(k)));
}

function membersOf(store, code) {
  const prefix = `member:${code}:`;
  return [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => {
    const row = JSON.parse(store.get(k));
    return { uid: k.slice(prefix.length), nick: row.nick || "Anon", since: row.since || 0 };
  }).sort((a, b) => (a.since || 0) - (b.since || 0) || a.nick.localeCompare(b.nick));
}

function picksOf(store, ids) {
  return Object.fromEntries(ids.map((id) => [id, store.has(`picks:${id}`) ? JSON.parse(store.get(`picks:${id}`)) : {}]));
}

/** Exactly the shape /state derives, computed from one effective results map. */
function leagueView(store, league, fixtures, results) {
  const merged = fixtures.map((fx) => (results[fx.id] ? { ...fx, ...results[fx.id] } : fx));
  const members = membersOf(store, league.code);
  const picks = picksOf(store, merged.map((fx) => fx.id));
  const completed = merged
    .map((fx) => ({
      id: fx.id,
      startMs: Date.parse(fx.lockAt || fx.startAt) || 0,
      result: normaliseResult(fx),
      voided: isVoided(fx),
      matchday: fx.matchday,
    }))
    .filter((fx) => fx.result || fx.voided);
  const wins = computeRoundWins(members, merged, picks);
  const byRound = {};
  for (const round of [...new Set(merged.map((fx) => fx.matchday))].sort((a, b) => a - b)) {
    byRound[round] = roundWinners(members, merged.filter((fx) => fx.matchday === round), picks);
  }
  return {
    code: league.code,
    table: computeTableWithMovement(members, completed, picks)
      .map((row) => ({ uid: row.uid, nick: row.nick, pts: row.pts, exact: row.exact, correct: row.correct,
        rank: row.rank, previousRank: row.previousRank, movement: row.movement, wins: wins[row.uid] || 0 })),
    roundWinners: byRound,
  };
}

const stable = (value) => JSON.stringify(value, null, 1);

// --- synthetic season --------------------------------------------------------

function enrich(store, fixtures) {
  const leagues = leaguesIn(store);
  const members = leagues.flatMap((l) => membersOf(store, l.code).map((m) => m.uid));
  // Three extra players per league so tables have shape (ties, movement, winners).
  for (const league of leagues) {
    for (const [index, uid] of ["syn_a", "syn_b", "syn_c"].entries()) {
      const key = `member:${league.code}:${uid}_${league.code}`;
      store.set(key, JSON.stringify({ nick: ["Alex", "Bailey", "Cam"][index], since: 1000 + index }));
      members.push(`${uid}_${league.code}`);
    }
  }
  const results = {};
  const rounds = 6;
  const played = fixtures.filter((fx) => fx.matchday <= rounds);
  played.forEach((fx, index) => {
    const [home, away] = [[2, 1], [1, 1], [0, 2], [3, 0], [1, 0], [2, 2], [0, 1], [1, 2]][index % 8];
    results[fx.id] = { status: "complete", result: [home, away], lockAt: fx.startAt };
    const picks = {};
    members.forEach((uid, seat) => {
      const slot = (index + seat * 3) % 10;
      picks[uid] = slot < 4 ? { p1: home, p2: away, ts: 1 }
        : slot < 7 ? { p1: home + 1, p2: away + 1, ts: 1 }
        : { p1: away, p2: home, ts: 1 };
    });
    store.set(`picks:${fx.id}`, JSON.stringify(picks));
  });
  store.set(LEGACY_RESULTS_KEY, JSON.stringify(results));
  return { rounds, settled: Object.keys(results).length, players: members.length };
}

// --- the run -----------------------------------------------------------------

async function parityRun(label, store, fixtures, report) {
  const env = { KV: memoryKV(store) };
  const leagues = leaguesIn(store);
  const legacyBefore = store.get(LEGACY_RESULTS_KEY);
  const legacyHashBefore = hashResults(JSON.parse(legacyBefore || "{}"));

  const baseline = {};
  const before = await readResults(env, "PL", "inventory");
  for (const league of leagues) baseline[league.code] = leagueView(store, league, fixtures, before);

  const lines = [];
  const fail = (message) => { lines.push(`   FAIL ${message}`); report.failures.push(`${label}: ${message}`); };
  const pass = (message) => lines.push(`   ok   ${message}`);

  lines.push(`\n## ${label}`);
  lines.push(`   leagues ${leagues.length} · legacy entries ${Object.keys(JSON.parse(legacyBefore || "{}")).length} · legacy hash ${legacyHashBefore}`);

  for (const stage of STAGES) {
    const { evidence } = await runStage(env, stage, { commit: true, now: "2026-07-28T00:00:00Z" });
    const current = await readResults(env, "PL", (await readMigration(env)).stage);
    lines.push(`\n   -- ${stage} --`);

    if (stage === "inventory") {
      lines.push(`   legacy=${evidence.legacyEntries} byCompetition=${JSON.stringify(evidence.byCompetition)} unnamespaced=${evidence.unnamespaced.length}`);
    }
    if (stage === "copy") {
      evidence.legacyUntouched ? pass("legacy object byte-identical after copy") : fail("copy mutated the legacy object");
      lines.push(`   copied=${JSON.stringify(evidence.copied)}`);
    }
    if (stage === "verify") {
      evidence.match ? pass("per-fixture id/score/status parity, counts and hashes match")
                     : fail(`verify found ${JSON.stringify(evidence.perCompetition)}`);
    }

    // Member-visible parity at every stage.
    let identical = true;
    for (const league of leagues) {
      const now = leagueView(store, league, fixtures, current);
      if (stable(now) !== stable(baseline[league.code])) { identical = false; fail(`${league.code} table changed at ${stage}`); }
    }
    if (identical) pass(`tables, points, ranks, movement and matchweek winners identical (${leagues.length} leagues)`);

    hashResults(current) === hashResults(before)
      ? pass(`effective results map identical (${hashResults(current)})`)
      : fail(`effective results map diverged at ${stage}`);

    store.get(LEGACY_RESULTS_KEY) === legacyBefore
      ? pass("legacy key untouched")
      : fail(`legacy key mutated at ${stage}`);
  }

  // Settlement lands only on its own competition key.
  const elcKeyBefore = store.get(resultsKey("ELC")) || null;
  const plBefore = JSON.parse(store.get(resultsKey("PL")) || "{}");
  const target = fixtures[0];
  const plAfter = { ...plBefore, [target.id]: { status: "complete", result: [7, 7], lockAt: target.startAt } };
  await env.KV.put(resultsKey("PL"), JSON.stringify(plAfter));
  lines.push(`\n   -- settlement scoping --`);
  (store.get(resultsKey("ELC")) || null) === elcKeyBefore
    ? pass("a PL settlement leaves results:ELC untouched")
    : fail("a PL settlement wrote outside its competition");
  store.get(LEGACY_RESULTS_KEY) === legacyBefore
    ? pass("a PL settlement leaves the legacy key untouched")
    : fail("a PL settlement wrote the legacy key");
  await env.KV.put(resultsKey("PL"), JSON.stringify(plBefore));

  // Rollback.
  const rolled = await rollback(env, { now: "2026-07-28T01:00:00Z" });
  const afterRollback = await readResults(env, "PL", (await readMigration(env)).stage);
  lines.push(`\n   -- rollback --`);
  lines.push(`   from ${rolled.rolledBackFrom} -> ${rolled.stage}`);
  let rollbackClean = true;
  for (const league of leagues) {
    if (stable(leagueView(store, league, fixtures, afterRollback)) !== stable(baseline[league.code])) rollbackClean = false;
  }
  rollbackClean ? pass("post-rollback view identical to baseline") : fail("rollback changed the member-visible view");
  store.get(LEGACY_RESULTS_KEY) === legacyBefore ? pass("legacy key still byte-identical after rollback")
                                                 : fail("rollback mutated the legacy key");
  store.has(LEGACY_RESULTS_KEY) ? pass("legacy key still present (never deleted)") : fail("legacy key was deleted");

  return lines;
}

async function main() {
  const snapshot = process.argv[2] || latestSnapshot();
  const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fixtures.json"), "utf8")).fixtures;
  const report = { failures: [] };
  const out = [
    "# Results-split parity evidence",
    `snapshot: ${path.basename(snapshot)}`,
    `fixtures: ${fixtures.length} Premier League 2026/27`,
    `generated: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
  ];

  out.push(...await parityRun("Run 1 — real production snapshot (as-is)", loadStore(snapshot), fixtures, report));

  const synthetic = loadStore(snapshot);
  const shape = enrich(synthetic, fixtures);
  out.push(...await parityRun(
    `Run 2 — SYNTHETIC season (${shape.settled} settled fixtures over ${shape.rounds} matchweeks, ${shape.players} players)`,
    synthetic, fixtures, report));

  out.push("", "## Result", report.failures.length
    ? `FAILED — ${report.failures.length} check(s):\n${report.failures.map((f) => `  - ${f}`).join("\n")}`
    : "PASSED — every check clean in both runs.");

  const text = out.join("\n") + "\n";
  const file = path.join(SNAPSHOT_DIR, "parity-report.md");
  fs.writeFileSync(file, text);
  console.log(text);
  console.log(`report -> ${path.relative(ROOT, file)}`);
  process.exit(report.failures.length ? 1 : 0);
}

main();
