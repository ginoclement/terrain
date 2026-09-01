import { niceStep, contourLevels, traceContours, polylineLength } from '../js/topomap.js';
import { toPDFWithJPEG } from '../js/exporters.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

// --- niceStep ---
check('niceStep basics', niceStep(37) === 50 && niceStep(120) === 200 && niceStep(9) === 10 && niceStep(0.23) === 0.25);
check('niceStep exact powers', niceStep(1) === 1 && niceStep(10) === 10 && niceStep(0.5) === 0.5);

// --- contourLevels ---
check('contourLevels aligned to multiples', JSON.stringify(contourLevels(123, 480, 100)) === JSON.stringify([200, 300, 400]));
check('contourLevels includes negatives', JSON.stringify(contourLevels(-250, 120, 100)) === JSON.stringify([-200, -100, 0, 100]));

// --- traceContours on a cone: each level should be one closed loop ---
{
  const W = 61, H = 61;
  const elev = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      elev[i + j * W] = 100 - Math.hypot(i - 30, j - 30) * 2; // peak 100 at center
    }
  }
  for (const level of [50, 70, 90]) {
    const lines = traceContours(elev, W, H, level);
    check(`cone level ${level}: one contour`, lines.length === 1, `got ${lines.length}`);
    const pts = lines[0];
    const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
    check(`cone level ${level}: closed loop`, closed);
    // radius check: level = 100 - r*2 -> r = (100-level)/2
    const expectedR = (100 - level) / 2;
    let maxErr = 0;
    for (const [x, y] of pts) {
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(x - 30, y - 30) - expectedR));
    }
    check(`cone level ${level}: radius accurate`, maxErr < 0.8, `maxErr=${maxErr}`);
    check(`cone level ${level}: circumference plausible`, Math.abs(polylineLength(pts) - 2 * Math.PI * expectedR) < expectedR, `len=${polylineLength(pts)}`);
  }
}

// --- traceContours on a slope: straight open contours spanning the grid ---
{
  const W = 41, H = 21;
  const elev = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) elev[i + j * W] = i;
  const lines = traceContours(elev, W, H, 20.5);
  check('slope: single open line', lines.length === 1, `got ${lines.length}`);
  check('slope: spans full height', Math.abs(polylineLength(lines[0]) - (H - 1)) < 0.01);
  check('slope: at correct x', lines[0].every(([x]) => Math.abs(x - 20.5) < 1e-6));
}

// --- two peaks: two separate loops at a level between them ---
{
  const W = 81, H = 41;
  const elev = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const a = 100 - Math.hypot(i - 20, j - 20) * 4;
      const b = 100 - Math.hypot(i - 60, j - 20) * 4;
      elev[i + j * W] = Math.max(a, b, 0);
    }
  }
  const lines = traceContours(elev, W, H, 80);
  check('two peaks: two contours', lines.length === 2, `got ${lines.length}`);
}

// --- PDF structure ---
{
  const fakeJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
  const pdf = toPDFWithJPEG(fakeJpeg, 595.28, 841.89, 1240, 1754, 'Test Map');
  const text = new TextDecoder('latin1').decode(pdf);
  check('PDF: header', text.startsWith('%PDF-1.4'));
  check('PDF: has all 6 objects', [1, 2, 3, 4, 5, 6].every((n) => text.includes(`${n} 0 obj`)));
  check('PDF: DCTDecode image with dims', text.includes('/DCTDecode') && text.includes('/Width 1240') && text.includes('/Height 1754'));
  check('PDF: media box', text.includes('/MediaBox [0 0 595.28 841.89]'));
  check('PDF: trailer + EOF', text.includes('/Root 1 0 R') && text.trimEnd().endsWith('%%EOF'));
  // xref offsets must point at "N 0 obj"
  const xrefAt = text.indexOf('xref\n');
  const lines = text.slice(xrefAt).split('\n').slice(3, 9); // skip 'xref', count line, and the free entry
  let offsetsOk = true;
  lines.forEach((ln, k) => {
    const off = parseInt(ln.slice(0, 10), 10);
    const probe = new TextDecoder('latin1').decode(pdf.slice(off, off + 8));
    if (!probe.startsWith(`${k + 1} 0 obj`)) offsetsOk = false;
  });
  check('PDF: xref offsets point at objects', offsetsOk);
  check('PDF: jpeg embedded verbatim', text.includes('stream\n\xff\xd8\xff'));
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll topomap checks passed.');
