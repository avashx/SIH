/* Entry point: boot, wire every control, own the interaction model. */
import { api, esc, fmt, debounce, setDataVersion } from './api.js';
import { BASEMAPS } from './basemaps.js';
import { MapView } from './map.js';
import { LayerPanel } from './layers.js';
import { Inspector } from './inspect.js';
import { StatsDrawer } from './stats.js';
import { ClassRail, Readout } from './rail.js';
import { applyTheme, currentTheme, mountThemePicker } from './theme.js';
import { Intro, prefersReducedMotion, runIntro } from './intro.js';
import { ListView } from './listview.js';

const $ = s => document.querySelector(s);

/* Default opacity for the risk surface over a tiled base map. */
const RISK_OPACITY = 0.46;

const state = {
  meta: null, stats: null, view: null, panel: null, inspector: null, drawer: null,
  rail: null, readout: null, list: null,
  places: [], invFacets: {}, invLoaded: false, invFilter: {}, mode: 'map',
};

boot().catch(err => {
  $('#boot-msg').textContent = err.message;
  $('#boot-msg').style.color = '#ff7f32';
  console.error(err);
});

async function boot() {
  const msg = $('#boot-msg');
  applyTheme(currentTheme());

  msg.textContent = 'loading layer catalogue…';
  state.meta = await api.meta();
  setDataVersion(state.meta.data_version);

  msg.textContent = 'building the map…';
  state.view = await new MapView($('#map'), state.meta).ready;
  window.__map = state.view.map;                       // debugging handle

  state.panel = new LayerPanel(state.view, {
    groups: $('#layer-groups-model'),
    factors: $('#layer-groups-factors'),
    factorsCount: $('#factors-count'),
    legend: $('#legend-stack'),
  });
  state.inspector = new Inspector(state.view, {
    root: $('#inspector'), title: $('#insp-title'), sub: $('#insp-sub'),
    body: $('#insp-body'), close: $('#insp-close'),
  });
  state.drawer = new StatsDrawer(state.view, {
    root: $('#drawer'), body: $('#drawer-body'), close: $('#drawer-close'), btn: $('#btn-stats'),
  }, rank => state.inspector.showHotspot(rank));
  state.list = new ListView(
    { root: $('#listview'), track: $('#list-track'), sub: $('#list-sub') },
    rank => { setMode('map'); state.inspector.showHotspot(rank); });

  buildBasemaps();
  buildThemePicker();
  wireFactorsDisclosure();
  wireOverlays();
  wireSearch();
  wireMapInteractions();
  wireChrome();

  msg.textContent = 'loading hotspots…';
  const [, , , stats] = await Promise.all([
    loadHotspots(), loadPlaces(), loadFacets(), api.stats(), loadBorders(),
  ]);
  state.stats = stats;

  // After loadBorders, so the mask has an outline to punch a hole in.
  wireFocus();

  state.readout = new Readout($('#readout'));
  state.rail = new ClassRail($('#rail-inner'), stats, onRailChange);
  onRailChange(state.rail.current);

  await state.panel.toggle('lsm_class', true);
  // The risk surface is an overlay on a tiled ground, not the ground itself, so it
  // is held back far enough to read the terrain and the place names underneath.
  state.panel.setOpacity('lsm_class', RISK_OPACITY);

  // Hold the data down and put the camera out over the Pacific BEFORE the boot
  // screen lifts, so the first frame anyone sees is the globe, not the map.
  const intro = !prefersReducedMotion();
  if (intro) {
    state.intro = new Intro(state.view);
    state.intro.lower();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  $('#boot').classList.add('done');
  setTimeout(() => $('#boot').remove(), 950);

  if (intro) await runIntro(state.intro);
}

/* ------------------------------------------------------- rail + readout --- */
function onRailChange(sel) {
  const s = state.stats;
  if (!s) return;

  if (sel.cls === null) {
    // "All" — the whole state
    state.view.setHotspotFilter(null);
    state.panel.setClassFilter(null);
    state.readout.show([
      { label: 'Hotspot patches', value: state.meta.counts.hotspots,
        note: 'Very-High, 8-connected' },
      { label: 'Very High', value: classRow(5).area_km2, unit: 'km²',
        note: `${classRow(5).share_pct}% of Sikkim` },
    ]);
  } else if (sel.cls === 5) {
    state.view.setHotspotFilter(null);
    state.panel.setClassFilter(5);
    state.readout.show([
      { label: 'Hotspot patches', value: state.meta.counts.hotspots, note: 'all shown' },
      { label: 'Mapped landslides', value: validRow(5)?.landslides ?? 0,
        note: `${fmt.pct(validRow(5)?.landslide_share ?? 0, 0)} of the GSI inventory` },
    ]);
  } else {
    // lower classes hold no hotspots by definition — show area and inventory instead
    state.view.setHotspotFilter(['==', ['get', 'rank_area'], -1]);
    state.panel.setClassFilter(sel.cls);
    const row = classRow(sel.cls), v = validRow(sel.cls);
    state.readout.show([
      { label: sel.label, value: row.area_km2, unit: 'km²', note: `${row.share_pct}% of Sikkim` },
      { label: 'Mapped landslides', value: v?.landslides ?? 0,
        note: v ? `density ${v.density_ratio}× versus area alone` : '' },
    ]);
  }

  if (state.mode === 'list') state.list.open(sel);
}

const classRow = c => state.stats.area.by_class.find(r => r.class === c) || {};
const validRow = c => state.stats.validation.by_class.find(r => r.class === c);

/* ---------------------------------------------------------------- theme -- */
function buildThemePicker() {
  mountThemePicker({ button: $('#btn-theme'), menu: $('#theme-drop') }, async () => {
    // Every panel, scrim and vignette is drawn from CSS custom properties and
    // repaints itself. The map does not: the base map's exposure lives in the
    // style, so the style has to be rebuilt for the new theme to reach it.
    await state.view.reloadStyle(restoreMapLayers);
    state.view.map.resize();
  });
}

/* --------------------------------------------------- factors disclosure --- */
function wireFactorsDisclosure() {
  const btn = $('#factors-toggle'), panel = $('#layer-groups-factors');
  const set = (open) => {
    panel.classList.toggle('is-collapsed', !open);
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('sikkim.factors', open ? '1' : '0'); } catch {}
  };
  let open = false;
  try { open = localStorage.getItem('sikkim.factors') === '1'; } catch {}
  set(open);
  btn.addEventListener('click', () => set(panel.classList.contains('is-collapsed')));
}

