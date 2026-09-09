"""FastAPI application.

Serves three things from one process, which is what makes the whole platform a
single container and a single Cloud Run deployment:
  · /api/*   the JSON + tile API
  · /        the dashboard (static files)
  · /healthz a liveness probe
"""
from __future__ import annotations

from pathlib import Path

from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from backend import features, query, registry, tiles
from backend.config import API_PREFIX, CORS_ORIGINS, FRONTEND_DIR, TILE_MAX_ZOOM, TILE_SIZE

app = FastAPI(
    title="Sikkim Landslide Platform API",
    version="0.1.0",
    description=(
        "Panel 1 - landslide susceptibility and hotspots for Sikkim.\n\n"
        "Serves the harmonised factor stack as XYZ tiles, point queries across every "
        "factor, the Very-High hotspot polygons, the GSI landslide inventory, and the "
        "validation statistics."
    ),
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)
# GeoJSON and the border vectors compress ~5x; PNG tiles are already
# compressed and fall under the size threshold anyway.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS or ["*"],
                   allow_methods=["GET"], allow_headers=["*"])

TILE_CACHE = "public, max-age=86400"
JSON_CACHE = "public, max-age=300"


# --------------------------------------------------------------------------- #
# metadata
# --------------------------------------------------------------------------- #
@app.get(f"{API_PREFIX}/meta", tags=["meta"], summary="Everything the dashboard needs to boot")
def meta():
    reg = registry.registry()
    return {
        "project": reg["project"],
        "grid": reg["grid"],
        "classification": {k: v for k, v in reg["classification"].items()
                           if k != "breaks_all_methods"},
        "layers": [{k: v for k, v in l.items() if k != "path"} for l in reg["layers"]],
        "vectors": reg["vectors"],
        "counts": {
            "hotspots": len(features.hotspots()),
            "inventory": len(features.inventory()),
            "places": len(registry.places()),
        },
        "tile_url_template": f"{API_PREFIX}/tiles/{{layer}}/{{z}}/{{x}}/{{y}}.png",
        "data_version": registry.data_version(),
        "tile_size": TILE_SIZE,
        "max_zoom": TILE_MAX_ZOOM,
    }


@app.get(f"{API_PREFIX}/layers", tags=["meta"])
def list_layers():
    return [{k: v for k, v in l.items() if k != "path"} for l in registry.registry()["layers"]]


@app.get(f"{API_PREFIX}/layers/{{layer_id}}/legend", tags=["meta"])
def layer_legend(layer_id: str):
    try:
        return tiles.legend(layer_id)
    except KeyError:
        raise HTTPException(404, f"unknown layer '{layer_id}'")


@app.get(f"{API_PREFIX}/stats", tags=["meta"], summary="Area, validation, exposure, cross-tabs")
def get_stats():
    s = registry.stats()
    if not s:
        raise HTTPException(503, "statistics not built - run `make data`")
    return JSONResponse(s, headers={"Cache-Control": JSON_CACHE})


# --------------------------------------------------------------------------- #
# tiles
# --------------------------------------------------------------------------- #
@app.get(f"{API_PREFIX}/tiles/{{layer_id}}/{{z}}/{{x}}/{{y}}.png", tags=["tiles"])
def tile(layer_id: str, z: int, x: int, y: int,
         vmin: Optional[float] = None, vmax: Optional[float] = None,
         colormap: Optional[str] = None,
         classes: Optional[str] = Query(None, description="categorical layers: "
                                        "comma-separated class values to paint; "
                                        "everything else renders transparent")):
    keep = None
    if classes:
        try:
            keep = tuple(int(v) for v in classes.split(",") if v.strip() != "")
        except ValueError:
            raise HTTPException(400, "classes must be comma-separated integers")
    try:
        png = tiles.render_tile(layer_id, z, x, y, TILE_SIZE, vmin, vmax, colormap, keep)
    except KeyError:
        raise HTTPException(404, f"unknown layer '{layer_id}'")
    if png is None:
        return Response(tiles.TRANSPARENT_PNG, media_type="image/png",
                        headers={"Cache-Control": TILE_CACHE})
    return Response(png, media_type="image/png", headers={"Cache-Control": TILE_CACHE})


# --------------------------------------------------------------------------- #
# point query
# --------------------------------------------------------------------------- #
@app.get(f"{API_PREFIX}/point", tags=["query"], summary="Every factor value at one coordinate")
def point(lon: float = Query(..., ge=-180, le=180), lat: float = Query(..., ge=-90, le=90)):
    return query.sample_point(lon, lat)


@app.get(f"{API_PREFIX}/profile", tags=["query"], summary="Susceptibility along a line")
def profile(lon1: float, lat1: float, lon2: float, lat2: float,
            n: int = Query(64, ge=2, le=512)):
    return query.sample_profile(lon1, lat1, lon2, lat2, n)


