// Quality tooling: critique, shade, cells, rotsprite, scale2x, render sizing, docs/help.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { helpText, opUsage, SIGS } from '../src/docs.js';
import { COMMAND_NAMES } from '../src/doc.js';
import { SKILLS, skillFile } from '../src/skills.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-q-'));
const ids = (r) => r.issues.map((i) => i.id);

test('critique: flags noise, seams, pillow shading, animation drift; clean art passes', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'noisy', width: 16 });
  e.run('draw', { canvas: 'noisy', commands: [{ op: 'noise', colors: ['#202020', '#808080', '#e0e0e0', '#a04040'] }] });
  assert.ok(ids(e.run('critique', { canvas: 'noisy' })).includes('noisy'));
  e.run('create', { name: 'seam', width: 16 });
  e.run('draw', { canvas: 'seam', commands: [{ op: 'gradient', colors: ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'], direction: 'horizontal', dither: 'none' }] });
  assert.ok(ids(e.run('critique', { canvas: 'seam', kind: 'texture' })).includes('tiling_seam'));
  e.run('create', { name: 'cob', width: 16 });
  e.run('draw', { canvas: 'cob', commands: [{ op: 'cells', colors: ['#3a3a44', '#55555f', '#70707a', '#90909a'], gap_color: '#22222a', size: 5, seed: 3 }] });
  assert.ok(!ids(e.run('critique', { canvas: 'cob' })).includes('tiling_seam'));
  // pillow: brightness rings following the outline
  e.run('create', { name: 'pillow', width: 24 });
  e.run('draw', { canvas: 'pillow', commands: [
    { op: 'rect', x: 2, y: 2, w: 20, h: 20, color: '#402020' }, { op: 'rect', x: 4, y: 4, w: 16, h: 16, color: '#703030' },
    { op: 'rect', x: 7, y: 7, w: 10, h: 10, color: '#a04848' }, { op: 'rect', x: 10, y: 10, w: 4, h: 4, color: '#d07070' },
  ] });
  assert.ok(ids(e.run('critique', { canvas: 'pillow', kind: 'sprite' })).includes('pillow_shading'));
  // shaded with one light direction: no pillow
  e.run('create', { name: 'ball', width: 24 });
  e.run('draw', { canvas: 'ball', commands: [{ op: 'ellipse', x: 2, y: 2, w: 20, h: 20, color: '#703030' }, { op: 'shade', colors: ['#301010', '#502020', '#703030', '#a04848', '#d07070'] }, { op: 'outline', color: '#200808' }] });
  const ball = e.run('critique', { canvas: 'ball' });
  assert.ok(!ids(ball).includes('pillow_shading'), JSON.stringify(ball.issues));
  assert.ok(!ids(ball).includes('weak_outline'));
  // animation drift
  e.run('create', { name: 'anim', width: 16, frames: 3 });
  e.run('draw', { canvas: 'anim', frame: 0, commands: [{ op: 'rect', x: 4, y: 4, w: 8, h: 10, color: '#888' }] });
  e.run('draw', { canvas: 'anim', frame: 1, commands: [{ op: 'rect', x: 4, y: 4, w: 8, h: 10, color: '#888' }] });
  e.run('draw', { canvas: 'anim', frame: 2, commands: [{ op: 'rect', x: 1, y: 1, w: 14, h: 15, color: '#f0f' }, { op: 'rect', x: 2, y: 2, w: 4, h: 4, color: '#0ff' }, { op: 'rect', x: 8, y: 8, w: 4, h: 4, color: '#ff0' }] });
  const an = e.run('critique', { canvas: 'anim' });
  assert.ok(ids(an.animation).includes('volume_drift'));
  assert.ok(ids(an.animation).includes('duplicate_frames'));
  assert.ok(ids(an.animation).includes('palette_drift'));
});

test('shade: one light direction, full ramp, only of-colors', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 's', width: 24 });
  const ramp = ['#100000', '#400000', '#800000', '#c00000', '#ff0000'];
  e.run('draw', { canvas: 's', commands: [{ op: 'ellipse', x: 2, y: 2, w: 20, h: 20, color: '#800000' }, { op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#00ff00' }, { op: 'shade', colors: ramp, of: '#800000' }] });
  const used = new Set(e.run('info', { canvas: 's' }).colors.top.map((c) => c.color));
  for (const c of ramp) assert.ok(used.has(c), `ramp color ${c} used`);
  assert.ok(used.has('#00ff00'), 'other colors untouched');
  const lum = (x, y) => { const r = e.run('read', { canvas: 's', x, y, w: 1, h: 1 }); return parseInt(r.legend[r.rows[0]].slice(1, 3), 16); };
  assert.ok(lum(7, 7) > lum(16, 16), 'top-left lit, bottom-right dark');
  assert.throws(() => e.run('draw', { canvas: 's', commands: [{ op: 'shade', colors: ramp, of: '#123456' }] }), /no pixels to shade/);
});

test('rotate angle (rotsprite) and scale2x keep the palette', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'r', width: 24 });
  e.run('draw', { canvas: 'r', commands: [{ op: 'rect', x: 10, y: 4, w: 4, h: 16, color: '#c0c0c0', outline: '#202020' }] });
  const before = e.run('info', { canvas: 'r' }).colors.unique;
  const r = e.run('draw', { canvas: 'r', commands: [{ op: 'rotate', angle: 45 }] });
  assert.match(r.notes.join(), /rotated 45/);
  const info = e.run('info', { canvas: 'r' });
  assert.ok(info.colors.unique <= before, 'no new colors');
  assert.equal(e.run('read', { canvas: 'r', x: 12, y: 2, w: 1, h: 1 }).rows[0], '.', 'top of the bar moved away');
  e.run('create', { name: 'u', width: 8, frames: 2 });
  e.run('draw', { canvas: 'u', frame: 1, commands: [{ op: 'ellipse', x: 1, y: 1, w: 6, h: 6, color: '#0a0' }] });
  e.run('transform', { canvas: 'u', action: 'scale', factor: 4, method: 'scale2x' });
  const d = e.get('u');
  assert.deepEqual([d.width, d.height, d.frameHeight], [32, 64, 32]);
  assert.equal(e.run('read', { canvas: 'u', frame: 0, x: 0, y: 28, w: 32, h: 4 }).rows.join('').replace(/\./g, ''), '', 'frame 0 stays empty (no bleed)');
  assert.throws(() => e.run('transform', { canvas: 'u', action: 'scale', factor: 5, method: 'scale2x' }), /factor 2, 3, 4, 6 or 8/);
});

