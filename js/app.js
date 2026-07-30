import { createMap, setBasemap, setHillshade, set3DTerrain, setRoute, BASEMAPS } from './mapview.js';
import { SelectionManager, bboxDimensionsMeters, rasterizeRouteMask } from './selection.js';
import { ELEVATION_SOURCES, fetchElevationGrid } from './elevation.js';
import { buildTerrainSolid, elevationsToModelZ, meshVolume } from './mesh.js';
import { smoothGrid, flattenWater, quantizeContours, embossRoute, tileRanges, extractSubgrid, splitAtHeight } from './heightops.js';
import { toBinarySTL, toAsciiSTL, toOBJ, toPLY, to3MFFiles } from './exporters.js';
import { TerrainPreview } from './preview3d.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Status bar

let statusTimer = null;
function status(msg, kind = 'info', sticky = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
  clearTimeout(statusTimer);
  if (!sticky && kind !== 'busy') {
    statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 6000);
  }
}

// ---------------------------------------------------------------------------
// Map + selection

const map = createMap('map');
let terrain3D = false;
let route = null; // { name, points: [[lon,lat],...] }

const selMgr = new SelectionManager(map, {
  onSelectionChange(sel) {
    const info = $('selection-info');
    const slider = $('rotation');
    if (!sel) {
      info.textContent = 'No selection yet — pick a tool and draw on the map.';
      $('btn-generate').disabled = true;
      slider.disabled = true;
      slider.value = 0;
      $('rotation-value').textContent = '0°';
      return;
    }
    const { width, height } = bboxDimensionsMeters(sel.bbox);
    const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
    const label = { rect: 'Rectangle', square: 'Square', circle: 'Circle', hex: 'Hexagon', polygon: 'Polygon', text: `Text “${sel.text}”` }[sel.shape] || sel.shape;
    info.textContent = `${label}: ${fmt(width)} × ${fmt(height)}`;
    $('btn-generate').disabled = false;
    slider.disabled = sel.shape === 'circle';
    slider.value = sel.rotationDeg || 0;
    $('rotation-value').textContent = `${sel.rotationDeg || 0}°`;
  },
  onToolChange(tool) {
    document.querySelectorAll('.tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    $('polygon-hint').style.display = tool === 'polygon' ? 'block' : 'none';
  },
});

// Tool buttons
document.querySelectorAll('.tool-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    selMgr.setTool(selMgr.tool === tool ? null : tool);
  });
});
$('btn-clear').addEventListener('click', () => selMgr.clear());

$('rotation').addEventListener('input', (ev) => {
  const deg = parseInt(ev.target.value, 10) || 0;
  $('rotation-value').textContent = `${deg}°`;
  selMgr.setRotation(deg);
});

// Text options
function syncTextOptions() {
  selMgr.setTextOptions({
    text: $('text-input').value || 'A',
    font: $('font-select').value,
  });
}
$('text-input').addEventListener('input', syncTextOptions);
$('font-select').addEventListener('change', syncTextOptions);
syncTextOptions();

// ---------------------------------------------------------------------------
// GPX / GeoJSON import

