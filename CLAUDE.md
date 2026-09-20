# CLAUDE.md

Interactive map of ferry routes to and from the UK. The output is one static file, `docs/index.html`, hosted on GitHub Pages. There is no server and no runtime dependency.

## Commands

```sh
npm install
npm run build    # writes docs/index.html
npm run check    # validates data/*.json, writes nothing, exits 1 on problems
```

Node 18 or newer. The first build downloads the Natural Earth coastline (about 13 MB) into `.cache/`, which is git-ignored.

## Layout

```
src/template.html    the whole front end: HTML, CSS and JS in one file
data/ports.json      ports (lon/lat, label hints)
data/routes.json     routes (operators, times, notes, waypoints)
data/regions.json    zoom targets for the jump buttons, as [lon0, lat0, lon1, lat1]
data/zones.json      country and sea names drawn on the map
scripts/build.js     projects the map, validates the data, injects it into the template
docs/index.html      BUILT OUTPUT, committed so GitHub Pages works with no build step
```

## Rules that matter

- **Never edit `docs/index.html` by hand.** Change `src/template.html` or `data/*.json`, run `npm run build`, and commit the rebuilt file. CI fails if `docs/index.html` is out of date.
- **Run `npm run check` after any change to `data/`.** It fails when a route crosses land, a port is missing, or an id is duplicated. Fix a land crossing by adding or moving a `via` waypoint, not by loosening the check.
- The build is deterministic. Do not add timestamps or random values to the output.
- `template.html` contains the literal `__DATA__`, which the build replaces with one JSON blob. Keep it exactly once.

## Data conventions

- **Ports:** `id` is a unique slug. `country` decides the marker: England, Scotland, Wales and Northern Ireland are UK ports and get a diamond, everything else gets a circle. `rank` is label priority (1 highest). `side` is the preferred label side (`l`, `r`, `t`, `b`). `isle` is optional and replaces the country in the detail card. The build snaps any terminal up to 5 km off the coast onto the coastline.
- **Routes:** `from` is always the UK port and `to` is the other end. Every route is treated as running both ways. `nation` is the UK nation of the `from` port. `dest` is one of: France, Spain, Netherlands, Ireland, Northern Ireland, Isle of Man, Channel Islands, Within the UK. `min` is the typical crossing in minutes (used for sorting and the slider); use `null` when unknown and write `Check timetable` in `dur`. `via` is `[lon, lat]` waypoints, drawn as a smooth curve.
- **Operators:** a route with more than one operator is coloured as "Several operators". Colours live in `OP_COLORS` in `template.html`. Operators without a colour share a grey and appear as "Other island operators".
- **Scope:** passenger ferries with at least one UK port. Left out on purpose: freight-only routes, river hops under about 3 km, most small inter-island links, and Crown Dependency links that skip the UK. There are no regular UK passenger ferries to anywhere outside Europe.

## Accuracy

- Do not invent crossing times, operators or seasons. Check operator or timetable sites, and if a figure is not confirmed, use `min: null` and say so in `dur` or `notes`.
- Timetables change. When you verify or update routes, update the "Details checked in ..." date in the scope note in `template.html`.
- The animated vessels are illustrative, not live positions. Keep the wording in the legend that says so.

## Front end notes (`src/template.html`)

- The world is a fixed 2400 by 2620 canvas in Web Mercator (scale 3900, centred on lon -2, lat 50). Map coordinates in the JS are world units. Zoom is `view = {k, tx, ty}` with screen = world * k + t.
- Land, routes and zone labels live inside the `#vp` group, which is scaled. Ports and vessels live in `#ov`, positioned in screen space so they stay a constant size.
- Strokes use `vector-effect: non-scaling-stroke` so line widths stay constant when zooming.
- All UI state is in the `state` object. `update()` is the single place that turns state into DOM: it recomputes the visible routes, restyles routes and ports, then re-renders the KPIs, list, legend and detail card. Change state, then call `update()`.
- Port labels use greedy placement (`layoutLabels`) so names never overlap. Rank and selection decide priority.
- Performance: the soft coastline glow is hidden while panning (`.map.moving`), and vessels are only animated for routes that are on screen. Wide strokes on the coastline are the expensive part, so avoid adding more.
- Deep links: `#route=<id>` and `#port=<id>` are read on load and written with `history.replaceState`.
- Colours are CSS variables with light and dark sets. Add a token to all three places (the light default, the `prefers-color-scheme: dark` block, and `[data-theme="dark"]`).
- Respect `prefers-reduced-motion`. Keep visible focus styles and keyboard access to ports and routes.

## Style

- British English. Sentence case for UI text. Plain, specific wording; describe what something does, not how it is built.
- Keep it dependency-free at runtime. The only build dependency is `d3-geo`.
