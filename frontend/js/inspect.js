/* The right-hand inspector. Three things can fill it: a clicked point, a
   hotspot, or a record from the GSI inventory. */
import { api, esc, fmt } from './api.js';

const RISK_COLORS = { 1: '#1a9850', 2: '#a6d96a', 3: '#fee08b', 4: '#f46d43', 5: '#a50026' };
/* The class-5 red is chosen for the map, where it sits on pale terrain. As display
   type on a near-black ground it goes muddy, so headline text uses a lifted
   variant. Swatches and the map keep the true colours. */
const RISK_TEXT = { 1: '#5cc98a', 2: '#c3e88a', 3: '#ffe9a3', 4: '#ff9a6b', 5: '#ff6b6b' };

export class Inspector {
  constructor(view, els, onSelect) {
    this.view = view; this.els = els; this.onSelect = onSelect;
    els.close.addEventListener('click', () => this.hide());
  }

  hide() {
    this.els.root.hidden = true;
    document.body.classList.remove('has-inspector');
    this.view.highlight(null);
    this.view.map.resize();
  }

  _open(title, sub) {
    this.els.root.hidden = false;
    document.body.classList.add('has-inspector');
    this.els.title.textContent = title;
    this.els.sub.textContent = sub || '';
    this.view.map.resize();
  }

  loading(title) {
    this._open(title, '');
    this.els.body.innerHTML = `<div class="note-box">Reading the factor stack…</div>`;
  }

  /* ------------------------------------------------------------- a point -- */
  async showPoint(lon, lat, label) {
    this.loading(label || 'Point');
    this.view.highlight({ type: 'Point', coordinates: [lon, lat] });
    let d;
    try { d = await api.point(lon, lat); }
    catch (e) { this.els.body.innerHTML = `<div class="note-box">Query failed: ${esc(e.message)}</div>`; return; }

    this._open(label || 'Point', fmt.coord(d.lon, d.lat));

    if (!d.inside_study_area && d.risk.class === null) {
      this.els.body.innerHTML = `
        <div class="note-box"><b>Outside the study area.</b><br>
        This platform covers Sikkim only. Every factor raster is clipped to the state boundary.</div>`;
      return;
    }

    const parts = [this._riskCard(d)];

    if (d.inside_study_area && d.risk.class === null) {
      parts.push(`<div class="note-box">This point is inside Sikkim but has <b>no ensemble value</b> —
        it falls in the ~139 km² the delivered susceptibility raster does not cover.
        The conditioning factors below are still valid.</div>`);
    }

    const groups = new Map();
    for (const f of d.factors) {
      if (f.id === 'lsm' || f.id === 'lsm_class') continue;
      if (!groups.has(f.group)) groups.set(f.group, { label: f.group_label, rows: [] });
      groups.get(f.group).rows.push(f);
    }
    for (const g of groups.values()) {
      parts.push(`<div class="fgroup"><div class="fgroup-t">${esc(g.label)}</div>
        ${g.rows.map(r => this._factorRow(r)).join('')}</div>`);
    }

    parts.push(`<div class="insp-actions">
        <button class="mini-btn" data-act="copy">Copy coordinates</button>
        <button class="mini-btn" data-act="centre">Centre map here</button>
      </div>`);

    this.els.body.innerHTML = parts.join('');
    this.els.body.querySelector('[data-act=copy]')?.addEventListener('click', e => {
      navigator.clipboard?.writeText(`${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}`);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy coordinates'; }, 1400);
    });
    this.els.body.querySelector('[data-act=centre]')?.addEventListener('click', () =>
      this.view.flyTo(d.lon, d.lat, Math.max(this.view.map.getZoom(), 13)));
  }

