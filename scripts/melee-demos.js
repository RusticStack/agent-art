// Renders the melee demos in docs/melee/ with Agent Art's own ops only: weapon turntables
// (art_model melee_<id> + model render), 8-direction strike sheets with the exported hit volumes
// drawn over the frames (art_anim melee + batch, overlays with art_draw line / ellipse / polygon),
// the paired rear takedown (art_anim paired) and first-person bash frames with their strike
// capsules (art_fp sweep + batch + composite).
// Usage: node scripts/melee-demos.js [workDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { MELEE_IDS, MELEE_WEAPONS } from '../src/meleekit.js';
import { VIEW_YAW8 } from '../src/melee.js';
import { packImages } from '../src/sheet.js';
import { encodePNG, decodePNG } from '../src/png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'melee');
fs.mkdirSync(DOCS, { recursive: true });
const work = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-melee-demo-')));
const e = new Engine({ home: path.join(work, 'home') });
const t0 = performance.now();
const log = (...a) => console.log(`[${Math.round((performance.now() - t0) / 1000)}s]`, ...a);
const save = (file, img) => { fs.writeFileSync(path.join(DOCS, file), encodePNG(img.width, img.height, img.data)); log(file, `${img.width}x${img.height}`); };
const zoom = (im, k) => {
  const W = im.width * k, H = im.height * k, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * im.width + Math.floor(x / k)) * 4; d.set(im.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: d };
};
const crop = (im, x0, y0, w, h) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) d.set(im.data.subarray(((y0 + y) * im.width + x0) * 4, ((y0 + y) * im.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: d };
};
const canvasImage = (name) => decodePNG(e.get(name).toPNG({}));
const BG = '#3a3530';

// ---------- 1. weapon turntables ----------
{
  const rows = [];
  for (const id of MELEE_IDS) {
    e.run('model_create', { name: `m_${id}`, template: `melee_${id}`, overwrite: true });
    // model units are cm with the grip on the origin: the longest reach fits half the cell
    const zoom = 46 / MELEE_WEAPONS[id].length_cm;
    const r = e.run('model_render', { name: `m_${id}`, camera: { yaw: 0, pitch: 0 }, zoom, size: [100, 100], angles: [0, 45, 90, 135, 180, 225, 270, 315].map((yaw) => ({ yaw, pitch: 20 })), outline: '#141218', light: { dir: [-0.5, 0.7, 0.6], ambient: 0.45 }, canvas: `tt_${id}` });
    rows.push({ img: decodePNG(Buffer.from(r.image)), label: id });
  }
  const s = packImages(rows, { labels: true, checker: false, columns: 2 });
  save('weapon-turntables.png', s);
}

// ---------- characters: a simple painted humanoid_hd skin per skeleton ----------
const PAL = { head: '#d9a882', weapon: '#c3ccd4', shield: '#3c4450', arm: '#56603e', hand: '#2c2a2e', leg: '#3e4636', body: '#4c5640', foot: '#1f1c1c' };
const DARK = { head: '#8a5c46', weapon: '#5d6670', shield: '#1b1f26', arm: '#2c3320', hand: '#141216', leg: '#1f241a', body: '#262c1e', foot: '#0d0b0b' };
const kind = (k) => (k.startsWith('head') ? 'head' : k === 'weapon' ? 'weapon' : k === 'shield' ? 'shield' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');
function paint(skin, tint) {
  const cells = e.run('rig_info', { name: skin }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) {
    const [k] = k0.split(':');
    if (k === 'cape' || k.startsWith('gear')) continue;
    const c = kind(k), fill = tint && c === 'body' ? tint : PAL[c];
    if (k === 'weapon') { const t = Math.max(2, Math.floor(h / 2)); cmds.push({ op: 'rect', x, y: y + Math.floor((h - t) / 2), w, h: t, color: fill, outline: DARK[c] }); continue; }
    cmds.push({ op: 'rect', x, y, w, h, color: fill, outline: DARK[c] });
    if (c === 'head') cmds.push({ op: 'rect', x: x + w - 4, y: y + 3, w: 3, h: 2, color: '#e8f0ff' });
  }
  e.run('draw', { canvas: `${skin}_parts`, layer: 'parts', commands: cmds });
}

// ---------- 2. 8-direction strike sheets with hit volumes ----------
const VIEWS8 = Object.keys(VIEW_YAW8);
function strikeSheet(file, skel, opts, clip, label) {
  e.run('anim_skeleton', { name: skel, template: 'humanoid_hd', frame: [128, 192], ...(opts.gun ? { weapon: { class: opts.gun } } : {}) });
  e.run('anim_melee', { skeleton: skel, ...(opts.weapon ? { weapon: opts.weapon } : {}), ...(opts.shield ? { shield: true } : {}) });
  const skin = `${skel}_skin`;
  e.run('anim_skin', { name: skin, skeleton: skel });
  paint(skin);
  const out = path.join(work, `out_${skel}`);
  e.run('anim_batch', { skins: [skin], clips: [clip], views: VIEWS8, out });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  const set = Object.values(man.sprites).find((s) => s.skin === skin) || Object.values(man.sprites)[0];
  const [FW, FH] = set.frame;
  const cells = [];
  for (const view of VIEWS8) {
    const A = set.anims[`${clip}_${view}`];
    if (!A?.melee) continue;
    const cv = `strip_${skel}_${view}`;
    e.run('import', { path: path.join(out, A.file), canvas: cv, overwrite: true });
    // a backdrop layer under the sprite, then the volumes of every active frame on top
    e.run('layer', { canvas: cv, action: 'add', name: 'bg', position: 'bottom' });
    const cmds = [];
    for (const h of A.melee.hits) for (const v of h.volumes) {
      const ox = h.frame * FW;
      if (v.sweep?.length >= 3) cmds.push({ op: 'polygon', points: v.sweep.map(([x, y]) => [ox + x, y]), fill: false, color: '#f2c14e' });
      cmds.push({ op: 'line', x1: Math.round(ox + v.a[0]), y1: Math.round(v.a[1]), x2: Math.round(ox + v.b[0]), y2: Math.round(v.b[1]), color: '#ff4a3d' });
      const r = Math.max(1, Math.round(v.r));
      for (const p of [v.a, v.b]) cmds.push({ op: 'ellipse', x: Math.round(ox + p[0] - r), y: Math.round(p[1] - r), w: 2 * r + 1, h: 2 * r + 1, fill: false, color: '#ff4a3d' });
    }
    e.run('layer', { canvas: cv, action: 'add', name: 'volumes', position: 'top' });
    e.run('draw', { canvas: cv, layer: 'volumes', commands: cmds });
    e.run('draw', { canvas: cv, layer: 'bg', commands: [{ op: 'rect', x: 0, y: 0, w: FW * A.frames, h: FH, color: BG }] });
    const img = canvasImage(cv);
    for (const f of A.melee.events.filter((x) => x.name === 'impact').map((x) => x.frame)) cells.push({ img: zoom(crop(img, f * FW, 0, FW, FH), 2), label: `${view} f${f}` });
  }
  const s = packImages(cells, { labels: true, checker: false, columns: Math.min(cells.length, label === 'combo' ? 6 : 8) });
  save(file, s);
}

// ---------- 3. paired takedown strip ----------
function pairedStrip() {
  e.run('anim_skeleton', { name: 'pk', template: 'humanoid_hd', frame: [128, 192] });
  e.run('anim_melee', { skeleton: 'pk', weapon: 'combat_knife' });
  e.run('anim_skin', { name: 'pk_a', skeleton: 'pk' }); paint('pk_a');
  e.run('anim_skin', { name: 'pk_v', skeleton: 'pk' }); paint('pk_v', '#6a3c34');
  const imgs = [];
  for (const view of ['side', 'front_side']) {
    const r = e.run('anim_paired', { skin: 'pk_a', victim_skin: 'pk_v', pair: 'takedown_rear', view });
    imgs.push({ img: decodePNG(Buffer.from(r.image)), label: `takedown_rear ${view} (sync ${r.sync_frame}, ${r.order})` });
  }
  save('paired-takedown-rear.png', packImages(imgs, { labels: true, checker: false, columns: 1 }));
}

// ---------- 4. first-person bash frames ----------
function fpFrames() {
  const out = path.join(work, 'fp');
  e.run('fp_sweep', { out, guns: ['rifle', 'pistol'], mags: ['rifle_mag_30', 'pistol_mag'], attachments: [], items: ['knife', 'baton', 'riot_shield'] });
  e.run('fp_batch', { out, classes: ['rifle', 'pistol', 'knife', 'baton', 'unarmed'], clips: ['melee', 'combo', 'strike', 'shield_bash', 'shield_up'], variants: false });
  const fp = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp.json'), 'utf8'));
  const shots = [['rifle', 'melee'], ['pistol', 'melee'], ['knife', 'combo'], ['unarmed', 'melee'], ['baton', 'strike'], ['baton', 'shield_bash']];
  const cells = [];
  for (const [cls, clip] of shots) {
    const A = fp.sprites[`fp_${cls}`].anims[clip];
    for (const f of A.melee.events.filter((x) => x.e === 'impact').map((x) => x.f)) {
      const r = e.run('fp_composite', { out, class: cls, clip, frame: f, zoom: 1, canvas: `fpc_${cls}_${clip}_${f}` });
      const cv = r.canvas;
      e.run('layer', { canvas: cv, action: 'add', name: 'volumes', position: 'top' });
      const cmds = [];
      for (const h of A.melee.hits.filter((x) => x.f === f)) for (const v of h.volumes) {
        if (v.sweep?.length >= 3) cmds.push({ op: 'polygon', points: v.sweep, fill: false, color: '#f2c14e' });
        cmds.push({ op: 'line', x1: Math.round(v.a[0]), y1: Math.round(v.a[1]), x2: Math.round(v.b[0]), y2: Math.round(v.b[1]), color: '#ff4a3d', width: 2 });
        const rr = Math.max(1, Math.round(v.r));
        for (const p of [v.a, v.b]) cmds.push({ op: 'ellipse', x: Math.round(p[0] - rr), y: Math.round(p[1] - rr), w: 2 * rr + 1, h: 2 * rr + 1, fill: false, color: '#ff4a3d' });
      }
      e.run('draw', { canvas: cv, layer: 'volumes', commands: cmds });
      cells.push({ img: canvasImage(cv), label: `${cls} ${clip} f${f} (${A.melee.damage ?? 'block'})` });
    }
  }
  save('fp-melee-frames.png', packImages(cells, { labels: true, checker: false, columns: 3 }));
}

strikeSheet('strike-knife-combo.png', 'dk', { weapon: 'combat_knife' }, 'knife_combo', 'combo');
strikeSheet('strike-rifle-butt.png', 'dr', { gun: 'rifle' }, 'butt_stroke', 'rifle');
strikeSheet('strike-shield-bash.png', 'ds', { weapon: 'baton', shield: true }, 'shield_bash', 'shield');
pairedStrip();
fpFrames();
log('done', work);
