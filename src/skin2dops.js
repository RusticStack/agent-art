// art_rig 2D skinning ops: skin (bind drawn sprites to the bones as deforming meshes), weights
// (weights check + per-bone heat map), shapes (deform shapes / correctives), chain (cable / strap
// helper: a drawn strip swept along a bone chain) and export (rig JSON with bones, meshes,
// weights, shapes and baked clips for runtime deformation, plus layered per-part strips).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRig, solvePose, renderPose, poseOf, partIn, worldOf } from './rig.js';
import { getRig, framePoses, artComposite } from './rigops.js';
import { buildSkinMesh, weightsImage, compactSkinReport, shapeWeights } from './skin2d.js';
import { encodePNG } from './png.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const allViews = (rig) => [...rig.views, ...Object.keys(rig.mirror)];

/** Compact skin description for rig_info (no mesh build). */
export function skinSummary(rig) {
  return Object.fromEntries(Object.values(rig.skin).map((m) => [m.name, {
    ...(m.part !== undefined ? { part: m.part } : { canvas: m.canvas ?? null }),
    bones: m.bones === 'all' ? rig.order.slice() : m.bones ? m.bones.slice() : [m.part, ...(m.absorb || []).filter((n) => n !== m.part)],
    method: m.method ?? 'heat', shapes: Object.keys(m.shapes || {}), ...(m.views ? { views: Object.keys(m.views) } : {}),
  }]));
}

/** Build every mesh of a rig in the given drawn views. -> {mesh: {view: built | null}} */
function buildAll(rig, d, views, only) {
  const out = {};
  for (const m of Object.values(rig.skin || {})) {
    if (only && m.name !== only) continue;
    out[m.name] = {};
    for (const v of views) {
      try { out[m.name][v] = buildSkinMesh(rig, d, m, v); } catch (e) { throw new Error(`skin "${m.name}" in view "${v}": ${e.message}`); }
    }
  }
  return out;
}

function reportOf(built) {
  const out = {};
  for (const [m, per] of Object.entries(built)) {
    out[m] = {};
    for (const [v, b] of Object.entries(per)) out[m][v] = b ? { ...compactSkinReport(b.report), ms: b.ms, ...(b.shapes.length ? { shapes: b.shapes.map((s) => s.name) } : {}) } : 'no drawing in this view (its parts draw rigid)';
  }
  return out;
}

/** Save a new rig definition (validated) on the parts canvas. */
function saveDef(engine, d, def, next, source, label) {
  const rig = normalizeRig(next);
  if (rig.skin) rig.skinDocs = (n) => engine.docs.get(n);
  d.checkpoint(label);
  d.meta = { ...d.meta, rig: next };
  d.touch?.();
  engine.changed(d, { op: 'rig', source, label, structural: true });
  return rig;
}

