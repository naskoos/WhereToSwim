"""
Snap hand-curated beach coordinates onto actual mapped beaches.

The 61 curated entries were written from Wikipedia, which gives a settlement's
coordinate — the village centre, frequently a kilometre or more inland — not
the beach. So "Pyrgadikia Beach" pointed at a road junction and directions sent
you to the wrong place. 44 of the 61 sat over a kilometre from any mapped
beach.

Their hand-written notes (toddler-friendliness, crowd level, shelter arc) are
still the best information in the dataset, so this keeps all of that and
replaces only the coordinate, taking it from the nearest OSM-mapped beach.

Snapping is capped: beyond MAX_SNAP_KM the nearest mapped beach is probably a
different beach entirely, so those are reported for a human to look at rather
than silently moved. Every change is printed with its distance.

    python scripts/snap_curated_to_beaches.py --dry-run   # report only
    python scripts/snap_curated_to_beaches.py             # apply
"""
import json
import re
import math
import sys

BEACHES = "beaches.json"

# Within this, the nearest mapped beach is almost certainly the beach the
# curated entry was describing. Beyond it, don't guess.
MAX_SNAP_KM = 6.0
# Already close enough that moving would add nothing.
ALREADY_GOOD_KM = 0.3

# Distance alone is not enough to identify a beach. The nearest mapped beach to
# "Voidokilia" is a different beach called Agios Nikolaos, and the nearest to
# "Marathon Beach" is a bar called Rusty Cannon; snapping to either would swap
# a vague coordinate for a confidently wrong one. So a snap also requires the
# names to agree.
GREEK_TO_LATIN = {
    "\u03b1":"a","\u03ac":"a","\u03b2":"v","\u03b3":"g","\u03b4":"d","\u03b5":"e","\u03ad":"e","\u03b6":"z",
    "\u03b7":"i","\u03ae":"i","\u03b8":"th","\u03b9":"i","\u03af":"i","\u03ca":"i","\u0390":"i","\u03ba":"k",
    "\u03bb":"l","\u03bc":"m","\u03bd":"n","\u03be":"x","\u03bf":"o","\u03cc":"o","\u03c0":"p","\u03c1":"r",
    "\u03c3":"s","\u03c2":"s","\u03c4":"t","\u03c5":"y","\u03cd":"y","\u03cb":"y","\u03b0":"y","\u03c6":"f",
    "\u03c7":"ch","\u03c8":"ps","\u03c9":"o","\u03ce":"o",
}
# Words that carry no identifying force when comparing names.
NOISE = {"beach", "paralia", "plaz", "akti", "town", "city", "the", "of", "gymnistion",
         "hotel", "resort", "bar", "unofficial", "nudist", "blue", "flag"}


def latinise(text):
    out = []
    for ch in text.lower():
        out.append(GREEK_TO_LATIN.get(ch, ch))
    return "".join(out)


def name_tokens(name):
    latin = latinise(name)
    words = re.findall(r"[a-z]+", latin)
    return {w for w in words if len(w) > 3 and w not in NOISE}


def names_agree(a, b):
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return False
    if ta & tb:
        return True
    # Allow near-misses from transliteration drift (Nikitis / Nikiti).
    for x in ta:
        for y in tb:
            if x.startswith(y[:5]) or y.startswith(x[:5]):
                return True
    return False


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def main():
    dry = "--dry-run" in sys.argv

    with open(BEACHES, encoding="utf-8") as f:
        beaches = json.load(f)

    curated = [b for b in beaches if b.get("source", "curated") == "curated"]
    mapped = [b for b in beaches if b.get("source") == "osm"]
    print(f"{len(curated)} curated entries, {len(mapped)} mapped beaches to snap to\n")

    snapped, already, too_far = [], [], []

    for b in curated:
        nearest = min(mapped, key=lambda o: haversine_km(b["lat"], b["lon"], o["lat"], o["lon"]))
        dist = haversine_km(b["lat"], b["lon"], nearest["lat"], nearest["lon"])

        if dist <= ALREADY_GOOD_KM:
            already.append((dist, b))
            continue
        if dist > MAX_SNAP_KM or not names_agree(b["name"], nearest["name"]):
            too_far.append((dist, b, nearest))
            continue

        old = (b["lat"], b["lon"])
        b["lat"], b["lon"] = nearest["lat"], nearest["lon"]
        b["coordinate_source"] = f"matched to the OpenStreetMap beach \u201c{nearest['name']}\u201d"
        # The old note claimed Wikipedia verification, which is what caused this.
        b["notes"] = (b.get("notes", "")
                      .replace(" Coordinates verified against Wikipedia.", "")
                      .replace(" Coordinates verified against public GPS listings.", "")
                      .strip())
        b["notes"] = (b["notes"] + " Position taken from the nearest OpenStreetMap-mapped beach; "
                      "the description here is still hand-written.").strip()
        snapped.append((dist, b, old, nearest))

    snapped.sort(reverse=True)
    too_far.sort(reverse=True)

    print(f"SNAPPED ({len(snapped)}) — coordinate moved onto a mapped beach:")
    for dist, b, old, nearest in snapped:
        print(f"  {dist:5.2f} km  {b['name'][:32]:32s} {old[0]:.4f},{old[1]:.4f} "
              f"-> {b['lat']:.5f},{b['lon']:.5f}  [{nearest['name'][:28]}]", flush=True)

    print(f"\nALREADY ON A BEACH ({len(already)}) — left alone:")
    for dist, b in sorted(already):
        print(f"  {dist:5.2f} km  {b['name'][:32]}")

    print(f"\nNOT SNAPPED ({len(too_far)}) — name doesn't match or too far; left unchanged:")
    for dist, b, nearest in too_far:
        why = "too far" if dist > MAX_SNAP_KM else "different name"
        print(f"  {dist:5.2f} km  {b['name'][:32]:32s} nearest: {nearest['name'][:26]:26s} ({why})")

    if dry:
        print("\n(dry run — nothing written)")
        return 0

    with open(BEACHES, "w", encoding="utf-8") as f:
        json.dump(beaches, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\nWrote {BEACHES}: {len(snapped)} coordinates corrected, "
          f"{len(too_far)} still needing attention.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
