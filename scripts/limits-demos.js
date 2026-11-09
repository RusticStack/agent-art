// Renders the 0.9 limits-pass demos in docs/limits/ with Agent Art's own ops: fp muzzle aim variants
// over an fp gun, diagonal muzzle flashes, a damage glb with baked AO kept (AO / mask UV sets), the
// damage blend at every LOD, a rigged damaged door opening (the exported glb's clip sampled), open-mesh
// fracture, the gun disarm strip with its gun track, front / back paired checks and a two-proportion
// takedown. glb images are drawn from the exported files (a small glTF reader + the software
// rasteriser), so they show what an engine loads.
// Usage: node scripts/limits-demos.js [workDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { packImages } from '../src/sheet.js';
import { encodePNG, decodePNG } from '../src/png.js';
import { normFx, renderFx } from '../src/fx/render.js';
import { makeCamera, renderCamera } from '../src/raster3d.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'limits');
fs.mkdirSync(DOCS, { recursive: true });
const work = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-limits-demo-')));
const e = new Engine({ home: path.join(work, 'home') });
const out = path.join(work, 'out');
fs.mkdirSync(out, { recursive: true });
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
const fill = (W, H, c) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d.set(c, i); return { width: W, height: H, data: d }; };
const BG = [42, 40, 46, 255];
const over = (dst, src) => { for (let i = 0; i < dst.data.length; i += 4) if (src.data[i + 3]) dst.data.set(src.data.subarray(i, i + 4), i); return dst; };
const pane = (img) => over(fill(img.width, img.height, BG), img);
const vstack = (imgs) => {
  const W = Math.max(...imgs.map((i) => i.width)), H = imgs.reduce((s, i) => s + i.height, 0), o = fill(W, H, [32, 34, 40, 255]);
  let y0 = 0;
  for (const im of imgs) { for (let y = 0; y < im.height; y++) o.data.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((y0 + y) * W) * 4); y0 += im.height; }
  return o;
};

// ---------- a small glTF reader: nodes (TRS / matrix, morph weights, clip sampling) -> raster groups ----------
function readGLB(file) {
  const buf = fs.readFileSync(file);
  const jl = buf.readUInt32LE(12), json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl, bin = buf.subarray(bo + 8, bo + 8 + buf.readUInt32LE(bo));
  const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
  const acc = (i) => {
    const A = json.accessors[i], V = json.bufferViews[A.bufferView], C = T[A.componentType], n = N[A.type] * A.count;
    const off = bin.byteOffset + V.byteOffset + (A.byteOffset || 0);
    return Array.from(new C(bin.buffer.slice(off, off + n * C.BYTES_PER_ELEMENT)));
  };
  const images = (json.images || []).map((im) => { const V = json.bufferViews[im.bufferView]; return decodePNG(Buffer.from(bin.subarray(V.byteOffset, V.byteOffset + V.byteLength))); });
  return { json, acc, images, byName: new Map(json.nodes.map((n, i) => [n.name, i])) };
}
const qmat = (q) => { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]; };
function nodeMat(n, trs) {
  if (n.matrix && !trs) { const m = n.matrix; return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]]; }
  const t = trs?.t ?? n.translation ?? [0, 0, 0], q = trs?.q ?? n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1], R = qmat(q);
  return [R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0], R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1], R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2]];
}
const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0)));
/** Clip TRS per node at time t (LINEAR / STEP; rotations nlerped). */
function sampleClip(G, name, t) {
  const an = (G.json.animations || []).find((a) => a.name === name), out = new Map();
  if (!an) return out;
  for (const ch of an.channels) {
    const sm = an.samplers[ch.sampler], times = G.acc(sm.input), vals = G.acc(sm.output), k = ch.target.path === 'rotation' ? 4 : 3;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= t) i++;
    const u = sm.interpolation === 'STEP' ? 0 : Math.max(0, Math.min(1, (t - times[i]) / Math.max(1e-9, times[i + 1] - times[i])));
    let v = Array.from({ length: k }, (_, c) => vals[i * k + c] * (1 - u) + vals[Math.min(times.length - 1, i + 1) * k + c] * u);
    if (k === 4) { const l = Math.hypot(...v); v = v.map((x) => x / l); }
    const o = out.get(ch.target.node) || {};
    o[ch.target.path === 'rotation' ? 'q' : 't'] = v;
    out.set(ch.target.node, o);
  }
  return out;
}
/**
 * Raster groups of a node subtree. opts: clip / t (animation), morph (weight 0..1), uvSet (texture the
 * model with an image through another UV set: {set, image}), mask ({set, image, blend}: the damage
 * threshold drawn over a grey surface), skip(nodeName).
 */
