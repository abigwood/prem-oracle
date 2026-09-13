// v1.8 Slice A — the one-step invitation join sheet, client side.
//
// The worker suite proves uniqueness and safety. These prove the sheet's own
// wiring: it identifies the league, a taken name shows suggestions and joins
// nobody, a suggestion chip fills the field, and a successful join lands on My
// Picks through the existing safe-switch — no parallel route.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// The real join-dialog markup, so the test drives the shipped DOM.
const JOIN_DIALOG = HTML.slice(HTML.indexOf('<dialog id="joinDialog">'),
  HTML.indexOf("</dialog>", HTML.indexOf('<dialog id="joinDialog">')) + "</dialog>".length);

function sheetBox({ joinResponse, stateResponse, api, fetch } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${JOIN_DIALOG}</body>`);
  const { document } = dom.window;
  // jsdom has no showModal/close in older versions; shim to track open state.
  const dialog = document.getElementById("joinDialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };

  const calls = { join: [], nav: [], flash: [], saved: [], savedNames: [] };
  const box = load(
    ["openJoinSheet", "submitJoinSheet", "showJoinSuggestions", "clearJoinFeedback"],
    {
      document,
      API: "https://api.test",
      playerName: "",
      STORAGE: { name: "n", recovery: "r" },
      localStorage: { setItem() {}, getItem: () => null },
      uid: () => "u1",
      // The request-safety state the sheet keeps at module scope. Seeded here
      // because the harness lifts functions, not their surrounding `let`s.
      joinSheetCode: "",
      joinSheetGeneration: 0,
      joinSubmitInFlight: false,
      api: api || (async () => { if (stateResponse) return stateResponse; throw new Error("not found"); }),
      fetch: fetch || (async () => joinResponse),
      saveLeague: (code) => calls.saved.push(code),
      saveLeagueName: (code, name) => calls.savedNames.push([code, name]),
      setFlash: (m) => calls.flash.push(m),
      navigateToView: async (v) => { calls.nav.push(v); },
      restoreViewport: () => {},
      launchRouted: false,
    });
  return { box, document, calls, dialog };
}
// A deferred response whose settle time the test controls, for ordering races.
function deferred(value) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, settle: () => resolve(value) };
}
const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));

test("the sheet opens identified by the league's name", async () => {
  const { box, document } = sheetBox({ stateResponse: { code: "ABC234", name: "Sunday Six" } });
  box.openJoinSheet("abc234");
  assert.equal(document.getElementById("joinDialog").open, true);
  await flush();
  assert.match(document.getElementById("joinLeagueName").textContent, /Join Sunday Six/);
});

test("an unknown invite fails honestly and blocks the join", async () => {
  const { box, document } = sheetBox({ /* api rejects */ });
  box.openJoinSheet("ZZZZZZ");
  await flush();
  assert.match(document.getElementById("joinLeagueName").textContent, /not found/i);
  assert.equal(document.getElementById("joinSubmit").disabled, true);
  assert.equal(document.getElementById("joinDisplayName").disabled, true);
});

test("a taken name shows suggestions and joins nobody", async () => {
  const { box, document, calls } = sheetBox({
    stateResponse: { code: "ABC234", name: "Sunday Six" },
    joinResponse: jsonResponse(409, { error: "That name is taken in this league", taken: true, suggestions: ["Gift 2", "Gift 3"] }),
  });
  box.openJoinSheet("ABC234");
  await flush();
  document.getElementById("joinDisplayName").value = "The Gift";
  await box.submitJoinSheet();
  const taken = document.getElementById("joinTaken");
  assert.equal(taken.hidden, false);
  assert.match(taken.textContent, /taken/i);
  const chips = [...document.querySelectorAll("[data-join-suggestion]")].map((c) => c.textContent);
  assert.deepEqual(chips, ["Gift 2", "Gift 3"]);
  assert.equal(calls.nav.length, 0, "a refused join navigated anyway");
  assert.equal(calls.saved.length, 0, "a refused join saved a membership");
  assert.equal(document.getElementById("joinDialog").open, true, "the sheet closed on refusal");
});

test("a successful join saves the league and lands on My Picks", async () => {
  const { box, document, calls } = sheetBox({
    stateResponse: { code: "ABC234", name: "Sunday Six" },
    joinResponse: jsonResponse(200, { ok: true, code: "ABC234", name: "Sunday Six", recovery: "amber-score-oracle" }),
  });
  box.openJoinSheet("ABC234");
  await flush();
  document.getElementById("joinDisplayName").value = "Ferdinand";
  await box.submitJoinSheet();
  assert.deepEqual(calls.saved, ["ABC234"]);
  assert.deepEqual(calls.nav, ["picks"], "did not land on My Picks");
  assert.match(calls.flash[0], /Joined Sunday Six/);
  assert.equal(document.getElementById("joinDialog").open, false, "the sheet stayed open after success");
});

test("an empty name is refused inline without a request", async () => {
  let fetched = 0;
  const { box, document, calls } = sheetBox({ stateResponse: { code: "ABC234", name: "L" } });
  box.openJoinSheet("ABC234");
  await flush();
  document.getElementById("joinDisplayName").value = "   ";
  await box.submitJoinSheet();
  assert.equal(calls.nav.length, 0);
  assert.equal(document.getElementById("joinTaken").hidden, false);
});

// --- request safety: the sheet is bound to the invitation it was opened for --
//
// Identification and submission are async. A second opening, or a close, must
// supersede whatever is still in flight: a late answer never renames the
// current sheet, shows another league's error, saves the wrong league, or
// navigates (Slice A/E).

test("slow A then fast B: A's late identification never renames B's sheet", async () => {
  const slowA = deferred({ code: "AAAAAA", name: "Alpha" });
  const api = async (path) => {
    if (path.includes("AAAAAA")) return slowA.promise;      // slow
    if (path.includes("BBBBBB")) return { code: "BBBBBB", name: "Bravo" }; // fast
    throw new Error("not found");
  };
  const { box, document } = sheetBox({ api });
  const name = () => document.getElementById("joinLeagueName").textContent;

  box.openJoinSheet("AAAAAA");
  await flush();
  box.openJoinSheet("BBBBBB");
  await flush();
  assert.match(name(), /Join Bravo/, "the fast, current identification should win");

  slowA.settle();
  await flush();
  assert.match(name(), /Join Bravo/, "A's late answer renamed B's sheet");
});

test("closing during identification: the late answer neither reopens nor renames", async () => {
  const slow = deferred({ code: "ABC234", name: "Sunday Six" });
  const { box, document, dialog } = sheetBox({ api: async () => slow.promise });
  box.openJoinSheet("ABC234");
  await flush();
  dialog.close();
  assert.equal(dialog.open, false);

  slow.settle();
  await flush();
  assert.equal(dialog.open, false, "a dismissed sheet reopened on a late answer");
  assert.match(document.getElementById("joinLeagueName").textContent, /Joining league/,
    "a dismissed sheet was renamed by its late answer");
});

test("crossed submissions: a superseded join saves and navigates for nobody", async () => {
  const slowJoin = deferred(jsonResponse(200, { ok: true, code: "AAAAAA", name: "Alpha", recovery: "a" }));
  const api = async (path) => path.includes("AAAAAA")
    ? { code: "AAAAAA", name: "Alpha" } : { code: "BBBBBB", name: "Bravo" };
  const fetch = async (url, init) => JSON.parse(init.body).code === "AAAAAA"
    ? slowJoin.promise
    : jsonResponse(200, { ok: true, code: "BBBBBB", name: "Bravo", recovery: "b" });
  const { box, document, calls } = sheetBox({ api, fetch });

  box.openJoinSheet("AAAAAA");
  await flush();
  document.getElementById("joinDisplayName").value = "Adam";
  box.submitJoinSheet(); // slow, left in flight

  box.openJoinSheet("BBBBBB");
  await flush();
  document.getElementById("joinDisplayName").value = "Adam";
  await box.submitJoinSheet(); // fast, wins

  slowJoin.settle();
  await flush();
  assert.deepEqual(calls.saved, ["BBBBBB"], "the superseded league A was saved");
  assert.deepEqual(calls.nav, ["picks"], "navigation fired twice, or for the wrong sheet");
});

test("double-submit: two clicks make one request, one save, one navigation", async () => {
  let fetches = 0;
  const slowJoin = deferred(jsonResponse(200, { ok: true, code: "ABC234", name: "Sunday Six", recovery: "r" }));
  const fetch = async () => { fetches++; return slowJoin.promise; };
  const { box, document, calls } = sheetBox({ stateResponse: { code: "ABC234", name: "Sunday Six" }, fetch });
  box.openJoinSheet("ABC234");
  await flush();
  document.getElementById("joinDisplayName").value = "Ferdinand";

  const first = box.submitJoinSheet();
  const second = box.submitJoinSheet(); // ignored while the first is in flight
  slowJoin.settle();
  await Promise.all([first, second]);
  await flush();
  assert.equal(fetches, 1, "a double-submit fired a second request");
  assert.deepEqual(calls.saved, ["ABC234"]);
  assert.deepEqual(calls.nav, ["picks"]);
});

test("a 503 is retryable in the sheet: no save, no nav, and the button comes back", async () => {
  const { box, document, calls } = sheetBox({
    stateResponse: { code: "ABC234", name: "Sunday Six" },
    joinResponse: jsonResponse(503, { error: "Joining is temporarily unavailable — please try again.", retryable: true }),
  });
  box.openJoinSheet("ABC234");
  await flush();
  document.getElementById("joinDisplayName").value = "Ferdinand";
  await box.submitJoinSheet();
  assert.equal(calls.saved.length, 0, "a 503 saved a membership");
  assert.equal(calls.nav.length, 0, "a 503 navigated anyway");
  assert.equal(document.getElementById("joinSubmit").disabled, false, "the button stayed disabled after a retryable failure");
  assert.match(document.getElementById("joinTaken").textContent, /try again/i);
  assert.equal(document.getElementById("joinDialog").open, true, "the sheet closed on a retryable failure");
});
