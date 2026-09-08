// v1.7 · Sol item E — pixel evidence from a REAL browser canvas.
//
// The Node tests draw through a recording stub: they prove which calls the card
// makes, not what a person receives. This renders the same functions in
// headless Chrome — already on this machine, so nothing new is installed and
// nothing new ships — reads the rasterised pixels back with getImageData, and
// writes the PNGs the browser itself encoded.
//
//   node evidence_pixels.mjs
//
// Writes evidence-pixels/*.png and prints a pass/fail line per check.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { APP, sourceOf, constOf } from "./test/harness.mjs";

const OUT = join(process.cwd(), "evidence-pixels");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const FUNCTIONS = ["roundedRect", "fitText", "ellipsise", "drawFitted", "cardCanvas",
  "drawCardHeader", "drawCardHero", "drawCardTableHead", "drawCardRowPlate",
  "drawCardHonours", "cardHonoursWidth", "cardHonoursFit", "drawCardFooter",
  "cardRowMetrics", "weeklyCardGeometry", "drawWeeklyRowBand", "drawCardRowRule",
  "seasonCardModel", "weeklyCardModel",
  "weeklyShareStatus", "weeklyTerminalCount", "weeklySharePublished", "podiumCounts",
  "sharedRankByUid", "winnerNames", "seasonShareFreshness", "drawSeasonTableCard",
  "drawWeeklyResultCard", "finalScore", "weeklyCardCaption", "noteWeeklyFinalMismatch"];
const CONSTS = ["CARD_W", "CARD_SIDE", "CARD_PAD", "CARD", "CARD_COL",
  "CARD_HEAD_H", "CARD_HERO_H", "CARD_TABLE_HEAD_H", "CARD_ROW_H", "CARD_SEASON_ROW_H",
  "CARD_FOOT_H", "CARD_GAP", "cardFont", "cardDate",
  "sentenceCase", "weeklyRanks", "VOID_STATUSES", "isVoidFixture", "isPostponed",
  "CARD_TYPE_FLOOR", "CARD_SECOND_FLOOR", "CARD_MIN_ROW", "CARD_MIN_NAME",
  "CARD_HERO_MIN", "CARD_RULE_H",
  "cardPageRows", "cardPageLabel",
  "PLACE_NUMBER", "PLACE_EMOJI"];

const lifted = [
  ...CONSTS.map((n) => [APP.indexOf(`const ${n} =`), constOf(n)]),
  ...FUNCTIONS.map((n) => [APP.indexOf(`function ${n}(`), sourceOf(n)]),
].sort((a, b) => a[0] - b[0]).map(([, src]) => src).join("\n\n");

// The handful of app globals a card reaches for, and nothing else. Anything the
// cards actually compute is lifted above, not reimplemented here.
const STUBS = `
const fixtures = [];
const fixtureById = (id) => fixtures.find((f) => String(f.id) === String(id)) || null;
const weeklyFinalMismatches = new Map();
const periodLabel = (p) => "Matchweek " + p;
const inviteLinkFor = (code) => "https://premoracle.app/j/" + code;
const leagueCompetitionNames = () => "Premier League";
const seasonRounds = () => 38;
`;