export const SKIN2D_OPS = {
  /** skin {name, skin:{<mesh>: {part | canvas, bones?, absorb?, method?, density?, ...} | null} | null}: bind drawn sprites to the bones. */
  rig_skin(a, source) {
    const { d, def } = getRig(this, a.name);
    if (a.skin === null || a.delete) {
      const next = { ...def }; delete next.skin;
      saveDef(this, d, def, next, source, `rig ${a.name}: skin removed`);
      return { rig: a.name, skin: null };
    }
    if (!a.skin || typeof a.skin !== 'object' || Array.isArray(a.skin)) throw new Error('skin needs skin:{<mesh>: {part:"<part>" | canvas:"<canvas>", bones?, absorb?, method?:"heat"|"distance"|"rigid", density?, paint?, weight_canvas?, shapes?, views?}} (null removes a mesh / the whole skin)');
    const skin = { ...(def.skin || {}) };
    for (const [k, v] of Object.entries(a.skin)) if (v === null) delete skin[k]; else skin[k] = v;
    const next = { ...def, skin };
    if (!Object.keys(skin).length) delete next.skin;
    const t0 = performance.now();
    const rig = normalizeRig(next);
    rig.skinDocs = (n) => this.docs.get(n);
    const built = buildAll(rig, d, rig.views);
    saveDef(this, d, def, next, source, `rig ${a.name}: skin ${Object.keys(a.skin).join(', ')}`);
    return {
      rig: a.name, meshes: reportOf(built), ms: Math.round(performance.now() - t0),
      next: `art_rig weights {name:"${a.name}", mesh, bone} = heat map + check; preview / animate render the skinned sprite (rest pose = the drawing pixel for pixel); shapes {mesh, shapes:{crease:{variant, driver:{bone, from, to}}}} adds correctives`,
    };
  },

  /** weights {name, mesh?, view?, bone?, scale?}: weights check of every mesh / view + a heat map image. */
  rig_weights(a) {
    const { d, rig } = getRig(this, a.name);
    if (!rig.skin) throw new Error(`rig "${a.name}" has no skin (art_rig skin {name, skin:{arm:{part:"upper_arm_f", absorb:["forearm_f"]}}} first)`);
    if (a.mesh !== undefined && !rig.skin[a.mesh]) throw new Error(`weights: no mesh "${a.mesh}" (meshes: ${Object.keys(rig.skin).join(', ')})`);
    if (a.view !== undefined && !rig.views.includes(rig.mirror[a.view] || a.view)) throw new Error(`weights: unknown view "${a.view}"`);
    const src = a.view !== undefined ? rig.mirror[a.view] || a.view : null;
    const built = buildAll(rig, d, src ? [src] : rig.views, a.mesh);
    let bad = 0, verts = 0, pruned = 0;
    for (const per of Object.values(built)) for (const b of Object.values(per)) if (b) { verts += b.report.vertices; pruned += b.report.over_4_influences; if (b.report.unweighted || b.report.non_normalised) bad++; }
    const out = {
      rig: a.name, pass: bad === 0, meshes: reportOf(built),
      summary: bad ? `FAIL: ${bad} mesh views have unweighted or non-normalised vertices` : `PASS: ${verts} vertices, <= 4 influences, weights sum to 1${pruned ? ` (${pruned} pruned from > 4)` : ''}`,
    };
    const mesh = a.mesh ?? (Object.keys(rig.skin).length === 1 ? Object.keys(rig.skin)[0] : undefined);
    if (mesh !== undefined && (a.bone !== undefined || a.image !== false)) {
      const views = src ? [src] : rig.views;
      const v = views.find((x) => built[mesh][x]);
      if (v) {
        const b = built[mesh][v];
        const scale = a.scale ?? Math.max(2, Math.min(8, Math.floor(320 / Math.max(b.w * 2, b.h))));
        const img = weightsImage(b, a.bone ?? null, scale);
        out.image = encodePNG(img.width, img.height, img.data);
        out.view = v; out.mesh = mesh; out.bone = a.bone ?? null;
        out.legend = a.bone !== undefined ? `left: the drawing + lattice; right: weight of "${a.bone}" (blue 0 .. red 1), bones as lines (yellow = this bone)` : 'left: the drawing + lattice; right: the dominant bone per pixel (one hue per bone), bones as lines';
      }
    }
    return out;
  },

  /** shapes {name, mesh, shapes:{<shape>: {sculpt?, variant?, canvas?, fit?, driver?} | null}, view?}: deform shapes and correctives. */
  rig_shapes(a, source) {
    const { d, def } = getRig(this, a.name);
    if (!def.skin?.[a.mesh]) throw new Error(`shapes needs mesh: a skin mesh (meshes: ${Object.keys(def.skin || {}).join(', ') || 'none: art_rig skin first'})`);
    if (!a.shapes || typeof a.shapes !== 'object') throw new Error('shapes needs shapes:{<name>: {sculpt:[{region:{circle:[x,y,r]}, move:[dx,dy]}] | variant:"<part variant>" | canvas:"<drawing>", fit?, driver?:{bone, from, to}} | null}');
    const m = structuredClone(def.skin[a.mesh]);
    const tgt = a.view !== undefined ? ((m.views ||= {})[a.view] ||= {}) : m;
    tgt.shapes = { ...(tgt.shapes || {}) };
    for (const [k, v] of Object.entries(a.shapes)) if (v === null) delete tgt.shapes[k]; else tgt.shapes[k] = v;
    if (!Object.keys(tgt.shapes).length) delete tgt.shapes;
    const next = { ...def, skin: { ...def.skin, [a.mesh]: m } };
    const rig = normalizeRig(next);
    rig.skinDocs = (n) => this.docs.get(n);
    const built = buildAll(rig, d, rig.views, a.mesh);
    saveDef(this, d, def, next, source, `rig ${a.name}: shapes ${Object.keys(a.shapes).join(', ')}`);
    const shapes = {};
    for (const [v, b] of Object.entries(built[a.mesh])) if (b) shapes[v] = b.shapes.map((s) => ({ shape: s.name, ...(s.variant ? { drawing: 'swaps in at >= 0.5' } : {}), ...(s.driver ? { driver: `${s.driver.bone} ${s.driver.from}..${s.driver.to} deg` } : {}), max_offset: r3(Math.max(0, ...Array.from({ length: s.d.length / 2 }, (_, i) => Math.hypot(s.d[2 * i], s.d[2 * i + 1])))) }));
    return { rig: a.name, mesh: a.mesh, shapes, next: `preview {name:"${a.name}", parts|pose, shapes:{<shape>:1}}; keys:[{pose, shapes:{<shape>:0..1}}] animate them; driven shapes follow their joint` };
  },

  /**
   * chain {name, part, bones?, axis?, prefix?, secondary?, method?}: cable / strap / sling / tail
   * helper. Adds a chain of bone-only parts along the drawn strip (pivot = its start), skins the
   * strip on them (heat weights) and returns the CCD IK end (chain:n).
   */
  rig_chain(a, source) {
    const { d, def, rig } = getRig(this, a.name);
    const p = rig.parts[a.part];
    if (!p || p.bone || p.art) throw new Error(`chain needs part: a drawn part (the strip, pivot at its start) (parts: ${rig.order.filter((n) => !rig.parts[n].bone).join(', ')})`);
    const axis = a.axis ?? (p.h >= p.w ? 'y' : 'x');
    if (!['x', 'y'].includes(axis)) throw new Error('chain axis must be "x" or "y" (the strip runs along it from the pivot)');
    const k = axis === 'y' ? 1 : 0;
    const size = axis === 'y' ? p.h : p.w, piv = p.pivot[k];
    const dir = piv > size / 2 ? -1 : 1;
    const len = dir > 0 ? size - piv : piv + 1;
    const n = Math.max(2, Math.min(24, Math.round(Number(a.bones ?? Math.max(2, Math.round(len / 8))))));
    const seg = len / n;
    const prefix = a.prefix ?? `${a.part}_`;
    const parts = {};
    let prev = a.part;
    for (let i = 1; i <= n; i++) {
      const nm = `${prefix}${i}`;
      if (rig.parts[nm] && !rig.parts[nm].bone) throw new Error(`chain: part "${nm}" exists and is drawn (prefix:"..." picks other names)`);
      const sl = Math.max(1, Math.round(seg));
      parts[nm] = { bone: true, parent: prev, at: axis === 'y' ? [0, r3(dir * seg)] : [r3(dir * seg), 0], w: axis === 'y' ? 1 : sl, h: axis === 'y' ? sl : 1, pivot: dir > 0 ? [0, 0] : axis === 'y' ? [0, sl - 1] : [sl - 1, 0], z: p.z };
      prev = nm;
    }
    const tip = prev;
    const bones = [a.part, ...Object.keys(parts).slice(0, -1)];
    const skin = { ...(def.skin || {}), [a.mesh ?? a.part]: { part: a.part, bones, absorb: [], method: a.method ?? 'heat', ...(a.density !== undefined ? { density: a.density } : { density: Math.max(1, Math.min(4, Math.round(seg / 2))) }) } };
    const nextParts = { ...def.parts };
    for (const nm of Object.keys(nextParts)) if (nm.startsWith(prefix) && /^\d+$/.test(nm.slice(prefix.length)) && def.parts[nm]?.bone) delete nextParts[nm];
    Object.assign(nextParts, parts);
    const upd = { name: a.name, parts: nextParts, skin };
    if (a.secondary) {
      const s = a.secondary === true ? { stiffness: 0.35, damping: 0.25, gravity: 0.6 } : a.secondary;
      upd.secondary = { ...(def.secondary || {}), ...Object.fromEntries(bones.slice(1).map((b) => [b, s])), ...(rig.parts[a.part].parent ? { [a.part]: s } : {}) };
    }
    // rig_update keeps the drawn cells (relayout) and validates everything
    const r = this.run('rig_update', upd, source);
    const built = buildAll(getRig(this, a.name).rig, d, rig.views, a.mesh ?? a.part);
    return {
      rig: a.name, part: a.part, axis, bones: Object.keys(parts), tip, mesh: a.mesh ?? a.part, cells: r.cells, weights: reportOf(built)[a.mesh ?? a.part],
      ik: { [tip]: { target: '[x,y] | {part, at}', chain: n } },
      next: `pose / keys ik:{${tip}:{target:{part:"<anchor part>"}, chain:${n}}} pins the far end (CCD); ${a.secondary ? 'secondary motion swings the segments (animate secondary:true); ' : ''}limits:{${bones[1] || a.part}:[-60,60]} stops kinks`,
    };
  },

  /**
   * export {name, path?, presets?, views?, layers?}: <name>.skin2d.json (bones, rigid part cells,
   * meshes with vertices / uvs / triangles / joints / weights / shapes, baked clips: per frame bone
   * transforms + shape weights + draw order) + textures, and with layers:true one strip per drawn
   * part / mesh per clip (engines composite them at runtime).
   */
  rig_export(a) {
    const { d, rig, def } = getRig(this, a.name);
    const dir = this.resolvePath(a.path ?? `${a.name}_skin2d`, this.exportDir);
    fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
    const files = [];
    const write = (rel, buf) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); files.push(rel); };
    write('parts.png', encodePNG(d.width, d.height, artComposite(d)));
    const views = a.views ? [].concat(a.views) : allViews(rig);
    for (const v of views) if (!allViews(rig).includes(v)) throw new Error(`export: unknown view "${v}" (views: ${allViews(rig).join(', ')})`);
    const drawn = [...new Set(views.map((v) => rig.mirror[v] || v))];
    const built = rig.skin ? buildAll(rig, d, drawn) : {};
    const bones = rig.order.map((n) => ({
      name: n, parent: rig.parts[n].parent, ...(rig.parts[n].bone ? { bone_only: true } : {}),
      bind: Object.fromEntries(drawn.map((v) => { const W = worldOf(rig, {}, v)[n]; return [v, [r3(W.x), r3(W.y)]]; })),
      z: Object.fromEntries(drawn.map((v) => [v, partIn(rig, n, v).z])),
    }));
    const bi = new Map(rig.order.map((n, i) => [n, i]));
    const parts = [];
    for (const v of drawn) for (const n of rig.order) {
      const p = partIn(rig, n, v);
      if (p.bone || p.hidden) continue;
      const cv = p.link && !p.link.flip ? p.link.view : v;
      const col = rig.layout.columns.find((c) => c.part === (rig.parts[n].art || n) && c.variant === 'base');
      parts.push({ name: n, view: v, cell: [col.x, rig.views.indexOf(cv) * rig.layout.rowH, p.w, p.h], pivot: p.pivot, z: p.z, ...(p.variants.length > 1 ? { variants: p.variants.slice(1) } : {}) });
    }
    const meshes = [];
    for (const [mn, per] of Object.entries(built)) for (const [v, b] of Object.entries(per)) {
      if (!b) continue;
      meshes.push(exportMesh(b, v, bi, write, a.name));
    }
    // baked clips: preset x view, per frame bone transforms (+ shape weights, draw order)
    const presets = a.presets === undefined || a.presets === 'all' ? Object.keys(def.presets || {}) : [].concat(a.presets);
    for (const p of presets) if (!def.presets?.[p]) throw new Error(`export: no preset "${p}" (presets: ${Object.keys(def.presets || {}).join(', ') || 'none'})`);
    const clips = {};
    const cache = new Map();
    for (const preset of presets) for (const view of views) {
      const fp = framePoses(this, rig, def, { preset, view, animation: undefined });
      const frames = [];
      const layerFrames = {};
      fp.poses.forEach((P, f) => {
        const sp = solvePose(rig, P, view);
        const fr = { bones: {} };
        for (const n of rig.order) { const T = sp.world[n], q = poseOf(rig, sp.VP, n); fr.bones[n] = [r3(T.x), r3(T.y), r3(T.rot), r3((T.flip ? -1 : 1) * q.sx), r3(q.sy)]; }
        const sw = {};
        for (const per of Object.values(built)) { const b = per[sp.src]; if (!b) continue; shapeWeights(rig, b, sp.world, sp.P).forEach((w, k) => { if (w > 0) sw[b.shapes[k].name] = r3(w); }); }
        if (Object.keys(sw).length) fr.shapes = sw;
        const trace = {};
        renderPose(rig, d, P, view, cache, { trace, sampling: 'nearest8' });
        fr.order = trace.order.map((e) => e.part);
        frames.push(fr);
        if (a.layers) for (const e of trace.order) {
          (layerFrames[e.part] ||= [])[f] = renderPose(rig, d, P, view, cache, { only: [e.part] });
        }
      });
      const key = `${preset}_${view}`;
      clips[key] = { preset, view, ...(rig.mirror[view] ? { mirror_of: rig.mirror[view] } : {}), fps: Math.round((fp.a.fps ?? 10) * 10) / 10, loop: fp.loop, frames, ...(fp.events.length ? { events: fp.events } : {}) };
      // full frames as a strip, and (layers) one strip per drawn part / mesh
      const [FW, FH] = rig.frame, n = fp.poses.length;
      const stripOf = (imgs) => { const out = new Uint8ClampedArray(FW * n * FH * 4); imgs.forEach((im, i) => { if (!im) return; for (let y = 0; y < FH; y++) out.set(im.subarray(y * FW * 4, (y + 1) * FW * 4), (y * FW * n + i * FW) * 4); }); return encodePNG(FW * n, FH, out); };
      write(`strips/${key}.png`, stripOf(fp.poses.map((P) => renderPose(rig, d, P, view, cache))));
      clips[key].strip = `strips/${key}.png`;
      if (a.layers) {
        clips[key].layers = {};
        for (const [part, imgs] of Object.entries(layerFrames)) { const rel = `layers/${key}/${part}.png`; write(rel, stripOf(Array.from({ length: n }, (_, i) => imgs[i] || null))); clips[key].layers[part] = rel; }
      }
    }
    const json = {
      format: 'agent-art-skin2d', version: 1, rig: a.name, frame: rig.frame, root: rig.root, views: drawn, mirror: Object.fromEntries(Object.entries(rig.mirror).filter(([m]) => views.includes(m))),
      textures: { parts: 'parts.png', filter: 'nearest' }, bones, parts, meshes, clips,
      deform: 'v_bind = vertex (frame px) + sum(shape weight * shape offset); v = sum_k weight_k * M(bone_k, frame) * (v_bind - bind(bone_k)), M = translate(x,y) * rotate(rot deg, clockwise on screen, y down) * scale(sx,sy); draw triangles in listed order, nearest-filtered; mirror views: render mirror_of and flip x about root.x (x\' = 2*root.x - 1 - x)',
    };
    const file = `${a.name}.skin2d.json`;
    write(file, JSON.stringify(json));
    return { dir, file: path.join(dir, file), meshes: meshes.length, bones: bones.length, clips: Object.keys(clips), files: files.length, ...(a.layers ? { layers: 'layers/<clip>/<part>.png per drawn part / mesh, frame order = clips[].frames[].order' } : {}), ...this.pathNote(a.path, dir) };
  },
};

