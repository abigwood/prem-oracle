// v1.8.1 fold-in — the League card's configuration eyebrow is gone.
//
// "PREMIER LEAGUE + EFL CHAMPIONSHIP · 6 FIXTURES/WEEK" no longer sits above
// the league name on the League card. The configuration is said ONCE, as a
// quiet line under the selected league's "League settings" heading inside
// Manage leagues, and follows the league pill. These run the REAL leagueView,
// leagueSettings and leagueSummaryLine across every rule shape the worker can
// return.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Every configuration shape, with the line it must produce.
const CONFIGS = [
  ["PL, standard 6", { competitions: ["PL"], weeklyRule: { method: "manual", count: 6 } }, "Premier League · 6 fixtures/week"],
  ["PL + ELC, 6", { competitions: ["PL", "ELC"], weeklyRule: { method: "manual", count: 6 } }, "Premier League + EFL Championship · 6 fixtures/week"],
  ["ELC only, 1", { competitions: ["ELC"], weeklyRule: { method: "manual", count: 1 } }, "EFL Championship · 1 fixture/week"],
  ["PL, 2", { competitions: ["PL"], weeklyRule: { method: "manual", count: 2 } }, "Premier League · 2 fixtures/week"],
  ["PL, random 1", { competitions: ["PL"], weeklyRule: { method: "random", count: 1 } }, "Premier League · ~1 random fixture/week"],
  ["legacy limited 1", { competition: "PL", fixtureMode: "limited", fixtureLimit: 1 }, "Premier League · ~1 fixture/week"],
  ["PL, max 20", { competitions: ["PL"], weeklyRule: { method: "manual", count: 20 } }, "Premier League · 20 fixtures/week"],
  ["PL + ELC, random 8", { competitions: ["PL", "ELC"], weeklyRule: { method: "random", count: 8 } }, "Premier League + EFL Championship · ~8 random fixtures/week"],
  ["PL, every fixture", { competitions: ["PL"], weeklyRule: { method: "allEligible" } }, "Premier League · every fixture"],
  ["PL + ELC, every ELC", { competitions: ["PL", "ELC"], weeklyRule: { method: "allCompetition", competitionScope: "ELC" } }, "Premier League + EFL Championship · every Championship fixture"],
  ["legacy limited 4", { competition: "PL", fixtureMode: "limited", fixtureLimit: 4 }, "Premier League · ~4 fixtures/week"],
  ["legacy host picks", { competition: "PL", fixtureMode: "limited", fixtureLimit: null }, "Premier League · host picks each week"],
  ["legacy unlimited", { competition: "ELC", fixtureMode: "all" }, "EFL Championship · every fixture"],
];

const state = (code, name, config, owner = "u1") =>
  ({ code, name, owner, error: null, currentPeriod: "13", currentSlate: null, ...config });

function view({ states, active, manage }) {
  const box = load(["leagueView", "leagueSettings", "leagueSummaryLine", "COMPETITIONS", "DEFAULT_COMPETITION",
    "competitionMeta", "weeklyCountControl"], {
    leagueCodes: Object.keys(states),
    leagueState: states[active],
    leagueStates: states,
    activeLeague: active,
    leagueManageOpen: manage,
    leagueSettingsOpen: false,
    countBusy: false,
    inviteCode: "",
    playerName: "Adam",
    uid: () => "u1",
    DEFAULT_FIXTURE_COUNT: 6,
    flash: () => "",
    leagueNames: Object.fromEntries(Object.values(states).map((s) => [s.code, s.name])),
    leagueSwitcher: () => `<div class="filters league-switcher">${Object.values(states).map((s) =>
      `<button class="filter league-filter" data-league="${s.code}"><span class="league-filter-name">${s.name}</span></button>`).join("")}</div>`,
    createLeagueCard: () => "<div class=create></div>",
    hostSlateControl: () => "",
    roundToggle: () => "",
    leagueSupportsRounds: () => false,
  });
  const html = box.leagueView();
  const { document } = new JSDOM(`<!doctype html><body><main>${html}</main></body>`).window;
  return { box, html, document, text: document.body.textContent };
}

// --- the League card ------------------------------------------------------------

test("the League card carries no configuration line, for every configuration", () => {
  for (const [label, config, line] of CONFIGS) {
    const v = view({ states: { AAA: state("AAA", "Burtons Premier", config) }, active: "AAA", manage: false });
    const card = v.document.querySelector(".league-card");
    assert.ok(card, label);
    assert.ok(!v.text.includes(line), `${label}: "${line}" is still on the League screen`);
    assert.doesNotMatch(v.text, /fixtures\/week|every fixture|host picks each week/i, label);
    assert.equal(card.querySelector(".eyebrow"), null, `${label}: an eyebrow survives on the card`);
    // The name is now the card's first thing, and says the same as before.
    assert.ok(card.firstElementChild.matches("h2"), `${label}: the name did not move up`);
    assert.equal(card.firstElementChild.textContent, "Burtons Premier");
  }
});

