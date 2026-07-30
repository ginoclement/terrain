/**
 * Watertight terrain solid generation from a masked heightmap grid.
 *
 * Grid convention: samples are indexed (i, j) with i = column (0..W-1, west->east)
 * and j = row (0..H-1, south->north). Sample index = i + j * W.
 * A cell (i, j) spans samples (i,j)..(i+1,j+1) and is "solid" only when all four
 * of its corner samples are inside the selection mask (and pass the optional
 * cellFilter). Solid cells get a top surface, a bottom surface (flat by default,
 * or a shallow inverted heightmap for base engraving), and walls along every
 * edge that borders a non-solid cell, producing a closed, printable solid.
 *
 * With optimizeFlat (default), constant-height rectangular patches of the top
 * and bottom surfaces are triangulated as center fans that keep every perimeter
 * sample vertex, so flattened water, contour terraces, baseplates, and the flat
 * underside use far fewer triangles without breaking watertightness.
 */

/**
 * @param {Object} opts
 * @param {number} opts.width   number of samples per row (W)
 * @param {number} opts.height  number of rows (H)
 * @param {Float32Array|number[]} opts.topZ  top surface z in model units, per sample
 * @param {?Float32Array} [opts.botZ]  bottom surface z per sample (default all 0)
 * @param {Uint8Array|boolean[]} opts.mask   1 = sample inside selection
 * @param {Float32Array|number[]} opts.xs    model-space x per column, length W
 * @param {Float32Array|number[]} opts.ys    model-space y per row, length H
 * @param {?Uint8Array} [opts.cellFilter]  optional per-cell keep flag ((W-1)*(H-1))
 * @param {boolean} [opts.optimizeFlat=true]  fan-merge constant-z rectangles
 * @returns {{positions: Float32Array, indices: Uint32Array, triangleCount: number, vertexCount: number}}
 */
