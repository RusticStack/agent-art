// art_fx (combat effects): determinism by seed, sheet limits, palette lock, metadata schema, seamless
// loops, decal maps, manifest export, tool wiring, and existing outputs (art_planet fx) unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { TOOLS } from '../src/mcp.js';
import { SKILLS } from '../src/skills.js';
import { helpText } from '../src/docs.js';
import { FX, FX_TYPES } from '../src/fx/effects.js';
import { normFx, renderFx, renderAt, validateFxMeta, loopSeam, presetItems, frameTime } from '../src/fx/render.js';
import { decalAtlas } from '../src/fx/decals.js';
import { RECIPES } from '../src/audio/sfx.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fx-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ALL = presetItems('all');
const PAL = ['#141018', '#3a2c3c', '#6e3a30', '#c0582a', '#f0a040', '#fff0c0', '#4a5660', '#9aa4ac', '#d8e0e4', '#2a7090', '#70e0f0', '#7a2040'];

test('fx: every preset effect renders, validates and stays within 1024 px', () => {
  assert.ok(ALL.length >= 70, `${ALL.length} presets`);
  for (const it of ALL) {
    const o = normFx(it), r = renderFx(o), m = r.meta;
    m.file = `${o.id}.png`; if (m.type === 'decal') Object.assign(m.maps, { albedo: 'a.png', normal: 'n.png', height: 'h.png' });
    assert.deepEqual(validateFxMeta(m), [], o.id);
    assert.ok(m.sheet[0] <= 1024 && m.sheet[1] <= 1024, `${o.id} ${m.sheet}`);
    for (const s of m.sound) assert.ok(RECIPES[s], `${o.id} sound ${s}`);
    if (r.sheet) {
      assert.equal(r.frames.length, m.frames);
      if (o.type !== 'haze') for (let i = 3; i < r.sheet.data.length; i += 4) assert.ok(r.sheet.data[i] === 0 || r.sheet.data[i] === 255, `${o.id}: 1-bit alpha`);
      if (o.type !== 'haze') assert.ok(r.frames.some((f) => f.some((v) => v > 0)), `${o.id} not empty`);
      if (o.cell[0] === o.cell[1] && [4, 16, 64].includes(o.frames)) assert.match(m.roblox.flipbook, /^Grid\dx\d$/, o.id);
    }
  }
});

test('fx: determinism by seed (byte-identical) and seeds differ', () => {
  for (const it of [{ type: 'muzzle', variant: 'rifle', view: 'fp' }, { type: 'impact', variant: 'electronics' }, { type: 'explosion', variant: 'frag' }, { type: 'smoke', variant: 'grenade' }, { type: 'decal' }, { type: 'haze', variant: 'flame' }]) {
    const a = renderFx(normFx({ ...it, seed: 7 })), b = renderFx(normFx({ ...it, seed: 7 })), c = renderFx(normFx({ ...it, seed: 8 }));
    const bytes = (r) => Buffer.from((r.sheet ?? { data: r.decal.albedo }).data);
    assert.equal(sha(bytes(a)), sha(bytes(b)), `${it.type} same seed`);
    if (it.type !== 'strobe') assert.notEqual(sha(bytes(a)), sha(bytes(c)), `${it.type} other seed`);
    if (a.decal) { assert.equal(sha(Buffer.from(a.decal.normal)), sha(Buffer.from(b.decal.normal))); assert.equal(sha(Buffer.from(a.decal.heightmap)), sha(Buffer.from(b.decal.heightmap))); }
  }
  // string seeds work too
  assert.equal(sha(Buffer.from(renderFx(normFx({ type: 'fire', seed: 'camp' })).sheet.data)), sha(Buffer.from(renderFx(normFx({ type: 'fire', seed: 'camp' })).sheet.data)));
});

test('fx: sheet size limits', () => {
  assert.throws(() => normFx({ type: 'fire', size: 300 }), /4\.\.256/);
  assert.throws(() => normFx({ type: 'fire', frames: 65 }), /1\.\.64/);
  assert.throws(() => renderFx(normFx({ type: 'explosion', size: 160, frames: 64 })), /1024 px texture limit/);
  const r = renderFx(normFx({ type: 'explosion', size: 128, frames: 64 }));
  assert.deepEqual(r.meta.sheet, [1024, 1024]);
  assert.equal(r.meta.roblox.flipbook, 'Grid8x8');
  const p = renderFx(normFx({ type: 'smoke', variant: 'column', frames: 10 }));
  assert.equal(p.meta.roblox.flipbook, null); // 10 frames in a padded 4x4 grid
  assert.match(p.meta.roblox.note, /pad: 6/);
  assert.throws(() => decalAtlas({ cell: 128, variants: 16 }), /1024 px/);
  // non-square tracer cells: rows of at most 1024 px
  const t = renderFx(normFx({ type: 'tracer', size: [200, 8], frames: 12 }));
  assert.ok(t.meta.sheet[0] <= 1024);
});

