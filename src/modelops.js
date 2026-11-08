// Engine ops for 3D models (art_model). A model = parts (builder + args + transform) stored as
// JSON in <workspace>/models/<name>.json, so agents can iterate; canvases stay the texture source.
import fs from 'node:fs';
import path from 'node:path';
import { parseColor, toHex } from './color.js';
import { buildModel, PART_DOCS, matMul, rigLayout } from './model3d.js';
import { generateCTM, CTM_METHODS } from './ctm.js';
import { Doc, MAX_SIZE } from './doc.js';
import { writeGLB, trsMatrix } from './glb.js';
import { renderViews, makeCamera, renderCamera } from './raster3d.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { BAYER4 } from './util.js';
import { normalizeWeapon3D, armsChains, solveHold3D, frameIssues3D, offsetOf } from './weapon3d.js';
import { rigInfo, rigSummary, rigScene, rigMeta, resolveOffsets, clipKeys, sampleClip, posedWorld, angleMatrix, subtree, quatOfMat, nodeTRS } from './modelrig.js';
import { MODEL_TEMPLATES } from './modeltemplates.js';
import { normPBR, normBump, bumpNormal, mrTexture, heightFromData } from './surface.js';
import { exportExtras, previewExtras, wantsExtras, MODEL_EXTRA_OPS } from './modelexport.js';

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
 * Surface data layers (left out of the colour): "height" (-> normal map, bump from meta.bump),
 * "metal" / "rough" (-> glTF metallicRoughness texture); canvas meta.material = PBR preset or
 * {metal, rough}; meta.trim = trim sheet strips. bump (export / preview option) = default bump for
 * canvases with a height source (height layer or a <canvas>_h canvas).
 */
export function texResolver(engine, { normal = false, bump = null } = {}) {
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
    // the emissive layer only feeds the emissive texture, never the colour (albedo) texture; the
    // surface data layers (height, metal, rough) never reach the colour either
    const has = (n) => (ref.layer === undefined || ref.layer === null) && d.layers.some((l) => l.name === n);
    let data = grab(d, ref.layer, ['emissive', 'height', 'metal', 'rough']);
    let heightData = has('height') ? grab(d, 'height') : null, metalData = has('metal') ? grab(d, 'metal') : null, roughData = has('rough') ? grab(d, 'rough') : null;
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
      if (heightData) heightData = crop(heightData, W, H, region).data;
      if (metalData) metalData = crop(metalData, W, H, region).data;
      if (roughData) roughData = crop(roughData, W, H, region).data;
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
    surfaceOf(t, d, { heightData, metalData, roughData, region, f, bump });
    cache.set(key, t);
    return t;
  };
  resolve.used = used;
  /** Height source of a canvas texture: the "height" layer, else a same-size <canvas>_h canvas. */
  const surfaceOf = (t, d, { heightData, metalData, roughData, region, f, bump: defBump }) => {
    const meta = d.meta || {};
    if (meta.trim) t.trim = meta.trim;
    if (!heightData && !metalData && !roughData && meta.material === undefined && meta.bump === undefined && !defBump && !engine.docs.has(`${d.name}_h`)) return;
    t.heightOf = () => {
      if (heightData) return heightFromData(heightData, t.width, t.height);
      const hd = engine.docs.get(`${d.name}_h`);
      if (!hd || hd.width !== d.width || (hd.frameHeight || hd.height) !== (d.frameHeight || d.height)) return null;
      let hdat = hd.frameHeight ? hd.frameData(Math.min(f, hd.frames - 1)) : hd.composite();
      if (region) hdat = crop(hdat, d.width, d.frameHeight || d.height, region).data;
      return heightFromData(hdat, t.width, t.height);
    };
    if (meta.material !== undefined) {
      const pbr = normPBR(meta.material);
      if (pbr) { t.pbr = { metal: pbr.metal, rough: pbr.rough }; if (pbr.emissive && !t.emissive) t.emissive = t.data; }
    }
    if (metalData || roughData) { t.metalData = metalData; t.roughData = roughData; t.mr = mrTexture(t.width, t.height, metalData, roughData, t.pbr || { metal: 0, rough: 1 }); }
    // height layer: always a normal map; <canvas>_h / derived height only when a bump is asked for
    const spec = meta.bump !== undefined ? normBump(meta.bump) : defBump ? normBump(defBump) : heightData ? normBump(true) : null;
    if (spec && t.width * t.height > 1) { const n = bumpNormal(t, spec); if (n) t.normal = n; }
  };
  return resolve;
}

/** Models registered as greeble pieces (greeble_kind:"<kind>"). */
const greebleKinds = (engine) => Object.fromEntries([...models(engine).values()].filter((m) => typeof m.greeble_kind === 'string').map((m) => [m.greeble_kind, m.name]));
function build(engine, def, opts = {}) {
  const tex = opts.tex || texResolver(engine, opts);
  const r = buildModel(def, { tex, getModel: (n) => getModel(engine, n), instances: opts.instances, greebleKinds: () => greebleKinds(engine) });
  // GPU-instanced greebles stay separate only for export (EXT_mesh_gpu_instancing); previews,
  // renders and summaries see them merged
  if (r.gpu && !opts.keepGpu) { for (const it of r.gpu) for (const M of it.mats) r.mesh.add(it.mesh.clone().transform(M)); delete r.gpu; }
  return { ...r, tex };
}
/** Variant model for a morph / preview: {model:"other"} or {set:{part:{..}}} patched over def. */
const variantOf = (engine, def) => (spec) => (spec.model ? getModel(engine, spec.model) : applyPatch(def, { set: spec.set }));

