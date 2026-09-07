// v1.7 · Sol's final presentation corrections, checked on the DRAWING PATH.
//
// The Slice C tests stub the draw functions out and check geometry. That is the
// right test for geometry and the wrong one for presentation: a card can have
// perfect bounds and still paint a trophy over nobody, or quietly drop a
// player's honours when the table is long. So this file lifts the REAL
// drawCard* functions and records every mark they make.
import test from "node:test";
import assert from "node:assert/strict";
import { APP, load } from "./harness.mjs";

/** A canvas that keeps every text draw, in order, with where it landed. */
function recorder() {
  const marks = [];
  const state = { font: "", fillStyle: "", textAlign: "left" };
  const ctx = new Proxy({
    fillText: (t, x, y) => marks.push({ text: String(t), x, y, font: state.font,
      fill: state.fillStyle, align: state.textAlign }),
    // Width follows the font actually set, the way a real canvas does. A flat
    // 12px a character makes every name look too long and every tally too wide.
    measureText: (t) => ({ width: String(t).length * (Number(/(\d+)px/.exec(state.font)?.[1] || 24) * 0.58) }),
    setTransform: () => {}, fillRect: () => {}, save: () => {}, restore: () => {},
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
    arcTo: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, clip: () => {},
    rect: () => {}, translate: () => {}, scale: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
  }, {
    get: (t, k) => (k in t ? t[k] : state[k]),
    set: (t, k, v) => { state[k] = v; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx,
    toDataURL: () => "data:image/png;base64,AAAA" };
  return { canvas, ctx, marks };
}

const NAMES = ["drawSeasonTableCard", "drawWeeklyResultCard", "drawCardHeader", "drawCardHero", "drawCardTableHead", "drawCardRowPlate", "drawCardHonours", "drawCardFooter",
  "drawFitted", "fitText", "ellipsise", "roundedRect", "cardCanvas", "cardRowMetrics", "cardFont",
  "cardDate", "sentenceCase", "seasonCardModel",
  "weeklyCardModel", "weeklyCardCaption", "weeklyShareStatus", "weeklyTerminalCount",
  "shareSurface", "shareRound", "sharePeriod", "normaliseView", "LEGACY_VIEWS", "weeklySharePublished", "shareCardState", "seasonShareFreshness", "shareIconButton",
  "podiumCounts", "weeklyRanks", "sharedRankByUid", "winnerNames", "noteWeeklyFinalMismatch",
  "weeklyFinalMismatchLines", "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "CARD_MIN_NAME",
  "CARD_MAX_COLUMNS", "CARD_COL_GAP", "cardColumnBox", "cardColumnCols", "cardSlot",
  "drawCardTableColumns", "cardHonoursWidth", "cardHonoursFit", 
  "CARD", "CARD_W", "CARD_SIDE", "CARD_PAD", "CARD_COL", "CARD_HEAD_H", "CARD_HERO_H",
  "CARD_TABLE_HEAD_H", "CARD_ROW_H", "CARD_SEASON_ROW_H", "CARD_FOOT_H", "CARD_GAP", "PLACE_NUMBER"];

function paintBox(overrides = {}) {
  const made = [];
  return load(NAMES, {
    fixtures: [],
    activeLeague: "AAA",
    leagueTab: "matchday",
    currentView: "league",
    selectedPeriod: "3",
    roundState: null,
    leagueStates: {},
    leagueCodes: ["AAA"],
    leagueNames: { AAA: "Sunday Six" },
    leagueState: { code: "AAA", name: "Sunday Six", owner: "u1", table: [] },
    weeklyFinalMismatches: new Map(),
    matchweekCountMismatches: new Map(),
    seasonRounds: () => 38,
    currentPeriodKey: () => "3",
    leagueSupportsRounds: () => true,
    inviteLinkFor: (c) => `https://x/${c}`,
    leagueCompetitionNames: () => "Premier League",
    periodLabel: (p) => `Matchweek ${p}`,
    escapeHTML: (v) => String(v),
    uid: () => "u1",
    PLACE_EMOJI: { gold: "🏆", silver: "🥈", bronze: "🥉" },
    document: { createElement: () => { const r = recorder(); made.push(r); return r.canvas; } },
    __made: made,
    ...overrides,
  });
}

const painted = (box) => box.__made[box.__made.length - 1].marks;
const texts = (box) => painted(box).map((m) => m.text);

const weeklyState = { code: "AAA", name: "Sunday Six", owner: "u1" };
const slate = (n, ids) => ({ period: String(n), status: "published", fixtureIds: ids, count: ids.length });
const weekRound = (n, entries, { complete = false, table = null, podium = [] } = {}) => ({
  code: "AAA", matchday: n, period: String(n), complete,
  slate: slate(n, entries.map((e) => e.id)),
  reveal: entries,
  podium,
  table: table || [{ uid: "u1", rank: 1, nick: "Adam", pts: 0, exact: 0 }],
});
const six = (settled, voided = 0) => Array.from({ length: 6 }, (_, i) => ({
  id: `w-${i}`,
  ...(i < settled ? { settled: true } : i < settled + voided ? { voided: true } : {}),
}));

// --- A · no floating trophy over a hero that names nobody -------------------

test("A · a not-started hero draws no trophy and no empty name", () => {
  const box = paintBox();
  const round = weekRound(3, six(0), {
    table: [{ uid: "u1", nick: "Adam", pts: 0, exact: 0 }, { uid: "u2", nick: "Bex", pts: 0, exact: 0 }],
  });
  box.drawWeeklyResultCard(weeklyState, round);
  const drawn = texts(box);
  assert.ok(drawn.includes("NOT STARTED"), "the state is named");
  assert.equal(drawn.filter((t) => t.includes("🏆")).length, 0,
    `a trophy was painted over nobody: ${JSON.stringify(drawn.filter((t) => t.includes("🏆")))}`);
  assert.equal(drawn.filter((t) => t.trim() === "").length, 0, "an empty string was drawn");
  // The state line moves up into the space the name would have used, and grows.
  const model = box.weeklyCardModel(weeklyState, round);
  const line = painted(box).find((m) => m.text === model.heroLine && m.align === "center"
    && m.fill === box.CARD.ink);
  assert.ok(line, "the hero states how far through the week it is");
  assert.match(line.font, /\b40px\b/, "the lone hero line is drawn at its larger size");
});

test("A · the trophy returns the moment a name is claimed", () => {
  for (const [label, round] of [
    ["leading", weekRound(3, six(2), { table: [{ uid: "u1", nick: "Adam", pts: 9, exact: 1 }] })],
    ["final", weekRound(3, six(6), { complete: true,
      podium: [{ uid: "u1", place: "gold", nick: "Adam", pts: 21 }],
      table: [{ uid: "u1", nick: "Adam", pts: 21, exact: 3 }] })],
  ]) {
    const box = paintBox();
    box.drawWeeklyResultCard(weeklyState, round);
    const trophies = texts(box).filter((t) => t.startsWith("🏆 "));
    assert.deepEqual(trophies, ["🏆 Adam"], `${label}: the claimed name carries the trophy`);
  }
});

test("A · the hero frame is neutral until somebody is named", () => {
  const box = paintBox();
  const hero = [];
  box.evalIn(`(${function (record) {
    const ctx = { _fill: "", _stroke: "",
      set fillStyle(v) { this._fill = v; record.push(["fill", v]); },
      get fillStyle() { return this._fill; },
      set strokeStyle(v) { this._stroke = v; record.push(["stroke", v]); },
      get strokeStyle() { return this._stroke; },
      font: "", textAlign: "left", lineWidth: 0,
      fillText: () => {}, fill: () => {}, stroke: () => {},
      measureText: () => ({ width: 10 }), beginPath: () => {}, closePath: () => {},
      moveTo: () => {}, lineTo: () => {}, arcTo: () => {},
    };
    globalThis.__heroProbe = (model) => { record.length = 0; drawCardHero(ctx, 0, model); return record.slice(); };
  }})(${"globalThis.__heroRecord = globalThis.__heroRecord || []"});`);
  const record = box.evalIn(`globalThis.__heroProbe({ heroEyebrow: "NOT STARTED", heroName: "", heroLine: "Week 3 · not started · 0 of 6 fixtures" })`);
  const colours = record.map(([, v]) => v);
  assert.ok(!colours.includes(box.CARD.goldWash), "an unclaimed hero was washed in gold");
  assert.ok(!colours.includes(box.CARD.goldEdge), "an unclaimed hero was edged in gold");
  assert.ok(colours.includes(box.CARD.row) && colours.includes(box.CARD.line), "the neutral frame is used");
  const claimed = box.evalIn(`globalThis.__heroProbe({ heroEyebrow: "MATCHWEEK CHAMPION", heroName: "Adam", heroLine: "x" })`)
    .map(([, v]) => v);
  assert.ok(claimed.includes(box.CARD.goldWash) && claimed.includes(box.CARD.goldEdge),
    "a claimed hero keeps its gold");
  void hero;
});

// --- B · honours survive every compression of the season table --------------

const seasonTable = (n) => Array.from({ length: n }, (_, i) => ({
  uid: `u${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 200 - i * 3, exact: i % 4,
  podiums: { gold: i % 3, silver: (i + 1) % 3, bronze: (i + 2) % 3 },
}));
const seasonState = (n) => ({ code: "AAA", name: "Sunday Six", owner: "u1",
  table: seasonTable(n), currentMatchday: 8, currentMatchdayHasResults: true });

for (const [label, members] of [["common", 8], ["maximum", 30]]) {
  test(`B · every honours value reaches the canvas at the ${label} size (${members} members)`, () => {
    const box = paintBox({ leagueTab: "season" });
    const state = seasonState(members);
    box.drawSeasonTableCard(state);
    const drawn = texts(box);
    const model = box.seasonCardModel(state);
    assert.equal(model.rows.length, members, "every member is exported");
    for (const row of model.rows) {
      for (const [emoji, key] of [["🏆", "gold"], ["🥈", "silver"], ["🥉", "bronze"]]) {
        assert.ok(drawn.includes(`${emoji} ${row.honours[key]}`),
          `${row.nick}: ${key}=${row.honours[key]} never reached the canvas`);
      }
    }
    // Every row's tally is drawn, not just the ones that happen to be non-zero.
    const tallies = drawn.filter((t) => /^🏆 \d+$/.test(t)).length;
    assert.equal(tallies, members, `${tallies} gold tallies for ${members} rows`);
  });
}

test("B · honours are on the row, whichever way the row is laid out", () => {
  const box = paintBox({ leagueTab: "season" });
  const chrome = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const roomy = box.cardRowMetrics(8, { chrome, base: box.CARD_SEASON_ROW_H });
  const tight = box.cardRowMetrics(30, { chrome, base: box.CARD_SEASON_ROW_H });
  assert.equal(roomy.honoursLine, true, "a roomy row gives honours their own line");
  assert.equal(tight.honoursLine, false, "a tight row cannot afford a second line");
  assert.ok(tight.honoursSize >= 13, "the compact tally is still a readable size");
  // Laid out beside the name rather than under it, and never over it.
  const box2 = paintBox({ leagueTab: "season" });
  box2.drawSeasonTableCard(seasonState(30));
  const marks = painted(box2);
  const tally = marks.find((m) => /^🏆 \d+$/.test(m.text));
  const name = marks.find((m) => m.text === "Player 1");
  assert.ok(tally && name, "both the name and the tally are drawn");
  assert.ok(tally.x > name.x, "the compact tally sits to the right of the name column");
});

test("B · a member with no honours still shows a zero tally", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = { code: "AAA", name: "Sunday Six", owner: "u1", currentMatchday: 8,
    currentMatchdayHasResults: true,
    table: [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1 }] };
  box.drawSeasonTableCard(state);
  const drawn = texts(box);
  assert.ok(drawn.includes("🏆 0") && drawn.includes("🥈 0") && drawn.includes("🥉 0"),
    "an empty tally is drawn as zeroes, not omitted");
});

// --- C · terminal is not "settled" -----------------------------------------

test("C · the weekly caption counts fixtures without calling a void settled", () => {
  const box = paintBox();
  const status = box.weeklyShareStatus(weekRound(3, six(2, 1)));
  assert.equal(status.label, "Week 3 · in progress · after 3 of 6");
  assert.ok(!/settled/.test(status.label), "a void was described as settled");
});

// --- D · a week may only be shared once it is published, here, now ----------

test("D · a league with a table but no published slate cannot be shared", () => {
  const box = paintBox({ roundState: { code: "AAA", matchday: 3, period: "3",
    table: [{ uid: "u1", nick: "Adam", pts: 0, exact: 0 }] } });
  const state = box.shareCardState();
  assert.equal(state.ready, false, "an unpublished week offered itself for sharing");
  assert.match(state.label, /still loading/);
  assert.equal(box.shareIconButton({ code: "AAA" }), "", "no control is rendered");
});

test("D · a slate that is not yet published cannot be shared", () => {
  const round = weekRound(3, six(0));
  const box = paintBox({ roundState: { ...round, slate: { ...round.slate, status: "draft" } } });
  assert.equal(box.shareCardState().ready, false, "a draft slate was shareable");
});

test("D · a slate with no fixtures in it cannot be shared", () => {
  const round = weekRound(3, []);
  const box = paintBox({ roundState: round });
  assert.equal(box.shareCardState().ready, false, "an empty slate was shareable");
});

test("D · publication alone opens sharing — settlement is not required", () => {
  const box = paintBox({ roundState: weekRound(3, six(0)) });
  const state = box.shareCardState();
  assert.equal(state.ready, true, "a newly published week refused to share");
  assert.equal(state.label, "Share Matchweek 3 standings");
});

test("D · a round for another period cannot be shared under this one", () => {
  // The screen is on week 3; a late response for week 2 arrives.
  const box = paintBox({ selectedPeriod: "3", roundState: weekRound(2, six(6), { complete: true }) });
  assert.equal(box.shareCardState().ready, false, "last week's round vouched for this week");
});

test("D · a slate for another period cannot be shared under this round", () => {
  const round = weekRound(3, six(2));
  const box = paintBox({ roundState: { ...round, slate: slate(2, ["w-0", "w-1"]) } });
  assert.equal(box.shareCardState().ready, false, "a stale slate was shared as this week's");
});

test("D · another league's round cannot be shared from this pill", () => {
  const box = paintBox({ activeLeague: "AAA",
    roundState: { ...weekRound(3, six(2)), code: "BBB" } });
  assert.equal(box.shareCardState().ready, false, "another league's week was shareable here");
});

test("D · the gate answers null, not a slate, for every refusal", () => {
  const box = paintBox();
  const good = weekRound(3, six(1));
  assert.equal(box.weeklySharePublished(good, "3"), good.slate, "the published slate is returned");
  assert.equal(box.weeklySharePublished(good, "2"), null, "wrong period");
  assert.equal(box.weeklySharePublished(null, "3"), null, "no round");
  assert.equal(box.weeklySharePublished({ ...good, error: true }, "3"), null, "an errored round");
  assert.equal(box.weeklySharePublished(good, null), null, "no period on screen");
  assert.equal(box.weeklySharePublished({ ...good, slate: undefined }, "3"), null, "no slate");
});

// --- Sol's readability ruling: layout solves the fit, not shrinking ---------
//
// The pixel evidence found effective 11px table text on two cards. The cause
// was a card that met its budget by scaling itself down; the answer is a table
// that takes another column instead. These tests hold the floors, the order
// and the membership that the second column must not cost us.

const WEEKLY_CHROME = () => {
  const box = paintBox();
  return box.CARD_HEAD_H + box.CARD_GAP + box.CARD_HERO_H + box.CARD_GAP
    + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
};

function layoutOf(box, members, weekly) {
  const chrome = weekly
    ? box.CARD_HEAD_H + box.CARD_GAP + box.CARD_HERO_H + box.CARD_GAP
      + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H
    : box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const m = box.cardRowMetrics(members, { chrome, base: weekly ? box.CARD_ROW_H : box.CARD_SEASON_ROW_H });
  const k = Math.min(1, box.CARD_SIDE / Math.max(m.contentHeight, 1));
  return { m, k, chrome };
}

const SIZES = [1, 2, 3, 6, 8, 10, 12, 16, 20, 24, 25, 30, 36, 40];

for (const weekly of [true, false]) {
  test(`floors · ${weekly ? "weekly" : "season"} type never falls below 18/15 after the transform`, () => {
    const box = paintBox();
    for (const members of SIZES) {
      const { m, k } = layoutOf(box, members, weekly);
      const primary = Math.min(m.name, m.number, m.points) * k;
      const secondary = Math.min(m.second, m.honoursSize) * k;
      assert.ok(primary >= box.CARD_TYPE_FLOOR - 0.001,
        `${members} members: names/ranks/points fell to ${primary.toFixed(1)}px`);
      assert.ok(secondary >= box.CARD_SECOND_FLOOR - 0.001,
        `${members} members: secondary figures fell to ${secondary.toFixed(1)}px`);
    }
  });

  test(`floors · ${weekly ? "weekly" : "season"} layout solves the fit — the card is never shrunk to fit`, () => {
    const box = paintBox();
    for (const members of SIZES) {
      const { m, k } = layoutOf(box, members, weekly);
      assert.equal(k, 1, `${members} members: the card was scaled to ${k.toFixed(3)} instead of laid out`);
      assert.ok(m.contentHeight <= box.CARD_SIDE + 0.001,
        `${members} members: content ${m.contentHeight} overflows the square`);
    }
  });
}

test("floors · a table takes a column only when it needs one", () => {
  const box = paintBox();
  // The accepted sizes stay in one column and keep their generous rows.
  assert.equal(layoutOf(box, 6, true).m.columns, 1, "a six-member week");
  assert.equal(layoutOf(box, 8, false).m.columns, 1, "the common season table");
  // The sizes the ruling named take a second.
  assert.equal(layoutOf(box, 20, true).m.columns, 2, "a twenty-member week");
  assert.equal(layoutOf(box, 20, false).m.columns, 2, "a twenty-member season");
  assert.equal(layoutOf(box, 30, false).m.columns, 2, "a thirty-member season");
  // And the row never drops below the height an 18px line needs.
  for (const members of SIZES) {
    for (const weekly of [true, false]) {
      assert.ok(layoutOf(box, members, weekly).m.rowH >= box.CARD_MIN_ROW - 0.001,
        `${members}/${weekly ? "weekly" : "season"} row is ${layoutOf(box, members, weekly).m.rowH}`);
    }
  }
});

test("columns · the ranking continues into the next column, in order", () => {
  const box = paintBox();
  const { m } = layoutOf(box, 20, false);
  assert.equal(m.columns, 2);
  assert.equal(m.perColumn, 10);
  const slots = Array.from({ length: 20 }, (_, i) => box.cardSlot(i, m));
  // Column 0 holds ranks 1..10 top to bottom; column 1 holds 11..20.
  slots.forEach((slot, index) => {
    assert.equal(slot.column, Math.floor(index / 10), `member ${index + 1} is in the wrong column`);
    assert.equal(slot.row, index % 10, `member ${index + 1} is on the wrong line`);
  });
  // Left to right: the second column starts to the right of the first, and the
  // two never overlap.
  const left = box.cardColumnBox(0, 2), right = box.cardColumnBox(1, 2);
  assert.ok(right.x >= left.x + left.width, "the columns overlap");
  assert.ok(right.x + right.width <= box.CARD_W - box.CARD_PAD + 0.001, "a column runs off the card");
});

test("columns · every member is drawn, in rank order, at every size", () => {
  for (const members of [8, 20, 30]) {
    const box = paintBox({ leagueTab: "season" });
    const state = seasonState(members);
    box.drawSeasonTableCard(state);
    const marks = painted(box);
    const model = box.seasonCardModel(state);
    assert.equal(model.rows.length, members, "the model dropped a member");
    for (const row of model.rows) {
      assert.ok(marks.some((mark) => mark.text === row.nick), `${row.nick} was never drawn`);
      assert.ok(marks.some((mark) => mark.text === String(row.rank)), `rank ${row.rank} was never drawn`);
      assert.ok(marks.some((mark) => mark.text === String(row.pts)), `${row.nick}'s points never drawn`);
      assert.ok(marks.some((mark) => mark.text === String(row.exact)), `${row.nick}'s exact count never drawn`);
    }
    // Reading each column top to bottom gives 1..N with nothing missing.
    const { m } = layoutOf(box, members, false);
    const order = model.rows.map((row, index) => ({ ...box.cardSlot(index, m), rank: row.rank }));
    const byColumn = new Map();
    for (const entry of order) {
      if (!byColumn.has(entry.column)) byColumn.set(entry.column, []);
      byColumn.get(entry.column).push(entry.rank);
    }
    const readOut = [...byColumn.keys()].sort((a, b) => a - b).flatMap((c) => byColumn.get(c));
    assert.deepEqual(readOut, model.rows.map((row) => row.rank),
      `${members} members read out of order`);
  }
});

test("columns · a continued table repeats its headings", () => {
  const box = paintBox({ leagueTab: "season" });
  box.drawSeasonTableCard(seasonState(20));
  const heads = texts(box).filter((text) => text === "PLAYER");
  assert.equal(heads.length, 2, "the second column has no heading of its own");
  const one = paintBox({ leagueTab: "season" });
  one.drawSeasonTableCard(seasonState(8));
  assert.equal(texts(one).filter((text) => text === "PLAYER").length, 1,
    "a single column grew a heading it does not need");
});

test("columns · an inline tally never runs into the exact column", () => {
  const box = paintBox({ leagueTab: "season" });
  const { m } = layoutOf(box, 30, false);
  assert.equal(m.honoursLine, false, "this size is the inline case");
  const ctx = { font: "", measureText: (t) => ({ width: String(t).length * 12 }) };
  // Two-digit honours are a real season: 38 matchweeks, three places.
  for (const columns of [1, 2]) {
    const cols = box.cardColumnCols(box.cardColumnBox(0, columns), columns);
    const counts = { gold: 12, silver: 34, bronze: 56 };
    const fit = box.cardHonoursFit(ctx, cols, counts, m);
    assert.ok(fit.x + fit.width <= cols.exact - m.second,
      `${columns} column(s): the tally reached the exact figure`);
    assert.ok(fit.size >= box.CARD_SECOND_FLOOR, `${columns} column(s): the tally fell below the floor`);
    assert.ok(fit.x - cols.name >= 24, `${columns} column(s): the name lost every character`);
  }
});

// --- the exported card carries no rostrum ----------------------------------

test("podium · the exported weekly card draws no rostrum", () => {
  const box = paintBox();
  const round = weekRound(3, six(6), { complete: true,
    podium: [{ uid: "u0", place: "gold", nick: "Adam", pts: 92 },
             { uid: "u1", place: "silver", nick: "Bex", pts: 89 },
             { uid: "u2", place: "bronze", nick: "Cal", pts: 86 }],
    table: [{ uid: "u0", nick: "Adam", pts: 92, exact: 3 },
            { uid: "u1", nick: "Bex", pts: 89, exact: 2 },
            { uid: "u2", nick: "Cal", pts: 86, exact: 1 }] });
  box.drawWeeklyResultCard(weeklyState, round);
  const drawn = texts(box);
  // The rostrum drew a big "1"/"2"/"3" on each block and a "N pts" line under
  // each name. The table draws neither.
  assert.equal(drawn.filter((text) => /^\d+ pts$/.test(text)).length, 0,
    "a rostrum points line was drawn");
  assert.equal(drawn.filter((text) => text === "Adam").length, 1,
    "the champion's name was drawn twice — hero and rostrum");
  // The medals survive, in the table where they belong.
  assert.deepEqual(drawn.filter((text) => ["🏆", "🥈", "🥉"].includes(text)), ["🏆", "🥈", "🥉"]);
});

test("podium · the drawing code has no rostrum left in it", () => {
  assert.equal(APP.includes("function drawCardPodium("), false, "drawCardPodium is still shipped");
  assert.equal(APP.includes("CARD_PODIUM"), false, "the rostrum geometry is still shipped");
  // The on-screen podium is untouched.
  assert.ok(APP.includes('class="podium-block"'), "the on-screen podium was removed");
  assert.ok(APP.includes("const PLACE_NUMBER ="), "the on-screen podium lost its numbers");
});

test("podium · dropping the rostrum is what buys the table its size", () => {
  const box = paintBox();
  const withRostrum = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_HERO_H + box.CARD_GAP
    + 350 + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  assert.ok(WEEKLY_CHROME() < withRostrum, "the export did not get its space back");
  // With the rostrum's 378px back, six rows are drawn at full height.
  const { m, k } = layoutOf(box, 6, true);
  assert.equal(k, 1);
  assert.ok(m.rowH >= 50, `a six-member week draws ${m.rowH}px rows`);
  assert.ok(m.name >= 22, `and names at ${m.name}px`);
});

test("columns · a narrow column takes the short heading, not two words run together", () => {
  const box = paintBox({ leagueTab: "season" });
  box.drawSeasonTableCard(seasonState(40));
  const drawn = texts(box);
  const { m } = layoutOf(box, 40, false);
  assert.equal(m.columns, 3, "forty members take a third column");
  assert.equal(drawn.filter((text) => text === "EX").length, 3, "each narrow column is headed EX");
  assert.equal(drawn.filter((text) => text === "EXACT").length, 0,
    "the long heading collided with PLAYER");
  // A column wide enough keeps the word.
  const wide = paintBox({ leagueTab: "season" });
  wide.drawSeasonTableCard(seasonState(20));
  assert.equal(texts(wide).filter((text) => text === "EXACT").length, 2);
  assert.equal(texts(wide).filter((text) => text === "EX").length, 0);
});

test("columns · forty members still hold every floor", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = seasonState(40);
  box.drawSeasonTableCard(state);
  const model = box.seasonCardModel(state);
  assert.equal(model.rows.length, 40);
  const marks = painted(box);
  for (const row of model.rows) {
    assert.ok(marks.some((mark) => mark.text === row.nick), `${row.nick} was never drawn`);
  }
  const { m, k } = layoutOf(box, 40, false);
  assert.equal(k, 1);
  assert.ok(Math.min(m.name, m.number, m.points) * k >= box.CARD_TYPE_FLOOR);
  assert.ok(Math.min(m.second, m.honoursSize) * k >= box.CARD_SECOND_FLOOR);
  // At three columns the tally cannot sit beside the name, so it takes its
  // own baseline rather than being dropped or run through the figures.
  assert.equal(m.honoursLine, true, "a narrow column tried to inline its tally");
});
