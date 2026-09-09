/* Map construction and every layer that lives on it.

   The hotspot markers are the visual centrepiece. They are built as three stacked
   circle layers rather than sprite images: an outer bloom, a mid halo and a hard
   core, each with `circle-blur`. That renders a real luminous point on the GPU for
   all 918 patches at once, and the radii can be driven straight off exposure_score
   so a brighter dot genuinely means more is at stake.

   A requestAnimationFrame loop breathes the bloom radius. It is a slow sine — the
   point is to make the map feel alive, not to distract from it. */
import { BASEMAPS, baseStyle } from './basemaps.js';
import { api } from './api.js';
import { groundIsLight } from './theme.js';

export const RASTER_ROOT = 'zzz-raster-anchor';

/* Borders are chrome, so they follow the theme rather than sitting at a fixed
   white that would glare on the light theme. The literal here is only the initial
   value; applyMarkerTheme() repaints it. */
const BORDER_COLOR = '#8ebcb6';

/* A 15-degree graticule, built rather than shipped - it is a few hundred bytes of
   generated line and only ever visible on the globe. */
function graticule(step = 15) {
  const features = [];
  for (let lon = -180; lon <= 180; lon += step) {
    const line = [];
    for (let lat = -80; lat <= 80; lat += 2) line.push([lon, lat]);
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
  }
  for (let lat = -75; lat <= 75; lat += step) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 2) line.push([lon, lat]);
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
  }
  return { type: 'FeatureCollection', features };
}

export class MapView {
  constructor(el, meta) {
    this.meta = meta;
    this.basemap = BASEMAPS[0];
    const [w, s, e, n] = meta.grid.bounds_wgs84;

    this.map = new maplibregl.Map({
      container: el,
      style: baseStyle(this.basemap, MapView.styleOpts()),
      bounds: [[w, s], [e, n]],
      // Desktop leaves room for the drawer, the rail and the readout; a phone has
      // none of them, and the desktop padding would push Sikkim off the screen.
      fitBoundsOptions: { padding: window.innerWidth < 900
        ? { top: 24, bottom: 96, left: 18, right: 18 }
        : { top: 56, bottom: 84, left: 388, right: 250 } },
      // No maxBounds, and a minZoom that stops where the globe fills the frame
      // rather than floating small inside it. Sikkim is still where every camera
      // move lands.
      minZoom: 1.4, maxZoom: 16, attributionControl: false,
      dragRotate: false, pitchWithRotate: false, fadeDuration: 220,
    });
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-right');
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.touchZoomRotate.disableRotation();

    this.rasterOrder = [];
    this.pulse = 0;
    this.ready = new Promise(res => this.map.on('load', () => {
      this._scaffold();
      this.applyMarkerTheme();
      this._startPulse();
      res(this);
    }));
  }

  _scaffold() {
    const m = this.map;
    const empty = { type: 'FeatureCollection', features: [] };

    /* ---- reference geography -------------------------------------------
       Country and state outlines so the ground around Sikkim is not a void, and
       a graticule that only means anything once the map is a globe. Added before
       the anchor, so factor rasters draw over them: the data is the subject and
       these are context. */
    m.addSource('graticule', { type: 'geojson', data: graticule() });
    m.addLayer({ id: 'graticule-line', type: 'line', source: 'graticule', paint: {
      'line-color': BORDER_COLOR,
      'line-width': 0.5,
      // Only on the globe. Flat, a graticule is just clutter over the data.
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.35, 3, 0.22, 5, 0],
    } });