const r4 = (v) => +v.toFixed(3);
function summary(def, built) {
  const { mesh, parts, origin } = built;
  const b = mesh.bounds(), scale = Number(def.scale ?? 32), grid = Number(def.grid ?? 32);
  const size = b.max.map((v, i) => v - b.min[i]);
  const groups = [...mesh.groups.values()];
  const tris = mesh.triangles;
  const warnings = [];
  checkRig(def, built);
  if (tris > 20000) warnings.push(`${tris} triangles: heavy for a kit piece (aim < 2000; lower segments/res, fewer ruins)`);
  if (groups.length > 8) warnings.push(`${groups.length} materials: reuse textures, or export atlas:true`);
  for (const g of groups) if (g.tex.width * g.tex.height > 1 && !g.tex.ctm && (g.tex.width & (g.tex.width - 1) || g.tex.height & (g.tex.height - 1))) { warnings.push(`texture ${g.tex.name} is ${g.tex.width}x${g.tex.height} (not power of two: fine for WebGL2, WebGL1 cannot REPEAT it)`); break; }
  return {
    triangles: tris, parts, materials: groups.map((g) => (g.overlay ? `overlay:${g.tex.name}` : g.tex.name)), origin,
    ...(built.baked && (built.baked.ctm_cells || built.baked.overlay_shells) ? { baked: built.baked } : {}),
    bounds_px: { min: b.min.map(r4), max: b.max.map(r4), size: size.map(r4) },
    size_units: size.map((v) => r4(v / scale)), size_cells: size.map((v) => r4(v / grid)), px_per_unit: scale, grid,
    ...(warnings.length ? { warnings } : {}),
    ...(rigOf(def, built) ? { rig: rigSummary(def, rigOf(def, built)) } : {}),
  };
}
/** Rig node tree of a built model (cached on the build), or null for plain models. */
function rigOf(def, built, force = false) {
  const k = force ? '_rigF' : '_rig';
  if (built[k] === undefined) built[k] = rigInfo(def, built, force) || (force ? null : false);
  return built[k] || null;
}
/** Stored poses and clips must resolve against the current nodes (a removed part would only fail at export). */
function checkRig(def, built) {
  if (!def.poses && !def.clips) return;
  const info = rigOf(def, built, true);
  const fix = 'remove or replace it with poses/clips:{<name>:null|{..}}';
  for (const [n, p] of Object.entries(def.poses || {})) {
    try { resolveOffsets(def, info, { parts: p?.parts }); } catch (e) { throw new Error(`pose "${n}": ${e.message} (${fix})`); }
  }
  for (const [n, c] of Object.entries(def.clips || {})) {
    try { clipKeys(def, info, c); } catch (e) { throw new Error(`clip "${n}": ${e.message} (${fix})`); }
  }
}
const groupsOf = (mesh) => [...mesh.groups.values()].filter((g) => g.idx.length);

/** Poses of a clip at n evenly spaced times: [{time, pose: Map node -> local TRS}], frame ms. */
function clipSamples(def, info, clipName, n, fps) {
  const clip = (def.clips || {})[clipName];
  if (!clip) throw new Error(`unknown clip "${clipName}" (clips: ${Object.keys(def.clips || {}).join(', ') || 'none'}; add one with art_model animate)`);
  const ck = clipKeys(def, info, clip);
  const count = Math.max(1, Math.min(240, Math.round(Number(n ?? Math.max(1, Math.round(ck.duration * (fps ?? 15)) + (ck.loop ? 0 : 1))))));
  const step = ck.loop ? ck.duration / count : count > 1 ? ck.duration / (count - 1) : 0;
  const out = [];
  for (let i = 0; i < count; i++) { const time = i * step; out.push({ time, pose: sampleClip(info, ck, time) }); }
  return { samples: out, ms: Math.max(10, Math.round((ck.loop ? ck.duration / count : step || ck.duration || 0.1) * 1000)), loop: ck.loop, duration: ck.duration };
}

function previewImage(engine, def, a) {
  const t0 = performance.now();
  const built = build(engine, def, a.bump !== undefined ? { bump: a.bump } : {});
  const ex = previewExtras(def, built, a, { variantDef: variantOf(engine, def), buildDef: (d) => build(engine, d, { tex: built.tex }) });
  if (ex) return ex;
  if (a.clip !== undefined || a.pose !== undefined || a.parts) {
    const info = rigOf(def, built, true);
    const filter = { only: a.only, hide: a.hide };
    if (a.clip !== undefined) {
      // contact sheet of the clip from one view
      const { samples } = clipSamples(def, info, a.clip, a.frames ?? 6);
      const S = Math.max(32, Math.min(512, Math.round(a.size ?? 192)));
      const posed = samples.map((s) => posedWorld(info, s.pose, filter));
      const full = samples.map((s) => (a.only || a.hide ? posedWorld(info, s.pose) : null));
      const fit = [];
      posed.forEach((p, i) => { const b = (full[i] || p).mesh.bounds(); for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]); });
      const view = a.view ?? (a.views && a.views.length === 1 ? a.views[0] : 'side');
      const cam = makeCamera(view, S, S, fit, { fov: a.fov });
      const items = posed.map((p, i) => ({ img: renderCamera(groupsOf(p.mesh), cam, S, S), label: `t=${samples[i].time.toFixed(2)}s` }));
      const img = packImages(items, { labels: true, checker: false, columns: Math.min(items.length, a.columns ?? 3) });
      return { image: encodePNG(img.width, img.height, img.data), clip: a.clip, view: cam.label, frames: samples.map((s) => +s.time.toFixed(3)), triangles: built.mesh.triangles, ms: Math.round(performance.now() - t0) };
    }
    const { mesh } = posedWorld(info, resolveOffsets(def, info, { pose: a.pose, parts: a.parts }), filter);
    if (a.view !== undefined && (a.view === 'fp' || (typeof a.view === 'object' && a.view.pos))) {
      const S = Math.max(32, Math.min(1024, Math.round(a.size ?? 384)));
      const img = renderCamera(groupsOf(mesh), makeCamera(a.view, S, S, [], { fov: a.fov }), S, S);
      return { image: encodePNG(img.width, img.height, img.data), pose: a.pose ?? null, views: [{ view: 'fp', pixels: img.drawn }], triangles: mesh.triangles, ms: Math.round(performance.now() - t0) };
    }
    const img = renderViews(groupsOf(mesh), { views: a.views || (a.view ? [a.view] : undefined), size: a.size ?? (a.views?.length === 1 || a.view ? 384 : 192) });
    return { image: encodePNG(img.width, img.height, img.data), pose: a.pose ?? null, views: img.views, triangles: mesh.triangles, ms: Math.round(performance.now() - t0) };
  }
  const groups = [...built.mesh.groups.values()].filter((g) => g.idx.length);
  const img = renderViews(groups, { views: a.views, size: a.size ?? (a.views?.length === 1 ? 384 : 192) });
  return { image: encodePNG(img.width, img.height, img.data), views: img.views, triangles: built.mesh.triangles, ms: Math.round(performance.now() - t0) };
}

