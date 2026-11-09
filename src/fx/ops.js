// art_fx engine ops: make / batch / preview / list / export. Sheets go to <exports>/<path|"fx">/<group>/, JSON to <exports>/<path|"fx">/;
// every make merges its entry into <dir>/fx.json (groups -> id -> metadata) that export validates and
// writes out as the manifest the game loads.
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from '../png.js';
import { encodeGIF } from '../gif.js';
import { packImages, packSize } from '../sheet.js';
import { Doc } from '../doc.js';
import { upscale } from '../space/noise.js';
import { FX, FX_TYPES, WEAPONS, SURFACES, FP_FRAME, FP_MUZZLE, FP_AIMS, FP_AIM_STEP } from './effects.js';
import { DECAL_KINDS } from './decals.js';
import { normFx, renderFx, validateFxMeta, presetItems, renderAt, BLENDS, FACINGS, ALL_TYPES, MUZZLE_VIEWS } from './render.js';
import { compositeOver, backdrop, hexRGB, texLimit, MAX_TEX } from './raster.js';

import { checkName } from '../util.js';

/** Groups name the folder their sheets live in: no dots (never collides with fx.json / <group>.fx.json / *.png at the root). */
const GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_GROUPS = new Set(['previews']);
/** Largest preview frame side (px) after scaling. */
const PREVIEW_MAX = 1024;
const MANIFEST = 'fx.json';

