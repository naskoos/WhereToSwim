"""
Bulk-import candidate beaches from OpenStreetMap (Overpass API) for the
whole Greek coastline, mainland and islands.

Runs on GitHub Actions (this sandbox's outbound network can't reach
Overpass directly). Writes candidate entries to osm_bulk_beaches.json
at the repo root for manual review - it does NOT touch beaches.json
directly, so a human can sanity-check the results before merging.
"""
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

USER_AGENT = "WhereToSwim-beach-finder/1.0 (personal hobby project; github.com/naskoos/WhereToSwim)"

# Rough bounding boxes (south, west, north, east) covering mainland
# Greek coastal regions.
MAINLAND_REGIONS = {
    "Evros": (40.75, 25.7, 41.0, 26.35),
    "Rodopi-Xanthi": (40.75, 24.75, 41.05, 25.35),
    "Kavala mainland": (40.75, 23.95, 41.0, 24.5),
    "Chalkidiki-Thessaloniki-Pieria": (39.9, 22.4, 40.65, 24.1),
    "Thessaly (Magnesia/Pelion)": (39.0, 22.5, 39.5, 23.3),
    "Central Greece (Maliakos)": (38.7, 22.5, 39.0, 22.85),
    "Aetolia-Acarnania": (38.2, 20.9, 38.7, 21.5),
    "Epirus": (38.9, 20.2, 39.6, 20.8),
    "Attica": (37.6, 23.4, 38.2, 24.1),
    "Corinthia-Argolis": (37.5, 22.6, 38.0, 23.2),
    "Laconia-Mani": (36.4, 22.3, 37.1, 23.2),
    "Messinia": (36.7, 21.5, 37.3, 22.3),
    "Elis-Achaea": (37.6, 21.1, 38.3, 21.9),
}

# Bounding boxes covering the main Greek island groups.
ISLAND_REGIONS = {
    "Corfu": (39.35, 19.65, 39.82, 20.15),
    "Paxoi": (39.1, 20.1, 39.25, 20.28),
    "Lefkada": (38.55, 20.5, 38.85, 20.78),
    "Kefalonia-Ithaca": (38.05, 20.4, 38.55, 20.85),
    "Zakynthos": (37.65, 20.7, 37.95, 21.0),
    "Kythira-Antikythira": (35.75, 22.95, 36.4, 23.15),
    "Evia": (37.95, 23.0, 39.05, 24.25),
    "Sporades": (39.0, 23.3, 39.6, 24.7),
    "Saronic islands": (37.1, 23.1, 38.05, 23.65),
    "Thassos": (40.6, 24.55, 40.82, 24.85),
    "Samothraki": (40.38, 25.4, 40.6, 25.65),
    "Crete": (34.75, 23.4, 35.75, 26.35),
    "Cyclades": (36.35, 24.15, 37.9, 26.4),
    "Dodecanese-North (Kos-Kalymnos-Leros-Patmos)": (35.85, 26.1, 37.0, 27.6),
    "Dodecanese-South (Rhodes-Karpathos)": (35.1, 27.0, 36.6, 28.5),
    "NE Aegean-North (Lesvos-Chios)": (38.0, 25.6, 39.5, 26.6),
    "NE Aegean-South (Samos-Ikaria)": (37.5, 26.0, 38.0, 27.3),
}

ALL_REGIONS = {**MAINLAND_REGIONS, **ISLAND_REGIONS}
ISLAND_REGION_NAMES = set(ISLAND_REGIONS.keys())

AMENITY_RADIUS_KM = 0.4
DEDUPE_KM = 0.4
CURATED_DEDUPE_KM = 0.5


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def overpass_query(bbox):
    s, w, n, e = bbox
    return (
        f"[out:json][timeout:90];"
        f"("
        f'nwr["natural"="beach"]({s},{w},{n},{e});'
        f'nwr["leisure"="beach_resort"]({s},{w},{n},{e});'
        f'nwr["amenity"~"^(bar|cafe|restaurant)$"]({s},{w},{n},{e});'
        f'nwr["amenity"="toilets"]({s},{w},{n},{e});'
        f");"
        f"out center tags;"
    )


def fetch_overpass(query):
    body = ("data=" + urllib.parse.quote(query)).encode("utf-8")
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"  overpass request failed on {url}: {e}", flush=True)
            continue
    return None


