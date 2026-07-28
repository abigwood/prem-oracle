const SEASON_START = new Date("2026-08-21T20:00:00+01:00");
const SEASON_START_DATE = "2026-08-21";
const APP_BUILD = "20260728a";
const API = window.PREM_API || null;
// Canonical public home of the web app. Inside the Capacitor shell the page is
// served from premoracle://localhost, so location.origin can never be used to
// build a link we hand to somebody else — it isn't reachable off-device, and
// WebKit's Web Share API rejects non-http(s) URLs outright.
const WEB_BASE = "https://abigwood.github.io/prem-oracle/";
const STORAGE = {
  uid: "prem_oracle_uid",
  name: "prem_oracle_name",
  picks: "prem_oracle_picks",
  leagues: "prem_oracle_leagues",
  leagueNames: "prem_oracle_league_names",
  activeLeague: "prem_oracle_active_league",
  recovery: "prem_oracle_recovery",
  pushToken: "prem_oracle_push_token",
};

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

// Native (Capacitor) builds get an `is-native` hook for shell-only styling —
// e.g. a tighter bottom-nav safe-area inset. The web build (window.Capacitor
// exists there too) never gets this class because isNativePlatform() is false.
if (isNativeApp()) {
  document.documentElement.classList.add("is-native");
}
const TEAM_MARKERS = {
  "AFC Bournemouth": { bg: "#DA291C", fg: "#FFFFFF", border: "#C8A657" },
  "Arsenal": { bg: "#E20613", fg: "#FFFFFF", border: "#9C824A" },
  "Aston Villa": { bg: "#670E36", fg: "#FFFFFF", border: "#95BFE5" },
  "Brentford": { bg: "#E30613", fg: "#FFFFFF", border: "#111111" },
  "Brighton & Hove Albion": { bg: "#0057B8", fg: "#FFFFFF", border: "#FFCD00" },
  "Chelsea": { bg: "#034694", fg: "#FFFFFF", border: "#DBA111" },
  "Coventry City": { bg: "#77BBE8", fg: "#102033", border: "#0B6FB3" },
  "Crystal Palace": { bg: "#1B458F", fg: "#FFFFFF", border: "#C4122E" },
  "Everton": { bg: "#003399", fg: "#FFFFFF", border: "#D1D5DB" },
  "Fulham": { bg: "#FFFFFF", fg: "#111111", border: "#CC0000" },
  "Hull City": { bg: "#F5A400", fg: "#111111", border: "#111111" },
  "Ipswich Town": { bg: "#0033A0", fg: "#FFFFFF", border: "#DE2C2F" },
  "Leeds United": { bg: "#FFFFFF", fg: "#1D428A", border: "#FFCD00" },
  "Liverpool": { bg: "#C8102E", fg: "#FFFFFF", border: "#00B2A9" },
  "Manchester City": { bg: "#6CABDD", fg: "#101820", border: "#1C2C5B" },
  "Manchester United": { bg: "#DA291C", fg: "#FFFFFF", border: "#FBE122" },
  "Newcastle United": { bg: "#241F20", fg: "#FFFFFF", border: "#D1D5DB" },
  "Nottingham Forest": { bg: "#DD0000", fg: "#FFFFFF", border: "#D1D5DB" },
  "Sunderland": { bg: "#E30613", fg: "#FFFFFF", border: "#111111" },
  "Tottenham Hotspur": { bg: "#FFFFFF", fg: "#132257", border: "#132257" },
};
// Official Premier League 3-letter club codes for all 2026/27 sides (incl. the
// promoted trio: Coventry COV, Hull HUL, Ipswich IPS). Used everywhere a team
// is abbreviated — badges, forecast strip labels, form guide.
const TEAM_CODES = {
  "Arsenal": "ARS",
  "Aston Villa": "AVL",
  "AFC Bournemouth": "BOU",
  "Brentford": "BRE",
  "Brighton & Hove Albion": "BHA",
  "Chelsea": "CHE",
  "Coventry City": "COV",
  "Crystal Palace": "CRY",
  "Everton": "EVE",
  "Fulham": "FUL",
  "Hull City": "HUL",
  "Ipswich Town": "IPS",
  "Leeds United": "LEE",
  "Liverpool": "LIV",
  "Manchester City": "MCI",
  "Manchester United": "MUN",
  "Newcastle United": "NEW",
  "Nottingham Forest": "NFO",
  "Sunderland": "SUN",
  "Tottenham Hotspur": "TOT",
};
// Real per-team forecast intel (rating + last-6 form) is loaded at runtime from
// the fixtures feed's `teams` block — see loadFixtures(). It is intentionally
// NOT hardcoded: when it is empty (or a team is missing) the UI shows neutral
// states rather than inventing numbers.
let teamIntel = {};
const VENUE_OUTLOOK = {
  "Emirates Stadium": { icon: "🌤", temp: 20, desc: "London late-summer outlook" },
  "MKM Stadium": { icon: "🌥", temp: 18, desc: "Hull coastal outlook" },
  "Hill Dickinson Stadium": { icon: "🌦", temp: 18, desc: "Liverpool dockside outlook" },
  "Portman Road": { icon: "🌤", temp: 19, desc: "Ipswich late-summer outlook" },
  "St James' Park": { icon: "🌦", temp: 17, desc: "Newcastle outlook" },
  "St. James' Park": { icon: "🌦", temp: 17, desc: "Newcastle outlook" },
  "City Ground": { icon: "🌤", temp: 19, desc: "Nottingham late-summer outlook" },
  "The City Ground": { icon: "🌤", temp: 19, desc: "Nottingham late-summer outlook" },
  "Villa Park": { icon: "🌤", temp: 19, desc: "Birmingham late-summer outlook" },
  "Gtech Community Stadium": { icon: "🌤", temp: 20, desc: "West London late-summer outlook" },
  "Amex Stadium": { icon: "🌥", temp: 18, desc: "Brighton coastal outlook" },
  "American Express Stadium": { icon: "🌥", temp: 18, desc: "Brighton coastal outlook" },
  "Coventry Building Society Arena": { icon: "🌤", temp: 19, desc: "Coventry late-summer outlook" },
  "Craven Cottage": { icon: "🌤", temp: 20, desc: "West London late-summer outlook" },
  "Old Trafford": { icon: "🌦", temp: 18, desc: "Manchester outlook" },
  "Anfield": { icon: "🌦", temp: 18, desc: "Liverpool outlook" },
  "Stadium of Light": { icon: "🌦", temp: 17, desc: "Sunderland coastal outlook" },
  "Elland Road": { icon: "🌥", temp: 18, desc: "Leeds outlook" },
  "Vitality Stadium": { icon: "🌤", temp: 19, desc: "Bournemouth coastal outlook" },
  "Etihad Stadium": { icon: "🌦", temp: 18, desc: "Manchester outlook" },
  "Selhurst Park": { icon: "🌤", temp: 20, desc: "South London late-summer outlook" },
  "Stamford Bridge": { icon: "🌤", temp: 20, desc: "West London late-summer outlook" },
  "Tottenham Hotspur Stadium": { icon: "🌤", temp: 20, desc: "North London late-summer outlook" },
};

let fixtures = [];
let currentView = "today";
let matchdayFilter = "all";
let picks = readJSON(STORAGE.picks, {});
let playerName = localStorage.getItem(STORAGE.name) || "";
let leagueCodes = readJSON(STORAGE.leagues, []);
let leagueNames = readJSON(STORAGE.leagueNames, {});
let activeLeague = localStorage.getItem(STORAGE.activeLeague) || leagueCodes[0] || "";
let leagueState = null;
let leagueTab = "matchday";
let selectedMatchday = null;
let roundState = null;
let matchdayPickerOpen = false;
let busyMatch = "";
let flashMessage = "";
let flashTone = "success";
let openScheduleDates = new Set();
let updateReloading = false;
let pendingUpdateReload = false;
// Custom Mix host Fixture Picker. Held outside the view functions because the
// picker is a full-screen layer over whichever tab the host opened it from.
let pickerOpen = false;
let pickerMatchweek = null;
let pickerSelection = new Set();
let pickerMode = "custom";
let pickerConfirmOpen = false;
let pickerBusy = false;
// Invite code from the launch URL (web query string). Mutable because native
// universal links deliver it later via the Capacitor appUrlOpen event.
let inviteCode = new URLSearchParams(location.search).get("league")?.toUpperCase() || "";

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function uid() {
  let value = localStorage.getItem(STORAGE.uid);
  if (!value) {
    value = `prem_${crypto.randomUUID?.() || `${Math.random().toString(36).slice(2)}_${Date.now()}`}`;
    localStorage.setItem(STORAGE.uid, value);
  }
  return value;
}

