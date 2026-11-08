// Engine ops for 3D models (art_model). A model = parts (builder + args + transform) stored as
// JSON in <workspace>/models/<name>.json, so agents can iterate; canvases stay the texture source.
import fs from 'node:fs';
import path from 'node:path';
import { parseColor, toHex } from './color.js';
import { buildModel, PART_DOCS } from './model3d.js';
import { generateCTM, CTM_METHODS } from './ctm.js';
import { Doc } from './doc.js';
import { writeGLB } from './glb.js';
import { renderViews } from './raster3d.js';
import { encodePNG } from './png.js';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;

function modelDir(engine) {
  const d = path.join(engine.home, 'models');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function models(engine) {
  if (engine.models) return engine.models;
  engine.models = new Map();
  for (const f of fs.readdirSync(modelDir(engine))) {
    if (!f.endsWith('.json')) continue;
    try { const m = JSON.parse(fs.readFileSync(path.join(modelDir(engine), f), 'utf8')); engine.models.set(m.name, m); } catch (e) { process.stderr.write(`[agent-art] could not load model ${f}: ${e.message}\n`); }
  }
  return engine.models;
}
function getModel(engine, name) {
  if (!name) throw new Error('model "name" is required');
  const m = models(engine).get(name);
  if (!m) throw new Error(`No model "${name}". Existing: ${[...models(engine).keys()].join(', ') || '(none)'}`);
  return m;
}
function saveModel(engine, def, source, label) {
  def.updated = Date.now();
  const file = path.join(modelDir(engine), `${def.name}.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify(def, null, 1));
  fs.renameSync(file + '.tmp', file);
  models(engine).set(def.name, def);
  engine.emit('event', { type: 'model', model: def.name, source, label, ts: Date.now() });
}

const crop = (data, W, H, [x, y, w, h]) => {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
  if (w <= 0 || h <= 0) throw new Error(`region [${x},${y},${w},${h}] is outside the ${W}x${H} image`);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(data.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4);
  return { data: out, w, h };
};

/**
 * Texture references: "canvas" | "#rrggbb" | {color} | {canvas, frame?, layer?, region?:[x,y,w,h], overlay?:<canvas>}.
 * Emissive = the canvas's layer named "emissive" or a "<canvas>_emissive" canvas; normal (opt-in)
 * = a "<canvas>_n" canvas (art_canvas normal_map). Pivot = canvas meta.pivot.
 */
export function texResolver(engine, { normal = false } = {}) {
  const cache = new Map(), used = new Set();
  const resolve = (ref) => {
    if (ref === null || ref === undefined || ref === false) return null;
    if (typeof ref === 'string') ref = /^(#|rgb|hsl)/i.test(ref) ? { color: ref } : { canvas: ref };
    if (typeof ref !== 'object') throw new Error(`texture must be a canvas name, a color or {canvas, frame?, layer?, region?} (got ${JSON.stringify(ref)})`);
    if (ref.color && !ref.canvas) {
      const c = parseColor(ref.color);
      const key = `color:${toHex(c)}`;
      if (!cache.has(key)) cache.set(key, { key, name: key.replace(/[#:]/g, '_'), width: 1, height: 1, data: Uint8ClampedArray.from([c[0], c[1], c[2], c[3] ?? 255]) });
      return cache.get(key);
    }
    const region = Array.isArray(ref.region) ? ref.region : ref.w !== undefined ? [ref.x ?? 0, ref.y ?? 0, ref.w, ref.h ?? ref.w] : null;
    const key = JSON.stringify([ref.canvas, ref.frame ?? null, ref.layer ?? null, region, ref.overlay ?? null]);
    if (cache.has(key)) return cache.get(key);
    const d = engine.get(ref.canvas);
    used.add(d.name);
    const f = Number(ref.frame ?? 0);
    if (d.frameHeight && (f < 0 || f >= d.frames)) throw new Error(`canvas "${d.name}" has frames 0..${d.frames - 1}`);
    const W = d.width, H = d.frameHeight || d.height;
    const grab = (doc, layer, exclude) => (doc.frameHeight ? doc.frameData(f, { layer, exclude }) : doc.composite({ layer, exclude }));
    // the emissive layer only feeds the emissive texture, never the colour (albedo) texture
    let data = grab(d, ref.layer, ['emissive']);
    let emissive = null, nmap = null;
    if ((ref.layer === undefined || ref.layer === null) && d.layers.some((l) => l.name === 'emissive')) emissive = grab(d, 'emissive');
    const ed = engine.docs.get(`${d.name}_emissive`);
    if (!emissive && ed && ed.width === W && (ed.frameHeight || ed.height) === H) emissive = grab(ed);
    if (emissive && emissive.length === data.length) {
      // keep the coverage of glow-only pixels (a flame drawn just on "emissive"): opaque black
      // albedo there, so the colour comes only from the emissive texture
      data = Uint8ClampedArray.from(data);
      for (let i = 0; i < data.length; i += 4) {
        const ea = emissive[i + 3];
        if (ea > data[i + 3]) {
          const k = data[i + 3] / ea;
          data[i] *= k; data[i + 1] *= k; data[i + 2] *= k; data[i + 3] = ea;
        }
      }
    }
    const nd = normal && engine.docs.get(`${d.name}_n`);
    if (nd && nd.width === W && (nd.frameHeight || nd.height) === H) nmap = grab(nd);
    let w = W, h = H;
    let pivot = Array.isArray(d.meta?.pivot) ? d.meta.pivot.map(Number) : null;
    if (region) {
      const c = crop(data, W, H, region);
      data = c.data; w = c.w; h = c.h;
      if (emissive) emissive = crop(emissive, W, H, region).data;
      if (nmap) nmap = crop(nmap, W, H, region).data;
      if (pivot) pivot = [pivot[0] - region[0], pivot[1] - region[1]];
    }
    if (ref.overlay) {
      // grime/decay overlay, tiled at the base texture's pixel grid, alpha-composited onto it
      const o = resolve(ref.overlay);
      data = Uint8ClampedArray.from(data);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4, q = ((y % o.height) * o.width + (x % o.width)) * 4, a = o.data[q + 3] / 255;
        if (!data[p + 3] || !a) continue;
        for (let k = 0; k < 3; k++) data[p + k] = data[p + k] * (1 - a) + o.data[q + k] * a;
      }
    }
    const name = `${d.name}${d.frameHeight ? `_f${f}` : ''}${ref.layer !== undefined && ref.layer !== null ? `_${ref.layer}` : ''}${region ? `_${region.join('x')}` : ''}${ref.overlay ? `_${typeof ref.overlay === 'string' ? ref.overlay : 'overlay'}` : ''}`;
    // CTM tileset (art_model ctm): faces using it get a tile per world cell from their neighbours
    const ctm = !region && d.meta?.ctm ? d.meta.ctm : null;
    const t = { key, canvas: d.name, name, width: w, height: h, data, emissive, normal: nmap, pivot, ctm };
    cache.set(key, t);
    return t;
  };
  resolve.used = used;
  return resolve;
}

function build(engine, def, opts = {}) {
  const tex = opts.tex || texResolver(engine, opts);
  const r = buildModel(def, { tex, getModel: (n) => getModel(engine, n), instances: opts.instances });
  return { ...r, tex };
}

const r4 = (v) => +v.toFixed(3);
function summary(def, built) {
  const { mesh, parts, origin } = built;
  const b = mesh.bounds(), scale = Number(def.scale ?? 32), grid = Number(def.grid ?? 32);
  const size = b.max.map((v, i) => v - b.min[i]);
  const groups = [...mesh.groups.values()];
  const tris = mesh.triangles;
  const warnings = [];
  if (tris > 20000) warnings.push(`${tris} triangles: heavy for a kit piece (aim < 2000; lower segments/res, fewer ruins)`);
  if (groups.length > 8) warnings.push(`${groups.length} materials: reuse textures, or export atlas:true`);
  for (const g of groups) if (g.tex.width * g.tex.height > 1 && !g.tex.ctm && (g.tex.width & (g.tex.width - 1) || g.tex.height & (g.tex.height - 1))) { warnings.push(`texture ${g.tex.name} is ${g.tex.width}x${g.tex.height} (not power of two: fine for WebGL2, WebGL1 cannot REPEAT it)`); break; }
  return {
    triangles: tris, parts, materials: groups.map((g) => (g.overlay ? `overlay:${g.tex.name}` : g.tex.name)), origin,
    ...(built.baked && (built.baked.ctm_cells || built.baked.overlay_shells) ? { baked: built.baked } : {}),
    bounds_px: { min: b.min.map(r4), max: b.max.map(r4), size: size.map(r4) },
    size_units: size.map((v) => r4(v / scale)), size_cells: size.map((v) => r4(v / grid)), px_per_unit: scale, grid,
    ...(warnings.length ? { warnings } : {}),
  };
}

function previewImage(engine, def, a) {
  const t0 = performance.now();
  const built = build(engine, def);
  const groups = [...built.mesh.groups.values()].filter((g) => g.idx.length);
  const img = renderViews(groups, { views: a.views, size: a.size ?? (a.views?.length === 1 ? 384 : 192) });
  return { image: encodePNG(img.width, img.height, img.data), views: img.views, triangles: built.mesh.triangles, ms: Math.round(performance.now() - t0) };
}

/** Model-level options kept on create/update (besides name and parts). */
export const MODEL_KEYS = ['grid', 'scale', 'origin', 'notes', 'project', 'overlays', 'uv_origin'];

function applyPatch(def, a) {
  const parts = a.parts !== undefined ? [...a.parts] : [...def.parts];
  if (a.set) for (const [k, patch] of Object.entries(a.set)) {
    const i = Number(k);
    if (!parts[i]) throw new Error(`set: no part ${i} (have 0..${parts.length - 1})`);
    if (patch === null) { parts[i] = null; continue; }
    const p = { ...parts[i] };
    for (const [f, v] of Object.entries(patch)) if (v === null) delete p[f]; else p[f] = v;
    parts[i] = p;
  }
  if (a.remove) for (const i of [...a.remove].map(Number).sort((x, y) => y - x)) { if (!parts[i]) throw new Error(`remove: no part ${i}`); parts.splice(i, 1); }
  if (a.add) parts.push(...[].concat(a.add));
  const next = { ...def, parts: parts.filter(Boolean) };
  for (const k of MODEL_KEYS) if (a[k] !== undefined) { if (a[k] === null) delete next[k]; else next[k] = a[k]; }
  return next;
}

/** CTM tilesets used by a built model (for the runtime json next to the .glb). */
function ctmUsed(built) {
  const out = {};
  const scan = (mesh) => { for (const g of mesh.groups.values()) if (g.tex.ctm) out[g.tex.canvas] = { ...g.tex.ctm, atlas: `${g.tex.canvas}.png`, atlas_size: [g.tex.width, g.tex.height] }; };
  scan(built.mesh);
  for (const it of built.instances) scan(it.mesh);
  return out;
}

export const MODEL_OPS = {
  /**
   * Connected-texture tileset (OptiFine/Continuity CTM) as a new canvas: atlas + meta.ctm.
   * Faces textured with it are baked per world cell from their neighbours (all pieces).
   */
  model_ctm(a, source) {
    const o = { ...(a.ctm || {}), ...a };
    const method = o.method || 'full';
    if (!CTM_METHODS.includes(method)) throw new Error(`method must be one of ${CTM_METHODS.join(', ')}`);
    const tex = texResolver(this);
    const img = (r) => (r === undefined || r === null ? null : tex(r));
    const base = img(o.base), template = img(o.template), overlay = img(o.overlay);
    const variants = o.variants ? [].concat(o.variants).map(img) : null;
    const firstVariant = o.variants ? [].concat(o.variants)[0] : undefined;
    const baseName = o.base ?? (method === 'random' ? (typeof firstVariant === 'string' ? firstVariant : firstVariant?.canvas) : undefined);
    const name = o.canvas || o.new_name || o.name || `${baseName || o.template || o.overlay}_${method.replace('+', '_')}`;
    if (!NAME_RE.test(name)) throw new Error('ctm output canvas name must be 1-64 chars of letters, digits, _ - .');
    if (this.docs.has(name) && !o.overwrite) throw new Error(`Canvas "${name}" exists (pass overwrite: true to rebuild the tileset)`);
    const border = o.border ? { ...o.border } : undefined;
    if (border) for (const k of ['color', 'light', 'dark']) if (border[k] !== undefined) { const c = parseColor(border[k]); border[k] = [c[0], c[1], c[2], c[3] ?? 255]; }
    const r = generateCTM({ method, base, template, overlay, variants, tile: o.tile, border, connect: o.connect, weights: o.weights, seed: o.seed, creep: o.creep });
    const meta = { ...r.meta, base: baseName ?? null };
    if (method === 'overlay') meta.from = o.from ?? null;
    const d = new Doc({ name, width: r.width, height: r.height });
    d.layers[0].data.set(r.data);
    d.meta = { ctm: meta, build: false };
    this.attach(d);
    this.changed(d, { op: 'ctm', source, label: `ctm ${method} tileset`, structural: true });
    return {
      canvas: name, size: `${r.width}x${r.height}`, method, tile: meta.tile, tiles: meta.count, order: meta.order, connect: meta.connect,
      use: method === 'overlay'
        ? `overlays:[{texture:"${name}", from:"<canvas or ctm_tag that creeps in>"}] on the receiving parts`
        : `texture:"${name}" on floor/wall/box parts (world-tiled faces); touching same-${meta.connect} faces connect across pieces`,
    };
  },
  model_create(a, source) {
    if (!NAME_RE.test(a.name || '')) throw new Error('model "name" must be 1-64 chars of letters, digits, _ - .');
    if (models(this).has(a.name) && !a.overwrite) throw new Error(`Model "${a.name}" exists (overwrite:true replaces it; art_model update changes it)`);
    const def = { name: a.name, parts: a.parts, grid: a.grid ?? 32, scale: a.scale ?? 32, origin: a.origin ?? 'auto' };
    for (const k of MODEL_KEYS) if (a[k] !== undefined && a[k] !== null && def[k] === undefined) def[k] = a[k];
    def.created = Date.now();
    const s = summary(def, build(this, def));
    saveModel(this, def, source, 'model created');
    return { model: def.name, ...s, next: `art_model preview {name:"${def.name}"} to look at it, update {set:{i:{..}}|add|remove} to iterate, export {name} for .glb` };
  },
  model_update(a, source) {
    const def = getModel(this, a.name);
    const next = applyPatch(def, a);
    const s = summary(next, build(this, next));
    saveModel(this, next, source, 'model updated');
    return { model: next.name, ...s };
  },
  model_info(a) {
    const def = getModel(this, a.name);
    let s;
    try { s = summary(def, build(this, def)); } catch (e) { s = { error: e.message }; }
    const opts = Object.fromEntries(MODEL_KEYS.filter((k) => def[k] !== undefined && k !== 'notes').map((k) => [k, def[k]]));
    return { model: def.name, parts_def: def.parts, notes: def.notes, options: opts, ...s };
  },
  model_list() {
    return { models: [...models(this).values()].sort((x, y) => (y.updated || 0) - (x.updated || 0)).map((m) => ({ name: m.name, parts: m.parts.length, types: [...new Set(m.parts.map((p) => p.type))], project: m.project, updated: m.updated })), part_types: Object.keys(PART_DOCS) };
  },
  model_delete(a, source) {
    getModel(this, a.name);
    models(this).delete(a.name);
    fs.rmSync(path.join(modelDir(this), `${a.name}.json`), { force: true });
    this.emit('event', { type: 'model', model: a.name, deleted: true, source, ts: Date.now() });
    return { deleted: a.name };
  },
  model_preview(a) {
    const def = getModel(this, a.name);
    return { model: def.name, ...previewImage(this, def, a) };
  },
  model_export(a) {
    const def = getModel(this, a.name);
    const scale = Number(a.scale ?? def.scale ?? 32);
    let file = this.resolvePath(a.path || `${def.name}.glb`, this.exportDir);
    if (/[\\/]$/.test(a.path || '') || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(file, `${def.name}.glb`);
    if (!/\.glb$/i.test(file)) file += '.glb';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const normal = !!a.normal_maps;
    if (normal) {
      // make missing "<canvas>_n" normal maps with the normal_map op (they stay editable canvases)
      const probe = build(this, def);
      for (const c of probe.tex.used) if (!this.docs.has(`${c}_n`) && !/_n$/.test(c)) this.run('normal_map', { canvas: c }, 'agent');
    }
    const built = build(this, def, { normal, instances: !!a.instances });
    const meshes = [], nodes = [];
    if (built.mesh.triangles) { meshes.push({ name: def.name, groups: built.mesh.groups.values() }); nodes.push({ name: def.name, mesh: 0 }); }
    const meshOf = new Map();
    for (const [k, it] of built.instances.entries()) {
      if (!meshOf.has(it.model)) { meshes.push({ name: it.model, groups: it.mesh.groups.values() }); meshOf.set(it.model, meshes.length - 1); }
      nodes.push({ name: `${it.model}_${k}`, mesh: meshOf.get(it.model), matrix: it.matrix });
    }
    if (!nodes.length) throw new Error('model has no triangles to export');
    if (a.instances) for (const n of nodes.slice(built.mesh.triangles ? 1 : 0)) n.instance = { model: n.name.replace(/_\d+$/, '') };
    const ctm = ctmUsed(built);
    const ctmNames = Object.keys(ctm);
    const extras = ctmNames.length ? { ctm: { file: path.basename(file).replace(/\.glb$/i, '.ctm.json'), tilesets: ctmNames } } : undefined;
    const { glb, stats } = writeGLB({ meshes, nodes }, { scale, up: a.up, atlas: !!a.atlas, name: def.name, extras });
    fs.writeFileSync(file, glb);
    let ctmFile;
    if (ctmNames.length) {
      // runtime CTM: tilesets + rules (faces are already baked; this is for re-tiling in the engine)
      ctmFile = file.replace(/\.glb$/i, '.ctm.json');
      const dir = path.dirname(file);
      for (const n of ctmNames) { const d = this.get(n); fs.writeFileSync(path.join(dir, `${n}.png`), encodePNG(d.width, d.height, d.composite())); }
      fs.writeFileSync(ctmFile, JSON.stringify({ px_per_unit: scale, bits: 'N1 NE2 E4 SE8 S16 SW32 W64 NW128 (N = up on walls, -Z on floors)', tilesets: ctm, baked: built.baked }, null, 2));
    }
    const meta = {
      name: def.name, file: path.basename(file), generator: 'agent-art', format: 'glTF 2.0 binary',
      units: { px_per_unit: scale, up: a.up === 'z' ? 'Z (root node rotated +90deg about X)' : 'Y (glTF standard)', front: a.up === 'z' ? '-Y' : '+Z', note: 'Z-up engines (Three.js with camera.up = Z): object.rotation.x = Math.PI / 2 maps glTF +Y up to +Z up, or export with up:"z"' },
      origin: built.origin, grid_px: Number(def.grid ?? 32), ...stats, instances: a.instances ? built.instances.length : undefined,
      parts: built.parts, baked: built.baked || undefined, ctm: ctmFile ? path.basename(ctmFile) : undefined,
      materials_note: 'NEAREST filters + REPEAT wrap; alphaMode MASK (cutoff 0.5) where the texture has transparency; emissive from layer "emissive" / <canvas>_emissive; overlay materials (name overlay_*) sample TEXCOORD_1, strength = COLOR_0 alpha',
    };
    const metaFile = file.replace(/\.glb$/i, '.meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return { file, meta: metaFile, ...(ctmFile ? { ctm: ctmFile } : {}), bytes: glb.length, triangles: stats.triangles, vertices: stats.vertices, materials: stats.materials, nodes: stats.nodes, bounds_units: stats.bounds, atlased: stats.atlased };
  },
};
