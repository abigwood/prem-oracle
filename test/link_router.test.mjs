// v1.9 §1 — invite links open the right league (iOS).
//
// On build 35 a tapped https://abigwood.github.io/prem-oracle/?league=SWAF5M
// opened the app on whatever league was last viewed: @capacitor/app was never
// installed, so neither the cold-launch URL nor the warm appUrlOpen reached the
// page. These drive the REAL router — linkRoute → followIncomingLink →
// followLinkRoute — through the REAL setupNativeUniversalLinks, over a fake
// App plugin, for cold and warm launches × member / not a member / dead code,
// and the REAL join sheet for what a dead code says.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const JOIN_DIALOG = HTML.slice(HTML.indexOf('<dialog id="joinDialog">'),
  HTML.indexOf("</dialog>", HTML.indexOf('<dialog id="joinDialog">')) + "</dialog>".length);
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SPM = readFileSync(new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url), "utf8");

const LINK = (code) => `https://abigwood.github.io/prem-oracle/?league=${code}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake @capacitor/app: a launch URL for a cold start, and a way to fire a warm one. */
function fakeApp(launchUrl = "") {
  let listener = null;
  return {
    addListener: async (name, fn) => { if (name === "appUrlOpen") listener = fn; return { remove() {} }; },
    getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : undefined),
    warm: (url) => listener?.({ url }),
  };
}

function world({ codes = ["AAA111", "SWAF5M"], active = "AAA111", launchUrl = "", native = true,
  state = (code) => (code === "DEAD00" ? Promise.reject(new Error("League not found")) : Promise.resolve({ code, name: `${code} League` })),
  session = new Map() } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${JOIN_DIALOG}</body>`);
  const { document } = dom.window;
  const dialog = document.getElementById("joinDialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };
  const plugin = fakeApp(launchUrl);
  const calls = { switched: [], views: [], sheets: [], writes: [] };
  const box = load([
    "leagueCodeFromUrl", "requestedView", "LEGACY_VIEWS", "normaliseView", "linkRoute", "followLinkRoute",
    "LAST_LINK_KEY", "LINK_REPEAT_MS", "followIncomingLink", "setupNativeUniversalLinks",
    "MATCHDAY_VIEWS", "UK_DATE_RE", "matchdayRouteFromBlock", "matchdayRouteFromSearch",
    "openJoinSheet", "clearJoinFeedback",
  ], {
    document,
    location: { href: "capacitor://localhost/", search: "" },
    window: { Capacitor: { isNativePlatform: () => native }, capacitorApp: { App: plugin } },
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)) },
    // Identity, recovery and picks live here. A link may never write to it.
    localStorage: { getItem: () => null, setItem: (k) => calls.writes.push(k), removeItem: (k) => calls.writes.push(k) },
    API: "https://api.test",
    api: (path) => state(/code=([A-Z0-9]+)/.exec(path)[1]),
    playerName: "Adam",
    inviteCode: "",
    lastLink: { url: "", at: 0 },
    joinSheetCode: "",
    joinSheetGeneration: 0,
    joinSubmitInFlight: false,
    leagueCodes: codes,
    activeLeague: active,
    URL,
    URLSearchParams,
    render: () => {},
  });
  // Recorded through the box, so the router's own writes to activeLeague count.
  box.setActiveLeague = (code) => { calls.switched.push(code); box.activeLeague = code; };
  box.navigateToView = async (view) => { calls.views.push(view); };
  const realOpen = box.openJoinSheet;
  box.openJoinSheet = (code) => { calls.sheets.push(code); realOpen(code); };
  box.evalIn("var setActiveLeague = globalThis.setActiveLeague, navigateToView = globalThis.navigateToView, openJoinSheet = globalThis.openJoinSheet;");
  return { box, plugin, calls, document, dialog, session };
}

const heading = (document) => document.getElementById("joinLeagueName").textContent;
const intro = (document) => document.getElementById("joinIntro").textContent;

