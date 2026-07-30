import { buildTerrainSolid, meshVolume } from '../js/mesh.js';
import { interlockedTileFilters } from '../js/heightops.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

function analyze({ indices }) {
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) degenerate++;
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cur = edges.get(key) || { n: 0, dir: 0 };
      cur.n++;
      cur.dir += a < b ? 1 : -1;
      edges.set(key, cur);
    }
  }
  let bad = 0, badWind = 0;
  for (const { n, dir } of edges.values()) {
    if (n !== 2) bad++;
    else if (dir !== 0) badWind++;
  }
  return { bad, badWind, degenerate };
}

function grid(W, H, topFn, maskFn = () => true, botFn = null) {
  const topZ = new Float32Array(W * H);
  const botZ = botFn ? new Float32Array(W * H) : null;
  const mask = new Uint8Array(W * H);
  const xs = new Float32Array(W), ys = new Float32Array(H);
  for (let i = 0; i < W; i++) xs[i] = i * 1.5;
  for (let j = 0; j < H; j++) ys[j] = j * 1.5;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const s = i + j * W;
      topZ[s] = topFn(i, j);
      mask[s] = maskFn(i, j) ? 1 : 0;
      if (botZ) botZ[s] = botFn(i, j);
    }
  }
  return { width: W, height: H, topZ, botZ, mask, xs, ys };
}

function compareOptimized(name, g) {
  const opt = buildTerrainSolid({ ...g, optimizeFlat: true });
  const raw = buildTerrainSolid({ ...g, optimizeFlat: false });
  const aOpt = analyze(opt), aRaw = analyze(raw);
  check(`${name}: optimized watertight`, aOpt.bad === 0 && aOpt.badWind === 0 && aOpt.degenerate === 0,
    JSON.stringify(aOpt));
  check(`${name}: unoptimized watertight`, aRaw.bad === 0 && aRaw.badWind === 0);
  const vOpt = meshVolume(opt.positions, opt.indices);
  const vRaw = meshVolume(raw.positions, raw.indices);
  check(`${name}: volumes match (${vOpt.toFixed(2)})`, Math.abs(vOpt - vRaw) / Math.abs(vRaw) < 1e-5,
    `${vOpt} vs ${vRaw}`);
  return { opt, raw };
}

// 1. Fully flat model — big decimation expected
{
  const g = grid(40, 30, () => 5);
  const { opt, raw } = compareOptimized('flat-40x30', g);
  check('flat-40x30: strong triangle reduction', opt.triangleCount < raw.triangleCount / 4,
    `${opt.triangleCount} vs ${raw.triangleCount}`);
}

// 2. Mixed: flat "water" at 3 around a varying island
{
  const g = grid(48, 48, (i, j) => {
    const d = Math.hypot(i - 24, j - 24);
    return d < 12 ? 3 + (12 - d) * 0.7 + Math.sin(i) * 0.2 : 3;
  });
  const { opt, raw } = compareOptimized('island-in-flat-sea', g);
  check('island-in-flat-sea: reduction on flat parts', opt.triangleCount < raw.triangleCount * 0.75,
    `${opt.triangleCount} vs ${raw.triangleCount}`);
}

// 3. Contour-terrace style top (many flat bands)
{
  const g = grid(40, 40, (i, j) => 2 + Math.floor((i + j) / 10) * 2);
  compareOptimized('terraced', g);
}

// 4. Circle mask with flat top and engraved (non-flat) bottom
{
  const g = grid(41, 41, () => 6, (i, j) => Math.hypot(i - 20, j - 20) <= 18,
    (i, j) => (i > 12 && i < 28 && j > 16 && j < 24 ? 0.8 : 0));
  const { opt } = compareOptimized('engraved-bottom-circle', g);
  let minZ = Infinity;
  for (let v = 2; v < opt.positions.length; v += 3) minZ = Math.min(minZ, opt.positions[v]);
  check('engraved-bottom-circle: engraving raised the floor locally', minZ === 0);
}

// 5. Donut mask, flat top (interior walls + fans coexist)
{
  const g = grid(44, 44, () => 4, (i, j) => {
    const d = Math.hypot(i - 22, j - 22);
    return d <= 20 && d > 7;
  });
  compareOptimized('flat-donut', g);
}

// 6. Interlocked tile filters: partition, watertightness, volume conservation, tabs
{
  const W = 121, H = 91;
  const g = grid(W, H, (i, j) => 3 + Math.sin(i * 0.2) + Math.cos(j * 0.25));
  const cellW = W - 1, cellH = H - 1;
  const filters = interlockedTileFilters(cellW, cellH, 2, 2);
  check('interlock: 4 filters', filters.length === 4);
  const owners = new Int8Array(cellW * cellH).fill(-1);
  let overlap = false;
  filters.forEach((f, t) => {
    for (let c = 0; c < f.length; c++) {
      if (f[c]) {
        if (owners[c] !== -1) overlap = true;
        owners[c] = t;
      }
    }
  });
  check('interlock: filters are a strict partition', !overlap && ![...owners].includes(-1));

  // tabs: ownership must deviate from the straight-cut partition somewhere
  const cutX = Math.round(cellW / 2), cutY = Math.round(cellH / 2);
  let tabCells = 0;
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const straight = (j < cutY ? 0 : 2) + (i < cutX ? 0 : 1);
      if (owners[i + j * cellW] !== straight) tabCells++;
    }
  }
  check('interlock: tabs deviate from straight cuts', tabCells > 20, `cells=${tabCells}`);

  const whole = buildTerrainSolid(g);
  const vWhole = meshVolume(whole.positions, whole.indices);
  let vSum = 0, allTight = true;
  for (const f of filters) {
    const m = buildTerrainSolid({ ...g, cellFilter: f });
    const a = analyze(m);
    allTight = allTight && a.bad === 0 && a.badWind === 0;
    vSum += meshVolume(m.positions, m.indices);
  }
  check('interlock: each tile watertight', allTight);
  check('interlock: tile volumes sum to whole', Math.abs(vSum - vWhole) / vWhole < 1e-5, `${vSum} vs ${vWhole}`);
}

// 7. 3x3 interlock partition sanity
{
  const filters = interlockedTileFilters(150, 150, 3, 3);
  const owners = new Int8Array(150 * 150).fill(-1);
  let overlap = false;
  filters.forEach((f, t) => {
    for (let c = 0; c < f.length; c++) if (f[c]) { if (owners[c] !== -1) overlap = true; owners[c] = t; }
  });
  check('interlock 3x3: strict partition', !overlap && ![...owners].includes(-1));
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll mesh2 checks passed.');