function setRouteState(newRoute) {
  route = newRoute;
  map.getSource('route') && setRoute(map, route ? route.points : []);
  $('route-row').style.display = route ? 'flex' : 'none';
  $('route-emboss-row').style.display = route ? 'flex' : 'none';
  if (route) $('route-info').textContent = `Route “${route.name}” (${route.points.length} pts)`;
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let k = 0; k < maxPoints; k++) out.push(points[Math.floor(k * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function parseGPX(xmlText, name) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  let nodes = [...doc.querySelectorAll('trkpt')];
  if (!nodes.length) nodes = [...doc.querySelectorAll('rtept')];
  if (!nodes.length) nodes = [...doc.querySelectorAll('wpt')];
  const points = nodes
    .map((n) => [parseFloat(n.getAttribute('lon')), parseFloat(n.getAttribute('lat'))])
    .filter((p) => isFinite(p[0]) && isFinite(p[1]));
  if (points.length < 2) throw new Error('No track points found in GPX file');
  return { name: doc.querySelector('trk > name, name')?.textContent || name, points: downsample(points, 3000) };
}

function largestOuterRing(geojson) {
  let best = null;
  let bestLen = 0;
  const consider = (ring) => {
    if (ring && ring.length > bestLen) { best = ring; bestLen = ring.length; }
  };
  const walkGeom = (g) => {
    if (!g) return;
    if (g.type === 'Polygon') consider(g.coordinates[0]);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => consider(poly[0]));
    else if (g.type === 'GeometryCollection') g.geometries.forEach(walkGeom);
  };
  if (geojson.type === 'FeatureCollection') geojson.features.forEach((f) => walkGeom(f.geometry));
  else if (geojson.type === 'Feature') walkGeom(geojson.geometry);
  else walkGeom(geojson);
  return best;
}

function firstLineString(geojson) {
  let line = null;
  const walkGeom = (g) => {
    if (!g || line) return;
    if (g.type === 'LineString') line = g.coordinates;
    else if (g.type === 'MultiLineString') line = g.coordinates.flat();
    else if (g.type === 'GeometryCollection') g.geometries.forEach(walkGeom);
  };
  if (geojson.type === 'FeatureCollection') geojson.features.forEach((f) => walkGeom(f.geometry));
  else if (geojson.type === 'Feature') walkGeom(geojson.geometry);
  else walkGeom(geojson);
  return line;
}

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    if (/\.gpx$/i.test(file.name) || text.includes('<gpx')) {
      const parsed = parseGPX(text, file.name.replace(/\.gpx$/i, ''));
      setRouteState(parsed);
      const bbox = [
        Math.min(...parsed.points.map((p) => p[0])), Math.min(...parsed.points.map((p) => p[1])),
        Math.max(...parsed.points.map((p) => p[0])), Math.max(...parsed.points.map((p) => p[1])),
      ];
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 1000 });
      status(`Route loaded (${parsed.points.length} points). Draw a selection around it, or it will be embossed wherever it crosses your cutout.`, 'info');
    } else {
      const geojson = JSON.parse(text);
      const ring = largestOuterRing(geojson);
      if (ring) {
        const points = downsample(ring.map((c) => [c[0], c[1]]), 800);
        selMgr.setPolygonSelection(points);
        const b = selMgr.selection.bbox;
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, duration: 1000 });
        status('GeoJSON polygon imported as the cutout shape.', 'info');
      } else {
        const line = firstLineString(geojson);
        if (!line) throw new Error('No Polygon or LineString found in GeoJSON');
        const points = downsample(line.map((c) => [c[0], c[1]]), 3000);
        setRouteState({ name: file.name.replace(/\.(geo)?json$/i, ''), points });
        status('GeoJSON line imported as an embossable route.', 'info');
      }
    }
  } catch (err) {
    console.error(err);
    status(`Import failed: ${err.message}`, 'error');
  }
});
$('btn-clear-route').addEventListener('click', () => setRouteState(null));

// ---------------------------------------------------------------------------
// Layers / data source UI

const basemapBox = $('basemap-options');
Object.entries(BASEMAPS).forEach(([id, bm], idx) => {
  const label = document.createElement('label');
  label.className = 'radio-row';
  label.innerHTML = `<input type="radio" name="basemap" value="${id}" ${idx === 0 ? 'checked' : ''}><span>${bm.name}</span>`;
  basemapBox.appendChild(label);
});
basemapBox.addEventListener('change', (ev) => setBasemap(map, ev.target.value));

$('hillshade-toggle').addEventListener('change', (ev) => setHillshade(map, ev.target.checked));

$('btn-3d').addEventListener('click', () => {
  terrain3D = !terrain3D;
  set3DTerrain(map, terrain3D, parseFloat($('exaggeration').value) || 1.3);
  $('btn-3d').classList.toggle('active', terrain3D);
  $('btn-3d').textContent = terrain3D ? '2D view' : '3D view';
});

const sourceSelect = $('source-select');
Object.entries(ELEVATION_SOURCES).forEach(([id, src], idx) => {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = src.name;
  if (idx === 0) opt.selected = true;
  sourceSelect.appendChild(opt);
});
function syncSourceUI() {
  const src = ELEVATION_SOURCES[sourceSelect.value];
  $('source-desc').textContent = src.description;
  $('maptiler-key-row').style.display = src.needsKey ? 'flex' : 'none';
}
sourceSelect.addEventListener('change', syncSourceUI);
syncSourceUI();
$('maptiler-key').value = localStorage.getItem('maptilerKey') || '';
$('maptiler-key').addEventListener('change', (ev) => localStorage.setItem('maptilerKey', ev.target.value.trim()));

