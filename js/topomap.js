/**
 * 2D topographic map rendering: contour extraction (marching squares with
 * edge-exact stitching), hillshade/hypsometric raster layers, water features,
 * graticule, and map furniture — assembled into a standalone SVG string that
 * the app can also rasterize to PNG or wrap into a PDF.
 *
 * Grid convention matches the rest of the app: sample (i, j), i = column
 * (west->east), j = row (0 = SOUTH edge), index = i + j * W.
 */
import { LAND_GRADIENT, SEA_GRADIENT, gradientColor } from './colors.js';

// ---------------------------------------------------------------------------
// Pure helpers (node-testable)

/** Round a raw step to a pleasant 1/2/2.5/5 × 10^k value. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  let n;
  if (r <= 1) n = 1;
  else if (r <= 2) n = 2;
  else if (r <= 2.5) n = 2.5;
  else if (r <= 5) n = 5;
  else n = 10;
  return n * mag;
}

/** Contour levels covering [minE, maxE] at `interval`, aligned to multiples. */
export function contourLevels(minE, maxE, interval) {
  const levels = [];
  const first = Math.ceil(minE / interval) * interval;
  for (let v = first; v <= maxE; v += interval) levels.push(+v.toFixed(6));
  return levels;
}

/**
 * Marching squares over the grid for one level. Returns polylines in grid
 * coordinates ([x = i, y = j], fractional). Endpoints are keyed by the cell
 * edge they sit on, so chains stitch exactly across cells.
 */
export function traceContours(elev, W, H, level) {
  // Samples exactly equal to the level are nudged by a deterministic epsilon:
  // otherwise intersections land on cell corners, where two edge keys describe
  // one point and the chain stitching breaks.
  const eps = (Math.abs(level) + 1) * 1e-6;
  const at = (idx) => {
    const v = elev[idx];
    return v === level ? level + eps : v;
  };
  const segs = [];
  const interp = (v0, v1) => {
    const d = v1 - v0;
    return Math.abs(d) < 1e-12 ? 0.5 : (level - v0) / d;
  };
  const edgePoint = {}; // edgeKey -> [x, y]
  const addSeg = (aKey, ax, ay, bKey, bx, by) => {
    edgePoint[aKey] = [ax, ay];
    edgePoint[bKey] = [bx, by];
    segs.push([aKey, bKey]);
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const v00 = at(i + j * W);        // SW
      const v10 = at(i + 1 + j * W);    // SE
      const v01 = at(i + (j + 1) * W);  // NW
      const v11 = at(i + 1 + (j + 1) * W); // NE
      const lo = Math.min(v00, v10, v01, v11);
      const hi = Math.max(v00, v10, v01, v11);
      if (level < lo || level >= hi) continue;

      let caseId = 0;
      if (v00 >= level) caseId |= 1;
      if (v10 >= level) caseId |= 2;
      if (v11 >= level) caseId |= 4;
      if (v01 >= level) caseId |= 8;
      if (caseId === 0 || caseId === 15) continue;

      // Edge keys shared exactly between adjacent cells
      const S = `h${i}_${j}`, N = `h${i}_${j + 1}`, Wk = `v${i}_${j}`, E = `v${i + 1}_${j}`;
      const pS = [i + interp(v00, v10), j];
      const pN = [i + interp(v01, v11), j + 1];
      const pW = [i, j + interp(v00, v01)];
      const pE = [i + 1, j + interp(v10, v11)];
      const emit = (k1, p1, k2, p2) => addSeg(k1, p1[0], p1[1], k2, p2[0], p2[1]);

      switch (caseId) {
        case 1: case 14: emit(Wk, pW, S, pS); break;
        case 2: case 13: emit(S, pS, E, pE); break;
        case 3: case 12: emit(Wk, pW, E, pE); break;
        case 4: case 11: emit(E, pE, N, pN); break;
        case 6: case 9: emit(S, pS, N, pN); break;
        case 7: case 8: emit(Wk, pW, N, pN); break;
        case 5: case 10: {
          // saddle: disambiguate by center average
          const center = (v00 + v10 + v01 + v11) / 4;
          const flip = (center >= level) === (caseId === 5);
          if (flip) { emit(Wk, pW, S, pS); emit(E, pE, N, pN); }
          else { emit(Wk, pW, N, pN); emit(S, pS, E, pE); }
          break;
        }
      }
    }
  }

  // Stitch segments into polylines via edge-key adjacency
  const adj = new Map(); // key -> [segIdx,...]
  segs.forEach(([a, b], k) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(k);
    adj.get(b).push(k);
  });
  const used = new Uint8Array(segs.length);
  const polylines = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    let [start, end] = segs[s];
    const chainKeys = [start, end];
    // extend forward from `end`, then backward from `start`
    for (const dir of [1, 0]) {
      let cursor = dir ? end : start;
      for (;;) {
        const next = (adj.get(cursor) || []).find((k) => !used[k]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segs[next];
        cursor = a === cursor ? b : a;
        if (dir) chainKeys.push(cursor);
        else chainKeys.unshift(cursor);
      }
    }
    polylines.push(chainKeys.map((k) => edgePoint[k]));
  }
  return polylines;
}