// ---------- sprite renders: quantize, dither, outline ----------
/** Median-cut palette of n colours from opaque pixels of several RGBA images. */
function medianCut(images, n) {
  const counts = new Map();
  for (const d of images) for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  let boxes = [[...counts].map(([k, c]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, c])];
  if (!boxes[0].length) return [];
  while (boxes.length < n) {
    let bi = -1, best = 0, ch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) { let lo = 255, hi = 0; for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; } if (hi - lo > best) { best = hi - lo; bi = i; ch = c; } }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => x[ch] - y[ch]), total = b.reduce((s, p) => s + p[3], 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) { acc += b[i][3]; if (acc >= total / 2) { cut = i + 1; break; } cut = i + 1; }
    boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.filter((b) => b.length).map((b) => { const w = b.reduce((s, p) => s + p[3], 0); return [0, 1, 2].map((c) => Math.round(b.reduce((s, p) => s + p[c] * p[3], 0) / w)); });
}
function quantizeFrames(images, W, pal, dither, strength = 1) {
  const spread = 40 * strength, cache = new Map();
  for (const d of images) for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const px = (i / 4) % W, py = Math.floor(i / 4 / W);
    const off = dither ? ((BAYER4[py & 3][px & 3] + 0.5) / 16 - 0.5) * spread : 0;
    const r = d[i] + off, g = d[i + 1] + off, b = d[i + 2] + off;
    const key = `${Math.round(r)},${Math.round(g)},${Math.round(b)}`;
    let best = cache.get(key);
    if (!best) {
      let bd = Infinity;
      for (const p of pal) {
        const rm = (r + p[0]) / 2;
        const dd = (2 + rm / 256) * (r - p[0]) ** 2 + 4 * (g - p[1]) ** 2 + (2 + (255 - rm) / 256) * (b - p[2]) ** 2;
        if (dd < bd) { bd = dd; best = p; }
      }
      cache.set(key, best);
    }
    d[i] = best[0]; d[i + 1] = best[1]; d[i + 2] = best[2];
  }
}
function outlineFrame(d, W, H, c) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= 128;
  const add = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!d[(y * W + x) * 4 + 3] && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) add.push((y * W + x) * 4);
  for (const o of add) d.set([c[0], c[1], c[2], c[3] ?? 255], o);
}
/** [from, to, step] | number -> list of angles (inclusive). */
function range(v, name) {
  if (v === undefined || v === null) return [0];
  if (typeof v === 'number') return [v];
  if (!Array.isArray(v) || v.length < 2 || v.some((x) => !Number.isFinite(Number(x)))) throw new Error(`sweep.${name} must be a number or [from, to, step] degrees`);
  const [a, b] = v.map(Number), st = Math.abs(Number(v[2] ?? (b - a))) || 1, out = [];
  const dir = b >= a ? 1 : -1;
  for (let x = a; dir > 0 ? x <= b + 1e-9 : x >= b - 1e-9; x += dir * st) { out.push(+x.toFixed(6)); if (out.length > 400) throw new Error('sweep: too many angles (max 400)'); }
  return out;
}
/** Put n frames into a canvas under an animation tag (replace the tag's frames, reuse a blank canvas, or append). */
function placeFrames(engine, outName, FW, FH, tag, imgs, { durations, loop, project, label, source, meta }) {
  let out = engine.docs.get(outName);
  if (out) {
    if (out.width !== FW || (out.frameHeight || out.height) !== FH) throw new Error(`canvas "${outName}" frames are ${out.width}x${out.frameHeight || out.height}, the render is ${FW}x${FH} (pass size:[${out.width},${out.frameHeight || out.height}] or another canvas)`);
    out.checkpoint(`model render ${tag}`);
    if (!out.frameHeight) out.frameHeight = FH;
  } else {
    out = new Doc({ name: outName, width: FW, height: FH, frameHeight: FH });
    if (project) out.project = project;
    out.meta = {};
    out._fresh = true;
    engine.attach(out);
  }
  const n = imgs.length;
  let start;
  const old = out.animations[tag];
  const blankSingle = out.frames === 1 && !Object.keys(out.animations).length && !out.layers.some((l) => l.data.some((v, i) => i % 4 === 3 && v));
  if (old) {
    const sorted = [...old.frames].sort((x, y) => x - y);
    const contiguous = sorted.every((f, i) => f === sorted[0] + i) && new Set(old.frames).size === old.frames.length;
    if (contiguous && sorted.length === n) start = sorted[0];
    else {
      const keep = [...Array(out.frames).keys()].filter((f) => !old.frames.includes(f));
      delete out.animations[tag];
      out.reorderFrames(keep.length ? keep : [-1]);
      if (!keep.length) { start = 0; out.reorderFrames([...Array(n).fill(-1)]); }
    }
  }
  if (start === undefined) {
    const total = (blankSingle ? 0 : out.frames) + n;
    if (total * FH > MAX_SIZE) throw new Error(`canvas "${outName}" would hold ${total} frames of ${FH}px (${total * FH}px tall, max ${MAX_SIZE}): render into another canvas, fewer frames or a smaller size`);
    if (blankSingle) { out.reorderFrames(Array(n).fill(-1)); start = 0; }
    else { start = out.frames; out.reorderFrames([...Array(out.frames).keys(), ...Array(n).fill(-1)]); }
  }
  let layer = out.layers.find((l) => l.name === 'render');
  if (!layer) { layer = out.layers[0]; if (out._fresh) layer.name = 'render'; }
  delete out._fresh;
  imgs.forEach((img, i) => layer.data.set(img, (start + i) * FW * FH * 4));
  out.setAnimation(tag, { from: start, to: start + n - 1, durations, loop });
  out.meta = { ...(out.meta || {}), ...meta, anchors: { ...(out.meta?.anchors || {}), ...(meta.anchors || {}) } };
  out.touch?.();
  engine.changed(out, { op: 'model', source, label, structural: true });
  return { out, start };
}

/** Model-level options kept on create/update (besides name and parts). */
export const MODEL_KEYS = ['grid', 'scale', 'origin', 'notes', 'project', 'overlays', 'uv_origin', 'rig', 'sockets', 'poses', 'clips', 'weapon', 'arms', 'merge', 'morphs', 'cull', 'greeble_kind'];

/** Part index from a number or a part name. */
function partIndex(parts, k, what) {
  if (/^\d+$/.test(String(k))) return Number(k);
  const i = parts.findIndex((p) => p && (p.name === k || p.id === k));
  if (i < 0) throw new Error(`${what}: no part ${JSON.stringify(k)} (indices 0..${parts.length - 1} or part names: ${parts.filter((p) => p?.name).map((p) => p.name).join(', ') || 'none'})`);
  return i;
}

function applyPatch(def, a) {
  const parts = a.parts !== undefined ? [...a.parts] : [...def.parts];
  if (a.set) for (const [k, patch] of Object.entries(a.set)) {
    const i = partIndex(parts, k, 'set');
    if (!parts[i]) throw new Error(`set: no part ${i} (have 0..${parts.length - 1})`);
    if (patch === null) { parts[i] = null; continue; }
    const p = { ...parts[i] };
    for (const [f, v] of Object.entries(patch)) if (v === null) delete p[f]; else p[f] = v;
    parts[i] = p;
  }
  if (a.remove) for (const i of [...a.remove].map((k) => partIndex(parts, k, 'remove')).sort((x, y) => y - x)) { if (!parts[i]) throw new Error(`remove: no part ${i}`); parts.splice(i, 1); }
  if (a.add) parts.push(...[].concat(a.add));
  const next = { ...def, parts: parts.filter(Boolean) };
  for (const k of MODEL_KEYS) if (a[k] !== undefined) { if (a[k] === null) delete next[k]; else next[k] = a[k]; }
  return next;
}

