// v1.9 Slice 2 §B — the weather pill shows a real forecast or nothing.
//
// VENUE_OUTLOOK was a hard-coded August table: every fixture at the Emirates
// read "20°C Outlook", including a November evening. It is gone. These run the
// REAL weatherIntel / matchIntelStrip over fixtures with and without the
// forecast the worker now lays on them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { load, APP } from "./harness.mjs";

const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const strip = () => load(["weatherIntel", "matchIntelStrip"], { fixtureDayDiff: () => 2 });
const dom = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const ARS_MCI = { id: "m1", player1: "Arsenal", player2: "Manchester City", venue: "Emirates Stadium", startAt: "2026-11-29T16:30:00Z" };
const FORECAST = { icon: "🌧", temp: 7, desc: "Rain", at: "2026-11-29T06:00:05Z" };
const LEGAL = "https://weatherkit.apple.com/legal-attribution.html";

test("no forecast, no pill — and no attribution — whatever the venue", () => {
  const box = strip();
  for (const match of [ARS_MCI, { ...ARS_MCI, weather: null }, { ...ARS_MCI, weather: { icon: "☀️", desc: "x" } },
    { ...ARS_MCI, weather: { icon: "☀️", temp: "n/a" } }]) {
    assert.equal(box.weatherIntel(match), null);
    const d = dom(box.matchIntelStrip(match));
    assert.equal(d.querySelector(".weather-pill"), null);
    assert.equal(d.querySelector(".weather-attribution"), null);
    assert.match(d.body.textContent, /Emirates Stadium/, "the venue pill stays");
    assert.doesNotMatch(d.body.textContent, /°C|Outlook|Forecast/);
  }
});

test("a real forecast reads '<icon> <temp>°C Forecast', with Apple's attribution beside it", () => {
  const box = strip();
  const d = dom(box.matchIntelStrip({ ...ARS_MCI, weather: FORECAST }));
  const pill = d.querySelector(".weather-pill");
  assert.equal(pill.textContent.replace(/\s+/g, " ").trim(), "🌧 7°C Forecast");
  assert.equal(pill.getAttribute("title"), "Rain");
  const mark = d.querySelector("a.weather-attribution");
  assert.ok(mark, "a forecast without Apple's attribution");
  assert.equal(mark.getAttribute("href"), LEGAL);
  assert.equal(mark.textContent, " Weather");
  assert.equal(mark.getAttribute("rel"), "noopener");
});

test("a forecast is not shown for a fixture more than a week away", () => {
  const box = load(["weatherIntel"], { fixtureDayDiff: () => 8 });
  assert.equal(box.weatherIntel({ ...ARS_MCI, weather: FORECAST }), null);
});

test("the made-up outlook is deleted, not hidden", () => {
  for (const gone of ["VENUE_OUTLOOK", "late-summer", "Outlook", "provisional:", "weather.provisional"]) {
    assert.ok(!APP.includes(gone), `app.js still ships ${gone}`);
  }
});

test("the app never calls WeatherKit — only links to its attribution page", () => {
  for (const [name, text] of [["app.js", APP], ["sw.js", SW]]) {
    const hits = text.match(/weatherkit\.apple\.com[^"'`\s]*/g) || [];
    assert.ok(hits.every((hit) => hit === "weatherkit.apple.com/legal-attribution.html"), `${name}: ${hits}`);
  }
  assert.doesNotMatch(APP, /fetch\([^)]*weather/i);
});