async function api(path, body) {
  if (!API) throw new Error("The shared league service is not connected yet.");
  const options = body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function registerPushToken(token) {
  if (!token?.value) return;
  localStorage.setItem(STORAGE.pushToken, token.value);
  if (!API) return;
  try {
    await api("/push-token", {
      uid: uid(),
      nickname: playerName,
      token: token.value,
      platform: window.Capacitor?.getPlatform?.() || "ios",
    });
  } catch {
    // Token registration is retried on the next native launch.
  }
}

async function loadFixtures(refresh = false) {
  try {
    let response = null;
    if (API) {
      response = await fetch(`${API}/fixtures?${refresh ? "refresh=1&" : ""}t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
    }
    if (!response?.ok) response = await fetch(`data/fixtures.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    fixtures = (data.fixtures || []).sort((a, b) =>
      (Date.parse(a.startAt || "") || 0) - (Date.parse(b.startAt || "") || 0) ||
      String(a.id).localeCompare(String(b.id))
    );
    teamIntel = (data.teams && typeof data.teams === "object") ? data.teams : {};
  } catch {
    fixtures = [];
    teamIntel = {};
  }
}

async function hydrateIdentity() {
  if (!API) return;
  try {
    const me = await api(`/me?uid=${encodeURIComponent(uid())}`);
    if (me.nickname && !playerName) {
      playerName = me.nickname;
      localStorage.setItem(STORAGE.name, playerName);
    }
    if (me.recovery) localStorage.setItem(STORAGE.recovery, me.recovery);
    if (Array.isArray(me.leagues)) {
      leagueCodes = [...new Set(me.leagues.filter(Boolean))];
      localStorage.setItem(STORAGE.leagues, JSON.stringify(leagueCodes));
      pruneStoredLeagueNames();
      if (!leagueCodes.includes(activeLeague)) setActiveLeague(leagueCodes[0] || "", false);
    }
    if (activeLeague) await loadLeagueState();
    await loadKnownLeagueNames();
    await syncUserPicks();
  } catch {
    // The PWA remains usable for cached fixtures and local picks while offline.
  }
}

async function syncUserPicks(replace = false) {
  if (!API) return;
  const response = await api(`/picks?uid=${encodeURIComponent(uid())}`);
  const serverPicks = response.picks || {};
  picks = replace ? serverPicks : { ...picks, ...serverPicks };
  localStorage.setItem(STORAGE.picks, JSON.stringify(picks));
}

function leagueSupportsRounds(state) {
  return !!state && !state.error && "currentMatchday" in state;
}

async function loadLeagueState() {
  if (!activeLeague || !API) { leagueState = null; roundState = null; return; }
  try {
    // `uid` asks the worker for this viewer's own Trophy Cabinet alongside the
    // table; older workers simply ignore it.
    leagueState = await api(`/state?code=${encodeURIComponent(activeLeague)}&uid=${encodeURIComponent(uid())}`);
    saveLeagueName(leagueState.code, leagueState.name);
  } catch (error) {
    roundState = null;
    if (/league not found/i.test(error.message)) {
      removeStoredLeague(activeLeague);
      if (activeLeague) return loadLeagueState();
      leagueState = null;
      return;
    }
    leagueState = { error: error.message, code: activeLeague };
    return;
  }
  if (leagueSupportsRounds(leagueState)) {
    if (selectedMatchday == null) selectedMatchday = leagueState.currentMatchday || 38;
    if (leagueTab === "matchday") await loadRoundState();
  } else {
    leagueTab = "season"; // Old worker cache: fall back to the season-only UI.
  }
}

async function loadRoundState() {
  if (!activeLeague || !API || selectedMatchday == null) { roundState = null; return; }
  try {
    roundState = await api(`/state?code=${encodeURIComponent(activeLeague)}&md=${selectedMatchday}`);
  } catch (error) {
    roundState = { error: error.message };
  }
}

async function loadKnownLeagueNames() {
  if (!API || !leagueCodes.length) return;
  const missingCodes = leagueCodes.filter((code) => !leagueNames[code] && code !== leagueState?.code);
  if (!missingCodes.length) return;
  const states = await Promise.allSettled(missingCodes.map((code) => api(`/state?code=${encodeURIComponent(code)}`)));
  states.forEach((result) => {
    if (result.status === "fulfilled") saveLeagueName(result.value.code, result.value.name);
  });
}

function saveLeagueName(code, name) {
  if (!code || !name) return;
  leagueNames = { ...leagueNames, [code]: name };
  localStorage.setItem(STORAGE.leagueNames, JSON.stringify(leagueNames));
}

function pruneStoredLeagueNames() {
  const nextNames = Object.fromEntries(Object.entries(leagueNames).filter(([code]) => leagueCodes.includes(code)));
  if (Object.keys(nextNames).length !== Object.keys(leagueNames).length) {
    leagueNames = nextNames;
    localStorage.setItem(STORAGE.leagueNames, JSON.stringify(leagueNames));
  }
}

function removeStoredLeague(code) {
  if (!code) return;
  leagueCodes = leagueCodes.filter((leagueCode) => leagueCode !== code);
  localStorage.setItem(STORAGE.leagues, JSON.stringify(leagueCodes));
  const { [code]: _removed, ...remainingNames } = leagueNames;
  leagueNames = remainingNames;
  localStorage.setItem(STORAGE.leagueNames, JSON.stringify(leagueNames));
  if (activeLeague === code) setActiveLeague(leagueCodes[0] || "", false);
}

function setActiveLeague(code, refresh = true) {
  activeLeague = code || "";
  selectedMatchday = null;
  roundState = null;
  if (activeLeague) localStorage.setItem(STORAGE.activeLeague, activeLeague);
  else localStorage.removeItem(STORAGE.activeLeague);
  if (refresh) loadLeagueState().then(render);
}

function saveLeague(code) {
  leagueCodes = [...new Set([...leagueCodes, code])];
  localStorage.setItem(STORAGE.leagues, JSON.stringify(leagueCodes));
  setActiveLeague(code, false);
}

function londonDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dateLabel(value, long = false) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short",
    year: long ? "numeric" : undefined,
  }).format(new Date(`${value}T12:00:00+01:00`));
}

function matchTime(match) {
  if (match.startAt) {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/London",
    }).format(new Date(match.startAt));
  }
  return match.time || "Time TBC";
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

