// art_model unwrap: one cohesive UV atlas per model (layout, bakes, canvas, check, projection, export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { buildModel } from '../src/model3d.js';
import { texResolver, modelDefs } from '../src/modelops.js';
import { anchorOf, applyUnwrap } from '../src/uvops.js';
import { normUnwrap, layoutOf, texelMap } from '../src/uvunwrap.js';
import { makeCamera, renderCamera } from '../src/raster3d.js';
import { bakeBase, bakeCourses } from '../src/uvbake.js';
import { validateGLB, parseGLB } from '../src/gltfcheck.js';
import { TOOLS } from '../src/mcp.js';
import { helpText } from '../src/docs.js';
import { UV_MODELS, uvCorpusEngine, drawTextures } from './fixtures/uv-corpus.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-uvt-'));
const defOf = (e, n) => modelDefs(e).get(n);
/** Plain build (no atlas swap) the way modelops builds it. */
const plainOf = (e, def) => { const tex = texResolver(e); return { ...buildModel(def, { tex, getModel: (n) => defOf(e, n) }), tex }; };
const layoutFor = (e, def, opt = {}) => { const b = plainOf(e, def), o = normUnwrap(opt); return { b, o, L: layoutOf(b.mesh, o, { anchor: anchorOf(def, b) }) }; };
/** Unwrapped build (atlas swap applied when the atlas matches). */
const uwBuilt = (e, name) => { const def = defOf(e, name), b = plainOf(e, def); applyUnwrap(e, def, b); return b; };
const lum = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const layer = (doc, n) => doc.layers.find((l) => l.name === n);
const texOf = (doc) => doc.composite({ exclude: ['emissive', 'height', 'metal', 'rough', 'masks', 'guide'] });
const sub = (a, b) => a.map((v, i) => v - b[i]);
/** Orthographic render at 1 screen px per model px (pixel centres = texel centres). */
function pixelShot(mesh, view) {
  const bb = mesh.bounds(), fit = [];
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) fit.push([x, y, z]);
  const probe = makeCamera(view, 1000, 1000, fit, { zoom: 1, margin: 0 });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of fit) { const [sx, sy] = probe.project(p); x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
  const IW = Math.ceil(x1 - x0) + 4, IH = Math.ceil(y1 - y0) + 4;
  return Buffer.from(renderCamera([...mesh.groups.values()].filter((g) => g.idx.length), makeCamera(view, IW, IH, fit, { zoom: 1, margin: 2 }), IW, IH, { bg: null }).data);
}
const dist = (a, b) => Math.hypot(...sub(a, b));
let shared = null;
const corpus = () => (shared ??= uvCorpusEngine(tmp()));

test('no unwrap = no change: builds, previews and exports of other models stay identical', () => {
  const e = uvCorpusEngine(tmp());
  const snap = () => {
    const b = plainOf(e, defOf(e, 'column_static'));
    const groups = [...b.mesh.groups].map(([k, g]) => [k, Array.from(g.uv)]);
    const img = e.run('model_preview', { name: 'column_static', views: ['front', 'game'], size: 128 }).image;
    const r = e.run('model_export', { name: 'column_static', path: path.join(tmp(), 'c.glb') });
    const info = e.run('model_info', { name: 'column_static' });
    return { groups, img: Buffer.from(img).toString('base64'), glb: fs.readFileSync(r.file).toString('base64'), info: { ...info, updated: 0 } };
  };
  const before = snap();
  e.run('model_unwrap', { name: 'column' });
  assert.deepEqual(snap(), before);
  assert.equal(defOf(e, 'column_static').unwrap, false); // the fixture opts out (unwrap:false); unwrapping another model never touches it
  assert.equal(e.run('model_info', { name: 'column_static' }).unwrap, undefined);
});

test('layout: deterministic hash and rects; a moved part changes the hash', () => {
  const e = corpus();
  const def = defOf(e, 'column');
  const a = layoutFor(e, def).L, b = layoutFor(e, def).L;
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.charts.map((c) => c.rect), b.charts.map((c) => c.rect));
  const moved = { ...def, parts: def.parts.map((p, i) => (i === 3 ? { ...p, at: [0, 55, 0] } : p)) };
  assert.notEqual(layoutFor(e, moved).L.hash, a.hash);
});

test('layout: zero stretch (every 2D edge = its 3D length) on column, arch and crate', () => {
  const e = corpus();
  for (const m of ['column', 'arch', 'crate']) {
    const { L } = layoutFor(e, defOf(e, m));
    for (const F of L.facets) {
      const X = L.x2[F.id];
      for (const tr of F.tris) for (let q = 0; q < 3; q++) {
        const i = tr[q], j = tr[(q + 1) % 3];
        const d2 = Math.hypot(X[i * 2] - X[j * 2], X[i * 2 + 1] - X[j * 2 + 1]), d3 = dist(F.pos[i], F.pos[j]);
        assert.ok(Math.abs(d2 - d3) < 1e-3, `${m} facet ${F.id}: 2D ${d2} vs 3D ${d3}`);
      }
    }
  }
});

