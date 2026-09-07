// v1.7 Slice A — Matchweek shell.
//
// Schedule was a season browser that could be scoped to your leagues; the
// scoping was optional and the fallback was the whole competition calendar.
// Matchweek is the selected league's current published slate and nothing else,
// so the tests that matter are the ones about what must NEVER appear: another
// league's fixtures, another week's fixtures, and twenty-two competition
// fixtures standing in for the six a host chose.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, sourceOf, constOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate",
  "matchweekSlots", "matchweekContext", "matchweekEmpty",
  "matchweekUnavailable", "picksView", "pickRow", "pickRowLabel", "pickJustSaved",
  "noteMatchweekCountMismatch", "matchweekMismatchLines",
];

/** A competition calendar far larger than any slate, so a fallback would show. */
const CALENDAR = Array.from({ length: 22 }, (_, i) => ({
  id: `pl-${String(i + 1).padStart(3, "0")}`,
  player1: `Home ${i + 1}`, player2: `Away ${i + 1}`,
  matchday: 7, startAt: `2026-09-${String(12 + (i % 3)).padStart(2, "0")}T14:00:00Z`,
}));

const leagueState = ({ code, name, period = "7", ids = null, count = null }) => ({
  code, name, currentPeriod: period,
  currentSlate: ids === null ? null : {
    period, matchweek: Number(period) || null, status: "published",
    fixtureIds: ids, count: count ?? ids.length,
  },
  table: [],
});

/**
 * The Matchweek view over a chosen world. `leagueState` and `leagueStates` are
 * set independently on purpose: a slow answer for the league you just left is
 * exactly the state this screen has to refuse.
 */
const BASE_STUBS = {
  picks: {},
  leagueNames: {},
  expandedPickId: null,
  playerName: "Adam",
  // Fresh per sandbox: the mismatch record is a diagnostic, not shared state.
  matchweekCountMismatches: new Map(),
  periodLabel: (p) => `Matchweek ${p}`,
  pulsingStatus: (m) => `<p class="pulse">${m}</p>`,
  onboardingState: () => `<div class="onboarding">Create a league</div>`,
  leagueSwitcher: () => "",
  // The real row, so a placeholder is the real placeholder. What the row is
  // made OF — the result card, the picker, the mates section — is somebody
  // else's test, so those are stubs.
  matchweekRowState: () => "open",
  pickEditable: () => true,
  isSettledCard: () => false,
  resultCard: (m) => `<article data-match-card="${m.id}"></article>`,
  scorePicker: () => `<div class="score-picker"></div>`,
  fixtureRevealSection: () => "",
  shortKickoff: () => "Sat 15:00",
  pickProgress: (slots) => ({ complete: 0, total: slots.length }),
  pickListState: () => "",
  pickDeadlineLine: () => "",
  pickShareRow: () => "",
};

function world({ active = "AAA", live = null, cached = {}, codes = null, names = {} } = {}) {
  const store = {};
  for (const [code, state] of Object.entries(cached)) store[code] = state;
  return load(NAMES, {
    ...BASE_STUBS,
    matchweekCountMismatches: new Map(),
    fixtures: CALENDAR,
    activeLeague: active,
    leagueState: live,
    leagueStates: store,
    leagueCodes: codes ?? [...new Set([active, ...Object.keys(store)].filter(Boolean))],
    leagueNames: names,
  });
}

const cardIds = (html) => [...html.matchAll(/data-pick-row="([^"]+)"/g)].map((m) => m[1]);

// --- 1 · the rename, without breaking the client --------------------------

