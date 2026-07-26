#!/usr/bin/env node
// Build the Prem Oracle forecast intel and wire it into data/fixtures.json.
//
//   node scripts/build_intel.mjs            # offline, reproducible from CSVs
//   node scripts/build_intel.mjs --refresh  # also fold in 2026/27 results
//                                           # (needs FOOTBALL_DATA_TOKEN)
//
// Ratings are seeded from real 2025/26 final league performance
// (football-data.co.uk season CSVs, committed under data/source/). The three
// promoted clubs are rated from their 2025/26 Championship record with a
// division handicap. Form is each team's last 6 league games (most recent
// last), regardless of season or division.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_VERSION,
  ratingFromSeason,
  matchProbabilities,
} from "../worker/src/forecast.mjs";
import { mapFootballDataTeam } from "../worker/src/results_feed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "data", "source");
const FIXTURES = path.join(ROOT, "data", "fixtures.json");

// football-data.co.uk short name -> canonical fixtures.json name, for the 20
// Premier League 2026/27 clubs. Seventeen stayed up (E0), three came up (E1).
const CANON = {
  // Premier League 2025/26 (E0)
  Arsenal: "Arsenal",
  "Aston Villa": "Aston Villa",
  Bournemouth: "AFC Bournemouth",
  Brentford: "Brentford",
  Brighton: "Brighton & Hove Albion",
  Chelsea: "Chelsea",
  "Crystal Palace": "Crystal Palace",
  Everton: "Everton",
  Fulham: "Fulham",
  Leeds: "Leeds United",
  Liverpool: "Liverpool",
  "Man City": "Manchester City",
  "Man United": "Manchester United",
  Newcastle: "Newcastle United",
  "Nott'm Forest": "Nottingham Forest",
  Sunderland: "Sunderland",
  Tottenham: "Tottenham Hotspur",
  // Championship 2025/26 (E1) — promoted
  Coventry: "Coventry City",
  Hull: "Hull City",
  Ipswich: "Ipswich Town",
};
const PROMOTED = new Set(["Coventry City", "Hull City", "Ipswich Town"]);

// ---- CSV parsing ------------------------------------------------------------
function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const header = headerLine.split(",");
  const col = (name) => header.indexOf(name);
  const iH = col("HomeTeam");
  const iA = col("AwayTeam");
  const iHG = col("FTHG");
  const iAG = col("FTAG");
  const iDate = col("Date");
  return lines
    .map((line) => {
      const c = line.split(",");
      return {
        home: c[iH],
        away: c[iA],
        hg: Number(c[iHG]),
        ag: Number(c[iAG]),
        date: parseDate(c[iDate]),
      };
    })
    .filter((m) => m.home && m.away && Number.isFinite(m.hg) && Number.isFinite(m.ag));
}

// football-data.co.uk dates are DD/MM/YYYY (occasionally 2-digit year).
function parseDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(value || "").trim());
  if (!m) return 0;
  let [, d, mo, y] = m;
  y = y.length === 2 ? Number(y) + 2000 : Number(y);
  return Date.UTC(y, Number(mo) - 1, Number(d));
}

const outcome = (goalsFor, goalsAgainst) =>
  goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";

// Build per-team season aggregate + chronological match log from raw matches.
// `nameFor` maps a raw CSV team name to the canonical name we track (or null).
function accumulate(matches, nameFor, store) {
  for (const m of matches) {
    const home = nameFor(m.home);
    const away = nameFor(m.away);
    for (const [team, gf, ga] of [
      [home, m.hg, m.ag],
      [away, m.ag, m.hg],
    ]) {
      if (!team) continue;
      const t = store[team] || (store[team] = { played: 0, points: 0, gf: 0, ga: 0, log: [] });
      const res = outcome(gf, ga);
      t.played += 1;
      t.gf += gf;
      t.ga += ga;
      t.points += res === "W" ? 3 : res === "D" ? 1 : 0;
      t.log.push({ date: m.date, result: res });
    }
  }
}

function last6Form(log) {
  return log
    .slice()
    .sort((a, b) => a.date - b.date)
    .slice(-6)
    .map((g) => g.result)
    .join("");
}

// ---- Optional in-season refresh (football-data.org, free tier) --------------
async function fetchCurrentSeason(season) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    console.warn("[refresh] FOOTBALL_DATA_TOKEN not set — skipping current-season fold-in.");
    return [];
  }
  const url = `https://api.football-data.org/v4/competitions/PL/matches?season=${season}`;
  try {
    const res = await fetch(url, { headers: { "X-Auth-Token": token } });
    if (!res.ok) throw new Error(`football-data.org ${res.status}`);
    const body = await res.json();
    const finished = (body.matches || [])
      .filter((it) => it?.status === "FINISHED")
      .map((it) => {
        const home = mapFootballDataTeam(it.homeTeam?.name || it.homeTeam?.shortName);
        const away = mapFootballDataTeam(it.awayTeam?.name || it.awayTeam?.shortName);
        const s = it.score?.fullTime;
        if (!home || !away || !Number.isInteger(s?.home) || !Number.isInteger(s?.away)) return null;
        return { home, away, hg: s.home, ag: s.away, date: Date.parse(it.utcDate) || 0 };
      })
      .filter(Boolean);
    console.log(`[refresh] folded in ${finished.length} finished 2026/27 match(es).`);
    return finished;
  } catch (err) {
    console.warn(`[refresh] current-season fetch failed (${err.message}); using season baseline.`);
    return [];
  }
}

