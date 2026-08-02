const SEASON_START = new Date("2026-08-21T20:00:00+01:00");
const SEASON_START_DATE = "2026-08-21";
const APP_BUILD = "20260802d";
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
  competition: "prem_oracle_competition",
  mutedCompetitions: "prem_oracle_muted_competitions",
  leagueStates: "prem_oracle_league_states",
  pickSections: "prem_oracle_pick_sections",
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
// --- Competitions -----------------------------------------------------------
// Mirrors worker/src/competitions.js. A league is created for one competition
// and stays there, so the app only ever holds one competition's fixtures at a
// time — chosen by whichever league is active.
const COMPETITIONS = {
  PL: { code: "PL", name: "Premier League", short: "Premier League", chip: "EPL", rounds: 38, data: "data/fixtures.json" },
  ELC: { code: "ELC", name: "EFL Championship", short: "Championship", chip: "EFLC", rounds: 46, data: "data/fixtures-elc.json" },
};
const DEFAULT_COMPETITION = "PL";
// v1.5 §9: ONE validation path for the weekly count — 1 to 20, default 6,
// floor 1. Mirrors worker/src/competitions.js; nothing re-imposes another band.
const MIN_FIXTURE_COUNT = 1;
const MAX_FIXTURE_COUNT = 20;
const DEFAULT_FIXTURE_COUNT = 6;

// Single flag gating Championship visibility. Flipped on once the v1.3 parity
// gates pass; until then the Championship is invisible to members even though
// the data and the worker are ready for it.
const FEATURES = { elc: true };

const competitionEnabled = (code) => code === DEFAULT_COMPETITION || (code === "ELC" && FEATURES.elc);
const availableCompetitions = () => Object.keys(COMPETITIONS).filter(competitionEnabled);
const competitionMeta = (code) => COMPETITIONS[code] || COMPETITIONS[DEFAULT_COMPETITION];

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
  // EFL Championship 2026/27. Same shape as above: primary kit colour, a
  // readable foreground, and a secondary accent used for the badge outline —
  // which is what keeps the white and pale kits visible on a white card.
  "Birmingham City": { bg: "#0000A6", fg: "#FFFFFF", border: "#D1D5DB" },
  "Blackburn Rovers": { bg: "#0B4EA2", fg: "#FFFFFF", border: "#8FD3F4" },
  "Bolton Wanderers": { bg: "#FFFFFF", fg: "#20397C", border: "#20397C" },
  "Bristol City": { bg: "#E21C38", fg: "#FFFFFF", border: "#1C1C1C" },
  "Burnley": { bg: "#6C1D45", fg: "#FFFFFF", border: "#99D6EA" },
  "Cardiff City": { bg: "#0070B5", fg: "#FFFFFF", border: "#D11524" },
  "Charlton Athletic": { bg: "#D6161E", fg: "#FFFFFF", border: "#1C1C1C" },
  "Derby County": { bg: "#FFFFFF", fg: "#000000", border: "#000000" },
  "Lincoln City": { bg: "#D0161C", fg: "#FFFFFF", border: "#111111" },
  "Middlesbrough": { bg: "#E21C38", fg: "#FFFFFF", border: "#000000" },
  "Millwall": { bg: "#001D5B", fg: "#FFFFFF", border: "#D1D5DB" },
  "Norwich City": { bg: "#FFF200", fg: "#00543C", border: "#00A650" },
  "Portsmouth": { bg: "#001489", fg: "#FFFFFF", border: "#F2A900" },
  "Preston North End": { bg: "#FFFFFF", fg: "#1B1F62", border: "#1B1F62" },
  "Queens Park Rangers": { bg: "#1D5BA4", fg: "#FFFFFF", border: "#D1D5DB" },
  "Sheffield United": { bg: "#CE1B22", fg: "#FFFFFF", border: "#000000" },
  "Southampton": { bg: "#D71920", fg: "#FFFFFF", border: "#130C0E" },
  "Stoke City": { bg: "#CE1F24", fg: "#FFFFFF", border: "#1B1B1B" },
  "Swansea City": { bg: "#FFFFFF", fg: "#121212", border: "#121212" },
  "Watford": { bg: "#FBEE23", fg: "#11210F", border: "#ED2127" },
  "West Bromwich Albion": { bg: "#122F67", fg: "#FFFFFF", border: "#D1D5DB" },
  "West Ham United": { bg: "#7A263A", fg: "#FFFFFF", border: "#1BB1E7" },
  "Wolverhampton Wanderers": { bg: "#FDB913", fg: "#231F20", border: "#231F20" },
  "Wrexham": { bg: "#C8001A", fg: "#FFFFFF", border: "#D1D5DB" },
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
  // EFL Championship 2026/27.
  "Birmingham City": "BIR",
  "Blackburn Rovers": "BLB",
  "Bolton Wanderers": "BOL",
  "Bristol City": "BRC",
  "Burnley": "BUR",
  "Cardiff City": "CAR",
  "Charlton Athletic": "CHA",
  "Derby County": "DER",
  "Lincoln City": "LIN",
  "Middlesbrough": "MID",
  "Millwall": "MIL",
  "Norwich City": "NOR",
  "Portsmouth": "POR",
  "Preston North End": "PNE",
  "Queens Park Rangers": "QPR",
  "Sheffield United": "SHU",
  "Southampton": "SOU",
  "Stoke City": "STK",
  "Swansea City": "SWA",
  "Watford": "WAT",
  "West Bromwich Albion": "WBA",
  "West Ham United": "WHU",
  "Wolverhampton Wanderers": "WOL",
  "Wrexham": "WRE",
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
// Last known /state for every league this device plays, so switching leagues
// paints from memory instead of waiting on the network. Seeded from
// localStorage at boot, which is what makes the FIRST switch of a session fast
// too. Never a source of truth: every read is followed by a background refresh.
let leagueStates = readJSON(STORAGE.leagueStates, {});
let leagueTab = "matchday";
// The period the round view is showing. A matchweek number for a single-
// competition league, a window key for a mixed one — the same period abstraction
// the picker, the nudges and the Schedule tab all inherit from.
let selectedPeriod = null;
// The numeric matchweek, where the league actually has one. Null for a mixed
// league, which runs on windows and has no matchweek numbering to report.
const selectedMatchday = () => (Number(selectedPeriod) || null);
let roundState = null;
let matchdayPickerOpen = false;
let busyMatch = "";
let flashMessage = "";
let flashTone = "success";
let openScheduleDates = new Set();
// Which My Predictions sections the viewer has collapsed. Sections default to
// open, so only the closed ones are worth remembering — and remembering them
// means a long list stays the shape they left it in.
let collapsedPickSections = new Set(readJSON(STORAGE.pickSections, []));
let updateReloading = false;
let pendingUpdateReload = false;
// Custom Mix host Fixture Picker. Held outside the view functions because the
// picker is a full-screen layer over whichever tab the host opened it from.
let pickerOpen = false;
let pickerPeriod = null;
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

async function loadOneCompetition(code, refresh) {
  let response = null;
  if (API) {
    response = await fetch(
      `${API}/fixtures?competition=${code}&${refresh ? "refresh=1&" : ""}t=${Date.now()}`,
      { cache: "no-store" }
    ).catch(() => null);
  }
  if (!response?.ok) response = await fetch(`${competitionMeta(code).data}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`fixtures ${code}`);
  return response.json();
}

async function loadFixtures(refresh = false) {
  const competitions = activeCompetitions();
  try {
    const payloads = await Promise.all(competitions.map((code) => loadOneCompetition(code, refresh)));
    fixtures = payloads.flatMap((data) => data.fixtures || []).sort((a, b) =>
      (Date.parse(a.startAt || "") || 0) - (Date.parse(b.startAt || "") || 0) ||
      String(a.id).localeCompare(String(b.id))
    );
    // Team intel merges across competitions; club names never collide.
    teamIntel = Object.assign({}, ...payloads.map((data) =>
      (data.teams && typeof data.teams === "object") ? data.teams : {}));
    loadedCompetition = competitions.join("+");
  } catch {
    fixtures = [];
    teamIntel = {};
    loadedCompetition = null;
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
    // Now that the league and its period are known, the launch tree can answer
    // properly — a cold install had nothing to go on the first time round.
    applyLaunchBranch();
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

// The competitions the app is currently showing: whichever set the active
// league plays, remembered across launches so the first paint is never wrong.
function activeCompetitions() {
  const stored = readJSON(STORAGE.competition, null);
  const codes = Array.isArray(leagueState?.competitions) ? leagueState.competitions
    : Array.isArray(stored) ? stored
    : [String(stored || DEFAULT_COMPETITION)];
  const usable = codes.filter(competitionEnabled);
  return usable.length ? usable : [DEFAULT_COMPETITION];
}

const activeCompetition = () => activeCompetitions()[0];
const isMixedActive = () => activeCompetitions().length > 1;

// A mixed league has no single season length — it runs on calendar weeks.
const seasonRounds = () => (isMixedActive() ? null : competitionMeta(activeCompetition()).rounds);
const competitionName = () => activeCompetitions().map((code) => competitionMeta(code).name).join(" + ");
const competitionOfFixture = (id) =>
  String(id || "").startsWith("elc-") ? "ELC" : String(id || "").startsWith("pl-") ? "PL" : null;

// --- Your Week --------------------------------------------------------------
// Premier League matchweeks and Championship rounds never align, so a league
// drawing on both runs on its own calendar window instead.
//
// The window is TUESDAY to MONDAY (v1.5 §9), mirroring worker/src/competitions.js.
// It opens on Tuesday morning once Monday night football has settled the round
// before it, and closes at Monday midnight — which keeps a whole round on one
// side of the boundary, and keeps a Champions League Tuesday and Wednesday in
// ONE window rather than two.

function windowKeyFor(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // Offsets back to the window's opening Tuesday; Monday is six days in.
  const offset = { Tue: 0, Wed: 1, Thu: 2, Fri: 3, Sat: 4, Sun: 5, Mon: 6 }[byType.weekday];
  if (offset == null) return null;
  const tuesday = new Date(Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day) - offset));
  return `w${tuesday.toISOString().slice(0, 10)}`;
}

const isWindowKey = (key) => /^w\d{4}-\d{2}-\d{2}$/.test(String(key || ""));

function windowLabel(key) {
  if (!isWindowKey(key)) return "";
  const start = new Date(`${String(key).slice(1)}T12:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86400000);
  const fmt = (date, withMonth) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", ...(withMonth ? { month: "short" } : {}),
  }).format(date);
  return `${fmt(start, start.getUTCMonth() !== end.getUTCMonth())} – ${fmt(end, true)}`;
}

/**
 * THE period key, app-side. Everything with a weekly beat reads it from here —
 * the Next tab, the Schedule tab's grouping and the host picker all inherit one
 * definition rather than each deciding what a week is.
 */
