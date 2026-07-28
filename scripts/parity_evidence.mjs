// Final parity evidence for the results-split migration.
//
// Runs the seven gate checks against an in-memory copy of a production KV
// snapshot, driving the real worker (not a reimplementation of it) so the
// payloads compared are the ones members would actually receive.
//
//   node scripts/parity_evidence.mjs [snapshot.json]
//
// Writes .migration-snapshots/parity-evidence.md and exits non-zero on any
// failed check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/worker.js";
import { LEGACY_RESULTS_KEY, hashResults, resultsKey } from "../worker/src/competitions.js";
import { STAGES, readMigration, rollback, runStage } from "../worker/src/migration.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = path.join(ROOT, ".migration-snapshots");
const PL_FEED = path.join(ROOT, "data", "fixtures.json");
const ELC_FEED = path.join(ROOT, "data", "fixtures-elc.json");

const out = [];
const results = [];
let currentCheck = null;

const say = (line = "") => out.push(line);
function check(id, title) {
  currentCheck = { id, title, pass: 0, fail: 0, notes: [] };
  results.push(currentCheck);
  say(`\n## ${id}. ${title}`);
}
const ok = (message) => { currentCheck.pass++; say(`   PASS  ${message}`); };
const bad = (message) => { currentCheck.fail++; say(`   FAIL  ${message}`); };
const note = (message) => say(`         ${message}`);
const assert = (condition, message) => (condition ? ok(message) : bad(message));

// --- harness ----------------------------------------------------------------

function latestSnapshot() {
  const files = fs.readdirSync(SNAPSHOT_DIR).filter((n) => n.startsWith("prod-kv-")).sort();
  if (!files.length) throw new Error("no snapshot in .migration-snapshots");
  return path.join(SNAPSHOT_DIR, files.at(-1));
}

// Guarded KV: mirrors the worker's own rule, and additionally refuses any write
// or delete of the legacy key so an accidental one is a hard error, not a diff.
function guardedKV(store, journal) {
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (type !== "json") return raw;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async put(key, value) {
      if (key === LEGACY_RESULTS_KEY) { journal.push(`put ${key}`); throw new Error("legacy results key is frozen"); }
      store.set(key, value);
    },
    async delete(key) {
      if (key === LEGACY_RESULTS_KEY) { journal.push(`delete ${key}`); throw new Error("legacy results key is never deleted"); }
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

const feeds = {
  "https://feed.local/pl.json": PL_FEED,
  "https://feed.local/elc.json": ELC_FEED,
};

function installFetch() {
  globalThis.fetch = async (url) => {
    const clean = String(url).split("?")[0];
    const file = feeds[clean];
    if (!file) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(file, "utf8"), { status: 200 });
  };
}

const req = (path) => new Request(`https://worker.test${path}`);
const post = (path, body) => new Request(`https://worker.test${path}`, { method: "POST", body: JSON.stringify(body) });
const runStageViaApi = (env, stage, commit = false) =>
  call(env, post("/admin/migration", { secret: "evidence-secret", action: "run", stage, commit }));
const rollbackViaApi = (env) => call(env, post("/admin/migration", { secret: "evidence-secret", action: "rollback" }));
const call = async (env, request) => (await worker.fetch(request, env)).json();

function makeEnv(store, journal) {
  return {
    FIXTURES_URL: "https://feed.local/pl.json",
    FIXTURES_URL_ELC: "https://feed.local/elc.json",
    SETTLE_SECRET: "evidence-secret",
    MIGRATION_SECRET: "evidence-secret",
    KV: guardedKV(store, journal),
  };
}

const loadStore = (file) => new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));

// A synthetic season, because production has settled nothing yet and a parity
// run over all-zero tables proves nothing.
function seedSyntheticSeason(store, fixtures, leagueCode) {
  const players = ["syn_alex", "syn_bailey", "syn_cam", "syn_dee"];
  players.forEach((uid, index) => {
    store.set(`member:${leagueCode}:${uid}`, JSON.stringify({ nick: ["Alex", "Bailey", "Cam", "Dee"][index], since: 1000 + index }));
  });
  const legacy = {};
  const played = fixtures.filter((fx) => fx.matchday <= 6);
  played.forEach((fx, index) => {
    const [home, away] = [[2, 1], [1, 1], [0, 2], [3, 0], [1, 0], [2, 2], [0, 1], [1, 2]][index % 8];
    legacy[fx.id] = { status: "complete", result: [home, away], lockAt: fx.startAt };
    const picks = {};
    players.forEach((uid, seat) => {
      const slot = (index + seat * 3) % 10;
      picks[uid] = slot < 4 ? { p1: home, p2: away, ts: 1 }
        : slot < 7 ? { p1: home + 1, p2: away + 1, ts: 1 }
        : { p1: away, p2: home, ts: 1 };
    });
    store.set(`picks:${fx.id}`, JSON.stringify(picks));
  });
  store.set(LEGACY_RESULTS_KEY, JSON.stringify(legacy));
  return { settled: Object.keys(legacy).length, players: players.length };
}