test("nothing on the table view would make VoiceOver say the removed copy", () => {
  for (const [label, config, line] of CONFIGS) {
    const v = view({ states: { AAA: state("AAA", "Burtons Premier", config) }, active: "AAA", manage: false });
    const spoken = [...v.document.querySelectorAll("[aria-label],[title],[aria-description]")]
      .map((el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("aria-description") || ""}`).join(" ");
    assert.ok(!spoken.includes(line), `${label}: the removed copy is in an accessible label`);
    assert.doesNotMatch(spoken, /fixtures\/week/i);
  }
});

test("the name moves up into the space: only the card's leading h2 loses its top margin", () => {
  assert.match(CSS, /\.league-card > h2:first-child \{ margin-top: 0; \}/);
  // Everything else about the heading is as it was.
  assert.match(CSS, /\.league-card h2, \.rules-card h2 \{ margin: 4px 0 8px; font-family: Georgia, serif; \}/);
});

// --- Manage leagues -------------------------------------------------------------

test("Manage leagues says the configuration once, under the settings heading, for every configuration", () => {
  for (const [label, config, line] of CONFIGS) {
    const v = view({ states: { AAA: state("AAA", "Burtons Premier", config) }, active: "AAA", manage: true });
    const summary = v.document.querySelector(".league-settings > summary.league-settings-head");
    assert.ok(summary, `${label}: no settings heading`);
    const config_ = summary.querySelector(".league-settings-config");
    assert.equal(config_?.textContent, line, label);
    // Beneath the heading text, inside the same (always visible) summary.
    assert.equal(config_.previousElementSibling.textContent, "League settings");
    // Exactly once on the whole screen.
    assert.equal(v.text.split(line).length - 1, 1, `${label}: said ${v.text.split(line).length - 1} times`);
    // Visible while the settings stay collapsed.
    assert.equal(v.document.querySelector(".league-settings").hasAttribute("open"), false);
  }
});

test("its spoken name is the heading followed by the configuration, nothing more", () => {
  const v = view({ states: { AAA: state("AAA", "Burtons Premier", CONFIGS[1][1]) }, active: "AAA", manage: true });
  const summary = v.document.querySelector("summary.league-settings-head");
  assert.equal(summary.textContent.trim(), "League settingsPremier League + EFL Championship · 6 fixtures/week");
  assert.equal(summary.getAttribute("aria-label"), null, "a label would hide the configuration from VoiceOver");
});

test("selecting another league pill shows THAT league's configuration, and no list is added", () => {
  const states = {
    AAA: state("AAA", "Burtons Premier", CONFIGS[0][1]),
    BBB: state("BBB", "BVW Premier", CONFIGS[4][1]),
    CCC: state("CCC", "Barasti Prem", CONFIGS[2][1], "u-other"),
  };
  for (const [code, line] of [["AAA", CONFIGS[0][2]], ["BBB", CONFIGS[4][2]], ["CCC", CONFIGS[2][2]]]) {
    const v = view({ states, active: code, manage: true });
    const lines = [...v.document.querySelectorAll(".league-settings-config")].map((el) => el.textContent);
    assert.deepEqual(lines, [line], `${code}: ${JSON.stringify(lines)}`);
    for (const other of Object.keys(states).filter((c) => c !== code)) {
      const otherLine = CONFIGS.find(([, cfg]) => cfg === states[other].weeklyRule || cfg === states[other])?.[2];
      if (otherLine && otherLine !== line) assert.ok(!v.text.includes(otherLine), `${code} shows ${other}'s configuration`);
    }
    // The pills are the only list of leagues; nothing new enumerates them.
    assert.equal(v.document.querySelectorAll("[data-league]").length, 3);
    assert.equal(v.document.querySelectorAll(".league-settings").length, 1);
  }
});

test("a league still loading shows no configuration rather than another league's", () => {
  const v = view({ states: { AAA: state("AAA", "Burtons Premier", CONFIGS[0][1]) }, active: "AAA", manage: true });
  assert.equal(v.document.querySelectorAll(".league-settings-config").length, 1);
  const loading = load(["leagueSettings", "leagueSummaryLine", "COMPETITIONS", "DEFAULT_COMPETITION", "competitionMeta"], {});
  assert.equal(loading.leagueSettings(null, false), "");
  assert.equal(loading.leagueSettings({ error: "Not found" }, false), "");
});

