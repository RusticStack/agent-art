// Regression tests for issues an agent hit while building the README showcase (v1 polish, part 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { runTool } from '../src/mcp.js';
import { overviewFacts } from '../src/audio/image.js';
import { skillText } from '../src/skills.js';
import { helpText } from '../src/docs.js';
import { meleeCell } from '../src/meleekit.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-v1b-'));
const tool = async (e, name, args) => runTool(name, args, (op, a) => e.run(op, a));
const text = (content) => content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = async (e, name, args) => JSON.parse(text(await tool(e, name, args)));
const painted = (e, canvas, layer = 0) => { const d = e.get(canvas).layers[layer].data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };

async function meleeSkin(e) {
  e.run('anim_skeleton', { name: 'k', template: 'humanoid_hd', frame: [64, 96] });
  const s = e.run('anim_skin', { name: 'kn', skeleton: 'k' });
  // paint the chest cell so a rebuild has something to keep
  const [x, w] = [s.cells.parts.chest[0], s.cells.parts.chest[1]];
  e.run('draw', { canvas: 'kn_parts', commands: [{ op: 'rect', x, y: 0, w, h: 4, color: '#aa3344', fill: true }] });
  e.run('anim_melee', { skeleton: 'k', weapon: 'baton', shield: true });
  return s;
}

test('art_anim skin overwrite:true rebuilds the rig with parts the skeleton gained (shield) and keeps drawn cells', async () => {
  const e = new Engine({ home: tmp() });
  await meleeSkin(e);
  const before = painted(e, 'kn_parts');
  assert.ok(before > 0);
  const r = await json(e, 'art_anim', { action: 'skin', name: 'kn', skeleton: 'k', overwrite: true });
  assert.equal(r.rebuilt, true);
  assert.deepEqual(r.added_parts, ['shield']);
  assert.ok(!r.warning, r.warning);
  assert.ok(r.cells.parts.shield);
  assert.equal(painted(e, 'kn_parts'), before, 'drawn pixels survive the rebuild');
  // without overwrite an existing rig is bound as before
  const again = await json(e, 'art_anim', { action: 'skin', name: 'kn', skeleton: 'k' });
  assert.equal(again.created, false);
  assert.equal(again.rebuilt, undefined);
  // a bound foreign rig (map) is never rebuilt
  e.run('rig_create', { name: 'own', template: 'humanoid_hd', frame: [64, 96] });
  const own = await json(e, 'art_anim', { action: 'skin', name: 'own', skeleton: 'k', rig: 'own', map: { shield: 'hand_b' }, overwrite: true });
  assert.equal(own.rebuilt, undefined);
  assert.ok(!e.run('rig_info', { name: 'own' }).parts.shield);
});

test('art_anim skin delete:true deletes the skin (no skeleton needed), keeps its rig; unknown skin is a clear error', async () => {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'k', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_skin', { name: 'kn', skeleton: 'k' });
  const r = await json(e, 'art_anim', { action: 'skin', name: 'kn', delete: true });
  assert.equal(r.deleted, true);
  assert.equal(r.rig_kept, 'kn');
  assert.ok(e.docs.has('kn_parts'));
  assert.deepEqual(e.run('anim_list', {}).skins, []);
  await assert.rejects(tool(e, 'art_anim', { action: 'skin', name: 'kn', delete: true }), /no skin "kn"/);
});

test('art_rig debug_render {animation:"<clip>_<view>", frame} renders that library clip frame, not the rest pose', async () => {
  const e = new Engine({ home: tmp() });
  await meleeSkin(e);
  e.run('anim_skin', { name: 'kn', skeleton: 'k', overwrite: true });
  e.run('anim_render', { skin: 'kn', clip: 'baton_strike', view: 'side' });
  const r = await tool(e, 'art_rig', { action: 'debug_render', name: 'kn', animation: 'baton_strike_side', frame: 4 });
  const j = JSON.parse(text(r));
  assert.equal(j.frame, 4);
  assert.equal(j.view, 'side');
  assert.match(j.source, /clip kn\/baton_strike/);
  assert.ok(r.some((c) => c.type === 'image'));
  // tag works the same; the rest pose is still the default
  assert.match(e.run('rig_debug_render', { name: 'kn', tag: 'baton_strike_side', frame: 4 }).source, /clip/);
  assert.match(e.run('rig_debug_render', { name: 'kn' }).source, /rest pose/);
});

