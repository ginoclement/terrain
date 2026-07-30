import { createMap, setBasemap, setHillshade, set3DTerrain, setRoute, BASEMAPS } from './mapview.js';
import {
  SelectionManager, bboxDimensionsMeters, buildSelectionMask, hydrateSelection, rasterizePolylines,
} from './selection.js';
import { ELEVATION_SOURCES, fetchElevationGrid } from './elevation.js';
import { buildTerrainSolid, elevationsToModelZ, meshVolume } from './mesh.js';
import {
  smoothGrid, flattenWater, quantizeContours, embossRoute, tileRanges, extractSubgrid,
  interlockedTileFilters, splitAtHeight,
} from './heightops.js';
import { toBinarySTL, toAsciiSTL, toOBJ, toPLY, to3MFFiles, to3MFColorFiles, toGLB } from './exporters.js';
import { TerrainPreview, LAND_GRADIENT, SEA_GRADIENT, gradientColor } from './preview3d.js';

const $ = (id) => document.getElementById(id);
const EARTH_RADIUS = 6371000;

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
    $('btn-batch-add').disabled = !sel;
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
  onProfileLine(a, b) {
    showElevationProfile(a, b).catch((err) => status(`Profile failed: ${err.message}`, 'error'));
  },
});

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

// Text options + custom font upload
function syncTextOptions() {
  selMgr.setTextOptions({
    text: $('text-input').value || 'A',
    font: $('font-select').value,
  });
}
$('text-input').addEventListener('input', syncTextOptions);
$('font-select').addEventListener('change', syncTextOptions);
syncTextOptions();

$('font-upload-btn').addEventListener('click', () => $('font-upload').click());
$('font-upload').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const face = new FontFace('UserUploadedFont', await file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    const value = '"UserUploadedFont", sans-serif';
    let opt = [...$('font-select').options].find((o) => o.value === value);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = value;
      $('font-select').appendChild(opt);
    }
    opt.textContent = `Custom: ${file.name}`;
    $('font-select').value = value;
    syncTextOptions();
    status(`Font “${file.name}” loaded for the letters tool.`, 'info');
  } catch (err) {
    status(`Font load failed: ${err.message}`, 'error');
  }
});

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

$('water-mode').addEventListener('change', () => {
  $('water-level-row').style.display = $('water-mode').value === 'flatten' ? 'flex' : 'none';
});

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
// Settings

function readSettings() {
  return {
    maxSamples: parseInt($('resolution').value, 10),
    sizeMM: Math.max(10, parseFloat($('model-size').value) || 100),
    exaggeration: Math.max(0.1, parseFloat($('exaggeration').value) || 1),
    baseMM: Math.max(0.4, parseFloat($('base-height').value) || 2),
    sourceId: sourceSelect.value,
    apiKey: $('maptiler-key').value.trim(),
    smoothRadius: parseInt($('smoothing').value, 10) || 0,
    waterFlatten: $('water-mode').value === 'flatten',
    waterLevel: parseFloat($('water-level').value) || 0,
    contourStep: Math.max(0, parseFloat($('contour-step').value) || 0),
    plateOn: $('plate-toggle').checked,
    plateMM: parseFloat($('plate-height').value) || 1.5,
    embossRouteOn: !!route && $('route-emboss').checked,
    routeRaiseMM: Math.max(0.1, parseFloat($('route-height').value) || 0.6),
    riversMode: $('rivers-mode').value,
    curvature: $('curvature-toggle').checked,
    engraveBase: $('engrave-toggle').checked,
  };
}

// ---------------------------------------------------------------------------
// OSM waterways via Overpass