function sceneGroups(G, rootName, opts = {}) {
  const groups = [], anim = opts.clip ? sampleClip(G, opts.clip, opts.t ?? 0) : new Map();
  let key = 0;
  const texOf = (img) => ({ key: `t${key++}`, name: 'tex', width: img.width, height: img.height, data: img.data });
  const walk = (i, M) => {
    const n = G.json.nodes[i];
    if (opts.skip && opts.skip(n)) return;
    const W = mul(M, nodeMat(n, anim.get(i) && { t: anim.get(i).t ?? n.translation, q: anim.get(i).q ?? n.rotation }));
    if (n.mesh !== undefined) for (const p of G.json.meshes[n.mesh].primitives) {
      const mat = G.json.materials[p.material] || {}, bt = mat.pbrMetallicRoughness?.baseColorTexture;
      const pos = G.acc(p.attributes.POSITION), nrm = G.acc(p.attributes.NORMAL), idx = G.acc(p.indices);
      if (p.targets && opts.morph) { const d = G.acc(p.targets[0].POSITION); for (let k = 0; k < pos.length; k++) pos[k] += d[k] * opts.morph; }
      let uvSet = bt?.texCoord ?? 0, img = bt ? G.images[G.json.textures[bt.index].source] : null;
      const overlay = uvSet !== 0;
      if (opts.uvSet && !overlay) { uvSet = opts.uvSet.set; img = opts.uvSet.image; }
      if (opts.mask && !overlay) { uvSet = opts.mask.set; img = maskImage(opts.mask.image, opts.mask.blend); }
      if (overlay && (opts.uvSet || opts.mask)) continue;
      if (!img) { const c = (mat.pbrMetallicRoughness?.baseColorFactor || [0.7, 0.7, 0.7, 1]).map((v) => Math.round(v * 255)); img = { width: 1, height: 1, data: Uint8ClampedArray.from(c) }; }
      const uvA = p.attributes[`TEXCOORD_${uvSet}`];
      const uv = uvA !== undefined ? G.acc(uvA) : new Array((pos.length / 3) * 2).fill(0.5);
      const wp = [], wn = [];
      for (let v = 0; v < pos.length / 3; v++) {
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        wp.push(W[0] * x + W[1] * y + W[2] * z + W[3], W[4] * x + W[5] * y + W[6] * z + W[7], W[8] * x + W[9] * y + W[10] * z + W[11]);
        const a = nrm[v * 3], b = nrm[v * 3 + 1], c = nrm[v * 3 + 2];
        wn.push(W[0] * a + W[1] * b + W[2] * c, W[4] * a + W[5] * b + W[6] * c, W[8] * a + W[9] * b + W[10] * c);
      }
      groups.push({ tex: texOf(img), pos: wp, nrm: wn, uv, idx, ...(overlay ? { overlay: true, uv0: uv, alpha: new Array(pos.length / 3).fill(1) } : {}) });
    }
    for (const c of n.children || []) walk(c, W);
  };
  walk(G.byName.get(rootName), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  return groups;
}
/** The damage mask at a blend (threshold encoding): grey surface, scorch dark brown, dents blue-grey, holes black, wear light. */
function maskImage(m, blend) {
  const d = new Uint8ClampedArray(m.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const on = (v) => v > 0 && blend >= 1 - v / 255;
    let c = [138, 143, 150];
    if (on(m.data[i + 1])) c = [104, 118, 140];
    if (on(m.data[i + 3])) c = [196, 200, 204];
    if (on(m.data[i])) c = [58, 42, 30];
    if (on(m.data[i + 2])) c = [12, 10, 12];
    d.set([...c, 255], i);
  }
  return { width: m.width, height: m.height, data: d };
}
const fitOf = (groups) => { const f = []; for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) f.push([g.pos[i], g.pos[i + 1], g.pos[i + 2]]); return f; };
const shot = (groups, S = 160, view = 'game', fit = null) => renderCamera(groups, makeCamera(view, S, S, fit || fitOf(groups), {}), S, S);