/* Everything that lives above the base-map style and has to be put back after the
   style is rebuilt. Both the base-map switch and the theme switch go through it. */
function restoreMapLayers() {
  state.panel.restore();
  restoreOverlayData();
  if (state.rail) onRailChange(state.rail.current);
}

/* ------------------------------------------------------- study-area focus -- */
/* Masks everything outside Sikkim and drops the reference geography with it, so
   the map shows the area of interest and nothing else. */
function wireFocus() {
  const btn = $('#btn-focus');
  const set = (on) => {
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    state.view.focusArea(on);
    try { localStorage.setItem('sikkim.focus', on ? '1' : '0'); } catch { /* private mode */ }
  };
  let on = false;
  try { on = localStorage.getItem('sikkim.focus') === '1'; } catch { /* private mode */ }
  set(on);
  btn.addEventListener('click', () => set(!btn.classList.contains('is-on')));
}

/* ------------------------------------------------------------- basemaps -- */
function buildBasemaps() {
  $('#basemap-grid').innerHTML = BASEMAPS.map((b, i) => `
    <button class="bm ${i === 0 ? 'is-active' : ''}" data-id="${b.id}"
      ${b.swatch ? `style="background:${b.swatch}"` : ''}
      title="${esc(b.label)}"><span>${esc(b.label)}</span></button>`).join('');

  $('#basemap-grid').addEventListener('click', async e => {
    const btn = e.target.closest('.bm');
    if (!btn) return;
    $('#basemap-grid').querySelectorAll('.bm').forEach(b => b.classList.toggle('is-active', b === btn));
    await state.view.setBasemap(btn.dataset.id, restoreMapLayers);
    if (!state.panel.userSetOpacity.has('lsm_class') && state.panel.active.has('lsm_class')) {
      state.panel.setOpacity('lsm_class', RISK_OPACITY);
    }
  });
}

