/* ==========================================================================
   Where To Swim — Greece
   Finds calm, safe swimming water using live wind, wave, sea-temperature
   and UV data. Everything runs in the browser; no backend, no accounts.
   ========================================================================== */

"use strict";

/* -------------------------------------------------------------------------
   Config
   ------------------------------------------------------------------------- */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OSM_DEDUPE_KM = 0.3;
const OSM_AMENITY_RADIUS_KM = 0.4;
const OSM_MAX_RADIUS_KM = 40;
const MAX_CANDIDATES_FOR_WEATHER = 40;
const MIN_CURATED_BEFORE_SKIPPING_OSM = 8;
const MAX_RESULTS_SHOWN = 25;

const SAND_SURFACES = ["sand", "fine_sand", "sandy"];
const ROUGH_SURFACES = ["pebblestone", "pebbles", "shingle", "rock", "rocks", "gravel", "stone"];

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const CROWD_PENALTY = { low: 0, medium: 8, high: 18 };

const BEAUFORT = [
  { max: 1,   num: 0,  label: "Calm" },
  { max: 5,   num: 1,  label: "Light air" },
  { max: 11,  num: 2,  label: "Light breeze" },
  { max: 19,  num: 3,  label: "Gentle breeze" },
  { max: 28,  num: 4,  label: "Moderate breeze" },
  { max: 38,  num: 5,  label: "Fresh breeze" },
  { max: 49,  num: 6,  label: "Strong breeze" },
  { max: 61,  num: 7,  label: "Near gale" },
  { max: 74,  num: 8,  label: "Gale" },
  { max: 88,  num: 9,  label: "Strong gale" },
  { max: 102, num: 10, label: "Storm" },
  { max: 117, num: 11, label: "Violent storm" },
  { max: Infinity, num: 12, label: "Hurricane" },
];

/* Swimmer profiles encode the "what counts as calm" judgement, so nobody has
   to guess numbers. Advanced controls can still override them. */
const PROFILES = {
  toddler: { label: "Toddler", note: "1–4 yrs", maxWave: 0.3, maxBft: 3, needsShallow: true,  wantsAmenities: true  },
  child:   { label: "Kids",    note: "5–12",    maxWave: 0.5, maxBft: 4, needsShallow: true,  wantsAmenities: true  },
  anyone:  { label: "Anyone",  note: "general", maxWave: 1.0, maxBft: 5, needsShallow: false, wantsAmenities: false },
  strong:  { label: "Strong",  note: "confident", maxWave: 2.0, maxBft: 7, needsShallow: false, wantsAmenities: false },
};

const RADIUS_OPTIONS = [
  { value: 10,  label: "10 km", note: "walk/short drive" },
  { value: 25,  label: "25 km", note: "~30 min" },
  { value: 50,  label: "50 km", note: "~1 hour" },
  { value: 100, label: "100 km", note: "day trip" },
];

const WAVE_OPTIONS = [
  { value: 0.2, label: "0.2 m", note: "glassy" },
  { value: 0.3, label: "0.3 m", note: "toddler" },
  { value: 0.5, label: "0.5 m", note: "light chop" },
  { value: 1.0, label: "1.0 m", note: "lively" },
  { value: 9.9, label: "Any",   note: "no limit" },
];

const WIND_OPTIONS = [
  { value: 2, label: "Bft 2", note: "light" },
  { value: 3, label: "Bft 3", note: "gentle" },
  { value: 4, label: "Bft 4", note: "moderate" },
  { value: 5, label: "Bft 5", note: "fresh" },
  { value: 12, label: "Any",  note: "no limit" },
];

