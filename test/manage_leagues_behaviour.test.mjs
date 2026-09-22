// v1.8 §1 — behavioural coverage: leagueView is RUN in each state and its
// rendered output is asserted, rather than matching the function's source text.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

// Render leagueView with the collaborators stubbed to recognisable markers, so
// the assertions are about what the view actually produces.
function render({ codes, ls, manage }) {
  const box = load(["leagueView"], {
    leagueCodes: codes,
    leagueState: ls,
    leagueManageOpen: manage,
    inviteCode: "",
    playerName: "Adam",
    uid: () => "u1",
    escapeHTML: (v) => String(v ?? ""),
    flash: () => "",
    leagueSwitcher: () => "<SWITCHER>",
    createLeagueCard: () => "<CREATE-WIZARD>",
    hostSlateControl: () => "<HOST-SLATE>",
    leagueSettings: () => "<ADMIN-SETTINGS>",
    roundToggle: () => "<ROUND-TOGGLE>",
    leagueSummaryLine: () => "summary",
    leagueSupportsRounds: () => true,
  });
  return box.leagueView();
}
const LS = { name: "My League", owner: "u1", error: null };

test("§1 · with leagues, the table view leads with the table and hides the rest", () => {
  const html = render({ codes: ["ABC123"], ls: LS, manage: false });
  assert.ok(html.includes("<HOST-SLATE>"), "host-selected fixtures render on the table");
  assert.ok(html.includes("data-manage-open"), "a Manage leagues entry is offered");
  // The table comes before the manage entry.
  assert.ok(html.indexOf("<HOST-SLATE>") < html.indexOf("data-manage-open"));
  // Create, manual join, restore and admin are NOT on the table view.
  for (const hidden of ["<CREATE-WIZARD>", "data-join-league", "data-restore", "<ADMIN-SETTINGS>"]) {
    assert.ok(!html.includes(hidden), `${hidden} leaked onto the table view`);
  }
});

test("§1 · opening Manage leagues reveals create/join/restore/admin and a way back", () => {
  const html = render({ codes: ["ABC123"], ls: LS, manage: true });
  for (const shown of ["<CREATE-WIZARD>", "data-join-league", "data-restore", "<ADMIN-SETTINGS>"]) {
    assert.ok(html.includes(shown), `${shown} missing from the manage panel`);
  }
  assert.ok(html.includes("data-manage-close"), "a Back-to-table control is present");
  assert.ok(!html.includes("<HOST-SLATE>"), "the table card is not drawn under management");
});

test("§1 · a player with no leagues can act and is never trapped", () => {
  const html = render({ codes: [], ls: null, manage: false });
  // Every entry point is available immediately.
  for (const shown of ["<CREATE-WIZARD>", "data-join-league", "data-restore"]) {
    assert.ok(html.includes(shown), `${shown} missing for a new player`);
  }
  assert.ok(html.includes("Manage leagues"), "the surface is clearly labelled");
  // No admin block (there is no active league) and no dead "back" to nowhere.
  assert.ok(!html.includes("<ADMIN-SETTINGS>"));
  assert.ok(!html.includes("data-manage-close"));
});

test("§1 · the table view carries no navigation tab of its own", () => {
  const html = render({ codes: ["ABC123"], ls: LS, manage: false });
  assert.ok(!html.includes("data-view="), "leagueView must not add a fourth tab");
});
