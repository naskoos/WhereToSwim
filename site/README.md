# Where To Swim (static/live version)

A phone-friendly, no-install beach picker for Chalkidiki. Pure static
HTML/CSS/JS &mdash; all live wind/wave/place lookups happen directly from your
browser to [Open-Meteo](https://open-meteo.com/) (free, no key). No backend,
no build step, so it can be hosted anywhere that serves static files
(GitHub raw CDN, GitHub Pages, Netlify, etc.).

This repo is public so it can be served for free via a raw-GitHub CDN
without any account/login. It's a generated mirror of the primary
(private) development repo — edit `beaches.json` here to tweak beach data
for the live site.

Open `index.html` in any browser, tap "Use my location" (or search a
place), pick your filters, and hit "Find calm beaches".
