// v1.6.6 Slice 2 — binding acceptance tests R1-R3, S1, L1, M1, C1, A2, A3.
// Executed, not eyeballed: the card renderers are run and their output asserted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, APP, sourceOf } from "./harness.mjs";
import { scorePick } from "../worker/src/logic.js";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const D3 = ["VOID_STATUSES", "isVoidFixture", "isPostponed", "finalScore", "scorePickLocal",
  "resultState", "RESULT_FIRST_STATES", "isSettledCard", "resultBadge",
  "resultPickLine", "resultCard"];

// A vm-realm object has a different Object.prototype, so deepStrictEqual
// rejects it on identity alone. Compare the values these functions are about.
const plain = (o) => JSON.parse(JSON.stringify(o));

const FUTURE = "2099-05-01T14:00:00Z";
const PAST = "2020-05-01T14:00:00Z";

const fx = (over = {}) => ({
  id: "m1", player1: "Arsenal", player2: "Chelsea", matchday: 7, startAt: PAST, ...over,
});

// --- R1 -------------------------------------------------------------------

test("R1 · the five result states are exactly the pinned set", () => {
  const s = load(D3);
  s.picks = {};
  assert.equal(s.resultState(fx({ startAt: FUTURE })), "pre-match");
  assert.equal(s.resultState(fx()), "started-unsettled");
  assert.equal(s.resultState(fx({ result: [2, 1] })), "completed-no-pick");
  assert.equal(s.resultState(fx({ status: "postponed" })), "void");
  s.picks = { m1: { p1: 1, p2: 1 } };
  assert.equal(s.resultState(fx({ result: [2, 1] })), "completed");
  assert.deepEqual([...s.RESULT_FIRST_STATES].sort(),
    ["completed", "completed-no-pick", "started-unsettled", "void"]);
});

test("R1 · a void fixture carrying a partial score is never shown as a result", () => {
  const s = load(D3);
  s.picks = { m1: { p1: 1, p2: 0 } };
  // Abandoned at 1-0 is not a 1-0 win. Void wins over the score, every time.
  assert.equal(s.resultState(fx({ status: "abandoned", result: [1, 0] })), "void");
  const html = s.resultCard(fx({ status: "abandoned", result: [1, 0] }));
  assert.match(html, /Void — no points/);
  assert.doesNotMatch(html, /FINAL/);
});

test("R1 · a started fixture with no score says so and invents nothing", () => {
  const s = load(D3);
  s.picks = { m1: { p1: 2, p2: 2 } };
  const html = s.resultCard(fx());
  assert.match(html, /Awaiting final score/);
  assert.doesNotMatch(html, /FINAL/);
  // No fabricated scoreline anywhere in the figure.
  assert.match(html, /<div class="result-figure" aria-hidden="true"><span class="result-sep">–<\/span><\/div>/);
});

test("R1 · COMPLETED-NO-PICK carries the exact pinned copy", () => {
  const s = load(D3);
  s.picks = {};
  assert.match(s.resultCard(fx({ result: [3, 0] })), /No pick made · 0 points/);
});

test("R1 · card points match the worker's scoring function on every scoreline", () => {
  const s = load(D3);
  // The full supported range, not a sample: validFootballScore admits 0-9, so
  // 0-4 left three quarters of the space unchecked.
  const MAX = 9;
  let checked = 0;
  let rendered = 0;
  for (let a1 = 0; a1 <= MAX; a1++) for (let a2 = 0; a2 <= MAX; a2++)
    for (let p1 = 0; p1 <= MAX; p1++) for (let p2 = 0; p2 <= MAX; p2++) {
      const mine = s.scorePickLocal({ p1, p2 }, { p1: a1, p2: a2 });
      const theirs = scorePick({ p1, p2 }, { p1: a1, p2: a2 });
      assert.deepEqual(plain(mine), theirs, `pick ${p1}-${p2} v result ${a1}-${a2}`);
      checked++;
    }
  assert.equal(checked, 10000);

  // And the number the card PRINTS is that number. Rendering all ten thousand
  // cards is a minute of string building for no extra coverage, so this walks
  // the diagonal band that produces every distinct outcome instead.
  for (let a1 = 0; a1 <= MAX; a1++) for (let a2 = 0; a2 <= MAX; a2++)
    for (const [p1, p2] of [[a1, a2], [a2, a1], [a1 + 1, a2], [a1, a2 + 1], [0, 0], [MAX, 0]]) {
      if (p1 > MAX || p2 > MAX) continue;
      const theirs = scorePick({ p1, p2 }, { p1: a1, p2: a2 });
      s.picks = { m1: { p1, p2 } };
      const html = s.resultCard(fx({ result: [a1, a2] }));
      const word = theirs.pts === 1 ? "point" : "points";
      assert.ok(html.includes(`>${theirs.pts} ${word}</span>`),
        `card for pick ${p1}-${p2} v ${a1}-${a2} did not print ${theirs.pts}`);
      rendered++;
    }
  assert.ok(rendered >= 500, `only ${rendered} cards rendered`);
  // Every outcome the scorer can return was actually exercised on a card.
  const seen = new Set();
  for (let a1 = 0; a1 <= MAX; a1++) for (let a2 = 0; a2 <= MAX; a2++)
    for (const [p1, p2] of [[a1, a2], [a2, a1], [a1 + 1, a2], [a1, a2 + 1], [0, 0], [MAX, 0]]) {
      if (p1 > MAX || p2 > MAX) continue;
      seen.add(scorePick({ p1, p2 }, { p1: a1, p2: a2 }).pts);
    }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 5]);
});

