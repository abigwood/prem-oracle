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
  const fills = [];
  const state = { font: "", fillStyle: "", textAlign: "left" };
  const ctx = new Proxy({
    fillText: (t, x, y) => marks.push({ text: String(t), x, y, font: state.font,
      fill: state.fillStyle, align: state.textAlign }),
    // Width follows the font actually set, the way a real canvas does. A flat
    // 12px a character makes every name look too long and every tally too wide.
    measureText: (t) => ({ width: String(t).length * (Number(/(\d+)px/.exec(state.font)?.[1] || 24) * 0.58) }),
    setTransform: () => {},
    // Recorded, not discarded: rules and bands are drawn with fillRect, and a
    // boundary the eye relies on has to be assertable.
    fillRect: (x, y, w, h) => fills.push({ x, y, w, h, fill: state.fillStyle }),
    save: () => {}, restore: () => {},
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
  return { canvas, ctx, marks, fills };
}

const NAMES = ["roundTableHtml", "seasonTableHtml", "medalLine", "weeklyMovementBadge", "movementBadge", "seasonMovement", "movementMark", "cardMovementText", "cardMovementWidth", "drawCardMovement", "slateIdsOf", "weeklyMovement", "settlementWindows", "windowPointsByUid", "seasonCardPages", "drawSeasonPage", "drawSeasonTableCard", "weeklyCardPages", "drawWeeklyPage", "drawWeeklyResultCard", "drawCardHeader", "drawCardHero", "drawCardTableHead", "drawCardCellSplit", "drawCardRowPlate", "drawWeeklyRowBand",
  "drawCardRowRule", "weeklyCardGeometry", "drawCardHonours", "drawCardFooter",
  "drawFitted", "fitText", "ellipsise", "roundedRect", "cardCanvas", "cardRowMetrics", "cardFont",
  "cardDate", "sentenceCase", "seasonCardModel",
  "weeklyCardModel", "weeklyCardCaption", "weeklyShareStatus", "weeklyTerminalCount",
  "shareSurface", "shareRound", "sharePeriod", "normaliseView", "LEGACY_VIEWS",
  "cardPageRows", "cardPageLabel", "cardTableTop", "CARD_MIN_NAME", "weeklySharePublished", "shareCardState", "seasonShareFreshness", "shareIconButton",
  "podiumCounts", "weeklyRanks", "sharedRankByUid", "winnerNames", "noteWeeklyFinalMismatch",
  "weeklyFinalMismatchLines", "finalScore", "isVoidFixture", "isPostponed", "VOID_STATUSES",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "cardHonoursParts", "CARD_HONOURS_SEP", "cardHonoursWidth", "cardHonoursSize", "CARD_MOVE_GAP", "CARD_MOVE_COLOUR", "CARD_SEASON_MAX_ROWS", "CARD_ROW_TWO_LINE", "CARD_TABLE_LEAD", 
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

// Mixed states across every table: unchanged, up one, up two, down two, down
// one — so no size is ever rendered with only one kind of marker. The cycle
// starts at zero so that no player's PREVIOUS rank comes out below first.
const seasonMove = (i) => ((i + 2) % 5) - 2;
const seasonTable = (n) => Array.from({ length: n }, (_, i) => ({
  uid: `u${i}`, rank: i + 1, nick: `Player ${i + 1}`, pts: 200 - i * 3, exact: i % 4,
  // Four shapes, cycling: no medals at all, one type only, two types, and all
  // three at two digits. Every rendered table therefore carries a row that
  // must show nothing and a row that must show everything.
  podiums: [{ gold: 0, silver: 0, bronze: 0 },
    { gold: 3, silver: 0, bronze: 0 },
    { gold: 0, silver: 2, bronze: 4 },
    { gold: 12, silver: 34, bronze: 56 }][i % 4],
  // The worker sends both, and they agree: movement IS previousRank - rank.
  movement: seasonMove(i),
  previousRank: i + 1 + seasonMove(i),
}));
/** The same table before any second window completed: no comparison exists. */
const seasonTableUnavailable = (n) => seasonTable(n)
  .map((row) => ({ ...row, movement: 0, previousRank: null }));
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
    // Compression, never truncation: every NON-ZERO count reaches the canvas.
    // A zero reaches nothing, because a medal nobody won is not a record.
    let withMedals = 0, withNone = 0;
    for (const row of model.rows) {
      if (box.cardHonoursParts(row.honours).length) withMedals++; else withNone++;
      for (const [emoji, key] of [["🏆", "gold"], ["🥈", "silver"], ["🥉", "bronze"]]) {
        const count = row.honours[key];
        if (count > 0) {
          assert.ok(drawn.includes(emoji + count),
            `${row.nick}: ${key}=${count} never reached the canvas`);
        } else {
          assert.ok(!drawn.includes(emoji + "0"), `${row.nick}: ${key}=0 was drawn anyway`);
        }
      }
    }
    assert.ok(withMedals > 0 && withNone > 0, "the fixture covers only one case");
  });
}

test("B · honours are on the row, whichever way the row is laid out", () => {
  const box = paintBox({ leagueTab: "season" });
  const chrome = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const opts = { chrome, base: box.CARD_SEASON_ROW_H, maxPerPage: box.CARD_SEASON_MAX_ROWS };
  const roomy = box.cardRowMetrics(8, opts);
  const tight = box.cardRowMetrics(30, opts);
  for (const members of [1, 6, 11, 20, 21, 30, 40, 60, 90, 200]) {
    const m = box.cardRowMetrics(members, opts);
    assert.ok(m.rowsPerPage <= box.CARD_SEASON_MAX_ROWS, `${members}: a page exceeded the cap`);
    assert.ok(m.honoursSize >= box.CARD_SECOND_FLOOR, `${members}: the tally fell below the floor`);
  }
  assert.ok(tight.honoursSize >= 13, "the compact tally is still a readable size");
  assert.ok(roomy.rowH >= tight.rowH, "a smaller table did not get roomier rows");
  // One line, one cell: the tally follows the name and shares its baseline.
  const box2 = paintBox({ leagueTab: "season" });
  const pages = box2.drawSeasonTableCard(seasonState(30)).length;
  const marks = box2.__made.slice(-pages).flatMap((made) => made.marks);
  const name = marks.find((m) => m.text === "Player 4");
  const tally = marks.find((m) => /^🏆\d+$/.test(m.text) && Math.abs(m.y - name.y) < 1);
  assert.ok(tally && name, "both the name and the tally are drawn");
  assert.equal(tally.y, name.y, "the tally left the name's line");
  assert.ok(tally.x > name.x, "the tally does not follow the name");
  assert.ok(tally.x < box2.CARD_COL.player, "the tally left the Player cell");
});

