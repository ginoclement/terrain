/* Service worker: offline app shell + map/DEM tile cache.
 * App shell is network-first (deploys take effect immediately, offline falls
 * back to cache); versioned CDN libraries are cache-first; map & elevation
 * tiles are cached as they stream in, capped to a bounded LRU-ish store.
 */
const SHELL_CACHE = 'terrain-shell-v1';
const CDN_CACHE = 'terrain-cdn-v1';
const TILE_CACHE = 'terrain-tiles-v1';
const TILE_CACHE_MAX = 800;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/mapview.js',
  './js/selection.js',
  './js/elevation.js',
  './js/mesh.js',
  './js/heightops.js',
  './js/exporters.js',
  './js/preview3d.js',
];

const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = [
  's3.amazonaws.com', 'tile.openstreetmap.org', 'tile.opentopomap.org', 'server.arcgisonline.com',
  'basemap.nationalmap.gov', 'basemaps.cartocdn.com', 'wms.gebco.net', 'api.maptiler.com',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.allSettled(SHELL_ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  const keep = [SHELL_CACHE, CDN_CACHE, TILE_CACHE];
  ev.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_MAX) {
    await Promise.all(keys.slice(0, keys.length - TILE_CACHE_MAX).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Versioned CDN libraries: cache-first.
  if (CDN_HOSTS.some((h) => url.hostname.endsWith(h))) {
    ev.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp.ok || resp.type === 'opaque') cache.put(req, resp.clone());
        return resp;
      })
    );
    return;
  }

  // Map / DEM tiles: cache-first with a bounded store.
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    ev.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp.ok || resp.type === 'opaque') {
          cache.put(req, resp.clone());
          trimTileCache();
        }
        return resp;
      })
    );
    return;
  }

  // Same-origin app shell: network-first, cache fallback for offline.
  if (url.origin === location.origin) {
    ev.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
    );
  }
});