const SCENES = `
const slate = (n, ids) => ({ period: String(n), status: "published", fixtureIds: ids, count: ids.length });
const six = (settled, voided) => Array.from({ length: 6 }, (_, i) => ({
  id: "w-" + i,
  ...(i < settled ? { settled: true } : i < settled + (voided || 0) ? { voided: true } : {}),
}));
let HEAVY = false;
const league = { code: "CGALPR", name: "Sunday Six", owner: "u1" };
const week = (n, entries, over) => ({
  code: "CGALPR", matchday: n, period: String(n), complete: false,
  slate: slate(n, entries.map((e) => e.id)), reveal: entries, podium: [],
  table: [], ...over,
});
const players = (n) => Array.from({ length: n }, (_, i) => ({
  uid: "u" + i, rank: i + 1, nick: ["Adam","Bex","Cal","Dev","Eli","Fay","Gus","Hal","Ivy","Jo",
    "Kit","Lou","Mac","Nia","Oz","Pip","Quin","Rae","Sol","Tam","Uma","Vic","Wes","Xan","Yaz",
    "Zed","Ash","Bo","Cleo","Dax","Eve","Finn","Gil","Hux","Iris","Jax","Kaya","Loz","Moss",
    "Nell"][i] || ("Player " + (i + 1)),
  pts: 92 - i * 3, exact: (i * 2) % 5,
  podiums: HEAVY
    ? { gold: 12 - (i % 3), silver: 10 + (i % 4), bronze: 11 + (i % 2) }
    : { gold: i % 3, silver: (i + 1) % 3, bronze: (i + 2) % 3 },
}));
const seasonState = (n) => ({ ...league, table: players(n), currentMatchday: 8, currentMatchdayHasResults: true });
const FINAL = (n) => ({ complete: true, table: players(n),
  podium: [{ uid: "u0", place: "gold", nick: "Adam", pts: 92 },
           { uid: "u1", place: "silver", nick: "Bex", pts: 89 },
           { uid: "u2", place: "bronze", nick: "Cal", pts: 86 }] });

const SCENE = {
  "weekly-not-started": () => drawWeeklyResultCard(league,
    week(3, six(0), { table: players(6).map((p) => ({ ...p, pts: 0, exact: 0 })) })),
  "weekly-in-progress-with-void": () => drawWeeklyResultCard(league,
    week(3, six(2, 1), { table: players(6) })),
  "weekly-final-6": () => drawWeeklyResultCard(league, week(3, six(5, 1), FINAL(6))),
  "weekly-final-11": () => drawWeeklyResultCard(league, week(3, six(5, 1), FINAL(11))),
  "weekly-final-20": () => drawWeeklyResultCard(league, week(3, six(5, 1), FINAL(20))),
  "weekly-final-30": () => drawWeeklyResultCard(league, week(3, six(5, 1), FINAL(30))),
  "season-1": () => drawSeasonTableCard(seasonState(1)),
  "season-11": () => drawSeasonTableCard(seasonState(11)),
  "season-20": () => drawSeasonTableCard(seasonState(20)),
  "season-30": () => drawSeasonTableCard(seasonState(30)),
  "season-40": () => drawSeasonTableCard(seasonState(40)),
  "season-30-two-digit-honours": () => {
    HEAVY = true;
    const canvases = drawSeasonTableCard(seasonState(30));
    HEAVY = false;
    return canvases;
  },
};
const FINAL_MEMBERS = { "weekly-final-6": 6, "weekly-final-11": 11, "weekly-final-20": 20,
  "weekly-final-30": 30 };
const WEEKLY_MEMBERS = { "weekly-not-started": 6, "weekly-in-progress-with-void": 6,
  "weekly-final-6": 6, "weekly-final-11": 11, "weekly-final-20": 20, "weekly-final-30": 30 };
const SEASON_MEMBERS = { "season-1": 1, "season-11": 11, "season-20": 20, "season-30": 30,
  "season-40": 40, "season-30-two-digit-honours": 30 };
const HEAVY_SCENES = new Set(["season-30-two-digit-honours"]);
`;

