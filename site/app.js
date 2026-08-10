const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
const CROWD_PENALTY = { low: 0, medium: 8, high: 18 };

const BEAUFORT_SCALE = [
  { max: 1, num: 0, label: "Calm" },
  { max: 5, num: 1, label: "Light air" },
  { max: 11, num: 2, label: "Light breeze" },
  { max: 19, num: 3, label: "Gentle breeze" },
  { max: 28, num: 4, label: "Moderate breeze" },
  { max: 38, num: 5, label: "Fresh breeze" },
  { max: 49, num: 6, label: "Strong breeze" },
  { max: 61, num: 7, label: "Near gale" },
  { max: 74, num: 8, label: "Gale" },
  { max: 88, num: 9, label: "Strong gale" },
  { max: 102, num: 10, label: "Storm" },
  { max: 117, num: 11, label: "Violent storm" },
  { max: Infinity, num: 12, label: "Hurricane" },
];

function kmhToBeaufort(kmh) {
  if (kmh === null || kmh === undefined) return null;
  const step = BEAUFORT_SCALE.find((s) => kmh <= s.max) || BEAUFORT_SCALE[BEAUFORT_SCALE.length - 1];
  return step.num;
}

function beaufortLabel(num) {
  const step = BEAUFORT_SCALE.find((s) => s.num === num);
  return step ? step.label : "";
}

let selectedLocation = null; // { lat, lon, label }
let beachesPromise = fetch("beaches.json").then((r) => r.json());

const locationStatus = document.getElementById("location-status");
const placeInput = document.getElementById("place-input");
const placeResults = document.getElementById("place-results");
const findBtn = document.getElementById("find-btn");
const resultsEl = document.getElementById("results");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setLocation(lat, lon, label) {
  selectedLocation = { lat, lon, label };
  const coords = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
  const labelHtml = label ? `${escapeHtml(label)} &mdash; ` : "";
  locationStatus.innerHTML = `${labelHtml}${coords} <a href="${mapsUrl}" target="_blank" rel="noopener">check on map</a>`;
}

document.getElementById("use-location-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    locationStatus.textContent = "Geolocation not supported by this browser.";
    return;
  }
  locationStatus.textContent = "Locating...";
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "your current location"),
    () => {
      locationStatus.textContent = "Could not get your location. Try searching a place instead.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

let searchTimer = null;
placeInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = placeInput.value.trim();
  placeResults.innerHTML = "";
  if (q.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
      const resp = await fetch(url);
      const data = await resp.json();
      placeResults.innerHTML = "";
      (data.results || []).forEach((item) => {
        const labelParts = [item.name, item.admin1, item.country].filter(Boolean);
        const label = labelParts.join(", ");
        const div = document.createElement("div");
        div.textContent = label;
        div.addEventListener("click", () => {
          setLocation(item.latitude, item.longitude, label);
          placeInput.value = label;
          placeResults.innerHTML = "";
        });
        placeResults.appendChild(div);
      });
    } catch (e) {
      // ignore transient search errors
    }
  }, 300);
});

document.addEventListener("click", (e) => {
  if (!placeResults.contains(e.target) && e.target !== placeInput) {
    placeResults.innerHTML = "";
  }
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function degToCompass(deg) {
  if (deg === null || deg === undefined) return null;
  const idx = Math.round(deg / 22.5) % 16;
  return COMPASS_POINTS[idx];
}

function circularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

async function fetchWind(beaches) {
  if (!beaches.length) return {};
  const lats = beaches.map((b) => b.lat).join(",");
  const lons = beaches.map((b) => b.lon).join(",");
  const url = `${FORECAST_URL}?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timezone=auto`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("bad response");
    const data = await resp.json();
    const entries = Array.isArray(data) ? data : [data];
    const result = {};
    beaches.forEach((b, i) => {
      const current = (entries[i] && entries[i].current) || {};
      result[b.id] = { speed: current.wind_speed_10m, dir: current.wind_direction_10m };
    });
    return result;
  } catch (e) {
    return {};
  }
}

async function fetchWaves(beaches) {
  if (!beaches.length) return {};
  const lats = beaches.map((b) => b.lat).join(",");
  const lons = beaches.map((b) => b.lon).join(",");
  const url = `${MARINE_URL}?latitude=${lats}&longitude=${lons}&current=wave_height&timezone=auto`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("bad response");
    const data = await resp.json();
    const entries = Array.isArray(data) ? data : [data];
    const result = {};
    beaches.forEach((b, i) => {
      const current = (entries[i] && entries[i].current) || {};
      result[b.id] = current.wave_height ?? null;
    });
    return result;
  } catch (e) {
    const result = {};
    beaches.forEach((b) => (result[b.id] = null));
    return result;
  }
}

