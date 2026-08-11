"""
Fetch the real geometry of an OpenStreetMap way and describe its extent.

A long beach is stored in this app as a single point, which is why Kakoudia
(about 3 km, three distinct areas) can't be represented properly. Pulling the
actual polyline shows where it starts and ends, how long it really is, and
which end is which — so sections can be placed on evidence rather than on a
guess about compass direction.

Usage: python scripts/osm_way_extent.py way/363019603 [more ids...]
"""
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
USER_AGENT = "WhereToSwim-beach-finder/1.0 (personal hobby project; github.com/naskoos/WhereToSwim)"


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def compass(deg):
    return COMPASS[round(deg / 22.5) % 16]


def fetch(query):
    body = ("data=" + urllib.parse.quote(query)).encode("utf-8")
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"  {url} failed: {e}", flush=True)
    return None


def describe(kind, osm_id, out):
    q = f"[out:json][timeout:40];{kind}({osm_id});out geom tags;"
    data = fetch(q)
    if not data or not data.get("elements"):
        print(f"  no geometry returned for {kind}/{osm_id}", flush=True)
        return

    el = data["elements"][0]
    tags = el.get("tags", {}) or {}
    geom = el.get("geometry") or []
    if not geom and el.get("members"):
        for m in el["members"]:
            geom.extend(m.get("geometry") or [])
    if len(geom) < 2:
        print(f"  {kind}/{osm_id} has no usable geometry", flush=True)
        return

    pts = [(p["lat"], p["lon"]) for p in geom]
    print(f"\n=== {kind}/{osm_id} — {tags.get('name', '(unnamed)')} ===", flush=True)
    print(f"  tags: {json.dumps(tags, ensure_ascii=False)}", flush=True)
    print(f"  {len(pts)} points", flush=True)

    # Perimeter, and the two points furthest apart (the real ends of the beach).
    perimeter = sum(haversine_km(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
    best = (0, pts[0], pts[0])
    step = max(1, len(pts) // 200)   # sample for very detailed ways
    sample = pts[::step]
    for i in range(len(sample)):
        for j in range(i + 1, len(sample)):
            d = haversine_km(*sample[i], *sample[j])
            if d > best[0]:
                best = (d, sample[i], sample[j])

    span, a, b = best
    # Report the westerly end first so "east end" is unambiguous.
    west, east = (a, b) if a[1] <= b[1] else (b, a)
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    centroid = (sum(lats) / len(lats), sum(lons) / len(lons))

    print(f"  path length along the shore: {perimeter:.2f} km", flush=True)
    print(f"  straight-line span end to end: {span:.2f} km", flush=True)
    print(f"  bounding box: {min(lats):.5f},{min(lons):.5f} .. {max(lats):.5f},{max(lons):.5f}", flush=True)
    print(f"  centroid (what the app currently uses): {centroid[0]:.5f}, {centroid[1]:.5f}", flush=True)
    print(f"  WEST end: {west[0]:.5f}, {west[1]:.5f}", flush=True)
    print(f"  EAST end: {east[0]:.5f}, {east[1]:.5f}", flush=True)
    print(f"  orientation west->east: {bearing(*west, *east):.0f}° ({compass(bearing(*west, *east))})", flush=True)

    # Thirds along the shore, for a beach described as having three areas.
    thirds = []
    target = perimeter / 3
    acc, idx = 0.0, 0
    for i in range(len(pts) - 1):
        acc += haversine_km(*pts[i], *pts[i + 1])
        if acc >= target * (idx + 1) and idx < 2:
            thirds.append(pts[i + 1])
            idx += 1
    print("  points at one third and two thirds along the shore:", flush=True)
    for k, p in enumerate(thirds, 1):
        print(f"    {k}/3: {p[0]:.5f}, {p[1]:.5f}", flush=True)

    out[f"{kind}/{osm_id}"] = {
        "name": tags.get("name"), "tags": tags, "points": len(pts),
        "shore_length_km": round(perimeter, 3), "span_km": round(span, 3),
        "centroid": [round(centroid[0], 5), round(centroid[1], 5)],
        "west_end": [round(west[0], 5), round(west[1], 5)],
        "east_end": [round(east[0], 5), round(east[1], 5)],
        "bearing_w_to_e": round(bearing(*west, *east)),
        "thirds": [[round(p[0], 5), round(p[1], 5)] for p in thirds],
        "bbox": [round(min(lats), 5), round(min(lons), 5), round(max(lats), 5), round(max(lons), 5)],
    }


def main():
    targets = sys.argv[1:] or ["way/363019603"]
    out = {}
    for t in targets:
        kind, _, osm_id = t.partition("/")
        if kind not in ("way", "relation", "node") or not osm_id.isdigit():
            print(f"skipping {t!r}: expected e.g. way/363019603", flush=True)
            continue
        describe(kind, osm_id, out)

    with open("osm_extent.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nWrote osm_extent.json with {len(out)} feature(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
