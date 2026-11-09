// art_model unwrap: one cohesive UV atlas canvas (<model>_uv) for the whole model. Layout (uvunwrap),
// bakes (uvbake), cohesion check (uvcheck), canvas I/O with paint preservation, projection painting
// from an orthographic view, and the build() hook that swaps the unwrapped faces onto the atlas.
import { Doc, Layer } from './doc.js';
import { normUnwrap, storedUnwrap, layoutOf, texelMap, regroup, facetsOf, geoKey, dilate, fnv } from './uvunwrap.js';
import { bakeBase, bakeMasks, bakeCourses, cohesionPalette, composeCohesion, guideImage } from './uvbake.js';
import { cohesionCheck, partLabel, texturedParts } from './uvcheck.js';
import { renderViews, makeCamera, renderCamera, resolveView } from './raster3d.js';
import { packImages } from './sheet.js';
import { encodePNG } from './png.js';
import { bvhOf } from './bake.js';
import { blendOver } from './color.js';

const LAYERS = ['base', 'cohesion', 'paint', 'emissive', 'metal', 'rough', 'height', 'masks', 'guide'];
const HIDDEN = new Set(['metal', 'rough', 'height', 'masks', 'guide']);
const groupsOf = (mesh) => [...mesh.groups.values()].filter((g) => g.idx.length);

/** Pattern-space anchor of a build: origin shift + uv_origin (the world-UV lattice origin). */
export function anchorOf(def, built) {
  const grid = Number(def.grid ?? 32), uo = def.uv_origin ?? [grid / 2, 0, grid / 2];
  return [0, 1, 2].map((k) => Number(uo[k] ?? 0) + (built.shift?.[k] ?? 0));
}
/** Part index set from a list of indices / names (unknown names throw). */
function partSet(def, list, what) {
  if (!list) return null;
  const s = new Set();
  for (const k of list) {
    if (Number.isInteger(k)) { s.add(k); continue; }
    const i = (def.parts || []).findIndex((p) => p && (p.name === k || p.id === k));
    if (i < 0) throw new Error(`unwrap ${what}: no part ${JSON.stringify(k)}`);
    s.add(i);
  }
  return s;
}
/** Which faces go into the atlas (and why the others stay on their own material). */
function includer(def, o) {
  const only = partSet(def, o.parts, 'parts'), ex = partSet(def, o.exclude, 'exclude');
  const why = (g, f) => {
    if (g.overlay) return 'overlay';
    if (g.tex.material) return g.tex.material.glass ? 'glass' : g.tex.material.blend ? 'opacity' : 'double_sided';
    if (g.tex.v2) return 'materials v2';
    if (g.tex.decal) return 'decal';
    if ((only && !only.has(f.pi)) || (ex && ex.has(f.pi))) return 'excluded';
    return null;
  };
  const include = (g, f) => !why(g, f);
  include.why = why;
  return include;
}
/** Layout of a plain build, cached per model on the engine by geometry + options. */
function cachedLayout(engine, def, built, o) {
  const anchor = anchorOf(def, built), include = includer(def, o);
  const topo = facetsOf(built.mesh, anchor, include);
  if (!topo.facets.length) throw new Error('unwrap: no faces to unwrap (every part is excluded, glass / opacity, or materials v2)');
  const geo = geoKey(topo, o) + anchor.join(',');
  engine._uv ??= new Map();
  const c = engine._uv.get(def.name);
  if (c && c.geo === geo) return { ...c.layout, facets: topo.facets, edges: topo.edges, include };
  const L = layoutOf(built.mesh, o, { anchor, include, topo });
  engine._uv.set(def.name, { geo, layout: L });
  return { ...L, include };
}
const canvasName = (def, o) => o.canvas ?? `${def.name}_uv`;
/** Which part textures the atlas was baked from (a part's texture swapped = stale atlas). */
const srcKey = (L) => fnv(L.facets.map((F) => F.src.tex.key).join('|'));

