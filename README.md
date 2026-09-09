# Sikkim Landslide Risk Platform

An interactive GIS platform for landslide susceptibility mapping, hotspot identification and
exposure screening across Sikkim, India.

### 🔗 Live demo — **https://sikkim-landslide.onrender.com/**

_No installation needed. The instance sleeps when idle, so the first request may take up to a
minute to wake._

---

## 1. Project Information

| | |
|---|---|
| **Project title** | Sikkim Landslide Risk Platform |
| **Problem Statement ID** | 26001 |
| **Problem Statement** | AI-Based Early Warning and Landslide Risk Monitoring System in NER |
| **Organisation** | Ministry of Development of North Eastern Region (MDoNER) |
| **Category** | Software |
| **Theme** | Disaster Management · GIS and Remote Sensing |
| **Study area** | Sikkim, India — 7,108 km² |
| **Live deployment** | https://sikkim-landslide.onrender.com/ |

---

## 2. Problem Description

Sikkim is one of the most landslide-prone states in India. Steep Himalayan slopes, intense monsoon
rainfall and rapid hill-road construction combine to produce slope failures that cut highways,
isolate villages and cost lives. Of the 691 landslides in the Geological Survey of India's
inventory for the state, **638 were rainfall-triggered**.

Planning and mitigation need an answer to a specific question: **which slopes are predisposed to
fail, and what sits on them?** That answer exists today only as static PDF maps and scattered
raster files — there is no shared, queryable view that a district officer can open, click and
interrogate.

This project answers that question. It does **not** claim to be an early-warning system; see
section 10.

---

## 3. Solution Approach

A five-model machine-learning ensemble produces a continuous susceptibility surface over 17
conditioning factors. The platform turns that surface into decisions:

```
 17 conditioning factors            5 ML models              continuous
 (slope, NDVI, rainfall,   ──▶   CNN · Random Forest   ──▶   susceptibility
  lithology, soil, LULC,          tabular · chained          index 0 – 0.89
  roads, drainage, NTL)           equal-weight 0.2 each
                                                                   │
                                                                   ▼
                                          Jenks natural breaks (k = 5)
                                                                   │
                                                                   ▼
                        5 risk categories  ·  918 hotspot patches  ·  exposure ranking
```

**Hotspot extraction is deterministic and auditable** — there is no second model. Class 5
("Very High") is sieved at a 1.08 ha floor, labelled into 8-connected components, polygonised, and
given per-patch zonal statistics. Every break value and parameter is written to
`data/processed/classification.json`, so the classification can be checked rather than taken on
trust.

Each hotspot carries an **exposure score** — a transparent screening heuristic over night-lights,
built-up area, road proximity and patch size — so 918 patches can be ranked by what is actually at
stake rather than by area alone.

---

## 4. Core Capabilities

- **Risk map** — five susceptibility categories over Sikkim, filterable by class, served as tiles
  rendered on demand.
- **918 ranked hotspots** — every Very-High patch with area, mean and maximum susceptibility, slope,
  distance to the nearest road, built-up and cropland hectares, night-lights total, and a count of
  past landslides inside it.
- **Click-to-inspect** — click anywhere on the map and read every conditioning-factor value at that
  pixel alongside the model's verdict.
- **"Sikkim only" view** — hide all surrounding geography and reference borders to present the study
  area in isolation.
- **Nine conditioning factors as toggleable layers**, each with its own legend, opacity control and
  provenance note.
- **Statistics panel** — area by class, validation against the GSI inventory, exposure totals, and
  cross-tabulations of risk against land cover, lithology, soil and slope band.
- **Search** across settlements, hotspots and inventory landslides.
- **Past-landslide inventory** — 691 GSI records, filterable.
- **REST API** — every view in the dashboard is backed by a documented endpoint.

---

## 5. Tech Requirements