function icsLine(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function calendarHref(match) {
  if (!match.startAt) return "";
  const start = new Date(match.startAt);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + 115 * 60000);
  const title = `${match.player1} v ${match.player2}`;
  const pick = picks[match.id];
  const description = [
    match.round || `Matchweek ${match.matchday}`,
    match.venue,
    match.broadcaster ? `UK TV: ${match.broadcaster}` : "",
    pick && validScore(pick.p1) && validScore(pick.p2)
      ? `Your prediction: ${match.player1} ${pick.p1}-${pick.p2} ${match.player2}`
      : "",
    "Prem Oracle fixture",
  ].filter(Boolean).join(" · ");
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PremOracle//PremierLeague202627//EN",
    "BEGIN:VEVENT",
    `UID:${icsLine(match.id)}@premoracle`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsLine(`⚽ ${title}`)}`,
    `DESCRIPTION:${icsLine(description)}`,
    `LOCATION:${icsLine(match.venue || "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
}

// WKWebView silently drops `<a download>` on a data: URL — the click dispatches,
// nothing navigates, nothing errors. Natively we point the link at the Worker's
// text/calendar endpoint instead: Capacitor hands off-origin top-level
// navigations to the system, and iOS answers a text/calendar response with its
// own "Add to Calendar" sheet. The web build keeps the data: URL download.
function calendarLink(match) {
  const pick = picks[match.id];
  if (isNativeApp() && API && match.id && match.startAt) {
    const query = pick && validScore(pick.p1) && validScore(pick.p2) ? `?pick=${pick.p1}-${pick.p2}` : "";
    return { href: `${API}/ics/${encodeURIComponent(match.id)}${query}`, download: "" };
  }
  const href = calendarHref(match);
  return href ? { href, download: calendarFileName(match) } : { href: "", download: "" };
}

function calendarFileName(match) {
  return `${match.player1}-v-${match.player2}.ics`
    .replace(/&/g, "and")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function calendarDayDiff(fromKey, toKey) {
  const utcMidday = (key) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.max(0, Math.round((utcMidday(toKey) - utcMidday(fromKey)) / 86400000));
}

function fixtureDayDiff(match, now = new Date()) {
  const start = match?.date || londonDateKey(new Date(match?.startAt || Date.now()));
  return calendarDayDiff(londonDateKey(now), start);
}

function daysToStart(now = new Date()) {
  if (now >= SEASON_START) return "The Premier League season is under way";
  const today = londonDateKey(now);
  if (today >= SEASON_START_DATE) return "Premier League starts today";
  const days = calendarDayDiff(today, SEASON_START_DATE);
  return `${countPhrase(days, days === 1 ? "day" : "days")} until Arsenal v Coventry`;
}

function playerInitial() {
  return (playerName.trim()[0] || "?").toUpperCase();
}

// A number and the word it counts must break as one unit — "38" stranded at the
// end of a line above "Matchweeks" reads as a different number entirely.
function countPhrase(count, word) {
  return `<span class="nowrap">${count} ${escapeHTML(word)}</span>`;
}

function hero() {
  return `<section class="hero">
    <span class="eyebrow">Premier League 2026/27 · ${countPhrase(38, "Matchweeks")}</span>
    <h1>Predict the scores.</h1>
    <p>All ${countPhrase(380, "fixtures")}. Private leagues. Picks lock at kick-off.</p>
    <div class="countdown">⚽ <span>${daysToStart()}</span></div>
  </section>`;
}

function installNotice() {
  // Inside the Capacitor native shell there is nothing to "add to home screen".
  // (The web build also exposes window.Capacitor, so gate on isNativePlatform.)
  if (window.Capacitor?.isNativePlatform?.()) return "";
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return "";
  return `<div class="notice install-notice"><span class="notice-icon">📱</span><div><strong>Home Screen app</strong><p>On iPhone: Safari, Share, Add to Home Screen.</p></div></div>`;
}

function fixtureNotice() {
  return `<div class="notice">
    <span class="notice-icon">ℹ️</span>
    <div><strong>Fixtures loaded</strong><p>Dates and TV slots can move.</p></div>
  </div>`;
}

function validScore(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 9;
}

function closedStatus(match) {
  return ["postponed", "abandoned", "cancelled", "live", "in progress", "completed", "complete", "finished"].includes(String(match.status).toLowerCase());
}

function matchOpen(match) {
  if (!match.player1 || !match.player2 || match.result || closedStatus(match)) return false;
  if (match.startAt) return Date.now() < Date.parse(match.startAt);
  return false;
}

function resultText(match) {
  const result = Array.isArray(match.result) ? match.result : match.result && [match.result.p1, match.result.p2];
  if (result?.length === 2) return `Final: ${result[0]}-${result[1]}`;
  if (["postponed", "cancelled", "abandoned"].includes(String(match.status).toLowerCase())) return "Void";
  if (match.status === "live") return "Result pending";
  if (match.startAt && Date.now() >= Date.parse(match.startAt)) return "Picks locked";
  return "Predictions open";
}

function pickStatus(match, pick, open) {
  if (!pick) return "";
  const status = open
    ? "Change it anytime before kick-off. Hidden from your league until the match starts."
    : "Locked at kick-off. Your league sees picks only after the reveal window opens.";
  return `<div class="pick-lock-card">
    <div class="pick-lock-icon" aria-hidden="true">🔒</div>
    <div class="pick-lock-main">
      <span class="pick-lock-label">Your pick is locked in</span>
      <strong>${escapeHTML(match.player1)} <b>${pick.p1}-${pick.p2}</b> ${escapeHTML(match.player2)}</strong>
      <p>${status}</p>
    </div>
  </div>`;
}

function teamInitials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join("").slice(0, 3).toUpperCase();
}

// Official PL 3-letter code, falling back to derived initials for any team not
// in the map (e.g. a future opponent), so a code is always shown.
function teamCode(name) {
  return TEAM_CODES[name] || teamInitials(name);
}

function teamBadge(name) {
  const marker = TEAM_MARKERS[name] || { bg: "#ECFFF5", fg: "#38003C", border: "#B9F8D8" };
  const style = `--team-bg:${marker.bg};--team-fg:${marker.fg};--team-border:${marker.border};`;
  return `<span class="team-crest" style="${style}" aria-hidden="true">${escapeHTML(teamCode(name))}</span>`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Background of the .oracle-prob card; contrast is measured against this so the
// bars and percentage numbers stay readable where they actually sit.
const PROB_CARD_BG = "#fbfcfe";

function hexToRgb(hex) {
  const clean = String(hex).replace("#", "");
  const full = clean.length === 3 ? clean.replace(/./g, (ch) => ch + ch) : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex({ r, g, b }) {
  return "#" + [r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("");
}

function channelLuminance(value) {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function darken(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r * (1 - factor), g: g * (1 - factor), b: b * (1 - factor) });
}

// Darkens a colour just enough to clear the target contrast against the card,
// so a team's own colour can be reused for text/outlines without washing out.
function readableColour(hex, minRatio, background = PROB_CARD_BG) {
  let out = hex;
  for (let i = 0; i < 12 && contrastRatio(out, background) < minRatio; i++) out = darken(out, 0.12);
  return out;
}

// Resolves how one team's likelihood segment should be painted. White/very light
// kits (Fulham, Leeds, Spurs) fall back to their border/accent colour, or keep
// the light fill with a 1px inset outline so the segment never disappears.
function teamSegmentColours(marker) {
  const bgTooLight = contrastRatio(marker.bg, PROB_CARD_BG) < 1.6;
  let fill = marker.bg;
  let accent = marker.bg;
  if (bgTooLight) {
    accent = marker.border;
    if (contrastRatio(marker.border, PROB_CARD_BG) >= 2) fill = marker.border;
  }
  const needsOutline = contrastRatio(fill, PROB_CARD_BG) < 1.6;
  const outline = readableColour(accent, 3);
  const text = readableColour(needsOutline ? outline : fill, 4.5);
  return { fill, needsOutline, outline, text };
}

// The forecast is real-data-only. There is deliberately no client-side
// probability fallback: a fixture without probabilities renders as unavailable.
function hasProbabilities(match) {
  return Array.isArray(match.probabilities) &&
    match.probabilities.length === 3 &&
    match.probabilities.every((value) => Number.isFinite(value));
}

const PROB_FALLBACK_MARKER = { bg: "#ECFFF5", fg: "#38003C", border: "#B9F8D8" };

function segmentFillStyle(segment) {
  return `background:${segment.fill}${segment.needsOutline ? `;box-shadow:inset 0 0 0 1px ${segment.outline}` : ""}`;
}

function probabilityStrip(match) {
  if (!hasProbabilities(match)) {
    return `<div class="oracle-prob oracle-prob-empty" aria-label="Oracle forecast unavailable">
      <div class="prob-title"><span>Oracle forecast</span></div>
      <div class="prob-unavailable">Forecast unavailable</div>
    </div>`;
  }
  const [home, draw, away] = match.probabilities;
  const columns = `${home}fr ${draw}fr ${away}fr`;
  const homeSeg = teamSegmentColours(TEAM_MARKERS[match.player1] || PROB_FALLBACK_MARKER);
  const awaySeg = teamSegmentColours(TEAM_MARKERS[match.player2] || PROB_FALLBACK_MARKER);
  return `<div class="oracle-prob" aria-label="Oracle forecast: ${escapeHTML(match.player1)} ${home}%, draw ${draw}%, ${escapeHTML(match.player2)} ${away}%">
    <div class="prob-title"><span>Oracle forecast</span></div>
    <div class="prob-values" style="grid-template-columns:${columns}">
      <span class="home" style="color:${homeSeg.text}">${home}%</span>
      <span class="draw">${draw}%</span>
      <span class="away" style="color:${awaySeg.text}">${away}%</span>
    </div>
    <div class="prob-rail" style="grid-template-columns:${columns}">
      <i class="home" style="${segmentFillStyle(homeSeg)}"></i>
      <i class="draw"></i>
      <i class="away" style="${segmentFillStyle(awaySeg)}"></i>
    </div>
    <div class="prob-labels"><span>${escapeHTML(teamCode(match.player1))}</span><span>Draw</span><span>${escapeHTML(teamCode(match.player2))}</span></div>
  </div>`;
}

function weatherIntel(match) {
  if (fixtureDayDiff(match) > 7) return null;
  if (match.weather) return match.weather;
  const outlook = VENUE_OUTLOOK[match.venue];
  if (!outlook) return null;
  return { ...outlook, provisional: true };
}

function matchIntelStrip(match) {
  const weather = weatherIntel(match);
  const weatherTitle = weather
    ? `${weather.desc}${weather.provisional ? "; live forecast nearer kick-off" : ""}`
    : "";
  return `<div class="match-intel-strip">
    ${weather ? `<span class="intel-pill weather-pill" title="${escapeHTML(weatherTitle)}">${weather.icon} ${weather.temp}°C <em>${weather.provisional ? "Outlook" : "Forecast"}</em></span>` : ""}
    ${match.venue ? `<span class="intel-pill venue-pill">📍 ${escapeHTML(match.venue)}</span>` : ""}
  </div>`;
}

function formGuide(match) {
  return `<div class="form-guide" aria-label="Recent form guide">
    ${teamFormRow(match.player1)}
    ${teamFormRow(match.player2)}
  </div>`;
}

// A valid form string is exactly six W/D/L results (most recent last). Anything
// else is treated as missing so we show a neutral em-dash, never a placeholder.
function validForm(form) {
  return typeof form === "string" && /^[WDL]{6}$/.test(form) ? form : "";
}

function teamFormRow(team) {
  const form = validForm(teamIntel[team]?.form);
  const dots = form
    ? [...form].map((result) => `<span class="form-dot ${formClass(result)}">${escapeHTML(result)}</span>`).join("")
    : `<span class="form-dot unknown form-dot-empty" aria-label="Form unavailable">—</span>`;
  return `<div class="form-row">
    <div class="form-team"><strong>${escapeHTML(teamCode(team))}</strong></div>
    <div class="form-dots">${dots}</div>
  </div>`;
}

function formClass(result) {
  return result === "W" ? "win" : result === "D" ? "draw" : result === "L" ? "loss" : "unknown";
}

function scorePicker(match, open) {
  if (!open) return "";
  const pick = picks[match.id];
  const p1 = pick?.p1 ?? 0;
  const p2 = pick?.p2 ?? 0;
  const saving = busyMatch === match.id;
  return `<div class="score-window" data-score-window="${match.id}">
    <div class="score-picker" aria-label="Choose score for ${escapeHTML(match.player1)} against ${escapeHTML(match.player2)}">
      <div class="score-step">
        <button type="button" data-score-step="p1,-1" aria-label="Decrease ${escapeHTML(match.player1)} score" ${saving ? "disabled" : ""}>−</button>
        <span class="score-value" data-score-value="p1">${p1}</span>
        <button type="button" data-score-step="p1,1" aria-label="Increase ${escapeHTML(match.player1)} score" ${saving ? "disabled" : ""}>＋</button>
      </div>
      <span class="score-dash">–</span>
      <div class="score-step">
        <button type="button" data-score-step="p2,-1" aria-label="Decrease ${escapeHTML(match.player2)} score" ${saving ? "disabled" : ""}>−</button>
        <span class="score-value" data-score-value="p2">${p2}</span>
        <button type="button" data-score-step="p2,1" aria-label="Increase ${escapeHTML(match.player2)} score" ${saving ? "disabled" : ""}>＋</button>
      </div>
    </div>
    <button class="lock-pick-button" type="button" data-lock-score ${saving ? "disabled" : ""}>${saving ? "Saving..." : pick ? "Update pick" : "Lock it in"}</button>
    ${pick ? "" : `<div class="pick-edit-hint">Hidden from your mates until kick-off, then everyone reveals at once.</div>`}
  </div>`;
}

function matchCard(match) {
  const pick = picks[match.id];
  const open = matchOpen(match);
  const calendar = calendarLink(match);
  return `<article class="match-card" data-match-card="${match.id}">
    ${calendar.href ? `<a class="fixture-calendar" href="${calendar.href}"${calendar.download ? ` download="${calendar.download}"` : ""} aria-label="Add ${escapeHTML(match.player1)} v ${escapeHTML(match.player2)} to calendar">＋</a>` : ""}
    <div class="match-meta">
      <span class="tour-badge">Matchweek ${match.matchday}</span>
      <span>${matchTime(match)}${match.broadcaster ? ` · ${escapeHTML(match.broadcaster)}` : ""}</span>
    </div>
    ${matchIntelStrip(match)}
    <div class="players football-teams">
      <div class="player-row">${teamBadge(match.player1)}<span class="player-name">${escapeHTML(match.player1)}</span><em>Home</em></div>
      <div class="versus">VS</div>
      <div class="player-row">${teamBadge(match.player2)}<span class="player-name">${escapeHTML(match.player2)}</span><em>Away</em></div>
    </div>
    ${probabilityStrip(match)}
    ${formGuide(match)}
    <div class="pick-zone">
      <div class="pick-label">${resultText(match)}</div>
      ${pick ? pickStatus(match, pick, open) : ""}
      ${scorePicker(match, open)}
    </div>
  </article>`;
}

function groupedMatchdays(list) {
  return [...new Set(list.map((fixture) => fixture.matchday))].map((matchday) => {
    const matches = list.filter((fixture) => fixture.matchday === matchday);
    const key = `md-${matchday}`;
    const firstDate = matches[0]?.date;
    const open = openScheduleDates.has(key) || (!openScheduleDates.size && matchday === nextMatchday());
    return `<details class="day-card" data-day-card="${key}" ${open ? "open" : ""}>
      <summary>
        <div><strong>Matchweek ${matchday}</strong><span>${firstDate ? dateLabel(firstDate, true) : ""}</span></div>
        <span>${countPhrase(matches.length, matches.length === 1 ? "fixture" : "fixtures")}</span>
      </summary>
      <div class="day-body">${matches.map(matchCard).join("")}</div>
    </details>`;
  }).join("");
}

function nextMatchday() {
  const now = Date.now();
  const upcoming = fixtures.find((fixture) => Date.parse(fixture.startAt || "") > now);
  return upcoming?.matchday || fixtures[0]?.matchday || 1;
}

// --- Custom Mix ------------------------------------------------------------
// From the member's side Custom Mix is meant to be invisible: the Next tab
// simply shows fewer cards. Everything here is a read of the league state the
// app already holds, so a league that isn't running Custom Mix is untouched.

function isLeagueHost() {
  return !!leagueState && !leagueState.error && leagueState.owner === uid();
}

function customMixActive() {
  return !!leagueState && !leagueState.error && leagueState.customMix === true;
}

// The slate governing a matchweek, or null while the host has yet to set one.
function slateForMatchweek(matchweek) {
  const slate = leagueState?.currentSlate;
  return slate && slate.matchweek === matchweek ? slate : null;
}

function hostNickname() {
  return (leagueState?.table || []).find((row) => row.uid === leagueState?.owner)?.nick || "your host";
}

// True while a Custom Mix league is waiting on its host for this matchweek.
function awaitingSlate(matchweek) {
  return customMixActive() && leagueState?.currentMatchday === matchweek && !slateForMatchweek(matchweek);
}

function slateNotice(matchweek) {
  if (!awaitingSlate(matchweek)) return "";
  if (isLeagueHost()) {
    return `<div class="slate-notice slate-notice-host">
      <p>You pick this week's fixtures for ${escapeHTML(leagueState.name)}.</p>
      <button class="primary wide" type="button" data-open-picker="${matchweek}">Pick fixtures for Matchweek ${matchweek}</button>
    </div>`;
  }
  return `<div class="slate-notice"><p>Waiting for ${escapeHTML(hostNickname())} to set this week's fixtures</p></div>`;
}

function slateSummary(slate) {
  if (!slate || slate.mode !== "custom") return "";
  return `<p class="slate-summary">Custom Mix · ${countPhrase(slate.count, slate.count === 1 ? "fixture" : "fixtures")} this week</p>`;
}

function todayView() {
  const today = londonDateKey();
  let dayMatches = fixtures.filter((fixture) => fixture.date === today);
  let title = "Today's predictions";
  let subtitle = dateLabel(today, true);
  if (!dayMatches.length) {
    const md = nextMatchday();
    dayMatches = fixtures.filter((fixture) => fixture.matchday === md);
    title = md === 1 ? "Opening matchweek" : "Next matchweek";
    subtitle = `Matchweek ${md}`;
  }
  const homeMatchday = dayMatches[0]?.matchday ?? nextMatchday();
  const slate = slateForMatchweek(homeMatchday);
  const waiting = awaitingSlate(homeMatchday);
  if (slate) {
    const chosen = new Set(slate.fixtureIds.map(String));
    dayMatches = dayMatches.filter((fixture) => chosen.has(String(fixture.id)));
  }
  const roundFixtures = slate
    ? fixtures.filter((fixture) => slate.fixtureIds.map(String).includes(String(fixture.id)))
    : fixtures.filter((fixture) => fixture.matchday === homeMatchday);
  const pickedCount = roundFixtures.filter((fixture) => picks[fixture.id]).length;
  const progress = roundFixtures.length && !waiting
    ? `<p class="pick-progress">You've picked ${pickedCount} of ${roundFixtures.length}</p>`
    : "";
  return `${hero()}${installNotice()}${inviteCode && !leagueCodes.includes(inviteCode) ? `<div class="notice invite-notice"><span class="notice-icon">🏆</span><div><strong>League invitation: ${inviteCode}</strong><p>Open the League tab to join.</p></div></div>` : ""}${fixtureNotice()}
    <div class="section-head">
      <div><span class="eyebrow">Next up · <span class="nowrap">Game ${homeMatchday} of 38</span></span><h2>${title}</h2><p>${subtitle}</p>${slateSummary(slate)}${progress}</div>
    </div>
    ${slateNotice(homeMatchday)}
    ${waiting ? "" : dayMatches.map(matchCard).join("")}`;
}

function scheduleView() {
  const filtered = fixtures.filter((fixture) => matchdayFilter === "all" || String(fixture.matchday) === String(matchdayFilter));
  const matchdays = [...new Set(fixtures.map((fixture) => fixture.matchday))];
  return `${hero()}
    <div class="section-head"><div><span class="eyebrow">Full season</span><h2>Prediction schedule</h2></div></div>
    <div class="filters">
      <button class="filter${matchdayFilter === "all" ? " active" : ""}" data-filter="all">All rounds</button>
      ${matchdays.map((value) => `<button class="filter${String(matchdayFilter) === String(value) ? " active" : ""}" data-filter="${value}">MW ${value}</button>`).join("")}
    </div>
    ${groupedMatchdays(filtered)}`;
}

function picksView() {
  const picked = fixtures.filter((fixture) => picks[fixture.id]);
  return `<div class="section-head"><div><span class="eyebrow">${playerName || "Your profile"}</span><h2>My predictions</h2><p>Synced securely when online; cached on this device</p></div></div>
    <div class="stats-grid">
      <div class="stat"><b>${picked.length}</b><span>Picks made</span></div>
      <div class="stat"><b>${fixtures.length}</b><span>Total fixtures</span></div>
      <div class="stat"><b>${fixtures.length - picked.length}</b><span>To pick</span></div>
    </div>
    ${picked.length ? groupedMatchdays(picked) : `<div class="empty"><strong>No picks yet</strong><p>Choose a scoreline on any fixture before kick-off.</p></div>`}`;
}

function leagueSwitcher() {
  if (!leagueCodes.length) return "";
  const namedLeagueCodes = leagueCodes.filter((code) => (leagueState?.code === code ? leagueState.name : leagueNames[code]));
  if (!namedLeagueCodes.length) return "";
  return `<div class="filters league-switcher">${namedLeagueCodes.map((code) => {
    const name = leagueState?.code === code ? leagueState.name : leagueNames[code];
    return `<button class="filter league-filter${activeLeague === code ? " active" : ""}" data-league="${code}"><span class="league-filter-name">${escapeHTML(name)}</span></button>`;
  }).join("")}</div>`;
}

function revealCard(reveal) {
  const result = reveal.voided ? "Void" : reveal.settled ? `${reveal.result.p1}-${reveal.result.p2}` : "In play / awaiting result";
  return `<div class="reveal-card">
    <div class="reveal-head"><strong>${escapeHTML(reveal.player1)} v ${escapeHTML(reveal.player2)}</strong><span>${result}</span></div>
    <div class="reveal-picks">${reveal.picks.map((pick) =>
      `<div><span>${escapeHTML(pick.nick)}</span><b>${pick.asleep ? "-" : `${pick.p1}-${pick.p2}`}</b><em>${reveal.voided || !pick.settled ? "" : `+${pick.pts}`}</em></div>`
    ).join("")}</div>
  </div>`;
}

function movementBadge(row) {
  const value = Number(row.movement || 0);
  if (value > 0) return `<span class="movement movement-up" aria-label="Up ${value} place${value === 1 ? "" : "s"}">▲</span>`;
  if (value < 0) return `<span class="movement movement-down" aria-label="Down ${Math.abs(value)} place${Math.abs(value) === 1 ? "" : "s"}">▼</span>`;
  return `<span class="movement movement-flat" aria-label="No position change">-</span>`;
}

function leagueTableText(state) {
  const updated = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  }).format(new Date());
  const rows = (state.table || []).map((row, index) => {
    const rank = row.rank || index + 1;
    const movement = Number(row.movement || 0);
    const marker = movement > 0 ? `▲${movement}` : movement < 0 ? `▼${Math.abs(movement)}` : "-";
    return `${rank}. ${row.nick} ${marker} - ${row.pts} pts (${row.exact} exact)${row.wins ? ` 🏆x${row.wins}` : ""}`;
  });
  return `Prem Oracle league table - ${state.name}\nUpdated ${updated}\n\n${rows.join("\n")}\n\nJoin on the web or in the app with code ${state.code}`;
}

function winnerNames(round) {
  return (round?.winners || [])
    .map((winnerUid) => (round.table || []).find((row) => row.uid === winnerUid)?.nick)
    .filter(Boolean)
    .join(" & ");
}

function roundShareText(state, round) {
  const head = round.complete
    ? `🏆 Matchweek ${round.matchday}: won by ${winnerNames(round) || "nobody"}`
    : `🏆 Matchweek ${round.matchday} · in progress`;
  const rows = (round.table || []).map((row, index) => `${row.rank || index + 1}. ${row.nick} - ${row.pts} pts (${row.exact} exact)`);
  return `${head}\n\n${rows.join("\n")}\n\nJoin on the web or in the app with code ${state.code}`;
}

function roundToggle() {
  const md = selectedMatchday || leagueState?.currentMatchday || 1;
  return `<div class="round-toggle">
    <button type="button" class="round-seg${leagueTab === "matchday" ? " active" : ""}" data-round-tab="matchday">Matchweek ${md} ▾</button>
    <button type="button" class="round-seg${leagueTab === "season" ? " active" : ""}" data-round-tab="season">Season</button>
  </div>`;
}

function matchdayPicker() {
  if (!matchdayPickerOpen) return "";
  const md = selectedMatchday || 1;
  return `<div class="md-picker" role="group" aria-label="Choose matchweek">${Array.from({ length: 38 }, (_, i) => i + 1).map((n) =>
    `<button type="button" class="md-cell${n === md ? " active" : ""}" data-round-md="${n}">${n}</button>`).join("")}</div>`;
}

function fixtureHasResult(match) {
  const result = match?.result;
  if (Array.isArray(result)) return result.length === 2 && result.every((value) => value != null);
  return result?.p1 != null && result?.p2 != null;
}

function seasonBanner(state) {
  const played = state.currentMatchday == null ? 38 : Math.max(0, state.currentMatchday - 1);
  const currentMatchdayHasResults = state.currentMatchdayHasResults ||
    fixtures.some((fixture) => fixture.matchday === state.currentMatchday && fixtureHasResult(fixture));
  const detail = currentMatchdayHasResults && state.currentMatchday != null
    ? `Matchweek ${state.currentMatchday} in progress`
    : played === 0 ? `starts Matchweek ${state.currentMatchday || 1}` : `after Matchweek ${played} of 38`;
  return `<div class="round-banner"><strong>Season 2026/27</strong><span>${detail}</span></div>`;
}

// Slate line under a matchweek banner, so a curated week is always legible as
// one — and a full card never grows a label it doesn't need.
function roundSlateLine(round) {
  if (round?.slate?.mode !== "custom") return "";
  const count = round.slate.count;
  return `<span class="round-slate">Custom Mix · ${countPhrase(count, count === 1 ? "fixture" : "fixtures")}</span>`;
}

const PLACE_NUMBER = { gold: "1", silver: "2", bronze: "3" };

// One rostrum step. A shared place puts every name on the same widened step —
// there is no second step to demote anyone to, because the podium rules never
// award the place below a tie.
function podiumStep(place, entries) {
  return `<div class="podium-step podium-step-${place}${entries.length > 1 ? " podium-step-shared" : ""}">
    <div class="podium-label">
      <span class="podium-medal" aria-hidden="true">${PLACE_EMOJI[place]}</span>
      ${entries.map((entry) => `<span class="podium-name">${escapeHTML(entry.nick)}</span>`).join("")}
      <span class="podium-points">${countPhrase(entries[0].pts, "pts")}</span>
    </div>
    <div class="podium-block"><span>${PLACE_NUMBER[place]}</span></div>
  </div>`;
}

// The weekly podium as a three-step rostrum: winner on the tallest middle step,
// second to its left, third to its right. Steps are emitted gold-first so the
// reading order matches the result, and ordered visually in CSS. A place nobody
// reached simply has no step, so a two-player league renders two.
function podiumSteps(round) {
  const podium = round?.podium || [];
  if (!podium.length) return "";
  const steps = ["gold", "silver", "bronze"]
    .map((place) => [place, podium.filter((entry) => entry.place === place)])
    .filter(([, entries]) => entries.length)
    .map(([place, entries]) => podiumStep(place, entries))
    .join("");
  return `<div class="podium-steps" role="group" aria-label="Matchweek podium">${steps}</div>`;
}

function roundBanner(round) {
  const md = round.matchday;
  if (round.complete) {
    const names = winnerNames(round);
    return `<div class="round-banner is-success"><strong>Matchweek ${md} complete — won by ${names ? escapeHTML(names) : "nobody"} 🏆</strong><span><span class="nowrap">Game ${md} of 38 ·</span>all fixtures settled</span>${roundSlateLine(round)}${podiumSteps(round)}</div>`;
  }
  if (!round.status || round.status === "in progress") {
    return `<div class="round-banner"><strong><span class="nowrap">Game ${md} of 38 ·</span>in progress</strong>${roundSlateLine(round)}</div>`;
  }
  return `<div class="round-banner is-pending"><strong><span class="nowrap">Game ${md} of 38 ·</span>${escapeHTML(round.status)}</strong>${roundSlateLine(round)}</div>`;
}

function roundTableHtml(round) {
  const awards = new Map((round.complete ? round.podium || [] : []).map((entry) => [entry.uid, entry.place]));
  return `<table class="table round-standings"><thead><tr><th>Player</th><th>Pts</th><th>Exact</th></tr></thead>
    <tbody>${(round.table || []).map((row, index) => {
      const place = awards.get(row.uid);
      const medal = place ? ` <span class="crown" aria-label="Matchweek ${place}">${PLACE_EMOJI[place]}</span>` : "";
      return `<tr><td>${row.rank || index + 1}. ${escapeHTML(row.nick)}${medal}</td><td>${row.pts}</td><td>${row.exact}</td></tr>`;
    }).join("")}</tbody></table>`;
}

function seasonTableHtml(state, isOwner, withWins) {
  return `<table class="table league-table"><thead><tr><th>Player</th><th></th><th>Pts</th><th>Exact</th>${withWins ? `<th class="wins-col" aria-label="Weekly wins">🏆</th>` : ""}${isOwner ? "<th></th>" : ""}</tr></thead>
    <tbody>${(state.table || []).map((row, index) =>
      `<tr><td>${row.rank || index + 1}. ${escapeHTML(row.nick)}</td><td>${movementBadge(row)}</td><td>${row.pts}</td><td>${row.exact}</td>${withWins ? `<td class="wins-col">${row.wins || 0}</td>` : ""}${isOwner ? `<td class="kick-cell">${row.uid && row.uid !== state.owner ? `<button class="kick-btn" type="button" data-kick-league="${state.code}" data-kick-uid="${escapeHTML(row.uid)}" aria-label="Remove ${escapeHTML(row.nick)}">×</button>` : ""}</td>` : ""}</tr>`
    ).join("")}</tbody></table>`;
}

function leagueRevealsHtml(state) {
  return (state.reveals || []).length
    ? `<h3>Latest reveals</h3>${state.reveals.slice(0, 8).map(revealCard).join("")}`
    : `<p class="muted">Picks reveal here after kick-off.</p>`;
}

function whatsappUrlFor(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// A link a mate can actually open. On the web that is wherever this copy of the
// app is hosted; in the native shell it has to be the public site, which also
// universal-links straight back into the app.
function inviteLinkFor(code) {
  const base = isNativeApp() ? WEB_BASE : `${location.origin}${location.pathname}`;
  return `${base}?league=${code}`;
}

// Native shells go through @capacitor/share (a real UIActivityViewController).
// navigator.share exists inside WKWebView but rejects with a bare TypeError for
// anything it dislikes — notably our premoracle:// URLs — and that rejection is
// invisible to the user. The web build keeps using navigator.share unchanged.
async function openShareSheet({ title, text, url }) {
  if (isNativeApp()) {
    const share = window.Capacitor?.Plugins?.Share;
    if (share) {
      await share.share({ title, text, url, dialogTitle: title });
      return true;
    }
  }
  if (navigator.share) {
    await navigator.share(url ? { title, text, url } : { title, text });
    return true;
  }
  return false;
}

// Share, and fall back to the WhatsApp web hand-off if the sheet is unavailable
// or fails. A user dismissing the sheet is not a failure — it must not then
// bounce them into WhatsApp.
async function shareOrWhatsApp({ title, text, url }) {
  try {
    if (await openShareSheet({ title, text, url })) return;
  } catch (error) {
    if (error?.name === "AbortError" || /cancel/i.test(error?.message || "")) return;
  }
  location.href = whatsappUrlFor(text);
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth, fontFactory, maxSize, minSize) {
  let size = maxSize;
  do {
    ctx.font = fontFactory(size);
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  } while (size >= minSize);
  ctx.font = fontFactory(minSize);
  return minSize;
}

function drawLeagueTableCard(state) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const rows = state.table || [];
  const topRows = rows.slice(0, 10);
  const updated = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" }).format(new Date());

  ctx.fillStyle = "#f5f7fb";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#38003c";
  ctx.fillRect(0, 0, W, 258);
  ctx.fillStyle = "#00ff87";
  ctx.fillRect(0, 244, W, 16);
  roundedRect(ctx, 48, 48, W - 96, H - 96, 28);
  ctx.strokeStyle = "rgba(56, 0, 60, .14)";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#00ff87";
  ctx.font = "900 42px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("PREM", 78, 128);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 58px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("ORACLE", 242, 128);
  ctx.fillStyle = "#d8c9dc";
  ctx.font = "800 26px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("LIVE LEAGUE TABLE", 80, 176);

  ctx.fillStyle = "#17202a";
  fitText(ctx, state.name, W - 130, (size) => `900 ${size}px -apple-system, BlinkMacSystemFont, sans-serif`, 64, 38);
  ctx.fillText(state.name, 78, 330);
  ctx.fillStyle = "#64748b";
  ctx.font = "800 30px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(`Standings - ${updated}`, 78, 374);

  const startY = 420;
  const rowH = Math.max(76, Math.min(104, (H - startY - 170) / Math.max(topRows.length, 1)));
  topRows.forEach((row, index) => {
    const y = startY + index * rowH;
    roundedRect(ctx, 78, y, W - 156, rowH - 12, 16);
    ctx.fillStyle = index < 3 ? "#effdf4" : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = index < 3 ? "#00a86b" : "#d7dee8";
    ctx.lineWidth = index < 3 ? 4 : 2;
    ctx.stroke();
    const mid = y + (rowH - 12) / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = "#38003c";
    ctx.font = "900 38px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(String(row.rank || index + 1), 134, mid + 14);
    ctx.textAlign = "left";
    ctx.fillStyle = "#17202a";
    fitText(ctx, row.nick, 520, (size) => `900 ${size}px -apple-system, BlinkMacSystemFont, sans-serif`, 42, 26);
    ctx.fillText(row.nick, 210, mid - 6);
    ctx.fillStyle = "#64748b";
    ctx.font = "800 25px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(`${row.exact} exact - ${row.correct} scoring picks`, 210, mid + 30);
    ctx.textAlign = "right";
    ctx.fillStyle = "#38003c";
    ctx.font = "900 46px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(String(row.pts), W - 120, mid + 16);
    ctx.textAlign = "left";
  });
  ctx.fillStyle = "#64748b";
  ctx.font = "800 26px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(`Exact = 5 - GD/draw = 2 - winner = 1 - code ${state.code}`, 78, H - 92);
  ctx.textAlign = "right";
  ctx.fillStyle = "#38003c";
  ctx.font = "900 32px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("PREM ORACLE", W - 78, H - 92);
  return canvas;
}

async function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
}