// --- the route itself ----------------------------------------------------------

test("a link names a league (upper-cased) and opens it on My Picks unless it names a view", () => {
  const { box } = world();
  assert.deepEqual({ ...box.linkRoute(LINK("swaf5m")) }, { league: "SWAF5M", view: "picks" });
  assert.deepEqual({ ...box.linkRoute(`${LINK("SWAF5M")}&view=league`) }, { league: "SWAF5M", view: "league" });
  // v1.7.1's removed routes come back as My Picks, exactly as on the web.
  assert.equal(box.linkRoute(`${LINK("SWAF5M")}&view=mates`).view, "picks");
  for (const nothing of ["", "https://abigwood.github.io/prem-oracle/", "not a url at all ::", "premoracle://x?view=league"]) {
    assert.equal(box.linkRoute(nothing), null, nothing);
  }
});

// --- cold launch: the link arrives as getLaunchUrl -----------------------------

test("cold · a member is switched to that league's My Picks", async () => {
  const { box, calls } = world({ launchUrl: LINK("SWAF5M") });
  await box.setupNativeUniversalLinks();
  assert.deepEqual(calls.switched, ["SWAF5M"]);
  assert.deepEqual(calls.views, ["picks"]);
  assert.deepEqual(calls.sheets, [], "a member was offered a join");
});

test("cold · a member already on that league is not re-switched, but lands on My Picks", async () => {
  const { box, calls } = world({ launchUrl: LINK("SWAF5M"), active: "SWAF5M" });
  await box.setupNativeUniversalLinks();
  assert.deepEqual(calls.switched, []);
  assert.deepEqual(calls.views, ["picks"]);
});

test("cold · not a member gets the one-step 'You're invited' join sheet", async () => {
  const { box, calls, document, dialog } = world({ launchUrl: LINK("NEW123") });
  await box.setupNativeUniversalLinks();
  await flush();
  assert.deepEqual(calls.sheets, ["NEW123"]);
  assert.equal(dialog.open, true);
  assert.equal(heading(document), "Join NEW123 League");
  assert.equal(box.inviteCode, "NEW123", "the My Picks invitation notice has nothing to show");
  assert.deepEqual(calls.switched, [], "a non-member was switched to a league they don't play");
  assert.deepEqual(calls.views, []);
});

test("cold · a dead code says what to do, in the web's own words, and joins nothing", async () => {
  const { box, document } = world({ launchUrl: LINK("DEAD00") });
  await box.setupNativeUniversalLinks();
  await flush();
  assert.equal(heading(document), "League not found");
  assert.equal(intro(document), "This invitation link is unknown or has expired. Check the code with whoever invited you.");
  assert.equal(document.getElementById("joinSubmit").disabled, true);
  // The very function the web build opens for ?league= at launch.
  assert.match(APP, /if \(joinInvite && API && !sheetOpen\) openJoinSheet\(joinInvite\);/);
});

// --- warm: the link arrives as appUrlOpen ------------------------------------

test("warm · a member is switched; not a member is invited; a dead code is explained", async () => {
  const { box, plugin, calls, document, dialog } = world();
  await box.setupNativeUniversalLinks();
  assert.deepEqual(calls, { switched: [], views: [], sheets: [], writes: [] }, "a launch with no link routed somewhere");

  await plugin.warm(LINK("SWAF5M"));
  assert.deepEqual(calls.switched, ["SWAF5M"]);
  assert.deepEqual(calls.views, ["picks"]);

  await plugin.warm(LINK("NEW123"));
  await flush();
  assert.deepEqual(calls.sheets, ["NEW123"]);
  assert.equal(heading(document), "Join NEW123 League");

  dialog.close();
  await plugin.warm(LINK("DEAD00"));
  await flush();
  assert.equal(heading(document), "League not found");
  assert.deepEqual(calls.switched, ["SWAF5M"], "an invite or a dead code moved the viewer's league");
});

