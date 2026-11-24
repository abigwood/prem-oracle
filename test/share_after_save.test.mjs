// v1.8.1 fold-in — "share after save".
//
// One prompt on My Picks, raised only by the successful save that takes the
// ACTIVE league from incomplete to every required prediction saved. These run
// the REAL savePick → picksView → sharePromptHtml → shareNow → leagueInvite
// chain against a JSDOM, with the network, the share sheet and storage stubbed
// at their edges.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const HOUR = 3600000;
const now = Date.now();
const fx = (id, hours = 48) => ({ id, player1: "Arsenal", player2: "Coventry City", matchday: 13,
  startAt: new Date(now + hours * HOUR).toISOString() });
const A = [fx("a1"), fx("a2"), fx("a3")];
const B = [fx("b1"), fx("b2")];
const W2 = [fx("w1"), fx("w2")];          // a later week for league AAA

const league = (code, name, ids, period = "13") => ({
  code, name, currentPeriod: period,
  currentSlate: { period, matchweek: Number(period), status: "published", fixtureIds: ids, count: ids.length },
  table: [], owner: "u-host",
});

const NAMES = [
  "matchweekLeagueState", "matchweekLeagueName", "matchweekSlate", "matchweekSlots",
  "matchweekContext", "matchweekEmpty", "matchweekUnavailable",
  "matchweekRowState", "MATCHWEEK_ROW_LINE", "shortKickoff", "closedStatus", "matchOpen", "finalScore",
  "VOID_STATUSES", "isVoidFixture", "isPostponed", "clientLockMs",
  "picksView", "pickActionSummary", "pickCounts", "launchBranch", "pickRow", "pickRowKickoff", "pickRowMark",
  "pickRowBody", "pickRowLabel", "PICK_SAVED_MS", "pickJustSaved", "pickListState", "pickShareRow",
  "pickDeadlineLine", "expandPick", "pickEditable", "resultState", "isSettledCard", "RESULT_FIRST_STATES",
  "validScore", "savePick",
  "SHARE_PROMPT_DONE", "sharePromptKey", "sharePromptDone", "markSharePromptDone", "slotsComplete",
  "activeLeagueCompletion", "noteSaveCompletion", "sharePromptHtml", "shareFromPrompt", "dismissSharePrompt",
  "removeSharePrompt", "shareNow", "leagueInvite", "inviteLinkFor", "whatsappUrlFor", "cssEscape",
];

/**
 * share: "ok" | "cancel" | "fail" | "none" (no sheet at all); native: use the
 * Capacitor plugin path instead of navigator.share.
 */