function scoreBeach(beach, distanceKm, wind, waveHeight, wantToddler, wantBar, maxWave, maxBeaufort) {
  const windSpeed = wind ? wind.speed : null;
  const windDir = wind ? wind.dir : null;
  const beaufort = kmhToBeaufort(windSpeed);

  let exposed = null;
  if (windDir !== null && windDir !== undefined) {
    const diff = circularDiff(windDir, beach.facing_deg);
    exposed = diff <= beach.shelter_arc_deg / 2;
  }

  let chop = null;
  let chopSource = "unknown";
  if (waveHeight !== null && waveHeight !== undefined) {
    chop = waveHeight * (exposed === false ? 0.6 : 1.0);
    chopSource = "marine forecast";
  } else if (windSpeed !== null && windSpeed !== undefined) {
    const base = windSpeed / 50.0;
    chop = base * (exposed === false ? 0.3 : 1.0);
    chopSource = "wind estimate";
  }

  const calmness = chop !== null ? Math.max(0, 100 - chop * 80 - (windSpeed || 0) * 0.5) : 50;

  const passesWave = waveHeight === null || waveHeight === undefined || waveHeight <= maxWave;
  const passesWind = beaufort === null || beaufort === undefined || beaufort <= maxBeaufort;
  const passesComfort = passesWave && passesWind;
  const comfortUnknown = (waveHeight === null || waveHeight === undefined) && (beaufort === null || beaufort === undefined);

  let score = calmness;
  score += beach.toddler_friendly ? 10 : wantToddler ? -25 : 0;
  score += beach.has_beach_bar ? 10 : wantBar ? -25 : 0;
  score -= CROWD_PENALTY[beach.crowd_level] ?? 5;
  score -= distanceKm * 0.3;
  score += passesComfort ? 0 : -40;

  const reasons = [];
  if (waveHeight !== null && waveHeight !== undefined) {
    reasons.push(`~${waveHeight.toFixed(1)} m waves expected right now${passesWave ? "" : ` (over your ${maxWave} m limit)`}`);
  }
  if (windSpeed !== null && windSpeed !== undefined) {
    const compass = degToCompass(windDir) || "";
    const state = exposed ? "exposed to" : "sheltered from";
    reasons.push(
      `${state} the current ${compass} wind: Bft ${beaufort} (${beaufortLabel(beaufort)}, ${windSpeed.toFixed(0)} km/h)${passesWind ? "" : ` (over your Bft ${maxBeaufort} limit)`}`.replace("  ", " ")
    );
  }
  if (beach.toddler_friendly) reasons.push("toddler-friendly (shallow/gentle entry)");
  if (beach.has_beach_bar) reasons.push("has a beach bar/taverna");
  reasons.push(`${beach.crowd_level} crowd level`);
  reasons.push(`${distanceKm.toFixed(0)} km away`);

  return {
    id: beach.id,
    name: beach.name,
    area: beach.area,
    distance_km: Math.round(distanceKm * 10) / 10,
    score: Math.round(score * 10) / 10,
    calmness: Math.round(calmness * 10) / 10,
    exposed_to_wind: exposed,
    wind_speed_kmh: windSpeed ?? null,
    wind_direction: degToCompass(windDir),
    beaufort,
    wave_height_m: waveHeight ?? null,
    chop_source: chopSource,
    passes_comfort: passesComfort,
    comfort_unknown: comfortUnknown,
    toddler_friendly: beach.toddler_friendly,
    toddler_notes: beach.toddler_notes,
    has_beach_bar: beach.has_beach_bar,
    bar_notes: beach.bar_notes,
    crowd_level: beach.crowd_level,
    notes: beach.notes,
    maps_url: `https://www.google.com/maps/dir/?api=1&destination=${beach.lat},${beach.lon}`,
    reasons,
  };
}

function badge(text, cls) {
  return `<span class="badge ${cls || ""}">${text}</span>`;
}

