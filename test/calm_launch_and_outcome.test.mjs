// v1.9 §2 — a calm cold launch — and §3 — your pick and points on finished rows.
//
// §2. Opening from closed painted "Fixture temporarily unavailable. Pull to
//     refresh." on every row and "Waiting on your host to publish…" above them,
//     for the second or two before the fixture list arrived. Now: the shape of
//     the week until the first load resolves, one card on a genuine failure,
//     and "waiting on your host" only once the server has said so.
// §3. A finished collapsed row carries "You 2-2" and a pill, from the existing
//     scoring port; every other row, and every expanded card, is unchanged.
//
// These run the REAL picksView / pickRow / pickRowOutcome / pickRowLabel /
// picksLoadPhase over a mounted DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, constOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const HOUR = 3600000;
const now = Date.now();
const fx = (id, { hours = 24, result = null, status = null, teams = ["Arsenal", "Coventry City"] } = {}) => ({
  id, player1: teams[0], player2: teams[1], matchday: 13,
  startAt: new Date(now + hours * HOUR).toISOString(),
  ...(result ? { result, status: status || "complete" } : status ? { status } : {}),
});

const OPEN = fx("f-open", { hours: 48, teams: ["Leeds United", "Coventry City"] });
const LOCKED = { ...fx("f-locked", { hours: 3, teams: ["Manchester United", "Brentford"] }), lockAt: new Date(now - HOUR).toISOString() };
// Kicked off, or full time with no result in the feed yet: "Pending", no pill.
const PENDING = fx("f-pending", { hours: -2, teams: ["Everton", "Liverpool"] });
const EXACT = fx("f-exact", { hours: -26, result: [2, 2], teams: ["Fulham", "AFC Bournemouth"] });
const RESULT = fx("f-result", { hours: -26, result: [3, 1], teams: ["Chelsea", "Brentford"] });
const MISS = fx("f-miss", { hours: -26, result: [0, 1], teams: ["Wolverhampton Wanderers", "Sunderland"] });
const NO_PICK = fx("f-nopick", { hours: -26, result: [1, 0], teams: ["Aston Villa", "Crystal Palace"] });
const VOID = fx("f-void", { hours: -26, status: "abandoned", teams: ["Sunderland", "Tottenham Hotspur"] });
const POSTPONED = fx("f-post", { hours: -26, status: "postponed", teams: ["Arsenal", "Manchester City"] });
const ALL = [OPEN, LOCKED, PENDING, EXACT, RESULT, MISS, NO_PICK, VOID, POSTPONED];
const PICKS = {
  [OPEN.id]: { p1: 1, p2: 0 }, [LOCKED.id]: { p1: 2, p2: 1 }, [PENDING.id]: { p1: 1, p2: 1 },
  [EXACT.id]: { p1: 2, p2: 2 }, [RESULT.id]: { p1: 1, p2: 0 }, [MISS.id]: { p1: 2, p2: 0 },
  [VOID.id]: { p1: 0, p2: 0 }, [POSTPONED.id]: { p1: 1, p2: 2 },
};

const NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable",
  "matchweekRowState", "MATCHWEEK_ROW_LINE",
  "shortKickoff", "closedStatus", "matchOpen", "finalScore",
  "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickActionSummary", "pickCounts", "launchBranch", "pickRow", "pickRowKickoff", "pickRowMark",
  "pickRowOutcome", "pickRowBody", "pickRowLabel", "PICK_SAVED_MS", "pickJustSaved", "pickListState",
  "pickShareRow", "pickDeadlineLine", "expandPick", "pickEditable", "picksLoadPhase",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "scorePickLocal", "RESULT_FIRST_STATES",
  "TEAM_MARKERS", "TEAM_CODES", "teamInitials", "teamCode", "teamBadge",
];

const slateState = (ids, extra = {}) => ({ code: "AAA", name: "Burtons Premier", currentPeriod: "13",
  currentSlate: { period: "13", matchweek: 13, status: "published", fixtureIds: ids, count: ids.length },
  table: [], owner: "u-me", ...extra });