test("B · a member with no honours shows nothing, and reserves nothing", () => {
  const box = paintBox({ leagueTab: "season" });
  const bare = { code: "AAA", name: "Sunday Six", owner: "u1", currentMatchday: 8,
    currentMatchdayHasResults: true,
    table: [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1 }] };
  box.drawSeasonTableCard(bare);
  const drawn = texts(box);
  assert.ok(!drawn.some((t) => /[🏆🥈🥉]/u.test(t)),
    "an empty tally was drawn as noughts rather than omitted");
  assert.equal(box.cardHonoursParts({ gold: 0, silver: 0, bronze: 0 }).length, 0);
  const ctx = { font: "", measureText: (t) => ({ width: String(t).length * 12 }) };
  assert.equal(box.cardHonoursWidth(ctx, { gold: 0, silver: 0, bronze: 0 }, 24), 0,
    "an absent tally still reserved width");
  // And the name gets the space the tally would have taken: a medal-less row
  // is not indented to line up with rows that have one.
  const medalled = { ...bare,
    table: [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1,
      podiums: { gold: 12, silver: 34, bronze: 56 } }] };
  const box2 = paintBox({ leagueTab: "season" });
  box2.drawSeasonTableCard(medalled);
  const withTally = box2.__made.slice(-1)[0].marks.filter((m) => /^[🏆🥈🥉]\d+$/u.test(m.text));
  assert.equal(withTally.length, 3, "all three medal types must be shown");
  assert.deepEqual(withTally.map((m) => m.text), ["🏆12", "🥈34", "🥉56"],
    "two-digit counts were compressed away");
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
  const m = box.cardRowMetrics(members,
    { chrome, base: box.CARD_SEASON_ROW_H, maxPerPage: box.CARD_SEASON_MAX_ROWS });
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
  // The season table caps itself at twenty a page. The frame would take
  // forty-four; forty-four rows of a season table is not something read on a
  // phone, so the cap is the card's own limit rather than the frame's.
  assert.equal(layoutOf(box, 8, false).m.pages, 1, "the common season table");
  assert.equal(layoutOf(box, 11, false).m.pages, 1, "an eleven-member season");
  assert.equal(layoutOf(box, 20, false).m.pages, 1, "a twenty-member season");
  assert.equal(layoutOf(box, 21, false).m.pages, 2, "twenty-one members must split");
  assert.equal(layoutOf(box, 30, false).m.pages, 2, "a thirty-member season");
  assert.equal(layoutOf(box, 40, false).m.pages, 2, "a forty-member season");
  assert.equal(layoutOf(box, 60, false).m.pages, 3, "a sixty-member season");
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
  for (const members of [1, 11, 20, 21, 30, 40, 60]) {
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
  for (const members of [11, 20, 21, 30, 40, 60]) {
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

// --- Sol's portrait ruling: twenty a page, and every page a whole table -----

const SOL_SEASON = [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]];

test("sol · a season export pages at twenty, whatever the league's size", () => {
  const box = paintBox({ leagueTab: "season" });
  for (const [members, pages] of SOL_SEASON) {
    const { m } = layoutOf(box, members, false);
    assert.equal(m.pages, pages, `${members} members should be ${pages} attachment(s)`);
    assert.ok(m.rowsPerPage <= 20, `${members}: ${m.rowsPerPage} rows on a page`);
    // Balanced, not front-loaded: thirty is fifteen and fifteen, not twenty and ten.
    assert.equal(m.rowsPerPage, Math.ceil(members / pages), `${members}: pages are lopsided`);
  }
});

test("sol · every attachment is a complete, readable table in its own right", () => {
  for (const [members, pages] of SOL_SEASON) {
    const box = paintBox({ leagueTab: "season" });
    const state = seasonState(members);
    const model = box.seasonCardModel(state);
    const canvases = box.drawSeasonTableCard(state);
    assert.equal(canvases.length, pages, `${members}: wrong attachment count`);
    const made = box.__made.slice(-pages);

    // 1 · the whole membership, once each, in rank order, across the pages.
    const names = made.flatMap((page) => page.marks.map((mark) => mark.text))
      .filter((text) => /^Player \d+$/.test(text));
    assert.equal(names.length, members, `${members}: a member was lost or duplicated`);
    assert.deepEqual(names, model.rows.map((row) => row.nick), `${members}: the ranking moved`);

    made.forEach((page, index) => {
      const drawn = page.marks.map((mark) => mark.text);
      // 2 · no page carries more than twenty players.
      const onPage = drawn.filter((text) => /^Player \d+$/.test(text)).length;
      assert.ok(onPage <= 20, `${members}: page ${index + 1} carries ${onPage} rows`);
      assert.ok(onPage > 0, `${members}: page ${index + 1} is empty`);
      // 3 · identity, headings, page marker and branding, repeated on each.
      assert.ok(drawn.includes("Sunday Six"), `${members}/${index + 1}: no league identity`);
      for (const heading of ["PLAYER", "EXACT", "PTS"]) {
        assert.ok(drawn.includes(heading), `${members}/${index + 1}: no ${heading} heading`);
      }
      assert.ok(drawn.some((text) => /Prem Oracle/i.test(text)),
        `${members}/${index + 1}: no Prem Oracle branding`);
      if (pages > 1) {
        assert.ok(drawn.includes(`Page ${index + 1} of ${pages}`),
          `${members}/${index + 1}: no page marker`);
      }
      // 4 · every medalled row's tally sits inside the Player cell, beside the
      //     name, and every medal-less row shows none.
      const tallies = page.marks.filter((mark) => /^🏆\d+$/u.test(mark.text));
      const medalled = model.rows
        .filter((row) => box.cardHonoursParts(row.honours).some(([g]) => g === "🏆"))
        .filter((row) => drawn.includes(row.nick)).length;
      assert.equal(tallies.length, medalled,
        `${members}/${index + 1}: ${tallies.length} gold tallies for ${medalled} medalled rows`);
      for (const tally of tallies) {
        assert.ok(tally.x >= box.CARD_COL.name, `${members}: a tally sat left of the name`);
        assert.ok(tally.x < box.CARD_COL.player, `${members}: a tally left the Player cell`);
      }
      // 5 · nothing in the Player cell reaches across the rule at its edge.
      const playerSide = page.marks.filter((mark) => mark.align !== "right" && mark.align !== "center"
        && mark.x >= box.CARD_COL.name && /^(Player \d+|[🏆🥈🥉])/u.test(mark.text));
      for (const mark of playerSide) {
        const width = String(mark.text).length * (Number(/(\d+)px/.exec(mark.font)?.[1] || 24) * 0.58);
        assert.ok(mark.x + width <= box.CARD_COL.split,
          `${members}: "${mark.text}" runs into the scoring columns`);
      }
      // 6 · the boundary itself is drawn, once, spanning the table.
      const rules = page.fills.filter((fill) => fill.x === box.CARD_COL.split);
      assert.equal(rules.length, 1, `${members}/${index + 1}: the cell boundary is not drawn once`);
      assert.ok(rules[0].h > 100, `${members}/${index + 1}: the boundary does not span the table`);
    });

    // 7 · the final pixels hold both floors — no page is scaled down.
    const { m, k } = layoutOf(box, members, false);
    assert.equal(k, 1, `${members}: a page was scaled to fit`);
    assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR, `${members}: type floor`);
    assert.ok(Math.min(m.second, m.honoursSize) >= box.CARD_SECOND_FLOOR, `${members}: second floor`);
  }
});

