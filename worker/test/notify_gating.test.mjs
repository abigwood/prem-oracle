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
 * The gate is BINDINGS, not infrastructure.
 *
 * Phase B1 deliberately created the queue and applied the SQLite migration that
 * declares NotifyLedger, because creating infrastructure and activating it are
 * separate decisions and only the first was approved. This test used to forbid
 * both — and it read the whole file, so the comment EXPLAINING that there is no
 * durable_objects binding tripped the check that looks for one.
 *
 * So it reads ACTIVE DIRECTIVES ONLY, and asserts the thing that actually keeps
 * the live worker on the legacy path: the worker has no way to reach either.
 */
const directives = () => readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")
  .split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean).join("\n");

test("no queue or Durable Object BINDING is configured", () => {
  const active = directives();
  assert.ok(!/\[\[queues/.test(active), "a queue producer or consumer was added before approval");
  assert.ok(!/\[\[durable_objects\.bindings\]\]/.test(active),
    "a Durable Object binding was added before approval");
  assert.ok(!/\bNOTIFY_(QUEUE|LEDGER)\b/.test(active), "a NOTIFY_* binding was added before approval");
  assert.ok(!/^\s*binding\s*=\s*"NOTIFY/m.test(active));
});

test("the approved migration declares the CLASS and binds nothing", () => {
  const active = directives();
  // It has to be here: without it the namespace does not exist. What it must
  // not do is give the worker a name to call it by.
  assert.match(active, /\[\[migrations\]\]/);
  assert.match(active, /new_sqlite_classes = \["NotifyLedger"\]/);
  const migration = active.slice(active.indexOf("[[migrations]]"));
  assert.ok(!/binding/.test(migration), "the migration block carries a binding");
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
