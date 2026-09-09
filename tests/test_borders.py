"""The map is presented to an Indian government audience.

Depicting Jammu & Kashmir or Ladakh by de-facto control — which is what every
off-the-shelf boundary dataset does by default — is not lawful to publish in
India. These tests fail the build if a rebuild of the boundary vectors ever
reverts to that depiction.
"""
import json
import pathlib

import pytest
from shapely.geometry import LineString, Point, shape
from shapely.ops import unary_union

DATA = pathlib.Path(__file__).resolve().parents[1] / "frontend" / "data"

# Places India administers, paired with territory India claims. If the map shows
# the claim, no boundary line lies between them.
CLAIM_PAIRS = [
    ("Srinagar", (74.80, 34.08), "PoK (Muzaffarabad)", (73.60, 34.20)),
    ("Srinagar", (74.80, 34.08), "Gilgit-Baltistan", (75.00, 36.00)),
    ("Leh", (77.58, 34.16), "Aksai Chin", (79.00, 35.00)),
    ("Leh", (77.58, 34.16), "Siachen", (77.10, 35.40)),
]


def _lines(name):
    path = DATA / f"borders-{name}.geojson"
    if not path.exists():
        pytest.skip(f"{path.name} not built")
    doc = json.loads(path.read_text())
    return unary_union([shape(f["geometry"]) for f in doc["features"]])


@pytest.mark.parametrize("layer", ["world", "region"])
@pytest.mark.parametrize("a_name,a,b_name,b", CLAIM_PAIRS)
def test_no_border_splits_indian_claim(layer, a_name, a, b_name, b):
    """A straight line from Indian-administered ground into claimed territory
    must not cross a drawn boundary."""
    lines = _lines(layer)
    path = LineString([a, b])
    assert not path.crosses(lines), (
        f"borders-{layer}: a boundary line separates {a_name} from {b_name} — "
        f"Jammu & Kashmir / Ladakh is being drawn by de-facto control"
    )


def test_the_window_rectangle_is_not_drawn_as_a_border():
    """Clipping the polygons and taking the boundary afterwards drew the clip
    rectangle itself as though it were a frontier.

    Proximity to the window edge is NOT the symptom — real borders are legitimately
    truncated there. The symptom is a perfectly axis-aligned run, which no natural
    boundary produces.
    """
    lines = _lines("region")
    geoms = list(lines.geoms) if hasattr(lines, "geoms") else [lines]
    for ls in geoms:
        xs = [c[0] for c in ls.coords]
        ys = [c[1] for c in ls.coords]
        if len(ls.coords) < 2:
            continue
        axis_aligned = (max(xs) - min(xs) < 1e-6) or (max(ys) - min(ys) < 1e-6)
        assert not (axis_aligned and ls.length > 1.0), (
            f"an axis-aligned run of {ls.length:.1f}° is in the data — "
            f"the clip window is being drawn as a border"
        )


def test_border_files_stay_small_enough_to_ship():
    for name, limit_kb in (("world", 400), ("region", 400)):
        path = DATA / f"borders-{name}.geojson"
        if not path.exists():
            pytest.skip(f"{path.name} not built")
        kb = path.stat().st_size / 1024
        assert kb < limit_kb, f"borders-{name} is {kb:.0f} KB"