test('charts: box = 6 islands at angle 46, 1 at 91; 12-segment cylinder side = 1 ring island, seam at the back', () => {
  const e = new Engine({ home: tmp() });
  drawTextures(e);
  e.run('model_create', { name: 'box', parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'brick' }] });
  assert.equal(layoutFor(e, defOf(e, 'box')).L.charts.length, 6);
  assert.equal(layoutFor(e, defOf(e, 'box'), { angle: 91 }).L.charts.length, 1);
  const { L } = layoutFor(e, defOf(corpus(), 'column'));
  const rings = L.charts.filter((c) => c.ring);
  assert.equal(rings.length, 1);
  const N = 12, r = 8;
  assert.equal(rings[0].ring.N, N);
  assert.ok(Math.abs(rings[0].ring.L - 2 * N * r * Math.sin(Math.PI / N)) < 1e-3, `ring L ${rings[0].ring.L}`);
  const inRing = new Set(rings[0].facets);
  const cuts = L.seams.filter((s) => s.cut && inRing.has(s.a.fi) && inRing.has(s.b.fi));
  assert.ok(cuts.length >= 1);
  const f = L.front, fl = Math.hypot(...f);
  for (const s of cuts) for (const fi of [s.a.fi, s.b.fi]) {
    const n = L.facets[fi].n;
    assert.ok((n[0] * f[0] + n[1] * f[1] + n[2] * f[2]) / fl < 0, 'ring seam faces away from the front');
  }
});

test('packing: no texel claimed twice, gutters >= pad, UVs in [0,1]', () => {
  const e = corpus();
  for (const m of ['column', 'arch', 'crate']) {
    const { L } = layoutFor(e, defOf(e, m));
    const claims = new Uint8Array(L.W * L.H), t = L.texel;
    for (const c of L.charts) for (const fi of c.facets) {
      const F = L.facets[fi], X = L.x2[fi];
      for (const tr of F.tris) {
        const P = tr.map((v) => [c.rect[0] + (X[v * 2] - c.o[0]) / t, c.rect[1] + (X[v * 2 + 1] - c.o[1]) / t]);
        const ar = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
        if (Math.abs(ar) < 1e-9) continue;
        for (let j = 0; j < L.H; j++) for (let i = 0; i < L.W; i++) {
          if (i < c.rect[0] - 1 || j < c.rect[1] - 1 || i > c.rect[0] + c.rect[2] || j > c.rect[1] + c.rect[3]) continue;
          const qx = i + 0.5, qy = j + 0.5;
          const l0 = ((P[1][0] - qx) * (P[2][1] - qy) - (P[2][0] - qx) * (P[1][1] - qy)) / ar;
          const l1 = ((P[2][0] - qx) * (P[0][1] - qy) - (P[0][0] - qx) * (P[2][1] - qy)) / ar;
          if (l0 > 1e-3 && l1 > 1e-3 && 1 - l0 - l1 > 1e-3) claims[j * L.W + i]++;
        }
      }
    }
    assert.ok(claims.every((v) => v <= 1), `${m}: a texel is claimed twice`);
    for (const a of L.charts) for (const b of L.charts) {
      if (a.id >= b.id) continue;
      const gx = Math.max(b.rect[0] - (a.rect[0] + a.rect[2]), a.rect[0] - (b.rect[0] + b.rect[2]));
      const gy = Math.max(b.rect[1] - (a.rect[1] + a.rect[3]), a.rect[1] - (b.rect[1] + b.rect[3]));
      assert.ok(Math.max(gx, gy) >= L.pad, `${m}: islands ${a.id} / ${b.id} gutter ${Math.max(gx, gy)}`);
    }
    for (const c of L.charts) assert.ok(c.rect[0] >= 0 && c.rect[1] >= 0 && c.rect[0] + c.rect[2] <= L.W && c.rect[1] + c.rect[3] <= L.H);
  }
  const e2 = uvCorpusEngine(tmp());
  e2.run('model_unwrap', { name: 'column' });
  const b = uwBuilt(e2, 'column');
  assert.ok(b.unwrap.canvas && !b.unwrap.stale);
  const g = [...b.mesh.groups.values()][0];
  assert.equal(g.tex.name, 'column_uv');
  assert.ok(g.uv.every((v) => v >= 0 && v <= 1));
});

