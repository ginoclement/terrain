/**
 * Pure heightmap-grid operations applied between elevation fetch and mesh
 * construction: smoothing, water flattening, contour quantization, tile
 * splitting, and two-piece elevation splits. All node-testable.
 */

/**
 * Separable gaussian-ish blur (three box passes approximate a gaussian).
 * radius 0 = no-op. Returns a new Float32Array.
 */
export function smoothGrid(elev, W, H, radius) {
  if (!radius) return Float32Array.from(elev);
  let src = Float32Array.from(elev);
  let dst = new Float32Array(elev.length);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        let sum = 0, count = 0;
        for (let k = -r; k <= r; k++) {
          const ii = i + k;
          if (ii >= 0 && ii < W) { sum += src[row + ii]; count++; }
        }
        dst[row + i] = sum / count;
      }
    }
    [src, dst] = [dst, src];
    // vertical
    for (let i = 0; i < W; i++) {
      for (let j = 0; j < H; j++) {
        let sum = 0, count = 0;
        for (let k = -r; k <= r; k++) {
          const jj = j + k;
          if (jj >= 0 && jj < H) { sum += src[i + jj * W]; count++; }
        }
        dst[i + j * W] = sum / count;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/**
 * Clamp everything at or below `level` (meters) up to `level` — flattens seas
 * and lakes whose DEM values are noisy. Returns a new Float32Array.
 */
export function flattenWater(elev, level) {
  const out = Float32Array.from(elev);
  for (let s = 0; s < out.length; s++) {
    if (out[s] <= level) out[s] = level;
  }
  return out;
}

/**
 * Quantize elevations into `stepM`-meter contour terraces (laser-cut topo
 * look). Anchored at the masked minimum so the lowest terrace sits on the
 * base. stepM <= 0 = no-op. Returns a new Float32Array.
 */
export function quantizeContours(elev, mask, stepM) {
  const out = Float32Array.from(elev);
  if (!(stepM > 0)) return out;
  let minE = Infinity;
  for (let s = 0; s < out.length; s++) {
    if (mask[s] && out[s] < minE) minE = out[s];
  }
  if (!isFinite(minE)) return out;
  for (let s = 0; s < out.length; s++) {
    out[s] = minE + Math.floor((out[s] - minE) / stepM) * stepM;
  }
  return out;
}

/**
 * Raise samples covered by an embossed route mask by `raiseMM` (model units).
 * Applied to topZ after scaling. Returns a new Float32Array.
 */
export function embossRoute(topZ, routeMask, raiseMM) {
  const out = Float32Array.from(topZ);
  for (let s = 0; s < out.length; s++) {
    if (routeMask[s]) out[s] += raiseMM;
  }
  return out;
}

/**
 * Split a W×H sample grid into cols×rows tile ranges. Adjacent tiles share
 * their boundary sample row/column, so cut faces mate exactly.
 * Returns [{i0, i1, j0, j1, col, row}] with inclusive bounds.
 */
export function tileRanges(W, H, cols, rows) {
  const ranges = [];
  for (let r = 0; r < rows; r++) {
    const j0 = Math.round((r * (H - 1)) / rows);
    const j1 = Math.round(((r + 1) * (H - 1)) / rows);
    for (let c = 0; c < cols; c++) {
      const i0 = Math.round((c * (W - 1)) / cols);
      const i1 = Math.round(((c + 1) * (W - 1)) / cols);
      if (i1 > i0 && j1 > j0) ranges.push({ i0, i1, j0, j1, col: c, row: r });
    }
  }
  return ranges;
}

/** Extract a subgrid (inclusive range) from grid arrays for one tile. */
export function extractSubgrid({ topZ, botZ = null, mask, xs, ys, width: W }, { i0, i1, j0, j1 }) {
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const subTop = new Float32Array(w * h);
  const subBot = botZ ? new Float32Array(w * h) : null;
  const subMask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const src = i0 + i + (j0 + j) * W;
      const dst = i + j * w;
      subTop[dst] = topZ[src];
      if (subBot) subBot[dst] = botZ[src];
      subMask[dst] = mask[src];
    }
  }
  return {
    width: w,
    height: h,
    topZ: subTop,
    botZ: subBot,
    mask: subMask,
    xs: xs.slice(i0, i1 + 1),
    ys: ys.slice(j0, j1 + 1),
  };
}

/**
 * Partition the cell grid into cols×rows regions whose boundaries carry
 * puzzle-style interlocking tabs (a rectangular neck with a wider head), so
 * separately printed tiles key into each other in-plane. Because every tile is
 * built over the full grid with its own cell filter, mating walls share the
 * exact same vertices and fit together with zero designed clearance (a light
 * sanding pass may be needed for a snug fit).
 *
 * @returns {Uint8Array[]} one cell filter per tile, row-major by (row, col);
 *   filters are a strict partition of all cells.
 */