  _riskCard(d) {
    const r = d.risk;
    if (r.class === null) {
      return `<div class="risk-card" style="--c:#6d7d99">
        <div class="risk-lbl">Susceptibility</div>
        <div class="risk-val" style="font-size:16px">No model value here</div></div>`;
    }
    const pos = Math.max(0, Math.min(1, r.index_normalised ?? 0)) * 100;
    return `
      <div class="risk-card" style="--c:${RISK_TEXT[r.class]}">
        <div class="risk-lbl">Susceptibility · class ${r.class} of 5</div>
        <div class="risk-val">${esc(r.label)}</div>
        <div class="risk-idx">ensemble index ${r.index?.toFixed(4) ?? '—'}</div>
        <div class="gauge"><i style="left:${pos}%"></i></div>
        <div class="gauge-ticks"><span>Very Low</span><span>Very High</span></div>
      </div>`;
  }

  _factorRow(f) {
    if (f.kind === 'categorical') {
      const v = f.value === null
        ? '<span class="na">no data</span>'
        : `${esc(f.label || f.value)}${f.inferred ? ' <span class="inferred-mark" title="Label inferred from the data">?</span>' : ''}`;
      return `<div class="frow">
        ${f.color ? `<span class="frow-sw" style="background:${esc(f.color)}"></span>` : ''}
        <span class="frow-n">${esc(f.title)}</span>
        <span class="frow-v">${v}</span></div>`;
    }
    /* A small bar gives the value context against the layer's own display range. */
    const d = f.display || {};
    let bar = '';
    if (f.value !== null && d.min !== undefined && d.max !== undefined) {
      const t = Math.max(0, Math.min(1, (f.value - d.min) / (d.max - d.min))) * 100;
      bar = `<span class="frow-bar"><i style="width:${t.toFixed(1)}%"></i></span>`;
    }
    return `<div class="frow">
      <span class="frow-n">${esc(f.title)}</span>${bar}
      <span class="frow-v">${f.value === null ? '<span class="na">—</span>' : esc(fmt.value(f.value, f.units))}</span>
      <span class="frow-u">${esc(f.units === 'susceptibility index' ? '' : (f.units || ''))}</span></div>`;
  }

  /* ----------------------------------------------------------- a hotspot -- */
  async showHotspot(rank) {
    this.loading(`Hotspot #${rank}`);
    let f;
    try { f = await api.hotspot(rank); }
    catch (e) { this.els.body.innerHTML = `<div class="note-box">${esc(e.message)}</div>`; return; }
    const p = f.properties;
    this.view.highlight(f.geometry);
    this._open(`Hotspot #${p.rank_area}`, `${fmt.area(p.area_km2)} of Very High terrain`);

    const road = p.min_dist_road_m >= 99999 ? '—'
      : p.min_dist_road_m === 0 ? 'road runs through it' : `${fmt.num(p.min_dist_road_m)} m`;

    this.els.body.innerHTML = `
      <div class="risk-card" style="--c:#ff9a6b">
        <div class="risk-lbl">Exposure score · rank ${p.rank_exposure} of ${this.view.meta.counts.hotspots}</div>
        <div class="risk-val">${p.exposure_score.toFixed(1)}<small style="font-size:13px;color:var(--ink-3)"> / 100</small></div>
        <div class="risk-idx">largest by area: rank ${p.rank_area}</div>
      </div>

      <div class="fgroup"><div class="fgroup-t">Extent</div>
        <div class="frow"><span class="frow-n">Area</span><span class="frow-v">${fmt.area(p.area_km2)}</span></div>
        <div class="frow"><span class="frow-n">Mean index</span><span class="frow-v">${p.mean_index.toFixed(4)}</span></div>
        <div class="frow"><span class="frow-n">Peak index</span><span class="frow-v">${p.max_index.toFixed(4)}</span></div>
        <div class="frow"><span class="frow-n">Mean slope</span><span class="frow-v">${p.mean_slope_deg}°</span></div>
        <div class="frow"><span class="frow-n">Steepest slope</span><span class="frow-v">${p.max_slope_deg}°</span></div>
      </div>

      <div class="fgroup"><div class="fgroup-t">What is exposed</div>
        <div class="frow"><span class="frow-n">Built-up inside</span><span class="frow-v">${p.builtup_ha ? fmt.num(p.builtup_ha, 1) + ' ha' : '<span class="na">none</span>'}</span></div>
        <div class="frow"><span class="frow-n">Cropland inside</span><span class="frow-v">${p.cropland_ha ? fmt.num(p.cropland_ha, 1) + ' ha' : '<span class="na">none</span>'}</span></div>
        <div class="frow"><span class="frow-n">Nearest road</span><span class="frow-v">${esc(road)}</span></div>
        <div class="frow"><span class="frow-n">Night-lights sum</span><span class="frow-v">${fmt.num(p.ntl_sum, 1)}</span></div>
        <div class="frow"><span class="frow-n">Past landslides inside</span><span class="frow-v">${p.past_slides}</span></div>
      </div>

      <div class="note-box">Exposure score is a transparent screening heuristic, not a calibrated
        risk model: percentile ranks of night-lights (0.40), built-up area (0.25), area (0.15) plus
        road proximity (0.20). It ranks patches for attention; it does not price consequence.</div>

      <div class="insp-actions">
        <button class="mini-btn" data-act="zoom">Zoom to hotspot</button>
        <button class="mini-btn" data-act="inspect">Inspect its centre</button>
      </div>`;

    this.els.body.querySelector('[data-act=zoom]')?.addEventListener('click', () => {
      const bb = bboxOf(f.geometry);
      this.view.fitBounds(bb);
    });
    this.els.body.querySelector('[data-act=inspect]')?.addEventListener('click', () =>
      this.showPoint(p.lon, p.lat, `Hotspot #${p.rank_area} centre`));
  }

