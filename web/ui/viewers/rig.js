// Rig viewer: parts sheet (cells + pivots), pose previews per view, and clips (the rig's animated
// output canvases) played with a skeleton overlay built from the per-frame part anchors.
import { el, enc, getJSON, loadBitmap, checker, playList } from '../util.js';
import { PixelView } from './pixel.js';

export class RigViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.rig-viewer');
    host.append(this.root);
    this.mode = 'clip';
    this.playing = true;
    this.modeSel = el('select', { on: { change: () => { this.mode = this.modeSel.value; this.show(); } } },
      el('option', { value: 'clip', text: 'Clip + skeleton' }), el('option', { value: 'pose', text: 'Pose (all views)' }), el('option', { value: 'parts', text: 'Parts sheet' }), this.skinOpt = el('option', { value: 'skin', text: 'Skin mesh + weights' }));
    this.meshSel = el('select', { on: { change: () => { this.fillBones(); this.show(); } } });
    this.boneSel = el('select', { on: { change: () => this.show() } });
    this.poseSel = el('select', { on: { change: () => this.show() } });
    this.viewSel = el('select', { on: { change: () => this.show() } });
    this.clipSel = el('select', { on: { change: () => this.show() } });
    this.boneCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.drawClip() } });
    this.playBtn = el('button.btn', { text: '❚❚', title: 'Play / pause (Space)', on: { click: () => this.toggle() } });
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, this.modeSel),
      this.poseG = el('div.group', {}, el('span.muted', { text: 'Pose' }), this.poseSel),
      this.viewG = el('div.group', {}, el('span.muted', { text: 'View' }), this.viewSel),
      this.clipG = el('div.group', {}, el('span.muted', { text: 'Clip' }), this.clipSel, this.playBtn, el('label.toggle', {}, this.boneCb, ' Skeleton')),
      this.skinG = el('div.group', {}, el('span.muted', { text: 'Mesh' }), this.meshSel, el('span.muted', { text: 'Bone' }), this.boneSel),
      el('div.spacer'),
      this.editBtn = el('button.btn', { text: 'Edit parts', title: 'Open the parts canvas in the editor', on: { click: () => this.ctx.app.open({ kind: 'canvas', name: `${this.name}_parts` }) } })));
    this.stage = el('div.rig-stage');
    this.root.append(this.stage);
    this.status = el('div.vstatus.mono');
    this.root.append(this.status);
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }
  async open(target) {
    this.name = target.name;
    this.rig = await getJSON(`/api/rig/${enc(this.name)}`).catch((e) => ({ error: e.message }));
    if (this.rig.error) { this.stage.textContent = this.rig.error; return; }
    const views = [...this.rig.views, ...Object.keys(this.rig.mirror || {})];
    const fill = (sel, items, first) => {
      const k = items.join('|');
      if (sel.dataset.k === k) return;
      const cur = sel.value;
      sel.innerHTML = '';
      if (first) sel.append(el('option', { value: '', text: first }));
      for (const v of items) sel.append(el('option', { value: v, text: v }));
      if (items.includes(cur)) sel.value = cur;
      sel.dataset.k = k;
    };
    fill(this.poseSel, Object.keys(this.rig.poses || {}), 'rest');
    fill(this.viewSel, views, 'all views');
    // clips: tags on the rig's output canvases
    const outs = this.ctx.app.assets?.rigs?.find((r) => r.name === this.name)?.outputs || [];
    this.outInfo = {};
    const clips = [];
    for (const o of outs) {
      const info = await getJSON(`/api/canvas/${enc(o)}`).catch(() => null);
      if (!info) continue;
      this.outInfo[o] = info;
      for (const t of Object.keys(info.animations || {})) clips.push(`${o}/${t}`);
    }
    fill(this.clipSel, clips, null);
    // 2D skin: mesh / bone pickers for the weights view
    this.skinOpt.hidden = !this.rig.skin;
    if (this.rig.skin) { fill(this.meshSel, Object.keys(this.rig.skin), null); this.fillBones(); }
    else if (this.mode === 'skin') this.mode = 'pose';
    if (target.clip && clips.includes(target.clip)) this.clipSel.value = target.clip;
    if (!clips.length && this.mode === 'clip') { this.mode = 'pose'; }
    if (target.mode) this.mode = target.mode;
    this.modeSel.value = this.mode;
    this.parent = Object.fromEntries(Object.entries(this.rig.parts).map(([n, p]) => [n, p.parent]));
    await this.show();
  }
  fillBones() {
    const bones = this.rig.skin?.[this.meshSel.value]?.bones || [];
    const cur = this.boneSel.value;
    this.boneSel.innerHTML = '';
    this.boneSel.append(el('option', { value: '', text: 'dominant bone' }));
    for (const b of bones) this.boneSel.append(el('option', { value: b, text: b }));
    if (bones.includes(cur)) this.boneSel.value = cur;
  }
  async show() {
    this.poseG.hidden = this.mode !== 'pose';
    this.viewG.hidden = this.mode !== 'pose' && this.mode !== 'skin';
    this.skinG.hidden = this.mode !== 'skin';
    this.clipG.hidden = this.mode !== 'clip';
    this.pv?.destroy(); this.pv = null;
    this.stage.innerHTML = '';
    this.clip = null;
    const r = this.rig;
    const base = `${this.name} · frame ${r.frame.join('×')} · ${Object.keys(r.parts).length} parts · views ${r.views.join(', ')}${Object.keys(r.mirror || {}).length ? ` (+ mirrored ${Object.keys(r.mirror).join(', ')})` : ''}`;
    if (this.mode === 'parts') {
      const host = el('div.stage');
      this.stage.append(host);
      this.pv = new PixelView(host, { editable: false });
      this.pv.setImage(await loadBitmap(`/api/canvas/${enc(this.name + '_parts')}/png?t=${Date.now()}`));
      this.status.textContent = `${base} · parts canvas ${this.name}_parts (red dot = pivot)`;
      return;
    }
    if (this.mode === 'skin') {
      const q = new URLSearchParams({ mesh: this.meshSel.value, t: Date.now() });
      if (this.boneSel.value) q.set('bone', this.boneSel.value);
      if (this.viewSel.value) q.set('view', this.viewSel.value);
      const img = el('img.pose-img', { src: `/api/rig/${enc(this.name)}/weights.png?${q}`, alt: 'skin weights' });
      this.stage.append(el('div.center-scroll', {}, img));
      this.status.textContent = `${base} · skin ${this.meshSel.value}: drawing + lattice | ${this.boneSel.value ? `weight of ${this.boneSel.value} (blue 0 .. red 1)` : 'dominant bone per pixel'}`;
      return;
    }
    if (this.mode === 'pose') {
      const q = new URLSearchParams();
      if (this.poseSel.value) q.set('pose', this.poseSel.value);
      if (this.viewSel.value) q.set('view', this.viewSel.value);
      q.set('t', Date.now());
      const img = el('img.pose-img', { src: `/api/rig/${enc(this.name)}/preview.png?${q}`, alt: 'pose preview' });
      this.stage.append(el('div.center-scroll', {}, img));
      this.status.textContent = `${base} · pose ${this.poseSel.value || 'rest'} · red dashes = ground line`;
      return;
    }
    const [canvas, tag] = (this.clipSel.value || '').split('/');
    const info = this.outInfo[canvas];
    if (!info) { this.stage.append(el('div.empty-note', { text: 'No clips yet: art_rig animate {name, preset} renders them.' })); this.status.textContent = base; return; }
    const strip = await loadBitmap(`/api/canvas/${enc(canvas)}/png?t=${Date.now()}`);
    const fh = info.frameHeight || strip.height;
    const box = this.stage.getBoundingClientRect();
    const scale = Math.max(1, Math.min(16, Math.floor(Math.min((box.width - 40) / strip.width, (box.height - 40) / fh))));
    const c = el('canvas.rig-canvas', { width: strip.width * scale, height: fh * scale });
    this.stage.append(el('div.center-scroll', {}, c));
    this.clip = { c, strip, fh, scale, info, tag, pl: playList(info, tag), idx: 0, next: 0, anchors: info.meta?.anchors?.[tag] || [] };
    c.addEventListener('click', (e) => {
      if (!this.ctx.app.reviewMode) return;
      const k = this.clip, r = c.getBoundingClientRect();
      this.ctx.app.reviewPrompt({ asset: `canvas:${canvas}`, tag, frame: k.pl.frames[k.idx], point: [Math.floor((e.clientX - r.left) / k.scale), Math.floor((e.clientY - r.top) / k.scale)] });
    });
    this.status.textContent = `${base} · clip ${canvas}/${tag}: ${this.clip.pl.frames.length} frames${this.clip.anchors.length ? ' · skeleton from part anchors' : ' · no anchors on this clip'}`;
    this.drawClip();
  }
  drawClip() {
    const k = this.clip;
    if (!k) return;
    const cx = k.c.getContext('2d');
    checker(cx, 0, 0, k.c.width, k.c.height, Math.max(4, k.scale * 2));
    cx.imageSmoothingEnabled = false;
    const f = k.pl.frames[k.idx] ?? 0;
    cx.drawImage(k.strip, 0, f * k.fh, k.strip.width, k.fh, 0, 0, k.c.width, k.c.height);
    if (!this.boneCb.checked) return;
    // anchors are per frame of the tag (in tag order); playList may reverse / pingpong the frames
    const tagFrames = k.info.animations[k.tag]?.frames || [];
    const ai = tagFrames.indexOf(f);
    const an = k.anchors[ai >= 0 ? ai : k.idx];
    if (!an) return;
    const P = (n) => an[n] && [(an[n][0] + 0.5) * k.scale, (an[n][1] + 0.5) * k.scale];
    cx.lineWidth = Math.max(1.5, k.scale / 3);
    for (const n of Object.keys(an)) {
      const p = P(n), q = this.parent[n] && P(this.parent[n]);
      if (p && q) { cx.strokeStyle = 'rgba(245,165,36,.9)'; cx.beginPath(); cx.moveTo(q[0], q[1]); cx.lineTo(p[0], p[1]); cx.stroke(); }
    }
    for (const n of Object.keys(an)) {
      const p = P(n);
      if (!p) continue;
      cx.fillStyle = this.parent[n] ? '#38bdf8' : '#e5484d';
      cx.beginPath(); cx.arc(p[0], p[1], Math.max(2, k.scale / 2.5), 0, Math.PI * 2); cx.fill();
      if (k.scale >= 4) { cx.fillStyle = 'rgba(230,233,239,.85)'; cx.font = '10px ui-monospace, monospace'; cx.fillText(n, p[0] + 4, p[1] - 4); }
    }
  }
  tick(t) {
    this.raf = requestAnimationFrame((x) => this.tick(x));
    const k = this.clip;
    if (!k || !this.playing) return;
    if (!k.next) k.next = t + (k.pl.durations[k.idx] || 100);
    if (t < k.next) return;
    k.idx = (k.idx + 1) % k.pl.frames.length;
    k.next = t + (k.pl.durations[k.idx] || 100);
    this.drawClip();
  }
  toggle() { this.playing = !this.playing; this.playBtn.textContent = this.playing ? '❚❚' : '▶'; }
  onEvent(ev) {
    if (ev.type !== 'change') return;
    if (ev.canvas === `${this.name}_parts` || this.outInfo?.[ev.canvas]) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open({ name: this.name }), 200); }
  }
  keydown(e, k) { if (k === ' ') { this.toggle(); return true; } return false; }
  destroy() { cancelAnimationFrame(this.raf); clearTimeout(this.rt); this.pv?.destroy(); this.root.remove(); }
}
