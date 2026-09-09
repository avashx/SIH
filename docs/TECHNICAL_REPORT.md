# Technical Report — Sikkim Landslide Platform

**Panel 1: susceptibility mapping, hotspot extraction and exposure screening.**
Smart India Hackathon · problem statement **26001**, *AI-Based Early Warning and Landslide Risk
Monitoring System in NER* (MDoNER) · study area **Sikkim, India**.

Every number in this document is produced by `make data` and read back out of
`data/processed/`. Nothing here is typed by hand. Re-run the pipeline and the figures regenerate.

---

## Contents

1. [What the system is](#1-what-the-system-is)
2. [The analysis grid](#2-the-analysis-grid)
3. [Layer reference — ranges, pixel values and encodings](#3-layer-reference)
4. [Classification — how the five categories were derived](#4-classification)
5. [Hotspot extraction and the exposure score](#5-hotspot-extraction)
6. [Zonal statistics and cross-tabulations](#6-zonal-statistics)
7. [Validation](#7-validation)
8. [Engineering — what we built, how, and why](#8-engineering)
9. [Bugs worth recording](#9-bugs-worth-recording)
10. [Known limitations](#10-known-limitations)
11. [Future work](#11-future-work)

---

## 1. What the system is

Three questions, three tracks, three very different levels of maturity:

| Track | Question | Method | Status |
|---|---|---|---|
| **1 · Susceptibility** | Where are slopes predisposed to fail? | 17 static factors → 5 ML models → equal-weight ensemble → 5 classes | **Complete. This document.** |
| 2 · Rapid detection | Has a slope just failed, and where? | 12-channel Sentinel-1 SAR + Sentinel-2 RGB → binary CNN @ 0.5 → 1 km tiles → GradCAM | Model works (~80%, validated 1 June 2025). Not wired in. |
| 3 · Early warning | Is a slope about to fail? | InSAR LOS deformation + live rainfall / soil-moisture triggers | **Not built.** InSAR blocked. |

**Panel 1 is a static planning map.** It carries no live rainfall, no soil moisture and no
deformation signal. It cannot say a slope is failing today. Say "susceptibility" and "rapid
detection"; do not let either be read as "early warning".

### What arrived, and what did not

The delivery contains **9 of the 17** conditioning factors described in the project review, plus the
model output and a landslide inventory — 881 MB across 11 files.

Missing: **aspect, curvature, TWI, elevation** and three others. The platform is registry-driven, so
each is a `config/layers.yml` entry plus `make data` when it lands.

---

## 2. The analysis grid

The delivery arrived in **three resolutions** (10 m, 30 m, ~5 km), **two CRSs** (UTM 45N and
geographic) and **four no-data conventions**. Nothing downstream can be trusted until they share a
lattice.

> The rainfall layer has since been re-supplied at 30 m in EPSG:32645, already clipped to the state,
> which removes the geographic-CRS outlier. The original was 21 × 25 px and had to be blown up ~170×;
> the replacement carries 2,018 distinct values over the same 625 – 2,151 mm/yr range. The pipeline
> needed a one-line path change to adopt it — the point of the registry design.

```
CRS          EPSG:32645  (WGS 84 / UTM zone 45N)
Resolution   30 m
Size         3007 × 3885 px  =  11,682,195 pixels
Transform    (30, 0, 600206.0083, 0, −30, 3112539.6842)
Bounds UTM   600206.008, 2995989.684 → 690416.008, 3112539.684
Bounds WGS84 88.010695°E, 27.073148°N → 88.938677°E, 28.134655°N
Centre       88.474686°E, 27.603901°N
Pixel area   900 m²  =  0.0009 km²  =  0.09 ha
```

**Why this grid.** It is the union of every source layer's extent at 30 m, **snapped to the LSM
ensemble's own pixel origin**. That snap matters: the model output — the one layer that must not be
smeared — lands on an exact integer pixel offset and is *copied*, not interpolated. Everything else
resamples onto it (nearest for categorical, bilinear/average for continuous).

The 5 km rainfall climatology is excluded from the union calculation; its footprint spills well
beyond Sikkim and would inflate the grid.

**Study-area mask** = the LULC raster's valid footprint.

```
Study area        7,897,990 px  =  7,108.2 km²
Sikkim (official)                   7,096    km²    ← 0.2% agreement
Classified        7,743,174 px  =  6,968.9 km²
Unclassified                        139.3 km²       ← inside Sikkim, no ensemble value
```

---

## 3. Layer reference

Each COG stores **integers**, decoded as `real = stored × scale + offset`. This is what turns
881 MB of float32 into 62 MB with no loss that matters at 30 m.

### 3.1 Model output

| | |
|---|---|
| **`lsm` — Landslide Susceptibility (ensemble)** | continuous, *susceptibility index* |
| Storage | `uint16`, scale **0.0001**, offset 0, nodata **65535** |
| Real range | **0.0004 – 0.8882** |
| Mean / SD | 0.2343 / 0.2425 |
| p2 / p98 | 0.0079 / 0.7886 |
| Median | 0.1107 |
| Stored range | 4 – 8882 |
| Display | `rdylgn_r`, stretched 0.0 – 0.9 → stored 0 – 9000 |
| Coverage | 98.04% of the study area |
| COG size | 15.14 MB |

> **The single most important fact about this file:** it arrived as a *continuous* surface, not the
> 1–5 classification the project review describes. Every category shown in the dashboard is derived
> in `pipeline/s03_classify.py` — see §4.

| | |
|---|---|
| **`lsm_class` — Risk category (5-class)** | categorical, derived |
| Storage | `uint8`, scale 1, offset 0, nodata **0** |
| Values | 1 Very Low · 2 Low · 3 Moderate · 4 High · **5 Very High = hotspot** |
| COG size | 0.66 MB |

### 3.2 Conditioning factors

| Layer | Kind | Units | Storage | Real range | Mean ± SD | p2 – p98 | Coverage | COG |
|---|---|---|---|---|---|---|---|---|
| `slope` | continuous | degrees | `uint16` × 0.01, nd 65535 | 0.0019 – 89.6063 | 28.16 ± 13.20 | 2.74 – 55.48 | 99.88% | 17.16 MB |
| `ndvi` | continuous | NDVI | `int16` × 0.0001, nd −32768 | −0.6877 – 0.9217 | 0.3605 ± 0.2954 | −0.075 – 0.788 | 99.17% | 16.48 MB |
| `dist_roads` | continuous | m | `uint16` × 1, nd 65535 | 0 – 39,871 | 7,320.7 ± 8,526.3 | 30 – 31,812 | 100% | 3.44 MB |
| `dist_drainage` | continuous | m | `uint16` × 1, nd 65535 | 5.94 – 4,590.4 | 697.6 ± 499.8 | 24.3 – 1,882.7 | 99.88% | 5.67 MB |
| `rainfall` | continuous | mm/yr | `uint16` × 0.1, nd 65535 | 625.4 – 2,151.2 | 1,270.3 ± 309.7 | 790 – 1,842 | 100% | 0.25 MB |
| `ntl` | continuous | normalised radiance | `uint16` × 0.0001, nd 65535 | 0.0 – 1.0 | 0.0246 ± 0.0306 | 0.0123 – 0.0936 | 100% | 1.09 MB |
| `lulc` | categorical | — | `uint8`, nd 255 | 1–9 (8 present) | — | — | 100% | 1.36 MB |
| `lithology` | categorical | — | `uint8`, nd 255 | 1–7 | — | — | 100% | 0.12 MB |
| `soil` | categorical | — | `uint8`, nd 255 | 0–4 | — | — | 100% | 0.25 MB |

**Display stretches** (what the tile server renders between):

| Layer | Colormap | Display min → max | Stored min → max |
|---|---|---|---|
| `lsm` | `rdylgn_r` | 0.0 → 0.9 | 0 → 9000 |
| `slope` | `rdylgn_r` | 0 → 90° | 0 → 9000 |
| `ndvi` | `rdylgn` | −0.2 → 0.8 | −2000 → 8000 |
| `dist_roads` | `viridis_r` | 0 → 8000 m | 0 → 8000 |
| `dist_drainage` | `blues_r` | 0 → 2500 m | 0 → 2500 |
| `rainfall` | `ylgnbu` | 600 → 2200 mm/yr | 6000 → 22000 |
| `ntl` | `inferno` | 0.0 → 0.35 | 0 → 3500 |

### 3.3 Categorical class values and areas

**LULC** — *no legend shipped with the raster.* Labels were recovered by measuring each class's
signature across NDVI, night-lights, slope and latitude. Classes marked **?** are the ones the
evidence does **not** settle.

| Value | Label | Area km² | % of state | mean NDVI | mean NTL | mean slope | % north of 27.8°N | Confidence |
|---|---|---|---|---|---|---|---|---|
| 3 | Forest | **3,434.53** | 48.3% | **0.623** | 0.031 | 29.5° | 1% | High |
| 9 | Sparse vegetation / scrub **?** | 1,012.01 | 14.2% | 0.138 | 0.016 | 27.6° | 36% | Low |
| 4 | Alpine meadow / pasture **?** | 907.41 | 12.8% | 0.289 | 0.018 | 24.9° | 43% | Low |
| 7 | Barren / rocky | 882.62 | 12.4% | −0.029 | 0.018 | 29.6° | 41% | High |
| 5 | Snow / glacier | 817.03 | 11.5% | 0.046 | 0.019 | 26.6° | **68%** | High |
| 6 | Water body | 38.49 | 0.5% | **−0.151** | 0.034 | **5.8°** | 65% | High |
| 1 | Built-up | 12.70 | 0.18% | 0.310 | **0.179** | 18.1° | 4% | High |
| 2 | Wetland / valley vegetation **?** | 3.40 | 0.05% | 0.516 | 0.058 | **12.0°** | 0% | Low |

*Class 8 is absent from the raster.* Built-up is identified by night-lights **10× any other class**;
snow/glacier by near-zero NDVI at the highest latitudes; water by the flattest slope and most
negative NDVI.

**Lithology** — named from the team's own published lithology map of Sikkim. Values were matched to
labels by area **and** geography, not by area alone: Sedimentary is the north-east corner
(lon mean 88.66), Unconsolidated the north-west edge (88.22), and Schist reaches further east
(88.80) than Slate (88.57) — which is what separates that otherwise similar pair. Rendering the
raster with these colours reproduces the reference map feature for feature.

| Value | Label | Area km² | % | Colour |
|---|---|---|---|---|
| 1 | Metamorphic | 6,185.82 | 87.0% | `#7a1216` |
| 2 | Paragneiss | 542.45 | 7.6% | `#ffd24a` |
| 4 | Slate | 164.67 | 2.3% | `#8de83a` |
| 3 | Schist | 117.56 | 1.7% | `#f92e0c` |
| 5 | Sedimentary | 79.24 | 1.1% | `#45be8c` |
| 6 | Unconsolidated | 17.68 | 0.25% | `#2080a0` |
| 7 | Igneous | 0.78 | 0.01% | `#f8bfc6` |

**Soil** — named from the team's own soil map of Sikkim. Matched by area and latitude: Sandy Clay
Loam dominates the south (lat mean 27.44), Silty Clay Loam the north (27.81), and Loam is the
far-southern strip (27.18). Value 0 is a **real class**, not a hole — 621 km² of
high-altitude ice and rock where soil is not mapped.

| Value | Label | Area km² | % | Colour |
|---|---|---|---|---|
| 3 | Sandy Clay Loam | 4,188.57 | 58.9% | `#8b1030` |
| 4 | Silty Clay Loam | 2,097.61 | 29.5% | `#a18d7e` |
| 0 | Ice/No data | 621.25 | 8.7% | `#bfbfbf` |
| 1 | Loam | 176.80 | 2.5% | `#ffb3ba` |
| 2 | Silt | 23.97 | 0.34% | `#efc000` |

### 3.4 Vector layers

**`inventory`** — Geological Survey of India national landslide inventory (Bhukosh), Sikkim extract.
**691 points, 39 attributes**.

| Facet | Distribution |
|---|---|
| District | West Sikkim 221 · South Sikkim 176 · East Sikkim 176 · North Sikkim 116 · East District 2 |
| Trigger | **Rainfall 638** · Rainfall/Earthquake 39 · Rainfall. 4 · other 3 · unrecorded 7 |
| Material | Debris 534 · Rock 135 · Earth 16 · Rock-cum-Debris 5 |
| Movement | Slide 617 · Fall 52 · Subsidence 13 · Topple 5 |
| Activity | Active 594 · Suspended 53 · Dormant 32 · Reactivated 8 |
| Road class | 89 distinct road names — SH 165, NH 65, North Sikkim Highway 42 … |

**638 of 691 were rainfall-triggered.** That is the empirical case for keeping the static stack and
making *only* the rainfall layer live.

**`hotspots`** — 918 polygons + 918 centroids, derived. See §5.

---

## 4. Classification

The ensemble is a continuous index. The five categories are derived here, and every break is written
to `data/processed/classification.json` so the choice is auditable rather than buried in code.

### Method

Default is **natural breaks (Jenks)** — the convention in the susceptibility literature, because it
places boundaries where the histogram is already sparse rather than imposing an arbitrary grid on a
strongly right-skewed distribution (median 0.1107, mean 0.2343).

Exact Fisher-Jenks is O(n²k) and unusable on 7.7 M pixels. It is computed as **histogram-weighted
1-D k-means** over 2,048 bins with deterministic quantile initialisation, which reproduces the same
breaks to well within one bin width in under a second.

### Breaks

| Method | Break 1 | Break 2 | Break 3 | Break 4 |
|---|---|---|---|---|
| **natural_breaks** ← in use | **0.117502** | **0.280616** | **0.464883** | **0.643408** |
| quantile | 0.034100 | 0.078600 | 0.184200 | 0.480200 |
| equal_interval | 0.177960 | 0.355520 | 0.533080 | 0.710640 |

### Resulting distribution

| Class | Label | Index range | Pixels | Area km² | Share |
|---|---|---|---|---|---|
| 1 | Very Low | 0.0004 – 0.1175 | 3,983,618 | 3,585.26 | 51.45% |
| 2 | Low | 0.1175 – 0.2806 | 1,231,729 | 1,108.56 | 15.91% |
| 3 | Moderate | 0.2806 – 0.4649 | 900,045 | 810.04 | 11.62% |
| 4 | High | 0.4649 – 0.6434 | 817,705 | 735.93 | 10.56% |
| **5** | **Very High** | **0.6434 – 0.8882** | **810,077** | **729.07** | **10.46%** |

### Why natural breaks and not the alternatives

| Method | Top-2 classes cover | …and contain | Lift |
|---|---|---|---|
| **natural_breaks** | **21.02%** of area | **99.24%** of mapped landslides | **4.72×** |
| quantile | 40.00% | 100.00% | 2.50× |
| equal_interval | 16.90% | 96.02% | 5.68× |

Equal interval scores a higher lift by drawing a tighter envelope, but it **misses 4% of mapped
landslides entirely** and leaves Very High too small to plan against. Quantile is too permissive at
40% of the state. Natural breaks captures 99.24% while holding the hotspot class to a usable 10.46%.

Change `classification.method` in `config/layers.yml` and re-run `make data-force` to switch; the
comparison table in the dashboard regenerates itself.

---

## 5. Hotspot extraction

Class 5 is the hotspot layer. Extraction is four steps:

```
1. binary mask        classes == 5                      810,077 px
2. sieve              min 12 px (1.08 ha), 8-connected  813,789 px
                        specks removed 24,172 · holes filled 27,884
3. connected labels   scipy.ndimage.label, 8-connectivity   918 patches
4. polygonise         rasterio.features.shapes on the label
                      raster, simplify 45 m, 5 dp coords     918 polygons
```

**Connectivity has to match between the sieve and the polygonisation.** It did not at first: sieving
8-connected and polygonising 4-connected shattered patches into 10,236 fragments, 8,900 of them a
single pixel. Aligning both to 8-connectivity gives 918 real patches.

| | |
|---|---|
| Patches | **918** |
| Total area | 732.41 km² |
| Largest | **633.34 km²** — 86.5% of all Very High terrain in one connected blob |
| Median | **2.25 ha** |
| Minimum | 1.08 ha (the sieve floor) |

> **The largest patch is not a "hotspot" in any operational sense.** It is a single connected region
> spanning southern Sikkim, and it is partly the distance-to-road artefact stitching separate slopes
> together. This is exactly why patches can be ranked by **exposure** rather than area.

### Per-patch zonal attributes

Computed with `scipy.ndimage` labelled statistics over the label raster — one pass, not 918 clips:

| Attribute | How |
|---|---|
| `area_ha`, `area_km2` | pixel count × 0.09 ha |
| `mean_index`, `max_index` | `ndimage.mean` / `maximum` over `lsm` |
| `mean_slope_deg`, `max_slope_deg` | over `slope` |
| `min_dist_road_m` | `ndimage.minimum` over `dist_roads` |
| `builtup_ha`, `cropland_ha` | pixel count where `lulc ∈ {1}` / `{4}` |
| `ntl_sum` | `ndimage.sum` over `ntl` — population proxy |
| `past_slides` | STRtree point-in-polygon join against the GSI inventory |
| `rank_area`, `rank_exposure` | ordinal ranks |

### The exposure score

```
exposure = 100 × ( 0.40 · pctrank(ntl_sum)
                 + 0.25 · pctrank(builtup_px)
                 + 0.20 · road_proximity
                 + 0.15 · pctrank(area_px) )

road_proximity = clip((2000 − min_dist_road_m) / 1900, 0, 1)
```

**Percentile ranks, not max-normalisation** — patch areas span five orders of magnitude, and raw
normalisation would let the single 633 km² patch swamp the scale.

> This is a **transparent screening heuristic, not a calibrated risk model.** It ranks patches for
> attention; it does not price consequence. The weights live in `config/layers.yml` and are worth
> arguing about.

---

## 6. Zonal statistics

All cross-tabs are masked to the study area and report the share of each class falling in
**High or Very High** (classes 4–5).

### 6.1 Risk by slope band

| Slope band | Area km² | High+VH km² | Share |
|---|---|---|---|
| 0–15° | 1,185.83 | 136.20 | 11.5% |
| 15–25° | 1,690.06 | 431.04 | 25.5% |
| **25–35°** | **2,118.06** | **547.54** | **25.9%** |
| 35–45° | 1,424.17 | 281.39 | 19.8% |
| 45–90° | 681.74 | 68.84 | 10.1% |

**Risk peaks at 25–35°, then falls.** That is geomorphologically correct and a genuinely good sign:
the steepest terrain in Sikkim is bare rock and ice with no regolith to mobilise, so it produces
rockfall rather than the debris slides the inventory records. A model that simply tracked slope
would rise monotonically. This one does not.

### 6.2 Risk by land cover

| Land cover | Area km² | High+VH km² | Share |
|---|---|---|---|
| Wetland / valley vegetation **?** | 3.40 | 2.73 | 80.3% |
| **Built-up** | **12.70** | **9.70** | **76.4%** |
| **Forest** | **3,434.53** | **1,377.68** | **40.1%** |
| Water body | 38.49 | 2.79 | 7.3% |
| Alpine meadow / pasture **?** | 907.41 | 48.97 | 5.4% |
| Snow / glacier | 817.03 | 17.38 | 2.1% |
| Sparse vegetation / scrub **?** | 1,012.01 | 5.73 | 0.6% |
| Barren / rocky | 882.62 | 0.02 | 0.0% |

**76% of Sikkim's built-up land sits in High or Very High.** Settlement in Sikkim follows the mid-
altitude valley slopes, which is precisely the terrain the model flags. The 80% on wetland is noise
— the class is 3.4 km².

### 6.3 Risk by lithology

| Lithology | Area km² | High+VH km² | Share |
|---|---|---|---|
| **Schist** | 117.56 | 64.45 | **54.8%** |
| **Slate** | 164.67 | 74.06 | **45.0%** |
| Metamorphic | 6,185.82 | 1,234.85 | 20.0% |
| Paragneiss | 542.45 | 91.65 | 16.9% |
| Sedimentary / Unconsolidated / Igneous | 97.70 | 0.00 | 0.0% |

**Schist and slate are the two most landslide-prone rocks in the state**, at 2.5× the dominant
metamorphic unit on 4% of the area. That is textbook and a real check on the model: both are
strongly foliated, weather to clay-rich regolith, and fail along their foliation planes. A model
that had learned nothing about rock would not have separated them from the metamorphic mass.

### 6.4 Risk by soil

| Soil | Area km² | High+VH km² | Share |
|---|---|---|---|
| **Loam** | 176.80 | 151.04 | **85.4%** |
| Sandy Clay Loam | 4,188.57 | 1,293.02 | 30.9% |
| Silt | 23.97 | 5.57 | 23.2% |
| Silty Clay Loam | 2,097.61 | 15.37 | 0.7% |
| Ice/No data | 621.25 | 0.00 | 0.0% |
| **Sum** | **7,108.20** | | ← equals the study area exactly |

**Loam is 85% High+ across 177 km²** — the strongest single-factor signal in the stack. It is the
far-southern strip, the same belt that carries most of Sikkim's settlement and road network.

### 6.5 Exposure

| Metric | Value |
|---|---|
| Built-up total | 12.70 km² |
| Built-up in High+VH | **9.70 km² (76.4%)** |
| Built-up in Very High | 4.89 km² |
| Road cells (distance = 0) | 69,326 |
| Estimated network length | ~2,079.8 km |
| Network in High+VH | **74.3%** (~1,545.1 km) |
| Network in Very High | 58.8% (~1,223.5 km) |
| Very High within 250 m of a road | 263.81 km² |
| Night-lights in High+VH | **41.1%** of Sikkim's total radiance |
| Night-lights in Very High | 20.1% |
| Mapped landslides inside a hotspot | 520 of 691 (75.3%) |

> **Read the shares, not the kilometres.** The road vector was not supplied — only a distance
> raster. Cells at distance 0 are taken as carrying the centreline, so length ≈ cell count × 30 m.
> The ~2,080 km estimate is close to Sikkim's *total* road network, not the ~700–900 km of National
> and State Highways, so despite the file name `dis_to_Major_roads` the underlying network looks
> broader than "major roads". The **share** is sound because the same rasterisation bias affects
> numerator and denominator identically; cell-count × 30 m also under-reads diagonals by up to 41%.

---

## 7. Validation

The ensemble is scored against the **691 GSI inventory points**. 654 are scored; **37 fall outside
the ensemble's extent** and are excluded.

### Landslide density by class

| Class | Area share | Mapped slides | Slide share | Density ratio |
|---|---|---|---|---|
| 1 Very Low | 51.45% | 0 | 0.00% | **0.00×** |
| 2 Low | 15.91% | 0 | 0.00% | **0.00×** |
| 3 Moderate | 11.62% | 5 | 0.76% | 0.07× |
| 4 High | 10.56% | 105 | 16.06% | 1.52× |
| **5 Very High** | **10.46%** | **544** | **83.18%** | **7.95×** |

Density ratio = slide share ÷ area share. 1.00× would mean landslides fall there no more often than
chance.

### Success-rate curve

| Metric | Value |
|---|---|
| **AUC** | **0.9475** |
| Top 10% of area captures | 81.65% of mapped landslides |
| Top 20% of area captures | 98.78% |
| Top 30% of area captures | 100.00% |
| High + Very High (21.02% of area) | **99.24%** of landslides — lift **4.72×** |

### What this number is not

**This is a success-rate curve, not a prediction-rate curve.** The GSI inventory was almost
certainly used to train the five models. Scoring the ensemble against its own training data measures
**goodness of fit, not out-of-sample skill**. The clean 0-and-0 in classes 1 and 2 is a symptom of
exactly that — a genuinely held-out inventory would leak some points downward.

Further caveats:

- **37 of 691** points fall outside the ensemble extent and are excluded.
- GSI points are mapped at ~1:50,000, so a point can sit tens of metres from the actual scarp, which
  blurs the value sampled at 30 m.
- The inventory is **road- and settlement-biased** — 89 distinct road names appear in the records.
  Landslides get mapped where people are. Both the score and the training set inherit that bias, so
  low predicted risk in the unpopulated high north rests on very little evidence.

---

## 8. Engineering

### 8.1 Pipeline

Five ordered steps, resumable (`--from N`) and individually runnable (`--only N`).

| Step | Reads | Writes | Why it exists |
|---|---|---|---|
| `s01_inventory` | raw | `inventory.json` | Catch a wrong CRS or a broken no-data **before** it poisons the stack |
| `s02_harmonise` | raw | `cog/*.tif`, `grid.json` | One grid, one encoding |
| `s03_classify` | `cog/lsm.tif` | `lsm_class.tif`, hotspots, `classification.json` | Continuous index → 5 classes → ranked patches |
| `s04_inventory_points` | KML + COGs | `inventory.geojson` | Parse GSI attributes GDAL drops; enrich; join to hotspots |
| `s05_stats` | everything | `stats.json` | Area, validation, exposure, cross-tabs |

Full rebuild from the 881 MB raw delivery: **83 seconds**.

### 8.2 Storage — why integer-encoded COGs

Float32 at 30 m over 11.7 M pixels is 46 MB per layer. Ten layers is 460 MB — too large to commit,
and GitHub caps a single file at 100 MB.

Each layer is instead written as `uint8`/`uint16`/`int16` at a scale that preserves meaningful
precision, DEFLATE-compressed with a horizontal predictor, internally tiled at 512 px with five
overview levels.

```
881 MB raw  →  62 MB of COGs      (14× reduction, no loss that matters at 30 m)
```

That is what makes `data/processed/` committable, and therefore what makes the repository
**clone-and-run without the raw delivery**.

### 8.3 Tiles rendered on demand

There is no tile pyramid. `rio-tiler` opens the COG, reads the 512 px block at the overview level
the zoom needs, applies the registry's colormap and returns a PNG.

**Measured: 13–35 ms per tile**, z9 to z15, across all eleven layers.

Pre-generating z8–z16 for eleven layers would add hundreds of megabytes, cap the zoom, and need
invalidating on every pipeline run. On-demand rendering also gives `?vmin=&vmax=&colormap=` and
`?classes=` for free — the last of which is what lets the dashboard's category rail isolate a single
risk class **server-side**, with no second copy of the raster.

### 8.4 Point queries

`/api/point` reads a **1×1 window** from each COG — eleven cheap disk seeks, not eleven raster
loads. This is what makes click-to-inspect feel instant, and it scales unchanged to the full 17
factors.

`pipeline/s04` samples the inventory through the same code path, which makes `inventory.geojson` a
regression fixture for the API as well as a map layer.

### 8.5 Vectors in memory

`hotspots.geojson` (918 polygons, 8 MB) and `inventory.geojson` (691 points) load once at start-up
into an **STRtree** index, so a bbox query while the user pans is a spatial-index lookup rather than
a scan. At this size that is far simpler than PostGIS and costs nothing — the process idles at
**~90 MB RSS**.

*When to move to PostGIS:* when detected events start being written (panel 2), when more than one
process needs to write, or past ~100k features. The API is shaped so swapping `backend/features.py`
for a database-backed store changes nothing else.

### 8.6 The registry is the contract

`config/layers.yml` is read by the pipeline, the API **and** the UI. It carries each layer's source
path, no-data convention, resampling method, storage encoding, display colours, class labels and the
prose shown in the sidebar.

**Adding a conditioning factor is: drop the `.tif` in, add an entry, `make data`.** No Python, no
JavaScript. That is deliberate — eight of the seventeen factors have not arrived yet.

### 8.7 Front end

No build step. Vendored MapLibre GL JS, vendored fonts, ES modules, hand-written CSS — a teammate
can edit it without installing Node.

- **Two base maps**, Light (Esri gray canvas) and Terrain (OpenTopoMap), on a light theme by
  default. Neither paints an opaque background colour, so the CSS vignette shows through the canvas
  and a slow or missing tile CDN degrades to a coloured ground rather than a blank rectangle.
- **Luminous hotspots** are three stacked GPU circle layers — bloom, halo, core — using MapLibre's
  `circle-blur`, sized off `exposure_score` so size and brightness encode what is at stake. Exposure
  is well spread across the 918 patches (p25 38, p50 53, p75 69), so the radii span a matching range
  — a 0.9–4.4 px core, 5–30 px bloom. Sprite images were rejected: `circle-blur` renders all 918
  points in one GPU pass.
- **Category rail** filters the raster server-side (`?classes=5`) and the points client-side.
- **Reference geography and a globe.** Country and first-level admin outlines (Natural Earth, public
  domain) sit under the factor rasters so the ground around Sikkim is context rather than void, and
  MapLibre 5's globe projection transitions to mercator on its own as you zoom in — no second
  library. The two border files cross-fade: the 1:110m world outlines carry the globe, the 1:10m
  regional file takes over by z6, so a national border is never drawn twice at two generalisations.
  `tools/build_borders.py` regenerates both; `linemerge` before `simplify` is what takes the regional
  file from 1,066 KB to 178 KB, since clipping leaves thousands of disjoint pieces whose endpoints
  `simplify(preserve_topology)` will not touch.

### India's boundary

Both border files depict **India as India claims it**, not by de-facto control.

Every off-the-shelf boundary dataset — Natural Earth's default included — places
Pakistan-administered Kashmir, Gilgit-Baltistan and Aksai Chin outside India. That depiction is not
lawful to publish in India, and this map is presented to an Indian government audience.

Two corrections are applied:

1. **Natural Earth's India point-of-view edition** (`ne_10m_admin_0_countries_ind`) supplies the
   national outline. It moves India's northern extent from 35.49°N to 37.05°N and brings all three
   territories inside. The build asserts this with point-in-polygon tests and aborts if it ever fails.
2. **Contradictory internal lines are cut.** The admin-1 layer still carried Pakistan's and China's
   own provincial divisions across those territories, so drawing it unchanged would have painted the
   Line of Control straight back over an outline that has none. Five Natural Earth disputed-area
   polygons — Gilgit-Baltistan, PoK, Aksai Chin, Shaksgam and the Siachen Glacier — are cleared, and
   India's claimed frontier is drawn in their place at full weight. The 1:110m layer needs a much
   wider cut (0.35° against 0.02°) because its generalised line sits up to ~25 km off the 1:10m
   polygons.

`tests/test_borders.py` guards this: a straight line from Srinagar to Muzaffarabad, Srinagar to
Gilgit-Baltistan, Leh to Aksai Chin and Leh to Siachen must cross **no** drawn boundary, in both
files. A rebuild that reverted to the default dataset fails the build.
- **Responses are gzipped** (`GZipMiddleware`, 1 KB floor). The borders go over the wire at 83 KB
  rather than 230 KB; PNG tiles are already compressed and are untouched.
- **The opening flight.** The map loads as a globe over the Pacific, turns east onto Asia and
  descends onto Sikkim, and the data fades up underneath once the camera has stopped. Three things
  make it read as a shot rather than a transition: the turn and the descent are a **single**
  `flyTo`, which interpolates pan and zoom together along van Wijk's smooth-zoom path so the planet
  is still rotating as it grows — rotating first and then zooming reads as two camera operations,
  because it is; the easing is symmetric (a pure ease-out covered the whole rotation in the first
  second and then spent six more just zooming); and the layers arrive staggered *after* the move, so
  the eye lands on terrain first.
  The curtain drops **before** the boot screen lifts, so the first frame anyone sees is the globe
  rather than the finished map. It is skipped entirely under `prefers-reduced-motion`, and any
  pointer, wheel or key event cancels it into the final state.
- **Five colour themes** (Forest, Night, White, Grey, Black) live entirely in CSS custom properties
  under `[data-theme]`. The risk ramp is deliberately excluded — a Very-High pixel stays the same red
  in every theme, or the map stops meaning anything. Map markers are repainted in JS on theme change,
  since the canvas is not styled by CSS: the white-glow treatment inverts to a deep ember core on the
  light theme, where white on near-white would be nothing at all.
- Everything remote is optional. Fonts (84 KB) and MapLibre (852 KB) are local.

### 8.8 Testing and CI

**45 tests.** Pipeline tests assert the artefacts stay coherent — all COGs share one grid, classes
are exactly 1–5, class areas sum to the classified area, breaks increase, every hotspot reaches the
Very-High break, polygons and centroids match 1:1, and **lift stays above 2×**. API tests assert the
contract — tiles render as valid PNGs at every zoom, out-of-bounds tiles are valid transparent PNGs,
the class filter isolates a category, filters compose, bad input is rejected.

CI runs the suite, then **builds the Docker image and smoke-tests the running container** — health,
dashboard HTML, a real tile, a point query. Docker is not installed on the dev machine, so CI is
what actually validates the Dockerfile.

---

## 9. Bugs worth recording

Each of these was found by testing, not by reading the code. They are recorded because they are the
kind that ship silently.

| Bug | Symptom | Cause | Fix |
|---|---|---|---|
| **Corrupt blank tile** | Every out-of-bounds tile failed to decode — at low zoom, most tiles | A hand-written 1×1 PNG had a wrong IDAT chunk length | Build the PNG with `zlib` + `struct` and correct CRCs |
| **Sieve/polygon connectivity mismatch** | 10,236 "hotspots", 8,900 of them one pixel | `sieve` used 8-connectivity, `shapes` defaulted to 4 | Align both to 8; label with `ndimage` first |
| **Glyph host served HTML** | *Every* GeoJSON overlay vanished — circles included | `fonts.openmaptiles.org` returned an HTML page with status **200**; MapLibre's pbf parser threw inside the tile worker, killing the whole source's parse | Vendor the glyph ranges locally |
| **`[hidden]` overridden** | Three panels opened on load | `.modal{display:grid}` outranks the UA rule for `[hidden]` | Explicit `[hidden]{display:none!important}` |
| **Animation fill-mode** | The map hint would not fade out | `animation:… both` keeps asserting its final opacity, outranking a later `opacity:0` | `animation:none` in the hiding rule |
| **`libexpat.so.1`** | Container never booted | `rasterio`'s wheel bundles GDAL but links against system expat; `python:slim` omits it | `apt-get install libexpat1` |
| **Grid needed raw data** | Tests failed in CI | `build_grid()` opened the raw GeoTIFF only to recover a pixel origin | `resolve_grid()` reads the published `grid.json` |
| **Nested `zoom` expression** | All hotspot markers invisible | MapLibre rejects `zoom` inside arithmetic | Nest the exposure ramp *inside* the zoom interpolate |
| **Unmasked cross-tab** | Soil "Unmapped" reported 4,027 km² instead of 621 km² | The soil cross-tab counted class 0 across the whole grid, absorbing every pixel outside Sikkim | Mask every cross-tab to the study area |
| **Rasters past the boundary** | `soil` drew a grey rectangle over Nepal, Bhutan and West Bengal; three other layers spilled a fringe | `soil` treats 0 as a real class, so every out-of-state pixel stored as 0 and rendered; `ndvi`, `rainfall` and `ntl` leaked a resampling fringe | `mask_with_study_area` on all four — 3,406 km² of false soil removed |
| **CARTO basemap** | "API KEY REQUIRED" stamped across every tile | CARTO now gates its basemap CDN | Switch to Esri / OpenTopoMap |

---

## 10. Known limitations

1. **~139 km² of southern and eastern Sikkim has no ensemble value** although it is inside the study
   area. Those pixels return "no model value".
2. **Random Forest over-fits distance-to-road**, painting Very High directly onto road pixels. The
   equal-weight ensemble damps this; it does not remove it. Some of the 74.3% road-exposure figure
   is this artefact.
3. **The GSI inventory is road- and settlement-biased.** The model has seen few examples from the
   unpopulated high north, so low risk there is weakly evidenced.
4. **Three land-cover labels are still unconfirmed.** Lithology and soil are now named from the
   team's own published maps of Sikkim; LULC classes 2, 4 and 9 remain inferred from the data.
5. **No road vector** — only a distance raster. Absolute lengths are estimates.
6. **No village boundaries or population.** "Population exposed" is a night-lights proxy.
7. **Only 9 of 17 factors** are in the stack.
8. **The five categories were derived here**, not delivered.
9. **Chaten reads Low.** At the approximate coordinates in `reference/places_sikkim.csv`, the site of
   the June 2025 event the detection model was validated on classifies as Low. Check it against the
   event's true extent — if it holds, it is a real and interesting limitation, and better found by
   us than by a judge.

---

## 11. Future work

Ordered by *value per unit of effort against problem statement 26001*, which asks for real-time
monitoring, early warning, and prevention support for the North Eastern Region.

### 11.1 Highest value — closes the gap to the problem statement

**A. Live rainfall — the one layer that has to move.**
Of the 17 factors, 16 are static. Only the trigger needs to be live, and **638 of 691** mapped
landslides were rainfall-triggered. Implementation: a scheduled job pulling CHIRPS (~1 day latency)
or NASA **IMERG Early Run** (~4 hours, 0.1°) onto the same grid as `rainfall_live.tif`, plus a
registry entry. **The dashboard needs no code change** — that is the payoff of the registry design.

**B. A rainfall-threshold trigger — the honest route to "early warning".**
The literature standard is an **intensity–duration (I–D) threshold**: a landslide becomes likely
when rainfall intensity over a duration exceeds a locally calibrated curve, conditioned on
antecedent rainfall. With 691 dated GSI points plus CHIRPS history, an **I-D curve can be fitted for
Sikkim** and combined with the static susceptibility as
`P(failure) ≈ susceptibility × trigger_exceedance`. That is defensible, publishable, and turns panel
3 from a claim into a product.

**C. Unblock InSAR.**
The highest-value unclaimed work in the project, and it *has* a plausible fix that nobody owns.
Deformation currently reads construction as subsidence. **LULC is already in the stack** — mask
pixels whose land cover changed between epochs, and the false positives over built-up areas
disappear. Sentinel-1 SBAS via LiCSBAS or MintPy; the 2019–2022 series already exists.

**D. Spatially held-out validation.**
Today's AUC 0.948 is a success rate on training data. Split the 691 points **spatially** (nearby
landslides are not independent — use k-fold on a spatial block grid), retrain on one fold, score on
the other. This converts the headline number from "fit" to "skill" and is the single highest-value
modelling addition before a national round.

### 11.2 GIS and modelling depth

**E. The missing eight factors.** Aspect, plan/profile curvature, TWI, elevation, SPI, relative
relief, distance to lineaments/faults. Each is a config entry once delivered. TWI and curvature in
particular are the standard controls on shallow translational failure — the dominant mechanism in
this inventory.

**F. Replace the night-lights proxy with real population.** Census 2011 village points, or WorldPop
100 m rasters, give an actual headcount instead of "41% of radiance". This directly answers the
problem statement's "isolate remote villages" framing, and unlocks *villages exposed* as a
first-class statistic.

**G. Road-corridor risk instead of blob hotspots.** The 633 km² patch is useless operationally.
Intersecting Very High with a 250 m road buffer fragments it into **rankable road segments** — "this
7 km of NH-10 between Rangpo and Singtam is the highest-exposure corridor in the state". That is
what a road authority can actually act on. The 263.81 km² figure is already computed; it needs the
road vector to become segments.

**H. Runout modelling.** Susceptibility says where a slope fails; it does not say what is downhill.
A simple flow-routing runout (Flow-R style, or an angle-of-reach model on the DEM) turns source
zones into **impact zones**, which is what determines whether a village is actually at risk.

**I. Uncertainty as a first-class layer.** The five models disagree. Their per-pixel **standard
deviation** is already computable from the individual model rasters and would show where the
ensemble is confident versus where it is guessing. Judges notice honesty about uncertainty.

### 11.3 Platform and product

**J. PostGIS + detected events.** Panel 2 writes time-stamped detections. That is the point where an
in-memory store stops being right: `/api/detections?from=&to=`, a time slider, and a detection
gallery page.

**K. Alerting.** Once the trigger exists: subscribe a village or a road segment, get an SMS/webhook
when its combined score crosses a threshold. Cheap to build, and it is literally what the problem
statement asks for.

**L. Offline-first field mode.** Sikkim has patchy connectivity, and responders are exactly the
people who need this. A service worker caching the base-map tiles for the state, the class raster and
the hotspot list would make the app usable in the field. Our own tiles are the easy half; the
base-map tiles are the volume.

**M. Field-report ingestion.** The problem statement mentions geotechnical photographs. A simple
authenticated endpoint accepting a photo + GPS + a short form would let field staff validate or
refute the map, growing the inventory and creating the *held-out* set item D needs.

**N. Deployment hardening.** Cache tiles at a CDN edge, add `?v=` cache-busting keyed to the
pipeline run, and set `--min-instances=1` for demo day to remove the cold start.

### 11.4 Framing for the judges

The strongest version of this project is not the one that claims the most. It is the one that shows:

- **a validated static product** (AUC 0.948, lift 4.72×, 99.24% of mapped landslides in 21% of the
  state),
- **a working detection model** (~80%, validated on a real June 2025 event),
- **a clear, costed plan** for the early-warning gap, with the specific blocker named and a fix
  proposed,
- and **explicit honesty** about what is not built.

The framing to carry in is: *Rapid Satellite-Based
Detection System*. A team that says plainly what its model cannot do is more credible than one that
oversells — and every limitation in §10 has a corresponding item in §11.

---

*Generated from `data/processed/` — regenerate with `make data-force`.*
