// Schedule-integrity reconciliation — pure-function behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import {
  londonFromUtc, londonOffsetMinutes, reconcileFixtures, applyFeedUpdates, indexByIdentity,
} from "../scripts/reconcile_schedule.mjs";

const NOW = Date.parse("2026-10-06T09:00:00Z");   // before every fixture below
// Our stored fixture, defaulted to Sat 10 Oct 15:00 BST.
const fx = (id, home, away, over = {}) => ({
  id, player1: home, player2: away, result: null,
  date: "2026-10-10", time: "15:00", startAt: "2026-10-10T15:00:00+01:00", ...over,
});
const prov = (home, away, utcKickoff, status = "SCHEDULED") => ({ home, away, utcKickoff, status });
const only = (r) => { assert.equal(r.updates.length, 1, "expected one update"); return r.updates[0].to; };

// --- Europe/London normalisation (BST / GMT / DST boundary) ------------------

test("londonFromUtc: BST (summer) → +01:00", () => {
  assert.deepEqual(londonFromUtc("2026-10-10T11:30:00Z"),
    { date: "2026-10-10", time: "12:30", startAt: "2026-10-10T12:30:00+01:00" });
});
test("londonFromUtc: GMT (winter) → +00:00", () => {
  assert.deepEqual(londonFromUtc("2026-11-07T15:00:00Z"),
    { date: "2026-11-07", time: "15:00", startAt: "2026-11-07T15:00:00+00:00" });
});
test("londonFromUtc: across the autumn DST boundary (26 Oct 2026)", () => {
  assert.equal(londonOffsetMinutes(new Date("2026-10-24T14:00:00Z")), 60, "still BST before the change");
  assert.equal(londonOffsetMinutes(new Date("2026-10-26T14:00:00Z")), 0, "GMT after the change");
  assert.equal(londonFromUtc("2026-10-24T14:00:00Z").startAt, "2026-10-24T15:00:00+01:00");
  assert.equal(londonFromUtc("2026-10-26T14:00:00Z").startAt, "2026-10-26T14:00:00+00:00");
});

// --- move types --------------------------------------------------------------

test("Friday-night move (date Sat→Fri)", () => {
  const to = only(reconcileFixtures([fx("a", "West Ham", "QPR")],
    [prov("West Ham", "QPR", "2026-10-09T19:00:00Z")], NOW, { competition: "ELC" }));
  assert.deepEqual(to, { date: "2026-10-09", time: "20:00", startAt: "2026-10-09T20:00:00+01:00" });
});
test("lunchtime move (time only, same date)", () => {
  const to = only(reconcileFixtures([fx("a", "Charlton", "Bristol City")],
    [prov("Charlton", "Bristol City", "2026-10-10T11:30:00Z")], NOW, { competition: "ELC" }));
  assert.deepEqual(to, { date: "2026-10-10", time: "12:30", startAt: "2026-10-10T12:30:00+01:00" });
});
test("Sunday move", () => {
  const to = only(reconcileFixtures([fx("a", "Liverpool", "Man City")],
    [prov("Liverpool", "Man City", "2026-10-11T15:30:00Z")], NOW, { competition: "PL" }));
  assert.deepEqual(to, { date: "2026-10-11", time: "16:30", startAt: "2026-10-11T16:30:00+01:00" });
});
test("Monday-night move", () => {
  const to = only(reconcileFixtures([fx("a", "Coventry", "Newcastle")],
    [prov("Coventry", "Newcastle", "2026-10-12T19:00:00Z")], NOW, { competition: "PL" }));
  assert.deepEqual(to, { date: "2026-10-12", time: "20:00", startAt: "2026-10-12T20:00:00+01:00" });
});

// --- no-op / idempotency -----------------------------------------------------