/** create {template}: the template's parts/sockets/poses/clips, then the caller's overrides. */
function fromTemplate(a) {
  const make = MODEL_TEMPLATES[a.template];
  if (!make) throw new Error(`unknown template "${a.template}" (templates: ${Object.keys(MODEL_TEMPLATES).join(', ')})`);
  if (a.parts !== undefined) throw new Error('template: change the template parts with set:{<part name>:{..}}, add:[..] and remove:[names] (parts replaces nothing here)');
  const t = make(a);
  const base = { name: a.name, parts: t.parts, sockets: t.sockets, poses: t.poses, clips: t.clips, notes: t.notes, ...(t.weapon ? { weapon: t.weapon } : {}) };
  const merged = applyPatch(base, { set: a.set, add: a.add, remove: a.remove });
  for (const k of ['sockets', 'poses', 'clips']) if (a[k] !== undefined && a[k] !== null) {
    merged[k] = { ...(merged[k] || {}) };
    for (const [n, v] of Object.entries(a[k])) { if (v === null) delete merged[k][n]; else merged[k][n] = v; }
    if (!Object.keys(merged[k]).length) delete merged[k];
  }
  for (const k of ['sockets', 'poses', 'clips']) if (merged[k] === undefined) delete merged[k];
  return merged;
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
    const tpl = a.template !== undefined ? fromTemplate(a) : null;
    const def = { name: a.name, parts: tpl ? tpl.parts : a.parts, grid: a.grid ?? 32, scale: a.scale ?? 32, origin: a.origin ?? 'auto' };
    if (tpl) { for (const k of ['sockets', 'poses', 'clips', 'weapon']) if (tpl[k]) def[k] = tpl[k]; if (a.notes === undefined) def.notes = tpl.notes; def.template = a.template; }
    for (const k of MODEL_KEYS) if (a[k] !== undefined && a[k] !== null && def[k] === undefined) def[k] = a[k];
    def.created = Date.now();
    const s = summary(def, build(this, def));
    saveModel(this, def, source, 'model created');
    let next = `art_model preview {name:"${def.name}"} to look at it, update {set:{i:{..}}|add|remove} to iterate, export {name} for .glb`;
    if (s.rig) next += `. Rig: pose {name, pose, parts:{<node>:{rot,at}}}, animate {name, clip, keys:[{pose|parts, t}]}, preview {name, clip, view:"fp"|"side"}, render {name, canvas, clip} = pixel sprites`;
    // origin "auto" keeps part coordinates (kit pieces snap to the grid); a standalone prop or vehicle
    // that is off-centre is easier to place in an engine with origin:"bottom"
    if (def.origin === 'auto' && s.origin === 'parts') {
      const { min, max } = s.bounds_px, cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      if (Math.abs(cx) > 0.5 || Math.abs(cz) > 0.5 || Math.abs(min[1]) > 0.5) next += `. Not centred (bbox centre x ${r4(cx)}, z ${r4(cz)}, bottom y ${r4(min[1])}): for a prop / ship / vehicle use update {name:"${def.name}", origin:"bottom"} (centre on X/Z, bottom on y=0)`;
    }
    return { model: def.name, ...s, next };
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
    return { model: def.name, parts_def: def.parts, notes: def.notes, options: opts, ...(def.template ? { template: def.template } : {}), ...s };
  },
  /** Store a named pose: per-node offsets from the rest pose. parts:null deletes it. */
  model_pose(a, source) {
    const def = getModel(this, a.name);
    if (!/^[\w.-]{1,64}$/.test(a.pose || '')) throw new Error('pose needs a "pose" name (e.g. "grip_rifle")');
    const built = build(this, def);
    const info = rigOf(def, built, true);
    const poses = { ...(def.poses || {}) };
    if (a.parts === null || a.delete) delete poses[a.pose];
    else {
      if (!a.parts || typeof a.parts !== 'object') throw new Error('pose needs parts: {<part name>: {rot?:[x,y,z] deg, at?:[dx,dy,dz] px, scale?}} (offsets from the rest pose; base?:<pose> starts from another pose)');
      let parts = a.parts;
      if (a.base !== undefined) { const b = a.base === 'rest' && !poses.rest ? { parts: {} } : poses[a.base]; if (!b) throw new Error(`base: unknown pose "${a.base}"`); parts = { ...b.parts, ...a.parts }; }
      resolveOffsets(def, info, { parts });
      poses[a.pose] = { parts };
    }
    const next = { ...def, poses };
    if (!Object.keys(poses).length) delete next.poses;
    saveModel(this, next, source, `pose ${a.pose}`);
    return { model: def.name, pose: a.pose, poses: Object.keys(poses), nodes: info.nodes.map((n) => n.name), next: `art_model preview {name:"${def.name}", pose:"${a.pose}"} (view:"fp" = first-person camera)` };
  },
  /** Store an animation clip: keys [{pose|parts, t (s), ease?}], loop?, events?:[{t, name}], duration?. keys:null deletes it. */
  model_animate(a, source) {
    const def = getModel(this, a.name);
    if (a.hold) return holdAnimate(this, def, a, source);
    if (!/^[\w.-]{1,64}$/.test(a.clip || '')) throw new Error('animate needs a "clip" name (e.g. "reload_empty")');
    const clips = { ...(def.clips || {}) };
    let r = null;
    if (a.keys === null || a.delete) delete clips[a.clip];
    else {
      const clip = { keys: a.keys };
      for (const k of ['loop', 'events', 'duration', 'ease']) if (a[k] !== undefined && a[k] !== null) clip[k] = a[k];
      const info = rigOf(def, build(this, def), true);
      const ck = clipKeys(def, info, clip);
      r = { duration: ck.duration, keys: ck.keys.length, loop: ck.loop, nodes: [...new Set(ck.keys.flatMap((k) => [...k.off.keys()]))], events: clip.events || [] };
      clips[a.clip] = clip;
    }
    const next = { ...def, clips };
    if (!Object.keys(clips).length) delete next.clips;
    saveModel(this, next, source, `clip ${a.clip}`);
    return { model: def.name, clip: a.clip, ...(r || { deleted: true }), clips: Object.keys(clips), next: `art_model preview {name:"${def.name}", clip:"${a.clip}", frames:6, view:"side"|"fp"} to check it; export writes it as a glTF animation; render {name, clip, canvas} makes sprite frames` };
  },
  /**
   * Render pose / clip / angle frames into a canvas as crisp pixel art (nearest texels, no AA,
   * transparent background), optional palette quantize + ordered dither + 1 px outline, with
   * per-frame socket anchors in meta.anchors[animation] (spritesheet json frames[].anchors).
   */
  model_render(a, source) {
    const def = getModel(this, a.name);
    const built = build(this, def);
    const info = rigOf(def, built, true);
    const size = a.size === undefined ? [64, 64] : typeof a.size === 'number' ? [a.size, a.size] : Array.isArray(a.size) ? a.size : [];
    const [FW, FH] = size.map((v) => Math.round(Number(v)));
    if (!(FW >= 4 && FH >= 4 && FW <= 1024 && FH <= 1024)) throw new Error('size must be [w, h] px, 4..1024');
    for (const k of ['only', 'hide']) if (a[k] !== undefined && !Array.isArray(a[k])) throw new Error(`${k} must be a list of part (node) names`);
    if (a.only) subtree(info, a.only);
    if (a.hide) subtree(info, a.hide);
    // poses: clip samples | one pose | rest
    let samples, ms = a.duration ?? 100, loop = a.loop;
    // hold: arms solved onto a gun (or a gun carried by arms) every frame: carry state, grips, dead zone
    const hold = a.hold ? holdSetup(this, def, built, info, a) : null;
    if (hold) { samples = hold.samples; ms = a.duration ?? hold.ms ?? ms; loop = loop ?? hold.loop; }
    else if (a.clip !== undefined) {
      const cs = clipSamples(def, info, a.clip, a.frames, a.fps);
      samples = cs.samples; ms = a.duration ?? cs.ms; loop = loop ?? cs.loop;
    } else samples = [{ time: 0, pose: resolveOffsets(def, info, { pose: a.pose, parts: a.parts }) }];
    // angles: sweep grid (row-major: pitch rows x yaw columns) | list | front
    let angles = [{ yaw: 0, pitch: 0, roll: 0 }], grid = null;
    if (a.sweep) {
      const yaws = range(a.sweep.yaw, 'yaw'), pitches = range(a.sweep.pitch, 'pitch'), rolls = range(a.sweep.roll, 'roll');
      angles = [];
      for (const roll of rolls) for (const pitch of pitches) for (const yaw of yaws) angles.push({ yaw, pitch, roll });
      grid = { columns: yaws.length, rows: pitches.length * rolls.length, yaw: yaws, pitch: pitches, ...(rolls.length > 1 ? { roll: rolls } : {}) };
    } else if (a.angles) {
      if (!Array.isArray(a.angles) || !a.angles.length) throw new Error('angles must be [{yaw?, pitch?, roll?}, ...] degrees');
      angles = a.angles.map((x) => {
        if (!x || typeof x !== 'object') throw new Error('angles must be [{yaw?, pitch?, roll?}, ...] degrees');
        return { yaw: Number(x.yaw ?? 0), pitch: Number(x.pitch ?? 0), roll: Number(x.roll ?? 0) };
      });
    }
    if (a.pivot && !(Array.isArray(a.pivot) && a.pivot.length === 3 && a.pivot.every((v) => Number.isFinite(Number(v))))) throw new Error('pivot must be [x,y,z] px');
    const pivot = a.pivot ? a.pivot.map(Number) : [0, 0, 0];
    const frames = [];
    for (const ang of angles) for (const s of samples) frames.push({ ang, s });
    if (frames.length > 400) throw new Error(`${frames.length} frames: max 400 per render (fewer frames or angles)`);
    const filter = { only: a.only, hide: a.hide };
    const posed = frames.map(({ ang, s }) => {
      const pre = ang.yaw || ang.pitch || ang.roll ? angleMatrix(ang, pivot) : null;
      if (s.self) {
        const full = holdPosed(s.self, pre);
        if (a.hold.both) full.mesh.add(holdPosed(s.other, pre).mesh);
        const shown = a.only || a.hide ? holdPosed(s.self, pre, filter) : full;
        return { full, shown };
      }
      const full = posedWorld(info, s.pose, { pre });
      const shown = a.only || a.hide ? posedWorld(info, s.pose, { pre, ...filter }) : full;
      return { full, shown };
    });
    // one camera for every frame (fitted to the FULL model, so layers rendered with only/hide line up)
    const fit = [];
    for (const p of posed) { const b = p.full.mesh.bounds(); for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]); }
    const camSpec = a.camera ?? 'fp';
    const cam = makeCamera(camSpec, FW, FH, fit, { fov: a.fov, zoom: a.zoom, margin: a.margin });
    const L = a.light || {};
    const lopts = { bg: null };
    if (L.dir && !(Array.isArray(L.dir) && L.dir.length === 3 && L.dir.every((v) => Number.isFinite(Number(v))))) throw new Error('light.dir must be [x,y,z] (toward the light)');
    if (L.dir) { const d = L.dir.map(Number), l = Math.hypot(...d) || 1; lopts.light = d.map((v) => v / l); }
    if (L.ambient !== undefined) lopts.ambient = Math.max(0, Math.min(1, Number(L.ambient)));
    if (L.color) { const c = parseColor(L.color); lopts.color = [c[0] / 255, c[1] / 255, c[2] / 255]; }
    const imgs = posed.map((p) => renderCamera(groupsOf(p.shown.mesh), cam, FW, FH, lopts).data);
    let colors;
    if (a.quantize) {
      const q = a.quantize === true ? { colors: 16 } : a.quantize;
      let pal;
      if (q.palette === 'project' || q.palette === 'canvas') {
        const proj = def.project && this.projects?.get(def.project);
        const outDoc = this.docs.get(a.canvas || '');
        const src = q.palette === 'project' ? proj?.palette || outDoc?.fullPalette : outDoc?.fullPalette;
        pal = Object.values(src || {}).map((c) => parseColor(c)).filter((c) => (c[3] ?? 255) > 0);
        if (!pal.length) throw new Error(`quantize palette:"${q.palette}": no palette (set the model's project, or give colors:[..] / colors:<n>)`);
      } else if (Array.isArray(q.colors)) pal = q.colors.map((c) => parseColor(c));
      else pal = medianCut(imgs, Math.max(2, Math.min(256, Math.round(Number(q.colors ?? 16)))));
      if (pal.length) quantizeFrames(imgs, FW, pal, q.dither === true || q.dither === 'bayer', Number(q.strength ?? 1));
      colors = pal.length;
    }
    if (a.outline) { const c = parseColor(a.outline); for (const d of imgs) outlineFrame(d, FW, FH, c); }
    // per-frame socket anchors: frame pixel [x, y] (0.1 px) + screen rotation of the socket's forward (-Z) axis
    const anchors = posed.map((p) => {
      const out = {};
      for (const [name, s] of p.full.sockets) {
        const P = cam.project(s.pos), Q = cam.project([s.pos[0] + s.forward[0] * 4, s.pos[1] + s.forward[1] * 4, s.pos[2] + s.forward[2] * 4]);
        const dx = Q[0] - P[0], dy = Q[1] - P[1];
        const rot = Math.hypot(dx, dy) > 1e-3 ? Math.round((Math.atan2(dy, dx) * 180) / Math.PI * 10) / 10 : 0;
        out[name] = [Math.round((P[0] - 0.5) * 10) / 10, Math.round((P[1] - 0.5) * 10) / 10, rot];
      }
      return out;
    });
    const clipName = a.clip ?? (hold ? hold.clip ?? undefined : undefined); // hold:{clip} renders that gun clip
    const tag = a.animation ?? (clipName !== undefined ? clipName : a.sweep || a.angles ? 'angles' : a.pose ?? 'rest');
    if (!/^[\w.-]{1,64}$/.test(tag)) throw new Error('animation (tag) must be 1-64 chars of letters, digits, _ - .');
    const outName = a.canvas || `${def.name}_${tag}`;
    if (!NAME_RE.test(outName)) throw new Error('canvas name must be 1-64 chars of letters, digits, _ - .');
    const renderMeta = { model: def.name, camera: typeof camSpec === 'string' ? camSpec : { ...camSpec }, size: [FW, FH], clip: a.clip, pose: a.pose, only: a.only, hide: a.hide, ...(grid ? { grid } : {}) };
    const { out, start } = placeFrames(this, outName, FW, FH, tag, imgs, {
      durations: imgs.map(() => Math.max(10, Math.round(ms))), loop: loop !== false, project: def.project, label: `model ${def.name}: render ${tag} (${imgs.length} frames)`, source,
      meta: { anchors: { [tag]: anchors }, renders: { ...(this.docs.get(outName)?.meta?.renders || {}), [tag]: renderMeta } },
    });
    // contact sheet for the agent (frames scaled up to >= 96 px)
    const k = Math.max(1, Math.min(8, Math.ceil(96 / Math.max(FW, FH))));
    const shown = imgs.slice(0, 24).map((d, i) => {
      const W = FW * k, H = FH * k, big = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * FW + Math.floor(x / k)) * 4; big.set(d.subarray(s, s + 4), (y * W + x) * 4); }
      return { img: { width: W, height: H, data: big }, label: String(start + i) };
    });
    const sheet = packImages(shown, { labels: true, checker: true, columns: grid ? Math.min(grid.columns, 8) : Math.min(shown.length, 6) });
    return {
      canvas: out.name, animation: tag, frames: [start, start + imgs.length - 1], count: imgs.length, size: `${FW}x${FH}`, camera: cam.label, ...(grid ? { grid } : {}),
      ...(colors ? { colors } : {}), ...(hold ? { hold: holdReport(hold) } : {}), anchors: info.sockets.map((s) => s.name), image: encodePNG(sheet.width, sheet.height, sheet.data),
      next: `art_animation export {canvas:"${out.name}", format:"spritesheet"} (json frames[].anchors = socket positions per frame; json:false = png only). Arms: art_rig animate {..., ik_from:{canvas:"${out.name}", animation:"${tag}", map:{hand_f:"socket_grip_r"}}}`,
    };
  },
  /**
   * Weapon-handling validation for first-person rigs: every frame of every gun clip (+ the rest
   * pose) in every carry state: hand-to-grip distance, over-extension, gun-body penetration,
   * muzzle flags, gun visibility through the fp camera. -> pass/fail + failing frames.
   */
  model_check(a) {
    const def = getModel(this, a.name);
    const built = build(this, def), info = rigOf(def, built, true);
    if (!a.hold) throw new Error('check needs hold:{weapon:<gun model>} (on arms) or {arms:<arms model>} (on a gun)');
    const probe = holdSetup(this, def, built, info, { ...a, hold: { ...a.hold, clip: undefined }, clip: undefined, pose: undefined });
    const W = probe.gun.weapon;
    const clips = a.clips || (a.hold.clip ? [a.hold.clip] : [null, ...Object.keys(probe.gun.def.clips || {})]);
    const carries = a.carries || (a.hold.carry ? [a.hold.carry] : Object.keys(W.states));
    const out = [];
    let frames = 0, failed = 0;
    const worst = { hand_grip: 0, reach: 0, penetration: 0, visible: null };
    const t0 = performance.now();
    for (const clip of clips) for (const carry of carries) {
      const hs = holdSetup(this, def, built, info, { hold: { ...a.hold, clip: clip ?? undefined, carry }, frames: a.frames ?? (clip ? 8 : 1) });
      for (const [i, s] of hs.samples.entries()) {
        const m = s.sol.metrics;
        const visible = a.visibility === false || m.hidden ? null : gunVisibility(s);
        const issues = frameIssues3D(m, visible, W);
        frames++;
        for (const v of Object.values(m.hand_grip)) worst.hand_grip = Math.max(worst.hand_grip, v);
        for (const v of Object.values(m.reach)) worst.reach = Math.max(worst.reach, v);
        worst.penetration = Math.max(worst.penetration, m.penetration);
        if (visible !== null) { worst.visible = worst.visible === null ? visible.visible : Math.min(worst.visible, visible.visible); worst.onscreen = worst.onscreen === undefined ? visible.onscreen : Math.min(worst.onscreen, visible.onscreen); }
        if (issues.length) { failed++; if (out.length < (a.limit ?? 40)) out.push({ clip: clip ?? 'rest', carry, frame: i, t: +s.time.toFixed(3), issues }); }
      }
    }
    return {
      model: def.name, gun: probe.gun.def.name, arms: probe.arms.def.name, pass: failed === 0, frames_checked: frames, frames_failed: failed, worst, carries, clips: clips.map((c) => c ?? 'rest'),
      summary: failed ? `FAIL: ${failed} of ${frames} frames violate weapon constraints (first: ${out[0].clip}/${out[0].carry} frame ${out[0].frame}: ${out[0].issues[0]})` : `PASS: ${frames} frames (${clips.length} clips x ${carries.length} carry states) hold the gun correctly`,
      ...(out.length ? { issues: out } : {}), ms: Math.round(performance.now() - t0),
    };
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
    const { glb, stats, built, info, rigClips, ctm, ctmNames, ext } = assembleGLB(this, def, { normal, instances: !!a.instances, scale, up: a.up, atlas: !!a.atlas, ctmFile: path.basename(file).replace(/\.glb$/i, '.ctm.json'), file, args: a, ...(a.bump !== undefined ? { bump: a.bump } : {}) });
    fs.writeFileSync(file, glb);
    if (ext) ext.after();
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
      ...(info ? { rig: { ...rigMeta(info, scale), clips: rigClips } } : {}),
      materials_note: 'NEAREST filters + REPEAT wrap; alphaMode MASK (cutoff 0.5) where the texture has transparency; BLEND (baseColorFactor alpha = opacity, extras.depthWrite false) for parts with opacity < 1 or glass, doubleSided for glass / double_sided; emissive from layer "emissive" / <canvas>_emissive; overlay materials (name overlay_*) sample TEXCOORD_1, strength = COLOR_0 alpha',
      ...(ext ? ext.meta : {}),
    };
    const metaFile = file.replace(/\.glb$/i, '.meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return { file, meta: metaFile, ...(ctmFile ? { ctm: ctmFile } : {}), bytes: glb.length, triangles: stats.triangles, vertices: stats.vertices, materials: stats.materials, nodes: stats.nodes, bounds_units: stats.bounds, atlased: stats.atlased, ...(info ? { animations: Object.keys(rigClips), sockets: info.sockets.map((s) => s.name) } : {}), ...(ext ? ext.result : {}) };
  },
  ...MODEL_EXTRA_OPS,
};