const STORE = {
  favorites: "wts:favorites",
  theme: "wts:theme",
  profile: "wts:profile",
  radius: "wts:radius",
  location: "wts:location",
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */

const state = {
  location: null,          // { lat, lon, label }
  radiusKm: 25,
  profile: "toddler",
  maxWave: null,           // null => derive from profile
  maxBft: null,
  results: [],
  filters: new Set(),
  sort: "best",
  areaTimeline: null,
  favorites: new Set(loadJSON(STORE.favorites, [])),
  searching: false,
  usedFallbackRadius: false,
};

let allBeaches = null;
const beachesPromise = fetch("beaches.json")
  .then((r) => { if (!r.ok) throw new Error("beaches.json " + r.status); return r.json(); })
  .then((data) => { allBeaches = data; return data; });

/* -------------------------------------------------------------------------
   Small utilities
   ------------------------------------------------------------------------- */

function $(id) { return document.getElementById(id); }

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
}

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function icon(name, cls) {
  return `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dphi = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function degToCompass(deg) {
  if (deg == null) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function circularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function kmhToBeaufort(kmh) {
  if (kmh == null) return null;
  return (BEAUFORT.find((s) => kmh <= s.max) || BEAUFORT[BEAUFORT.length - 1]).num;
}

function beaufortLabel(n) {
  const s = BEAUFORT.find((x) => x.num === n);
  return s ? s.label : "";
}

/* Greek → Latin, so a visitor who can't read Greek script can still say the
   name out loud and match it to a road sign. Loosely follows ELOT 743. */
const GREEK_RE = /[Ά-ώἀ-῾]/;

function transliterate(input) {
  const digraphs = [
    ["αι","ai"],["αί","ai"],["ει","ei"],["εί","ei"],["οι","oi"],["οί","oi"],
    ["ου","ou"],["ού","ou"],["υι","yi"],
    ["αυ","av"],["αύ","av"],["ευ","ev"],["εύ","ev"],["ηυ","iv"],
    ["μπ","b"],["ντ","nt"],["γκ","gk"],["γγ","ng"],["γχ","nch"],["γξ","nx"],
    ["τσ","ts"],["τζ","tz"],
  ];
  const single = {
    "α":"a","ά":"a","β":"v","γ":"g","δ":"d","ε":"e","έ":"e","ζ":"z","η":"i","ή":"i",
    "θ":"th","ι":"i","ί":"i","ϊ":"i","ΐ":"i","κ":"k","λ":"l","μ":"m","ν":"n","ξ":"x",
    "ο":"o","ό":"o","π":"p","ρ":"r","σ":"s","ς":"s","τ":"t","υ":"y","ύ":"y","ϋ":"y","ΰ":"y",
    "φ":"f","χ":"ch","ψ":"ps","ω":"o","ώ":"o",
  };

  let out = "";
  let i = 0;
  const lower = input.toLowerCase();

  while (i < lower.length) {
    let matched = false;
    for (const [gr, la] of digraphs) {
      if (lower.startsWith(gr, i)) {
        // αυ/ευ sound like "af/ef" before a voiceless consonant
        let rep = la;
        if (la === "av" || la === "ev" || la === "iv") {
          const nxt = lower[i + 2] || "";
          if ("θκξπστφχψ".includes(nxt) || nxt === "" || nxt === " ") rep = la[0] + "f";
        }
        out += rep;
        i += gr.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = lower[i];
    out += single[ch] !== undefined ? single[ch] : input[i];
    i++;
  }

  // Re-capitalise word starts to match the original's shape.
  return out.replace(/(^|[\s\-'"(/])([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}

/* Descriptive language — this is what turns raw numbers into an answer. */

function seaTempDescriptor(c) {
  if (c == null) return null;
  if (c < 17) return { word: "cold", tone: "bad", advice: "Cold enough to take your breath — short dips only." };
  if (c < 20) return { word: "bracing", tone: "warn", advice: "Bracing. Fine for a swim, chilly for small children." };
  if (c < 23) return { word: "fresh", tone: "warn", advice: "Fresh at first, comfortable once you're moving." };
  if (c < 26) return { word: "pleasant", tone: "good", advice: "Pleasant — comfortable for a long swim." };
  if (c < 29) return { word: "warm", tone: "good", advice: "Warm. Easy for children to stay in a while." };
  return { word: "very warm", tone: "good", advice: "Bath-warm. Very easy swimming, but drink plenty of water." };
}

function uvDescriptor(uv) {
  if (uv == null) return null;
  if (uv < 3)  return { word: "Low", tone: "good", advice: "Low UV — normal sun sense is enough." };
  if (uv < 6)  return { word: "Moderate", tone: "good", advice: "Moderate UV. Hat and sunscreen for a long stay." };
  if (uv < 8)  return { word: "High", tone: "warn", advice: "High UV. Seek shade between 11:00 and 16:00; reapply sunscreen." };
  if (uv < 11) return { word: "Very high", tone: "bad", advice: "Very high UV. Shade, hat and SPF50 — keep small children covered." };
  return { word: "Extreme", tone: "bad", advice: "Extreme UV. Avoid open sun in the middle of the day entirely." };
}

/* -------------------------------------------------------------------------
   Weather / sea data
   ------------------------------------------------------------------------- */

async function getJSON(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function asArray(data) { return Array.isArray(data) ? data : [data]; }

/** Batched current conditions for a list of beaches (2 requests total). */
async function fetchConditions(beaches) {
  if (!beaches.length) return {};
  const lats = beaches.map((b) => b.lat).join(",");
  const lons = beaches.map((b) => b.lon).join(",");
  const out = {};
  beaches.forEach((b) => { out[b.id] = {}; });

  const airUrl = `${FORECAST_URL}?latitude=${lats}&longitude=${lons}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,uv_index` +
    `&wind_speed_unit=kmh&timezone=auto`;

  const seaUrl = `${MARINE_URL}?latitude=${lats}&longitude=${lons}` +
    `&current=wave_height,sea_surface_temperature&timezone=auto`;

  const [air, sea] = await Promise.allSettled([getJSON(airUrl), getJSON(seaUrl)]);

  if (air.status === "fulfilled") {
    asArray(air.value).forEach((entry, i) => {
      const b = beaches[i];
      if (!b) return;
      const c = (entry && entry.current) || {};
      out[b.id].windSpeed = c.wind_speed_10m ?? null;
      out[b.id].windDir = c.wind_direction_10m ?? null;
      out[b.id].windGust = c.wind_gusts_10m ?? null;
      out[b.id].airTemp = c.temperature_2m ?? null;
      out[b.id].uv = c.uv_index ?? null;
    });
  }

  if (sea.status === "fulfilled") {
    asArray(sea.value).forEach((entry, i) => {
      const b = beaches[i];
      if (!b) return;
      const c = (entry && entry.current) || {};
      out[b.id].waveHeight = c.wave_height ?? null;
      out[b.id].seaTemp = c.sea_surface_temperature ?? null;
    });
  }

  return out;
}

/** Hourly wind for the searched area — powers the "calmest window today" card. */
async function fetchAreaTimeline(lat, lon, withDaylight) {
  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,uv_index` +
    (withDaylight ? `&daily=sunrise,sunset` : ``) +
    `&wind_speed_unit=kmh&timezone=auto&forecast_days=2`;
  try {
    const data = await getJSON(url, 10000);
    const entry = asArray(data)[0];
    if (!entry || !entry.hourly || !entry.hourly.time) return null;
    return {
      time: entry.hourly.time,
      wind: entry.hourly.wind_speed_10m,
      uv: entry.hourly.uv_index || [],
      sunrise: entry.daily && entry.daily.sunrise ? entry.daily.sunrise : null,
      sunset: entry.daily && entry.daily.sunset ? entry.daily.sunset : null,
    };
  } catch (e) {
    return null;
  }
}

