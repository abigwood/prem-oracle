// Wires Oracle forecasts into the Championship fixture list.
//
// Deliberately a sibling of build_intel.mjs rather than a generalisation of it:
// the Premier League intel is live, and the safest way to add a competition is
// to leave the pipeline that feeds production completely untouched. Both share
// the one thing that matters — the model itself, in worker/src/forecast.mjs.
//
// Every 2026/27 Championship club has a 2025/26 record in one of three free
// football-data.co.uk files, and which file it came from is what the division
// handicap corrects for:
//
//   E1  18 clubs who were already in the Championship   no handicap
//   E0   3 clubs relegated from the Premier League      credited (relegated)
//   E2   3 clubs promoted from League One               discounted (promoted)
//
// A club with no record in any of the three would simply get no rating, and
// every fixture it appears in would ship without probabilities — the app
// renders those as "Forecast unavailable" rather than inventing a number.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_VERSION, matchProbabilities, ratingFromSeason } from "../worker/src/forecast.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "data", "source");
const FIXTURES = path.join(ROOT, "data", "fixtures-elc.json");

// football-data.co.uk short name -> canonical fixtures-elc.json name.
const CANON = {
  Birmingham: "Birmingham City",
  Blackburn: "Blackburn Rovers",
  Bolton: "Bolton Wanderers",
  "Bristol City": "Bristol City",
  Burnley: "Burnley",
  Cardiff: "Cardiff City",
  Charlton: "Charlton Athletic",
  Derby: "Derby County",
  Lincoln: "Lincoln City",
  Middlesbrough: "Middlesbrough",
  Millwall: "Millwall",
  Norwich: "Norwich City",
  Portsmouth: "Portsmouth",
  Preston: "Preston North End",
  QPR: "Queens Park Rangers",
  "Sheffield United": "Sheffield United",
  Southampton: "Southampton",
  Stoke: "Stoke City",
  Swansea: "Swansea City",
  Watford: "Watford",
  "West Brom": "West Bromwich Albion",
  "West Ham": "West Ham United",
  Wolves: "Wolverhampton Wanderers",
  Wrexham: "Wrexham",
};

const DIVISIONS = [
  { file: "E1_2526.csv", basis: "2025/26 Championship", opts: {} },
  { file: "E0_2526.csv", basis: "2025/26 Premier League (relegated)", opts: { relegated: true } },
  { file: "E2_2526.csv", basis: "2025/26 League One (promoted)", opts: { promoted: true } },
];

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = headerLine.split(",");
  return lines.map((line) => {
    // football-data rows are plain comma-separated with no quoted commas.
    const cells = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

function parseDate(value) {
  const [day, month, year] = String(value || "").split("/").map(Number);
  if (!day || !month || !year) return 0;
  return Date.UTC(year < 100 ? 2000 + year : year, month - 1, day);
}

const outcome = (goalsFor, goalsAgainst) =>
  goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";

function seasonRecords(file) {
  const store = {};
  for (const row of parseCsv(path.join(SOURCE, file))) {
    const home = CANON[row.HomeTeam];
    const away = CANON[row.AwayTeam];
    const homeGoals = Number(row.FTHG);
    const awayGoals = Number(row.FTAG);
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
    const date = parseDate(row.Date);
    for (const [team, goalsFor, goalsAgainst] of [
      [home, homeGoals, awayGoals],
      [away, awayGoals, homeGoals],
    ]) {
      if (!team) continue;
      const record = store[team] || (store[team] = { played: 0, points: 0, gf: 0, ga: 0, log: [] });
      const result = outcome(goalsFor, goalsAgainst);
      record.played += 1;
      record.gf += goalsFor;
      record.ga += goalsAgainst;
      record.points += result === "W" ? 3 : result === "D" ? 1 : 0;
      record.log.push({ date, result });
    }
  }
  return store;
}

const last6Form = (log) =>
  log.slice().sort((a, b) => a.date - b.date).slice(-6).map((entry) => entry.result).join("");

function build() {
  const fixturesData = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const clubs = [...new Set(fixturesData.fixtures.flatMap((fx) => [fx.homeTeam, fx.awayTeam]))].sort();

  const byDivision = DIVISIONS.map((division) => ({ ...division, store: seasonRecords(division.file) }));
  const teams = {};
  const unrated = [];
  for (const name of clubs) {
    const division = byDivision.find((entry) => entry.store[name]);
    if (!division) {
      unrated.push(name);
      continue;
    }
    const record = division.store[name];
    teams[name] = {
      rating: ratingFromSeason(record, division.opts),
      form: last6Form(record.log),
      played: record.played,
      points: record.points,
      gf: record.gf,
      ga: record.ga,
      gd: record.gf - record.ga,
      basis: division.basis,
    };
  }

  // Forecasts are opt-in until the model is validated against real Championship
  // results, per Section 6 of the expansion plan. The seeding above is honest
  // about each club's record but the cross-division handicap is not calibrated
  // for this division: it pins relegated clubs to the Elo floor and lets a
  // dominant League One side outrank the whole Championship. Shipping that
  // would be worse than shipping nothing, so by default every fixture goes out
  // without probabilities and the app renders "Forecast unavailable".
  const withForecasts = process.argv.includes("--with-forecasts");
  let forecast = 0;
  for (const fixture of fixturesData.fixtures) {
    const home = teams[fixture.homeTeam];
    const away = teams[fixture.awayTeam];
    fixture.probabilities = withForecasts && home && away
      ? matchProbabilities(home.rating, away.rating, home.form, away.form)
      : null;
    if (fixture.probabilities) forecast += 1;
  }

  fixturesData.modelVersion = withForecasts ? MODEL_VERSION : null;
  fixturesData.forecast = {
    model: "prem-oracle v2 Elo + Poisson (home advantage + form)",
    version: MODEL_VERSION,
    baseline: "football-data.co.uk 2025/26 (E0 + E1 + E2)",
    status: withForecasts ? "live" : "seeded, awaiting validation against 2026/27 results",
  };
  fixturesData.teams = teams;
  fixturesData.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.writeFileSync(FIXTURES, JSON.stringify(fixturesData, null, 2) + "\n");

  console.log(`rated ${Object.keys(teams).length}/${clubs.length} clubs`);
  if (unrated.length) console.log(`no 2025/26 record (forecast omitted): ${unrated.join(", ")}`);
  console.log(`probabilities on ${forecast}/${fixturesData.fixtures.length} fixtures`);
}

build();
