// v1.8.1 — Profile's explicit recovery view.
//
// Profile used to print the recovery code the moment it opened. Now it opens
// with the code absent from the rendered text and a "View recovery code"
// button; the code is inserted (as text) only on that tap, copied only on an
// explicit "Copy code", and cleared on "Hide code", on close, on an identity
// change and when a restore completes. These run the REAL functions against the
// REAL profile dialog markup from index.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dialogOf = (id) => {
  const at = HTML.indexOf(`<dialog id="${id}">`);
  return HTML.slice(at, HTML.indexOf("</dialog>", at) + "</dialog>".length);
};

const CODE_A = "amber-score-oracle";
const CODE_B = "violet-corner-flag";
const flush = () => new Promise((r) => setTimeout(r, 0));

// clipboardMode: "ok" resolves and records; "fail" rejects; "none" = no API.
function profileBox({ stored = CODE_A, clipboardMode = "ok" } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${dialogOf("profileDialog")}${dialogOf("recoveryDialog")}</body>`);
  const { window } = dom;
  const { document } = window;
  for (const d of document.querySelectorAll("dialog")) {
    d.showModal = function () { this.open = true; };
    d.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  }
  const storage = new Map(stored ? [["prem_oracle_recovery", stored]] : []);
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const writes = [];
  const navigator = clipboardMode === "none" ? {}
    : clipboardMode === "fail" ? { clipboard: { writeText: async () => { throw new Error("denied"); } } }
      : { clipboard: { writeText: async (t) => { writes.push(t); } } };
  const box = load(["resetProfileRecovery", "revealProfileRecovery", "hideProfileRecovery", "copyRecovery",
    "openRecoveryOnboarding", "clearRecoveryOnboarding", "continueRecovery"], {
    document, navigator, localStorage,
    STORAGE: { recovery: "prem_oracle_recovery", uid: "prem_oracle_uid" },
    recoveryContinue: null,
  });
  // Mirror app.js's wiring (pinned below) so real taps and closes are exercised.
  const profile = document.getElementById("profileDialog");
  profile.addEventListener("click", (event) => {
    if (event.target.closest("[data-profile-recovery-view]")) box.revealProfileRecovery();
    else if (event.target.closest("[data-profile-recovery-copy]")) box.copyRecovery("profileRecoveryCode", "profileRecoveryCopied");
    else if (event.target.closest("[data-profile-recovery-hide]")) box.hideProfileRecovery();
  });
  profile.addEventListener("close", box.resetProfileRecovery);
  document.getElementById("recoveryDialog").addEventListener("close", () => { box.clearRecoveryOnboarding(); box.continueRecovery(); });
  const open = () => { box.resetProfileRecovery(); profile.showModal(); };
  const tap = (sel) => document.querySelector(sel).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const text = () => profile.textContent;
  const code = () => document.getElementById("profileRecoveryCode").textContent;
  const shown = (id) => !document.getElementById(id).hidden;
  return { box, document, profile, open, tap, text, code, shown, writes, storage };
}

const VIEW = "[data-profile-recovery-view]";
const COPY = "[data-profile-recovery-copy]";
const HIDE = "[data-profile-recovery-hide]";

test("Profile opens with the code ABSENT and a 'View recovery code' button", () => {
  const p = profileBox();
  p.open();
  assert.ok(!p.text().includes(CODE_A), "the code is in the rendered text on open");
  assert.equal(p.code(), "");
  const view = p.document.querySelector(VIEW);
  assert.equal(view.textContent.trim(), "View recovery code");
  assert.equal(view.getAttribute("type"), "button", "View would submit the profile form");
  assert.ok(p.shown("profileRecoveryView"));
  assert.ok(!p.shown("profileRecoveryRevealed"));
  // The static markup carries no code either.
  assert.ok(!dialogOf("profileDialog").includes(CODE_A));
  assert.equal(p.writes.length, 0);
});

test("an explicit View tap inserts the current identity's code, as text", () => {
  const p = profileBox({ stored: "<b>x</b>-y-z" });
  p.open();
  p.tap(VIEW);
  const el = p.document.getElementById("profileRecoveryCode");
  assert.equal(el.textContent, "<b>x</b>-y-z");
  assert.equal(el.querySelector("b"), null, "the credential was injected as HTML");
  assert.ok(p.shown("profileRecoveryRevealed"));
  assert.ok(!p.shown("profileRecoveryView"), "View is still offered with the code on screen");
  // Explicit Copy and Hide controls, both plain buttons.
  for (const [sel, label] of [[COPY, "Copy code"], [HIDE, "Hide code"]]) {
    const b = p.document.querySelector(sel);
    assert.equal(b.textContent.trim(), label);
    assert.equal(b.getAttribute("type"), "button");
  }
  assert.match(sourceOf("revealProfileRecovery"), /codeEl\.textContent = rec;/);
  assert.doesNotMatch(sourceOf("revealProfileRecovery"), /innerHTML/);
});

test("revealing never copies; only the explicit Copy tap does", async () => {
  const p = profileBox();
  p.open();
  p.tap(VIEW);
  await flush();
  assert.equal(p.writes.length, 0, "the clipboard was written without a Copy tap");
  assert.ok(!p.shown("profileRecoveryCopied"));
  p.tap(COPY);
  await flush();
  assert.deepEqual(p.writes, [CODE_A]);
  const msg = p.document.getElementById("profileRecoveryCopied");
  assert.ok(!msg.hidden);
  assert.equal(msg.textContent, "Copied — store it somewhere safe.", "not the existing success message");
  for (const fn of ["resetProfileRecovery", "revealProfileRecovery", "hideProfileRecovery"]) {
    assert.doesNotMatch(sourceOf(fn), /clipboard|writeText/, `${fn} touches the clipboard`);
  }
});

test("a failed or missing clipboard is honest and keeps the code visible", async () => {
  for (const mode of ["fail", "none"]) {
    const p = profileBox({ clipboardMode: mode });
    p.open();
    p.tap(VIEW);
    p.tap(COPY);
    await flush();
    const msg = p.document.getElementById("profileRecoveryCopied");
    assert.equal(msg.textContent, "Couldn't copy automatically — select the code above and save it by hand.", mode);
    assert.doesNotMatch(msg.textContent, /Copied —/, `${mode}: claimed success`);
    assert.equal(p.code(), CODE_A, `${mode}: the code was lost`);
  }
});

test("Hide code clears the rendered code and resets the view", async () => {
  const p = profileBox();
  p.open();
  p.tap(VIEW);
  p.tap(COPY);
  await flush();
  p.tap(HIDE);
  assert.ok(!p.text().includes(CODE_A), "the code is still in the rendered text");
  assert.equal(p.code(), "");
  assert.ok(p.shown("profileRecoveryView"));
  assert.ok(!p.shown("profileRecoveryRevealed"));
  assert.ok(!p.shown("profileRecoveryCopied"), "a stale copy confirmation survived");
  assert.equal(p.document.getElementById("profileRecoveryCopied").textContent, "");
  // Hiding does not touch the clipboard either way — never cleared, never written.
  assert.deepEqual(p.writes, [CODE_A]);
});

test("closing Profile, by any route, clears the code and resets the reveal", () => {
  const p = profileBox();
  p.open();
  p.tap(VIEW);
  assert.ok(p.text().includes(CODE_A));
  p.profile.close();                         // ×, Cancel, Escape and Save all close it
  assert.equal(p.code(), "");
  assert.ok(!p.text().includes(CODE_A));
  // Re-opening starts from the closed state, not the last reveal.
  p.open();
  assert.ok(!p.text().includes(CODE_A));
  assert.ok(p.shown("profileRecoveryView"));
});

test("an identity change clears a revealed code; the next View shows the NEW identity's", () => {
  const p = profileBox();
  p.open();
  p.tap(VIEW);
  assert.equal(p.code(), CODE_A);
  // What the restore handler, /me and the storage listener all do.
  p.storage.set("prem_oracle_recovery", CODE_B);
  p.box.resetProfileRecovery();
  assert.ok(!p.text().includes(CODE_A), "the previous identity's code stayed on screen");
  assert.ok(!p.text().includes(CODE_B), "the new code appeared without a tap");
  p.tap(VIEW);
  assert.equal(p.code(), CODE_B, "View showed a stale identity's code");
});

test("/me changing the stored code resets the view; an unchanged code leaves it alone", async () => {
  const resets = [];
  const storage = new Map([["prem_oracle_recovery", CODE_A]]);
  const make = (recovery) => load(["hydrateIdentity"], {
    API: "https://api.example",
    api: async () => ({ recovery }),
    uid: () => "u-me",
    playerName: "Adam",
    STORAGE: { recovery: "prem_oracle_recovery", name: "n", leagues: "l" },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    resetProfileRecovery: () => resets.push(storage.get("prem_oracle_recovery")),
    activeLeague: "",
    applyLaunchBranch: () => {},
    loadKnownLeagueNames: async () => {},
    syncUserPicks: async () => {},
  });
  await make(CODE_A).hydrateIdentity();
  assert.deepEqual(resets, [], "an unchanged code reset the view");
  await make(CODE_B).hydrateIdentity();
  assert.deepEqual(resets, [CODE_B], "a changed code did not reset the view");
});

test("a completed restore and a cross-tab identity change both reset the view", () => {
  const restore = APP.slice(APP.indexOf('if (event.target.matches("[data-restore]"))'));
  const block = restore.slice(0, restore.indexOf('setFlash("Identity and leagues restored.")'));
  assert.ok(block.indexOf("localStorage.setItem(STORAGE.recovery, response.recovery);") < block.indexOf("resetProfileRecovery();"),
    "a restore does not clear the old identity's rendered code");
  assert.match(APP, /window\.addEventListener\("storage", \(event\) => \{[\s\S]{0,80}?\n\s+if \(event\.key === null \|\| event\.key === STORAGE\.uid \|\| event\.key === STORAGE\.recovery\) resetProfileRecovery\(\);/);
  // And the real wiring the box above mirrors.
  assert.match(APP, /document\.getElementById\("profileDialog"\)\.addEventListener\("close", resetProfileRecovery\);/);
  assert.match(APP, /if \(event\.target\.closest\("\[data-profile-recovery-view\]"\)\) revealProfileRecovery\(\);/);
  assert.match(APP, /else if \(event\.target\.closest\("\[data-profile-recovery-copy\]"\)\) copyRecovery\("profileRecoveryCode", "profileRecoveryCopied"\);/);
  assert.match(APP, /else if \(event\.target\.closest\("\[data-profile-recovery-hide\]"\)\) hideProfileRecovery\(\);/);
  // Opening Profile resets before it shows.
  const opener = APP.slice(APP.indexOf('document.getElementById("profileButton").addEventListener("click"'));
  const body = opener.slice(0, opener.indexOf("\n});"));
  assert.ok(body.indexOf("resetProfileRecovery();") > -1 && body.indexOf("resetProfileRecovery();") < body.indexOf("showModal()"));
  assert.ok(!body.includes("STORAGE.recovery"), "opening Profile still reads the credential");
});

test("no code available: an honest, non-secret message instead", () => {
  const p = profileBox({ stored: null });
  p.open();
  p.tap(VIEW);
  const msg = p.document.getElementById("profileRecoveryMissing");
  assert.ok(!msg.hidden);
  assert.equal(msg.textContent, "No recovery code is saved on this device. One is issued when you join or create a league.");
  assert.ok(!p.shown("profileRecoveryRevealed"), "an empty code box was revealed");
  assert.equal(p.code(), "");
  // Closing resets that too.
  p.profile.close();
  assert.ok(msg.hidden);
});

test("no screenshot-protection claim, and the credential stays out of every other surface", () => {
  const profile = dialogOf("profileDialog");
  assert.doesNotMatch(profile, /screenshot|screen capture|protected/i);
  for (const fn of ["resetProfileRecovery", "revealProfileRecovery", "hideProfileRecovery"]) {
    assert.doesNotMatch(sourceOf(fn), /console\.|setFlash|api\(|fetch\(/, `${fn} logs or sends something`);
  }
  for (const fn of ["diagnosticsText", "leagueView", "weeklyCardModel", "seasonCardModel", "shareNow"]) {
    // The League screen legitimately ASKS for a code (the restore form); none
    // of these may READ the stored one.
    assert.ok(!sourceOf(fn).includes("STORAGE.recovery"), `${fn} reads the recovery code`);
  }
});

test("post-join / post-create onboarding is unchanged and independent", async () => {
  const p = profileBox();
  // The onboarding dialog still shows the code immediately, exactly as before…
  p.box.openRecoveryOnboarding(CODE_A, null);
  assert.equal(p.document.getElementById("recoveryCode").textContent, CODE_A);
  // …copies with its own default elements…
  await p.box.copyRecovery();
  assert.deepEqual(p.writes, [CODE_A]);
  assert.equal(p.document.getElementById("recoveryCopied").textContent, "Copied — store it somewhere safe.");
  // …and leaves Profile's view untouched.
  assert.equal(p.code(), "");
  assert.ok(p.document.getElementById("profileRecoveryCopied").hidden);
  assert.match(APP, /if \(event\.target\.closest\("\[data-recovery-copy\]"\)\) copyRecovery\(\);/);
});

// --- review fix: a /me answer for an identity this device has left ----------

test("REGRESSION: a /me response that lands after a restore cannot plant the old identity's code", async () => {
  // Reproduced against 4450593: uid u-B, stored recovery code-A, leagues ["AAA"].
  const store = new Map([["uid", "u-A"], ["rec", CODE_A], ["l", '["AAA"]']]);
  const resets = [];
  let answer;
  const b = load(["hydrateIdentity"], {
    API: "https://api.example",
    uid: () => store.get("uid"),
    playerName: "",
    api: () => new Promise((resolve) => { answer = resolve; }),
    STORAGE: { recovery: "rec", name: "n", leagues: "l" },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    resetProfileRecovery: () => resets.push(store.get("rec")),
    activeLeague: "", leagueCodes: [], pruneStoredLeagueNames: () => {}, setActiveLeague: () => {},
    applyLaunchBranch: () => {}, loadKnownLeagueNames: async () => {}, syncUserPicks: async () => {},
  });
  const pending = b.hydrateIdentity();
  // The restore handler completes while /me for u-A is still in flight.
  store.set("uid", "u-B"); store.set("rec", CODE_B); store.set("l", '["BBB"]');
  answer({ uid: "u-A", nickname: "Old", recovery: CODE_A, leagues: ["AAA"] });
  await pending;
  assert.equal(store.get("rec"), CODE_B, "the previous identity's recovery code was written under the new one");
  assert.equal(store.get("l"), '["BBB"]', "the previous identity's leagues were written under the new one");
  assert.equal(store.get("n"), undefined, "the previous identity's name was adopted");
  assert.deepEqual(resets, [], "a stale answer touched the Profile view");
  // A revealed code is therefore the restored identity's.
  const p = profileBox({ stored: store.get("rec") });
  p.open();
  p.tap(VIEW);
  assert.equal(p.code(), CODE_B);
});

test("an in-flight /me for the SAME identity still applies", async () => {
  const store = new Map([["uid", "u-A"], ["rec", CODE_A]]);
  const resets = [];
  const b = load(["hydrateIdentity"], {
    API: "https://api.example", uid: () => store.get("uid"), playerName: "Adam",
    api: async () => ({ recovery: CODE_B, leagues: ["AAA"] }),
    STORAGE: { recovery: "rec", name: "n", leagues: "l" },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    resetProfileRecovery: () => resets.push(store.get("rec")),
    activeLeague: "", leagueCodes: [], pruneStoredLeagueNames: () => {}, setActiveLeague: () => {},
    applyLaunchBranch: () => {}, loadKnownLeagueNames: async () => {}, syncUserPicks: async () => {},
  });
  await b.hydrateIdentity();
  assert.equal(store.get("rec"), CODE_B);
  assert.equal(store.get("l"), '["AAA"]');
  assert.deepEqual(resets, [CODE_B]);
});

test("another tab clearing storage outright (key null) clears a revealed code", () => {
  const p = profileBox();
  p.open();
  p.tap(VIEW);
  assert.equal(p.code(), CODE_A);
  // Mirror of the real listener, whose source is pinned above.
  const onStorage = (event) => {
    if (event.key === null || event.key === "prem_oracle_uid" || event.key === "prem_oracle_recovery") p.box.resetProfileRecovery();
  };
  onStorage({ key: null });
  assert.equal(p.code(), "");
  assert.ok(!p.text().includes(CODE_A));
});

test("closing onboarding clears ITS copy only — Profile can still reveal the stored code", () => {
  const p = profileBox();
  const onboarding = p.document.getElementById("recoveryDialog");
  p.box.openRecoveryOnboarding(CODE_A, null);
  assert.ok(onboarding.outerHTML.includes(CODE_A));
  onboarding.close();
  assert.ok(!p.document.body.innerHTML.includes(CODE_A), "the code is still somewhere in the DOM after onboarding");
  assert.equal(p.storage.get("prem_oracle_recovery"), CODE_A, "the stored credential was cleared");
  p.open();
  assert.ok(!p.text().includes(CODE_A));
  p.tap(VIEW);
  assert.equal(p.code(), CODE_A, "Profile lost the player's code");
});
