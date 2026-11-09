// Animation player: plays a canvas's tags at their own timing (or all frames at an fps), loop,
// scale, and a per-view grid that plays every direction of the same animation side by side
// (rig outputs: "walk", "walk_front", "walk_back", ... laid out as a compass for 8 directions).
import { el, enc, getJSON, loadBitmap, playList, checker, store } from '../util.js';

const COMPASS = {
  n: ['back', 'north', 'up', 'n'], s: ['front', 'south', 'down', 's'], e: ['side', 'right', 'east', 'e'], w: ['side_left', 'left', 'west', 'w'],
  ne: ['back_side', 'back_right', 'ne'], nw: ['back_side_left', 'back_left', 'nw'], se: ['front_side', 'front_right', 'se'], sw: ['front_side_left', 'front_left', 'sw'],
};
const SLOT = { nw: 0, n: 1, ne: 2, w: 3, e: 5, sw: 6, s: 7, se: 8 };
const ALL_VIEWS = Object.values(COMPASS).flat().sort((a, b) => b.length - a.length);
const compassOf = (view) => Object.keys(COMPASS).find((k) => COMPASS[k].includes(view));

/** Group tags by base animation: {base: {view: tag}} (views from the rig, else common names). */
export function directionGroups(tags, views, firstView) {
  const known = views?.length ? [...views].sort((a, b) => b.length - a.length) : ALL_VIEWS;
  const groups = new Map();
  for (const t of tags) {
    let base = t, view = firstView || null;
    for (const v of known) if (t.endsWith('_' + v)) { base = t.slice(0, -v.length - 1); view = v; break; }
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[view || 'default'] = t;
  }
  return groups;
}

