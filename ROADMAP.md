# Roadmap

## Trail / breadcrumb integrations

### ✅ Shipped: file-based trail import
GPX (multi-segment), TCX, KML/KMZ, Garmin FIT (binary), and GeoJSON lines can
be uploaded and are shown on the live map, embossed on the 3D model, drawn on
2D map exports (SVG/PNG/PDF), and engraved onto layered cut sheets (SVG +
dedicated `TRAIL` DXF layer). Every major fitness platform can export at
least one of these formats today:

- **Strava**: activity page → ⋯ → "Export GPX" (or bulk export in settings).
- **Garmin Connect**: activity → gear icon → "Export to GPX" / "Export
  original" (a `.fit` file — supported directly).
- **Komoot / AllTrails / Wahoo / Coros / Suunto / Apple Health (via apps)**:
  all export GPX.

### 🔜 Strava account linking (feasible, needs a small backend)
The Strava API supports browser (CORS) calls with a bearer token, so a
"Connect Strava" button that lists recent activities and pulls their
breadcrumbs (`GET /activities/{id}/streams?keys=latlng`) is realistic.
What's needed:

1. **Register an API application** at strava.com/settings/api (free) —
   gives a client ID + client secret; set the authorization callback domain
   to the site's host (e.g. `ginoclement.github.io`).
2. **A tiny token-exchange service** (~50 lines on Cloudflare Workers /
   Netlify Functions, free tier). OAuth's `code → access_token` exchange
   requires the client secret, which must never ship in a static site. The
   worker holds the secret and proxies exactly two endpoints:
   `/oauth/token` (initial exchange) and token refresh.
3. **Frontend flow** (all client-side once the worker exists): redirect to
   Strava's authorize URL with `scope=activity:read`, receive the code on
   return, exchange via the worker, store tokens in `localStorage`, then
   call the Strava API directly from the browser. UI: an activity picker
   (name, date, distance) that loads the selected activity's `latlng`
   stream as a trail.
4. **Rate limits**: 100 requests / 15 min per app by default — fine for
   personal use.

### 🔭 Garmin Connect account linking (not practical for a hobby deployment)
Garmin's Connect Developer Program requires a company application and
commercial approval before issuing API keys, and its Activity API delivers
data by push (webhooks to a server you operate), not simple pulls. Until
that changes the supported path is Garmin's own "Export original" (FIT) or
GPX export, which this app reads natively.

### Other candidates (same OAuth-proxy pattern as Strava)
- **Komoot** — OAuth partner program (application required).
- **Ride with GPS** — has a straightforward API with personal API keys.
- **Dropbox/Google Drive pickers** — grab GPX/FIT files without manual
  download/upload hops.

## Other ideas under consideration
- Elevation-colored trail (gradient by climb) on 2D exports
- Waypoint markers (GPX `<wpt>`) with labels on maps and models
- Start/end markers and distance ticks along the trail
- Multiple simultaneous trails with per-trail colors
