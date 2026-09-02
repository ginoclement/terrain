/**
 * Breadcrumb-trail file parsing: GPX, TCX, KML/KMZ, and Garmin's binary FIT.
 * All parsers return { name, lines } where lines is an array of polylines
 * ([[lon, lat], ...]) — one per track segment, so separate recordings never
 * get bridged by a straight line.
 *
 * String parsers are regex-based (no DOMParser) so they run in node tests.
 * Loaded lazily by the app on first track import.
 */

const MAX_POINTS_PER_LINE = 3000;
const MAX_LINES = 60;

function downsampleLine(points) {
  if (points.length <= MAX_POINTS_PER_LINE) return points;
  const step = points.length / MAX_POINTS_PER_LINE;
  const out = [];
  for (let k = 0; k < MAX_POINTS_PER_LINE; k++) out.push(points[Math.floor(k * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function finish(name, lines) {
  const cleaned = lines
    .filter((l) => l.length >= 2)
    .slice(0, MAX_LINES)
    .map(downsampleLine);
  if (!cleaned.length) throw new Error('No trail points found in file');
  return { name, lines: cleaned };
}

const num = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// ---------------------------------------------------------------------------
// GPX: one line per <trkseg> (falls back to <rte>, then waypoints)

export function parseGPXText(text, name = 'GPX track') {
  const nameMatch = text.match(/<name>([^<]{1,80})<\/name>/);
  const pointTag = /<(?:trkpt|rtept)\b[^>]*>/g;
  const extract = (block) => {
    const pts = [];
    for (const m of block.matchAll(pointTag)) {
      const lat = num(m[0].match(/lat="([^"]+)"/)?.[1]);
      const lon = num(m[0].match(/lon="([^"]+)"/)?.[1]);
      if (lat !== null && lon !== null) pts.push([lon, lat]);
    }
    return pts;
  };
  let lines = [...text.matchAll(/<trkseg\b[\s\S]*?<\/trkseg>/g)].map((m) => extract(m[0]));
  if (!lines.some((l) => l.length >= 2)) {
    lines = [...text.matchAll(/<rte\b[\s\S]*?<\/rte>/g)].map((m) => extract(m[0]));
  }
  if (!lines.some((l) => l.length >= 2)) {
    const pts = [];
    for (const m of text.matchAll(/<wpt\b[^>]*>/g)) {
      const lat = num(m[0].match(/lat="([^"]+)"/)?.[1]);
      const lon = num(m[0].match(/lon="([^"]+)"/)?.[1]);
      if (lat !== null && lon !== null) pts.push([lon, lat]);
    }
    lines = [pts];
  }
  return finish(nameMatch?.[1]?.trim() || name, lines);
}

// ---------------------------------------------------------------------------
// TCX (Garmin Training Center): one line per <Track>

export function parseTCXText(text, name = 'TCX activity') {
  const lines = [...text.matchAll(/<Track>[\s\S]*?<\/Track>/g)].map((m) => {
    const pts = [];
    for (const tp of m[0].matchAll(/<Trackpoint>[\s\S]*?<\/Trackpoint>/g)) {
      const lat = num(tp[0].match(/<LatitudeDegrees>([^<]+)</)?.[1]);
      const lon = num(tp[0].match(/<LongitudeDegrees>([^<]+)</)?.[1]);
      if (lat !== null && lon !== null) pts.push([lon, lat]);
    }
    return pts;
  });
  const sport = text.match(/Sport="([^"]{1,40})"/)?.[1];
  return finish(sport ? `${sport} (TCX)` : name, lines);
}

// ---------------------------------------------------------------------------
// KML: <LineString><coordinates> tuples and <gx:Track><gx:coord> sequences

export function parseKMLText(text, name = 'KML track') {
  const lines = [];
  for (const m of text.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)) {
    const pts = [];
    for (const tuple of m[1].trim().split(/\s+/)) {
      const [lon, lat] = tuple.split(',').map(num);
      if (lat !== null && lon !== null && lat !== undefined) pts.push([lon, lat]);
    }
    if (pts.length >= 2) lines.push(pts);
  }
  for (const track of text.matchAll(/<gx:Track>[\s\S]*?<\/gx:Track>/g)) {
    const pts = [];
    for (const c of track[0].matchAll(/<gx:coord>([^<]+)<\/gx:coord>/g)) {
      const [lon, lat] = c[1].trim().split(/\s+/).map(num);
      if (lat !== null && lon !== null && lat !== undefined) pts.push([lon, lat]);
    }
    if (pts.length >= 2) lines.push(pts);
  }
  const nameMatch = text.match(/<name>([^<]{1,80})<\/name>/);
  return finish(nameMatch?.[1]?.trim() || name, lines);
}

// ---------------------------------------------------------------------------
// FIT (Garmin binary): minimal decoder for record messages (global msg 20),
// fields 0/1 = position_lat/position_long in semicircles.

const SEMI_TO_DEG = 180 / 2 ** 31;
const FIT_INVALID = 0x7fffffff;

export function parseFITBuffer(buf, name = 'FIT activity') {
  const dv = new DataView(buf);
  if (buf.byteLength < 14) throw new Error('Not a FIT file');
  const headerSize = dv.getUint8(0);
  const magic = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if ((headerSize !== 12 && headerSize !== 14) || magic !== '.FIT') throw new Error('Not a FIT file');
  const dataSize = dv.getUint32(4, true);
  const end = Math.min(buf.byteLength, headerSize + dataSize);

  const defs = {}; // localType -> { le, gmn, fields: [{num, size}], devSize }
  const pts = [];
  let off = headerSize;

  const readData = (local) => {
    const d = defs[local];
    if (!d) throw new Error('FIT data before definition — unsupported file');
    let lat = null, lon = null;
    for (const f of d.fields) {
      if (d.gmn === 20 && f.size === 4 && (f.num === 0 || f.num === 1)) {
        const v = d.le ? dv.getInt32(off, true) : dv.getInt32(off, false);
        if (v !== FIT_INVALID) {
          if (f.num === 0) lat = v * SEMI_TO_DEG;
          else lon = v * SEMI_TO_DEG;
        }
      }
      off += f.size;
    }
    off += d.devSize;
    if (lat !== null && lon !== null) pts.push([lon, lat]);
  };

  while (off < end) {
    const hdr = dv.getUint8(off++);
    if (hdr & 0x80) {
      // compressed-timestamp data message (local type in bits 5-6)
      readData((hdr >> 5) & 0x3);
    } else if (hdr & 0x40) {
      // definition message
      const local = hdr & 0x0f;
      const hasDev = !!(hdr & 0x20);
      off++; // reserved
      const le = dv.getUint8(off++) === 0;
      const gmn = le ? dv.getUint16(off, true) : dv.getUint16(off, false);
      off += 2;
      const n = dv.getUint8(off++);
      const fields = [];
      for (let k = 0; k < n; k++) {
        fields.push({ num: dv.getUint8(off), size: dv.getUint8(off + 1) });
        off += 3;
      }
      let devSize = 0;
      if (hasDev) {
        const dn = dv.getUint8(off++);
        for (let k = 0; k < dn; k++) {
          devSize += dv.getUint8(off + 1);
          off += 3;
        }
      }
      defs[local] = { le, gmn, fields, devSize };
    } else {
      readData(hdr & 0x0f);
    }
  }
  return finish(name, [pts]);
}

// ---------------------------------------------------------------------------
// GeoJSON lines (LineString / MultiLineString across features)

export function parseGeoJSONLines(geojson, name = 'GeoJSON track') {
  const lines = [];
  const walkGeom = (g) => {
    if (!g) return;
    if (g.type === 'LineString') lines.push(g.coordinates.map((c) => [c[0], c[1]]));
    else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => lines.push(l.map((c) => [c[0], c[1]])));
    else if (g.type === 'GeometryCollection') g.geometries.forEach(walkGeom);
  };
  if (geojson.type === 'FeatureCollection') geojson.features.forEach((f) => walkGeom(f.geometry));
  else if (geojson.type === 'Feature') walkGeom(geojson.geometry);
  else walkGeom(geojson);
  return finish(name, lines);
}

// ---------------------------------------------------------------------------
// Dispatcher

/**
 * Parse any supported breadcrumb file.
 * @param {string} fileName
 * @param {ArrayBuffer} buffer raw file bytes
 * @returns {{name: string, lines: [number, number][][]}}
 */
export function parseTrack(fileName, buffer) {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const bytes = new Uint8Array(buffer);
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

  const isFit = ext === 'fit' ||
    (bytes.length > 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54);
  if (isFit) return parseFITBuffer(buffer, baseName);

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (ext === 'kmz' || (isZip && ext !== 'zip')) {
    const fflate = globalThis.fflate;
    if (!fflate) throw new Error('KMZ support unavailable (fflate not loaded)');
    const files = fflate.unzipSync(bytes);
    const kmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'));
    if (!kmlName) throw new Error('No KML inside KMZ');
    return parseKMLText(new TextDecoder().decode(files[kmlName]), baseName);
  }

  const text = new TextDecoder().decode(bytes);
  if (ext === 'tcx' || text.includes('TrainingCenterDatabase')) return parseTCXText(text, baseName);
  if (ext === 'kml' || text.includes('<kml')) return parseKMLText(text, baseName);
  if (ext === 'gpx' || text.includes('<gpx')) return parseGPXText(text, baseName);
  if (ext === 'json' || ext === 'geojson' || text.trimStart().startsWith('{')) {
    return parseGeoJSONLines(JSON.parse(text), baseName);
  }
  throw new Error(`Unrecognized trail format: .${ext || '?'} (supported: GPX, TCX, KML, KMZ, FIT, GeoJSON)`);
}
