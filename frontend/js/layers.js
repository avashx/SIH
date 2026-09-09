/* Sidebar layer control + the legend stack.
   Both are generated from /api/meta, so a new raster in config/layers.yml shows
   up here with no JavaScript change. */
import { api, esc, fmt } from './api.js';

export class LayerPanel {
  constructor(view, els) {
    this.view = view;
    this.els = els;
    this.layers = view.meta.layers;
    this.active = new Map();          // id -> opacity
    this.legends = new Map();
    this.classFilter = null;          // set by the category rail
    this.userSetOpacity = new Set();  // layers whose slider the user has moved
    this._render();
  }

  _render() {
    const groups = new Map();
    for (const l of this.layers) {
      if (!groups.has(l.group)) groups.set(l.group, { label: l.group_label, items: [] });
      groups.get(l.group).items.push(l);
    }

    /* Model output is the product and stays in front of you. The nine
       conditioning factors are reference material — they go behind a disclosure
       so the drawer opens short instead of scrolling past everything. */
    const render = (g, showTitle = true) => `
      <div class="lgroup">
        ${showTitle ? `<div class="lg-title">${esc(g.label)}</div>` : ''}
        ${g.items.map(l => this._layerHtml(l)).join('')}
      </div>`;

    const model = [...groups.entries()].filter(([k]) => k === 'model').map(([, g]) => g);
    const factors = [...groups.entries()].filter(([k]) => k !== 'model').map(([, g]) => g);

    // The section already says "Model output"; repeating the group heading under
    // it just doubles the words.
    this.els.groups.innerHTML = model.map(g => render(g, false)).join('');
    this.els.factors.innerHTML = factors.map(g => render(g)).join('');
    if (this.els.factorsCount) {
      this.els.factorsCount.textContent = factors.reduce((n, g) => n + g.items.length, 0);
    }

    this._nodes().forEach(node => {
      const id = node.dataset.id;
      node.querySelector('input[type=checkbox]').addEventListener('change', e =>
        this.toggle(id, e.target.checked));
      const range = node.querySelector('input[type=range]');
      range?.addEventListener('input', e => {
        this.userSetOpacity.add(id);
        const o = Number(e.target.value) / 100;
        node.querySelector('.opacity-val').textContent = `${e.target.value}%`;
        this.active.set(id, o);
        this.view.setRasterOpacity(id, o);
      });
      node.querySelector('.layer-info')?.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        node.classList.toggle('show-note');
      });
    });
  }

  _layerHtml(l) {
    const pct = Math.round((l.display?.opacity ?? 0.85) * 100);
    const gap = l.coverage !== null && l.coverage !== undefined && l.coverage < 0.995
      ? `<em>Coverage gap: ${fmt.pct(1 - l.coverage, 1)} of Sikkim has no value in this layer.</em>` : '';
    const inf = l.labels_inferred
      ? `<em>Class names were recovered from the data, not supplied with it — treat them as provisional.</em>` : '';
    return `
      <div class="layer" data-id="${esc(l.id)}">
        <label class="layer-row">
          <input type="checkbox">
          <span class="layer-name" title="${esc(l.title)}">${esc(l.title)}</span>
          ${l.group === 'model' ? '<span class="layer-badge">MODEL</span>' : ''}
          <span class="layer-info" title="About this layer">i</span>
        </label>
        <div class="layer-ctl"><div class="layer-ctl-inner">
          <div class="opacity-row">
            <input type="range" min="0" max="100" value="${pct}" aria-label="Opacity">
            <span class="opacity-val">${pct}%</span>
          </div>
          <div class="layer-note">
            ${esc(l.role || l.source || '')}
            ${l.source && l.role ? `<em>Source: ${esc(l.source)}</em>` : ''}
            ${gap}${inf}
          </div>
        </div></div>
      </div>`;
  }

  /* Layer rows live in two containers now, so look in both. */
  _nodes() {
    return [...this.els.groups.querySelectorAll('.layer'),
            ...this.els.factors.querySelectorAll('.layer')];
  }

  _node(id) {
    return this.els.groups.querySelector(`.layer[data-id="${id}"]`)
        || this.els.factors.querySelector(`.layer[data-id="${id}"]`);
  }

  async toggle(id, on) {
    const node = this._node(id);
    node?.classList.toggle('is-on', on);
    const box = node?.querySelector('input[type=checkbox]');
    if (box) box.checked = on;

    if (on) {
      const o = this.active.get(id) ?? (this.layers.find(l => l.id === id)?.display?.opacity ?? 0.85);
      this.active.set(id, o);
      this.view.addRaster(id, o);
      this._applyFilter(id);
      await this._legend(id);
    } else {
      this.active.delete(id);
      this.view.removeRaster(id);
      this.legends.delete(id);
    }
    this._renderLegends();
  }

  clear() {
    for (const id of [...this.active.keys()]) this.toggle(id, false);
  }

  /* Set opacity programmatically and keep the slider in step. */
  setOpacity(id, o) {
    this.active.set(id, o);
    this.view.setRasterOpacity(id, o);
    const node = this._node(id);
    const range = node?.querySelector('input[type=range]');
    if (range) { range.value = Math.round(o * 100); }
    const val = node?.querySelector('.opacity-val');
    if (val) val.textContent = `${Math.round(o * 100)}%`;
  }

  restore() {
    for (const [id, o] of this.active) { this.view.addRaster(id, o); this._applyFilter(id); }
  }

  /* The category rail calls this. Only the 5-class layer responds — isolating a
     class on a continuous surface would be meaningless. */
  setClassFilter(cls) {
    this.classFilter = cls;
    if (this.active.has('lsm_class')) this._applyFilter('lsm_class');
    this._renderLegends();
  }

  _applyFilter(id) {
    if (id !== 'lsm_class') return;
    const src = this.view.map.getSource('r-lsm_class');
    if (!src?.setTiles) return;
    src.setTiles([api.tileUrl(id, { classes: this.classFilter })]);
  }

  async _legend(id) {
    if (this.legends.has(id)) return;
    try { this.legends.set(id, await api.legend(id)); } catch { /* legend is optional */ }
  }

  _renderLegends() {
    const order = [...this.active.keys()].reverse();
    this.els.legend.innerHTML = order.map(id => {
      const lg = this.legends.get(id);
      if (!lg) return '';
      return lg.kind === 'categorical' ? this._catLegend(lg) : this._rampLegend(lg);
    }).join('');
  }

  _rampLegend(lg) {
    const stops = lg.ramp.map(r => `${r.color} ${(r.t * 100).toFixed(1)}%`).join(',');
    return `
      <div class="legend">
        <div class="legend-title">${esc(lg.title)}<span>${esc(lg.units || '')}</span></div>
        <div class="rule-node"><i></i></div>
        <div class="legend-ramp" style="background:linear-gradient(90deg,${stops})"></div>
        <div class="legend-scale"><span>${fmt.num(lg.min, lg.max <= 2 ? 2 : 0)}</span>
          <span>${fmt.num(lg.max, lg.max <= 2 ? 2 : 0)}</span></div>
      </div>`;
  }

  _catLegend(lg) {
    const dim = (v) => this.classFilter && lg.id === 'lsm_class' && v !== this.classFilter;
    return `
      <div class="legend">
        <div class="legend-title">${esc(lg.title)}</div>
        <div class="rule-node"><i></i></div>
        <div class="legend-cats">
          ${lg.entries.map(e => `
            <div class="legend-cat" style="opacity:${dim(e.value) ? .3 : 1}">
              ${e.area_km2 ? `<u>${fmt.num(e.area_km2, 0)}</u>` : ''}
              <b>${esc(e.label)}${e.inferred ? ' <span class="inferred-mark" title="Label inferred from the data — to be confirmed">?</span>' : ''}</b>
              <i style="background:${esc(e.color)};color:${esc(e.color)}"></i>
            </div>`).join('')}
        </div>
      </div>`;
  }
}
