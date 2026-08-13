"""
Verify that the live APIs site/app.js depends on actually return the fields it
reads, using the exact URLs the app builds. The dev sandbox can't reach
Open-Meteo, so this runs on GitHub Actions instead.

Open-Meteo answers an invalid parameter with HTTP 400 and a JSON body
containing "reason", so a wrong field name shows up as a readable message
rather than a silent null. Nothing here fails the build on its own - the point
is to print what the API really says.

Writes api_verification.json for the record.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"

USER_AGENT = "WhereToSwim-beach-finder/1.0 (personal hobby project; github.com/naskoos/WhereToSwim)"

# Real coastal points from beaches.json: Chania (Crete), Ierissos (Chalkidiki),
# Voidokilia (Messinia). Multi-point requests are what the app actually sends.
POINTS = [
    ("Chania / Nea Chora", 35.51290, 24.01110),
    ("Ierissos", 40.39860, 23.87920),
    ("Voidokilia", 36.96400, 21.65960),
]

results = {}
problems = []


def fetch(label, url):
    print(f"\n=== {label} ===", flush=True)
    print(f"GET {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            print(f"HTTP {resp.status}", flush=True)
            return body, None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        print(f"HTTP {e.code} -> {raw[:500]}", flush=True)
        try:
            return json.loads(raw), f"HTTP {e.code}"
        except ValueError:
            return {"raw": raw}, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 - report anything, don't crash the run
        print(f"ERROR {type(e).__name__}: {e}", flush=True)
        return None, str(e)


def as_list(data):
    return data if isinstance(data, list) else [data]


def check_fields(label, entry, section, expected):
    """Report which expected keys are present, and whether they carry a value."""
    block = (entry or {}).get(section, {}) or {}
    present, missing, null_valued = [], [], []
    for key in expected:
        if key not in block:
            missing.append(key)
        elif block[key] is None:
            null_valued.append(key)
        else:
            present.append(f"{key}={block[key]}")
    print(f"  [{label}] {section}: " + (", ".join(present) if present else "(nothing)"), flush=True)
    if missing:
        print(f"  [{label}] MISSING from {section}: {missing}", flush=True)
        problems.append(f"{label}: missing {missing} in {section}")
    if null_valued:
        print(f"  [{label}] present but null: {null_valued}", flush=True)
    return {"present": present, "missing": missing, "null": null_valued}


lats = ",".join(str(p[1]) for p in POINTS)
lons = ",".join(str(p[2]) for p in POINTS)

# ---------------------------------------------------------------- forecast API
# Exactly the URL fetchConditions() builds.
air_url = (
    f"{FORECAST_URL}?latitude={lats}&longitude={lons}"
    f"&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,uv_index"
    f"&wind_speed_unit=kmh&timezone=auto"
)
air, air_err = fetch("forecast API — current conditions (multi-point)", air_url)
if air is not None:
    entries = as_list(air)
    print(f"  returned {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} for {len(POINTS)} points", flush=True)
    if len(entries) != len(POINTS):
        problems.append(f"forecast: expected {len(POINTS)} entries, got {len(entries)}")
    results["forecast_current"] = {}
    for (name, _, _), entry in zip(POINTS, entries):
        results["forecast_current"][name] = check_fields(
            name, entry, "current",
            ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "temperature_2m", "uv_index"],
        )

# ------------------------------------------------------------------ marine API
# Exactly the URL fetchConditions() builds. sea_surface_temperature is the field
# the new UI leans on hardest, and the one that was never tested live.
sea_url = (
    f"{MARINE_URL}?latitude={lats}&longitude={lons}"
    f"&current=wave_height,sea_surface_temperature&timezone=auto"
)
sea, sea_err = fetch("marine API — waves + sea temperature (multi-point)", sea_url)
if sea is not None:
    entries = as_list(sea)
    print(f"  returned {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} for {len(POINTS)} points", flush=True)
    results["marine_current"] = {}
    for (name, _, _), entry in zip(POINTS, entries):
        results["marine_current"][name] = check_fields(
            name, entry, "current", ["wave_height", "sea_surface_temperature"]
        )

# If sea_surface_temperature is rejected, find out what the marine API does offer.
if sea_err or any(
    "sea_surface_temperature" in (v.get("missing") or [])
    for v in results.get("marine_current", {}).values()
):
    probe, _ = fetch(
        "marine API — probing sea_surface_temperature alone",
        f"{MARINE_URL}?latitude={POINTS[0][1]}&longitude={POINTS[0][2]}&current=sea_surface_temperature",
    )
    results["marine_sst_probe"] = probe

# ------------------------------------------------- forecast API: hourly + daily
# Exactly the URL fetchAreaTimeline(lat, lon, true) builds.
tl_url = (
    f"{FORECAST_URL}?latitude={POINTS[0][1]}&longitude={POINTS[0][2]}"
    f"&hourly=wind_speed_10m,uv_index&daily=sunrise,sunset"
    f"&wind_speed_unit=kmh&timezone=auto&forecast_days=2"
)
tl, tl_err = fetch("forecast API — hourly timeline + daily sun times", tl_url)
if tl is not None:
    entry = as_list(tl)[0]
    hourly = entry.get("hourly", {}) or {}
    daily = entry.get("daily", {}) or {}
    print(f"  hourly keys: {sorted(hourly.keys())}", flush=True)
    print(f"  daily keys:  {sorted(daily.keys())}", flush=True)
    for key in ("time", "wind_speed_10m", "uv_index"):
        n = len(hourly.get(key) or [])
        print(f"  hourly.{key}: {n} values" + (f", first={hourly[key][0]}" if n else ""), flush=True)
        if not n:
            problems.append(f"timeline: hourly.{key} empty")
    for key in ("sunrise", "sunset"):
        vals = daily.get(key) or []
        print(f"  daily.{key}: {vals}", flush=True)
        if not vals:
            problems.append(f"timeline: daily.{key} empty")
    print(f"  timezone: {entry.get('timezone')} ({entry.get('utc_offset_seconds')}s)", flush=True)
    results["timeline"] = {"hourly_keys": sorted(hourly.keys()), "daily_keys": sorted(daily.keys()),
                           "timezone": entry.get("timezone"), "sunrise": daily.get("sunrise"),
                           "sunset": daily.get("sunset")}

# ------------------------------------------- marine API: sea temperature trend
# For the sea-temperature evolution chart: recent past + forecast in one call.
# past_days is the parameter in question - if the marine API rejects it, or
# silently returns forecast only, the chart has nothing to plot.
hist_url = (
    f"{MARINE_URL}?latitude={POINTS[1][1]}&longitude={POINTS[1][2]}"
    f"&hourly=sea_surface_temperature,wave_height&past_days=7&forecast_days=3&timezone=auto"
)
hist, hist_err = fetch("marine API — sea temperature history + forecast (past_days)", hist_url)
if hist is not None:
    entry = as_list(hist)[0]
    hourly = entry.get("hourly", {}) or {}
    times = hourly.get("time") or []
    temps = hourly.get("sea_surface_temperature") or []
    waves = hourly.get("wave_height") or []
    print(f"  hourly keys: {sorted(hourly.keys())}", flush=True)
    print(f"  time: {len(times)} values" + (f"  {times[0]} .. {times[-1]}" if times else ""), flush=True)
    print(f"  sea_surface_temperature: {len(temps)} values", flush=True)
    print(f"  wave_height: {len(waves)} values", flush=True)

    real = [t for t in temps if t is not None]
    if real:
        print(f"  range {min(real)}°C .. {max(real)}°C, nulls={len(temps) - len(real)}", flush=True)
        # Daily means make the shape of the trend obvious in the log.
        by_day = {}
        for t, v in zip(times, temps):
            if v is not None:
                by_day.setdefault(t[:10], []).append(v)
        print("  daily mean sea temp:", flush=True)
        for day in sorted(by_day):
            vals = by_day[day]
            print(f"    {day}  {sum(vals)/len(vals):.2f}°C  (n={len(vals)}, "
                  f"min {min(vals):.1f}, max {max(vals):.1f})", flush=True)
        results["sea_history"] = {"hours": len(times), "first": times[0], "last": times[-1],
                                  "days": {d: round(sum(v)/len(v), 2) for d, v in sorted(by_day.items())}}
        # 10 days of hourly data should be ~240 points; far fewer means past_days was ignored.
        if len(times) < 200:
            problems.append(f"sea history: only {len(times)} hourly values, expected ~240 (past_days may be ignored)")
    else:
        problems.append("sea history: sea_surface_temperature returned no values")
        results["sea_history"] = {"error": "no values"}

# ------------------------------------------------------- road distance (OSRM)
# Straight-line distance misleads badly on this coastline: Salonikiou is 20 km
# across the Singitic Gulf but 39 km by road, because you drive around the bay.
# OSRM's table service answers many destinations from one origin in a single
# request, which is the only polite way to ask for 40 beaches at once.
OSRM_URL = "https://router.project-osrm.org/table/v1/driving"
HERE = (40.429569, 23.849819)          # the reporter's pin at Kakoudia
ROAD_TARGETS = [
    ("Salonikiou (Google says 39 km / 42 min)", 40.29298, 23.69503),
    ("Develiki", 40.36266, 23.82645),
    ("Ierissos town", 40.39860, 23.87920),
    ("Nea Roda", 40.38060, 23.92500),
]

coords = ";".join(f"{lon},{lat}" for _, lat, lon in [("", HERE[0], HERE[1])] + ROAD_TARGETS)
dests = ";".join(str(i) for i in range(1, len(ROAD_TARGETS) + 1))
osrm_url = f"{OSRM_URL}/{coords}?sources=0&destinations={dests}&annotations=duration,distance"
osrm, osrm_err = fetch("OSRM table — driving distance for several beaches at once", osrm_url)
if osrm is not None and osrm.get("code") == "Ok":
    durations = (osrm.get("durations") or [[]])[0]
    distances = (osrm.get("distances") or [[]])[0]
    print(f"  returned {len(distances)} distances for {len(ROAD_TARGETS)} destinations", flush=True)
    road = {}
    for (name, lat, lon), dist, dur in zip(ROAD_TARGETS, distances, durations):
        straight = haversine_km(HERE[0], HERE[1], lat, lon)
        if dist is None:
            print(f"  {name}: no route found", flush=True)
            continue
        km, mins = dist / 1000, dur / 60
        print(f"  {name}: straight {straight:.1f} km -> road {km:.1f} km, {mins:.0f} min "
              f"(detour factor {km / straight:.2f}x)", flush=True)
        road[name] = {"straight_km": round(straight, 1), "road_km": round(km, 1),
                      "minutes": round(mins), "factor": round(km / straight, 2)}
    results["road_distance"] = road
    if not road:
        problems.append("OSRM: no routes returned")
elif osrm is not None:
    problems.append(f"OSRM returned code={osrm.get('code')}")
    print(f"  body: {json.dumps(osrm)[:300]}", flush=True)

# -------------------------------------------------------------------- geocoder
geo_url = f"{GEOCODE_URL}?name={urllib.parse.quote('Chania')}&count=6&language=en&format=json"
geo, geo_err = fetch("geocoding API — place search", geo_url)
if geo is not None:
    hits = geo.get("results") or []
    print(f"  {len(hits)} results; first: " +
          (json.dumps({k: hits[0].get(k) for k in ('name', 'admin1', 'country', 'country_code',
                                                   'latitude', 'longitude')}, ensure_ascii=False)
           if hits else "(none)"), flush=True)
    if not hits:
        problems.append("geocoder: no results for 'Chania'")
    results["geocode"] = hits[:2]

# ---------------------------------------------------------------------- summary
with open("api_verification.json", "w", encoding="utf-8") as f:
    json.dump({"results": results, "problems": problems}, f, indent=2, ensure_ascii=False)

print("\n" + "=" * 60, flush=True)
if problems:
    print(f"PROBLEMS FOUND ({len(problems)}):", flush=True)
    for p in problems:
        print(f"  - {p}", flush=True)
else:
    print("ALL FIELDS THE APP READS ARE PRESENT AND POPULATED", flush=True)
print("=" * 60, flush=True)

# Exit 0 either way: a red X would hide the report, and the report is the point.
sys.exit(0)