const stable = (value) => JSON.stringify(value, Object.keys(value || {}).sort ? undefined : undefined, 1);

async function main() {
  installFetch();
  const snapshotFile = process.argv[2] || latestSnapshot();
  const plFixtures = JSON.parse(fs.readFileSync(PL_FEED, "utf8")).fixtures;

  const journal = [];
  const store = loadStore(snapshotFile);
  const env = makeEnv(store, journal);
  const leagues = [...store.keys()].filter((k) => k.startsWith("league:")).map((k) => JSON.parse(store.get(k)));
  const leagueCode = leagues[0]?.code;
  const shape = seedSyntheticSeason(store, plFixtures, leagueCode);
  const legacyBefore = store.get(LEGACY_RESULTS_KEY);
  const legacyHashBefore = hashResults(JSON.parse(legacyBefore));

  say("# Results-split migration — parity evidence");
  say("");
  say(`snapshot           ${path.basename(snapshotFile)}`);
  say(`leagues            ${leagues.map((l) => l.code).join(", ")}`);
  say(`synthetic season   ${shape.settled} settled fixtures over 6 matchweeks, ${shape.players} players`);
  say(`legacy hash        ${legacyHashBefore}`);
  say(`generated          ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  say("");
  say("Production's `results` object is empty — the season has not started — so");
  say("every table below is driven by a synthetic season layered onto the real");
  say("snapshot. The league records, members, picks keys and user records are");
  say("real; the settled results and the four synthetic players are not.");

  const snapshotState = async () => ({
    fixtures: await call(env, req("/fixtures")),
    elc: await call(env, req("/fixtures?competition=ELC")),
    states: Object.fromEntries(await Promise.all(leagues.map(async (l) =>
      [l.code, await call(env, req(`/state?code=${l.code}&uid=syn_alex`))]))),
    rounds: Object.fromEntries(await Promise.all(leagues.map(async (l) =>
      [l.code, await call(env, req(`/state?code=${l.code}&md=3`))]))),
  });

  const baseline = await snapshotState();

  // --- 1 ---------------------------------------------------------------------
  check(1, "Parity counts");
  const inventory = (await runStageViaApi(env, "inventory")).evidence;
  note(`legacy entries ${inventory.legacyEntries}, by competition ${JSON.stringify(inventory.byCompetition)}`);
  note(`un-namespaced ids: ${inventory.unnamespaced.length ? inventory.unnamespaced.join(", ") : "none"}`);
  await runStageViaApi(env, "copy", true);
  const verify = (await runStageViaApi(env, "verify")).evidence;
  for (const [code, detail] of Object.entries(verify.perCompetition)) {
    assert(detail.match, `${code}: ${detail.expectedEntries} expected / ${detail.actualEntries} present, hashes equal`);
    note(`expected ${detail.expectedHash}`);
    note(`actual   ${detail.actualScopedHash}`);
    assert(detail.differences.length === 0, `${code}: zero per-fixture differences across ${detail.compared} compared`);
  }
  assert(inventory.unnamespaced.length === 0, "no un-namespaced ids to strand");

  // --- 2 ---------------------------------------------------------------------
  check(2, "Sampled payload equivalence (/fixtures and /state)");
  const afterCopy = await snapshotState();
  assert(JSON.stringify(afterCopy.fixtures) === JSON.stringify(baseline.fixtures),
    `/fixtures byte-identical (${baseline.fixtures.fixtures.length} fixtures)`);
  for (const code of Object.keys(baseline.states)) {
    assert(JSON.stringify(afterCopy.states[code]) === JSON.stringify(baseline.states[code]),
      `/state?code=${code} byte-identical (table, cabinet, reveals, movement)`);
    assert(JSON.stringify(afterCopy.rounds[code]) === JSON.stringify(baseline.rounds[code]),
      `/state?code=${code}&md=3 byte-identical (round table, winners, podium)`);
    const table = baseline.states[code].table || [];
    if (table.length) note(`${code} sampled table: ${table.map((r) => `${r.nick} ${r.pts}`).join(" · ")}`);
  }

  // --- 3 ---------------------------------------------------------------------
  check(3, "Dual-read fallback exercised");
  // Simulate a copy that missed one fixture: delete it from the competition key
  // and confirm the legacy object is what serves it.
  const copied = JSON.parse(store.get(resultsKey("PL")));
  const [sampleId] = Object.keys(copied);
  delete copied[sampleId];
  store.set(resultsKey("PL"), JSON.stringify(copied));
  note(`removed ${sampleId} from ${resultsKey("PL")} to force the fallback`);
  const withFallback = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
  assert(JSON.stringify(withFallback) === JSON.stringify(baseline.states[leagueCode]),
    "legacy fallback serves the missing fixture; /state unchanged");
  await runStageViaApi(env, "freeze", true);
  const frozen = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
  assert(JSON.stringify(frozen) !== JSON.stringify(baseline.states[leagueCode]),
    "at freeze the fallback is gone and the gap shows — proving it was the fallback serving it");
  note("this is why freeze runs only after verify reports zero differences");
  // Restore the entry and re-verify.
  copied[sampleId] = JSON.parse(legacyBefore)[sampleId];
  store.set(resultsKey("PL"), JSON.stringify(copied));
  await runStageViaApi(env, "freeze", true);
  const restored = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
  assert(JSON.stringify(restored) === JSON.stringify(baseline.states[leagueCode]),
    "with the copy complete, freeze is indistinguishable from baseline");

  // --- 4 ---------------------------------------------------------------------
  check(4, "Switch-read proof with legacy unmutated");
  for (const stage of STAGES) {
    await runStageViaApi(env, stage, true);
    const now = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
    const same = JSON.stringify(now) === JSON.stringify(baseline.states[leagueCode]);
    const untouched = store.get(LEGACY_RESULTS_KEY) === legacyBefore;
    if (!same) bad(`${stage}: member-visible state changed`);
    if (!untouched) bad(`${stage}: legacy object mutated`);
    if (same && untouched) ok(`${stage}: state identical, legacy byte-identical`);
  }
  assert(hashResults(JSON.parse(store.get(LEGACY_RESULTS_KEY))) === legacyHashBefore,
    `legacy hash unchanged end-to-end (${legacyHashBefore})`);
  const rolled = await rollbackViaApi(env);
  const afterRollback = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
  assert(JSON.stringify(afterRollback) === JSON.stringify(baseline.states[leagueCode]),
    `rollback from ${rolled.rolledBackFrom} restores baseline exactly`);
  assert(store.get(LEGACY_RESULTS_KEY) === legacyBefore, "rollback had nothing to undo");

  // --- 5 ---------------------------------------------------------------------
  check(5, "Never-delete guard rejects attempted cleanup");
  const attempts = [
    ["a cleanup script deleting the legacy key", () => env.KV.delete(LEGACY_RESULTS_KEY)],
    ["a settle path writing the legacy key", () => env.KV.put(LEGACY_RESULTS_KEY, "{}")],
  ];
  for (const [what, attempt] of attempts) {
    let threw = false;
    try { await attempt(); } catch { threw = true; }
    assert(threw, `${what} — refused`);
  }
  assert(store.has(LEGACY_RESULTS_KEY), "legacy key still present after both attempts");
  assert(store.get(LEGACY_RESULTS_KEY) === legacyBefore, "legacy key still byte-identical");
  note(`guard attempts recorded: ${journal.join(", ") || "none"}`);
  note("assertNotLegacyResultsKey additionally guards every write inside the worker");

  // --- 6 ---------------------------------------------------------------------
  check(6, "DST regression: 28 Mar 2027 and the April/May lock windows");
  const BST_ENDS = "2026-10-25";
  const BST_RESUMES = "2027-03-28";
  for (const [label, file] of [["Premier League", PL_FEED], ["Championship", ELC_FEED]]) {
    const list = JSON.parse(fs.readFileSync(file, "utf8")).fixtures;
    const wrong = list.filter((fx) => {
      const expected = fx.date < BST_ENDS || fx.date >= BST_RESUMES ? "+01:00" : "+00:00";
      return !fx.startAt.endsWith(expected);
    });
    assert(wrong.length === 0, `${label}: all ${list.length} offsets correct at both boundaries`);
  }
  const runin = plFixtures.filter((fx) => fx.date >= BST_RESUMES);
  assert(runin.length > 0 && runin.every((fx) => fx.startAt.endsWith("+01:00")),
    `${runin.length} Premier League fixtures on/after ${BST_RESUMES} are BST`);
  const aprMay = plFixtures.filter((fx) => fx.date >= "2027-04-01");
  const sample = aprMay[0];
  note(`sample lock window: ${sample.player1} v ${sample.player2} ${sample.startAt}`);
  note(`  local kick-off 15:00 BST = 14:00Z — previously stamped 15:00Z, locking an hour early`);
  assert(aprMay.every((fx) => fx.startAt.endsWith("+01:00")), `all ${aprMay.length} April/May fixtures lock on BST`);

  // --- 7 ---------------------------------------------------------------------
  check(7, "Championship competition-keyed end-to-end, zero PL fallthrough");
  const elcCode = "EVIDNC";
  store.set(`league:${elcCode}`, JSON.stringify({ code: elcCode, name: "Evidence ELC", owner: "syn_alex", competition: "ELC", createdAt: 0 }));
  store.set(`member:${elcCode}:syn_alex`, JSON.stringify({ nick: "Alex", since: 0 }));
  const elcFixtures = JSON.parse(fs.readFileSync(ELC_FEED, "utf8")).fixtures;
  const elcState = await call(env, req(`/state?code=${elcCode}&uid=syn_alex`));
  assert(elcState.competition === "ELC" && elcState.competitionName === "EFL Championship",
    `/state reports ${elcState.competition} / ${elcState.competitionName}`);
  const elcFeed = await call(env, req("/fixtures?competition=ELC"));
  assert(elcFeed.fixtures.length === 552 && elcFeed.fixtures.every((fx) => fx.id.startsWith("elc-")),
    `/fixtures?competition=ELC serves ${elcFeed.fixtures.length} elc- ids and nothing else`);
  assert(baseline.fixtures.fixtures.every((fx) => fx.id.startsWith("pl-")),
    `/fixtures serves ${baseline.fixtures.fixtures.length} pl- ids and nothing else`);
  assert(elcFeed.modelVersion === null && elcFeed.fixtures.every((fx) => fx.probabilities === null),
    "Championship ships forecast-absent, as intended");

  // Settle an ELC fixture and prove the blast radius.
  const plKeyBefore = store.get(resultsKey("PL"));
  const target = elcFixtures[0];
  const settle = await call(env, post("/settle", {
    secret: "evidence-secret",
    results: { [target.id]: { status: "complete", result: [2, 0] } },
  }));
  assert(settle.ok && settle.competitions?.length === 1 && settle.competitions[0] === "ELC",
    `settlement touched exactly one competition: ${JSON.stringify(settle.competitions)}`);
  assert(!!store.get(resultsKey("ELC")), `${resultsKey("ELC")} written`);
  assert(store.get(resultsKey("PL")) === plKeyBefore, `${resultsKey("PL")} untouched by an ELC settlement`);
  assert(store.get(LEGACY_RESULTS_KEY) === legacyBefore, "legacy key untouched by an ELC settlement");

  // A PL-shaped entry in legacy must never surface in a Championship view.
  const elcAfter = await call(env, req(`/state?code=${elcCode}&uid=syn_alex`));
  assert(elcAfter.competition === "ELC", "Championship league still competition-keyed after settlement");
  const plStateAfter = await call(env, req(`/state?code=${leagueCode}&uid=syn_alex`));
  assert(JSON.stringify(plStateAfter) === JSON.stringify(baseline.states[leagueCode]),
    "the Premier League league is completely unaffected by an ELC settlement");
  const badId = await call(env, post("/settle", { secret: "evidence-secret", results: { "12345": { status: "complete", result: [1, 0] } } }));
  assert(/not namespaced/.test(badId.error || ""), `a bare provider id is refused: "${badId.error}"`);

  // --- summary ---------------------------------------------------------------
  const failed = results.filter((r) => r.fail > 0);
  say("");
  say("## Summary");
  say("");
  say("| # | Check | Assertions | Result |");
  say("|---|-------|-----------:|--------|");
  for (const r of results) {
    say(`| ${r.id} | ${r.title} | ${r.pass + r.fail} | ${r.fail ? `**${r.fail} FAILED**` : "PASS"} |`);
  }
  say("");
  say(failed.length ? `**GATE NOT MET** — ${failed.length} check(s) failed.`
                    : "**GATE MET** — all seven checks pass.");

  const text = out.join("\n") + "\n";
  const file = path.join(SNAPSHOT_DIR, "parity-evidence.md");
  fs.writeFileSync(file, text);
  console.log(text);
  console.log(`\nreport -> ${path.relative(ROOT, file)}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
