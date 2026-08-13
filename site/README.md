# Where To Swim — Greece

A phone-friendly app for finding a calm, safe place to swim anywhere in
Greece. No install, no account, no backend: it's plain HTML/CSS/JS, and every
live lookup goes straight from your browser to a free open API.

## What it tells you

For every beach in range it pulls the things that actually decide whether a
swim is a good idea:

| | |
|---|---|
| **Waves** | Live wave height from the marine model, adjusted for whether the beach faces into today's wind |
| **Wind** | Beaufort force, speed, direction and gusts |
| **Sea temperature** | With a plain-language read ("bracing", "pleasant", "bath-warm") |
| **Sea temperature trend** | A chart of the past week plus the next three days, so you can see whether the water is warming, cooling, or has just been flushed cold by a meltemi |
| **UV index** | With shade/sunscreen advice — it gets extreme here in summer |
| **Calmest window today** | An hourly wind timeline, so you can dodge the afternoon meltemi |
| **Daylight left** | Time until sunset, for an evening swim |
| **Driving distance** | Real road distance and time, not crow-flies — around the Chalkidiki peninsulas a beach 20 km across the water is a 40-minute drive around the bay |

Each result leads with a one-line verdict — *"Very calm water · gentle sandy
entry"*, *"Too windy right now — Bft 6 strong breeze"* — rather than making you
read numbers and work it out yourself.

## Who's swimming

The wave and wind limits that count as "calm" depend entirely on who's getting
in, so that's the main control rather than a pair of raw numbers:

- **Toddler** (1–4) — ≤0.3 m waves, ≤Bft 3, prefers shallow sandy entry and nearby toilets
- **Kids** (5–12) — ≤0.5 m, ≤Bft 4
- **Anyone** — ≤1.0 m, ≤Bft 5
- **Strong** swimmers — ≤2.0 m, ≤Bft 7

You can still fine-tune the exact thresholds if you want them.

## Other things it does

- **Search 2,600+ beaches by name**, in Greek or Latin script — typing
  `kalami` finds `Παραλία Καλάμι`.
- **Transliterates Greek names**, so you can read a name off the app and match
  it to a road sign.
- **Save beaches** you like; they rank slightly higher and can be filtered to.
- **Filter and sort** by calm, kid-friendly, amenities, warm sea, or saved.
- **Works offline** once loaded (installable as a home-screen app) — the beach
  list is cached, though live conditions obviously need a connection.
- **Share a beach** as a link that opens straight to that spot.
- **Light and dark themes**, following your phone or toggled manually.

## Corrections from people who've been there

Most beaches come from OpenStreetMap, so facilities are often missing — and
facilities don't stay true anyway. Beach bars in Greece open and close between
summers, so "there was a bar here last August" is a claim about last August.

So the app separates two kinds of fact:

- **Durable** — where a beach is, which way it faces, whether the shore is sand
  or shingle. Report it once and it stands.
- **Seasonal** — bars, toilets, how busy it gets. These are dated, and they
  **expire when a new swimming season starts**. Until somebody confirms them
  again the app treats the field as unknown rather than as fact, and says so.

Tap **"Something wrong or out of date? Report it"** on any beach. It opens a
pre-filled form; submitting it needs a GitHub account, which is what makes
attribution and abuse handling work without this app running a server or
holding anyone's data.

A bot (`scripts/aggregate_community.py`) rebuilds `community.json` from those
reports on every submission and nightly. It applies a field only when
agreements outnumber disagreements, records who said what and when, caps how
much one account can change in a single run, checks values against the field's
type, rejects positions outside Greece or more than 8 km from the beach they
describe, and refuses links in free text. A maintainer can label a report
`verified` to make it count double, or `rejected` to veto it. Everything
rejected is listed in the job log with a reason, so a good report that trips a
check can be spotted rather than silently dropped.

`beaches.json` is never modified by this; the community layer is an overlay
applied at load time, so the two can always be compared.

**Current limitation:** reports can correct existing fields, but new beach
entries (like splitting a long beach into its distinct ends) still have to be
added by a maintainer.

## Where the data comes from

- **Conditions** — [Open-Meteo](https://open-meteo.com/): forecast API for
  wind/UV/air temperature, marine API for waves and sea temperature. Free, no
  key, no tracking.
- **Beaches** — [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors (ODbL). 2,680 beaches covering the mainland and the islands.
  61 of them are hand-verified with real shelter, crowd and amenity notes and
  are badged **Hand-checked**; the rest come from OSM tags and are marked
  `OSM`.
- **Place search** — Open-Meteo's geocoder.
- **Driving distances** — the public [OSRM](https://project-osrm.org/) demo
  server, one matrix request per search. It's a free service run on goodwill,
  so if it's unavailable the app falls back to straight-line distance and
  labels it plainly as such rather than passing it off as a drive.

## Honest limits

- Wave data comes from a coarse ocean model. Small enclosed bays often have no
  wave figure at all, and the app falls back to a wind-based estimate and says
  so. The same coarseness applies to sea temperature: the trend chart shows a
  regional model value, not a thermometer in that particular cove.
- "Sheltered from today's wind" is only known for the 61 hand-checked beaches,
  which have an authored facing direction and shelter arc. Everywhere else the
  app says shelter is unknown rather than guessing.
- Crowd levels are only recorded for hand-checked beaches.
- Beach names sourced from research are medium/high-confidence matches, not
  verified in person.
- **None of this replaces looking at the water.** It's a forecast model, not a
  lifeguard.

## Running it locally

The site is static — anything that serves files will do:

```bash
cd site && python3 -m http.server 8000
```

Or run the Flask app from the repo root, which serves this same UI plus a
small JSON API (`/api/recommend`, `/api/geocode`):

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py
```
