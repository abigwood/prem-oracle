// v1.8 §1 League-table-first + Manage leagues, and §2 two-step creation.
//
// Structure is asserted from source (the shape is the contract); creation
// behaviour is run through the lifted advanceWizard.
import test from "node:test";
import assert from "node:assert/strict";
import { sourceOf, load, APP } from "./harness.mjs";

// --- §1 Navigation: the table leads; the rest is behind Manage leagues ------

test("§1 · the default League view leads with the table and offers Manage leagues", () => {
  const view = sourceOf("leagueView");
  // The default (has-leagues, not-managing) return renders ${content} (the
  // league-card) then the Manage leagues entry.
  const defaultReturn = view.slice(view.lastIndexOf("<h2>League table</h2>"));
  assert.match(defaultReturn, /\$\{content\}/, "the table content must be the default view");
  assert.match(defaultReturn, /data-manage-open/, "a Manage leagues entry must be offered");
  // content is the league-card, defined before (and thus rendered as) the table.
  assert.match(view, /const content =[\s\S]*<section class="league-card">/);
  assert.ok(defaultReturn.indexOf("${content}") < defaultReturn.indexOf("data-manage-open"),
    "the table leads, the manage entry follows");
});

test("§1 · create, manual join, restore and admin all live in the manage panel", () => {
  const view = sourceOf("leagueView");
  assert.match(view, /manage-panel/);
  assert.match(view, /createLeagueCard\(\)/);
  assert.match(view, /data-join-league/);
  assert.match(view, /data-restore/);
  assert.match(view, /leagueSettings\(state, isOwner\)/);
  assert.match(view, /data-manage-close/, "a way back to the table");
});

test("§1 · the no-leagues state routes through Manage leagues", () => {
  const view = sourceOf("leagueView");
  assert.match(view, /!leagueCodes\.length/);
  assert.match(view, /<h2>Manage leagues<\/h2>/);
});

test("§1 · host-selected fixtures stay with the table; this slice adds no tab", () => {
  const view = sourceOf("leagueView");
  const card = view.slice(view.indexOf('<section class="league-card">'), view.indexOf("${inner}"));
  assert.match(card, /hostSlateControl\(state\)/, "host-selected fixtures must remain on the table");
  assert.ok(!view.includes("data-view="), "leagueView must not introduce a navigation tab");
});

// --- §2 Two-step creation: defaults, Advanced, accessibility ---------------

test("§2 · creation defaults to six fixtures and manual host selection", () => {
  assert.match(APP, /const DEFAULT_FIXTURE_COUNT = 6;/);
  assert.match(sourceOf("openWizard"), /count: DEFAULT_FIXTURE_COUNT/);
  assert.match(sourceOf("wizardRule"), /method: "manual"/);
});

test("§2 · step 1 takes name + competition, step 2 confirms the standard format", () => {
  const details = sourceOf("wizardStepDetails");
  assert.match(details, /Step 1 of 2/);
  assert.match(details, /data-wizard-name/);
  assert.match(details, /data-wizard-competition/);
  const confirm = sourceOf("wizardStepConfirm");
  assert.match(confirm, /Step 2 of 2/);
  assert.match(confirm, /format-summary/);
  assert.match(confirm, /You pick the fixtures yourself, every week/);
  assert.match(confirm, /"Create league"/);
});

test("§2 · the unusual fixture-count choice sits under Advanced settings", () => {
  const confirm = sourceOf("wizardStepConfirm");
  assert.match(confirm, /<summary>Advanced settings<\/summary>/);
  assert.match(confirm, /wizard-advanced/);
  assert.match(confirm, /data-count-step/);
  assert.ok(confirm.indexOf("format-summary") < confirm.indexOf("wizard-advanced"),
    "the standard format is shown before Advanced");
  assert.ok(confirm.indexOf("wizard-advanced") < confirm.indexOf("data-count-step"),
    "the count control lives inside Advanced");
});

test("§2 · Advanced preserves the full supported count range (1–20)", () => {
  assert.match(APP, /const MIN_FIXTURE_COUNT = 1;/);
  assert.match(APP, /const MAX_FIXTURE_COUNT = 20;/);
  assert.match(APP, /Math\.max\(MIN_FIXTURE_COUNT, Math\.min\(MAX_FIXTURE_COUNT, wizard\.count \+ delta\)\)/);
});

test("§ accessibility · competition group is labelled; steppers carry aria-labels", () => {
  const details = sourceOf("wizardStepDetails");
  assert.match(details, /role="group"/);
  assert.match(details, /aria-label="Competitions"/);
  const confirm = sourceOf("wizardStepConfirm");
  assert.match(confirm, /aria-label="Fewer fixtures"/);
  assert.match(confirm, /aria-label="More fixtures"/);
  // the count steppers belong to Advanced (confirm), not step 1.
  assert.ok(!details.includes('aria-label="Fewer fixtures"'));
});

// --- §2 creation success / failure (behaviour) -----------------------------

function wizardBox(apiImpl) {
  const recovered = [];
  const wizard = { step: "confirm", name: "Test", competitions: ["EPL"], count: 6,
    confirmSingle: true, advancedOpen: false, busy: false, code: "", error: "" };
  const box = load(["advanceWizard"], {
    wizard,
    WIZARD_STEPS: ["details", "confirm", "share"],
    wizardStepError: () => "",
    wizardRule: () => ({ method: "manual" }),
    render: () => {},
    api: apiImpl,
    saveLeague: () => {},
    saveLeagueName: () => {},
    rememberCompetition: () => false,
    loadFixtures: async () => {},
    loadLeagueState: async () => {},
    localStorage: { setItem() {}, getItem: () => null },
    STORAGE: { name: "n", recovery: "r" },
    playerName: "Adam",
    openRecoveryOnboarding: (code) => recovered.push(code),
  });
  return { box, wizard, recovered };
}

test("§2 · creation success advances to share and surfaces recovery once", async () => {
  const { box, wizard, recovered } = wizardBox(async () =>
    ({ ok: true, code: "NEW123", name: "Test", recovery: "amber-score-oracle", competitions: ["EPL"] }));
  await box.advanceWizard();
  assert.equal(wizard.step, "share");
  assert.deepEqual(recovered, ["amber-score-oracle"]);
  assert.equal(wizard.busy, false);
});

test("§2 · creation failure stays on confirm, shows the error, surfaces no recovery", async () => {
  const { box, wizard, recovered } = wizardBox(async () => { throw new Error("That name is taken"); });
  await box.advanceWizard();
  assert.equal(wizard.step, "confirm", "a failed create must not advance to share");
  assert.match(wizard.error, /taken/);
  assert.equal(wizard.busy, false);
  assert.equal(recovered.length, 0, "no recovery moment on a failed create");
});

// --- §3 Regression: the invite journey is untouched ------------------------

test("§3 · invite links open the one-step join sheet, not Manage leagues", () => {
  // The launch decision opens the join sheet for an invite to a league not joined.
  assert.match(APP, /if \(joinInvite && API\) openJoinSheet\(joinInvite\)/);
  // The join sheet's submit path never toggles the management surface.
  assert.ok(!sourceOf("submitJoinSheet").includes("leagueManageOpen"));
  assert.ok(!sourceOf("openJoinSheet").includes("leagueManageOpen"));
  // The invite recovery link still reaches the existing restore surface.
  assert.match(APP, /data-join-recover/);
});
