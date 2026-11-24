// v1.8.1 — the trophy cabinet as the league's honours board.
//
// Collapsed: one row, "🏆 Trophy cabinet" and the league's combined, zero-
// suppressed tally (the share cards' own formatter). Expanded: every member's
// gold/silver/bronze/podiums, the viewer pinned first and the rest by podiums,
// zeros as dashes. A native <details>, closed on every visit. The Season
// table's rows no longer carry a tally of their own. These run the REAL
// functions against a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf, APP } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const member = (uid, nick, gold = 0, silver = 0, bronze = 0, extra = {}) =>
  ({ uid, nick, pts: 10, exact: 1, rank: 1, wins: gold, podiums: { gold, silver, bronze }, ...extra });

// Several honour distributions, including an old-worker row with only `wins`.
const LEAGUES = {
  spread: [member("u1", "Adam", 1, 2, 0), member("u2", "Tom", 6, 4, 2), member("u3", "Sol", 0, 3, 3), member("u4", "Kit", 6, 0, 0)],
  oneWinner: [member("u2", "Tom", 1), member("u1", "Adam"), member("u3", "Sol")],
  legacy: [{ uid: "u1", nick: "Adam", pts: 3, exact: 0, wins: 2 }, { uid: "u2", nick: "Tom", pts: 1, exact: 0, wins: 1 }],
  none: [member("u1", "Adam"), member("u2", "Tom")],
};

function cabinet(table, { me = "u1", weeks = null } = {}) {
  const box = load(["trophyCabinet", "honoursBoardRows", "honoursBoardHtml", "HONOUR_PLACES", "podiumCounts",
    "cardHonoursParts", "CARD_HONOURS_SEP", "PLACE_EMOJI", "cabinetWeeksHtml", "collapseCabinets"], {
    uid: () => me,
    seasonSection: (name, title) => `<section class="season-fold" data-season-fold="${name}"><button type="button" aria-expanded="false">${title}</button></section>`,
    cabinetWeek: (w) => `<li>${w.period}</li>`,
  });
  const html = box.trophyCabinet({ code: "AAA", table, cabinet: weeks ? { nick: "Adam", weeks } : undefined });
  const dom = new JSDOM(`<!doctype html><body><main>${html}</main></body>`);
  const { document } = dom.window;
  const fold = document.querySelector("[data-cabinet-fold]");
  const bodyRows = () => [...document.querySelectorAll(".honours-board tbody tr")].map((tr) => ({
    nick: tr.querySelector("th").childNodes[0].textContent,
    you: tr.classList.contains("is-you"),
    cells: [...tr.querySelectorAll("td")].map((td) => td.querySelector('[aria-hidden="true"]')?.textContent ?? td.textContent),
    spoken: [...tr.querySelectorAll("td")].map((td) => td.querySelector(".sr-only")?.textContent ?? td.textContent),
  }));
  return { box, html, document, window: dom.window, fold, bodyRows,
    summary: fold?.querySelector("summary"),
    spoken: () => fold.querySelector(".sr-only")?.textContent,
    tally: () => fold.querySelector(".cabinet-fold-tally")?.textContent };
}

// --- the collapsed row ----------------------------------------------------------

test("collapsed by default: a native disclosure, no open state, nothing persisted", () => {
  const c = cabinet(LEAGUES.spread);
  assert.equal(c.fold.tagName, "DETAILS");
  assert.equal(c.fold.open, false);
  assert.equal(c.fold.hasAttribute("open"), false);
  assert.ok(c.summary === c.fold.firstElementChild);
  assert.doesNotMatch(sourceOf("trophyCabinet"), /localStorage|STORAGE/);
});

test("the row: '🏆 Trophy cabinet' and the league's combined zero-suppressed tally", () => {
  const c = cabinet(LEAGUES.spread);
  assert.equal(c.fold.querySelector(".cabinet-fold-label").textContent, "🏆 Trophy cabinet");
  assert.equal(c.tally(), "🏆13 · 🥈9 · 🥉5");
  assert.equal(cabinet(LEAGUES.oneWinner).tally(), "🏆1", "zero silver and bronze are suppressed");
  assert.equal(cabinet(LEAGUES.legacy).tally(), "🏆3", "old wins-only rows count as gold");
});

