"""API contract tests. These are what tell the front-end it is safe to deploy."""
import io
import math

import numpy as np

import pytest

from tests.conftest import needs_data

pytestmark = needs_data

GANGTOK = (88.6138, 27.3314)
OUTSIDE = (77.2090, 28.6139)   # Delhi — well outside the study area


def deg2tile(lon, lat, z):
    n = 2 ** z
    return (int((lon + 180) / 360 * n),
            int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))


def test_healthz(client):
    j = client.get("/healthz").json()
    assert j["status"] == "ok" and j["layers"] >= 10


def test_meta_shape(meta):
    assert meta["project"]["crs"] == "EPSG:32645"
    ids = {l["id"] for l in meta["layers"]}
    assert {"lsm", "lsm_class", "slope", "lulc"} <= ids
    assert meta["counts"]["inventory"] == 691


def test_meta_publishes_a_data_version(client, meta):
    """Tiles are cached for a day. Without a version token in the URL a client
    keeps drawing stale imagery after `make data` — which is what kept the
    unclipped soil rectangle on screen after the raster had been fixed."""
    v = meta["data_version"]
    assert v and isinstance(v, str)
    # and the tile endpoint must not reject it
    x, y = deg2tile(88.4747, 27.6039, 11)
    assert client.get(f"/api/tiles/soil/11/{x}/{y}.png?v={v}").status_code == 200


def test_lithology_and_soil_carry_real_names(client):
    """These were placeholder 'Unit N' / 'Soil type N' labels until the team's own
    published maps supplied the legend."""
    lith = {e["label"] for e in client.get("/api/layers/lithology/legend").json()["entries"]}
    soil = {e["label"] for e in client.get("/api/layers/soil/legend").json()["entries"]}
    assert {"Metamorphic", "Paragneiss", "Schist", "Slate"} <= lith
    assert {"Sandy Clay Loam", "Silty Clay Loam", "Loam", "Silt"} <= soil
    assert not any(l.startswith("Unit ") for l in lith)
    assert not any(l.startswith("Soil type ") for l in soil)


def test_every_layer_has_a_legend(client, meta):
    for l in meta["layers"]:
        j = client.get(f"/api/layers/{l['id']}/legend").json()
        assert j["kind"] == l["kind"]
        assert j["entries"] if l["kind"] == "categorical" else j["ramp"]


def test_unknown_layer_is_404(client):
    assert client.get("/api/layers/nope/legend").status_code == 404
    assert client.get("/api/tiles/nope/10/1/1.png").status_code == 404


