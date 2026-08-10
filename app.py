import json
import math
import os

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

BEACHES_PATH = os.path.join(os.path.dirname(__file__), "beaches.json")
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
HTTP_TIMEOUT = 8

COMPASS_POINTS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

CROWD_PENALTY = {"low": 0, "medium": 8, "high": 18}

BEAUFORT_SCALE = [
    (1, 0, "Calm"),
    (5, 1, "Light air"),
    (11, 2, "Light breeze"),
    (19, 3, "Gentle breeze"),
    (28, 4, "Moderate breeze"),
    (38, 5, "Fresh breeze"),
    (49, 6, "Strong breeze"),
    (61, 7, "Near gale"),
    (74, 8, "Gale"),
    (88, 9, "Strong gale"),
    (102, 10, "Storm"),
    (117, 11, "Violent storm"),
    (math.inf, 12, "Hurricane"),
]


def kmh_to_beaufort(kmh):
    if kmh is None:
        return None
    for max_kmh, num, _label in BEAUFORT_SCALE:
        if kmh <= max_kmh:
            return num
    return 12


def beaufort_label(num):
    for _max_kmh, n, label in BEAUFORT_SCALE:
        if n == num:
            return label
    return ""


def load_beaches():
    with open(BEACHES_PATH, encoding="utf-8") as f:
        return json.load(f)


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def deg_to_compass(deg):
    if deg is None:
        return None
    idx = round(deg / 22.5) % 16
    return COMPASS_POINTS[idx]