/** "2h 40m of daylight left" / "sunrise 06:42" — matters for an evening swim. */
function daylightNote(tl) {
  if (!tl || !tl.sunset || !tl.sunset.length) return null;
  const now = new Date();
  const sunset = new Date(tl.sunset[0]);
  const sunrise = tl.sunrise && tl.sunrise.length ? new Date(tl.sunrise[0]) : null;
  const fmt = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (sunrise && now < sunrise) return `Sunrise ${fmt(sunrise)} · sunset ${fmt(sunset)}`;

  if (now < sunset) {
    const mins = Math.round((sunset - now) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    const left = h ? `${h}h ${m}m` : `${m} min`;
    return `${left} of daylight left · sunset ${fmt(sunset)}`;
  }

  const tomorrow = tl.sunrise && tl.sunrise.length > 1 ? new Date(tl.sunrise[1]) : null;
  return tomorrow ? `Sun is down · sunrise tomorrow ${fmt(tomorrow)}` : `Sun is down (sunset was ${fmt(sunset)})`;
}

/**
 * Pick the calmest daylight stretch from here on. Returns the window plus
 * enough hourly slices to draw the timeline.
 */
function analyseTimeline(tl) {
  if (!tl) return null;
  const now = new Date();
  const hours = [];

  for (let i = 0; i < tl.time.length; i++) {
    const t = new Date(tl.time[i]);
    if (t < now - 3600e3) continue;           // keep the hour we're in
    if (hours.length >= 15) break;
    hours.push({ date: t, hour: t.getHours(), wind: tl.wind[i], uv: tl.uv[i] ?? null, isNow: hours.length === 0 });
  }
  if (!hours.length) return null;

  const daylight = hours.filter((h) => h.hour >= 7 && h.hour <= 20);
  const pool = daylight.length >= 3 ? daylight : hours;

  // Best contiguous 2-3h run by average wind.
  let best = null;
  for (let i = 0; i < pool.length; i++) {
    for (const span of [3, 2]) {
      if (i + span > pool.length) continue;
      const slice = pool.slice(i, i + span);
      if (slice.some((h) => h.wind == null)) continue;
      // Only contiguous clock hours.
      const contiguous = slice.every((h, k) => k === 0 || (h.date - slice[k - 1].date) === 3600e3);
      if (!contiguous) continue;
      const avg = slice.reduce((s, h) => s + h.wind, 0) / slice.length;
      if (!best || avg < best.avg - 0.01) best = { avg, from: slice[0], to: slice[slice.length - 1] };
    }
  }

  return { hours, best };
}

/* -------------------------------------------------------------------------
   Live OpenStreetMap lookup (only used where our own coverage is thin)
   ------------------------------------------------------------------------- */

function osmLatLon(el) {
  if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

async function overpassFetch(query) {
  for (const url of OVERPASS_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      return await resp.json();
    } catch (e) { /* try next mirror */ }
  }
  return null;
}

async function fetchOsmBeaches(lat, lon, radiusKm, curated) {
  const radiusM = Math.round(Math.min(radiusKm, OSM_MAX_RADIUS_KM) * 1000);
  const q = `[out:json][timeout:20];(` +
    `nwr["natural"="beach"](around:${radiusM},${lat},${lon});` +
    `nwr["leisure"="beach_resort"](around:${radiusM},${lat},${lon});` +
    `nwr["amenity"~"^(bar|cafe|restaurant)$"](around:${radiusM},${lat},${lon});` +
    `nwr["amenity"="toilets"](around:${radiusM},${lat},${lon});` +
    `);out center tags;`;

  const data = await overpassFetch(q);
  if (!data || !Array.isArray(data.elements)) return [];

  const raw = [], amenities = [];
  for (const el of data.elements) {
    const pos = osmLatLon(el);
    if (!pos) continue;
    const tags = el.tags || {};
    if (tags.natural === "beach" || tags.leisure === "beach_resort") {
      raw.push({ id: `osm_${el.type}_${el.id}`, lat: pos.lat, lon: pos.lon, tags });
    } else if (tags.amenity === "toilets") {
      amenities.push({ lat: pos.lat, lon: pos.lon, isToilet: true });
    } else if (["bar", "cafe", "restaurant"].includes(tags.amenity)) {
      amenities.push({ lat: pos.lat, lon: pos.lon, isToilet: false });
    }
  }

  const results = [];
  for (const rb of raw) {
    if (curated.some((c) => haversineKm(rb.lat, rb.lon, c.lat, c.lon) < OSM_DEDUPE_KM)) continue;
    if (results.some((r) => haversineKm(rb.lat, rb.lon, r.lat, r.lon) < OSM_DEDUPE_KM)) continue;

    const near = amenities.filter((a) => haversineKm(rb.lat, rb.lon, a.lat, a.lon) <= OSM_AMENITY_RADIUS_KM);
    const bars = near.filter((a) => !a.isToilet).length;
    const toilet = near.some((a) => a.isToilet);
    const surface = (rb.tags.surface || "").toLowerCase();

    results.push({
      id: rb.id,
      name: rb.tags.name || rb.tags["name:en"] || "Unnamed beach",
      area: "Nearby (OpenStreetMap)",
      lat: rb.lat, lon: rb.lon,
      facing_deg: null, shelter_arc_deg: null,
      toddler_friendly: SAND_SURFACES.includes(surface) ? true : ROUGH_SURFACES.includes(surface) ? false : null,
      toddler_notes: surface
        ? `OpenStreetMap lists the surface as "${surface}".`
        : "Surface and depth aren't recorded — check before bringing a small child.",
      has_beach_bar: bars > 0 || toilet,
      bar_notes: bars > 0
        ? `${bars} bar/cafe/restaurant mapped within ${Math.round(OSM_AMENITY_RADIUS_KM * 1000)} m.`
        : toilet ? "A public toilet is mapped nearby."
        : "Nothing mapped nearby — may simply be unmapped.",
      crowd_level: null,
      surface: surface || null,
      notes: "Found live on OpenStreetMap, not independently checked.",
      source: "osm",
    });
  }
  return results;
}

/* -------------------------------------------------------------------------
   Scoring
   ------------------------------------------------------------------------- */

function activeLimits() {
  const p = PROFILES[state.profile];
  return {
    maxWave: state.maxWave != null ? state.maxWave : p.maxWave,
    maxBft: state.maxBft != null ? state.maxBft : p.maxBft,
    needsShallow: p.needsShallow,
    wantsAmenities: p.wantsAmenities,
  };
}

function scoreBeach(beach, distanceKm, cond) {
  const lim = activeLimits();
  const { windSpeed = null, windDir = null, windGust = null, waveHeight = null, seaTemp = null, uv = null, airTemp = null } = cond || {};
  const beaufort = kmhToBeaufort(windSpeed);

  let exposed = null;
  if (windDir != null && beach.facing_deg != null && beach.shelter_arc_deg != null) {
    exposed = circularDiff(windDir, beach.facing_deg) <= beach.shelter_arc_deg / 2;
  }

  let chop = null, chopSource = "unknown";
  if (waveHeight != null) {
    chop = waveHeight * (exposed === false ? 0.6 : 1.0);
    chopSource = "marine forecast";
  } else if (windSpeed != null) {
    chop = (windSpeed / 50) * (exposed === false ? 0.3 : 1.0);
    chopSource = "wind estimate";
  }

  const calmness = chop != null ? Math.max(0, Math.min(100, 100 - chop * 80 - (windSpeed || 0) * 0.5)) : 50;

  const passesWave = waveHeight == null || waveHeight <= lim.maxWave;
  const passesWind = beaufort == null || beaufort <= lim.maxBft;
  const passesComfort = passesWave && passesWind;
  const comfortUnknown = waveHeight == null && beaufort == null;

  let score = calmness;
  if (beach.toddler_friendly === true) score += 10;
  else if (beach.toddler_friendly === false && lim.needsShallow) score -= 25;
  if (beach.has_beach_bar) score += 10;
  else if (lim.wantsAmenities) score -= 20;
  score -= CROWD_PENALTY[beach.crowd_level] ?? 5;
  score -= distanceKm * 0.3;
  if (!passesComfort) score -= 40;
  if (state.favorites.has(beach.id)) score += 6;

  return {
    beach,
    id: beach.id,
    name: beach.name,
    latin: GREEK_RE.test(beach.name) ? transliterate(beach.name) : null,
    area: beach.area,
    lat: beach.lat, lon: beach.lon,
    distanceKm,
    score,
    calmness,
    exposed,
    windSpeed, windDir, windGust, beaufort,
    waveHeight, seaTemp, uv, airTemp,
    chopSource,
    passesWave, passesWind, passesComfort, comfortUnknown,
    toddlerFriendly: beach.toddler_friendly,
    hasBar: beach.has_beach_bar,
    crowd: beach.crowd_level,
    surface: beach.surface || null,
    source: beach.source || "curated",
    mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${beach.lat},${beach.lon}`,
  };
}

/** The plain-language answer that leads each card. */
function verdictFor(r) {
  const lim = activeLimits();
  const who = PROFILES[state.profile].label.toLowerCase();

  if (!r.passesWind && r.beaufort != null) {
    return { tone: "bad", icon: "wind",
      text: `Too windy right now — Bft ${r.beaufort} ${beaufortLabel(r.beaufort).toLowerCase()}` };
  }
  if (!r.passesWave && r.waveHeight != null) {
    return { tone: "bad", icon: "wave",
      text: `Choppy — ${r.waveHeight.toFixed(1)} m waves, over your ${lim.maxWave} m limit` };
  }
  if (r.comfortUnknown) {
    return { tone: "neutral", icon: "info", text: "No live conditions for this spot — check before you go" };
  }
  if (r.toddlerFriendly === false && lim.needsShallow) {
    return { tone: "warn", icon: "alert",
      text: `Calm, but ${r.surface ? r.surface.replace(/_/g, " ") : "rough"} underfoot — awkward for a ${who}` };
  }

  const bits = [];
  if (r.exposed === false) bits.push(`sheltered from today's ${degToCompass(r.windDir)} wind`);
  else if (r.calmness >= 78) bits.push("very calm water");
  else bits.push("calm enough");

  if (r.toddlerFriendly === true && lim.needsShallow) bits.push("gentle sandy entry");
  else if (r.hasBar && lim.wantsAmenities) bits.push("food and toilets nearby");

  const text = bits.join(" · ");
  return { tone: r.calmness >= 65 ? "good" : "warn", icon: "check", text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/* -------------------------------------------------------------------------
   Search — places (geocoder) and beaches (our own list)
   ------------------------------------------------------------------------- */

function normalise(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9α-ω\s]/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function searchBeachesByName(query, limit) {
  if (!allBeaches) return [];
  const q = normalise(query);
  if (q.length < 3) return [];
  const qLatin = normalise(transliterate(query));
  const hits = [];

  for (const b of allBeaches) {
    const name = normalise(b.name);
    const latin = GREEK_RE.test(b.name) ? normalise(transliterate(b.name)) : name;
    let rank = -1;
    if (name.startsWith(q) || latin.startsWith(q) || latin.startsWith(qLatin)) rank = 0;
    else if (name.includes(q) || latin.includes(q) || latin.includes(qLatin)) rank = 1;
    if (rank >= 0) {
      hits.push({ beach: b, rank });
      if (hits.length > 400) break;
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.beach.name.length - b.beach.name.length);
  return hits.slice(0, limit || 5).map((h) => h.beach);
}

async function geocodePlaces(query) {
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
    const data = await getJSON(url, 8000);
    return (data.results || []).filter((r) => r.country_code === "GR" || !r.country_code).slice(0, 5);
  } catch (e) {
    return [];
  }
}

/* -------------------------------------------------------------------------
   Rendering — controls
   ------------------------------------------------------------------------- */

function renderSegmented(el, options, current, onPick) {
  el.innerHTML = options.map((o) => `
    <button type="button" data-value="${o.value}" aria-pressed="${o.value === current}">
      ${esc(o.label)}${o.note ? `<small>${esc(o.note)}</small>` : ""}
    </button>`).join("");
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.value;
      const value = isNaN(Number(raw)) ? raw : Number(raw);
      el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      onPick(value);
    });
  });
}