function leagueTableShareText(state) {
  const link = inviteLinkFor(state.code);
  return `🏆 ${state.name} - Prem Oracle live league table. Tap to join on the web or in the app and get your picks in: ${link}`;
}

async function shareLeagueTableGraphic(state) {
  const canvas = drawLeagueTableCard(state);
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error("Could not create league table graphic.");
  const text = leagueTableShareText(state);
  const file = new File([blob], "prem-oracle-league-table.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text, title: `${state.name} league table` });
    return;
  }
  if (navigator.share) {
    await navigator.share({ text, title: `${state.name} league table` });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "prem-oracle-league-table.png";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Host Fixture Picker ---------------------------------------------------

const SLATE_MIN = 6;
const SLATE_MAX = 10;
const SURPRISE_COUNT = 8;

function pickerFixtures() {
  return fixtures
    .filter((fixture) => fixture.matchday === pickerMatchweek)
    .sort((a, b) => (Date.parse(a.startAt || "") || 0) - (Date.parse(b.startAt || "") || 0) ||
      String(a.id).localeCompare(String(b.id)));
}

function pickerKickoff(match) {
  if (!match.startAt) return match.time || "Time TBC";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  }).format(new Date(match.startAt));
}

// "Surprise me" is a starting point, not a mode: it drops a random eight into
// the ordinary selection, so every fixture stays swappable and another tap
// simply re-rolls. Pure client-side randomness — nothing is stored, and members
// never learn a slate was dealt rather than chosen.
function surpriseSelection(list) {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return new Set(pool.slice(0, Math.min(SURPRISE_COUNT, pool.length)).map((fixture) => String(fixture.id)));
}