// ---------- weapon handling (first-person): arms holding a gun model ----------
/**
 * hold:{weapon:<gun> (rendering arms) | arms:<arms> (rendering the gun), clip?, carry?, attach?, both?, fix?}
 * -> per-frame samples of the rendered model (pose + root transform + hidden nodes) and the other model.
 */
function holdSetup(engine, def, built, info, a) {
  const h = a.hold;
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('hold must be {weapon:<gun model>} (on an arms model) or {arms:<arms model>} (on a gun), with carry?, attach?, clip?, both?, fix?');
  const selfGun = !!def.weapon;
  const otherName = selfGun ? h.arms : h.weapon;
  if (!otherName) throw new Error(selfGun ? 'hold on a gun needs arms:<arms model>' : 'hold on an arms model needs weapon:<gun model>');
  const odef = getModel(engine, otherName), obuilt = build(engine, odef), oinfo = rigOf(odef, obuilt, true);
  const [gdef, gbuilt, ginfo, adef, ainfo] = selfGun ? [def, built, info, odef, oinfo] : [odef, obuilt, oinfo, def, info];
  if (!gdef.weapon) throw new Error(`hold: model "${gdef.name}" has no weapon setting (create {template:"fp_rifle", weapon:true} or update {weapon:{grips:{grip_main:"grip_r", grip_support:"grip_l"}}})`);
  const gun = { def: gdef, info: ginfo, weapon: normalizeWeapon3D(gdef, ginfo, gbuilt) };
  const arms = { def: adef, info: ainfo, chainsInfo: armsChains(adef, ainfo) };
  if (h.carry !== undefined) { const st = typeof h.carry === 'string' ? h.carry : h.carry?.state; if (!gun.weapon.states[st]) throw new Error(`hold.carry: unknown state "${st}" (states: ${Object.keys(gun.weapon.states).join(', ')})`); }
  if (h.attach !== undefined) for (const n of [].concat(h.attach)) if (!gun.weapon.attachments[n]) throw new Error(`hold.attach: unknown attachment "${n}" (attachments: ${Object.keys(gun.weapon.attachments).join(', ') || 'none'})`);
  const clip = h.clip ?? a.clip;
  let gs, ms, loop;
  if (clip !== undefined && (gdef.clips || {})[clip]) { const cs = clipSamples(gdef, ginfo, clip, a.frames, a.fps); gs = cs.samples; ms = cs.ms; loop = cs.loop; }
  else if (clip !== undefined) throw new Error(`hold: the gun "${gdef.name}" has no clip "${clip}" (clips: ${Object.keys(gdef.clips || {}).join(', ') || 'none'})`);
  else gs = [{ time: 0, pose: selfGun ? resolveOffsets(gdef, ginfo, { pose: a.pose, parts: a.parts }) : new Map() }];
  const armsBase = selfGun ? new Map() : resolveOffsets(adef, ainfo, { pose: a.pose, parts: a.parts });
  const samples = gs.map((s) => {
    const sol = solveHold3D(gun, arms, { gunPose: s.pose, armsPose: armsBase, carry: h.carry, attach: h.attach, fix: !!h.fix });
    const inactive = Object.entries(gun.weapon.attachments).filter(([n]) => !sol.active.includes(n)).flatMap(([, x]) => x.parts);
    const gunHide = sol.hidden ? [ginfo.root] : inactive;
    const gunS = { info: ginfo, pose: s.pose, pre: sol.pre, hide: gunHide }, armS = { info: ainfo, pose: sol.arms, pre: null, hide: [] };
    return { time: s.time, self: selfGun ? gunS : armS, other: selfGun ? armS : gunS, gun: gunS, arms: armS, sol };
  });
  return { samples, ms, loop, gun, arms, clip: clip ?? null };
}