test("A1 · the week lives on My Picks, and Matchweek is not in the navigation", () => {
  // Adam's ruling: one weekly journey, four tabs.
  assert.ok(!/data-view="schedule"/.test(HTML), "the Matchweek tab is still in the bar");
  assert.ok(!/>Matchweek<\/button>/.test(HTML), "a Matchweek tab label survives");
  assert.ok(!/>Schedule<\/button>/.test(HTML), "a visible Schedule label survives");
  const box = world({ live: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] }) });
  assert.match(box.picksView(), /<h2>My Picks<\/h2>/);
  // And the shell that answers the tap says the same thing.
  assert.match(APP, /picks: \(\) => `<div class="section-head">[\s\S]*?<h2>My Picks<\/h2>/);
});

test("A1 · installed clients still work: the old route redirects rather than breaking", () => {
  // The stored view key and the deep-link target are still `schedule` on
  // devices that have not updated. They must land on My Picks, not on nothing.
  assert.match(APP, /const LEGACY_VIEWS = \{ schedule: "picks" \};/);
  assert.match(APP, /await navigateToView\("picks"\)/);
  assert.match(APP, /currentView = launchBranch\(\) === "awaiting" \? "picks" : "today"/);
  // Storage keys are presentation-independent and must not have moved.
  for (const key of ["prem_oracle_active_league", "prem_oracle_league_states",
    "prem_oracle_round_states", "prem_oracle_pick_weeks"]) {
    assert.ok(APP.includes(key), `storage key ${key} was renamed`);
  }
});

// --- 2 · only the published slate, in host order, at the real count -------

test("A2 · the permitted minimum, the common six and the product maximum", () => {
  for (const size of [3, 6, 20]) {
    const ids = Array.from({ length: size }, (_, i) => `pl-${String(i + 1).padStart(3, "0")}`);
    const box = world({ live: leagueState({ code: "AAA", name: "Sunday Six", ids }) });
    const html = box.picksView();
    const drawn = cardIds(html);
    assert.equal(drawn.length, size, `${size}-game slate drew ${drawn.length} cards`);
    assert.deepEqual(drawn, ids, `${size}-game slate lost host order`);
    assert.equal(new Set(drawn).size, size, "a fixture was drawn twice");
    assert.match(html, new RegExp(`of ${size} saved`), "the header count is wrong");
  }
});

test("A2 · host order is preserved even when it contradicts kick-off order", () => {
  // Deliberately reversed against the calendar, which is sorted by kick-off.
  const ids = ["pl-006", "pl-001", "pl-004", "pl-002"];
  const box = world({ live: leagueState({ code: "AAA", name: "Sunday Six", ids }) });
  assert.deepEqual(cardIds(box.picksView()), ids);
});

test("A2 · the count is the host's, never a hard-coded six", () => {
  assert.ok(!/\bof 6\b|\bsix\b/i.test(sourceOf("picksView")),
    "the header hard-codes a fixture count");
  const one = world({ live: leagueState({ code: "AAA", name: "L", ids: ["pl-001"] }) });
  assert.match(one.picksView(), /of 1 saved/, "a one-fixture week is not counted");
});

test("A2 · a slate listing a fixture twice still renders it once", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", "pl-002", "pl-001"] }) });
  assert.deepEqual(cardIds(box.picksView()), ["pl-001", "pl-002"]);
  assert.match(box.picksView(), /of 2 saved/);
});

// --- 3 · the non-negotiable empty state -----------------------------------

test("A3 · no published slate gives the exact two lines and ZERO cards", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "Sunday Six", ids: null }) });
  const html = box.picksView();
  assert.match(html, /<strong>No league fixtures selected yet\.<\/strong>/);
  assert.match(html,
    /<p>Your league fixtures will appear here when this week's line-up is published\.<\/p>/);
  assert.equal(cardIds(html).length, 0, "the empty state drew fixture cards");
  // Not one of the twenty-two, and no widening control to reach them.
  for (const gone of ["data-full-season", "data-schedule-scope", "View all fixtures",
    "data-filter", "All fixtures"]) {
    assert.ok(!html.includes(gone), `the empty state still offers ${gone}`);
  }
});

test("A3 · an empty fixture list is treated as unpublished, not as a slate", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "L", ids: [] }) });
  assert.match(box.picksView(), /No league fixtures selected yet\./);
  assert.equal(cardIds(box.picksView()).length, 0);
});

test("A3 · a slate for another period is refused rather than shown as this week", () => {
  const state = leagueState({ code: "AAA", name: "L", period: "7", ids: ["pl-001"] });
  state.currentSlate.period = "6";
  state.currentSlate.matchweek = 6;
  const box = world({ live: state });
  assert.equal(box.matchweekSlate(state), null, "last week's slate answered for this week");
  assert.match(box.picksView(), /No league fixtures selected yet\./);
});

// --- 4 · no path substitutes the competition calendar ---------------------

test("A4 · the weekly journey never reaches the season browser", () => {
  const view = sourceOf("picksView");
  for (const banned of ["groupedPeriods", "scheduleFilters", "scheduleScopeToggle",
    "scheduleMore", "scheduleWindow", "leagueSlateFixtureIds", "periodsInOrder",
    "matchdayFilter", "scheduleFullSeason"]) {
    assert.ok(!view.includes(banned), `picksView reaches ${banned}`);
  }
  // It draws from the slate's own ids, never from the fixture list.
  assert.ok(!/\bfixtures\.filter\(|\bfixtures\.map\(/.test(view),
    "picksView walks the competition fixture list");
  assert.match(sourceOf("matchweekSlots"), /plan\.ids\.map\(/);
});

test("A4 · every drawn card came from the slate, at every league size", () => {
  for (const ids of [["pl-001"], ["pl-003", "pl-009"], CALENDAR.slice(0, 20).map((f) => f.id)]) {
    const box = world({ live: leagueState({ code: "AAA", name: "L", ids }) });
    const drawn = cardIds(box.picksView());
    assert.ok(drawn.every((id) => ids.includes(id)), "a card appeared that the host did not select");
    assert.ok(drawn.length <= CALENDAR.length);
  }
});

test("A4 · the old season browser is gone, not merely unreachable", () => {
  // It was kept whole through the soak so the direction could be reverted by
  // one line. The direction is now a ruling, so the second implementation of a
  // fixture row goes with it — two of them is how they drift.
  for (const gone of ["function scheduleView()", "function fixtureRow(", "function expandFixture(",
    "function dayBody(", "function fillDayBody(", "function groupedPeriods(",
    "function matchweekView()", "expandedFixtureId"]) {
    assert.ok(!APP.includes(gone), `${gone} survives the consolidation`);
  }
  assert.ok(!APP.includes("RETAINED, NOT REACHED"));
  // One row implementation, and it is the consolidated one.
  assert.ok(APP.includes("function pickRow(slot, { expanded })"));
});

// --- 5 · sticky league context --------------------------------------------

test("A5 · the selected league stays visible and is not a decoration", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] }) });
  const html = box.picksView();
  assert.match(html, /data-matchweek-context/);
  // With a single league there are no pills, so the name itself is the context.
  assert.match(html, /Sunday Six/);
  assert.match(CSS, /\.matchweek-context \{[^}]*position:\s*sticky/);
  assert.match(CSS, /\.matchweek-context \{[^}]*top:\s*0/);
  // Sticky over a scroller needs an opaque ground or the list shows through.
  assert.match(CSS, /\.matchweek-context \{[^}]*background:\s*var\(--cream\)/);
});

test("A5 · with several leagues the switcher is the sticky context", () => {
  const box = load(NAMES, {
    fixtures: CALENDAR, picks: {}, activeLeague: "AAA",
    leagueState: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] }),
    leagueStates: {}, leagueCodes: ["AAA", "BBB"], leagueNames: { AAA: "Sunday Six", BBB: "Bury" },
    ...BASE_STUBS,
    leagueSwitcher: () => `<div class="filters league-switcher"><button data-league="AAA">Sunday Six</button><button data-league="BBB">Bury</button></div>`,
  });
  const html = box.picksView();
  const context = html.slice(html.indexOf("data-matchweek-context"));
  assert.match(context.slice(0, 300), /league-switcher/);
  assert.match(context.slice(0, 300), /data-league="BBB"/);
});

// --- 6 · league switching --------------------------------------------------

test("A6 · a league we have left can never draw, however stale the global is", () => {
  // The pill says BBB; `leagueState` is still AAA's answer in flight.
  const box = world({
    active: "BBB",
    live: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001", "pl-002"] }),
    cached: {},
    codes: ["AAA", "BBB"],
  });
  const html = box.picksView();
  assert.equal(box.matchweekLeagueState(), null, "AAA's state answered for BBB");
  assert.equal(cardIds(html).length, 0, "AAA's fixtures painted under BBB");
  assert.ok(!html.includes("Sunday Six"), "AAA's name painted under BBB");
  assert.match(html, /Loading this week/, "no acknowledged shell was drawn");
});

test("A6 · a valid cache for the new league paints without waiting", () => {
  const box = world({
    active: "BBB",
    live: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001", "pl-002"] }),
    cached: { BBB: leagueState({ code: "BBB", name: "Bury Legends", ids: ["pl-005", "pl-003"] }) },
    codes: ["AAA", "BBB"],
  });
  const html = box.picksView();
  assert.deepEqual(cardIds(html), ["pl-005", "pl-003"], "the cached league did not paint in host order");
  assert.match(html, /Bury Legends/);
  assert.ok(!html.includes("Sunday Six"), "the league we left is still named");
  assert.ok(!cardIds(html).includes("pl-001"), "the league we left still has cards on screen");
});

test("A6 · an errored cache is not content, and does not resurrect the old league", () => {
  const box = world({
    active: "BBB",
    live: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] }),
    cached: { BBB: { code: "BBB", error: "offline" } },
    codes: ["AAA", "BBB"],
  });
  const html = box.picksView();
  assert.equal(box.matchweekLeagueState(), null);
  assert.equal(cardIds(html).length, 0);
  assert.ok(!html.includes("Sunday Six"));
});

test("A6 · switching clears the open card, so it cannot reopen under a new name", () => {
  const switcher = sourceOf("setActiveLeague");
  assert.match(switcher, /if \(next !== activeLeague\) \{[\s\S]*expandedPickId = null;/);
});

test("A6 · a superseded response is cached but never painted", () => {
  const loader = sourceOf("loadLeagueState");
  assert.match(loader, /requested !== activeLeague/);
  assert.match(loader, /cacheLeagueState\(state\);\s*\n\s*if \(superseded\(\)\) return;/);
});

// --- 7 · two leagues sharing fixture ids -----------------------------------

test("A7 · a shared fixture id shows each league's own slate, never a merge", () => {
  const shared = ["pl-002", "pl-004"];
  const aaa = leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001", ...shared] });
  const bbb = leagueState({ code: "BBB", name: "Bury Legends", ids: [...shared, "pl-009"] });

  const onA = world({ active: "AAA", live: aaa, cached: { AAA: aaa, BBB: bbb }, codes: ["AAA", "BBB"] });
  const onB = world({ active: "BBB", live: bbb, cached: { AAA: aaa, BBB: bbb }, codes: ["AAA", "BBB"] });

  assert.deepEqual(cardIds(onA.picksView()), ["pl-001", "pl-002", "pl-004"]);
  assert.deepEqual(cardIds(onB.picksView()), ["pl-002", "pl-004", "pl-009"]);
  // Neither borrowed the other's exclusive fixture, and neither is a union.
  assert.ok(!cardIds(onA.picksView()).includes("pl-009"));
  assert.ok(!cardIds(onB.picksView()).includes("pl-001"));
  assert.match(onA.picksView(), /of 3 saved/);
  assert.match(onB.picksView(), /of 3 saved/);
});

test("A7 · the view is a pure function of the SELECTED league", () => {
  const aaa = leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] });
  const bbb = leagueState({ code: "BBB", name: "Bury Legends", ids: ["pl-005"] });
  // Same caches, different pill: the answer must follow the pill and nothing else.
  const seen = new Set();
  for (const live of [aaa, bbb, null, { code: "AAA", error: "x" }]) {
    const box = world({ active: "BBB", live, cached: { AAA: aaa, BBB: bbb }, codes: ["AAA", "BBB"] });
    seen.add(cardIds(box.picksView()).join(","));
  }
  assert.deepEqual([...seen], ["pl-005"], "the answer changed with the stale global");
});

// --- 8 · rapid switching ---------------------------------------------------

test("A8 · rapid switching lands on the final selection", () => {
  const states = {
    AAA: leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001"] }),
    BBB: leagueState({ code: "BBB", name: "Bury Legends", ids: ["pl-005"] }),
    CCC: leagueState({ code: "CCC", name: "Third", ids: ["pl-009", "pl-010"] }),
  };
  // Every intermediate global the churn could leave behind, against the final pill.
  for (const live of [states.AAA, states.BBB, states.CCC, null]) {
    const box = world({ active: "CCC", live, cached: states, codes: ["AAA", "BBB", "CCC"] });
    const html = box.picksView();
    assert.deepEqual(cardIds(html), ["pl-009", "pl-010"], "a mid-flight league won");
    assert.match(html, /Third/);
    assert.ok(!html.includes("Sunday Six") && !html.includes("Bury Legends"));
  }
});

// --- 9 · everything outside the shell ---------------------------------------

test("A9 · no league at all gets the welcome, not a season of fixtures", () => {
  const box = world({ active: "", live: null, cached: {}, codes: [] });
  const html = box.picksView();
  assert.match(html, /onboarding/);
  assert.equal(cardIds(html).length, 0, "a viewer with no league was shown the calendar");
});

test("A9 · the other surfaces are untouched", () => {
  // Slice A is a shell change. These are the routes it must not have moved.
  for (const view of ["todayView", "picksView", "leagueView", "rulesView"]) {
    assert.ok(APP.includes(`function ${view}(`), `${view} went missing`);
  }
  assert.match(APP, /today: todayView, picks: picksView, league: leagueView, rules: rulesView/);
  // Prediction, scoring, mates, notifications, sharing and host admin still there.
  for (const anchor of ["function scorePicker(", "function savePick(", "function matesMatrix(",
    "function pickRevealSection(", "readNotificationRoute", "data-share-league",
    "function leagueSettings(", "hostSlateControl"]) {
    assert.ok(APP.includes(anchor), `${anchor} was disturbed`);
  }
});

test("A9 · the host keeps the complete fixture pool", () => {
  // M8: the browser goes from the player journey, not from line-up selection.
  assert.ok(APP.includes("function hostSlateControl(") || APP.includes("hostSlateControl"),
    "the host line-up control went missing");
  assert.ok(APP.includes("data-open-picker"), "the host picker entry point went missing");
});

test("A9 · no worker, schema or endpoint change", () => {
  for (const call of ["/state?code=", "roundStatePath", "seasonStatePath"]) {
    assert.ok(APP.includes(call), `${call} was changed`);
  }
  assert.ok(!/matchweekView[\s\S]{0,400}\bapi\(|matchweekView[\s\S]{0,400}fetch\(/.test(APP),
    "Matchweek issues a request of its own");
  const view = sourceOf("picksView");
  assert.ok(!/fetch\(|\bapi\(/.test(view), "matchweekView fetches");
});

// --- 10 · the header and the content tell the same truth ------------------
//
// The first cut skipped a published fixture this device could not resolve while
// keeping the host's declared count in the header — five rows under a heading
// that said six. That is not a smaller lie than showing the wrong fixtures; it
// is the screen contradicting itself, and it gave the viewer no way to tell a
// game that was never selected from one that failed to load.
//
// The contract now: every published id gets a SLOT in host order, a slot either
// resolves or admits it cannot, and the number on the header is the number of
// slots. Nothing is ever substituted from the calendar.

/** Ids the calendar cannot resolve, deliberately absent from CALENDAR. */
const MISSING = "missing-X";

const slotsOf = (html) =>
  [...html.matchAll(/data-pick-row="([^"]+)"|data-matchweek-unavailable="([^"]+)"/g)]
    .map((m) => (m[1] ? { kind: "row", id: m[1] } : { kind: "unavailable", id: m[2] }));

const headerCount = (html) => {
  const m = html.match(/of (\d+) saved/);
  return m ? Number(m[1]) : null;
};

test("A10 · [known, missing, known] renders three ordered slots", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", MISSING, "pl-002"] }) });
  const slots = slotsOf(box.picksView());
  assert.deepEqual(slots, [
    { kind: "row", id: "pl-001" },
    { kind: "unavailable", id: MISSING },
    { kind: "row", id: "pl-002" },
  ], "the unresolved id lost its host-selected position");
});

test("A10 · the header reports three, not the stale declared count nor the two resolved", () => {
  const box = world({
    live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", MISSING, "pl-002"], count: 6 }),
  });
  const html = box.picksView();
  assert.equal(headerCount(html), 3, "the header did not report the published slot count");
  assert.notEqual(headerCount(html), 6, "a stale declared count reached the screen");
  assert.notEqual(headerCount(html), 2, "the header counted only what resolved");
  // The invariant, stated directly: the number equals what is on screen.
  assert.equal(headerCount(html), slotsOf(html).length);
});

test("A10 · the count always equals rendered rows plus explicit placeholders", () => {
  const cases = [
    ["pl-001"],
    ["pl-001", MISSING],
    [MISSING, "missing-Y", "missing-Z"],
    ["pl-003", "pl-001", MISSING, "pl-002", "missing-Y"],
    Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? `gone-${i}` : `pl-${String(i + 1).padStart(3, "0")}`)),
  ];
  for (const ids of cases) {
    const box = world({ live: leagueState({ code: "AAA", name: "L", ids }) });
    const html = box.picksView();
    assert.equal(headerCount(html), slotsOf(html).length,
      `header disagreed with the screen for ${JSON.stringify(ids)}`);
    assert.equal(slotsOf(html).length, ids.length);
    assert.deepEqual(slotsOf(html).map((s) => s.id), ids, "host order was lost");
  }
});

test("A10 · a resolvable id replaces its placeholder in place, moving nothing", () => {
  const ids = ["pl-001", MISSING, "pl-002"];
  const before = world({ live: leagueState({ code: "AAA", name: "L", ids }) });
  assert.deepEqual(slotsOf(before.picksView()).map((s) => s.kind),
    ["row", "unavailable", "row"]);

  // The fixture arrives — the only thing that changed is what the device holds.
  const after = load(NAMES, {
    ...BASE_STUBS,
    fixtures: [...CALENDAR, { id: MISSING, player1: "Late", player2: "Arrival", matchday: 7, startAt: "2026-09-12T14:00:00Z" }],
    activeLeague: "AAA",
    leagueState: leagueState({ code: "AAA", name: "L", ids }),
    leagueStates: {}, leagueCodes: ["AAA"],
  });
  const slots = slotsOf(after.picksView());
  assert.deepEqual(slots, [
    { kind: "row", id: "pl-001" },
    { kind: "row", id: MISSING },
    { kind: "row", id: "pl-002" },
  ], "the arriving fixture reordered the slate");
  assert.equal(headerCount(after.picksView()), 3, "the count moved when the data arrived");
});

test("A10 · duplicates render once and cannot inflate the count", () => {
  const box = world({
    live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", "pl-002", "pl-001", MISSING, MISSING], count: 5 }),
  });
  const html = box.picksView();
  assert.deepEqual(slotsOf(html).map((s) => s.id), ["pl-001", "pl-002", MISSING]);
  assert.equal(headerCount(html), 3, "duplicates inflated the displayed count");
  assert.equal(headerCount(html), slotsOf(html).length);
});

test("A10 · an unresolved id never pulls a fixture out of the calendar", () => {
  for (const ids of [[MISSING], ["pl-001", MISSING], [MISSING, "missing-Y"]]) {
    const box = world({ live: leagueState({ code: "AAA", name: "L", ids }) });
    const html = box.picksView();
    const drawn = slotsOf(html).filter((s) => s.kind === "row").map((s) => s.id);
    assert.ok(drawn.every((id) => ids.includes(id)),
      `a calendar fixture stood in for an unresolved id: ${drawn}`);
    assert.equal(slotsOf(html).length, ids.length);
  }
  // And the substitution cannot be hiding in the slot builder either.
  assert.match(sourceOf("matchweekSlots"), /plan\.ids\.map\(\(id\) => \(\{ id, fixture: fixtureById\(id\) \}\)\)/);
});

test("A10 · a mismatched declared count is recorded, not displayed", () => {
  const box = world({
    live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", "pl-002"], count: 6 }),
  });
  const plan = box.matchweekSlate();
  assert.equal(plan.count, 2, "the ids are not the display authority");
  assert.equal(plan.declared, 6);
  assert.deepEqual({ ...plan.mismatch }, { code: "AAA", period: "7", declared: 6, normalised: 2 });
  assert.equal(headerCount(box.picksView()), 2);
  // It reaches the diagnostics the profile dialog already copies, once.
  box.matchweekSlate(); box.matchweekSlate();
  // Spread into this realm: an array built inside the vm has the vm's
  // Array prototype, and deepStrictEqual compares realms as well as contents.
  assert.deepEqual([...box.matchweekMismatchLines()],
    ["slate count mismatch AAA period 7: declared 6, published 2"]);
  assert.match(APP, /\.\.\.matchweekMismatchLines\(\),/);
});

test("A10 · an agreeing count records nothing", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "L", ids: ["pl-001", "pl-002"], count: 2 }) });
  assert.equal(box.matchweekSlate().mismatch, null);
  assert.deepEqual([...box.matchweekMismatchLines()], []);
});

test("A10 · the placeholder is readable text and accepts nothing", () => {
  const box = world({ live: leagueState({ code: "AAA", name: "L", ids: [MISSING] }) });
  const html = box.picksView();
  const slot = html.slice(html.indexOf("fixture-row-unavailable"));
  assert.match(slot, /<strong>Fixture temporarily unavailable\.<\/strong>/);
  assert.match(slot, /<span>Pull to refresh\.<\/span>/);
  // Nothing interactive, and above all nothing that could take a prediction.
  for (const control of ["<button", "<input", "<select", "<a ", "data-expand-fixture",
    "data-count-step", "data-lock-pick", "data-match-card", "contenteditable", "tabindex"]) {
    assert.ok(!slot.includes(control), `the placeholder exposes ${control}`);
  }
  // Text, not an aria-label on an empty box — a reader announces the sentences.
  assert.ok(!/aria-label=/.test(slot.slice(0, slot.indexOf("</div>"))));
});

test("A10 · a placeholder, its count and its state cannot cross to another league", () => {
  const broken = leagueState({ code: "AAA", name: "Sunday Six", ids: ["pl-001", MISSING, "pl-002"] });
  const whole = leagueState({ code: "BBB", name: "Bury Legends", ids: ["pl-005", "pl-003"] });

  const onA = world({ active: "AAA", live: broken, cached: { AAA: broken, BBB: whole }, codes: ["AAA", "BBB"] });
  const onB = world({ active: "BBB", live: broken, cached: { AAA: broken, BBB: whole }, codes: ["AAA", "BBB"] });

  const a = onA.picksView();
  const b = onB.picksView();
  assert.equal(slotsOf(a).filter((s) => s.kind === "unavailable").length, 1);
  assert.equal(headerCount(a), 3);

  assert.ok(!b.includes("fixture-row-unavailable"), "AAA's placeholder appeared under BBB");
  assert.ok(!b.includes(MISSING), "AAA's unresolved id appeared under BBB");
  assert.equal(headerCount(b), 2, "AAA's count followed the switch");
  assert.deepEqual(slotsOf(b).map((s) => s.id), ["pl-005", "pl-003"]);
  assert.ok(!b.includes("Sunday Six"));
});