// ---------------------------------------------------------------------------
// Location search (Nominatim)

$('search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  status('Searching…', 'busy', true);
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const results = await resp.json();
    if (!results.length) {
      status(`No results for “${q}”`, 'error');
      return;
    }
    const r = results[0];
    const bb = r.boundingbox.map(Number); // [s, n, w, e]
    map.fitBounds([[bb[2], bb[0]], [bb[3], bb[1]]], { padding: 60, duration: 1200, maxZoom: 13 });
    status(`Found: ${r.display_name.split(',').slice(0, 3).join(',')}`, 'info');
  } catch (err) {
    status(`Search failed: ${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// Share links: state serialized into the URL hash

function collectState() {
  return {
    v: 1,
    map: {
      c: [+map.getCenter().lng.toFixed(6), +map.getCenter().lat.toFixed(6)],
      z: +map.getZoom().toFixed(2),
      p: +map.getPitch().toFixed(0),
      b: +map.getBearing().toFixed(0),
    },
    basemap: document.querySelector('input[name=basemap]:checked')?.value || 'osm',
    hillshade: $('hillshade-toggle').checked,
    sel: selMgr.toJSON(),
    text: { t: $('text-input').value, f: $('font-select').value },
    set: {
      res: $('resolution').value,
      size: $('model-size').value,
      exag: $('exaggeration').value,
      base: $('base-height').value,
      src: sourceSelect.value,
      smooth: $('smoothing').value,
      water: [$('water-toggle').checked ? 1 : 0, $('water-level').value],
      contour: $('contour-step').value,
      plate: [$('plate-toggle').checked ? 1 : 0, $('plate-height').value],
      tiles: [$('tile-cols').value, $('tile-rows').value],
      split: $('split-elev').value,
    },
  };
}

function applyState(st) {
  if (!st || st.v !== 1) return;
  try {
    if (st.set) {
      $('resolution').value = st.set.res;
      $('model-size').value = st.set.size;
      $('exaggeration').value = st.set.exag;
      $('base-height').value = st.set.base;
      if (ELEVATION_SOURCES[st.set.src]) sourceSelect.value = st.set.src;
      $('smoothing').value = st.set.smooth ?? '0';
      $('water-toggle').checked = !!(st.set.water?.[0]);
      $('water-level').value = st.set.water?.[1] ?? 0;
      $('contour-step').value = st.set.contour ?? 0;
      $('plate-toggle').checked = !!(st.set.plate?.[0]);
      $('plate-height').value = st.set.plate?.[1] ?? 1.5;
      $('tile-cols').value = st.set.tiles?.[0] ?? '1';
      $('tile-rows').value = st.set.tiles?.[1] ?? '1';
      $('split-elev').value = st.set.split ?? 0;
      syncSourceUI();
    }
    if (st.text) {
      $('text-input').value = st.text.t ?? 'A';
      if ([...$('font-select').options].some((o) => o.value === st.text.f)) $('font-select').value = st.text.f;
      syncTextOptions();
    }
    if (st.basemap && BASEMAPS[st.basemap]) {
      document.querySelector(`input[name=basemap][value=${st.basemap}]`).checked = true;
      setBasemap(map, st.basemap);
    }
    if (st.hillshade) {
      $('hillshade-toggle').checked = true;
      setHillshade(map, true);
    }
    if (st.map) {
      map.jumpTo({ center: st.map.c, zoom: st.map.z, pitch: st.map.p || 0, bearing: st.map.b || 0 });
      if (st.map.p > 15) {
        terrain3D = true;
        set3DTerrain(map, true, parseFloat($('exaggeration').value) || 1.3);
        $('btn-3d').classList.add('active');
        $('btn-3d').textContent = '2D view';
      }
    }
    if (st.sel) selMgr.fromJSON(st.sel);
  } catch (err) {
    console.error('State restore failed', err);
  }
}

function encodeState(st) {
  const json = JSON.stringify(st);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(hash) {
  const m = hash.match(/#s=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

$('btn-share').addEventListener('click', async () => {
  const hash = `#s=${encodeState(collectState())}`;
  history.replaceState(null, '', hash);
  try {
    await navigator.clipboard.writeText(location.href);
    status('Share link copied to clipboard.', 'info');
  } catch {
    status('Link is in the address bar — copy it from there.', 'info');
  }
});