test("sol · eleven members are not held apart from their own heading", () => {
  const box = paintBox({ leagueTab: "season" });
  // The table is biased up under its headings; the slack falls below it, as
  // margin above the footer, rather than opening a gap in the middle.
  assert.ok(box.CARD_TABLE_LEAD <= 48, "the lead is too generous to read as air");
  const after = box.CARD_HEAD_H + box.CARD_GAP;
  const { m } = layoutOf(box, 11, false);
  const top = box.cardTableTop(after, m.tableHeight, box.CARD_TABLE_LEAD);
  assert.ok(top - after <= box.CARD_TABLE_LEAD, "eleven members still float below their heading");
  // The cap is the season's alone. The weekly composition is accepted as it
  // stands, and it centres — pinning that down, because cardTableTop is shared
  // and a default-on cap silently moved four accepted weekly cards once.
  assert.ok(sourceOf("drawSeasonPage").includes("CARD_TABLE_LEAD"), "the season lost its lead cap");
  assert.ok(!sourceOf("drawWeeklyPage").includes("CARD_TABLE_LEAD"), "the cap leaked into the weekly card");
  assert.match(sourceOf("cardTableTop"), /lead = Infinity/, "the cap became the default");
  const weeklyAfter = box.CARD_HEAD_H + box.CARD_GAP + box.weeklyCardGeometry(6).hero + box.CARD_GAP;
  const weeklyTable = box.weeklyCardGeometry(6).m.tableHeight;
  const room = box.CARD_H_PX - box.CARD_FOOT_H - box.CARD_GAP - weeklyAfter;
  assert.equal(box.cardTableTop(weeklyAfter, weeklyTable),
    weeklyAfter + Math.max(0, (room - weeklyTable) / 2), "the weekly table stopped centring");
  // A full page is unaffected: it never had slack to give away.
  const full = layoutOf(box, 20, false).m;
  assert.ok(box.cardTableTop(after, full.tableHeight, box.CARD_TABLE_LEAD) - after <= box.CARD_TABLE_LEAD);
  // And the table still clears the footer.
  assert.ok(top + m.tableHeight <= box.CARD_H_PX - box.CARD_FOOT_H,
    "the table ran into the footer");
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

test("pages · a medal tally stays inside the Player cell, clear of EXACT", () => {
  const box = paintBox({ leagueTab: "season" });
  const chrome = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const cell = box.CARD_COL.player - box.CARD_COL.name;
  // Two-digit honours are a real season: thirty-eight weeks, three places.
  const counts = { gold: 12, silver: 34, bronze: 56 };
  const ctx = { font: "", measureText: (t) => ({ width: String(t).length * 12 }) };
  for (const members of [11, 20, 21, 30, 40, 60]) {
    const m = box.cardRowMetrics(members,
      { chrome, base: box.CARD_SEASON_ROW_H, maxPerPage: box.CARD_SEASON_MAX_ROWS });
    const size = box.cardHonoursSize(ctx, counts, m.honoursSize, cell);
    assert.ok(size >= box.CARD_SECOND_FLOOR, `${members}: the tally fell below the floor`);
    assert.ok(box.cardHonoursWidth(ctx, counts, size) <= cell,
      `${members}: the tally left the Player cell`);
  }
  // The cell ends before EXACT does, and a rule is drawn in between: the
  // heading cannot be read as owning the tally sitting to its left.
  assert.ok(box.CARD_COL.player < box.CARD_COL.split, "the cell has no boundary");
  assert.ok(box.CARD_COL.split < box.CARD_COL.exact, "the boundary is inside the exact column");
  const drawn = box.drawSeasonTableCard(seasonState(30));
  const fills = box.__made.slice(-drawn.length).flatMap((made) => made.fills || []);
  assert.ok(fills.some((f) => f.x === box.CARD_COL.split && f.h > 100),
    "no rule was drawn between the Player cell and the scoring columns");
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

test("pages · forty members hold every floor, across two portrait images", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = seasonState(40);
  const canvases = box.drawSeasonTableCard(state);
  assert.equal(canvases.length, 2, "forty members is two pages of twenty");
  const model = box.seasonCardModel(state);
  assert.equal(model.rows.length, 40);
  const drawn = box.__made.slice(-2).flatMap((made) => made.marks.map((mark) => mark.text));
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
  // Its geometry is the same chrome it always had, now under its own cap.
  const box = paintBox({ leagueTab: "season" });
  assert.equal(layoutOf(box, 11, false).m.pages, 1);
  assert.equal(layoutOf(box, 20, false).m.pages, 1);
  assert.equal(layoutOf(box, 30, false).m.pages, 2);
  assert.equal(layoutOf(box, 40, false).m.pages, 2);
  // And the cap is the season's alone: the accepted weekly capacities stand.
  assert.equal(layoutOf(box, 11, true).m.pages, 1, "the weekly eleven regressed");
  assert.equal(layoutOf(box, 20, true).m.pages, 1, "the weekly twenty regressed");
  assert.equal(layoutOf(box, 30, true).m.pages, 1, "the weekly thirty regressed");
  assert.equal(layoutOf(box, 40, true).m.pages, 2, "the weekly forty regressed");
  assert.ok(!sourceOf("weeklyCardPages").includes("maxPerPage"), "the cap leaked into the weekly card");
});

// --- movement markers on the exports (Adam's build-28 rider) ---------------
//
// The binding rule is rule 1: the card reuses the value the screen shows. So
// these tests build ONE snapshot and check both surfaces against it, rather
// than checking each surface against a number written out by hand here.

const T1 = "2026-09-12T14:00:00Z";
const T2 = "2026-09-13T14:00:00Z";

/**
 * Five players, two completed windows, and a snapshot carrying every marker
 * state at once. Only the second window's points are what the arrows measure.
 *
 * Before it:  Bex 10, Cal 8, Ann 4, Dot 2, Eve 1
 * It pays:    Ann 7, nobody else
 * After it:   Ann 11, Bex 10, Cal 8, Dot 2, Eve 1
 *
 * So Ann climbs two, Bex and Cal each drop one, and Dot and Eve hold — a
 * climb that stops short of the top is what leaves anyone standing still.
 */
const MOVERS = [
  { id: "m1", lockAt: T1, settled: true,
    picks: [{ uid: "a", pts: 4 }, { uid: "b", pts: 10 }, { uid: "c", pts: 8 },
            { uid: "d", pts: 2 }, { uid: "e", pts: 1 }] },
  { id: "m2", lockAt: T2, settled: true,
    picks: [{ uid: "a", pts: 7 }, { uid: "b", pts: 0 }, { uid: "c", pts: 0 },
            { uid: "d", pts: 0 }, { uid: "e", pts: 0 }] },
];
const MOVER_TABLE = [
  { uid: "a", nick: "Ann", pts: 11, exact: 3 },
  { uid: "b", nick: "Bex", pts: 10, exact: 2 },
  { uid: "c", nick: "Cal", pts: 8, exact: 1 },
  { uid: "d", nick: "Dot", pts: 2, exact: 0 },
  { uid: "e", nick: "Eve", pts: 1, exact: 0 },
];
const moverRound = (entries = MOVERS, table = MOVER_TABLE) =>
  weekRound(3, entries, { table });

/** Every mark the card drew, by the name it sits beside. */
function cardMarks(box, model, pages = 1) {
  const marks = box.__made.slice(-pages).flatMap((made) => made.marks);
  const byName = new Map();
  for (const row of model.rows) {
    const name = marks.find((mark) => mark.text === row.nick);
    const mark = marks.find((m) => /^[▲▼–]/.test(m.text)
      && Math.abs(m.y - (name?.y ?? -999)) < 1);
    byName.set(row.nick, mark || null);
  }
  return byName;
}

test("move · one snapshot produces up, down and unchanged on the weekly card", () => {
  const box = paintBox();
  const round = moverRound();
  const model = box.weeklyCardModel(weeklyState, round);
  const move = new Map(model.rows.map((row) => [row.nick, row.movement]));
  assert.equal(move.get("Ann"), 2, "the climb was not carried into the card");
  assert.equal(move.get("Bex"), -1);
  assert.equal(move.get("Cal"), -1);
  assert.equal(move.get("Dot"), 0, "a player who held position lost their marker");
  assert.equal(move.get("Eve"), 0);
  // And the card DRAWS all three kinds, with the magnitude visible.
  box.drawWeeklyResultCard(weeklyState, round);
  const drawn = cardMarks(box, model);
  assert.equal(drawn.get("Ann").text, "▲2", "an up marker must show its size");
  assert.equal(drawn.get("Bex").text, "▼1");
  assert.equal(drawn.get("Dot").text, "–", "no change carries no number");
});

test("move · direction is never carried by colour alone", () => {
  const box = paintBox();
  const round = moverRound();
  const model = box.weeklyCardModel(weeklyState, round);
  box.drawWeeklyResultCard(weeklyState, round);
  const drawn = cardMarks(box, model);
  // Strip every colour and the three states are still three different shapes.
  const glyphs = ["Ann", "Bex", "Dot"].map((n) => drawn.get(n).text[0]);
  assert.equal(new Set(glyphs).size, 3, "two states share a glyph");
  // Colour agrees with the glyph rather than replacing it.
  assert.equal(drawn.get("Ann").fill, box.CARD.rise);
  assert.equal(drawn.get("Bex").fill, box.CARD.fall);
  assert.equal(drawn.get("Dot").fill, box.CARD.muted);
  assert.notEqual(box.CARD.rise, box.CARD.fall);
  // The words exist too, for the surface that can speak them.
  assert.equal(box.movementMark(3).label, "Up 3 places");
  assert.equal(box.movementMark(1).label, "Up 1 place");
  assert.equal(box.movementMark(-1).label, "Down 1 place");
  assert.equal(box.movementMark(0).label, "No change");
});

test("move · before the first completed window there are no markers at all", () => {
  const box = paintBox();
  // Nothing settled: the window never completes, so there is nothing to
  // compare against and the card says nothing rather than a column of dashes.
  const round = moverRound([{ id: "m1", lockAt: T1, picks: MOVERS[0].picks }]);
  const model = box.weeklyCardModel(weeklyState, round);
  assert.ok(model.rows.every((row) => row.movement === null),
    "a card claimed movement before any window completed");
  box.drawWeeklyResultCard(weeklyState, round);
  const marks = box.__made.slice(-1).flatMap((made) => made.marks.map((m) => m.text));
  assert.ok(!marks.some((t) => /^[▲▼–]/.test(t)), "a marker was drawn anyway");
  // The same silence the screen keeps.
  assert.ok(!/movement-/.test(box.roundTableHtml(round)), "the screen drew one, so parity is wrong");
});

test("move · a not-started weekly card stays honest", () => {
  const box = paintBox();
  const round = weekRound(3, six(0), {
    table: [{ uid: "u1", nick: "Adam", pts: 0, exact: 0 }, { uid: "u2", nick: "Bex", pts: 0, exact: 0 }],
  });
  const model = box.weeklyCardModel(weeklyState, round);
  assert.equal(model.heroEyebrow, "NOT STARTED", "the accepted hero changed");
  assert.ok(model.rows.every((row) => row.movement === null), "a not-started week invented movement");
  box.drawWeeklyResultCard(weeklyState, round);
  assert.ok(!texts(box).some((t) => /^[▲▼–]/.test(t)), "a marker on a not-started card");
});

test("move · a void fixture pays nobody, and still completes its window", () => {
  const box = paintBox();
  // The last window holds one settled fixture and one void one. Void is
  // terminal, so the window completes; it pays nobody, so it moves nobody.
  const round = moverRound([
    MOVERS[0],
    { id: "m2", lockAt: T2, settled: true, picks: MOVERS[1].picks },
    { id: "m3", lockAt: T2, voided: true, picks: [{ uid: "b", pts: 99 }] },
  ]);
  const model = box.weeklyCardModel(weeklyState, round);
  const move = new Map(model.rows.map((row) => [row.nick, row.movement]));
  assert.equal(move.get("Ann"), 2, "the void fixture changed a settled answer");
  assert.equal(move.get("Bex"), -1, "a void fixture paid out 99 points");
});

test("move · a postponed fixture leaves its window and blocks nothing", () => {
  const box = paintBox({ fixtureById: (id) => (id === "m9" ? { id, status: "postponed" } : null) });
  const round = moverRound([...MOVERS,
    { id: "m9", lockAt: T2, picks: [{ uid: "d", pts: 40 }] }]);
  const model = box.weeklyCardModel(weeklyState, round);
  const move = new Map(model.rows.map((row) => [row.nick, row.movement]));
  // Unsettled, but postponed — so it does not hold the window open, and the
  // markers are exactly what they were without it.
  assert.equal(move.get("Ann"), 2, "a postponed fixture held the window open");
  assert.equal(move.get("Dot"), 0, "a postponed fixture paid out");
});

test("move · players who tie move together", () => {
  const box = paintBox();
  // Bex and Cal finish level on 10, so they share a rank and must share a
  // marker: one arrow up and one arrow down between tied players is a lie.
  const table = [
    { uid: "a", nick: "Ann", pts: 11, exact: 3 },
    { uid: "b", nick: "Bex", pts: 10, exact: 2 },
    { uid: "c", nick: "Cal", pts: 10, exact: 1 },
    { uid: "d", nick: "Dot", pts: 2, exact: 0 },
  ];
  const round = moverRound([
    { id: "m1", lockAt: T1, settled: true,
      picks: [{ uid: "a", pts: 4 }, { uid: "b", pts: 10 }, { uid: "c", pts: 10 }, { uid: "d", pts: 2 }] },
    { id: "m2", lockAt: T2, settled: true,
      picks: [{ uid: "a", pts: 7 }, { uid: "b", pts: 0 }, { uid: "c", pts: 0 }, { uid: "d", pts: 0 }] },
  ], table);
  const model = box.weeklyCardModel(weeklyState, round);
  const move = new Map(model.rows.map((row) => [row.nick, row.movement]));
  assert.equal(move.get("Bex"), move.get("Cal"), "tied players were given different markers");
  assert.equal(model.rows.find((r) => r.nick === "Bex").rank,
    model.rows.find((r) => r.nick === "Cal").rank, "tied players were given different ranks");
});

test("move · the screen and the export agree, row for row, from one snapshot", () => {
  const box = paintBox();
  const round = moverRound();
  // What the panel renders...
  const html = box.roundTableHtml(round);
  const onScreen = [...html.matchAll(/movement movement-(up|down|flat)[^>]*aria-label="([^"]+)"/g)]
    .map((m) => ({ dir: m[1], label: m[2] }));
  // ...against what the card model carries, through the shared meaning.
  const model = box.weeklyCardModel(weeklyState, round);
  const exported = model.rows.map((row) => {
    const mark = box.movementMark(row.movement);
    return { dir: mark.dir, label: mark.label };
  });
  assert.equal(onScreen.length, model.rows.length, "the surfaces show a different number of markers");
  assert.deepEqual(exported, onScreen, "the card disagrees with the table it was shared from");
  // And neither recalculates: both read the one function.
  assert.match(sourceOf("weeklyCardModel"), /weeklyMovement\(round\.table, round\.reveal, slateIdsOf\(round\)\)/);
  assert.match(sourceOf("roundTableHtml"), /weeklyMovement\(round\.table, round\.reveal, slateIds\)/);
  for (const fn of ["drawWeeklyPage", "drawSeasonPage", "weeklyCardModel", "seasonCardModel"]) {
    assert.ok(!/sharedRankByUid|settlementWindows|windowPointsByUid/.test(sourceOf(fn)),
      `${fn} works movement out for itself`);
  }
});

test("move · the season card takes the snapshot's own movement value", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = seasonState(11);
  const model = box.seasonCardModel(state);
  // Straight from the row the screen renders — not recomputed from points.
  for (const [index, row] of model.rows.entries()) {
    assert.equal(row.movement, state.table[index].movement,
      `${row.nick}: the card invented a movement value`);
    // The screen's badge, from the same row, agrees on direction.
    const badge = box.movementBadge(state.table[index]);
    assert.match(badge, new RegExp(`movement-${box.movementMark(row.movement).dir}`),
      `${row.nick}: the screen and the card disagree`);
  }
  assert.match(sourceOf("seasonCardModel"), /movement: seasonMovement\(row\)/);
});

test("move · markers appear on every page of a paged table, once per row", () => {
  for (const [members, pages] of [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]]) {
    const box = paintBox({ leagueTab: "season" });
    const state = seasonState(members);
    const model = box.seasonCardModel(state);
    const canvases = box.drawSeasonTableCard(state);
    assert.equal(canvases.length, pages, `${members}: pagination changed`);
    const made = box.__made.slice(-pages);
    let total = 0;
    made.forEach((page, index) => {
      const rows = page.marks.filter((m) => /^Player \d+$/.test(m.text)).length;
      const marks = page.marks.filter((m) => /^[▲▼–]/.test(m.text));
      assert.equal(marks.length, rows, `${members}/${index + 1}: ${marks.length} markers for ${rows} rows`);
      total += marks.length;
      // Every kind is present somewhere, so no page is a single-state page.
      // Every marker on its own column's axis, between the Player cell and
      // EXACT — that is what makes a page of them read as a column.
      for (const mark of marks) {
        assert.equal(mark.x, box.CARD_COL.move, `${members}: a marker left the MOVE column`);
        assert.equal(mark.align, "center", `${members}: a marker is not centred on its column`);
      }
    });
    assert.equal(total, members, `${members}: a member lost their marker across pages`);
  }
});

test("move · a marker is never mistaken for honours, Exact or Pts", () => {
  const box = paintBox({ leagueTab: "season" });
  const state = seasonState(20);
  const model = box.seasonCardModel(state);
  box.drawSeasonTableCard(state);
  const marks = box.__made.slice(-1)[0].marks;
  for (const row of model.rows) {
    const name = marks.find((m) => m.text === row.nick);
    const mark = marks.find((m) => /^[▲▼–]/.test(m.text) && Math.abs(m.y - name.y) < 1);
    assert.ok(mark, `${row.nick}: no marker drawn`);
    // Its own column: past the Player cell and its rule, short of EXACT, on
    // the same axis for every row whatever the magnitude.
    assert.equal(mark.x, box.CARD_COL.move, `${row.nick}: the marker left the MOVE column`);
    // Shares the row's baseline with the name and the scores, so the row
    // reads straight across rather than stepping up and down.
    assert.equal(mark.y, name.y, `${row.nick}: the marker left the row's line`);
    // A tally, where the row has one, stays behind in the Player cell.
    const tally = marks.find((m) => /^🏆\d+$/u.test(m.text) && Math.abs(m.y - name.y) < 1);
    if (tally) assert.ok(tally.x < box.CARD_COL.split, `${row.nick}: the tally left the cell`);
  }
  assert.ok(box.CARD_COL.split < box.CARD_COL.move, "MOVE is inside the Player cell");
  assert.ok(box.CARD_COL.move < box.CARD_COL.exact, "MOVE is not before EXACT");
  // The column order is PLAYER | MOVE | EXACT | PTS, and the headings say so.
  const headings = marks.filter((m) => ["PLAYER", "MOVE", "EXACT", "PTS"].includes(m.text));
  assert.deepEqual(headings.map((h) => h.text), ["PLAYER", "MOVE", "EXACT", "PTS"],
    "the headings are missing or out of order");
  assert.deepEqual(headings.map((h) => h.x),
    [box.CARD_COL.name, box.CARD_COL.move, box.CARD_COL.exact, box.CARD_COL.pts]);
  assert.equal(headings[1].align, "center", "the MOVE heading is not over its column");
  assert.ok(headings.every((h) => h.y === headings[0].y), "the headings are not on one line");
});

test("move · nothing accepted moved to make room for the markers", () => {
  const box = paintBox({ leagueTab: "season" });
  // Capacities, pagination and floors are all unchanged by the rider.
  for (const [members, pages] of [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]]) {
    const { m, k } = layoutOf(box, members, false);
    assert.equal(m.pages, pages, `${members}: season pagination moved`);
    assert.ok(m.rowsPerPage <= box.CARD_SEASON_MAX_ROWS, `${members}: the cap moved`);
    assert.equal(k, 1, `${members}: a page is being scaled`);
    assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR, `${members}: type floor`);
    assert.ok(Math.min(m.second, m.honoursSize) >= box.CARD_SECOND_FLOOR, `${members}: second floor`);
  }
  for (const [members, pages] of [[6, 1], [11, 1], [20, 1], [30, 1], [40, 2]]) {
    assert.equal(layoutOf(box, members, true).m.pages, pages, `${members}: weekly pagination moved`);
  }
  // The marker is a secondary figure and holds the secondary floor.
  const { m } = layoutOf(box, 20, false);
  assert.ok(m.second >= box.CARD_SECOND_FLOOR, "the marker fell below the secondary floor");
});

