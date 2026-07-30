/**
 * Map selection tools: rectangle, square, circle, hexagon, freeform polygon,
 * and text/letters. Selections are stored in geographic coordinates and can be
 * rasterized into a boolean mask over any sample grid (used to cut the model).
 *
 * Works in both 2D and 3D terrain view — MapLibre reports terrain-aware
 * lng/lat for pointer events, so you can draw directly on tilted 3D terrain.
 */
import { setTextOverlay } from './mapview.js';

const M_PER_DEG_LAT = 111320;

function mPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Distance in meters between two lng/lat points (local flat approximation). */
export function localDistance(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(midLat);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function bboxDimensionsMeters(bbox) {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  return {
    width: (e - w) * mPerDegLon(midLat),
    height: (n - s) * M_PER_DEG_LAT,
  };
}

function circlePoints(center, radiusM, segments, phase = 0) {
  const [clon, clat] = center;
  const mLon = mPerDegLon(clat);
  const pts = [];
  for (let k = 0; k <= segments; k++) {
    const a = phase + (k / segments) * Math.PI * 2;
    pts.push([clon + (Math.cos(a) * radiusM) / mLon, clat + (Math.sin(a) * radiusM) / M_PER_DEG_LAT]);
  }
  return pts;
}

function ringBbox(pts) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a];
    const [xb, yb] = ring[b];
    if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

function polygonFeature(ring) {
  const closed = ring[0] === ring[ring.length - 1] ? ring : [...ring, ring[0]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closed] } };
}

function bboxRing(bbox) {
  const [w, s, e, n] = bbox;
  return [[w, s], [e, s], [e, n], [w, n]];
}

/** Render text into a canvas; returns the canvas. Used for both the map
 * preview overlay and the mask rasterization, so they always agree. */
export function renderTextCanvas(text, font, W, H, fillStyle = '#000') {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = fillStyle;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const probe = 100;
  ctx.font = `${probe}px ${font}`;
  const m = ctx.measureText(text);
  const textW = Math.max(1, m.width);
  const textH = Math.max(1, (m.actualBoundingBoxAscent || probe * 0.8) + (m.actualBoundingBoxDescent || probe * 0.2));
  const scale = Math.min((W * 0.94) / textW, (H * 0.94) / textH);
  ctx.font = `${probe * scale}px ${font}`;
  const m2 = ctx.measureText(text);
  const yShift = ((m2.actualBoundingBoxAscent || 0) - (m2.actualBoundingBoxDescent || 0)) / 2;
  ctx.fillText(text, W / 2, H / 2 + yShift);
  return canvas;
}

export class SelectionManager {
  constructor(map, { onSelectionChange, onToolChange } = {}) {
    this.map = map;
    this.onSelectionChange = onSelectionChange || (() => {});
    this.onToolChange = onToolChange || (() => {});
    this.tool = null;
    this.selection = null;
    this.textOptions = { text: 'A', font: '"Archivo Black", sans-serif' };
    this._drag = null; // in-progress drag {start}
    this._poly = null; // in-progress polygon points
    this._bindEvents();
  }