test('world grid: island and uv tiling agree on axis-aligned boxes; cohesion:false is lossless', () => {
  const e = uvCorpusEngine(tmp());
  const { L } = layoutFor(e, defOf(e, 'boxes'));
  const M = texelMap(L);
  const a = bakeBase(L, M, { tile: 'island', fit: 'auto', fit_max: 0.13 }).color, b = bakeBase(L, M, { tile: 'uv', fit: 'auto', fit_max: 0.13 }).color;
  assert.ok(Buffer.from(a).equals(Buffer.from(b)));
  const VIEWS = ['front', 'side', 'top', 'back'];
  const before = VIEWS.map((v) => pixelShot(plainOf(e, defOf(e, 'boxes')).mesh, v));
  const r = e.run('model_unwrap', { name: 'boxes', unwrap: { cohesion: false } });
  assert.deepEqual(r.baked, ['base']);
  const ub = uwBuilt(e, 'boxes');
  assert.deepEqual([...ub.mesh.groups.values()].map((g) => g.tex.name), ['boxes_uv']);
  VIEWS.forEach((v, i) => assert.ok(pixelShot(ub.mesh, v).equals(before[i]), `unwrap {cohesion:false} renders ${v} identically`));
});

test('ring fit: shaft scaled to whole bricks; fit:false reports pattern_seam', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column', unwrap: { cohesion: false } });
  const meta = e.get('column_uv').meta.uv;
  const fit = Object.values(meta.baked.ring_fit || {})[0] ?? meta.baked.ring_fit?.[0];
  const scale = typeof fit === 'number' ? fit : fit?.scale;
  const L = 2 * 12 * 8 * Math.sin(Math.PI / 12);
  assert.ok(Math.abs(scale - 48 / L) < 1e-3, `ring_fit ${JSON.stringify(meta.baked.ring_fit)}`);
  assert.ok(!(meta.baked.pattern_seams || []).length);
  // head joints run evenly round the ring, across its seam (no half brick at the cut)
  const lay = layoutFor(e, defOf(e, 'column')).L, ring = lay.charts.find((c) => c.ring);
  const base = layer(e.get('column_uv'), 'base').data, W = lay.W, [rx, ry, rw, rh] = ring.rect;
  const dark = (i, j) => lum(base, (j * W + i) * 4) < 90;
  let rows = 0;
  for (let j = ry; j < ry + rh; j++) {
    const xs = [];
    for (let i = rx; i < rx + rw; i++) if (dark(i, j) && !dark(i - 1, j)) xs.push(i - rx);
    if (xs.length < 2 || xs.length > rw / 4) continue;
    const gaps = xs.slice(1).map((x, k) => x - xs[k]).concat(ring.ring.L / lay.texel - xs[xs.length - 1] + xs[0]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1.5, `row ${j - ry}: head joints at ${xs}, ring ${ring.ring.L}`);
    rows++;
  }
  assert.ok(rows > 4);
  e.run('model_unwrap', { name: 'column', unwrap: { cohesion: false, bake: { fit: false } } });
  const c = e.run('model_unwrap', { name: 'column', unwrap: { do: 'check' } }).cohesion;
  assert.ok(c.issues.some((i) => i.id === 'pattern_seam'), JSON.stringify(c.issues.map((i) => i.id)));
});

test('packing: max_size too small is an error naming max_size and texel', () => {
  const e = uvCorpusEngine(tmp());
  assert.throws(() => e.run('model_unwrap', { name: 'column', unwrap: { max_size: 64 } }), /max_size[\s\S]*texel|texel[\s\S]*max_size/);
  assert.equal(e.docs.has('column_uv'), false);
});

