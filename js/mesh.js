/**
 * Watertight terrain solid generation from a masked heightmap grid.
 *
 * Grid convention: samples are indexed (i, j) with i = column (0..W-1, west->east)
 * and j = row (0..H-1, south->north). Sample index = i + j * W.
 * A cell (i, j) spans samples (i,j)..(i+1,j+1) and is "solid" only when all four
 * of its corner samples are inside the selection mask. Solid cells get a top
 * surface, a bottom surface at z = 0, and walls along every edge that borders a
 * non-solid cell (or the grid boundary), producing a closed, printable solid.
 */

/**
 * @param {Object} opts
 * @param {number} opts.width   number of samples per row (W)
 * @param {number} opts.height  number of rows (H)
 * @param {Float32Array|number[]} opts.topZ  top surface z in model units, per sample
 * @param {Uint8Array|boolean[]} opts.mask   1 = sample inside selection
 * @param {Float32Array|number[]} opts.xs    model-space x per column, length W
 * @param {Float32Array|number[]} opts.ys    model-space y per row, length H
 * @returns {{positions: Float32Array, indices: Uint32Array, triangleCount: number, vertexCount: number}}
 */
export function buildTerrainSolid({ width: W, height: H, topZ, mask, xs, ys }) {
  const cellW = W - 1;
  const cellH = H - 1;
  const solid = new Uint8Array(cellW * cellH);
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const a = i + j * W;
      if (mask[a] && mask[a + 1] && mask[a + W] && mask[a + W + 1]) {
        solid[i + j * cellW] = 1;
      }
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
      positions.push(xs[i], ys[j], 0);
    }
    return botIdx[s];
  };
  const isSolid = (i, j) =>
    i >= 0 && j >= 0 && i < cellW && j < cellH && solid[i + j * cellW] === 1;

  // Wall for the directed boundary edge p->q (CCW around the top face):
  // outward-facing quad split along the tp-bq diagonal.
  const wall = (tp, tq, bp, bq) => {
    indices.push(tp, bq, tq, tp, bp, bq);
  };

  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      if (!solid[i + j * cellW]) continue;
      // Corners CCW seen from above: a = SW, b = SE, c = NE, d = NW.
      const Ta = getTop(i, j), Tb = getTop(i + 1, j), Tc = getTop(i + 1, j + 1), Td = getTop(i, j + 1);
      const Ba = getBot(i, j), Bb = getBot(i + 1, j), Bc = getBot(i + 1, j + 1), Bd = getBot(i, j + 1);

      indices.push(Ta, Tb, Tc, Ta, Tc, Td); // top, normal +z
      indices.push(Ba, Bc, Bb, Ba, Bd, Bc); // bottom, normal -z

      if (!isSolid(i, j - 1)) wall(Ta, Tb, Ba, Bb); // south edge a->b
      if (!isSolid(i + 1, j)) wall(Tb, Tc, Bb, Bc); // east edge b->c
      if (!isSolid(i, j + 1)) wall(Tc, Td, Bc, Bd); // north edge c->d
      if (!isSolid(i - 1, j)) wall(Td, Ta, Bd, Ba); // west edge d->a
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