test("one link is followed once: a cold launch's retained event, a reload's launch URL", async () => {
  const session = new Map();
  const first = world({ launchUrl: LINK("SWAF5M"), session });
  await first.box.setupNativeUniversalLinks();
  // The plugin retains appUrlOpen until a listener takes it: the same link again, at once.
  await first.plugin.warm(LINK("SWAF5M"));
  assert.deepEqual(first.calls.switched, ["SWAF5M"]);
  // An update reload asks for the launch URL again within the same webview session.
  const reload = world({ launchUrl: LINK("SWAF5M"), session, active: "AAA111" });
  await reload.box.setupNativeUniversalLinks();
  assert.deepEqual(reload.calls.switched, [], "a reload re-followed the link that launched the app");
  // A deliberate second tap later is a new arrival.
  reload.box.lastLink = { url: LINK("SWAF5M"), at: Date.now() - 10000 };
  await reload.plugin.warm(LINK("SWAF5M"));
  assert.deepEqual(reload.calls.switched, ["SWAF5M"]);
});

test("a link never writes identity, recovery or picks", async () => {
  for (const url of [LINK("SWAF5M"), LINK("NEW123"), LINK("DEAD00")]) {
    const { box, plugin, calls } = world({ launchUrl: url });
    await box.setupNativeUniversalLinks();
    await plugin.warm(url.replace("prem-oracle/", "prem-oracle/index.html"));
    await flush();
    assert.deepEqual(calls.writes, [], `${url} wrote ${calls.writes}`);
  }
  for (const name of ["linkRoute", "followLinkRoute", "followIncomingLink", "setupNativeUniversalLinks"]) {
    assert.doesNotMatch(sourceOf(name), /localStorage|STORAGE\.(uid|recovery|picks|name)|\/league\/join/, name);
  }
});

test("web · nothing here runs, and ?league= is read off the page's own URL as before", async () => {
  const { box, calls } = world({ native: false, launchUrl: LINK("SWAF5M") });
  await box.setupNativeUniversalLinks();
  assert.deepEqual(calls, { switched: [], views: [], sheets: [], writes: [] });
  assert.match(APP, /let inviteCode = new URLSearchParams\(location\.search\)\.get\("league"\)\?\.toUpperCase\(\) \|\| "";/);
  assert.match(APP, /const linked = inviteCode && leagueCodes\.includes\(inviteCode\) && inviteCode !== activeLeague/);
});

test("the link is listened for straight after the first paint, not after identity", () => {
  const first = APP.indexOf("\nrender();\n", APP.indexOf("hydrateCachedLeague();\n"));
  const setup = APP.indexOf("\nsetupNativeUniversalLinks();\n");
  const boot = APP.indexOf("Promise.all([loadFixtures(), hydrateIdentity()])");
  assert.ok(first > 0 && setup > first && setup < boot, "listened for too late");
  assert.equal(APP.split("setupNativeUniversalLinks();").length - 1, 1, "listened for twice");
});

test("@capacitor/app is installed, pinned, and in the iOS package", () => {
  assert.equal(PKG.dependencies["@capacitor/app"], "8.1.2");
  assert.match(SPM, /\.package\(name: "CapacitorApp", path: "\.\.\/\.\.\/\.\.\/node_modules\/@capacitor\/app"\)/);
  assert.match(SPM, /\.product\(name: "CapacitorApp", package: "CapacitorApp"\)/);
  // The page reaches it through the existing shim's global.
  assert.match(HTML, /<script src="vendor\/capacitor\/app\.js" defer><\/script>/);
});

test("boot does not re-open a sheet a cold-launch link already opened (it would clear the name being typed)", () => {
  const boot = APP.slice(APP.indexOf("Promise.all([loadFixtures(), hydrateIdentity()])"));
  assert.match(boot, /const sheetOpen = document\.getElementById\("joinDialog"\)\?\.open && joinSheetCode === joinInvite;\s*\n\s*if \(joinInvite && API && !sheetOpen\) openJoinSheet\(joinInvite\);/);
});