// --- what the pixels have to say --------------------------------------------
const CHECKS = `
const hsv = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max / 255 };
};

/** Everything drawn, as a bounding box, against the flat card background. */
function inkBox(data, w, h, bg) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 8) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The bounding box of TYPE — the near-white and lavender pixels the card sets
 * its words in. Bands and rules are brand purple or green and full-bleed by
 * design; a letter touching an edge is the thing worth failing over.
 */
function typeBox(data, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // White, silver and the lavender used for muted labels: bright and unsaturated.
    if (!(lum > 130 && (max ? (max - min) / max : 0) < 0.35)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Every pixel line in a band that carries ink over the grounds it is drawn on. */
function inkLines(ctx, x, y, w, h, grounds) {
  const d = ctx.getImageData(x, y, w, h).data;
  const isGround = (i) => grounds.some((c) =>
    Math.abs(d[i] - c[0]) <= 10 && Math.abs(d[i + 1] - c[1]) <= 10 && Math.abs(d[i + 2] - c[2]) <= 10);
  let first = null, last = null;
  for (let row = 0; row < h; row++) {
    const base = row * w * 4;
    for (let col = 0; col < w; col++) {
      if (isGround(base + col * 4)) continue;
      if (first === null) first = row;
      last = row;
      break;
    }
  }
  return { first, last };
}

/** The colour a single pixel is, as a triple. */
const pixelAt = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);

/** Is this rectangle a single flat colour — i.e. was nothing drawn in it? */
function flat(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[0]) > 6 || Math.abs(d[i + 1] - d[1]) > 6 || Math.abs(d[i + 2] - d[2]) > 6) return false;
  }
  return true;
}

/** Warm gold pixels — the trophy emoji and the champion's frame, nothing else. */
function goldPixels(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const c = hsv(d[i], d[i + 1], d[i + 2]);
    if (c.h >= 15 && c.h <= 70 && c.s > 0.35 && c.v > 0.35) n++;
  }
  return n;
}

/** The strongest ink-to-ground contrast in a band — is anything readable here. */
function contrast(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, w, h).data;
  const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const l = lum(i); if (l < lo) lo = l; if (l > hi) hi = l; }
  const L = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return (L(hi) + 0.05) / (L(lo) + 0.05);
}
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>card pixels</title>
<body style="margin:0;background:#111">
<script>
${STUBS}
${lifted}
${SCENES}
${CHECKS}

const report = { cards: [], errors: [] };

/**
 * Every horizontal transition down one column of pixels.
 *
 * A row divider drawn once, straight, from the row itself gives the SAME list
 * at every x. A rounded plate gives a different list near the name column than
 * across the points column, which is what "misaligned separators" looks like.
 */
function columnEdges(ctx, x, height, from, to) {
  const col = ctx.getImageData(x, 0, 1, height).data;
  const edges = [];
  for (let y = Math.max(1, from); y < Math.min(height, to); y++) {
    const i = y * 4, j = (y - 1) * 4;
    if (Math.abs(col[i] - col[j]) + Math.abs(col[i + 1] - col[j + 1])
      + Math.abs(col[i + 2] - col[j + 2]) > 12) edges.push(y);
  }
  return edges;
}

const bg = [0x18, 0x00, 0x20];

// Where the drawing sits inside the square, in device pixels.
const place = (contentHeight) => {
  const k = Math.min(1, CARD_SIDE / Math.max(contentHeight, 1));
  return { k, tx: (CARD_SIDE - CARD_W * k) / 2, ty: (CARD_SIDE - contentHeight * k) / 2 };
};

function tableGeometry(expect) {
  const m = expect.weekly
    ? weeklyCardGeometry(expect.rows).m
    : cardRowMetrics(expect.rows, { chrome: expect.chrome, base: expect.base });
  const head = expect.weekly
    ? CARD_HEAD_H + CARD_GAP + weeklyCardGeometry(expect.rows).hero + CARD_GAP
    : CARD_HEAD_H + CARD_GAP;
  return { m, head, top: head + CARD_TABLE_HEAD_H, ...place(m.contentHeight) };
}

function checkCard(name, canvas, expect) {
  const ctx = canvas.getContext("2d");
  const checks = [];
  const ok = (label, pass, detail) => checks.push({ label, pass: !!pass, detail: detail || "" });
  const note = (label, detail) => checks.push({ label, note: true, detail });

  ok("canvas is square 1080x1080", canvas.width === 1080 && canvas.height === 1080,
    canvas.width + "x" + canvas.height);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const box = inkBox(data, canvas.width, canvas.height, bg);
  // A full-bleed brand band legitimately touches the edge; a cut letter does
  // not. So the test is whether an edge line SWINGS, not whether it is empty.
  const type = typeBox(data, canvas.width, canvas.height);
  ok("no type is cut by any edge of the square",
    type.minX >= 8 && type.minY >= 8 && type.maxX <= canvas.width - 9 && type.maxY <= canvas.height - 9,
    "type box " + JSON.stringify(type) + "; all ink " + JSON.stringify(box));
  ok("the drawing actually fills the card", (box.maxX - box.minX) > canvas.width * 0.7,
    "ink width " + (box.maxX - box.minX));
  ok("text is legible against the ground (contrast >= 4.5:1)",
    contrast(ctx, 0, box.minY, canvas.width, Math.max(1, box.maxY - box.minY)) >= 4.5,
    contrast(ctx, 0, box.minY, canvas.width, Math.max(1, box.maxY - box.minY)).toFixed(1) + ":1");

  if (expect.hero) {
    const p = place(expect.contentHeight);
    const y = Math.round(p.ty + p.k * (CARD_HEAD_H + CARD_GAP));
    const h = Math.round(p.k * CARD_HERO_H);
    const gold = goldPixels(ctx, 0, y, canvas.width, h);
    if (expect.hero === "trophy") ok("the hero carries its trophy", gold > 200, gold + " warm pixels");
    else ok("no trophy floats over a hero that names nobody", gold === 0, gold + " warm pixels");
  }

  if (expect.rows) {
    const g = tableGeometry(expect);
    const onPage = Math.min(g.m.rowsPerPage, expect.rows - expect.page * g.m.rowsPerPage);
    let withHonours = 0, overlaps = 0, tallyClash = 0;
    const gaps = [];
    for (let i = 0; i < onPage; i++) {
      const rowTop = g.top + i * g.m.rowH;
      const mid = rowTop + (g.m.rowH - 10) / 2;

      if (expect.honours) {
        const index = expect.page * g.m.rowsPerPage + i;
        const counts = expect.heavy
          ? { gold: 12 - (index % 3), silver: 10 + (index % 4), bronze: 11 + (index % 2) }
          : { gold: index % 3, silver: (index + 1) % 3, bronze: (index + 2) % 3 };
        // Mirrors the drawing code exactly, so a tally that moved would be
        // found missing rather than quietly measured somewhere else.
        const fit = g.m.honoursLine ? null : cardHonoursFit(ctx, CARD_COL, counts, g.m);
        const hx = fit ? fit.x : CARD_COL.name;
        const hy = g.m.honoursLine ? mid + g.m.honoursDy : mid + g.m.name / 3;
        const size = fit ? fit.size : g.m.honoursSize;
        const width = fit ? fit.width : cardHonoursWidth(ctx, counts, size);
        if (!flat(ctx, Math.round(g.tx + g.k * hx), Math.round(g.ty + g.k * (hy - size)),
          Math.round(g.k * width), Math.round(g.k * (size + 4)))) withHonours++;
        // An inline tally shares its baseline with the exact figure, so it
        // must stop before that figure starts.
        if (fit && fit.x + fit.width > CARD_COL.exact - g.m.second * 1.2) tallyClash++;
      }

      // Overlap is about ink meeting ink. An emoji tail may hang below its own
      // plate — that is a shape, not a collision. What must never happen is one
      // row's marks touching the next row's.
      if (i + 1 < onPage) {
        const band = (bandTop) => {
          const y0 = Math.round(g.ty + g.k * bandTop) + 1;
          const y1 = Math.round(g.ty + g.k * (bandTop + g.m.rowH));
          const x0 = Math.round(g.tx + g.k * (CARD_PAD + 4));
          const w = Math.max(1, Math.round(g.k * (CARD_W - CARD_PAD * 2 - 8)));
          const found = inkLines(ctx, x0, y0, w, Math.max(1, y1 - y0), [bg, pixelAt(ctx, x0, y0 + 1)]);
          return { y0, first: found.first, last: found.last };
        };
        const here = band(rowTop), next = band(rowTop + g.m.rowH);
        const clear = here.last == null || next.first == null
          ? 99
          : (next.y0 + next.first) - (here.y0 + here.last) - 1;
        if (clear < 1) overlaps++;
        gaps.push(clear);
      }
    }

    // Every page repeats the table's own headings and the league's name.
    const drawn = ctx.getImageData(0, 0, canvas.width, canvas.height);
    void drawn;
    ok("this page carries the table's headings", !flat(ctx,
      Math.round(g.tx + g.k * CARD_PAD), Math.round(g.ty + g.k * (g.head + 8)),
      Math.round(g.k * (CARD_W - CARD_PAD * 2)), Math.round(g.k * 36)), "headings drawn");

    if (expect.honours) {
      ok("no honours tally runs into the exact column", tallyClash === 0, tallyClash + " clashes");
      ok("honours are painted on EVERY row of this page", withHonours === onPage,
        withHonours + " of " + onPage + " rows carry a tally");
    }
    ok("no row's ink runs into the next row", overlaps === 0,
      overlaps + " collisions; narrowest clear space between rows " + Math.min(...gaps, 99) + "px");
    ok("one linear vertical list, never side-by-side columns",
      onPage > 0 && g.m.rowsPerPage <= expect.rows,
      onPage + " of " + expect.rows + " members on page " + (expect.page + 1) + " of " + expect.pages);

    // Sol's floors, measured after the square transform, not before it.
    const primary = Math.min(g.m.name, g.m.number, g.m.points) * g.k;
    const secondary = Math.min(g.m.second, g.m.honoursSize) * g.k;
    ok("names, ranks and points are at least 18px after the transform", primary >= 18 - 0.01,
      primary.toFixed(1) + "px");
    ok("secondary figures and honours are at least 15px after the transform", secondary >= 15 - 0.01,
      secondary.toFixed(1) + "px");
    ok("the layout solved the fit — no global shrinking", g.k >= 1,
      "square fit " + g.k.toFixed(3));
  }

  if (expect.weekly && expect.rows) {
    // The dividers, measured at the table's left edge, between the name and
    // exact columns, and at its right edge. One straight rule gives the same
    // answer at all three; a curved plate edge does not.
    const g = tableGeometry(expect);
    const from = Math.round(g.ty + g.k * g.top);
    const to = Math.round(g.ty + g.k * (g.top + g.m.rowsPerPage * g.m.rowH));
    const at = (x) => columnEdges(ctx, x, canvas.height, from, to).join(",");
    const left = at(Math.round(g.tx + g.k * (CARD_PAD + 6)));
    const mid = at(Math.round(g.tx + g.k * 620));
    const right = at(Math.round(g.tx + g.k * (CARD_W - CARD_PAD - 6)));
    ok("every divider is one continuous line across the full width",
      left === mid && mid === right,
      left === mid && mid === right
        ? left.split(",").length + " transitions, identical at every x"
        : "left [" + left + "] mid [" + mid + "] right [" + right + "]");
    // And it never runs into the page margin.
    const outside = columnEdges(ctx, Math.round(g.tx + g.k * (CARD_PAD - 8)), canvas.height, from, to);
    ok("no divider crosses the page margin", outside.length === 0,
      outside.length + " transitions outside the table");
  }

  if (expect.podium === "none") {
    // The rostrum used to live between the hero and the table head. That band
    // is a gap now, and a gap is flat.
    const g = tableGeometry(expect);
    const y = Math.round(g.ty + g.k * (CARD_HEAD_H + CARD_GAP + CARD_HERO_H + 4));
    ok("the export carries no rostrum between hero and table",
      flat(ctx, Math.round(g.tx + g.k * CARD_PAD), y,
        Math.round(g.k * (CARD_W - CARD_PAD * 2)), Math.max(1, Math.round(g.k * 18))),
      "hero-to-table band is clear");
  }

  // Measured, not asserted: how small the smallest word on the card ends up
  // once the square fit has scaled the design down.
  if (expect.metrics) {
    const { m, k } = expect.metrics;
    const smallest = Math.min(m.name, m.number, m.points, m.honoursSize || 99) * k;
    note("smallest table type in the exported image",
      smallest.toFixed(1) + "px of 1080 (row " + (m.rowH * k).toFixed(0) + "px, square fit " + k.toFixed(3) + ")");
  }
  report.cards.push({ name, checks, png: canvas.toDataURL("image/png") });
}

try {
  for (const [name, draw] of Object.entries(SCENE)) {
    const canvases = draw();
    const members = WEEKLY_MEMBERS[name] ?? SEASON_MEMBERS[name];
    const weekly = name.startsWith("weekly");
    const chrome = weekly
      ? weeklyCardGeometry(members).chrome
      : CARD_HEAD_H + CARD_GAP + CARD_TABLE_HEAD_H + CARD_GAP + CARD_FOOT_H;
    const m = weekly
      ? weeklyCardGeometry(members).m
      : cardRowMetrics(members, { chrome, base: CARD_SEASON_ROW_H });
    const expect = {
      rows: members, members, weekly, chrome, base: weekly ? CARD_ROW_H : CARD_SEASON_ROW_H,
      honours: !weekly,
      hero: weekly ? (name === "weekly-not-started" ? "bare" : "trophy") : null,
      contentHeight: m.contentHeight,
      metrics: { m, k: place(m.contentHeight).k },
      podium: FINAL_MEMBERS[name] ? "none" : null,
      heavy: HEAVY_SCENES.has(name),
    };
    canvases.forEach((canvas, page) => checkCard(
      canvases.length > 1 ? name + "-page-" + (page + 1) + "-of-" + canvases.length : name,
      canvas, { ...expect, page, pages: canvases.length }));
  }
} catch (error) {
  report.errors.push(String(error && error.stack || error));
}
document.title = "done";
const out = document.createElement("pre");
out.id = "out";
out.textContent = JSON.stringify(report);
document.body.appendChild(out);
<\/script>
</body>`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const pagePath = join(OUT, "cards.html");
writeFileSync(pagePath, PAGE);