test("the configuration is rendered as text, never markup", () => {
  const box = load(["leagueSettings", "leagueSummaryLine", "COMPETITIONS", "DEFAULT_COMPETITION", "competitionMeta", "weeklyCountControl"],
    { leagueSettingsOpen: false, uid: () => "u1", countBusy: false, DEFAULT_FIXTURE_COUNT: 6 });
  const html = box.leagueSettings(state("AAA", "x", { competitions: ["PL"], weeklyRule: { method: "manual", count: "<b>6</b>" } }), true);
  assert.ok(html.includes("&lt;b&gt;6&lt;/b&gt;"));
});

// --- said once, nowhere else -------------------------------------------------------

test("leagueSummaryLine has exactly one caller: the Manage-leagues settings heading", () => {
  const calls = APP.match(/leagueSummaryLine\(/g).length - 1;   // minus the definition
  assert.equal(calls, 1);
  assert.match(APP, /<span class="league-settings-config">\$\{escapeHTML\(leagueSummaryLine\(state\)\)\}<\/span>/);
});

test("quiet, sentence case, and wraps rather than overflowing", () => {
  const rule = CSS.match(/\.league-settings-config \{([^}]*)\}/)[1];
  assert.match(rule, /color: var\(--muted\)/);
  assert.match(rule, /font-weight: 600/);
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.doesNotMatch(rule, /text-transform/);
  assert.match(CSS.match(/\.league-settings-title \{([^}]*)\}/)[1], /min-width: 0/);
});

// =============================================================================
// The "Season 2026/27 · next up: Week N" card is gone; its week number rides on
// the League card's lock line: "Week {N} · locks {day date} at {time}".
// =============================================================================

const WINDOW = "w2026-11-24";                 // a mixed league's week key
const HOUR = 3600000;
const future = (h) => new Date(Date.now() + h * HOUR).toISOString();

function card({ state: s, weekOf = (p) => (p === WINDOW ? 13 : null), owner = "u1" } = {}) {
  return load(["hostSlateControl", "lockLine", "slateLocked", "cardLockLine", "weekStatusWord", "lockWeekPrefix", "lockTimeLabel",
    "periodLabel", "periodLabelLong", "isWindowKey"], {
    uid: () => owner,
    weekNumberFor: weekOf,
    windowLabel: () => "24–30 Nov",
    weekDateRange: () => "24–30 Nov",
  });
}
const slateFor = (period, extra = {}) => ({ period, status: "published", fixtureIds: ["a"], count: 1, locked: false, ...extra });
const text = (html) => new JSDOM(`<body>${html}</body>`).window.document.body.textContent.trim();

test("open week: 'Week N · locks {day date} at {time}', in UK time, for mixed and single-competition leagues", () => {
  const b = card();
  const mixed = { code: "AAA", owner: "u2", currentPeriod: WINDOW, currentSlate: slateFor(WINDOW, { lockAt: "2026-11-28T15:00:00Z" }) };
  assert.equal(text(b.hostSlateControl(mixed)), "Week 13 · locks Sat 28 Nov at 15:00");
  // A Premier-League-only league keeps its official matchweek wording.
  const pl = { code: "PPP", owner: "u2", currentPeriod: "13", currentSlate: slateFor("13", { lockAt: "2026-11-28T15:00:00Z" }) };
  assert.equal(text(b.hostSlateControl(pl)), "Matchweek 13 · locks Sat 28 Nov at 15:00");
  // BST: the same wall-clock lock is 14:00Z in August.
  const summer = { ...pl, currentPeriod: "33", currentSlate: slateFor("33", { lockAt: "2027-04-03T14:00:00Z" }) };
  assert.equal(text(b.hostSlateControl(summer)), "Matchweek 33 · locks Sat 3 Apr at 15:00");
});

test("the line is dynamic: a different week and lock time say so", () => {
  const b = card({ weekOf: (p) => ({ [WINDOW]: 13, "w2026-12-01": 14 })[p] ?? null });
  const s = (period, lockAt) => ({ code: "AAA", owner: "u2", currentPeriod: period, currentSlate: slateFor(period, { lockAt }) });
  assert.equal(text(b.hostSlateControl(s(WINDOW, "2026-11-28T15:00:00Z"))), "Week 13 · locks Sat 28 Nov at 15:00");
  assert.equal(text(b.hostSlateControl(s("w2026-12-01", "2026-12-05T12:30:00Z"))), "Week 14 · locks Sat 5 Dec at 12:30");
});