function openFixturePicker(matchweek) {
  pickerOpen = true;
  pickerMatchweek = Number(matchweek);
  pickerSelection = new Set();
  pickerMode = "custom";
  pickerConfirmOpen = false;
  pickerBusy = false;
}

function closeFixturePicker() {
  pickerOpen = false;
  pickerConfirmOpen = false;
  pickerSelection = new Set();
  pickerMatchweek = null;
  pickerBusy = false;
}

function pickerRow(match) {
  const selected = pickerSelection.has(String(match.id));
  return `<button type="button" class="picker-row${selected ? " is-selected" : ""}" data-picker-fixture="${escapeHTML(match.id)}" aria-pressed="${selected}">
    <span class="picker-teams">${teamBadge(match.player1)}<em>v</em>${teamBadge(match.player2)}</span>
    <span class="picker-kickoff">${escapeHTML(pickerKickoff(match))}</span>
    <span class="picker-tick" aria-hidden="true"></span>
    <span class="sr-only">${escapeHTML(`${match.player1} v ${match.player2}`)}</span>
  </button>`;
}

function pickerConfirm(total) {
  if (!pickerConfirmOpen) return "";
  const count = pickerSelection.size;
  return `<div class="picker-confirm-scrim">
    <div class="picker-confirm" role="dialog" aria-modal="true" aria-label="Confirm fixtures">
      <strong>${pickerMode === "full" ? `Use all ${total} fixtures?` : `Set these ${count} fixtures?`}</strong>
      <p>Your league cannot change them after this.</p>
      <div class="picker-confirm-actions">
        <button class="secondary" type="button" data-picker-cancel ${pickerBusy ? "disabled" : ""}>Back</button>
        <button class="primary" type="button" data-picker-commit ${pickerBusy ? "disabled" : ""}>${pickerBusy ? "Setting…" : "Set fixtures"}</button>
      </div>
    </div>
  </div>`;
}