/** Merge an action's unwrap spec over the stored one (action keys never stored). */
function mergedSpec(def, a) {
  const stored = def.unwrap && typeof def.unwrap === 'object' ? def.unwrap : {};
  if (a === undefined || a === null || a === true) return { ...stored };
  if (typeof a !== 'object' || Array.isArray(a)) return a; // normUnwrap reports it
  return { ...stored, ...a };
}

/**
 * build() hook: swap the unwrapped faces onto the atlas canvas when it matches the geometry.
 * Missing or stale atlas: the model keeps its per-part textures and built.unwrap says why.
 */
export function applyUnwrap(engine, def, built, { isSkinned } = {}) {
  if (!def.unwrap || (isSkinned && isSkinned(def)) || def.morphs) return;
  let o;
  try { o = normUnwrap(def.unwrap); } catch (e) { built.unwrap = { error: e.message }; return; }
  const name = canvasName(def, o), doc = engine.docs.get(name);
  if (!doc || !doc.meta?.uv) { built.unwrap = { missing: true, canvas: name }; return; }
  let L;
  try { L = cachedLayout(engine, def, built, o); } catch (e) { built.unwrap = { error: e.message, canvas: name }; return; }
  if (doc.meta.uv.hash !== L.hash || doc.width !== L.W || doc.height !== L.H) { built.unwrap = { stale: true, canvas: name }; return; }
  if (doc.meta.uv.src && doc.meta.uv.src !== srcKey(L)) { built.unwrap = { stale: true, canvas: name, textures: true }; return; }
  const tex = built.tex({ canvas: name });
  regroup(built.mesh, L, tex);
  built.unwrap = { canvas: name, size: [L.W, L.H], texel: L.texel, islands: L.charts.length, hash: L.hash, fill: L.fill, baked: doc.meta.uv.baked || {} };
}

/** Short unwrap / cohesion fields for summary() (create / update / info replies). */
export function unwrapSummary(def, built) {
  const out = {};
  const u = built.unwrap;
  if (def.unwrap && u) {
    out.unwrap = u.canvas && !u.stale && !u.missing && !u.error ? { canvas: u.canvas, size: u.size, texel_px: u.texel, islands: u.islands, fill: u.fill, hash: u.hash } : { canvas: u.canvas, ...(u.stale ? { stale: true } : {}), ...(u.missing ? { missing: true } : {}), ...(u.error ? { error: u.error } : {}) };
  }
  if (u && (u.stale || u.missing)) { out.cohesion = `atlas ${u.canvas} is ${u.stale ? `stale${u.textures ? ' (part textures changed)' : ''}` : 'missing'}: art_model unwrap {name:"${def.name}"}`; return out; }
  if (texturedParts(built).size < 2) return out;
  const r = cohesionCheck(def, built, { anchor: anchorOf(def, built), full: false });
  if (!r.pass) out.cohesion = `detached look: ${r.issues.filter((x) => x.level === 'error').map((x) => x.id).join(', ')}; art_model unwrap {name:"${def.name}"} bakes one cohesive texture (check: unwrap:{do:"check"})`;
  return out;
}

// ---------- canvas I/O ----------
function layerOf(doc, name) { return doc.layers.find((l) => l.name === name) || null; }
/** Find or insert a layer at its canonical place (hidden data layers stay hidden). */
function ensureLayer(doc, name) {
  let l = layerOf(doc, name);
  if (l) return l;
  l = new Layer(name, doc.width, doc.height);
  if (HIDDEN.has(name)) l.visible = false;
  const rank = LAYERS.indexOf(name);
  let at = doc.layers.length;
  for (let i = 0; i < doc.layers.length; i++) { const r = LAYERS.indexOf(doc.layers[i].name); if (r > rank) { at = i; break; } }
  doc.layers.splice(at, 0, l);
  if (doc.active >= at) doc.active++;
  return l;
}
const setLayer = (doc, name, data) => { const l = ensureLayer(doc, name); l.data.set(data); return l; };
const clearLayer = (doc, name) => { const l = layerOf(doc, name); if (l) l.data.fill(0); };
const islandTable = (def, L) => L.charts.slice(0, 4096).map((c) => ({ id: c.id, key: c.key, rect: c.rect, part: partLabel(def, c.pi), pi: c.pi ?? null, role: c.role, facets: c.facets.length, ring: !!c.ring, area: Math.round(c.area) }));

