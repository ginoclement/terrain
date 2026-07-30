import { createMap, setBasemap, setHillshade, set3DTerrain, BASEMAPS } from './mapview.js';
import { SelectionManager, bboxDimensionsMeters } from './selection.js';
import { ELEVATION_SOURCES, fetchElevationGrid } from './elevation.js';
import { buildTerrainSolid, elevationsToModelZ } from './mesh.js';
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

const selMgr = new SelectionManager(map, {
  onSelectionChange(sel) {
    const info = $('selection-info');
    if (!sel) {
      info.textContent = 'No selection yet — pick a tool and draw on the map.';
      $('btn-generate').disabled = true;
      return;
    }
    const { width, height } = bboxDimensionsMeters(sel.bbox);
    const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
    const label = { rect: 'Rectangle', square: 'Square', circle: 'Circle', hex: 'Hexagon', polygon: 'Polygon', text: `Text “${sel.text}”` }[sel.shape] || sel.shape;
    info.textContent = `${label}: ${fmt(width)} × ${fmt(height)}`;
    $('btn-generate').disabled = false;
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
// Model generation

const preview = new TerrainPreview($('preview-canvas'));
let lastMesh = null; // { positions, indices, name }

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

    const { gridW, gridH, widthM, heightM } = gridSizeForSelection(sel, maxSamples);
    if (sourceId === 'openmeteo' && gridW * gridH > 20000) {
      status('Open-Meteo is point-query based — use grid detail ≤ 128 with it, or switch source.', 'error');
      return;
    }

    status('Preparing…', 'busy', true);
    await document.fonts.ready; // text masks need the display fonts loaded

    const { elev, zoom } = await fetchElevationGrid(sourceId, sel.bbox, gridW, gridH, {
      apiKey: $('maptiler-key').value.trim(),
      onProgress: (msg) => status(msg, 'busy', true),
    });

    status('Building mesh…', 'busy', true);
    const mask = selMgr.buildMask(gridW, gridH);
    let inside = 0;
    for (let s = 0; s < mask.length; s++) inside += mask[s];
    if (inside < 8) {
      status('Selection is too small or empty at this resolution — enlarge it or raise grid detail.', 'error');
      return;
    }

    const horizontalScale = sizeMM / Math.max(widthM, heightM);
    const { topZ, minElev, maxElev, maxZ } = elevationsToModelZ(elev, mask, horizontalScale, exaggeration, baseMM);
    const xs = new Float32Array(gridW);
    const ys = new Float32Array(gridH);
    for (let i = 0; i < gridW; i++) xs[i] = (i / (gridW - 1)) * widthM * horizontalScale;
    for (let j = 0; j < gridH; j++) ys[j] = (j / (gridH - 1)) * heightM * horizontalScale;

    const mesh = buildTerrainSolid({ width: gridW, height: gridH, topZ, mask, xs, ys });
    if (mesh.triangleCount === 0) {
      status('Mesh came out empty — try a larger selection or higher grid detail.', 'error');
      return;
    }
    lastMesh = { ...mesh, name: `terrain-${sel.shape}` };

    preview.setMesh(mesh.positions, mesh.indices);
    $('preview-panel').classList.add('open');

    const dims = `${(widthM * horizontalScale).toFixed(1)} × ${(heightM * horizontalScale).toFixed(1)} × ${maxZ.toFixed(1)} mm`;
    const res = `${gridW} × ${gridH} samples` + (zoom ? ` (DEM z${zoom})` : '');
    const groundRes = (Math.max(widthM, heightM) / maxSamples).toFixed(0);
    $('stats').innerHTML = [
      `<b>Model:</b> ${dims}`,
      `<b>Elevation:</b> ${minElev.toFixed(0)} – ${maxElev.toFixed(0)} m`,
      `<b>Grid:</b> ${res}, ~${groundRes} m/sample`,
      `<b>Triangles:</b> ${mesh.triangleCount.toLocaleString()}`,
      `<b>Source:</b> ${ELEVATION_SOURCES[sourceId].name}`,
    ].join('<br>');
    document.querySelectorAll('.export-btn').forEach((b) => (b.disabled = false));
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

const EXPORTERS = {
  'stl-binary': (m) => download(toBinarySTL(m.positions, m.indices, m.name), `${m.name}.stl`, 'model/stl'),
  'stl-ascii': (m) => download(toAsciiSTL(m.positions, m.indices, m.name), `${m.name}-ascii.stl`, 'model/stl'),
  obj: (m) => download(toOBJ(m.positions, m.indices, m.name), `${m.name}.obj`, 'model/obj'),
  ply: (m) => download(toPLY(m.positions, m.indices, m.name), `${m.name}.ply`, 'application/octet-stream'),
  '3mf': (m) => {
    const files = to3MFFiles(m.positions, m.indices, m.name);
    const zipInput = {};
    for (const [path, content] of Object.entries(files)) zipInput[path] = fflate.strToU8(content);
    const zipped = fflate.zipSync(zipInput, { level: 6 });
    download(zipped, `${m.name}.3mf`, 'model/3mf');
  },
};

document.querySelectorAll('.export-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!lastMesh) return;
    try {
      EXPORTERS[btn.dataset.format](lastMesh);
      status(`Exported ${btn.dataset.format.toUpperCase()}.`, 'info');
    } catch (err) {
      console.error(err);
      status(`Export failed: ${err.message}`, 'error');
    }
  });
});

status('Draw a selection on the map to begin.', 'info');