// The picker is mounted on <body>, not inside #app. A position:fixed element
// nested in `main` is clipped to that scroller by WKWebView (main carries
// -webkit-overflow-scrolling: touch), which left the overlay tucked under the
// header and above the tab bar in the native shell.
function renderPickerLayer() {
  let layer = document.getElementById("pickerLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "pickerLayer";
    document.body.append(layer);
  }
  layer.innerHTML = fixturePickerView();
  document.body.classList.toggle("picker-open", pickerOpen);
}

function fixturePickerView() {
  if (!pickerOpen) return "";
  const list = pickerFixtures();
  const count = pickerSelection.size;
  const leagueName = leagueState?.name || "your league";
  return `<div class="picker-overlay" role="dialog" aria-modal="true" aria-label="Pick your fixtures">
    <header class="picker-head">
      <div><h2>Pick your fixtures</h2><p>Matchweek ${pickerMatchweek} · ${escapeHTML(leagueName)}</p></div>
      <button class="picker-close" type="button" data-picker-close aria-label="Close fixture picker">×</button>
    </header>
    <div class="picker-counter">
      <strong>Select ${SLATE_MIN}–${SLATE_MAX} · ${count} selected</strong>
      <button class="picker-dice" type="button" data-picker-surprise>🎲 <span>Surprise me</span></button>
    </div>
    <div class="picker-list">${list.map(pickerRow).join("")}</div>
    <div class="picker-actions">
      <button class="picker-secondary" type="button" data-picker-all>Use all ${list.length} this week</button>
      <button class="primary wide" type="button" data-picker-set ${count < SLATE_MIN || count > SLATE_MAX ? "disabled" : ""}>Set ${count} fixtures</button>
    </div>
    ${pickerConfirm(list.length)}
  </div>`;
}

// --- Trophy Cabinet --------------------------------------------------------

const PLACE_EMOJI = { gold: "🏆", silver: "🥈", bronze: "🥉" };
const ORDINALS = ["", "1st", "2nd", "3rd"];

function ordinal(rank) {
  if (ORDINALS[rank]) return ORDINALS[rank];
  const remainder = rank % 100;
  if (remainder >= 11 && remainder <= 13) return `${rank}th`;
  return `${rank}${({ 1: "st", 2: "nd", 3: "rd" })[rank % 10] || "th"}`;
}

function cabinetWeek(week) {
  const award = week.place
    ? `<span class="cab-award" aria-label="${week.place}">${PLACE_EMOJI[week.place]}</span>`
    : `<span class="cab-award cab-award-none" aria-label="No podium"></span>`;
  const slate = week.slateType === "custom" ? "Custom Mix" : "Full card";
  return `<li class="cabinet-week">
    ${award}
    <div class="cabinet-week-main">
      <strong>Matchweek ${week.matchweek}</strong>
      <span>${slate} · ${countPhrase(week.fixtures, week.fixtures === 1 ? "fixture" : "fixtures")}</span>
    </div>
    <b>${countPhrase(week.pts, "pts")}${week.place ? "" : ` · ${ordinal(week.rank)}`}</b>
  </li>`;
}

function trophyCabinet(state) {
  const cabinet = state?.cabinet;
  if (!cabinet) return "";
  const shelf = ["gold", "silver", "bronze"].map((place) =>
    `<div class="cab-slot"><span class="cab-emoji">${PLACE_EMOJI[place]}</span><b>× ${cabinet[place] || 0}</b></div>`
  ).join("");
  return `<section class="cabinet">
    <h3>${escapeHTML(cabinet.nick || "Your")}'s trophy cabinet</h3>
    <div class="cabinet-shelf">
      ${shelf}
      <div class="cab-slot cab-total"><b>${cabinet.podiums || 0}</b><span>podiums</span></div>
    </div>
    <h4>Week by week</h4>
    ${cabinet.weeks?.length
      ? `<ul class="cabinet-weeks">${cabinet.weeks.map(cabinetWeek).join("")}</ul>`
      : `<p class="muted">Your first matchweek award lands here once a round is settled.</p>`}
  </section>`;
}

function leagueView() {
  const recovery = localStorage.getItem(STORAGE.recovery);
  const joinDefault = inviteCode && !leagueCodes.includes(inviteCode) ? inviteCode : "";
  const controls = `<div class="league-actions">
    <form class="league-form" data-create-league>
      <span class="eyebrow">Start a competition</span><h3>Create a league</h3>
      <input name="leagueName" maxlength="40" placeholder="Saturday Super 6" required>
      <label class="league-toggle">
        <input type="checkbox" name="customMix">
        <span><strong>Custom matchweek picks</strong><em>Host chooses ${SLATE_MIN}–${SLATE_MAX} fixtures each week</em></span>
      </label>
      <button class="primary wide" type="submit">Create league</button>
    </form>
    <form class="league-form" data-join-league>
      <span class="eyebrow">Got an invitation?</span><h3>Join a league</h3>
      <input name="leagueCode" maxlength="6" value="${joinDefault}" placeholder="ABC234" required>
      <button class="primary wide" type="submit">Join league</button>
    </form>
  </div>`;
  const restore = `<form class="restore-card" data-restore>
    <div><strong>${recovery ? "Your recovery code" : "Returning on another device?"}</strong><p>${recovery ? `<code>${recovery}</code> - save this privately.` : "Enter your three-word recovery code to restore your identity, leagues and standings."}</p></div>
    <input name="recovery" placeholder="amber-score-oracle">
    <button class="secondary" type="submit">Restore</button>
  </form>`;
  if (!leagueCodes.length) {
    return `<div class="section-head"><div><span class="eyebrow">Private predictor leagues</span><h2>Play against your mates</h2></div></div>${flash()}${controls}${restore}`;
  }
  const state = leagueState;
  const isOwner = state && !state.error && state.owner === uid();
  const supportsRounds = leagueSupportsRounds(state);
  const showMatchday = supportsRounds && leagueTab === "matchday";
  const shareLabel = showMatchday && roundState && !roundState.error && roundState.matchday != null
    ? `Share Matchweek ${roundState.matchday} result`
    : "Share table to WhatsApp";
  let inner;
  if (showMatchday) {
    inner = !roundState
      ? `<div class="empty"><strong>Loading matchweek…</strong></div>`
      : roundState.error
        ? `<div class="empty"><strong>${escapeHTML(roundState.error)}</strong></div>`
        : `${roundBanner(roundState)}${roundTableHtml(roundState)}`;
  } else if (supportsRounds) {
    inner = `${seasonBanner(state)}${seasonTableHtml(state, isOwner, true)}${trophyCabinet(state)}${leagueRevealsHtml(state)}`;
  } else if (state && !state.error) {
    // Resilient fallback: an old worker response without round data.
    inner = `${seasonTableHtml(state, isOwner, false)}${leagueRevealsHtml(state)}`;
  }
  const content = !state
    ? `<div class="empty"><strong>Loading league...</strong></div>`
    : state.error
      ? `<div class="empty"><strong>${escapeHTML(state.error)}</strong></div>`
      : `<section class="league-card">
          <span class="eyebrow">Private predictor league</span>
          <h2>${escapeHTML(state.name)}</h2>
          <div class="league-code"><span>League code</span><strong>${state.code}</strong></div>
          ${isOwner && state.customMix && state.currentMatchday != null && !state.currentSlate
            ? `<button class="primary wide host-slate-banner" type="button" data-open-picker="${state.currentMatchday}">Pick fixtures for Matchweek ${state.currentMatchday}</button>`
            : ""}
          <button class="secondary wide" type="button" data-share-league="${state.code}">Invite mates</button>
          <button class="secondary wide" type="button" data-league-nick="${state.code}">Change my name in this league</button>
          ${isOwner ? `<button class="link-danger" type="button" data-delete-league="${state.code}">Delete league</button>` : ""}
          ${supportsRounds ? `${roundToggle()}${matchdayPicker()}` : ""}
          ${inner}
          <button class="whatsapp-share wide" type="button" data-export-league-table="${state.code}">${shareLabel}</button>
        </section>`;
  return `<div class="section-head"><div><span class="eyebrow">Private predictor leagues</span><h2>League table</h2></div></div>${flash()}${leagueSwitcher()}${content}${controls}${restore}`;
}