/** Copy a rect of one RGBA buffer into another (same size rect). */
function blit(src, SW, sr, dst, DW, dr) {
  for (let y = 0; y < sr[3]; y++) dst.set(src.subarray(((sr[1] + y) * SW + sr[0]) * 4, ((sr[1] + y) * SW + sr[0] + sr[2]) * 4), ((dr[1] + y) * DW + dr[0]) * 4);
}
const rectPainted = (data, W, r) => { for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) if (data[(y * W + x) * 4 + 3]) return true; return false; };

/**
 * Create the atlas canvas, or move an existing one to a new layout: paint (and the other layers)
 * of every island whose key still exists is copied to its new rect; painted islands that no longer
 * exist need overwrite:true. -> {doc, created, migrated}
 */
function prepareCanvas(engine, def, L, o, source) {
  const name = canvasName(def, o);
  let doc = engine.docs.get(name);
  const meta = () => ({ model: def.name, v: 1, hash: L.hash, size: [L.W, L.H], texel: L.texel, pad: L.pad, method: L.method, anchor: L.anchor.map((v) => +v.toFixed(4)), islands: islandTable(def, L) });
  if (!doc) {
    doc = new Doc({ name, width: L.W, height: L.H });
    doc.layers[0].name = 'base';
    for (const n of ['cohesion', 'paint', 'masks', 'guide']) ensureLayer(doc, n);
    doc.active = doc.layers.findIndex((l) => l.name === 'paint');
    if (def.project) doc.project = def.project;
    doc.meta = { uv: { ...meta(), baked: {} }, build: false };
    engine.attach(doc);
    return { doc, created: true, migrated: 0 };
  }
  if (!doc.meta?.uv && !o.overwrite) throw new Error(`unwrap: canvas "${name}" exists and is not an atlas (overwrite:true replaces it, or unwrap:{canvas:"<other>"})`);
  doc.checkpoint('unwrap layout');
  const old = doc.meta?.uv;
  if (old && old.hash === L.hash && doc.width === L.W && doc.height === L.H) { doc.meta = { ...doc.meta, uv: { ...old, ...meta(), baked: old.baked || {} }, build: false }; return { doc, created: false, migrated: 0 }; }
  // layout changed: carry islands that still exist (same key and size) to their new rects
  const oldIs = old ? old.islands || [] : [];
  const byKey = new Map(oldIs.map((i) => [i.key, i]));
  const paintL = layerOf(doc, 'paint');
  const matched = new Set();
  for (const c of L.charts) { const oi = byKey.get(c.key); if (oi && oi.rect[2] === c.rect[2] && oi.rect[3] === c.rect[3]) matched.add(oi.id); }
  const lost = paintL ? oldIs.filter((i) => !matched.has(i.id) && i.rect[0] + i.rect[2] <= doc.width && i.rect[1] + i.rect[3] <= doc.height && rectPainted(paintL.data, doc.width, i.rect)) : [];
  if (lost.length && !o.overwrite) throw new Error(`unwrap: the model changed; ${lost.length} painted islands (${[...new Set(lost.map((i) => i.part))].join(', ')}) no longer exist. overwrite:true drops their paint (the rest is kept)`);
  const OW = doc.width, OH = doc.height, prev = doc.layers.map((l) => ({ name: l.name, data: l.data }));
  doc.width = L.W; doc.height = L.H;
  let migrated = 0;
  for (const l of doc.layers) {
    const src = prev.find((p) => p.name === l.name).data;
    l.data = new Uint8ClampedArray(L.W * L.H * 4);
    if (!old || l.name === 'base' || l.name === 'guide' || l.name === 'masks') continue; // re-baked
    for (const c of L.charts) {
      const oi = byKey.get(c.key);
      if (!oi || !matched.has(oi.id)) continue;
      const pr = c.rect, or = oi.rect;
      if (or[0] - L.pad < 0 || or[1] - L.pad < 0 || or[0] + or[2] + L.pad > OW || or[1] + or[3] + L.pad > OH) { blit(src, OW, or, l.data, L.W, pr); continue; }
      blit(src, OW, [or[0] - L.pad, or[1] - L.pad, or[2] + 2 * L.pad, or[3] + 2 * L.pad], l.data, L.W, [pr[0] - L.pad, pr[1] - L.pad, pr[2] + 2 * L.pad, pr[3] + 2 * L.pad]);
      if (l.name === 'paint' && rectPainted(src, OW, or)) migrated++;
    }
  }
  doc.meta = { ...(doc.meta || {}), uv: { ...meta(), baked: {} }, build: false };
  return { doc, created: false, migrated, relaid: true };
}

