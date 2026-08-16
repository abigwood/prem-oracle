// Mates' Picks — the server gate.
//
// Spec §5: "after kick-off" means server time >= Date.parse(fixture.lockAt) and
// nothing else, with the server capturing its time ONCE per response. The whole
// privacy promise of the feature rests on this one comparison, so these tests
// go at it from every side: the boundary itself, the feed states that must not
// move it, who is allowed to ask, and who was even eligible to be asked about.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundReveal, fixtureLockMs } from "../src/logic.js";

const LOCK = "2026-08-22T14:00:00Z";
const LOCK_MS = Date.parse(LOCK);

const fixture = (over = {}) => ({
  id: "pl-1", player1: "Arsenal", player2: "Chelsea", startAt: LOCK, ...over,
});

const MEMBERS = [
  { uid: "u1", nick: "Adam", since: 0 },
  { uid: "u2", nick: "Bex", since: 0 },
  { uid: "u3", nick: "Cal", since: 0 },
];

const PICKS = {
  "pl-1": {
    u1: { p1: 2, p2: 1, ts: LOCK_MS - 60000 },
    u2: { p1: 1, p2: 1, ts: LOCK_MS - 30000 },
  },
};

const build = (over = {}) => buildRoundReveal({
  fixtures: [fixture(over.fixture)],
  picksByMatch: over.picks || PICKS,
  members: over.members || MEMBERS,
  serverNow: over.serverNow ?? LOCK_MS,
  includePicks: over.includePicks ?? true,
})[0];

/** Everything a client could read off the wire, as one string. */
const wire = (value) => JSON.stringify(value);

// --- the boundary ----------------------------------------------------------

test("now == lockAt reveals", () => {
  const entry = build({ serverNow: LOCK_MS });
  assert.equal(entry.revealed, true);
  assert.equal(entry.picks.length, 3);
});

test("one millisecond before lockAt reveals nothing", () => {
  const entry = build({ serverNow: LOCK_MS - 1 });
  assert.equal(entry.revealed, false);
  assert.equal(entry.picks, undefined, "the key is absent, not empty");
  assert.doesNotMatch(wire(entry), /"p1"/, "no prediction reaches the wire");
});

test("a missing kick-off never reveals", () => {
  const entry = build({ fixture: { startAt: undefined }, serverNow: LOCK_MS + 1e9 });
  assert.equal(entry.lockAt, null);
  assert.equal(entry.revealed, false);
  assert.equal(entry.picks, undefined);
});

test("an unparseable kick-off never reveals", () => {
  const entry = build({ fixture: { startAt: "sometime Saturday" }, serverNow: LOCK_MS + 1e9 });
  assert.equal(entry.lockAt, null);
  assert.equal(entry.revealed, false);
  assert.equal(entry.picks, undefined);
});

test("a LIVE status with a future kick-off still reveals nothing", () => {
  // The feed says the game is on; the clock says it is not. The clock wins,
  // because a stale or wrong feed must never open the gate early.
  const entry = build({ fixture: { status: "live" }, serverNow: LOCK_MS - 60000 });
  assert.equal(entry.revealed, false);
  assert.equal(entry.picks, undefined);
});

test("a postponement does not close a gate that has already opened", () => {
  // The mirror of the above: once a fixture has passed its kick-off the picks
  // are out, and a later postponement cannot un-ring that bell.
  const entry = build({ fixture: { status: "postponed" }, serverNow: LOCK_MS + 60000 });
  assert.equal(entry.revealed, true);
  assert.equal(entry.picks.length, 3);
});

test("the gate reads the clock, not the result", () => {
  const entry = build({ fixture: { result: { p1: 3, p2: 0 } }, serverNow: LOCK_MS - 1 });
  assert.equal(entry.revealed, false, "a result posted early cannot open the gate");
});

test("one server timestamp gates every fixture in the response", () => {
  const early = fixture({ id: "early", startAt: "2026-08-22T12:00:00Z" });
  const late = fixture({ id: "late", startAt: "2026-08-22T16:30:00Z" });
  const entries = buildRoundReveal({
    fixtures: [early, late],
    picksByMatch: { early: PICKS["pl-1"], late: PICKS["pl-1"] },
    members: MEMBERS,
    serverNow: LOCK_MS,
    includePicks: true,
  });
  assert.equal(entries[0].revealed, true, "the earlier fixture has kicked off");
  assert.equal(entries[1].revealed, false, "the later one has not — Saturday cannot spoil Sunday");
  assert.doesNotMatch(wire(entries[1]), /"p1"/);
});

test("fixtureLockMs is the only clock the gate consults", () => {
  assert.equal(fixtureLockMs({ startAt: LOCK }), LOCK_MS);
  // An explicit lockAt wins over the kick-off when a fixture carries one.
  assert.equal(fixtureLockMs({ startAt: LOCK, lockAt: "2026-08-22T13:00:00Z" }), Date.parse("2026-08-22T13:00:00Z"));
  for (const bad of [{}, { startAt: null }, { startAt: "" }, { startAt: "nonsense" }, null, undefined]) {
    assert.equal(fixtureLockMs(bad), null, `${JSON.stringify(bad)} must have no lock`);
  }
});

// --- who may ask -----------------------------------------------------------

