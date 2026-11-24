// v1.8.1 — the Exact column steps back; Pts leads.
//
// On screen only: the Weekly and Season tables mark every Exact header and
// value with `col-exact`, styled in the app's muted token at regular weight.
// The share cards draw their own table (the frozen M9 design) and are not
// touched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, sourceOf } from "./harness.mjs";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const TABLE = [
  { uid: "u1", nick: "Adam", rank: 1, pts: 40, exact: 3, wins: 1 },
  { uid: "u2", nick: "Tom", rank: 2, pts: 31, exact: 2, wins: 0 },
  { uid: "u3", nick: "Sol", rank: 3, pts: 12, exact: 0, wins: 0 },
];

const doc = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const column = (d, n) => [...d.querySelectorAll(`tr > :nth-child(${n})`)];

function weekly() {
  const box = load(["roundTableHtml", "slateIdsOf", "weeklyRanks", "weeklyMovement", "weeklyMovementBadge",
    "sharedRankByUid", "settlementWindows", "windowPointsByUid", "VOID_STATUSES", "isVoidFixture", "isPostponed",
    "PLACE_EMOJI", "podiumCounts"], { slateForPeriod: () => null, fixtureById: () => null });
  return doc(box.roundTableHtml({ period: "2", table: TABLE, reveal: [], complete: true,
    podium: [{ uid: "u1", place: "gold" }] }));
}
function season(isOwner) {
  const box = load(["seasonTableHtml", "movementBadge", "seasonMovement", "movementMark"], {});
  return doc(box.seasonTableHtml({ code: "AAA", owner: "u1", table: TABLE }, isOwner));
}

test("Weekly: the Exact header and every value are de-emphasised; Pts is not", () => {
  const d = weekly();
  const exact = column(d, 3);
  assert.equal(exact[0].textContent, "Exact");
  assert.ok(exact.every((cell) => cell.classList.contains("col-exact")), "an Exact cell was missed");
  assert.deepEqual(exact.slice(1).map((c) => c.textContent), ["3", "2", "0"], "the values changed");
  assert.ok(column(d, 2).every((cell) => !cell.classList.contains("col-exact")), "Pts was dimmed");
  assert.equal(d.querySelectorAll(".col-exact").length, TABLE.length + 1);
});

test("Season, for host and member alike: Exact de-emphasised, Pts and the kick column untouched", () => {
  for (const isOwner of [false, true]) {
    const d = season(isOwner);
    const exact = column(d, 4);
    assert.equal(exact[0].textContent, "Exact");
    assert.ok(exact.every((cell) => cell.classList.contains("col-exact")), `owner=${isOwner}`);
    assert.ok(column(d, 3).every((cell) => !cell.classList.contains("col-exact")), "Pts was dimmed");
    assert.equal(d.querySelectorAll(".col-exact").length, TABLE.length + 1);
    if (isOwner) assert.ok(column(d, 5).every((cell) => !cell.classList.contains("col-exact")), "the kick column was dimmed");
    // Main table ordering is untouched.
    assert.deepEqual([...d.querySelectorAll(".player-name")].map((n) => n.textContent), ["1. Adam", "2. Tom", "3. Sol"]);
  }
});

test("the style: the app's existing muted token at regular weight", () => {
  assert.match(CSS, /\.table \.col-exact \{ color: var\(--muted\); font-weight: 400; \}/);
  assert.match(CSS, /--muted: #64748b;/);
  // Nothing re-colours Pts.
  assert.doesNotMatch(CSS, /\.table td:nth-child\(3\)|\.col-pts/);
});

test("AA contrast holds on the league card the tables sit in", () => {
  const lum = (rgb) => rgb.map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // .league-card is rgba(255,255,255,.78) over the page's cream.
  assert.match(CSS, /\.notice, \.empty, \.rules-card, \.league-card \{[^}]*background: rgba\(255,255,255,\.78\)/);
  const card = hex("#f5f7fb").map((c) => Math.round(255 * 0.78 + c * 0.22));
  const muted = ratio(hex("#64748b"), card);
  assert.ok(muted >= 4.5, `Exact ${muted.toFixed(2)}:1`);
  assert.ok(ratio(hex("#17202a"), card) > muted, "Pts is no longer the stronger figure");
});

test("the share cards are untouched: their table draws Exact exactly as before", () => {
  for (const fn of ["drawCardTableHead", "drawWeeklyPage", "drawSeasonPage"]) {
    assert.ok(!sourceOf(fn).includes("col-exact"), `${fn} picked up the screen class`);
  }
  assert.match(sourceOf("drawCardTableHead"), /ctx\.fillText\("EXACT", CARD_COL\.exact, y \+ 36\);/);
});
