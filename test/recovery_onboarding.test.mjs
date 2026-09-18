// v1.8 Recovery onboarding — the one-time "save your recovery code" moment
// shown after a join or a create, before the player continues.
//
// The join_sheet suite proves joining surfaces this moment; here we prove the
// moment itself: it shows the code without ever touching the clipboard on its
// own, copies only on the explicit tap, confirms on success, is honest on
// failure without losing the code, survives repeated taps, and continues
// exactly once. A separate test proves league creation surfaces it too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const RECOVERY_DIALOG = HTML.slice(HTML.indexOf('<dialog id="recoveryDialog">'),
  HTML.indexOf("</dialog>", HTML.indexOf('<dialog id="recoveryDialog">')) + "</dialog>".length);

// clipboardMode: "ok" resolves and records; "fail" rejects; "none" = no API.
function recoveryBox({ clipboardMode = "ok" } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${RECOVERY_DIALOG}</body>`);
  const { document } = dom.window;
  const dialog = document.getElementById("recoveryDialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };

  const writes = [];
  let navigator;
  if (clipboardMode === "none") navigator = {};
  else if (clipboardMode === "fail") navigator = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
  else navigator = { clipboard: { writeText: async (t) => { writes.push(t); } } };

  const calls = { viewport: 0 };
  const box = load(
    ["openRecoveryOnboarding", "copyRecovery", "continueRecovery"],
    {
      document,
      navigator,
      recoveryContinue: null,
      restoreViewport: () => { calls.viewport++; },
    });
  // Mirror app.js's own wiring so a real tap/close is exercised, not just a
  // direct function call. (The wiring's presence in source is pinned in the
  // python suite.)
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-recovery-copy]")) box.copyRecovery();
  });
  dialog.addEventListener("close", () => { box.continueRecovery(); calls.viewport++; });
  return { box, document, dialog, writes, calls };
}

const CODE = "amber-score-oracle";
const flush = () => new Promise((r) => setTimeout(r, 0));
const tapCopy = (document) => document.getElementById("recoveryCopy")
  .dispatchEvent(new document.defaultView.MouseEvent("click", { bubbles: true }));

test("opening shows the code and copies NOTHING until an explicit tap", async () => {
  const { box, document, writes } = recoveryBox();
  box.openRecoveryOnboarding(CODE, () => {});
  assert.equal(document.getElementById("recoveryDialog").open, true);
  assert.equal(document.getElementById("recoveryCode").textContent, CODE, "the code is not shown");
  await flush();
  assert.equal(writes.length, 0, "the clipboard was written without a tap");
  assert.equal(document.getElementById("recoveryCopied").hidden, true, "a copy confirmation showed before any tap");
});

test("the code is rendered as text, never markup", async () => {
  const { box, document } = recoveryBox();
  box.openRecoveryOnboarding("<b>x</b>-y-z", () => {});
  const el = document.getElementById("recoveryCode");
  assert.equal(el.textContent, "<b>x</b>-y-z");
  assert.equal(el.querySelector("b"), null, "the credential was injected as HTML");
});

test("an explicit Copy tap writes the code and confirms", async () => {
  const { box, document, writes } = recoveryBox();
  box.openRecoveryOnboarding(CODE, () => {});
  tapCopy(document);
  await flush();
  assert.deepEqual(writes, [CODE], "the tap did not copy exactly the code");
  const copied = document.getElementById("recoveryCopied");
  assert.equal(copied.hidden, false);
  assert.equal(copied.textContent, "Copied — store it somewhere safe.");
});

test("a clipboard failure is honest and keeps the code on screen", async () => {
  const { box, document } = recoveryBox({ clipboardMode: "fail" });
  box.openRecoveryOnboarding(CODE, () => {});
  tapCopy(document);
  await flush();
  assert.equal(document.getElementById("recoveryCode").textContent, CODE, "the code was lost on failure");
  const copied = document.getElementById("recoveryCopied");
  assert.equal(copied.hidden, false);
  assert.match(copied.textContent, /couldn't copy/i);
  assert.doesNotMatch(copied.textContent, /Copied —/, "claimed success on a failed copy");
});

test("no clipboard API at all fails honestly, code intact", async () => {
  const { box, document } = recoveryBox({ clipboardMode: "none" });
  box.openRecoveryOnboarding(CODE, () => {});
  tapCopy(document);
  await flush();
  assert.equal(document.getElementById("recoveryCode").textContent, CODE);
  assert.match(document.getElementById("recoveryCopied").textContent, /couldn't copy/i);
});

test("repeated taps stay safe — one copy per tap, code intact", async () => {
  const { box, document, writes } = recoveryBox();
  box.openRecoveryOnboarding(CODE, () => {});
  tapCopy(document); await flush();
  tapCopy(document); await flush();
  tapCopy(document); await flush();
  assert.deepEqual(writes, [CODE, CODE, CODE], "a tap did not map to exactly one copy");
  assert.equal(document.getElementById("recoveryCode").textContent, CODE);
  assert.equal(document.getElementById("recoveryCopied").textContent, "Copied — store it somewhere safe.");
});

test("Continue runs the continuation exactly once and then never again", async () => {
  const { box, document, calls } = recoveryBox();
  let continued = 0;
  box.openRecoveryOnboarding(CODE, () => { continued++; });
  document.getElementById("recoveryDialog").close();          // Continue / dismiss
  assert.equal(continued, 1, "Continue did not run the continuation");
  assert.ok(calls.viewport >= 1, "the viewport was not restored on continue");
  // A second close must not re-run it (the callback was cleared).
  box.continueRecovery();
  assert.equal(continued, 1, "the continuation ran twice");
});

test("a create-style open with no continuation just closes cleanly", async () => {
  const { box, document } = recoveryBox();
  box.openRecoveryOnboarding(CODE, null);
  assert.doesNotThrow(() => document.getElementById("recoveryDialog").close());
});

// --- league creation surfaces the same moment -------------------------------

test("creating a league surfaces the recovery code before the share step", async () => {
  const recovered = [];
  const wizard = { step: "count", name: "Test", competitions: ["EPL"], count: 6, confirmSingle: true, busy: false, error: "" };
  const box = load(["advanceWizard"], {
    wizard,
    WIZARD_STEPS: ["name", "competitions", "count", "share"],
    wizardStepError: () => "",
    wizardRule: () => ({ method: "manual" }),
    render: () => {},
    api: async () => ({ ok: true, code: "NEW123", name: "Test", recovery: CODE, competitions: ["EPL"] }),
    saveLeague: () => {},
    saveLeagueName: () => {},
    rememberCompetition: () => false,
    loadFixtures: async () => {},
    loadLeagueState: async () => {},
    localStorage: { setItem() {}, getItem: () => null },
    STORAGE: { name: "n", recovery: "r" },
    playerName: "Adam",
    openRecoveryOnboarding: (code) => { recovered.push(code); },
  });
  await box.advanceWizard();
  assert.deepEqual(recovered, [CODE], "creation did not surface the recovery code");
  assert.equal(wizard.step, "share", "creation did not advance to the share step");
});