function rulesView() {
  return `<div class="rules-card">
    <span class="eyebrow">Scoring</span>
    <h2>How Prem Oracle works</h2>
    <ul class="rules-list">
      <li>Predict the <strong>final Premier League scoreline</strong> for every fixture.</li>
      <li><strong>Exact score = 5 points.</strong></li>
      <li><strong>Correct draw, wrong score = 2 points.</strong></li>
      <li><strong>Correct winner and goal difference = 2 points.</strong></li>
      <li><strong>Correct winner only = 1 point.</strong></li>
      <li>Wrong outcome or no prediction = 0 points.</li>
      <li>Picks lock at scheduled kick-off and then reveal to the league.</li>
      <li>Postponed or abandoned matches are void until they are rescheduled.</li>
    </ul>
    <p class="rules-attribution">Match data: <a href="https://www.football-data.org/" target="_blank" rel="noopener">football-data.org</a>. Football data provided by the Football-Data.org API.</p>
  </div>`;
}

function flash() {
  return flashMessage ? `<div class="flash flash-${flashTone}">${escapeHTML(flashMessage)}</div>` : "";
}

function setFlash(message, tone = "success") {
  flashMessage = message;
  flashTone = tone;
}

function clearFlash() {
  flashMessage = "";
  flashTone = "success";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

function appScroller() {
  return document.querySelector("main");
}

function scrollAppToTop() {
  appScroller()?.scrollTo({ top: 0, behavior: "smooth" });
}

function rememberMatchDay(matchId) {
  const match = fixtures.find((fixture) => fixture.id === matchId);
  if (match?.matchday) openScheduleDates.add(`md-${match.matchday}`);
}

function render(options = {}) {
  const app = document.getElementById("app");
  const views = { today: todayView, schedule: scheduleView, picks: picksView, league: leagueView, rules: rulesView };
  app.innerHTML = (views[currentView] || todayView)();
  renderPickerLayer();
  document.getElementById("profileInitial").textContent = playerInitial();
  document.querySelectorAll(".bottom-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === currentView));
  if (options.anchorMatchId) {
    requestAnimationFrame(() => document.querySelector(`[data-match-card="${CSS.escape(options.anchorMatchId)}"]`)?.scrollIntoView({ block: "center" }));
  } else if (options.scrollTop) {
    requestAnimationFrame(scrollAppToTop);
  }
}

function showUpdatePrompt(registration) {
  if (!registration?.waiting || document.querySelector(".app-update-prompt")) return;
  const appliedKey = "prem_oracle_applied_build";
  if (sessionStorage.getItem(appliedKey) === APP_BUILD) return;
  const prompt = document.createElement("button");
  prompt.className = "app-update-prompt";
  prompt.type = "button";
  prompt.textContent = "Tap to update";
  prompt.addEventListener("click", () => {
    pendingUpdateReload = true;
    sessionStorage.setItem(appliedKey, APP_BUILD);
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  });
  document.body.append(prompt);
}

async function navigateToView(view) {
  if (!view) return;
  currentView = view;
  clearFlash();
  render({ scrollTop: true });
  if (currentView === "league") {
    await loadLeagueState();
    render();
  }
}

// Commits the slate. Immutable server-side, so this runs once and then the
// picker closes for good — every later matchweek gets its own picker.
async function commitSlate() {
  const matchweek = pickerMatchweek;
  const mode = pickerMode;
  const fixtureIds = [...pickerSelection];
  pickerBusy = true;
  render();
  try {
    await api("/league/slate", { uid: uid(), code: activeLeague, matchweek, mode, fixtureIds });
    closeFixturePicker();
    setFlash(`Matchweek ${matchweek} is set — ${fixtureIds.length} fixtures.`);
    await loadLeagueState();
  } catch (error) {
    pickerBusy = false;
    pickerConfirmOpen = false;
    setFlash(error.message, "error");
  }
  render();
}

async function handlePickerClick(event) {
  const open = event.target.closest("[data-open-picker]");
  if (open) {
    openFixturePicker(open.dataset.openPicker);
    render();
    return true;
  }
  if (!pickerOpen) return false;
  if (event.target.closest("[data-picker-commit]")) {
    if (!pickerBusy) await commitSlate();
    return true;
  }
  // Dismiss on the Back button, or on a direct hit outside the half-modal —
  // never on a click that merely bubbled up through the dialog itself.
  if (event.target.closest("[data-picker-cancel]") || event.target.classList?.contains("picker-confirm-scrim")) {
    if (!pickerBusy) { pickerConfirmOpen = false; render(); }
    return true;
  }
  if (pickerConfirmOpen) return true;
  if (event.target.closest("[data-picker-close]")) {
    closeFixturePicker();
    render();
    return true;
  }
  if (event.target.closest("[data-picker-surprise]")) {
    pickerSelection = surpriseSelection(pickerFixtures());
    pickerMode = "custom";
    render();
    return true;
  }
  if (event.target.closest("[data-picker-all]")) {
    pickerSelection = new Set(pickerFixtures().map((fixture) => String(fixture.id)));
    pickerMode = "full";
    pickerConfirmOpen = true;
    render();
    return true;
  }
  if (event.target.closest("[data-picker-set]")) {
    if (pickerSelection.size >= SLATE_MIN && pickerSelection.size <= SLATE_MAX) {
      pickerMode = "custom";
      pickerConfirmOpen = true;
      render();
    }
    return true;
  }
  const row = event.target.closest("[data-picker-fixture]");
  if (row) {
    const id = row.dataset.pickerFixture;
    if (pickerSelection.has(id)) pickerSelection.delete(id);
    else pickerSelection.add(id);
    pickerMode = "custom";
    render();
    return true;
  }
  return !!event.target.closest(".picker-overlay");
}

document.addEventListener("click", async (event) => {
  if (await handlePickerClick(event)) return;
  const nav = event.target.closest("[data-view]");
  if (nav) {
    await navigateToView(nav.dataset.view);
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) { matchdayFilter = filter.dataset.filter; render(); return; }
  const league = event.target.closest("[data-league]");
  if (league) { setActiveLeague(league.dataset.league); return; }
  const roundTab = event.target.closest("[data-round-tab]");
  if (roundTab) {
    if (roundTab.dataset.roundTab === "matchday") {
      if (leagueTab === "matchday") { matchdayPickerOpen = !matchdayPickerOpen; render(); return; }
      leagueTab = "matchday";
      matchdayPickerOpen = false;
      render();
      if (!roundState || roundState.error || roundState.matchday !== selectedMatchday) {
        await loadRoundState();
        render();
      }
      return;
    }
    leagueTab = "season";
    matchdayPickerOpen = false;
    render();
    return;
  }
  const roundMd = event.target.closest("[data-round-md]");
  if (roundMd) {
    selectedMatchday = Number(roundMd.dataset.roundMd);
    leagueTab = "matchday";
    matchdayPickerOpen = false;
    render();
    await loadRoundState();
    render();
    return;
  }
  const share = event.target.closest("[data-share-league]");
  if (share) {
    const url = inviteLinkFor(share.dataset.shareLeague);
    const text = `Join my Prem Oracle league ${share.dataset.shareLeague} on the web or in the app: ${url}`;
    await shareOrWhatsApp({ title: "Prem Oracle", text, url });
    return;
  }
  const del = event.target.closest("[data-delete-league]");
  if (del) {
    const code = del.dataset.deleteLeague;
    const name = (leagueState?.code === code ? leagueState.name : leagueNames[code]) || code;
    if (!confirm(`Delete ${name}? This removes the league and its table for all members — picks aren't affected.`)) return;
    try {
      await api("/league/delete", { uid: uid(), code });
      removeStoredLeague(code);
      pruneStoredLeagueNames();
      setFlash(`Deleted ${name}`);
      await loadLeagueState();
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
    return;
  }
  const nick = event.target.closest("[data-league-nick]");
  if (nick) {
    const code = nick.dataset.leagueNick;
    const current = leagueState?.table?.find((row) => row.uid === uid())?.nick || playerName || "";
    const next = prompt("Your name in this league", current);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) { setFlash("Name can't be empty", "error"); render(); return; }
    try {
      const result = await api("/league/nick", { uid: uid(), code, nick: trimmed });
      setFlash(`Now showing as ${result.nick} in this league`);
      await loadLeagueState();
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
    return;
  }
  const kick = event.target.closest("[data-kick-league]");
  if (kick) {
    const code = kick.dataset.kickLeague;
    const memberUid = kick.dataset.kickUid;
    const name = (leagueState?.code === code ? leagueState.name : leagueNames[code]) || code;
    const nick = leagueState?.table?.find((row) => row.uid === memberUid)?.nick || "this member";
    if (!confirm(`Remove ${nick} from ${name}? Their picks aren't affected and they can rejoin with the code.`)) return;
    try {
      await api("/league/kick", { uid: uid(), code, memberUid });
      setFlash(`Removed ${nick}`);
      await loadLeagueState();
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
    return;
  }
  const exportTable = event.target.closest("[data-export-league-table]");
  if (exportTable) {
    if (leagueTab === "matchday" && roundState && !roundState.error && roundState.table?.length) {
      const text = roundShareText(leagueState, roundState);
      await shareOrWhatsApp({ title: "Prem Oracle", text });
      return;
    }
    if (leagueState?.table?.length) {
      // The PNG share card rides on navigator.share({files}), which the native
      // WKWebView has no answer for. Natively we share the same text + invite
      // link through the Share plugin instead.
      if (isNativeApp()) {
        await shareOrWhatsApp({ title: `${leagueState.name} league table`, text: leagueTableShareText(leagueState) });
        return;
      }
      setFlash("Building share card.");
      render();
      try {
        await shareLeagueTableGraphic(leagueState);
        setFlash("Share card ready.");
      } catch {
        location.href = whatsappUrlFor(leagueTableText(leagueState));
        setFlash("Opened WhatsApp share text.");
      }
      render();
    }
    return;
  }
  const scoreWindow = event.target.closest("[data-score-window]");
  if (scoreWindow) {
    const matchId = scoreWindow.dataset.scoreWindow;
    const step = event.target.closest("[data-score-step]");
    if (step) {
      const [key, delta] = step.dataset.scoreStep.split(",");
      const value = scoreWindow.querySelector(`[data-score-value="${key}"]`);
      value.textContent = Math.max(0, Math.min(9, Number(value.textContent) + Number(delta)));
      return;
    }
    if (event.target.closest("[data-lock-score]")) {
      const p1 = Number(scoreWindow.querySelector('[data-score-value="p1"]').textContent);
      const p2 = Number(scoreWindow.querySelector('[data-score-value="p2"]').textContent);
      await savePick(matchId, p1, p2);
    }
  }
});

// Native shell: swipe left/right to move between the bottom-nav tabs. iOS
// reviewers expect paged content to respond to horizontal swipes, so we wire
// this up only inside the Capacitor shell (is-native). The web build is left
// exactly as-is. We never preventDefault, so vertical scrolling, momentum and
// horizontal scrollers keep their native behaviour — a gesture only switches
// tabs when it is clearly horizontal and starts on inert (non-interactive,
// non-scrolling) content such as the +/− steppers or the filter chips.
function stepView(direction) {
  const order = Array.from(document.querySelectorAll(".bottom-nav button[data-view]"))
    .map((button) => button.dataset.view);
  const index = order.indexOf(currentView);
  if (index === -1) return;
  const next = order[index + direction];
  if (next) navigateToView(next);
}

if (document.documentElement.classList.contains("is-native")) {
  const SWIPE_MIN_X = 60;          // horizontal travel required (px)
  const SWIPE_MAX_DURATION = 600;  // a flick, not a slow drag (ms)
  let swipe = null;

  const swipeBlockedBy = (target) => {
    if (!target?.closest) return true;
    // Interactive controls own their own touches (steppers, buttons, links,
    // form fields, open dialogs, and the whole score window).
    if (target.closest("button, a, input, select, textarea, dialog[open], [data-score-window]")) return true;
    // Let anything inside a horizontal scroller (e.g. the filter chips) scroll.
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      const overflowX = window.getComputedStyle(el).overflowX;
      if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth) return true;
    }
    return false;
  };

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || swipeBlockedBy(event.target)) { swipe = null; return; }
    const touch = event.touches[0];
    swipe = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  }, { passive: true });

  document.addEventListener("touchend", (event) => {
    const start = swipe;
    swipe = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    if (Date.now() - start.t > SWIPE_MAX_DURATION) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Require a clearly horizontal flick so we never fight vertical scrolling.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 2) return;
    stepView(dx < 0 ? 1 : -1);  // swipe left → next tab, swipe right → previous
  }, { passive: true });
}

