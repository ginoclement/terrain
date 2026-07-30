import { buildTerrainSolid } from '../js/mesh.js';
import { to3MFColorFiles, toGLB } from '../js/exporters.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

// Small test mesh
const W = 12, H = 10;
const topZ = new Float32Array(W * H).map((_, s) => 3 + (s % W) * 0.2);
const mask = new Uint8Array(W * H).fill(1);
const xs = new Float32Array(W).map((_, i) => i);
const ys = new Float32Array(H).map((_, j) => j);
const mesh = buildTerrainSolid({ width: W, height: H, topZ, mask, xs, ys });

// --- color 3MF ---
const palette = ['#204020', '#608040', '#a0a080', '#e0e0e0'];
const triMat = new Uint8Array(mesh.triangleCount).map((_, k) => k % palette.length);
const files = to3MFColorFiles(mesh.positions, mesh.indices, palette, triMat, 'test');
const model = files['3D/3dmodel.model'];
check('color 3MF: has basematerials with all palette entries', (model.match(/<base /g) || []).length === palette.length);
check('color 3MF: every triangle has a material ref', (model.match(/pid="2" p1="/g) || []).length === mesh.triangleCount);
check('color 3MF: object references material group', model.includes('pid="2" pindex="0"'));
check('color 3MF: vertex count', (model.match(/<vertex /g) || []).length === mesh.vertexCount);
check('color 3MF: package files present', !!files['[Content_Types].xml'] && !!files['_rels/.rels']);

// --- GLB, untextured ---
function parseGLB(buf) {
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const total = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  const jsonType = dv.getUint32(16, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binLenOff = 20 + jsonLen;
  const binLen = dv.getUint32(binLenOff, true);
  const binType = dv.getUint32(binLenOff + 4, true);
  return { magic, version, total, jsonType, binType, binLen, json, declaredTotalOk: total === buf.byteLength };
}

const glbPlain = toGLB(mesh.positions, mesh.indices, null, null, 'test');
let g = parseGLB(glbPlain);
check('GLB plain: magic/version', g.magic === 0x46546c67 && g.version === 2);
check('GLB plain: chunk types', g.jsonType === 0x4e4f534a && g.binType === 0x004e4942);
check('GLB plain: total length matches', g.declaredTotalOk);
check('GLB plain: accessor counts', g.json.accessors[0].count === mesh.vertexCount && g.json.accessors[1].count === mesh.indices.length);
check('GLB plain: buffer length matches bin chunk', g.json.buffers[0].byteLength === g.binLen);
check('GLB plain: json parses with mesh+material', g.json.meshes?.length === 1 && g.json.materials?.length === 1);
check('GLB plain: 4-byte aligned chunks', g.binLen % 4 === 0 && (20 + g.json ? (glbPlain.byteLength - 0) % 4 === 0 : false));

// --- GLB, textured ---
// minimal 1x1 PNG
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), (c) => c.charCodeAt(0));
const uvs = new Float32Array(mesh.vertexCount * 2).map(() => Math.random());
const glbTex = toGLB(mesh.positions, mesh.indices, uvs, PNG_1PX, 'test');
g = parseGLB(glbTex);
check('GLB textured: valid container', g.magic === 0x46546c67 && g.declaredTotalOk);
check('GLB textured: has texture/image/sampler', g.json.textures?.length === 1 && g.json.images?.length === 1 && g.json.samplers?.length === 1);
check('GLB textured: TEXCOORD_0 wired', g.json.meshes[0].primitives[0].attributes.TEXCOORD_0 !== undefined);
check('GLB textured: material uses texture', g.json.materials[0].pbrMetallicRoughness.baseColorTexture?.index === 0);
// PNG bytes recoverable from bin chunk at image bufferView
{
  const iv = g.json.bufferViews[g.json.images[0].bufferView];
  const binStart = 20 + new DataView(glbTex).getUint32(12, true) + 8;
  const png = new Uint8Array(glbTex, binStart + iv.byteOffset, iv.byteLength);
  check('GLB textured: embedded PNG magic', png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll exporter2 checks passed.');
