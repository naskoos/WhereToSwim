# Where To Swim

A small local webapp that suggests nearby beaches with calmer water, based on
live wind/wave conditions, plus toddler-friendliness, beach bar availability
and typical crowd level.

## How it works

- You share a location (GPS "Use my location", or search any place name).
- The app pulls the curated beach list from `beaches.json`, keeps the ones
  within your chosen radius, and fetches **live** wind (and where available,
  wave height) for each beach from [Open-Meteo](https://open-meteo.com/)
  (free, no API key required).
- Each beach has a stored "facing direction" (which way it opens to the sea)
  and a "shelter arc". The app compares that to the live wind direction to
  estimate whether the beach is exposed or sheltered right now, and combines
  that with wave height, distance, crowd level, and your toddler/beach-bar
  requirements into a ranked list.

This is a heuristic, not a survey — the beach orientations, bar/crowd info
etc. are curated from general knowledge and approximate coordinates. Edit
`beaches.json` any time to correct details or add more beaches (it's a plain
JSON list, one object per beach).

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
