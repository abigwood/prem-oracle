// Prem Oracle in-house forecast model (pure, no I/O).
//
// Shared by the offline build pipeline (scripts/build_intel.mjs), the worker
// refresh path, and the test suite. Everything here is deterministic given its
// inputs so ratings/forecasts are reproducible.

export const MODEL_VERSION = "1.1.0";

// ---- Rating model -----------------------------------------------------------
// A team's rating is seeded from a completed league season: points-per-game
// (which encodes points) plus goal-difference-per-game (which encodes goals
// for/against). Promoted clubs are rated from their Championship season and
// then handicapped, because second-tier form overstates top-flight strength.
const RATING = {
  BASE: 40,
  PPG_WEIGHT: 20,
  GDPG_WEIGHT: 6,
  DIVISION_PENALTY: 22, // subtracted from ratings seeded on second-tier data
  MIN: 45,
  MAX: 95,
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/**
 * Rating from one season's aggregate record.
 * @param {{played:number, points:number, gf:number, ga:number}} season
 * @param {{promoted?:boolean}} [opts] promoted => apply division handicap
 * @returns {number} integer rating, clamped to [MIN, MAX]
 */
export function ratingFromSeason(season, opts = {}) {
  const played = season.played || 0;
  if (!played) return RATING.MIN;
  const ppg = season.points / played;
  const gdpg = (season.gf - season.ga) / played;
  let rating = RATING.BASE + ppg * RATING.PPG_WEIGHT + gdpg * RATING.GDPG_WEIGHT;
  if (opts.promoted) rating -= RATING.DIVISION_PENALTY;
  return Math.round(clamp(rating, RATING.MIN, RATING.MAX));
}

// ---- Form model -------------------------------------------------------------
// Form is a W/D/L string of the last 6 league games, most recent LAST.
const FORM = {
  NEUTRAL_PPG: 1.35, // ~ mid-table points-per-game; the "no swing" baseline
  WEIGHT: 4, // rating-points per (ppg above/below neutral)
  SWING_CAP: 8, // clamp the form adjustment either way
};

const resultPoints = (ch) => (ch === "W" ? 3 : ch === "D" ? 1 : 0);

/**
 * Convert a form string into a small rating adjustment (recent games weighted
 * more heavily). Neutral form ~ 0; hot form positive, cold form negative.
 * @param {string} form e.g. "WWDLDW" (most recent last)
 * @returns {number}
 */
export function formAdjustment(form) {
  const chars = String(form || "").toUpperCase().replace(/[^WDL]/g, "").split("");
  if (!chars.length) return 0;
  let weighted = 0;
  let weightSum = 0;
  chars.forEach((ch, i) => {
    const weight = i + 1; // oldest = 1 ... most recent = length
    weighted += weight * resultPoints(ch);
    weightSum += weight;
  });
  const weightedPpg = weighted / weightSum;
  const swing = (weightedPpg - FORM.NEUTRAL_PPG) * FORM.WEIGHT;
  return clamp(swing, -FORM.SWING_CAP, FORM.SWING_CAP);
}

// ---- Match probability model ------------------------------------------------
const MODEL = {
  HOME_ADV: 7, // home advantage in rating points
  SIG_SCALE: 15, // logistic scale for the home/away split
  DRAW_BASE: 30, // draw % for a perfectly even tie
  DRAW_SLOPE: 0.22, // draw % lost per rating point of mismatch
  DRAW_MIN: 18,
  DRAW_MAX: 32,
  OUTCOME_CAP: 75, // no single outcome is allowed above this
};

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Round an array of non-negative reals to integers summing to `total`
// (largest-remainder method) so probabilities always sum to exactly 100.
function roundToTotal(values, total = 100) {
  const floors = values.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = values
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floors[order[k].i] += 1;
  }
  return floors;
}

/**
 * Compute [homePct, drawPct, awayPct] integer probabilities summing to 100.
 * @param {number} homeRating
 * @param {number} awayRating
 * @param {string} [homeForm] W/D/L string, most recent last
 * @param {string} [awayForm]
 * @returns {[number, number, number]}
 */
export function matchProbabilities(homeRating, awayRating, homeForm = "", awayForm = "") {
  const eff =
    homeRating - awayRating +
    MODEL.HOME_ADV +
    (formAdjustment(homeForm) - formAdjustment(awayForm));

  const draw = clamp(
    MODEL.DRAW_BASE - MODEL.DRAW_SLOPE * Math.abs(eff),
    MODEL.DRAW_MIN,
    MODEL.DRAW_MAX,
  );
  const homeShare = sigmoid(eff / MODEL.SIG_SCALE);
  let home = (100 - draw) * homeShare;
  let away = (100 - draw) * (1 - homeShare);
  let drawPct = draw;

  // Enforce the favourite cap, then hand the excess back to the other two
  // outcomes in proportion so the trio still totals 100.
  const cap = MODEL.OUTCOME_CAP;
  if (home > cap || away > cap) {
    if (home > cap) {
      const excess = home - cap;
      home = cap;
      const rest = drawPct + away || 1;
      drawPct += excess * (drawPct / rest);
      away += excess * (away / rest);
    } else {
      const excess = away - cap;
      away = cap;
      const rest = drawPct + home || 1;
      drawPct += excess * (drawPct / rest);
      home += excess * (home / rest);
    }
  }

  return roundToTotal([home, drawPct, away], 100);
}

/**
 * Convenience wrapper taking an intel map ({ [team]: { rating, form } }).
 * Falls back to a league-average rating (69) for unknown teams.
 */
export function fixtureProbabilities(intel, homeTeam, awayTeam) {
  const h = intel[homeTeam] || {};
  const a = intel[awayTeam] || {};
  return matchProbabilities(h.rating ?? 69, a.rating ?? 69, h.form || "", a.form || "");
}