test("R1 · no pick and a void fixture both score zero, as the worker does", () => {
  const s = load(D3);
  assert.deepEqual(plain(s.scorePickLocal(null, { p1: 1, p2: 0 })),
    scorePick(null, { p1: 1, p2: 0 }));
  assert.deepEqual(plain(s.scorePickLocal({ p1: 1, p2: 0 }, { p1: 1, p2: 0 }, true)),
    scorePick({ p1: 1, p2: 0 }, { p1: 1, p2: 0 }, true));
});

test("R1 · the result card drops every pre-match element", () => {
  const s = load(D3);
  s.picks = { m1: { p1: 1, p2: 0 } };
  const html = s.resultCard(fx({ result: [1, 0], broadcaster: "Sky", venue: "Emirates" }));
  for (const gone of ["score-picker", "lock-pick-button", "probability", "form-guide",
    "match-intel-strip", "fixture-calendar", "Emirates", "Sky", "pick-lock-card"]) {
    assert.ok(!html.includes(gone), `settled card still renders ${gone}`);
  }
});

test("R1 · all three named surfaces route through the one result-first path", () => {
  // My Picks, expanded Schedule rows, and the Weekly fixture rows.
  // My Picks also hands the card the section it was drawn in, so its reveal
  // can answer for that league and week rather than the active one.
  assert.match(sourceOf("pickEntry"), /matchCard\(fixture, \{ resultFirst: true, reveal \}\)/);
  assert.match(sourceOf("fixtureRow"), /matchCard\(fixture, \{ resultFirst: true \}\)/);
  assert.match(sourceOf("expandFixture"), /matchCard\(fixture, \{ resultFirst: true \}\)/);
  assert.match(sourceOf("matchCard"), /if \(resultFirst && isSettledCard\(match\)\) return resultCard\(match, reveal\);/);
});

test("R1 · D3 has exactly two surfaces, and Weekly is not one of them", () => {
  // League -> Weekly had no fixture card to restyle. Adding one would have been
  // a second fixture surface, not a treatment: Weekly stays banner + standings.
  assert.ok(!APP.includes("weeklyFixtureCards"), "the invented Weekly list is back");
  const fill = sourceOf("fillPanelProgressively");
  const weekly = fill.slice(fill.indexOf('if (tab === "matchday")'));
  assert.match(weekly, /\$\{roundBanner\(roundState\)\}\$\{roundTableHtml\(roundState\)\}/);
  assert.ok(!weekly.includes("fixtureRow"), "Weekly grew a fixture list");
  assert.ok(!weekly.includes("matchCard"), "Weekly grew a fixture card");
});

// --- R2 -------------------------------------------------------------------

test("R2 · Next never asks for the result-first treatment", () => {
  const today = sourceOf("todayView");
  assert.match(today, /due\.map\(matchCard\)/);
  assert.ok(!today.includes("resultFirst"), "Next opted into settled cards");
  // And Next only ever holds open fixtures anyway.
  assert.match(today, /matchOpen\(fixture\) && !picks\[fixture\.id\]/);
});