/** Posed world of one hold side under an optional angle transform. */
function holdPosed(side, angPre, extra = {}) {
  const pre = side.pre ? (angPre ? matMul(angPre, side.pre) : side.pre) : angPre;
  const hide = [...side.hide, ...(extra.hide || [])];
  return posedWorld(side.info, side.pose, { pre, ...extra, ...(hide.length ? { hide } : { hide: undefined }) });
}

/**
 * Gun visibility through the fp camera: onscreen = gun pixels in the frame / frame area (a gun
 * pushed off screen or holstered reads as gone); visible = share of those not covered by the arms.
 */
function gunVisibility(sample, size = [96, 72]) {
  const [w, h] = size;
  const cam = makeCamera('fp', w, h, [], {});
  const g = holdPosed(sample.gun, null).mesh, ar = holdPosed(sample.arms, null).mesh;
  if (!g.triangles) return null;
  const draw = (m) => renderCamera(groupsOf(m), cam, w, h, { bg: null }).data;
  const both = g.clone(); both.add(ar.clone());
  const G = draw(g), B = draw(both), A = ar.triangles ? draw(ar) : new Uint8ClampedArray(G.length);
  let own = 0, vis = 0;
  for (let i = 0; i < G.length; i += 4) {
    if (!G[i + 3]) continue;
    own++;
    if (B[i + 3] && (B[i] !== A[i] || B[i + 1] !== A[i + 1] || B[i + 2] !== A[i + 2] || !A[i + 3])) vis++;
  }
  return { visible: own ? Math.round((vis / own) * 100) / 100 : 0, onscreen: Math.round((own / (w * h)) * 1000) / 1000 };
}