// Restore on style.load, not load — the latter waits for tile downloads and
// never fires if a basemap host is unreachable.
map.once('style.load', () => {
  try {
    const st = decodeState(location.hash);
    if (st) {
      applyState(st);
      status('Restored shared view.', 'info');
    }
  } catch (err) {
    console.error('Bad share link', err);
  }
});

// ---------------------------------------------------------------------------
// Model generation

const preview = new TerrainPreview($('preview-canvas'));
let lastMesh = null; // { positions, indices, name }
let lastGrid = null; // { gridW, gridH, topZ, mask, xs, ys, minElev, zPerMeter, baseMM }

$('wireframe-toggle').addEventListener('change', (ev) => preview.setWireframe(ev.target.checked));
$('btn-close-preview').addEventListener('click', () => $('preview-panel').classList.remove('open'));

function gridSizeForSelection(sel, maxSamples) {
  const { width, height } = bboxDimensionsMeters(sel.bbox);
  const aspect = height / Math.max(1e-9, width);
  let gridW, gridH;
  if (aspect <= 1) {
    gridW = maxSamples;
    gridH = Math.max(2, Math.round(maxSamples * aspect));
  } else {
    gridH = maxSamples;
    gridW = Math.max(2, Math.round(maxSamples / aspect));
  }
  return { gridW, gridH, widthM: width, heightM: height };
}

