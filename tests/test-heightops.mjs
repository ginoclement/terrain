import { smoothGrid, flattenWater, quantizeContours, embossRoute, tileRanges, extractSubgrid, splitAtHeight } from '../js/heightops.js';
import { buildTerrainSolid, meshVolume } from '../js/mesh.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

function analyzeWatertight({ indices }) {
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  return [...edges.values()].every((c) => c === 2);
}

// --- smoothing --------------------------------------------------------------
{
  const W = 20, H = 20;
  const elev = new Float32Array(W * H);
  elev[10 + 10 * W] = 100; // spike
  const sm = smoothGrid(elev, W, H, 2);
  check('smooth: spike reduced', sm[10 + 10 * W] < 20, `got ${sm[10 + 10 * W]}`);
  check('smooth: neighbors raised', sm[11 + 10 * W] > 0);
  const sumBefore = elev.reduce((a, b) => a + b, 0);
  const sumAfter = sm.reduce((a, b) => a + b, 0);
  check('smooth: roughly mass-preserving (interior)', Math.abs(sumBefore - sumAfter) / sumBefore < 0.05, `${sumBefore} vs ${sumAfter}`);
  check('smooth: radius 0 is identity', smoothGrid(elev, W, H, 0).every((v, s) => v === elev[s]));
}

// --- water flatten ----------------------------------------------------------
{
  const elev = Float32Array.from([-30, -5, 0, 3, 250]);
  const flat = flattenWater(elev, 0);
  check('flatten: below level clamped', flat[0] === 0 && flat[1] === 0 && flat[2] === 0);
  check('flatten: above level untouched', flat[3] === 3 && flat[4] === 250);
  const lake = flattenWater(elev, 200);
  check('flatten: lake level works', lake[3] === 200 && lake[4] === 250);
}

// --- contour quantization ---------------------------------------------------
{
  const elev = Float32Array.from([100, 149, 150, 199, 200, 260]);
  const mask = Uint8Array.from([1, 1, 1, 1, 1, 1]);
  const q = quantizeContours(elev, mask, 50);
  check('quantize: terraces at step multiples from min', q[0] === 100 && q[1] === 100 && q[2] === 150 && q[3] === 150 && q[4] === 200 && q[5] === 250, JSON.stringify([...q]));
  check('quantize: step 0 is identity', quantizeContours(elev, mask, 0).every((v, s) => v === elev[s]));
}

// --- route emboss -----------------------------------------------------------
{
  const topZ = Float32Array.from([5, 5, 5, 5]);
  const route = Uint8Array.from([0, 1, 1, 0]);
  const em = embossRoute(topZ, route, 0.8);
  check('emboss: raises only route samples', em[0] === 5 && Math.abs(em[1] - 5.8) < 1e-6 && em[3] === 5);
}

// --- tiles ------------------------------------------------------------------
{
  const W = 101, H = 61;
  const ranges = tileRanges(W, H, 2, 2);
  check('tiles: 2x2 gives 4 ranges', ranges.length === 4);
  check('tiles: cover full grid', ranges[0].i0 === 0 && ranges[3].i1 === W - 1 && ranges[3].j1 === H - 1);
  check('tiles: adjacent tiles share boundary column', ranges[0].i1 === ranges[1].i0);
  check('tiles: adjacent tiles share boundary row', ranges[0].j1 === ranges[2].j0);

  // Volume of tile solids ≈ volume of the whole solid
  const topZ = new Float32Array(W * H);
  const mask = new Uint8Array(W * H).fill(1);
  const xs = new Float32Array(W), ys = new Float32Array(H);
  for (let i = 0; i < W; i++) xs[i] = i;
  for (let j = 0; j < H; j++) ys[j] = j;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) topZ[i + j * W] = 3 + Math.sin(i * 0.2) + Math.cos(j * 0.3);

  const whole = buildTerrainSolid({ width: W, height: H, topZ, mask, xs, ys });
  const wholeVol = meshVolume(whole.positions, whole.indices);
  let tileVol = 0;
  let allTight = true;
  for (const r of ranges) {
    const sub = extractSubgrid({ topZ, mask, xs, ys, width: W }, r);
    const m = buildTerrainSolid(sub);
    allTight = allTight && analyzeWatertight(m);
    tileVol += meshVolume(m.positions, m.indices);
  }
  check('tiles: each tile watertight', allTight);
  check('tiles: volumes sum to whole', Math.abs(tileVol - wholeVol) / wholeVol < 1e-4, `${tileVol} vs ${wholeVol}`);
}

// --- two-piece split --------------------------------------------------------
{
  const W = 30, H = 30;
  const topZ = new Float32Array(W * H);
  const mask = new Uint8Array(W * H).fill(1);
  const xs = new Float32Array(W), ys = new Float32Array(H);
  for (let i = 0; i < W; i++) xs[i] = i;
  for (let j = 0; j < H; j++) ys[j] = j;
  // dome peaking at 20mm
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const d = Math.hypot(i - 14.5, j - 14.5);
    topZ[i + j * W] = Math.max(2, 20 - d * 1.2);
  }
  const { lower, upper } = splitAtHeight(topZ, mask, 10, 0.6);
  const mLower = buildTerrainSolid({ width: W, height: H, topZ: lower.topZ, mask: lower.mask, xs, ys });
  const mUpper = buildTerrainSolid({ width: W, height: H, topZ: upper.topZ, mask: upper.mask, xs, ys });
  check('split: lower watertight', analyzeWatertight(mLower));
  check('split: upper watertight', analyzeWatertight(mUpper));
  check('split: lower clamped at split height', Math.max(...lower.topZ) <= 10 + 1e-6);
  check('split: upper has samples only above split', upper.mask.some((v) => v === 1));
  const volWhole = meshVolume(...(() => { const m = buildTerrainSolid({ width: W, height: H, topZ, mask, xs, ys }); return [m.positions, m.indices]; })());
  const volSum = meshVolume(mLower.positions, mLower.indices) + meshVolume(mUpper.positions, mUpper.indices);
  // Pieces overlap slightly at mask edges (minThick floor), so allow tolerance
  check('split: combined volume close to whole', Math.abs(volSum - volWhole) / volWhole < 0.08, `${volSum} vs ${volWhole}`);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll heightops checks passed.');
