// v1.8 §7 — restrained visual refinement. Behavioural checks on the shipped
// shell: a consistent line-icon language for navigation, accessible icon
// labels, and preserved controls. No pixel or whitespace assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const doc = () => new JSDOM(HTML).window.document;

test("§7 · navigation uses one consistent line-icon language, not emoji", () => {
  const buttons = [...doc().querySelectorAll(".bottom-nav button")];
  assert.equal(buttons.length, 3, "still exactly three tabs");
  for (const b of buttons) {
    const svg = b.querySelector("svg.nav-icon");
    assert.ok(svg, "each tab carries an inline line icon");
    assert.equal(svg.getAttribute("aria-hidden"), "true", "the icon is decorative; the label names the tab");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "line icon inherits colour (state, not colour-only)");
    assert.equal(svg.getAttribute("fill"), "none", "a line icon, not a filled glyph");
  }
  // No emoji survive in the navigation (incl. the decorative trophy).
  assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(doc().querySelector(".bottom-nav").textContent),
    "no emoji in the nav");
});

test("§7 · navigation labels, order and default tab are preserved", () => {
  const buttons = [...doc().querySelectorAll(".bottom-nav button")];
  assert.deepEqual(buttons.map((b) => b.dataset.view), ["picks", "league", "rules"]);
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, "").trim()),
    ["My Picks", "League", "Rules"]);
  const active = doc().querySelector(".bottom-nav button.active");
  assert.equal(active.dataset.view, "picks");
  assert.equal(active.getAttribute("aria-current"), "page", "the active tab exposes a non-colour cue");
});

test("§7 · aria-current is kept in sync with the active tab in code", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  // Both places that toggle .active also set aria-current.
  const toggles = app.split('classList.toggle("active"').length - 1;
  const currents = app.split('setAttribute("aria-current"').length - 1;
  assert.ok(toggles >= 2, "nav active state is synced");
  assert.ok(currents >= 2, "aria-current is synced wherever active is");
});

test("§7 · icon-only shell controls keep meaningful accessible labels", () => {
  const iconOnly = [...doc().querySelectorAll(".icon-button")];
  assert.ok(iconOnly.length > 0);
  for (const b of iconOnly) {
    assert.ok((b.getAttribute("aria-label") || "").trim().length > 0,
      "every icon-only control names itself");
  }
});

test("§7 · adds no external design dependency (self-contained shell)", () => {
  // No web-font or stylesheet CDN links, no external script sources.
  assert.ok(!/<link[^>]+href="https?:/i.test(HTML), "no external stylesheet/font link");
  assert.ok(!/<script[^>]+src="https?:/i.test(HTML), "no external script");
});
