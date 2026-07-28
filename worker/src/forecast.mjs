// Prem Oracle in-house forecast model (pure, no I/O).
//
// Shared by the offline build pipeline (scripts/build_intel.mjs), the worker
// refresh path, and the test suite. Everything here is deterministic given its
// inputs so ratings/forecasts are reproducible.

export const MODEL_VERSION = "2.0.0";

// ---- Rating model -----------------------------------------------------------
// A team's Elo is seeded from a completed league season: points-per-game
// (results strength) plus goal-difference-per-game (goal strength). Promoted
// clubs are seeded from their Championship season and then handicapped, because
// second-tier form overstates top-flight strength.
const RATING = {
  BASE_ELO: 1500,
  NEUTRAL_PPG: 1.35,
  PPG_WEIGHT: 260,
  GDPG_WEIGHT: 140,
  DIVISION_PENALTY: 160, // Elo subtracted from ratings seeded on second-tier data
  MIN: 1320,
  MAX: 1900,
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/**
 * Elo seed from one season's aggregate record.
 *
 * A record only means something relative to the division it was earned in.
 * `promoted` discounts a record set one tier below the competition being
 * rated; `relegated` is its mirror, crediting a record set one tier above —
 * a bottom-three Premier League season is a strong Championship baseline.
 *
 * @param {{played:number, points:number, gf:number, ga:number}} season
 * @param {{promoted?:boolean, relegated?:boolean}} [opts]
 * @returns {number} integer Elo, clamped to [MIN, MAX]
 */
export function ratingFromSeason(season, opts = {}) {
  const played = season.played || 0;
  if (!played) return RATING.MIN;
  const ppg = season.points / played;
  const gdpg = (season.gf - season.ga) / played;
  let rating =
    RATING.BASE_ELO +
    (ppg - RATING.NEUTRAL_PPG) * RATING.PPG_WEIGHT +
    gdpg * RATING.GDPG_WEIGHT;
  if (opts.promoted) rating -= RATING.DIVISION_PENALTY;
  if (opts.relegated) rating += RATING.DIVISION_PENALTY;
  return Math.round(clamp(rating, RATING.MIN, RATING.MAX));
}

// Standard Elo update, using the same goal-difference multiplier shape as
// eloratings.net. This lets the Tue/Fri refresh move the model with real games.
export function updatedElo(homeElo, awayElo, homeGoals, awayGoals, opts = {}) {
  const k = opts.k ?? 40;
  const homeAdv = opts.homeAdv ?? 0;
  const diff = homeElo + homeAdv - awayElo;
  const expected = 1 / (1 + 10 ** (-diff / 400));
  const actual = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const gd = Math.abs(homeGoals - awayGoals);
  const goalMultiplier = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
  const delta = k * goalMultiplier * (actual - expected);
  return [homeElo + delta, awayElo - delta];
}

// ---- Form model -------------------------------------------------------------
// Form is a W/D/L string of the last 6 league games, most recent LAST.
const FORM = {
  NEUTRAL_PPG: 1.35, // ~ mid-table points-per-game; the "no swing" baseline
  WEIGHT: 22, // Elo per weighted-form ppg above/below neutral
  SWING_CAP: 45, // clamp the form adjustment either way
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
const POISSON = {
  HOME_ADV: 65, // home advantage in Elo points
  BASE_GOALS: 1.33,
  ELO_GOAL_SCALE: 1100,
  MAX_GOALS: 3.4,
  MIN_GOALS: 0.25,
  GRID: 10,
  OUTCOME_CAP: 75, // app-friendly cap; avoids cartoon certainty
};

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

function poissonPmf(lambda, maxGoals = POISSON.GRID) {
  const out = [];
  let p = Math.exp(-lambda);
  out.push(p);
  for (let k = 1; k <= maxGoals; k++) {
    p = (p * lambda) / k;
    out.push(p);
  }
  return out;
}

export function expectedGoals(homeElo, awayElo, homeForm = "", awayForm = "") {
  const diff =
    homeElo -
    awayElo +
    POISSON.HOME_ADV +
    (formAdjustment(homeForm) - formAdjustment(awayForm));
  const home = POISSON.BASE_GOALS * 10 ** (diff / POISSON.ELO_GOAL_SCALE);
  const away = POISSON.BASE_GOALS * 10 ** (-diff / POISSON.ELO_GOAL_SCALE);
  return [
    clamp(home, POISSON.MIN_GOALS, POISSON.MAX_GOALS),
    clamp(away, POISSON.MIN_GOALS, POISSON.MAX_GOALS),
  ];
}

function capFavourite([home, draw, away]) {
  const cap = POISSON.OUTCOME_CAP;
  if (home <= cap && away <= cap) return [home, draw, away];
  if (home > cap) {
    const excess = home - cap;
    const rest = draw + away || 1;
    return [cap, draw + excess * (draw / rest), away + excess * (away / rest)];
  }
  const excess = away - cap;
  const rest = draw + home || 1;
  return [home + excess * (home / rest), draw + excess * (draw / rest), cap];
}

/**
 * Compute [homePct, drawPct, awayPct] integer probabilities summing to 100.
 * @param {number} homeRating Elo
 * @param {number} awayRating Elo
 * @param {string} [homeForm] W/D/L string, most recent last
 * @param {string} [awayForm]
 * @returns {[number, number, number]}
 */
export function matchProbabilities(homeRating, awayRating, homeForm = "", awayForm = "") {
  const [homeGoals, awayGoals] = expectedGoals(homeRating, awayRating, homeForm, awayForm);
  const homePmf = poissonPmf(homeGoals);
  const awayPmf = poissonPmf(awayGoals);
  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= POISSON.GRID; h++) {
    for (let a = 0; a <= POISSON.GRID; a++) {
      const p = homePmf[h] * awayPmf[a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }

  const total = home + draw + away || 1;
  return roundToTotal(capFavourite([home, draw, away].map((p) => (p / total) * 100)), 100);
}

/**
 * Convenience wrapper taking an intel map ({ [team]: { rating, form } }).
 * Falls back to a league-average Elo (1500) for unknown teams.
 */
export function fixtureProbabilities(intel, homeTeam, awayTeam) {
  const h = intel[homeTeam] || {};
  const a = intel[awayTeam] || {};
  return matchProbabilities(h.rating ?? RATING.BASE_ELO, a.rating ?? RATING.BASE_ELO, h.form || "", a.form || "");
}
