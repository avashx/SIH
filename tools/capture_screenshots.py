"""Capture the dashboard screenshots used by README.md and the submission.

Run against the live deployment (the default) or any local instance:

    pip install playwright                 # not in requirements — a docs tool
    python tools/capture_screenshots.py assets/screenshots
    python tools/capture_screenshots.py assets/screenshots http://localhost:8000/

It drives real Chrome, so what lands in the PNG is what a reviewer sees: the
MapLibre canvas, the tiles the API rendered on demand, the live statistics.

Three things make the run reproducible rather than lucky:

  - the context asks for reduced motion, which the dashboard honours by skipping
    the opening globe flight entirely, so there is no camera still easing when
    the shutter opens;
  - controls are clicked through the DOM, not the mouse, because the list view
    and the statistics drawer sit over the buttons that dismiss them and a
    real click would land on whatever is on top;
  - the cursor is parked in the corner before every frame, so no hover popup or
    hover state is captured by accident.

Only the point-inspector shot needs the mouse, because it is a map click. The
hotspot markers carry a generous invisible hit target (`hs-hit`), so that click
would open the hotspot panel instead of querying the pixel — the markers are
toggled off for that one frame and back on afterwards.
"""
from __future__ import annotations

import pathlib
import sys

from playwright.sync_api import sync_playwright

DEFAULT_URL = "https://sikkim-landslide.onrender.com/"

# SwiftShader gives headless Chrome a working WebGL implementation; without it
# MapLibre has no context and every map frame comes out blank.
CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader",
               "--enable-unsafe-swiftshader", "--hide-scrollbars"]

# Fraction of the map viewport that lands in the southern Very-High belt, which
# is where both the interesting pixels and the top-ranked hotspots are.
HOT = (0.45, 0.77)


def settle(page, ms=2000):
    """Let tiles arrive and transitions finish. Generous on purpose — a tile
    that has not painted yet is the one failure this script cannot detect."""
    page.wait_for_timeout(ms)


def js_click(page, sel):
    page.eval_on_selector(sel, "el => el.click()")


def set_checkbox(page, sel, on):
    page.eval_on_selector(
        sel,
        "(el, on) => { el.checked = on; "
        "el.dispatchEvent(new Event('change', {bubbles: true})); }", on)


def set_layer(page, layer_id, on):
    set_checkbox(page, f'.layer[data-id="{layer_id}"] input[type=checkbox]', on)


def close_inspector(page):
    if page.locator("#inspector").get_attribute("hidden") is None:
        js_click(page, "#insp-close")
        settle(page, 800)


def map_click(page, fx, fy):
    box = page.locator("#map").bounding_box()
    page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)


def capture(url: str, out: pathlib.Path):
    out.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        page.mouse.move(4, 4)          # off every hoverable layer
        page.wait_for_timeout(700)
        path = out / name
        page.screenshot(path=str(path))
        print(f"  {name}  ({path.stat().st_size // 1024} KB)")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", args=CHROME_ARGS)
        ctx = browser.new_context(viewport={"width": 1600, "height": 900},
                                  device_scale_factor=2,
                                  reduced_motion="reduce")
        page = ctx.new_page()
        page.on("console",
                lambda m: m.type == "error" and print("  [console]", m.text[:160]))

        # Render's free tier sleeps; the first request can take a minute to wake.
        page.goto(url, wait_until="networkidle", timeout=120_000)
        page.wait_for_selector("#boot", state="detached", timeout=90_000)
        settle(page, 5000)

        print("01 risk map")
        js_click(page, "#sidebar-close")
        settle(page, 2500)
        shot(page, "01-risk-map.png")

        print("02 point inspector")
        set_checkbox(page, "#ov-hotspots", False)
        settle(page, 1500)
        map_click(page, *HOT)
        page.wait_for_selector("#inspector:not([hidden])", timeout=30_000)
        settle(page, 3000)
        shot(page, "02-click-inspect.png")
        close_inspector(page)
        set_checkbox(page, "#ov-hotspots", True)
        settle(page, 1500)

        print("03 hotspot list")
        js_click(page, "#view-list")
        settle(page, 4000)
        shot(page, "03-hotspots.png")

        print("07 hotspot detail")
        # The first card is rank 1 by exposure; opening it returns to the map
        # and puts that patch in the inspector.
        js_click(page, ".list-track .card")
        page.wait_for_selector("#inspector:not([hidden])", timeout=30_000)
        settle(page, 4000)
        shot(page, "07-hotspot-detail.png")
        close_inspector(page)

        print("04 sikkim only")
        js_click(page, "#sidebar-reopen")
        settle(page, 1500)
        js_click(page, "#btn-focus")
        settle(page, 4500)
        shot(page, "04-sikkim-only.png")

        print("06 conditioning factors")
        js_click(page, "#btn-focus")           # back to full context
        settle(page, 3000)
        js_click(page, "#factors-toggle")
        settle(page, 1500)
        # Swap the model output for a factor raster, so the frame shows a factor
        # actually drawn on the map under its own legend.
        set_layer(page, "lsm_class", False)
        set_layer(page, "slope", True)
        settle(page, 5000)
        page.eval_on_selector("#factors-toggle",
                              "el => el.scrollIntoView({block: 'start'})")
        settle(page, 1500)
        shot(page, "06-layers.png")
        set_layer(page, "slope", False)
        set_layer(page, "lsm_class", True)
        js_click(page, "#factors-toggle")
        settle(page, 2500)

        print("05 statistics")
        js_click(page, "#sidebar-close")
        settle(page, 2000)
        js_click(page, "#btn-stats")
        settle(page, 3000)
        js_click(page, '.dt[data-tab="validation"]')
        settle(page, 3000)
        shot(page, "05-statistics.png")

        browser.close()


if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "assets/screenshots")
    url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_URL
    print(f"capturing {url} -> {out}/")
    capture(url, out)
    print("done — downsample to 1600 px wide before committing:")
    print("  sips --resampleWidth 1600 " + str(out / "*.png"))