| Layer | Technology |
|---|---|
| **Frontend** | HTML, CSS, vanilla ES modules, MapLibre GL JS (vendored — no build step) |
| **Backend** | Python 3.12, FastAPI, Uvicorn |
| **Geospatial** | rasterio, rio-tiler, Shapely, pyproj, GDAL (Cloud-Optimised GeoTIFF) |
| **Processing** | NumPy, SciPy |
| **ML (upstream)** | CNN, Random Forest and tabular models — equal-weight ensemble |
| **Data formats** | COG rasters, GeoJSON vectors, JSON statistics |
| **Testing** | pytest |
| **Deployment** | Docker, Google Cloud Run / Render, GitHub Actions CI |

No database is required: the processed rasters and vectors are the data store, which is what keeps
the platform clone-and-run.

---

## 6. System Architecture

```
   raw GeoTIFFs                    pipeline/                    data/processed/
   3 resolutions, 2 CRSs   ──▶   s01 inventory            ──▶   COGs  (62 MB)
   881 MB delivery                s02 harmonise                  GeoJSON vectors
                                  s03 classify + hotspots        stats.json
                                  s04 GSI inventory points       classification.json
                                  s05 statistics
                                                                        │
                                                                        ▼
                                              backend/   FastAPI + rio-tiler
                                              ├── /api/tiles/{layer}/{z}/{x}/{y}.png
                                              ├── /api/point?lon=&lat=
                                              ├── /api/hotspots · /api/inventory
                                              ├── /api/stats · /api/search
                                              └── static hosting for the dashboard
                                                                        │
                                                                        ▼
                                              frontend/  MapLibre GL JS dashboard
```

**One container serves both the API and the dashboard**, so a deployment is a single image and a
single URL. Tiles are rendered on demand rather than pre-generated: rio-tiler reads only the block
it needs at the right overview level, so the repository stays small, every zoom stays sharp, and
re-running the pipeline takes effect immediately with no tile cache to invalidate.

The whole system is driven by one registry file, `config/layers.yml` — the pipeline, the API and the
dashboard all read it, so adding a factor raster is a config entry and a rebuild, with no code
change anywhere.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/TECHNICAL_REPORT.md](docs/TECHNICAL_REPORT.md).

---

## 7. Installation

Requires Python 3.12 or newer.

```bash
git clone <this-repository>
cd NSUT-SIH-DEMO-GI

make install          # creates .venv and installs dependencies
```

Or without `make`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The processed data (`data/processed/`) is committed, so no raw rasters are needed to run the
platform. To rebuild it from the raw delivery instead, place the delivery at `Risk_hotspots/` and
run `make data` — see [docs/DATA.md](docs/DATA.md).

---

## 8. Execution

```bash
make serve            # http://localhost:8000
```

Or directly:

