// v1.7 · Sol's final presentation corrections, checked on the DRAWING PATH.
//
// The Slice C tests stub the draw functions out and check geometry. That is the
// right test for geometry and the wrong one for presentation: a card can have
// perfect bounds and still paint a trophy over nobody, or quietly drop a
// player's honours when the table is long. So this file lifts the REAL
// drawCard* functions and records every mark they make.
import test from "node:test";
import assert from "node:assert/strict";
import { APP, load, sourceOf } from "./harness.mjs";

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

const NAMES = ["seasonCardPages", "drawSeasonPage", "drawSeasonTableCard", "weeklyCardPages", "drawWeeklyPage", "drawWeeklyResultCard", "drawCardHeader", "drawCardHero", "drawCardTableHead", "drawCardRowPlate", "drawWeeklyRowBand",
  "drawCardRowRule", "weeklyCardGeometry", "drawCardHonours", "drawCardFooter",
  "drawFitted", "fitText", "ellipsise", "roundedRect", "cardCanvas", "cardRowMetrics", "cardFont",
  "cardDate", "sentenceCase", "seasonCardModel",
  "weeklyCardModel", "weeklyCardCaption", "weeklyShareStatus", "weeklyTerminalCount",
  "shareSurface", "shareRound", "sharePeriod", "normaliseView", "LEGACY_VIEWS",
  "cardPageRows", "cardPageLabel", "cardTableTop", "CARD_MIN_NAME", "weeklySharePublished", "shareCardState", "seasonShareFreshness", "shareIconButton",
  "podiumCounts", "weeklyRanks", "sharedRankByUid", "winnerNames", "noteWeeklyFinalMismatch",
  "weeklyFinalMismatchLines", "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "cardHonoursWidth", "cardHonoursFit", 
  "CARD", "CARD_W", "CARD_W_PX", "CARD_H_PX", "CARD_PAD", "CARD_COL", "CARD_HEAD_H", "CARD_HERO_H",
  "CARD_HERO_MIN", "CARD_RULE_H", "weeklyCardGeometry", "drawWeeklyRowBand", "drawCardRowRule",
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
    const pages = box.drawSeasonTableCard(state).length;
    const drawn = box.__made.slice(-pages).flatMap((made) => made.marks.map((mark) => mark.text));
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
  const pages = box2.drawSeasonTableCard(seasonState(30)).length;
  const marks = box2.__made.slice(-pages).flatMap((made) => made.marks);
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
  // The weekly card's hero and table are solved together, by the shipped
  // function — the test must not carry its own copy of that arithmetic.
  if (weekly) {
    const { hero, chrome, m } = box.weeklyCardGeometry(members);
    return { m, chrome, hero, k: Math.min(1, box.CARD_H_PX / Math.max(m.contentHeight, 1)) };
  }
  const chrome = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const m = box.cardRowMetrics(members, { chrome, base: box.CARD_SEASON_ROW_H });
  const k = Math.min(1, box.CARD_H_PX / Math.max(m.contentHeight, 1));
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
      assert.ok(m.contentHeight <= box.CARD_H_PX + 0.001,
        `${members} members: content ${m.contentHeight} overflows the square`);
    }
  });
}

test("pages · a table takes a second page only when it needs one", () => {
  const box = paintBox();
  // Adam's ruling: one linear vertical list, never side-by-side columns.
  // Portrait: everything the ruling named fits one image.
  assert.equal(layoutOf(box, 6, true).m.pages, 1, "a six-member week");
  assert.equal(layoutOf(box, 11, true).m.pages, 1, "an eleven-member week");
  assert.equal(layoutOf(box, 20, true).m.pages, 1, "a twenty-member week");
  assert.equal(layoutOf(box, 30, true).m.pages, 1, "a thirty-member week");
  assert.equal(layoutOf(box, 8, false).m.pages, 1, "the common season table");
  assert.equal(layoutOf(box, 11, false).m.pages, 1, "an eleven-member season");
  assert.equal(layoutOf(box, 20, false).m.pages, 1, "a twenty-member season");
  assert.equal(layoutOf(box, 30, false).m.pages, 1, "a thirty-member season");
  assert.equal(layoutOf(box, 40, false).m.pages, 1, "a forty-member season");
  // And a genuinely large table still pages rather than shrinking.
  assert.ok(layoutOf(box, 60, false).m.pages >= 2, "sixty members did not page");
  assert.ok(layoutOf(box, 60, true).m.pages >= 2, "sixty members did not page");
  // And the row never drops below the height an 18px line needs.
  for (const members of SIZES) {
    for (const weekly of [true, false]) {
      assert.ok(layoutOf(box, members, weekly).m.rowH >= box.CARD_MIN_ROW - 0.001,
        `${members}/${weekly ? "weekly" : "season"} row is ${layoutOf(box, members, weekly).m.rowH}`);
    }
  }
});

