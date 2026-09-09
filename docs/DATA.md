# Data provenance and known gaps

Everything here is derived from the delivery in `Risk_hotspots/`, dated 27 August, and from
`make inventory`, which re-reads the raw files and writes `data/processed/inventory.json`.

## The raw delivery

Not in git (881 MB). Get it from the team's shared drive and place it at the repository root
as `Risk_hotspots/`, or point `RAW_DIR` at it.

```
Risk_hotspots/
├── LSM_ensemble.tif          43 MB   the five-model ensemble
├── Past_LS_points.kml       1.6 MB   GSI landslide inventory, 691 points
└── Layers/                          nine conditioning factors
```

| File | Layer id | Native res | CRS | Notes on arrival |
|---|---|---|---|---|
| `LSM_ensemble.tif` | `lsm` | 30 m | 32645 | **Continuous** 0.0004–0.888, not the 1–5 classes |
| `SLOPE_SIKKIM.tif` | `slope` | 30 m | 32645 | nodata −9999 |
| `Mean_NDVI_Sikkim_2013_2019.tif` | `ndvi` | **10 m** | 32645 | 318 MB; no declared nodata |
| `dis_to_Major_roads.tif` | `dist_roads` | 30 m | 32645 | **No nodata at all** — fills the whole rectangle |
| `final_dis_drainage.tif` | `dist_drainage` | **10 m** | 32645 | 418 MB; nodata −1e9 |
| `lithology_cat_f.tif` | `lithology` | 30 m | 32645 | 0 = outside; **unit names not supplied** |
| `lulc_cat_f.tif` | `lulc` | 30 m | 32645 | 0 = outside; **legend not supplied** |
| `soil_type_cat_f.tif` | `soil` | 30 m | 32645 | 0 is a *real* class, not nodata |
| `mean_annual_rainfall_30yrs_CRS.tif` | `rainfall` | 30 m | 32645 | **re-supplied**; supersedes the 21 × 25 px, ~5 km EPSG:4326 original |
| `ntl_sikkim_30m.tif` | `ntl` | 30 m | 32645 | −9999 present but **not declared** as nodata |

Three resolutions, two CRSs and four different no-data conventions. Step 2 resolves all of it onto
one 30 m grid in EPSG:32645 — `3007 × 3885`, snapped to the ensemble's own pixel lattice so the
model output lands on an exact integer offset and is never interpolated.

## Only 9 of the 17 factors arrived

The project scope defines 17 conditioning factors across 18–19 raster files. Nine are
here. **Aspect, curvature, TWI, elevation** and others named on the call are missing. The dashboard
is registry-driven, so each one is a `config/layers.yml` entry plus `make data` when it lands.

## Recovered labels — confirm these

No legend shipped with the three categorical rasters. The labels in `config/layers.yml` were
recovered by measuring each class's signature across NDVI, night-lights, slope and latitude
(snow and ice sit in the far north; built-up is the only class with high night-lights).

### LULC

| Code | Label | km² | mean NDVI | mean NTL | mean slope | % north of 27.8°N | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | Built-up | 12.7 | 0.310 | **0.179** | 18.1° | 4% | **High** — 10× the night-lights of any other class |
| 2 | Wetland / valley vegetation | 3.4 | 0.516 | 0.058 | **12.0°** | 0% | *Low* — tiny, flat, southernmost |
| 3 | Forest | 3,434 | **0.623** | 0.031 | 29.5° | 1% | **High** — 48% of the state, matches Sikkim's forest cover |
| 4 | Alpine meadow / pasture | 907 | 0.289 | 0.018 | 24.9° | 43% | *Low* — too far north to be cropland |
| 5 | Snow / glacier | 817 | 0.046 | 0.019 | 26.6° | **68%** | **High** — near-zero NDVI, northernmost |
| 6 | Water body | 38.5 | **−0.151** | 0.034 | **5.8°** | 65% | **High** — flattest, most negative NDVI |
| 7 | Barren / rocky | 883 | −0.029 | 0.018 | 29.6° | 41% | **High** |
| 9 | Sparse vegetation / scrub | 1,012 | 0.138 | 0.016 | 27.6° | 36% | *Low* |