test("no nameable week: the prefix is omitted, never empty or stale", () => {
  const b = card({ weekOf: () => null });
  const unnamed = { code: "AAA", owner: "u2", currentPeriod: WINDOW, currentSlate: slateFor(WINDOW, { lockAt: "2026-11-28T15:00:00Z" }) };
  const line = text(b.hostSlateControl(unnamed));
  assert.equal(line, "Locks Sat 28 Nov at 15:00");
  assert.doesNotMatch(line, /^·|Week\s*·|null|undefined|24–30 Nov/);
  // A slate for a different period than the league's current one cannot lend
  // its week to this line.
  const b2 = card();
  const mismatched = { code: "AAA", owner: "u2", currentPeriod: WINDOW, currentSlate: slateFor("w2026-11-17", { lockAt: "2026-11-28T15:00:00Z" }) };
  assert.equal(text(b2.hostSlateControl(mismatched)), "Locks Sat 28 Nov at 15:00");
});

test("locked, lapsed, unpublished and season-finished states never claim an upcoming lock", () => {
  const b = card();
  const base = { code: "AAA", owner: "u2", currentPeriod: WINDOW };
  // Locked by the server.
  assert.equal(text(b.hostSlateControl({ ...base, currentSlate: slateFor(WINDOW, { locked: true, lockAt: future(-2) }) })),
    "Week 13 · line-up locked — the first fixture has kicked off.");
  // The lock moment has passed but the cached slate predates it.
  const lapsed = text(b.hostSlateControl({ ...base, currentSlate: slateFor(WINDOW, { locked: false, lockAt: future(-0.1) }) }));
  assert.match(lapsed, /line-up locked/);
  assert.doesNotMatch(lapsed, /locks/);
  // No lock time known: nothing rather than an invented one.
  assert.equal(text(b.hostSlateControl({ ...base, currentSlate: slateFor(WINDOW) })), "");
  // Nothing published yet: a member sees nothing; the host keeps their button.
  assert.equal(b.hostSlateControl({ ...base, currentSlate: null }), "");
  assert.match(card({ owner: "u2" }).hostSlateControl({ ...base, currentSlate: null }), /Pick fixtures for Week 13 · 24–30 Nov/);
  // Season finished: no period, no line.
  assert.equal(b.hostSlateControl({ ...base, currentPeriod: null, currentSlate: null }), "");
});

test("an open week keeps the host's Edit line-up next to the merged line", () => {
  const b = card({ owner: "u2" });
  const html = b.hostSlateControl({ code: "AAA", owner: "u2", currentPeriod: WINDOW, currentSlate: slateFor(WINDOW, { lockAt: future(30) }) });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  assert.match(doc.querySelector(".lock-line").textContent, /^Week 13 · locks /);
  assert.equal(doc.querySelector("[data-amend]").textContent, "Edit line-up");
});