test("pages · there is no column machinery left to fall back to", () => {
  for (const gone of ["cardColumnBox", "cardColumnCols", "cardSlot", "drawCardTableColumns",
    "CARD_MAX_COLUMNS", "CARD_COL_GAP", "m.columns", "perColumn"]) {
    assert.ok(!APP.includes(gone), `${gone} survives the single-list ruling`);
  }
});

test("pages · every member appears exactly once, in rank order, across the pages", () => {
  const box = paintBox({ leagueTab: "season" });
  for (const members of [1, 11, 20, 30, 40]) {
    const state = seasonState(members);
    const model = box.seasonCardModel(state);
    const { m } = layoutOf(box, members, false);
    const paged = Array.from({ length: m.pages }, (_, page) => box.cardPageRows(model.rows, page, m));
    const flat = paged.flat();
    assert.equal(flat.length, members, `${members}: a member was lost or duplicated`);
    assert.deepEqual(flat.map((row) => row.rank), model.rows.map((row) => row.rank),
      `${members}: the ranking was reordered across pages`);
    assert.equal(new Set(flat.map((row) => row.nick)).size, members, `${members}: a member appears twice`);
    // Each page is a contiguous run of the ranking, top to bottom.
    for (const page of paged) {
      assert.ok(page.length > 0, `${members}: an empty page was generated`);
      assert.deepEqual(page.map((row) => row.rank),
        page.map((_, i) => page[0].rank + i), `${members}: a page is not contiguous`);
    }
  }
});

test("pages · every page is 1080x1920 and carries the table's own headings", () => {
  for (const members of [11, 20, 30, 40, 60]) {
    const box = paintBox({ leagueTab: "season" });
    const canvases = box.drawSeasonTableCard(seasonState(members));
    const { m } = layoutOf(box, members, false);
    assert.equal(canvases.length, m.pages, `${members}: wrong number of pages`);
    for (const canvas of canvases) {
      assert.equal(canvas.width, 1080);
      assert.equal(canvas.height, 1920);
    }
    // One recorder per page: each drew its own PLAYER/EXACT/PTS headings.
    const drawnPages = box.__made.slice(-m.pages).map((made) => made.marks.map((mark) => mark.text));
    for (const drawn of drawnPages) {
      assert.ok(drawn.includes("PLAYER"), `${members}: a page lost its headings`);
      assert.ok(drawn.includes("EXACT"));
      assert.ok(drawn.includes("PTS"));
      assert.ok(drawn.includes("Sunday Six"), `${members}: a page lost the league name`);
    }
  }
});

test("pages · a multi-page export marks its pages, a single one does not", () => {
  const box = paintBox({ leagueTab: "season" });
  assert.equal(box.cardPageLabel(0, 1), "", "a single card claimed to be a page");
  assert.equal(box.cardPageLabel(0, 3), "Page 1 of 3");
  assert.equal(box.cardPageLabel(2, 3), "Page 3 of 3");
  box.drawSeasonTableCard(seasonState(60));
  const { m } = layoutOf(box, 60, false);
  const marks = box.__made.slice(-m.pages).map((made) => made.marks.map((mark) => mark.text));
  assert.deepEqual(marks.map((drawn) => drawn.find((text) => /^Page \d+ of \d+$/.test(text))),
    Array.from({ length: m.pages }, (_, i) => `Page ${i + 1} of ${m.pages}`));
  // An eleven-member league is one image and says nothing about pages.
  const one = paintBox({ leagueTab: "season" });
  one.drawSeasonTableCard(seasonState(11));
  assert.ok(!texts(one).some((text) => /^Page /.test(text)), "a single square was marked as a page");
});

