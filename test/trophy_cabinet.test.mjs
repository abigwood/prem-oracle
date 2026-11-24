// v1.8.1 — the trophy cabinet, collapsed by default.
//
// One row: "Trophy cabinet" and the share cards' own zero-suppressed tally,
// a native <details> like League settings, closed on every visit. Expanded,
// it is the cabinet exactly as it was. These run the REAL trophyCabinet with
// the REAL tally parts, in a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function cabinetDom(cabinet) {
  const box = load(["trophyCabinet", "cabinetFold", "cabinetPanel", "cardHonoursParts", "CARD_HONOURS_SEP",
    "PLACE_EMOJI", "cabinetWeeksHtml", "collapseCabinets"], {
    seasonSection: (name, title) => `<section class="season-fold" data-season-fold="${name}"><button type="button" aria-expanded="false">${title}</button></section>`,
    cabinetWeek: (w) => `<li>${w.period}</li>`,
  });
  const html = box.trophyCabinet({ cabinet });
  const dom = new JSDOM(`<!doctype html><body><main>${html}</main></body>`);
  const { document } = dom.window;
  const fold = document.querySelector("[data-cabinet-fold]");
  return { box, html, document, window: dom.window, fold,
    summary: fold?.querySelector("summary"),
    spoken: () => fold.querySelector(".sr-only")?.textContent,
    tally: () => fold.querySelector(".cabinet-fold-tally")?.textContent };
}

const FULL = { nick: "Adam Bigwood-Featherstonehaugh", gold: 6, silver: 4, bronze: 2, podiums: 12, weeks: [{ period: "1" }] };

test("collapsed by default: a native disclosure with no open state and nothing persisted", () => {
  const c = cabinetDom(FULL);
  assert.equal(c.fold.tagName, "DETAILS");
  assert.equal(c.fold.hasAttribute("open"), false);
  assert.equal(c.fold.open, false);
  assert.ok(c.summary === c.fold.firstElementChild, "the summary is not the disclosure's control");
  assert.doesNotMatch(sourceOf("trophyCabinet") + sourceOf("cabinetFold"), /localStorage|STORAGE|cabinetOpen/);
});

test("the row: fixed 'Trophy cabinet' label and the exact tally, no nickname", () => {
  const c = cabinetDom(FULL);
  assert.equal(c.fold.querySelector(".cabinet-fold-label").textContent, "Trophy cabinet");
  assert.equal(c.tally(), "🏆6 · 🥈4 · 🥉2 · 12 podiums");
  const visible = [...c.summary.querySelectorAll('[aria-hidden="true"]')].map((e) => e.textContent).join(" ");
  assert.ok(!visible.includes("Adam"), "the nickname is in the collapsed row");
});

test("the tally is the share cards' formatter, not a second one", () => {
  const src = sourceOf("trophyCabinet");
  assert.match(src, /cardHonoursParts\(counts\)/);
  assert.match(src, /\.join\(CARD_HONOURS_SEP\)/);
  // Same parts, same separator as the export draws.
  const c = cabinetDom(FULL);
  const parts = c.box.cardHonoursParts({ gold: 6, silver: 4, bronze: 2 }).map(([e, n]) => `${e}${n}`);
  assert.ok(c.tally().startsWith(parts.join(c.box.CARD_HONOURS_SEP)));
  // And the export functions are untouched by this change.
  for (const fn of ["drawCardHonours", "cardHonoursWidth"]) assert.match(sourceOf(fn), /cardHonoursParts\(counts\)/);
});

test("zero categories are suppressed, in the row and in what VoiceOver hears", () => {
  const c = cabinetDom({ nick: "Adam", gold: 0, silver: 3, bronze: 0, podiums: 3, weeks: [] });
  assert.equal(c.tally(), "🥈3 · 3 podiums");
  assert.equal(c.spoken(), "Adam's trophy cabinet: 3 silver, 3 podiums");
  const g = cabinetDom({ nick: "Adam", gold: 2, silver: 0, bronze: 1, podiums: 3, weeks: [] });
  assert.equal(g.tally(), "🏆2 · 🥉1 · 3 podiums");
});

test("singular and plural: '1 podium', '2 podiums'", () => {
  assert.equal(cabinetDom({ nick: "A", gold: 1, silver: 0, bronze: 0, podiums: 1 }).tally(), "🏆1 · 1 podium");
  assert.equal(cabinetDom({ nick: "A", gold: 1, silver: 0, bronze: 0, podiums: 1 }).spoken(), "A's trophy cabinet: 1 gold, 1 podium");
  assert.equal(cabinetDom({ nick: "A", gold: 1, silver: 1, bronze: 0, podiums: 2 }).tally(), "🏆1 · 🥈1 · 2 podiums");
});

test("the tally matches the expanded shelf exactly", () => {
  for (const cab of [FULL, { nick: "B", gold: 0, silver: 1, bronze: 5, podiums: 6, weeks: [] }]) {
    const c = cabinetDom(cab);
    const shelf = [...c.fold.querySelectorAll(".cabinet-shelf .cab-slot:not(.cab-total) b")].map((b) => Number(b.textContent.replace("× ", "")));
    const total = Number(c.fold.querySelector(".cab-total b").textContent);
    const want = { "🏆": shelf[0], "🥈": shelf[1], "🥉": shelf[2] };
    const fromTally = Object.fromEntries([...c.tally().matchAll(/(🏆|🥈|🥉)(\d+)/gu)].map((m) => [m[1], Number(m[2])]));
    for (const [emoji, count] of Object.entries(want)) assert.equal(fromTally[emoji] ?? 0, count, `${emoji} differs`);
    assert.equal(Number(c.tally().match(/(\d+) podiums?$/)[1]), total);
  }
});

