# API reference

Base URL `/api`. Interactive docs at **`/api/docs`** (FastAPI generates them from the code).

Everything is GET, everything is JSON except the tile endpoint. CORS is open by default; set
`CORS_ORIGINS` to lock it down.

## Metadata

### `GET /api/meta`
Everything the dashboard needs to boot: project settings, the analysis grid, the layer catalogue,
the classification breaks, feature counts and the tile URL template. The frontend calls this once.

### `GET /api/layers`
The layer catalogue alone.

### `GET /api/layers/{id}/legend`
A drawable legend. Continuous layers return a 24-stop colour ramp with values; categorical layers
return one entry per class with its colour, area and whether the label was inferred.

### `GET /api/stats`
The full statistics document — area, validation, exposure and cross-tabs. Same file the pipeline
writes to `data/processed/stats.json`.

## Tiles

### `GET /api/tiles/{layer}/{z}/{x}/{y}.png`

XYZ raster tiles rendered on demand from the COGs by rio-tiler. Colours come from
`config/layers.yml`.

| Query | Default | Use |
|---|---|---|
| `vmin`, `vmax` | the layer's configured range | restretch a continuous layer |
| `colormap` | the layer's configured map | any matplotlib colormap name |

Returns a 1×1 transparent PNG for tiles outside the layer, and 404 for an unknown layer.
Cached for a day (`Cache-Control: public, max-age=86400`). Typical render is 15–35 ms.

```
/api/tiles/lsm_class/12/3054/1721.png
/api/tiles/slope/12/3054/1721.png?vmin=20&vmax=60&colormap=inferno
```

## Point queries

### `GET /api/point?lon=&lat=`

**The click-to-inspect endpoint.** Every conditioning factor at one coordinate plus the model's
verdict. Reads a 1×1 window from each COG, so it stays fast however many layers exist.

```json
{
  "lon": 88.6138, "lat": 27.3314,
  "utm": { "crs": "EPSG:32645", "x": 658327.6, "y": 3023361.6 },
  "inside_study_area": true,
  "risk": { "class": 5, "label": "Very High", "index": 0.645,
            "index_normalised": 0.7261, "breaks": [0.1175, 0.2806, 0.4649, 0.6434] },
  "factors": [
    { "id": "slope", "title": "Slope", "kind": "continuous",
      "units": "degrees", "value": 11.4 },
    { "id": "lulc", "title": "Land use / land cover", "kind": "categorical",
      "value": 1, "label": "Built-up", "color": "#cc2b2b", "inferred": false }
  ]
}
```

`inside_study_area: false` means the point is outside Sikkim. A point can be inside the study area
and still have `risk.class: null` — that is the ~139 km² the ensemble does not cover.

### `GET /api/profile?lon1=&lat1=&lon2=&lat2=&n=`
Susceptibility sampled along a straight line — useful for reading a road corridor. `n` ≤ 512.

## Hotspots

### `GET /api/hotspots`

| Query | Default | Notes |
|---|---|---|
| `geometry` | `polygon` | `point` returns centroids — far smaller, use it for clustering |
| `bbox` | — | `minlon,minlat,maxlon,maxlat`; served from an STRtree index |
| `order_by` | `area_ha` | or `exposure_score`, `past_slides`, `builtup_ha`, `max_index`, `mean_index` |
| `min_area_ha` | 0 | |
| `limit` / `offset` | 500 / 0 | |

Properties per patch: `area_ha`, `area_km2`, `mean_index`, `max_index`, `mean_slope_deg`,
`max_slope_deg`, `min_dist_road_m`, `builtup_ha`, `cropland_ha`, `ntl_sum`, `past_slides`,
`exposure_score`, `rank_area`, `rank_exposure`.

The polygon set is ~8 MB in full; request it by `bbox` rather than downloading it whole.

### `GET /api/hotspots/{rank}`
One patch by its `rank_area`.

## GSI inventory

### `GET /api/inventory`

Filters compose: `district`, `trigger`, `material_type`, `movement_type`, `activity`,
`risk_class` (1–5), `in_hotspot` (bool), `bbox`, `limit`.

`full=true` includes the bulky `citation`, `abstract` and the per-point `factors` block; the
default strips them.

### `GET /api/inventory/facets`
Distinct values and counts for every filterable attribute — what the dashboard's dropdowns read.

### `GET /api/inventory/{id}`
One record.

## Search

### `GET /api/search?q=`
Settlements, named landslides, and `#123` for a hotspot rank. Returns `label`, `sublabel`,
`lat`, `lon`, `kind`.

### `GET /api/places`
The full settlement list.

## Health

### `GET /healthz`
`200` when layers and statistics are loaded, `503` otherwise. This is the container health check
and the Cloud Run readiness probe.
