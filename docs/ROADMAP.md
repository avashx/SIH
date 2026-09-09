# Roadmap

What is built, what is next, and what is deliberately not claimed. Panel 1 is complete and is what
this repository contains; panels 2 and 3 are scoped here so the boundary stays explicit.

## Done — panel 1

- [x] Load the susceptibility ensemble and render it as a risk map — **the categories had to be
      derived; the ensemble arrived as a continuous surface**
- [x] Expose category 5 ("Very High") as the hotspot layer
- [x] Click-to-inspect returning every conditioning-factor value at a point
- [x] Map library: **MapLibre GL JS**, vendored — GPU raster layers with per-layer opacity, native
      clustering and expression-driven styling
- [x] REST API for diagnosis and filter selection — see [API.md](API.md)
- [x] Repository layout, Docker image and Cloud Run target
- [x] Statistics: area, exposure, cross-tabulations
- [x] Independent validation against the GSI landslide inventory
- [x] Test suite over the pipeline artefacts and the API contract

## Next — panel 1 data

- [ ] The remaining 8 of 17 conditioning factors (aspect, curvature, TWI, elevation, …)
- [ ] Lithology unit names and the LULC legend — see [DATA.md](DATA.md) for what was inferred
- [ ] Road and drainage **vectors**, not only distance rasters
- [ ] Resolve why the ensemble's extent falls ~139 km² short of the state boundary
- [ ] Rainfall source selection and latency — CHIRPS vs NASA IMERG
- [ ] Soil-moisture source

## Panel 2 — rapid detection

The model exists (~80%, validated on the 1 June 2025 event). What is missing is wiring, not
modelling.

- [ ] Scene search over a user-supplied date range (Sentinel-1 SAR + Sentinel-2 optical)
- [ ] Rolling 30-day date buffer with a 20% cloud-pixel filter
- [ ] GradCAM over flagged 1 km tiles, threshold tuned from the 0.43–0.58 range
- [ ] Detections as a feature store behind `/api/detections?from=&to=`
- [ ] Second dashboard page: detection gallery, filterable by date and confidence
- [ ] Move detected events to PostGIS — the point at which an in-memory store stops being right

## Panel 3 — early warning

Not built, and not claimed. Two independent blockers.

- [ ] **Unblock InSAR.** Apply a LULC-change mask so vegetation clearance and construction stop
      reading as ground subsidence. The ingredients exist — LULC is already in the stack.
- [ ] Live rainfall feed replacing the 30-year climatology — a scheduled job writing
      `rainfall_live.tif` onto the same grid; the dashboard needs no code change
- [ ] Soil moisture as a second continuous input
- [ ] Trigger logic and alert thresholds — **not designed yet**

## Worth doing

- [ ] **Spatially held-out validation.** The current AUC of 0.948 is a success rate measured on the
      inventory the models were fitted to. A spatial split would turn it into a defensible
      prediction rate — the single highest-value modelling addition. See [VALIDATION.md](VALIDATION.md).
- [ ] Investigate whether the detection model leans on slope as a shortcut
- [ ] Quantify the Random Forest distance-to-road artefact and consider down-weighting it
- [ ] Census 2011 village points → real "villages exposed" and "population exposed" figures instead
      of the night-lights proxy
- [ ] Chaten (June 2025) reads **Low** on this map at the approximate coordinates in
      `reference/places_sikkim.csv`. Check it against the event's true extent — if it holds, it is a
      real and interesting limitation of the current ensemble.