test('cohesion: contact darkening, worn edges, strict palette, deterministic bytes', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column' });
  const doc = e.get('column_uv'), def = defOf(e, 'column');
  const { L } = layoutFor(e, def), M = texelMap(L), A = L.anchor;
  const comp = texOf(doc), base = layer(doc, 'base').data;
  const capUnder = [], shaftTop = [], shaftMid = [], dk = (k) => lum(base, k * 4) - lum(comp, k * 4);
  let lighter = 0;
  for (let k = 0; k < L.W * L.H; k++) {
    const fi = M.facet[k];
    if (fi < 0) continue;
    const F = L.facets[fi], p = M.posAt(k).map((v, i) => v + A[i]);
    if (F.pi === 3 && F.n[1] < -0.9 && Math.hypot(p[0], p[2]) < 11) capUnder.push(dk(k));
    if (F.pi === 2 && Math.abs(F.n[1]) < 0.5) { if (p[1] > 52) shaftTop.push(dk(k)); else if (p[1] > 28 && p[1] < 36) shaftMid.push(dk(k)); }
    if (F.pi === 0 && Math.abs(F.n[1]) < 0.5 && p[1] > 5 && (Math.abs(p[0]) > 13 || Math.abs(p[2]) > 13) && lum(comp, k * 4) > lum(base, k * 4) + 4) lighter++;
  }
  // darkening (base - result luminance): contact zones darker than the free mid shaft
  assert.ok(mean(capUnder) > mean(shaftMid) + 5, `cap underside ${mean(capUnder)} vs shaft mid ${mean(shaftMid)}`);
  assert.ok(mean(shaftTop) > mean(shaftMid) + 5, `shaft top ${mean(shaftTop)} vs shaft mid ${mean(shaftMid)}`);
  assert.ok(lighter > 0, 'worn plinth top edges get highlight colours');
  // same input twice = same bytes
  const e2 = uvCorpusEngine(tmp());
  e2.run('model_unwrap', { name: 'column' });
  assert.ok(Buffer.from(layer(e2.get('column_uv'), 'cohesion').data).equals(Buffer.from(layer(doc, 'cohesion').data)));
  // strict palette adds no colour
  const pal = ['#8a8478', '#4a463e', '#2a2620', '#b0a898'];
  e.run('model_unwrap', { name: 'column', unwrap: { cohesion: { palette: pal } } });
  const coh = layer(e.get('column_uv'), 'cohesion').data, ok = new Set(pal.map((c) => c.slice(1)));
  for (let p = 0; p < coh.length; p += 4) if (coh[p + 3]) assert.ok(ok.has([coh[p], coh[p + 1], coh[p + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')), 'cohesion colour from the palette');
});

test('courses: snapped bed joints on the first / last rows of each part; head joints round the shaft = round(L / len)', () => {
  const e = corpus();
  const def = defOf(e, 'column'), { b, L } = layoutFor(e, def), M = texelMap(L), A = L.anchor;
  const spec = normUnwrap({ cohesion: { courses: { h: 8, len: 16 } } }).cohesion.courses;
  const { joint } = bakeCourses(L, M, spec, { partBounds: b.partBounds });
  for (const pi of [0, 1, 3]) {
    const bb = b.partBounds[pi], y0 = Math.round(bb.min[1]), y1 = Math.round(bb.max[1]);
    let rows = 0;
    for (let k = 0; k < L.W * L.H; k++) {
      const fi = M.facet[k];
      if (fi < 0 || L.facets[fi].pi !== pi || Math.abs(L.facets[fi].n[1]) > 0.5) continue;
      const y = Math.floor(M.posAt(k)[1] + A[1]);
      if (y === y0 || y === y1 - 1) { rows++; assert.equal(joint[k], 1, `part ${pi} row ${y}`); }
    }
    assert.ok(rows > 0);
  }
  const ring = L.charts.find((c) => c.ring);
  const [rx, ry, rw, rh] = ring.rect;
  let best = 0;
  for (let j = ry; j < ry + rh; j++) {
    let runs = 0, prev = false, beds = 0;
    for (let i = rx; i < rx + rw; i++) { const on = joint[j * L.W + i] === 1; if (on && !prev) runs++; prev = on; if (on) beds++; }
    if (beds < rw / 2) best = Math.max(best, runs);
  }
  assert.equal(best, Math.round(ring.ring.L / 16));
});

test('canvas: atlas layers, hidden data layers, meta, and the build never shows the guide', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column' });
  const doc = e.get('column_uv');
  for (const n of ['base', 'cohesion', 'paint', 'masks', 'guide']) assert.ok(layer(doc, n), n);
  assert.equal(layer(doc, 'masks').visible, false);
  assert.equal(layer(doc, 'guide').visible, false);
  assert.ok(doc.meta.uv.hash);
  assert.equal(doc.meta.build, false);
  assert.equal(doc.layers[doc.active].name, 'paint');
  const t0 = Buffer.from([...uwBuilt(e, 'column').mesh.groups.values()][0].tex.data);
  layer(doc, 'guide').visible = true;
  const t1 = Buffer.from([...uwBuilt(e, 'column').mesh.groups.values()][0].tex.data);
  assert.ok(t0.equals(t1), 'guide never reaches the texture');
});

test('paint preservation: paint moves with its island on re-layout; a changed painted island needs overwrite', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column', unwrap: { cohesion: false } });
  const isl = () => e.get('column_uv').meta.uv.islands;
  const cap = isl().find((i) => i.part === 'cap' && i.rect[2] >= 4 && i.rect[3] >= 4);
  const at = [cap.rect[0] + 1, cap.rect[1] + 1];
  e.run('draw', { canvas: 'column_uv', layer: 'paint', commands: [{ op: 'pixels', points: [[at[0], at[1], '#ff0000']] }] });
  const painted = () => { const now = isl().find((i) => i.key === cap.key), doc = e.get('column_uv'), p = ((now.rect[1] + 1) * doc.width + now.rect[0] + 1) * 4, d = layer(doc, 'paint').data; return [d[p], d[p + 1], d[p + 2], d[p + 3]]; };
  // a def changed outside update (file edit): the explicit layout step moves the paint and says so
  const def = defOf(e, 'column');
  modelDefs(e).set('column', { ...def, parts: def.parts.map((p) => (p.name === 'plinth' ? { ...p, w: 40, d: 40 } : p)) });
  const r = e.run('model_unwrap', { name: 'column', unwrap: { do: 'layout' } });
  assert.ok(isl().find((i) => i.key === cap.key), 'cap island kept');
  assert.deepEqual(painted(), [255, 0, 0, 255]);
  assert.ok(r.notes?.some((n) => /paint of 1 island/.test(n)), JSON.stringify(r.notes));
  // update re-lays the atlas itself (paint moves with its island)
  e.run('model_update', { name: 'column', set: { plinth: { w: 36, d: 36 } } });
  assert.deepEqual(painted(), [255, 0, 0, 255]);
  // the painted island changes: update keeps the atlas (stale, per-part textures) and says why
  const u = e.run('model_update', { name: 'column', set: { cap: { w: 26, d: 26 } } });
  assert.match(u.unwrap_note, /overwrite/);
  assert.throws(() => e.run('model_unwrap', { name: 'column' }), /overwrite/);
  e.run('model_unwrap', { name: 'column', unwrap: { overwrite: true } });
});

test('stale atlas: the build falls back to per-part textures and says so; check reports stale_atlas', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column' });
  // update re-bakes (never stale); a def changed outside update (file edit) is stale until the next preview / update
  const def = defOf(e, 'column');
  modelDefs(e).set('column', { ...def, parts: def.parts.map((p) => (p.name === 'shaft' ? { ...p, r: 7 } : p)) });
  const u = e.run('model_info', { name: 'column' });
  assert.match(u.cohesion, /stale/);
  assert.equal(u.unwrap.stale, true);
  const b = uwBuilt(e, 'column');
  assert.ok(![...b.mesh.groups.values()].some((g) => g.tex.name === 'column_uv'));
  const c = e.run('model_unwrap', { name: 'column', unwrap: { do: 'check' } }).cohesion;
  assert.ok(c.issues.some((i) => i.id === 'stale_atlas'));
});

