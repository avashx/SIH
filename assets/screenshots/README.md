# Screenshots

Dashboard screenshots for the submission and for the top-level README.

| File | What it shows |
|---|---|
| `01-risk-map.png` | the five-class risk surface over Sikkim, hotspot markers on |
| `02-click-inspect.png` | point inspector — every conditioning-factor value at one pixel |
| `03-hotspots.png` | the 918 Very-High patches as a list, ranked by exposure |
| `04-sikkim-only.png` | study area isolated, surrounding geography and borders hidden |
| `05-statistics.png` | statistics drawer, Validation tab — success-rate curve and density by class |
| `06-layers.png` | a conditioning factor (slope) drawn with its own legend, all nine listed |
| `07-hotspot-detail.png` | one hotspot — extent, susceptibility, and what is exposed inside it |

## Regenerating

`tools/capture_screenshots.py` drives the live deployment with Playwright and
writes this whole set. It needs `pip install playwright` and a local Chrome;
everything else it reads off the running instance.

```bash
python tools/capture_screenshots.py assets/screenshots
```

Captured at a 1600 x 900 viewport on a 2x device pixel ratio, then downsampled
to 1600 px wide — sharp at the width GitHub renders, without committing 3200 px
files. Use `NN-short-description.png`, numbered in the order they appear in the
demo.