// ---------- bake steps ----------
function stepBake(engine, def, L, M, o, doc, built) {
  const top = o.bake.top ? built.tex(o.bake.top) : null;
  const r = bakeBase(L, M, { ...o.bake, top });
  setLayer(doc, 'base', r.color);
  for (const k of ['emissive', 'metal', 'rough', 'height']) { if (r[k]) setLayer(doc, k, r[k]); else if (layerOf(doc, k) && layerOf(doc, k).data.some((v) => v)) clearLayer(doc, k); }
  doc.meta.uv.baked = { ...(doc.meta.uv.baked || {}), base: true, ring_fit: r.ring_fit, pattern_seams: r.pattern_seams };
  doc.meta.uv.src = srcKey(L);
  return r;
}
function stepCohesion(engine, def, L, M, o, doc, built) {
  const coh = o.cohesion;
  if (!coh) {
    clearLayer(doc, 'cohesion'); clearLayer(doc, 'masks');
    doc.meta.uv.baked = { ...(doc.meta.uv.baked || {}), cohesion: false, edges: false, courses: false };
    return null;
  }
  const base = layerOf(doc, 'base').data;
  // per-node occluders only when parts can move (poses / clips): a static named-part prop bakes contact across parts
  const moves = !!(def.poses && Object.keys(def.poses).length) || !!(def.clips && Object.keys(def.clips).length);
  const masks = bakeMasks(L, M, built.mesh, { cohesion: coh, perNode: !!built.layout && moves && !coh.across_nodes });
  let courses = null, coursed = false;
  if (coh.courses) {
    const only = partSet(def, coh.courses.parts, 'courses.parts');
    courses = bakeCourses(L, M, coh.courses, { partBounds: built.partBounds, partOk: (pi) => !only || only.has(pi), seed: coh.seed });
    coursed = only ? [...only] : true;
  }
  const overlays = coh.overlays.map((x) => ({ ...x, tex: built.tex(x.texture) }));
  const extra = [];
  for (const ov of overlays) { const d = ov.tex.data; for (let p = 0; p < d.length; p += 4) if (d[p + 3] >= 128) extra.push([d[p], d[p + 1], d[p + 2]]); }
  const proj = def.project && engine.projects?.get(def.project);
  const palette = cohesionPalette(base, coh, { project: proj?.palette, canvas: doc.fullPalette, extra });
  const out = composeCohesion(L, M, base, masks, courses, coh, palette, { overlays });
  setLayer(doc, 'cohesion', out);
  setLayer(doc, 'masks', masks.masks);
  doc.meta.uv.baked = { ...(doc.meta.uv.baked || {}), cohesion: true, edges: !!coh.edges, courses: coursed, ao_step: masks.ao_step, passes: ['ao', 'contact', 'edges', 'grime'].filter((k) => coh[k]).concat(coh.courses ? ['courses'] : [], coh.overlays.length ? ['overlays'] : []), colors: palette.length };
  return { masks, palette };
}
function stepGuide(def, L, M, doc) {
  setLayer(doc, 'guide', guideImage(L, M, { names: (def.parts || []).map((p, i) => p?.name ?? p?.type ?? i) }));
}