// ---------- 1. fp muzzle aim variants over an fp gun ----------
{
  e.run('model_create', { name: 'ar', template: 'fp_rifle' });
  // the gun swung across the screen (turning / recoil extremes): the muzzle's screen aim changes
  e.run('model_render', { name: 'ar', canvas: 'ar_sway', camera: 'fp', size: [384, 216], sweep: { yaw: [-50, 50, 10], pitch: [-30, 30, 30] } });
  const d = e.get('ar_sway'), fh = d.frameHeight || d.height, full = d.composite(), anchors = Object.values(d.meta.anchors)[0];
  const fx = path.join(out, 'fx');
  const mk = e.run('fx_make', { type: 'muzzle', variant: 'rifle', view: 'fp', seed: 3, path: fx, aims: 7 });
  const cell = mk.meta.cell, pivot = mk.meta.pivot, cols = mk.meta.grid ? mk.meta.grid[0] : Math.floor(mk.meta.sheet[0] / cell[0]);
  const variants = mk.meta.fp.aims.map((v) => ({ aim: v.aim_deg, img: crop(decodePNG(fs.readFileSync(path.join(fx, v.file))), (1 % cols) * cell[0], Math.floor(1 / cols) * cell[1], cell[0], cell[1]) }));
  const near = (deg) => variants.reduce((b, v) => { const dd = Math.abs(((deg - v.aim + 540) % 360) - 180); return dd < b.d ? { d: dd, v } : b; }, { d: Infinity }).v;
  const items = [];
  // one frame per variant the sweep reaches (muzzle on screen)
  const aimOf = (f) => { const a = anchors[f]?.socket_muzzle; return a && a[0] > 8 && a[1] > 8 && a[0] < d.width - 8 && a[1] < fh - 8 ? a[2] ?? (Math.atan2(fh / 2 - a[1], d.width / 2 - a[0]) * 180) / Math.PI : null; };
  const byVar = new Map();
  for (let f = 0; f < d.frames; f++) { const deg = aimOf(f); if (deg === null) continue; const v = near(deg); if (!byVar.has(v.aim)) byVar.set(v.aim, f); }
  const picks = [...byVar.values()].slice(0, 6);
  for (const f of picks) {
    const im = { width: d.width, height: fh, data: full.slice(f * d.width * fh * 4, (f + 1) * d.width * fh * 4) };
    const a = anchors[f].socket_muzzle, deg = a[2] ?? (Math.atan2(fh / 2 - a[1], d.width / 2 - a[0]) * 180) / Math.PI, v = near(deg);
    const x0 = Math.round(a[0] - pivot[0]), y0 = Math.round(a[1] - pivot[1]);
    for (let y = 0; y < cell[1]; y++) for (let x = 0; x < cell[0]; x++) {
      const s = (y * cell[0] + x) * 4, X = x0 + x, Y = y0 + y;
      if (!v.img.data[s + 3] || X < 0 || Y < 0 || X >= im.width || Y >= im.height) continue;
      const o = (Y * im.width + X) * 4;
      for (let k = 0; k < 3; k++) im.data[o + k] = Math.min(255, im.data[o + k] + v.img.data[s + k]);
      im.data[o + 3] = 255;
    }
    items.push({ img: pane(im), label: `muzzle aim ${Math.round(deg)} deg -> variant ${v.aim} deg` });
  }
  const row = variants.map((v) => ({ img: pane(v.img), label: `variant ${Math.round(v.aim)} deg` }));
  save('fp_aims.png', vstack([packImages(items, { labels: true, checker: false, columns: items.length }), packImages(row, { labels: true, checker: false, columns: row.length })]));
}

