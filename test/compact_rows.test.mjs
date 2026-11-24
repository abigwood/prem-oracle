// v1.8.1 — compact My Picks rows.
//
// The row is kick-off | home badge v away badge | one fixed-width mark. These
// tests run the REAL pickRow with the REAL teamBadge/teamCode over the REAL
// TEAM_MARKERS/TEAM_CODES, and pin what the brief makes binding:
//
//   · every state's mark says what kind of number it is, and a prediction is
//     never presented as a result;
//   · the spoken name carries both full team names, the kick-off and the state;
//   · the expanded content (match card, result card, mates) is what it was;
//   · "Saved" is row-specific and out of flow;
//   · every PL and ELC club has a marker and a unique code, and every possible
//     pairing renders two coded, bounded circles with a neutral "v" between.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

// Comments stripped, so a selector is a selector and not the note above it.
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const feed = (file) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")).fixtures;
const clubsIn = (fixtures) => [...new Set(fixtures.flatMap((f) => [f.player1, f.player2]).filter(Boolean))].sort();
const PL_CLUBS = clubsIn(feed("fixtures.json"));
const ELC_CLUBS = clubsIn(feed("fixtures-elc.json"));
const ALL_CLUBS = [...PL_CLUBS, ...ELC_CLUBS];

const HOUR = 3600000;
const now = Date.now();
const fx = (id, { hours = 24, result = null, status = null, teams = ["Arsenal", "Coventry City"] } = {}) => ({
  id, player1: teams[0], player2: teams[1], matchday: 13,
  startAt: new Date(now + hours * HOUR).toISOString(),
  ...(result ? { result, status: status || "complete" } : status ? { status } : {}),
});

const OPEN = fx("f-open", { hours: 48, teams: ["Leeds United", "Coventry City"] });
const LOCKED = { ...fx("f-locked", { hours: 3, teams: ["Manchester United", "Brentford"] }), lockAt: new Date(now - HOUR).toISOString() };
const IN_PLAY = fx("f-inplay", { hours: -1, teams: ["Everton", "Liverpool"] });
const SETTLED = fx("f-settled", { hours: -26, result: [2, 1], teams: ["Fulham", "AFC Bournemouth"] });
const VOID = fx("f-void", { hours: -26, status: "abandoned", teams: ["Sunderland", "Tottenham Hotspur"] });
const POSTPONED = fx("f-post", { hours: -26, status: "postponed", teams: ["Arsenal", "Manchester City"] });
const ALL = [OPEN, LOCKED, IN_PLAY, SETTLED, VOID, POSTPONED];

const NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable",
  "matchweekRowState", "MATCHWEEK_ROW_LINE",
  "shortKickoff", "closedStatus", "matchOpen", "finalScore",
  "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickActionSummary", "pickCounts", "launchBranch", "pickRow", "pickRowKickoff", "pickRowMark",
  "pickRowBody", "pickRowLabel", "PICK_SAVED_MS", "pickJustSaved", "pickListState",
  "pickShareRow", "pickDeadlineLine", "expandPick", "pickEditable",
  "resultCard", "resultState", "resultPickLine", "resultBadge", "isSettledCard",
  "scorePickLocal", "RESULT_FIRST_STATES",
  // The live badge system, unstubbed.
  "TEAM_MARKERS", "TEAM_CODES", "teamInitials", "teamCode", "teamBadge",
];

function box({ picks = {}, ids = ALL.map((f) => f.id), document = null, requests = { api: 0 } } = {}) {
  return load(NAMES, {
    picks,
    fixtures: ALL,
    leagueNames: {},
    expandedPickId: null,
    activeLeague: "AAA",
    leagueState: { code: "AAA", name: "Burtons Premier", currentPeriod: "13",
      currentSlate: { period: "13", matchweek: 13, status: "published", fixtureIds: ids, count: ids.length },
      table: [], owner: "u-me" },
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
    preseasonState: () => "",
    inviteCode: "",
    onboardingState: () => "",
    leagueSwitcher: () => "",
    playerName: "Adam",
    matchCard: (m, opts) => `<article class="match-card" data-match-card="${m.id}"${
      opts?.social === false ? ' data-social="false"' : ""}><div class="score-picker" data-picker="${m.id}"></div><span class="player-name">${m.player1}</span><span class="player-name">${m.player2}</span></article>`,
    fixtureRevealSection: (m) => `<section class="fixture-reveal" data-reveal="${m.id}">MATES</section>`,
    pickRevealSection: () => "",
    countPhrase: (n, word) => `${n} ${word}`,
    uid: () => "u-me",
    ...(document ? { document } : {}),
    api: async () => { requests.api += 1; return {}; },
  });
}