function buildControls() {
  renderSegmented($("seg-radius"), RADIUS_OPTIONS, state.radiusKm, (v) => {
    state.radiusKm = v; saveJSON(STORE.radius, v);
  });

  const profileOpts = Object.entries(PROFILES).map(([k, p]) => ({ value: k, label: p.label, note: p.note }));
  renderSegmented($("seg-profile"), profileOpts, state.profile, (v) => {
    state.profile = v;
    state.maxWave = null;
    state.maxBft = null;
    saveJSON(STORE.profile, v);
    syncAdvancedToProfile();
    if (state.results.length) { rescoreExisting(); renderResults(); }
  });

  syncAdvancedToProfile();
}

function syncAdvancedToProfile() {
  const lim = activeLimits();
  renderSegmented($("seg-wave"), WAVE_OPTIONS, lim.maxWave, (v) => {
    state.maxWave = v;
    if (state.results.length) { rescoreExisting(); renderResults(); }
  });
  renderSegmented($("seg-wind"), WIND_OPTIONS, lim.maxBft, (v) => {
    state.maxBft = v;
    if (state.results.length) { rescoreExisting(); renderResults(); }
  });
}

/* -------------------------------------------------------------------------
   Rendering — area conditions
   ------------------------------------------------------------------------- */

function renderAreaPanel(analysis, sample, rawTimeline) {
  const panel = $("area-panel");
  if (!analysis || !analysis.hours.length) { panel.classList.add("hidden"); return; }

  const { hours, best } = analysis;
  const lim = activeLimits();
  const maxWind = Math.max(...hours.map((h) => h.wind || 0), 10);

  const bars = hours.map((h) => {
    const bft = kmhToBeaufort(h.wind);
    const pct = Math.max(6, Math.round(((h.wind || 0) / maxWind) * 100));
    const cls = bft <= lim.maxBft ? "is-calm" : bft >= lim.maxBft + 2 ? "is-rough" : "";
    return `<div class="tl-col ${cls} ${h.isNow ? "is-now" : ""}" title="${String(h.hour).padStart(2,"0")}:00 · Bft ${bft}">
      <div class="tl-bar" style="height:${pct}%"></div>
    </div>`;
  }).join("");

  const axis = hours.map((h, i) => `<div>${i % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}</div>`).join("");

  let callout = "";
  if (best) {
    const f = String(best.from.hour).padStart(2, "0");
    const t = String((best.to.hour + 1) % 24).padStart(2, "0");
    const bft = kmhToBeaufort(best.avg);
    const ok = bft <= lim.maxBft;
    callout = `<div class="window-callout ${ok ? "" : "is-warn"}">
      ${icon("clock")}
      <div>
        <strong>${ok ? "Calmest window today" : "Best of a windy day"}: ${f}:00–${t}:00</strong>
        <span>Averaging Bft ${bft} (${beaufortLabel(bft).toLowerCase()})${ok ? "" : " — still above your limit, but the quietest stretch"}.</span>
      </div>
    </div>`;
  }

  const daylight = daylightNote(rawTimeline);
  const seaBits = [];
  if (sample) {
    const st = seaTempDescriptor(sample.seaTemp);
    if (st) seaBits.push(`Sea ${sample.seaTemp.toFixed(1)}°C · ${st.word}`);
    const uvd = uvDescriptor(sample.uv);
    if (uvd) seaBits.push(`UV ${Math.round(sample.uv)} · ${uvd.word.toLowerCase()}`);
    if (sample.airTemp != null) seaBits.push(`Air ${Math.round(sample.airTemp)}°C`);
  }

  panel.innerHTML = `
    <div class="area-head">
      <h2 id="area-h">Conditions around ${esc(shortLabel(state.location.label))}</h2>
      ${seaBits.length ? `<span class="area-sub">${esc(seaBits.join(" · "))}</span>` : ""}
    </div>
    ${callout}
    <div class="timeline">${bars}</div>
    <div class="tl-axis">${axis}</div>
    <div class="tl-legend">
      <span><i style="background:var(--good)"></i>within your limit</span>
      <span><i style="background:var(--brand);opacity:.45"></i>borderline</span>
      <span><i style="background:var(--bad);opacity:.7"></i>too windy</span>
    </div>
    ${daylight ? `<p class="daylight">${icon("sun")}<span>${esc(daylight)}</span></p>` : ""}`;
  panel.classList.remove("hidden");
}

