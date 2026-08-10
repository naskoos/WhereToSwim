let selectedLocation = null; // { lat, lon, label }

const locationStatus = document.getElementById("location-status");
const placeInput = document.getElementById("place-input");
const placeResults = document.getElementById("place-results");
const findBtn = document.getElementById("find-btn");
const resultsEl = document.getElementById("results");

function setLocation(lat, lon, label) {
  selectedLocation = { lat, lon, label };
  locationStatus.textContent = label ? `Using: ${label}` : `Using: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

document.getElementById("use-location-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    locationStatus.textContent = "Geolocation not supported by this browser.";
    return;
  }
  locationStatus.textContent = "Locating...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setLocation(pos.coords.latitude, pos.coords.longitude, "your current location");
    },
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
      const resp = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const items = await resp.json();
      placeResults.innerHTML = "";
      items.forEach((item) => {
        const div = document.createElement("div");
        div.textContent = item.label;
        div.addEventListener("click", () => {
          setLocation(item.lat, item.lon, item.label);
          placeInput.value = item.label;
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

function badge(text, cls) {
  return `<span class="badge ${cls || ""}">${text}</span>`;
}

function renderResults(data) {
  resultsEl.innerHTML = "";

  if (data.relaxed_filters) {
    const note = document.createElement("p");
    note.className = "status-msg";
    note.textContent = "Not enough beaches matched your must-haves nearby, so filters were relaxed — check the notes on each card.";
    resultsEl.appendChild(note);
  }

  if (!data.results.length) {
    resultsEl.innerHTML += `<p class="status-msg">No beaches found in range. Try a larger radius.</p>`;
    return;
  }

  data.results.forEach((beach, idx) => {
    const card = document.createElement("div");
    card.className = `beach-card ${idx === 0 ? "rank-1" : ""}`;

    let calmBadge;
    if (beach.calmness >= 65) calmBadge = badge("Calm", "good");
    else if (beach.calmness >= 40) calmBadge = badge("Some chop", "warn");
    else calmBadge = badge("Choppy/windy", "bad");

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
      conditions.push(`💨 ${beach.wind_speed_kmh.toFixed(0)} km/h ${beach.wind_direction || ""}`);
    }

    card.innerHTML = `
      <div class="beach-card-header">
        <h3>${idx + 1}. ${beach.name}</h3>
        <span>${beach.distance_km} km</span>
      </div>
      <p class="beach-area">${beach.area} &middot; ${conditions.join(" &middot; ")}</p>
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
  const toddler = document.getElementById("toddler-check").checked;
  const needsBar = document.getElementById("bar-check").checked;
  const radius = document.getElementById("radius-select").value;

  findBtn.disabled = true;
  findBtn.textContent = "Searching...";
  resultsEl.innerHTML = `<p class="status-msg">Checking live wind &amp; wave conditions...</p>`;

  try {
    const params = new URLSearchParams({
      lat: selectedLocation.lat,
      lon: selectedLocation.lon,
      radius_km: radius,
      toddler,
      needs_bar: needsBar,
    });
    const resp = await fetch(`/api/recommend?${params.toString()}`);
    const data = await resp.json();
    if (data.error) {
      resultsEl.innerHTML = `<p class="status-msg">${data.error}</p>`;
    } else {
      renderResults(data);
    }
  } catch (e) {
    resultsEl.innerHTML = `<p class="status-msg">Something went wrong fetching recommendations. Please try again.</p>`;
  } finally {
    findBtn.disabled = false;
    findBtn.textContent = "Find calm beaches";
  }
});

// Try to auto-locate on load for convenience.
window.addEventListener("load", () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "your current location"),
      () => {
        locationStatus.textContent = "Tap \"Use my location\" or search a place to get started.";
      },
      { timeout: 8000 }
    );
  }
});