test('export: one material for the atlas, validates, meta uv, bake_ao, lods; glass keeps its own material', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column' });
  const ex = (name, args = {}) => {
    const r = e.run('model_export', { name, path: path.join(tmp(), `${name}.glb`), ...args });
    const buf = fs.readFileSync(r.file), v = validateGLB(buf);
    assert.ok(v.ok, v.errors?.join('; '));
    return { r, ...parseGLB(buf), meta: JSON.parse(fs.readFileSync(r.meta, 'utf8')) };
  };
  const a = ex('column');
  assert.equal(a.json.materials.length, 1);
  assert.equal(a.json.images.length, 1);
  assert.ok(a.meta.uv?.canvas === 'column_uv');
  assert.ok(a.json.asset.extras?.uv?.hash);
  assert.deepEqual(a.r.unwrap.canvas, 'column_uv');
  const ao = ex('column', { bake_ao: true });
  assert.ok(ao.json.meshes.some((m) => m.primitives.some((p) => p.attributes.TEXCOORD_1 !== undefined)));
  assert.ok(ao.r.unwrap_note);
  ex('column', { lods: [1, 0.5] });
  e.run('model_unwrap', { name: 'hull' });
  const h = ex('hull');
  assert.ok(h.json.materials.length >= 2, 'glass canopy keeps its material');
});

test('rig: named parts export nodes with atlas UVs; a pose preview renders', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'column' });
  e.run('model_pose', { name: 'column', pose: 'tilt', parts: { cap: { rot: [0, 0, 8] } } });
  const r = e.run('model_export', { name: 'column', path: path.join(tmp(), 'c.glb') });
  const { json } = parseGLB(fs.readFileSync(r.file));
  assert.ok(json.nodes.length > 1);
  assert.equal(json.images.length, 1);
  assert.ok(e.run('model_preview', { name: 'column', pose: 'tilt', size: 96 }).image.length > 100);
});

test('damage: a damage state preview of an unwrapped model works', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'crate' });
  e.run('model_damage', { name: 'crate', kind: 'crate', seed: 7, states: ['scuffed', 'wrecked'] });
  assert.ok(e.run('model_preview', { name: 'crate', damage: 'wrecked', size: 64 }).image.length > 100);
});