def element_latlon(el):
    if "lat" in el and "lon" in el:
        return el["lat"], el["lon"]
    center = el.get("center")
    if center:
        return center["lat"], center["lon"]
    return None


def main():
    only_islands = "--islands-only" in sys.argv
    only_mainland = "--mainland-only" in sys.argv
    only_arg = next((a for a in sys.argv if a.startswith("--only=")), None)

    if only_arg:
        names = [n.strip() for n in only_arg[len("--only="):].split(",") if n.strip()]
        regions = {n: ALL_REGIONS[n] for n in names if n in ALL_REGIONS}
        missing = [n for n in names if n not in ALL_REGIONS]
        if missing:
            print(f"Warning: unknown region names ignored: {missing}", flush=True)
    elif only_islands:
        regions = ISLAND_REGIONS
    elif only_mainland:
        regions = MAINLAND_REGIONS
    else:
        regions = ALL_REGIONS

    with open("beaches.json", encoding="utf-8") as f:
        curated = json.load(f)

    all_candidates = []
    for region_name, bbox in regions.items():
        print(f"Querying {region_name} {bbox} ...", flush=True)
        data = fetch_overpass(overpass_query(bbox))
        if not data or not isinstance(data.get("elements"), list):
            print(f"  no data for {region_name}, skipping", flush=True)
            continue

        raw_beaches = []
        amenities = []
        for el in data["elements"]:
            pos = element_latlon(el)
            if not pos:
                continue
            tags = el.get("tags", {}) or {}
            if tags.get("natural") == "beach" or tags.get("leisure") == "beach_resort":
                raw_beaches.append({"type": el["type"], "id": el["id"], "lat": pos[0], "lon": pos[1], "tags": tags})
            elif tags.get("amenity") == "toilets":
                amenities.append({"lat": pos[0], "lon": pos[1], "is_toilet": True})
            elif tags.get("amenity") in ("bar", "cafe", "restaurant"):
                amenities.append({"lat": pos[0], "lon": pos[1], "is_toilet": False})

        is_island = region_name in ISLAND_REGION_NAMES
        for rb in raw_beaches:
            surface = (rb["tags"].get("surface") or "").lower()
            name = rb["tags"].get("name") or rb["tags"].get("name:en") or f"Unnamed beach ({region_name})"

            nearby = [a for a in amenities if haversine_km(rb["lat"], rb["lon"], a["lat"], a["lon"]) <= AMENITY_RADIUS_KM]
            bar_count = sum(1 for a in nearby if not a["is_toilet"])
            has_toilet = any(a["is_toilet"] for a in nearby)

            all_candidates.append({
                "osm_type": rb["type"],
                "osm_id": rb["id"],
                "name": name,
                "region": region_name,
                "is_island": is_island,
                "lat": round(rb["lat"], 5),
                "lon": round(rb["lon"], 5),
                "surface": surface or None,
                "bar_count_nearby": bar_count,
                "has_toilet_nearby": has_toilet,
            })
        print(f"  {len(raw_beaches)} beach points kept", flush=True)
        time.sleep(2)  # be polite to the free API between region queries

    # Dedupe against each other (keep first / prefer named)
    deduped = []
    for cand in all_candidates:
        dup = next(
            (d for d in deduped if haversine_km(cand["lat"], cand["lon"], d["lat"], d["lon"]) < DEDUPE_KM),
            None,
        )
        if dup is None:
            deduped.append(cand)
        elif dup["name"].startswith("Unnamed") and not cand["name"].startswith("Unnamed"):
            deduped.remove(dup)
            deduped.append(cand)

    # Dedupe against existing curated beaches.json
    final = [
        c for c in deduped
        if not any(haversine_km(c["lat"], c["lon"], b["lat"], b["lon"]) < CURATED_DEDUPE_KM for b in curated)
    ]

    print(f"\nTotal raw candidates: {len(all_candidates)}")
    print(f"After self-dedup: {len(deduped)}")
    print(f"After dedup against {len(curated)} curated beaches: {len(final)}")

    out_path = "osm_bulk_beaches.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(final, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Wrote {out_path} with {len(final)} candidates")


if __name__ == "__main__":
    main()