  _bindEvents() {
    const map = this.map;
    const canvas = map.getCanvas();

    map.on('mousedown', (ev) => {
      if (!this.tool || this.tool === 'polygon') return;
      ev.preventDefault();
      this._drag = { start: [ev.lngLat.lng, ev.lngLat.lat] };
    });
    map.on('mousemove', (ev) => {
      const p = [ev.lngLat.lng, ev.lngLat.lat];
      if (this._drag) {
        this._updateDraft(this._dragShape(this._drag.start, p));
      } else if (this._poly && this._poly.length) {
        this._updateDraft(this._polyDraft(p));
      }
    });
    map.on('mouseup', (ev) => {
      if (!this._drag) return;
      const shape = this._dragShape(this._drag.start, [ev.lngLat.lng, ev.lngLat.lat]);
      this._drag = null;
      this._clearDraft();
      if (shape && this._shapeBigEnough(shape)) {
        this._setSelection(shape);
        this.setTool(null);
      }
    });
    map.on('click', (ev) => {
      if (this.tool !== 'polygon') return;
      const p = [ev.lngLat.lng, ev.lngLat.lat];
      if (!this._poly) this._poly = [];
      // Clicking near the first vertex closes the polygon.
      if (this._poly.length >= 3) {
        const firstPx = map.project({ lng: this._poly[0][0], lat: this._poly[0][1] });
        if (Math.hypot(firstPx.x - ev.point.x, firstPx.y - ev.point.y) < 12) {
          this._finishPolygon();
          return;
        }
      }
      this._poly.push(p);
      this._updateDraft(this._polyDraft(p));
    });
    map.on('dblclick', (ev) => {
      if (this.tool !== 'polygon' || !this._poly) return;
      ev.preventDefault();
      this._finishPolygon();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this._drag = null;
        this._poly = null;
        this._clearDraft();
        this.setTool(null);
      }
    });
    canvas.addEventListener('mouseleave', () => {
      if (this._drag) {
        this._drag = null;
        this._clearDraft();
      }
    });
  }

  setTool(tool) {
    this.tool = tool;
    this._poly = tool === 'polygon' ? [] : null;
    this._drag = null;
    this._clearDraft();
    const map = this.map;
    if (tool) {
      map.getCanvas().style.cursor = 'crosshair';
      if (tool !== 'polygon') map.dragPan.disable();
      map.doubleClickZoom.disable();
    } else {
      map.getCanvas().style.cursor = '';
      map.dragPan.enable();
      map.doubleClickZoom.enable();
    }
    this.onToolChange(tool);
  }

  setTextOptions(opts) {
    this.textOptions = { ...this.textOptions, ...opts };
    if (this.selection?.shape === 'text') {
      this.selection.text = this.textOptions.text;
      this.selection.font = this.textOptions.font;
      this._renderSelection();
      this.onSelectionChange(this.selection);
    }
  }

  clear() {
    this.selection = null;
    this._poly = null;
    this._drag = null;
    this._clearDraft();
    this._renderSelection();
    this.onSelectionChange(null);
  }

  // -- shape construction -----------------------------------------------

  _dragShape(a, b) {
    const tool = this.tool;
    if (!tool) return null;
    if (tool === 'rect' || tool === 'square' || tool === 'text') {
      let [x0, y0] = a, [x1, y1] = b;
      if (tool === 'square') {
        const midLat = (y0 + y1) / 2;
        const dxM = (x1 - x0) * mPerDegLon(midLat);
        const dyM = (y1 - y0) * M_PER_DEG_LAT;
        const side = Math.max(Math.abs(dxM), Math.abs(dyM));
        x1 = x0 + (Math.sign(dxM) || 1) * (side / mPerDegLon(midLat));
        y1 = y0 + (Math.sign(dyM) || 1) * (side / M_PER_DEG_LAT);
      }
      const bbox = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      if (tool === 'text') {
        return { shape: 'text', bbox, text: this.textOptions.text, font: this.textOptions.font };
      }
      return { shape: tool, bbox };
    }
    if (tool === 'circle') {
      const r = localDistance(a, b);
      const ring = circlePoints(a, r, 72).slice(0, -1);
      return { shape: 'circle', center: a, radiusM: r, ring, bbox: ringBbox(ring) };
    }
    if (tool === 'hex') {
      const r = localDistance(a, b);
      const ring = circlePoints(a, r, 6, Math.PI / 6).slice(0, -1); // pointy-top
      return { shape: 'hex', center: a, radiusM: r, ring, bbox: ringBbox(ring) };
    }
    return null;
  }

  _polyDraft(cursor) {
    const pts = [...this._poly, cursor];
    if (pts.length < 2) return null;
    return { shape: 'polygon', points: pts, bbox: ringBbox(pts), draft: true };
  }

  _finishPolygon() {
    if (!this._poly || this._poly.length < 3) return;
    const points = this._poly;
    this._poly = null;
    this._clearDraft();
    const shape = { shape: 'polygon', points, bbox: ringBbox(points) };
    if (this._shapeBigEnough(shape)) {
      this._setSelection(shape);
      this.setTool(null);
    }
  }

  _shapeBigEnough(shape) {
    const { width, height } = bboxDimensionsMeters(shape.bbox);
    return width > 15 && height > 15; // ignore accidental tiny drags
  }

  _setSelection(shape) {
    this.selection = shape;
    this._renderSelection();
    this.onSelectionChange(shape);
  }

  // -- map rendering ----------------------------------------------------

  _shapeRing(shape) {
    switch (shape.shape) {
      case 'rect':
      case 'square':
      case 'text':
        return bboxRing(shape.bbox);
      case 'circle':
      case 'hex':
        return shape.ring;
      case 'polygon':
        return shape.points;
      default:
        return null;
    }
  }

  _renderSelection() {
    const features = [];
    const sel = this.selection;
    if (sel) {
      const ring = this._shapeRing(sel);
      if (ring) features.push(polygonFeature(ring));
    }
    this.map.getSource('selection').setData({ type: 'FeatureCollection', features });

    if (sel?.shape === 'text') {
      const { width, height } = bboxDimensionsMeters(sel.bbox);
      const W = 512;
      const H = Math.max(32, Math.min(1024, Math.round((W * height) / Math.max(1, width))));
      const canvas = renderTextCanvas(sel.text, sel.font, W, H, 'rgba(255,140,0,0.9)');
      setTextOverlay(this.map, canvas.toDataURL(), sel.bbox);
    } else {
      setTextOverlay(this.map, null, null);
    }
  }

  _updateDraft(shape) {
    const features = [];
    if (shape) {
      const ring = this._shapeRing(shape);
      if (ring && ring.length >= 3) features.push(polygonFeature(ring));
      if (shape.draft) {
        for (const p of shape.points.slice(0, -1)) {
          features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
        }
      }
    }
    this.map.getSource('draft').setData({ type: 'FeatureCollection', features });
  }

  _clearDraft() {
    this.map.getSource('draft').setData({ type: 'FeatureCollection', features: [] });
  }

  // -- mask rasterization ------------------------------------------------

  /**
   * Rasterize the current selection into a W×H boolean mask over its bbox.
   * Row j = 0 is the SOUTH edge (matching the elevation grid convention).
   */
  buildMask(W, H) {
    const sel = this.selection;
    if (!sel) throw new Error('No selection');
    const mask = new Uint8Array(W * H);
    const [w, s, e, n] = sel.bbox;

    if (sel.shape === 'rect' || sel.shape === 'square') {
      mask.fill(1);
      return mask;
    }
    if (sel.shape === 'text') {
      const canvas = renderTextCanvas(sel.text, sel.font, W, H);
      const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
      for (let j = 0; j < H; j++) {
        const row = H - 1 - j; // canvas y is down; mask row 0 is south
        for (let i = 0; i < W; i++) {
          mask[i + j * W] = data[(i + row * W) * 4 + 3] > 127 ? 1 : 0;
        }
      }
      return mask;
    }
    if (sel.shape === 'circle') {
      const [clon, clat] = sel.center;
      const mLon = mPerDegLon(clat);
      const r2 = sel.radiusM * sel.radiusM;
      for (let j = 0; j < H; j++) {
        const lat = s + ((n - s) * j) / (H - 1);
        const dy = (lat - clat) * M_PER_DEG_LAT;
        for (let i = 0; i < W; i++) {
          const lon = w + ((e - w) * i) / (W - 1);
          const dx = (lon - clon) * mLon;
          mask[i + j * W] = dx * dx + dy * dy <= r2 ? 1 : 0;
        }
      }
      return mask;
    }
    // hex / polygon: point-in-ring test
    const ring = sel.shape === 'hex' ? sel.ring : sel.points;
    for (let j = 0; j < H; j++) {
      const lat = s + ((n - s) * j) / (H - 1);
      for (let i = 0; i < W; i++) {
        const lon = w + ((e - w) * i) / (W - 1);
        mask[i + j * W] = pointInRing(lon, lat, ring) ? 1 : 0;
      }
    }
    return mask;
  }
}
