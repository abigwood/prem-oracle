// Slice 1 · N3 and N7 — the tap, and every way it can be wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { load, APP, sourceOf } from "./harness.mjs";

/** vm-realm objects carry a foreign prototype; compare the values. */
const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const ROUTE = ["NOTIFY_PAYLOAD_VERSION", "safeParseJSON", "readNotificationRoute"];

// --- N7 · the payload is never trusted -------------------------------------

test("N7 · a well-formed routing block is read", () => {
  const s = load(ROUTE);
  assert.deepEqual(plain(s.readNotificationRoute({ po: { v: 1, f: "m1", l: "aaa" } })),
    { fixtureId: "m1", league: "AAA" });
  // APNs hands the block through in different shapes depending on the path.
  assert.deepEqual(plain(s.readNotificationRoute({ notification: { data: { po: { v: 1, f: "m1", l: "AAA" } } } })),
    { fixtureId: "m1", league: "AAA" });
  // Some transports stringify nested objects.
  assert.deepEqual(plain(s.readNotificationRoute({ po: JSON.stringify({ v: 1, f: "m1", l: "AAA" }) })),
    { fixtureId: "m1", league: "AAA" });
});

test("N7 · anything unrecognised is refused rather than guessed at", () => {
  const s = load(ROUTE);
  for (const [label, data] of [
    ["nothing at all", null],
    ["no routing block", { aps: { alert: "hi" } }],
    ["a future version", { po: { v: 2, f: "m1", l: "AAA" } }],
    ["no version", { po: { f: "m1", l: "AAA" } }],
    ["no fixture", { po: { v: 1, l: "AAA" } }],
    ["no league", { po: { v: 1, f: "m1" } }],
    ["empty strings", { po: { v: 1, f: "", l: "" } }],
    ["malformed json", { po: "{not json" }],
    ["an array", { po: [1, 2, 3] }],
  ]) {
    assert.equal(s.readNotificationRoute(data), null, `${label} was accepted`);
  }
});

test("N7 · a stale payload cannot open a league this device does not play", () => {
  const src = sourceOf("openNotificationTarget");
  // Activation is conditional on membership; there is no unconditional switch.
  assert.match(src, /if \(leagueCodes\.includes\(league\) && activeLeague !== league\)/);
  assert.ok(!/setActiveLeague\(league\);/.test(src), "the league is switched unconditionally");
});

test("N7 · every failure is a fallback, and each one is distinguishable", () => {
  const src = sourceOf("openNotificationTarget");
  for (const outcome of ["fallback:no-route", "fallback:unknown-fixture", "fallback:not-on-screen", "opened"]) {
    assert.ok(src.includes(`"${outcome}"`), `missing outcome ${outcome}`);
  }
  // No throw path: a bad payload must not surface as an error.
  assert.ok(!/throw /.test(src));
});

test("N7 · a thrown handler still opens the app", () => {
  const handler = APP.slice(APP.indexOf('await push.addListener("pushNotificationActionPerformed"'));
  const body = handler.slice(0, handler.indexOf("});") + 3);
  assert.match(body, /catch \{[\s\S]*currentView = "today";[\s\S]*render\(\{ scrollTop: true \}\);/);
});

// --- N3 · the tap reaches the exact card -----------------------------------

test("N3 · the tap activates the payload's league before navigating", () => {
  const src = sourceOf("openNotificationTarget");
  assert.ok(src.indexOf("setActiveLeague(league, false)") < src.indexOf('navigateToView("schedule")'),
    "the league is switched after the screen is built");
  // `false` matters: the refresh comes from navigateToView, not from a second
  // request racing it.
  assert.match(src, /setActiveLeague\(league, false\)/);
});

test("N3 · the fixture's own week is opened, and no filter hides it", () => {
  const src = sourceOf("openNotificationTarget");
  assert.match(src, /openScheduleDates\.add\(`md-\$\{period\}`\)/);
  assert.match(src, /matchdayFilter = "all";/);
});

test("N3 · the exact card is expanded and scrolled to", () => {
  const src = sourceOf("openNotificationTarget");
  assert.match(src, /document\.querySelector\(`\[data-fixture-row="\$\{cssEscape\(fixtureId\)\}"\]`\)/);
  assert.match(src, /expandFixture\(fixtureId\)/);
  assert.match(src, /scrollIntoView\(\{ block: "center", behavior: "smooth" \}\)/);
});

test("N3 · one path serves foreground, background and closed", () => {
  const handler = APP.slice(APP.indexOf('await push.addListener("pushNotificationActionPerformed"'));
  const body = handler.slice(0, handler.indexOf("});") + 3);
  // The payload arrives in the same place whichever state the app was in, so
  // there is one handler rather than three that can drift.
  assert.match(body, /event\?\.notification\?\.data \?\? event\?\.data \?\? null/);
  assert.match(body, /openNotificationTarget\(readNotificationRoute\(data\)\)/);
  assert.equal((body.match(/openNotificationTarget/g) || []).length, 1);
});

test("N3 · the fixture id is escaped before it reaches a selector", () => {
  const s = load(["cssEscape"], { window: {} });
  assert.equal(s.cssEscape("m1"), "m1");
  assert.equal(s.cssEscape('a"b'), 'a\\"b');
  // With the platform's own escaper available, use it.
  const withCss = load(["cssEscape"], { window: { CSS: { escape: (v) => `<${v}>` } } });
  assert.equal(withCss.cssEscape("m1"), "<m1>");
});

// --- the tap never asks the server who to trust ----------------------------

test("the tap builds no request and syncs no active league", () => {
  const src = sourceOf("openNotificationTarget");
  assert.ok(!/\bapi\(|fetch\(/.test(src), "the tap handler makes a request");
  // D2 forbids an active-league sync; the payload's code is the only input.
  assert.ok(!/activeLeague *=/.test(src), "the handler assigns activeLeague directly");
});