// --- unavailable is not zero (Adam's final semantic correction) ------------
//
// Two different facts that used to render identically: "nobody has measured
// this yet" and "this player held their position". The worker has always told
// them apart — `previousRank` is null until a second window completes — and
// both surfaces now read that same field.

/** The badge each row shows on screen, by name, or "" for no badge at all. */
function screenBadges(box, table) {
  const html = box.seasonTableHtml({ code: "AAA", name: "Sunday Six", owner: "u1", table },
    false, true);
  return table.map((row) => {
    const cell = html.slice(html.indexOf(`. ${row.nick}<`));
    const badge = /<span class="movement movement-(\w+)"[^>]*aria-label="([^"]+)"[^>]*>([^<]*)<\/span>/
      .exec(cell.slice(0, cell.indexOf("</tr>")));
    return badge ? { dir: badge[1], label: badge[2], glyph: badge[3] } : null;
  });
}

/** The marker each row shows on the export, by name, or null for none. */
function exportMarkers(box, table) {
  const state = { code: "AAA", name: "Sunday Six", owner: "u1", table,
    currentMatchday: 8, currentMatchdayHasResults: true };
  const model = box.seasonCardModel(state);
  const pages = box.drawSeasonTableCard(state).length;
  // Page by page, not flattened: two pages put different players at the same
  // y, so a flattened search hands row five of page one the marker belonging
  // to row five of page two.
  const made = box.__made.slice(-pages);
  return model.rows.map((row) => {
    const page = made.find((m) => m.marks.some((mark) => mark.text === row.nick));
    const name = page.marks.find((m) => m.text === row.nick);
    const mark = page.marks.find((m) => /^[▲▼–]/.test(m.text) && Math.abs(m.y - name.y) < 1);
    return mark ? { text: mark.text, fill: mark.fill, value: row.movement } : null;
  });
}

