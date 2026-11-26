// v1.9 Slice 2 §B — live match weather from Apple WeatherKit.
//
// The rule this module exists to keep: ALWAYS FREE. WeatherKit's REST API is
// included with the Apple Developer membership up to 500,000 calls a month, and
// nothing here can come near that:
//
//   - fetched server-side only, from the cron, never per user or per app open;
//   - EXACTLY two fetches in a fixture's life: once seven UK days out, and once
//     on the UK morning of the match (the 06:00 tick);
//   - one call per venue + kick-off hour, shared by every fixture in it;
//   - a hard monthly cap (3,000 by default) checked before every call;
//   - any error, or the cap, keeps whatever forecast is already stored — no
//     retry, no loop. A missed forecast is no pill, never a second call.
//
// With the three secrets absent the whole feature is off: no fetch, no read,
// no pill, no error.

const WEATHERKIT_HOST = "https://weatherkit.apple.com";
export const WEATHER_TEAM_ID = "Y98F87NK7D";
export const DEFAULT_MONTHLY_CAP = 3000;
const TOKEN_TTL_S = 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A stored forecast is dropped this long after its kick-off. */
const PRUNE_AFTER_MS = 3 * DAY_MS;

export const weatherConfigured = (env) =>
  !!(env?.WEATHERKIT_KEY && env?.WEATHERKIT_KEY_ID && env?.WEATHERKIT_SERVICE_ID);

/** Per-competition store: { [fixtureId]: { passes: ["week","day"], weather? } }. */
export const weatherKey = (competition) => `weather:${competition}`;
/** The monthly call counter, keyed by UK calendar month. */
export const weatherCallsKey = (month) => `weather:calls:${month}`;