$('btn-generate').addEventListener('click', async () => {
  const sel = selMgr.selection;
  if (!sel) return;
  const btn = $('btn-generate');
  btn.disabled = true;
  try {
    const maxSamples = parseInt($('resolution').value, 10);
    const sizeMM = Math.max(10, parseFloat($('model-size').value) || 100);
    const exaggeration = Math.max(0.1, parseFloat($('exaggeration').value) || 1);
    const baseMM = Math.max(0.4, parseFloat($('base-height').value) || 2);
    const sourceId = sourceSelect.value;
    const smoothRadius = parseInt($('smoothing').value, 10) || 0;
    const waterOn = $('water-toggle').checked;
    const waterLevel = parseFloat($('water-level').value) || 0;
    const contourStep = Math.max(0, parseFloat($('contour-step').value) || 0);
    const plateOn = $('plate-toggle').checked;
    const plateMM = Math.min(baseMM, Math.max(0.4, parseFloat($('plate-height').value) || 1.5));
    const embossOn = route && $('route-emboss').checked;
    const routeRaiseMM = Math.max(0.1, parseFloat($('route-height').value) || 0.6);

    const { gridW, gridH, widthM, heightM } = gridSizeForSelection(sel, maxSamples);
    if (sourceId === 'openmeteo' && gridW * gridH > 20000) {
      status('Open-Meteo is point-query based — use grid detail ≤ 128 with it, or switch source.', 'error');
      return;
    }

    status('Preparing…', 'busy', true);
    await document.fonts.ready; // text masks need the display fonts loaded

    let { elev, zoom } = await fetchElevationGrid(sourceId, sel.bbox, gridW, gridH, {
      apiKey: $('maptiler-key').value.trim(),
      onProgress: (msg) => status(msg, 'busy', true),
    });

    status('Building mesh…', 'busy', true);
    const selMask = selMgr.buildMask(gridW, gridH);
    let inside = 0;
    for (let s = 0; s < selMask.length; s++) inside += selMask[s];
    if (inside < 8) {
      status('Selection is too small or empty at this resolution — enlarge it or raise grid detail.', 'error');
      return;
    }

    // Sculpting passes on raw elevations (meters)
    if (smoothRadius) elev = smoothGrid(elev, gridW, gridH, smoothRadius);
    if (waterOn) elev = flattenWater(elev, waterLevel);
    if (contourStep > 0) elev = quantizeContours(elev, selMask, contourStep);

    const horizontalScale = sizeMM / Math.max(widthM, heightM);
    const zPerMeter = horizontalScale * exaggeration;
    const { topZ, minElev, maxElev, maxZ } = elevationsToModelZ(elev, selMask, horizontalScale, exaggeration, baseMM);

    // Baseplate: fill the bbox with a thin plate outside the cutout shape
    const mask = plateOn ? new Uint8Array(gridW * gridH).fill(1) : selMask;
    let finalTop = topZ;
    if (plateOn) {
      finalTop = Float32Array.from(topZ);
      for (let s = 0; s < finalTop.length; s++) {
        if (!selMask[s]) finalTop[s] = plateMM;
      }
    }

    // Route embossing
    if (embossOn) {
      const lineWidthPx = Math.max(2, Math.round(gridW / 150));
      const routeMask = rasterizeRouteMask(route.points, sel.bbox, gridW, gridH, lineWidthPx);
      for (let s = 0; s < routeMask.length; s++) {
        if (routeMask[s] && !mask[s]) routeMask[s] = 0; // only raise inside the model
      }
      finalTop = embossRoute(finalTop, routeMask, routeRaiseMM);
    }

    const xs = new Float32Array(gridW);
    const ys = new Float32Array(gridH);
    for (let i = 0; i < gridW; i++) xs[i] = (i / (gridW - 1)) * widthM * horizontalScale;
    for (let j = 0; j < gridH; j++) ys[j] = (j / (gridH - 1)) * heightM * horizontalScale;

    const mesh = buildTerrainSolid({ width: gridW, height: gridH, topZ: finalTop, mask, xs, ys });
    if (mesh.triangleCount === 0) {
      status('Mesh came out empty — try a larger selection or higher grid detail.', 'error');
      return;
    }
    lastMesh = { ...mesh, name: `terrain-${sel.shape}` };
    lastGrid = { gridW, gridH, topZ: finalTop, mask, xs, ys, minElev, zPerMeter, baseMM };

    preview.setMesh(mesh.positions, mesh.indices);
    $('preview-panel').classList.add('open');

    const volumeCm3 = meshVolume(mesh.positions, mesh.indices) / 1000;
    const gramsSolid = volumeCm3 * 1.24; // PLA density
    const scaleRatio = Math.round(Math.max(widthM, heightM) / (sizeMM / 1000));
    const dims = `${(widthM * horizontalScale).toFixed(1)} × ${(heightM * horizontalScale).toFixed(1)} × ${maxZ.toFixed(1)} mm`;
    const res = `${gridW} × ${gridH} samples` + (zoom ? ` (DEM z${zoom})` : '');
    const groundRes = (Math.max(widthM, heightM) / maxSamples).toFixed(0);
    $('stats').innerHTML = [
      `<b>Model:</b> ${dims} &nbsp;·&nbsp; scale ≈ 1:${scaleRatio.toLocaleString()}`,
      `<b>Elevation:</b> ${minElev.toFixed(0)} – ${maxElev.toFixed(0)} m`,
      `<b>Grid:</b> ${res}, ~${groundRes} m/sample`,
      `<b>Triangles:</b> ${mesh.triangleCount.toLocaleString()}`,
      `<b>Material:</b> ${volumeCm3.toFixed(1)} cm³ ≈ ${gramsSolid.toFixed(0)} g PLA solid (~${(gramsSolid * 0.4).toFixed(0)} g at 15% infill)`,
      `<b>Source:</b> ${ELEVATION_SOURCES[sourceId].name}`,
    ].join('<br>');
    updateExportButtons();
    status('Model ready — inspect it and export below.', 'info');
  } catch (err) {
    console.error(err);
    status(`Generation failed: ${err.message}`, 'error', true);
  } finally {
    btn.disabled = !selMgr.selection;
  }
});

// ---------------------------------------------------------------------------
// Exports