function shortLabel(label) {
  if (!label) return "your location";
  return label.split(",")[0].trim();
}

/* -------------------------------------------------------------------------
   Rendering — results
   ------------------------------------------------------------------------- */

const FILTERS = [
  { key: "calm",     label: "Calm now",     icon: "wave",  test: (r) => r.passesComfort },
  { key: "shallow",  label: "Kid-friendly", icon: "child", test: (r) => r.toddlerFriendly === true },
  { key: "bar",      label: "Bar / toilet", icon: "umbrella", test: (r) => r.hasBar },
  { key: "warm",     label: "Warm sea",     icon: "thermo", test: (r) => r.seaTemp != null && r.seaTemp >= 24 },
  { key: "fav",      label: "Saved",        icon: "heart", test: (r) => state.favorites.has(r.id) },
];

const SORTS = [
  { key: "best",     label: "Best match" },
  { key: "near",     label: "Nearest" },
  { key: "calm",     label: "Calmest" },
  { key: "warm",     label: "Warmest sea" },
];

function renderToolbar() {
  const bar = $("toolbar");
  const chips = $("filter-chips");
  const sortLabel = (SORTS.find((s) => s.key === state.sort) || SORTS[0]).label;

  chips.innerHTML = FILTERS.map((f) => `
    <button class="chip" type="button" data-filter="${f.key}" aria-pressed="${state.filters.has(f.key)}">
      ${icon(f.icon)} ${esc(f.label)}
    </button>`).join("");

  chips.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.filter;
      if (state.filters.has(k)) state.filters.delete(k); else state.filters.add(k);
      renderToolbar();
      renderResults();
    });
  });

  bar.classList.remove("hidden");
}

function applyFiltersAndSort(list) {
  let out = list.filter((r) => [...state.filters].every((k) => {
    const f = FILTERS.find((x) => x.key === k);
    return f ? f.test(r) : true;
  }));

  const cmp = {
    best: (a, b) => b.score - a.score,
    near: (a, b) => a.distanceKm - b.distanceKm,
    calm: (a, b) => b.calmness - a.calmness,
    warm: (a, b) => (b.seaTemp ?? -99) - (a.seaTemp ?? -99),
  }[state.sort];

  return out.sort(cmp);
}

function statTile(label, value, note, tone, extra) {
  const cls = value == null ? "stat is-muted" : `stat${tone ? " tone-" + tone : ""}`;
  return `<div class="${cls}">
    <span class="s-label">${esc(label)}</span>
    <span class="s-value">${value == null ? "—" : value}${extra || ""}</span>
    ${note ? `<span class="s-note">${esc(note)}</span>` : ""}
  </div>`;
}