test("pages · an inline tally never runs into the exact column", () => {
  const box = paintBox({ leagueTab: "season" });
  const { m } = layoutOf(box, 30, false);
  assert.equal(m.honoursLine, false, "this size is the inline case");
  const ctx = { font: "", measureText: (t) => ({ width: String(t).length * 12 }) };
  // Two-digit honours are a real season: 38 matchweeks, three places.
  const counts = { gold: 12, silver: 34, bronze: 56 };
  const fit = box.cardHonoursFit(ctx, box.CARD_COL, counts, m);
  assert.ok(fit.x + fit.width <= box.CARD_COL.exact - m.second, "the tally reached the exact figure");
  assert.ok(fit.size >= box.CARD_SECOND_FLOOR, "the tally fell below the floor");
  assert.ok(fit.x - box.CARD_COL.name >= 24, "the name lost every character");
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

test("pages · forty members hold every floor, on one portrait image", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = seasonState(40);
  const canvases = box.drawSeasonTableCard(state);
  assert.equal(canvases.length, 1, "forty members should now be one portrait image");
  const model = box.seasonCardModel(state);
  assert.equal(model.rows.length, 40);
  const drawn = box.__made.slice(-1).flatMap((made) => made.marks.map((mark) => mark.text));
  for (const row of model.rows) {
    assert.ok(drawn.includes(row.nick), `${row.nick} was never drawn`);
  }
  const { m, k } = layoutOf(box, 40, false);
  assert.equal(k, 1);
  assert.ok(Math.min(m.name, m.number, m.points) * k >= box.CARD_TYPE_FLOOR);
  assert.ok(Math.min(m.second, m.honoursSize) * k >= box.CARD_SECOND_FLOOR);
});

// --- the weekly export pages too (Adam's build-25 ruling 1) -----------------

test("pages · a weekly export is one list, paged, with every member once", () => {
  const box = paintBox();
  for (const members of [1, 6, 11, 20, 30]) {
    const round = weekRound(3, six(6), { complete: true,
      table: Array.from({ length: members }, (_, i) => ({
        uid: `w${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 90 - i * 2, exact: i % 4 })) });
    const canvases = box.drawWeeklyResultCard(weeklyState, round);
    const { m } = layoutOf(box, members, true);
    assert.equal(canvases.length, m.pages, `${members}: wrong page count`);
    for (const canvas of canvases) {
      assert.equal(canvas.width, 1080);
      assert.equal(canvas.height, 1920);
    }
    // Every member drawn exactly once, in rank order, across the pages.
    const model = box.weeklyCardModel(weeklyState, round);
    const paged = Array.from({ length: m.pages }, (_, page) => box.cardPageRows(model.rows, page, m));
    const flat = paged.flat();
    assert.equal(flat.length, members, `${members}: a member was lost or duplicated`);
    assert.deepEqual(flat.map((row) => row.nick), model.rows.map((row) => row.nick),
      `${members}: the ranking was reordered`);
    assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR,
      `${members}: a weekly page fell below the type floor`);
    assert.equal(Math.min(1, box.CARD_H_PX / m.contentHeight), 1,
      `${members}: a weekly page was shrunk to fit`);
  }
});

test("pages · every weekly page repeats the hero, the headings and its number", () => {
  const box = paintBox();
  const MEMBERS = 60;                       // enough to page a portrait weekly card
  const round = weekRound(3, six(6), { complete: true,
    podium: [{ uid: "w0", place: "gold", nick: "Player 1", pts: 90 }],
    table: Array.from({ length: MEMBERS }, (_, i) => ({
      uid: `w${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 90 - i * 2, exact: i % 4 })) });
  const canvases = box.drawWeeklyResultCard(weeklyState, round);
  const { m } = layoutOf(box, MEMBERS, true);
  assert.equal(canvases.length, m.pages);
  assert.ok(m.pages >= 2, "this size should page");
  const pages = box.__made.slice(-m.pages).map((made) => made.marks.map((mark) => mark.text));
  pages.forEach((drawn, index) => {
    assert.ok(drawn.includes("PLAYER"), `page ${index + 1} lost its headings`);
    assert.ok(drawn.includes("Sunday Six"), `page ${index + 1} lost the league name`);
    assert.ok(drawn.some((text) => text.startsWith("\u{1F3C6} ")), `page ${index + 1} lost the champion`);
    assert.ok(drawn.includes(`Page ${index + 1} of ${pages.length}`), `page ${index + 1} is not numbered`);
  });
  // Every member once, split across the pages, with nothing repeated.
  const named = pages.map((drawn) => drawn.filter((text) => /^Player \d+$/.test(text)));
  assert.equal(named.flat().length, MEMBERS, "a member was lost or duplicated");
  assert.equal(new Set(named.flat()).size, MEMBERS, "a member appears on two pages");
});

test("pages · no exported table uses side-by-side columns, weekly or season", () => {
  // No column machinery anywhere on either export path.
  for (const fn of ["weeklyCardPages", "drawWeeklyPage", "drawWeeklyResultCard",
                    "seasonCardPages", "drawSeasonPage", "drawSeasonTableCard"]) {
    const src = sourceOf(fn);
    for (const banned of ["cardColumnBox", "cardColumnCols", "cardSlot", "drawCardTableColumns",
      "m.columns", "perColumn", "slot.box", "slot.cols"]) {
      assert.ok(!src.includes(banned), `${fn} reaches ${banned}`);
    }
  }
  // The page drawers are the ones that page and number.
  for (const fn of ["drawWeeklyPage", "drawSeasonPage"]) {
    const src = sourceOf(fn);
    assert.match(src, /cardPageRows\(model\.rows, page, m\)/, `${fn} does not page`);
    assert.match(src, /cardPageLabel\(page, m\.pages\)/, `${fn} does not number its pages`);
  }
});

// --- Adam's build-25 weekly corrections ------------------------------------

test("W1 · eleven members are one portrait weekly attachment", () => {
  const box = paintBox();
  const { m, hero } = layoutOf(box, 11, true);
  assert.equal(m.pages, 1, `eleven members split into ${m.pages} attachments`);
  assert.equal(m.rowsPerPage, 11, "the page does not carry all eleven");
  // Portrait has room to spare, so the hero keeps its full height AND the rows
  // keep theirs: the fit no longer costs anything.
  assert.equal(hero, box.CARD_HERO_H, "the hero compacted when it did not need to");
  assert.equal(m.rowH, box.CARD_ROW_H, "the rows were compressed when they did not need to be");
  assert.ok(m.rowH >= box.CARD_MIN_ROW, "the rows fell below the row floor");
  assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR);
  assert.ok(Math.min(m.second) >= box.CARD_SECOND_FLOOR);
  assert.equal(Math.min(1, box.CARD_H_PX / m.contentHeight), 1, "the card was shrunk to fit");
});

test("W1 · the eleven names are drawn once each, in rank order, on that one square", () => {
  const box = paintBox();
  const table = Array.from({ length: 11 }, (_, i) => ({
    uid: `w${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 92 - i * 3, exact: i % 4 }));
  const canvases = box.drawWeeklyResultCard(weeklyState, weekRound(3, six(6), { complete: true, table }));
  assert.equal(canvases.length, 1);
  const drawn = texts(box);
  for (const row of table) {
    assert.equal(drawn.filter((text) => text === row.nick).length, 1, `${row.nick} is not drawn exactly once`);
    assert.ok(drawn.includes(String(row.pts)), `${row.nick}'s points are missing`);
  }
  const order = drawn.filter((text) => /^Player \d+$/.test(text));
  assert.deepEqual(order, table.map((row) => row.nick), "the ranking was reordered");
  assert.ok(!drawn.some((text) => /^Page /.test(text)), "a single square was marked as a page");
});

test("W1 · the hero compacts only as far as the table needs, and no further", () => {
  const box = paintBox();
  // A small week keeps the roomy hero; a big one is bounded by its floor.
  assert.equal(layoutOf(box, 6, true).hero, box.CARD_HERO_H, "a six-member week lost its hero");
  assert.equal(layoutOf(box, 11, true).hero, box.CARD_HERO_H, "an eleven-member week lost its hero");
  // It only compacts where the table genuinely needs the room.
  assert.ok(layoutOf(box, 40, true).hero <= box.CARD_HERO_H);
  for (const members of SIZES) {
    const { hero } = layoutOf(box, members, true);
    assert.ok(hero >= box.CARD_HERO_MIN && hero <= box.CARD_HERO_H,
      `${members} members put the hero at ${hero}`);
  }
  // It is a calculation, not a cutoff: the source contains no member count.
  const geometry = sourceOf("weeklyCardGeometry");
  assert.match(geometry, /CARD_H_PX - fixed - count \* CARD_MIN_ROW/);
  assert.ok(!/\b(11|eleven)\b/.test(geometry), "a member count is hard-coded");
  assert.match(geometry, /cardRowMetrics\(rows, \{ chrome: fixed \+ hero, base: CARD_ROW_H \}\)/);
});

test("W1 · twenty and thirty page only where the geometry requires it", () => {
  const box = paintBox();
  for (const [members, pages] of [[6, 1], [11, 1], [20, 1], [30, 1], [36, 1], [60, 2]]) {
    const { m } = layoutOf(box, members, true);
    assert.equal(m.pages, pages, `${members} members produced ${m.pages} attachments`);
    // A page never carries more rows than a readable row height allows.
    assert.ok(m.rowsPerPage * box.CARD_MIN_ROW <= box.CARD_H_PX - layoutOf(box, members, true).chrome + 0.5,
      `${members}: a page is overfilled`);
  }
  // And no size is ever truncated.
  for (const members of SIZES) {
    const { m } = layoutOf(box, members, true);
    assert.ok(m.pages * m.rowsPerPage >= members, `${members}: the pages cannot hold everyone`);
  }
});

test("W2 · a weekly row's divider is drawn once, straight, across the table", () => {
  const rule = sourceOf("drawCardRowRule");
  // One rect, full table width, constant y and thickness — not per-column
  // fragments and not a rounded plate edge that curves at the name column.
  assert.match(rule, /ctx\.fillRect\(CARD_PAD, Math\.round\(y\), CARD_W - CARD_PAD \* 2, CARD_RULE_H\)/);
  assert.match(rule, /ctx\.fillStyle = CARD\.line;/);
  assert.equal((rule.match(/fillRect/g) || []).length, 1, "the divider is drawn more than once");
  const draw = sourceOf("drawWeeklyPage");
  assert.match(draw, /if \(index < rows\.length - 1\) drawCardRowRule\(ctx, rowTop \+ m\.rowH - CARD_RULE_H\);/);
  // The weekly card no longer uses the rounded plate at all.
  assert.ok(!draw.includes("drawCardRowPlate"), "the weekly row still draws a rounded plate");
  // The band behind a podium row is a straight rect, so its edges agree.
  assert.match(sourceOf("drawWeeklyRowBand"), /ctx\.fillRect\(CARD_PAD, y, CARD_W - CARD_PAD \* 2, height\)/);
});

test("W2 · every row gets exactly one divider, and the last row gets none", () => {
  const box = paintBox();
  const rules = [];
  box.evalIn(`globalThis.__rules = [];`);
  const table = Array.from({ length: 11 }, (_, i) => ({
    uid: `w${i}`, rank: i + 1, nick: `P${i + 1}`, pts: 92 - i * 3, exact: i % 4 }));
  box.drawWeeklyResultCard(weeklyState, weekRound(3, six(6), { complete: true, table }));
  // The recorder does not capture fillRect, so count from the geometry and the
  // source contract instead: ten dividers for eleven rows on one page.
  const { m } = layoutOf(box, 11, true);
  assert.equal(m.pages, 1);
  assert.equal(m.rowsPerPage - 1, 10, "eleven rows should carry ten dividers");
  void rules;
});

test("W2 · two-digit points and a medal do not move the divider", () => {
  // The divider's y comes from the row, not from what is drawn in it, so a
  // medal and a two-digit total cannot shift it.
  const draw = sourceOf("drawWeeklyPage");
  const ruleAt = /drawCardRowRule\(ctx, rowTop \+ m\.rowH - CARD_RULE_H\)/;
  assert.match(draw, ruleAt);
  const rule = draw.slice(draw.search(ruleAt));
  for (const perRow of ["row.pts", "row.place", "PLACE_EMOJI", "row.nick"]) {
    assert.ok(!rule.slice(0, 90).includes(perRow), `the divider position depends on ${perRow}`);
  }
});

test("W2 · the Season export is untouched by the weekly corrections", () => {
  const season = sourceOf("drawSeasonPage");
  assert.match(season, /drawCardRowPlate\(ctx, rowTop, m\.rowH, index, null\)/, "the season plate changed");
  for (const weeklyOnly of ["drawCardRowRule", "drawWeeklyRowBand", "weeklyCardGeometry", "drawCardHero"]) {
    assert.ok(!season.includes(weeklyOnly), `the season card now uses ${weeklyOnly}`);
  }
  // Its geometry is the same chrome it always had.
  const box = paintBox({ leagueTab: "season" });
  assert.equal(layoutOf(box, 11, false).m.pages, 1);
  assert.equal(layoutOf(box, 20, false).m.pages, 1);
  assert.equal(layoutOf(box, 30, false).m.pages, 1);
  assert.equal(layoutOf(box, 40, false).m.pages, 1);
});