/* ------------------------------------------------------------- overlays -- */
let hotspotPoints = null, inventoryFC = null, placesFC = null;
let bordersWorld = null, bordersRegion = null, outlineFC = null;

/* Country and state outlines. Static files rather than an API route — they never
   change with the data, and serving them from /data lets the browser cache them
   independently of the tile version. Failure is non-fatal: the map is still a map
   without its surroundings. */
async function loadBorders() {
  const grab = async (name) => {
    try {
      const r = await fetch(`/data/${name}.geojson`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  [bordersWorld, bordersRegion, outlineFC] = await Promise.all([
    grab('borders-world'), grab('borders-region'), grab('sikkim'),
  ]);
  if (bordersWorld) state.view.setData('borders-world', bordersWorld);
  if (bordersRegion) state.view.setData('borders-region', bordersRegion);
  // The study-area outline drives the "Sikkim only" mask. Without it the toggle
  // has nothing to punch a hole in, so it stays disabled rather than blanking
  // the whole map.
  if (outlineFC) state.view.setOutline(outlineFC);
  $('#btn-focus').disabled = !outlineFC;
}

async function loadHotspots() {
  const fc = await api.hotspots({ geometry: 'point', limit: 20000, order_by: 'area_ha' });
  hotspotPoints = fc;
  state.view.setData('hotspot-pt', fc);
  $('#ov-hotspots-n').textContent = `${fmt.num(fc.features.length)} Very-High patches`;
}

async function loadPlaces() {
  state.places = await api.places();
  placesFC = {
    type: 'FeatureCollection',
    features: state.places.map(p => ({
      type: 'Feature', properties: { name: p.name, type: p.type, district: p.district, note: p.note },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
  state.view.setData('places', placesFC);
}

async function loadFacets() {
  try { state.invFacets = await api.facets(); } catch { state.invFacets = {}; }
}

async function loadInventory() {
  const fc = await api.inventory({ limit: 5000, ...state.invFilter });
  inventoryFC = fc;
  state.view.setData('inventory', fc);
  $('#ov-inventory-n').textContent =
    `${fmt.num(fc.meta.returned)} of ${fmt.num(fc.meta.total)} shown`;
  const c = $('#inv-count');
  if (c) c.textContent = `${fmt.num(fc.meta.matched)} records match`;
}

function restoreOverlayData() {
  if (bordersWorld) state.view.setData('borders-world', bordersWorld);
  if (bordersRegion) state.view.setData('borders-region', bordersRegion);
  if (hotspotPoints) state.view.setData('hotspot-pt', hotspotPoints);
  if (inventoryFC) state.view.setData('inventory', inventoryFC);
  if (placesFC) state.view.setData('places', placesFC);
  syncOverlayVisibility();
}

function syncOverlayVisibility() {
  state.view.setVisible(['hs-bloom', 'hs-halo', 'hs-core', 'hs-hit'], $('#ov-hotspots').checked);
  state.view.setVisible(['hotspot-fill', 'hotspot-line'], $('#ov-hotspot-outline').checked);
  state.view.setVisible(['inv-glow', 'inv-point'], $('#ov-inventory').checked);
  state.view.setVisible(['place-dot', 'place-label'], $('#ov-places').checked);
}

function wireOverlays() {
  $('#ov-hotspots').addEventListener('change', syncOverlayVisibility);
  $('#ov-places').addEventListener('change', syncOverlayVisibility);

  $('#ov-hotspot-outline').addEventListener('change', async e => {
    syncOverlayVisibility();
    if (e.target.checked) await refreshOutlines();
  });

  $('#ov-inventory').addEventListener('change', async e => {
    syncOverlayVisibility();
    $('#inv-filters').hidden = !e.target.checked;
    if (e.target.checked) {
      if (!state.invLoaded) { renderInvFilters(); state.invLoaded = true; }
      await loadInventory();
    }
  });

  /* Outlines are fetched for the current viewport only — the full polygon set is
     ~8 MB and there is no reason to ship it to the browser. */
  state.view.map.on('moveend', debounce(() => {
    if ($('#ov-hotspot-outline').checked) refreshOutlines();
  }, 320));

  $('#btn-clear-layers').addEventListener('click', () => state.panel.clear());
}

async function refreshOutlines() {
  try {
    const fc = await api.hotspots({ bbox: state.view.bboxString(), limit: 900, order_by: 'area_ha' });
    state.view.setData('hotspot-poly', fc);
  } catch (e) { console.warn('outline fetch failed', e); }
}

function renderInvFilters() {
  const f = state.invFacets;
  const sel = (key, label) => {
    const opts = Object.entries(f[key] || {});
    if (!opts.length) return '';
    return `<div><label for="if-${key}">${esc(label)}</label>
      <select id="if-${key}" data-key="${key}">
        <option value="">All (${fmt.num(opts.reduce((s, [, n]) => s + n, 0))})</option>
        ${opts.map(([k, n]) => `<option value="${esc(k)}">${esc(k)} — ${n}</option>`).join('')}
      </select></div>`;
  };
  $('#inv-filters').innerHTML =
    sel('district', 'District') + sel('material_type', 'Material') +
    sel('movement_type', 'Movement') + sel('activity', 'Activity') +
    `<div><label for="if-risk">Model class at site</label>
      <select id="if-risk" data-key="risk_class">
        <option value="">Any</option>
        <option value="5">Very High</option><option value="4">High</option>
        <option value="3">Moderate</option><option value="2">Low</option><option value="1">Very Low</option>
      </select></div>
     <div class="inv-count" id="inv-count"></div>`;

  $('#inv-filters').querySelectorAll('select').forEach(s =>
    s.addEventListener('change', async () => {
      state.invFilter = {};
      $('#inv-filters').querySelectorAll('select').forEach(x => {
        if (x.value) state.invFilter[x.dataset.key] = x.value;
      });
      await loadInventory();
    }));
}

/* --------------------------------------------------------------- search -- */
function wireSearch() {
  const input = $('#search-input'), box = $('#search-results');
  let results = [], sel = -1;

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    try {
      const r = await api.search(q);
      results = r.results; sel = -1;
      box.hidden = false;
      box.innerHTML = results.length ? results.map((x, i) => `
        <div class="sr" data-i="${i}">
          <span class="sr-ic" style="background:${x.kind === 'landslide' ? '#e9f2f0'
            : x.kind === 'hotspot' ? '#ffcf9a' : '#8ebcb6'};color:${
            x.kind === 'landslide' ? '#e9f2f0' : x.kind === 'hotspot' ? '#ffcf9a' : '#8ebcb6'}"></span>
          <span class="sr-tx"><b>${esc(x.label)}</b><small>${esc(x.sublabel || '')}</small></span>
        </div>`).join('') : `<div class="sr-empty">Nothing matches “${esc(q)}”</div>`;
    } catch { box.hidden = true; }
  }, 190);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => {
    if (results.length && input.value.trim().length >= 2) box.hidden = false;
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { box.hidden = true; input.blur(); return; }
    if (!results.length || box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      box.querySelectorAll('.sr').forEach((n, i) => n.classList.toggle('is-sel', i === sel));
      box.querySelector('.sr.is-sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[sel < 0 ? 0 : sel]);
    }
  });

  box.addEventListener('click', e => {
    const n = e.target.closest('.sr');
    if (n) pick(results[Number(n.dataset.i)]);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search')) box.hidden = true;
  });

  function pick(r) {
    if (!r) return;
    box.hidden = true;
    input.blur();
    setMode('map');
    state.view.flyTo(r.lon, r.lat, r.kind === 'hotspot' ? 12 : 13.5);
    if (r.kind === 'hotspot') state.inspector.showHotspot(r.id);
    else if (r.kind === 'landslide') {
      api.inventory({ limit: 5000, full: true })
        .then(fc => {
          const f = fc.features.find(x => x.id === r.id);
          if (f) state.inspector.showLandslide(f);
          else state.inspector.showPoint(r.lon, r.lat, r.label);
        })
        .catch(() => state.inspector.showPoint(r.lon, r.lat, r.label));
    } else {
      state.inspector.showPoint(r.lon, r.lat, r.label);
    }
  }
}

/* ------------------------------------------------------ map interactions -- */
function wireMapInteractions() {
  const map = state.view.map;
  const CLICKABLE = ['hs-hit', 'inv-point', 'place-dot'];

  map.on('mousemove', e => {
    $('#badge-coords').textContent = fmt.coord(e.lngLat.lng, e.lngLat.lat);
    const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter(l => map.getLayer(l)) });
    map.getCanvas().style.cursor = hit.length ? 'pointer' : 'crosshair';
  });

  map.on('click', async e => {
    $('#map-hint')?.classList.add('gone');

    const hits = map.queryRenderedFeatures(e.point,
      { layers: CLICKABLE.filter(l => map.getLayer(l)) });

    if (hits.length) {
      const f = hits[0];
      if (f.layer.id === 'hs-hit') { state.inspector.showHotspot(f.properties.rank_area); return; }
      if (f.layer.id === 'inv-point') {
        const rec = await api.inventory({ limit: 5000, full: true })
          .then(fc => fc.features.find(x => x.id === f.id)).catch(() => null);
        if (rec) state.inspector.showLandslide(rec);
        else state.inspector.showPoint(...f.geometry.coordinates, 'Landslide');
        return;
      }
      if (f.layer.id === 'place-dot') {
        state.inspector.showPoint(...f.geometry.coordinates, f.properties.name);
        return;
      }
    }
    state.inspector.showPoint(e.lngLat.lng, e.lngLat.lat);
  });

  const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 13 });
  map.on('mouseenter', 'place-dot', e => {
    const p = e.features[0].properties;
    pop.setLngLat(e.features[0].geometry.coordinates)
       .setHTML(`<b>${esc(p.name)}</b><br><span>${esc(p.type)} · ${esc(p.district)}</span>`).addTo(map);
  });
  map.on('mouseleave', 'place-dot', () => pop.remove());
  map.on('mouseenter', 'hs-hit', e => {
    const p = e.features[0].properties;
    pop.setLngLat(e.features[0].geometry.coordinates)
       .setHTML(`<b>Hotspot #${p.rank_area}</b><br><span>${fmt.area(p.area_km2)} ·
          exposure ${Number(p.exposure_score).toFixed(0)}</span>`).addTo(map);
  });
  map.on('mouseleave', 'hs-hit', () => pop.remove());
  map.on('mouseenter', 'inv-point', e => {
    const p = e.features[0].properties;
    pop.setLngLat(e.features[0].geometry.coordinates)
       .setHTML(`<b>${esc(p.slide_name || p.slide_no || 'Landslide')}</b><br>
         <span>${esc(p.material_type || '')} ${esc(p.movement_type || '')} · ${esc(p.district || '')}</span>`)
       .addTo(map);
  });
  map.on('mouseleave', 'inv-point', () => pop.remove());

  $('#zoom-in').addEventListener('click', () => map.zoomIn({ duration: 420 }));
  $('#zoom-out').addEventListener('click', () => map.zoomOut({ duration: 420 }));
}

/* ------------------------------------------------------------ map / list -- */
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  const isList = mode === 'list';
  $('#view-map').classList.toggle('is-on', !isList);
  $('#view-list').classList.toggle('is-on', isList);
  if (isList) state.list.open(state.rail?.current);
  else state.list.close();
}