test("a non-member is served no predictions at all", () => {
  const entry = build({ includePicks: false, serverNow: LOCK_MS + 60000 });
  assert.equal(entry.revealed, true, "the fixture has still kicked off");
  assert.equal(entry.picks, undefined, "but this viewer gets none of them");
  assert.doesNotMatch(wire(entry), /"p1"|Adam|Bex/);
});

test("a removed member is a non-member", () => {
  // Membership is read fresh from the league's member list on every request,
  // so removal takes effect on the next answer rather than at some later sync.
  const stillListed = MEMBERS.some((member) => member.uid === "u9");
  assert.equal(stillListed, false);
  const entry = buildRoundReveal({
    fixtures: [fixture()], picksByMatch: PICKS, members: MEMBERS,
    serverNow: LOCK_MS, includePicks: MEMBERS.some((member) => member.uid === "u9"),
  })[0];
  assert.equal(entry.picks, undefined);
});

// --- who was eligible ------------------------------------------------------

test("a member who joined after a fixture locked is omitted from it", () => {
  const members = [...MEMBERS, { uid: "u4", nick: "Dee", since: LOCK_MS + 1 }];
  const entry = build({ members, serverNow: LOCK_MS + 60000 });
  assert.deepEqual(entry.picks.map((row) => row.uid), ["u1", "u2", "u3"]);
  assert.equal(entry.eligible, 3, "and is not counted against the locked-in total");
  assert.doesNotMatch(wire(entry), /Dee/, "a latecomer is absent, not shown as No pick");
});

test("a member who joined exactly on the lock is still eligible", () => {
  const members = [...MEMBERS, { uid: "u4", nick: "Dee", since: LOCK_MS }];
  const entry = build({ members, serverNow: LOCK_MS });
  assert.deepEqual(entry.picks.map((row) => row.uid), ["u1", "u2", "u3", "u4"]);
});

test("an eligible member with no pick is present and honest about it", () => {
  const entry = build({ serverNow: LOCK_MS });
  const cal = entry.picks.find((row) => row.uid === "u3");
  assert.equal(cal.none, true);
  assert.equal(cal.p1, null);
  assert.equal(cal.p2, null);
});

test("a pick recorded after the lock is not treated as a pick", () => {
  const late = { "pl-1": { u1: { p1: 2, p2: 1, ts: LOCK_MS + 1 } } };
  const entry = build({ picks: late, serverNow: LOCK_MS + 60000 });
  assert.equal(entry.picks.find((row) => row.uid === "u1").none, true);
  assert.equal(entry.lockedIn, 0);
});

// --- counts before the reveal ----------------------------------------------

test("before kick-off only counts are published, never values", () => {
  const entry = build({ serverNow: LOCK_MS - 60000 });
  assert.deepEqual(entry, {
    id: "pl-1",
    lockAt: new Date(LOCK_MS).toISOString(),
    revealed: false,
    eligible: 3,
    lockedIn: 2,
  });
});

// --- after settlement ------------------------------------------------------

test("a settled fixture carries the score and points per pick", () => {
  const entry = build({ fixture: { result: { p1: 2, p2: 1 } }, serverNow: LOCK_MS + 7200000 });
  assert.equal(entry.settled, true);
  assert.deepEqual(entry.result, { p1: 2, p2: 1 });
  const [adam, bex, cal] = entry.picks;
  assert.equal(adam.pts, 5, "an exact score is five");
  assert.equal(adam.exact, true);
  assert.equal(bex.pts, 0, "a wrong outcome is nothing");
  assert.equal(cal.pts, 0, "and no pick scores nothing");
  assert.equal(cal.none, true);
});

test("kicked off but unsettled shows picks with no points and no score", () => {
  const entry = build({ serverNow: LOCK_MS + 600000 });
  assert.equal(entry.settled, false);
  assert.equal(entry.result, null);
  for (const row of entry.picks) assert.equal(row.pts, null, "no points until the engine says so");
  // And nothing that could be read as a running score.
  assert.doesNotMatch(wire(entry), /minute|live|score":/i);
});

test("a voided fixture settles to nothing rather than scoring", () => {
  // An abandonment voids; a postponement (tested above) does not.
  const entry = build({ fixture: { status: "abandoned", result: { p1: 1, p2: 0 } }, serverNow: LOCK_MS + 7200000 });
  assert.equal(entry.voided, true);
  assert.equal(entry.settled, false, "void is its own outcome — nothing was scored");
  for (const row of entry.picks) assert.equal(row.pts, null, "so there are no points to show");
  // The picks themselves are still out: the fixture kicked off before it died.
  assert.equal(entry.picks.find((row) => row.uid === "u1").p1, 2);
});

// --- the shape as a whole --------------------------------------------------

test("an unrevealed fixture's entry contains no member identity either", () => {
  const entry = build({ serverNow: LOCK_MS - 1 });
  for (const member of MEMBERS) {
    assert.doesNotMatch(wire(entry), new RegExp(member.nick), `${member.nick} must not appear`);
    assert.doesNotMatch(wire(entry), new RegExp(member.uid), `${member.uid} must not appear`);
  }
});

test("an empty round reveals an empty list rather than failing", () => {
  assert.deepEqual(buildRoundReveal({ fixtures: [], picksByMatch: {}, members: [], serverNow: 0, includePicks: true }), []);
  assert.deepEqual(buildRoundReveal({ serverNow: 0, includePicks: true }), []);
});