function windArrow(deg) {
  if (deg == null) return "";
  // Meteorological direction is where wind comes FROM; point the arrow that way.
  return `<svg class="wind-arrow" viewBox="0 0 24 24" style="transform:rotate(${deg}deg)" aria-hidden="true">
    <path d="M12 21V5M12 3 6.5 9.5M12 3l5.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4"
      stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function beachCard(r, index) {
  const v = verdictFor(r);
  const fav = state.favorites.has(r.id);
  const st = seaTempDescriptor(r.seaTemp);
  const uvd = uvDescriptor(r.uv);

  const tags = [];
  if (r.toddlerFriendly === true) tags.push(`<span class="tag good">${icon("child")}Gentle entry</span>`);
  else if (r.toddlerFriendly === false) tags.push(`<span class="tag warn">${icon("alert")}${esc((r.surface || "rough").replace(/_/g," "))}</span>`);
  if (r.hasBar) tags.push(`<span class="tag good">${icon("umbrella")}Bar / toilet</span>`);
  if (r.crowd) tags.push(`<span class="tag ${r.crowd === "low" ? "good" : r.crowd === "high" ? "warn" : ""}">${esc(r.crowd)} crowds</span>`);
  if (r.exposed === false) tags.push(`<span class="tag good">${icon("wind")}Sheltered today</span>`);
  // 61 of ~2,700 entries are hand-verified, so badge those rather than
  // stamping "community-mapped" on almost every card.
  if (r.source === "curated") tags.push(`<span class="tag">${icon("check")}Hand-checked</span>`);

  return `
  <article class="beach-card ${index === 0 ? "rank-1" : ""}" data-id="${esc(r.id)}" tabindex="0"
           style="animation-delay:${Math.min(index * 26, 260)}ms">
    <div class="bc-top">
      <span class="bc-rank">${index + 1}</span>
      <div class="bc-heading">
        <h3>${esc(r.name)}</h3>
        ${r.latin ? `<div class="bc-latin">${esc(r.latin)}</div>` : ""}
        <div class="bc-place">
          <span>${esc(r.area)}</span><span class="dot">·</span>
          <span class="num">${r.distanceKm < 10 ? r.distanceKm.toFixed(1) : Math.round(r.distanceKm)} km away</span>
          ${r.source !== "curated" ? `<span class="dot">·</span><span title="Location and amenities from OpenStreetMap, not verified in person">OSM</span>` : ""}
        </div>
      </div>
      <button class="bc-fav ${fav ? "is-on" : ""}" type="button" data-fav="${esc(r.id)}"
              aria-label="${fav ? "Remove from saved" : "Save this beach"}" aria-pressed="${fav}">
        ${icon("heart")}
      </button>
    </div>

    <div class="verdict is-${v.tone === "neutral" ? "" : v.tone}">${icon(v.icon)}<span>${esc(v.text)}</span></div>

    <div class="stats">
      ${statTile("Waves", r.waveHeight == null ? null : r.waveHeight.toFixed(1) + " m",
                 r.chopSource === "wind estimate" && r.waveHeight == null ? "estimated" : null,
                 r.waveHeight == null ? null : r.passesWave ? "good" : "bad")}
      ${statTile("Wind", r.beaufort == null ? null : "Bft " + r.beaufort,
                 r.windSpeed == null ? null : `${Math.round(r.windSpeed)} km/h ${degToCompass(r.windDir) || ""}`,
                 r.beaufort == null ? null : r.passesWind ? "good" : "bad",
                 windArrow(r.windDir))}
      ${statTile("Sea", r.seaTemp == null ? null : r.seaTemp.toFixed(1) + "°", st ? st.word : null,
                 st ? st.tone : null)}
      ${statTile("UV", r.uv == null ? null : String(Math.round(r.uv)), uvd ? uvd.word : null,
                 uvd ? uvd.tone : null)}
    </div>

    ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
  </article>`;
}

function renderResults() {
  const el = $("results");
  const list = applyFiltersAndSort(state.results);
  const shown = list.slice(0, MAX_RESULTS_SHOWN);

  const meta = $("result-meta");
  if (meta) {
    const lim = activeLimits();
    const sortLabel = (SORTS.find((s) => s.key === state.sort) || SORTS[0]).label;
    meta.innerHTML = `
      <span class="rm-count">${list.length}${state.results.length > list.length ? ` of ${state.results.length}` : ""}
        beach${list.length === 1 ? "" : "es"} · ${esc(PROFILES[state.profile].label)}, ≤${lim.maxWave} m, ≤Bft ${lim.maxBft}</span>
      <button class="sort-btn" type="button" id="sort-btn">${icon("sliders")}<span>${esc(sortLabel)}</span></button>`;

    $("sort-btn").addEventListener("click", () => {
      const i = SORTS.findIndex((s) => s.key === state.sort);
      state.sort = SORTS[(i + 1) % SORTS.length].key;
      renderResults();
    });
  }

  if (!shown.length) {
    el.innerHTML = `<div class="empty">${icon("empty")}
      <h3>Nothing matches right now</h3>
      <p>${state.results.length
        ? "Try clearing a filter, widening the search radius, or checking back at the calmer window shown above."
        : "No beaches found in range. Try a wider radius."}</p></div>`;
    return;
  }

  const notice = state.usedFallbackRadius
    ? `<div class="notice">${icon("info")}<div>No beach fell inside your radius, so these are the closest ones we know of.</div></div>`
    : "";

  el.innerHTML = notice + shown.map(beachCard).join("");

  el.querySelectorAll(".beach-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-fav]")) return;
      openSheet(card.dataset.id);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(card.dataset.id); }
    });
  });

  el.querySelectorAll("[data-fav]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.fav);
    });
  });
}

function rescoreExisting() {
  state.results = state.results.map((r) =>
    scoreBeach(r.beach, r.distanceKm, {
      windSpeed: r.windSpeed, windDir: r.windDir, windGust: r.windGust,
      waveHeight: r.waveHeight, seaTemp: r.seaTemp, uv: r.uv, airTemp: r.airTemp,
    })
  );
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) { state.favorites.delete(id); toast("Removed from saved"); }
  else { state.favorites.add(id); toast("Saved"); }
  saveJSON(STORE.favorites, [...state.favorites]);
  rescoreExisting();
  renderResults();
  if (sheetOpenId === id) openSheet(id);
}

/* -------------------------------------------------------------------------
   Detail sheet
   ------------------------------------------------------------------------- */

let sheetOpenId = null;

async function openSheet(id) {
  const r = state.results.find((x) => x.id === id);
  if (!r) return;
  sheetOpenId = id;

  const sheet = $("sheet");
  const st = seaTempDescriptor(r.seaTemp);
  const uvd = uvDescriptor(r.uv);
  const fav = state.favorites.has(r.id);
  const b = r.beach;

  const facts = [];
  if (r.waveHeight != null) {
    facts.push(["wave", `Waves around <strong>${r.waveHeight.toFixed(1)} m</strong> (${r.chopSource}).`, r.passesWave ? "good" : "bad"]);
  }
  if (r.windSpeed != null) {
    const gust = r.windGust != null ? `, gusting ${Math.round(r.windGust)} km/h` : "";
    facts.push(["wind", `<strong>Bft ${r.beaufort} ${beaufortLabel(r.beaufort).toLowerCase()}</strong> — ${Math.round(r.windSpeed)} km/h from the ${degToCompass(r.windDir)}${gust}.`, r.passesWind ? "good" : "bad"]);
  }
  if (r.exposed === false) facts.push(["check", "This beach faces away from today's wind, so the water here is sheltered.", "good"]);
  else if (r.exposed === true) facts.push(["alert", "This beach faces into today's wind, so expect more chop than the open forecast suggests.", "bad"]);
  if (st) facts.push(["thermo", `Sea <strong>${r.seaTemp.toFixed(1)}°C</strong> — ${st.advice}`, st.tone === "bad" ? "bad" : "good"]);
  if (uvd) facts.push(["sun", `UV index <strong>${Math.round(r.uv)}</strong> — ${uvd.advice}`, uvd.tone === "bad" ? "bad" : "good"]);
  if (r.airTemp != null) facts.push(["thermo", `Air temperature ${Math.round(r.airTemp)}°C.`, ""]);

  sheet.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head">
      <div style="flex:1;min-width:0">
        <h2 id="sheet-title">${esc(r.name)}</h2>
        <div class="sh-sub">${r.latin ? esc(r.latin) + " · " : ""}${esc(r.area)} · ${r.distanceKm.toFixed(1)} km away</div>
      </div>
      <button class="icon-btn" type="button" id="sheet-close" aria-label="Close">${icon("close")}</button>
    </div>
    <div class="sheet-body">
      <div class="sheet-section">
        <h3>Right now</h3>
        <ul class="detail-list">
          ${facts.map(([ic, html, tone]) => `<li class="${tone ? "dl-" + tone : ""}">${icon(ic)}<span>${html}</span></li>`).join("")
            || `<li>${icon("info")}<span>No live conditions available for this spot.</span></li>`}
        </ul>
      </div>

      <div class="sheet-section">
        <h3>Getting in the water</h3>
        <p class="prose">${esc(b.toddler_notes || "No information recorded.")}</p>
        <p class="prose">${esc(b.bar_notes || "")}</p>
        ${b.crowd_level ? `<p class="prose">Typically <strong>${esc(b.crowd_level)}</strong> crowds.</p>`
          : `<p class="prose small">Crowd level isn't recorded for this beach.</p>`}
      </div>

      <div class="sheet-section">
        <h3>Timing</h3>
        <div id="sheet-timeline"><p class="prose small">Loading today's wind…</p></div>
      </div>

      <div class="sheet-section">
        <h3>About this entry</h3>
        <p class="prose small">${esc(b.notes || "")}</p>
        <p class="prose small">Coordinates ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}.</p>
      </div>
    </div>
    <div class="sheet-actions">
      <a class="btn-action primary" href="${r.mapsUrl}" target="_blank" rel="noopener">${icon("route")} Directions</a>
      <button class="btn-action icon-only" type="button" id="sheet-fav" aria-label="Save"
              style="${fav ? "color:var(--bad)" : ""}">${icon("heart")}</button>
      <button class="btn-action icon-only" type="button" id="sheet-share" aria-label="Share">${icon("share")}</button>
    </div>`;

  sheet.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
    $("backdrop").classList.add("is-open");
  });
  document.body.style.overflow = "hidden";

  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-fav").addEventListener("click", () => toggleFavorite(r.id));
  $("sheet-share").addEventListener("click", () => shareBeach(r));

  // Per-beach hourly wind, so you can pick your hour for this exact spot.
  const tl = await fetchAreaTimeline(r.lat, r.lon);
  const holder = $("sheet-timeline");
  if (!holder || sheetOpenId !== id) return;
  const analysis = analyseTimeline(tl);
  if (!analysis) { holder.innerHTML = `<p class="prose small">Hourly forecast unavailable.</p>`; return; }

  const lim = activeLimits();
  const maxW = Math.max(...analysis.hours.map((h) => h.wind || 0), 10);
  holder.innerHTML = `
    ${analysis.best ? `<p class="prose">Calmest stretch here: <strong>${String(analysis.best.from.hour).padStart(2,"0")}:00–${String((analysis.best.to.hour + 1) % 24).padStart(2,"0")}:00</strong>
      (about Bft ${kmhToBeaufort(analysis.best.avg)}).</p>` : ""}
    <div class="timeline" style="margin-top:10px">${analysis.hours.map((h) => {
      const bft = kmhToBeaufort(h.wind);
      const cls = bft <= lim.maxBft ? "is-calm" : bft >= lim.maxBft + 2 ? "is-rough" : "";
      return `<div class="tl-col ${cls} ${h.isNow ? "is-now" : ""}" title="${String(h.hour).padStart(2,"0")}:00 · Bft ${bft}">
        <div class="tl-bar" style="height:${Math.max(6, Math.round(((h.wind||0)/maxW)*100))}%"></div></div>`;
    }).join("")}</div>
    <div class="tl-axis">${analysis.hours.map((h, i) => `<div>${i % 3 === 0 ? String(h.hour).padStart(2,"0") : ""}</div>`).join("")}</div>`;
}

function closeSheet() {
  const sheet = $("sheet");
  sheetOpenId = null;
  sheet.classList.remove("is-open");
  $("backdrop").classList.remove("is-open");
  document.body.style.overflow = "";
  setTimeout(() => { if (!sheet.classList.contains("is-open")) sheet.hidden = true; }, 340);
}

async function shareBeach(r) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = `?lat=${r.lat.toFixed(5)}&lon=${r.lon.toFixed(5)}&name=${encodeURIComponent(r.name)}`;
  const text = `${r.name} — ${r.area}. ${r.mapsUrl}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: r.name, text, url: url.toString() });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast("Link copied");
  } catch (e) { /* user cancelled */ }
}