async function savePick(matchId, p1, p2) {
  if (!validScore(p1) || !validScore(p2)) return;
  rememberMatchDay(matchId);
  picks[matchId] = { p1, p2, savedAt: Date.now() };
  busyMatch = matchId;
  render({ anchorMatchId: matchId });
  try {
    if (API) await api("/pick", { uid: uid(), nickname: playerName, matchId, p1, p2 });
    localStorage.setItem(STORAGE.picks, JSON.stringify(picks));
    setFlash("Pick saved.");
  } catch (error) {
    setFlash(error.message, "error");
    delete picks[matchId];
  } finally {
    busyMatch = "";
    render({ anchorMatchId: matchId });
  }
}

document.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-create-league]")) {
    event.preventDefault();
    const form = new FormData(event.target);
    const name = form.get("leagueName");
    const customMix = form.get("customMix") != null;
    try {
      const response = await api("/league", { uid: uid(), nickname: playerName, name, customMix });
      saveLeague(response.code);
      saveLeagueName(response.code, response.name);
      if (response.recovery) localStorage.setItem(STORAGE.recovery, response.recovery);
      setFlash(`League created: ${response.code}`);
      await loadLeagueState();
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
    return;
  }
  if (event.target.matches("[data-join-league]")) {
    event.preventDefault();
    const code = String(new FormData(event.target).get("leagueCode") || "").toUpperCase();
    try {
      const response = await api("/join", { uid: uid(), nickname: playerName, code });
      saveLeague(response.code);
      saveLeagueName(response.code, response.name);
      if (response.recovery) localStorage.setItem(STORAGE.recovery, response.recovery);
      setFlash(`Joined ${response.name}`);
      await loadLeagueState();
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
    return;
  }
  if (event.target.matches("[data-restore]")) {
    event.preventDefault();
    try {
      const response = await api("/restore", { code: new FormData(event.target).get("recovery") });
      localStorage.setItem(STORAGE.uid, response.uid);
      localStorage.setItem(STORAGE.recovery, response.recovery);
      playerName = response.nickname || playerName;
      if (playerName) localStorage.setItem(STORAGE.name, playerName);
      leagueCodes = response.leagues || [];
      localStorage.setItem(STORAGE.leagues, JSON.stringify(leagueCodes));
      setActiveLeague(leagueCodes[0] || "", false);
      picks = response.picks || {};
      localStorage.setItem(STORAGE.picks, JSON.stringify(picks));
      await syncUserPicks(true);
      await loadLeagueState();
      setFlash("Identity and leagues restored.");
    } catch (error) {
      setFlash(error.message, "error");
    }
    render();
  }
});

document.addEventListener("toggle", (event) => {
  const card = event.target.closest?.("[data-day-card]");
  if (!card) return;
  if (card.open) openScheduleDates.add(card.dataset.dayCard);
  else openScheduleDates.delete(card.dataset.dayCard);
}, true);

document.getElementById("profileButton").addEventListener("click", () => {
  document.getElementById("playerName").value = playerName;
  document.getElementById("profileDialog").showModal();
});

document.getElementById("profileForm").addEventListener("submit", (event) => {
  event.preventDefault();
  playerName = document.getElementById("playerName").value.trim().slice(0, 24);
  localStorage.setItem(STORAGE.name, playerName);
  document.getElementById("profileDialog").close();
  render();
});

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((registration) => {
    showUpdatePrompt(registration);
    registration.update().catch(() => {});
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdatePrompt(registration);
      });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateReloading) return;
    updateReloading = true;
    if (pendingUpdateReload) location.reload();
  });
}

async function setupNativePushNotifications() {
  const cap = window.Capacitor;
  const push = window.capacitorPushNotifications?.PushNotifications || cap?.Plugins?.PushNotifications;
  if (!cap?.isNativePlatform?.() || !push) return;
  try {
    await push.addListener("registration", registerPushToken);
    await push.addListener("registrationError", () => {});
    await push.addListener("pushNotificationActionPerformed", () => {
      currentView = "today";
      render({ scrollTop: true });
    });
    let permission = await push.checkPermissions();
    if (permission.receive === "prompt") permission = await push.requestPermissions();
    if (permission.receive === "granted") await push.register();
  } catch {
    // Native notification permission is optional; the app remains fully usable.
  }
}

// Pull a ?league=CODE invite out of an incoming URL (universal link or web).
function leagueCodeFromUrl(url) {
  try {
    return new URL(url, location.href).searchParams.get("league")?.toUpperCase() || "";
  } catch {
    return "";
  }
}

// Open the join flow for an invite code arriving after launch (native deep link).
async function openInviteFlow(code) {
  if (!code || leagueCodes.includes(code)) return;
  inviteCode = code;
  await navigateToView("league");
}

// Native universal links (applinks:abigwood.github.io) arrive through the
// Capacitor App plugin rather than location.search, because the webview runs at
// capacitor://localhost. Route them into the same invite flow as the web build.
async function setupNativeUniversalLinks() {
  const cap = window.Capacitor;
  const app = window.capacitorApp?.App || cap?.Plugins?.App;
  if (!cap?.isNativePlatform?.() || !app) return;
  try {
    await app.addListener("appUrlOpen", (data) => {
      const code = leagueCodeFromUrl(data?.url || "");
      if (code) openInviteFlow(code);
    });
    const launch = await app.getLaunchUrl?.();
    const launchCode = leagueCodeFromUrl(launch?.url || "");
    if (launchCode) openInviteFlow(launchCode);
  } catch {
    // Deep-link routing is best-effort; the code can still be typed manually.
  }
}

Promise.all([loadFixtures(), hydrateIdentity()]).then(() => {
  if (inviteCode && !leagueCodes.includes(inviteCode)) currentView = "league";
  render();
  registerServiceWorker();
  setupNativePushNotifications();
  setupNativeUniversalLinks();
  if (currentView === "league") {
    loadLeagueState().then(render);
  }
});

setInterval(async () => {
  await loadFixtures();
  if (activeLeague) await loadLeagueState();
  render();
}, 180000);