test("unavailable · 1 · no comparison yet means nothing, on screen and on the card", () => {
  const box = paintBox({ leagueTab: "season" });
  const table = seasonTableUnavailable(11);
  // The screen draws no badge — not an empty disc holding a place.
  assert.deepEqual(screenBadges(box, table), Array(11).fill(null),
    "the screen reserved a badge for a comparison that does not exist");
  const html = box.seasonTableHtml({ code: "AAA", name: "S", owner: "u1", table }, false, true);
  assert.ok(!html.includes("movement-flat"), "an unmeasured row was given a dash");
  assert.ok(!html.includes('class="movement'), "an empty badge was still rendered");
  // And the export says exactly as much.
  assert.deepEqual(exportMarkers(box, table), Array(11).fill(null),
    "the card drew a marker with nothing to compare against");
  const model = box.seasonCardModel({ code: "AAA", name: "S", owner: "u1", table,
    currentMatchday: 8, currentMatchdayHasResults: true });
  assert.ok(model.rows.every((row) => row.movement === null));
});

test("unavailable · 2 · a real comparison worth zero is a dash on both", () => {
  const box = paintBox({ leagueTab: "season" });
  // previousRank present and equal to rank: measured, and the player held.
  const table = seasonTable(6).map((row) => ({ ...row, movement: 0, previousRank: row.rank }));
  const screen = screenBadges(box, table);
  assert.ok(screen.every((badge) => badge && badge.dir === "flat"),
    "a measured hold lost its dash on screen");
  assert.ok(screen.every((badge) => badge.label === "No change"));
  const drawn = exportMarkers(box, table);
  assert.ok(drawn.every((mark) => mark && mark.text === "–"), "a measured hold lost its dash on the card");
  assert.ok(drawn.every((mark) => mark.value === 0), "a dash was drawn for a non-zero value");
  assert.ok(drawn.every((mark) => mark.fill === box.CARD.muted), "the neutral marker is not neutral");
  // The two facts are distinguishable, which is the whole point.
  assert.notDeepEqual(screenBadges(box, seasonTableUnavailable(6)), screen);
});

