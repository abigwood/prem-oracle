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
  ["ELC only, 1", { competitions: ["ELC"], weeklyRule: { method: "manual", count: 1 } }, "EFL Championship · 1 fixtures/week"],
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