test('art_model render camera:"game" applies zoom and fov', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'b', parts: [{ type: 'box', w: 32, h: 32, d: 32, color: '#808080' }] });
  const bbox = (canvas) => {
    const d = e.get(canvas).layers[0].data, W = e.get(canvas).width;
    let x0 = 1e9, x1 = -1;
    for (let i = 3, p = 0; i < d.length; i += 4, p++) if (d[i]) { const x = p % W; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return x1 - x0 + 1;
  };
  const w = (args, c) => { e.run('model_render', { name: 'b', canvas: c, camera: 'game', size: [96, 96], ...args }); return bbox(c); };
  const fit = w({}, 'g0'), z = w({ zoom: 2 }, 'g1'), z1 = w({ zoom: 1 }, 'g2'), fov = w({ fov: 20 }, 'g3');
  assert.ok(z > z1 * 1.6 && z < z1 * 2.4, `zoom 2 ~ twice zoom 1 (${z} vs ${z1})`);
  assert.ok(Math.abs(z1 - 32 * Math.SQRT2) < 12, `zoom 1 = ~1 px per model px (${z1})`);
  assert.ok(fit > 0 && fov > 0);
  assert.notEqual(e.run('model_render', { name: 'b', canvas: 'g4', camera: 'game', size: [96, 96], fov: 20 }).canvas, undefined);
});

test('art_model livery accepts stripes / hazard / decals / mark as documented, as JSON strings, and rejects bad shapes clearly', async () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 's', parts: [{ type: 'hull', length: 256, width: 64, height: 40 }] });
  const args = { stripes: [{ t: [0.6, 0.64], color: '#b8462e' }], hazard: [{ t: [0.2, 0.25] }], decals: [{ text: 'VK-07', t: 0.45 }], mark: { t: 0.18, seed: 11 } };
  const a = await json(e, 'art_model', { action: 'livery', name: 's', canvas: 'l1', ...args });
  assert.equal(a.canvas, 'l1');
  const strs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)]));
  await json(e, 'art_model', { action: 'livery', name: 's', canvas: 'l2', apply: false, ...strs });
  assert.deepEqual(e.get('l2').layers[0].data, e.get('l1').layers[0].data, 'stringified args paint the same livery');
  await assert.rejects(tool(e, 'art_model', { action: 'livery', name: 's', canvas: 'l3', stripes: [{ t: 0.6 }] }), /stripes\[0\]\.t must be \[a,b\]/);
  await assert.rejects(tool(e, 'art_model', { action: 'livery', name: 's', canvas: 'l3', decals: 'VK-07' }), /decals must be a list/);
  const t = (await import('../src/mcp.js')).TOOLS.find((x) => x.name === 'art_model').inputSchema.properties;
  for (const k of ['stripes', 'hazard', 'decals', 'mark']) assert.ok(t[k], k);
});

test('art_model fracture of a column (touching shells) gives watertight chunks', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'col', parts: [{ type: 'column', name: 'c', height: 96 }] });
  const r = e.run('model_fracture', { name: 'col', groups: [{ part: 'c', pieces: 6 }] });
  assert.equal(r.groups[0].watertight, true);
  assert.ok(r.groups[0].merged_shells > 1);
  assert.ok(r.groups[0].chunk_volume_error < 1e-3);
  // a single-shell box is untouched
  e.run('model_create', { name: 'bx', parts: [{ type: 'box', name: 'c', w: 32, h: 32, d: 32 }] });
  const b = e.run('model_fracture', { name: 'bx', groups: [{ part: 'c', pieces: 6 }] });
  assert.equal(b.groups[0].watertight, true);
  assert.equal(b.groups[0].merged_shells, undefined);
});

