#!/usr/bin/env node
/*
 * Builds docs/index.html: a single self-contained page.
 *
 *   src/template.html   the page (HTML, CSS and JS)
 *   data/*.json         ports, routes, regions and sea/country labels
 *   Natural Earth       coastline geometry, downloaded once into .cache/
 *
 * Usage:
 *   node scripts/build.js           build the site
 *   node scripts/build.js --check   validate the data only (exit code 1 on problems)
 */
const fs = require("fs");
const path = require("path");
const { geoMercator, geoPath, geoGraticule, geoContains, geoBounds } = require("d3-geo");

const ROOT = path.join(__dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");
const NE_FILE = path.join(ROOT, ".cache", "ne_10m_admin_0_map_units.geojson");
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_map_units.geojson";
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));

async function ensureGeometry() {
  if (fs.existsSync(NE_FILE)) return;
  console.log("Downloading Natural Earth map units (about 13 MB, once)...");
  const res = await fetch(NE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  fs.mkdirSync(path.dirname(NE_FILE), { recursive: true });
  fs.writeFileSync(NE_FILE, Buffer.from(await res.arrayBuffer()));
}

// ---------- projection: one world canvas, Web Mercator ----------
const W = 2400, H = 2620, CX = W / 2, CY = 1420, SCALE = 3900, CENTRE = [-2, 50];
const makeProj = () => geoMercator().center(CENTRE).scale(SCALE).translate([CX, CY]);
const proj = makeProj();
const project = (lon, lat) => proj([lon, lat]);
const inv = makeProj();
const clipped = makeProj();
clipped.clipExtent([[-40, -40], [W + 40, H + 40]]);
const path2d = geoPath(clipped).digits(1);

// ---------- simplify projected coastlines (Douglas-Peucker) ----------
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (len2 === 0) d = Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      else { const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2)); d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy)); }
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyPath(d, tol) {
  return d.split("M").filter(Boolean).map((sp) => {
    const closed = /Z\s*$/.test(sp);
    const nums = sp.replace(/Z\s*$/, "").split("L").map((q) => q.split(",").map(Number));
    if (nums.length < 5) return "M" + nums.map((p) => p.join(",")).join("L") + (closed ? "Z" : "");
    const out = dp(nums, tol);
    if (out.length < 4 && nums.length >= 8) return "";
    return "M" + out.map((p) => p[0] + "," + p[1]).join("L") + (closed ? "Z" : "");
  }).join("");
}

const HOME_NATIONS = ["England", "Scotland", "Wales", "Northern Ireland"];
const landKey = (p) => {
  const g = p.GEOUNIT, a = p.ADMIN;
  if (g === "England") return "england";
  if (g === "Scotland") return "scotland";
  if (g === "Wales") return "wales";
  if (g === "Northern Ireland") return "northern-ireland";
  if (g === "Isle of Man") return "isle-of-man";
  if (g === "Jersey") return "jersey";
  if (g === "Guernsey") return "guernsey";
  return { Ireland: "ireland", France: "france", Spain: "spain", Netherlands: "netherlands", Belgium: "belgium", Germany: "germany", Portugal: "portugal" }[a] || "other";
};

// ---------- geometry helpers ----------
const RAD = Math.PI / 180;
const haversineNm = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(s));
};
function catmullPath(pts) {
  const f = (n) => n.toFixed(1);
  if (pts.length === 2) return `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [c1, c2] = controls(pts, i);
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(pts[i + 1][0])} ${f(pts[i + 1][1])}`;
  }
  return d;
}
function controls(pts, i) {
  const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
  return [[p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]];
}
const bezier = (p0, c1, c2, p1, t) => {
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]];
};