export class AnimViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.anim-viewer');
    host.append(this.root);
    this.playing = true;
    this.build();
    this.cells = [];
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }
  get app() { return this.ctx.app; }
  build() {
    this.tagSel = el('select', { on: { change: () => this.layout() } });
    this.playBtn = el('button.btn', { text: '❚❚', title: 'Play / pause (Space)', on: { click: () => this.toggle() } });
    this.fps = el('input', { type: 'range', min: 1, max: 30, value: store.get('fps', 10), title: 'fps for untagged frames', on: { input: () => { this.fpsLabel.textContent = `${this.fps.value} fps`; store.set('fps', Number(this.fps.value)); this.layout(); } } });
    this.fpsLabel = el('span.mono', { text: `${this.fps.value} fps` });
    this.loopCb = el('input', { type: 'checkbox', checked: true });
    this.dirCb = el('input', { type: 'checkbox', checked: store.get('dirgrid', true), on: { change: () => { store.set('dirgrid', this.dirCb.checked); this.layout(); } } });
    this.scaleIn = el('input', { type: 'range', min: 1, max: 16, value: 0, title: 'Scale', on: { input: () => { this.userScale = Number(this.scaleIn.value); this.layout(); } } });
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, el('label.toggle', {}, 'Animation ', this.tagSel)),
      el('div.group', {}, this.playBtn, el('label.toggle', { title: 'Loop' }, this.loopCb, ' Loop')),
      el('div.group', {}, this.fps, this.fpsLabel),
      el('div.group', {}, el('label.toggle', { title: 'Play every direction of this animation in a grid' }, this.dirCb, ' Per-view grid')),
      el('div.group', {}, el('span.muted', { text: 'Scale' }), this.scaleIn),
      el('div.spacer'),
      this.gifA = el('a.btn', { text: 'GIF', download: '' })));
    this.stage = el('div.anim-stage');
    this.root.append(this.stage);
    this.status = el('div.vstatus.mono');
    this.root.append(this.status);
  }
  async open(target) {
    this.name = target.name;
    this.info = await getJSON(`/api/canvas/${enc(this.name)}`).catch(() => null);
    if (!this.info) { this.stage.textContent = 'Canvas not found'; return; }
    this.strip = await loadBitmap(`/api/canvas/${enc(this.name)}/png?t=${Date.now()}`);
    this.fh = this.info.frameHeight || this.strip.height;
    const rig = this.info.meta?.rig && typeof this.info.meta.rig === 'string' ? this.app.assets?.rigs?.find((r) => r.name === this.info.meta.rig) : null;
    this.views = rig ? [...(rig.views || []), ...(rig.mirror || [])] : null;
    this.firstView = rig?.views?.[0] || null;
    const tags = Object.keys(this.info.animations || {});
    const want = tags.join('|');
    if (this.tagSel.dataset.k !== want || target.tag) {
      const cur = target.tag || this.tagSel.value;
      this.tagSel.innerHTML = '';
      this.tagSel.append(el('option', { value: '', text: 'all frames' }), ...tags.map((t) => el('option', { value: t, text: t })));
      this.tagSel.value = tags.includes(cur) ? cur : tags[0] || '';
      this.tagSel.dataset.k = want;
    }
    this.layout();
  }
  layout() {
    if (!this.info) return;
    const tag = this.tagSel.value;
    this.gifA.href = `/api/canvas/${enc(this.name)}/anim.gif?scale=4&download=1${tag ? '&animation=' + enc(tag) : ''}`;
    let list = [{ tag, label: tag || 'all frames' }];
    let compass = false;
    if (tag && this.dirCb.checked) {
      const groups = directionGroups(Object.keys(this.info.animations), this.views, this.firstView);
      const base = [...groups.entries()].find(([, v]) => Object.values(v).includes(tag));
      if (base && Object.keys(base[1]).length > 1) {
        list = Object.entries(base[1]).map(([view, t]) => ({ tag: t, label: view === 'default' ? t : view, view }));
        compass = list.every((x) => compassOf(x.view)) && list.length >= 3;
      }
    }
    const w = this.strip.width, fh = this.fh;
    const box = this.stage.getBoundingClientRect();
    const cols = compass ? 3 : Math.min(list.length, 4);
    const rows = compass ? 3 : Math.ceil(list.length / cols);
    const fitScale = Math.max(1, Math.floor(Math.min((box.width - 24 * cols) / (w * cols), (box.height - 40 * rows) / (fh * rows))));
    const scale = this.userScale || Math.min(16, fitScale);
    this.scaleIn.value = scale;
    this.stage.innerHTML = '';
    this.stage.classList.toggle('compass', compass);
    const grid = el('div.anim-grid', { style: { gridTemplateColumns: `repeat(${cols}, auto)` } });
    const slots = compass ? Array(9).fill(null) : null;
    this.cells = list.map((x) => {
      const c = el('canvas.anim-cell', { width: w * scale, height: fh * scale });
      const cell = el('figure.anim-fig', {}, c, el('figcaption', { text: x.label }));
      const pl = playList(this.info, x.tag, Number(this.fps.value));
      const st = { c, pl, idx: 0, next: 0, scale, cell };
      // review mode: a click marks this view at this frame (pin at the pixel)
      c.addEventListener('click', (e) => {
        if (!this.app.reviewMode) return;
        const r = c.getBoundingClientRect();
        const px = Math.floor(((e.clientX - r.left) / r.width) * w), py = Math.floor(((e.clientY - r.top) / r.height) * fh);
        this.app.reviewPrompt({ asset: `canvas:${this.name}`, tag: x.tag || undefined, view: x.view && x.view !== 'default' ? x.view : undefined, frame: st.pl.frames[st.idx], point: [px, py] });
      });
      if (slots) slots[SLOT[compassOf(x.view)]] = cell; else grid.append(cell);
      return st;
    });
    if (slots) slots.forEach((s, i) => grid.append(s || el('figure.anim-fig.empty', {}, i === 4 ? el('span.muted', { text: tag.replace(/_.*/, '') || '' }) : '')));
    this.stage.append(grid);
    const t = this.info.animations?.[tag];
    this.status.textContent = `${this.name} · ${tag ? `${tag}: ${t.frames.length} frames, ${t.durations.reduce((a, b) => a + b, 0)} ms${t.loop === false ? ', no loop' : ''}${t.direction && t.direction !== 'forward' ? `, ${t.direction}` : ''}` : `${this.info.frames} frames @ ${this.fps.value} fps`}${list.length > 1 ? ` · ${list.length} views` : ''}`;
    for (const s of this.cells) this.drawCell(s);
  }
  drawCell(s) {
    const cx = s.c.getContext('2d');
    checker(cx, 0, 0, s.c.width, s.c.height, Math.max(4, s.scale * 2));
    cx.imageSmoothingEnabled = false;
    const f = s.pl.frames[s.idx] ?? 0;
    cx.drawImage(this.strip, 0, f * this.fh, this.strip.width, this.fh, 0, 0, s.c.width, s.c.height);
  }
  tick(t) {
    this.raf = requestAnimationFrame((x) => this.tick(x));
    if (!this.playing) return;
    for (const s of this.cells) {
      if (!s.next) s.next = t + (s.pl.durations[s.idx] || 100);
      if (t < s.next) continue;
      let i = s.idx + 1;
      if (i >= s.pl.frames.length) { if (!this.loopCb.checked) continue; i = 0; }
      s.idx = i;
      s.next = t + (s.pl.durations[i] || 100);
      this.drawCell(s);
    }
  }
  toggle() { this.playing = !this.playing; this.playBtn.textContent = this.playing ? '❚❚' : '▶'; }
  onEvent(ev) {
    if (ev.type === 'change' && ev.canvas === this.name) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open({ name: this.name }), 120); }
  }
  keydown(e, k) {
    if (k === ' ') { this.toggle(); return true; }
    return false;
  }
  destroy() { cancelAnimationFrame(this.raf); clearTimeout(this.rt); this.root.remove(); }
}