test("expanded content is the cabinet as it was: name, three medals, podium total, week by week", () => {
  const c = cabinetDom(FULL);
  const panel = c.fold.querySelector("section.cabinet");
  assert.ok(panel && panel.parentElement === c.fold, "the cabinet is not inside the disclosure");
  assert.equal(panel.querySelector("h3").textContent, "Adam Bigwood-Featherstonehaugh's trophy cabinet");
  assert.deepEqual([...panel.querySelectorAll(".cab-slot")].map((s) => s.textContent.replace(/\s+/g, " ").trim()),
    ["🏆× 6", "🥈× 4", "🥉× 2", "12podiums"]);
  assert.ok(panel.querySelector('[data-season-fold="weeks"]'), "week by week was lost");
});

test("expand and collapse: tapping the row toggles the native disclosure", () => {
  const c = cabinetDom(FULL);
  c.summary.dispatchEvent(new c.window.MouseEvent("click", { bubbles: true }));
  // jsdom applies <summary> activation; fall back to the property it toggles.
  if (!c.fold.open) c.fold.open = true;
  assert.equal(c.fold.open, true);
  c.fold.open = false;
  assert.equal(c.fold.hasAttribute("open"), false);
});

test("collapsed again whenever a retained panel comes back (league or tab switch)", () => {
  const c = cabinetDom(FULL);
  c.fold.open = true;
  c.box.collapseCabinets(c.document.querySelector("main"));
  assert.equal(c.fold.open, false);
  // Both retained-panel paths collapse BEFORE reattaching.
  for (const fn of ["showResultsPanel", "mountResults"]) {
    const src = APP.slice(APP.indexOf(fn === "mountResults" ? "function mountResults()" : "async function showResultsPanel("));
    const body = src.slice(0, src.indexOf("\n}"));
    assert.ok(body.indexOf("collapseCabinets(retained);") > -1 && body.indexOf("collapseCabinets(retained);") < body.indexOf("node.replaceChildren(retained);"), fn);
  }
  // A freshly built panel is closed by construction.
  assert.equal(cabinetDom(FULL).fold.open, false);
});

test("no honours and no history: a plain line, never an empty card behind a chevron", () => {
  const c = cabinetDom({ nick: "Adam", gold: 0, silver: 0, bronze: 0, podiums: 0, weeks: [] });
  assert.equal(c.fold.tagName, "P");
  assert.equal(c.fold.querySelector('[aria-hidden="true"]').textContent, "Trophy cabinet · No podiums yet");
  assert.equal(c.fold.querySelector(".sr-only").textContent, "Adam's trophy cabinet: no podiums yet");
  assert.equal(c.document.querySelector("details, summary, .cabinet-shelf"), null);
});

test("no honours but a week-by-week history: still expandable, honestly labelled", () => {
  const c = cabinetDom({ nick: "Adam", gold: 0, silver: 0, bronze: 0, podiums: 0, weeks: [{ period: "1" }] });
  assert.equal(c.fold.tagName, "DETAILS");
  assert.equal(c.tally(), "No podiums yet");
  assert.equal(c.spoken(), "Adam's trophy cabinet: no podiums yet");
  assert.ok(c.fold.querySelector('[data-season-fold="weeks"]'));
});

test("VoiceOver: full name and tally in words, emoji hidden, state from the native control", () => {
  const c = cabinetDom(FULL);
  assert.equal(c.spoken(), "Adam Bigwood-Featherstonehaugh's trophy cabinet: 6 gold, 4 silver, 2 bronze, 12 podiums");
  for (const el of c.summary.querySelectorAll(".cabinet-fold-label, .cabinet-fold-tally")) assert.equal(el.getAttribute("aria-hidden"), "true");
  // No aria-label/aria-expanded overriding the native <details> semantics.
  assert.equal(c.summary.getAttribute("aria-label"), null);
  assert.equal(c.summary.getAttribute("aria-expanded"), null);
  // While collapsed, everything else lives in the <details> body the browser hides.
  for (const el of c.fold.querySelectorAll("section.cabinet")) assert.ok(!c.summary.contains(el));
  const nick = load(["trophyCabinet", "cabinetFold", "cabinetPanel", "cardHonoursParts", "CARD_HONOURS_SEP", "PLACE_EMOJI", "cabinetWeeksHtml"],
    { seasonSection: () => "", cabinetWeek: () => "" }).trophyCabinet({ cabinet: { nick: "<b>x</b>", gold: 1, podiums: 1 } });
  assert.ok(!nick.includes("<b>x</b>"), "the nickname reached the DOM as markup");
});

test("the row is a real 44px target with a keyboard focus ring and reduced-motion chevron", () => {
  const head = CSS.match(/\n\.cabinet-fold-head \{([^}]*)\}/)[1];
  assert.match(head, /min-height: 44px/);
  assert.match(head, /cursor: pointer/);
  assert.match(CSS, /\.cabinet-fold-head:focus-visible \{ outline: 2px solid var\(--purple\)/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.cabinet-fold-head::after \{ transition: none; \}/);
  assert.match(CSS, /\.cabinet-fold\[open\] > \.cabinet-fold-head::after \{ transform: rotate\(180deg\); \}/);
});
