/**
 * Map selection tools: rectangle, square, circle, hexagon, freeform polygon,
 * and text/letters — plus rotation, GeoJSON polygon import, and share-link
 * serialization. Selections are stored in geographic coordinates and can be
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

/** Rotate a lng/lat point about a center by deg (CCW), in local meters. */
function rotatePoint([lon, lat], [clon, clat], deg) {
  if (!deg) return [lon, lat];
  const a = (deg * Math.PI) / 180;
  const mLon = mPerDegLon(clat);
  const dx = (lon - clon) * mLon;
  const dy = (lat - clat) * M_PER_DEG_LAT;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  return [clon + rx / mLon, clat + ry / M_PER_DEG_LAT];
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

function bboxCenter(bbox) {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
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

/**
 * Rasterize a lng/lat polyline into a W×H boolean mask over bbox (row 0 =
 * south), with the line drawn `lineWidthPx` samples wide. Used to emboss
 * GPX routes onto the model.
 */
export function rasterizeRouteMask(points, bbox, W, H, lineWidthPx = 2) {
  const [w, s, e, n] = bbox;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = lineWidthPx;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  for (const [lon, lat] of points) {
    const x = ((lon - w) / (e - w || 1e-12)) * (W - 1);
    const y = (1 - (lat - s) / (n - s || 1e-12)) * (H - 1);
    if (started) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); started = true; }
  }
  ctx.stroke();
  const data = ctx.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const row = H - 1 - j;
    for (let i = 0; i < W; i++) {
      mask[i + j * W] = data[(i + row * W) * 4 + 3] > 127 ? 1 : 0;
    }
  }
  return mask;
}