const periodOfFixture = (fixture) =>
  (isMixedActive() ? windowKeyFor(fixture?.startAt) : fixture?.matchday == null ? null : String(fixture.matchday));

// --- Week naming ------------------------------------------------------------
// A window league counts its own weeks: Week 1 is the league's opening window,
// and every week after it is the next number. Deliberately NOT "Round" — that
// word belongs to official competition rounds and would be a lie here.
//
// The Tuesday-to-Monday convention is stated ONCE, above the strip, instead of
// being repeated as a "Tue …– Mon …" prefix on all forty-odd chips.

/** Sequential week number for a window period, or null if it isn't one. */
function weekNumberFor(period) {
  if (!isWindowKey(period)) return null;
  const index = periodsInOrder().indexOf(String(period));
  return index < 0 ? null : index + 1;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** The Tuesday a window opens and the Monday it closes, as UTC dates. */
function weekBounds(period) {
  if (!isWindowKey(period)) return null;
  const start = new Date(`${String(period).slice(1)}T12:00:00Z`);
  return { start, end: new Date(start.getTime() + 6 * 86400000) };
}

/** "18–24 Aug", or "27 Aug – 2 Sep" when the week straddles a month. */
function weekDateRange(period) {
  const bounds = weekBounds(period);
  if (!bounds) return "";
  const { start, end } = bounds;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  return sameMonth
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS_SHORT[start.getUTCMonth()]}`
    : `${start.getUTCDate()} ${MONTHS_SHORT[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS_SHORT[end.getUTCMonth()]}`;
}

/**
 * "11–17" for the season view, where the month is the section label. A week
 * that straddles into the next month names it — "27–2 Nov" — because the
 * section header above says October and the 2nd is not October's.
 */
function weekDayRange(period) {
  const bounds = weekBounds(period);
  if (!bounds) return "";
  const { start, end } = bounds;
  const range = `${start.getUTCDate()}–${end.getUTCDate()}`;
  return start.getUTCMonth() === end.getUTCMonth()
    ? range
    : `${range} ${MONTHS_SHORT[end.getUTCMonth()]}`;
}

/** The month a week is filed under: the one it opens in. */
function weekMonthKey(period) {
  const bounds = weekBounds(period);
  return bounds ? `${bounds.start.getUTCFullYear()}-${bounds.start.getUTCMonth()}` : "";
}

function weekMonthLabel(period) {
  const bounds = weekBounds(period);
  return bounds ? `${MONTHS_LONG[bounds.start.getUTCMonth()]} ${bounds.start.getUTCFullYear()}` : "";
}

const WEEK_CONVENTION = `<p class="week-convention">Weeks run Tuesday to Monday.</p>`;

/**
 * The everyday control: one horizontal strip, centred on the week in play.
 * Weeks already gone are faded and sit to the left; the rest are a swipe right.
 */
function weekStrip(selected, attribute) {
  const periods = periodsInOrder();
  if (!periods.length) return "";
  const current = leagueState?.currentPeriod ?? currentPeriodKey();
  // A window league counts weeks and states the Tuesday convention once; a
  // matchweek league has an official number that needs no explaining and no
  // date beneath it.
  const windows = isWindowKey(periods[0]);
  return `${windows ? WEEK_CONVENTION : ""}
    <div class="week-strip${windows ? "" : " week-strip-plain"}" role="group" aria-label="${windows ? "Choose a week" : "Choose a matchweek"}">
      ${periods.map((period) => {
        const isSelected = String(period) === String(selected);
        const isCurrent = String(period) === String(current);
        const past = comparePeriods(period, current) < 0;
        return `<button type="button"
          class="week-chip${isCurrent ? " is-current" : ""}${isSelected ? " is-selected" : ""}${past ? " is-past" : ""}"
          ${attribute}="${escapeHTML(period)}"
          ${isCurrent ? 'data-week-anchor="1"' : ""}
          aria-current="${isCurrent ? "date" : "false"}">
          <b>${escapeHTML(periodLabel(period))}</b>
          ${windows ? `<em>${escapeHTML(weekDateRange(period))}</em>` : ""}
        </button>`;
      }).join("")}
    </div>`;
}

/**
 * The season view: every week of the season, each month named once and the
 * chips reduced to the day range under it.
 */
function weekSeasonPicker(selected, attribute) {
  const periods = periodsInOrder().filter(isWindowKey);
  if (!periods.length) return "";
  const current = leagueState?.currentPeriod ?? currentPeriodKey();
  const months = [];
  for (const period of periods) {
    const key = weekMonthKey(period);
    if (!months.length || months[months.length - 1].key !== key) {
      months.push({ key, label: weekMonthLabel(period), weeks: [] });
    }
    months[months.length - 1].weeks.push(period);
  }
  return `${WEEK_CONVENTION}
    <div class="week-months">
      ${months.map((month) => `<div class="week-month">
        <span class="week-month-label">${escapeHTML(month.label)}</span>
        <div class="week-month-row" role="group" aria-label="${escapeHTML(month.label)}">
          ${month.weeks.map((period) => {
            const isSelected = String(period) === String(selected);
            const isCurrent = String(period) === String(current);
            const past = comparePeriods(period, current) < 0;
            return `<button type="button"
              class="week-day-chip${isCurrent ? " is-current" : ""}${isSelected ? " is-selected" : ""}${past ? " is-past" : ""}"
              ${attribute}="${escapeHTML(period)}"
              aria-label="Week ${weekNumberFor(period)}, ${escapeHTML(weekDateRange(period))}">${escapeHTML(weekDayRange(period))}</button>`;
          }).join("")}
        </div>
      </div>`).join("")}
    </div>`;
}

/**
 * How a period is named everywhere in the app.
 *
 * A window league counts its own weeks — "Week 11" — and states the
 * Tuesday-to-Monday convention once per screen instead of prefixing every
 * mention with it. A single-competition league keeps its official matchweek.
 *
 * `periodLabelLong` adds the date range for the places where knowing *which*
 * dates genuinely helps: the picker, and the button that opens it.
 */
const periodLabel = (period) => {
  if (!isWindowKey(period)) return `Matchweek ${period}`;
  const week = weekNumberFor(period);
  // Before fixtures load there is no week ordering to count against; the date
  // range is still true, so fall back to it rather than to "Week null".
  return week == null ? windowLabel(period) : `Week ${week}`;
};

const periodLabelLong = (period) => {
  if (!isWindowKey(period)) return periodLabel(period);
  const week = weekNumberFor(period);
  return week == null ? windowLabel(period) : `Week ${week} · ${weekDateRange(period)}`;
};

/** Chronological order for periods: window keys as strings, matchweeks as numbers. */
const comparePeriods = (a, b) => {
  const numeric = Number(a) - Number(b);
  return Number.isNaN(numeric) ? String(a).localeCompare(String(b)) : numeric;
};

/** Every period in the loaded fixture list, in order. */
function periodsInOrder() {
  return [...new Set(fixtures.map(periodOfFixture).filter((key) => key != null))].sort(comparePeriods);
}

/** The earliest period that has not finished kicking off. */
function currentPeriodKey() {
  const now = Date.now();
  const upcoming = fixtures.find((fixture) => Date.parse(fixture.startAt || "") > now);
  return periodOfFixture(upcoming || fixtures[fixtures.length - 1]) ?? periodsInOrder()[0] ?? null;
}

// Which competition the fixtures currently in memory belong to. Compared
// against the active league rather than against the last remembered value,
// because on a first run there is nothing remembered and the fixtures loaded
// before the league state arrived — that mismatch is exactly the case that
// would otherwise render a Championship league against Premier League cards.
let loadedCompetition = null;
// Fixtures for competitions the ACTIVE league does not play, fetched only for
// My Predictions so a second league on another competition can still render its
// section. Deliberately separate from `fixtures`, which stays exactly the
// active league's world so Next and Schedule are unaffected.
let extraFixtures = {};

/**
 * Loads any competition a league needs that the active one does not, into the
 * side map. One request per missing competition, once.
 */
async function loadFixturesForLeagues() {
  const wanted = new Set();
  for (const code of leagueCodes) {
    const state = leagueState?.code === code ? leagueState : leagueStates[code];
    for (const competition of state?.competitions || []) {
      if (competitionEnabled(competition)) wanted.add(competition);
    }
  }
  const have = new Set(activeCompetitions());
  const missing = [...wanted].filter((code) => !have.has(code) && !extraFixtures[`__loaded_${code}`]);
  if (!missing.length) return;
  await Promise.allSettled(missing.map(async (code) => {
    const data = await loadOneCompetition(code, false);
    const next = { ...extraFixtures, [`__loaded_${code}`]: true };
    for (const fixture of data.fixtures || []) next[String(fixture.id)] = fixture;
    extraFixtures = next;
  }));
}

function rememberCompetition(codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).filter(competitionEnabled);
  if (!list.length) return false;
  localStorage.setItem(STORAGE.competition, JSON.stringify(list));
  return list.join("+") !== loadedCompetition;
}

async function loadLeagueState() {
  if (!activeLeague || !API) { leagueState = null; roundState = null; return; }
  try {
    // `uid` asks the worker for this viewer's own Trophy Cabinet alongside the
    // table; older workers simply ignore it.
    leagueState = await api(`/state?code=${encodeURIComponent(activeLeague)}&uid=${encodeURIComponent(uid())}`);
    if (rememberCompetition(leagueState.competitions || leagueState.competition)) await loadFixtures();
    saveLeagueName(leagueState.code, leagueState.name);
    cacheLeagueState(leagueState);
  } catch (error) {
    roundState = null;
    if (/league not found/i.test(error.message)) {
      forgetLeagueState(activeLeague);
      removeStoredLeague(activeLeague);
      if (activeLeague) return loadLeagueState();
      leagueState = null;
      return;
    }
    leagueState = { error: error.message, code: activeLeague };
    return;
  }
  if (leagueSupportsRounds(leagueState)) {
    if (selectedPeriod == null) selectedPeriod = leagueState.currentPeriod ?? currentPeriodKey();
    // The round table is a SECOND /state call. Paint the season state we already
    // hold rather than holding the whole screen back for it.
    if (leagueTab === "matchday") {
      render();
      await loadRoundState();
    }
  } else {
    leagueTab = "season"; // Old worker cache: fall back to the season-only UI.
  }
}

async function loadRoundState() {
  if (!activeLeague || !API || selectedPeriod == null) { roundState = null; return; }
  try {
    roundState = await api(`/state?code=${encodeURIComponent(activeLeague)}&period=${encodeURIComponent(selectedPeriod)}`);
  } catch (error) {
    roundState = { error: error.message };
  }
}

async function loadKnownLeagueNames() {
  if (!API || !leagueCodes.length) return;
  const missingCodes = leagueCodes.filter((code) => !leagueNames[code] && code !== leagueState?.code);
  if (!missingCodes.length) return;
  const states = await Promise.allSettled(missingCodes.map((code) => api(`/state?code=${encodeURIComponent(code)}&uid=${encodeURIComponent(uid())}`)));
  states.forEach((result) => {
    if (result.status !== "fulfilled") return;
    saveLeagueName(result.value.code, result.value.name);
    // These responses are full season states — cache them rather than throw
    // away everything but the name.
    cacheLeagueState(result.value);
  });
}

/**
 * Caches one league's season state. Trimmed to the leagues this device is
 * actually in, so a left or deleted league cannot linger in storage.
 */
function cacheLeagueState(state) {
  if (!state?.code || state.error) return;
  leagueStates = { ...leagueStates, [state.code]: state };
  const kept = Object.fromEntries(Object.entries(leagueStates).filter(([code]) => leagueCodes.includes(code)));
  leagueStates = kept;
  try {
    localStorage.setItem(STORAGE.leagueStates, JSON.stringify(kept));
  } catch {
    // A full quota must never break switching; the in-memory cache still works.
  }
}

function forgetLeagueState(code) {
  if (!code || !(code in leagueStates)) return;
  const { [code]: _gone, ...rest } = leagueStates;
  leagueStates = rest;
  try { localStorage.setItem(STORAGE.leagueStates, JSON.stringify(rest)); } catch { /* see above */ }
}

/**
 * Renames one member everywhere this device already holds them: the live state,
 * the cached copy, and the round table if one is loaded. The server is the
 * source of truth, but it reads members through an eventually-consistent list,
 * so waiting for it is what produced a stale name on screen.
 */
function applyNickLocally(code, memberUid, nick) {
  const rename = (rows) => (rows || []).map((row) => (row.uid === memberUid ? { ...row, nick } : row));
  if (leagueState && !leagueState.error && leagueState.code === code) {
    leagueState = {
      ...leagueState,
      table: rename(leagueState.table),
      reveals: (leagueState.reveals || []).map((reveal) => ({ ...reveal, picks: rename(reveal.picks) })),
      cabinet: leagueState.cabinet && leagueState.cabinet.uid === memberUid
        ? { ...leagueState.cabinet, nick }
        : leagueState.cabinet,
    };
    cacheLeagueState(leagueState);
  }
  if (roundState && !roundState.error) {
    roundState = { ...roundState, table: rename(roundState.table), podium: rename(roundState.podium) };
  }
  const cached = leagueStates[code];
  if (cached && cached !== leagueState) {
    leagueStates = { ...leagueStates, [code]: { ...cached, table: rename(cached.table) } };
  }
}

/**
 * Warms the cache for every league the viewer is NOT currently looking at, so
 * the first tap on another pill is already a cache hit. Fire-and-forget: it
 * renders nothing and its failures are silent.
 */
async function prefetchLeagueStates() {
  if (!API) return;
  const others = leagueCodes.filter((code) => code !== activeLeague);
  if (!others.length) return;
  await Promise.allSettled(others.map(async (code) => {
    const state = await api(`/state?code=${encodeURIComponent(code)}&uid=${encodeURIComponent(uid())}`);
    cacheLeagueState(state);
    saveLeagueName(state.code, state.name);
  }));
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

/**
 * Switches league. The pill activates and the table paints on the same tick as
 * the tap: the cached season state is good enough to look at, and the network
 * refresh happens behind it. Only a league we have never seen shows a loading
 * state, and only for as long as its first /state takes.
 */
function setActiveLeague(code, refresh = true) {
  activeLeague = code || "";
  selectedPeriod = null;
  roundState = null;
  if (activeLeague) localStorage.setItem(STORAGE.activeLeague, activeLeague);
  else localStorage.removeItem(STORAGE.activeLeague);
  // Paint from cache first — this is the whole point.
  leagueState = activeLeague ? (leagueStates[activeLeague] || null) : null;
  if (leagueState && leagueSupportsRounds(leagueState)) {
    selectedPeriod = leagueState.currentPeriod ?? currentPeriodKey();
  }
  render();
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
  // A mixed league has no season length and no single fixture total — it runs on
  // calendar windows — so it is described by its competitions rather than given
  // a count that would have to be invented.
  const rounds = seasonRounds();
  const eyebrow = rounds == null
    ? `${escapeHTML(competitionName())} 2026/27`
    : `${escapeHTML(competitionName())} 2026/27 · ${countPhrase(rounds, "Matchweeks")}`;
  const scope = rounds == null
    ? "Every fixture across your competitions."
    : `All ${countPhrase(rounds * (activeCompetition() === "ELC" ? 12 : 10), "fixtures")}.`;
  return `<section class="hero">
    <span class="eyebrow">${eyebrow}</span>
    <h1>Predict the scores.</h1>
    <p>${scope} Private leagues. Picks lock at kick-off.</p>
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

/**
 * The Schedule's grouping — keyed on the SAME period abstraction as everything
 * else, so a mixed league sees its own Tuesday-to-Monday windows rather than a
 * matchweek number that means nothing to it.
 *
 * The current period opens; every future period is collapsed but expandable.
 * None of them is hidden.
 */
function groupedPeriods(list, currentPeriod = null) {
  const current = currentPeriod ?? currentPeriodKey();
  return [...new Set(list.map(periodOfFixture).filter((key) => key != null))]
    .sort(comparePeriods)
    .map((period) => {
      const matches = list.filter((fixture) => periodOfFixture(fixture) === period);
      const key = `md-${period}`;
      const firstDate = matches[0]?.date;
      // Once the viewer has opened or closed anything, their choice wins; until
      // then the current week is the one that starts open.
      const open = openScheduleDates.has(key) || (!openScheduleDates.size && String(period) === String(current));
      return `<details class="day-card" data-day-card="${escapeHTML(key)}" ${open ? "open" : ""}>
        <summary>
          <div><strong>${escapeHTML(periodLabel(period))}</strong><span>${
            isWindowKey(period)
              // The week's own range, not the first fixture's date — a week
              // that opens on a Friday would otherwise look like a Friday.
              ? escapeHTML(weekDateRange(period))
              : firstDate ? dateLabel(firstDate, true) : ""}</span></div>
          <span>${countPhrase(matches.length, matches.length === 1 ? "fixture" : "fixtures")}</span>
        </summary>
        <div class="day-body">${matches.map(matchCard).join("")}</div>
      </details>`;
    }).join("");
}

// My Picks still groups by matchweek, which is what it has always done.
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

/** True when the league publishes itself and needs no host step at all. */
function setAndForgetActive() {
  return !!leagueState && !leagueState.error &&
    (leagueState.setAndForget === true || (leagueState.weeklyRule && leagueState.weeklyRule.method !== "manual"));
}

// The PUBLISHED slate governing a period, or null while the league is still
// waiting on one. The worker never reports a draft here.
function slateForPeriod(period) {
  const slate = leagueState?.currentSlate;
  return slate && String(slate.period ?? slate.matchweek) === String(period) ? slate : null;
}

function hostNickname() {
  return (leagueState?.table || []).find((row) => row.uid === leagueState?.owner)?.nick || "your host";
}

// True while a league is waiting on a published slate for this period. Under
// v1.5 that is every league, not just the ones running Custom Mix.
function awaitingSlate(period) {
  if (!leagueState || leagueState.error) return false;
  return String(leagueState.currentPeriod) === String(period) && !slateForPeriod(period);
}

/** "Sat 16 Aug, 12:30" — the concrete moment a line-up stops being editable. */
function lockTimeLabel(slate) {
  const at = slate?.lockAt ? Date.parse(slate.lockAt) : NaN;
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  }).format(new Date(at)).replace(/(\d{2}:\d{2})$/, ", $1").replace(/,\s*,/, ",");
}