@pytest.mark.parametrize("layer", ["lsm", "lsm_class", "slope", "lulc", "rainfall"])
@pytest.mark.parametrize("z", [9, 11, 13])
def test_tiles_render_png(client, layer, z):
    x, y = deg2tile(88.4747, 27.6039, z)
    r = client.get(f"/api/tiles/{layer}/{z}/{x}/{y}.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_out_of_bounds_tile_is_a_valid_transparent_png(client):
    """Regression: a hand-written blank PNG with a bad chunk length broke every
    out-of-bounds tile, which at low zoom is most of them."""
    from PIL import Image
    r = client.get("/api/tiles/lsm_class/10/1/1.png")
    assert r.status_code == 200
    im = Image.open(io.BytesIO(r.content))
    im.load()
    assert im.mode == "RGBA" and im.getpixel((0, 0))[3] == 0


def test_tile_class_filter_isolates_a_category(client):
    """The dashboard's category rail relies on this: painting only the requested
    classes and leaving the rest fully transparent."""
    from PIL import Image
    x, y = deg2tile(88.4747, 27.6039, 11)

    def opaque_fraction(query=""):
        r = client.get(f"/api/tiles/lsm_class/11/{x}/{y}.png{query}")
        assert r.status_code == 200
        a = np.array(Image.open(io.BytesIO(r.content)).convert("RGBA"))
        return float((a[..., 3] > 0).mean())

    everything = opaque_fraction()
    only5 = opaque_fraction("?classes=5")
    only45 = opaque_fraction("?classes=4,5")

    assert everything > 0.9, "unfiltered tile should cover the tile"
    assert 0 < only5 < only45 < everything
    assert client.get(
        f"/api/tiles/lsm_class/11/{x}/{y}.png?classes=abc").status_code == 400


def test_point_query_returns_every_factor(client, meta):
    j = client.get("/api/point", params={"lon": GANGTOK[0], "lat": GANGTOK[1]}).json()
    assert j["inside_study_area"] is True
    assert j["risk"]["class"] in (1, 2, 3, 4, 5)
    assert {f["id"] for f in j["factors"]} == {l["id"] for l in meta["layers"]}
    lulc = next(f for f in j["factors"] if f["id"] == "lulc")
    assert lulc["label"], "categorical factors must resolve to a label"


def test_point_outside_the_study_area_is_handled(client):
    j = client.get("/api/point", params={"lon": OUTSIDE[0], "lat": OUTSIDE[1]}).json()
    assert j["inside_study_area"] is False
    assert j["risk"]["class"] is None


def test_point_rejects_impossible_coordinates(client):
    assert client.get("/api/point", params={"lon": 999, "lat": 0}).status_code == 422


def test_hotspots_ordering_and_filtering(client):
    j = client.get("/api/hotspots", params={"geometry": "point", "limit": 20,
                                            "order_by": "exposure_score"}).json()
    scores = [f["properties"]["exposure_score"] for f in j["features"]]
    assert scores == sorted(scores, reverse=True)

    big = client.get("/api/hotspots", params={"geometry": "point", "limit": 500,
                                              "min_area_ha": 100}).json()
    assert all(f["properties"]["area_ha"] >= 100 for f in big["features"])
    assert big["meta"]["matched"] <= j["meta"]["total"]


def test_hotspot_bbox_narrows_results(client):
    everything = client.get("/api/hotspots", params={"geometry": "point", "limit": 20000}).json()
    tight = client.get("/api/hotspots", params={"geometry": "point", "limit": 20000,
                                                "bbox": "88.55,27.28,88.68,27.38"}).json()
    assert 0 < tight["meta"]["matched"] < everything["meta"]["matched"]


def test_bad_bbox_is_rejected(client):
    assert client.get("/api/hotspots", params={"bbox": "1,2,3"}).status_code == 400
    assert client.get("/api/hotspots", params={"bbox": "a,b,c,d"}).status_code == 400


def test_single_hotspot(client):
    f = client.get("/api/hotspots/1").json()
    assert f["properties"]["rank_area"] == 1
    assert f["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert client.get("/api/hotspots/999999").status_code == 404


def test_inventory_filters_compose(client):
    all_pts = client.get("/api/inventory", params={"limit": 5000}).json()
    assert all_pts["meta"]["total"] == 691

    west = client.get("/api/inventory", params={"district": "West Sikkim", "limit": 5000}).json()
    assert all(f["properties"]["district"] == "West Sikkim" for f in west["features"])
    assert 0 < west["meta"]["matched"] < 691

    vh = client.get("/api/inventory", params={"risk_class": 5, "limit": 5000}).json()
    assert all(f["properties"]["risk_class"] == 5 for f in vh["features"])


def test_inventory_strips_bulk_text_unless_asked(client):
    lite = client.get("/api/inventory", params={"limit": 3}).json()["features"][0]
    assert "citation" not in lite["properties"] and "factors" not in lite["properties"]
    full = client.get("/api/inventory", params={"limit": 3, "full": True}).json()["features"][0]
    assert "factors" in full["properties"]


def test_search_finds_places_and_slides(client):
    r = client.get("/api/search", params={"q": "gangtok"}).json()
    assert r["results"] and r["results"][0]["label"] == "Gangtok"
    assert client.get("/api/search", params={"q": "zzzznope"}).json()["results"] == []


def test_stats_headline_is_present(client):
    s = client.get("/api/stats").json()
    assert s["validation"]["headline"]["lift"] > 2
    assert s["exposure"]["roads"]["share_in_high_or_very_high"] > 0
    assert s["cross_tabs"]["slope"] and s["cross_tabs"]["lulc"]


def test_frontend_is_served(client):
    """Anchored to structure, not copy. This previously asserted on the page's
    title text and broke the moment the title was reworded, which tells you
    nothing about whether the app is being served."""
    html = client.get("/").content
    assert b'id="map"' in html
    assert b'js/app.js' in html
    assert client.get("/js/app.js").status_code == 200
    assert client.get("/css/app.css").status_code == 200
    assert client.get("/fonts/Noto Sans Regular/0-255.pbf").status_code == 200
    assert client.get("/fonts/web/CormorantGaramond.woff2").status_code == 200
    assert client.get("/img/grain.png").status_code == 200