/* -------------------------------------------------------------------------
   Toast
   ------------------------------------------------------------------------- */

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("is-open");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-open"), 1900);
}

/* -------------------------------------------------------------------------
   Location handling
   ------------------------------------------------------------------------- */

function setLocation(lat, lon, label, opts) {
  state.location = { lat, lon, label };
  saveJSON(STORE.location, state.location);

  const chip = $("loc-chip");
  chip.innerHTML = `${icon("pin")}<span>${esc(label || "Your location")}</span>
    <span class="coords num">${lat.toFixed(3)}, ${lon.toFixed(3)}</span>`;
  chip.classList.remove("hidden");

  if (!opts || opts.search !== false) runSearch();
}

function useMyLocation() {
  const btn = $("use-location-btn");
  if (!navigator.geolocation) { toast("Location isn't available on this device"); return; }
  btn.classList.add("is-busy");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove("is-busy");
      setLocation(pos.coords.latitude, pos.coords.longitude, "Your location");
    },
    () => {
      btn.classList.remove("is-busy");
      toast("Couldn't get your location — search a place instead");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

/* -------------------------------------------------------------------------
   The search itself
   ------------------------------------------------------------------------- */

function showSkeletons(n) {
  $("results").innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton">
      <div class="sk-line" style="width:55%;height:16px"></div>
      <div class="sk-line" style="width:35%"></div>
      <div class="sk-line" style="width:100%;height:44px;margin-top:14px"></div>
    </div>`).join("");
}

async function runSearch() {
  if (!state.location) { toast("Pick a place first"); return; }
  if (state.searching) return;

  state.searching = true;
  state.usedFallbackRadius = false;
  const btn = $("find-btn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>Checking the sea…</span>`;
  showSkeletons(3);

  try {
    const beaches = await beachesPromise;
    const { lat, lon } = state.location;

    let candidates = beaches
      .map((b) => ({ beach: b, distance: haversineKm(lat, lon, b.lat, b.lon) }))
      .filter((c) => c.distance <= state.radiusKm)
      .sort((a, b) => a.distance - b.distance);

    if (!candidates.length) {
      state.usedFallbackRadius = true;
      candidates = beaches
        .map((b) => ({ beach: b, distance: haversineKm(lat, lon, b.lat, b.lon) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 6);
    } else {
      candidates = candidates.slice(0, MAX_CANDIDATES_FOR_WEATHER);
    }

    // Our own list now covers the whole country, so only fall back to a live
    // Overpass query where coverage is genuinely thin.
    if (candidates.length < MIN_CURATED_BEFORE_SKIPPING_OSM) {
      const osm = await fetchOsmBeaches(lat, lon, state.radiusKm, beaches);
      candidates = candidates.concat(
        osm.map((b) => ({ beach: b, distance: haversineKm(lat, lon, b.lat, b.lon) }))
           .sort((a, b) => a.distance - b.distance)
           .slice(0, 12)
      );
    }

    const beachList = candidates.map((c) => c.beach);
    const [condById, timeline] = await Promise.all([
      fetchConditions(beachList),
      fetchAreaTimeline(lat, lon, true),
    ]);

    state.results = candidates.map((c) => scoreBeach(c.beach, c.distance, condById[c.beach.id]));
    state.areaTimeline = analyseTimeline(timeline);

    const sample = state.results.find((r) => r.seaTemp != null) || state.results[0] || null;
    renderAreaPanel(state.areaTimeline, sample, timeline);
    renderToolbar();
    renderResults();

    $("data-stamp").textContent = `Conditions fetched ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ` +
      `${allBeaches ? allBeaches.length.toLocaleString() : ""} beaches in the database.`;
  } catch (e) {
    $("results").innerHTML = `<div class="empty">${icon("alert")}
      <h3>Couldn't load conditions</h3>
      <p>Check your connection and try again. If you're offline, saved beaches still work.</p></div>`;
  } finally {
    state.searching = false;
    btn.disabled = false;
    btn.innerHTML = `${icon("wave")}<span>Find calm water</span>`;
  }
}

/* -------------------------------------------------------------------------
   Autocomplete
   ------------------------------------------------------------------------- */

function renderSuggestions(places, beaches) {
  const box = $("place-results");
  if (!places.length && !beaches.length) { box.innerHTML = ""; return; }

  let html = "";
  if (beaches.length) {
    html += `<div class="suggest-group">Beaches</div>`;
    html += beaches.map((b) => `
      <div class="suggest-item" role="option" data-kind="beach" data-lat="${b.lat}" data-lon="${b.lon}" data-name="${esc(b.name)}">
        ${icon("wave")}
        <div style="min-width:0">
          <div class="s-main">${esc(b.name)}</div>
          <div class="s-sub">${GREEK_RE.test(b.name) ? esc(transliterate(b.name)) + " · " : ""}${esc(b.area)}</div>
        </div>
      </div>`).join("");
  }
  if (places.length) {
    html += `<div class="suggest-group">Places</div>`;
    html += places.map((p) => {
      const label = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
      return `<div class="suggest-item" role="option" data-kind="place" data-lat="${p.latitude}" data-lon="${p.longitude}" data-name="${esc(label)}">
        ${icon("pin")}
        <div style="min-width:0">
          <div class="s-main">${esc(p.name)}</div>
          <div class="s-sub">${esc([p.admin1, p.country].filter(Boolean).join(", "))}</div>
        </div>
      </div>`;
    }).join("");
  }

  box.innerHTML = html;
  box.querySelectorAll(".suggest-item").forEach((item) => {
    item.addEventListener("click", () => {
      const lat = parseFloat(item.dataset.lat);
      const lon = parseFloat(item.dataset.lon);
      const name = item.dataset.name;
      $("place-input").value = name;
      box.innerHTML = "";
      if (item.dataset.kind === "beach") {
        // Centre tightly on the beach itself so it leads the list.
        state.radiusKm = Math.min(state.radiusKm, 25);
        renderSegmented($("seg-radius"), RADIUS_OPTIONS, state.radiusKm, (v) => { state.radiusKm = v; saveJSON(STORE.radius, v); });
      }
      setLocation(lat, lon, name);
    });
  });
}

function wireSearchBox() {
  const input = $("place-input");
  const box = $("place-results");
  let timer = null;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.innerHTML = ""; return; }

    // Local beach matches are instant; the geocoder is debounced.
    const localHits = searchBeachesByName(q, 4);
    renderSuggestions([], localHits);

    timer = setTimeout(async () => {
      const places = await geocodePlaces(q);
      if (input.value.trim() !== q) return;
      renderSuggestions(places, searchBeachesByName(q, 4));
    }, 280);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") box.innerHTML = "";
    if (e.key === "Enter") {
      const first = box.querySelector(".suggest-item");
      if (first) first.click();
    }
  });

  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) box.innerHTML = "";
  });
}

