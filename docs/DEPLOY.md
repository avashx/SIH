# Deploying

The image is one container: FastAPI serves the API *and* the dashboard, so a deployment is one
service and one URL. `data/processed/` (~72 MB) is committed and baked into the image, so nothing
needs the 881 MB raw delivery at runtime.

Every push to `main` runs [CI](../.github/workflows/ci.yml), which executes the 44-test suite, then
builds the image and smoke-tests the running container — health, dashboard HTML, a real tile and a
point query. **If CI is green, the image boots and serves.**

## Run it locally

```bash
docker compose up --build      # → http://localhost:8080
```

Or without Docker:

```bash
make install && make serve     # → http://localhost:8000
```

## Option A — Render (fastest path to a public URL)

The repository is **private**, so Render needs to be granted access to it.

1. [render.com](https://render.com) → **New** → **Blueprint**
2. Connect the GitHub account that owns `avashx/SIHGIS`, and grant access to that repository
3. Point it at the repo — Render reads [`render.yaml`](../render.yaml) and needs no other input
4. Every later push to `main` redeploys automatically

Already configured in the blueprint: free plan, Singapore region (closest to India),
`/healthz` as the health check, and `GDAL_CACHEMAX=128` so the GDAL block cache cannot push a
512 MB instance into an OOM restart under tile load. The app idles at ~90 MB.

> **Demo-day warning.** The free plan spins down after ~15 minutes idle and the next request pays a
> cold start of roughly 50 seconds. Before presenting, either open the URL a minute early to wake it,
> or move to a paid instance for the day.

## Option B — Google Cloud Run

Builds from your local checkout, so no GitHub access is needed even though the repo is private.

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com

make deploy PROJECT=<PROJECT_ID>
# or, for the pinned pipeline with an image tag per commit:
gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=asia-south1
```

[`cloudbuild.yaml`](../cloudbuild.yaml) deploys to `asia-south1` (Mumbai) with 1 GiB, concurrency 40
and `--min-instances=0`. For a live demo set `--min-instances=1` to remove the cold start; it costs
a little but the container is always warm.

## Option C — any other container host

Fly.io, Railway, Azure Container Apps and friends all work unchanged. The contract is small:

| | |
|---|---|
| Port | reads `$PORT`, defaults to `8080` |
| Health check | `GET /healthz` → `200` when layers and statistics are loaded, else `503` |
| Memory | ~90 MB idle; 512 MB is comfortable with `GDAL_CACHEMAX=128` |
| Persistence | none — everything is read-only, baked into the image |
| Build | plain `Dockerfile`, no build args |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | injected by Cloud Run and Render |
| `GDAL_CACHEMAX` | `256` | GDAL block cache, MB. Drop to `128` on a 512 MB instance |
| `PROCESSED_DIR` | `data/processed` | where the COGs and vectors live |
| `LAYERS_CONFIG` | `config/layers.yml` | the layer registry |
| `CORS_ORIGINS` | `*` | comma-separated; restrict if the API is consumed cross-origin |
| `TILE_MAX_ZOOM` | `16` | upper zoom the frontend requests |

## After a data refresh

The image carries the data, so new rasters mean a rebuild, not a restart:

```bash
make data-force     # regenerate data/processed from Risk_hotspots/
make test           # confirm the artefacts are still coherent
git add data/processed && git commit -m "Refresh processed data" && git push
```

CI rebuilds and re-smoke-tests the image; Render redeploys on its own, Cloud Run needs the deploy
command again.

## Troubleshooting

**`libexpat.so.1: cannot open shared object file`** — rasterio's wheel bundles GDAL but links
against the system expat, which `python:*-slim` does not ship. The Dockerfile installs `libexpat1`;
if you change the base image, carry that line across.

**`/healthz` returns 503** — `data/processed/stats.json` is missing from the image. Run `make data`
and rebuild; the Dockerfile also fails the build for this rather than shipping a broken image.

**Tiles are blank but return 200** — a 1×1 transparent PNG means the tile lies outside the layer.
Check the z/x/y against Sikkim's bounds (88.011–88.939 E, 27.073–28.135 N).

**Basemap tiles missing, data layers fine** — the Esri and OpenTopoMap basemaps are the only remote
dependency. The dashboard still works without them; MapLibre and its glyphs are vendored locally.
