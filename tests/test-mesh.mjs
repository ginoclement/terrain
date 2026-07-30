import { buildTerrainSolid, elevationsToModelZ } from '../js/mesh.js';
import { toBinarySTL, toAsciiSTL, toOBJ, toPLY, to3MFFiles } from '../js/exporters.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

function makeGrid(W, H, maskFn, elevFn) {
  const mask = new Uint8Array(W * H);
  const elev = new Float32Array(W * H);
  const xs = new Float32Array(W);
  const ys = new Float32Array(H);
  for (let i = 0; i < W; i++) xs[i] = i * 2;
  for (let j = 0; j < H; j++) ys[j] = j * 2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const s = i + j * W;
      mask[s] = maskFn(i, j) ? 1 : 0;
      elev[s] = elevFn(i, j);
    }
  }
  return { W, H, mask, elev, xs, ys };
}

// Watertight = every undirected edge is used by exactly two triangles, with
// opposite directions (consistent winding), and no degenerate triangles.
function analyzeMesh({ positions, indices }) {
  const edgeCounts = new Map();
  let degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) degenerate++;
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const dir = a < b ? 1 : -1;
      const cur = edgeCounts.get(key) || { count: 0, dirSum: 0 };
      cur.count++;
      cur.dirSum += dir;
      edgeCounts.set(key, cur);
    }
  }
  let bad = 0, badWinding = 0;
  for (const { count, dirSum } of edgeCounts.values()) {
    if (count !== 2) bad++;
    else if (dirSum !== 0) badWinding++;
  }
  return { badEdges: bad, badWinding, degenerate, edges: edgeCounts.size };
}

// Signed volume via divergence theorem — must be positive for outward winding.
function signedVolume({ positions, indices }) {
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

function runCase(name, W, H, maskFn, elevFn) {
  console.log(`case: ${name}`);
  const g = makeGrid(W, H, maskFn, elevFn);
  const { topZ } = elevationsToModelZ(g.elev, g.mask, 0.5, 1.5, 3);
  const mesh = buildTerrainSolid({ width: W, height: H, topZ, mask: g.mask, xs: g.xs, ys: g.ys });
  const a = analyzeMesh(mesh);
  check(`${name}: has triangles`, mesh.triangleCount > 0);
  check(`${name}: watertight (all edges shared by 2 tris)`, a.badEdges === 0, `bad=${a.badEdges}/${a.edges}`);
  check(`${name}: consistent winding`, a.badWinding === 0, `bad=${a.badWinding}`);
  check(`${name}: no degenerate triangles`, a.degenerate === 0, `n=${a.degenerate}`);
  const vol = signedVolume(mesh);
  check(`${name}: positive enclosed volume`, vol > 0, `vol=${vol}`);
  return mesh;
}

// 1. Full rectangle
const rectMesh = runCase('full-rect', 12, 9, () => true, (i, j) => 100 + 10 * Math.sin(i * 0.7) * Math.cos(j * 0.5));

// 2. Circle mask
runCase('circle', 21, 21, (i, j) => (i - 10) ** 2 + (j - 10) ** 2 <= 81, (i, j) => 50 + i + j);

// 3. Mask with a hole (donut) — interior walls must also close
runCase('donut', 25, 25, (i, j) => {
  const d2 = (i - 12) ** 2 + (j - 12) ** 2;
  return d2 <= 121 && d2 > 16;
}, (i, j) => 200 + 5 * Math.sin(i) + 3 * Math.cos(j));

// 4. Two disjoint islands touching diagonally
runCase('diagonal-islands', 10, 10, (i, j) => (i < 5 && j < 5) || (i >= 4 && j >= 4), () => 10);

// 5. Flat zero-relief terrain (all elevations equal)
runCase('flat', 8, 8, () => true, () => 42);

// Exporter sanity on the rect mesh
console.log('case: exporters');
const stlBin = toBinarySTL(rectMesh.positions, rectMesh.indices);
check('binary STL size matches triangle count', stlBin.byteLength === 84 + rectMesh.triangleCount * 50);
check('binary STL declares triangle count', new DataView(stlBin).getUint32(80, true) === rectMesh.triangleCount);

const stlAscii = toAsciiSTL(rectMesh.positions, rectMesh.indices, 'test');
check('ascii STL facet count', (stlAscii.match(/facet normal/g) || []).length === rectMesh.triangleCount);
check('ascii STL closes solid', stlAscii.trim().endsWith('endsolid test'));

const obj = toOBJ(rectMesh.positions, rectMesh.indices, 'test');
check('OBJ vertex count', (obj.match(/^v /gm) || []).length === rectMesh.vertexCount);
check('OBJ face count', (obj.match(/^f /gm) || []).length === rectMesh.triangleCount);
check('OBJ faces are 1-indexed and in range', (() => {
  for (const m of obj.matchAll(/^f (\d+) (\d+) (\d+)$/gm)) {
    for (let k = 1; k <= 3; k++) {
      const idx = +m[k];
      if (idx < 1 || idx > rectMesh.vertexCount) return false;
    }
  }
  return true;
})());

const ply = toPLY(rectMesh.positions, rectMesh.indices, 'test');
const plyBytes = new Uint8Array(ply);
const plyMarker = new TextEncoder().encode('end_header\n');
let plyHeaderLen = -1;
outer: for (let i = 0; i < plyBytes.length - plyMarker.length; i++) {
  for (let k = 0; k < plyMarker.length; k++) if (plyBytes[i + k] !== plyMarker[k]) continue outer;
  plyHeaderLen = i + plyMarker.length;
  break;
}
check('PLY size matches header + data', ply.byteLength === plyHeaderLen + rectMesh.vertexCount * 12 + rectMesh.triangleCount * 13);

const files = to3MFFiles(rectMesh.positions, rectMesh.indices, 'test');
check('3MF has all 3 package files', Object.keys(files).length === 3 && files['3D/3dmodel.model'] && files['[Content_Types].xml'] && files['_rels/.rels']);
check('3MF model vertex count', (files['3D/3dmodel.model'].match(/<vertex /g) || []).length === rectMesh.vertexCount);
check('3MF model triangle count', (files['3D/3dmodel.model'].match(/<triangle /g) || []).length === rectMesh.triangleCount);

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed.');
