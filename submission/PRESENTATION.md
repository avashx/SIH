# Presentation

**Project:** Sikkim Landslide Risk Platform
**Problem Statement ID:** 26001 — AI-Based Early Warning and Landslide Risk Monitoring System in NER
**Category:** Software · **Theme:** Disaster Management (GIS and Remote Sensing)

---

## Slide deck

| | |
|---|---|
| **File** | `submission/SIH-Presentation.pptx` |
| **External link** | _(add a public Google Drive / OneDrive link here if the file is too large for Git)_ |

> Upload the `.pptx` into this folder. If it exceeds GitHub's file-size comfort limit, upload it to
> Drive instead, set sharing to **Anyone with the link — Viewer**, and paste the link above.

---

## Suggested structure

1. **Problem** — landslide exposure in Sikkim; 638 of 691 recorded slides were rainfall-triggered.
2. **Solution** — 17 conditioning factors → 5-model ensemble → 5 risk categories → 918 ranked
   hotspots.
3. **Methodology** — Jenks natural breaks, sieve, connected-component labelling, zonal exposure.
   Emphasise that hotspot extraction is deterministic and every parameter is written out.
4. **Results** — 21% of the area holds 99.2% of mapped landslides; lift 4.72×; AUC 0.948.
5. **Live demo** — risk map, click-to-inspect, hotspot ranking, statistics.
6. **Scope and roadmap** — susceptibility is complete; rapid detection is next; early warning is
   explicitly not claimed.

## Points to state explicitly

- The AUC of 0.948 is a **success-rate** curve, not a prediction-rate curve — the inventory was
  almost certainly in the models' training data, so it measures fit, not out-of-sample skill.
- The largest hotspot patch spans 633 km². It is a connected region, not a single site, which is
  precisely why patches are ranked by **exposure** rather than by area.
- This is a planning map. It is not an early-warning system.