function mounted({ picks = PICKS, fixtures = ALL, ids = ALL.map((f) => f.id), state = slateState(ids),
  fixturesStatus = "ready", confirmed = ["AAA"], failed = [], timedOut = false, preseason = false,
  shape = undefined, stored = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body><main id="app"></main></body>`);
  const { document } = dom.window;
  const b = load(shape === undefined ? NAMES : [...NAMES, "rememberWeekShape", "weekShapeFor"], {
    ...(shape === undefined ? {} : {
      weekShape: shape, STORAGE: { weekShape: "ws" },
      localStorage: { setItem: (k, v) => { if (stored) stored.push([k, v]); } },
    }),
    picks, fixtures, document,
    API: "https://api.test",
    fixturesStatus,
    confirmedLeagues: new Set(confirmed),
    leagueLoadFailed: new Set(failed),
    picksLoadTimedOut: timedOut,
    leagueNames: { AAA: "Burtons Premier" },
    expandedPickId: null,
    activeLeague: "AAA",
    leagueState: state,
    leagueStates: {},
    leagueCodes: ["AAA"],
    shareIconButton: () => "",
    matchweekCountMismatches: new Map(),
    periodLabel: (p) => `Matchweek ${p}`,
    pulsingStatus: (m) => `<p class="pulse">${m}</p>`,
    picksDue: () => [],
    periodOfFixture: (f) => (f?.matchday == null ? null : String(f.matchday)),
    installNotice: () => "",
    slateNotice: () => "",
    preseasonState: () => "<div data-preseason>PRESEASON</div>",
    launchBranch: () => (preseason ? "preseason" : "season"),
    inviteCode: "",
    onboardingState: () => "",
    leagueSwitcher: () => "",
    playerName: "Adam",
    matchCard: (m) => `<article class="match-card" data-match-card="${m.id}"></article>`,
    fixtureRevealSection: (m) => `<section data-reveal="${m.id}">MATES</section>`,
    countPhrase: (n, word) => `${n} ${word}`,
    uid: () => "u-me",
  });
  const paint = () => { document.getElementById("app").innerHTML = b.picksView(); };
  paint();
  const text = () => document.getElementById("app").textContent.replace(/\s+/g, " ");
  const row = (id) => document.querySelector(`[data-pick-row="${id}"]`);
  return { box: b, document, paint, text, row };
}

const ERROR_WORDS = /temporarily unavailable|Pull to refresh|Waiting on your host|Couldn.t load|No league fixtures selected|went wrong|error/i;

// --- §2 · skeleton until the first load resolves -------------------------------

test("cold launch · a cached slate paints its own shape, with no error words, until fixtures arrive", () => {
  const ids = [OPEN.id, LOCKED.id, EXACT.id, RESULT.id, MISS.id, NO_PICK.id];
  const app = mounted({ ids, fixtures: [], fixturesStatus: "loading", confirmed: [] });
  const skeletons = app.document.querySelectorAll("[data-pick-skeleton]");
  assert.equal(skeletons.length, 6, "one skeleton per published slot");
  assert.doesNotMatch(app.text(), ERROR_WORDS);
  assert.equal(app.document.querySelectorAll(".fixture-row-unavailable").length, 0);
  // Each skeleton is the real row's own grid: date block, two grey circles, score block.
  for (const s of skeletons) {
    assert.ok(s.matches(".pick-row") && s.getAttribute("aria-hidden") === "true");
    const head = s.querySelector(":scope > .pick-row-head");
    assert.deepEqual([...head.children].map((c) => c.className), ["pick-row-when", "pick-row-match", "pick-row-mark"]);
    assert.equal(head.querySelectorAll(".pick-row-when .skeleton-bar").length, 2);
    assert.equal(head.querySelectorAll(".pick-row-match .skeleton-circle").length, 2);
    assert.equal(head.querySelectorAll(".pick-row-mark .skeleton-bar").length, 1);
  }
  // The subtitle is grey lines; a screen reader hears that the week is loading.
  const summary = app.document.querySelector("[data-pick-summary]");
  assert.ok(summary.classList.contains("pick-skeleton-lines"));
  assert.equal(summary.querySelectorAll(".skeleton-bar").length, 2);
  assert.equal(summary.querySelector(".sr-only").textContent, "Loading this week…");
  assert.equal(app.document.querySelector("[data-pick-list]").getAttribute("aria-busy"), "true");

  // The fixtures land: the same six slots, now real rows, in the same order, and still no error words.
  app.box.fixtures = ALL;
  app.box.fixturesStatus = "ready";
  app.paint();
  assert.equal(app.document.querySelectorAll("[data-pick-skeleton]").length, 0);
  assert.deepEqual([...app.document.querySelectorAll("[data-pick-row]")].map((r) => r.dataset.pickRow), ids);
  assert.doesNotMatch(app.text(), ERROR_WORDS);
  assert.match(app.document.querySelector("[data-pick-summary]").textContent, /prediction/);
});

test("cold launch · nothing cached at all is still skeleton, not 'Loading' prose or an error", () => {
  const app = mounted({ state: null, fixtures: [], fixturesStatus: "loading", confirmed: [] });
  assert.equal(app.document.querySelectorAll("[data-pick-skeleton]").length, 3);
  assert.doesNotMatch(app.text().replace("Loading this week…", ""), /Loading/);
  assert.doesNotMatch(app.text(), ERROR_WORDS);
});

test("'Waiting on your host' only once the server has said nothing is published", () => {
  const unpublished = slateState([], { currentSlate: null });
  // A cached "nothing published" may be stale — the host can have published since.
  const cold = mounted({ state: unpublished, confirmed: [] });
  assert.doesNotMatch(cold.text(), /Waiting on your host|No league fixtures selected/);
  assert.equal(cold.document.querySelectorAll("[data-pick-skeleton]").length, 3);
  // The server confirms it.
  cold.box.confirmedLeagues.add("AAA");
  cold.paint();
  assert.match(cold.text(), /Waiting on your host to publish this week’s fixtures/);
  assert.match(cold.text(), /No league fixtures selected yet\./);
  assert.equal(cold.document.querySelectorAll("[data-pick-skeleton]").length, 0);
  // Pre-season is the same rule.
  const pre = mounted({ state: unpublished, confirmed: [], preseason: true });
  assert.equal(pre.document.querySelector("[data-preseason]"), null);
  // A published week this device cannot name has been published: the host is not to blame.
  assert.equal(load(["pickActionSummary", "pickCounts", "matchOpen", "closedStatus", "clientLockMs"], {})
    .pickActionSummary([{ id: "x", fixture: null }]), "");
});

// --- §2 · one card on a genuine failure -----------------------------------------

const oneCard = (app) => {
  const cards = app.document.querySelectorAll("[data-picks-load-failed]");
  assert.equal(cards.length, 1, `${cards.length} failure cards`);
  const card = cards[0];
  assert.equal(card.querySelector("strong").textContent, "Couldn’t load your picks");
  assert.equal(card.querySelector("p").textContent, "Check your connection, then pull down to try again. Your saved picks are safe.");
  const retry = card.querySelector("button[data-retry-picks]");
  assert.equal(retry.textContent, "Try again");
  assert.equal(card.getAttribute("role"), "status");
  assert.equal(app.document.querySelectorAll("[data-pick-row], [data-pick-skeleton], .fixture-row-unavailable").length, 0,
    "a failure painted rows as well as the card");
  assert.doesNotMatch(app.text(), /Waiting on your host|temporarily unavailable/);
};

test("genuine failure · the fixture list could not be read at all", () => {
  oneCard(mounted({ fixtures: [], fixturesStatus: "failed" }));
});

test("genuine failure · the league read failed with nothing cached (offline, server error)", () => {
  oneCard(mounted({ state: null, fixtures: [], fixturesStatus: "ready", confirmed: [], failed: ["AAA"] }));
  // A cached "nothing published" that the server could not confirm is a failure too, not a claim.
  oneCard(mounted({ state: slateState([], { currentSlate: null }), confirmed: [], failed: ["AAA"] }));
});

test("genuine failure · a load nobody would wait for (timeout)", () => {
  oneCard(mounted({ fixtures: [], fixturesStatus: "loading", timedOut: true }));
  oneCard(mounted({ state: null, fixtures: [], fixturesStatus: "loading", confirmed: [], timedOut: true }));
});

test("a failed refresh with a usable cache keeps the rows — the card is for when there is nothing to show", () => {
  const app = mounted({ confirmed: [], failed: ["AAA"] });
  assert.equal(app.document.querySelectorAll("[data-picks-load-failed]").length, 0);
  assert.equal(app.document.querySelectorAll("[data-pick-row]").length, ALL.length);
});

test("the load bookkeeping: confirmed by any server answer, failed only by a real failure, retried by 'Try again'", () => {
  const loader = sourceOf("loadLeagueState");
  assert.match(loader, /confirmedLeagues\.add\(requested\);\s*\n\s*leagueLoadFailed\.delete\(requested\);/);
  assert.match(loader, /if \(!\/league not found\/i\.test\(error\.message\)\) leagueLoadFailed\.add\(requested\);\s*\n\s*if \(superseded\(\)\) return;/);
  assert.match(sourceOf("prefetchLeagueStates"), /confirmedLeagues\.add\(state\.code\)/);
  assert.match(sourceOf("hydrateIdentity"), /catch \{[\s\S]*leagueLoadFailed\.add\(activeLeague\)/);
  const fixtures = sourceOf("loadFixtures");
  assert.match(fixtures, /if \(competitions\.join\("\+"\) !== loadedCompetition\) fixturesStatus = "loading";/);
  assert.match(fixtures, /fixturesStatus = "ready";/);
  assert.match(fixtures, /fixturesStatus = "failed";/);
  // The deadline is armed before the first paint, and "Try again" is wired to the retry.
  assert.ok(APP.indexOf("\narmPicksLoadTimeout();\n") > 0
    && APP.indexOf("\narmPicksLoadTimeout();\n") < APP.indexOf("Promise.all([loadFixtures(), hydrateIdentity()])"));
  assert.match(APP, /if \(event\.target\.closest\("\[data-retry-picks\]"\)\) \{ retryPicksLoad\(\); return; \}/);
  assert.match(sourceOf("retryPicksLoad"), /leagueLoadFailed\.clear\(\);[\s\S]*picksLoadTimedOut = false;[\s\S]*hydrateIdentity\(\)/);
  assert.match(constOf("PICKS_LOAD_TIMEOUT_MS"), /= 15000;/);
});

test("the load phase, as a table", () => {
  const phase = (stubs, state = { code: "AAA" }) => load(["picksLoadPhase"], {
    API: "x", activeLeague: "AAA", confirmedLeagues: new Set(), leagueLoadFailed: new Set(), picksLoadTimedOut: false, ...stubs,
  }).picksLoadPhase(state);
  assert.equal(phase({}), "loading");
  assert.equal(phase({ confirmedLeagues: new Set(["AAA"]) }), "ready");
  assert.equal(phase({ leagueLoadFailed: new Set(["AAA"]) }), "failed");
  assert.equal(phase({ picksLoadTimedOut: true }), "failed");
  assert.equal(phase({ confirmedLeagues: new Set(["AAA"]), picksLoadTimedOut: true }), "ready", "a late answer still wins");
  assert.equal(phase({ leagueLoadFailed: new Set(["BBB"]) }), "loading", "another league's failure is not this one's");
  assert.equal(phase({ API: null }), "ready");
});

// --- §3 · your pick and its points -----------------------------------------------

const outcome = (app, id) => app.row(id).querySelector("[data-pick-outcome]");

test("FT rows: exact, right result, miss and no pick — each its own pill", () => {
  const app = mounted();
  const exact = outcome(app, EXACT.id);
  assert.equal(exact.dataset.pickOutcome, "exact");
  assert.equal(exact.querySelector(".pick-row-you").textContent, "You 2-2");
  assert.equal(exact.querySelector(".pick-pill").textContent, "+5 exact");
  assert.ok(exact.querySelector(".pick-pill").classList.contains("pick-pill-exact"));

  const result = outcome(app, RESULT.id);
  assert.equal(result.dataset.pickOutcome, "result");
  assert.equal(result.querySelector(".pick-row-you").textContent, "You 1-0");
  assert.equal(result.querySelector(".pick-pill").textContent, "+1");

  const miss = outcome(app, MISS.id);
  assert.equal(miss.dataset.pickOutcome, "miss");
  assert.equal(miss.querySelector(".pick-row-you").textContent, "You 2-0");
  assert.equal(miss.querySelector(".pick-pill").textContent, "0");

  const none = outcome(app, NO_PICK.id);
  assert.equal(none.dataset.pickOutcome, "none");
  assert.equal(none.querySelector(".pick-row-you"), null, "'You' with no pick");
  assert.equal(none.querySelector(".pick-pill").textContent, "No pick");

  // It sits under the score and "FT", inside the one disclosure, hidden from the
  // accessibility tree — the row's name says it in words.
  for (const id of [EXACT.id, RESULT.id, MISS.id, NO_PICK.id]) {
    const head = app.row(id).querySelector("[data-expand-pick]");
    assert.ok(head.contains(outcome(app, id)));
    assert.equal(outcome(app, id).getAttribute("aria-hidden"), "true");
    assert.equal(app.row(id).querySelector("[data-row-mark]").textContent, `${app.box.finalScore(fixtureOf(id)).join("-")}FT`);
  }
});
const fixtureOf = (id) => ALL.find((f) => f.id === id);

test("the pill's points are the scoring port's, for every pick against every result", () => {
  const b = mounted().box;
  for (let a = 0; a <= 3; a++) for (let h = 0; h <= 3; h++) for (let x = 0; x <= 3; x++) for (let y = 0; y <= 3; y++) {
    const match = { id: "m", result: [a, h] };
    const html = b.pickRowOutcome(match, { p1: x, p2: y }, "settled");
    const { pts, exact, hit } = b.scorePickLocal({ p1: x, p2: y }, { p1: a, p2: h });
    const pill = new JSDOM(html).window.document.querySelector(".pick-pill").textContent;
    assert.equal(pill, exact ? `+${pts} exact` : hit ? `+${pts}` : "0", `${x}-${y} on ${a}-${h}`);
  }
  // No scoring of its own: it calls the port and nothing else does arithmetic.
  assert.match(sourceOf("pickRowOutcome"), /scorePickLocal\(pick, \{ p1: actual\[0\], p2: actual\[1\] \}\)/);
  assert.doesNotMatch(sourceOf("pickRowOutcome"), /pts\s*[+\-*]=|=== 5|=== 2/);
});

test("open, locked, pending, void and postponed rows carry no pick line", () => {
  const app = mounted();
  for (const f of [OPEN, LOCKED, PENDING, VOID, POSTPONED]) {
    assert.equal(outcome(app, f.id), null, `${f.id} has a pick line`);
    assert.equal(app.row(f.id).querySelectorAll(".pick-pill").length, 0);
  }
  assert.equal(app.row(PENDING.id).querySelector("[data-row-mark]").textContent, "Pending");
});

test("VoiceOver: the row's name says the pick and the points in words", () => {
  const app = mounted();
  const label = (id) => app.row(id).querySelector("[data-expand-pick]").getAttribute("aria-label");
  assert.match(label(EXACT.id), /, final score 2-2, your pick 2-2, 5 points, exact score$/);
  assert.match(label(RESULT.id), /, final score 3-1, your pick 1-0, 1 point$/);
  assert.match(label(MISS.id), /, final score 0-1, your pick 2-0, 0 points$/);
  assert.match(label(NO_PICK.id), /, final score 1-0, no pick$/);
  assert.match(label(PENDING.id), /your prediction 1-1, result pending$/);
});

test("the expanded card is unchanged: the result card's own line, not the pill", () => {
  const app = mounted();
  app.box.expandedPickId = EXACT.id;
  app.paint();
  const body = app.row(EXACT.id).querySelector(".pick-row-body");
  assert.match(body.textContent, /Your pick 2-2 · 5 points · exact/);
  assert.equal(body.querySelectorAll(".pick-pill").length, 0);
});

test("display only: scoring, settlement, the table and the exports never see it", () => {
  for (const fn of ["scorePickLocal", "resultPickLine", "resultCard"]) {
    assert.doesNotMatch(sourceOf(fn), /pickRowOutcome|pick-pill/, fn);
  }
  const uses = APP.split("pickRowOutcome(").length - 1;
  assert.equal(uses, 2, "the pill is built somewhere other than the row");   // its definition + pickRow
  // Every "pick-pill" in the app is inside the row's builder — none in a share card, an export or the table.
  const count = (src) => src.split("pick-pill").length - 1;
  assert.equal(count(APP), count(sourceOf("pickRowOutcome")));
});

test("320pt: the line spans the whole row and never wraps; the pills use the approved colours", () => {
  const rule = (sel) => {
    const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `no rule for ${sel}`);
    return m[2];
  };
  const line = rule(".pick-row-outcome");
  assert.match(line, /grid-column: 1 \/ -1;/);
  assert.match(line, /justify-self: end;/);
  assert.match(line, /white-space: nowrap;/);
  assert.match(rule(".pick-pill-exact"), /background: #DFF7E9; color: #0B6B3A;/);
  assert.match(rule(".pick-pill-result"), /background: #EFE6F3; color: #420A42;/);
  assert.match(CSS, /\.pick-pill-miss,\s*\n\.pick-pill-none \{ background: #EEF0F3; color: #5A6478; \}/);
});

// --- §2 · the skeleton is the size of the screen it becomes ---------------------

test("a cold launch's skeleton is the last screen's shape: its rows, its finished rows, its header lines", () => {
  const ids = [OPEN.id, PENDING.id, EXACT.id, RESULT.id, NO_PICK.id];
  // A loaded paint remembers the week's shape — once, not on every paint.
  const stored = [];
  const seen = mounted({ ids, shape: null, stored });
  seen.paint();
  assert.equal(stored.length, 1, "a repaint of the same screen wrote storage again");
  const shape = JSON.parse(stored[0][1]);
  assert.equal(stored[0][0], "ws");
  assert.deepEqual(shape.rows, [false, false, true, true, true]);
  assert.equal(shape.code, "AAA");
  assert.equal(shape.period, "13");
  const head = seen.document.querySelector(".section-head");
  assert.equal(shape.summary, head.querySelector("[data-pick-summary]").textContent);
  assert.equal(shape.detail, head.querySelector(".pick-detail").textContent);

  // Next launch, fixtures still on their way: the same rows, finished ones a line taller.
  const cold = mounted({ ids, fixtures: [], fixturesStatus: "loading", confirmed: [], shape });
  const rows = [...cold.document.querySelectorAll("[data-pick-skeleton]")];
  assert.deepEqual(rows.map((r) => !!r.querySelector(".pick-row-outcome .skeleton-outcome")), shape.rows);
  // The header lines are the real paragraphs, so they wrap where the words did —
  // but the words are never seen, and a screen reader hears only "Loading this week…".
  const summary = cold.document.querySelector("[data-pick-summary]");
  assert.equal(summary.querySelector(".skeleton-text").textContent, shape.summary);
  assert.equal(summary.querySelector(".skeleton-text").getAttribute("aria-hidden"), "true");
  assert.equal(summary.querySelector(".sr-only").textContent, "Loading this week…");
  assert.equal(cold.document.querySelector(".pick-detail").getAttribute("aria-hidden"), "true");
  assert.equal(cold.document.querySelector(".pick-detail .skeleton-text").textContent, shape.detail);
  assert.match(CSS, /\.skeleton-text \{[^}]*color: transparent;[^}]*box-decoration-break: clone;/);

  // With nothing cached at all, the remembered row count still holds.
  const none = mounted({ state: null, fixtures: [], fixturesStatus: "loading", confirmed: [], shape });
  assert.equal(none.document.querySelectorAll("[data-pick-skeleton]").length, 5);
  // Another league's shape is not this one's.
  const other = mounted({ state: null, fixtures: [], fixturesStatus: "loading", confirmed: [], shape: { ...shape, code: "BBB" } });
  assert.equal(other.document.querySelectorAll("[data-pick-skeleton]").length, 3);
  assert.equal(other.document.querySelectorAll(".skeleton-text").length, 0);
});