async function fetchWaterways(bbox, onProgress) {
  onProgress?.('Fetching rivers from OpenStreetMap…');
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:30];way[waterway~"^(river|canal|stream)$"](${s},${w},${n},${e});out geom 6000;`;
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`Overpass API error ${resp.status}`);
  const data = await resp.json();
  const lines = [];
  for (const el of data.elements || []) {
    if (el.type === 'way' && el.geometry?.length >= 2) {
      lines.push(el.geometry.map((g) => [g.lon, g.lat]));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Model computation pipeline (shared by live generate and batch export)

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

async function computeModel(sel, S, onProgress = () => {}) {
  const { gridW, gridH, widthM, heightM } = gridSizeForSelection(sel, S.maxSamples);
  if (S.sourceId === 'openmeteo' && gridW * gridH > 20000) {
    throw new Error('Open-Meteo is point-query based — use grid detail ≤ 128 with it, or switch source.');
  }
  await document.fonts.ready; // text masks need the display fonts loaded

  let { elev, zoom } = await fetchElevationGrid(S.sourceId, sel.bbox, gridW, gridH, {
    apiKey: S.apiKey,
    onProgress: (msg) => onProgress(msg),
  });

  onProgress('Building mesh…');
  const selMask = buildSelectionMask(sel, gridW, gridH);
  let inside = 0;
  for (let s = 0; s < selMask.length; s++) inside += selMask[s];
  if (inside < 8) {
    throw new Error('Selection is too small or empty at this resolution — enlarge it or raise grid detail.');
  }

  // Sculpting passes on raw elevations (meters)
  if (S.smoothRadius) elev = smoothGrid(elev, gridW, gridH, S.smoothRadius);
  if (S.waterFlatten) elev = flattenWater(elev, S.waterLevel);
  if (S.contourStep > 0) elev = quantizeContours(elev, selMask, S.contourStep);
  if (S.curvature) {
    // True spherical drop-off from the selection center.
    const curved = Float32Array.from(elev);
    for (let j = 0; j < gridH; j++) {
      const dy = (j / (gridH - 1) - 0.5) * heightM;
      for (let i = 0; i < gridW; i++) {
        const dx = (i / (gridW - 1) - 0.5) * widthM;
        curved[i + j * gridW] -= (dx * dx + dy * dy) / (2 * EARTH_RADIUS);
      }
    }
    elev = curved;
  }

  const horizontalScale = S.sizeMM / Math.max(widthM, heightM);
  const zPerMeter = horizontalScale * S.exaggeration;
  const { topZ, minElev, maxElev, maxZ } = elevationsToModelZ(elev, selMask, horizontalScale, S.exaggeration, S.baseMM);

  // Baseplate: fill the bbox with a thin plate outside the cutout shape
  const plateMM = Math.min(S.baseMM, Math.max(0.4, S.plateMM));
  const mask = S.plateOn ? new Uint8Array(gridW * gridH).fill(1) : selMask;
  let finalTop = topZ;
  if (S.plateOn) {
    finalTop = Float32Array.from(topZ);
    for (let s = 0; s < finalTop.length; s++) {
      if (!selMask[s]) finalTop[s] = plateMM;
    }
  }

  // Route embossing
  if (S.embossRouteOn && route) {
    const lineWidthPx = Math.max(2, Math.round(gridW / 150));
    const routeMask = rasterizePolylines([route.points], sel.bbox, gridW, gridH, lineWidthPx);
    for (let s = 0; s < routeMask.length; s++) {
      if (routeMask[s] && !mask[s]) routeMask[s] = 0;
    }
    finalTop = embossRoute(finalTop, routeMask, S.routeRaiseMM);
  }

  // OSM waterways
  if (S.riversMode !== 'off') {
    try {
      const lines = await fetchWaterways(sel.bbox, onProgress);
      if (lines.length) {
        const riverMask = rasterizePolylines(lines, sel.bbox, gridW, gridH, Math.max(1, Math.round(gridW / 220)));
        const delta = S.riversMode === 'engrave' ? -0.5 : 0.5;
        if (finalTop === topZ) finalTop = Float32Array.from(topZ);
        const floor = 0.4;
        for (let s = 0; s < riverMask.length; s++) {
          if (riverMask[s] && mask[s]) finalTop[s] = Math.max(floor, finalTop[s] + delta);
        }
        onProgress(`Added ${lines.length} waterway(s).`);
      }
    } catch (err) {
      console.warn('Waterway fetch failed', err);
      onProgress(`Rivers skipped (${err.message}).`);
    }
  }

  // Base engraving (mirrored so it reads correctly from below)
  let botZ = null;
  if (S.engraveBase) {
    const depth = Math.min(1, S.baseMM * 0.35);
    const clat = ((sel.bbox[1] + sel.bbox[3]) / 2).toFixed(3);
    const clon = ((sel.bbox[0] + sel.bbox[2]) / 2).toFixed(3);
    const scaleRatio = Math.round(Math.max(widthM, heightM) / (S.sizeMM / 1000));
    const textSel = {
      shape: 'text',
      text: `${clat}, ${clon}  ·  1:${scaleRatio}`,
      font: 'sans-serif',
      rect0: sel.bbox,
      bbox: sel.bbox,
      center: [(sel.bbox[0] + sel.bbox[2]) / 2, (sel.bbox[1] + sel.bbox[3]) / 2],
      rotationDeg: 0,
    };
    const textMask = buildSelectionMask(textSel, gridW, gridH);
    botZ = new Float32Array(gridW * gridH);
    for (let j = 0; j < gridH; j++) {
      for (let i = 0; i < gridW; i++) {
        // mirror horizontally: engraving must read correctly when flipped over
        if (textMask[gridW - 1 - i + j * gridW] && mask[i + j * gridW]) botZ[i + j * gridW] = depth;
      }
    }
  }

  const xs = new Float32Array(gridW);
  const ys = new Float32Array(gridH);
  for (let i = 0; i < gridW; i++) xs[i] = (i / (gridW - 1)) * widthM * horizontalScale;
  for (let j = 0; j < gridH; j++) ys[j] = (j / (gridH - 1)) * heightM * horizontalScale;

  const mesh = buildTerrainSolid({ width: gridW, height: gridH, topZ: finalTop, botZ, mask, xs, ys });
  if (mesh.triangleCount === 0) {
    throw new Error('Mesh came out empty — try a larger selection or higher grid detail.');
  }
  const seaZ = !S.waterFlatten && minElev < 0 ? S.baseMM + (0 - minElev) * zPerMeter : null;
  return {
    mesh,
    grid: { gridW, gridH, topZ: finalTop, botZ, mask, xs, ys, minElev, zPerMeter, baseMM: S.baseMM },
    info: { widthM, heightM, minElev, maxElev, maxZ, zoom, seaZ, horizontalScale },
  };
}

// ---------------------------------------------------------------------------
// Live generation

const preview = new TerrainPreview($('preview-canvas'));
let lastMesh = null; // { positions, indices, name }
let lastGrid = null;
let lastInfo = null;
let lastBbox = null;

$('wireframe-toggle').addEventListener('change', (ev) => preview.setWireframe(ev.target.checked));

function setPreviewOpen(on) {
  $('preview-panel').classList.toggle('open', on);
  $('resize-preview').style.display = on ? 'block' : 'none';
}
$('btn-close-preview').addEventListener('click', () => setPreviewOpen(false));

$('btn-generate').addEventListener('click', async () => {
  const sel = selMgr.selection;
  if (!sel) return;
  const btn = $('btn-generate');
  btn.disabled = true;
  try {
    status('Preparing…', 'busy', true);
    const S = readSettings();
    const { mesh, grid, info } = await computeModel(sel, S, (msg) => status(msg, 'busy', true));
    lastMesh = { ...mesh, name: `terrain-${sel.shape}` };
    lastGrid = grid;
    lastInfo = info;
    lastBbox = [...sel.bbox];

    preview.setMesh(mesh.positions, mesh.indices, info.seaZ);
    setPreviewOpen(true);

    const volumeCm3 = meshVolume(mesh.positions, mesh.indices) / 1000;
    const gramsSolid = volumeCm3 * 1.24; // PLA density
    const scaleRatio = Math.round(Math.max(info.widthM, info.heightM) / (S.sizeMM / 1000));
    const dims = `${(info.widthM * info.horizontalScale).toFixed(1)} × ${(info.heightM * info.horizontalScale).toFixed(1)} × ${info.maxZ.toFixed(1)} mm`;
    const res = `${grid.gridW} × ${grid.gridH} samples` + (info.zoom ? ` (DEM z${info.zoom})` : '');
    const groundRes = (Math.max(info.widthM, info.heightM) / S.maxSamples).toFixed(0);
    $('stats').innerHTML = [
      `<b>Model:</b> ${dims} &nbsp;·&nbsp; scale ≈ 1:${scaleRatio.toLocaleString()}`,
      `<b>Elevation:</b> ${info.minElev.toFixed(0)} – ${info.maxElev.toFixed(0)} m`,
      `<b>Grid:</b> ${res}, ~${groundRes} m/sample`,
      `<b>Triangles:</b> ${mesh.triangleCount.toLocaleString()}`,
      `<b>Material:</b> ${volumeCm3.toFixed(1)} cm³ ≈ ${gramsSolid.toFixed(0)} g PLA solid (~${(gramsSolid * 0.4).toFixed(0)} g at 15% infill)`,
      `<b>Source:</b> ${ELEVATION_SOURCES[S.sourceId].name}`,
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
// Elevation profile

async function showElevationProfile(a, b) {
  status('Sampling elevation profile…', 'busy', true);
  const pad = 0.01;
  const bbox = [
    Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad,
    Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad,
  ];
  const G = 220;
  const { elev } = await fetchElevationGrid('terrarium', bbox, G, G, {
    onProgress: (msg) => status(msg, 'busy', true),
  });
  const N = 200;
  const samples = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const lon = a[0] + ((b[0] - a[0]) * k) / (N - 1);
    const lat = a[1] + ((b[1] - a[1]) * k) / (N - 1);
    const fx = ((lon - bbox[0]) / (bbox[2] - bbox[0])) * (G - 1);
    const fy = ((lat - bbox[1]) / (bbox[3] - bbox[1])) * (G - 1);
    const i = Math.max(0, Math.min(G - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(G - 2, Math.floor(fy)));
    const dx = fx - i, dy = fy - j;
    samples[k] =
      elev[i + j * G] * (1 - dx) * (1 - dy) + elev[i + 1 + j * G] * dx * (1 - dy) +
      elev[i + (j + 1) * G] * (1 - dx) * dy + elev[i + 1 + (j + 1) * G] * dx * dy;
  }
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const distM = Math.hypot((b[0] - a[0]) * 111320 * Math.cos(midLat), (b[1] - a[1]) * 111320);
  drawProfile(samples, distM);
  status('', 'info');
}

function drawProfile(samples, distM) {
  const canvas = $('profile-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 800;
  const cssH = 150;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  let min = Infinity, max = -Infinity;
  for (const v of samples) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  const padL = 8, padR = 8, padT = 10, padB = 18;
  const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
  const xAt = (k) => padL + (k / (samples.length - 1)) * plotW;
  const yAt = (v) => padT + (1 - (v - min) / span) * plotH;

  // area fill + line
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(samples[0]));
  for (let k = 1; k < samples.length; k++) ctx.lineTo(xAt(k), yAt(samples[k]));
  ctx.strokeStyle = '#00c2ff';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(xAt(samples.length - 1), padT + plotH);
  ctx.lineTo(xAt(0), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 194, 255, 0.16)';
  ctx.fill();

  // sea level line if the profile crosses 0
  if (min < 0 && max > 0) {
    ctx.strokeStyle = 'rgba(126, 196, 218, 0.6)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, yAt(0));
    ctx.lineTo(padL + plotW, yAt(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = '#93a0b4';
  ctx.font = '11px Inter, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(max)} m`, padL, padT - 8 < 0 ? 0 : padT - 8);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(min)} m`, padL, cssH - 2);
  ctx.textAlign = 'right';
  ctx.fillText(distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM)} m`, cssW - padR, cssH - 2);
  ctx.textAlign = 'left';

  const gain = samples.reduce((acc, v, k) => (k ? acc + Math.max(0, v - samples[k - 1]) : 0), 0);
  $('profile-stats').textContent =
    `${Math.round(min)}–${Math.round(max)} m · +${Math.round(gain)} m gain · ${(distM / 1000).toFixed(1)} km`;
  $('profile-panel').style.display = 'block';
}
$('btn-close-profile').addEventListener('click', () => { $('profile-panel').style.display = 'none'; });