const dom = execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-sandbox",
  "--force-color-profile=srgb", "--hide-scrollbars", "--virtual-time-budget=8000",
  "--dump-dom", `file://${pagePath}`], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });

const at = dom.indexOf('<pre id="out">');
if (at < 0) { console.error("the page produced no report:\n" + dom.slice(0, 2000)); process.exit(1); }
const json = dom.slice(dom.indexOf(">", at) + 1, dom.indexOf("</pre>", at))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
const report = JSON.parse(json);

if (report.errors.length) { console.error(report.errors.join("\n")); process.exit(1); }


let failed = 0;
console.log(`\n  Rendered in ${execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim()}\n`);
for (const card of report.cards) {
  const png = Buffer.from(card.png.split(",")[1], "base64");
  const file = join(OUT, `${card.name}.png`);
  writeFileSync(file, png);
  console.log(`  ${card.name}  (${(png.length / 1024).toFixed(0)} KB)  ${file}`);
  for (const check of card.checks) {
    if (check.note) { console.log(`      NOTE  ${check.label}  — ${check.detail}`); continue; }
    if (!check.pass) failed++;
    console.log(`      ${check.pass ? "PASS" : "FAIL"}  ${check.label}${check.detail ? `  — ${check.detail}` : ""}`);
  }
}
console.log(failed ? `\n  ${failed} pixel checks FAILED\n` : "\n  every pixel check passed\n");
process.exit(failed ? 1 : 0);