test('render: small canvases stay small, big ones become downsampled overviews', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'tiny', width: 16 });
  const t = e.run('render', { canvas: 'tiny' });
  assert.equal(decodePNG(t.image).width, 256);
  e.run('create', { name: 'big', width: 1600, height: 900, background: '#335' });
  const b = e.run('render', { canvas: 'big' });
  assert.equal(b.scale, '1/4');
  assert.ok(decodePNG(b.image).width <= 512);
  const z = e.run('render', { canvas: 'big', x: 0, y: 0, w: 32, h: 32 });
  assert.equal(z.scale, 16);
});

test('draw feedback: unknown fields noted, errors carry usage', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'c', width: 8 });
  const r = e.run('draw', { canvas: 'c', commands: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#fff', colour: '#f00' }] });
  assert.match(r.notes.join(), /unknown field\(s\) colour/);
  assert.throws(() => e.run('draw', { canvas: 'c', commands: [{ op: 'shade', colors: ['#000'] }] }), (err) => /usage: shade/.test(err.message) && /example:/.test(err.message));
});

test('docs: every command has a signature and usage; help topics and skills resolve', () => {
  for (const op of COMMAND_NAMES) {
    assert.ok(SIGS[op], `SIGS missing ${op}`);
    assert.ok(opUsage(op).includes('example:'), `example missing for ${op}`);
  }
  assert.match(helpText({}), /Topics:/);
  assert.match(helpText({ topic: 'textures' }), /cells/);
  assert.throws(() => helpText({ topic: 'nope' }), /Unknown topic/);
  for (const k of Object.keys(SKILLS)) assert.match(skillFile(k), /^---\nname: agent-art-/);
});

test('mcp: help tool, prompts and compact tool list', async () => {
  const home = tmp();
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'mcp'], { env: { ...process.env, AGENT_ART_HOME: home, AGENT_ART_PORT: '1' } });
  const replies = new Map();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'art_help', arguments: { op: 'cells' } } });
  send({ id: 4, method: 'prompts/list' });
  send({ id: 5, method: 'prompts/get', params: { name: 'tileable-texture' } });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  assert.ok(replies.get(1).result.capabilities.prompts);
  const tools = replies.get(2).result.tools;
  const size = JSON.stringify(tools).length;
  assert.ok(size < 40235, `tool list ${size} chars`); // 39380 before ships & structures (art_model kit / livery / generate / budget / walk_check actions, kind, hull, mood, static, split, walk, budget, class, ships-structures skill, +~0.85k, 40005 measured); 38650 before mesh processing (boolean/remesh/decimate/cluster_lod/visibility, +~0.75k, 39151 measured); 37900 before materials v2 (material action, profile/packing/tangents/lightmap/probes/thickness/vertex_colors/uv2/uv3/channel/pom, +~0.74k, 38406 measured); 37280 before art_rig 2D skinning (+~0.62k, 37669 measured); 36850 before art_model skinning (skeleton/skin/weights, +~0.43k, 37048 measured); 35640 before art_cleanup (+~1.15k, 36618 measured); 34800 before hand-drawn fp sources (art_fp template/anchors/sweep2d/trace + properties, +~0.84k, 35473 measured); 33200 before art_fp (first-person viewmodels: kit/sweep/batch/composite/check/paint, +~1.6k, 34634 measured); 32650 before runtime weapon layers (art_anim weapon/conform/weapon_sheet/composite/weapon_check + properties, +~0.6k); 31400 before art_planet merged with the animation library (32417 measured); 29500 before art_anim (art_planet alone +~1.15k); 28380 before the animation library (new art_anim tool: skeleton/clip/skin/retarget/render/batch/gltf; art_rig consistency/derive/zcheck/debug_render, depth/stable/events/tag; art_animation layout files: 31271 measured); 27400 before hard-surface detail + render cost (art_model trim action, bake_ao, lods, impostor, collision, occluder, stats, preview ao/lod/morph, merge/morphs/cull, hard-surface skill: 28133 measured); 26100 before weapon handling merged with art_graph + art_review (27159 measured); 24700 before art_graph + art_review (+~2.7k); 23350 before weapon handling (+~1.2k); 21800 before art_model rigs/clips/render + art_rig ik_from (+~1.57k, 23157 measured); 17000 before art_model (+~2k), 19000 before art_audio (+~1.4k), 20560 before the ship kit part schema (+~0.5k), 21100 before canvas options (commands_file, keep_visible, json) and sfx fx/reverb/target/loop/tail/names (+~0.4k) and rig hd params (+~180)
  assert.ok(tools.some((t) => t.name === 'art_critique'));
  assert.match(replies.get(3).result.content[0].text, /^cells \{/);
  assert.ok(replies.get(4).result.prompts.length >= 5);
  assert.match(replies.get(5).result.messages[0].content.text, /cells/);
});