// ---------- 2. diagonal muzzle flashes ----------
{
  const items = [];
  for (const variant of ['rifle', 'pistol', 'shotgun', 'energy']) for (const view of ['side', 'front_side', 'back_side', 'front']) {
    const r = renderFx(normFx({ type: 'muzzle', variant, view, seed: 4 }));
    const frames = r.frames.slice(0, 3).map((f) => pane({ width: r.meta.cell[0], height: r.meta.cell[1], data: f }));
    const strip = fill(frames.reduce((s, f) => s + f.width + 2, 0), frames[0].height, BG);
    let x = 0;
    for (const f of frames) { for (let y = 0; y < f.height; y++) strip.data.set(f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4), (y * strip.width + x) * 4); x += f.width + 2; }
    items.push({ img: zoom(strip, 3), label: `${variant} ${view}` });
  }
  save('muzzle_diagonals.png', packImages(items, { labels: true, checker: false, columns: 4 }));
}

// ---------- 3. damage glb with baked AO kept; 4. blend at every LOD ----------
e.run('create', { name: 'plank', width: 16 });
e.run('draw', { canvas: 'plank', commands: [{ op: 'noise', colors: ['#7a5630', '#835d34', '#8c6538'], scale: 3, seed: 2 }, { op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#4a3420', fill: false }] });
e.run('create', { name: 'hull', width: 16 });
e.run('draw', { canvas: 'hull', commands: [{ op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 3, seed: 3 }, { op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#2a2e35', fill: false }] });
e.run('model_create', { name: 'crate', origin: 'bottom', parts: [
  { type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'plank' },
  { type: 'box', id: 'lid', w: 26, h: 2, d: 26, at: [0, 24, 0], texture: 'hull' },
  { type: 'box', id: 'foot', w: 28, h: 2, d: 28, at: [0, -2, 0], texture: 'hull' },
] });
e.run('model_damage', { name: 'crate', kind: 'crate', seed: 7, states: ['scuffed', 'damaged', 'wrecked'] });
{
  const dir = path.join(out, 'ao');
  e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), bake_ao: true, uv2: true });
  const G = readGLB(path.join(dir, 'crate.damage.glb')), man = JSON.parse(fs.readFileSync(path.join(dir, 'crate.damage.json'), 'utf8'));
  const prim = G.json.meshes[G.json.nodes[G.byName.get('crate_intact')].mesh].primitives[0];
  const aoImg = G.images[G.json.textures[G.json.materials[prim.material].occlusionTexture.index].source];
  const set = Number(man.blend.uv_set.match(/TEXCOORD_(\d)/)[1]);
  const mask = decodePNG(fs.readFileSync(path.join(dir, 'crate.damage_mask.png')));
  const items = [];
  for (const st of ['intact', 'wrecked']) {
    items.push({ img: zoom(pane(shot(sceneGroups(G, `crate_${st}`))), 1), label: `${st}: base colour` });
    items.push({ img: zoom(pane(shot(sceneGroups(G, `crate_${st}`, { uvSet: { set: 1, image: aoImg } }))), 1), label: `${st}: AO on TEXCOORD_1` });
  }
  items.push({ img: pane(shot(sceneGroups(G, 'crate_intact', { mask: { set, image: mask, blend: 1 }, morph: 1 }))), label: `intact blend 1: mask on TEXCOORD_${set}` });
  items.push({ img: pane(zoom(aoImg, Math.max(1, Math.floor(160 / aoImg.width)))), label: 'baked AO map (in the glb)' });
  save('damage_ao_kept.png', packImages(items, { labels: true, checker: false, columns: 2 }));
}
{
  const dir = path.join(out, 'lod');
  e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), damage: { lods: [1, 0.5, 0.25] } });
  const G = readGLB(path.join(dir, 'crate.damage.glb')), man = JSON.parse(fs.readFileSync(path.join(dir, 'crate.damage.json'), 'utf8'));
  const mask = decodePNG(fs.readFileSync(path.join(dir, 'crate.damage_mask.png')));
  const fit = fitOf(sceneGroups(G, 'crate_intact_LOD0'));
  const items = [];
  for (const L of man.states[0].lods) for (const blend of [0, 0.5, 1]) items.push({ img: pane(shot(sceneGroups(G, L.node, { mask: { set: 1, image: mask, blend }, morph: blend }), 150, 'game', fit)), label: `LOD${L.level} (${L.triangles} tris) blend ${blend}` });
  save('damage_blend_lods.png', packImages(items, { labels: true, checker: false, columns: 3 }));
}

// ---------- 5. rigged damaged door opening (the glb clip sampled) ----------
{
  e.run('model_create', { name: 'locker', origin: 'bottom', parts: [
    { type: 'box', name: 'body', w: 26, h: 44, d: 18, texture: 'hull' },
    { type: 'box', name: 'door', parent: 'body', w: 22, h: 38, d: 2, at: [0, 3, 10], pivot: [-11, 0, 0], texture: 'plank' },
    { type: 'box', name: 'handle', parent: 'door', w: 2, h: 6, d: 2, at: [8, 20, 11.5], color: '#c8c0a0' },
  ], sockets: { handle: { part: 'door', at: [8, 20, 12] } } });
  e.run('model_animate', { name: 'locker', clip: 'open', keys: [{ t: 0, parts: { door: { rot: [0, 0, 0] } } }, { t: 1, parts: { door: { rot: [0, -110, 0] } } }] });
  e.run('model_damage', { name: 'locker', kind: 'crate', states: ['scuffed', 'damaged', 'wrecked'], seed: 5, roles: { keep: ['door', 'handle'] } });
  const dir = path.join(out, 'rig');
  e.run('model_export', { name: 'locker', path: path.join(dir, 'locker.glb') });
  const G = readGLB(path.join(dir, 'locker.damage.glb'));
  const fit = fitOf(sceneGroups(G, 'locker_intact')).concat([[-40, 0, 40], [30, 50, 40]].map((p) => p.map((v) => v / 32)));
  const items = [];
  for (const st of ['intact', 'damaged', 'wrecked']) for (const t of [0, 0.5, 1]) items.push({ img: pane(shot(sceneGroups(G, `locker_${st}`, { clip: 'open', t }), 150, 'game', fit)), label: `${st} open t=${t}` });
  save('rigged_door_open.png', packImages(items, { labels: true, checker: false, columns: 3 }));
}

// ---------- 6. open-mesh fracture ----------
{
  e.run('model_create', { name: 'duct', origin: 'bottom', parts: [{ type: 'tube', id: 'duct', from: [-24, 12, 0], to: [24, 12, 0], r: 8, sides: 10, caps: false, texture: 'hull' }, { type: 'box', id: 'base', w: 34, h: 4, d: 14, texture: 'plank' }] });
  const r = e.run('model_fracture', { name: 'duct', parts: [{ part: 'duct', pieces: 6, seed: 2 }] });
  const img = decodePNG(Buffer.from(r.image));
  save('open_mesh_fracture.png', packImages([{ img, label: `capless duct: closed by ${r.groups[0].closed?.method ?? '?'}, ${r.groups[0].chunks} watertight chunks` }], { labels: true, checker: false, columns: 1 }));
}

// ---------- characters ----------
const PAL = { head: '#d9a882', weapon: '#c3ccd4', shield: '#3c4450', arm: '#56603e', hand: '#2c2a2e', leg: '#3e4636', body: '#4c5640', foot: '#1f1c1c' };
const DARK = { head: '#8a5c46', weapon: '#5d6670', shield: '#1b1f26', arm: '#2c3320', hand: '#141216', leg: '#1f241a', body: '#262c1e', foot: '#0d0b0b' };
const kind = (k) => (k.startsWith('head') ? 'head' : k.startsWith('weapon') || k.startsWith('mag') ? 'weapon' : k === 'shield' ? 'shield' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');
function paint(skin, tint) {
  const cells = e.run('rig_info', { name: skin }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) {
    const [k] = k0.split(':');
    if (k === 'cape' || k.startsWith('gear')) continue;
    const c = kind(k), col = tint && c === 'body' ? tint : PAL[c];
    if (c === 'weapon') { const t = Math.max(2, Math.floor(h / 3)); cmds.push({ op: 'rect', x, y: y + Math.floor((h - t) / 2), w, h: t, color: col, outline: DARK[c] }); continue; }
    cmds.push({ op: 'rect', x, y, w, h, color: col, outline: DARK[c] });
    if (c === 'head') cmds.push({ op: 'rect', x: x + w - 4, y: y + 3, w: 3, h: 2, color: '#e8f0ff' });
  }
  e.run('draw', { canvas: `${skin}_parts`, layer: 'parts', commands: cmds });
}
const frameOf = (canvas, f) => { const d = e.get(canvas), fh = d.frameHeight || d.height, full = d.composite(); return { width: d.width, height: fh, data: full.slice(f * d.width * fh * 4, (f + 1) * d.width * fh * 4) }; };

// ---------- 7. gun disarm strip with the gun track ----------
{
  e.run('anim_skeleton', { name: 'gd', template: 'humanoid_hd', frame: [128, 192], weapon: { class: 'rifle' } });
  e.run('anim_melee', { skeleton: 'gd', disarm: 'take' });
  e.run('anim_skin', { name: 'gd_a', skeleton: 'gd' }); paint('gd_a');
  e.run('anim_skin', { name: 'gd_v', skeleton: 'gd' }); paint('gd_v', '#6a3c34');
  const bo = path.join(out, 'gd');
  e.run('anim_batch', { skins: ['gd_a'], clips: ['disarm_front_attacker'], views: ['side', 'front_side'], out: bo });
  const man = JSON.parse(fs.readFileSync(path.join(bo, 'manifest', 'characters.json'), 'utf8'));
  const spr = man.sprites.gd_a, anims = spr.anims;
  const items = [];
  for (const view of ['side', 'front_side']) {
    const r = e.run('anim_paired', { skin: 'gd_a', victim_skin: 'gd_v', pair: 'disarm_front', view, canvas: `gd_${view}` });
    const A = anims[`disarm_front_attacker_${view}`], tr = A.melee.transfer, bpad = spr.pad;
    const col = { victim: '#40c8ff', attacker: '#ffd040', world: '#ff6040' };
    const frames = [6, 9, 10, 11, 13, 17];
    for (const f of frames) {
      const q = tr.track[f], x = q.x - bpad[0] + r.pad[0], y = q.y - bpad[1] + r.pad[1];
      const im = frameOf(`gd_${view}`, f);
      // the gun's grip_main on the runtime weapon layer (ring) + a cross: owner colour (blue victim, yellow attacker, red world)
      const cmds = [{ op: 'ellipse', x: Math.round(x) - 5, y: Math.round(y) - 5, w: 11, h: 11, color: col[q.owner], fill: false }, { op: 'line', x1: Math.round(x) - 2, y1: Math.round(y), x2: Math.round(x) + 2, y2: Math.round(y), color: col[q.owner] }, { op: 'line', x1: Math.round(x), y1: Math.round(y) - 2, x2: Math.round(x), y2: Math.round(y) + 2, color: col[q.owner] }];
      e.run('create', { name: 'tmp_gd', width: im.width, height: im.height, overwrite: true });
      e.get('tmp_gd').layers[0].data.set(im.data);
      e.run('draw', { canvas: 'tmp_gd', commands: cmds });
      items.push({ img: pane(frameOf('tmp_gd', 0)), label: `${view} f${f} gun: ${q.owner} ${q.state}` });
    }
  }
  save('gun_disarm_strip.png', packImages(items, { labels: true, checker: false, columns: 6 }));
}

// ---------- 8. front / back paired checks; 9. two-proportion takedown ----------
{
  e.run('anim_skeleton', { name: 'pk', template: 'humanoid_hd', frame: [128, 192], proportions: { heavy: { width: 1.25, spine: 1.06, legs: 1.04 }, light: { width: 0.85, legs: 0.94, arms: 0.95 } } });
  e.run('anim_melee', { skeleton: 'pk', weapon: 'combat_knife' });
  e.run('anim_skin', { name: 'pk_a', skeleton: 'pk' }); paint('pk_a');
  e.run('anim_skin', { name: 'pk_v', skeleton: 'pk' }); paint('pk_v', '#6a3c34');
  const chk = e.run('anim_melee_check', { skeleton: 'pk', clips: ['takedown_rear_attacker', 'disarm_front_attacker'] }).clips;
  const items = [];
  for (const pair of ['disarm_front', 'takedown_rear']) for (const view of ['front', 'back']) {
    const c = chk[`${pair}_attacker`], r = e.run('anim_paired', { skin: 'pk_a', victim_skin: 'pk_v', pair, view, canvas: `pk_${pair}_${view}` });
    const f = pair === 'disarm_front' ? 8 : 16;
    items.push({ img: pane(frameOf(`pk_${pair}_${view}`, f)), label: `${pair} ${view} f${f}: 3D ${c.contact_by_view[view]} px, staged ${c.lateral_px[view]} px` });
  }
  save('front_back_check.png', packImages(items, { labels: true, checker: false, columns: 4 }));

  e.run('anim_skin', { name: 'pk_h', skeleton: 'pk', proportions: 'heavy' }); paint('pk_h');
  e.run('anim_skin', { name: 'pk_l', skeleton: 'pk', proportions: 'light' }); paint('pk_l', '#6a3c34');
  e.run('anim_skin', { name: 'pk_l2', skeleton: 'pk', proportions: 'light' }); paint('pk_l2');
  e.run('anim_skin', { name: 'pk_h2', skeleton: 'pk', proportions: 'heavy' }); paint('pk_h2', '#6a3c34');
  const two = [];
  for (const [a, v, lab] of [['pk_h', 'pk_l', 'heavy on light'], ['pk_l2', 'pk_h2', 'light on heavy']]) {
    const c = e.run('anim_melee_check', { skeleton: 'pk', skin: a, victim_skin: v, clips: ['takedown_rear_attacker'] }).clips.takedown_rear_attacker;
    for (const view of ['side', 'front_side']) {
      const r = e.run('anim_paired', { skin: a, victim_skin: v, pair: 'takedown_rear', view, canvas: `two_${a}_${view}` });
      for (const f of [10, 16]) two.push({ img: pane(frameOf(`two_${a}_${view}`, f)), label: `${lab} ${view} f${f}: refit ${r.refit_offset?.[0]}, contact ${c.contact_by_view[view]} px` });
    }
  }
  save('two_proportion_takedown.png', packImages(two, { labels: true, checker: false, columns: 4 }));
}
log('done');
