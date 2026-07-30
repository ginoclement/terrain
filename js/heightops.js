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
export function extractSubgrid({ topZ, mask, xs, ys, width: W }, { i0, i1, j0, j1 }) {
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const subTop = new Float32Array(w * h);
  const subMask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const src = i0 + i + (j0 + j) * W;
      subTop[i + j * w] = topZ[src];
      subMask[i + j * w] = mask[src];
    }
  }
  return {
    width: w,
    height: h,
    topZ: subTop,
    mask: subMask,
    xs: xs.slice(i0, i1 + 1),
    ys: ys.slice(j0, j1 + 1),
  };
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