    m.addSource('borders-world', { type: 'geojson', data: empty });
    m.addLayer({ id: 'border-country', type: 'line', source: 'borders-world', paint: {
      'line-color': BORDER_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 4, 0.9, 9, 1],
      // Fades out as border-admin1 fades in: both carry national borders, and the
      // 1:110m version would otherwise ghost alongside the 1:10m one.
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 1.4, 0.8, 4, 0.62, 6, 0.16, 8, 0.07],
    } });

    m.addSource('borders-region', { type: 'geojson', data: empty });
    m.addLayer({ id: 'border-admin1', type: 'line', source: 'borders-region', paint: {
      'line-color': BORDER_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 0.85, 12, 1.2],
      // Takes over from the coarse outlines as soon as it is worth drawing.
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 3.5, 0, 5, 0.42, 7, 0.6, 11, 0.5],
    } });

    /* The study-area boundary, drawn only while "Sikkim only" is on. With the base
       map hidden the risk surface would otherwise end on a raw raster edge; this
       gives the state its own outline to end on. */
    m.addSource('aoi', { type: 'geojson', data: empty });
    m.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': BORDER_COLOR, 'line-width': 1.2, 'line-opacity': 0.9 } });

    m.addSource('anchor', { type: 'geojson', data: empty });
    m.addLayer({ id: RASTER_ROOT, type: 'circle', source: 'anchor',
                 paint: { 'circle-radius': 0, 'circle-opacity': 0 } });

    /* ---- hotspot outlines ---- */
    m.addSource('hotspot-poly', { type: 'geojson', data: empty });
    m.addLayer({ id: 'hotspot-fill', type: 'fill', source: 'hotspot-poly',
      paint: { 'fill-color': '#ff7f32', 'fill-opacity': 0.10 }, layout: { visibility: 'none' } });
    m.addLayer({ id: 'hotspot-line', type: 'line', source: 'hotspot-poly',
      paint: { 'line-color': '#ffb27a', 'line-opacity': 0.7,
               'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.6] },
      layout: { visibility: 'none' } });

    /* ---- luminous hotspot points ------------------------------------------
       Radius scales with exposure_score, so the eye is drawn to the patches
       where most is exposed rather than simply the largest.

       MapLibre only accepts `zoom` at the top level of an interpolate, so the
       two inputs are nested rather than multiplied: zoom on the outside, the
       exposure ramp as each stop's output. */
    const glow = (lo, hi) => ['interpolate', ['linear'], ['zoom'],
      7,  ['interpolate', ['linear'], ['get', 'exposure_score'], 0, lo * 0.34, 100, hi * 0.34],
      9,  ['interpolate', ['linear'], ['get', 'exposure_score'], 0, lo * 0.55, 100, hi * 0.55],
      11, ['interpolate', ['linear'], ['get', 'exposure_score'], 0, lo, 100, hi],
      15, ['interpolate', ['linear'], ['get', 'exposure_score'], 0, lo * 1.7, 100, hi * 1.7]];
    const zScale = (base) => ['interpolate', ['linear'], ['zoom'], 7, base * 0.75, 11, base, 15, base * 1.7];

    m.addSource('hotspot-pt', { type: 'geojson', data: empty });

    /* The exposure range is wide enough to read — p25 38, p50 53, p75 69 across
       918 patches — but only if the radii are. The earlier 1.2-2.8 px core made
       a 2.3x span out of a spread that deserves far more, and every point looked
       the same size. These ramps roughly quadruple the visible range. */
    m.addLayer({ id: 'hs-bloom', type: 'circle', source: 'hotspot-pt', paint: {
      'circle-color': '#ffcf9a',
      'circle-radius': glow(5, 30), 'circle-blur': 1.5, 'circle-opacity': 0.28,
      'circle-radius-transition': { duration: 0 },
    } });
    m.addLayer({ id: 'hs-halo', type: 'circle', source: 'hotspot-pt', paint: {
      'circle-color': '#fff3e0',
      'circle-radius': glow(2.4, 13), 'circle-blur': 0.85, 'circle-opacity': 0.6,
    } });
    m.addLayer({ id: 'hs-core', type: 'circle', source: 'hotspot-pt', paint: {
      'circle-color': '#ffffff',
      'circle-radius': glow(0.9, 4.4), 'circle-blur': 0.18, 'circle-opacity': 0.96,
    } });
    // generous invisible hit target — the visible core is only a few pixels
    m.addLayer({ id: 'hs-hit', type: 'circle', source: 'hotspot-pt',
      paint: { 'circle-radius': zScale(13), 'circle-opacity': 0 } });

    /* ---- GSI inventory ---- */
    m.addSource('inventory', { type: 'geojson', data: empty });
    m.addLayer({ id: 'inv-glow', type: 'circle', source: 'inventory',
      paint: { 'circle-color': '#a8cbc7', 'circle-blur': 1.1, 'circle-opacity': 0.42,
               'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.5, 0, 8, 5, 14, 11] },
      layout: { visibility: 'none' } });
    m.addLayer({ id: 'inv-point', type: 'circle', source: 'inventory',
      paint: { 'circle-color': '#e9f2f0', 'circle-opacity': 0.9, 'circle-blur': 0.2,
               'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.5, 0, 8, 1.5, 14, 3.6] },
      layout: { visibility: 'none' } });

    /* ---- settlements ---- */
    m.addSource('places', { type: 'geojson', data: empty });
    m.addLayer({ id: 'place-dot', type: 'circle', source: 'places', paint: {
      'circle-color': '#8ebcb6', 'circle-opacity': 0.95,
      'circle-stroke-color': 'rgba(0,36,31,.8)',
      /* Collapsed to nothing below z6. Fifty settlements inside one state become
         a single clot at globe scale, and their dark stroke rings read as a black
         smudge sitting on the planet. Radius rather than opacity, so the intro's
         opacity fade stays free to drive the same layer. */
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.4, 3],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.4, 1],
    } });
    m.addLayer({ id: 'place-label', type: 'symbol', source: 'places',
      minzoom: 5.6,
      layout: { 'text-field': ['get', 'name'], 'text-size': 10.5,
                'text-font': ['Noto Sans Regular'], 'text-offset': [0, 1.1],
                'text-anchor': 'top', 'text-optional': true, 'text-letter-spacing': 0.06 },
      paint: { 'text-color': 'rgba(207,227,224,.72)', 'text-halo-color': 'rgba(0,26,22,.85)',
               'text-halo-width': 1.3 } });

    /* ---- selection highlight ---- */
    m.addSource('sel', { type: 'geojson', data: empty });
    m.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#ff7f32', 'fill-opacity': 0.16 } });
    m.addLayer({ id: 'sel-line', type: 'line', source: 'sel',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': '#ff7f32', 'line-width': 1.6 } });
    m.addLayer({ id: 'sel-ring', type: 'circle', source: 'sel',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 13, 'circle-color': 'rgba(255,127,50,.14)',
               'circle-stroke-width': 1, 'circle-stroke-color': '#ff7f32' } });
    m.addLayer({ id: 'sel-dot', type: 'circle', source: 'sel',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 2.6, 'circle-color': '#fff' } });
  }

  /* Marker colours follow the theme.

     The luminous treatment assumes a dark ground: a white core with a warm bloom
     reads as a light source. Over a light ground that inverts — white on near-white
     is nothing at all — so there the core goes deep ember and the bloom warm, which
     reads as a hot point rather than a glowing one. It keys off the ground, not the
     theme: a dark UI showing full-strength tiles needs the light-ground treatment. */
  markerPalette() {
    const light = groundIsLight();
    return light
      ? { bloom: '#e2600a', halo: '#f08a2e', core: '#7c2d05',
          bloomOp: 0.34, haloOp: 0.5, coreOp: 1 }
      : { bloom: '#ffcf9a', halo: '#fff3e0', core: '#ffffff',
          bloomOp: 0.28, haloOp: 0.6, coreOp: 0.96 };
  }

  applyMarkerTheme() {
    const m = this.map, p = this.markerPalette();
    const set = (layer, prop, val) => { if (m.getLayer(layer)) m.setPaintProperty(layer, prop, val); };
    set('hs-bloom', 'circle-color', p.bloom);
    set('hs-halo', 'circle-color', p.halo);
    set('hs-halo', 'circle-opacity', p.haloOp);
    set('hs-core', 'circle-color', p.core);
    set('hs-core', 'circle-opacity', p.coreOp);
    this._bloomOp = p.bloomOp;

    // The inventory dots and settlement labels sit on the same ground.
    const light = groundIsLight();
    set('inv-glow', 'circle-color', light ? '#4a6b64' : '#a8cbc7');
    set('inv-point', 'circle-color', light ? '#12241f' : '#e9f2f0');
    set('place-dot', 'circle-color', light ? '#2f5b52' : '#8ebcb6');
    set('place-dot', 'circle-stroke-color', light ? 'rgba(255,255,255,.9)' : 'rgba(0,36,31,.8)');
    if (m.getLayer('place-label')) {
      m.setPaintProperty('place-label', 'text-color', light ? '#1d2f2a' : 'rgba(207,227,224,.72)');
      m.setPaintProperty('place-label', 'text-halo-color',
        light ? 'rgba(255,255,255,.92)' : 'rgba(0,26,22,.85)');
    }

    // Reference geography reads off the theme's own hairline tone.
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--ui-active').trim() || '#8ebcb6';
    for (const id of ['border-country', 'border-admin1', 'graticule-line']) {
      set(id, 'line-color', line);
    }

    set('aoi-line', 'line-color', line);
  }

  /* The pulse writes hs-bloom's opacity on every frame, so anything else that
     wants to animate that property has to stop it first. */
  pausePulse() { this._pulsePaused = true; }
  resumePulse() { this._pulsePaused = false; }

  /* A slow sine on the bloom. ~0.09 Hz: perceptible, never busy. */
  _startPulse() {
    const step = (t) => {
      this.pulse = t;
      if (!this._pulsePaused && this.map.getLayer('hs-bloom')) {
        const k = 1 + 0.16 * Math.sin(t / 1750);
        const ramp = (m) => ['interpolate', ['linear'], ['get', 'exposure_score'],
                             0, 5 * k * m, 100, 30 * k * m];
        this.map.setPaintProperty('hs-bloom', 'circle-radius',
          ['interpolate', ['linear'], ['zoom'],
           7, ramp(0.34), 9, ramp(0.55), 11, ramp(1), 15, ramp(1.7)]);
        const base = this._bloomOp ?? 0.28;
        this.map.setPaintProperty('hs-bloom', 'circle-opacity',
          base - 0.04 + 0.08 * Math.sin(t / 1750));
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /* The study-area boundary. Kept so it survives a style rebuild. */
  setOutline(fc) {
    this._outline = fc;
    this.setData('aoi', fc);
  }

  /* Isolate the area of interest. Everything that places Sikkim in its
     surroundings goes: the base-map tiles, the graticule and both border layers.
     What is left is the state's own outline over the theme's ground, with the risk
     surface — which is already clipped to the study area — inside it.

     Hiding the raster rather than masking around it is deliberate. A mask means a
     world-sized polygon with the state punched out of it, and that is a lot of
     geometry to get right for a result you can have by turning one layer off. */
  focusArea(on) {
    this._focus = on;
    const m = this.map;
    const vis = (id, v) => { if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', v); };
    vis('aoi-line', on ? 'visible' : 'none');
    vis('basemap', on ? 'none' : 'visible');
    for (const id of ['graticule-line', 'border-country', 'border-admin1']) {
      vis(id, on ? 'none' : 'visible');
    }
  }

  /* Hold the base map back whenever the ground is meant to be dark. */
  static sinksBasemap() {
    return !groundIsLight();
  }

  /* The style is built from the live palette, so a theme swap needs no table here. */
  static styleOpts() {
    return {
      dark: MapView.sinksBasemap(),
      ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(),
    };
  }

  /* Rebuild the style, then put back everything that lives above it. The base-map
     exposure is part of the style rather than a later paint call, so this is the
     only way to change it — see the note in basemaps.js. */
  async reloadStyle(restore) {
    this.map.setStyle(baseStyle(this.basemap, MapView.styleOpts()));
    await new Promise(res => this.map.once('styledata', res));
    this._scaffold();
    this.applyMarkerTheme();
    if (this._outline) this.setOutline(this._outline);
    this.focusArea(!!this._focus);
    restore?.();
  }

  async setBasemap(id, restore) {
    const bm = BASEMAPS.find(b => b.id === id);
    if (!bm || bm.id === this.basemap.id) return;
    this.basemap = bm;
    await this.reloadStyle(restore);
  }

  addRaster(id, opacity) {
    if (this.map.getSource(`r-${id}`)) return;
    this.map.addSource(`r-${id}`, {
      type: 'raster', tiles: [api.tileUrl(id)], tileSize: this.meta.tile_size || 256,
      minzoom: 0, maxzoom: this.meta.max_zoom || 16,
    });
    this.map.addLayer({
      id: `r-${id}`, type: 'raster', source: `r-${id}`,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 260,
               'raster-resampling': 'nearest',
               'raster-opacity-transition': { duration: 420 } },
    }, RASTER_ROOT);
    this.rasterOrder.push(id);
  }

  removeRaster(id) {
    if (this.map.getLayer(`r-${id}`)) this.map.removeLayer(`r-${id}`);
    if (this.map.getSource(`r-${id}`)) this.map.removeSource(`r-${id}`);
    this.rasterOrder = this.rasterOrder.filter(x => x !== id);
  }

  setRasterOpacity(id, o) {
    if (this.map.getLayer(`r-${id}`)) this.map.setPaintProperty(`r-${id}`, 'raster-opacity', o);
  }

  setData(source, data) { this.map.getSource(source)?.setData(data); }

  setVisible(layerIds, on) {
    for (const id of layerIds) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    }
  }

  /* Filter the luminous points without refetching — the rail uses this. */
  setHotspotFilter(expr) {
    for (const id of ['hs-bloom', 'hs-halo', 'hs-core', 'hs-hit']) {
      if (this.map.getLayer(id)) this.map.setFilter(id, expr);
    }
  }

  highlight(geometry) {
    this.setData('sel', geometry
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] }
      : { type: 'FeatureCollection', features: [] });
  }

  flyTo(lon, lat, zoom = 13) {
    this.map.flyTo({ center: [lon, lat], zoom, speed: 1.1, curve: 1.5, essential: true });
  }

  fitBounds(bbox, padding = 90) {
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding, maxZoom: 14, speed: 1.1 });
  }

  /* Keep Sikkim clear of the chrome.

     The rail sits to the right of the layers drawer, so with the drawer open
     there is roughly 500 px of furniture down the left edge and the readout down
     the right. MapLibre's camera padding shifts the centre for us, which is
     cheaper and smoother than re-fitting bounds on every toggle. */
  /* Width of the layers drawer when it is open, 0 when it is not. */
  sidebarWidth() {
    if (document.body.classList.contains('sidebar-closed')) return 0;
    return parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-w'), 10) || 326;
  }

  chromePadding(sidebarOpen) {
    if (window.innerWidth < 900) return { top: 20, bottom: 92, left: 14, right: 14 };
    const railRoom = 62;
    const sidebarW = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || 326;
    return {
      top: 56, bottom: 84,
      left: (sidebarOpen ? sidebarW : 0) + railRoom,
      right: 250,
    };
  }

  applyChromePadding(sidebarOpen, animate = true) {
    const pad = this.chromePadding(sidebarOpen);
    if (animate) this.map.easeTo({ padding: pad, duration: 520 });
    else this.map.setPadding(pad);
  }

  /* Place Sikkim in the space the chrome actually leaves.

     setPadding alone stores the padding for later camera moves but does not
     re-place the current view, and the constructor's fitBounds ran before the
     drawer's restored state was known. Re-fitting against the same padding is
     what actually centres it. */
  refit(sidebarOpen, animate = false) {
    const [w, s, e, n] = this.meta.grid.bounds_wgs84;
    this.map.fitBounds([[w, s], [e, n]], {
      padding: this.chromePadding(sidebarOpen),
      duration: animate ? 620 : 0,
    });
  }

  bboxString() {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(4)).join(',');
  }
}