// ---------------------------------------------------------------------------
// Satellite texture (for GLB export)

function lon2mercX(lon) { return (lon + 180) / 360; }
function lat2mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

async function fetchImageryTexture(bbox, targetPx = 1024) {
  const [w, s, e, n] = bbox;
  let z = Math.ceil(Math.log2(targetPx / 256 / Math.max(1e-9, lon2mercX(e) - lon2mercX(w))));
  z = Math.max(1, Math.min(17, z));
  let x0, x1, y0, y1;
  do {
    const scale = 1 << z;
    x0 = Math.floor(lon2mercX(w) * scale);
    x1 = Math.floor(lon2mercX(e) * scale);
    y0 = Math.floor(lat2mercY(n) * scale);
    y1 = Math.floor(lat2mercY(s) * scale);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) break;
    z--;
  } while (z > 1);
  const scale = 1 << z;
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext('2d');
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`tile ${r.status}`))))
          .then((blob) => createImageBitmap(blob))
          .then((bmp) => {
            ctx.drawImage(bmp, (tx - x0) * 256, (ty - y0) * 256);
            bmp.close?.();
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(jobs);
  // crop to the exact bbox in mercator pixels
  const px0 = lon2mercX(w) * scale * 256 - x0 * 256;
  const px1 = lon2mercX(e) * scale * 256 - x0 * 256;
  const py0 = lat2mercY(n) * scale * 256 - y0 * 256;
  const py1 = lat2mercY(s) * scale * 256 - y0 * 256;
  const out = document.createElement('canvas');
  out.width = Math.max(8, Math.round(px1 - px0));
  out.height = Math.max(8, Math.round(py1 - py0));
  out.getContext('2d').drawImage(canvas, px0, py0, px1 - px0, py1 - py0, 0, 0, out.width, out.height);
  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Color banding (for color 3MF)

function buildColorBands(mesh, seaZ) {
  const { positions, indices } = mesh;
  let minZ = Infinity, maxZ = -Infinity;
  for (let v = 2; v < positions.length; v += 3) {
    if (positions[v] < minZ) minZ = positions[v];
    if (positions[v] > maxZ) maxZ = positions[v];
  }
  const hasSea = seaZ !== null && seaZ !== undefined && seaZ > minZ;
  const seaBands = hasSea ? 5 : 0;
  const landBands = 9;
  const hex = ([r, g, b]) =>
    `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const palette = [];
  for (let k = 0; k < seaBands; k++) palette.push(hex(gradientColor(SEA_GRADIENT, (k + 0.5) / seaBands)));
  for (let k = 0; k < landBands; k++) palette.push(hex(gradientColor(LAND_GRADIENT, (k + 0.5) / landBands)));
  const landBase = hasSea ? Math.min(seaZ, maxZ) : minZ;
  const landSpan = maxZ - landBase || 1;
  const seaSpan = hasSea ? seaZ - minZ || 1 : 1;
  const triMaterial = new Uint8Array(indices.length / 3);
  for (let t = 0; t < triMaterial.length; t++) {
    const a = indices[t * 3] * 3 + 2, b = indices[t * 3 + 1] * 3 + 2, c = indices[t * 3 + 2] * 3 + 2;
    const z = (positions[a] + positions[b] + positions[c]) / 3;
    if (hasSea && z < seaZ) {
      triMaterial[t] = Math.min(seaBands - 1, Math.floor(((z - minZ) / seaSpan) * seaBands));
    } else {
      triMaterial[t] = seaBands + Math.min(landBands - 1, Math.max(0, Math.floor(((z - landBase) / landSpan) * landBands)));
    }
  }
  return { palette, triMaterial };
}

// ---------------------------------------------------------------------------
// Resizable panels

function initResizers() {
  const sidebar = $('sidebar');
  const previewPanel = $('preview-panel');
  const saved = JSON.parse(localStorage.getItem('panelSizes') || '{}');
  if (saved.sidebar) sidebar.style.width = `${saved.sidebar}px`;
  if (saved.preview) previewPanel.style.setProperty('--preview-w', `${saved.preview}px`);

  const savePanelSizes = () => {
    const previewW = Math.round(previewPanel.getBoundingClientRect().width);
    localStorage.setItem('panelSizes', JSON.stringify({
      sidebar: Math.round(sidebar.getBoundingClientRect().width),
      // Keep the stored width when the panel is closed (its live width is ~0)
      preview: previewW > 100 ? previewW : saved.preview,
    }));
  };

  const attach = (resizerId, onDrag) => {
    const resizer = $(resizerId);
    resizer.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      resizer.setPointerCapture(ev.pointerId);
      resizer.classList.add('active');
      document.body.classList.add('resizing');
      previewPanel.classList.add('no-transition');
      const onMove = (mv) => onDrag(mv.clientX);
      const onUp = () => {
        resizer.classList.remove('active');
        document.body.classList.remove('resizing');
        previewPanel.classList.remove('no-transition');
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onUp);
        savePanelSizes();
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', onUp);
    });
  };

  attach('resize-sidebar', (x) => {
    const w = Math.max(220, Math.min(540, x - $('layout').getBoundingClientRect().left));
    sidebar.style.width = `${w}px`;
  });
  attach('resize-preview', (x) => {
    const w = Math.max(280, Math.min(900, $('layout').getBoundingClientRect().right - x));
    previewPanel.style.setProperty('--preview-w', `${w}px`);
  });
}
initResizers();

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
      water: [$('water-mode').value === 'flatten' ? 1 : 0, $('water-level').value],
      contour: $('contour-step').value,
      plate: [$('plate-toggle').checked ? 1 : 0, $('plate-height').value],
      tiles: [$('tile-cols').value, $('tile-rows').value],
      split: $('split-elev').value,
      rivers: $('rivers-mode').value,
      curve: $('curvature-toggle').checked ? 1 : 0,
      engrave: $('engrave-toggle').checked ? 1 : 0,
      interlock: $('interlock-toggle').checked ? 1 : 0,
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
      $('water-mode').value = st.set.water?.[0] ? 'flatten' : 'bathy';
      $('water-level-row').style.display = st.set.water?.[0] ? 'flex' : 'none';
      $('water-level').value = st.set.water?.[1] ?? 0;
      $('contour-step').value = st.set.contour ?? 0;
      $('plate-toggle').checked = !!(st.set.plate?.[0]);
      $('plate-height').value = st.set.plate?.[1] ?? 1.5;
      $('tile-cols').value = st.set.tiles?.[0] ?? '1';
      $('tile-rows').value = st.set.tiles?.[1] ?? '1';
      $('split-elev').value = st.set.split ?? 0;
      if (st.set.rivers) $('rivers-mode').value = st.set.rivers;
      $('curvature-toggle').checked = !!st.set.curve;
      $('engrave-toggle').checked = !!st.set.engrave;
      $('interlock-toggle').checked = st.set.interlock === undefined ? true : !!st.set.interlock;
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
// Batch export

const batch = [];

function renderBatchList() {
  const box = $('batch-list');
  box.innerHTML = '';
  batch.forEach((item, k) => {
    const row = document.createElement('div');
    row.className = 'batch-item';
    const dims = bboxDimensionsMeters(hydrateSelection(item.sel).bbox);
    const span = document.createElement('span');
    span.textContent = `${k + 1}. ${item.sel.shape} · ${(dims.width / 1000).toFixed(1)}×${(dims.height / 1000).toFixed(1)} km · ${item.settings.maxSamples}px`;
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      batch.splice(k, 1);
      renderBatchList();
    });
    row.append(span, del);
    box.appendChild(row);
  });
  $('btn-batch-export').disabled = batch.length === 0;
}

$('btn-batch-add').addEventListener('click', () => {
  const selJson = selMgr.toJSON();
  if (!selJson) return;
  batch.push({ sel: selJson, settings: readSettings() });
  renderBatchList();
  status(`Added to batch (${batch.length} queued).`, 'info');
});

$('btn-batch-export').addEventListener('click', async () => {
  if (!batch.length) return;
  $('btn-batch-export').disabled = true;
  const files = {};
  try {
    for (let k = 0; k < batch.length; k++) {
      const { sel, settings } = batch[k];
      const hydrated = hydrateSelection(sel);
      status(`Batch ${k + 1}/${batch.length}: generating…`, 'busy', true);
      const { mesh } = await computeModel(hydrated, settings, (msg) =>
        status(`Batch ${k + 1}/${batch.length}: ${msg}`, 'busy', true));
      files[`${String(k + 1).padStart(2, '0')}-terrain-${sel.shape}.stl`] = toBinarySTL(mesh.positions, mesh.indices);
    }
    zipDownload(files, 'terrain-batch.zip');
    status(`Batch exported: ${batch.length} model(s).`, 'info');
  } catch (err) {
    console.error(err);
    status(`Batch failed: ${err.message}`, 'error', true);
  } finally {
    $('btn-batch-export').disabled = batch.length === 0;
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
  const { gridW, gridH, topZ, botZ, mask, xs, ys } = lastGrid;
  const files = {};
  let skipped = 0;
  if ($('interlock-toggle').checked) {
    const filters = interlockedTileFilters(gridW - 1, gridH - 1, cols, rows);
    filters.forEach((cellFilter, t) => {
      const m = buildTerrainSolid({ width: gridW, height: gridH, topZ, botZ, mask, xs, ys, cellFilter });
      if (m.triangleCount === 0) { skipped++; return; }
      const r = Math.floor(t / cols), c = t % cols;
      files[`${lastMesh.name}-tile-r${r + 1}c${c + 1}.stl`] = toBinarySTL(m.positions, m.indices, `${lastMesh.name} tile`);
    });
  } else {
    for (const r of tileRanges(gridW, gridH, cols, rows)) {
      const sub = extractSubgrid({ topZ, botZ, mask, xs, ys, width: gridW }, r);
      const m = buildTerrainSolid(sub);
      if (m.triangleCount === 0) { skipped++; continue; }
      files[`${lastMesh.name}-tile-r${r.row + 1}c${r.col + 1}.stl`] = toBinarySTL(m.positions, m.indices, `${lastMesh.name} tile`);
    }
  }
  if (!Object.keys(files).length) throw new Error('All tiles were empty');
  zipDownload(files, `${lastMesh.name}-tiles-${cols}x${rows}.zip`);
  const style = $('interlock-toggle').checked ? 'interlocking tabs' : 'straight cuts';
  status(`Exported ${Object.keys(files).length} tiles (${style})${skipped ? `, ${skipped} empty skipped` : ''}.`, 'info');
}

function exportTwoPiece() {
  const splitM = parseFloat($('split-elev').value) || 0;
  const { gridW, gridH, topZ, botZ, mask, xs, ys, minElev, zPerMeter, baseMM } = lastGrid;
  const splitZ = baseMM + (splitM - minElev) * zPerMeter;
  let maxTop = -Infinity;
  for (let s = 0; s < topZ.length; s++) {
    if (mask[s] && topZ[s] > maxTop) maxTop = topZ[s];
  }
  if (splitZ <= baseMM || splitZ >= maxTop) {
    throw new Error(`Split elevation must be between ${Math.ceil(minElev)} m and ${Math.floor(minElev + (maxTop - baseMM) / zPerMeter)} m for this model`);
  }
  const { lower, upper } = splitAtHeight(topZ, mask, splitZ, 0.6);
  const mLower = buildTerrainSolid({ width: gridW, height: gridH, topZ: lower.topZ, botZ, mask: lower.mask, xs, ys });
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

async function exportGLB() {
  status('Fetching satellite texture…', 'busy', true);
  let texture = null;
  try {
    texture = await fetchImageryTexture(lastBbox, 1024);
  } catch (err) {
    console.warn('Texture fetch failed', err);
  }
  let uvs = null;
  if (texture) {
    const { positions } = lastMesh;
    const maxX = lastGrid.xs[lastGrid.xs.length - 1] || 1;
    const maxY = lastGrid.ys[lastGrid.ys.length - 1] || 1;
    uvs = new Float32Array((positions.length / 3) * 2);
    for (let v = 0; v < positions.length / 3; v++) {
      uvs[v * 2] = positions[v * 3] / maxX;
      uvs[v * 2 + 1] = 1 - positions[v * 3 + 1] / maxY;
    }
  }
  download(toGLB(lastMesh.positions, lastMesh.indices, uvs, texture, lastMesh.name), `${lastMesh.name}.glb`, 'model/gltf-binary');
  status(texture ? 'Exported textured GLB.' : 'Imagery unavailable — exported untextured GLB.', texture ? 'info' : 'error');
}

const EXPORTERS = {
  'stl-binary': (m) => download(toBinarySTL(m.positions, m.indices, m.name), `${m.name}.stl`, 'model/stl'),
  'stl-ascii': (m) => download(toAsciiSTL(m.positions, m.indices, m.name), `${m.name}-ascii.stl`, 'model/stl'),
  obj: (m) => download(toOBJ(m.positions, m.indices, m.name), `${m.name}.obj`, 'model/obj'),
  ply: (m) => download(toPLY(m.positions, m.indices, m.name), `${m.name}.ply`, 'application/octet-stream'),
  '3mf': (m) => zipDownload(to3MFFiles(m.positions, m.indices, m.name), `${m.name}.3mf`),
  '3mf-color': (m) => {
    const { palette, triMaterial } = buildColorBands(m, lastInfo?.seaZ ?? null);
    zipDownload(to3MFColorFiles(m.positions, m.indices, palette, triMaterial, m.name), `${m.name}-color.3mf`);
  },
  glb: () => exportGLB(),
  tiles: () => exportTiles(),
  'two-piece': () => exportTwoPiece(),
};

document.querySelectorAll('.export-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!lastMesh) return;
    try {
      EXPORTERS[btn.dataset.format](lastMesh);
      if (!['tiles', 'two-piece', 'glb'].includes(btn.dataset.format)) {
        status(`Exported ${btn.dataset.format.toUpperCase()}.`, 'info');
      }
    } catch (err) {
      console.error(err);
      status(`Export failed: ${err.message}`, 'error');
    }
  });
});

// ---------------------------------------------------------------------------
// PWA: offline shell + tile cache

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
}

status('Draw a selection on the map to begin.', 'info');

// Dev/test handle
window.__terrain = { map, selMgr };
