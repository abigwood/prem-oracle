#!/usr/bin/env node
// Schedule-integrity reconciliation.
//
// Keeps PL/ELC kickoff dates/times accurate against football-data.org (the same
// provider settlement already trusts) so players never depend on someone
// noticing a TV rearrangement. It runs on a bounded recurring CI schedule,
// matches fixtures by STABLE IDENTITY (home|away, not calendar date), updates
// ONLY date/time/startAt for verified reschedules, fails closed on anything
// incomplete/ambiguous/conflicting, and never touches results, IDs, picks,
// forecasts or any other field.
//
// The pure functions below carry the whole decision; main() is only IO. Tests
// import the pure functions.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapFootballDataTeam, feedForCompetition } from "../worker/src/results_feed.js";

const FEED_BASE = "https://api.football-data.org/v4/competitions";
export const FEEDS = { PL: "data/fixtures.json", ELC: "data/fixtures-elc.json" };

// --- Europe/London normalisation (correct across BST/GMT via the TZ database) -

// Minutes that Europe/London is ahead of UTC at instant `d` (60 in BST, 0 GMT).
export function londonOffsetMinutes(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return Math.round((asUTC - d.getTime()) / 60000);
}

// A provider UTC instant → the feed's { date, time, startAt } in Europe/London.
export function londonFromUtc(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const hh = String((+p.hour) % 24).padStart(2, "0");
  const off = londonOffsetMinutes(d);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${hh}:${p.minute}`;
  return { date, time, startAt: `${date}T${time}:00${offStr}` };
}

// --- Stable-identity index (home|away), ambiguity-aware ----------------------

// Collision-safe separator (a control char no club name contains).
const ID_SEP = "\u0000";
const idKey = (home, away) => `${home}${ID_SEP}${away}`;

// Index entries by home|away; a key seen more than once is AMBIGUOUS and is
// removed, so nothing is ever matched to a pair we cannot tell apart.
export function indexByIdentity(entries, homeOf, awayOf) {
  const map = new Map();
  const ambiguous = new Set();
  for (const e of entries) {
    const h = homeOf(e), a = awayOf(e);
    if (!h || !a) continue;                 // unmappable → not indexed
    const k = idKey(h, a);
    if (map.has(k)) { ambiguous.add(k); continue; }
    map.set(k, e);
  }
  for (const k of ambiguous) map.delete(k);
  return { map, ambiguous };
}

// --- The reconciliation decision (pure) --------------------------------------
//
// ours:     our feed fixtures for one competition (full list).
// provider: [{ home, away, utcKickoff, status }] already mapped to OUR names.
// Returns { updates, diagnostics, alerts } — updates carry only date/time/startAt.
export function reconcileFixtures(ours, provider, nowMs, { competition } = {}) {
  const diagnostics = { competition, considered: 0, reconciled: 0, unchanged: 0,
    unmatched: 0, ambiguous: 0, skippedPast: 0, skippedSettled: 0 };
  const alerts = [];
  const updates = [];

  // FAIL CLOSED on provider outage / empty payload: change nothing, alert loudly.
  if (!Array.isArray(provider) || provider.length === 0) {
    alerts.push({ level: "error", code: "provider_unavailable",
      message: `${competition}: no provider schedule data — made no changes` });
    return { updates, diagnostics, alerts };
  }

  const provIdx = indexByIdentity(provider, (e) => e.home, (e) => e.away);
  const ourIdx = indexByIdentity(ours, (f) => f.player1, (f) => f.player2);

  for (const f of ours) {
    // Only UPCOMING, unplayed fixtures. Never touch settled/played ones.
    if (f.result != null) { diagnostics.skippedSettled++; continue; }
    const startMs = Date.parse(f.startAt || f.date);
    if (Number.isFinite(startMs) && startMs <= nowMs) { diagnostics.skippedPast++; continue; }
    if (!f.player1 || !f.player2) continue;

    const key = idKey(f.player1, f.player2);
    // Our side ambiguous (two fixtures share home|away) → fail closed.
    if (provIdx.ambiguous.has(key) || ourIdx.ambiguous.has(key)) {
      diagnostics.ambiguous++;
      alerts.push({ level: "warn", code: "ambiguous_identity", id: f.id,
        message: `${f.id}: ${f.player1} v ${f.player2} is ambiguous in provider or feed — not reconciled` });
      continue;
    }
    diagnostics.considered++;
    const prov = provIdx.map.get(key);
    if (!prov) {
      diagnostics.unmatched++;
      alerts.push({ level: "warn", code: "unmatched", id: f.id,
        message: `${f.id}: ${f.player1} v ${f.player2} has no provider entry — kickoff unverified` });
      continue;
    }
    if (!prov.utcKickoff) {                  // present but no scheduled time → fail closed
      diagnostics.unmatched++;
      alerts.push({ level: "warn", code: "no_provider_time", id: f.id,
        message: `${f.id}: provider has no scheduled time yet` });
      continue;
    }
    const want = londonFromUtc(prov.utcKickoff);
    if (!want) {
      diagnostics.unmatched++;
      alerts.push({ level: "warn", code: "bad_provider_time", id: f.id,
        message: `${f.id}: provider time ${prov.utcKickoff} is unparseable` });
      continue;
    }
    if (f.date === want.date && f.time === want.time && f.startAt === want.startAt) {
      diagnostics.unchanged++;               // already correct → no diff (idempotent)
      continue;
    }
    diagnostics.reconciled++;
    updates.push({ id: f.id, from: { date: f.date, time: f.time, startAt: f.startAt }, to: want });
  }
  return { updates, diagnostics, alerts };
}

// --- Minimal deterministic feed edit (raw text; only date/startAt/time) -------

export function applyFeedUpdates(rawText, updates) {
  if (!updates.length) return { text: rawText, changedLines: 0 };
  const lines = rawText.split("\n");
  let changed = 0;
  for (const u of updates) {
    const i = lines.findIndex((l) => l.includes(`"id": "${u.id}"`));
    if (i < 0) throw new Error(`reconcile: id not found in feed: ${u.id}`);
    // Field order in the feed is id, date, startAt, time — verified before write.
    const expect = [["date", i + 1], ["startAt", i + 2], ["time", i + 3]];
    for (const [key, idx] of expect) {
      if (!lines[idx]?.includes(`"${key}":`)) {
        throw new Error(`reconcile: expected "${key}" at line ${idx + 1} for ${u.id}`);
      }
    }
    const set = (idx, key, val) => {
      const indent = lines[idx].match(/^\s*/)[0];
      const nl = `${indent}"${key}": "${val}",`;
      if (nl !== lines[idx]) { lines[idx] = nl; changed++; }
    };
    set(i + 1, "date", u.to.date);
    set(i + 2, "startAt", u.to.startAt);
    set(i + 3, "time", u.to.time);
  }
  return { text: lines.join("\n"), changedLines: changed };
}

// --- IO: fetch the provider schedule, mapped to our names --------------------

export async function fetchProviderSchedule(competition, token, fixtures, fetchImpl = fetch) {
  const feed = feedForCompetition(competition);
  if (!feed) throw new Error(`no provider feed for ${competition}`);
  const season = seasonOf(fixtures);
  const url = `${FEED_BASE}/${feed.feedCode}/matches?season=${season}`;
  const res = await fetchImpl(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`provider fetch ${res.status}`);
  const body = await res.json();
  const matches = Array.isArray(body.matches) ? body.matches : [];
  // Map provider names to OUR fixture names; drop anything already finished (we
  // only reconcile upcoming kickoffs) or unmappable.
  return matches
    .filter((m) => m.status !== "FINISHED" && m.status !== "CANCELLED")
    .map((m) => ({
      home: mapFootballDataTeam(m.homeTeam?.name || m.homeTeam?.shortName, competition),
      away: mapFootballDataTeam(m.awayTeam?.name || m.awayTeam?.shortName, competition),
      utcKickoff: m.utcDate || null,
      status: m.status,
    }))
    .filter((m) => m.home && m.away);
}

const seasonOf = (fixtures) => {
  const first = (fixtures || []).map((f) => Date.parse(f.startAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return Number.isFinite(first) ? new Date(first).getUTCFullYear() : new Date().getUTCFullYear();
};

// --- main (CI entrypoint) ----------------------------------------------------

async function main() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const nowMs = Date.now();
  let anyChange = false, hadError = false;
  const allAlerts = [];
  if (!token) { console.error("::error::FOOTBALL_DATA_TOKEN missing — reconciliation skipped"); process.exit(78); }

  for (const [competition, rel] of Object.entries(FEEDS)) {
    const path = join(root, rel);
    let feed;
    try { feed = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { console.error(`::error::cannot read ${rel}: ${e.message}`); hadError = true; continue; }
    let provider;
    try { provider = await fetchProviderSchedule(competition, token, feed.fixtures); }
    catch (e) {
      // Provider outage → fail closed for this competition, keep the other going.
      allAlerts.push({ level: "error", code: "provider_unavailable", message: `${competition}: ${e.message}` });
      hadError = true; continue;
    }
    const { updates, diagnostics, alerts } = reconcileFixtures(feed.fixtures, provider, nowMs, { competition });
    allAlerts.push(...alerts);
    console.log(`[${competition}] ${JSON.stringify(diagnostics)}`);
    if (updates.length) {
      const raw = readFileSync(path, "utf8");
      const { text, changedLines } = applyFeedUpdates(raw, updates);
      writeFileSync(path, text);
      anyChange = true;
      console.log(`[${competition}] reconciled ${updates.length} fixture(s), ${changedLines} lines:`);
      updates.forEach((u) => console.log(`  ${u.id}: ${u.from.startAt} -> ${u.to.startAt}`));
    }
  }

  // Bounded, actionable alert surface for upcoming fixtures still unverified.
  const actionable = allAlerts.filter((a) => a.code !== "unchanged").slice(0, 50);
  for (const a of actionable) console.log(`::${a.level === "error" ? "error" : "warning"}::${a.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["# Schedule reconciliation", "", anyChange ? "Feed updated." : "No kickoff changes.", ""];
    if (actionable.length) { lines.push("## Needs attention", ...actionable.map((a) => `- **${a.code}** ${a.message}`)); }
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
  }
  // Exit 0 on a clean run (changed or not); non-zero only on provider/IO failure
  // so the schedule job flags an outage without blocking on benign no-ops.
  process.exit(hadError ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
