"""
Bulk reverse-geocode the unnamed beach candidates from the OSM import
(osm_bulk_beaches.json on the osm-bulk-review branch) against Nominatim,
OpenStreetMap's own geocoder. This replaces WebSearch-snippet guessing
(which caused real mistakes - beaches misattributed to Turkey and to the
wrong Greek region) with an actual lookup: nearest real settlement name,
country, and administrative area for every point.

Runs on GitHub Actions (this sandbox's outbound network can't reach
Nominatim directly, same reason the Overpass import runs there). Writes
geocode_results.json - does not touch beaches.json or osm_bulk_beaches.json.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "WhereToSwim-beach-finder/1.0 (personal hobby project; github.com/naskoos/WhereToSwim)"
RATE_LIMIT_SECONDS = 1.1  # Nominatim's usage policy: max 1 request/second


def reverse_geocode(lat, lon, retries=2):
    params = urllib.parse.urlencode({
        "lat": lat,
        "lon": lon,
        "format": "json",
        "zoom": 16,
        "addressdetails": 1,
    })
    url = f"{NOMINATIM_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"  geocode failed (attempt {attempt + 1}): {e}", flush=True)
            time.sleep(3)
    return {"error": "failed after retries"}


def main():
    only_unnamed = "--all" not in sys.argv

    with open("osm_bulk_beaches.json", encoding="utf-8") as f:
        candidates = json.load(f)

    if only_unnamed:
        candidates = [c for c in candidates if c["name"].startswith("Unnamed")]

    print(f"Reverse-geocoding {len(candidates)} points (rate-limited to ~1/sec, so this will take a while)...", flush=True)

    results = []
    start = time.time()
    for i, c in enumerate(candidates):
        geo = reverse_geocode(c["lat"], c["lon"])
        address = geo.get("address", {}) if isinstance(geo, dict) else {}
        results.append({
            "osm_type": c.get("osm_type"),
            "osm_id": c.get("osm_id"),
            "name": c.get("name"),
            "region": c.get("region"),
            "lat": c["lat"],
            "lon": c["lon"],
            "geocode_display_name": geo.get("display_name") if isinstance(geo, dict) else None,
            "geocode_country": address.get("country"),
            "geocode_country_code": address.get("country_code"),
            "geocode_state": address.get("state"),
            "geocode_locality": (
                address.get("suburb")
                or address.get("village")
                or address.get("town")
                or address.get("municipality")
                or address.get("city")
                or address.get("hamlet")
            ),
        })

        if (i + 1) % 25 == 0 or (i + 1) == len(candidates):
            elapsed = time.time() - start
            print(f"  {i + 1}/{len(candidates)} geocoded ({elapsed:.0f}s elapsed)", flush=True)
            with open("geocode_results.json", "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)

        time.sleep(RATE_LIMIT_SECONDS)

    with open("geocode_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    non_greece = [r for r in results if r["geocode_country_code"] and r["geocode_country_code"] != "gr"]
    print(f"\nDone: {len(results)} geocoded, wrote geocode_results.json", flush=True)
    if non_greece:
        print(f"WARNING: {len(non_greece)} points geocoded to a country other than Greece:", flush=True)
        for r in non_greece[:20]:
            print(f"  {r['region']} / {r['osm_type']}{r['osm_id']}: {r['geocode_country']} ({r['geocode_display_name']})", flush=True)


if __name__ == "__main__":
    main()
