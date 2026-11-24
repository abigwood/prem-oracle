// v1.8.1 — a league name with no break opportunity stays inside its card.
//
// Forty characters is the most a league name can be (worker and form both cap
// it there). Forty with no space — "WWWW…" — had nowhere to wrap, so the
// League card's name heading pushed the whole page sideways on a phone. The
// fix lets the heading break such a word, and only such a word.
//
// The layout half is real layout: the real leagueView card, the real
// stylesheet, inside genuine 320px and 375px iframe viewports in headless
// Chrome (the same browser evidence_pixels.mjs uses). JSDOM cannot lay text
// out, so where Chrome is absent that half skips and says so; the stylesheet
// half always runs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "./harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSS = readFileSync(join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UNBROKEN = "W".repeat(40);

test("the League card's name heading may break an unbreakable word; nothing else about it changes", () => {
  assert.match(CSS, /\.league-card > h2 \{ overflow-wrap: break-word; \}/);
  // Typography and spacing exactly as they were.
  assert.match(CSS, /\.league-card h2, \.rules-card h2 \{ margin: 4px 0 8px; font-family: Georgia, serif; \}/);
  assert.match(CSS, /\.league-card > h2:first-child \{ margin-top: 0; \}/);
});

/** The real League card for a league called `name`, as leagueView draws it. */
function cardHtml(name) {
  const state = { code: "AAA", name, owner: "u2", error: null, currentPeriod: "13",
    currentSlate: { period: "13", lockAt: "2027-05-22T14:00:00Z", locked: false } };
  const box = load(["leagueView", "hostSlateControl", "lockLine", "slateLocked", "cardLockLine", "lockWeekPrefix", "lockTimeLabel",
    "periodLabel", "periodLabelLong", "isWindowKey"], {
    leagueCodes: ["AAA"], leagueState: state, leagueStates: { AAA: state }, activeLeague: "AAA", leagueManageOpen: false,
    inviteCode: "", playerName: "Adam", uid: () => "u1", flash: () => "", leagueNames: {}, weekNumberFor: () => 13,
    windowLabel: () => "", weekDateRange: () => "", leagueSwitcher: () => "", createLeagueCard: () => "",
    leagueSettings: () => "", roundToggle: () => "", leagueSupportsRounds: () => false, leagueSummaryLine: () => "",
  });
  return box.leagueView();
}

test("an unbroken 40-character name wraps inside the card at 320px and 375px", { skip: !existsSync(CHROME) && "headless Chrome not installed here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "po-name-"));
  try {
    const page = (name, id) => {
      writeFileSync(join(dir, `${id}.html`), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${join(ROOT, "styles.css")}">
<style>html,body{height:auto!important;overflow:visible!important;display:block!important}</style></head>
<body><main style="overflow:visible">${cardHtml(name)}</main><script>addEventListener("load",()=>{
const card=document.querySelector(".league-card"),h=card.querySelector("h2"),R=(e)=>e.getBoundingClientRect();
parent.postMessage(JSON.stringify({id:${JSON.stringify(id)},w:innerWidth,text:h.textContent,
sideways:document.documentElement.scrollWidth>innerWidth,headingOverflows:h.scrollWidth>h.clientWidth+1,
headingRight:R(h).right,cardInnerRight:R(card).right-parseFloat(getComputedStyle(card).paddingRight),
headingH:R(h).height,font:getComputedStyle(h).font}),"*")})</script></body></html>`);
    };
    page(UNBROKEN, "unbroken");
    page("Burtons Premier", "ordinary");
    const frames = [320, 375].flatMap((w) => ["unbroken", "ordinary"].map((id) =>
      `<iframe src="file://${join(dir, `${id}.html`)}" width="${w}" height="400"></iframe>`)).join("");
    writeFileSync(join(dir, "host.html"), `<!doctype html><body>${frames}<pre id="probe"></pre><script>
const got=[];addEventListener("message",(e)=>{got.push(JSON.parse(e.data));document.getElementById("probe").textContent=JSON.stringify(got)})</script></body>`);
    const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--allow-file-access-from-files",
      "--window-size=1800,600", "--virtual-time-budget=3000", "--dump-dom", `file://${join(dir, "host.html")}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
    const raw = /<pre id="probe">([\s\S]*?)<\/pre>/.exec(dom)?.[1] || "[]";
    const results = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.equal(results.length, 4, "not every viewport reported");
    for (const r of results) {
      assert.equal(r.sideways, false, `${r.id} @${r.w}: the page scrolls sideways`);
      assert.equal(r.headingOverflows, false, `${r.id} @${r.w}: the name overflows its heading`);
      assert.ok(r.headingRight <= r.cardInnerRight + 0.5, `${r.id} @${r.w}: the name runs past the card`);
    }
    const at = (id, w) => results.find((r) => r.id === id && r.w === w);
    for (const w of [320, 375]) {
      // The whole name is still there, just broken across lines.
      assert.equal(at("unbroken", w).text, UNBROKEN);
      assert.ok(at("unbroken", w).headingH > at("ordinary", w).headingH, `@${w}: the unbroken name did not wrap`);
      // An ordinary name is untouched: one line, same type.
      assert.equal(at("ordinary", w).font, at("unbroken", w).font);
      assert.ok(at("ordinary", w).headingH < 40, `@${w}: an ordinary name changed height`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