test('art_audio analyze view:"mix" returns the mix image + mix fields only; plain analyze keeps the full report', async () => {
  const e = new Engine({ home: tmp() });
  await tool(e, 'art_audio', { action: 'song', name: 'loop', text: 'tempo 140\nkey e phrygian\nloop all\ntrack g metal_guitar octave=2\ntrack drums metal_kit\nsection a 2\ng: @doom_riff style=chug bars=2\ndrums: @blast_beat style=blast bars=2' });
  const m = await tool(e, 'art_audio', { action: 'analyze', name: 'loop', view: 'mix' });
  const j = JSON.parse(text(m));
  assert.ok(m.some((c) => c.type === 'image'));
  assert.equal(j.view, 'mix');
  assert.ok(j.mix && j.mix.masking);
  for (const k of ['stats', 'report', 'perception']) assert.equal(j[k], undefined, k);
  const full = JSON.parse(text(await tool(e, 'art_audio', { action: 'analyze', name: 'loop' })));
  assert.ok(full.stats && full.report && full.perception.mix);
});

test('one-shot SFX overview image leaves out drum / feel / swing / style lines; music and loops keep them', () => {
  const p = { kind: 'sfx', rhythm: { kick_pattern: 'none', hats: 'none', drive_words: 'laid-back', swing: 0, timing_spread_ms: 3 }, timbre: { brightness: 'bright', distortion_words: 'clean', space: 'dry' }, genre: { ranking: [{ genre: 'rock', match: 0.2 }] } };
  const sfx = overviewFacts(p, false).join('|');
  assert.doesNotMatch(sfx, /DRUMS|FEEL|SWING|STYLE|HATS/);
  assert.match(sfx, /TONE: bright/);
  assert.match(overviewFacts(p, true).join('|'), /FEEL: laid-back/);
  assert.match(overviewFacts({ ...p, kind: 'music' }, false).join('|'), /DRUMS: none.*STYLE: rock/);
});

test('melee shield cell is at body scale (not a bug: a 92 cm shield on a 180 cm body)', () => {
  const c = meleeCell('riot_shield', [64, 96]);
  assert.deepEqual([c.w, c.h], [24, 45]);
  assert.match(helpText({ topic: 'melee', full: true }), /24x45 in a 64x96 frame/);
});

test('art_fp kit names the models it kept; a foreign model with a kit name is never overwritten silently', async () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'reflex', parts: [{ type: 'box', w: 8, h: 8, d: 8 }] });
  const r = await json(e, 'art_fp', { action: 'kit', guns: [], mags: [], items: [], attachments: ['reflex', 'suppressor'] });
  assert.deepEqual(r.created, ['suppressor']);
  assert.deepEqual(r.kept, ['reflex']);
  assert.match(r.warning, /reflex/);
  assert.equal(e.run('model_info', { name: 'reflex' }).parts_def.length, 1, 'the user model is untouched');
  const again = await json(e, 'art_fp', { action: 'kit', guns: [], mags: [], items: [], attachments: ['suppressor'] });
  assert.deepEqual(again.kept, ['suppressor']);
  assert.equal(again.warning, undefined);
  const o = await json(e, 'art_fp', { action: 'kit', guns: [], mags: [], items: [], attachments: ['reflex'], overwrite: true });
  assert.deepEqual(o.replaced, ['reflex']);
});

test('docs: planets-space skill keeps its steps and moves the code behind sections; gunship create summarises its parts', async () => {
  const short = skillText('planets-space');
  assert.ok(short.length < 4000, `${short.length}`);
  assert.match(short, /section:"<id>"/);
  assert.doesNotMatch(short, /ShaderMaterial/);
  assert.match(skillText('planets-space', { section: 'atmosphere' }), /ShaderMaterial/);
  assert.match(skillText('planets-space', { full: true }), /ShaderMaterial/);
  assert.throws(() => skillText('planets-space', { section: 'nope' }), /Unknown section nope/);
  const e = new Engine({ home: tmp() });
  assert.match(text(await tool(e, 'art_help', { skill: 'planets-space', section: 'night' })), /night/);
  const g = await json(e, 'art_model', { action: 'create', name: 'g', template: 'gunship' });
  assert.ok(g.parts.count > 600 && g.parts.types.hull && g.parts.heaviest.length === 5);
  assert.match(g.parts.all, /art_model info/);
  assert.equal(e.run('model_info', { name: 'g' }).parts.length, g.parts.count, 'info keeps every part');
  // small models keep the per-part list
  assert.ok(Array.isArray(e.run('model_create', { name: 'b', parts: [{ type: 'box' }] }).parts));
  const m = helpText({ topic: '3d', full: true });
  assert.match(m, /TOWARD the light/);
  assert.match(helpText({ op: 'iso_box' }), /gz = lift in screen px/);
});