function download(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function zipDownload(files, filename) {
  const zipInput = {};
  for (const [path, content] of Object.entries(files)) {
    zipInput[path] = typeof content === 'string' ? fflate.strToU8(content) : new Uint8Array(content);
  }
  download(fflate.zipSync(zipInput, { level: 4 }), filename, 'application/zip');
}

function tilesSetting() {
  return [parseInt($('tile-cols').value, 10) || 1, parseInt($('tile-rows').value, 10) || 1];
}

function updateExportButtons() {
  const [cols, rows] = tilesSetting();
  const splitM = parseFloat($('split-elev').value) || 0;
  document.querySelectorAll('.export-btn').forEach((b) => {
    if (b.dataset.format === 'tiles') b.disabled = !lastGrid || cols * rows < 2;
    else if (b.dataset.format === 'two-piece') b.disabled = !lastGrid || splitM <= 0;
    else b.disabled = !lastMesh;
  });
}
$('tile-cols').addEventListener('change', updateExportButtons);
$('tile-rows').addEventListener('change', updateExportButtons);
$('split-elev').addEventListener('change', updateExportButtons);

function exportTiles() {
  const [cols, rows] = tilesSetting();
  const { gridW, gridH, topZ, mask, xs, ys } = lastGrid;
  const files = {};
  let skipped = 0;
  for (const r of tileRanges(gridW, gridH, cols, rows)) {
    const sub = extractSubgrid({ topZ, mask, xs, ys, width: gridW }, r);
    const m = buildTerrainSolid(sub);
    if (m.triangleCount === 0) { skipped++; continue; }
    files[`${lastMesh.name}-tile-r${r.row + 1}c${r.col + 1}.stl`] = toBinarySTL(m.positions, m.indices, `${lastMesh.name} tile`);
  }
  if (!Object.keys(files).length) throw new Error('All tiles were empty');
  zipDownload(files, `${lastMesh.name}-tiles-${cols}x${rows}.zip`);
  status(`Exported ${Object.keys(files).length} tiles${skipped ? ` (${skipped} empty tiles skipped)` : ''}. Adjacent tiles mate along their cut faces.`, 'info');
}

function exportTwoPiece() {
  const splitM = parseFloat($('split-elev').value) || 0;
  const { gridW, gridH, topZ, mask, xs, ys, minElev, zPerMeter, baseMM } = lastGrid;
  const splitZ = baseMM + (splitM - minElev) * zPerMeter;
  let maxTop = -Infinity;
  for (let s = 0; s < topZ.length; s++) {
    if (mask[s] && topZ[s] > maxTop) maxTop = topZ[s];
  }
  if (splitZ <= baseMM || splitZ >= maxTop) {
    throw new Error(`Split elevation must be between ${Math.ceil(minElev)} m and ${Math.floor(minElev + (maxTop - baseMM) / zPerMeter)} m for this model`);
  }
  const { lower, upper } = splitAtHeight(topZ, mask, splitZ, 0.6);
  const mLower = buildTerrainSolid({ width: gridW, height: gridH, topZ: lower.topZ, mask: lower.mask, xs, ys });
  const mUpper = buildTerrainSolid({ width: gridW, height: gridH, topZ: upper.topZ, mask: upper.mask, xs, ys });
  const files = {};
  files[`${lastMesh.name}-lower-below-${Math.round(splitM)}m.stl`] = toBinarySTL(mLower.positions, mLower.indices);
  if (mUpper.triangleCount > 0) {
    files[`${lastMesh.name}-upper-above-${Math.round(splitM)}m.stl`] = toBinarySTL(mUpper.positions, mUpper.indices);
  }
  zipDownload(files, `${lastMesh.name}-two-piece.zip`);
  status(mUpper.triangleCount > 0
    ? 'Exported both pieces — the upper piece prints flat and stacks on the lower one.'
    : 'Only the lower piece had geometry at that split elevation.', 'info');
}

const EXPORTERS = {
  'stl-binary': (m) => download(toBinarySTL(m.positions, m.indices, m.name), `${m.name}.stl`, 'model/stl'),
  'stl-ascii': (m) => download(toAsciiSTL(m.positions, m.indices, m.name), `${m.name}-ascii.stl`, 'model/stl'),
  obj: (m) => download(toOBJ(m.positions, m.indices, m.name), `${m.name}.obj`, 'model/obj'),
  ply: (m) => download(toPLY(m.positions, m.indices, m.name), `${m.name}.ply`, 'application/octet-stream'),
  '3mf': (m) => zipDownload(to3MFFiles(m.positions, m.indices, m.name), `${m.name}.3mf`),
  tiles: () => exportTiles(),
  'two-piece': () => exportTwoPiece(),
};

document.querySelectorAll('.export-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!lastMesh) return;
    try {
      EXPORTERS[btn.dataset.format](lastMesh);
      if (!['tiles', 'two-piece'].includes(btn.dataset.format)) {
        status(`Exported ${btn.dataset.format.toUpperCase()}.`, 'info');
      }
    } catch (err) {
      console.error(err);
      status(`Export failed: ${err.message}`, 'error');
    }
  });
});

status('Draw a selection on the map to begin.', 'info');