Classes 2, 4 and 9 are flagged `inferred: true` and render with a `?` in the UI. Class 8 is absent
from the raster. **The source legend is still to be confirmed** — it is a one-line fix in `config/layers.yml`.

### Lithology

Seven units, 87% of the area in unit 1. **No names are recoverable from the data** — signatures do
not separate rock types. Shown as "Unit 1"…"Unit 7". This needs the source legend.

### Soil

Class 0 covers 621 km² inside the study area with mean NDVI −0.035. It is not a data hole: it is
the high-altitude rock and ice where soil is not mapped. Labelled "Unmapped (rock / ice)".

## Coverage gaps

| Layer | Coverage of the study area | Note |
|---|---|---|
| `lsm` | **98.0%** | ~139 km² of southern and eastern Sikkim has no ensemble value |
| `ndvi` | 99.2% | native footprint stops just short of the boundary |
| `rainfall` | 100% | after edge-backfill; the source grid sits ~4 m off ours |
| everything else | ≥ 99.9% | |

The `lsm` gap is worth resolving with the GIS side: the study mask (from LULC) reaches Sikkim's
southern tip; the delivered ensemble does not.

## The GSI landslide inventory

`Past_LS_points.kml` is the Geological Survey of India national landslide inventory (Bhukosh),
Sikkim extract: **691 points, 39 attributes** — trigger, material, movement type and rate, failure
mechanism, dimensions, land use, road, remediation and damage.

GDAL's KML driver silently drops `<SchemaData>` attributes, returning 691 geometries and nothing
else, so `pipeline/s04_inventory_points.py` parses the XML directly.

What it says: **638 of 691** were triggered by rainfall — which is the empirical case for the
design in which only the rainfall layer needs to go live. 594 are still active. 534 are
debris; 617 are slides.

**Sampling bias.** GSI maps landslides where people and roads are. 89 distinct road names appear in
the records. So the inventory is not a random sample of Sikkim's failures, and both the validation
score and the model's own training set inherit that bias. Low predicted risk in the unpopulated
north rests on very little evidence.

## Settlement list

`reference/places_sikkim.csv` — 50 towns and villages with **approximate** coordinates, hand-compiled
so search works. It is a placeholder: replace it with the Census 2011 / LGD village dataset, which
would also unlock real "villages exposed" and "population exposed" statistics in place of the
night-lights proxy.

## Encoding in `data/processed/`

Each COG stores integers with `real = stored × scale + offset` (recorded per layer in
`config/layers.yml` and echoed in every API response). Float32 rasters became `uint16`/`int16`,
which with DEFLATE and a horizontal predictor is what turns 881 MB into 62 MB with no loss that
matters at 30 m.


## Boundary vectors

`frontend/data/borders-world.geojson` and `borders-region.geojson` are generated by
`tools/build_borders.py` from Natural Earth (public domain). They are committed, so a clone renders
them without running the tool.

**India is drawn as India claims it.** The build uses Natural Earth's India point-of-view edition
and clears the disputed-area outlines inside that claim, so Jammu & Kashmir and Ladakh — including
Pakistan-administered Kashmir, Gilgit-Baltistan and Aksai Chin — read as one continuous part of
India with no Line of Control. Depicting them otherwise is not lawful to publish in India.
`tests/test_borders.py` fails the build if that ever regresses.

One thing the tool deliberately does **not** do: draw the internal boundary between the Jammu &
Kashmir and Ladakh union territories. Natural Earth has no geometry for the 2019 reorganisation, and
inventing a line would be worse than omitting one. If the GIS side can supply it, it drops in as
another feature in the regional file.