test("already-correct time produces no update (idempotent)", () => {
  const r = reconcileFixtures([fx("a", "A", "B")], [prov("A", "B", "2026-10-10T14:00:00Z")], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.equal(r.diagnostics.unchanged, 1);
});
test("running twice is idempotent (second run finds nothing)", () => {
  const our = [fx("a", "A", "B")];
  const p = [prov("A", "B", "2026-10-10T11:30:00Z")];
  const r1 = reconcileFixtures(our, p, NOW, { competition: "PL" });
  assert.equal(r1.updates.length, 1);
  // apply then re-run
  our[0] = { ...our[0], ...r1.updates[0].to };
  const r2 = reconcileFixtures(our, p, NOW, { competition: "PL" });
  assert.equal(r2.updates.length, 0, "no further change once applied");
});

// --- fail-closed paths -------------------------------------------------------

test("provider outage (empty) → no changes, alert", () => {
  const r = reconcileFixtures([fx("a", "A", "B")], [], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.ok(r.alerts.some((x) => x.code === "provider_unavailable"));
});
test("unmatched fixture → no change, actionable alert", () => {
  const r = reconcileFixtures([fx("a", "A", "B")], [prov("C", "D", "2026-10-10T11:30:00Z")], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.ok(r.alerts.some((x) => x.code === "unmatched" && x.id === "a"));
});
test("ambiguous identity (two same-pair fixtures) → fail closed", () => {
  const r = reconcileFixtures(
    [fx("a", "A", "B"), fx("b", "A", "B", { date: "2026-12-05", startAt: "2026-12-05T15:00:00+00:00" })],
    [prov("A", "B", "2026-10-10T11:30:00Z")], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.ok(r.alerts.some((x) => x.code === "ambiguous_identity"));
});
test("ambiguous provider (two entries same pair) → fail closed", () => {
  const r = reconcileFixtures([fx("a", "A", "B")],
    [prov("A", "B", "2026-10-10T11:30:00Z"), prov("A", "B", "2026-10-17T11:30:00Z")], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.ok(r.alerts.some((x) => x.code === "ambiguous_identity"));
});
test("provider entry with no scheduled time → never inferred, alert", () => {
  const r = reconcileFixtures([fx("a", "A", "B")], [prov("A", "B", null)], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.ok(r.alerts.some((x) => x.code === "no_provider_time"));
});

// --- preservation ------------------------------------------------------------

test("settled/past fixtures are never touched", () => {
  const settled = fx("done", "A", "B", { result: [1, 0] });
  const past = fx("old", "C", "D", { date: "2026-09-01", startAt: "2026-09-01T15:00:00+01:00" });
  const r = reconcileFixtures([settled, past],
    [prov("A", "B", "2026-10-10T11:30:00Z"), prov("C", "D", "2026-09-01T11:30:00Z")], NOW, { competition: "PL" });
  assert.equal(r.updates.length, 0);
  assert.equal(r.diagnostics.skippedSettled, 1);
  assert.equal(r.diagnostics.skippedPast, 1);
});

// --- minimal deterministic feed edit -----------------------------------------

test("applyFeedUpdates changes only date/startAt/time, nothing else", () => {
  const raw = [
    "{", '  "fixtures": [', "    {",
    '      "id": "pl-1",',
    '      "date": "2026-10-10",',
    '      "startAt": "2026-10-10T15:00:00+01:00",',
    '      "time": "15:00",',
    '      "player1": "Arsenal",',
    '      "result": null',
    "    }", "  ]", "}",
  ].join("\n");
  const { text, changedLines } = applyFeedUpdates(raw, [
    { id: "pl-1", from: {}, to: { date: "2026-10-11", time: "16:30", startAt: "2026-10-11T16:30:00+01:00" } },
  ]);
  assert.equal(changedLines, 3);
  assert.match(text, /"date": "2026-10-11"/);
  assert.match(text, /"startAt": "2026-10-11T16:30:00\+01:00"/);
  assert.match(text, /"time": "16:30"/);
  assert.match(text, /"player1": "Arsenal"/);   // untouched
  assert.match(text, /"result": null/);         // untouched
  // no updates → byte-identical (deterministic no-op)
  assert.equal(applyFeedUpdates(raw, []).text, raw);
});

test("indexByIdentity drops ambiguous pairs, keeps unique ones", () => {
  const { map, ambiguous } = indexByIdentity(
    [{ h: "A", a: "B" }, { h: "A", a: "B" }, { h: "C", a: "D" }], (e) => e.h, (e) => e.a);
  assert.equal(ambiguous.size, 1);          // the A/B pair
  assert.equal(map.size, 1);                // only the unique C/D pair survives
  assert.equal([...map.values()][0].h, "C");
});