/* -------------------------------------------------------------------------
   Theme
   ------------------------------------------------------------------------- */

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");

  const dark = theme === "dark" ||
    (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  $("theme-icon").innerHTML = `<use href="#i-${dark ? "sun" : "moon"}"/>`;
}

function wireTheme() {
  const saved = loadJSON(STORE.theme, null);
  applyTheme(saved);
  $("theme-toggle").addEventListener("click", () => {
    const current = loadJSON(STORE.theme, null);
    const isDark = current === "dark" ||
      (current == null && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    saveJSON(STORE.theme, next);
    applyTheme(next);
  });
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

function wireMisc() {
  $("backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetOpenId) closeSheet(); });

  $("use-location-btn").addEventListener("click", useMyLocation);
  $("find-btn").addEventListener("click", runSearch);

  const more = $("more-toggle");
  more.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") === "true";
    more.setAttribute("aria-expanded", String(!open));
    $("advanced-controls").classList.toggle("hidden", open);
  });

  const appbar = $("appbar");
  const onScroll = () => appbar.classList.toggle("is-stuck", window.scrollY > 6);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function restorePreferences() {
  const profile = loadJSON(STORE.profile, null);
  if (profile && PROFILES[profile]) state.profile = profile;
  const radius = loadJSON(STORE.radius, null);
  if (radius && RADIUS_OPTIONS.some((o) => o.value === radius)) state.radiusKm = radius;
}

function bootLocation() {
  const params = new URLSearchParams(location.search);
  const qLat = parseFloat(params.get("lat"));
  const qLon = parseFloat(params.get("lon"));
  if (!isNaN(qLat) && !isNaN(qLon)) {
    const name = params.get("name") || "Shared location";
    $("place-input").value = name;
    setLocation(qLat, qLon, name);
    return;
  }

  const saved = loadJSON(STORE.location, null);
  if (saved && typeof saved.lat === "number") {
    $("place-input").value = saved.label || "";
    setLocation(saved.lat, saved.lon, saved.label, { search: false });
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "Your location"),
      () => { /* stay quiet; the saved or typed location is enough */ },
      { timeout: 8000, maximumAge: 300000 }
    );
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ });
  });
}

restorePreferences();
buildControls();
wireSearchBox();
wireTheme();
wireMisc();
bootLocation();
registerServiceWorker();

beachesPromise
  .then((b) => {
    $("brand-sub").textContent = `${b.length.toLocaleString()} beaches · live conditions`;
    $("data-stamp").textContent = `${b.length.toLocaleString()} beaches in the database.`;
  })
  .catch(() => {
    $("results").innerHTML = `<div class="empty">${icon("alert")}
      <h3>Couldn't load the beach list</h3><p>Reload the page to try again.</p></div>`;
  });
