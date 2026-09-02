import { parseGPXText, parseTCXText, parseKMLText, parseFITBuffer, parseGeoJSONLines, parseTrack } from '../js/tracks.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

// --- GPX: two segments must stay two lines (no bridging) ---
{
  const gpx = `<?xml version="1.0"?><gpx><trk><name>Morning Hike</name>
    <trkseg><trkpt lat="46.1" lon="8.1"></trkpt><trkpt lon="8.2" lat="46.2"></trkpt><trkpt lat="46.3" lon="8.3"/></trkseg>
    <trkseg><trkpt lat="47.1" lon="9.1"/><trkpt lat="47.2" lon="9.2"/></trkseg>
  </trk></gpx>`;
  const t = parseGPXText(gpx);
  check('GPX: name extracted', t.name === 'Morning Hike');
  check('GPX: two segments -> two lines', t.lines.length === 2, `got ${t.lines.length}`);
  check('GPX: attribute order handled', t.lines[0][1][0] === 8.2 && t.lines[0][1][1] === 46.2);
  check('GPX: point counts', t.lines[0].length === 3 && t.lines[1].length === 2);
}

// --- GPX route fallback ---
{
  const gpx = `<gpx><rte><rtept lat="10.0" lon="20.0"/><rtept lat="10.1" lon="20.1"/></rte></gpx>`;
  const t = parseGPXText(gpx);
  check('GPX: rte fallback', t.lines.length === 1 && t.lines[0].length === 2);
}

// --- TCX ---
{
  const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap>
    <Track>
      <Trackpoint><Time>t</Time><Position><LatitudeDegrees>45.5</LatitudeDegrees><LongitudeDegrees>7.5</LongitudeDegrees></Position></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>45.6</LatitudeDegrees><LongitudeDegrees>7.6</LongitudeDegrees></Position></Trackpoint>
      <Trackpoint><Time>no-position-gap</Time></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>45.7</LatitudeDegrees><LongitudeDegrees>7.7</LongitudeDegrees></Position></Trackpoint>
    </Track>
    <Track>
      <Trackpoint><Position><LatitudeDegrees>44.0</LatitudeDegrees><LongitudeDegrees>6.0</LongitudeDegrees></Position></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>44.1</LatitudeDegrees><LongitudeDegrees>6.1</LongitudeDegrees></Position></Trackpoint>
    </Track>
  </Lap></Activity></Activities></TrainingCenterDatabase>`;
  const t = parseTCXText(tcx);
  check('TCX: sport name', t.name === 'Running (TCX)');
  check('TCX: two tracks', t.lines.length === 2);
  check('TCX: gap trackpoints skipped', t.lines[0].length === 3);
  check('TCX: lon/lat order', t.lines[0][0][0] === 7.5 && t.lines[0][0][1] === 45.5);
}

// --- KML: LineString + gx:Track ---
{
  const kml = `<kml><Document><name>Tour</name>
    <Placemark><LineString><coordinates>
      8.0,46.0,1200 8.1,46.1,1250
      8.2,46.2,1300
    </coordinates></LineString></Placemark>
    <Placemark><gx:Track>
      <gx:coord>9.0 47.0 800</gx:coord><gx:coord>9.1 47.1 820</gx:coord>
    </gx:Track></Placemark>
  </Document></kml>`;
  const t = parseKMLText(kml);
  check('KML: name', t.name === 'Tour');
  check('KML: LineString + gx:Track lines', t.lines.length === 2);
  check('KML: coordinates parsed lon,lat', t.lines[0][2][0] === 8.2 && t.lines[0][2][1] === 46.2);
  check('KML: gx:coord parsed lon lat', t.lines[1][1][0] === 9.1 && t.lines[1][1][1] === 47.1);
}

// --- FIT: synthetic binary with definition + records (incl. invalid + dev fields) ---
{
  const deg2semi = (d) => Math.round(d / (180 / 2 ** 31));
  const records = [
    [46.5, 8.5], [46.51, 8.52], null /* invalid position */, [46.52, 8.54],
  ];
  // definition (little endian, global 20, 3 fields: lat(0,4), lon(1,4), hr(3,1)) + dev fields (1 field, 2 bytes)
  const defBytes = [0x60, 0x00, 0x00, 20, 0, 3, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 0x02, 1, 0, 2, 0];
  const dataMsgs = [];
  for (const r of records) {
    const dvb = new DataView(new ArrayBuffer(1 + 4 + 4 + 1 + 2));
    dvb.setUint8(0, 0x00); // data msg, local 0
    dvb.setInt32(1, r ? deg2semi(r[0]) : 0x7fffffff, true);
    dvb.setInt32(5, r ? deg2semi(r[1]) : 0x7fffffff, true);
    dvb.setUint8(9, 140); // hr
    dvb.setUint16(10, 42, true); // dev field
    dataMsgs.push(new Uint8Array(dvb.buffer));
  }
  const body = [new Uint8Array(defBytes), ...dataMsgs];
  const bodyLen = body.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(14 + bodyLen + 2);
  const hv = new DataView(buf.buffer);
  hv.setUint8(0, 14);
  hv.setUint8(1, 0x20);
  hv.setUint16(2, 2172, true);
  hv.setUint32(4, bodyLen, true);
  buf.set(new TextEncoder().encode('.FIT'), 8);
  let off = 14;
  for (const b of body) { buf.set(b, off); off += b.length; }
  const t = parseFITBuffer(buf.buffer, 'ride');
  check('FIT: parsed as one line', t.lines.length === 1);
  check('FIT: invalid position skipped', t.lines[0].length === 3, `got ${t.lines[0].length}`);
  const [lon0, lat0] = t.lines[0][0];
  check('FIT: semicircle conversion accurate', Math.abs(lat0 - 46.5) < 1e-6 && Math.abs(lon0 - 8.5) < 1e-6,
    `${lat0},${lon0}`);
  // dispatcher sniffs FIT by magic even without extension
  const viaDispatcher = parseTrack('mystery.bin', buf.buffer);
  check('FIT: dispatcher magic sniffing', viaDispatcher.lines[0].length === 3);
}

// --- GeoJSON lines ---
{
  const gj = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] } },
  ] };
  const t = parseGeoJSONLines(gj);
  check('GeoJSON: MultiLineString -> two lines', t.lines.length === 2);
}

// --- errors ---
{
  let threw = false;
  try { parseTrack('nothing.gpx', new TextEncoder().encode('<gpx></gpx>').buffer); } catch { threw = true; }
  check('empty GPX throws', threw);
  threw = false;
  try { parseTrack('junk.xyz', new TextEncoder().encode('hello').buffer); } catch { threw = true; }
  check('unknown format throws', threw);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll tracks checks passed.');