test('fx: palette lock keeps every colour on the palette', () => {
  const pal = new Set(PAL.map((c) => c.toLowerCase()));
  const hex = (d, i) => '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  const items = ALL.filter((it) => it.type !== 'haze'); // haze is a distortion mask, not colours
  for (const it of items) {
    const r = renderFx(normFx({ ...it, palette_rgb: PAL.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16))) }));
    const data = r.sheet ? [r.sheet.data, r.straight?.data].filter(Boolean) : [r.decal.albedo];
    for (const d of data) for (let i = 0; i < d.length; i += 4) if (d[i + 3] || d[i] || d[i + 1] || d[i + 2]) assert.ok(pal.has(hex(d, i)), `${it.type}/${it.variant}: ${hex(d, i)}`);
    if (r.decal?.emissive) for (let i = 0; i < r.decal.emissive.length; i += 4) { const d = r.decal.emissive; if (d[i] || d[i + 1] || d[i + 2]) assert.ok(pal.has(hex(d, i))); }
    assert.equal(r.meta.palette_locked, true);
  }
});

test('fx: loops are seamless (last frame flows into the first; t = 1 renders t = 0)', () => {
  const loops = ALL.filter((it) => { const o = normFx(it); return o.loop; });
  assert.ok(loops.length >= 15, `${loops.length} loops`);
  for (const it of loops) {
    const o = normFx(it), r = renderFx(o);
    const seam = loopSeam(r.frames);
    assert.ok(seam <= 1.05, `${o.id}: seam ${seam.toFixed(2)} (wrap jump vs the largest in-loop step)`);
    const k = o.frames, a = renderAt(o, 0, 0), b = renderAt(o, 1, k);
    let diff = 0; for (let i = 0; i < a.length; i++) diff += a[i] !== b[i];
    assert.ok(diff / a.length < 0.002, `${o.id}: t=1 vs t=0 differ in ${diff} bytes`);
    assert.equal(frameTime(o, k), 1);
  }
});

test('fx: metadata schema catches bad entries', () => {
  const r = renderFx(normFx({ type: 'muzzle', variant: 'shotgun', view: 'fp' })), m = { ...r.meta, file: 'x.png' };
  assert.deepEqual(validateFxMeta(m), []);
  assert.ok(m.fp.shake.amp_px > 0 && m.light.intensity.length >= 2 && m.emitters.length >= 1);
  assert.match(validateFxMeta({ ...m, blend: 'screen' }).join(), /blend/);
  assert.match(validateFxMeta({ ...m, sound: ['nope'] }).join(), /sound/);
  assert.match(validateFxMeta({ ...m, pivot: [999, 0] }).join(), /pivot/);
  assert.match(validateFxMeta({ ...m, light: { color: 'red', radius_m: 1, intensity: [[0, 1]] } }).join(), /light/);
  assert.match(validateFxMeta({ ...m, emitters: [{ ...m.emitters[0], count: [5, 1] }] }).join(), /count/);
  assert.match(validateFxMeta({ ...m, emitters: [{ ...m.emitters[0], size_over_life: [[0.5, 1], [0.2, 1]] }] }).join(), /size_over_life/);
  assert.match(validateFxMeta({ ...m, sheet: [2048, 64] }).join(), /1024/);
  // fp variant aims at the frame centre from the anchor
  const o = normFx({ type: 'muzzle', variant: 'rifle', view: 'fp', anchor: [300, 108], frame_size: [384, 216] });
  assert.ok(Math.abs(o.aim - Math.PI) < 1e-9);
  assert.throws(() => normFx({ type: 'muzzle', variant: 'bow' }), /variant/);
  assert.throws(() => normFx({ type: 'lasers' }), /type must be/);
});

test('fx: decals carry normal / height maps and per-kind cells', () => {
  const A = decalAtlas({ seed: 2 });
  assert.equal(A.width, 128); assert.equal(A.height, 32 * 9);
  assert.ok(A.emissive, 'energy burn emissive');
  for (const [k, cells] of Object.entries(A.cells)) {
    assert.equal(cells.length, 4, k);
    for (const [x, y, w, h] of cells) {
      // 1 px transparent gutter and flat normal on the border
      for (let i = 0; i < w; i++) for (const [px, py] of [[x + i, y], [x + i, y + h - 1], [x, y + i], [x + w - 1, y + i]]) {
        const o = (py * A.width + px) * 4;
        assert.equal(A.albedo[o + 3], 0, `${k} gutter`);
        assert.equal(A.heightmap[o], 128, `${k} flat height at the gutter`);
      }
      let opaque = 0, bent = 0;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const o = (yy * A.width + xx) * 4; opaque += A.albedo[o + 3] > 0; bent += Math.abs(A.normal[o] - 128) > 4 || Math.abs(A.normal[o + 1] - 128) > 4; }
      assert.ok(opaque > 4, `${k} has pixels`);
      if (k !== 'scorch' && k !== 'bullet_electronics') assert.ok(bent > 0, `${k} normal has relief`);
    }
  }
});