function renderResults(results, relaxedFilters) {
  resultsEl.innerHTML = "";

  if (relaxedFilters) {
    const note = document.createElement("p");
    note.className = "status-msg";
    note.textContent = "Not enough beaches matched your must-haves and wave/wind limits nearby, so filters were relaxed — check the \"Over your limit\" badges below.";
    resultsEl.appendChild(note);
  }

  if (!results.length) {
    resultsEl.innerHTML += `<p class="status-msg">No beaches found in range. Try a larger radius.</p>`;
    return;
  }

  results.forEach((beach, idx) => {
    const card = document.createElement("div");
    card.className = `beach-card ${idx === 0 ? "rank-1" : ""}`;

    let calmBadge;
    if (beach.comfort_unknown) calmBadge = badge("Conditions unknown", "warn");
    else if (!beach.passes_comfort) calmBadge = badge("Over your limit", "bad");
    else if (beach.calmness >= 65) calmBadge = badge("Calm", "good");
    else calmBadge = badge("Within your limit", "warn");

    const badges = [
      calmBadge,
      beach.toddler_friendly ? badge("Toddler-friendly", "good") : badge("Not ideal for toddlers", "warn"),
      beach.has_beach_bar ? badge("Beach bar/toilet", "good") : badge("No beach bar", "warn"),
      badge(`${beach.crowd_level} crowd`, beach.crowd_level === "low" ? "good" : beach.crowd_level === "medium" ? "warn" : "bad"),
    ].join("");

    const conditions = [];
    if (beach.wave_height_m !== null && beach.wave_height_m !== undefined) {
      conditions.push(`🌊 ${beach.wave_height_m.toFixed(1)} m waves`);
    }
    if (beach.wind_speed_kmh !== null && beach.wind_speed_kmh !== undefined) {
      conditions.push(`💨 Bft ${beach.beaufort} (${beach.wind_speed_kmh.toFixed(0)} km/h ${beach.wind_direction || ""})`);
    }

    card.innerHTML = `
      <div class="beach-card-header">
        <h3>${idx + 1}. ${beach.name}</h3>
        <span>${beach.distance_km} km</span>
      </div>
      <p class="beach-area">${beach.area}${conditions.length ? " &middot; " + conditions.join(" &middot; ") : ""}</p>
      <div class="badges">${badges}</div>
      <ul class="reasons">${beach.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
      <p class="beach-notes">${beach.notes}<br/>${beach.toddler_notes} ${beach.bar_notes}</p>
      <a class="maps-link" href="${beach.maps_url}" target="_blank" rel="noopener">Get directions →</a>
    `;
    resultsEl.appendChild(card);
  });
}

findBtn.addEventListener("click", async () => {
  if (!selectedLocation) {
    locationStatus.textContent = "Set a location first (use your location or search a place).";
    return;
  }
  const wantToddler = document.getElementById("toddler-check").checked;
  const wantBar = document.getElementById("bar-check").checked;
  const maxWave = parseFloat(document.getElementById("max-wave-select").value);
  const maxBeaufort = parseInt(document.getElementById("max-wind-select").value, 10);
  const radiusKm = parseFloat(document.getElementById("radius-select").value);

  findBtn.disabled = true;
  findBtn.textContent = "Searching...";
  resultsEl.innerHTML = `<p class="status-msg">Checking live wind &amp; wave conditions...</p>`;

  try {
    const allBeaches = await beachesPromise;
    const { lat, lon } = selectedLocation;

    let candidates = allBeaches
      .map((b) => ({ beach: b, distance: haversineKm(lat, lon, b.lat, b.lon) }))
      .filter((c) => c.distance <= radiusKm);

    if (!candidates.length) {
      candidates = allBeaches
        .map((b) => ({ beach: b, distance: haversineKm(lat, lon, b.lat, b.lon) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
    }

    const beachList = candidates.map((c) => c.beach);
    const [windById, waveById] = await Promise.all([fetchWind(beachList), fetchWaves(beachList)]);

    const scored = candidates.map((c) =>
      scoreBeach(c.beach, c.distance, windById[c.beach.id], waveById[c.beach.id], wantToddler, wantBar, maxWave, maxBeaufort)
    );

    const strict = scored.filter(
      (s) => (!wantToddler || s.toddler_friendly) && (!wantBar || s.has_beach_bar) && s.passes_comfort
    );
    const relaxedFilters = strict.length < 3;
    const pool = relaxedFilters ? scored : strict;
    pool.sort((a, b) => b.score - a.score);

    renderResults(pool.slice(0, 6), relaxedFilters);
  } catch (e) {
    resultsEl.innerHTML = `<p class="status-msg">Something went wrong fetching recommendations. Check your connection and try again.</p>`;
  } finally {
    findBtn.disabled = false;
    findBtn.textContent = "Find calm beaches";
  }
});

window.addEventListener("load", () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "your current location"),
      () => {
        locationStatus.textContent = 'Tap "Use my location" or search a place to get started.';
      },
      { timeout: 8000 }
    );
  }
});