/* --------------------------------------------------------------- chrome -- */
function wireChrome() {
  const sidebar = $('#sidebar'), btnLayers = $('#btn-layers'), reopen = $('#sidebar-reopen');
  // The drawer overlays the map rather than shrinking it, so the canvas never
  // resizes; only the camera padding has to follow.
  let booted = false;
  const setSidebar = (open) => {
    sidebar.classList.toggle('is-closed', !open);
    document.body.classList.toggle('sidebar-closed', !open);
    btnLayers.classList.toggle('is-on', open);
    btnLayers.setAttribute('aria-expanded', String(open));
    reopen.hidden = open;
    try { localStorage.setItem('sikkim.layers', open ? '1' : '0'); } catch {}
    // On a later toggle, ease the padding so the user keeps their zoom and pan.
    // At boot there is nothing to preserve, and easing here would undo the refit.
    if (booted) setTimeout(() => state.view.applyChromePadding(open), 380);
  };
  // Open by default on desktop so nothing is hidden on first view; one click gives
  // the full map. On a phone the drawer would cover everything, so it starts closed.
  let open = window.innerWidth > 900;
  try { const v = localStorage.getItem('sikkim.layers'); if (v !== null) open = v === '1'; } catch {}
  setSidebar(open);
  state.view.refit(open, false);
  booted = true;
  btnLayers.addEventListener('click', () => setSidebar(sidebar.classList.contains('is-closed')));
  $('#sidebar-close').addEventListener('click', () => setSidebar(false));
  reopen.addEventListener('click', () => setSidebar(true));

  // On a phone the search field cannot share the bar with the brand and four
  // buttons, so it collapses to an icon and expands over the row when tapped.
  const searchBtn = $('#btn-search'), searchBox = document.querySelector('.search');
  searchBtn.addEventListener('click', () => {
    const open = !document.body.classList.contains('search-open');
    document.body.classList.toggle('search-open', open);
    searchBtn.setAttribute('aria-expanded', String(open));
    if (open) $('#search-input').focus();
  });
  document.addEventListener('click', e => {
    if (document.body.classList.contains('search-open') &&
        !e.target.closest('.search') && !e.target.closest('#btn-search')) {
      document.body.classList.remove('search-open');
      searchBtn.setAttribute('aria-expanded', 'false');
    }
  });

  $('#view-map').addEventListener('click', () => setMode('map'));
  $('#view-list').addEventListener('click', () => setMode('list'));

  $('#btn-stats').addEventListener('click', () => {
    state.drawer.toggle();
    $('#btn-stats').classList.toggle('is-on', !$('#drawer').hidden);
  });
  $('#btn-about').addEventListener('click', () => { $('#about').hidden = false; renderAbout(); });
  $('#about-close').addEventListener('click', () => { $('#about').hidden = true; });
  $('#about').addEventListener('click', e => { if (e.target.id === 'about') $('#about').hidden = true; });
  const hint = $('#map-hint');
  const dismissHint = () => hint.classList.add('gone');
  $('#map-hint .hint-x').addEventListener('click', dismissHint);
  // Start the 6 s depletion on the next frame so the transition actually runs -
  // setting the class in the same frame as the initial paint would skip it.
  requestAnimationFrame(() => requestAnimationFrame(() => hint.classList.add('counting')));
  setTimeout(dismissHint, 6000);

  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#search-input')) {
      e.preventDefault(); $('#search-input').focus();
    }
    if (e.key === 'Escape') {
      $('#about').hidden = true;
      if (!$('#drawer').hidden) { state.drawer.close(); $('#btn-stats').classList.remove('is-on'); }
      else if (!$('#inspector').hidden) state.inspector.hide();
    }
    // ↑/↓ step the class rail, like the year timeline
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.rail
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      const next = state.rail.active + (e.key === 'ArrowDown' ? 1 : -1);
      if (next >= 0 && next < state.rail.items.length) state.rail.select(next);
    }
  });

  document.querySelectorAll('.panel-tab').forEach(t => t.addEventListener('click', () => {
    if (t.classList.contains('is-disabled')) {
      showToast(t.textContent.trim(), 'abhi banya nahi h');
    }
  }));
}

/* --------------------------------------------------------------- toast ---- */
let toastTimer = null;
function showToast(title, msg, ms = 2600) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  $('#toast-title').textContent = title;
  $('#toast-msg').textContent = msg;
  el.classList.remove('leaving');
  el.hidden = false;
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 300);
  };
  toastTimer = setTimeout(dismiss, ms);
  el.onclick = () => { clearTimeout(toastTimer); dismiss(); };
}

function renderAbout() {
  const TEAM = ['Varun', 'Aman', 'Kajal', 'Sameera', 'Vanshaj', 'Dheeraj'];
  $('#about-body').innerHTML = `
    <div class="credit-hero">
      <div class="credit-title">SIH GI 2026</div>
    </div>
    <div class="team">
      ${TEAM.map((n, i) => `
        <div class="team-member" style="animation-delay:${i * 70}ms">
          <span class="team-dot"></span><span class="team-name">${esc(n)}</span>
        </div>`).join('')}
    </div>`;
}
