# Where To Swim (static/live version)

A phone-friendly, no-install beach picker. Works anywhere in Greece (or
beyond), not just the pre-curated Chalkidiki beaches. Pure static
HTML/CSS/JS &mdash; all live wind/wave/place/beach lookups happen directly
from your browser to [Open-Meteo](https://open-meteo.com/) (free, no key)
and the [Overpass API](https://overpass-api.de/) (OpenStreetMap, free, no
key). No backend, no build step, so it can be hosted anywhere that serves
static files (GitHub raw CDN, GitHub Pages, Netlify, etc.).

This repo is public so it can be served for free via a raw-GitHub CDN
without any account/login. It's a generated mirror of the primary
(private) development repo — edit `beaches.json` here to tweak the
curated beach data for the live site.

## Two data sources, merged

- **Curated** (`beaches.json`): a hand-verified list of Chalkidiki beaches
  with real toddler-friendliness, beach-bar, and crowd-level notes.
- **Community-mapped (OpenStreetMap)**: for any other beach in range, the
  app queries Overpass for `natural=beach`/`leisure=beach_resort` points
  and checks for nearby bars/cafes/restaurants/toilets to infer a beach
  bar. Toddler-friendliness comes from OSM's `surface` tag when present
  (sand vs pebble/rock); otherwise it's shown as "unknown - verify
  locally", same for crowd level, which OSM doesn't track at all. These
  results are dedup'd against the curated list and clearly badged
  "🗺️ Community-mapped (OSM)" so you know which claims are verified vs not.

Open `index.html` in any browser, tap "Use my location" (or search any
place in Greece), pick your filters, and hit "Find calm beaches".