test("unavailable · 3 · up and down match, glyph for glyph, across both", () => {
  const box = paintBox({ leagueTab: "season" });
  const table = seasonTable(11);
  const screen = screenBadges(box, table);
  const drawn = exportMarkers(box, table);
  table.forEach((row, i) => {
    const mark = box.movementMark(row.movement);
    assert.ok(screen[i], `${row.nick}: no badge on screen`);
    assert.equal(screen[i].dir, mark.dir, `${row.nick}: the screen shows a different direction`);
    assert.equal(screen[i].glyph, mark.glyph, `${row.nick}: the screen shows a different glyph`);
    assert.equal(drawn[i].text[0], mark.glyph, `${row.nick}: the card shows a different glyph`);
    // Magnitude is visible on the card, and spoken on the screen.
    if (mark.magnitude) {
      assert.equal(drawn[i].text, mark.glyph + mark.magnitude, `${row.nick}: no magnitude`);
      assert.match(screen[i].label, new RegExp(`${mark.magnitude} place`), `${row.nick}: no magnitude spoken`);
    }
    assert.equal(drawn[i].fill,
      box.CARD[{ up: "rise", down: "fall", flat: "muted" }[mark.dir]], `${row.nick}: wrong colour`);
  });
  // Every state is present, so this is not three tests of one case.
  assert.equal(new Set(screen.map((b) => b.dir)).size, 3, "the fixture does not cover all three states");
});

