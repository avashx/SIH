# Validation, and how the five categories were chosen

## The problem the pipeline had to solve

`LSM_ensemble.tif` arrived as a **continuous** susceptibility index, 0.0004 – 0.888, not as the
1–5 classification the project scope describes. The five categories the dashboard shows
are therefore derived in `pipeline/s03_classify.py`, and every break value is written to
`data/processed/classification.json` so the choice is auditable.

## Choosing the breaks

Three schemes are computed on every run; the default is **natural breaks (Jenks)**, the convention
in the susceptibility literature, because it puts boundaries where the histogram is already sparse
instead of imposing an arbitrary grid on a strongly right-skewed distribution (median 0.111,
mean 0.234).

Exact Fisher-Jenks is O(n²k) and unusable on 7.7 M pixels, so it is computed as histogram-weighted
1-D k-means over 2,048 bins with deterministic quantile initialisation — the same breaks to well
within one bin width, in under a second.

**Breaks in use:** `0.1175 · 0.2806 · 0.4649 · 0.6434`

| Method | Top-2 classes cover | …and contain | Lift |
|---|---|---|---|
| **natural breaks** | **21.0%** of the area | **99.2%** of mapped landslides | **4.72×** |
| quantile | 40.0% | 100.0% | 2.50× |
| equal interval | 16.9% | 96.0% | 5.68× |

Equal interval scores a higher lift by drawing a tighter High+Very High envelope, but it misses
4% of mapped landslides entirely and leaves the Very High class too small to plan against. Natural
breaks captures 99.2% while holding the hotspot class to a usable 10.5% of the state. Change
`classification.method` in `config/layers.yml` and re-run `make data-force` to switch; the
comparison table in the dashboard updates itself.

## Results with the chosen breaks

| Class | Index range | Area | Share | Mapped slides | Density ratio |
|---|---|---|---|---|---|
| 1 Very Low | 0.0004 – 0.1175 | 3,585 km² | 51.4% | 0 | 0.00× |
| 2 Low | 0.1175 – 0.2806 | 1,109 km² | 15.9% | 0 | 0.00× |
| 3 Moderate | 0.2806 – 0.4649 | 810 km² | 11.6% | 5 | 0.07× |
| 4 High | 0.4649 – 0.6434 | 736 km² | 10.6% | 105 | 1.52× |
| 5 **Very High** | 0.6434 – 0.8882 | **729 km²** | 10.5% | **544** | **7.95×** |

Density ratio is the share of landslides divided by the share of area. 1.00× would mean landslides
fall there no more often than chance.

**Success-rate AUC 0.948.** The top 10% of Sikkim by susceptibility contains 81.7% of every
landslide the GSI has mapped; the top 20% contains 98.8%.

## What these numbers are not

**This is a success-rate curve, not a prediction-rate curve.** The GSI inventory was almost
certainly used to train the five models. Scoring the ensemble against its own training data
measures goodness of fit, not out-of-sample skill. The clean 0-and-0 in classes 1 and 2 is a
symptom of exactly that: a genuinely held-out inventory would leak some points downward.

To convert this into a defensible prediction rate, the team needs to split the 691 points
(spatially, not randomly — nearby landslides are not independent), retrain on one half, and score
on the other. That is a modelling task for the GIS side, not a dashboard task, but it is the
single highest-value thing that could be added before a national round.

Three further caveats, carried in `stats.json` and shown in the dashboard:

- **37 of 691** inventory points fall outside the ensemble's extent and are excluded from scoring.
- GSI points are mapped at ~1:50,000, so a point can sit tens of metres from the actual scarp,
  which blurs the value sampled at 30 m.
- The inventory is road- and settlement-biased (see [DATA.md](DATA.md)); both the score and the
  training set inherit that bias.

## Hotspots

Class 5 is sieved at 12 pixels (1.08 ha) to drop single-pixel specks and fill sub-hectare holes,
then labelled into **918 8-connected components**, each carrying zonal attributes.

Connectivity has to match between the sieve and the polygonisation. It did not at first: sieving
8-connected and polygonising 4-connected shattered patches into 10,236 fragments, 8,900 of them a
single pixel. Aligning both to 8-connectivity gives 918 real patches.

**The largest patch is 633 km² — 87% of all Very High terrain in one blob** across southern Sikkim.
That is not a "hotspot" in any operational sense, and it is partly the road artefact stitching
separate slopes into one connected region. It is why hotspots can be ranked by **exposure** rather
than area:

```
exposure = 100 × ( 0.40·pctrank(night-lights sum)
                 + 0.25·pctrank(built-up pixels)
                 + 0.20·road proximity
                 + 0.15·pctrank(area) )
road proximity = clip((2000 − min_dist_road_m) / 1900, 0, 1)
```

Percentile ranks, not max-normalisation, because patch areas span five orders of magnitude and one
patch would otherwise swamp the scale. **This is a transparent screening heuristic, not a
calibrated risk model** — it ranks patches for attention; it does not price consequence. The weights
are in `config/layers.yml` reach and worth arguing about with the team.

## Reproducing

```bash
make data-force        # rebuilds everything and reprints every figure
make test              # asserts the numbers stay coherent
```

`tests/test_pipeline.py` fails the build if class areas stop summing to the classified area, if
breaks stop increasing, if a hotspot fails to reach the Very-High break, or if lift drops below 2×.