test("R2 · matchCard is unchanged for every caller that does not opt in", () => {
  const s = load([...D3, "matchOpen", "matchCard", "scorePicker", "pickStatus",
    "resultText"], {
    calendarLink: () => ({ href: "", download: "" }),
    matchIntelStrip: () => "<intel>",
    probabilityStrip: () => "<prob>",
    formGuide: () => "<form>",
    matchTime: () => "15:00",
    closedStatus: () => false,
  });
  s.picks = { m1: { p1: 1, p2: 0 } };
  const settled = fx({ result: [1, 0] });
  const bare = s.matchCard(settled);
  assert.equal(bare, s.matchCard(settled, {}), "default options changed the render");
  assert.ok(bare.includes("<intel>") && bare.includes("<prob>") && bare.includes("<form>"),
    "the non-opted-in path lost its pre-match furniture");
  assert.notEqual(bare, s.matchCard(settled, { resultFirst: true }));
});

test("R2 · Mates' Picks keeps its own card treatment", () => {
  assert.ok(!sourceOf("matesFixtureCard").includes("resultFirst"));
  assert.ok(!sourceOf("matesCardBody").includes("resultCard"));
  assert.ok(!sourceOf("matesMatrix").includes("resultCard"));
});

// --- R3 -------------------------------------------------------------------

test("R3 · the mates' reveal stays reachable on a settled card", () => {
  const s = load(D3, { fixtureRevealSection: () => `<section class="fixture-reveal">R</section>` });
  s.picks = { m1: { p1: 1, p2: 0 } };
  for (const over of [{ result: [1, 0] }, { status: "postponed" }, {}]) {
    assert.match(s.resultCard(fx(over)), /class="fixture-reveal"/);
  }
  // Both branches: the Schedule's current-round reveal, and My Picks' own
  // league-and-week one. A settled card is never left without either.
  assert.match(sourceOf("resultCard"),
    /\$\{reveal \? pickRevealSection\(match, reveal\) : fixtureRevealSection\(match\)\}/);
  const withContext = load(D3, {
    fixtureRevealSection: () => "<section class=\"fixture-reveal\">CURRENT</section>",
    pickRevealSection: () => "<section class=\"fixture-reveal pick-reveal\">OWN</section>",
  });
  withContext.picks = { m1: { p1: 1, p2: 0 } };
  const own = withContext.resultCard(fx({ result: [1, 0] }), { code: "AAA", period: "1" });
  assert.match(own, /pick-reveal/, "a My Picks card did not use its own league's reveal");
  assert.ok(!own.includes("CURRENT"), "a My Picks card fell back to the active league");
});

// --- S1 -------------------------------------------------------------------

test("S1 · the schedule union deduplicates a fixture two leagues both picked", () => {
  const s = load(["leagueSlateFixtureIds"]);
  const ids = s.leagueSlateFixtureIds([
    { code: "AAA", lineup: new Set(["m1", "m2"]) },
    { code: "BBB", lineup: new Set(["m2", "m3"]) },
  ]);
  assert.deepEqual([...ids].sort(), ["m1", "m2", "m3"]);
  assert.equal(ids.size, 3, "a shared fixture appeared twice");
});

test("S1 · the union is empty for a viewer with no leagues", () => {
  const s = load(["leagueSlateFixtureIds"]);
  assert.equal(s.leagueSlateFixtureIds([]).size, 0);
});

test("S1 · no leagues gets All Fixtures with no toggle and no explanation", () => {
  const view = sourceOf("scheduleView");
  const noLeagues = view.slice(view.indexOf("if (!hasLeagues)"), view.indexOf("const slateIds"));
  assert.ok(!noLeagues.includes("scheduleScopeToggle"));
  assert.ok(!noLeagues.includes("data-schedule-scope"));
  assert.match(noLeagues, /groupedPeriods\(inWindow, current\)/);
});