/**
 * Closed loops bounding the region elev >= level, clipped to the grid: the
 * grid is padded with a ring of -1e9 so contours that would run off the map
 * edge close around it instead. Every returned loop is closed (first ==
 * last point) in original grid coordinates. Used for layered cut sheets.
 */
export function traceClosedBands(elev, W, H, level) {
  const PW = W + 2, PH = H + 2;
  const padded = new Float32Array(PW * PH).fill(-1e9);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) padded[i + 1 + (j + 1) * PW] = elev[i + j * W];
  }
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  return traceContours(padded, PW, PH, level)
    .map((pts) => pts.map(([x, y]) => [clamp(x - 1, W - 1), clamp(y - 1, H - 1)]))
    .filter((pts) => pts.length >= 4);
}

/** Length of a polyline in arbitrary units. */
export function polylineLength(pts) {
  let len = 0;
  for (let k = 1; k < pts.length; k++) {
    len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  }
  return len;
}

// ---------------------------------------------------------------------------
// Raster layers (browser only)

function makeCanvas(W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

/** Hillshade canvas (315°/45° sun), north-up image (row 0 = north). */
export function renderHillshadeCanvas(elev, W, H, cellSizeM, exag = 1.3) {
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);
  for (let j = 0; j < H; j++) {
    const row = H - 1 - j; // canvas y down = north up
    for (let i = 0; i < W; i++) {
      const iw = Math.max(0, i - 1), ie = Math.min(W - 1, i + 1);
      const js = Math.max(0, j - 1), jn = Math.min(H - 1, j + 1);
      const dzdx = ((elev[ie + j * W] - elev[iw + j * W]) / ((ie - iw) * cellSizeM)) * exag;
      const dzdy = ((elev[i + jn * W] - elev[i + js * W]) / ((jn - js) * cellSizeM)) * exag;
      const norm = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      let shade = (-dzdx * lx + -dzdy * ly + lz) / norm;
      shade = Math.max(0, Math.min(1, shade));
      const p = (i + row * W) * 4;
      const v = Math.round(shade * 255);
      img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Hypsometric tint canvas, north-up. */
export function renderHypsoCanvas(elev, W, H, minE, maxE) {
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const hasSea = minE < 0;
  const landBase = hasSea ? 0 : minE;
  const landSpan = Math.max(1e-6, maxE - landBase);
  const seaSpan = Math.max(1e-6, 0 - minE);
  for (let j = 0; j < H; j++) {
    const row = H - 1 - j;
    for (let i = 0; i < W; i++) {
      const e = elev[i + j * W];
      const rgb = hasSea && e < 0
        ? gradientColor(SEA_GRADIENT, (e - minE) / seaSpan)
        : gradientColor(LAND_GRADIENT, Math.max(0, e - landBase) / landSpan);
      const p = (i + row * W) * 4;
      img.data[p] = Math.round(rgb[0] * 255);
      img.data[p + 1] = Math.round(rgb[1] * 255);
      img.data[p + 2] = Math.round(rgb[2] * 255);
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// SVG assembly

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (x) => +x.toFixed(2);

function graticuleStep(spanDeg) {
  return niceStep(spanDeg / 5);
}

function formatDeg(v, isLat) {
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  const abs = Math.abs(v);
  const dec = abs >= 10 ? 2 : 3;
  return `${abs.toFixed(dec)}°${hemi}`;
}

/**
 * Build the full topographic map as an SVG string.
 *
 * @param {Object} p
 * @param {Float32Array} p.elev grid elevations (j=0 south)
 * @param {number} p.W @param {number} p.H grid dims
 * @param {[number,number,number,number]} p.bbox [w,s,e,n] degrees
 * @param {number} p.pageW @param {number} p.pageH page size in px
 * @param {Object} p.opts toggles + values (see app)
 * @param {Array} p.waterLines lng/lat polylines
 * @param {Array} p.waterPolys lng/lat rings
 * @returns {{svg: string, contourInterval: number, scaleRatio: number}}
 */
export function buildTopoSVG(p) {
  const { elev, W, H, bbox, pageW, pageH, opts, waterLines = [], waterPolys = [] } = p;
  const [bw, bs, be, bn] = bbox;
  const midLat = ((bs + bn) / 2) * (Math.PI / 180);
  const realWidthM = (be - bw) * 111320 * Math.cos(midLat);
  const realHeightM = (bn - bs) * 111320;

  let minE = Infinity, maxE = -Infinity;
  for (let s = 0; s < elev.length; s++) {
    if (elev[s] < minE) minE = elev[s];
    if (elev[s] > maxE) maxE = elev[s];
  }

  // Layout: margins depend on enabled furniture
  const base = Math.min(pageW, pageH);
  const mTop = opts.title ? base * 0.085 : base * 0.03;
  const mBottom = (opts.scaleBar || opts.legend) ? base * 0.085 : base * 0.03;
  const mSide = opts.grid ? base * 0.055 : base * 0.03;
  const availW = pageW - 2 * mSide;
  const availH = pageH - mTop - mBottom;
  const aspect = realWidthM / realHeightM;
  let mapW = availW, mapH = availW / aspect;
  if (mapH > availH) { mapH = availH; mapW = availH * aspect; }
  const mapX = (pageW - mapW) / 2;
  const mapY = mTop + (availH - mapH) / 2;

  // grid coords -> map px
  const gx = (x) => (x / (W - 1)) * mapW;
  const gy = (y) => (1 - y / (H - 1)) * mapH;
  const lonX = (lon) => ((lon - bw) / (be - bw)) * mapW;
  const latY = (lat) => (1 - (lat - bs) / (bn - bs)) * mapH;

  const layers = [];

  // -- raster layers
  if (opts.hypso) {
    const c = renderHypsoCanvas(elev, W, H, minE, maxE);
    layers.push(`<image href="${c.toDataURL('image/png')}" x="0" y="0" width="${fmt(mapW)}" height="${fmt(mapH)}" preserveAspectRatio="none" image-rendering="optimizeQuality"/>`);
  } else {
    layers.push(`<rect x="0" y="0" width="${fmt(mapW)}" height="${fmt(mapH)}" fill="#f7f4ec"/>`);
  }
  if (opts.hillshade) {
    const cellM = realWidthM / (W - 1);
    const c = renderHillshadeCanvas(elev, W, H, cellM);
    layers.push(`<image href="${c.toDataURL('image/png')}" x="0" y="0" width="${fmt(mapW)}" height="${fmt(mapH)}" preserveAspectRatio="none" opacity="0.42" style="mix-blend-mode:multiply"/>`);
  }

  // -- water
  if (opts.water && (waterLines.length || waterPolys.length)) {
    const polys = waterPolys.map((ring) =>
      `<path d="M${ring.map(([lo, la]) => `${fmt(lonX(lo))},${fmt(latY(la))}`).join('L')}Z" fill="#9dc7e8" stroke="#5f93bd" stroke-width="${fmt(mapW * 0.0008)}"/>`
    ).join('');
    const lines = waterLines.map((line) =>
      `<polyline points="${line.map(([lo, la]) => `${fmt(lonX(lo))},${fmt(latY(la))}`).join(' ')}" fill="none" stroke="#4a86b8" stroke-width="${fmt(mapW * 0.0014)}" stroke-linejoin="round" stroke-linecap="round"/>`
    ).join('');
    layers.push(`<g>${polys}${lines}</g>`);
  }

  // -- contours
  let interval = opts.contourInterval;
  if (!(interval > 0)) interval = niceStep((maxE - minE) / 18) || 10;
  const levels = contourLevels(minE, maxE, interval);
  let labelCount = 0;
  if (opts.contours && levels.length) {
    const indexEvery = 5;
    const minor = [];
    const index = [];
    const labels = [];
    for (const level of levels) {
      const isIndex = Math.round(level / interval) % indexEvery === 0;
      const lines = traceContours(elev, W, H, level);
      for (const pts of lines) {
        if (pts.length < 2) continue;
        const d = `M${pts.map(([x, y]) => `${fmt(gx(x))},${fmt(gy(y))}`).join('L')}`;
        (isIndex ? index : minor).push(`<path d="${d}"/>`);
        if (isIndex && opts.contourLabels && polylineLength(pts) > (W + H) / 10 && labelCount < 60) {
          const mid = Math.floor(pts.length / 2);
          const a = pts[Math.max(0, mid - 2)], b = pts[Math.min(pts.length - 1, mid + 2)];
          let ang = (Math.atan2(gy(b[1]) - gy(a[1]), gx(b[0]) - gx(a[0])) * 180) / Math.PI;
          if (ang > 90) ang -= 180;
          if (ang < -90) ang += 180;
          const px = gx(pts[mid][0]), py = gy(pts[mid][1]);
          labels.push(
            `<text x="${fmt(px)}" y="${fmt(py)}" transform="rotate(${fmt(ang)} ${fmt(px)} ${fmt(py)})" ` +
            `font-size="${fmt(base * 0.012)}" text-anchor="middle" dominant-baseline="middle" fill="${opts.lineArt ? '#000000' : '#8a5a2b'}" ` +
            `paint-order="stroke" stroke="#ffffff" stroke-width="${fmt(base * 0.004)}" font-family="sans-serif">${Math.round(level)}</text>`
          );
          labelCount++;
        }
      }
    }
    const sw = Math.max(0.5, mapW * 0.0006);
    const minorColor = opts.lineArt ? '#333333' : '#b08050';
    const indexColor = opts.lineArt ? '#000000' : '#8a5a2b';
    layers.push(`<g fill="none" stroke="${minorColor}" stroke-width="${fmt(sw)}" opacity="0.85">${minor.join('')}</g>`);
    layers.push(`<g fill="none" stroke="${indexColor}" stroke-width="${fmt(sw * 2.2)}" opacity="0.95">${index.join('')}</g>`);
    if (labels.length) layers.push(`<g>${labels.join('')}</g>`);
  }

  // -- graticule
  const edgeLabels = [];
  if (opts.grid) {
    const stepLon = graticuleStep(be - bw);
    const stepLat = graticuleStep(bn - bs);
    const gridLines = [];
    for (let lon = Math.ceil(bw / stepLon) * stepLon; lon < be; lon += stepLon) {
      const x = lonX(lon);
      gridLines.push(`<line x1="${fmt(x)}" y1="0" x2="${fmt(x)}" y2="${fmt(mapH)}"/>`);
      edgeLabels.push(`<text x="${fmt(mapX + x)}" y="${fmt(mapY + mapH + base * 0.018)}" font-size="${fmt(base * 0.013)}" text-anchor="middle" fill="#666" font-family="sans-serif">${formatDeg(lon, false)}</text>`);
    }
    for (let lat = Math.ceil(bs / stepLat) * stepLat; lat < bn; lat += stepLat) {
      const y = latY(lat);
      gridLines.push(`<line x1="0" y1="${fmt(y)}" x2="${fmt(mapW)}" y2="${fmt(y)}"/>`);
      edgeLabels.push(`<text x="${fmt(mapX - base * 0.008)}" y="${fmt(mapY + y)}" font-size="${fmt(base * 0.013)}" text-anchor="end" dominant-baseline="middle" fill="#666" font-family="sans-serif">${formatDeg(lat, true)}</text>`);
    }
    layers.push(`<g stroke="#00000022" stroke-width="${fmt(Math.max(0.4, mapW * 0.0004))}">${gridLines.join('')}</g>`);
  }

  // -- furniture
  const furniture = [];
  const paperMMW = opts.paperMMW || (pageW / (opts.dpi || 150)) * 25.4;
  const printedWidthMM = (mapW / pageW) * paperMMW;
  const scaleRatio = Math.round(realWidthM / (printedWidthMM / 1000));

  if (opts.title) {
    furniture.push(
      `<text x="${fmt(pageW / 2)}" y="${fmt(mTop * 0.48)}" font-size="${fmt(base * 0.034)}" text-anchor="middle" fill="#222" font-family="Georgia, serif" font-weight="bold">${esc(opts.titleText || 'Topographic Map')}</text>`,
      `<text x="${fmt(pageW / 2)}" y="${fmt(mTop * 0.80)}" font-size="${fmt(base * 0.015)}" text-anchor="middle" fill="#666" font-family="sans-serif">${formatDeg((bs + bn) / 2, true)} ${formatDeg((bw + be) / 2, false)} · ${(realWidthM / 1000).toFixed(1)} × ${(realHeightM / 1000).toFixed(1)} km</text>`
    );
  }
  const bottomY = mapY + mapH + (pageH - mapY - mapH) * 0.45;
  if (opts.scaleBar) {
    const targetM = niceStep(realWidthM / 5);
    const barPx = (targetM / realWidthM) * mapW;
    const bx = mapX;
    const label = targetM >= 1000 ? `${targetM / 1000} km` : `${targetM} m`;
    furniture.push(
      `<g font-family="sans-serif">` +
      `<rect x="${fmt(bx)}" y="${fmt(bottomY)}" width="${fmt(barPx / 2)}" height="${fmt(base * 0.008)}" fill="#222"/>` +
      `<rect x="${fmt(bx + barPx / 2)}" y="${fmt(bottomY)}" width="${fmt(barPx / 2)}" height="${fmt(base * 0.008)}" fill="none" stroke="#222" stroke-width="1"/>` +
      `<text x="${fmt(bx)}" y="${fmt(bottomY - base * 0.006)}" font-size="${fmt(base * 0.013)}" fill="#333">0</text>` +
      `<text x="${fmt(bx + barPx)}" y="${fmt(bottomY - base * 0.006)}" font-size="${fmt(base * 0.013)}" text-anchor="end" fill="#333">${label}</text>` +
      `<text x="${fmt(bx)}" y="${fmt(bottomY + base * 0.026)}" font-size="${fmt(base * 0.013)}" fill="#333">Scale ≈ 1:${scaleRatio.toLocaleString('en-US')}</text>` +
      `</g>`
    );
  }
  if (opts.legend) {
    const lx = mapX + mapW;
    const ly = bottomY;
    const fs = base * 0.013;
    furniture.push(
      `<g font-family="sans-serif" font-size="${fmt(fs)}" fill="#333">` +
      `<line x1="${fmt(lx - fs * 11)}" y1="${fmt(ly)}" x2="${fmt(lx - fs * 9)}" y2="${fmt(ly)}" stroke="${opts.lineArt ? '#000000' : '#8a5a2b'}" stroke-width="2"/>` +
      `<text x="${fmt(lx - fs * 8.6)}" y="${fmt(ly + fs * 0.35)}">contours every ${interval >= 1 ? Math.round(interval) : interval} m</text>` +
      (opts.water ? `<line x1="${fmt(lx - fs * 11)}" y1="${fmt(ly + fs * 1.6)}" x2="${fmt(lx - fs * 9)}" y2="${fmt(ly + fs * 1.6)}" stroke="#4a86b8" stroke-width="2"/><text x="${fmt(lx - fs * 8.6)}" y="${fmt(ly + fs * 1.95)}">waterways</text>` : '') +
      `</g>`
    );
    // North arrow above legend, top-right inside margin
    const nx = mapX + mapW - base * 0.03;
    const ny = mapY + base * 0.045;
    furniture.push(
      `<g font-family="sans-serif">` +
      `<path d="M${fmt(nx)},${fmt(ny - base * 0.026)} L${fmt(nx + base * 0.011)},${fmt(ny + base * 0.012)} L${fmt(nx)},${fmt(ny + 0.004 * base)} L${fmt(nx - base * 0.011)},${fmt(ny + base * 0.012)} Z" fill="#222" opacity="0.85"/>` +
      `<text x="${fmt(nx)}" y="${fmt(ny + base * 0.030)}" font-size="${fmt(base * 0.016)}" text-anchor="middle" fill="#222" font-weight="bold">N</text>` +
      `</g>`
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">` +
    `<rect width="${pageW}" height="${pageH}" fill="#ffffff"/>` +
    `<g transform="translate(${fmt(mapX)},${fmt(mapY)})">` +
    `<clipPath id="mapclip"><rect x="0" y="0" width="${fmt(mapW)}" height="${fmt(mapH)}"/></clipPath>` +
    `<g clip-path="url(#mapclip)">${layers.join('')}</g>` +
    `<rect x="0" y="0" width="${fmt(mapW)}" height="${fmt(mapH)}" fill="none" stroke="#222" stroke-width="${fmt(Math.max(1, base * 0.0018))}"/>` +
    `</g>` +
    edgeLabels.join('') +
    furniture.join('') +
    `</svg>`;
  return { svg, contourInterval: interval, scaleRatio };
}

// ---------------------------------------------------------------------------
// Layered cut sheets (laser / Cricut / hand-cut stacking)

/**
 * Build one cut sheet per elevation band. Sheet k's CUT loops bound the
 * region elev >= level_k (layer 0 is the full base rectangle); its GUIDE
 * loops are the next layer's outline, drawn for glue placement. All loops are
 * closed, so interior holes fall out naturally when cut.
 *
 * @param {Object} p {elev, W, H, bbox, pageW, pageH, paperMMW, interval, title}
 * @returns {{sheets: [{svg, name, level, cutLoops, guideLoops}], levels, interval, mapWmm, mapHmm}}
 *   cutLoops/guideLoops are in page-millimeter coordinates (y down from sheet top).
 */
export function buildCutSheets(p) {
  const { elev, W, H, bbox, pageW, pageH, paperMMW, title } = p;
  const [bw, bs, be, bn] = bbox;
  const midLat = ((bs + bn) / 2) * (Math.PI / 180);
  const realWidthM = (be - bw) * 111320 * Math.cos(midLat);
  const realHeightM = (bn - bs) * 111320;

  let minE = Infinity, maxE = -Infinity;
  for (let s = 0; s < elev.length; s++) {
    if (elev[s] < minE) minE = elev[s];
    if (elev[s] > maxE) maxE = elev[s];
  }
  let interval = p.interval;
  if (!(interval > 0)) interval = niceStep((maxE - minE) / 12) || 10;
  let levels = contourLevels(minE, maxE, interval).filter((l) => l > minE);
  if (levels.length > 60) {
    interval = niceStep((maxE - minE) / 50);
    levels = contourLevels(minE, maxE, interval).filter((l) => l > minE);
  }

  // Layout: fit the map rect into the page with a margin band for labels.
  const base = Math.min(pageW, pageH);
  const margin = base * 0.05;
  const labelBand = base * 0.05;
  const availW = pageW - 2 * margin;
  const availH = pageH - 2 * margin - labelBand;
  const aspect = realWidthM / realHeightM;
  let mapW = availW, mapH = availW / aspect;
  if (mapH > availH) { mapH = availH; mapW = availH * aspect; }
  const mapX = (pageW - mapW) / 2;
  const mapY = margin + labelBand;
  const pxPerMM = pageW / paperMMW;

  const gx = (x) => mapX + (x / (W - 1)) * mapW;
  const gy = (y) => mapY + (1 - y / (H - 1)) * mapH;
  const minLoopLenPx = 4 * pxPerMM; // drop confetti smaller than ~4mm perimeter

  const loopsAtLevel = new Map();
  const getLoops = (level) => {
    if (!loopsAtLevel.has(level)) {
      const loops = traceClosedBands(elev, W, H, level)
        .map((pts) => pts.map(([x, y]) => [gx(x), gy(y)]))
        .filter((pts) => polylineLength(pts) >= minLoopLenPx);
      loopsAtLevel.set(level, loops);
    }
    return loopsAtLevel.get(level);
  };
  const rectLoop = [[mapX, mapY], [mapX + mapW, mapY], [mapX + mapW, mapY + mapH], [mapX, mapY + mapH], [mapX, mapY]];

  const toPath = (pts) => `M${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join('L')}`;
  const toMM = (pts) => pts.map(([x, y]) => [x / pxPerMM, y / pxPerMM]);

  const sheets = [];
  const total = levels.length + 1;
  for (let k = 0; k <= levels.length; k++) {
    const cutLoops = k === 0 ? [rectLoop] : getLoops(levels[k - 1]);
    const guideLoops = k < levels.length ? getLoops(levels[k]) : [];
    if (!cutLoops.length) continue;
    const levelLabel = k === 0 ? `base (${Math.round(minE)} m+)` : `≥ ${Math.round(levels[k - 1])} m`;
    const label = `${title ? `${title} · ` : ''}layer ${k + 1}/${total} · ${levelLabel} · ${interval} m steps`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">` +
      `<rect width="${pageW}" height="${pageH}" fill="#ffffff"/>` +
      `<text x="${fmt(margin)}" y="${fmt(margin + labelBand * 0.5)}" font-size="${fmt(base * 0.022)}" fill="#0066ff" font-family="sans-serif">${esc(label)}</text>` +
      `<g fill="none" stroke="#0066ff" stroke-width="${fmt(Math.max(0.6, pxPerMM * 0.15))}" stroke-dasharray="${fmt(pxPerMM * 1.2)} ${fmt(pxPerMM * 0.9)}">` +
      guideLoops.map((pts) => `<path d="${toPath(pts)}"/>`).join('') +
      `</g>` +
      `<g fill="none" stroke="#ff0000" stroke-width="${fmt(Math.max(0.5, pxPerMM * 0.1))}">` +
      cutLoops.map((pts) => `<path d="${toPath(pts)}"/>`).join('') +
      `</g>` +
      `</svg>`;
    sheets.push({
      svg,
      name: `layer-${String(k + 1).padStart(2, '0')}-${k === 0 ? 'base' : `${Math.round(levels[k - 1])}m`}`,
      level: k === 0 ? minE : levels[k - 1],
      cutLoops: cutLoops.map(toMM),
      guideLoops: guideLoops.map(toMM),
      label,
    });
  }
  return {
    sheets,
    levels,
    interval,
    mapWmm: mapW / pxPerMM,
    mapHmm: mapH / pxPerMM,
  };
}