/**
 * What the league is told about the deadline. Before the first kickoff the
 * line-up can still be amended, so both host and members see when that stops.
 */
function lockLine(slate) {
  if (!slate) return "";
  if (slate.locked) return `<p class="lock-line is-locked">Line-up locked — the first fixture has kicked off.</p>`;
  const when = lockTimeLabel(slate);
  return when ? `<p class="lock-line">Locks ${escapeHTML(when)}</p>` : "";
}

function slateNotice(period) {
  const published = slateForPeriod(period);
  // Published and still amendable: the host can change the line-up, and both
  // sides are told when that stops.
  if (published) {
    const canEdit = isLeagueHost() && !published.locked;
    return `<div class="slate-notice slate-notice-published">
      ${lockLine(published)}
      ${canEdit ? `<button class="secondary wide" type="button" data-open-picker="${escapeHTML(period)}" data-amend="1">Edit line-up</button>` : ""}
    </div>`;
  }
  if (!awaitingSlate(period)) return "";
  if (isLeagueHost() && !setAndForgetActive()) {
    // The copy splits on what the league runs on: a single-competition league
    // has a real matchweek number to name, a windowed one does not.
    const headline = isWindowKey(period)
      ? `Set this week's fixtures for ${escapeHTML(leagueState.name)}`
      : `Matchweek ${escapeHTML(period)} is open — set your fixtures`;
    const draft = leagueState?.currentDraft;
    return `<div class="slate-notice slate-notice-host">
      <p>${headline}</p>
      ${draft ? `<p class="slate-draft-note">You have a draft of ${countPhrase(draft.count, draft.count === 1 ? "fixture" : "fixtures")} saved.</p>` : ""}
      <button class="primary wide" type="button" data-open-picker="${escapeHTML(period)}">${draft ? "Finish your picks" : `Pick fixtures for ${escapeHTML(periodLabelLong(period))}`}</button>
    </div>`;
  }
  if (setAndForgetActive()) {
    return `<div class="slate-notice"><p>This week's fixtures publish automatically — nothing for anyone to do.</p></div>`;
  }
  return `<div class="slate-notice"><p>Waiting for ${escapeHTML(hostNickname())} to set this week's fixtures</p></div>`;
}

function slateSummary(slate) {
  if (!slate || slate.mode !== "custom") return "";
  return `<p class="slate-summary">${escapeHTML(competitionName())} · ${countPhrase(slate.count, slate.count === 1 ? "fixture" : "fixtures")} this week</p>`;
}

// --- The launch decision tree ----------------------------------------------
// v1.5 §9(7). A blank Next tab is a design gap, not a state, so on every launch
// the app asks four questions in order and always lands somewhere with content.

/** The fixtures this viewer owes a pick on, in the active league's current period. */
function picksDue() {
  const period = leagueState?.currentPeriod ?? currentPeriodKey();
  const slate = slateForPeriod(period);
  if (!slate) return [];
  const chosen = new Set(slate.fixtureIds.map(String));
  return fixtures.filter((fixture) => chosen.has(String(fixture.id)) && matchOpen(fixture));
}

