"""
Turn community reports (GitHub issues labelled 'beach-data') into community.json.

Design notes
------------
GitHub is doing the hard parts here. Every report carries a real account, the
full history is public and revertible, and abuse is handled by systems that
already exist. That buys Wikipedia-ish accountability without running a server
or storing anyone's personal data.

What this script adds on top:

* Majority. A field is only applied when agreements outnumber disagreements.
  One person can add a fact; one person can also be wrong, so a single report
  is applied at low confidence and is easy to overturn.
* Recency. Facilities change between summers, so seasonal claims are dated and
  the app expires them at the start of each season. Durable facts (position,
  which way a beach faces, what the shore is made of) don't expire.
* Sanity checks. Positions must be in Greece and near the beach they describe;
  values must match the field's type; a single account can only carry so much
  weight in one run.

Anything rejected is reported in the job log with a reason, so a good-faith
report that trips a check can be seen and fixed rather than vanishing.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

REPO = os.environ.get("GITHUB_REPOSITORY", "naskoos/WhereToSwim")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
API = "https://api.github.com"

BEACHES_PATH = "beaches.json"
OUT_PATH = "community.json"

# Greece, generously bounded. A position outside this is a mistake or mischief.
GREECE_BBOX = (34.6, 19.2, 41.9, 29.8)  # south, west, north, east
MAX_KM_FROM_PARENT = 8.0      # a claimed spot must plausibly be that beach
MAX_CLAIMS_PER_USER = 25      # one account can't flood a single run
TRUSTED_LABEL = "verified"    # maintainer-applied; counts double
REJECT_LABEL = "rejected"     # maintainer veto

SEASONAL_FIELDS = {"has_beach_bar", "bar_notes", "crowd_level"}

BOOL_FIELDS = {"has_beach_bar", "toddler_friendly"}
TEXT_FIELDS = {"name", "bar_notes", "toddler_notes", "notes", "area"}
ENUM_FIELDS = {"crowd_level": {"low", "medium", "high"}}
NUM_FIELDS = {"facing_deg": (0, 360), "shelter_arc_deg": (10, 359),
              "lat": (GREECE_BBOX[0], GREECE_BBOX[2]), "lon": (GREECE_BBOX[1], GREECE_BBOX[3])}

ALLOWED_FIELDS = BOOL_FIELDS | TEXT_FIELDS | set(ENUM_FIELDS) | set(NUM_FIELDS)

rejections = []


def log(msg):
    print(msg, flush=True)


def reject(issue_num, reason):
    rejections.append({"issue": issue_num, "reason": reason})
    log(f"  REJECTED #{issue_num}: {reason}")


def api_get(path):
    req = urllib.request.Request(f"{API}{path}", headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "WhereToSwim-community-bot",
        **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def haversine_km(lat1, lon1, lat2, lon2):
    import math
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_issues():
    """Every open issue carrying the beach-data label."""
    issues, page = [], 1
    while True:
        batch = api_get(f"/repos/{REPO}/issues?labels=beach-data&state=open&per_page=100&page={page}")
        if not batch:
            break
        issues.extend([i for i in batch if "pull_request" not in i])
        if len(batch) < 100:
            break
        page += 1
    return issues


def parse_issue_body(body):
    """
    Read GitHub's issue-form output. Each answer arrives as:

        ### Field name
        <blank>
        value

    Unfilled answers come through as "_No response_".
    """
    if not body:
        return {}
    fields, key, buf = {}, None, []
    for line in body.splitlines():
        heading = re.match(r"^###\s+(.*\S)\s*$", line)
        if heading:
            if key:
                fields[key] = "\n".join(buf).strip()
            key, buf = heading.group(1).strip().lower(), []
        elif key:
            buf.append(line)
    if key:
        fields[key] = "\n".join(buf).strip()
    return {k: ("" if v == "_No response_" else v) for k, v in fields.items()}


def coerce(field, raw):
    """Validate and convert a reported value; raises ValueError if it's no good."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("empty value")

    if field in BOOL_FIELDS:
        low = raw.lower()
        if low in ("yes", "true", "y", "1"):
            return True
        if low in ("no", "false", "n", "0"):
            return False
        raise ValueError(f"expected yes/no, got {raw!r}")

    if field in ENUM_FIELDS:
        low = raw.lower()
        if low not in ENUM_FIELDS[field]:
            raise ValueError(f"expected one of {sorted(ENUM_FIELDS[field])}, got {raw!r}")
        return low

    if field in NUM_FIELDS:
        try:
            val = float(raw)
        except ValueError:
            raise ValueError(f"expected a number, got {raw!r}")
        lo, hi = NUM_FIELDS[field]
        if not (lo <= val <= hi):
            raise ValueError(f"{val} outside the allowed range {lo}..{hi}")
        return val

    if field in TEXT_FIELDS:
        if len(raw) > 400:
            raise ValueError("text longer than 400 characters")
        if re.search(r"https?://", raw, re.I):
            raise ValueError("links aren't allowed in free text")
        return raw

    raise ValueError(f"unknown field {field!r}")