test("unavailable · 4 · mixed and multi-page season tables agree row for row", () => {
  for (const [members, pages] of [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]]) {
    const box = paintBox({ leagueTab: "season" });
    // A mixture on purpose: most rows measured, every fifth with no comparison.
    const table = seasonTable(members)
      .map((row, i) => (i % 5 === 4 ? { ...row, movement: 0, previousRank: null } : row));
    const screen = screenBadges(box, table);
    const drawn = exportMarkers(box, table);
    assert.equal(drawn.length, members, `${members}: a row lost its place`);
    const state = { code: "AAA", name: "Sunday Six", owner: "u1", table,
      currentMatchday: 8, currentMatchdayHasResults: true };
    assert.equal(box.drawSeasonTableCard(state).length, pages, `${members}: pagination moved`);
    table.forEach((row, i) => {
      const value = box.seasonMovement(row);
      if (value == null) {
        assert.equal(screen[i], null, `${members}/${row.nick}: screen marked an unmeasured row`);
        assert.equal(drawn[i], null, `${members}/${row.nick}: card marked an unmeasured row`);
        return;
      }
      const mark = box.movementMark(value);
      assert.equal(screen[i].dir, mark.dir, `${members}/${row.nick}: screen`);
      assert.equal(drawn[i].text[0], mark.glyph, `${members}/${row.nick}: card`);
    });
    // Both surfaces suppressed exactly the same rows, and some but not all.
    const blankScreen = screen.filter((b) => b === null).length;
    const blankCard = drawn.filter((m) => m === null).length;
    assert.equal(blankScreen, blankCard, `${members}: the surfaces suppressed different rows`);
    assert.ok(blankCard > 0 && blankCard < members, `${members}: the fixture is not mixed`);
  }
});

test("unavailable · 5 · nothing else moved: layout, paging, floors, or words", () => {
  const box = paintBox({ leagueTab: "season" });
  for (const [members, pages] of [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]]) {
    const { m, k } = layoutOf(box, members, false);
    assert.equal(m.pages, pages, `${members}: pagination moved`);
    assert.ok(m.rowsPerPage <= box.CARD_SEASON_MAX_ROWS, `${members}: the cap moved`);
    assert.equal(k, 1, `${members}: a page is being scaled`);
    assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR, `${members}: type floor`);
    assert.ok(Math.min(m.second, m.honoursSize) >= box.CARD_SECOND_FLOOR, `${members}: second floor`);
  }
  // The season table keeps its columns whether or not any badge is rendered.
  const empty = box.seasonTableHtml({ code: "AAA", name: "S", owner: "u1",
    table: seasonTableUnavailable(4) }, false, true);
  const full = box.seasonTableHtml({ code: "AAA", name: "S", owner: "u1",
    table: seasonTable(4) }, false, true);
  const cells = (html) => (html.match(/<td/g) || []).length;
  assert.equal(cells(empty), cells(full), "a suppressed badge took its column with it");
  // Accessibility: every rendered badge still names itself in words.
  for (const badge of screenBadges(box, seasonTable(11))) {
    assert.ok(badge.label && /^(Up|Down|No change)/.test(badge.label), `bad label: ${badge.label}`);
  }
  // The weekly card is untouched by a season-only correction.
  assert.ok(!sourceOf("weeklyCardModel").includes("seasonMovement"), "the weekly model changed");
  assert.match(sourceOf("weeklyCardModel"), /movement\.has\(row\.uid\)/, "the weekly rule changed");
});

// --- the MOVE column and the compact tally (build-29 rider) ----------------

const HONOUR_SHAPES = [
  ["no medals at all", { gold: 0, silver: 0, bronze: 0 }, []],
  ["one type only", { gold: 3, silver: 0, bronze: 0 }, ["🏆3"]],
  ["two types", { gold: 0, silver: 2, bronze: 4 }, ["🥈2", "🥉4"]],
  ["all three, two digits", { gold: 12, silver: 34, bronze: 56 }, ["🏆12", "🥈34", "🥉56"]],
];

const seasonOf = (table) => ({ code: "AAA", name: "Sunday Six", owner: "u1", table,
  currentMatchday: 8, currentMatchdayHasResults: true });

test("cols · the export reads PLAYER | MOVE | EXACT | PTS, in that order", () => {
  for (const weekly of [false, true]) {
    const box = paintBox({ leagueTab: weekly ? "matchday" : "season" });
    if (weekly) box.drawWeeklyResultCard(weeklyState, moverRound());
    else box.drawSeasonTableCard(seasonState(11));
    const marks = box.__made.slice(-1)[0].marks;
    const headings = marks.filter((m) => ["PLAYER", "MOVE", "EXACT", "PTS"].includes(m.text));
    assert.deepEqual(headings.map((h) => h.text), ["PLAYER", "MOVE", "EXACT", "PTS"],
      `${weekly ? "weekly" : "season"}: wrong headings or order`);
    // Left to right, strictly increasing, with MOVE immediately before EXACT.
    const xs = [box.CARD_COL.name, box.CARD_COL.move, box.CARD_COL.exact, box.CARD_COL.pts];
    assert.deepEqual(headings.map((h) => h.x), xs);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, "the columns are out of order");
    assert.ok(box.CARD_COL.player < box.CARD_COL.move, "MOVE is still inside the Player cell");
    assert.ok(box.CARD_COL.split > box.CARD_COL.player && box.CARD_COL.split < box.CARD_COL.move,
      "the rule is not between PLAYER and MOVE");
    // Every marker on the column's axis, whatever its magnitude.
    const markers = marks.filter((m) => /^[▲▼–]/.test(m.text));
    assert.ok(markers.length > 0, "no markers drawn");
    for (const marker of markers) {
      assert.equal(marker.x, box.CARD_COL.move, "a marker left the MOVE column");
      assert.equal(marker.align, "center");
    }
  }
});

test("cols · both exports place the MOVE column identically", () => {
  const season = paintBox({ leagueTab: "season" });
  season.drawSeasonTableCard(seasonState(11));
  const weekly = paintBox();
  weekly.drawWeeklyResultCard(weeklyState, moverRound());
  const moveX = (box) => box.__made.slice(-1)[0].marks
    .filter((m) => /^[▲▼–]/.test(m.text)).map((m) => m.x);
  const seasonXs = moveX(season), weeklyXs = moveX(weekly);
  assert.ok(seasonXs.length && weeklyXs.length, "one of the cards drew no markers");
  assert.deepEqual(new Set([...seasonXs, ...weeklyXs]), new Set([season.CARD_COL.move]),
    "the two exports put the marker in different places");
});

for (const [label, counts, expected] of HONOUR_SHAPES) {
  test(`tally · ${label}`, () => {
    const box = paintBox({ leagueTab: "season" });
    const table = [{ uid: "u1", rank: 1, nick: "Adam", pts: 12, exact: 1,
      podiums: counts, movement: 0, previousRank: 1 }];
    box.drawSeasonTableCard(seasonOf(table));
    const marks = box.__made.slice(-1)[0].marks;
    const name = marks.find((m) => m.text === "Adam");
    const parts = marks.filter((m) => /^[🏆🥈🥉]\d+$/u.test(m.text)).map((m) => m.text);
    // Only non-zero counts, in medal order, complete and uncompressed.
    assert.deepEqual(parts, expected, `${label}: wrong tally`);
    // Nothing at all when there is nothing to show — no empty glyphs.
    if (!expected.length) {
      assert.ok(!marks.some((m) => /[🏆🥈🥉]/u.test(m.text)), "an empty glyph was drawn");
    }
    // Same line as the name, after it, inside the Player cell.
    for (const part of marks.filter((m) => /^[🏆🥈🥉]\d+$/u.test(m.text))) {
      assert.equal(part.y, name.y, `${label}: the tally left the name's line`);
      assert.ok(part.x > name.x, `${label}: the tally is not after the name`);
      assert.ok(part.x < box.CARD_COL.player, `${label}: the tally left the Player cell`);
      assert.ok(part.x < box.CARD_COL.move, `${label}: the tally reached the MOVE column`);
    }
  });
}

