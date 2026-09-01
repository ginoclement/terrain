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
     the Alps). Enable the **baseplate** option to join the letters on one
     printable plate.
   - **Rotation**: any selection except circles can be rotated with the
     slider to align with a valley or coastline.
   - **Moving**: with no tool active, drag an existing selection to
     reposition it (the cursor changes to a move cursor over it).
   - **Import**: load a **GeoJSON** polygon (e.g. a country or county
     boundary) as the cutout shape, or a **GPX** track to emboss a hiking
     route as a raised line on the model.
   - **Custom fonts**: upload any TTF/OTF/WOFF file for the letters tool.
   - **Profile tool**: drag a line to see its elevation cross-section (with
     total distance and climb) before committing to a model.
3. **Generate** — pick grid detail, model size, vertical exaggeration, and
   base thickness, then generate. The app fetches elevation data, carves the
   selection, and shows an orbitable 3D preview with model dimensions,
   elevation range, and triangle count.
3. **Sculpt** — optional passes applied before meshing:
   - **Smoothing** — reduces DEM noise/stair-stepping.
   - **Underwater terrain** — choose whether to *include* seafloor/lakebed
     bathymetry (underwater contours, tinted blue in the preview) or
     *flatten* water at a chosen level (sea level, or a lake's surface
     elevation) to a clean flat plane. For real bathymetric detail pick the
     NOAA ETOPO 2022 elevation source; the default AWS tiles carry only
     coarse ETOPO1 depths.
   - **Contour terraces** — quantizes elevation into discrete steps for a
     laser-cut topographic-model look.
   - **Rivers (OSM)** — fetches rivers, streams, and canals from
     OpenStreetMap for the selected area and embosses (raised) or engraves
     (recessed) them into the surface.
   - **Earth curvature** — applies the true spherical drop-off from the
     selection center (noticeable on selections larger than ~100 km).
   - **Base engraving** — engraves the center coordinates and scale ratio
     into the underside, mirrored so it reads correctly when flipped over.
4. **Export** — binary STL (recommended), ASCII STL, 3MF, OBJ, or PLY. Units
   are millimeters; models are watertight solids with a flat base, ready to
   slice. Flat regions (water, terraces, baseplates, the underside) are
   automatically decimated with watertight center-fans, cutting triangle
   counts dramatically. More formats and options:
   - **3MF (color)** — per-triangle elevation-band colors (bathymetric blues
     below sea level, hypsometric tints above) for multi-material printers
     like Bambu/Prusa XL.
   - **GLB (textured)** — binary glTF with Esri satellite imagery draped
     over the terrain, for renders or full-color printing services.
   - **Split into tiles** (up to 4×4) — each tile is a separate watertight
     STL in a ZIP. With **interlocking tabs** on (default), puzzle-style
     tabs key the tiles together in-plane (zero designed clearance — a
     light sanding pass may be needed); switch it off for straight glue
     faces.
   - **Two-piece split at an elevation** — a lower and an upper piece;
     print them in different colors and stack the flat-bottomed upper piece
     on the lower one (e.g. white above the snow line).
5. **Topo map (2D)** — render the selected area as a printable topographic
   map instead of (or alongside) the 3D model. Everything is toggleable:
   contour lines with auto or custom interval and labeled index contours,
   hillshade relief, hypsometric tint, OSM water features, title block,
   scale bar with 1:N ratio, lat/lon graticule, and north arrow + legend.
   Size by paper preset (A4/A3/Letter, portrait/landscape, 150 or 300 DPI)
   or exact pixels; export as SVG (vector — editable, laser-cuttable),
   PNG, or a print-ready PDF.
6. **Batch** — queue several selections (each remembers the settings it was
   queued with) and export them all as one ZIP of STLs.
7. **Share** — the Share link button copies a URL that restores your view,
   selection, and settings.

The app is an installable PWA: the shell and libraries are cached by a
service worker (app updates still land immediately — the shell is
network-first), and recently viewed map/DEM tiles are kept in a bounded
offline cache.

The sidebar and the 3D preview panel are resizable — drag the divider next
to either one; sizes persist across visits.

## Elevation data sources

Switch sources in the sidebar — they all feed the same pipeline:

| Source | Coverage / detail | Key needed |
| --- | --- | --- |
| **AWS Terrain Tiles (Terrarium)** — default | Global composite (USGS 3DEP, SRTM, GMTED2010, ETOPO1), up to zoom 15 (~5 m/px in the US, ~30 m most land) | No |
| **MapTiler Terrain-RGB v2** | Global, up to zoom 12 | Free key from [maptiler.com](https://www.maptiler.com/) |
| **USGS 3DEP ImageServer** | United States only, down to ~1 m | No |
| **NOAA ETOPO 2022** | Global land + real ocean bathymetry (GEBCO-based, ~460 m; finer near US coasts) | No |
| **EMODnet Bathymetry** | European seas, ~115 m seafloor detail (marine only; land reads 0) | No |
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
js/app.js          UI wiring, model pipeline, batch, share links, imports
js/mapview.js      basemaps, hillshade, 3D terrain, route + text overlays
js/selection.js    drawing tools, rotation, profile tool, mask rasterization
js/elevation.js    elevation source registry & fetching/decoding
js/mesh.js         watertight solid construction + decimation (pure, node-testable)
js/heightops.js    smoothing/water/contours/tiles/interlocks/splits (pure)
js/exporters.js    STL/OBJ/PLY/3MF/color-3MF/GLB/PDF writers (pure, node-testable)
js/topomap.js      2D topo map renderer: contours, rasters, furniture, SVG
js/colors.js       shared elevation color ramps
sw.js              service worker (offline shell + tile cache)
tests/             geometry, grid-ops, and exporter checks
```

Run the tests with:

```bash
for t in tests/test-*.mjs; do node "$t"; done
```

They verify the generated meshes are watertight (every edge shared by exactly
two consistently wound triangles), enclose positive volume across tricky masks
(donuts, diagonal pinch points), and that each export format is structurally
valid.

## Hosting

The included GitHub Actions workflow (`.github/workflows/pages.yml`) deploys
the site to GitHub Pages on every push to `main`. One-time setup: in the
repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
Any other static host (Cloudflare Pages, Netlify, S3, nginx) also works —
there is no build step; just serve the repo root.

If the site gets significant public traffic, switch the default basemap to a
keyed provider — the public OSM/OpenTopoMap tile servers are for light use —
and restrict any MapTiler key to your domain in the MapTiler dashboard.

## Data attribution

Map data © OpenStreetMap contributors; OpenTopoMap (CC-BY-SA); imagery ©
Esri; USGS The National Map; © CARTO. Terrain tiles from the Mapzen/AWS Open
Data Terrain Tiles program (3DEP, SRTM, GMTED2010, ETOPO1); MapTiler
elevation © MapTiler; Copernicus GLO-90 DEM via Open-Meteo; bathymetry ©
EMODnet Bathymetry Consortium and reproduced from the GEBCO Grid; waterway
data © OpenStreetMap contributors via the Overpass API. Geocoding by
Nominatim/OpenStreetMap. Please respect each provider's usage policies.
