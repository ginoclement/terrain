/**
 * Elevation data sources. All sources produce a Float32Array grid of elevations
 * in meters, row j = 0 at the SOUTH edge of the bbox, sampled on a regular
 * lon/lat grid.
 *
 * bbox = [west, south, east, north] in degrees.
 */

const EARTH_CIRCUMFERENCE = 40075016.686;

export const ELEVATION_SOURCES = {
  terrarium: {
    name: 'AWS Terrain Tiles (Terrarium)',
    description: 'Mapzen/AWS Open Data global composite (3DEP, SRTM, GMTED, ETOPO1). Free, no key, up to zoom 15 (~5 m/px).',
    type: 'tiles',
    maxZoom: 15,
    needsKey: false,
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    decode: (r, g, b) => r * 256 + g + b / 256 - 32768,
    attribution: 'Terrain Tiles: Mapzen/AWS Open Data (3DEP, SRTM, GMTED2010, ETOPO1)',
  },
  maptiler: {
    name: 'MapTiler Terrain-RGB v2',
    description: 'MapTiler global DEM. Requires a free API key (set it in Data Sources). Up to zoom 12.',
    type: 'tiles',
    maxZoom: 12,
    needsKey: true,
    url: (z, x, y, key) => `https://api.maptiler.com/tiles/terrain-rgb-v2/${z}/${x}/${y}.webp?key=${key}`,
    decode: (r, g, b) => -10000 + (r * 65536 + g * 256 + b) * 0.1,
    attribution: 'Elevation © MapTiler',
  },
  openmeteo: {
    name: 'Open-Meteo (Copernicus GLO-90)',
    description: 'Copernicus GLO-90 DEM via the Open-Meteo elevation API. Free, no key. Coarser (~90 m) and slower — best for grid sizes ≤ 128.',
    type: 'api',
    needsKey: false,
    attribution: 'Elevation: Open-Meteo / Copernicus GLO-90 DEM',
  },
};

// ---------------------------------------------------------------------------
// Web Mercator helpers