test("tally · the tally is reserved first; an over-long name takes the ellipsis", () => {
  const box = paintBox({ leagueTab: "season" });
  const long = "Bartholomew Fotheringay-Chumleigh";
  const table = [
    { uid: "u1", rank: 1, nick: long, pts: 12, exact: 1,
      podiums: { gold: 12, silver: 34, bronze: 56 }, movement: 0, previousRank: 1 },
    { uid: "u2", rank: 2, nick: long, pts: 9, exact: 0,
      podiums: { gold: 0, silver: 0, bronze: 0 }, movement: 0, previousRank: 2 },
  ];
  box.drawSeasonTableCard(seasonOf(table));
  const marks = box.__made.slice(-1)[0].marks;
  const parts = marks.filter((m) => /^[🏆🥈🥉]\d+$/u.test(m.text)).map((m) => m.text);
  // Compression only, never truncation: all three survive the long name.
  assert.deepEqual(parts, ["🏆12", "🥈34", "🥉56"], "a medal was dropped to fit a name");
  // The name is what gave way, and it says so with an ellipsis.
  const names = marks.filter((m) => m.text.startsWith("Bart"));
  assert.equal(names.length, 2, "both rows should have drawn a name");
  assert.ok(names[0].text.endsWith("…"), `the medalled name was not ellipsised: ${names[0].text}`);
  assert.ok(names[0].text.length < long.length, "the name was not shortened at all");
  // The medal-less row keeps more of its name: nothing is reserved for a
  // tally that does not exist.
  assert.ok(names[1].text.length > names[0].text.length,
    "a row with no medals lost the same space as one with three");
  // Nothing wraps: one mark per name, one line per row.
  assert.equal(new Set(marks.filter((m) => m.text.startsWith("Bart")).map((m) => m.y)).size, 2,
    "a name was drawn on more than one line");
});

test("tally · names stay dominant, and the tally stays legible", () => {
  const box = paintBox({ leagueTab: "season" });
  const chrome = box.CARD_HEAD_H + box.CARD_GAP + box.CARD_TABLE_HEAD_H + box.CARD_GAP + box.CARD_FOOT_H;
  const opts = { chrome, base: box.CARD_SEASON_ROW_H, maxPerPage: box.CARD_SEASON_MAX_ROWS };
  for (const members of [11, 20, 21, 30, 40, 60]) {
    const m = box.cardRowMetrics(members, opts);
    assert.ok(m.honoursSize <= m.name, `${members}: the tally is not smaller than the name`);
    assert.ok(m.honoursSize >= box.CARD_SECOND_FLOOR, `${members}: the tally fell below the floor`);
    assert.ok(m.name >= box.CARD_TYPE_FLOOR, `${members}: the name fell below the floor`);
  }
  // Even squeezed to its floor the tally keeps every medal it was given.
  const ctx = { font: "", measureText: (t) => ({ width: String(t).length * 12 }) };
  const counts = { gold: 12, silver: 34, bronze: 56 };
  const size = box.cardHonoursSize(ctx, counts, 24, 40);
  assert.equal(size, box.CARD_SECOND_FLOOR, "the tally did not shrink to its floor");
  assert.equal(box.cardHonoursParts(counts).length, 3, "a medal was dropped under pressure");
});

test("cols · the accepted portrait guarantees are all still true", () => {
  const box = paintBox({ leagueTab: "season" });
  for (const [members, pages] of [[11, 1], [20, 1], [21, 2], [30, 2], [40, 2], [60, 3]]) {
    const { m, k } = layoutOf(box, members, false);
    assert.equal(m.pages, pages, `${members}: season pagination moved`);
    assert.ok(m.rowsPerPage <= box.CARD_SEASON_MAX_ROWS, `${members}: the 20-row cap moved`);
    assert.equal(k, 1, `${members}: a page is being scaled`);
    assert.ok(Math.min(m.name, m.number, m.points) >= box.CARD_TYPE_FLOOR, `${members}: type floor`);
    assert.ok(Math.min(m.second, m.honoursSize) >= box.CARD_SECOND_FLOOR, `${members}: second floor`);
  }
  for (const [members, pages] of [[6, 1], [11, 1], [20, 1], [30, 1], [40, 2]]) {
    assert.equal(layoutOf(box, members, true).m.pages, pages, `${members}: weekly pagination moved`);
  }
  for (const members of [11, 20, 30]) {
    for (const [weekly, draw] of [[false, () => box.drawSeasonTableCard(seasonState(members))],
      [true, () => box.drawWeeklyResultCard(weeklyState, moverRound(MOVERS, MOVER_TABLE))]]) {
      void weekly;
      for (const canvas of draw()) {
        assert.equal(canvas.width, 1080);
        assert.equal(canvas.height, 1920);
      }
    }
  }
  // Season rows stay rounded plates; weekly rows stay banded with one rule.
  assert.match(sourceOf("drawSeasonPage"), /drawCardRowPlate\(ctx, rowTop, m\.rowH, index, null\)/);
  assert.ok(!sourceOf("drawSeasonPage").includes("drawCardRowRule"), "the season card grew dividers");
  assert.match(sourceOf("drawWeeklyPage"), /drawCardRowRule\(ctx, rowTop \+ m\.rowH - CARD_RULE_H\)/);
  assert.ok(!sourceOf("drawWeeklyPage").includes("drawCardHonours"), "the weekly card grew a tally");
});

test("cols · the on-screen tables are untouched by an export-only change", () => {
  // The screen keeps its own three-column shape and its own badge markup.
  const screen = sourceOf("seasonTableHtml");
  assert.ok(!screen.includes("MOVE"), "the screen grew a MOVE column");
  assert.match(screen, /<th>Player<\/th><th><\/th><th>Pts<\/th><th>Exact<\/th>/);
  assert.match(screen, /\$\{movementBadge\(row\)\}/, "the screen's badge changed");
  assert.match(sourceOf("medalLine"), /class="medals"/, "the screen's medal line changed");
  // The screen still shows a zero medal, muted — only the CARD suppresses.
  assert.match(sourceOf("medalLine"), /is-none/, "the screen stopped showing zero medals");
  const box = paintBox({ leagueTab: "season" });
  const html = box.seasonTableHtml(seasonOf(seasonTable(4)), false, true);
  assert.ok(html.includes("🏆 0") || html.includes("🥈 0") || html.includes("🥉 0"),
    "the screen's zero medals disappeared with the card's");
});
