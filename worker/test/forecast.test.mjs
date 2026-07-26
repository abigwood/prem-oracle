import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_VERSION,
  ratingFromSeason,
  formAdjustment,
  matchProbabilities,
  fixtureProbabilities,
} from "../src/forecast.mjs";

const RATINGS = [45, 50, 60, 66, 73, 80, 88, 92, 95];
const FORMS = ["WWWWWW", "LLLLLL", "WDLWDL", "DDDDDD", "LWDWLW", ""];

test("model version is exposed", () => {
  assert.equal(typeof MODEL_VERSION, "string");
  assert.match(MODEL_VERSION, /^\d+\.\d+\.\d+$/);
});

test("probabilities are three integers summing to exactly 100", () => {
  for (const hr of RATINGS) {
    for (const ar of RATINGS) {
      for (const hf of FORMS) {
        for (const af of FORMS) {
          const p = matchProbabilities(hr, ar, hf, af);
          assert.equal(p.length, 3);
          assert.ok(p.every((n) => Number.isInteger(n) && n >= 0 && n <= 100));
          assert.equal(p[0] + p[1] + p[2], 100);
        }
      }
    }
  }
});

test("no single outcome exceeds the 75% cap, even in extreme mismatches", () => {
  const p = matchProbabilities(95, 45, "WWWWWW", "LLLLLL");
  assert.ok(Math.max(...p) <= 75, `got ${p}`);
  const q = matchProbabilities(45, 95, "LLLLLL", "WWWWWW"); // away monster
  assert.ok(Math.max(...q) <= 75, `got ${q}`);
});

test("draw probability stays within 18-32 across the grid", () => {
  for (const hr of RATINGS) {
    for (const ar of RATINGS) {
      const [, draw] = matchProbabilities(hr, ar);
      assert.ok(draw >= 18 && draw <= 32, `draw ${draw} for ${hr} vs ${ar}`);
    }
  }
});

test("home advantage: equal teams favour the home side", () => {
  const [home, , away] = matchProbabilities(70, 70);
  assert.ok(home > away, `home ${home} should beat away ${away}`);
});

test("a stronger rating produces a bigger home win probability", () => {
  const weak = matchProbabilities(70, 70)[0];
  const strong = matchProbabilities(85, 70)[0];
  assert.ok(strong > weak);
});

test("form swings the forecast but does not dominate rating", () => {
  const hot = matchProbabilities(70, 70, "WWWWWW", "LLLLLL")[0];
  const cold = matchProbabilities(70, 70, "LLLLLL", "WWWWWW")[0];
  assert.ok(hot > cold, "hot home form should beat cold");
  // rating gap (15) should outweigh a form swing
  const ratingLed = matchProbabilities(85, 70, "LLLLLL", "WWWWWW")[0];
  assert.ok(ratingLed > matchProbabilities(70, 70)[2], "rating still leads");
});

test("formAdjustment is neutral-ish for empty/mid form and signed for hot/cold", () => {
  assert.equal(formAdjustment(""), 0);
  assert.ok(formAdjustment("WWWWWW") > 0);
  assert.ok(formAdjustment("LLLLLL") < 0);
  // most-recent-last weighting: recent wins matter more than old wins
  assert.ok(formAdjustment("LLLWWW") > formAdjustment("WWWLLL"));
});

test("ratingFromSeason encodes points and goal difference, clamped", () => {
  const champ = ratingFromSeason({ played: 38, points: 85, gf: 78, ga: 34 });
  const bottom = ratingFromSeason({ played: 38, points: 22, gf: 30, ga: 67 });
  assert.ok(champ > bottom);
  assert.ok(champ >= 45 && champ <= 95);
  assert.ok(bottom >= 45 && bottom <= 95);
});

test("promoted handicap lowers a rating vs the same record in the top flight", () => {
  const record = { played: 46, points: 95, gf: 84, ga: 32 };
  const topFlight = ratingFromSeason(record);
  const promoted = ratingFromSeason(record, { promoted: true });
  assert.ok(promoted < topFlight, "division penalty must apply");
  assert.ok(promoted >= 45, "but still a plausible floor");
});

test("fixtureProbabilities reads an intel map and tolerates unknown teams", () => {
  const intel = { A: { rating: 88, form: "WWWWWW" }, B: { rating: 55, form: "LLLLLL" } };
  const p = fixtureProbabilities(intel, "A", "B");
  assert.equal(p[0] + p[1] + p[2], 100);
  const unknown = fixtureProbabilities(intel, "X", "Y");
  assert.equal(unknown[0] + unknown[1] + unknown[2], 100);
});
