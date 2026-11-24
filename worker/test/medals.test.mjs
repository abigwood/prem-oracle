// A member's medals, run rather than read.
//
// Three shapes reach podiumCounts in production: a row from a worker that only
// ever knew about `wins`, a row from the current worker carrying `podiums`, and
// a row belonging to somebody who has won nothing. They feed the trophy
// cabinet's honours board.
//
// v1.8.1: the per-row medal line under each name in the Season table is gone —
// rows are one line each — so the table half of this file now proves its
// absence, while podiumCounts keeps every guarantee it had.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function lift(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  const end = APP.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated: ${startsWith}`);
  return APP.slice(start, end + 2);
}

/** A one-line const, for the small readers the badge is built out of. */
function liftLine(startsWith) {
  const start = APP.indexOf(startsWith);
  if (start < 0) throw new Error(`not found in app.js: ${startsWith}`);
  const end = APP.indexOf("\n", start);
  return APP.slice(start, end);
}

const ui = new Function(`
  ${lift("function escapeHTML(")}
  ${lift("function movementMark(value)")}
  ${liftLine("const seasonMovement =")}
  ${lift("function movementBadge(")}
  ${lift("function podiumCounts(row)")}
  ${lift("function seasonTableHtml(state, isOwner)")}
  return { podiumCounts, seasonTableHtml };
`)();

/** The rendered medals, read back out of the HTML that actually got produced. */
function medals(html) {
  const cells = [...html.matchAll(/<span class="(medal[^"]*)">([^<]*)<\/span>/g)]
    .map(([, cls, text]) => ({
      emoji: text.trim().split(" ")[0],
      count: Number(text.trim().split(" ")[1]),
      muted: cls.includes("is-none"),
    }));
  const label = /<span class="medals" aria-label="([^"]*)"/.exec(html);
  return { cells, label: label && label[1], text: html.replace(/<[^>]*>/g, "") };
}

// --- the three row shapes ----------------------------------------------------

test("a new row reads its podiums", () => {
  const row = { uid: "a", nick: "Adam", pts: 40, exact: 3, wins: 2, podiums: { gold: 2, silver: 1, bronze: 3 } };
  assert.deepEqual(ui.podiumCounts(row), { gold: 2, silver: 1, bronze: 3 });
});

test("an OLD row with only `wins` reads it as the gold count", () => {
  // A worker that predates this only ever counted round wins, and a round win
  // is a gold — so the other two are honestly zero rather than unknown.
  assert.deepEqual(ui.podiumCounts({ uid: "b", nick: "Tom", wins: 4 }), { gold: 4, silver: 0, bronze: 0 });
});

test("the two shapes agree whenever the old field is the whole story", () => {
  for (const gold of [0, 1, 7]) {
    assert.deepEqual(ui.podiumCounts({ wins: gold }), ui.podiumCounts({ wins: gold, podiums: { gold, silver: 0, bronze: 0 } }), `gold ${gold}`);
  }
});

test("a missing or malformed row degrades to zeros instead of throwing", () => {
  for (const row of [undefined, null, {}, { podiums: null }, { podiums: "3" }, { wins: undefined }]) {
    assert.deepEqual(ui.podiumCounts(row), { gold: 0, silver: 0, bronze: 0 }, JSON.stringify(row));
  }
});

// --- where they sit in the table --------------------------------------------

const STATE = {
  code: "ABCD", owner: "a",
  table: [
    { uid: "a", nick: "Adam", rank: 1, pts: 40, exact: 3, wins: 2, podiums: { gold: 2, silver: 1, bronze: 0 } },
    { uid: "b", nick: "Tom", rank: 2, pts: 31, exact: 2, wins: 0, podiums: { gold: 0, silver: 1, bronze: 2 } },
  ],
};

test("the table has four columns and no trophy column", () => {
  const html = ui.seasonTableHtml(STATE, false);
  const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map(([, h]) => h);
  assert.deepEqual(headers, ["Player", "", "Pts", "Exact"], "the movement column's header is deliberately blank");
  assert.equal((html.match(/<th>/g) || []).length, 4, "Player, movement, Pts, Exact — the fifth is gone");
  assert.ok(!html.includes("wins-col"), "the column that pushed Exact off a 402px screen");
});

test("every player cell is one line: rank and name, no medal tally", () => {
  for (const isOwner of [false, true]) {
    const html = ui.seasonTableHtml(STATE, isOwner);
    const cells = [...html.matchAll(/<td class="player-cell">(.*?)<\/td>/gs)].map(([, c]) => c);
    assert.deepEqual(cells, ['<span class="player-name">1. Adam</span>', '<span class="player-name">2. Tom</span>']);
    assert.ok(!/🏆|🥈|🥉|class="medals?/.test(html), "a tally survives in the table");
    assert.ok(html.includes("Adam") && html.includes(">40<"), "the rest of the row is untouched");
  }
});

test("the owner's kick column survives", () => {
  const html = ui.seasonTableHtml(STATE, true);
  assert.equal((html.match(/<th[ >]/g) || []).length, 5, "four plus the owner's own");
  assert.equal((html.match(/kick-btn/g) || []).length, 1, "everybody but the owner");
});

test("a nickname is still escaped", () => {
  const state = { code: "ABCD", owner: "a", table: [{ uid: "x", nick: "<b>hax</b>", rank: 1, pts: 1, exact: 0, wins: 0, podiums: { gold: 0, silver: 0, bronze: 0 } }] };
  const html = ui.seasonTableHtml(state, false);
  assert.ok(!html.includes("<b>hax</b>"));
  assert.ok(html.includes("&lt;b&gt;hax&lt;/b&gt;"));
});

test("the medal styles are gone with the medals; the name scoping stays", () => {
  const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.ok(!css.includes(".medal.is-none") && !css.includes(".medals {"));
  // Scoped: .player-name is also a match-card class on the Schedule, so an
  // unscoped display:block would restyle every fixture card.
  assert.ok(css.includes(".player-cell .player-name { display: block; }"));
  assert.ok(!/^\.player-name \{ display: block/m.test(css), "never unscoped");
});
