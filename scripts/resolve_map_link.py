"""
Resolve a shared map link (goo.gl/maps, maps.app.goo.gl, google.com/maps, OSM)
into plain coordinates.

Short links only redirect; the coordinates live in the URL you land on. The dev
sandbox has no outbound access, so this runs on GitHub Actions like the other
network jobs.

Usage: python scripts/resolve_map_link.py "<url>"
Writes resolved_link.json.
"""
import json
import re
import sys
import urllib.error
import urllib.request

# A plain urllib request gets a consent interstitial from Google; a browser-ish
# UA lands on the real redirect.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/126.0 Mobile Safari/537.36",
    "Accept-Language": "en",
}

# Ordered most-precise first: the !3d/!4d pair is the placed pin, @lat,lon is
# the map centre, which can differ by a fair margin when the view is panned.
PATTERNS = [
    ("pin (!3d!4d)",      r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)"),
    ("query (q= / ll=)",  r"[?&](?:q|ll|daddr|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)"),
    ("map centre (@)",    r"@(-?\d+\.\d+),(-?\d+\.\d+)"),
    ("osm hash",          r"#map=\d+/(-?\d+\.\d+)/(-?\d+\.\d+)"),
    ("osm query",         r"[?&]mlat=(-?\d+\.\d+)&mlon=(-?\d+\.\d+)"),
]


def follow(url, max_hops=10):
    """Walk the redirect chain, returning every URL seen plus the final body."""
    chain = [url]
    body = ""
    current = url
    for _ in range(max_hops):
        req = urllib.request.Request(current, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                final = resp.geturl()
                if final != current:
                    chain.append(final)
                    current = final
                raw = resp.read(400_000)
                body = raw.decode("utf-8", "replace")
                break
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.headers else None
            print(f"  HTTP {e.code} at {current}", flush=True)
            if loc and loc != current:
                chain.append(loc)
                current = loc
                continue
            break
        except urllib.error.URLError as e:
            print(f"  request failed: {e}", flush=True)
            break
    return chain, body


def extract(text):
    """Every coordinate pair found, tagged with which pattern matched."""
    hits = []
    for label, pattern in PATTERNS:
        for lat, lon in re.findall(pattern, text):
            lat, lon = float(lat), float(lon)
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                hits.append({"how": label, "lat": lat, "lon": lon})
    return hits


def main():
    if len(sys.argv) < 2:
        print("need a URL", flush=True)
        return 1
    url = sys.argv[1].strip()
    print(f"Resolving {url}\n", flush=True)

    chain, body = follow(url)
    print("Redirect chain:", flush=True)
    for i, hop in enumerate(chain):
        print(f"  {i}. {hop[:300]}", flush=True)

    from_url = []
    for hop in chain:
        from_url.extend(extract(hop))
    from_body = extract(body) if body else []

    print(f"\nCoordinates in the URL chain: {len(from_url)}", flush=True)
    for h in from_url:
        print(f"  {h['how']:20s} {h['lat']:.6f}, {h['lon']:.6f}", flush=True)

    print(f"Coordinates in the page body: {len(from_body)} (showing first 8)", flush=True)
    for h in from_body[:8]:
        print(f"  {h['how']:20s} {h['lat']:.6f}, {h['lon']:.6f}", flush=True)

    best = None
    for source in (from_url, from_body):
        for label, _ in PATTERNS:
            match = next((h for h in source if h["how"] == label), None)
            if match:
                best = match
                break
        if best:
            break

    # Title/place name, if the landing page carries one.
    title = None
    m = re.search(r"<title>(.*?)</title>", body, re.S | re.I)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()[:200]
    if title:
        print(f"\nPage title: {title}", flush=True)

    result = {"input": url, "chain": chain, "title": title,
              "candidates": from_url + from_body[:8], "best": best}
    with open("resolved_link.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("\n" + "=" * 56, flush=True)
    if best:
        print(f"RESOLVED: {best['lat']:.6f}, {best['lon']:.6f}   (via {best['how']})", flush=True)
    else:
        print("NO COORDINATES FOUND — the link may need a browser to resolve.", flush=True)
    print("=" * 56, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