export function interlockedTileFilters(cellW, cellH, cols, rows) {
  const region = new Int16Array(cellW * cellH);
  const colOf = new Int16Array(cellW);
  const rowOf = new Int16Array(cellH);
  const colEdge = (c) => Math.round((c * cellW) / cols);
  const rowEdge = (r) => Math.round((r * cellH) / rows);
  for (let c = 0; c < cols; c++) colOf.fill(c, colEdge(c), colEdge(c + 1));
  for (let r = 0; r < rows; r++) rowOf.fill(r, rowEdge(r), rowEdge(r + 1));
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) region[i + j * cellW] = rowOf[j] * cols + colOf[i];
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const assign = (iA, iB, jA, jB, t) => {
    for (let j = clamp(jA, 0, cellH - 1); j <= clamp(jB, 0, cellH - 1); j++) {
      for (let i = clamp(iA, 0, cellW - 1); i <= clamp(iB, 0, cellW - 1); i++) {
        region[i + j * cellW] = t;
      }
    }
  };

  // One tab per shared edge segment, direction alternating for balance.
  const tabDepth = clamp(Math.round(Math.min(cellW / cols, cellH / rows) / 8), 2, 12);
  for (let c = 1; c < cols; c++) {
    const cut = colEdge(c);
    for (let r = 0; r < rows; r++) {
      const jm = Math.floor((rowEdge(r) + rowEdge(r + 1)) / 2);
      const neck = clamp(Math.round((rowEdge(r + 1) - rowEdge(r)) / 6), 2, 14);
      const head = neck * 2;
      const left = r * cols + (c - 1), right = r * cols + c;
      if ((c + r) % 2 === 0) {
        // left tile protrudes right
        assign(cut, cut + tabDepth - 1, jm - (neck >> 1), jm + (neck >> 1), left);
        assign(cut + tabDepth, cut + 2 * tabDepth - 1, jm - (head >> 1), jm + (head >> 1), left);
      } else {
        assign(cut - tabDepth, cut - 1, jm - (neck >> 1), jm + (neck >> 1), right);
        assign(cut - 2 * tabDepth, cut - tabDepth - 1, jm - (head >> 1), jm + (head >> 1), right);
      }
    }
  }
  for (let r = 1; r < rows; r++) {
    const cut = rowEdge(r);
    for (let c = 0; c < cols; c++) {
      const im = Math.floor((colEdge(c) + colEdge(c + 1)) / 2);
      const neck = clamp(Math.round((colEdge(c + 1) - colEdge(c)) / 6), 2, 14);
      const head = neck * 2;
      const below = (r - 1) * cols + c, above = r * cols + c;
      if ((r + c) % 2 === 0) {
        assign(im - (neck >> 1), im + (neck >> 1), cut, cut + tabDepth - 1, below);
        assign(im - (head >> 1), im + (head >> 1), cut + tabDepth, cut + 2 * tabDepth - 1, below);
      } else {
        assign(im - (neck >> 1), im + (neck >> 1), cut - tabDepth, cut - 1, above);
        assign(im - (head >> 1), im + (head >> 1), cut - 2 * tabDepth, cut - tabDepth - 1, above);
      }
    }
  }

  const filters = [];
  for (let t = 0; t < cols * rows; t++) {
    const f = new Uint8Array(cellW * cellH);
    for (let c = 0; c < region.length; c++) f[c] = region[c] === t ? 1 : 0;
    filters.push(f);
  }
  return filters;
}

/**
 * Split a model into two stackable pieces at model height `splitZ` (mm).
 * Lower piece: same mask, top clamped at splitZ. Upper piece: only where the
 * terrain rises above splitZ (by at least minThick), rebased to z = 0 so it
 * prints flat and stacks on the lower piece.
 * Returns { lower: {topZ, mask}, upper: {topZ, mask} }.
 */
export function splitAtHeight(topZ, mask, splitZ, minThick = 0.6) {
  const n = topZ.length;
  const lowerTop = new Float32Array(n);
  const upperTop = new Float32Array(n);
  const upperMask = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    lowerTop[s] = Math.min(topZ[s], splitZ);
    const above = topZ[s] - splitZ;
    upperTop[s] = Math.max(above, minThick);
    upperMask[s] = mask[s] && above >= minThick ? 1 : 0;
  }
  return {
    lower: { topZ: lowerTop, mask: Uint8Array.from(mask) },
    upper: { topZ: upperTop, mask: upperMask },
  };
}
