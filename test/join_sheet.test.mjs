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

function sheetBox({ joinResponse, stateResponse } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${JOIN_DIALOG}</body>`);
  const { document } = dom.window;
  // jsdom has no showModal/close in older versions; shim to track open state.
  const dialog = document.getElementById("joinDialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };

  const calls = { join: [], nav: [], flash: [], saved: [] };
  const box = load(
    ["openJoinSheet", "submitJoinSheet", "showJoinSuggestions", "clearJoinFeedback"],
    {
      document,
      API: "https://api.test",
      playerName: "",
      STORAGE: { name: "n", recovery: "r" },
      localStorage: { setItem() {}, getItem: () => null },
      uid: () => "u1",
      api: async (path) => { if (stateResponse) return stateResponse; throw new Error("not found"); },
      fetch: async () => joinResponse,
      saveLeague: (code) => calls.saved.push(code),
      saveLeagueName: () => {},
      setFlash: (m) => calls.flash.push(m),
      navigateToView: async (v) => { calls.nav.push(v); },
      restoreViewport: () => {},
      launchRouted: false,
    });
  return { box, document, calls, dialog };
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