```bash
.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

Other commands:

| Command | What it does |
|---|---|
| `make test` | Test suite — pipeline artefacts and API contract |
| `make data` | Rebuild `data/processed/` from the raw delivery |
| `docker compose up --build` | Run the container on port 8080 |
| `make deploy PROJECT=<gcp-id>` | Deploy to Google Cloud Run |

Interactive API documentation is served at `/api/docs` once running, and written up in
[docs/API.md](docs/API.md).

### Hosted instance

The platform is deployed and publicly reachable — nothing needs to be installed to review it:

| | |
|---|---|
| Dashboard | https://sikkim-landslide.onrender.com/ |
| API docs | https://sikkim-landslide.onrender.com/api/docs |
| Health check | https://sikkim-landslide.onrender.com/healthz |

The free tier sleeps after a period of inactivity, so the first request may take up to a minute
while the container wakes.

---

## 9. Results

| Metric | Value |
|---|---|
| Study area | 7,108 km² |
| Very High ("hotspot") class | 729 km² · 10.5% of the state |
| High + Very High | 21.0% of the area holds **99.2%** of mapped landslides |
| Validation lift | **4.72×** landslide density versus area alone |
| Success-rate AUC | **0.948** |
| Top 10% of area | captures 81.7% of mapped landslides |
| Hotspot patches | **918**, each with exposure attributes |
| Built-up area exposed | 9.7 km² of 12.7 km² in High or Very High |
| Road network exposed | 74% of the mapped network |

Scored against 691 Geological Survey of India inventory points. **This is a success-rate curve, not
a prediction-rate curve** — the inventory was almost certainly part of the models' training data, so
it measures goodness of fit, not out-of-sample skill. Full discussion in
[docs/VALIDATION.md](docs/VALIDATION.md).

---

## 10. Scope — what this is, and what it is not

| Track | Question | Status |
|---|---|---|
| **1 · Susceptibility** | Where are slopes predisposed to fail? | **Complete — this repository** |
| 2 · Rapid detection | Has a slope just failed, and where? | Model trained and validated (~80%); not yet wired into the dashboard |
| 3 · Early warning | Is a slope about to fail? | **Not built** — needs the InSAR deformation track |

This platform is a **static planning map**. It carries no live rainfall, no soil moisture and no
ground-deformation signal, so it cannot say that a slope is failing today. It should be presented as
*susceptibility* and *rapid detection*; neither should be read as *early warning*.

---

## 11. Future Enhancements

- **Live rainfall feed** replacing the 30-year climatology — a scheduled job writing onto the same
  grid. 638 of 691 recorded landslides were rainfall-triggered, so this is the single highest-value
  data addition.
- **Rainfall intensity–duration threshold** fitted from the dated GSI inventory — the honest route
  toward a warning capability.
- **Spatially held-out validation** to convert the success-rate AUC into a defensible prediction
  rate.
- **Rapid detection panel** — Sentinel-1 SAR and Sentinel-2 optical scene search over a
  user-supplied date range, feeding the existing detection model.
- **Unblock InSAR** with a land-cover-change mask so construction stops reading as subsidence.
- The remaining 8 of 17 conditioning factors (aspect, curvature, TWI, elevation).
- **Census village points** for real population-exposed figures instead of the night-lights proxy.

Full list in [docs/ROADMAP.md](docs/ROADMAP.md).

---

## 12. Repository Layout

| Path | Contents |
|---|---|
| `config/layers.yml` | The registry — single source of truth for pipeline, API and UI |
| `pipeline/` | s01 inventory → s02 harmonise → s03 classify → s04 GSI points → s05 statistics |
| `backend/` | FastAPI app — tiles, point queries, features, statistics, static hosting |
| `frontend/` | MapLibre dashboard — no build step, vendored library and fonts |
| `data/processed/` | Committed COGs, GeoJSON and statistics — what makes this clone-and-run |
| `docs/` | Technical report, architecture, data provenance, validation, API reference, roadmap, deployment |
| `tests/` | Test suite over pipeline artefacts and the API contract |
| `tools/` | Boundary and outline generation scripts |
| `submission/` | Presentation and demo-video links |
| `assets/screenshots/` | Dashboard screenshots |

---

## 13. Submission Materials

| Item | Location |
|---|---|
| Live deployment | https://sikkim-landslide.onrender.com/ |
| Presentation (PPT) | [`submission/PRESENTATION.md`](submission/PRESENTATION.md) |
| Demo video | [`submission/DEMO.md`](submission/DEMO.md) |
| Screenshots | [`assets/screenshots/`](assets/screenshots/) |
| Technical report | [`docs/TECHNICAL_REPORT.md`](docs/TECHNICAL_REPORT.md) |

---

## 14. Credits

Landslide inventory © Geological Survey of India (Bhukosh). Base maps © Esri, OpenTopoMap and
OpenStreetMap contributors. Boundary vectors from Natural Earth (public domain), India
point-of-view edition. Rainfall climatology from CHIRPS.

Built for the Smart India Hackathon internal round, NSUT.

---

## 15. License

Released under the MIT License — see [LICENSE](LICENSE).