/** Reply image: the atlas (texture + guide), upscaled, beside game / front / side views of the unwrapped model. */
function guideSheet(engine, doc, mesh) {
  const comp = doc.composite({ exclude: ['emissive', 'height', 'metal', 'rough', 'masks', 'guide'] });
  const g = layerOf(doc, 'guide');
  if (g) for (let p = 0; p < comp.length; p += 4) if (g.data[p + 3]) { const c = blendOver([comp[p], comp[p + 1], comp[p + 2], comp[p + 3] || 255], [g.data[p], g.data[p + 1], g.data[p + 2], g.data[p + 3]]); comp.set(c, p); }
  const f = Math.max(1, Math.min(8, Math.ceil(384 / Math.max(doc.width, doc.height))));
  const W = doc.width * f, H = doc.height * f, big = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / f) * doc.width + Math.floor(x / f)) * 4; big.set(comp.subarray(s, s + 4), (y * W + x) * 4); }
  const views = renderViews(groupsOf(mesh), { views: ['game', 'front', 'side'], size: 192 });
  const sheet = packImages([{ img: { width: W, height: H, data: big }, label: `${doc.name} ${doc.width}x${doc.height}` }, { img: views, label: 'unwrapped' }], { labels: true, checker: true, columns: 2 });
  return encodePNG(sheet.width, sheet.height, sheet.data);
}

// ---------- projection painting ----------
const viewSlug = (v) => (typeof v === 'string' ? v : `y${Math.round(Number(v.yaw ?? 0))}p${Math.round(Number(v.pitch ?? 0))}`);
function orthoSpec(v) {
  if (v === undefined || v === null) return 'front';
  if (v === 'fp' || (typeof v === 'object' && (v.pos || v.perspective))) throw new Error('unwrap view must be orthographic (front|back|side|left|right|top|iso or {yaw, pitch})');
  const r = resolveView(typeof v === 'object' ? { yaw: v.yaw, pitch: v.pitch, label: v.label } : v);
  if (r.perspective) throw new Error('unwrap view must be orthographic (front|back|side|left|right|top|iso or {yaw, pitch}); "game" is a perspective camera');
  return typeof v === 'object' ? { yaw: r.yaw, pitch: r.pitch, label: viewSlug(v) } : v;
}
/** Camera with 1 view px = zoom atlas texels per model texel, fitted to the model bounds. */
function viewCamera(mesh, spec, zoom, texel) {
  const b = mesh.bounds(), fit = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]);
  const probe = makeCamera(spec, 1000, 1000, fit, { zoom: 1, margin: 0 });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of fit) { const [sx, sy] = probe.project(p); x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
  const k = zoom / texel, IW = Math.ceil((x1 - x0) * k) + 4, IH = Math.ceil((y1 - y0) * k) + 4;
  if (IW > 1024 || IH > 1024) throw new Error(`unwrap view ${IW}x${IH} px is over 1024: use zoom:${Math.max(1, Math.floor(zoom * 1020 / Math.max(IW, IH)))}${zoom === 1 ? ' or texel:2' : ''}`);
  return { cam: makeCamera(spec, IW, IH, fit, { zoom: k, margin: 2 }), IW, IH };
}
const flatGroups = (mesh) => groupsOf(mesh).map((g) => ({ ...g, ao: undefined, aoTex: undefined, tex: { key: g.tex.key, name: g.tex.name, width: g.tex.width, height: g.tex.height, data: g.tex.data, material: g.tex.material } }));