def main():
    with open(BEACHES_PATH, encoding="utf-8") as f:
        beaches = json.load(f)
    by_id = {b["id"]: b for b in beaches}
    log(f"Loaded {len(beaches)} beaches")

    try:
        issues = fetch_issues()
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        log(f"Could not read issues: {e}")
        issues = []
    log(f"Found {len(issues)} open beach-data issues")

    # Preserve seed entries that weren't produced from issues.
    seeded_claims, seeded_additions = {}, []
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                prev = json.load(f)
            seeded_claims = {k: v for k, v in (prev.get("claims") or {}).items()
                             if any(a.get("seed") for a in
                                    sum([c.get("agree", []) for c in v.values()], []))}
            seeded_additions = [a for a in (prev.get("additions") or [])
                                if any(r.get("seed") for r in (a.get("reported") or []))]
        except (ValueError, OSError):
            pass

    per_user = defaultdict(int)
    claims = defaultdict(lambda: defaultdict(lambda: {"agree": [], "disagree": [], "notes": []}))
    additions = {}

    for issue in sorted(issues, key=lambda i: i["number"]):
        num = issue["number"]
        labels = {l["name"] for l in issue.get("labels", [])}
        if REJECT_LABEL in labels:
            reject(num, "vetoed by a maintainer")
            continue

        user = (issue.get("user") or {}).get("login")
        if not user:
            reject(num, "no author")
            continue

        fields = parse_issue_body(issue.get("body", ""))
        beach_id = fields.get("beach id") or fields.get("beach_id")
        field = (fields.get("what needs changing") or fields.get("field") or "").strip()
        value = fields.get("correct value") or fields.get("value")
        note = fields.get("anything else") or fields.get("note") or ""
        stance = (fields.get("is this right or wrong") or "agree").strip().lower()

        if not beach_id or beach_id not in by_id:
            reject(num, f"unknown beach id {beach_id!r}")
            continue
        if field not in ALLOWED_FIELDS:
            reject(num, f"field {field!r} isn't editable")
            continue

        per_user[user] += 1
        if per_user[user] > MAX_CLAIMS_PER_USER:
            reject(num, f"{user} exceeded {MAX_CLAIMS_PER_USER} claims this run")
            continue

        try:
            val = coerce(field, value)
        except ValueError as e:
            reject(num, f"{field}: {e}")
            continue

        # A position has to be near the beach it claims to describe.
        if field in ("lat", "lon"):
            parent = by_id[beach_id]
            lat = val if field == "lat" else parent["lat"]
            lon = val if field == "lon" else parent["lon"]
            dist = haversine_km(parent["lat"], parent["lon"], lat, lon)
            if dist > MAX_KM_FROM_PARENT:
                reject(num, f"position {dist:.1f} km from the mapped beach (max {MAX_KM_FROM_PARENT})")
                continue

        when = (issue.get("created_at") or datetime.now(timezone.utc).isoformat())[:10]
        entry = {"by": user, "at": when, "issue": num}
        if TRUSTED_LABEL in labels:
            entry["verified"] = True

        bucket = claims[beach_id][field]
        side = "disagree" if stance.startswith("wrong") else "agree"
        # One account, one vote per field.
        if any(e["by"] == user for e in bucket[side]):
            reject(num, f"{user} already voted on {field} for this beach")
            continue
        bucket[side].append(entry)
        if note:
            bucket["notes"].append(note[:400])
        log(f"  #{num} {user}: {beach_id} {field}={val!r} ({side})")
        bucket["value"] = val

    out_claims = {}
    for beach_id, fields in claims.items():
        kept = {}
        for field, data in fields.items():
            if "value" not in data:
                continue
            # A maintainer-verified report counts double.
            weight = sum(2 if e.get("verified") else 1 for e in data["agree"])
            against = sum(2 if e.get("verified") else 1 for e in data["disagree"])
            if weight - against < 1:
                log(f"  dropped {beach_id}.{field}: {weight} for vs {against} against")
                continue
            kept[field] = {
                "value": data["value"],
                "agree": [{k: v for k, v in e.items() if k != "verified"} | (
                    {"verified": True} if e.get("verified") else {}) for e in data["agree"]],
                "disagree": data["disagree"],
            }
            if data["notes"]:
                kept[field]["note"] = data["notes"][0]
        if kept:
            out_claims[beach_id] = kept

    # Seeds merge in without clobbering anything the issues established.
    for beach_id, fields in seeded_claims.items():
        out_claims.setdefault(beach_id, {})
        for field, claim in fields.items():
            out_claims[beach_id].setdefault(field, claim)

    result = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Generated by scripts/aggregate_community.py from GitHub issues labelled 'beach-data'.",
        "claims": out_claims,
        "additions": seeded_additions + list(additions.values()),
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")

    total = sum(len(v) for v in out_claims.values())
    log(f"\nWrote {OUT_PATH}: {total} claims across {len(out_claims)} beaches, "
        f"{len(result['additions'])} added entries")
    seasonal = sum(1 for fields in out_claims.values() for k in fields if k in SEASONAL_FIELDS)
    log(f"{seasonal} of those are seasonal and expire at the start of each swimming season")
    if rejections:
        log(f"\n{len(rejections)} report(s) rejected:")
        for r in rejections:
            log(f"  #{r['issue']}: {r['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