/** The real list, mounted, so the tests read the DOM a viewer gets. */
function mounted(opts = {}) {
  const dom = new JSDOM(`<!doctype html><body><main id="app"></main></body>`);
  const { document } = dom.window;
  const requests = { api: 0 };
  const b = box({ ...opts, document, requests });
  document.getElementById("app").innerHTML = b.picksView();
  const row = (id) => document.querySelector(`[data-pick-row="${id}"]`);
  return { box: b, document, requests, row,
    head: (id) => row(id).querySelector("[data-expand-pick]"),
    mark: (id) => row(id).querySelector("[data-row-mark]"),
    body: (id) => row(id).querySelector(".pick-row-body") };
}

const MINE = { p1: 3, p2: 2 };
const everyPick = () => Object.fromEntries(ALL.map((f) => [f.id, { ...MINE }]));

// --- 1 · the row's anatomy ---------------------------------------------------

test("every state is ONE disclosure: the whole compact row is the button", () => {
  const app = mounted({ picks: everyPick() });
  for (const f of ALL) {
    const row = app.row(f.id);
    const buttons = row.querySelectorAll("button");
    assert.equal(buttons.length, 1, `${f.id} has ${buttons.length} controls`);
    assert.ok(buttons[0].matches(".pick-row-head[data-expand-pick]"), `${f.id}: the row is not the disclosure`);
    // The three columns, in order, inside that one button.
    const parts = [...buttons[0].children].map((el) => el.className.split(" ")[0]);
    assert.deepEqual(parts.slice(0, 3), ["pick-row-when", "pick-row-match", "pick-row-mark"], f.id);
  }
});

test("kick-off is two lines: 'Sat 28 Nov' over '15:00', in UK time", () => {
  const b = box();
  assert.deepEqual({ ...b.pickRowKickoff("2026-11-28T15:00:00Z") }, { date: "Sat 28 Nov", time: "15:00" });
  // BST: the same wall-clock kick-off is 14:00Z in August.
  assert.deepEqual({ ...b.pickRowKickoff("2026-08-22T14:00:00Z") }, { date: "Sat 22 Aug", time: "15:00" });
  assert.deepEqual({ ...b.pickRowKickoff("") }, { date: "", time: "" });
  const app = mounted();
  const when = app.row(OPEN.id).querySelector(".pick-row-when");
  assert.ok(when.querySelector(".pick-row-date + .pick-row-time"), "date is not over time");
  // Time slightly stronger than date.
  const weight = (sel) => Number((CSS.match(new RegExp(`\\${sel} \\{[^}]*font-weight: (\\d+)`)) || [])[1]);
  assert.ok(weight(".pick-row-time") > weight(".pick-row-date"), "the time is not stronger than the date");
});

test("badges come from the live teamBadge, centred with a neutral v", () => {
  const app = mounted();
  const match = app.row(OPEN.id).querySelector(".pick-row-match");
  const kids = [...match.children];
  assert.equal(kids.length, 3);
  assert.ok(kids[0].matches(".team-crest") && kids[2].matches(".team-crest"));
  assert.ok(kids[1].matches(".pick-row-v") && kids[1].textContent === "v");
  assert.equal(kids[0].textContent, "LEE");
  assert.equal(kids[2].textContent, "COV");
  // Byte-for-byte the production badge, not a lookalike.
  assert.equal(kids[0].outerHTML, new JSDOM(app.box.teamBadge("Leeds United")).window.document.body.firstChild.outerHTML);
  assert.match(sourceOf("pickRow"), /\$\{teamBadge\(match\.player1\)\}<span class="pick-row-v">v<\/span>\$\{teamBadge\(match\.player2\)\}/);
});