// ---------- ops ----------
/** Engine ops, bound to modelops internals. */
export function uvOps({ getModel, saveModel, build, isSkinned }) {
  const unwrapped = (engine, def) => build(engine, def);
  return {
    /**
     * One cohesive UV atlas for the model: unwrap {name, unwrap?:{do, texel, max_size, angle,
     * parts|exclude, bake, cohesion, view, zoom, from, layer, overwrite}}.
     */
    model_unwrap(a, source) {
      const t0 = performance.now();
      const def = getModel(this, a.name);
      if (isSkinned(def) || def.skeleton) throw new Error('unwrap: not on skinned models yet (skeleton / skin): unwrap before skinning is planned');
      if (def.morphs) throw new Error('unwrap: not with morphs yet');
      const spec = mergedSpec(def, a.unwrap);
      const o = normUnwrap(spec);
      const step = o.do;
      const name = canvasName(def, o);
      if (step === 'clear') {
        const next = { ...def }; delete next.unwrap;
        saveModel(this, next, source, 'unwrap removed');
        this._uv?.delete(def.name);
        return { model: def.name, unwrap: null, canvas: this.docs.has(name) ? name : null, note: this.docs.has(name) ? `canvas ${name} kept (art_canvas {canvas:"${name}", action:"delete"} removes it)` : undefined };
      }
      if (step === 'check') {
        const built = build(this, def);
        const doc = this.docs.get(name);
        const nested = (def.parts || []).map((p, i) => (p?.type === 'model' && p.model && (() => { try { return !!getModel(this, p.model).unwrap; } catch { return false; } })() ? i : -1)).filter((i) => i >= 0);
        return { model: def.name, cohesion: cohesionCheck(def, built, { anchor: anchorOf(def, built), atlasDoc: doc?.meta?.uv ? doc : null, full: true, front: o.front, nested }) };
      }
      if (step === 'view' || step === 'project') return viewOrProject.call(this, def, o, spec, source, step);
      const plain = build(this, def, { noUnwrap: true });
      const L = cachedLayout(this, def, plain, o);
      const M = texelMap(L);
      const doc0 = this.docs.get(name);
      if (step === 'guide') {
        if (!doc0?.meta?.uv) throw new Error(`unwrap: no atlas ${name} yet (art_model unwrap {name:"${def.name}"})`);
        if (doc0.meta.uv.hash !== L.hash) throw new Error(`unwrap: atlas ${name} is stale: art_model unwrap {name:"${def.name}"}`);
        doc0.checkpoint('unwrap guide');
        stepGuide(def, L, M, doc0);
        this.changed(doc0, { op: 'unwrap', source, label: 'uv guide', structural: true });
        const built = unwrapped(this, def);
        return { model: def.name, canvas: name, islands: L.charts.length, image: guideSheet(this, doc0, built.mesh) };
      }
      let steps = Array.isArray(step) ? [...step] : step === 'all' ? ['layout', 'bake', 'cohesion'] : [step];
      const fresh = !doc0 || !doc0.meta?.uv || doc0.meta.uv.hash !== L.hash || doc0.width !== L.W || doc0.height !== L.H;
      // part textures swapped since the last bake: the base is re-baked (paint stays)
      if (!fresh && doc0.meta.uv.src && doc0.meta.uv.src !== srcKey(L) && !(Array.isArray(step) ? step : [step]).some((x) => x === 'all' || x === 'bake')) throw new Error(`unwrap: part textures changed since ${name} was baked: run do:"bake" (or the default do:"all") first`);
      // a new or re-laid atlas is always baked whole (never an empty or scrambled atlas; paint is carried over)
      if (fresh) steps = ['layout', 'bake', 'cohesion'];
      const prep = steps.includes('layout') || fresh ? prepareCanvas(this, def, L, o, source) : (doc0.checkpoint(`unwrap ${steps.join('+')}`), { doc: doc0, created: false, migrated: 0 });
      const doc = prep.doc;
      const baked = [];
      let br = null;
      if (steps.includes('bake')) { br = stepBake(this, def, L, M, o, doc, plain); baked.push('base'); }
      if (steps.includes('cohesion')) { const r = stepCohesion(this, def, L, M, o, doc, plain); if (r) baked.push('cohesion'); }
      stepGuide(def, L, M, doc);
      this.changed(doc, { op: 'unwrap', source, label: `model ${def.name}: unwrap ${steps.join('+')}`, structural: true });
      const next = { ...def, unwrap: storedUnwrap(spec) };
      saveModel(this, next, source, 'model unwrapped');
      const built = unwrapped(this, next);
      const check = cohesionCheck(next, built, { anchor: anchorOf(next, built), atlasDoc: doc, full: true, front: o.front });
      const keptBy = new Map();
      for (const g of plain.mesh.groups.values()) for (const f of g.faces || []) { const w = L.include.why(g, f); if (w && w !== 'overlay') keptBy.set(`${partLabel(def, f.pi)}`, w); }
      const seamsVis = L.seams.filter((s) => s.smooth && s.vis > 0.6).length;
      const notes = [...(br?.notes || []), ...(prep.migrated ? [`paint of ${prep.migrated} island${prep.migrated === 1 ? '' : 's'} moved to the new layout`] : [])];
      return {
        model: def.name, canvas: name, size: `${L.W}x${L.H}`, texel_px: L.texel, islands: L.charts.length, fill: L.fill,
        seams: { total: L.seams.length, visible: seamsVis }, kept: [...keptBy].map(([part, why]) => `${part}: ${why}`).slice(0, 8),
        baked, cohesion: { pass: check.pass, score: check.score, issues: check.issues.slice(0, 3) },
        ...(notes.length ? { notes } : {}),
        image: guideSheet(this, doc, built.mesh), ms: Math.round(performance.now() - t0),
        next: `paint transitions on layer "paint" of ${name} (art_draw {canvas:"${name}", layer:"paint"}); art_model unwrap {name, unwrap:{do:"view", view:"front"}} to paint in a view; preview / export use the atlas`,
      };
    },
  };
  /** do:"view" (paintable orthographic view canvas) / do:"project" (its paint -> atlas texels). */
  function viewOrProject(def, o, spec, source, step) {
    const name = canvasName(def, o), atlas = this.docs.get(name);
    if (!atlas?.meta?.uv || !def.unwrap) throw new Error(`unwrap: no atlas ${name} yet (art_model unwrap {name:"${def.name}"} first)`);
    const built = build(this, def);
    if (!built.unwrap || !built.unwrap.canvas || built.unwrap.stale || built.unwrap.missing) throw new Error(`unwrap: atlas ${name} is stale: art_model unwrap {name:"${def.name}"}`);
    if (step === 'view') {
      const vs = orthoSpec(o.view);
      const { cam, IW, IH } = viewCamera(built.mesh, vs, o.zoom, built.unwrap.texel);
      const img = renderCamera(flatGroups(built.mesh), cam, IW, IH, { bg: null, ambient: 1 });
      const vname = `${name}_${viewSlug(o.view ?? 'front')}`;
      let vd = this.docs.get(vname);
      if (vd && (vd.width !== IW || vd.height !== IH || !vd.meta?.uv_view)) {
        if (!vd.meta?.uv_view && !o.overwrite) throw new Error(`unwrap: canvas "${vname}" exists and is not a view canvas (overwrite:true replaces it)`);
        this.docs.delete(vname); vd = null;
      }
      if (!vd) {
        vd = new Doc({ name: vname, width: IW, height: IH });
        vd.layers[0].name = 'render';
        vd.layers.push(new Layer('paint', IW, IH));
        vd.active = 1;
        if (def.project) vd.project = def.project;
        this.attach(vd);
      } else vd.checkpoint('unwrap view');
      vd.layers.find((l) => l.name === 'render').data.set(img.data);
      vd.meta = { ...(vd.meta || {}), uv_view: { model: def.name, canvas: name, view: o.view ?? 'front', zoom: o.zoom, size: [IW, IH], hash: atlas.meta.uv.hash }, build: false };
      this.changed(vd, { op: 'unwrap', source, label: `uv view ${viewSlug(o.view ?? 'front')}`, structural: true });
      return { model: def.name, canvas: vname, size: `${IW}x${IH}`, view: viewSlug(o.view ?? 'front'), zoom: o.zoom, image: encodePNG(IW, IH, img.data), next: `paint on layer "paint" of ${vname} (art_draw {canvas:"${vname}", layer:"paint"}), then art_model unwrap {name:"${def.name}", unwrap:{do:"project", from:"${vname}"}}` };
    }
    // project
    if (!o.from) throw new Error('unwrap project needs from:"<view canvas>" (made by unwrap:{do:"view"})');
    const vd = this.get(o.from), vm = vd.meta?.uv_view;
    if (!vm || vm.model !== def.name) throw new Error(`unwrap: "${o.from}" is not a view canvas of ${def.name} (make one with unwrap:{do:"view"})`);
    if (vm.hash !== atlas.meta.uv.hash) throw new Error(`unwrap: view ${o.from} was made for another layout of ${name}: make the view again (unwrap:{do:"view"})`);
    const { cam, IW, IH } = viewCamera(built.mesh, orthoSpec(vm.view), vm.zoom, built.unwrap.texel);
    if (IW !== vd.width || IH !== vd.height) throw new Error(`unwrap: view ${o.from} no longer matches the model bounds: make the view again`);
    const paint = vd.layers.find((l) => l.name === 'paint') || vd.layers[vd.active];
    const plain = build(this, def, { noUnwrap: true });
    const L = cachedLayout(this, def, plain, normUnwrap(spec));
    const M = texelMap(L);
    const target = ensureLayer(atlas, o.layer);
    atlas.checkpoint(`unwrap project ${o.from}`);
    const bvh = bvhOf([built.mesh]), zc = cam.basis[2], A = L.anchor;
    let projected = 0, hidden = 0;
    const islands = new Set(), mask = new Uint8Array(L.W * L.H);
    for (let k = 0; k < L.W * L.H; k++) {
      const fi = M.facet[k];
      if (fi < 0) continue;
      const n = L.facets[fi].n, pp = M.posAt(k), p = [pp[0] + A[0], pp[1] + A[1], pp[2] + A[2]];
      mask[k] = 1;
      if (n[0] * zc[0] + n[1] * zc[1] + n[2] * zc[2] <= 0.25) continue;
      const [sx, sy] = cam.project(p), x = Math.floor(sx), y = Math.floor(sy);
      if (x < 0 || y < 0 || x >= IW || y >= IH) continue;
      const q = (y * IW + x) * 4;
      if (!paint.data[q + 3]) continue;
      if (bvh.hit([p[0] + n[0] * 0.05, p[1] + n[1] * 0.05, p[2] + n[2] * 0.05], zc, 1e6) < 1e6) { hidden++; continue; }
      target.data.set(paint.data.subarray(q, q + 4), k * 4);
      projected++; islands.add(M.island[k]);
    }
    // gutters follow their island edge texels
    const tmp = Uint8ClampedArray.from(target.data);
    const grown = dilate(tmp, mask, L.W, L.H, L.pad);
    for (let k = 0; k < L.W * L.H; k++) if (!mask[k] && grown[k]) target.data.set(tmp.subarray(k * 4, k * 4 + 4), k * 4);
    this.changed(atlas, { op: 'unwrap', source, label: `projected ${o.from}`, structural: false });
    return { model: def.name, canvas: name, layer: o.layer, projected, islands: [...islands].sort((x, y) => x - y), skipped_hidden: hidden };
  }
}