/** Compact per-frame hold metrics for render replies. */
function holdReport(hold) {
  const W = hold.gun.weapon;
  const bad = [];
  hold.samples.forEach((s, i) => { const is = frameIssues3D(s.sol.metrics, null, W); if (is.length) bad.push({ frame: i, issues: is }); });
  return { gun: hold.gun.def.name, arms: hold.arms.def.name, states: [...new Set(hold.samples.map((s) => s.sol.metrics.state))], pass: !bad.length, ...(bad.length ? { issues: bad.slice(0, 6) } : {}), corrections: [...new Set(hold.samples.flatMap((s) => s.sol.metrics.corrections))] };
}

/**
 * animate {name:<arms>, clip, hold:{weapon:<gun>, clip?, carry?, attach?, fps?, bake_weapon?}}: bake an arms clip that
 * holds the gun on every key (sampled at fps, default 30); bake_weapon:"<clip>" also writes the gun's
 * carried / corrected motion as a clip on the gun model.
 */
function holdAnimate(engine, def, a, source) {
  if (!/^[\w.-]{1,64}$/.test(a.clip || '')) throw new Error('animate needs a "clip" name');
  if (def.weapon) throw new Error('animate {hold} bakes the ARMS clip: call it on the arms model with hold:{weapon:<gun>}');
  const built = build(engine, def), info = rigOf(def, built, true);
  const fps = Number(a.hold.fps ?? a.fps ?? 30);
  const gclip = a.hold.clip ?? (getModel(engine, a.hold.weapon).clips || {})[a.clip] ? (a.hold.clip ?? a.clip) : undefined;
  const probe = gclip ? clipSamples(getModel(engine, a.hold.weapon), rigOf(getModel(engine, a.hold.weapon), build(engine, getModel(engine, a.hold.weapon)), true), gclip, undefined, fps) : null;
  const hs = holdSetup(engine, def, built, info, { hold: { ...a.hold, clip: gclip }, frames: probe ? probe.samples.length + (probe.loop ? 0 : 0) : 1 });
  const chains = Object.values(hs.arms.chainsInfo.chains).flat();
  const keys = hs.samples.map((s) => ({ t: +s.time.toFixed(4), parts: Object.fromEntries(chains.filter((n) => s.sol.arms.has(n)).map((n) => [n, offsetOf(info.byName.get(n), s.sol.arms.get(n))])) }));
  const duration = probe ? probe.duration : 0;
  const clip = { keys: keys.length > 1 ? keys : [{ ...keys[0], t: 0 }], ...(probe?.loop ? { loop: true, duration } : duration ? { duration } : {}) };
  const clips = { ...(def.clips || {}), [a.clip]: clip };
  const ck = clipKeys(def, info, clip);
  saveModel(engine, { ...def, clips }, source, `clip ${a.clip} (held)`);
  let baked = null;
  if (a.hold.bake_weapon) {
    // the gun's top nodes carry the carry-state / correction transform per key
    const g = hs.gun, top = g.info.nodes.filter((n) => n.parent === g.info.root);
    const gkeys = hs.samples.map((s) => {
      const parts = {};
      for (const n of top) {
        const off = s.gun.pose.get(n.name);
        const L = off && off.q ? trsMatrix(off.t, off.q, off.s) : (() => { const x = nodeTRS(n, off); return trsMatrix(x.t, x.q, x.s); })();
        const M = matMul(s.sol.pre, L);
        parts[n.name] = offsetOf(n, { t: [M[3], M[7], M[11]], q: quatOfMat(M) });
      }
      for (const [nn, o] of s.gun.pose) if (!top.some((x) => x.name === nn)) { const node = g.info.byName.get(nn); if (node && o.q) parts[nn] = offsetOf(node, o); else if (o.rot) parts[nn] = { rot: o.rot, at: o.at, scale: o.scale }; }
      return { t: +s.time.toFixed(4), parts };
    });
    const gclips = { ...(g.def.clips || {}), [a.hold.bake_weapon]: { keys: gkeys, ...(probe?.loop ? { loop: true, duration } : duration ? { duration } : {}) } };
    saveModel(engine, { ...g.def, clips: gclips }, source, `clip ${a.hold.bake_weapon} (carried)`);
    baked = a.hold.bake_weapon;
  }
  return { model: def.name, clip: a.clip, keys: ck.keys.length, duration: ck.duration, loop: ck.loop, held: holdReport(hs), ...(baked ? { weapon_clip: `${hs.gun.def.name}/${baked}` } : {}), next: `export {name:"${def.name}"} ships the held clip as a glTF animation; check {name:"${def.name}", hold:{weapon:"${hs.gun.def.name}"}} validates every clip and carry state` };
}