export const monthlyCap = (env) => {
  const n = Number(env?.WEATHERKIT_MONTHLY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MONTHLY_CAP;
};

/**
 * Every venue in data/fixtures.json and data/fixtures-elc.json. A venue missing
 * here gets no forecast, never a guessed one; the suite checks both feeds are
 * covered so a new ground is noticed rather than silently forecast-less.
 */
export const STADIUMS = Object.freeze({
  // Premier League
  "American Express Stadium": [50.8616, -0.0837],
  "Anfield": [53.4308, -2.9608],
  "Coventry Building Society Arena": [52.4481, -1.4956],
  "Craven Cottage": [51.4749, -0.2217],
  "Elland Road": [53.7778, -1.5722],
  "Emirates Stadium": [51.5549, -0.1084],
  "Etihad Stadium": [53.4831, -2.2004],
  "Gtech Community Stadium": [51.4882, -0.2886],
  "Hill Dickinson Stadium": [53.4247, -3.0002],
  "MKM Stadium": [53.7465, -0.3678],
  "Old Trafford": [53.4631, -2.2913],
  "Portman Road": [52.0545, 1.1447],
  "Selhurst Park": [51.3983, -0.0855],
  "St. James' Park": [54.9756, -1.6217],
  "St James' Park": [54.9756, -1.6217],
  "Stadium of Light": [54.9146, -1.3884],
  "Stamford Bridge": [51.4817, -0.1910],
  "The City Ground": [52.9400, -1.1328],
  "City Ground": [52.9400, -1.1328],
  "Tottenham Hotspur Stadium": [51.6043, -0.0664],
  "Villa Park": [52.5092, -1.8848],
  "Vitality Stadium": [50.7352, -1.8383],
  // Championship
  "Ashton Gate": [51.4400, -2.6205],
  "Bramall Lane": [53.3703, -1.4709],
  "Cardiff City Stadium": [51.4728, -3.2030],
  "Carrow Road": [52.6221, 1.3092],
  "Deepdale": [53.7722, -2.6883],
  "Ewood Park": [53.7286, -2.4892],
  "Fratton Park": [50.7964, -1.0639],
  "LNER Stadium": [53.2185, -0.5409],
  "Loftus Road": [51.5093, -0.2322],
  "London Stadium": [51.5387, -0.0166],
  "Molineux Stadium": [52.5902, -2.1304],
  "Pride Park Stadium": [52.9150, -1.4472],
  "Racecourse Ground": [53.0521, -3.0049],
  "Riverside Stadium": [54.5782, -1.2170],
  "St Andrew's": [52.4756, -1.8681],
  "St Mary's Stadium": [50.9058, -1.3910],
  "Swansea.com Stadium": [51.6428, -3.9351],
  "The Den": [51.4859, -0.0509],
  "The Hawthorns": [52.5090, -1.9639],
  "The Valley": [51.4865, 0.0364],
  "Toughsheet Community Stadium": [53.5806, -2.5357],
  "Turf Moor": [53.7890, -2.2302],
  "Vicarage Road": [51.6498, -0.4015],
  "bet365 Stadium": [52.9884, -2.1756],
});

// --- UK calendar ---------------------------------------------------------------

const UK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** UK wall-clock parts for an instant: DST-aware, because Intl is. */
export function ukParts(ms) {
  const parts = Object.fromEntries(UK.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Whole UK calendar days from one date key to another. */
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The one tick a day that may fetch: the cron runs every 15 minutes on the
 * quarter-hour, so exactly one tick has UK time 06:00–06:14 — in GMT and BST
 * alike, since the hour is read in Europe/London.
 */
export const isDailyPassTick = (nowMs) => {
  const { hour, minute } = ukParts(nowMs);
  return hour === 6 && minute < 15;
};

/**
 * Which fixtures this tick owes a fetch, and for which pass.
 *
 *   week — kicks off on the UK date seven days from today, and has never had a
 *          forecast. Counted in UK dates, not hours, so a 23- or 25-hour DST day
 *          can neither skip a fixture nor take it twice.
 *   day  — kicks off later today (UK date).
 *
 * A pass already recorded for the fixture is never owed again — that record is
 * what makes a repeated or duplicated tick a no-op.
 */
export function dueForecasts(matches, store, nowMs) {
  const today = ukParts(nowMs).date;
  const due = [];
  for (const match of matches || []) {
    const startMs = Date.parse(match?.startAt);
    if (!Number.isFinite(startMs) || startMs <= nowMs || !match?.id) continue;
    const coords = STADIUMS[match.venue];
    if (!coords) continue;
    const entry = store?.[match.id] || {};
    const passes = Array.isArray(entry.passes) ? entry.passes : [];
    const days = dayDiff(today, ukParts(startMs).date);
    if (days === 7 && !passes.includes("week") && !entry.weather) due.push({ match, pass: "week", coords, startMs });
    else if (days === 0 && !passes.includes("day")) due.push({ match, pass: "day", coords, startMs });
  }
  return due;
}

// --- Auth ------------------------------------------------------------------------

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToPkcs8(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * The WeatherKit developer token: ES256, signed with the .p8 key. Apple's shape
 * differs from APNs' in two places — the header carries `id` (TEAMID.SERVICEID)
 * and the claims carry `sub` (the Services ID) and an expiry.
 */
export async function buildWeatherToken(env, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = b64urlJson({
    alg: "ES256", kid: env.WEATHERKIT_KEY_ID, id: `${WEATHER_TEAM_ID}.${env.WEATHERKIT_SERVICE_ID}`,
  });
  const claims = b64urlJson({ iss: WEATHER_TEAM_ID, sub: env.WEATHERKIT_SERVICE_ID, iat, exp: iat + TOKEN_TTL_S });
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(env.WEATHERKIT_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

// --- Conditions --------------------------------------------------------------

const CONDITIONS = {
  Clear: ["☀️", "Clear"],
  MostlyClear: ["🌤", "Mostly clear"],
  PartlyCloudy: ["⛅️", "Partly cloudy"],
  MostlyCloudy: ["🌥", "Mostly cloudy"],
  Cloudy: ["☁️", "Cloudy"],
  Foggy: ["🌫", "Fog"],
  Haze: ["🌫", "Haze"],
  Smoky: ["🌫", "Smoke"],
  Dust: ["🌫", "Dust"],
  Breezy: ["🌬", "Breezy"],
  Windy: ["🌬", "Windy"],
  Drizzle: ["🌦", "Drizzle"],
  Rain: ["🌧", "Rain"],
  HeavyRain: ["🌧", "Heavy rain"],
  SunShowers: ["🌦", "Sunny showers"],
  IsolatedThunderstorms: ["⛈", "Isolated storms"],
  ScatteredThunderstorms: ["⛈", "Scattered storms"],
  StrongStorms: ["⛈", "Strong storms"],
  Thunderstorms: ["⛈", "Thunderstorms"],
  Flurries: ["🌨", "Flurries"],
  Snow: ["🌨", "Snow"],
  HeavySnow: ["❄️", "Heavy snow"],
  SunFlurries: ["🌨", "Sunny flurries"],
  BlowingSnow: ["🌨", "Blowing snow"],
  Blizzard: ["❄️", "Blizzard"],
  Sleet: ["🌨", "Sleet"],
  FreezingDrizzle: ["🌧", "Freezing drizzle"],
  FreezingRain: ["🌧", "Freezing rain"],
  WintryMix: ["🌨", "Wintry mix"],
  Hail: ["🌨", "Hail"],
  Hot: ["☀️", "Hot"],
  Frigid: ["❄️", "Frigid"],
};

export const describeCondition = (code) => {
  const [icon, desc] = CONDITIONS[code] || ["🌡", "Forecast"];
  return { icon, desc };
};

/**
 * One WeatherKit call: the hourly forecast for the kick-off hour at a ground.
 * Returns { icon, temp, desc, at } or throws. Never retried.
 */
export async function fetchKickoffForecast(env, { coords, startMs }, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hourStart = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const [lat, lon] = coords;
  const query = new URLSearchParams({
    dataSets: "forecastHourly",
    hourlyStart: new Date(hourStart).toISOString(),
    hourlyEnd: new Date(hourStart + HOUR_MS).toISOString(),
    timezone: "Europe/London",
  });
  const token = await buildWeatherToken(env, nowMs);
  const response = await fetchImpl(`${WEATHERKIT_HOST}/api/v1/weather/en_GB/${lat}/${lon}?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response?.ok) throw new Error(`weatherkit ${response?.status}`);
  const body = await response.json();
  const hours = body?.forecastHourly?.hours || [];
  const hour = hours.find((h) => {
    const at = Date.parse(h?.forecastStart);
    return Number.isFinite(at) && at <= startMs && startMs < at + HOUR_MS;
  });
  // null/"" would pass Number() as 0 — a forecast of 0°C nobody made.
  const raw = hour?.temperature;
  const temp = typeof raw === "number" ? raw : NaN;
  if (!hour || !Number.isFinite(temp)) throw new Error("weatherkit: no forecast for the kick-off hour");
  return { ...describeCondition(hour.conditionCode), temp: Math.round(temp), at: new Date(nowMs).toISOString() };
}

/**
 * The daily pass for every competition. `listsByCompetition` is
 * { PL: [fixtures], ELC: [fixtures] } — the lists the worker already holds.
 *
 * Order matters, and is what keeps the "exactly two" promise under failure:
 *   1. the passes owed are CLAIMED (written to the store) before any call, so a
 *      crash or a duplicated tick afterwards finds them already spent;
 *   2. calls go out one per venue + kick-off hour, each behind the cap;
 *   3. results are written; an error leaves the previous forecast in place.
 *
 * Returns what it did, for diagnostics and tests. Writes nothing on a day with
 * nothing owed.
 */
export async function weatherPass(env, listsByCompetition, nowMs, { fetchImpl = fetch } = {}) {
  const stats = { calls: 0, capped: 0, errors: 0, stored: 0, changed: [] };
  if (!weatherConfigured(env) || !env.KV || !isDailyPassTick(nowMs)) return stats;

  const plans = [];
  for (const [competition, list] of Object.entries(listsByCompetition || {})) {
    const store = (await env.KV.get(weatherKey(competition), "json")) || {};
    const due = dueForecasts(list, store, nowMs);
    if (!due.length) continue;
    for (const { match, pass } of due) {
      const entry = store[match.id] || {};
      store[match.id] = {
        ...entry,
        kickoffAt: match.startAt,
        passes: [...new Set([...(entry.passes || []), pass])],
      };
    }
    await env.KV.put(weatherKey(competition), JSON.stringify(store));   // 1. claim
    plans.push({ competition, store, due });
  }
  if (!plans.length) return stats;

  const month = ukParts(nowMs).month;
  const cap = monthlyCap(env);
  let used = Number(await env.KV.get(weatherCallsKey(month))) || 0;
  const forecasts = new Map();                                          // venue|hour -> forecast | null

  for (const { competition, store, due } of plans) {
    for (const item of due) {
      const slot = `${item.match.venue}|${Math.floor(item.startMs / HOUR_MS)}`;
      if (!forecasts.has(slot)) {
        if (used >= cap) {
          stats.capped++;
          forecasts.set(slot, null);
        } else {
          used++;
          stats.calls++;
          // Counted BEFORE the outcome is known: a failed call is still a call.
          await env.KV.put(weatherCallsKey(month), String(used), { expirationTtl: 40 * 24 * 60 * 60 });
          try {
            forecasts.set(slot, await fetchKickoffForecast(env, item, { fetchImpl, nowMs }));
          } catch {
            stats.errors++;
            forecasts.set(slot, null);
          }
        }
      }
      const forecast = forecasts.get(slot);
      if (forecast) {
        store[item.match.id] = { ...store[item.match.id], weather: forecast };
        stats.stored++;
      }
    }
    prune(store, nowMs);
    await env.KV.put(weatherKey(competition), JSON.stringify(store));   // 3. results
    stats.changed.push(competition);
  }
  return stats;
}

/** Forgets fixtures well past kick-off, so the store stays a week's worth. */
function prune(store, nowMs) {
  for (const [id, entry] of Object.entries(store)) {
    const kickoff = Date.parse(entry?.kickoffAt || "");
    if (!entry || typeof entry !== "object") delete store[id];
    else if (Number.isFinite(kickoff) && kickoff < nowMs - PRUNE_AFTER_MS) delete store[id];
  }
}

/**
 * Lays stored forecasts onto a fixture list. Called on the worker's fixture
 * cache refresh, so a forecast reaches the client inside the /fixtures answer
 * it already fetches — no new request, no per-request read.
 */
export const usableWeather = (weather) => !!weather
  && typeof weather.temp === "number" && Number.isFinite(weather.temp)
  && typeof weather.icon === "string" && weather.icon !== ""
  && typeof weather.desc === "string" && weather.desc !== "";

/**
 * Forecasts are for clients that can attribute them. Builds up to 1.8.1 (and
 * the web on main) draw match.weather without Apple's Weather mark, which
 * WeatherKit requires wherever its data shows — so they are sent the list
 * without it, exactly as before. 1.9 asks with ?wx=1.
 */
export const withoutWeather = (list) => list.map((match) => {
  if (!match || !("weather" in match)) return match;
  const { weather: _dropped, ...rest } = match;
  return rest;
});

export function mergeWeather(list, store) {
  if (!store) return list;
  return list.map((match) => {
    const weather = store[match.id]?.weather;
    // Only a whole forecast is ever sent: a number for the temperature and the
    // icon and words to go with it. Anything less is no pill, never "undefined".
    return usableWeather(weather)
      ? { ...match, weather: { icon: weather.icon, temp: weather.temp, desc: weather.desc, at: weather.at } }
      : match;
  });
}