function world({ who = "u1", active = "AAA", picks = {}, share = "ok", native = false, storage = new Map(),
  apiFails = false, leagues = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body><main id="app"></main></body>`, { url: "https://abigwood.github.io/prem-oracle/" });
  const { window } = dom;
  const { document } = window;
  const shares = [];
  const sheet = (payload) => {
    shares.push(payload);
    if (share === "ok") return Promise.resolve();
    if (share === "cancel") return Promise.reject(Object.assign(new Error("Share canceled"), { name: "AbortError" }));
    return Promise.reject(new TypeError("Type error"));
  };
  const loc = { origin: "https://abigwood.github.io", pathname: "/prem-oracle/", href: "https://abigwood.github.io/prem-oracle/" };
  const states = leagues || { AAA: league("AAA", "Burtons Premier", A.map((f) => f.id)), BBB: league("BBB", "BVW Premier", B.map((f) => f.id)) };
  const calls = { api: 0, renders: 0 };
  let identity = who;
  const box = load(NAMES, {
    document, window: { CSS: window.CSS },
    location: loc,
    navigator: share === "none" || native ? {} : { share: sheet },
    isNativeApp: () => native,
    WEB_BASE: "https://abigwood.github.io/prem-oracle/",
    picks: { ...picks },
    fixtures: [...A, ...B, ...W2],
    activeLeague: active,
    leagueState: states[active],
    leagueStates: states,
    leagueCodes: Object.keys(states),
    leagueNames: {},
    expandedPickId: null,
    busyMatch: "",
    sharePrompt: null,
    API: "https://api.example",
    api: async () => { calls.api++; if (apiFails) throw new Error("Network down"); return { ok: true }; },
    playerName: "Adam",
    STORAGE: { picks: "prem_oracle_picks" },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    uid: () => identity,
    setFlash: () => {}, scheduleReminderOffer: () => {},
    shareIconButton: () => "", matchweekCountMismatches: new Map(), periodLabel: (p) => `Matchweek ${p}`,
    pulsingStatus: (m) => m, picksDue: () => [], periodOfFixture: (f) => String(f?.matchday ?? ""),
    installNotice: () => "", slateNotice: () => "", preseasonState: () => "", inviteCode: "",
    onboardingState: () => "", leagueSwitcher: () => "", countPhrase: (n, w) => `${n} ${w}`,
    teamBadge: () => "<i></i>", matchCard: () => "", fixtureRevealSection: () => "",
  });
  if (native) box.window.Capacitor = { Plugins: { Share: { share: sheet } } };
  const render = () => { calls.renders++; document.getElementById("app").innerHTML = box.picksView(); };
  box.render = render;
  // Mirror the real click wiring (its source and position are pinned below).
  document.addEventListener("click", (event) => {
    const promptShare = event.target.closest("[data-share-prompt-share]");
    if (promptShare) { box.lastShare = box.shareFromPrompt(promptShare.dataset.sharePromptShare); return; }
    const promptDismiss = event.target.closest("[data-share-prompt-dismiss]");
    if (promptDismiss) box.dismissSharePrompt(promptDismiss.dataset.sharePromptDismiss);
  });
  render();
  const prompts = () => document.querySelectorAll("[data-share-prompt]");
  const tap = (sel) => document.querySelector(sel).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const save = (id, p1 = 1, p2 = 0) => box.savePick(id, p1, p2);
  const switchTo = (code) => { box.evalIn(`activeLeague = ${JSON.stringify(code)}; leagueState = leagueStates[activeLeague];`); render(); };
  const become = (next) => { identity = next; render(); };
  return { box, document, window, storage, shares, calls, loc, prompts, tap, save, render, switchTo, become, states };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// --- 1 · when it appears ------------------------------------------------------

test("saves that leave the week incomplete never show it", async () => {
  const w = world();
  await w.save("a1");
  await w.save("a2");
  assert.equal(w.prompts().length, 0);
  assert.equal(w.document.body.innerHTML.includes("with mates"), false);
});

test("the final successful save shows it exactly once, with the approved copy", async () => {
  const w = world();
  await w.save("a1");
  await w.save("a2");
  await w.save("a3");
  assert.equal(w.prompts().length, 1);
  const p = w.prompts()[0];
  assert.equal(p.querySelector(".share-prompt-title").textContent, "All 3 predictions saved ✓");
  assert.equal(p.querySelector(".share-prompt-sub").textContent, "Share Burtons Premier with mates");
  assert.equal(p.querySelector("[data-share-prompt-share]").textContent, "Share");
  // It sits under the list, so it never moves a fixture row.
  assert.ok(p.previousElementSibling.matches("[data-pick-list]"), "the prompt is not directly under the rows");
});

test("an already-complete screen never shows it, however often it renders", () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 }, a3: { p1: 1, p2: 0 } } });
  for (let i = 0; i < 5; i++) w.render();
  assert.equal(w.prompts().length, 0);
});

test("editing a pick in an already-complete week does not raise it", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 }, a3: { p1: 1, p2: 0 } } });
  await w.save("a3", 2, 2);
  assert.equal(w.prompts().length, 0);
});

test("a final save that FAILS does not raise it", async () => {
  const w = world({ apiFails: true, picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  assert.equal(w.prompts().length, 0);
  assert.equal(w.box.evalIn("sharePrompt"), null);
});

test("it never appears while the final save is still in flight", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  const pending = w.save("a3");               // optimistic paint has happened, server has not answered
  assert.equal(w.prompts().length, 0, "the prompt appeared before the save succeeded");
  await pending;
  assert.equal(w.prompts().length, 1);
});

test("repeated saves and renders cannot duplicate it, and it announces once", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  // Two quick saves of the last fixture: the second is an edit of a complete week.
  await Promise.all([w.save("a3"), w.save("a3", 2, 1)]);
  assert.equal(w.prompts().length, 1);
  // Announced on the paint that first shows it, and only that one.
  const s = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await s.save("a3");
  assert.equal(s.document.querySelectorAll('[data-share-prompt] [role="status"]').length, 1, "first paint is not announced");
  s.render();
  assert.equal(s.document.querySelectorAll('[data-share-prompt] [role="status"]').length, 0, "it re-announces on a repaint");
  await w.save("a2", 3, 3);
  for (let i = 0; i < 4; i++) w.render();
  assert.equal(w.prompts().length, 1);
  assert.equal(w.document.querySelectorAll('[data-share-prompt] [role="status"]').length, 0, "it re-announces on every repaint");
});

test("a league switched DURING the final save does not get the prompt", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  const pending = w.save("a3");
  w.switchTo("BBB");
  await pending;
  assert.equal(w.prompts().length, 0);
  w.switchTo("AAA");
  assert.equal(w.prompts().length, 0, "a completion seen from another league was attributed to this one");
});

// --- 2 · Share ------------------------------------------------------------------

test("Share invokes the existing league invite, with this league's link", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  // Raised inside the tap: the sheet was asked for before anything awaited.
  assert.equal(w.shares.length, 1);
  assert.deepEqual({ ...w.shares[0] }, { ...w.box.leagueInvite("AAA") });
  assert.equal(w.shares[0].url, "https://abigwood.github.io/prem-oracle/?league=AAA");
  assert.match(w.shares[0].text, /^Join my Prem Oracle league AAA/);
  await w.box.lastShare;
});

test("in the native shell it goes through the Capacitor share sheet, same invite", async () => {
  const w = world({ native: true, picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  assert.equal(w.shares.length, 1);
  assert.equal(w.shares[0].dialogTitle, "Prem Oracle");
  assert.equal(w.shares[0].url, "https://abigwood.github.io/prem-oracle/?league=AAA");
  assert.equal(await w.box.lastShare, "shared");
  assert.equal(w.prompts().length, 0);
});

test("a successful share retires it, and a later completion never brings it back", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  assert.equal(await w.box.lastShare, "shared");
  assert.equal(w.prompts().length, 0, "the prompt stayed after sharing");
  assert.equal(w.storage.get("prem_oracle_share_prompt_done:u1:AAA"), "1");
  // Next week, AAA goes from incomplete to complete again.
  w.box.evalIn(`leagueStates.AAA = ${JSON.stringify(league("AAA", "Burtons Premier", W2.map((f) => f.id), "14"))}; leagueState = leagueStates.AAA;`);
  w.render();
  await w.save("w1");
  await w.save("w2");
  assert.equal(w.prompts().length, 0);
});

test("dismissal retires it too, and is a labelled control", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  const dismiss = w.document.querySelector("[data-share-prompt-dismiss]");
  assert.equal(dismiss.getAttribute("aria-label"), "Dismiss");
  assert.equal(dismiss.getAttribute("type"), "button");
  w.tap("[data-share-prompt-dismiss]");
  assert.equal(w.prompts().length, 0);
  assert.equal(w.shares.length, 0, "dismissing shared something");
  assert.equal(w.storage.get("prem_oracle_share_prompt_done:u1:AAA"), "1");
  w.render();
  assert.equal(w.prompts().length, 0, "it came back on the next paint");
  w.box.evalIn(`leagueStates.AAA = ${JSON.stringify(league("AAA", "Burtons Premier", W2.map((f) => f.id), "14"))}; leagueState = leagueStates.AAA;`);
  w.render();
  await w.save("w1");
  await w.save("w2");
  assert.equal(w.prompts().length, 0);
});

test("a cancelled sheet does not retire it, says nothing, and goes nowhere", async () => {
  const w = world({ share: "cancel", picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  assert.equal(await w.box.lastShare, "cancelled");
  assert.equal(w.prompts().length, 1, "a cancel removed the prompt");
  assert.equal(w.storage.has("prem_oracle_share_prompt_done:u1:AAA"), false);
  assert.equal(w.loc.href, "https://abigwood.github.io/prem-oracle/", "a cancel bounced the player to WhatsApp");
  // It still works afterwards.
  w.render();
  assert.equal(w.prompts().length, 1);
});

test("a failed sheet takes the existing fallback, quietly, and does not retire it", async () => {
  const w = world({ share: "fail", picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  assert.equal(await w.box.lastShare, "handed-off");
  assert.match(w.loc.href, /^https:\/\/wa\.me\/\?text=Join%20my%20Prem%20Oracle%20league%20AAA/);
  assert.equal(w.storage.has("prem_oracle_share_prompt_done:u1:AAA"), false, "an unconfirmed hand-off counted as a share");
  assert.equal(w.prompts().length, 1);
  assert.ok(!/shared|thanks/i.test(w.document.body.textContent.replace("Share Burtons", "")), "claimed a share that is not known to have happened");
});

test("no share sheet at all: the existing WhatsApp hand-off, not a share", async () => {
  const w = world({ share: "none", picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.tap("[data-share-prompt-share]");
  assert.equal(await w.box.lastShare, "handed-off");
  assert.match(w.loc.href, /^https:\/\/wa\.me\//);
  assert.equal(w.prompts().length, 1);
});

// --- 3 · scoping --------------------------------------------------------------

test("one player's dismissal never touches another player or another league", async () => {
  const storage = new Map();
  const u1 = world({ who: "u1", storage, picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await u1.save("a3");
  u1.tap("[data-share-prompt-dismiss]");
  assert.deepEqual([...storage.keys()].filter((k) => k.startsWith("prem_oracle_share_prompt_done")), ["prem_oracle_share_prompt_done:u1:AAA"]);
  // Another player on the same device, same league.
  const u2 = world({ who: "u2", storage, picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await u2.save("a3");
  assert.equal(u2.prompts().length, 1, "u1's dismissal suppressed u2");
  // The same player, a different league.
  const u1b = world({ who: "u1", storage, active: "BBB", picks: { b1: { p1: 1, p2: 0 } } });
  await u1b.save("b2");
  assert.equal(u1b.prompts().length, 1, "u1's AAA dismissal suppressed BBB");
  assert.equal(u1b.prompts()[0].querySelector(".share-prompt-sub").textContent, "Share BVW Premier with mates");
});

test("an identity change hides a prompt raised for the previous player", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  assert.equal(w.prompts().length, 1);
  w.become("u9");
  assert.equal(w.prompts().length, 0);
});

test("a league switch shows only that league's prompt", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  w.switchTo("BBB");
  assert.equal(w.prompts().length, 0);
  w.switchTo("AAA");
  assert.equal(w.prompts().length, 1);
});

// --- 4 · it changes nothing else -----------------------------------------------

test("source: the taps sit above every await; no analytics, worker writes or new endpoint", () => {
  const handler = APP.slice(APP.indexOf('document.addEventListener("click", async (event) => {'));
  const head = handler.slice(0, handler.indexOf("const leagueCountStep = event.target.closest")).replace(/\/\/[^\n]*/g, "");
  assert.ok(!head.includes("await"));
  assert.match(head, /const promptShare = event\.target\.closest\("\[data-share-prompt-share\]"\);\n\s+if \(promptShare\) \{\n\s+shareFromPrompt\(promptShare\.dataset\.sharePromptShare\);/);
  assert.match(head, /dismissSharePrompt\(promptDismiss\.dataset\.sharePromptDismiss\);/);
  // shareFromPrompt reaches shareNow with nothing awaited first.
  assert.match(sourceOf("shareFromPrompt"), /return shareNow\(leagueInvite\(code\)\)\.then\(/);
  assert.ok(!/await|async/.test(sourceOf("shareFromPrompt")));
  for (const fn of ["noteSaveCompletion", "sharePromptHtml", "shareFromPrompt", "dismissSharePrompt", "markSharePromptDone", "removeSharePrompt"]) {
    assert.ok(!/api\(|fetch\(|sendBeacon|analytics|track|console\./.test(sourceOf(fn)), `${fn} reports somewhere`);
  }
  // The other share entry points are as they were.
  assert.match(APP, /shareNow\(leagueInvite\(share\.dataset\.shareLeague\)\);/);
});

test("the prompt is the only addition to the rows' screen", async () => {
  const w = world();
  const before = w.document.querySelector("[data-pick-list]").outerHTML;
  await w.save("a1"); await w.save("a2"); await w.save("a3");
  // Same rows (save state aside), plus one section under them.
  const rows = [...w.document.querySelectorAll("[data-pick-row]")].map((r) => r.dataset.rowState);
  assert.deepEqual(rows, ["open", "open", "open"]);
  assert.equal(before.match(/data-pick-row=/g).length, 3);
});

// --- 5 · presentation ------------------------------------------------------------

test("slim and responsive: a wrapping text column, 44px targets, no motion", () => {
  const block = CSS.match(/\n\.share-prompt \{([^}]*)\}/)[1];
  assert.match(block, /grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(CSS, /\.share-prompt-sub \{[^}]*\}/);
  assert.match(CSS.match(/\.share-prompt-title,\n\.share-prompt-sub \{([^}]*)\}/)[1], /overflow-wrap: anywhere/);
  // Height is bounded for any permitted name: the name line clamps at two.
  const sub = [...CSS.matchAll(/\n\.share-prompt-sub \{([^}]*)\}/g)].map((m) => m[1]).find((b) => /line-clamp/.test(b)) || "";
  assert.match(sub, /-webkit-line-clamp: 2;/);
  assert.match(sub, /overflow: hidden;/);
  assert.match(CSS.match(/\.share-prompt-go \{([^}]*)\}/)[1], /min-height: 44px/);
  const dismiss = CSS.match(/\.share-prompt-dismiss \{([^}]*)\}/)[1];
  assert.match(dismiss, /width: 44px/);
  assert.match(dismiss, /height: 44px/);
  const all = [...CSS.matchAll(/\.share-prompt[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join("");
  assert.doesNotMatch(all, /animation|transition/, "an entrance animation needs a reduced-motion guard");
  assert.match(CSS, /\.share-prompt-go:focus-visible,\n\.share-prompt-dismiss:focus-visible \{[^}]*outline/);
});

test("contrast: every text/background pair in the prompt clears WCAG AA", () => {
  const lum = (hex) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const bg = CSS.match(/\n\.share-prompt \{[^}]*background: (#[0-9a-f]{6})/i)[1];
  for (const [label, fg, back] of [["title", "#064d41", bg], ["sub", "#17202a", bg], ["dismiss", "#064d41", bg], ["Share", "#ffffff", "#0a7f58"]]) {
    assert.ok(ratio(fg, back) >= 4.5, `${label} ${ratio(fg, back).toFixed(2)}:1`);
  }
});

test("a maximum-length (40-character) league name renders whole and escaped", async () => {
  const name = "W".repeat(36) + " <b>";                      // 40 chars, worst-case width, markup-like
  assert.equal(name.length, 40);
  const states = { AAA: league("AAA", name, A.map((f) => f.id)) };
  const w = world({ leagues: states, picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  const sub = w.prompts()[0].querySelector(".share-prompt-sub");
  assert.equal(sub.textContent, `Share ${name} with mates`);
  assert.equal(sub.querySelector("b"), null, "the league name was injected as markup");
});

test("the focus order is message, Share, Dismiss; dismissal hands focus on", async () => {
  const w = world({ picks: { a1: { p1: 1, p2: 0 }, a2: { p1: 1, p2: 0 } } });
  await w.save("a3");
  const focusables = [...w.prompts()[0].querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(focusables, ["Share", "×"]);
  assert.equal(w.prompts()[0].getAttribute("aria-labelledby"), "share-prompt-title");
  w.document.querySelector("[data-share-prompt-dismiss]").focus();
  w.tap("[data-share-prompt-dismiss]");
  assert.ok(w.document.activeElement.matches("[data-expand-pick]"), "focus was dropped to the body");
});