test("every other lockLine caller is unchanged", () => {
  const b = card();
  assert.equal(text(b.lockLine(slateFor(WINDOW, { lockAt: "2026-11-28T15:00:00Z" }))), "Locks Sat 28 Nov at 15:00");
  assert.equal(text(b.lockLine(slateFor(WINDOW, { locked: true }))), "Line-up locked — the first fixture has kicked off.");
  assert.match(APP, /\$\{lockLine\(published\)\}/);
  assert.equal((APP.match(/lockLine\(slate, \{ period: /g) || []).length, 1, "the week prefix reached another surface");
});

// --- the season card is gone, on every League screen ---------------------------------

test("the Season panel no longer builds a 'Season 2026/27' card", () => {
  const box = load(["seasonStages"], {
    trophyCabinet: () => "<CABINET>", seasonTableHtml: () => "<TABLE>", shareIconButton: () => "<SHARE>",
    leagueRevealsHtml: () => "<REVEALS>",
  });
  const stages = box.seasonStages({ code: "AAA" }, false);
  assert.deepEqual([...stages.map(([name]) => name)], ["cabinet", "standings", "share", "reveals"]);
  const html = stages.map(([, build]) => build()).join("");
  assert.doesNotMatch(html, /Season 2026\/27|next up|round-banner/);
  assert.ok(!APP.includes("function seasonBanner("), "the season card builder survives");
  assert.ok(!APP.includes("function seasonProgressLine("), "its line builder survives unused");
});

function leagueScreen({ states, active, tab }) {
  const box = load(["leagueView", "leagueSettings", "leagueSummaryLine", "COMPETITIONS", "DEFAULT_COMPETITION",
    "competitionMeta", "weeklyCountControl", "hostSlateControl", "lockLine", "slateLocked", "cardLockLine", "weekStatusWord", "lockWeekPrefix",
    "lockTimeLabel", "periodLabel", "periodLabelLong", "isWindowKey"], {
    leagueCodes: Object.keys(states), leagueState: states[active], leagueStates: states, activeLeague: active,
    leagueManageOpen: false, leagueSettingsOpen: false, countBusy: false, inviteCode: "", playerName: "Adam",
    uid: () => "u1", DEFAULT_FIXTURE_COUNT: 6, flash: () => "", leagueNames: {}, leagueTab: tab,
    weekNumberFor: (p) => ({ [WINDOW]: 13, "w2026-12-01": 14 })[p] ?? null, windowLabel: () => "", weekDateRange: () => "",
    leagueSwitcher: () => "<nav>pills</nav>", createLeagueCard: () => "",
    roundToggle: () => `<div class="round-toggle" data-tab="${tab}"></div>`, leagueSupportsRounds: () => true,
  });
  const html = box.leagueView();
  return { html, text: new JSDOM(`<body>${html}</body>`).window.document.body.textContent };
}

test("league switching and Weekly/Season switching: each league's own week, said once", () => {
  const states = {
    AAA: { ...state("AAA", "Burtons Premier", CONFIGS[1][1], "u2"), currentPeriod: WINDOW,
      currentSlate: slateFor(WINDOW, { lockAt: "2026-11-28T15:00:00Z" }) },
    BBB: { ...state("BBB", "BVW Premier", CONFIGS[0][1], "u2"), currentPeriod: "14",
      currentSlate: slateFor("14", { lockAt: "2026-12-05T12:30:00Z" }) },
    CCC: { ...state("CCC", "Barasti Prem", CONFIGS[4][1], "u2"), currentPeriod: "w2026-12-01",
      currentSlate: slateFor("w2026-12-01", { locked: true, lockAt: future(-5) }) },
  };
  const expect = {
    AAA: "Week 13 · locks Sat 28 Nov at 15:00",
    BBB: "Matchweek 14 · locks Sat 5 Dec at 12:30",
    CCC: "Week 14 · line-up locked — the first fixture has kicked off.",
  };
  for (const tab of ["matchday", "season"]) {
    for (const code of Object.keys(states)) {
      const v = leagueScreen({ states, active: code, tab });
      assert.ok(v.text.includes(expect[code]), `${code}/${tab}: ${v.text}`);
      // Exactly once, and no other league's line leaks in.
      assert.equal(v.text.split(expect[code]).length - 1, 1, `${code}/${tab}: said more than once`);
      for (const other of Object.keys(states).filter((c) => c !== code)) assert.ok(!v.text.includes(expect[other]), `${code} shows ${other}'s line`);
      assert.doesNotMatch(v.text, /Season 2026\/27|next up/i);
    }
  }
});

test("the merged line is plain text: no label repeats or hides it from VoiceOver", () => {
  const states = { AAA: { ...state("AAA", "Burtons Premier", CONFIGS[1][1], "u2"), currentPeriod: WINDOW,
    currentSlate: slateFor(WINDOW, { lockAt: "2026-11-28T15:00:00Z" }) } };
  const v = leagueScreen({ states, active: "AAA", tab: "season" });
  const doc = new JSDOM(`<body>${v.html}</body>`).window.document;
  const line = doc.querySelector(".lock-line");
  assert.equal(line.getAttribute("aria-label"), null);
  assert.equal(line.getAttribute("aria-hidden"), null);
  const labels = [...doc.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ");
  assert.doesNotMatch(labels, /Season 2026\/27|next up|fixtures\/week/i);
});

test("configuration wording agrees with its count: '1 fixture/week', '{N} fixtures/week'", () => {
  const b = load(["leagueSummaryLine", "COMPETITIONS", "DEFAULT_COMPETITION", "competitionMeta"], {});
  for (let n = 1; n <= 20; n++) {
    const noun = n === 1 ? "fixture" : "fixtures";
    assert.equal(b.leagueSummaryLine({ competitions: ["PL"], weeklyRule: { method: "manual", count: n } }), `Premier League · ${n} ${noun}/week`);
    assert.equal(b.leagueSummaryLine({ competitions: ["PL"], weeklyRule: { method: "random", count: n } }), `Premier League · ~${n} random ${noun}/week`);
    assert.equal(b.leagueSummaryLine({ competition: "PL", fixtureMode: "limited", fixtureLimit: n }), `Premier League · ~${n} ${noun}/week`);
  }
  assert.doesNotMatch(APP, /\b1 fixtures\/week/);
});