// Blend the preseason rating (a prior) with current-season performance.
// Early season stays near the prior; it shifts as real games accumulate.
const PRIOR_GAMES = 6;
function blendRating(priorRating, current) {
  if (!current || !current.played) return priorRating;
  const seasonRating = ratingFromSeason(current); // top-flight scale, no penalty
  const w = current.played;
  return Math.round((priorRating * PRIOR_GAMES + seasonRating * w) / (PRIOR_GAMES + w));
}

// ---- Main -------------------------------------------------------------------
async function build() {
  const refresh = process.argv.includes("--refresh");
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  const season = seasonArg ? Number(seasonArg.split("=")[1]) : 2026;

  const nameFor = (raw) => CANON[raw] || null;
  const store = {};
  accumulate(parseCsv(path.join(SOURCE, "E0_2526.csv")), nameFor, store); // Premier League
  accumulate(parseCsv(path.join(SOURCE, "E1_2526.csv")), nameFor, store); // Championship

  const fixturesData = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  // Snapshot the previous intel so we only bump generatedAt on real changes
  // (keeps the scheduled refresh from committing timestamp-only diffs).
  const prevVersion = fixturesData.modelVersion || null;
  const prevTeams = fixturesData.teams ? JSON.stringify(fixturesData.teams) : null;
  const prevProbs = fixturesData.fixtures.map((fx) => JSON.stringify(fx.probabilities || null));

  const teamNames = new Set();
  for (const fx of fixturesData.fixtures) {
    teamNames.add(fx.homeTeam || fx.player1);
    teamNames.add(fx.awayTeam || fx.player2);
  }

  // Seed baseline ratings + form from 2025/26.
  const teams = {};
  for (const name of [...teamNames].sort()) {
    const season2526 = store[name];
    if (!season2526) throw new Error(`no 2025/26 source data for team "${name}"`);
    const promoted = PROMOTED.has(name);
    teams[name] = {
      rating: ratingFromSeason(season2526, { promoted }),
      form: last6Form(season2526.log),
      played: season2526.played,
      points: season2526.points,
      gf: season2526.gf,
      ga: season2526.ga,
      gd: season2526.gf - season2526.ga,
      basis: promoted ? "2025/26 Championship (promoted)" : "2025/26 Premier League",
    };
  }

  // Optional: fold current-season results into ratings + form.
  if (refresh) {
    const current = await fetchCurrentSeason(season);
    if (current.length) {
      const curStore = {};
      accumulate(current, (n) => (teamNames.has(n) ? n : null), curStore);
      for (const name of teamNames) {
        const cur = curStore[name];
        teams[name].rating = blendRating(teams[name].rating, cur);
        if (cur) {
          // last 6 across the season/division boundary, most recent last
          const merged = [...store[name].log, ...cur.log];
          teams[name].form = last6Form(merged);
          teams[name].playedCurrent = cur.played;
        }
      }
    }
  }

  // Wire probabilities into every fixture.
  for (const fx of fixturesData.fixtures) {
    const home = fx.homeTeam || fx.player1;
    const away = fx.awayTeam || fx.player2;
    fx.probabilities = matchProbabilities(
      teams[home].rating,
      teams[away].rating,
      teams[home].form,
      teams[away].form,
    );
  }

  fixturesData.modelVersion = MODEL_VERSION;
  fixturesData.forecast = {
    model: "prem-oracle in-house (home advantage + rating + form)",
    version: MODEL_VERSION,
    baseline: "football-data.co.uk 2025/26 (E0 + E1)",
  };
  fixturesData.teams = teams;

  // Only advance generatedAt when the forecast actually changed.
  const changed =
    prevVersion !== MODEL_VERSION ||
    prevTeams !== JSON.stringify(teams) ||
    fixturesData.fixtures.some((fx, i) => prevProbs[i] !== JSON.stringify(fx.probabilities));
  fixturesData.generatedAt = changed
    ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    : fixturesData.generatedAt;

  fs.writeFileSync(FIXTURES, JSON.stringify(fixturesData, null, 2) + "\n");

  const promotedSummary = [...PROMOTED]
    .map((n) => `${n} ${teams[n].rating} (${teams[n].form})`)
    .join(", ");
  console.log(`wrote ${path.relative(ROOT, FIXTURES)}`);
  console.log(`  model ${MODEL_VERSION} · ${fixturesData.fixtures.length} fixtures · ${Object.keys(teams).length} teams`);
  console.log(`  promoted: ${promotedSummary}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