/**
 * Which branch the launch lands on:
 *   picks      (a) something to pick right now  -> Next
 *   awaiting   (b) a league, but no published slate yet -> Schedule
 *   onboarding (c) no league at all -> Next, with the two CTAs
 *   preseason  (d) nothing is pickable yet -> Next, with proof of life
 */
function launchBranch() {
  if (!leagueCodes.length) return "onboarding";
  if (picksDue().length) return "picks";
  const period = leagueState?.currentPeriod ?? currentPeriodKey();
  if (slateForPeriod(period)) return "picks";           // published, all picked already
  // Pre-season is "nothing is pickable yet", which is a question about the
  // fixture pool rather than about the calendar: a league whose current period
  // has no fixtures at all has nothing to await, only fixtures to show.
  const poolThisPeriod = period == null
    ? []
    : fixtures.filter((fixture) => periodOfFixture(fixture) === String(period));
  if (!fixtures.length || !poolThisPeriod.length) return "preseason";
  return "awaiting";
}

// True once the viewer has chosen a tab themselves. The launch tree is only
// ever allowed to move them before that.
let launchRouted = false;

/**
 * Sets the opening tab from the branch.
 *
 * Called again as league state and fixtures arrive, because on a cold install
 * the first evaluation has neither and can only answer "preseason". Re-running
 * it is what stops a first run landing somewhere the second run wouldn't — and
 * it stops the moment the viewer taps a tab of their own.
 */
function applyLaunchBranch() {
  if (launchRouted) return;
  currentView = launchBranch() === "awaiting" ? "schedule" : "today";
}

function onboardingState() {
  return `<div class="section-head"><div><span class="eyebrow">Welcome to Prem Oracle</span><h2>Play against your mates</h2></div></div>
    <div class="launch-card">
      <p>Set up a private league, choose your competitions and how each week works, then share the code.</p>
      <button class="primary wide" type="button" data-view="league" data-launch-create>Create a league</button>
      <button class="secondary wide" type="button" data-view="league">Join a league</button>
    </div>`;
}

/** Proof of life before anything is pickable: real fixtures, badges and dates. */
function preseasonState() {
  const upcoming = fixtures
    .filter((fixture) => Date.parse(fixture.startAt || "") > Date.now())
    .slice(0, 8);
  return `<div class="section-head">
      <div><span class="eyebrow">${escapeHTML(competitionName())} 2026/27</span><h2>Coming up</h2>
      <p>Fixtures are loading for the new season. Picks open when your league's weekly slate is published.</p></div>
    </div>
    ${upcoming.length
      ? `<div class="proof-of-life">${upcoming.map(preseasonRow).join("")}</div>`
      : `<div class="empty"><strong>Fixtures on their way</strong><p>Pull down in a moment — the season list is still loading.</p></div>`}`;
}

function preseasonRow(match) {
  const code = competitionOfFixture(match.id) || DEFAULT_COMPETITION;
  return `<div class="proof-row">
    <span class="proof-teams">${teamBadge(match.player1)}<em>v</em>${teamBadge(match.player2)}</span>
    <span class="comp-chip comp-chip-${code.toLowerCase()}">${escapeHTML(competitionMeta(code).chip)}</span>
    <span class="proof-date">${escapeHTML(matchTime(match))}</span>
  </div>`;
}

/**
 * Next: purely "your picks due this week". Not today's card, not the whole
 * matchweek — the fixtures this viewer's league published and this viewer still
 * owes a scoreline on.
 */