/** Compute the derived ring / bbox / overlay corners for a selection. */
function derive(sel) {
  const rot = sel.rotationDeg || 0;
  switch (sel.shape) {
    case 'rect':
    case 'square':
    case 'text': {
      const center = bboxCenter(sel.rect0);
      const corners = bboxRing(sel.rect0).map((p) => rotatePoint(p, center, rot));
      sel.ring = corners;
      sel.bbox = ringBbox(corners);
      sel.center = center;
      // Overlay wants TL, TR, BR, BL (unrotated: [w,n],[e,n],[e,s],[w,s])
      const [w0, s0, e0, n0] = sel.rect0;
      sel.overlayCorners = [[w0, n0], [e0, n0], [e0, s0], [w0, s0]].map((p) => rotatePoint(p, center, rot));
      break;
    }
    case 'circle': {
      sel.ring = circlePoints(sel.center, sel.radiusM, 72).slice(0, -1);
      sel.bbox = ringBbox(sel.ring);
      break;
    }
    case 'hex': {
      const base = circlePoints(sel.center, sel.radiusM, 6, Math.PI / 6).slice(0, -1);
      sel.ring = base.map((p) => rotatePoint(p, sel.center, rot));
      sel.bbox = ringBbox(sel.ring);
      break;
    }
    case 'polygon': {
      const center = bboxCenter(ringBbox(sel.basePoints));
      sel.ring = sel.basePoints.map((p) => rotatePoint(p, center, rot));
      sel.bbox = ringBbox(sel.ring);
      sel.center = center;
      break;
    }
  }
  return sel;
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
    this._move = null; // in-progress selection move {start, snapshot}
    this._bindEvents();
  }

  _bindEvents() {
    const map = this.map;
    const canvas = map.getCanvas();

    map.on('mousedown', (ev) => {
      if (this.tool && this.tool !== 'polygon') {
        ev.preventDefault();
        this._drag = { start: [ev.lngLat.lng, ev.lngLat.lat] };
        return;
      }
      // No tool active: grab the existing selection to move it.
      if (!this.tool && this.selection && this._hitSelection(ev.lngLat)) {
        ev.preventDefault();
        this._move = { start: [ev.lngLat.lng, ev.lngLat.lat], snapshot: this._geometrySnapshot() };
        map.getCanvas().style.cursor = 'grabbing';
      }
    });
    map.on('mousemove', (ev) => {
      const p = [ev.lngLat.lng, ev.lngLat.lat];
      if (this._drag) {
        this._updateDraft(this._dragShape(this._drag.start, p));
      } else if (this._move) {
        this._applyMoveDelta(p[0] - this._move.start[0], p[1] - this._move.start[1]);
      } else if (this._poly && this._poly.length) {
        this._updateDraft(this._polyDraft(p));
      } else if (!this.tool && this.selection) {
        map.getCanvas().style.cursor = this._hitSelection(ev.lngLat) ? 'move' : '';
      }
    });
    map.on('mouseup', (ev) => {
      if (this._move) {
        this._move = null;
        map.getCanvas().style.cursor = 'move';
        this.onSelectionChange(this.selection);
        return;
      }
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
        if (this._move) this._applyMoveDelta(0, 0); // snap back to where it was
        this._move = null;
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
      if (this._move) {
        this._move = null;
        this.onSelectionChange(this.selection);
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

  /** Rotate the current selection (degrees CCW). No-op for circles. */
  setRotation(deg) {
    if (!this.selection || this.selection.shape === 'circle') return;
    this.selection.rotationDeg = deg;
    derive(this.selection);
    this._renderSelection();
    this.onSelectionChange(this.selection);
  }

  /** Replace the selection with an imported polygon ring (lng/lat pairs). */
  setPolygonSelection(points) {
    if (!points || points.length < 3) throw new Error('Polygon needs at least 3 points');
    this._setSelection(derive({ shape: 'polygon', basePoints: points, rotationDeg: 0 }));
  }

  clear() {
    this.selection = null;
    this._poly = null;
    this._drag = null;
    this._clearDraft();
    this._renderSelection();
    this.onSelectionChange(null);
  }

  /** Compact serializable form for share links. */
  toJSON() {
    const sel = this.selection;
    if (!sel) return null;
    const round = (v) => Math.round(v * 1e6) / 1e6;
    const base = { shape: sel.shape, rot: sel.rotationDeg || 0 };
    switch (sel.shape) {
      case 'rect':
      case 'square':
        return { ...base, rect0: sel.rect0.map(round) };
      case 'text':
        return { ...base, rect0: sel.rect0.map(round), text: sel.text, font: sel.font };
      case 'circle':
      case 'hex':
        return { ...base, center: sel.center.map(round), r: Math.round(sel.radiusM) };
      case 'polygon':
        return { ...base, points: sel.basePoints.map((p) => p.map(round)) };
    }
    return null;
  }

  fromJSON(data) {
    if (!data) return;
    const sel = { shape: data.shape, rotationDeg: data.rot || 0 };
    switch (data.shape) {
      case 'rect':
      case 'square':
        sel.rect0 = data.rect0;
        break;
      case 'text':
        sel.rect0 = data.rect0;
        sel.text = data.text;
        sel.font = data.font;
        break;
      case 'circle':
      case 'hex':
        sel.center = data.center;
        sel.radiusM = data.r;
        break;
      case 'polygon':
        sel.basePoints = data.points;
        break;
      default:
        return;
    }
    this._setSelection(derive(sel));
  }

  // -- selection moving --------------------------------------------------

  _hitSelection(lngLat) {
    const ring = this.selection?.ring;
    return !!ring && pointInRing(lngLat.lng, lngLat.lat, ring);
  }

  _geometrySnapshot() {
    const sel = this.selection;
    switch (sel.shape) {
      case 'rect':
      case 'square':
      case 'text':
        return { rect0: [...sel.rect0] };
      case 'circle':
      case 'hex':
        return { center: [...sel.center] };
      case 'polygon':
        return { basePoints: sel.basePoints.map((p) => [...p]) };
      default:
        return {};
    }
  }

  _applyMoveDelta(dLon, dLat) {
    const sel = this.selection;
    const snap = this._move.snapshot;
    if (snap.rect0) {
      sel.rect0 = [snap.rect0[0] + dLon, snap.rect0[1] + dLat, snap.rect0[2] + dLon, snap.rect0[3] + dLat];
    } else if (snap.center) {
      sel.center = [snap.center[0] + dLon, snap.center[1] + dLat];
    } else if (snap.basePoints) {
      sel.basePoints = snap.basePoints.map((p) => [p[0] + dLon, p[1] + dLat]);
    }
    derive(sel);
    this._renderSelection();
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
      const rect0 = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const sel = { shape: tool, rect0, rotationDeg: 0 };
      if (tool === 'text') {
        sel.text = this.textOptions.text;
        sel.font = this.textOptions.font;
      }
      return derive(sel);
    }
    if (tool === 'circle') {
      return derive({ shape: 'circle', center: a, radiusM: localDistance(a, b), rotationDeg: 0 });
    }
    if (tool === 'hex') {
      return derive({ shape: 'hex', center: a, radiusM: localDistance(a, b), rotationDeg: 0 });
    }
    return null;
  }

  _polyDraft(cursor) {
    const pts = [...this._poly, cursor];
    if (pts.length < 2) return null;
    return { shape: 'polygon', points: pts, bbox: ringBbox(pts), ring: pts, draft: true };
  }

  _finishPolygon() {
    if (!this._poly || this._poly.length < 3) return;
    const points = this._poly;
    this._poly = null;
    this._clearDraft();
    const shape = derive({ shape: 'polygon', basePoints: points, rotationDeg: 0 });
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

  _renderSelection() {
    const features = [];
    const sel = this.selection;
    if (sel?.ring) features.push(polygonFeature(sel.ring));
    this.map.getSource('selection').setData({ type: 'FeatureCollection', features });

    if (sel?.shape === 'text') {
      const { width, height } = bboxDimensionsMeters(sel.rect0);
      const W = 512;
      const H = Math.max(32, Math.min(1024, Math.round((W * height) / Math.max(1, width))));
      const canvas = renderTextCanvas(sel.text, sel.font, W, H, 'rgba(255,140,0,0.9)');
      setTextOverlay(this.map, canvas.toDataURL(), sel.overlayCorners);
    } else {
      setTextOverlay(this.map, null, null);
    }
  }

  _updateDraft(shape) {
    const features = [];
    if (shape) {
      if (shape.ring && shape.ring.length >= 3) features.push(polygonFeature(shape.ring));
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
    const rot = sel.rotationDeg || 0;

    if ((sel.shape === 'rect' || sel.shape === 'square') && !rot) {
      mask.fill(1);
      return mask;
    }
    if (sel.shape === 'text') {
      // Render the text once over the unrotated rect0, then look samples up
      // by inverse-rotating them into that frame.
      const [w0, s0, e0, n0] = sel.rect0;
      const dims0 = bboxDimensionsMeters(sel.rect0);
      const cw = 1024;
      const ch = Math.max(64, Math.min(2048, Math.round((cw * dims0.height) / Math.max(1, dims0.width))));
      const canvas = renderTextCanvas(sel.text, sel.font, cw, ch);
      const data = canvas.getContext('2d').getImageData(0, 0, cw, ch).data;
      for (let j = 0; j < H; j++) {
        const lat = s + ((n - s) * j) / (H - 1);
        for (let i = 0; i < W; i++) {
          const lon = w + ((e - w) * i) / (W - 1);
          const [lon0, lat0] = rotatePoint([lon, lat], sel.center, -rot);
          if (lon0 < w0 || lon0 > e0 || lat0 < s0 || lat0 > n0) continue;
          const px = Math.round(((lon0 - w0) / (e0 - w0)) * (cw - 1));
          const py = Math.round((1 - (lat0 - s0) / (n0 - s0)) * (ch - 1));
          mask[i + j * W] = data[(px + py * cw) * 4 + 3] > 127 ? 1 : 0;
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
    // rect/square (rotated), hex, polygon: point-in-ring test
    const ring = sel.ring;
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