test("the tally is the share cards' formatter over podiumCounts — no second system", () => {
  const src = sourceOf("trophyCabinet");
  assert.match(src, /cardHonoursParts\(league\)/);
  assert.match(src, /\.join\(CARD_HONOURS_SEP\)/);
  assert.match(sourceOf("honoursBoardRows"), /podiumCounts\(row\)/);
  for (const fn of ["drawCardHonours", "cardHonoursWidth"]) assert.match(sourceOf(fn), /cardHonoursParts\(counts\)/);
});

test("the collapsed tally equals the sum of the expanded board, for every distribution", () => {
  for (const [name, table] of Object.entries(LEAGUES)) {
    if (name === "none") continue;
    const c = cabinet(table);
    const rows = c.bodyRows();
    const sum = [0, 1, 2, 3].map((col) => rows.reduce((t, r) => t + (r.cells[col] === "–" ? 0 : Number(r.cells[col])), 0));
    const fromTally = Object.fromEntries([...c.tally().matchAll(/(🏆|🥈|🥉)(\d+)/gu)].map((m) => [m[1], Number(m[2])]));
    assert.equal(fromTally["🏆"] ?? 0, sum[0], `${name}: gold`);
    assert.equal(fromTally["🥈"] ?? 0, sum[1], `${name}: silver`);
    assert.equal(fromTally["🥉"] ?? 0, sum[2], `${name}: bronze`);
    assert.equal(sum[3], sum[0] + sum[1] + sum[2], `${name}: podiums are the medals' sum`);
    // And it is the very data the Season rows used to render, per member.
    for (const row of table) {
      const shown = rows.find((r) => r.nick === row.nick).cells.slice(0, 3).map((v) => (v === "–" ? 0 : Number(v)));
      const p = c.box.podiumCounts(row);
      assert.deepEqual(shown, [p.gold, p.silver, p.bronze], `${name}: ${row.nick}`);
    }
  }
});

test("VoiceOver: the row is read in words with the state from the native control; emoji hidden", () => {
  const c = cabinet(LEAGUES.spread);
  assert.equal(c.spoken(), "Trophy cabinet: 13 gold, 9 silver, 5 bronze, 27 podiums");
  for (const el of c.summary.querySelectorAll(".cabinet-fold-label, .cabinet-fold-tally")) assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.equal(c.summary.getAttribute("aria-label"), null);
  assert.equal(c.summary.getAttribute("aria-expanded"), null, "the native details state must not be overridden");
  // The board is in the <details> body the browser hides while closed.
  assert.ok(!c.summary.contains(c.document.querySelector(".honours-board")));
});

test("singular and plural: '1 podium', '2 podiums'", () => {
  assert.equal(cabinet(LEAGUES.oneWinner).spoken(), "Trophy cabinet: 1 gold, 1 podium");
  assert.equal(cabinet([member("u1", "A", 1, 1)]).spoken(), "Trophy cabinet: 1 gold, 1 silver, 2 podiums");
});

// --- the expanded board ------------------------------------------------------------

test("the viewer is pinned first; everyone else by podiums, then gold, silver, bronze", () => {
  const c = cabinet(LEAGUES.spread, { me: "u1" });
  assert.deepEqual(c.bodyRows().map((r) => r.nick), ["Adam", "Tom", "Kit", "Sol"]);
  // Tom 12 podiums; Kit 6 and Sol 6 tie on podiums — Kit's 6 golds win it.
  assert.equal(c.bodyRows()[0].you, true);
  assert.equal(c.document.querySelector("tr.is-you th .sr-only").textContent, " (you)");
  // Another viewer gets themselves pinned instead, and Adam takes his place.
  const sol = cabinet(LEAGUES.spread, { me: "u3" });
  assert.deepEqual(sol.bodyRows().map((r) => r.nick), ["Sol", "Tom", "Kit", "Adam"]);
  // A viewer not in the table pins nobody.
  assert.deepEqual(cabinet(LEAGUES.spread, { me: "x" }).bodyRows().map((r) => r.nick), ["Tom", "Kit", "Sol", "Adam"]);
});

test("zeros are dashes on screen and '0' to VoiceOver", () => {
  const c = cabinet(LEAGUES.spread);
  const adam = c.bodyRows().find((r) => r.nick === "Adam");
  assert.deepEqual(adam.cells, ["1", "2", "–", "3"]);
  assert.deepEqual(adam.spoken, ["1", "2", "0", "3"]);
  assert.ok(c.document.querySelectorAll(".honours-board td.is-zero").length >= 3);
});