export function buildTerrainSolid({
  width: W, height: H, topZ, botZ = null, mask, xs, ys, cellFilter = null, optimizeFlat = true,
}) {
  const cellW = W - 1;
  const cellH = H - 1;
  const solid = new Uint8Array(cellW * cellH);
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const c = i + j * cellW;
      if (cellFilter && !cellFilter[c]) continue;
      const a = i + j * W;
      if (mask[a] && mask[a + 1] && mask[a + W] && mask[a + W + 1]) solid[c] = 1;
    }
  }

  // Two solid cells touching only at a corner would share a non-manifold
  // vertical edge. Carve one of the pair until no such pinch remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j < cellH - 1; j++) {
      for (let i = 0; i < cellW - 1; i++) {
        const c00 = solid[i + j * cellW], c10 = solid[i + 1 + j * cellW];
        const c01 = solid[i + (j + 1) * cellW], c11 = solid[i + 1 + (j + 1) * cellW];
        if (c00 && c11 && !c10 && !c01) { solid[i + j * cellW] = 0; changed = true; }
        else if (c10 && c01 && !c00 && !c11) { solid[i + 1 + j * cellW] = 0; changed = true; }
      }
    }
  }

  const topIdx = new Int32Array(W * H).fill(-1);
  const botIdx = new Int32Array(W * H).fill(-1);
  const positions = [];
  const indices = [];

  const getTop = (i, j) => {
    const s = i + j * W;
    if (topIdx[s] === -1) {
      topIdx[s] = positions.length / 3;
      positions.push(xs[i], ys[j], topZ[s]);
    }
    return topIdx[s];
  };
  const getBot = (i, j) => {
    const s = i + j * W;
    if (botIdx[s] === -1) {
      botIdx[s] = positions.length / 3;
      positions.push(xs[i], ys[j], botZ ? botZ[s] : 0);
    }
    return botIdx[s];
  };
  const isSolid = (i, j) =>
    i >= 0 && j >= 0 && i < cellW && j < cellH && solid[i + j * cellW] === 1;

  // ---- surface emission ---------------------------------------------------

  const emitTopCell = (i, j) => {
    const Ta = getTop(i, j), Tb = getTop(i + 1, j), Tc = getTop(i + 1, j + 1), Td = getTop(i, j + 1);
    indices.push(Ta, Tb, Tc, Ta, Tc, Td); // normal +z
  };
  const emitBotCell = (i, j) => {
    const Ba = getBot(i, j), Bb = getBot(i + 1, j), Bc = getBot(i + 1, j + 1), Bd = getBot(i, j + 1);
    indices.push(Ba, Bc, Bb, Ba, Bd, Bc); // normal -z
  };

  /** Sample coordinates of a cell-rect perimeter, CCW from the SW corner. */
  const rectPerimeter = (i0, i1, j0, j1) => {
    const pts = [];
    for (let i = i0; i <= i1 + 1; i++) pts.push([i, j0]);
    for (let j = j0 + 1; j <= j1 + 1; j++) pts.push([i1 + 1, j]);
    for (let i = i1; i >= i0; i--) pts.push([i, j1 + 1]);
    for (let j = j1; j >= j0 + 1; j--) pts.push([i0, j]);
    return pts;
  };

  const emitFan = (i0, i1, j0, j1, z, getVert, up) => {
    const centerIdx = positions.length / 3;
    positions.push((xs[i0] + xs[i1 + 1]) / 2, (ys[j0] + ys[j1 + 1]) / 2, z);
    const perim = rectPerimeter(i0, i1, j0, j1).map(([i, j]) => getVert(i, j));
    for (let k = 0; k < perim.length; k++) {
      const a = perim[k], b = perim[(k + 1) % perim.length];
      if (up) indices.push(centerIdx, a, b);
      else indices.push(centerIdx, b, a);
    }
  };

  /**
   * Emit one surface (top or bottom): greedily merge rectangles of solid cells
   * whose samples all share one exact z, fanning rectangles where that saves
   * triangles; everything else is emitted per cell.
   */
  const emitSurface = (zArr, getVert, emitCell, up) => {
    if (!optimizeFlat) {
      for (let j = 0; j < cellH; j++) {
        for (let i = 0; i < cellW; i++) if (solid[i + j * cellW]) emitCell(i, j);
      }
      return;
    }
    const zOf = (i, j) => (zArr ? zArr[i + j * W] : 0);
    const cellUniform = (i, j, z) =>
      zOf(i, j) === z && zOf(i + 1, j) === z && zOf(i, j + 1) === z && zOf(i + 1, j + 1) === z;
    const consumed = new Uint8Array(cellW * cellH);
    for (let j = 0; j < cellH; j++) {
      for (let i = 0; i < cellW; i++) {
        const c = i + j * cellW;
        if (!solid[c] || consumed[c]) continue;
        const z0 = zOf(i, j);
        if (!cellUniform(i, j, z0)) {
          consumed[c] = 1;
          emitCell(i, j);
          continue;
        }
        // extend width
        let i1 = i;
        while (
          i1 + 1 < cellW && solid[i1 + 1 + j * cellW] && !consumed[i1 + 1 + j * cellW] &&
          cellUniform(i1 + 1, j, z0)
        ) i1++;
        // extend height
        let j1 = j;
        extend: while (j1 + 1 < cellH) {
          for (let k = i; k <= i1; k++) {
            const cc = k + (j1 + 1) * cellW;
            if (!solid[cc] || consumed[cc] || !cellUniform(k, j1 + 1, z0)) break extend;
          }
          j1++;
        }
        for (let jj = j; jj <= j1; jj++) {
          for (let ii = i; ii <= i1; ii++) consumed[ii + jj * cellW] = 1;
        }
        const k = i1 - i + 1, m = j1 - j + 1;
        if ((k - 1) * (m - 1) >= 2) {
          emitFan(i, i1, j, j1, z0, getVert, up);
        } else {
          for (let jj = j; jj <= j1; jj++) {
            for (let ii = i; ii <= i1; ii++) emitCell(ii, jj);
          }
        }
      }
    }
  };

  emitSurface(topZ, getTop, emitTopCell, true);
  emitSurface(botZ, getBot, emitBotCell, false);

  // ---- walls --------------------------------------------------------------

  // Wall for the directed boundary edge p->q (CCW around the top face):
  // outward-facing quad split along the tp-bq diagonal.
  const wall = (tp, tq, bp, bq) => {
    indices.push(tp, bq, tq, tp, bp, bq);
  };
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      if (!solid[i + j * cellW]) continue;
      if (!isSolid(i, j - 1)) wall(getTop(i, j), getTop(i + 1, j), getBot(i, j), getBot(i + 1, j));
      if (!isSolid(i + 1, j)) wall(getTop(i + 1, j), getTop(i + 1, j + 1), getBot(i + 1, j), getBot(i + 1, j + 1));
      if (!isSolid(i, j + 1)) wall(getTop(i + 1, j + 1), getTop(i, j + 1), getBot(i + 1, j + 1), getBot(i, j + 1));
      if (!isSolid(i - 1, j)) wall(getTop(i, j + 1), getTop(i, j), getBot(i, j + 1), getBot(i, j));
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
    vertexCount: positions.length / 3,
  };
}

/** Enclosed volume of a closed mesh in model units³ (divergence theorem). */
export function meshVolume(positions, indices) {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/**
 * Map raw elevations to model-space top-surface heights.
 * z = baseMM + (elev - minElev) * horizontalScale * exaggeration, so the model
 * keeps true proportions at exaggeration = 1.
 *
 * @returns {{topZ: Float32Array, minElev: number, maxElev: number, maxZ: number}}
 */
export function elevationsToModelZ(elev, mask, horizontalScale, exaggeration, baseMM) {
  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let s = 0; s < elev.length; s++) {
    if (!mask[s]) continue;
    const e = elev[s];
    if (e < minElev) minElev = e;
    if (e > maxElev) maxElev = e;
  }
  if (!isFinite(minElev)) { minElev = 0; maxElev = 0; }
  const zScale = horizontalScale * exaggeration;
  const topZ = new Float32Array(elev.length);
  let maxZ = baseMM;
  for (let s = 0; s < elev.length; s++) {
    const z = baseMM + Math.max(0, elev[s] - minElev) * zScale;
    topZ[s] = z;
    if (mask[s] && z > maxZ) maxZ = z;
  }
  return { topZ, minElev, maxElev, maxZ };
}