test("the compact modifier changes size only — never colour, fill, ring, border or shadow", () => {
  const rule = CSS.match(/\.pick-row-match \.team-crest \{([^}]*)\}/);
  assert.ok(rule, "no compact size modifier");
  const props = rule[1].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean).sort();
  assert.deepEqual(props, ["font-size", "height", "width"]);
  assert.match(rule[1], /width: 40px/);
  assert.match(rule[1], /height: 40px/);
  // No other rule anywhere restyles a crest inside a pick row.
  const crestRules = [...CSS.matchAll(/([^{}]*\.team-crest[^{}]*)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(crestRules.filter((sel) => sel.includes("pick-row")), [".pick-row-match .team-crest"]);
  // And the badge renderer itself still reads only the two maps.
  const badge = sourceOf("teamBadge");
  assert.match(badge, /TEAM_MARKERS\[name\]/);
  assert.match(badge, /teamCode\(name\)/);
  assert.doesNotMatch(badge, /opponent|other|against/i, "an opponent-dependent variant crept in");
});

test("the score column is fixed width, brand purple, strong and tabular", () => {
  const head = CSS.match(/\.pick-row-head \{([^}]*)\}/)[1];
  assert.match(head, /grid-template-columns: 4\.6rem 1fr 4\.6rem;/, "the outer columns are not fixed");
  const score = CSS.match(/\.pick-row-score \{([^}]*)\}/)[1];
  assert.match(score, /color: var\(--purple\)/);
  assert.match(score, /font-weight: 900/);
  assert.match(score, /font-variant-numeric: tabular-nums/);
  // Approximately 64–68px tall.
  const minHeight = Number(head.match(/min-height: (\d+)px/)[1]);
  assert.ok(minHeight >= 64 && minHeight <= 68, `row height ${minHeight}px`);
});

// --- 2 · state semantics ------------------------------------------------------

test("open and locked show the saved PREDICTION, or a muted dash", () => {
  const withPick = mounted({ picks: { [OPEN.id]: { p1: 3, p2: 2 }, [LOCKED.id]: { p1: 2, p2: 2 } } });
  for (const [id, score] of [[OPEN.id, "3-2"], [LOCKED.id, "2-2"]]) {
    const mark = withPick.mark(id);
    assert.equal(mark.dataset.rowMark, "prediction", id);
    assert.equal(mark.textContent, score, id);
    assert.equal(mark.querySelector(".pick-row-caption"), null, `${id}: a prediction carries a result caption`);
  }
  const none = mounted();
  for (const id of [OPEN.id, LOCKED.id]) {
    const mark = none.mark(id);
    assert.equal(mark.dataset.rowMark, "none");
    assert.equal(mark.textContent, "—");
    assert.ok(mark.querySelector(".pick-row-needed"), "the dash is not muted");
  }
});

test("started but unsettled is honestly PENDING — not the prediction, not a score", () => {
  const app = mounted({ picks: everyPick() });
  const mark = app.mark(IN_PLAY.id);
  assert.equal(mark.dataset.rowMark, "pending");
  assert.equal(mark.textContent, "Pending");
  assert.doesNotMatch(mark.textContent, /\d/, "a number appeared before settlement");
});

test("settled shows the FINAL result, captioned FT, distinct from the prediction", () => {
  const app = mounted({ picks: { [SETTLED.id]: { p1: 0, p2: 0 } } });
  const mark = app.mark(SETTLED.id);
  assert.equal(mark.dataset.rowMark, "result");
  assert.equal(mark.querySelector(".pick-row-score").textContent, "2-1", "the row did not show the result");
  assert.ok(mark.querySelector(".pick-row-final"));
  assert.equal(mark.querySelector(".pick-row-caption").textContent, "FT");
  assert.ok(!mark.textContent.includes("0-0"), "the prediction was shown where the result goes");
});

