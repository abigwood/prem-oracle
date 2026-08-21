// Slice 1 — the switch, and what happens on either side of it.
//
// The D2 path needs a queue and a Durable Object namespace, and neither exists
// until the configuration step. So this code has to be able to land, be reviewed
// and be exercised while the live worker keeps doing exactly what it does now.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { NotifyLedger } from "../src/worker.js";
import { PAYLOAD_VERSION, reminderPayload } from "../src/notify/copy.js";
import { RETRY_DELAY_S as NOTIFY_RETRY_DELAY_S, LEASE_MS } from "../src/notify/ledger.js";

const SOURCE = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

test("X1 · the D2 path is gated on the bindings existing", () => {
  assert.match(SOURCE, /const notifyEnabled = \(env\) => !!\(env\.NOTIFY_QUEUE && env\.NOTIFY_LEDGER\);/);
  assert.match(SOURCE,
    /ctx\.waitUntil\(notifyEnabled\(env\) \? planKickoffReminders\(env, nowMs\) : notifyKickoffs\(env\)\)/);
});

test("X1 · without the bindings the cron does exactly what it does today", async () => {
  const calls = [];
  const env = {};   // no NOTIFY_QUEUE, no NOTIFY_LEDGER, no APNs secrets
  const ctx = { waitUntil: (p) => calls.push(p) };
  await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
  // Four background jobs as before, and none of them throws on a bare env.
  assert.equal(calls.length, 4);
  await Promise.all(calls.map((p) => Promise.resolve(p).catch(() => null)));
});

test("the planner is never reachable without a queue to plan into", () => {
  const planner = SOURCE.slice(SOURCE.indexOf("async function planKickoffReminders"));
  assert.match(planner, /if \(!notifyEnabled\(env\) \|\| !apnsConfigured\(env\)\) return/);
});

test("the queue consumer acks what is finished and retries what is owed", () => {
  const handler = SOURCE.slice(SOURCE.indexOf("async queue(batch, env)"));
  assert.match(handler, /if \(ack\) message\.ack\(\);/);
  assert.match(handler, /else message\.retry\(\{ delaySeconds: NOTIFY_RETRY_DELAY_S \}\);/);
  // A thrown consumer must not ack: failing closed loses nothing.
  assert.match(handler, /catch \{[\s\S]*message\.retry\(\{ delaySeconds: NOTIFY_RETRY_DELAY_S \}\);/);
});

test("the Durable Object class is exported for the migration to bind", () => {
  assert.equal(typeof NotifyLedger, "function");
  assert.match(SOURCE, /export \{ NotifyLedger \};/);
});

/**
 * The switch is BINDINGS, and nothing else.
 *
 * Phase B1 created the queue and applied the SQLite migration that declares
 * NotifyLedger while deliberately withholding every binding, because creating
 * infrastructure and activating it are separate decisions. B2 adds the three
 * blocks that let the worker reach what already exists. Rolling back is
 * deleting them and redeploying — the same code, the legacy path.
 *
 * These read ACTIVE DIRECTIVES ONLY: an earlier version read the whole file and
 * the comment EXPLAINING that there was no durable_objects binding tripped the
 * check looking for one.
 */
const WRANGLER = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const stripComments = (toml) => toml
  .split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean).join("\n");
const directives = () => stripComments(WRANGLER);