test('fx: engine ops write sheets, manifest, previews and export', () => {
  const home = tmp(), e = new Engine({ home }), dir = path.join(home, 'out');
  const r = e.run('fx_make', { type: 'muzzle', variant: 'rifle', view: 'side', seed: 4, path: dir, canvas: true });
  assert.ok(Buffer.isBuffer(r.image));
  const sheet = decodePNG(fs.readFileSync(path.join(dir, r.file)));
  assert.deepEqual([sheet.width, sheet.height], r.sheet);
  assert.equal(e.get('muzzle_rifle_side').frames, 4);
  e.run('fx_make', { type: 'impact', variant: 'metal', path: dir, group: 'combat' });
  e.run('fx_make', { type: 'decal', variant: ['bullet_metal', 'energy_burn'], variants: 2, path: dir, group: 'combat' });
  for (const f of ['impact_metal.png', 'impact_metal_straight.png', 'decal_bullet_metal_energy_burn.png', 'decal_bullet_metal_energy_burn_n.png', 'decal_bullet_metal_energy_burn_h.png', 'decal_bullet_metal_energy_burn_e.png']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const b = e.run('fx_batch', { items: [{ type: 'fire' }, { type: 'strobe', variant: 'amber', mode: 'beacon' }], path: dir, group: 'loops' });
  assert.equal(b.count, 2);
  assert.ok(fs.existsSync(path.join(dir, 'loops_contact.png')));
  assert.throws(() => e.run('fx_batch', { items: [{ type: 'fire' }, { type: 'nope' }], path: dir, group: 'bad' }), /items\[1\]/);
  const x = e.run('fx_export', { path: dir });
  assert.equal(x.valid, true, x.issues.join('; '));
  assert.deepEqual(x.written.map((w) => w.group).sort(), ['combat', 'fx', 'loops']);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'combat.fx.json'), 'utf8'));
  assert.ok(man.effects.impact_metal && man.effects.decal_bullet_metal_energy_burn.maps.emissive);
  const p = e.run('fx_preview', { type: 'explosion', variant: 'emp', path: dir });
  assert.ok(fs.existsSync(path.join(dir, 'previews', p.files[0])));
  assert.equal(fs.readFileSync(path.join(dir, 'previews', p.files[0])).subarray(0, 6).toString(), 'GIF89a');
  // fp overlay on a canvas frame with an anchor
  e.run('create', { name: 'frame', width: 384, height: 216 });
  const ov = e.run('fx_preview', { type: 'muzzle', variant: 'rifle', over: { canvas: 'frame', anchor: [262, 150] }, path: dir });
  assert.ok(ov.files[0].endsWith('_over.gif') && ov.anchor[0] === 262);
  const l = e.run('fx_list', { path: dir });
  assert.ok(l.types.muzzle.variants.includes('plasma') && l.manifest.combat === 2);
});

test('fx: tool, help topic and skill are wired', () => {
  const t = TOOLS.find((x) => x.name === 'art_fx');
  assert.ok(t);
  assert.deepEqual(t.inputSchema.properties.action.enum, ['make', 'batch', 'preview', 'list', 'export']);
  assert.match(helpText({ topic: 'fx' }), /ParticleEmitter/);
  assert.match(helpText({ topic: 'fx' }), /THREE\.AdditiveBlending/);
  assert.ok(SKILLS['combat-fx']);
  for (const tp of FX_TYPES) assert.ok(FX[tp].variants.length >= 1);
});

test('fx: existing space fx output unchanged (art_planet fx bytes)', () => {
  const e = new Engine({ home: tmp() }), r = e.run('planet_fx', { seed: 3 });
  const hashes = Object.fromEntries(r.files.filter((f) => f.endsWith('.png')).map((f) => [f, sha(fs.readFileSync(path.join(r.dir, f))).slice(0, 16)]));
  assert.deepEqual(hashes, EXPECTED_SPACE);
});
// hashes from origin/main (the space fx code is untouched; art_fx only reuses its helpers)
const EXPECTED_SPACE = { 'space_fx_sun.png': 'b03fcef75eb12976', 'space_fx_flare.png': '8257fa88a1c48e15', 'space_fx_debris.png': 'ba2d371888bf3f8e', 'space_fx_dust.png': 'dc8abf524e231035', 'space_fx_lightning.png': 'f36151e18bda4bfb' };
