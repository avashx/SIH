"""The processed artefacts have to be internally consistent before the API can be trusted."""
import json
from pathlib import Path

import numpy as np
import pytest
import rasterio

from pipeline.common import OUT_DIR, load_registry, resolve_grid
from tests.conftest import needs_data

pytestmark = needs_data


@pytest.fixture(scope="module")
def reg():
    return load_registry()


def test_every_configured_layer_has_a_cog(reg):
    for layer in reg["layers"]:
        assert (OUT_DIR / "cog" / f"{layer['id']}.tif").exists(), f"missing COG for {layer['id']}"


def test_all_cogs_share_one_grid(reg):
    grid = resolve_grid(reg)
    for layer in reg["layers"]:
        with rasterio.open(OUT_DIR / "cog" / f"{layer['id']}.tif") as ds:
            assert (ds.width, ds.height) == (grid.width, grid.height), layer["id"]
            assert ds.crs == grid.crs, layer["id"]
            assert ds.transform.almost_equals(grid.transform), layer["id"]


def test_cogs_are_tiled_with_overviews(reg):
    """Without these the tile server reads whole rasters instead of 512 px blocks."""
    for layer in reg["layers"]:
        with rasterio.open(OUT_DIR / "cog" / f"{layer['id']}.tif") as ds:
            assert ds.profile.get("tiled"), f"{layer['id']} is not internally tiled"
            assert len(ds.overviews(1)) >= 3, f"{layer['id']} has too few overviews"


def test_no_layer_paints_outside_the_study_area(reg):
    """Regression: `soil` treats 0 as a real class, so every pixel outside Sikkim
    was stored as 0 and rendered — a grey rectangle over Nepal, Bhutan and West
    Bengal. Three more layers spilled a resampling fringe past the boundary."""
    with rasterio.open(OUT_DIR / "cog" / "lulc.tif") as ds:
        study = ds.read(1) != ds.nodata

    for layer in reg["layers"]:
        path = OUT_DIR / "cog" / f"{layer['id']}.tif"
        if not path.exists():
            continue
        with rasterio.open(path) as ds:
            painted = ds.read(1) != ds.nodata
        outside_km2 = float((painted & ~study).sum()) * 0.0009
        assert outside_km2 < 1.0, (
            f"{layer['id']} paints {outside_km2:,.0f} km² outside the study area"
        )


def test_risk_classes_are_exactly_one_to_five():
    with rasterio.open(OUT_DIR / "cog" / "lsm_class.tif") as ds:
        vals = set(np.unique(ds.read(1)).tolist()) - {ds.nodata}
    assert vals <= {1, 2, 3, 4, 5} and vals, vals


def test_class_areas_sum_to_the_classified_area():
    c = json.load(open(OUT_DIR / "classification.json"))
    s = json.load(open(OUT_DIR / "stats.json"))
    total = sum(d["area_km2"] for d in c["distribution"])
    assert total == pytest.approx(s["area"]["classified_km2"], rel=1e-3)


def test_breaks_are_monotonic_and_inside_the_index_range():
    c = json.load(open(OUT_DIR / "classification.json"))
    b = c["breaks"]
    assert b == sorted(b), "class breaks must increase"
    assert c["index_min"] < b[0] and b[-1] < c["index_max"]


def test_hotspots_are_all_class_five_and_above_the_minimum_size():
    c = json.load(open(OUT_DIR / "classification.json"))
    fc = json.load(open(OUT_DIR / "vector" / "hotspots.geojson"))
    assert len(fc["features"]) == c["hotspots"]["count"]
    floor = c["hotspots"]["min_area_ha"]
    for f in fc["features"]:
        p = f["properties"]
        assert p["area_ha"] >= floor * 0.999, p
        assert p["max_index"] >= c["breaks"][-1], "a hotspot must reach the Very-High break"


def test_hotspot_points_match_the_polygons_one_for_one():
    poly = json.load(open(OUT_DIR / "vector" / "hotspots.geojson"))["features"]
    pts = json.load(open(OUT_DIR / "vector" / "hotspot_points.geojson"))["features"]
    assert len(poly) == len(pts)
    assert {f["properties"]["rank_area"] for f in poly} == {f["properties"]["rank_area"] for f in pts}


def test_inventory_points_are_inside_sikkim():
    fc = json.load(open(OUT_DIR / "vector" / "inventory.geojson"))
    assert len(fc["features"]) == 691
    for f in fc["features"]:
        lon, lat = f["geometry"]["coordinates"]
        assert 87.9 < lon < 89.0 and 27.0 < lat < 28.2, f["id"]


def test_inventory_carries_every_factor():
    fc = json.load(open(OUT_DIR / "vector" / "inventory.geojson"))
    reg = load_registry()
    ids = {l["id"] for l in reg["layers"]}
    for f in fc["features"][:40]:
        assert ids <= set(f["properties"]["factors"]), f["id"]


def test_rainfall_carries_real_spatial_detail():
    """The original rainfall input was 21 x 25 px at ~5 km and had to be blown up
    ~170x, which produced a smooth interpolated surface rather than data. The
    re-supplied 30 m raster has genuine structure; this fails if anyone points the
    config back at the coarse file."""
    import numpy as np
    with rasterio.open(OUT_DIR / "cog" / "rainfall.tif") as ds:
        arr = ds.read(1)
        valid = arr[arr != ds.nodata]
    assert len(np.unique(valid)) > 1000, "rainfall looks interpolated, not measured"


def test_validation_shares_are_coherent():
    v = json.load(open(OUT_DIR / "stats.json"))["validation"]
    rows = v["by_class"]
    assert sum(r["area_share"] for r in rows) == pytest.approx(1.0, abs=1e-3)
    assert sum(r["landslide_share"] for r in rows) == pytest.approx(1.0, abs=1e-3)
    assert 0.5 <= v["success_rate_curve"]["auc"] <= 1.0


def test_the_model_beats_chance():
    """The whole point of the map: landslides must concentrate in the top classes."""
    v = json.load(open(OUT_DIR / "stats.json"))["validation"]
    assert v["headline"]["lift"] > 2.0, "High+Very High should hold far more slides than area alone"
    top = [r for r in v["by_class"] if r["class"] == 5][0]
    bottom = [r for r in v["by_class"] if r["class"] == 1][0]
    assert top["density_ratio"] > bottom["density_ratio"]