def circular_diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def fetch_wind(beaches):
    """Batch-fetch current wind speed/direction for a list of beaches. Returns {id: (speed_kmh, dir_deg)}."""
    if not beaches:
        return {}
    lats = ",".join(str(b["lat"]) for b in beaches)
    lons = ",".join(str(b["lon"]) for b in beaches)
    params = {
        "latitude": lats,
        "longitude": lons,
        "current": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "kmh",
        "timezone": "auto",
    }
    try:
        resp = requests.get(FORECAST_URL, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException:
        return {}

    entries = data if isinstance(data, list) else [data]
    result = {}
    for beach, entry in zip(beaches, entries):
        current = entry.get("current", {}) if isinstance(entry, dict) else {}
        speed = current.get("wind_speed_10m")
        direction = current.get("wind_direction_10m")
        result[beach["id"]] = (speed, direction)
    return result


def fetch_waves(beaches):
    """Best-effort batch-fetch of current wave height for a list of beaches. Returns {id: wave_height_m or None}."""
    if not beaches:
        return {}
    lats = ",".join(str(b["lat"]) for b in beaches)
    lons = ",".join(str(b["lon"]) for b in beaches)
    params = {
        "latitude": lats,
        "longitude": lons,
        "current": "wave_height",
        "timezone": "auto",
    }
    try:
        resp = requests.get(MARINE_URL, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException:
        return {b["id"]: None for b in beaches}

    entries = data if isinstance(data, list) else [data]
    result = {}
    for beach, entry in zip(beaches, entries):
        current = entry.get("current", {}) if isinstance(entry, dict) else {}
        result[beach["id"]] = current.get("wave_height")
    return result


def score_beach(beach, distance_km, wind_speed, wind_dir, wave_height, want_toddler, want_bar, max_wave, max_beaufort):
    exposed = None
    if wind_dir is not None:
        diff = circular_diff(wind_dir, beach["facing_deg"])
        exposed = diff <= beach["shelter_arc_deg"] / 2

    beaufort = kmh_to_beaufort(wind_speed)

    if wave_height is not None:
        chop = wave_height * (1.0 if exposed else 0.6)
        chop_source = "marine forecast"
    elif wind_speed is not None:
        base = wind_speed / 50.0
        chop = base * (1.0 if exposed in (True, None) else 0.3)
        chop_source = "wind estimate"
    else:
        chop = None
        chop_source = "unknown"

    if chop is not None:
        calmness = max(0.0, 100.0 - chop * 80.0 - (wind_speed or 0) * 0.5)
    else:
        calmness = 50.0

    passes_wave = wave_height is None or wave_height <= max_wave
    passes_wind = beaufort is None or beaufort <= max_beaufort
    passes_comfort = passes_wave and passes_wind
    comfort_unknown = wave_height is None and beaufort is None

    score = calmness
    score += 10 if beach["toddler_friendly"] else -25 if want_toddler else 0
    score += 10 if beach["has_beach_bar"] else -25 if want_bar else 0
    score -= CROWD_PENALTY.get(beach["crowd_level"], 5)
    score -= distance_km * 0.3
    score += 0 if passes_comfort else -40

    reasons = []
    if wave_height is not None:
        over = "" if passes_wave else f" (over your {max_wave} m limit)"
        reasons.append(f"~{wave_height:.1f} m waves expected right now{over}")
    if wind_speed is not None:
        compass = deg_to_compass(wind_dir)
        state = "exposed to" if exposed else "sheltered from"
        over = "" if passes_wind else f" (over your Bft {max_beaufort} limit)"
        reasons.append(
            f"{state} the current {compass or ''} wind: Bft {beaufort} ({beaufort_label(beaufort)}, {wind_speed:.0f} km/h){over}".replace("  ", " ")
        )
    if beach["toddler_friendly"]:
        reasons.append("toddler-friendly (shallow/gentle entry)")
    if beach["has_beach_bar"]:
        reasons.append("has a beach bar/taverna")
    reasons.append(f"{beach['crowd_level']} crowd level")
    reasons.append(f"{distance_km:.0f} km away")

    return {
        "id": beach["id"],
        "name": beach["name"],
        "area": beach["area"],
        "lat": beach["lat"],
        "lon": beach["lon"],
        "distance_km": round(distance_km, 1),
        "score": round(score, 1),
        "calmness": round(calmness, 1),
        "exposed_to_wind": exposed,
        "wind_speed_kmh": wind_speed,
        "wind_direction": deg_to_compass(wind_dir),
        "beaufort": beaufort,
        "wave_height_m": wave_height,
        "chop_source": chop_source,
        "passes_comfort": passes_comfort,
        "comfort_unknown": comfort_unknown,
        "toddler_friendly": beach["toddler_friendly"],
        "toddler_notes": beach["toddler_notes"],
        "has_beach_bar": beach["has_beach_bar"],
        "bar_notes": beach["bar_notes"],
        "crowd_level": beach["crowd_level"],
        "notes": beach["notes"],
        "maps_url": f"https://www.google.com/maps/dir/?api=1&destination={beach['lat']},{beach['lon']}",
        "reasons": reasons,
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/geocode")
def api_geocode():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])
    params = {"name": query, "count": 8, "language": "en", "format": "json"}
    try:
        resp = requests.get(GEOCODE_URL, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException:
        return jsonify({"error": "geocoding service unavailable"}), 502

    results = []
    for item in data.get("results", []) or []:
        label_parts = [item.get("name")]
        if item.get("admin1"):
            label_parts.append(item["admin1"])
        if item.get("country"):
            label_parts.append(item["country"])
        results.append({
            "label": ", ".join(p for p in label_parts if p),
            "lat": item.get("latitude"),
            "lon": item.get("longitude"),
        })
    return jsonify(results)


@app.route("/api/recommend")
def api_recommend():
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lon query parameters are required"}), 400

    radius_km = float(request.args.get("radius_km", 30))
    want_toddler = request.args.get("toddler", "true").lower() != "false"
    want_bar = request.args.get("needs_bar", "true").lower() != "false"
    max_wave = float(request.args.get("max_wave", 0.3))
    max_beaufort = int(request.args.get("max_beaufort", 3))
    max_results = int(request.args.get("max_results", 6))

    beaches = load_beaches()
    candidates = []
    for b in beaches:
        distance = haversine_km(lat, lon, b["lat"], b["lon"])
        if distance <= radius_km:
            candidates.append((b, distance))

    if not candidates:
        candidates = sorted(
            ((b, haversine_km(lat, lon, b["lat"], b["lon"])) for b in beaches),
            key=lambda t: t[1],
        )[:5]

    beach_list = [b for b, _ in candidates]
    wind_by_id = fetch_wind(beach_list)
    wave_by_id = fetch_waves(beach_list)

    scored = []
    for b, distance in candidates:
        wind_speed, wind_dir = wind_by_id.get(b["id"], (None, None))
        wave_height = wave_by_id.get(b["id"])
        scored.append(score_beach(b, distance, wind_speed, wind_dir, wave_height, want_toddler, want_bar, max_wave, max_beaufort))

    strict = [
        s for s in scored
        if (not want_toddler or s["toddler_friendly"]) and (not want_bar or s["has_beach_bar"]) and s["passes_comfort"]
    ]
    pool = strict if len(strict) >= 3 else scored
    pool.sort(key=lambda s: s["score"], reverse=True)

    return jsonify({
        "query": {"lat": lat, "lon": lon, "radius_km": radius_km},
        "relaxed_filters": pool is scored and len(strict) < 3,
        "results": pool[:max_results],
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
