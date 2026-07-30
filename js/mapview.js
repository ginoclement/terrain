/**
 * Map setup: several aligned Web-Mercator basemaps (switch with radio buttons),
 * a hillshade overlay, and a MapLibre 3D terrain mode — all driven by the same
 * AWS Terrarium DEM so what you see matches what gets exported.
 */

export const BASEMAPS = {
  osm: {
    name: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
  topo: {
    name: 'OpenTopoMap (contours)',
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    maxzoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  },
  satellite: {
    name: 'Esri World Imagery',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  usgs: {
    name: 'USGS Topo (US)',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'USGS The National Map',
  },
  gebco: {
    name: 'GEBCO ocean relief',
    tiles: [
      'https://wms.gebco.net/mapserv?request=getmap&service=wms&version=1.3.0&layers=GEBCO_LATEST&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png',
    ],
    maxzoom: 12,
    attribution: 'Imagery reproduced from the GEBCO_2024 Grid, GEBCO Compilation Group',
  },
  light: {
    name: 'Carto Light',
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ],
    maxzoom: 20,
    attribution: '© OpenStreetMap contributors © CARTO',
  },
};

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const DEM_ATTRIBUTION = 'Terrain: Mapzen/AWS Open Data Terrain Tiles';

export function createMap(container) {
  const sources = {
    'dem-terrain': {
      type: 'raster-dem',
      tiles: DEM_TILES,
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: DEM_ATTRIBUTION,
    },
    'dem-hillshade': {
      type: 'raster-dem',
      tiles: DEM_TILES,
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
    },
    selection: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    draft: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  };
  const layers = [];
  for (const [id, bm] of Object.entries(BASEMAPS)) {
    sources[`basemap-${id}`] = {
      type: 'raster',
      tiles: bm.tiles,
      tileSize: 256,
      maxzoom: bm.maxzoom,
      attribution: bm.attribution,
    };
    layers.push({
      id: `basemap-${id}`,
      type: 'raster',
      source: `basemap-${id}`,
      layout: { visibility: id === 'osm' ? 'visible' : 'none' },
    });
  }
  layers.push(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-hillshade',
      layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0.55,
        'hillshade-shadow-color': '#2b1d0e',
        'hillshade-highlight-color': '#ffffff',
      },
    },
    {
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#e74c8b', 'line-width': 3, 'line-opacity': 0.9 },
    },
    {
      id: 'selection-fill',
      type: 'fill',
      source: 'selection',
      paint: { 'fill-color': '#ff8c00', 'fill-opacity': 0.22 },
    },
    {
      id: 'selection-outline',
      type: 'line',
      source: 'selection',
      paint: { 'line-color': '#ff8c00', 'line-width': 2.5 },
    },
    {
      id: 'draft-fill',
      type: 'fill',
      source: 'draft',
      paint: { 'fill-color': '#00c2ff', 'fill-opacity': 0.15 },
    },
    {
      id: 'draft-line',
      type: 'line',
      source: 'draft',
      paint: { 'line-color': '#00c2ff', 'line-width': 2, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'draft-points',
      type: 'circle',
      source: 'draft',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#00c2ff',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    }
  );

  const map = new maplibregl.Map({
    container,
    style: { version: 8, sources, layers },
    center: [8.0, 46.4], // Swiss Alps — good demo terrain
    zoom: 9,
    pitch: 0,
    maxPitch: 80,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  return map;
}

export function setBasemap(map, id) {
  for (const key of Object.keys(BASEMAPS)) {
    map.setLayoutProperty(`basemap-${key}`, 'visibility', key === id ? 'visible' : 'none');
  }
}

export function setHillshade(map, on) {
  map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none');
}

export function set3DTerrain(map, on, exaggeration = 1.3) {
  if (on) {
    map.setTerrain({ source: 'dem-terrain', exaggeration });
    if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, duration: 600 });
  }
}

/** Show or update a GPX route polyline on the map (empty array clears it). */
export function setRoute(map, points) {
  const features = points?.length
    ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } }]
    : [];
  map.getSource('route').setData({ type: 'FeatureCollection', features });
}

/**
 * Add or update the letters/text preview overlay image. `coords` is the four
 * image corners [TL, TR, BR, BL] in lng/lat (rotation-aware).
 */
export function setTextOverlay(map, dataUrl, coords) {
  const existing = map.getSource('text-overlay');
  if (!dataUrl || !coords) {
    if (map.getLayer('text-overlay')) map.removeLayer('text-overlay');
    if (existing) map.removeSource('text-overlay');
    return;
  }
  if (existing) {
    existing.updateImage({ url: dataUrl, coordinates: coords });
  } else {
    map.addSource('text-overlay', { type: 'image', url: dataUrl, coordinates: coords });
    map.addLayer({
      id: 'text-overlay',
      type: 'raster',
      source: 'text-overlay',
      paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
    });
  }
}