/**
 * One mesh view for export: lattice vertices split per texture page (each page holds one pixel
 * component per lattice cell, so overlapping cut quads never show the other side's pixels).
 */
function exportMesh(b, view, bi, write, rigName) {
  const n = b.verts.length / 2, nt = b.tris.length / 3;
  let pages = 1;
  for (let t = 0; t < nt; t++) pages = Math.max(pages, b.triComp[t] + 1);
  const W = b.w, H = b.h;
  const tex = new Uint8ClampedArray(W * H * pages * 4);
  const t32 = new Uint32Array(tex.buffer);
  for (let i = 0; i < W * H; i++) if (b.mask[i] && b.img32[i] >>> 24 && b.label[i] >= 0) t32[b.label[i] * W * H + i] = b.img32[i];
  const key = new Map(), verts = [], uvs = [], joints = [], weights = [], src = [];
  const vid = (v, page) => {
    const k = v * pages + page;
    let id = key.get(k);
    if (id === undefined) {
      id = verts.length / 2; key.set(k, id); src.push(v);
      verts.push(r3(b.verts[2 * v] + b.origin[0]), r3(b.verts[2 * v + 1] + b.origin[1]));
      uvs.push(b.verts[2 * v], b.verts[2 * v + 1] + page * H);
      // 4 influences, weights in 1e-4 steps summing to exactly 1 (the largest takes the residue)
      const q = Array.from({ length: 4 }, (_, c) => (c < b.counts[v] ? [bi.get(b.bones[b.joints[v * 4 + c]]), Math.round(b.weights[v * 4 + c] * 1e4)] : [0, 0]));
      const sum = q.reduce((s, x) => s + x[1], 0);
      q[0][1] += 1e4 - sum;
      for (const [j, w] of q) { joints.push(j); weights.push(w / 1e4); }
    }
    return id;
  };
  const tris = [];
  for (const t of b.order) for (let k = 0; k < 3; k++) tris.push(vid(b.tris[3 * t + k], b.triComp[t]));
  const texRel = `textures/${b.name}_${view}.png`;
  write(texRel, encodePNG(W, H * pages, tex));
  const shapes = b.shapes.map((s) => {
    const o = { name: s.name, offsets: src.flatMap((v) => [r4(s.d[2 * v]), r4(s.d[2 * v + 1])]) };
    if (s.driver) o.driver = s.driver;
    if (s.variant) {
      const rel = `textures/${b.name}_${view}__${s.name}.png`;
      const vd = new Uint8ClampedArray(s.variant.img32.buffer.slice(0));
      write(rel, encodePNG(W, H, new Uint8ClampedArray(vd.buffer, 0, W * H * 4)));
      o.texture = rel; o.uvs = src.flatMap((v) => [r4(b.verts[2 * v] + s.d[2 * v]), r4(b.verts[2 * v + 1] + s.d[2 * v + 1])]);
      o.swap = 'draw with this texture (uvs) while the shape weight >= 0.5';
    }
    return o;
  });
  void rigName;
  return { name: b.name, view, host: b.host, ...(b.canvas ? { canvas: b.canvas } : {}), z: b.z, replaces: [...new Set([...(b.host ? [b.host] : []), ...b.absorb])], texture: texRel, size: [W, H * pages], pages, origin: b.origin, vertices: verts, uvs, triangles: tris, joints, weights, ...(shapes.length ? { shapes } : {}), lattice: b.step };
}