test("void and postponed are visibly named, and no score is shown for either", () => {
  const app = mounted({ picks: everyPick() });
  assert.equal(app.mark(VOID.id).dataset.rowMark, "void");
  assert.equal(app.mark(VOID.id).textContent, "Void");
  assert.equal(app.mark(POSTPONED.id).dataset.rowMark, "void");
  assert.equal(app.mark(POSTPONED.id).textContent, "Postponed");
  for (const id of [VOID.id, POSTPONED.id]) assert.doesNotMatch(app.mark(id).textContent, /\d/);
});

test("a prediction is NEVER presented as a result, in any state", () => {
  // The same 3-2 pick on every fixture; the only "result" mark in the list is
  // the settled one, and it carries the real 2-1.
  const app = mounted({ picks: everyPick() });
  const marks = [...app.document.querySelectorAll("[data-row-mark]")];
  assert.equal(marks.length, ALL.length);
  const results = marks.filter((m) => m.dataset.rowMark === "result");
  assert.equal(results.length, 1);
  assert.equal(results[0].closest("[data-pick-row]").dataset.pickRow, SETTLED.id);
  assert.equal(results[0].querySelector(".pick-row-score").textContent, "2-1");
  // A prediction mark never sits on a fixture that has kicked off.
  for (const m of marks.filter((m) => m.dataset.rowMark === "prediction")) {
    const state = m.closest("[data-pick-row]").dataset.rowState;
    assert.ok(state === "open" || state === "locked", `a prediction showed on a ${state} row`);
  }
});

// --- 3 · accessibility --------------------------------------------------------

test("each row's name carries both FULL team names, the kick-off and the state", () => {
  const app = mounted({ picks: everyPick() });
  const label = (id) => app.head(id).getAttribute("aria-label");
  const kick = (f) => app.box.shortKickoff(f.startAt);
  assert.equal(label(OPEN.id), `Leeds United against Coventry City, ${kick(OPEN)}, your prediction 3-2, editable until kick-off`);
  assert.equal(label(LOCKED.id), `Manchester United against Brentford, ${kick(LOCKED)}, your prediction 3-2, locked`);
  assert.equal(label(IN_PLAY.id), `Everton against Liverpool, ${kick(IN_PLAY)}, your prediction 3-2, result pending`);
  assert.equal(label(SETTLED.id), `Fulham against AFC Bournemouth, ${kick(SETTLED)}, final score 2-1, your prediction 3-2`);
  assert.equal(label(VOID.id), `Sunderland against Tottenham Hotspur, ${kick(VOID)}, void, no points, your prediction 3-2`);
  assert.equal(label(POSTPONED.id), `Arsenal against Manchester City, ${kick(POSTPONED)}, postponed, no points, your prediction 3-2`);
  // The visual pieces are hidden from the accessibility tree; the name is the whole story.
  for (const f of ALL) {
    for (const sel of [".pick-row-when", ".pick-row-match", ".pick-row-mark"]) {
      assert.equal(app.row(f.id).querySelector(sel).getAttribute("aria-hidden"), "true", `${f.id} ${sel}`);
    }
    const head = app.head(f.id);
    assert.equal(head.getAttribute("aria-controls"), `pk-${f.id}`);
    assert.equal(app.body(f.id).id, `pk-${f.id}`);
  }
  const none = mounted();
  assert.match(none.head(OPEN.id).getAttribute("aria-label"), /, no prediction yet, editable until kick-off$/);
});

// --- 4 · expansion: unchanged content, one at a time, zero requests ------------