test('projection: paint in a front view lands on front-facing atlas texels only', () => {
  const e = uvCorpusEngine(tmp());
  e.run('model_unwrap', { name: 'boxes', unwrap: { cohesion: false } });
  const v = e.run('model_unwrap', { name: 'boxes', unwrap: { do: 'view', view: 'front' } });
  const vd = e.get(v.canvas);
  e.run('draw', { canvas: v.canvas, layer: 'paint', commands: [{ op: 'pixels', points: [[Math.floor(vd.width / 2), Math.floor(vd.height * 0.75), '#ff00ff']] }] });
  const before = Uint8ClampedArray.from(layer(e.get('boxes_uv'), 'paint').data);
  const r = e.run('model_unwrap', { name: 'boxes', unwrap: { do: 'project', from: v.canvas } });
  assert.ok(r.projected >= 1);
  const { L } = layoutFor(e, defOf(e, 'boxes')), M = texelMap(L);
  const after = layer(e.get('boxes_uv'), 'paint').data;
  let changed = 0;
  for (let k = 0; k < L.W * L.H; k++) {
    if (after[k * 4 + 3] === before[k * 4 + 3]) continue;
    const fi = M.facet[k];
    if (fi < 0) continue; // gutter
    changed++;
    assert.ok(L.facets[fi].n[2] > 0.9, 'only front faces change');
  }
  assert.equal(changed, r.projected);
  assert.equal(r.islands.length, 1);
});

test('check: column before / after unwrap, a single box has no false alarms, tile:false next to tiled = texel_density', () => {
  const e = uvCorpusEngine(tmp());
  const before = e.run('model_unwrap', { name: 'column', unwrap: { do: 'check' } }).cohesion;
  assert.equal(before.pass, false);
  for (const id of ['front_seam', 'course_cut', 'no_contact_shading']) assert.ok(before.issues.some((i) => i.id === id), id);
  e.run('model_update', { name: 'column', set: { plinth: { texture: 'stone' }, base: { texture: 'stone' }, shaft: { texture: 'stone' }, cap: { texture: 'stone' } } });
  e.run('model_unwrap', { name: 'column', unwrap: { cohesion: { courses: { h: 8, len: 16 } } } });
  assert.equal(e.run('model_unwrap', { name: 'column', unwrap: { do: 'check' } }).cohesion.pass, true);
  e.run('model_create', { name: 'one', unwrap: false, parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'brick' }] });
  assert.deepEqual(e.run('model_unwrap', { name: 'one', unwrap: { do: 'check' } }).cohesion.issues.filter((i) => i.id !== 'unwrap_off'), []);
  // the default (unwrapped) single box: only info notes (atlas fill), never an error or warning
  e.run('model_create', { name: 'one_uv', parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'brick' }] });
  assert.deepEqual(e.run('model_unwrap', { name: 'one_uv', unwrap: { do: 'check' } }).cohesion.issues.filter((i) => i.level !== 'info'), []);
  e.run('model_create', { name: 'mixed', unwrap: false, parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'brick' }, { type: 'box', w: 48, h: 16, d: 16, at: [32, 0, 0], texture: 'brick', tile: false }] });
  assert.ok(e.run('model_unwrap', { name: 'mixed', unwrap: { do: 'check' } }).cohesion.issues.some((i) => i.id === 'texel_density'));
});

test('refusals: skinned / morphs / unknown option / max_size over the limit', () => {
  const e = uvCorpusEngine(tmp());
  defOf(e, 'boxes').skeleton = { bones: [] };
  assert.throws(() => e.run('model_unwrap', { name: 'boxes' }), /skinned/);
  delete defOf(e, 'boxes').skeleton;
  defOf(e, 'boxes').morphs = { x: {} };
  assert.throws(() => e.run('model_unwrap', { name: 'boxes' }), /morphs/);
  delete defOf(e, 'boxes').morphs;
  assert.throws(() => e.run('model_unwrap', { name: 'boxes', unwrap: { texels: 2 } }), /unknown option "texels"/);
  assert.throws(() => e.run('model_unwrap', { name: 'boxes', unwrap: { max_size: 4096 } }), /max_size 4096/);
  assert.throws(() => e.run('model_create', { name: 'bad', unwrap: { nope: 1 }, parts: [{ type: 'box' }] }), /unknown option/);
});

test('MCP: art_model exposes unwrap; help topic 3d and materials document it', () => {
  const t = TOOLS.find((x) => x.name === 'art_model');
  assert.ok(t.inputSchema.properties.action.enum.includes('unwrap'));
  assert.ok(t.inputSchema.properties.unwrap);
  assert.match(helpText({ topic: '3d' }), /unwrap/);
  assert.match(helpText({ topic: 'materials' }), /UNWRAP ATLAS/);
});

test('acceptance renders: after differs from before and passes the check (AA_UV_RENDERS=<dir> writes PNGs)', () => {
  const e = uvCorpusEngine(tmp());
  const dir = process.env.AA_UV_RENDERS;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  for (const m of ['column', 'arch', 'crate', 'hull']) {
    const b = e.run('model_preview', { name: m, views: ['game', 'front', 'side'], size: 384 }).image;
    const r = e.run('model_unwrap', { name: m });
    const a = e.run('model_preview', { name: m, views: ['game', 'front', 'side'], size: 384 }).image;
    assert.ok(!Buffer.from(a).equals(Buffer.from(b)), `${m} after differs`);
    assert.equal(r.cohesion.pass, true, `${m}: ${JSON.stringify(r.cohesion.issues)}`);
    if (dir) { fs.writeFileSync(path.join(dir, `${m}_before.png`), b); fs.writeFileSync(path.join(dir, `${m}_after.png`), a); fs.writeFileSync(path.join(dir, `${m}_uv.png`), r.image); }
  }
  assert.ok(UV_MODELS.column);
});