function todayView() {
  const branch = launchBranch();
  if (branch === "onboarding") return `${installNotice()}${onboardingState()}`;
  if (branch === "preseason") return `${hero()}${installNotice()}${preseasonState()}`;

  const period = leagueState?.currentPeriod ?? currentPeriodKey();
  const slate = slateForPeriod(period);
  const waiting = awaitingSlate(period);
  const roundFixtures = slate
    ? fixtures.filter((fixture) => slate.fixtureIds.map(String).includes(String(fixture.id)))
    : [];
  const due = roundFixtures.filter((fixture) => matchOpen(fixture) && !picks[fixture.id]);
  const pickedCount = roundFixtures.filter((fixture) => picks[fixture.id]).length;
  const invite = inviteCode && !leagueCodes.includes(inviteCode)
    ? `<div class="notice invite-notice"><span class="notice-icon">🏆</span><div><strong>League invitation: ${inviteCode}</strong><p>Open the League tab to join.</p></div></div>`
    : "";

  const body = waiting || !slate
    ? `<div class="launch-card"><p>No picks due yet — fixtures will appear here when your host publishes this week's slate.</p></div>`
    : due.length
      ? due.map(matchCard).join("")
      : `<div class="launch-card"><p>All done for ${escapeHTML(periodLabel(period))} — every pick is in. Sit back.</p></div>`;

  return `${installNotice()}${invite}
    ${leagueSwitcher()}
    <div class="section-head">
      <div><span class="eyebrow">Your picks due · ${escapeHTML(periodLabel(period))}</span>
      <h2>${escapeHTML(leagueState?.name || "This week")}</h2>
      ${slate ? `<p class="pick-progress">You've picked ${pickedCount} of ${roundFixtures.length}</p>` : ""}${slateSummary(slate)}</div>
    </div>
    ${slateNotice(period)}
    ${body}`;
}

/**
 * Schedule: opens on the current week and keeps every future week COLLAPSED but
 * expandable. Nothing is ever hidden — a week the host has not published yet is
 * still a week the league can see coming.
 */
function scheduleView() {
  const current = leagueState?.currentPeriod ?? currentPeriodKey();
  const filtered = fixtures.filter((fixture) => matchdayFilter === "all" || String(periodOfFixture(fixture)) === String(matchdayFilter));
  const awaiting = leagueCodes.length && current != null && !slateForPeriod(current);
  return `<div class="section-head"><div><span class="eyebrow">Full season</span><h2>Prediction schedule</h2></div></div>
    ${awaiting ? `<div class="launch-card"><p>No picks due yet — fixtures will appear here when your host publishes this week's slate.</p></div>` : ""}
    <div class="filters filters-week"><button class="filter${matchdayFilter === "all" ? " active" : ""}" data-filter="all">${isMixedActive() ? "All weeks" : "All rounds"}</button></div>
    ${weekStrip(matchdayFilter, "data-filter")}
    ${groupedPeriods(filtered, current)}`;
}

// --- My Predictions ---------------------------------------------------------
// One section per league, then everything else. A pick is only ever HIDDEN, and
// only in one case: a line-up amendment dropped its fixture and no league the
// viewer plays still lists it. The stored pick is untouched, so if a later
// amendment puts the fixture back the prediction reappears already made.

/** The leagues this device knows about, with what each is asking for. */
function leaguePickContexts() {
  return leagueCodes
    .map((code) => (leagueState?.code === code && !leagueState.error ? leagueState : leagueStates[code]))
    .filter((state) => state && !state.error && state.code)
    .map((state) => ({
      code: state.code,
      name: state.name || leagueNames[state.code] || state.code,
      lineup: new Set((state.lineupFixtureIds || []).map(String)),
      dropped: new Set((state.droppedFixtureIds || []).map(String)),
    }));
}

/**
 * Picks the viewer should not be shown: dropped by an amendment somewhere, and
 * not asked for by any of their leagues now. A viewer with no leagues hides
 * nothing, and a pick on a fixture that was never in anybody's line-up is never
 * hidden — it simply was not dropped.
 */
function hiddenPickIds(contexts = leaguePickContexts()) {
  const hidden = new Set();
  if (!contexts.length) return hidden;
  const stillAsked = new Set();
  for (const league of contexts) for (const id of league.lineup) stillAsked.add(id);
  for (const league of contexts) {
    for (const id of league.dropped) if (!stillAsked.has(id)) hidden.add(id);
  }
  return hidden;
}

/** A fixture by id, from whatever the app currently holds. */
const fixtureById = (id) => fixtures.find((fixture) => String(fixture.id) === String(id)) || extraFixtures[String(id)] || null;

/** Every fixture the viewer has predicted and is allowed to see. */
function visiblePickedFixtures(hidden = hiddenPickIds()) {
  return Object.keys(picks)
    .filter((id) => !hidden.has(String(id)))
    .map(fixtureById)
    .filter(Boolean)
    .sort(byKickoffAsc);
}

const byKickoffAsc = (a, b) =>
  (Date.parse(a.startAt || "") || 0) - (Date.parse(b.startAt || "") || 0) || String(a.id).localeCompare(String(b.id));

/** "also in Sunday Six" — so a pick shared across leagues syncing is no surprise. */
function sharedLeagueNote(fixtureId, contexts, thisCode) {
  const others = contexts
    .filter((league) => league.code !== thisCode && league.lineup.has(String(fixtureId)))
    .map((league) => league.name);
  if (!others.length) return "";
  return `<p class="pick-shared">Also in ${escapeHTML(others.join(", "))} — one pick counts in both.</p>`;
}

/**
 * Groups a section's fixtures into the weeks that league runs on. Labelled by
 * date range rather than week number: the number comes from the ACTIVE league's
 * ordering, which is not this league's when the two play different competitions.
 */
function pickWeekGroups(list, mixed) {
  const keyOf = (fixture) => (mixed
    ? windowKeyFor(fixture.startAt)
    : fixture.matchday == null ? null : String(fixture.matchday));
  const groups = new Map();
  for (const fixture of list) {
    const period = keyOf(fixture);
    if (period == null) continue;
    if (!groups.has(period)) groups.set(period, []);
    groups.get(period).push(fixture);
  }
  return [...groups.entries()]
    .sort((a, b) => comparePeriods(a[0], b[0]))
    .map(([period, matches]) => ({
      period,
      label: isWindowKey(period) ? weekDateRange(period) : `Matchweek ${period}`,
      matches,
    }));
}

function pickEntry(fixture, note) {
  return `<div class="pick-entry">${matchCard(fixture)}${note}</div>`;
}

/**
 * One collapsible section. The count rides in the header so a collapsed league
 * still says how much is inside it, and the open/closed state is remembered —
 * a viewer in five leagues should not have to re-close four of them every time.
 */
function pickSection(title, subtitle, groups, contexts, code) {
  if (!groups.length) return "";
  const key = code || "__other";
  const count = groups.reduce((total, group) => total + group.matches.length, 0);
  const open = !collapsedPickSections.has(key);
  return `<details class="pick-section" data-pick-section="${escapeHTML(key)}"${open ? " open" : ""}>
    <summary class="pick-section-head">
      <div class="pick-section-title">
        <h3>${escapeHTML(title)}</h3>
        ${subtitle ? `<span>${escapeHTML(subtitle)}</span>` : ""}
      </div>
      <span class="pick-section-count">${countPhrase(count, count === 1 ? "pick" : "picks")}</span>
    </summary>
    <div class="pick-section-body">
      ${groups.map((group) => `<div class="pick-week">
        <span class="pick-week-label">${escapeHTML(group.label)}</span>
        ${group.matches.map((fixture) => pickEntry(fixture, code ? sharedLeagueNote(fixture.id, contexts, code) : "")).join("")}
      </div>`).join("")}
    </div>
  </details>`;
}

function picksView() {
  const contexts = leaguePickContexts();
  const hidden = hiddenPickIds(contexts);
  const visible = visiblePickedFixtures(hidden);
  const head = `<div class="section-head"><div><span class="eyebrow">${playerName || "Your profile"}</span><h2>My predictions</h2><p>Synced securely when online; cached on this device</p></div></div>
    <div class="stats-grid stats-grid-single">
      <div class="stat"><b>${visible.length}</b><span>Picks made</span></div>
    </div>`;
  const empty = `<div class="empty"><strong>No picks yet</strong><p>Choose a scoreline on any fixture before kick-off.</p></div>`;

  // No leagues: the plain week-grouped list, exactly as before.
  if (!contexts.length) {
    return `${head}${visible.length ? groupedMatchdays(visible) : empty}`;
  }

  const claimed = new Set();
  const sections = contexts.map((league) => {
    const mine = visible.filter((fixture) => league.lineup.has(String(fixture.id)));
    mine.forEach((fixture) => claimed.add(String(fixture.id)));
    const state = leagueState?.code === league.code ? leagueState : leagueStates[league.code];
    const mixed = (state?.competitions || []).length > 1;
    return pickSection(league.name, null, pickWeekGroups(mine, mixed), contexts, league.code);
  }).join("");

  // Anything predicted outside every current line-up — solo play lives here.
  const others = visible.filter((fixture) => !claimed.has(String(fixture.id)));
  const otherSection = pickSection("Your other predictions",
    "Not in any of your leagues' line-ups", pickWeekGroups(others, isMixedActive()), contexts, null);

  const body = `${sections}${otherSection}`;
  return `${head}${body.trim() ? body : empty}`;
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

/** Every competition a league plays, named. A mixed league is both, not the first. */
function leagueCompetitionNames(state) {
  const codes = Array.isArray(state?.competitions) && state.competitions.length
    ? state.competitions
    : [state?.competition || DEFAULT_COMPETITION];
  return codes.map((code) => competitionMeta(code).name).join(" + ");
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
  return `Prem Oracle ${leagueCompetitionNames(state)} table - ${state.name}\nUpdated ${updated}\n\n${rows.join("\n")}\n\nJoin on the web or in the app with code ${state.code}`;
}

function winnerNames(round) {
  return (round?.winners || [])
    .map((winnerUid) => (round.table || []).find((row) => row.uid === winnerUid)?.nick)
    .filter(Boolean)
    .join(" & ");
}

// The shared matchweek result leads with the podium — the same three names,
// in the same order, as the banner on the League tab.
function podiumShareLines(round) {
  const podium = round?.podium || [];
  if (!podium.length) return "";
  const medals = { gold: "🏆", silver: "🥈", bronze: "🥉" };
  return `${podium.map((entry) => `${medals[entry.place]} ${entry.nick} ${entry.pts} pts`).join("\n")}\n\n`;
}

function roundShareText(state, round) {
  const competition = leagueCompetitionNames(state);
  const week = round.matchday != null ? `Matchweek ${round.matchday}` : periodLabel(round.period);
  const head = round.complete
    ? `🏆 ${competition} ${week}: won by ${winnerNames(round) || "nobody"}`
    : `🏆 ${competition} ${week} · in progress`;
  const rows = (round.table || []).map((row, index) => `${row.rank || index + 1}. ${row.nick} - ${row.pts} pts (${row.exact} exact)`);
  return `${head}\n\n${podiumShareLines(round)}${rows.join("\n")}\n\nJoin on the web or in the app with code ${state.code}`;
}

function roundToggle() {
  const period = selectedPeriod ?? leagueState?.currentPeriod ?? currentPeriodKey();
  // The segment that opens the picker names the week the same way the picker
  // does — "Week 11", not "Tue 3 – Mon 9 Nov". Anything else reads as two
  // different controls.
  const week = weekNumberFor(period);
  const label = week == null ? periodLabel(period) : `Week ${week}`;
  return `<div class="round-toggle">
    <button type="button" class="round-seg${leagueTab === "matchday" ? " active" : ""}" data-round-tab="matchday">${escapeHTML(label)} ▾</button>
    <button type="button" class="round-seg${leagueTab === "season" ? " active" : ""}" data-round-tab="season">Season</button>
  </div>`;
}

function matchdayPicker() {
  if (!matchdayPickerOpen) return "";
  const current = selectedPeriod ?? currentPeriodKey();
  // One control for both league shapes: the strip labels itself from the
  // period, so a matchweek league reads "Matchweek 11" and a window league
  // "Week 11 / 3–9 Nov".
  return weekStrip(current, "data-round-md");
}

function fixtureHasResult(match) {
  const result = match?.result;
  if (Array.isArray(result)) return result.length === 2 && result.every((value) => value != null);
  return result?.p1 != null && result?.p2 != null;
}

function seasonBanner(state) {
  // A mixed league has no matchweek numbering and no season length, so it is
  // told where it is in its own terms rather than being given "of null".
  if (state.mixed || seasonRounds() == null) {
    const period = state.currentPeriod;
    const detail = period == null
      ? "season complete"
      : state.currentMatchdayHasResults ? `${periodLabel(period)} in progress` : `next up: ${periodLabel(period)}`;
    return `<div class="round-banner"><strong>Season 2026/27</strong><span>${escapeHTML(detail)}</span></div>`;
  }
  const played = state.currentMatchday == null ? seasonRounds() : Math.max(0, state.currentMatchday - 1);
  const currentMatchdayHasResults = state.currentMatchdayHasResults ||
    fixtures.some((fixture) => fixture.matchday === state.currentMatchday && fixtureHasResult(fixture));
  const detail = currentMatchdayHasResults && state.currentMatchday != null
    ? `Matchweek ${state.currentMatchday} in progress`
    : played === 0 ? `starts Matchweek ${state.currentMatchday || 1}` : `after Matchweek ${played} of ${seasonRounds()}`;
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
  // A "game N of the season" placement only means something where the league
  // has a season length at all.
  // A mixed league runs on windows, so it is placed by its window instead.
  const place = md != null && seasonRounds() != null
    ? `<span class="nowrap">Game ${md} of ${seasonRounds()} ·</span>`
    : `<span class="nowrap">${escapeHTML(periodLabel(round.period))} ·</span>`;
  const title = md != null ? `Matchweek ${md}` : periodLabel(round.period);
  if (round.complete) {
    const names = winnerNames(round);
    return `<div class="round-banner is-success"><strong>${escapeHTML(title)} complete — won by ${names ? escapeHTML(names) : "nobody"} 🏆</strong><span>${place}all fixtures settled</span>${roundSlateLine(round)}${podiumSteps(round)}</div>`;
  }
  if (!round.status || round.status === "in progress") {
    return `<div class="round-banner"><strong>${place}in progress</strong>${roundSlateLine(round)}</div>`;
  }
  return `<div class="round-banner is-pending"><strong>${place}${escapeHTML(round.status)}</strong>${roundSlateLine(round)}</div>`;
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

const SURPRISE_COUNT = DEFAULT_FIXTURE_COUNT;

/** The eligible pool: selected competitions, inside the current period. */
function pickerFixtures() {
  return fixtures
    .filter((fixture) => periodOfFixture(fixture) === String(pickerPeriod))
    .sort((a, b) => (Date.parse(a.startAt || "") || 0) - (Date.parse(b.startAt || "") || 0) ||
      String(a.id).localeCompare(String(b.id)));
}

/** The worker's pre-load for the period the picker is open on, if it has one. */
function pickerPreload() {
  const preload = leagueState?.preload || roundState?.preload;
  return preload && String(preload.period ?? pickerPeriod) === String(pickerPeriod) ? preload : null;
}

/**
 * The week's bounds. v1.5 §9: ONE validation path — the league's count is the
 * default the picker opens on, the floor is one fixture and the ceiling is the
 * pool. It is never a cap on the week the host actually publishes.
 */
function pickerBounds(poolSize) {
  const preload = pickerPreload();
  const rule = leagueState?.weeklyRule;
  const preferred = preload?.count
    ?? rule?.count
    ?? leagueState?.fixtureLimit
    ?? DEFAULT_FIXTURE_COUNT;
  const min = Math.min(MIN_FIXTURE_COUNT, poolSize);
  return {
    mode: rule?.method || (leagueState?.fixtureMode === "limited" ? "manual" : "allEligible"),
    default: Math.max(min, Math.min(preferred, poolSize)),
    min,
    max: poolSize,
    capped: preferred > poolSize,
  };
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
const shuffled = (list) => {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
};

/**
 * "Surprise me" deals a random slate of the right size. In a mixed league it
 * guarantees at least one fixture from each selected competition that actually
 * has fixtures this week, then fills the rest at random from the combined pool.
 * A competition with nothing on is simply absent — never an error, never a
 * blocked dice.
 */
function surpriseSelection(list, wanted) {
  const target = Math.max(1, Math.min(wanted || SURPRISE_COUNT, list.length));
  const byCompetition = new Map();
  for (const fixture of list) {
    const code = competitionOfFixture(fixture.id) || DEFAULT_COMPETITION;
    byCompetition.set(code, [...(byCompetition.get(code) || []), fixture]);
  }
  const chosen = [];
  // One from each represented competition first, while there is room.
  for (const [, group] of byCompetition) {
    if (chosen.length >= target) break;
    chosen.push(shuffled(group)[0]);
  }
  const taken = new Set(chosen.map((fixture) => String(fixture.id)));
  for (const fixture of shuffled(list)) {
    if (chosen.length >= target) break;
    if (taken.has(String(fixture.id))) continue;
    chosen.push(fixture);
    taken.add(String(fixture.id));
  }
  return new Set(chosen.slice(0, target).map((fixture) => String(fixture.id)));
}

// What the picker carried over, and what it could not: a fixture the host had
// drafted that has since been postponed or rescheduled out of the week is named
// rather than silently missing.
let pickerUnavailable = [];
// True when the picker was opened on an already-published line-up.
let pickerAmending = false;
// True while the host's weekly count is being saved, so the stepper cannot be
// double-tapped into a race.
let countBusy = false;

function openFixturePicker(period, amending = false) {
  pickerOpen = true;
  pickerAmending = amending;
  pickerPeriod = String(period);
  pickerMode = "custom";
  pickerConfirmOpen = false;
  pickerBusy = false;
  // The picker opens on the host's own draft where they have one, and on last
  // week's settings where they don't.
  const preload = pickerPreload();
  const available = new Set(pickerFixtures().map((fixture) => String(fixture.id)));
  pickerSelection = new Set((preload?.fixtureIds || []).map(String).filter((id) => available.has(id)));
  pickerUnavailable = preload?.unavailable || [];
}

function closeFixturePicker() {
  pickerOpen = false;
  pickerAmending = false;
  pickerConfirmOpen = false;
  pickerSelection = new Set();
  pickerUnavailable = [];
  pickerPeriod = null;
  pickerBusy = false;
}

function competitionChip(match) {
  if (!isMixedActive()) return "";
  const code = competitionOfFixture(match.id);
  if (!code) return "";
  return `<span class="comp-chip comp-chip-${code.toLowerCase()}">${escapeHTML(competitionMeta(code).chip)}</span>`;
}

function pickerRow(match) {
  const selected = pickerSelection.has(String(match.id));
  return `<button type="button" class="picker-row${selected ? " is-selected" : ""}" data-picker-fixture="${escapeHTML(match.id)}" aria-pressed="${selected}">
    <span class="picker-teams">${teamBadge(match.player1)}<em>v</em>${teamBadge(match.player2)}</span>
    ${competitionChip(match)}
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
      <strong>${pickerAmending
        ? `Update the line-up to ${count} ${count === 1 ? "fixture" : "fixtures"}?`
        : pickerMode === "full" ? `Publish all ${total} fixtures?` : `Publish these ${count} fixtures?`}</strong>
      <p>You can amend the line-up until the first kickoff.</p>
      <div class="picker-confirm-actions">
        <button class="secondary" type="button" data-picker-cancel ${pickerBusy ? "disabled" : ""}>Back</button>
        <button class="primary" type="button" data-picker-commit ${pickerBusy ? "disabled" : ""}>${pickerBusy ? "Publishing…" : pickerAmending ? "Update" : "Publish"}</button>
      </div>
    </div>
  </div>`;
}

const UNAVAILABLE_REASON = {
  postponed: "postponed",
  voided: "called off",
  notInPool: "no longer in this week",
};

/** Names every fixture that could not carry over, and why. Never a silent loss. */
function pickerUnavailableNote() {
  if (!pickerUnavailable.length) return "";
  const listed = pickerUnavailable
    .map((entry) => `${escapeHTML(entry.label || entry.id)} (${UNAVAILABLE_REASON[entry.reason] || "unavailable"})`)
    .join(", ");
  return `<p class="picker-note picker-note-warn">Dropped from your last selection: ${listed}. Pick a replacement if you want one.</p>`;
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
  const bounds = pickerBounds(list.length);
  const count = pickerSelection.size;
  const leagueName = leagueState?.name || "your league";
  const mixed = isMixedActive();
  // The default is a suggestion for this week, not a requirement.
  const counter = bounds.min === bounds.max
    ? `Select ${bounds.max} · ${count} selected`
    : `Select ${bounds.min}–${bounds.max} · ${count} selected`;
  const ready = count >= bounds.min && count <= bounds.max;

  // Grouped under competition headers when the pool spans more than one.
  const present = [...new Set(list.map((fixture) => competitionOfFixture(fixture.id) || DEFAULT_COMPETITION))];
  const body = mixed && present.length > 1
    ? present.map((code) => `<h3 class="picker-group">${escapeHTML(competitionMeta(code).name)}</h3>${
        list.filter((fixture) => (competitionOfFixture(fixture.id) || DEFAULT_COMPETITION) === code).map(pickerRow).join("")
      }`).join("")
    : list.map(pickerRow).join("");

  const notes = [];
  if (bounds.capped) {
    notes.push(`Only ${countPhrase(list.length, list.length === 1 ? "fixture" : "fixtures")} on this week — fewer than your usual ${bounds.default}.`);
  }
  if (!bounds.capped && bounds.max > bounds.min) {
    notes.push(`Your league usually plays ${countPhrase(bounds.default, "fixtures")} — take more or fewer this week if you like.`);
  }
  if (mixed && present.length === 1) {
    const missing = activeCompetitions().find((code) => !present.includes(code));
    if (missing) notes.push(`No ${escapeHTML(competitionMeta(missing).short)} fixtures this week — filling from ${escapeHTML(competitionMeta(present[0]).short)}.`);
  }

  return `<div class="picker-overlay" role="dialog" aria-modal="true" aria-label="Pick your fixtures">
    <header class="picker-head">
      <div><h2>${pickerAmending ? "Edit line-up" : "Pick your fixtures"}</h2><p>${escapeHTML(periodLabelLong(pickerPeriod))} · ${escapeHTML(leagueName)}</p></div>
      <button class="picker-close" type="button" data-picker-close aria-label="Close fixture picker">×</button>
    </header>
    <div class="picker-counter">
      <strong>${counter}</strong>
      <button class="picker-dice" type="button" data-picker-surprise>🎲 <span>Surprise me</span></button>
    </div>
    ${pickerUnavailableNote()}
    ${notes.map((note) => `<p class="picker-note">${note}</p>`).join("")}
    <div class="picker-list">${body}</div>
    <div class="picker-actions">
      <button class="picker-secondary" type="button" data-picker-all>Use all ${list.length} this week</button>
      <button class="primary wide" type="button" data-picker-set ${ready ? "" : "disabled"}>${pickerAmending ? "Update line-up" : "Publish to league"}</button>
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
  // A window league has no matchweek number — it counts its own weeks. Naming
  // it "Matchweek null" is what this said before the cabinet moved up the
  // Season tab and the fault became the first thing you read.
  const weekNumber = weekNumberFor(week.period);
  const title = week.matchweek != null
    ? `Matchweek ${week.matchweek}`
    : weekNumber != null ? `Week ${weekNumber}` : periodLabel(week.period);
  return `<li class="cabinet-week">
    ${award}
    <div class="cabinet-week-main">
      <strong>${escapeHTML(title)}</strong>
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

// --- Create a league wizard -------------------------------------------------
// One card, one button. The League screen offers exactly one way in — "Get
// started" — and the questions arrive one at a time instead of as a form the
// host has to decode. The old two-form "start a competition" framing is retired.

const WIZARD_STEPS = ["name", "competitions", "count", "share"];

let wizard = null;

function openWizard() {
  wizard = {
    step: "name",
    name: "",
    competitions: [availableCompetitions()[0]],
    count: DEFAULT_FIXTURE_COUNT,
    confirmSingle: false, // the soft confirm a one-fixture week asks for
    busy: false,
    code: "",
    error: "",
  };
}

const closeWizard = () => { wizard = null; };

/**
 * The rule the wizard writes. v1.5j: there is no rule CHOICE in the product —
 * every league is manual-first, the host picks and publishes each week, and a
 * week they miss is dealt for them. The scope is still explicit rather than
 * inferred, and the other methods remain valid in the data model for leagues
 * that already carry one.
 */
function wizardRule() {
  const scope = wizard.competitions.length > 1 ? "mixed" : wizard.competitions[0];
  return { method: "manual", competitionScope: scope, count: wizard.count };
}

function wizardProgress() {
  const index = WIZARD_STEPS.indexOf(wizard.step);
  return `<div class="wizard-progress" role="presentation">${WIZARD_STEPS.map((step, position) =>
    `<span class="wizard-dot${position <= index ? " is-done" : ""}${position === index ? " is-current" : ""}"></span>`
  ).join("")}</div>`;
}

function wizardStepName() {
  return `<span class="eyebrow">Step 1 of 4</span>
    <h3>Name your league</h3>
    <p class="wizard-hint">Your mates will see this at the top of the table.</p>
    <input name="leagueName" maxlength="40" placeholder="Saturday Super 6" value="${escapeHTML(wizard.name)}" data-wizard-name autofocus>
    <div class="wizard-actions">
      <button class="primary wide" type="button" data-wizard-next>Next</button>
    </div>`;
}

function wizardStepCompetitions() {
  const codes = availableCompetitions();
  return `<span class="eyebrow">Step 2 of 4</span>
    <h3>Choose competitions</h3>
    <p class="wizard-hint">Select everything your league should draw fixtures from.</p>
    <div class="competition-choice" role="group" aria-label="Competitions">
      ${codes.map((code) => `<label class="competition-option${wizard.competitions.includes(code) ? " is-selected" : ""}">
        <input type="checkbox" name="competitions" value="${code}" data-wizard-competition="${code}"${wizard.competitions.includes(code) ? " checked" : ""}>
        <span>${escapeHTML(competitionMeta(code).short)}</span>
      </label>`).join("")}
    </div>
    <div class="wizard-actions">
      <button class="secondary" type="button" data-wizard-back>Back</button>
      <button class="primary" type="button" data-wizard-next>Next</button>
    </div>`;
}

function wizardStepCount() {
  const single = wizard.count === 1;
  return `<span class="eyebrow">Step 3 of 4</span>
    <h3>Fixtures each week</h3>
    <p class="wizard-hint">How many fixtures should your mates predict each week? You can change this — and pick the fixtures yourself — every week.</p>
    <div class="fixture-count" data-fixture-count>
      <span>Fixtures each week</span>
      <div class="count-stepper">
        <button type="button" data-count-step="-1" aria-label="Fewer fixtures">−</button>
        <b data-count-value>${wizard.count}</b>
        <button type="button" data-count-step="1" aria-label="More fixtures">＋</button>
      </div>
      <input type="hidden" name="fixtureLimit" value="${wizard.count}">
    </div>
    ${single ? `<label class="wizard-confirm">
      <input type="checkbox" data-wizard-confirm-single${wizard.confirmSingle ? " checked" : ""}>
      <span>Short week — just one fixture to call!</span>
    </label>` : ""}
    <div class="wizard-actions">
      <button class="secondary" type="button" data-wizard-back>Back</button>
      <button class="primary" type="button" data-wizard-next ${wizard.busy ? "disabled" : ""}>${wizard.busy ? "Creating…" : "Create league"}</button>
    </div>`;
}

function wizardStepShare() {
  return `<span class="eyebrow">Step 4 of 4</span>
    <h3>Share your code</h3>
    <p class="wizard-hint">Anyone with this code can join ${escapeHTML(wizard.name || "your league")}.</p>
    <div class="league-code wizard-code"><span>League code</span><strong>${escapeHTML(wizard.code)}</strong></div>
    <div class="wizard-actions">
      <button class="primary wide" type="button" data-share-league="${escapeHTML(wizard.code)}">Invite mates</button>
    </div>
    <button class="secondary wide" type="button" data-wizard-done>Done</button>`;
}

const WIZARD_VIEWS = {
  name: wizardStepName,
  competitions: wizardStepCompetitions,
  count: wizardStepCount,
  share: wizardStepShare,
};

function createLeagueCard() {
  if (!wizard) {
    return `<section class="league-form create-card">
      <h3>Create a league</h3>
      <p class="create-hint">Name it, choose your competitions, set how the week works — then share the code.</p>
      <button class="primary wide" type="button" data-wizard-open>Get started</button>
    </section>`;
  }
  return `<section class="league-form wizard" aria-label="Create a league">
    ${wizardProgress()}
    ${wizard.error ? `<p class="wizard-error">${escapeHTML(wizard.error)}</p>` : ""}
    ${WIZARD_VIEWS[wizard.step]()}
    ${wizard.step === "share" ? "" : `<button class="wizard-cancel" type="button" data-wizard-cancel>Cancel</button>`}
  </section>`;
}

/** Validates the step the host is on. Returns an error string, or "". */
function wizardStepError() {
  if (wizard.step === "name" && !wizard.name.trim()) return "Give your league a name";
  if (wizard.step === "competitions" && !wizard.competitions.length) return "Choose at least one competition";
  // A one-fixture week is legal, but it is unusual enough to be worth a nod.
  if (wizard.step === "count" && wizard.count === 1 && !wizard.confirmSingle) {
    return "Short week — just one fixture to call! Tick to confirm.";
  }
  return "";
}

async function advanceWizard() {
  const error = wizardStepError();
  if (error) { wizard.error = error; render(); return; }
  wizard.error = "";
  const index = WIZARD_STEPS.indexOf(wizard.step);
  if (wizard.step !== "count") {
    wizard.step = WIZARD_STEPS[index + 1];
    render();
    return;
  }
  wizard.busy = true;
  render();
  try {
    const response = await api("/league", {
      uid: uid(), nickname: playerName,
      name: wizard.name.trim(),
      competitions: wizard.competitions,
      weeklyRule: wizardRule(),
      // Kept in step for a worker that predates the rule.
      // Kept in step for a worker that predates the rule; every wizard league
      // is manual, so this is always the limited shape.
      fixtureMode: "limited",
      fixtureLimit: wizard.count,
    });
    saveLeague(response.code);
    saveLeagueName(response.code, response.name);
    if (response.recovery) localStorage.setItem(STORAGE.recovery, response.recovery);
    if (rememberCompetition(response.competitions || response.competition)) await loadFixtures();
    wizard.code = response.code;
    wizard.step = "share";
    wizard.busy = false;
    await loadLeagueState();
  } catch (error) {
    wizard.busy = false;
    wizard.error = error.message;
  }
  render();
}

/** "Premier League · 6 fixtures/week" — what this league actually includes. */
function leagueSummaryLine(state) {
  const names = (state?.competitions || [state?.competition || DEFAULT_COMPETITION])
    .map((code) => competitionMeta(code).name).join(" + ");
  const rule = state?.weeklyRule;
  if (rule?.method === "allEligible") return `${names} · every fixture`;
  if (rule?.method === "allCompetition") return `${names} · every ${competitionMeta(rule.competitionScope).short} fixture`;
  // "~" because the count is a rule of thumb: individual weeks can differ.
  if (rule?.method === "random") return `${names} · ~${rule.count} random fixtures/week`;
  // Plain text: the caller escapes this line, so markup here would show as tags.
  if (rule?.method === "manual") return `${names} · ${rule.count} fixtures/week`;
  // A worker that predates the rule still answers with the old fields.
  if (state?.fixtureMode !== "limited") return `${names} · every fixture`;
  const limit = state?.fixtureLimit;
  return limit == null ? `${names} · host picks each week` : `${names} · ~${limit} fixtures/week`;
}

/**
 * The host's one standing setting: how many fixtures a week this league plays.
 *
 * v1.5j removed the rule choice from creation, so this is all that is left to
 * edit — and it is worth editing, because a host who opened on six may want
 * eight by October. It is the default the picker opens on and the number the
 * fallback deals; the week actually published is still whatever the host takes
 * in the picker.
 */
function weeklyCountControl(state) {
  if (!state || state.error || state.owner !== uid()) return "";
  // A league still carrying one of the retired every-fixture methods plays its
  // whole card regardless of the count, so offering a stepper would be a lie.
  const method = state.weeklyRule?.method || "manual";
  if (method === "allEligible" || method === "allCompetition") return "";
  const count = state.weeklyRule?.count ?? state.fixtureLimit ?? DEFAULT_FIXTURE_COUNT;
  return `<div class="fixture-count league-count" data-league-count="${escapeHTML(state.code)}">
    <span>Fixtures each week</span>
    <div class="count-stepper">
      <button type="button" data-league-count-step="-1" aria-label="Fewer fixtures each week"${countBusy ? " disabled" : ""}>−</button>
      <b data-count-value>${count}</b>
      <button type="button" data-league-count-step="1" aria-label="More fixtures each week"${countBusy ? " disabled" : ""}>＋</button>
    </div>
  </div>`;
}

/**
 * The host's control for the current period on the League card: publish it if
 * it has not gone out, edit it if it has and is still amendable, and either way
 * say when it locks. The Next tab shows the same states through slateNotice —
 * both read the one published slate, so they cannot disagree.
 */
function hostSlateControl(state) {
  if (!state || state.error || state.currentPeriod == null) return "";
  const isOwner = state.owner === uid();
  const slate = state.currentSlate;
  if (!slate) {
    return isOwner
      ? `<button class="primary wide host-slate-banner" type="button" data-open-picker="${escapeHTML(state.currentPeriod)}">Pick fixtures for ${escapeHTML(periodLabelLong(state.currentPeriod))}</button>`
      : "";
  }
  return `<div class="slate-notice slate-notice-published">
    ${lockLine(slate)}
    ${isOwner && !slate.locked
      ? `<button class="secondary wide" type="button" data-open-picker="${escapeHTML(state.currentPeriod)}" data-amend="1">Edit line-up</button>`
      : ""}
  </div>`;
}

function leagueView() {
  const recovery = localStorage.getItem(STORAGE.recovery);
  const joinDefault = inviteCode && !leagueCodes.includes(inviteCode) ? inviteCode : "";
  const controls = `<div class="league-actions">
    ${createLeagueCard()}
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
  const shareLabel = showMatchday && roundState && !roundState.error && roundState.period != null
    ? (roundState.matchday != null ? `Share Matchweek ${roundState.matchday} result` : `Share ${periodLabel(roundState.period)} results`)
    : "Share table to WhatsApp";
  let inner;
  if (showMatchday) {
    inner = !roundState
      ? `<div class="empty"><strong>Loading matchweek…</strong></div>`
      : roundState.error
        ? `<div class="empty"><strong>${escapeHTML(roundState.error)}</strong></div>`
        : `${roundBanner(roundState)}${roundTableHtml(roundState)}`;
  } else if (supportsRounds) {
    // A window league gets the whole season laid out by month here — every week
    // named once, so jumping to one is a tap rather than a scroll through forty.
    const seasonWeeks = isMixedActive() ? weekSeasonPicker(selectedPeriod, "data-round-md") : "";
    // Order matters here: where you stand, then how you got there. The cabinet
    // is the reward and sits under the season header; the table is what people
    // actually come to the Season tab for, so it comes before the week pills,
    // which are navigation and belong at the bottom.
    inner = `${seasonBanner(state)}${trophyCabinet(state)}${seasonTableHtml(state, isOwner, true)}${seasonWeeks}${leagueRevealsHtml(state)}`;
  } else if (state && !state.error) {
    // Resilient fallback: an old worker response without round data.
    inner = `${seasonTableHtml(state, isOwner, false)}${leagueRevealsHtml(state)}`;
  }
  const content = !state
    ? `<div class="empty"><strong>Loading league...</strong></div>`
    : state.error
      ? `<div class="empty"><strong>${escapeHTML(state.error)}</strong></div>`
      : `<section class="league-card">
          <span class="eyebrow">${escapeHTML(leagueSummaryLine(state))}</span>
          <h2>${escapeHTML(state.name)}</h2>
          <div class="league-code"><span>League code</span><strong>${state.code}</strong></div>
          ${hostSlateControl(state)}
          ${weeklyCountControl(state)}
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

/**
 * Anchors every week strip on the current week — weeks gone to the left, weeks
 * to come a swipe right. Runs on every paint, and a paint rebuilds the strip,
 * so opening or expanding the picker always lands on the green chip whatever
 * the strip was showing before.
 *
 * Measured from bounding rects, not offsetLeft. `.week-strip` is not a
 * positioning context, so offsetLeft was being measured against the page and
 * put the strip at an arbitrary mid-list position. Rects are relative to the
 * viewport, so the delta is correct wherever the strip is scrolled — which is
 * also what makes re-anchoring after the user has scrolled elsewhere exact
 * rather than approximate.
 *
 * Done on the strip's own scrollLeft rather than with scrollIntoView, which
 * would drag the page as well as the strip.
 */
function centreWeekStrip() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".week-strip").forEach((strip) => {
      const anchor = strip.querySelector("[data-week-anchor]");
      // No width yet means the strip has not been laid out; a later paint will
      // anchor it rather than this one writing a nonsense offset.
      if (!anchor || !strip.clientWidth) return;
      const stripBox = strip.getBoundingClientRect();
      const chipBox = anchor.getBoundingClientRect();
      strip.scrollLeft += (chipBox.left - stripBox.left) - (strip.clientWidth - chipBox.width) / 2;
    });
  });
}

function render(options = {}) {
  const app = document.getElementById("app");
  const views = { today: todayView, schedule: scheduleView, picks: picksView, league: leagueView, rules: rulesView };
  app.innerHTML = (views[currentView] || todayView)();
  renderPickerLayer();
  document.getElementById("profileInitial").textContent = playerInitial();
  document.querySelectorAll(".bottom-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === currentView));
  centreWeekStrip();
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
  launchRouted = true;   // the viewer is driving now
  currentView = view;
  clearFlash();
  render({ scrollTop: true });
  if (currentView === "league") {
    await loadLeagueState();
    render();
    // Warm every other league now, so the first pill tap is a cache hit.
    prefetchLeagueStates();
  }
  if (currentView === "picks") {
    // My Predictions is sectioned by league, so it needs every league's
    // line-up — and the fixtures behind any competition the active league
    // does not itself play.
    await prefetchLeagueStates();
    await loadFixturesForLeagues();
    render();
  }
}

// Publishes the slate. One way server-side, so this runs once and then the
// picker closes for good — every later period gets its own picker.
async function commitSlate() {
  const period = pickerPeriod;
  const mode = pickerMode;
  const fixtureIds = [...pickerSelection];
  pickerBusy = true;
  render();
  try {
    const result = await api("/league/slate", { uid: uid(), code: activeLeague, period, mode, fixtureIds, action: "publish" });
    const amended = result?.amended === true;
    closeFixturePicker();
    setFlash(amended
      ? `${periodLabel(period)} line-up updated — ${fixtureIds.length} fixtures.`
      : `${periodLabel(period)} is published — ${fixtureIds.length} fixtures.`);
    await loadLeagueState();
  } catch (error) {
    pickerBusy = false;
    pickerConfirmOpen = false;
    setFlash(error.message, "error");
  }
  render();
}

// Closing the picker without publishing keeps the work: the selection is saved
// as a draft, which the host can come back to and which the fallback will
// publish as-is rather than discard if they never do.
async function saveSlateDraft() {
  const period = pickerPeriod;
  const fixtureIds = [...pickerSelection];
  // A published week has no draft slot — closing an amendment simply abandons
  // it, leaving the line-up members already hold picks against untouched.
  if (pickerAmending) return;
  if (!period || !fixtureIds.length || !API) return;
  try {
    await api("/league/slate", { uid: uid(), code: activeLeague, period, mode: "custom", fixtureIds, action: "draft" });
  } catch {
    // A draft is a convenience; failing to save one must never block closing.
  }
}

/**
 * Saves a new weekly count for this league. The stored method and scope ride
 * along untouched — this control edits the count and nothing else, so a league
 * that already carries one of the older methods keeps it.
 */
async function changeWeeklyCount(delta) {
  const state = leagueState;
  if (!state || state.error || state.owner !== uid()) return;
  const current = state.weeklyRule?.count ?? state.fixtureLimit ?? DEFAULT_FIXTURE_COUNT;
  const next = Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT, current + delta));
  if (next === current) return;
  const rule = {
    method: state.weeklyRule?.method || "manual",
    competitionScope: state.weeklyRule?.competitionScope
      || ((state.competitions || []).length > 1 ? "mixed" : (state.competitions || [DEFAULT_COMPETITION])[0]),
    count: next,
  };
  countBusy = true;
  // Optimistic: the stepper answers on the tap, the save happens behind it.
  leagueState = { ...state, weeklyRule: rule, fixtureLimit: next };
  render();
  try {
    await api("/league/weekly-rule", { uid: uid(), code: state.code, weeklyRule: rule });
    cacheLeagueState(leagueState);
  } catch (error) {
    leagueState = state;   // put it back; nothing was saved
    setFlash(error.message, "error");
  } finally {
    countBusy = false;
    render();
  }
}

// Wizard input is read on the way OUT of a step rather than on every keystroke,
// so typing a league name never triggers a re-render mid-word.
function readWizardInputs() {
  const nameField = document.querySelector("[data-wizard-name]");
  if (nameField) wizard.name = nameField.value;
}

/**
 * Dismisses the software keyboard before a re-render.
 *
 * WKWebView keeps the keyboard up when the focused field is replaced, and the
 * viewport it leaves behind is the one that used to strand the bottom nav
 * mid-screen. Blurring on the way out of a step — and on every form submit —
 * hands the space back before the new screen paints.
 */
function dismissKeyboard() {
  const active = document.activeElement;
  if (active && typeof active.blur === "function" && active !== document.body) active.blur();
}

async function handleWizardClick(event) {
  if (event.target.closest("[data-wizard-open]")) {
    openWizard();
    render();
    return true;
  }
  if (!wizard) return false;
  if (event.target.closest("[data-wizard-cancel]")) {
    dismissKeyboard();
    closeWizard();
    render();
    return true;
  }
  if (event.target.closest("[data-wizard-done]")) {
    closeWizard();
    render();
    return true;
  }
  if (event.target.closest("[data-wizard-back]")) {
    readWizardInputs();
    dismissKeyboard();
    wizard.error = "";
    wizard.step = WIZARD_STEPS[Math.max(0, WIZARD_STEPS.indexOf(wizard.step) - 1)];
    render();
    return true;
  }
  if (event.target.closest("[data-wizard-next]")) {
    readWizardInputs();
    dismissKeyboard();
    if (!wizard.busy) await advanceWizard();
    return true;
  }
  return !!event.target.closest(".wizard");
}

async function handlePickerClick(event) {
  const open = event.target.closest("[data-open-picker]");
  if (open) {
    openFixturePicker(open.dataset.openPicker, open.hasAttribute("data-amend"));
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
    const pending = saveSlateDraft();
    closeFixturePicker();
    render();
    await pending;
    await loadLeagueState();
    render();
    return true;
  }
  if (event.target.closest("[data-picker-surprise]")) {
    const pool = pickerFixtures();
    const bounds = pickerBounds(pool.length);
    // Whatever the host has dialled for this week wins; the league default only
    // applies before they have picked anything.
    const dialled = pickerSelection.size || bounds.default;
    pickerSelection = surpriseSelection(pool, Math.max(bounds.min, Math.min(dialled, bounds.max)));
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
    const bounds = pickerBounds(pickerFixtures().length);
    const ready = pickerSelection.size >= bounds.min && pickerSelection.size <= bounds.max;
    if (ready) {
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
  const leagueCountStep = event.target.closest("[data-league-count-step]");
  if (leagueCountStep) {
    if (!countBusy) await changeWeeklyCount(Number(leagueCountStep.dataset.leagueCountStep));
    return;
  }
  const countStep = event.target.closest("[data-count-step]");
  if (countStep) {
    // v1.5 §9: one validation path — 1 to 20, default 6, floor 1. The worker
    // caps again per week against the pool actually available.
    const delta = Number(countStep.dataset.countStep);
    if (wizard) {
      wizard.count = Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT, wizard.count + delta));
      if (wizard.count !== 1) wizard.confirmSingle = false;
      wizard.error = "";
      render();
      return;
    }
    const panel = countStep.closest("[data-fixture-count]");
    const value = panel.querySelector("[data-count-value]");
    const hidden = panel.querySelector('input[name="fixtureLimit"]');
    const next = Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT, Number(value.textContent) + delta));
    value.textContent = next;
    hidden.value = next;
    return;
  }
  if (await handleWizardClick(event)) return;
  if (await handlePickerClick(event)) return;
  const nav = event.target.closest("[data-view]");
  if (nav) {
    // The onboarding CTA lands on the League tab with the wizard already open.
    if (nav.hasAttribute("data-launch-create")) openWizard();
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
      if (!roundState || roundState.error || String(roundState.period) !== String(selectedPeriod)) {
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
    selectedPeriod = roundMd.dataset.roundMd;
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
      forgetLeagueState(code);
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
      // Write through the cached state and repaint on the spot. The server read
      // that follows goes via a KV list, which can lag its own write by up to a
      // minute — long enough for the banner to say the new name while the table
      // underneath still said "Anon".
      applyNickLocally(code, uid(), result.nick);
      setFlash(`Now showing as ${result.nick} in this league`);
      render();
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
  // Every submit path dismisses the keyboard first; see dismissKeyboard().
  if (event.target.matches("[data-join-league], [data-restore]")) dismissKeyboard();
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
  const section = event.target.closest?.("[data-pick-section]");
  if (section) {
    const key = section.dataset.pickSection;
    if (section.open) collapsedPickSections.delete(key);
    else collapsedPickSections.add(key);
    try {
      localStorage.setItem(STORAGE.pickSections, JSON.stringify([...collapsedPickSections]));
    } catch {
      // A full quota must not break collapsing; it just will not persist.
    }
    return;
  }
  const card = event.target.closest?.("[data-day-card]");
  if (!card) return;
  if (card.open) openScheduleDates.add(card.dataset.dayCard);
  else openScheduleDates.delete(card.dataset.dayCard);
}, true);

// --- Per-competition notification preferences -------------------------------
// Midweek Champions League nights and Saturday Championship cards must never
// erode the Premier League core, so a member can mute a whole competition
// without losing the others. Only shown once more than one exists.

let mutedCompetitions = readJSON(STORAGE.mutedCompetitions, []);

function renderNotificationPrefs() {
  const wrap = document.getElementById("notificationPrefs");
  const list = document.getElementById("notificationPrefsList");
  const codes = availableCompetitions();
  if (!wrap || !list || codes.length < 2) {
    if (wrap) wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.innerHTML = codes.map((code) => `<label class="notif-row">
    <span>${escapeHTML(competitionMeta(code).name)}</span>
    <input type="checkbox" data-notif-competition="${code}"${mutedCompetitions.includes(code) ? "" : " checked"}>
  </label>`).join("");
}

async function saveNotificationPrefs() {
  localStorage.setItem(STORAGE.mutedCompetitions, JSON.stringify(mutedCompetitions));
  if (!API) return;
  try {
    await api("/notification-prefs", { uid: uid(), mute: mutedCompetitions });
  } catch {
    // Preferences are stored locally either way; the next launch retries.
  }
}

document.addEventListener("change", (event) => {
  const competition = event.target.closest("[data-wizard-competition]");
  if (competition && wizard) {
    const code = competition.dataset.wizardCompetition;
    wizard.competitions = competition.checked
      ? availableCompetitions().filter((entry) => entry === code || wizard.competitions.includes(entry))
      : wizard.competitions.filter((entry) => entry !== code);
    wizard.error = "";
    render();
    return;
  }
  const confirmSingle = event.target.closest("[data-wizard-confirm-single]");
  if (confirmSingle && wizard) {
    wizard.confirmSingle = confirmSingle.checked;
    if (confirmSingle.checked) wizard.error = "";
    return;
  }
  const toggle = event.target.closest("[data-notif-competition]");
  if (!toggle) return;
  const code = toggle.dataset.notifCompetition;
  mutedCompetitions = toggle.checked
    ? mutedCompetitions.filter((entry) => entry !== code)
    : [...new Set([...mutedCompetitions, code])];
  saveNotificationPrefs();
});

document.getElementById("profileButton").addEventListener("click", () => {
  document.getElementById("playerName").value = playerName;
  renderNotificationPrefs();
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

// Paint the shell before any network work. Identity and league state take a few
// seconds to settle — longer for a Championship league, whose fixture list is
// half again as large — and until this call existed the app showed an empty
// content area for the whole of it.
render();

// The last league this device looked at, straight from cache, so the first
// paint already has a table in it rather than a loading state.
if (activeLeague && leagueStates[activeLeague]) leagueState = leagueStates[activeLeague];

Promise.all([loadFixtures(), hydrateIdentity()]).then(() => {
  // The launch decision tree (§9.7). An invite in the URL always wins — the
  // viewer arrived to join something — and otherwise the branch decides.
  if (inviteCode && !leagueCodes.includes(inviteCode)) { launchRouted = true; currentView = "league"; }
  else applyLaunchBranch();
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