function outDir(engine, a) {
  const d = engine.resolvePath(a.path || 'fx', engine.exportDir);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function paletteOf(engine, v) {
  if (!v) return null;
  if (Array.isArray(v)) { if (!v.length) throw new Error('palette is empty'); return v.map(hexRGB); }
  if (typeof v === 'string' && v.startsWith('project:')) {
    const p = engine.getProject(v.slice(8)), pal = Object.values(p.palette || {}).map((c) => hexRGB(String(c).slice(0, 7)));
    if (!pal.length) throw new Error(`project "${p.name}" has no palette`);
    return pal;
  }
  throw new Error('palette must be a list of #rrggbb or "project:<name>"');
}
function readManifest(dir) {
  const f = path.join(dir, MANIFEST);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { version: 1, generator: 'agent-art art_fx', groups: {} };
}
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));
const pngFile = (dir, rel, w, h, data) => { texLimit(w, h, rel); const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encodePNG(w, h, data)); return rel; };
function groupOf(a) {
  const g = a.group ?? 'fx';
  if (typeof g !== 'string' || !GROUP_RE.test(g) || RESERVED_GROUPS.has(g)) throw new Error(`"group" must be 1-64 chars of letters, digits, _ - (not ${[...RESERVED_GROUPS].join(', ')}; got ${JSON.stringify(g)})`);
  return g;
}
/** Files of one effect, relative to the fx dir: <group>/<id>.png (+ _straight / _n / _h / _e). */
function fxFiles(group, r) {
  const f = (s) => `${group}/${r.o.id}${s}.png`;
  if (r.decal) return { file: f(''), normal: f('_n'), height: f('_h'), ...(r.decal.emissive ? { emissive: f('_e') } : {}) };
  return { file: f(''), ...(r.straight ? { straight: f('_straight') } : {}), ...Object.fromEntries((r.variants || []).flatMap((v, i) => (v.base ? [] : [[`aim${i}`, f(`_aim${i}`)], ...(v.straight ? [[`aim${i}_straight`, f(`_aim${i}_straight`)]] : [])]))) };
}
const filesOfMeta = (m) => [m.file, m.roblox?.file, ...Object.values(m.maps || {}), ...(m.fp?.aims || []).flatMap((v) => [v.file, v.straight])].filter(Boolean);
/** PNG [width, height] from the IHDR chunk (null when the file is not a PNG). */
function pngSize(f) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(24);
    if (fs.readSync(fd, b, 0, 24, 0) < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** The canvas an effect opens in (canvas:true = the effect id); never replaces a canvas without overwrite:true. */
function canvasName(engine, a, id) {
  if (!a.canvas) return null;
  const name = checkName(typeof a.canvas === 'string' ? a.canvas : id, 'canvas');
  if (engine.docs.has(name) && !a.overwrite) throw new Error(`canvas "${name}" exists (pass overwrite:true to replace it)`);
  return name;
}
/** Files another entry of the group already owns (one id's _n / _straight file can be another id's sheet). */
function clash(man, group, id, files) {
  for (const [k, m] of Object.entries(man.groups[group] ?? {})) {
    if (k === id) continue;
    const hit = filesOfMeta(m).find((f) => files.includes(f));
    if (hit) return `${hit} (effect "${k}")`;
  }
  return null;
}

/** Peak frame of an effect over a backdrop (contact sheets / previews). */
function peakImage(r) {
  if (r.decal) { const bg = backdrop(r.decal.width, r.decal.height); return compositeOver(bg, { width: r.decal.width, data: r.decal.albedo }, 'alpha'); }
  const bg = backdrop(r.sheet.width, r.sheet.height);
  return compositeOver(bg, r.sheet, r.o.blend === 'distortion' ? 'alpha' : r.o.blend);
}
/** Write one rendered effect's files; -> meta (file names filled). */
function writeFx(dir, group, r, write = true) {
  // write:false fills the metadata with the planned file names (validated before any file is written)
  const png = write ? pngFile : (d, rel, w, h) => { texLimit(w, h, rel); return rel; };
  const { meta } = r, F = fxFiles(group, r);
  if (r.decal) {
    const A = r.decal;
    meta.maps.albedo = meta.file = png(dir, F.file, A.width, A.height, A.albedo);
    meta.maps.normal = png(dir, F.normal, A.width, A.height, A.normal);
    meta.maps.height = png(dir, F.height, A.width, A.height, A.heightmap);
    if (A.emissive) meta.maps.emissive = png(dir, F.emissive, A.width, A.height, A.emissive);
    return meta;
  }
  meta.file = png(dir, F.file, r.sheet.width, r.sheet.height, r.sheet.data);
  meta.roblox.file = r.straight ? png(dir, F.straight, r.straight.width, r.straight.height, r.straight.data) : meta.file;
  (r.variants || []).forEach((v, i) => {
    const e = meta.fp.aims[i];
    if (v.base) { e.file = meta.file; if (r.straight) e.straight = meta.roblox.file; return; }
    e.file = png(dir, F[`aim${i}`], v.sheet.width, v.sheet.height, v.sheet.data);
    if (v.straight) e.straight = png(dir, F[`aim${i}_straight`], v.straight.width, v.straight.height, v.straight.data);
  });
  return meta;
}
function toCanvas(engine, name, r, source) {
  checkName(name, 'canvas');
  const fr = r.frames, [w, h] = r.o.cell, d = new Doc({ name, width: w, height: h * fr.length, frameHeight: fr.length > 1 ? h : null });
  fr.forEach((f, k) => d.layers[0].data.set(f, k * w * h * 4));
  d.meta = { generated: 'art_fx', fx: r.meta.id, blend: r.o.blend };
  if (fr.length > 1) d.animations[r.o.id.slice(0, 64)] = { frames: fr.map((_, k) => k), durations: fr.map(() => Math.round(1000 / r.o.fps)), loop: r.o.loop, direction: 'forward' };
  engine.attach(d);
  engine.changed(d, { op: 'fx', source, label: 'art_fx render', structural: true });
  return name;
}
function makeOne(engine, a, dir, group, man, source) {
  const o = normFx({ ...a, palette_rgb: paletteOf(engine, a.palette) });
  const canvas = o.type === 'decal' ? null : canvasName(engine, a, o.id);
  const t0 = Date.now(), r = renderFx(o);
  r.ms = Date.now() - t0; // render time: in the reply only, never in the saved json (same seed = same bytes)
  const c = clash(man, group, o.id, Object.values(fxFiles(group, r)));
  if (c) throw new Error(`effect "${o.id}" in group "${group}" would overwrite ${c}: pick another name or group`);
  const errs = validateFxMeta(writeFx(dir, group, r, false));
  if (errs.length) throw new Error(`fx metadata invalid: ${errs.join('; ')}`);
  const prev = man.groups[group]?.[o.id], meta = writeFx(dir, group, r);
  // remaking an effect with fewer aim variants (or no straight sheet): its old extra files go
  if (prev) {
    const keep = new Set(filesOfMeta(meta)), root = path.resolve(dir);
    for (const f of filesOfMeta(prev)) {
      const abs = path.resolve(dir, f);
      if (!keep.has(f) && abs.startsWith(root + path.sep) && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    }
  }
  (man.groups[group] ??= {})[o.id] = meta;
  if (canvas) toCanvas(engine, canvas, r, source);
  return r;
}
const summary = (r) => { const m = r.meta; return { id: m.id, file: m.file, sheet: m.sheet, cell: m.cell, frames: m.frames, fps: m.fps, loop: m.loop, blend: m.blend, ...(m.roblox?.flipbook ? { roblox: m.roblox.flipbook } : {}), ...(m.fp?.aims ? { aims: m.fp.aims.map((v) => v.aim_deg) } : {}), ms: r.ms }; };

// ---------- ops ----------
function fxMake(a, source) {
  const dir = outDir(this, a), group = groupOf(a), man = readManifest(dir);
  const r = makeOne(this, a, dir, group, man, source);
  writeJSON(path.join(dir, MANIFEST), man);
  const img = upscale(peakImage(r), Math.max(1, Math.min(4, Math.floor(512 / Math.max(r.meta.sheet[0], r.meta.sheet[1])))));
  // file is relative to dir (<dir>/<group>/<id>.png); abs_file = the full path
  return { ...summary(r), abs_file: path.join(dir, r.meta.file), dir, group, meta: r.meta, ...(a.path ? { next: `export with the same folder: art_fx {action:"export", path:${JSON.stringify(a.path)}} (the manifest lives in ${dir})` } : {}), image: encodePNG(img.width, img.height, img.data) };
}

function fxBatch(a, source) {
  const t0 = Date.now(), dir = outDir(this, a), group = groupOf(a), man = readManifest(dir);
  const base = { seed: a.seed, hue: a.hue, palette: a.palette };
  const items = a.items ?? presetItems(a.preset ?? 'all');
  if (!Array.isArray(items) || !items.length) throw new Error('batch needs items:[{type, variant, ...}] or preset: all | muzzle | impact');
  // validate everything before writing anything
  const canvases = new Set();
  items.forEach((it, i) => {
    try {
      const o = normFx({ ...base, ...it }), c = o.type === 'decal' ? null : canvasName(this, { ...base, ...it }, o.id);
      if (c && canvases.has(c)) throw new Error(`canvas "${c}" is used by two items`);
      if (c) canvases.add(c);
    } catch (e) { throw new Error(`items[${i}]: ${e.message}`); }
  });
  const shown = [], made = [];
  for (const it of items) {
    const r = makeOne(this, { ...base, ...it }, dir, group, man, source);
    made.push(summary(r));
    shown.push({ img: peakImage(r), label: r.o.id.replace(/_/g, ' ').slice(0, 26), sub: `${r.meta.sheet[0]}x${r.meta.sheet[1]} ${r.meta.frames}f` });
  }
  writeJSON(path.join(dir, MANIFEST), man);
  const sheet = packImages(shown, { checker: false, cell: a.cell ?? 128, columns: a.columns ?? Math.min(8, shown.length) });
  const contact = `${group}_contact.png`;
  fs.writeFileSync(path.join(dir, contact), encodePNG(sheet.width, sheet.height, sheet.data));
  const big = Math.max(...made.map((m) => Math.max(...m.sheet)));
  return { group, dir, count: made.length, largest_sheet_px: big, contact, ms: Date.now() - t0, effects: a.verbose ? made : made.map((m) => m.id), image: encodePNG(sheet.width, sheet.height, sheet.data) };
}

/** Sheet + GIF; over:{canvas, frame?, anchor?} composites an fp muzzle flash (or any effect) on a canvas frame. */
function fxPreview(a) {
  const want = Number(a.scale ?? 3);
  if (!Number.isFinite(want)) throw new Error(`"scale" must be a number 1..8 (got ${JSON.stringify(a.scale)})`);
  let scale = Math.max(1, Math.min(8, Math.round(want)));
  let at = null, bgImg = null;
  const args = { ...a };
  if (a.over) {
    if (typeof a.over !== 'object') throw new Error('over must be {canvas, frame?, anchor?}');
    const d = this.get(a.over.canvas), f = Math.round(Number(a.over.frame ?? 0)), fh = d.frameHeight || d.height;
    if (!(f >= 0 && f < d.frames)) throw new Error(`over.frame out of range (0..${d.frames - 1})`);
    if (Array.isArray(a.over.anchor)) {
      if (!(a.over.anchor.length === 2 && a.over.anchor.every((v) => typeof v === 'number' && Number.isFinite(v)))) throw new Error(`over.anchor must be [x, y]: two finite numbers (got ${JSON.stringify(a.over.anchor)})`);
      at = a.over.anchor.slice();
    } else if (a.over.anchor !== undefined && typeof a.over.anchor !== 'string') throw new Error('over.anchor must be a socket anchor name or [x, y]');
    const full = d.composite();
    bgImg = { width: d.width, height: fh, data: full.slice(f * d.width * fh * 4, (f + 1) * d.width * fh * 4) };
    if (!at) {
      const name = a.over.anchor ?? 'socket_muzzle', anim = Object.values(d.meta?.anchors ?? {})[0], an = anim?.[f]?.[name];
      if (!an) throw new Error(`canvas "${d.name}" has no anchor "${name}" on frame ${f} (art_model render with sockets writes them; or give over.anchor:[x, y])`);
      at = an;
      if (args.type === 'muzzle' && args.aim_deg === undefined && args.anchor === undefined && an[2] !== undefined) args.aim_deg = an[2];
    }
    if (args.type === 'muzzle') { args.view ??= 'fp'; if (args.anchor === undefined && args.aim_deg === undefined) args.anchor = at.slice(0, 2), args.frame_size = [d.width, fh]; }
  }
  // a preview draws one aim (the anchor's): fp aim variants are for make / batch
  const o = normFx({ ...args, ...(args.type === 'muzzle' && args.view === 'fp' && args.aims === undefined ? { aims: false } : {}), palette_rgb: paletteOf(this, a.palette) });
  // size everything before rendering: a scaled frame stays <= PREVIEW_MAX px (2x over a canvas frame,
  // never below its native size) and the frame strip fits one sheet; the scale steps down to fit
  const asked = scale, cols = Math.min(o.frames, bgImg ? 2 : 8), side = bgImg ? 2 * PREVIEW_MAX : PREVIEW_MAX;
  const fits = (s, fw, fh, strip) => Math.max(fw, fh) * s <= Math.max(side, fw, fh) && (!strip || packSize(o.frames, fw * s, fh * s, { columns: cols }).fits);
  const sized = (fw, fh, strip) => {
    while (scale > 1 && !fits(scale, fw, fh, strip)) scale--;
    if (!fits(scale, fw, fh, strip)) throw new Error(`preview of ${o.frames} frames at ${fw}x${fh} px does not fit one strip: lower size or frames`);
    return scale < asked ? { scale, scale_capped: `scale ${asked} -> ${scale} (frames <= ${side} px, the strip fits one sheet)` } : { scale };
  };
  const capped = o.type === 'decal' ? null : sized(bgImg ? bgImg.width : o.cell[0], bgImg ? bgImg.height : o.cell[1], true);
  const r = renderFx(o);
  const dir = path.join(outDir(this, a), 'previews');
  fs.mkdirSync(dir, { recursive: true });
  if (r.decal) {
    const sc = sized(r.decal.width, r.decal.height, false);
    const img = upscale(peakImage(r), scale), f = `${o.id}_preview.png`;
    fs.writeFileSync(path.join(dir, f), encodePNG(img.width, img.height, img.data));
    return { id: o.id, dir, files: [f], ...sc, image: encodePNG(img.width, img.height, img.data) };
  }
  const piv = FX[o.type].meta(o).pivot, [cw, ch] = o.cell, blend = o.blend === 'distortion' ? 'alpha' : o.blend;
  const frames = r.frames.map((fr) => {
    let bg;
    if (bgImg) { bg = { ...bgImg, data: bgImg.data.slice() }; for (let i = 3; i < bg.data.length; i += 4) if (!bg.data[i]) { bg.data[i - 3] = 26; bg.data[i - 2] = 28; bg.data[i - 1] = 34; bg.data[i] = 255; } compositeOver(bg, { width: cw, data: fr }, blend, Math.round(at[0] - piv[0]), Math.round(at[1] - piv[1]), cw); }
    else { bg = backdrop(cw, ch); compositeOver(bg, { width: cw, data: fr }, blend); }
    return upscale(bg, scale);
  });
  const W = frames[0].width, H = frames[0].height;
  // strip of every frame (reply image + file), built before anything is written
  const strip = packImages(frames.map((f, k) => ({ img: f, label: `${k}` })), { checker: false, columns: cols });
  const gif = encodeGIF(W, H, frames.map((f) => ({ data: f.data, delay: Math.round(1000 / o.fps) })), { loop: true });
  const gf = `${o.id}${bgImg ? '_over' : ''}.gif`, sf = `${o.id}${bgImg ? '_over' : ''}_frames.png`;
  fs.writeFileSync(path.join(dir, gf), gif);
  fs.writeFileSync(path.join(dir, sf), encodePNG(strip.width, strip.height, strip.data));
  return { id: o.id, dir, files: [gf, sf], frames: o.frames, fps: o.fps, ...capped, ...(at ? { anchor: at, aim_deg: +((o.aim ?? 0) * 180 / Math.PI).toFixed(1) } : {}), image: encodePNG(strip.width, strip.height, strip.data) };
}

function fxList(a) {
  const dir = this.resolvePath(a.path || 'fx', this.exportDir), man = fs.existsSync(path.join(dir, MANIFEST)) ? readManifest(dir) : null;
  return {
    types: Object.fromEntries(FX_TYPES.map((t) => [t, { about: FX[t].about, variants: FX[t].variants }]).concat([['decal', { about: 'decal atlas (albedo + normal + height + emissive), rows = kinds, columns = seeded variants', variants: ['all', ...Object.keys(DECAL_KINDS)] }]])),
    weapon_classes: Object.fromEntries(Object.entries(WEAPONS).map(([k, w]) => [k, { cell: w.cell, sound: w.sound }])), surfaces: Object.fromEntries(Object.entries(SURFACES).map(([k, s]) => [k, { blend: s.blend, decal: s.decal, sound: s.sound }])),
    muzzle_views: MUZZLE_VIEWS, fp: { frame: FP_FRAME, default_anchor: FP_MUZZLE, aims: `default ${FP_AIMS} variants, ${FP_AIM_STEP} deg apart around the base aim (aims: N | [deg..] | false)` }, blends: BLENDS, facings: FACINGS, presets: ['all', 'muzzle', 'impact'], limits: { sheet_px: MAX_TEX, frames: '1..64 (Roblox: 4, 16, 64)', size: '4..256 px per cell' },
    manifest: man ? Object.fromEntries(Object.entries(man.groups).map(([g, m]) => [g, Object.keys(m).length])) : null,
  };
}

/** Validate a manifest group (or all) and write <group>.fx.json (the file the game loads). */
function fxExport(a) {
  const dir = this.resolvePath(a.path || 'fx', this.exportDir), man = readManifest(dir);
  const groups = a.group ? [groupOf(a)] : Object.keys(man.groups);
  if (!groups.length) throw new Error(`no effects in ${path.join(dir, MANIFEST)}: run art_fx make / batch first${a.path ? '' : ' (effects made with a path:"..." are exported with that same path)'}`);
  const issues = [], written = [];
  for (const g of groups) {
    const ents = man.groups[g];
    if (!ents) throw new Error(`no group "${g}" (have: ${Object.keys(man.groups).join(', ')})`);
    for (const m of Object.values(ents)) {
      issues.push(...validateFxMeta(m));
      for (const f of filesOfMeta(m)) {
        const p = path.join(dir, f);
        if (!fs.existsSync(p)) { issues.push(`${m.id}: missing file ${f}`); continue; }
        const wh = pngSize(p);
        if (!wh) issues.push(`${m.id}: ${f} is not a PNG`);
        else if (Array.isArray(m.sheet) && (wh[0] !== m.sheet[0] || wh[1] !== m.sheet[1])) issues.push(`${m.id}: ${f} is ${wh[0]}x${wh[1]}, the entry says sheet ${m.sheet[0]}x${m.sheet[1]} (overwritten by another make? remake it)`);
      }
    }
    const effects = Object.fromEntries(Object.entries(ents).map(([k, { ms, ...m }]) => [k, m])); // ms: render time in pre-0.8.1 entries (not deterministic)
    const out = { version: 1, generator: 'agent-art art_fx', group: g, base: './', fp_frame: FP_FRAME, effects };
    const f = `${g}.fx.json`;
    writeJSON(path.join(dir, f), out);
    written.push({ group: g, file: f, effects: Object.keys(ents).length });
  }
  return { dir, written, valid: !issues.length, issues: issues.slice(0, 40), note: `${MANIFEST} is the working manifest make/batch keep updating; ship the <group>.fx.json file(s) above with the PNGs (the game loads those)` };
}

export const FX_OPS = { fx_make: fxMake, fx_batch: fxBatch, fx_preview: fxPreview, fx_list: fxList, fx_export: fxExport };
export { ALL_TYPES, renderAt };