async function main() {
  await ensureGeometry();
  const problems = [];

  // ---------- land ----------
  const gj = JSON.parse(fs.readFileSync(NE_FILE, "utf8"));
  const BBOX = [-22, 38, 18, 64];
  const land = [], landFeatures = [];
  for (const f of gj.features) {
    const [[w, s], [e, n]] = geoBounds(f);
    if (e < BBOX[0] || w > BBOX[2] || n < BBOX[1] || s > BBOX[3]) continue;
    let d = path2d(f);
    if (!d) continue;
    d = simplifyPath(d, 0.3);
    if (!d) continue;
    land.push({ key: landKey(f.properties), name: f.properties.GEOUNIT, d });
    landFeatures.push(f);
  }

  // ---------- ports ----------
  const portsIn = readJSON("ports.json");
  const ids = new Set();
  const ports = portsIn.map((p) => {
    if (ids.has(p.id)) problems.push(`Duplicate port id: ${p.id}`);
    ids.add(p.id);
    const [x, y] = project(p.lon, p.lat);
    return { ...p, isle: p.isle || null, x: +x.toFixed(1), y: +y.toFixed(1), home: HOME_NATIONS.includes(p.country) };
  });
  const portById = Object.fromEntries(ports.map((p) => [p.id, p]));

  // Terminals that sit a little off the coast are snapped onto it (up to 5 km).
  const rings = [];
  for (const f of landFeatures) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  }
  const segNearest = (p, a, b) => {
    const kx = Math.cos(p[1] * RAD) * 111.32, ky = 110.57;
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(ax + t * dx, ay + t * dy), pt: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
  };
  const notes = [];
  for (const p of ports) {
    let best = 1e9, bestPt = null;
    for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      if (Math.min(a[0], b[0]) - p.lon > 0.4 || p.lon - Math.max(a[0], b[0]) > 0.4 || Math.min(a[1], b[1]) - p.lat > 0.4 || p.lat - Math.max(a[1], b[1]) > 0.4) continue;
      const r = segNearest([p.lon, p.lat], a, b);
      if (r.d < best) { best = r.d; bestPt = r.pt; }
    }
    if (best > 1.2 && best <= 5 && bestPt) {
      p.lon = +bestPt[0].toFixed(4); p.lat = +bestPt[1].toFixed(4);
      const q = project(p.lon, p.lat); p.x = +q[0].toFixed(1); p.y = +q[1].toFixed(1);
      notes.push(`${p.id} snapped ${best.toFixed(1)} km to the coast`);
    } else if (best > 5) problems.push(`Port ${p.id} is ${best.toFixed(1)} km from any coast; check its coordinates`);
  }

  // ---------- routes ----------
  const routesIn = readJSON("routes.json");
  const routeIds = new Set();
  const routes = routesIn.map((r) => {
    if (routeIds.has(r.id)) problems.push(`Duplicate route id: ${r.id}`);
    routeIds.add(r.id);
    const a = portById[r.from], b = portById[r.to];
    if (!a || !b) { problems.push(`Route ${r.id} refers to a missing port (${r.from} / ${r.to})`); return null; }
    const ll = [[a.lon, a.lat], ...(r.via || []), [b.lon, b.lat]];
    const pts = ll.map(([lon, lat]) => project(lon, lat));
    let nm = 0;
    for (let i = 0; i < ll.length - 1; i++) nm += haversineNm(ll[i], ll[i + 1]);
    // sample the drawn curve and make sure it stays over water
    const samples = [];
    if (pts.length === 2) for (let i = 0; i <= 40; i++) samples.push([pts[0][0] + (pts[1][0] - pts[0][0]) * i / 40, pts[0][1] + (pts[1][1] - pts[0][1]) * i / 40]);
    else for (let i = 0; i < pts.length - 1; i++) { const [c1, c2] = controls(pts, i); for (let t = 0; t <= 1; t += 0.04) samples.push(bezier(pts[i], c1, c2, pts[i + 1], t)); }
    const bad = [];
    for (const s of samples) {
      if (Math.hypot(s[0] - pts[0][0], s[1] - pts[0][1]) < 9 || Math.hypot(s[0] - pts[pts.length - 1][0], s[1] - pts[pts.length - 1][1]) < 9) continue;
      const g = inv.invert(s);
      for (const f of landFeatures) {
        const [[w, so], [e, n]] = geoBounds(f);
        if (g[0] < w || g[0] > e || g[1] < so || g[1] > n) continue;
        if (geoContains(f, g)) { bad.push(`${g[0].toFixed(2)},${g[1].toFixed(2)}`); break; }
      }
    }
    if (bad.length) problems.push(`Route ${r.id} crosses land near ${[...new Set(bad)].slice(0, 4).join(" | ")}; add or move a "via" waypoint`);
    return { ...r, via: undefined, d: catmullPath(pts), nm: Math.round(nm) };
  }).filter(Boolean);

  // ---------- regions, labels, graticule ----------
  const box = ([lon0, lat0, lon1, lat1]) => {
    const a = project(lon0, lat1), b = project(lon1, lat0);
    return [a[0], a[1], b[0], b[1]].map((n) => +n.toFixed(1));
  };
  const regions = readJSON("regions.json").map((r) => ({ id: r.id, name: r.name, bbox: box(r.box) }));
  const zones = readJSON("zones.json").map((z) => { const [x, y] = project(z.lon, z.lat); return { ...z, x: +x.toFixed(1), y: +y.toFixed(1) }; });
  const graticule = geoPath(clipped).digits(1)(geoGraticule().extent([[-24, 36], [20, 66]]).step([2, 2])());

  console.log(`${land.length} land shapes, ${ports.length} ports, ${routes.length} routes`);
  notes.forEach((n) => console.log("  note:", n));
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    problems.forEach((p) => console.error("  -", p));
    if (CHECK_ONLY) process.exit(1);
  } else console.log("Data check passed: every route stays over water.");
  if (CHECK_ONLY) return;

  // ---------- write the page ----------
  const template = fs.readFileSync(path.join(ROOT, "src", "template.html"), "utf8");
  const data = { W, H, land, ports, routes, regions, zones, graticule };
  const html = template.replace("__DATA__", () => JSON.stringify(data));
  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "index.html"), html);
  fs.writeFileSync(path.join(ROOT, "docs", ".nojekyll"), "");
  console.log(`Wrote docs/index.html (${(html.length / 1024).toFixed(0)} KB)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