/** Workspace model definitions (name -> def), loaded on first use. */
export function modelDefs(engine) {
  return models(engine);
}

/** Small game-camera thumbnail (PNG Buffer) of a model definition, for the UI. */
export function modelThumbnail(engine, def, size = 128) {
  return previewImage(engine, def, { views: ['game'], size }).image;
}

/**
 * Build a model as an in-memory .glb (same scene as art_model export, no files written).
 * Used by export and by the web UI's 3D viewer.
 */
export function assembleGLB(engine, def, { normal = false, instances = false, scale = Number(def.scale ?? 32), up, atlas = false, ctmFile, bump, file = `${def.name}.glb`, args = {} } = {}) {
  const keepGpu = !(rigLayout(def) || def.sockets || def.clips);
  const built = build(engine, def, { normal, instances, keepGpu, ...(bump !== undefined ? { bump } : {}) });
  const info = rigOf(def, built);
  let meshes = [], nodes = [], animations, rigClips;
  if (info) {
    // rig: one node (own mesh, local TRS) per named part, sockets as empty nodes, clips as animations
    const rs = rigScene(def, info);
    ({ meshes, nodes, animations } = rs);
    rigClips = rs.clips;
    const meshOf = new Map();
    for (const [k, it] of built.instances.entries()) {
      if (!meshOf.has(it.model)) { meshes.push({ name: it.model, groups: it.mesh.groups.values() }); meshOf.set(it.model, meshes.length - 1); }
      nodes.push({ name: `${it.model}_${k}`, mesh: meshOf.get(it.model), matrix: it.matrix, instance: { model: it.model } });
      nodes[0].children.push(nodes.length - 1);
    }
    if (!meshes.length) throw new Error('model has no triangles to export');
  } else {
    if (built.mesh.triangles) { meshes.push({ name: def.name, groups: built.mesh.groups.values() }); nodes.push({ name: def.name, mesh: 0 }); }
    const meshOf = new Map();
    for (const [k, it] of built.instances.entries()) {
      if (!meshOf.has(it.model)) { meshes.push({ name: it.model, groups: it.mesh.groups.values() }); meshOf.set(it.model, meshes.length - 1); }
      nodes.push({ name: `${it.model}_${k}`, mesh: meshOf.get(it.model), matrix: it.matrix });
    }
    if (!nodes.length) throw new Error('model has no triangles to export');
    if (instances) for (const n of nodes.slice(built.mesh.triangles ? 1 : 0)) n.instance = { model: n.name.replace(/_\d+$/, '') };
  }
  const ctm = ctmUsed(built);
  const ctmNames = Object.keys(ctm);
  let extras = ctmNames.length ? { ctm: { file: ctmFile || `${def.name}.ctm.json`, tilesets: ctmNames } } : undefined;
  if (info) extras = { ...(extras || {}), rig: { nodes: info.nodes.length, sockets: info.sockets.map((s) => s.name), clips: Object.keys(rigClips) } };
  // surface / render-cost extras (only when asked for: plain exports are unchanged); side files are written by ext.after()
  const ext = wantsExtras(def, built, args) ? exportExtras(engine, def, built, args, { scale, file, info, meshes, nodes, writeGLB, variantDef: variantOf(engine, def), buildDef: (d) => build(engine, d, { tex: built.tex, normal, keepGpu }) }) : null;
  if (ext) ({ meshes, nodes } = ext);
  const { glb, stats } = writeGLB({ meshes, nodes, animations }, { scale, up, atlas, name: def.name, extras, ...(ext ? ext.glbOpts : {}) });
  return { glb, stats, built, info, rigClips, ctm, ctmNames, ext };
}