test("the board's columns are named for VoiceOver, not just drawn as emoji", () => {
  const c = cabinet(LEAGUES.spread);
  const heads = [...c.document.querySelectorAll(".honours-board thead th")].map((th) => th.querySelector(".sr-only")?.textContent ?? th.textContent);
  assert.deepEqual(heads, ["Player", "Gold", "Silver", "Bronze", "Podiums"]);
  assert.ok([...c.document.querySelectorAll(".honours-board tbody th")].every((th) => th.getAttribute("scope") === "row"));
});

test("no podiums anywhere in the league: a plain line, never an empty board", () => {
  const c = cabinet(LEAGUES.none);
  assert.equal(c.fold.tagName, "P");
  assert.equal(c.fold.querySelector('[aria-hidden="true"]').textContent, "🏆 Trophy cabinet · No podiums yet");
  assert.equal(c.fold.querySelector(".sr-only").textContent, "Trophy cabinet: no podiums yet");
  assert.equal(c.document.querySelector("details, .honours-board"), null);
  // A league with no table yet draws nothing at all.
  assert.equal(cabinet([]).html, "");
});

test("the viewer's own week-by-week history stays inside the cabinet, under the board", () => {
  const c = cabinet(LEAGUES.spread, { weeks: [{ period: "1" }] });
  const board = c.document.querySelector(".honours-board");
  const weeks = c.document.querySelector('[data-season-fold="weeks"]');
  assert.ok(weeks && board.compareDocumentPosition(weeks) & c.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(cabinet(LEAGUES.spread).document.querySelector('[data-season-fold="weeks"]'), null);
});

test("names are escaped", () => {
  const c = cabinet([member("u2", "<b>hax</b>", 1)]);
  assert.ok(!c.html.includes("<b>hax</b>"));
});

// --- collapse and switching ------------------------------------------------------------

test("expand and collapse via the native control; retained panels come back collapsed", () => {
  const c = cabinet(LEAGUES.spread);
  c.fold.open = true;
  assert.equal(c.fold.open, true);
  c.box.collapseCabinets(c.document.querySelector("main"));
  assert.equal(c.fold.open, false);
  for (const fn of ["async function showResultsPanel(", "function mountResults()"]) {
    const src = APP.slice(APP.indexOf(fn));
    const body = src.slice(0, src.indexOf("\n}"));
    assert.ok(body.indexOf("collapseCabinets(retained);") > -1
      && body.indexOf("collapseCabinets(retained);") < body.indexOf("node.replaceChildren(retained);"), fn);
  }
});

test("switching league repopulates from THAT league's table, collapsed", () => {
  const a = cabinet(LEAGUES.spread);
  const b = cabinet(LEAGUES.oneWinner);
  assert.equal(a.tally(), "🏆13 · 🥈9 · 🥉5");
  assert.equal(b.tally(), "🏆1");
  assert.deepEqual(b.bodyRows().map((r) => r.nick), ["Adam", "Tom", "Sol"]);
  assert.equal(b.fold.open, false);
});

// --- the Season table: one line per member -----------------------------------------------

test("Season rows carry no medal tally, for every distribution and both member roles", () => {
  const box = load(["seasonTableHtml", "movementBadge", "seasonMovement", "movementMark"], {});
  for (const [name, table] of Object.entries(LEAGUES)) {
    for (const isOwner of [false, true]) {
      const html = box.seasonTableHtml({ code: "AAA", owner: "u1", table }, isOwner);
      const doc = new JSDOM(`<body>${html}</body>`).window.document;
      assert.doesNotMatch(html, /🏆|🥈|🥉|class="medals?/, `${name}/${isOwner}`);
      for (const cell of doc.querySelectorAll(".player-cell")) {
        assert.equal(cell.children.length, 1, `${name}: a second line in the player cell`);
        assert.ok(cell.firstElementChild.matches(".player-name"));
      }
      assert.equal(doc.querySelectorAll(".kick-btn").length, isOwner ? table.length - 1 : 0, `${name}: kick control`);
    }
  }
});

// --- presentation ------------------------------------------------------------------

test("the row is a 44px target; the board stays compact and wraps names", () => {
  const head = CSS.match(/\n\.cabinet-fold-head \{([^}]*)\}/)[1];
  assert.match(head, /min-height: 44px/);
  assert.match(CSS, /\.honours-board tbody th \{[^}]*overflow-wrap: anywhere/);
  assert.match(CSS, /\.honours-board \.is-zero \{ color: var\(--muted\)/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.cabinet-fold-head::after \{ transition: none; \}/);
});