  /* ------------------------------------------------- a GSI inventory record */
  showLandslide(f) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    this.view.highlight(f.geometry);
    this._open(p.slide_name || p.slide_no || 'Landslide', `GSI record · ${fmt.coord(lon, lat)}`);

    const dims = [p.length_m && `${p.length_m} m long`, p.width_m && `${p.width_m} m wide`,
                  p.depth_m && `${p.depth_m} m deep`].filter(Boolean).join(' · ');
    const rows = [
      ['District', p.district], ['Slide no.', p.slide_no], ['Trigger', p.trigger],
      ['Material', p.material_type], ['Movement', p.movement_type],
      ['Rate', p.movement_rate], ['Activity', p.activity],
      ['Failure mechanism', p.failure_mechanism], ['Geomorphology', p.geomorphology],
      ['Land use at site', p.landuse_at_slide], ['Road', p.road_class],
      ['Cause noted by GSI', p.geoscientific_cause], ['Remediation', p.remediation],
    ].filter(([, v]) => v);

    const cls = p.risk_class;
    this.els.body.innerHTML = `
      ${cls ? `<div class="risk-card" style="--c:${RISK_TEXT[cls]}">
        <div class="risk-lbl">Model says, at this location</div>
        <div class="risk-val">${esc(p.risk_label)}</div>
        <div class="risk-idx">index ${p.susceptibility_index?.toFixed(4) ?? '—'}${
          p.hotspot_rank ? ` · inside hotspot #${p.hotspot_rank}` : ' · not inside a hotspot'}</div>
      </div>` : `<div class="note-box">This mapped landslide falls outside the ensemble's extent,
        so the model has no verdict here.</div>`}

      ${dims ? `<div class="chip">${esc(dims)}</div>` : ''}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${p.remarks ? `<div class="note-box">${esc(p.remarks)}</div>` : ''}
      <div class="insp-actions"><button class="mini-btn" data-act="factors">Read all factors here</button></div>`;

    this.els.body.querySelector('[data-act=factors]')?.addEventListener('click', () =>
      this.showPoint(lon, lat, p.slide_name || p.slide_no || 'Landslide'));
  }
}

export function bboxOf(geom) {
  let m = [180, 90, -180, -90];
  const walk = c => {
    if (typeof c[0] === 'number') {
      m = [Math.min(m[0], c[0]), Math.min(m[1], c[1]), Math.max(m[2], c[0]), Math.max(m[3], c[1])];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return m;
}
