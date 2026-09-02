/**
 * 2D map rendering controller — loaded on demand (dynamic import) the first
 * time the rendering panel is switched to "2D map" mode. Owns all wiring for
 * the topo/contour renderer: style, layers, furniture, sizing (fit-selection /
 * paper / custom in px or mm), map exports (SVG/PNG/PDF), and layered cut
 * sheets (SVG/DXF/PDF).
 */
import { buildTopoSVG, buildCutSheets } from './topomap.js';
import { toPDFMultiJPEG, toDXF } from './exporters.js';
import { bboxDimensionsMeters, buildSelectionMask } from './selection.js';
import { fetchElevationGrid } from './elevation.js';

const PAPER_MM = { a4p: [210, 297], a4l: [297, 210], a3p: [297, 420], a3l: [420, 297], letp: [215.9, 279.4], letl: [279.4, 215.9] };
const SCREEN_DPI = 96;

/**
 * @param {Object} ctx hooks provided by the app:
 *   getSelection(), getSourceId(), getApiKey(), getPlaceName(),
 *   fetchWaterFeatures(bbox, onProgress), download(data, name, mime),
 *   zipDownload(files, name)
 */
export function initTopo2D(ctx) {
  const $ = (id) => document.getElementById(id);
  let result = null; // last render: svg + page + grid data for cut sheets

  const info = (msg) => { $('topo-info').textContent = msg; };

  // -- sizing ---------------------------------------------------------------

  function sizeMode() {
    return document.querySelector('input[name=topo-size-mode]:checked')?.value || 'fit';
  }

  function syncSizeUI() {
    const mode = sizeMode();
    $('topo-fit-sub').style.display = mode === 'fit' ? 'block' : 'none';
    $('topo-paper-sub').style.display = mode === 'paper' ? 'block' : 'none';
    $('topo-custom-sub').style.display = mode === 'custom' ? 'block' : 'none';
    const usesDpi = mode === 'paper' ||
      (mode === 'fit' && $('topo-fit-unit').value === 'mm') ||
      (mode === 'custom' && $('topo-custom-unit').value === 'mm');
    $('topo-dpi-row').style.display = usesDpi ? 'flex' : 'none';
  }
  document.querySelectorAll('input[name=topo-size-mode]').forEach((r) => r.addEventListener('change', syncSizeUI));
  $('topo-fit-unit').addEventListener('change', syncSizeUI);
  $('topo-custom-unit').addEventListener('change', syncSizeUI);
  syncSizeUI();

  /** Resolve page pixels + physical mm from the sizing controls + selection. */
  function pageSize(sel) {
    const mode = sizeMode();
    const dpi = parseInt($('topo-dpi').value, 10) || 150;
    const clampPx = (v) => Math.max(50, Math.min(12000, Math.round(v)));
    if (mode === 'paper') {
      const [mmW, mmH] = PAPER_MM[$('topo-paper').value] || PAPER_MM.a4l;
      return { pageW: clampPx((mmW / 25.4) * dpi), pageH: clampPx((mmH / 25.4) * dpi), dpi, paperMMW: mmW, paperMMH: mmH };
    }
    if (mode === 'custom') {
      const w = parseFloat($('topo-px-w').value) || 1600;
      const h = parseFloat($('topo-px-h').value) || 1200;
      if ($('topo-custom-unit').value === 'mm') {
        return { pageW: clampPx((w / 25.4) * dpi), pageH: clampPx((h / 25.4) * dpi), dpi, paperMMW: w, paperMMH: h };
      }
      return { pageW: clampPx(w), pageH: clampPx(h), dpi: SCREEN_DPI, paperMMW: (w / SCREEN_DPI) * 25.4, paperMMH: (h / SCREEN_DPI) * 25.4 };
    }
    // fit: aspect follows the selection bbox
    const { width, height } = bboxDimensionsMeters(sel.bbox);
    const aspect = height / Math.max(1e-9, width);
    const long = parseFloat($('topo-fit-long').value) || 2000;
    const unit = $('topo-fit-unit').value;
    const effDpi = unit === 'mm' ? dpi : SCREEN_DPI;
    const longPx = unit === 'mm' ? (long / 25.4) * dpi : long;
    const pageW = clampPx(aspect <= 1 ? longPx : longPx / aspect);
    const pageH = clampPx(aspect <= 1 ? longPx * aspect : longPx);
    return { pageW, pageH, dpi: effDpi, paperMMW: (pageW / effDpi) * 25.4, paperMMH: (pageH / effDpi) * 25.4 };
  }

  // -- style preset ---------------------------------------------------------

  $('topo-style').addEventListener('change', () => {
    const lineArt = $('topo-style').value === 'lineart';
    $('topo-hillshade').checked = !lineArt;
    $('topo-hypso').checked = !lineArt;
    if (lineArt) $('topo-contours').checked = true;
  });

  // -- render ---------------------------------------------------------------

  async function render() {
    const sel = ctx.getSelection();
    if (!sel) {
      info('Draw a selection on the map first.');
      return;
    }
    const btn = $('btn-topo-render');
    btn.disabled = true;
    info('Rendering…');
    try {
      if (!$('topo-title-text').value && ctx.getPlaceName()) $('topo-title-text').value = ctx.getPlaceName();
      const { pageW, pageH, dpi, paperMMW, paperMMH } = pageSize(sel);
      // Sample the DEM at a fixed high resolution independent of model settings.
      const { width, height } = bboxDimensionsMeters(sel.bbox);
      const aspect = height / Math.max(1e-9, width);
      const gridW = aspect <= 1 ? 512 : Math.max(2, Math.round(512 / aspect));
      const gridH = aspect <= 1 ? Math.max(2, Math.round(512 * aspect)) : 512;
      const { elev } = await fetchElevationGrid(ctx.getSourceId(), sel.bbox, gridW, gridH, {
        apiKey: ctx.getApiKey(),
        onProgress: info,
      });
      let waterLines = [], waterPolys = [];
      if ($('topo-water').checked) {
        try {
          const feats = await ctx.fetchWaterFeatures(sel.bbox, info);
          waterLines = feats.lines;
          waterPolys = feats.polys;
        } catch (err) {
          console.warn('Water fetch failed', err);
        }
      }
      info('Drawing map…');
      // Same mask as the 3D pipeline: the map is clipped to the selection shape.
      const mask = buildSelectionMask(sel, gridW, gridH);
      const opts = {
        contours: $('topo-contours').checked,
        contourInterval: parseFloat($('topo-interval').value) || 0,
        contourLabels: $('topo-labels').checked,
        lineArt: $('topo-style').value === 'lineart',
        hillshade: $('topo-hillshade').checked,
        hypso: $('topo-hypso').checked,
        water: $('topo-water').checked,
        title: $('topo-title').checked,
        titleText: $('topo-title-text').value.trim() || 'Topographic Map',
        scaleBar: $('topo-scalebar').checked,
        grid: $('topo-grid').checked,
        legend: $('topo-legend').checked,
        frame: $('topo-frame').checked,
        transparentBg: $('topo-transparent').checked,
        dpi,
        paperMMW,
      };
      const trailLines = ctx.getRoute()?.lines || [];
      const { svg, contourInterval, scaleRatio } = buildTopoSVG({
        elev, W: gridW, H: gridH, bbox: sel.bbox, pageW, pageH, opts, waterLines, waterPolys, mask, trailLines,
      });
      result = {
        svg, pageW, pageH, dpi, paperMMW, paperMMH,
        elev, gridW, gridH, bbox: [...sel.bbox], mask, trailLines,
        transparent: opts.transparentBg,
        titleText: opts.titleText,
        name: (opts.titleText || 'topo-map').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      };
      const img = $('topo-preview-img');
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      img.dataset.url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      img.src = img.dataset.url;
      const mmLabel = `${Math.round(paperMMW)} × ${Math.round(paperMMH)} mm`;
      info(`${pageW} × ${pageH} px (${mmLabel}) · contours every ${contourInterval} m · scale ≈ 1:${scaleRatio.toLocaleString()}`);
      ['btn-topo-svg', 'btn-topo-png', 'btn-topo-pdf', 'btn-cut-svg', 'btn-cut-dxf', 'btn-cut-pdf'].forEach((id) => { $(id).disabled = false; });
    } catch (err) {
      console.error(err);
      info(`Failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }
  $('btn-topo-render').addEventListener('click', render);

  // -- map exports ----------------------------------------------------------

  async function svgToCanvas(svg, pageW, pageH, transparent = false) {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = pageW;
    canvas.height = pageH;
    const cx2 = canvas.getContext('2d');
    if (!transparent) {
      cx2.fillStyle = '#ffffff';
      cx2.fillRect(0, 0, pageW, pageH);
    }
    cx2.drawImage(img, 0, 0, pageW, pageH);
    URL.revokeObjectURL(img.src);
    return canvas;
  }

  $('btn-topo-svg').addEventListener('click', () => {
    if (result) ctx.download(result.svg, `${result.name}.svg`, 'image/svg+xml');
  });
  $('btn-topo-png').addEventListener('click', async () => {
    if (!result) return;
    try {
      info('Rasterizing PNG…');
      const canvas = await svgToCanvas(result.svg, result.pageW, result.pageH, result.transparent);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      ctx.download(blob, `${result.name}.png`);
      info('PNG exported.');
    } catch (err) {
      info(`PNG export failed: ${err.message}`);
    }
  });
  $('btn-topo-pdf').addEventListener('click', async () => {
    if (!result) return;
    try {
      info('Building PDF…');
      const canvas = await svgToCanvas(result.svg, result.pageW, result.pageH);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const wPt = (result.paperMMW / 25.4) * 72;
      const hPt = (result.paperMMH / 25.4) * 72;
      ctx.download(toPDFMultiJPEG([{ jpeg, pxW: canvas.width, pxH: canvas.height }], wPt, hPt, result.titleText), `${result.name}.pdf`, 'application/pdf');
      info('PDF exported.');
    } catch (err) {
      info(`PDF export failed: ${err.message}`);
    }
  });

  // -- layered cut sheets ---------------------------------------------------

  function buildSheets() {
    const { elev, gridW, gridH, bbox, pageW, pageH, paperMMW, titleText } = result;
    const sheets = buildCutSheets({
      elev, W: gridW, H: gridH, bbox, pageW, pageH, paperMMW, mask: result.mask, trailLines: result.trailLines,
      interval: parseFloat($('topo-interval').value) || 0,
      title: titleText,
    });
    if (!sheets.sheets.length) throw new Error('No layers produced — try a smaller contour interval.');
    return sheets;
  }

  $('btn-cut-svg').addEventListener('click', () => {
    if (!result) return;
    try {
      const { sheets, interval } = buildSheets();
      const files = {};
      for (const s of sheets) files[`${s.name}.svg`] = s.svg;
      ctx.zipDownload(files, `${result.name}-cut-sheets.zip`);
      info(`Exported ${sheets.length} cut sheets (SVG) at ${interval} m per layer.`);
    } catch (err) {
      info(`Cut sheets failed: ${err.message}`);
    }
  });
  $('btn-cut-dxf').addEventListener('click', () => {
    if (!result) return;
    try {
      const { sheets, interval, trailMM } = buildSheets();
      const files = {};
      for (const s of sheets) {
        const paths = [
          ...s.cutLoops.map((pts) => ({ pts, layer: 'CUT', closed: true })),
          ...s.guideLoops.map((pts) => ({ pts, layer: 'GUIDE', closed: true })),
          ...trailMM.map((pts) => ({ pts, layer: 'TRAIL', closed: false })),
        ];
        files[`${s.name}.dxf`] = toDXF(paths, result.paperMMH);
      }
      ctx.zipDownload(files, `${result.name}-cut-sheets-dxf.zip`);
      info(`Exported ${sheets.length} cut sheets (DXF, mm) at ${interval} m per layer.`);
    } catch (err) {
      info(`Cut sheets failed: ${err.message}`);
    }
  });
  $('btn-cut-pdf').addEventListener('click', async () => {
    if (!result) return;
    try {
      const { sheets, interval } = buildSheets();
      info(`Rasterizing ${sheets.length} sheets…`);
      const pages = [];
      for (const s of sheets) {
        const canvas = await svgToCanvas(s.svg, result.pageW, result.pageH);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), pxW: canvas.width, pxH: canvas.height });
      }
      const wPt = (result.paperMMW / 25.4) * 72;
      const hPt = (result.paperMMH / 25.4) * 72;
      ctx.download(toPDFMultiJPEG(pages, wPt, hPt, `${result.titleText} cut sheets`), `${result.name}-cut-sheets.pdf`, 'application/pdf');
      info(`Exported ${sheets.length}-page cut-sheet PDF at ${interval} m per layer.`);
    } catch (err) {
      info(`Cut sheets failed: ${err.message}`);
    }
  });

  info('Configure the map, then hit Render.');
  return {
    onSelectionChange(sel) {
      $('btn-topo-render').disabled = !sel;
    },
  };
}