test("expanding opens exactly what it opened before, with no request", () => {
  const app = mounted({ picks: everyPick() });
  app.box.expandPick(OPEN.id);
  let body = app.body(OPEN.id).innerHTML;
  assert.match(body, /data-match-card="f-open" data-social="false"/, "the open row lost its full card");
  assert.match(body, /Leeds United[\s\S]*Coventry City/, "complete names are gone from the expanded card");
  assert.ok(!body.includes("MATES"), "an open fixture leaked the mates section");

  app.box.expandPick(LOCKED.id);
  body = app.body(LOCKED.id).innerHTML;
  assert.match(body, /data-reveal="f-locked"/);
  assert.ok(!body.includes("score-picker"));

  // Result-first: the real result card (score, pick, points) above the mates.
  app.box.expandPick(SETTLED.id);
  const settled = app.body(SETTLED.id);
  const card = settled.querySelector(".result-card");
  assert.ok(card, "the result card is gone");
  assert.equal(card.dataset.resultState, "completed");
  assert.match(card.querySelector(".result-pick").textContent, /Your pick 3-2 · 2 points/);
  assert.equal(card.querySelectorAll(".player-name").length, 2);
  assert.deepEqual([...card.querySelectorAll(".player-name")].map((n) => n.textContent), ["Fulham", "AFC Bournemouth"]);
  assert.ok(settled.innerHTML.indexOf("result-card") < settled.innerHTML.indexOf("MATES"));

  app.box.expandPick(IN_PLAY.id);
  assert.match(app.body(IN_PLAY.id).textContent, /Awaiting final score/);
  app.box.expandPick(VOID.id);
  assert.match(app.body(VOID.id).textContent, /Void — no points/);

  // One disclosure at a time throughout.
  const open = [...app.document.querySelectorAll(".pick-row-body")].filter((b) => b.innerHTML).length;
  assert.equal(open, 1);
  assert.equal(app.document.querySelectorAll('[aria-expanded="true"]').length, 1);
  assert.equal(app.requests.api, 0, "expansion asked the network");
  app.box.expandPick(VOID.id);
  assert.equal(app.document.querySelectorAll('[aria-expanded="true"]').length, 0);
});

test("the result card, points and mates are the same renderers as before", () => {
  assert.match(sourceOf("pickRowBody"), /resultCard\(match, null, \{ social: false \}\)\}\$\{fixtureRevealSection\(match\)\}/);
  // The expander mounts the very body the first paint would have.
  assert.match(sourceOf("expandPick"), /pickRowBody\(fixture, pickEditable\(fixture\)\)/);
});

test("share/export output does not route through the compact row", () => {
  for (const fn of ["weeklyCardModel", "weeklyCardPages", "seasonCardModel", "seasonCardPages",
    "drawCardHeader", "drawCardHero", "drawCardFooter", "diagnosticsText"]) {
    const src = sourceOf(fn);
    for (const banned of ["pickRow", "pickRowMark", "pickRowKickoff", "pick-row", "recovery"]) {
      assert.ok(!src.includes(banned), `${fn} reaches ${banned}`);
    }
  }
});

// --- 5 · Saved: row-specific, transient, never moves a column -----------------

test("'Saved' shows on the saved row only, for a moment, out of flow", () => {
  const picks = everyPick();
  picks[LOCKED.id] = { p1: 1, p2: 0, savedAt: Date.now() };
  picks[OPEN.id] = { p1: 3, p2: 2, savedAt: Date.now() - 60_000 };
  const app = mounted({ picks });
  const saved = [...app.document.querySelectorAll("[data-pick-saved]")];
  assert.equal(saved.length, 1, "Saved appeared on more than one row");
  assert.equal(saved[0].closest("[data-pick-row]").dataset.pickRow, LOCKED.id);
  assert.equal(saved[0].textContent, "Saved");
  // It sits after the three columns, inside the same disclosure…
  assert.ok(saved[0].parentElement.matches(".pick-row-head"));
  assert.ok(saved[0].previousElementSibling.matches(".pick-row-mark"));
  // …and the prediction it confirms is still exactly where it was.
  assert.equal(app.mark(LOCKED.id).textContent, "1-0");
  // Out of flow: absolutely positioned in a positioned head, so the grid's
  // three columns are the same with or without it.
  const savedCss = CSS.match(/\.pick-row-saved \{([^}]*)\}/)[1];
  assert.match(savedCss, /position: absolute/);
  assert.match(CSS.match(/\.pick-row-head \{([^}]*)\}/)[1], /position: relative/);
  // And it expires.
  assert.equal(app.box.pickJustSaved({ savedAt: Date.now() - app.box.PICK_SAVED_MS - 1 }), false);
});

