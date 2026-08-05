// The medal line under each name, run rather than read.
//
// Three shapes reach these functions in production: a row from a worker that
// only ever knew about `wins`, a row from the current worker carrying
// `podiums`, and a row belonging to somebody who has won nothing. All three
// must render three medals, and the zeros must be muted rather than dropped —
// a row whose shape changes per player cannot be scanned down a column.
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

const ui = new Function(`
  ${lift("function escapeHTML(")}
  ${lift("function movementBadge(")}
  ${lift("function podiumCounts(row)")}
  ${lift("function medalLine(row)")}
  ${lift("function seasonTableHtml(state, isOwner, withWins)")}
  return { podiumCounts, medalLine, seasonTableHtml };
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

test("a new row renders its podiums, and nothing is muted", () => {
  const row = { uid: "a", nick: "Adam", pts: 40, exact: 3, wins: 2, podiums: { gold: 2, silver: 1, bronze: 3 } };
  assert.deepEqual(ui.podiumCounts(row), { gold: 2, silver: 1, bronze: 3 });

  const { cells, label } = medals(ui.medalLine(row));
  assert.deepEqual(cells.map((c) => c.emoji), ["🏆", "🥈", "🥉"], "gold, silver, bronze, in that order");
  assert.deepEqual(cells.map((c) => c.count), [2, 1, 3]);
  assert.deepEqual(cells.map((c) => c.muted), [false, false, false]);
  assert.equal(label, "2 gold, 1 silver, 3 bronze", "read out as words, not emoji");
});

test("an OLD row with only `wins` renders it as the gold count", () => {
  // A worker that predates this only ever counted round wins, and a round win
  // is a gold — so the other two are honestly zero rather than unknown.
  const old = { uid: "b", nick: "Tom", pts: 31, exact: 2, wins: 4 };
  assert.deepEqual(ui.podiumCounts(old), { gold: 4, silver: 0, bronze: 0 });

  const { cells, label } = medals(ui.medalLine(old));
  assert.deepEqual(cells.map((c) => c.count), [4, 0, 0]);
  assert.deepEqual(cells.map((c) => c.muted), [false, true, true], "the two it cannot know are muted");
  assert.equal(label, "4 gold, 0 silver, 0 bronze");
});

test("a row that has won nothing still shows all three, all muted", () => {
  const none = { uid: "c", nick: "Sol", pts: 12, exact: 0, wins: 0, podiums: { gold: 0, silver: 0, bronze: 0 } };
  const { cells, label, text } = medals(ui.medalLine(none));
  assert.equal(cells.length, 3, "muted, not hidden");
  assert.deepEqual(cells.map((c) => c.count), [0, 0, 0]);
  assert.deepEqual(cells.map((c) => c.muted), [true, true, true]);
  assert.equal(label, "0 gold, 0 silver, 0 bronze");
  assert.match(text, /🏆 0.*🥈 0.*🥉 0/s);
});

test("the two shapes agree whenever the old field is the whole story", () => {
  // Same league, same member: an old response and a new one must not disagree
  // about how many golds are on the screen.
  for (const gold of [0, 1, 7]) {
    const oldRow = { wins: gold };
    const newRow = { wins: gold, podiums: { gold, silver: 0, bronze: 0 } };
    assert.equal(medals(ui.medalLine(oldRow)).text, medals(ui.medalLine(newRow)).text, `gold ${gold}`);
  }
});

test("a missing or malformed row degrades to zeros instead of throwing", () => {
  for (const row of [undefined, null, {}, { podiums: null }, { podiums: "3" }, { wins: undefined }]) {
    assert.deepEqual(ui.podiumCounts(row), { gold: 0, silver: 0, bronze: 0 }, JSON.stringify(row));
    assert.deepEqual(medals(ui.medalLine(row)).cells.map((c) => c.muted), [true, true, true]);
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
  const html = ui.seasonTableHtml(STATE, false, true);
  const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map(([, h]) => h);
  assert.deepEqual(headers, ["Player", "", "Pts", "Exact"], "the movement column's header is deliberately blank");
  assert.equal((html.match(/<th>/g) || []).length, 4, "Player, movement, Pts, Exact — the fifth is gone");
  assert.ok(!html.includes("wins-col"), "the column that pushed Exact off a 402px screen");
});

test("every player cell carries its own medals, under the name", () => {
  const html = ui.seasonTableHtml(STATE, false, true);
  const cells = [...html.matchAll(/<td class="player-cell">(.*?)<\/td>/gs)].map(([, c]) => c);
  assert.equal(cells.length, 2);
  assert.match(cells[0], /<span class="player-name">1\. Adam<\/span><span class="medals"/, "name first, medals after");
  assert.deepEqual(medals(cells[0]).cells.map((c) => c.count), [2, 1, 0]);
  assert.deepEqual(medals(cells[1]).cells.map((c) => c.count), [0, 1, 2]);
  assert.equal(medals(cells[1]).label, "0 gold, 1 silver, 2 bronze");
});

test("a table asked for no medals renders none, and still has its columns", () => {
  const html = ui.seasonTableHtml(STATE, false, false);
  assert.equal(medals(html).cells.length, 0);
  assert.ok(html.includes("Adam") && html.includes(">40<"), "the rest of the row is untouched");
});

test("the owner's kick column survives beside the medals", () => {
  const html = ui.seasonTableHtml(STATE, true, true);
  assert.equal((html.match(/<th>/g) || []).length, 5, "four plus the owner's own");
  assert.equal((html.match(/kick-btn/g) || []).length, 1, "everybody but the owner");
  assert.deepEqual(medals(html).cells.length, 6, "three medals on each of two rows");
});

test("a nickname is escaped even with medals in the same cell", () => {
  const state = { code: "ABCD", owner: "a", table: [{ uid: "x", nick: "<b>hax</b>", rank: 1, pts: 1, exact: 0, wins: 0, podiums: { gold: 0, silver: 0, bronze: 0 } }] };
  const html = ui.seasonTableHtml(state, false, true);
  assert.ok(!html.includes("<b>hax</b>"));
  assert.ok(html.includes("&lt;b&gt;hax&lt;/b&gt;"));
});

// --- the styles the muting depends on ---------------------------------------

test("the muted class and the under-the-name layout are actually styled", () => {
  const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const block = (sel) => {
    const at = css.indexOf(sel + " {");
    assert.ok(at >= 0, `no rule for ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(block(".medal.is-none"), /opacity:\s*\.?\d/, "muted, and muted by opacity");
  assert.match(block(".medals"), /display:\s*block/, "on its own line under the name");
  assert.match(block(".medals"), /white-space:\s*nowrap/, "three medals must not wrap mid-row");
  // Scoped: .player-name is also a match-card class on the Schedule, so an
  // unscoped display:block would restyle every fixture card.
  assert.ok(css.includes(".player-cell .player-name { display: block; }"));
  assert.ok(!/^\.player-name \{ display: block/m.test(css), "never unscoped");
});