# --------------------------------------------------------------------------- #
# hotspots
# --------------------------------------------------------------------------- #
def _bbox(s: Optional[str]):
    if not s:
        return None
    try:
        vals = [float(v) for v in s.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be 'minlon,minlat,maxlon,maxlat'")
    if len(vals) != 4:
        raise HTTPException(400, "bbox must be 'minlon,minlat,maxlon,maxlat'")
    return vals


@app.get(f"{API_PREFIX}/hotspots", tags=["hotspots"],
         summary="Very-High patches as polygons or centroids")
def get_hotspots(bbox: Optional[str] = None,
                 limit: int = Query(500, ge=1, le=20000),
                 offset: int = Query(0, ge=0),
                 min_area_ha: float = Query(0, ge=0),
                 order_by: str = Query("area_ha", pattern="^(area_ha|exposure_score|past_slides|"
                                                          "builtup_ha|max_index|mean_index)$"),
                 geometry: str = Query("polygon", pattern="^(polygon|point)$")):
    store = features.hotspots() if geometry == "polygon" else features.hotspot_points()
    feats, total = store.query(
        bbox=_bbox(bbox), limit=limit, offset=offset, order_by=order_by,
        predicate=(lambda p: p.get("area_ha", 0) >= min_area_ha) if min_area_ha else None)
    return JSONResponse(
        {"type": "FeatureCollection", "features": feats,
         "meta": {"returned": len(feats), "matched": total, "total": len(store),
                  "order_by": order_by, "offset": offset}},
        headers={"Cache-Control": JSON_CACHE})


@app.get(f"{API_PREFIX}/hotspots/{{rank}}", tags=["hotspots"], summary="One hotspot polygon")
def get_hotspot(rank: int):
    f = features.hotspots().by_id(rank)
    if f is None:
        raise HTTPException(404, f"no hotspot with rank {rank}")
    return f


# --------------------------------------------------------------------------- #
# GSI inventory
# --------------------------------------------------------------------------- #
@app.get(f"{API_PREFIX}/inventory", tags=["inventory"],
         summary="Past landslides (GSI), filterable")
def get_inventory(bbox: Optional[str] = None,
                  district: Optional[str] = None,
                  trigger: Optional[str] = None,
                  material_type: Optional[str] = None,
                  movement_type: Optional[str] = None,
                  activity: Optional[str] = None,
                  risk_class: Optional[int] = Query(None, ge=1, le=5),
                  in_hotspot: Optional[bool] = None,
                  limit: int = Query(2000, ge=1, le=5000),
                  full: bool = False):
    filters = {"district": district, "trigger": trigger, "material_type": material_type,
               "movement_type": movement_type, "activity": activity}
    active = {k: v for k, v in filters.items() if v}

    def pred(p):
        for k, v in active.items():
            if (p.get(k) or "") != v:
                return False
        if risk_class is not None and p.get("risk_class") != risk_class:
            return False
        if in_hotspot is not None and (p.get("hotspot_rank") is not None) != in_hotspot:
            return False
        return True

    feats, total = features.inventory().query(bbox=_bbox(bbox), limit=limit,
                                              predicate=pred if (active or risk_class is not None
                                                                 or in_hotspot is not None) else None)
    if not full:
        feats = [features.strip(f) for f in feats]
    return JSONResponse(
        {"type": "FeatureCollection", "features": feats,
         "meta": {"returned": len(feats), "matched": total,
                  "total": len(features.inventory())}},
        headers={"Cache-Control": JSON_CACHE})


@app.get(f"{API_PREFIX}/inventory/facets", tags=["inventory"],
         summary="Distinct values and counts for every filterable attribute")
def inventory_facets():
    return JSONResponse(registry.facets(), headers={"Cache-Control": JSON_CACHE})


@app.get(f"{API_PREFIX}/inventory/{{fid}}", tags=["inventory"], summary="One landslide record")
def inventory_record(fid: int):
    f = features.inventory().by_id(fid)
    if f is None:
        raise HTTPException(404, f"no inventory record {fid}")
    return f


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #
@app.get(f"{API_PREFIX}/search", tags=["query"], summary="Find a place, a hotspot or a slide")
def search(q: str = Query(..., min_length=1), limit: int = Query(12, ge=1, le=50)):
    ql = q.strip().lower()
    out = []

    for p in registry.places():
        hay = f"{p['name']} {p['district']} {p['type']}".lower()
        if ql in hay:
            out.append({"kind": "place", "label": p["name"],
                        "sublabel": f"{p['type']} · {p['district']} district",
                        "lat": p["lat"], "lon": p["lon"], "note": p.get("note"),
                        "score": 0 if p["name"].lower().startswith(ql) else 1})

    for f in features.inventory().features:
        p = f["properties"]
        name = p.get("slide_name") or p.get("slide_no") or ""
        if ql in str(name).lower():
            lon, lat = f["geometry"]["coordinates"]
            out.append({"kind": "landslide", "label": str(name),
                        "sublabel": f"GSI {p.get('slide_no', '')} · {p.get('district', '')}",
                        "lat": lat, "lon": lon, "id": f["id"], "score": 2})

    if ql.startswith("#") and ql[1:].isdigit():
        f = features.hotspots().by_id(int(ql[1:]))
        if f:
            p = f["properties"]
            out.append({"kind": "hotspot", "label": f"Hotspot #{p['rank_area']}",
                        "sublabel": f"{p['area_ha']:,.0f} ha · exposure {p['exposure_score']}",
                        "lat": p["lat"], "lon": p["lon"], "id": p["rank_area"], "score": 0})

    out.sort(key=lambda r: (r["score"], len(r["label"])))
    return {"query": q, "results": out[:limit]}


@app.get(f"{API_PREFIX}/places", tags=["query"])
def all_places():
    return registry.places()


# --------------------------------------------------------------------------- #
# health + static
# --------------------------------------------------------------------------- #
@app.get("/healthz", include_in_schema=False)
def healthz():
    reg = registry.registry()
    ready = bool(reg["layers"]) and bool(registry.stats())
    return JSONResponse(
        {"status": "ok" if ready else "degraded",
         "layers": len(reg["layers"]), "hotspots": len(features.hotspots()),
         "inventory": len(features.inventory()), "stats_built": bool(registry.stats())},
        status_code=200 if ready else 503)


if FRONTEND_DIR.exists():
    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(FRONTEND_DIR / "index.html")

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