// --- 6 · every club, every pairing -------------------------------------------

test("every supported PL and ELC club has a marker and a three-character code", () => {
  const b = box();
  assert.equal(PL_CLUBS.length, 20, "the PL feed is not 20 clubs");
  assert.equal(ELC_CLUBS.length, 24, "the ELC feed is not 24 clubs");
  for (const club of ALL_CLUBS) {
    const marker = b.TEAM_MARKERS[club];
    assert.ok(marker, `${club} has no marker`);
    for (const key of ["bg", "fg", "border"]) assert.match(marker[key], /^#[0-9A-F]{6}$/i, `${club}.${key}`);
    assert.ok(Object.hasOwn(b.TEAM_CODES, club), `${club} falls back to derived initials`);
    assert.match(b.TEAM_CODES[club], /^[A-Z]{3}$/, `${club}'s code is not three letters`);
  }
});

test("codes are unique across the combined PL + ELC set", () => {
  const b = box();
  const seen = new Map();
  for (const club of ALL_CLUBS) {
    const code = b.TEAM_CODES[club];
    assert.ok(!seen.has(code), `${club} and ${seen.get(code)} share ${code}`);
    seen.set(code, club);
  }
  assert.equal(seen.size, ALL_CLUBS.length);
});

test("EVERY possible pairing renders two coded, bounded circles and a neutral v", () => {
  const b = box();
  const pairs = [];
  for (const home of ALL_CLUBS) for (const away of ALL_CLUBS) if (home !== away) pairs.push([home, away]);
  assert.equal(pairs.length, ALL_CLUBS.length * (ALL_CLUBS.length - 1));
  // Real rows, real badges, one document.
  const html = pairs.map(([home, away], i) =>
    b.pickRow({ id: `p${i}`, fixture: { id: `p${i}`, player1: home, player2: away, matchday: 1,
      startAt: new Date(now + 48 * HOUR).toISOString() } }, { expanded: false })).join("");
  const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window;
  const rows = document.querySelectorAll("[data-pick-row]");
  assert.equal(rows.length, pairs.length);
  rows.forEach((row, i) => {
    const [home, away] = pairs[i];
    const match = row.querySelector(".pick-row-match");
    const crests = match.querySelectorAll(":scope > .team-crest");
    assert.equal(crests.length, 2, `${home} v ${away}: ${crests.length} circles`);
    const v = match.querySelector(":scope > .pick-row-v");
    assert.ok(v && v.textContent === "v" && v.previousElementSibling === crests[0] && v.nextElementSibling === crests[1],
      `${home} v ${away}: the v is missing or misplaced`);
    for (const [crest, club] of [[crests[0], home], [crests[1], away]]) {
      const m = b.TEAM_MARKERS[club];
      // The code is what distinguishes clubs; colour is never relied on alone.
      assert.equal(crest.textContent, b.TEAM_CODES[club], `${club}'s code is not visible`);
      // Bounded: each circle carries its own club's ring, unchanged by who it plays.
      assert.equal(crest.getAttribute("style"), `--team-bg:${m.bg};--team-fg:${m.fg};--team-border:${m.border};`,
        `${club}'s badge changed against ${club === home ? away : home}`);
    }
    assert.notEqual(crests[0].textContent, crests[1].textContent, `${home} v ${away} read the same`);
    assert.match(row.querySelector("[data-expand-pick]").getAttribute("aria-label"),
      new RegExp(`^${home.replace(/[&]/g, "&")} against ${away}, `));
  });
  // The crest is a bounded circle by construction: a ring, a radius, a size.
  const crest = CSS.match(/\n\.team-crest \{([^}]*)\}/)[1];
  assert.match(crest, /border-radius: 50%/);
  assert.match(crest, /border: 2px solid var\(--team-border/);
});

test("the v between the badges is neutral, not a club colour", () => {
  const v = CSS.match(/\.pick-row-v \{([^}]*)\}/)[1];
  assert.match(v, /color: var\(--muted\)/);
  assert.doesNotMatch(v, /team-/);
  assert.ok(!APP.includes("pick-row-v\" style"), "the v takes an inline colour");
});
