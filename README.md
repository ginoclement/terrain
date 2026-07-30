# Terrain → STL Generator

A fully client-side web app that turns any place on Earth into a 3D-printable
terrain model. Pick a spot on a map (in 2D or tilted 3D terrain view), cut it
out with a shape — rectangle, square, circle, hexagon, freeform polygon, or
even letters — preview the solid in 3D, and export it as STL, 3MF, OBJ, or PLY.

No build step, no server, no accounts: it's a static page. Serve the folder
with any web server and open it:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` won't work because the app uses ES
modules and fetches map data — any static server is fine.)

## Workflow

1. **Find your area** — search for a place, or pan/zoom. Switch basemaps
   (OpenStreetMap, OpenTopoMap with contours, Esri satellite imagery, USGS
   Topo, Carto Light) at any time; they're all aligned Web-Mercator layers, so
   your selection stays put. Toggle the **hillshade overlay** to see relief on
   any basemap, or hit **3D view** to tilt into a live 3D terrain rendering —
   you can draw selections directly on the 3D terrain too.
2. **Select a cutout** — choose a tool and draw:
   - **Rectangle / Square**: drag a box (square is constrained to equal sides).
   - **Circle / Hexagon**: drag from the center outward.
   - **Polygon**: click to add vertices; click the first vertex (or
     double-click) to close. `Esc` cancels.
   - **Letters**: type text, pick a font, then drag a box on the map — the
     terrain is cut into the letter shapes (great for gifts: "ALPS" cut from
     the Alps). Each letter is its own solid with a flat base.
3. **Generate** — pick grid detail, model size, vertical exaggeration, and
   base thickness, then generate. The app fetches elevation data, carves the
   selection, and shows an orbitable 3D preview with model dimensions,
   elevation range, and triangle count.
4. **Export** — binary STL (recommended), ASCII STL, 3MF, OBJ, or PLY. Units
   are millimeters; models are watertight solids with a flat base, ready to
   slice.

## Elevation data sources

Switch sources in the sidebar — they all feed the same pipeline:

| Source | Coverage / detail | Key needed |
| --- | --- | --- |
| **AWS Terrain Tiles (Terrarium)** — default | Global composite (USGS 3DEP, SRTM, GMTED2010, ETOPO1), up to zoom 15 (~5 m/px in the US, ~30 m most land) | No |
| **MapTiler Terrain-RGB v2** | Global, up to zoom 12 | Free key from [maptiler.com](https://www.maptiler.com/) |
| **Open-Meteo elevation API** | Copernicus GLO-90 DEM (~90 m), point queries | No (use grid detail ≤ 128) |

The map's 3D terrain and hillshade are driven by the same AWS Terrarium DEM
as the default export source, so what you see is what you print.

## Model details

- The selection is sampled on a regular grid (up to 512 samples on the longest
  side), masked by the chosen shape, and extruded into a **watertight,
  consistently wound solid**: terrain top, vertical walls along the shape
  boundary (including interior holes, e.g. letter counters), and a flat base.
- At vertical exaggeration 1.0 the height is true to scale relative to the
  horizontal footprint; 1.5–2 usually looks better for prints of large areas.
- Elevations are normalized so the lowest point of the selection sits on top
  of the base plate.

## Development

Pure ES modules, no dependencies to install. Libraries (MapLibre GL JS,
three.js, fflate) load from CDN.

```
index.html         page layout & CDN imports
css/style.css      styling
js/app.js          UI wiring, generate/export pipeline
js/mapview.js      basemaps, hillshade, 3D terrain, text overlay
js/selection.js    drawing tools + mask rasterization
js/elevation.js    elevation source registry & fetching/decoding
js/mesh.js         watertight solid construction (pure, node-testable)
js/exporters.js    STL/OBJ/PLY/3MF writers (pure, node-testable)
tests/test-mesh.mjs  geometry & exporter checks
```

Run the tests with:

```bash
node tests/test-mesh.mjs
```

They verify the generated meshes are watertight (every edge shared by exactly
two consistently wound triangles), enclose positive volume across tricky masks
(donuts, diagonal pinch points), and that each export format is structurally
valid.

## Data attribution

Map data © OpenStreetMap contributors; OpenTopoMap (CC-BY-SA); imagery ©
Esri; USGS The National Map; © CARTO. Terrain tiles from the Mapzen/AWS Open
Data Terrain Tiles program (3DEP, SRTM, GMTED2010, ETOPO1); MapTiler
elevation © MapTiler; Copernicus GLO-90 DEM via Open-Meteo. Geocoding by
Nominatim/OpenStreetMap. Please respect each provider's usage policies.