// ---------- unwrap by default (new models) ----------
const fresh = () => { const e = new Engine({ home: tmp() }); drawTextures(e); return e; };
const imgOf = (e, name) => Buffer.from(e.run('model_preview', { name, views: ['front', 'game'], size: 128 }).image).toString('base64');

test('default: create stores the default unwrap and bakes the atlas; reply names it', () => {
  const e = fresh();
  const r = e.run('model_create', { name: 'column', ...UV_MODELS.column });
  const def = defOf(e, 'column');
  assert.deepEqual(def.unwrap, { cohesion: { ao: { strength: 1 }, contact: { strength: 1 }, edges: { strength: 1, wear: 0.65 }, grime: { strength: 0.5 }, courses: false } });
  assert.equal(r.unwrap.canvas, 'column_uv');
  assert.deepEqual(r.materials, ['column_uv']);
  assert.equal(r.unwrap_note, undefined);
  assert.match(r.next, /column_uv/);
  assert.ok(e.get('column_uv').meta.uv);
  assert.equal(e.run('model_unwrap', { name: 'column', unwrap: { do: 'check' } }).cohesion.pass, true);
});

test('opt-out: unwrap:false is byte-identical to a model saved before the default (no unwrap key)', () => {
  const e = fresh();
  e.run('model_create', { name: 'off', unwrap: false, ...UV_MODELS.crate });
  e.run('model_create', { name: 'old', unwrap: false, ...UV_MODELS.crate });
  delete defOf(e, 'old').unwrap; // a def saved before new models were unwrapped
  assert.equal(defOf(e, 'off').unwrap, false);
  assert.equal(e.docs.has('off_uv'), false);
  assert.equal(imgOf(e, 'off'), imgOf(e, 'old'));
  assert.deepEqual(e.run('model_info', { name: 'off' }).materials, e.run('model_info', { name: 'old' }).materials);
  const ga = parseGLB(fs.readFileSync(e.run('model_export', { name: 'off', path: path.join(tmp(), 'a.glb') }).file));
  const gb = parseGLB(fs.readFileSync(e.run('model_export', { name: 'old', path: path.join(tmp(), 'b.glb') }).file));
  assert.equal(JSON.stringify(ga.json.materials), JSON.stringify(gb.json.materials));
  assert.equal(JSON.stringify(ga.json.accessors), JSON.stringify(gb.json.accessors));
});

test('existing models: update keeps them per-part and never adds unwrap; unwrap:true on update converts one', () => {
  const e = fresh();
  e.run('model_create', { name: 'old', unwrap: false, ...UV_MODELS.column });
  delete defOf(e, 'old').unwrap;
  const r = e.run('model_update', { name: 'old', set: { cap: { h: 8 } } });
  assert.equal(defOf(e, 'old').unwrap, undefined);
  assert.equal(r.unwrap, undefined);
  assert.deepEqual(r.materials, ['brick']);
  assert.match(r.cohesion, /art_model unwrap/); // the one-line suggestion
  const c = e.run('model_update', { name: 'old', unwrap: true });
  assert.equal(c.unwrap.canvas, 'old_uv');
  assert.deepEqual(c.materials, ['old_uv']);
});

test('default: update / texture edits re-bake the atlas (paint kept); preview never shows a stale atlas', () => {
  const e = fresh();
  e.run('model_create', { name: 'column', ...UV_MODELS.column });
  const uv = () => e.get('column_uv').meta.uv, h0 = uv().hash, r0 = uv().islands[0].rect;
  e.run('draw', { canvas: 'column_uv', layer: 'paint', commands: [{ op: 'pixels', points: [[r0[0] + 1, r0[1] + 1, '#ff0000']] }] });
  const r = e.run('model_update', { name: 'column', set: { cap: { w: 26, d: 26 } } });
  assert.equal(r.unwrap.canvas, 'column_uv');
  assert.notEqual(uv().hash, h0);
  assert.equal(r.cohesion, undefined, 'not stale');
  assert.ok(layer(e.get('column_uv'), 'paint').data.some((v, i) => i % 4 === 3 && v), 'paint kept');
  const src = uv().src;
  e.run('draw', { canvas: 'brick', commands: [{ op: 'pixels', points: [[3, 3, '#ffffff']] }] });
  e.run('model_preview', { name: 'column' });
  assert.notEqual(uv().src, src, 'texture edit re-baked on preview');
  assert.equal(uwBuilt(e, 'column').unwrap.stale, undefined);
});

