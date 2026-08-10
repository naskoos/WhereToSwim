# Where To Swim

A small local webapp that suggests nearby beaches with calmer water, based on
live wind/wave conditions, plus toddler-friendliness, beach bar availability
and typical crowd level. Works anywhere in Greece, not just the pre-curated
Chalkidiki beaches.

## How it works

- You share a location (GPS "Use my location", or search any place name).
- The app combines two beach sources within your chosen radius:
  - **Curated** (`beaches.json`): hand-verified Chalkidiki beaches with real
    toddler-friendliness/bar/crowd notes and an authored "facing direction" +
    "shelter arc" used to judge whether a beach is exposed to or sheltered
    from the live wind direction.
  - **OpenStreetMap** (via the free [Overpass API](https://overpass-api.de/)):
    any other mapped beach in range, anywhere in Greece. Beach-bar presence
    is inferred from real nearby bars/cafes/restaurants/toilets; toddler-
    friendliness comes from OSM's `surface` tag when present, else shown as
    "unknown - verify locally" (same for crowd level, which OSM has no
    signal for at all). These are dedup'd against the curated list and
    badged "🗺️ Community-mapped (OSM)" so it's clear which is which.
- For every candidate it fetches **live** wind (and where available, wave
  height) from [Open-Meteo](https://open-meteo.com/) (free, no API key
  required) and scores/ranks by calmness, distance, and your filters.

This is a heuristic, not a survey — the curated beach orientations/bar/crowd
info are hand-verified against Wikipedia/Wikidata but still worth a sanity
check, and OSM-sourced fields are explicitly unverified. Edit `beaches.json`
any time to correct details or add more curated beaches (it's a plain JSON
list, one object per beach).

## Running it

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Then open `http://localhost:5000` in your browser (or `http://<your-laptop-ip>:5000`
from your phone, if it's on the same wifi).

## Notes

- Wave data comes from Open-Meteo's Marine API, which uses a coarse-ish
  ocean model — small, enclosed bays sometimes don't have wave data. When
  that happens the app falls back to a wind-based estimate instead, and
  says so in the "why" list on each card.
- "Beach bar", "toddler-friendly" and "crowd level" are curated fields —
  they're a good starting point but worth a quick sanity check, especially
  crowd levels, which can change with the season/day of the week.