function lon2mercX(lon) { return (lon + 180) / 360; }
function lat2mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Pick a tile zoom that gives roughly one DEM pixel per grid sample. */
export function pickZoom(bbox, gridW, maxZoom) {
  const [w, s, e, n] = bbox;
  const centerLat = (s + n) / 2;
  const widthM = ((e - w) / 360) * EARTH_CIRCUMFERENCE * Math.cos((centerLat * Math.PI) / 180);
  const targetRes = Math.max(1, widthM / gridW);
  let z = Math.ceil(Math.log2((EARTH_CIRCUMFERENCE * Math.cos((centerLat * Math.PI) / 180)) / (256 * targetRes)));
  z = Math.min(maxZoom, Math.max(1, z));
  // Cap the mosaic size (tiles are 256px; keep canvas under ~4k x 4k).
  while (z > 1) {
    const x0 = Math.floor(lon2mercX(w) * (1 << z));
    const x1 = Math.floor(lon2mercX(e) * (1 << z));
    const y0 = Math.floor(lat2mercY(n) * (1 << z));
    const y1 = Math.floor(lat2mercY(s) * (1 << z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 100) break;
    z--;
  }
  return z;
}

async function fetchTileBitmap(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`tile ${resp.status}`);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

async function fetchTileGrid(source, bbox, gridW, gridH, { apiKey, onProgress } = {}) {
  const [w, s, e, n] = bbox;
  const z = pickZoom(bbox, gridW, source.maxZoom);
  const scale = (1 << z) * 256; // world size in pixels at this zoom
  const x0 = Math.floor((lon2mercX(w) * scale) / 256);
  const x1 = Math.floor((lon2mercX(e) * scale) / 256);
  const y0 = Math.floor((lat2mercY(n) * scale) / 256);
  const y1 = Math.floor((lat2mercY(s) * scale) / 256);
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;

  const canvas = document.createElement('canvas');
  canvas.width = tilesX * 256;
  canvas.height = tilesY * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const total = tilesX * tilesY;
  let done = 0;
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        fetchTileBitmap(source.url(z, tx, ty, apiKey))
          .then((bmp) => {
            ctx.drawImage(bmp, (tx - x0) * 256, (ty - y0) * 256);
            bmp.close?.();
          })
          .catch(() => { /* missing tile: leave transparent, decodes to fallback */ })
          .finally(() => {
            done++;
            onProgress?.(`Fetching DEM tiles (z${z}): ${done}/${total}`);
          })
      );
    }
  }
  await Promise.all(jobs);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const dem = new Float32Array(canvas.width * canvas.height);
  for (let p = 0, q = 0; p < dem.length; p++, q += 4) {
    dem[p] = px[q + 3] === 0 ? 0 : source.decode(px[q], px[q + 1], px[q + 2]);
  }

  // Bilinear sampling of the decoded mosaic at each grid point.
  const elev = new Float32Array(gridW * gridH);
  const mw = canvas.width, mh = canvas.height;
  for (let j = 0; j < gridH; j++) {
    const lat = s + ((n - s) * j) / (gridH - 1);
    const fy = lat2mercY(lat) * scale - y0 * 256 - 0.5;
    for (let i = 0; i < gridW; i++) {
      const lon = w + ((e - w) * i) / (gridW - 1);
      const fx = lon2mercX(lon) * scale - x0 * 256 - 0.5;
      const ix = Math.max(0, Math.min(mw - 2, Math.floor(fx)));
      const iy = Math.max(0, Math.min(mh - 2, Math.floor(fy)));
      const dx = Math.max(0, Math.min(1, fx - ix));
      const dy = Math.max(0, Math.min(1, fy - iy));
      const p00 = dem[ix + iy * mw], p10 = dem[ix + 1 + iy * mw];
      const p01 = dem[ix + (iy + 1) * mw], p11 = dem[ix + 1 + (iy + 1) * mw];
      elev[i + j * gridW] =
        p00 * (1 - dx) * (1 - dy) + p10 * dx * (1 - dy) + p01 * (1 - dx) * dy + p11 * dx * dy;
    }
  }
  return { elev, zoom: z };
}

async function fetchApiGrid(bbox, gridW, gridH, { onProgress } = {}) {
  const [w, s, e, n] = bbox;
  const elev = new Float32Array(gridW * gridH);
  const points = [];
  for (let j = 0; j < gridH; j++) {
    const lat = s + ((n - s) * j) / (gridH - 1);
    for (let i = 0; i < gridW; i++) {
      const lon = w + ((e - w) * i) / (gridW - 1);
      points.push([lat, lon]);
    }
  }
  const CHUNK = 100;
  const chunks = [];
  for (let c = 0; c < points.length; c += CHUNK) chunks.push([c, points.slice(c, c + CHUNK)]);

  let done = 0;
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const [offset, pts] = chunks[cursor++];
      const lats = pts.map((p) => p[0].toFixed(6)).join(',');
      const lons = pts.map((p) => p[1].toFixed(6)).join(',');
      const resp = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
      if (!resp.ok) throw new Error(`Open-Meteo API error ${resp.status}`);
      const data = await resp.json();
      for (let k = 0; k < data.elevation.length; k++) elev[offset + k] = data.elevation[k] ?? 0;
      done++;
      onProgress?.(`Querying elevation API: ${done}/${chunks.length} batches`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { elev, zoom: null };
}

/**
 * Fetch an elevation grid from the chosen source.
 * @returns {Promise<{elev: Float32Array, zoom: ?number}>}
 */
export async function fetchElevationGrid(sourceId, bbox, gridW, gridH, opts = {}) {
  const source = ELEVATION_SOURCES[sourceId];
  if (!source) throw new Error(`Unknown elevation source: ${sourceId}`);
  if (source.needsKey && !opts.apiKey) {
    throw new Error(`${source.name} needs an API key — enter one under Data Sources, or switch source.`);
  }
  if (source.type === 'tiles') return fetchTileGrid(source, bbox, gridW, gridH, opts);
  return fetchApiGrid(bbox, gridW, gridH, opts);
}