test('fallbacks: morphs, skinned, layouts and big models keep per-part textures with one note; check reports unwrap_off', () => {
  const e = fresh();
  const m = e.run('model_create', { name: 'morph', parts: [{ type: 'box', w: 8, h: 8, d: 8, texture: 'brick' }], morphs: { a: { set: { 0: { w: 10 } } } } });
  assert.match(m.unwrap_note, /morphs/);
  assert.equal(defOf(e, 'morph').unwrap, false);
  e.run('model_create', { name: 'piece', ...UV_MODELS.boxes });
  const lay = e.run('model_create', { name: 'lay', parts: [{ type: 'model', model: 'piece' }, { type: 'model', model: 'piece', at: [64, 0, 0] }] });
  assert.match(lay.unwrap_note, /layout/);
  const big = e.run('model_create', { name: 'g', template: 'gunship' });
  assert.match(big.unwrap_note, /triangles/);
  assert.equal(e.docs.has('g_uv'), false);
  const chk = e.run('model_unwrap', { name: 'g', unwrap: { do: 'check' } }).cohesion.issues.find((i) => i.id === 'unwrap_off');
  assert.match(chk.detail, /triangles/);
  // skinned: the skeleton reply says so once; check reports it
  e.run('model_create', { name: 'sk', parts: [{ type: 'box', name: 'body', w: 8, h: 24, d: 8, texture: 'brick' }, { type: 'box', name: 'head', parent: 'body', w: 8, h: 8, d: 8, at: [0, 24, 0], texture: 'brick' }] });
  const s = e.run('model_skeleton', { name: 'sk', skeleton: { from_parts: true } });
  assert.match(s.unwrap_note, /skinned/);
  const sc = e.run('model_unwrap', { name: 'sk', unwrap: { do: 'check' } }).cohesion.issues.find((i) => i.id === 'unwrap_off');
  assert.match(sc.detail, /skinned/);
});

test('cohesion shading: clean bands, few orphan texels (no per-texel dither noise)', () => {
  const e = uvCorpusEngine(tmp());
  for (const m of ['column', 'crate']) {
    e.run('model_unwrap', { name: m });
    const d = e.get(`${m}_uv`), W = d.width, H = d.height, coh = layer(d, 'cohesion').data, comp = texOf(d);
    const id = new Int32Array(W * H).fill(-1);
    for (const i of d.meta.uv.islands) for (let y = i.rect[1]; y < i.rect[1] + i.rect[3]; y++) for (let x = i.rect[0]; x < i.rect[0] + i.rect[2]; x++) id[y * W + x] = i.id;
    const col = (k) => (comp[k * 4] << 16) | (comp[k * 4 + 1] << 8) | comp[k * 4 + 2];
    let orph = 0, written = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (id[k] < 0 || !coh[k * 4 + 3]) continue;
      written++;
      let kin = false, nbs = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy, q = Y * W + X; if ((!dx && !dy) || X < 0 || Y < 0 || X >= W || Y >= H || id[q] !== id[k]) continue; nbs++; if (col(q) === col(k)) kin = true; }
      if (!kin && nbs >= 3) orph++;
    }
    assert.ok(written > 1000 && orph / written < 0.05, `${m}: ${orph} orphans of ${written}`);
  }
});

test('performance: default create of a small model stays fast; ship templates fall back before any layout', () => {
  const e = fresh();
  let t = performance.now();
  e.run('model_create', { name: 'column', ...UV_MODELS.column });
  assert.ok(performance.now() - t < 15000);
  t = performance.now();
  e.run('model_preview', { name: 'column' });
  assert.ok(performance.now() - t < 5000);
  t = performance.now();
  e.run('model_create', { name: 'f', template: 'fighter' });
  assert.equal(defOf(e, 'f').unwrap, false);
  assert.ok(performance.now() - t < 20000);
});

test('default path golden: create bakes the same atlas (layout hash + base / cohesion RGBA), recorded on this branch', async () => {
  const crypto = await import('node:crypto');
  const e = fresh();
  // recorded with the clean-band cohesion shading (feat/model-uv, default unwrap); a change here changes every new model
  const want = { column: ['4fcf1dab', '0f0d789135527041'], crate: ['2ab35b89', '741ff9217d9a3116'] };
  for (const [m, [hash, rgba]] of Object.entries(want)) {
    e.run('model_create', { name: m, ...UV_MODELS[m] });
    const d = e.get(`${m}_uv`), h = crypto.createHash('sha256');
    for (const n of ['base', 'cohesion']) h.update(layer(d, n).data);
    assert.deepEqual([d.meta.uv.hash, h.digest('hex').slice(0, 16)], [hash, rgba], m);
  }
});
