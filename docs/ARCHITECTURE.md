# Architecture

## The shape of the problem

The delivery is nine conditioning rasters plus a model output, in three resolutions, two coordinate
systems and four no-data conventions, totalling 881 MB. The dashboard needs to answer "what is the
value of everything, here?" in milliseconds, and to render any layer at any zoom.

Those two requirements drive every decision below.

## One grid

Nothing downstream can be trusted until every raster sits on the same lattice. `pipeline/s02`
warps all of them onto:

```
EPSG:32645 (UTM 45N) · 30 m · 3007 × 3885 px · 11.7 M pixels
bounds 88.0107 – 88.9387 E, 27.0731 – 28.1347 N
```

The grid is the **union** of every layer's extent, at the project resolution, **snapped to the LSM
ensemble's own pixel origin**. That snap matters: the model output — the one layer that must not be
smeared — lands on an exact integer pixel offset and is copied rather than interpolated. Everything
else resamples onto it (nearest for categorical, bilinear or average for continuous).

The coarse 5 km rainfall climatology is excluded from the union calculation, or its footprint would
inflate the grid well beyond Sikkim.

The **study-area mask** is the LULC raster's valid footprint: 7,108 km², against Sikkim's actual
7,096 km². Every area statistic is computed inside it.

## Storage: integer-encoded COGs

Each layer becomes one Cloud-Optimised GeoTIFF with `real = stored × scale + offset`, recorded per
layer in `config/layers.yml`:

- float32 → `uint16` / `int16` at a scale that preserves meaningful precision
- DEFLATE with a horizontal predictor
- 512 px internal tiles, five overview levels

**881 MB → 62 MB**, which is what lets `data/processed/` be committed so the repository is
clone-and-run without the raw delivery.

## Tiles rendered on demand

There is no tile pyramid. `rio-tiler` opens the COG, reads the 512 px block at the overview level
the zoom needs, applies the registry's colormap, and returns a PNG in 15–35 ms.

The alternative — pre-generating z8–z16 for eleven layers — would add hundreds of megabytes, cap
the zoom, and need invalidating every time the pipeline runs. On-demand rendering also gives
`?vmin=&vmax=&colormap=` for free, so a layer can be restretched from the client without touching
the data.

## Point queries

`/api/point` reads a 1×1 window from each COG — eleven cheap seeks, not eleven raster loads. This
is what makes click-to-inspect feel instant, and it scales to the full 17 factors when they arrive.

`pipeline/s04` samples the GSI inventory through the same code path, which makes
`inventory.geojson` a regression fixture for the API as well as a map layer.

## Vectors held in memory

`hotspots.geojson` (918 polygons) and `inventory.geojson` (691 points) load once at start-up into
an STRtree index, so a bbox query while the user pans is a spatial-index lookup rather than a scan.
At this size that is far simpler than PostGIS and costs nothing.

**When to move to PostGIS**: when detected events start being written (panel 2), when more than one
process needs to write, or when the hotspot set grows past ~100k features. The API surface is
already shaped so that swapping `backend/features.py` for a database-backed store changes nothing
else.

## One process, one container

FastAPI serves the API *and* the static dashboard. One image, one Cloud Run service, one URL, no
CORS in production, no separate frontend deploy. The frontend has **no build step** — vendored
MapLibre, ES modules, hand-written CSS — so a teammate can edit it without installing Node.

## The registry is the contract

`config/layers.yml` is read by the pipeline, the API and the UI. It carries each layer's source
path, no-data convention, resampling method, storage encoding, display colours, class labels and
the prose shown in the sidebar.

Adding a conditioning factor is: drop the `.tif` in, add an entry, `make data`. No Python, no
JavaScript. That is deliberate — eight of the seventeen factors have not arrived yet.

## Request flow

```
browser
  │  GET /api/meta ──────────────▶ registry.py ──▶ config/layers.yml + processed metadata
  │  GET /api/tiles/lsm/12/…png ─▶ tiles.py ────▶ rio-tiler ──▶ data/processed/cog/lsm.tif
  │  GET /api/point?lon=&lat= ───▶ query.py ────▶ 1×1 window from each COG
  │  GET /api/hotspots?bbox= ────▶ features.py ─▶ STRtree
  └▶ GET /api/stats ─────────────▶ data/processed/stats.json
```

## Pipeline stages

| Step | Reads | Writes | Why it exists |
|---|---|---|---|
| `s01_inventory` | raw | `inventory.json` | Catch a wrong CRS or broken no-data before it poisons the stack |
| `s02_harmonise` | raw | `cog/*.tif`, `grid.json` | One grid, one encoding |
| `s03_classify` | `cog/lsm.tif` | `lsm_class.tif`, hotspots, `classification.json` | Continuous index → 5 classes → ranked patches |
| `s04_inventory_points` | KML + COGs | `inventory.geojson` | Parse GSI attributes GDAL drops; enrich; join to hotspots |
| `s05_stats` | everything | `stats.json` | Area, validation, exposure, cross-tabs |

`python -m pipeline.run_all --from 3` resumes; `--only 5` re-runs one step.

## Where panels 2 and 3 attach

- **Panel 2 (detection).** Detected events are points or tiles with a date. Add a `detections`
  feature store beside `hotspots`, a `/api/detections?from=&to=` endpoint, and a time filter in the
  UI. GradCAM heat maps are single-tile rasters — they can be served by the existing tile endpoint
  once written as COGs. This is where PostGIS starts to earn its place.
- **Panel 3 (early warning).** The agreed design is to keep the static stack,
  replace the rainfall *layer* with a live feed. Concretely, that is a scheduled job writing a
  rolling `rainfall_live.tif` onto the same grid, plus a registry entry. The dashboard picks it up
  with no code change. The trigger logic on top — and the InSAR deformation track — is the part
  that does not exist yet.