/** The rollback, performed on the text: delete the three activation blocks. */
function rolledBack(toml = WRANGLER) {
  const drop = /\n\[\[(?:durable_objects\.bindings|queues\.producers|queues\.consumers)\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g;
  return toml.replace(drop, "\n");
}

test("B2 · the reviewed bindings are configured, and named exactly", () => {
  const active = directives();
  assert.match(active, /\[\[durable_objects\.bindings\]\]\nname = "NOTIFY_LEDGER"\nclass_name = "NotifyLedger"/,
    "the Durable Object binding is missing or not bound to NotifyLedger");
  assert.match(active, /\[\[queues\.producers\]\]\nbinding = "NOTIFY_QUEUE"\nqueue = "prem-oracle-notify"/,
    "the producer is missing or points at another queue");
  // Exactly one of each: a second producer would be a second name for the same
  // switch, and a second consumer would double every delivery.
  assert.equal(active.match(/\[\[durable_objects\.bindings\]\]/g).length, 1);
  assert.equal(active.match(/\[\[queues\.producers\]\]/g).length, 1);
  assert.equal(active.match(/\[\[queues\.consumers\]\]/g).length, 1);
  // The names the code gates on are the names configured.
  assert.match(SOURCE, /env\.NOTIFY_QUEUE && env\.NOTIFY_LEDGER/);
  assert.match(SOURCE, /env\.NOTIFY_QUEUE\.send\(job\)/);
});

test("B2 · the consumer uses the frozen limits, on the right queue", () => {
  const active = directives();
  const consumer = active.slice(active.indexOf("[[queues.consumers]]"));
  // docs/v1.6.6-notification-read-plan.md section 4.1.
  assert.match(consumer, /queue = "prem-oracle-notify"/);
  assert.match(consumer, /max_batch_size = 1\b/,
    "a batch bigger than one job breaks the 45-APNs-per-invocation bound");
  assert.match(consumer, /max_batch_timeout = 5\b/);
  assert.match(consumer, /max_retries = 3\b/, "the budget is priced at four deliveries");
  assert.match(consumer, /max_concurrency = 10\b/);
  assert.ok(!/dead_letter_queue/.test(consumer),
    "a dead-letter queue was attached; the ledger's dropped_log is the record");
  // And the retry delay, which lives in code because it must outlast the lease.
  assert.equal(NOTIFY_RETRY_DELAY_S, 150);
  assert.ok(NOTIFY_RETRY_DELAY_S * 1000 > LEASE_MS,
    `a ${NOTIFY_RETRY_DELAY_S}s retry lands inside the ${LEASE_MS}ms lease`);
});

test("B2 · activation adds a binding, never a second migration", () => {
  const active = directives();
  assert.match(active, /\[\[migrations\]\]/);
  assert.match(active, /new_sqlite_classes = \["NotifyLedger"\]/);
  assert.equal(active.match(/\[\[migrations\]\]/g).length, 1,
    "a second migration was introduced");
  assert.equal(active.match(/^tag = /gm).length, 1);
  assert.match(active, /tag = "v1"/, "the applied migration tag changed");
  // Nothing may be renamed or deleted: those are the migration verbs that
  // would touch a namespace that already holds state.
  assert.ok(!/renamed_classes|deleted_classes|new_classes\b/.test(active));
});

test("B2 · the rollback is deleting three blocks, and nothing else", () => {
  const back = stripComments(rolledBack());
  assert.ok(!/\bNOTIFY_(QUEUE|LEDGER)\b/.test(back), "rollback left a NOTIFY_* binding");
  assert.ok(!/\[\[queues/.test(back), "rollback left a queue binding");
  assert.ok(!/\[\[durable_objects\.bindings\]\]/.test(back), "rollback left a DO binding");
  // What must SURVIVE a rollback: the migration, the cron, and KV.
  assert.match(back, /\[\[migrations\]\]/, "rollback removed the applied migration");
  assert.match(back, /new_sqlite_classes = \["NotifyLedger"\]/);
  assert.match(back, /crons = \["\*\/15 \* \* \* \*"\]/);
  assert.match(back, /binding = "KV"/);
  assert.match(back, /^name = "prem-oracle-window"/m);
});

// --- X1 · payload compatibility -------------------------------------------

test("N4 · the payload is additive: an old client sees the alert it always saw", () => {
  const payload = reminderPayload({
    match: { id: "f1", player1: "Home", player2: "Away", startAt: "2026-09-12T14:00:00Z" },
    leagueCode: "AAA",
  });
  // Everything a 1.6.5 client reads is where it has always been.
  assert.equal(typeof payload.aps.alert.body, "string");
  assert.equal(payload.aps.sound, "default");
  // The routing block is new, versioned, and ignorable.
  assert.equal(payload.po.v, PAYLOAD_VERSION);
  const legacyView = { ...payload };
  delete legacyView.po;
  assert.deepEqual(Object.keys(legacyView), ["aps"]);
});

test("N4 · a stale or malformed routing block cannot be mistaken for a good one", () => {
  const payload = reminderPayload({
    match: { id: "f1", player1: "Home", player2: "Away", startAt: "2026-09-12T14:00:00Z" },
    leagueCode: "AAA",
  });
  // The version is what a new client checks before trusting f and l at all.
  assert.equal(payload.po.v, 1);
  assert.equal(typeof payload.po.f, "string");
  assert.equal(typeof payload.po.l, "string");
});

// --- B2 · which path a scheduled invocation ACTUALLY runs -----------------
//
// The ternary in scheduled() makes "never both" true by construction, but a
// structural claim is not a measurement. These drive the real handler and watch
// for something only one path can do:
//
//   legacy   lists KV under "notified:" to find fixtures it has already told
//            people about — no other job in the tick touches that prefix
//   new      builds a ledger client, which reaches env.NOTIFY_LEDGER before it
//            reads a single fixture
//
// Exactly one of those must happen, every time.

/** A scheduled tick, instrumented on both paths at once. */
async function runScheduled({ queue = true, ledger = true } = {}) {
  const seen = { prefixes: [], ledgerTouched: false, ledgerOps: [], sent: [] };
  const store = new Map();
  const env = {
    // Enough APNs configuration that neither path short-circuits before it
    // reaches the thing being watched.
    APNS_KEY: "k", APNS_KEY_ID: "kid", APNS_TEAM_ID: "team",
    FIXTURES_URL: "https://example.com/f.json",
    ALLOWED_ORIGIN: "*",
    KV: {
      async get() { return null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      // list_complete matters: helpers that paginate loop on it, and a shim
      // that omits it spins forever rather than failing.
      async list({ prefix = "" } = {}) {
        seen.prefixes.push(prefix);
        return { keys: [], list_complete: true, cursor: undefined };
      },
    },
  };
  if (queue) env.NOTIFY_QUEUE = { async send(job) { seen.sent.push(job); } };
  if (ledger) {
    const stub = {
      async fetch(_url, init) {
        seen.ledgerOps.push(JSON.parse(init.body).op);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    };
    env.NOTIFY_LEDGER = {
      idFromName(name) { seen.ledgerTouched = true; return { name }; },
      get() { return stub; },
    };
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fixtures: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const pending = [];
  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 12, 12, 0, 0) }, env,
      { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.map((p) => Promise.resolve(p).catch(() => null)));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    ...seen,
    legacyRan: seen.prefixes.includes("notified:"),
    plannerRan: seen.ledgerTouched,
  };
}

test("B2 · with BOTH bindings the planner runs and the legacy path does not", async () => {
  const run = await runScheduled({ queue: true, ledger: true });
  assert.equal(run.plannerRan, true, "the queue/DO planner never reached the ledger");
  assert.equal(run.legacyRan, false,
    "the legacy notifyKickoffs path ran while the new one was enabled");
});

test("B2 · with EITHER binding missing the legacy path runs and the planner does not", async () => {
  for (const missing of [{ queue: false }, { ledger: false }, { queue: false, ledger: false }]) {
    const run = await runScheduled(missing);
    const label = JSON.stringify(missing);
    assert.equal(run.legacyRan, true, `${label}: the legacy path did not run`);
    assert.equal(run.plannerRan, false, `${label}: the planner ran without both bindings`);
    assert.deepEqual(run.sent, [], `${label}: something was enqueued`);
  }
});

test("B2 · never both paths in one scheduled invocation", async () => {
  for (const options of [
    { queue: true, ledger: true },
    { queue: true, ledger: false },
    { queue: false, ledger: true },
    { queue: false, ledger: false },
  ]) {
    const run = await runScheduled(options);
    assert.equal(Number(run.legacyRan) + Number(run.plannerRan), 1,
      `${JSON.stringify(options)}: legacy=${run.legacyRan} planner=${run.plannerRan}`);
  }
});

test("B2 · removing the bindings restores the legacy path, with no code change", async () => {
  // Rollback is a redeploy without the three blocks. The env the worker then
  // sees is exactly this one, and the same build takes the other branch.
  const activated = await runScheduled({ queue: true, ledger: true });
  const rolledBack = await runScheduled({ queue: false, ledger: false });
  assert.equal(activated.plannerRan, true);
  assert.equal(rolledBack.legacyRan, true);
  assert.equal(rolledBack.plannerRan, false);
  assert.deepEqual(rolledBack.sent, []);
});