test("S1 · joined-but-unpublished explains itself and never silently falls back", () => {
  const view = sourceOf("scheduleView");
  assert.match(view, /const unpublished = scoping && !scoped\.length;/);
  // Exact pinned wording.
  assert.match(view, /<strong>No league fixtures selected yet\.<\/strong>/);
  assert.match(view, /<p>Your league fixtures will appear here when this week's line-up is published\.<\/p>/);
  assert.match(view, /data-schedule-scope="all">View all fixtures<\/button>/);
  // The list stays scoped while the notice is up: it does not quietly widen.
  assert.match(view, /const list = scoping \? scoped : inWindow;/);
});

test("S1 · the union is taken inside the visible window, never the whole season", () => {
  const view = sourceOf("scheduleView");
  assert.ok(view.indexOf("const inWindow") < view.indexOf("const scoped"));
  assert.match(view, /const scoped = inWindow\.filter\(\(fixture\) => slateIds\.has\(String\(fixture\.id\)\)\);/);
});

test("S1 · Show full season is unchanged", () => {
  assert.match(APP, /data-full-season>Show full season/);
  assert.match(sourceOf("scheduleWindow"), /if \(scheduleFullSeason \|\| matchdayFilter !== "all"\) return periods;/);
});

// --- L1 -------------------------------------------------------------------

test("L1 · the table and segments come before administration", () => {
  const view = sourceOf("leagueView");
  const card = view.slice(view.indexOf('<section class="league-card">'));
  assert.ok(card.indexOf("roundToggle()") < card.indexOf("${inner}"));
  assert.ok(card.indexOf("${inner}") < card.indexOf("leagueSettings(state, isOwner)"));
  for (const admin of ["data-share-league", "data-league-nick", "data-delete-league",
    "weeklyCountControl", "league-code"]) {
    assert.ok(!card.includes(admin), `${admin} is still above the table`);
  }
});

test("L1 · the collapse holds exactly the five administrative controls", () => {
  const settings = sourceOf("leagueSettings");
  for (const control of ["league-code", "data-share-league", "data-league-nick",
    "weeklyCountControl", "data-delete-league"]) {
    assert.ok(settings.includes(control), `League settings is missing ${control}`);
  }
  // Deadline-bound line-up control is NOT administration.
  assert.ok(!settings.includes("slate-slot"));
  assert.ok(!settings.includes("hostSlateControl"));
  assert.ok(!settings.includes("data-open-picker"));
});

test("L1 · Edit line-up and its deadline stay next to Weekly", () => {
  const view = sourceOf("leagueView");
  const card = view.slice(view.indexOf('<section class="league-card">'));
  assert.ok(card.indexOf("roundToggle()") < card.indexOf("slate-slot"));
  assert.ok(card.indexOf("slate-slot") < card.indexOf("${inner}"));
  assert.match(sourceOf("hostSlateControl"), /Edit line-up/);
  assert.match(sourceOf("hostSlateControl"), /lockLine\(slate\)/);
});

test("L1 · the collapse state is remembered", () => {
  assert.match(APP, /leagueSettings: "prem_oracle_league_settings",/);
  assert.match(APP, /let leagueSettingsOpen = readJSON\(STORAGE\.leagueSettings, false\) === true;/);
  assert.match(APP, /leagueSettingsOpen = settings\.open;/);
  assert.match(APP, /localStorage\.setItem\(STORAGE\.leagueSettings, JSON\.stringify\(leagueSettingsOpen\)\)/);
  assert.match(sourceOf("leagueSettings"), /\$\{open \? " open" : ""\}/);
});

// --- M1 -------------------------------------------------------------------

test("M1 · the member sees the waiting copy and no action", () => {
  const s = load(["matesAwaitingSlate"], { isLeagueHost: () => false });
  const html = s.matesAwaitingSlate(7);
  assert.match(html, /Waiting for the host to select this week's fixtures\./);
  assert.ok(!html.includes("data-open-picker"));
});

test("M1 · the host sees host copy and the Select fixtures action", () => {
  const s = load(["matesAwaitingSlate"], { isLeagueHost: () => true });
  const html = s.matesAwaitingSlate(7);
  assert.match(html, /Waiting for you to select this week's fixtures\./);
  assert.match(html, /data-open-picker="7">Select fixtures</);
});

test("M1 · no published slate means no cards are built at all", () => {
  const fill = sourceOf("fillPanelProgressively");
  const guard = fill.indexOf("if (!slateForPeriod(matesState?.period))");
  assert.ok(guard > 0, "no pre-publication guard");
  assert.ok(guard < fill.indexOf("const matrix = matesMatrix(matesState);"),
    "the matrix is built before the guard runs");
  assert.ok(guard < fill.indexOf("matesFixtureCard"));
});

test("M1 · after publication only the slate's fixtures render", () => {
  const matrix = sourceOf("matesMatrix");
  assert.match(matrix, /slateForPeriod\(state\?\.period\)\?\.fixtureIds\?\.map\(String\)/);
});

// --- C1 -------------------------------------------------------------------

test("C1 · the Rules card reads the neutral sentence", () => {
  const rules = sourceOf("rulesView");
  assert.match(rules, /Predict the <strong>final scoreline<\/strong> for each fixture selected for your league\./);
  assert.ok(!rules.includes("final Premier League scoreline"));
});

test("C1 · no store metadata is touched by the binary", () => {
  // The listing lives outside the repo; what the binary must not do is carry a
  // competition name into the one card the 4.1(a) correction was about.
  const rules = sourceOf("rulesView");
  const firstBullet = rules.slice(rules.indexOf("<li>"), rules.indexOf("</li>"));
  for (const name of ["Premier League", "Champions League", "Championship", "Sky", "TNT", "BBC"]) {
    assert.ok(!firstBullet.includes(name), `${name} is back in the Rules sentence`);
  }
});

// --- A2 -------------------------------------------------------------------

test("A2 · both collapses are real disclosure widgets, keyboard-operable", () => {
  // <details>/<summary> is focusable and toggles on Enter and Space natively,
  // and exposes expanded/collapsed to assistive tech without an aria dance.
  assert.match(sourceOf("leagueSettings"), /<details class="league-settings" data-league-settings/);
  assert.match(sourceOf("leagueSettings"), /<summary class="league-settings-head">/);
  assert.match(sourceOf("pickSection"), /<details class="pick-section"/);
  assert.match(sourceOf("pickSection"), /<summary class="pick-section-head">/);
});

test("A2 · the collapse chevron is not the only cue and respects reduced motion", () => {
  assert.match(CSS, /\.league-settings\[open\] > \.league-settings-head::after \{ transform: rotate\(180deg\); \}/);
  // Joined, so a later reduced-motion block cannot hide this rule from the test.
  const reduced = CSS.split("@media (prefers-reduced-motion: reduce)")
    .slice(1).map((block) => block.slice(0, block.indexOf("\n}"))).join("\n");
  assert.match(reduced, /\.league-settings-head::after \{ transition: none; \}/);
});

// --- A3 -------------------------------------------------------------------

test("A3 · the large score carries accessible text and is not read twice", () => {
  const s = load(D3);
  s.picks = { m1: { p1: 1, p2: 0 } };
  const html = s.resultCard(fx({ result: [3, 1] }));
  assert.match(html, /aria-label="Arsenal 3, Chelsea 1, final score"/);
  // The decorative figure is hidden so a screen reader gets the sentence, not "3 – 1".
  assert.match(html, /<div class="result-figure" aria-hidden="true">/);
});

test("A3 · void and unsettled states have their own accessible sentences", () => {
  const s = load(D3);
  s.picks = {};
  assert.match(s.resultCard(fx({ status: "postponed" })),
    /aria-label="Arsenal against Chelsea, void, no points"/);
  assert.match(s.resultCard(fx()),
    /aria-label="Arsenal against Chelsea, awaiting final score"/);
  assert.match(s.resultCard(fx({ status: "abandoned", result: [2, 2] })),
    /aria-label="Arsenal 2, Chelsea 2, void"/);
});

test("A3 · FINAL is a status, not a colour", () => {
  const s = load(D3);
  s.picks = {};
  assert.match(s.resultBadge("completed"), /role="status"/);
  assert.match(s.resultBadge("completed"), /FINAL/);
  assert.match(s.resultBadge("void"), /VOID/);
  assert.match(s.resultBadge("started-unsettled"), /IN PLAY/);
});

test("R1 · the client's void list is the worker's, and postponed is separate", async () => {
  const s = load(D3);
  const { isVoided } = await import("../worker/src/logic.js");
  for (const status of ["walkover", "retired", "cancelled", "abandoned",
    "postponed", "scheduled", "live", ""]) {
    assert.equal(s.isVoidFixture({ status }), isVoided({ status }),
      `client and worker disagree on "${status}"`);
  }
  assert.equal(s.isVoidFixture({ void: true }), isVoided({ void: true }));
  // Postponed is void to the VIEWER (no points, no result to show) but is not
  // the worker's void, because D7 must be able to tell them apart.
  assert.equal(s.isPostponed({ status: "postponed" }), true);
  assert.equal(s.isVoidFixture({ status: "postponed" }), false);
  s.picks = {};
  assert.equal(s.resultState({ id: "m1", status: "postponed" }), "void");
});
