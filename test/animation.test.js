import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { encodeGIF } from '../src/gif.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-a-'));
const px = (e, canvas, x, y, frame) => {
  const r = e.run('read', { canvas, x, y, w: 1, h: 1, frame });
  return r.legend[r.rows[0]];
};

/** Minimal GIF decoder (indices + global palette per frame) to verify the encoder. */
function decodeGIF(buf) {
  let p = 6;
  const W = buf.readUInt16LE(p), H = buf.readUInt16LE(p + 2), flags = buf[p + 4];
  p += 7;
  const gct = flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0;
  const palette = buf.subarray(p, p + gct);
  p += gct;
  const frames = [];
  while (buf[p] !== 0x3b) {
    if (buf[p] === 0x21) { p += 2; while (buf[p]) p += buf[p] + 1; p++; continue; }
    if (buf[p] !== 0x2c) throw new Error('bad block ' + buf[p]);
    p += 10;
    const minCode = buf[p++];
    const data = [];
    while (buf[p]) { data.push(...buf.subarray(p + 1, p + 1 + buf[p])); p += buf[p] + 1; }
    p++;
    const clear = 1 << minCode, eoi = clear + 1;
    let size, dict, next, prev;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; size = minCode + 1; next = eoi + 1; prev = null; };
    reset();
    const out = [];
    let bitPos = 0;
    const read = () => { let v = 0; for (let i = 0; i < size; i++, bitPos++) v |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i; return v; };
    for (;;) {
      const code = read();
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let entry;
      if (dict[code]) entry = dict[code];
      else if (code === next && prev) entry = [...prev, prev[0]];
      else throw new Error('bad code ' + code);
      out.push(...entry);
      if (prev && next < 4096) { dict[next++] = [...prev, entry[0]]; if (next === 1 << size && size < 12) size++; }
      prev = entry;
    }
    frames.push(out);
  }
  return { W, H, palette, frames };
}

test('gif encoder round-trips through an LZW decoder', () => {
  const w = 37, h = 23;
  const mk = (seed) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = (i * seed * 7 + (i >> 3)) % 90;
      if (v < 10) continue; // transparent
      d.set([v * 2, (v * 5) % 256, (v * 11) % 256, 255], i * 4);
    }
    return d;
  };
  const frames = [mk(1), mk(3), mk(5)].map((data) => ({ data, delay: 80 }));
  const g = decodeGIF(encodeGIF(w, h, frames));
  assert.equal(g.W, w);
  assert.equal(g.frames.length, 3);
  frames.forEach((f, k) => {
    assert.equal(g.frames[k].length, w * h);
    for (let i = 0; i < w * h; i++) {
      const idx = g.frames[k][i];
      if (f.data[i * 4 + 3] < 128) assert.equal(idx, 0);
      else assert.deepEqual([...g.palette.subarray(idx * 3, idx * 3 + 3)], [...f.data.subarray(i * 4, i * 4 + 3)]);
    }
  });
  // large image exercises dictionary resets at 4096 codes
  const big = new Uint8ClampedArray(200 * 200 * 4);
  for (let i = 0; i < 200 * 200; i++) big.set([(i * 37) % 251, (i * 91) % 241, (i * 13) % 199, 255], i * 4);
  const gb = decodeGIF(encodeGIF(200, 200, [{ data: big, delay: 100 }]));
  assert.equal(gb.frames[0].length, 40000);
});

test('frame ops, tags, filmstrip, exports', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'hero', width: 8, height: 8 });
  e.run('draw', { canvas: 'hero', commands: [{ op: 'rect', color: '#f00' }] });
  e.run('animation', { canvas: 'hero', action: 'insert', count: 3, copy_from: 0 });
  assert.equal(e.run('info', { canvas: 'hero' }).frames, 4);
  e.run('draw', { canvas: 'hero', frame: 2, commands: [{ op: 'rect', color: '#00f' }] });
  const r = e.run('draw', { canvas: 'hero', frame: 3, commands: [{ op: 'pixels', points: [[1, 2, '#0f0']] }] });
  assert.deepEqual(r.dirty, { x: 1, y: 26, w: 1, h: 1 });
  assert.deepEqual(r.frames, { first: 3, last: 3, local: { x: 1, y: 2, w: 1, h: 1 } });
  e.run('animation', { canvas: 'hero', action: 'tag', name: 'walk', from: 0, to: 3, duration: 120, direction: 'pingpong' });
  e.run('animation', { canvas: 'hero', action: 'tag', name: 'idle', frames: [0, 2], durations: [300, 200] });
  e.run('animation', { canvas: 'hero', action: 'move', frame: 2, to: 0 });
  assert.equal(px(e, 'hero', 0, 0, 0), '#0000ff');
  assert.deepEqual(e.run('animation', { canvas: 'hero', action: 'list' }).animations.idle.frames, [1, 0]);
  e.run('animation', { canvas: 'hero', action: 'delete', frame: 3 });
  assert.equal(e.run('animation', { canvas: 'hero', action: 'list' }).animations.walk.frames.length, 3);
  const fs1 = e.run('filmstrip', { canvas: 'hero', animation: 'walk' });
  assert.equal(fs1.frames.length, 4); // pingpong 0,1,2,1
  assert.ok(decodePNG(fs1.image).width > 8);
  const gif = e.run('export_animation', { canvas: 'hero', animation: 'walk', format: 'gif', scale: 2 });
  assert.equal(decodeGIF(fs.readFileSync(gif.file)).frames.length, 4);
  const sh = e.run('export_animation', { canvas: 'hero', format: 'spritesheet' });
  const meta = JSON.parse(fs.readFileSync(sh.json, 'utf8'));
  assert.equal(meta.meta.frameTags.length, 2);
  assert.equal(decodePNG(fs.readFileSync(sh.png)).height, 16);
  const v = e.run('render', { canvas: 'hero', frame: 1, onion: 1 });
  assert.ok(decodePNG(v.image).width >= 8);
  e.run('undo', { canvas: 'hero', steps: 2 });
  assert.equal(e.run('info', { canvas: 'hero' }).frames, 4);
  e.flush();
  assert.ok(new Engine({ home }).get('hero').animations.walk);
});

test('blend modes, layer masks, grid cpp, remap errors, copy scale/tint', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'b', width: 4, height: 4, background: '#808080', palette: { s1: '#ff0000', s2: '#00ff00' } });
  e.run('layer', { canvas: 'b', action: 'add', name: 'shade' });
  e.run('layer', { canvas: 'b', action: 'blend', layer: 'shade', blend: 'multiply' });
  e.run('draw', { canvas: 'b', layer: 'shade', commands: [{ op: 'rect', color: '#808080' }] });
  assert.equal(px(e, 'b', 0, 0), '#404040');
  e.run('layer', { canvas: 'b', action: 'blend', layer: 'shade', blend: 'screen' });
  assert.equal(px(e, 'b', 0, 0), '#c0c0c0');
  e.run('create', { name: 'm', width: 4, height: 1 });
  e.run('draw', { canvas: 'm', commands: [{ op: 'pixels', points: [[1, 0, '#fff']] }] });
  e.run('layer', { canvas: 'm', action: 'add', name: 'top' });
  e.run('draw', { canvas: 'm', layer: 'top', commands: [{ op: 'rect', color: '#f00', mask: 'layer:base' }] });
  assert.equal(e.run('read', { canvas: 'm', layer: 'top' }).rows[0].replace(/[^.]/g, '#'), '.#..');
  e.run('draw', { canvas: 'b', layer: 'base', commands: [{ op: 'grid', cpp: 2, rows: ['s1..s2'] }] });
  e.run('layer', { canvas: 'b', action: 'visibility', layer: 'shade', visible: false });
  assert.equal(px(e, 'b', 0, 0), '#ff0000');
  assert.equal(px(e, 'b', 1, 0), '#808080');
  assert.equal(px(e, 'b', 2, 0), '#00ff00');
  assert.throws(() => e.run('draw', { canvas: 'b', commands: [{ op: 'remap', map: { '#123456': '#000' } }] }), /Colors present/);
  e.run('create', { name: 'c', width: 8, height: 8 });
  e.run('draw', { canvas: 'c', commands: [{ op: 'copy', from_canvas: 'b', x: 0, y: 0, w: 2, h: 1, to_x: 0, to_y: 0, scale: 2, tint: '#808080' }] });
  const rr = e.run('read', { canvas: 'c', x: 0, y: 0, w: 4, h: 2 });
  assert.equal(rr.legend[rr.rows[1][1]], '#800000');
  assert.equal(rr.rows[0][3], rr.rows[1][2]);
});

test('effects and iso shapes produce sensible pixels', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'fx', width: 32, height: 32, background: '#202030' });
  e.run('draw', { canvas: 'fx', commands: [
    { op: 'light', x: 16, y: 16, radius: 10, color: '#ffcc66', intensity: 0.8 },
    { op: 'fog', to: 0.5, color: '#8899aa' },
    { op: 'vignette', strength: 0.8 },
    { op: 'rays', x: 0, y: 0, angle: 45, spread: 30, count: 3, color: '#ffffff', alpha: 0.5 },
    { op: 'glow', threshold: 0.4, radius: 2 },
    { op: 'blur', radius: 1, x: 0, y: 0, w: 8, h: 8 },
    { op: 'quantize', colors: ['#202030', '#ffcc66', '#8899aa', '#000000', '#ffffff'], dither: 'bayer' },
  ] });
  const st = e.run('info', { canvas: 'fx' }).colors;
  assert.ok(st.unique <= 5 && st.unique >= 3, `unique ${st.unique}`);
  e.run('create', { name: 'iso', width: 64, height: 64 });
  e.run('draw', { canvas: 'iso', commands: [
    { op: 'iso_tile', at: [0, 0, 0], tile: 32, origin: [32, 20], color: '#6a5' },
    { op: 'iso_box', x: 16, y: 0, w: 32, height: 12, top: '#c96', outline: '#302020' },
  ] });
  assert.ok(e.run('info', { canvas: 'iso' }).colors.unique >= 4);
  const rd = e.run('read', { canvas: 'iso', x: 16, y: 0, w: 32, h: 1 });
  assert.equal(rd.rows[0].replace(/[^.]/g, '#'), '..............####..............');
  e.run('layer', { canvas: 'iso', action: 'add', name: 'obj' });
  e.run('draw', { canvas: 'iso', layer: 'obj', commands: [{ op: 'rect', x: 40, y: 40, w: 4, h: 8, color: '#fff' }] });
  e.run('draw', { canvas: 'iso', layer: 'base', commands: [{ op: 'cast_shadow', from_layer: 'obj', dx: 3, dy: 0, squash: 0.5, color: '#000000aa' }] });
  assert.notEqual(e.run('read', { canvas: 'iso', layer: 'base', x: 43, y: 47, w: 1, h: 1 }).rows[0], '.');
  const nm = e.run('normal_map', { canvas: 'iso' });
  assert.equal(nm.created, 'iso_n');
  assert.equal(e.get('iso_n').meta.build, false);
});

test('sheet: name-only filter, exclude, mixed sizes, tile, tint, paging', () => {
  const e = new Engine({ home: tmp() });
  e.run('project_create', { name: 'p' });
  for (const n of ['lava', 'stone', 'dirt']) e.run('create', { name: n, project: 'p', meta: { texture: `blocks/${n === 'stone' ? 'lava_like' : n}` } });
  e.run('create', { name: 'big', project: 'p', width: 256 });
  e.run('create', { name: 'grass', project: 'p', background: '#ffffff', meta: { tint: '#00ff00' } });
  assert.equal(e.run('sheet', { project: 'p', exclude: '^lava' }).count, 4);
  assert.deepEqual(e.run('sheet', { project: 'p', filter: 'lava' }).names, ['lava']);
  assert.deepEqual(e.run('sheet', { project: 'p', texture_filter: 'lava' }).names.sort(), ['lava', 'stone']);
  const s = e.run('sheet', { project: 'p', labels: false, scale: 4 });
  assert.equal(s.cell, 128); // common size (16) x 4, doubled to give the 256px canvas room — not 256 x 4
  assert.deepEqual(s.tinted, ['grass']);
  assert.equal(e.run('sheet', { project: 'p', offset: 3, limit: 10 }).count, 2);
  assert.equal(e.run('sheet', { project: 'p', tile: 3, scale: 2, filter: 'dirt' }).cell, 96);
  const img = decodePNG(e.run('render', { canvas: 'grass', apply_tint: true, scale: 1, grid: false }).image);
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 255, 0, 255]);
});

test('cli batch + stdin args', () => {
  const home = tmp();
  const env = { ...process.env, AGENT_ART_HOME: home, AGENT_ART_PORT: '1' };
  const bin = path.join(ROOT, 'bin', 'agent-art.js');
  const batch = [
    { op: 'create', args: { name: 'k', width: 4 } },
    { op: 'draw', args: { canvas: 'k', commands: [{ op: 'rect', color: '#abc' }] } },
    { op: 'render', args: { canvas: 'k' }, out: 'k.png' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const outDir = tmp();
  const out = execFileSync(process.execPath, [bin, 'batch', '-', '--out-dir', outDir], { input: batch, env, encoding: 'utf8' });
  assert.match(out, /\[2\] render ok/);
  assert.ok(fs.existsSync(path.join(outDir, 'k.png')));
  const o2 = execFileSync(process.execPath, [bin, 'op', 'read', '-'], { input: '{"canvas":"k","w":1,"h":1}', env, encoding: 'utf8' });
  assert.match(o2, /#aabbcc/);
});

test('crop on a frame strip crops every frame and keeps frames, animations and anchors', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'cs', width: 8, height: 8, frames: 3 });
  for (let f = 0; f < 3; f++) e.run('draw', { canvas: 'cs', frame: f, commands: [{ op: 'pixels', points: [[2 + f, 3]], color: '#ff0000' }] });
  e.run('animation', { canvas: 'cs', action: 'tag', name: 'run', from: 0, to: 2, duration: 80 });
  e.get('cs').meta.anchors = { run: [{ hand: [4, 5, 0] }, { hand: [5, 5, 0] }, { hand: [6, 5, 0] }] };
  const info = e.run('transform', { canvas: 'cs', action: 'crop', x: 1, y: 2, w: 5, h: 4 });
  assert.equal(info.frames, 3);
  assert.equal(info.frameHeight, 4);
  assert.equal(info.width, 5);
  assert.equal(info.height, 12);
  assert.deepEqual(info.animations.run.frames, [0, 1, 2]);
  for (let f = 0; f < 3; f++) assert.equal(px(e, 'cs', 1 + f, 1, f), '#ff0000', `frame ${f} content moved by the crop offset`);
  assert.deepEqual(e.get('cs').meta.anchors.run[0].hand, [3, 3, 0]);
  // export still sees 3 frames
  const sh = e.run('export_animation', { canvas: 'cs', format: 'spritesheet', animation: 'run' });
  assert.equal(decodePNG(fs.readFileSync(sh.png)).width, 15);
});

test('rotate expand grows every frame and keeps rotated content', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 're', width: 8, height: 8, frames: 2 });
  e.run('draw', { canvas: 're', frame: 0, commands: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, color: '#00ff00' }] });
  e.run('draw', { canvas: 're', frame: 1, commands: [{ op: 'pixels', points: [[0, 0]], color: '#0000ff' }] });
  const count = (d, f) => { let n = 0; const fh = d.frameHeight; for (let y = 0; y < fh; y++) for (let x = 0; x < d.width; x++) if (d.layers[0].data[((f * fh + y) * d.width + x) * 4 + 3]) n++; return n; };
  // default: a 6x6 square rotated 45° in an 8x8 frame loses its corners
  const e2 = new Engine({ home: tmp() });
  e2.run('create', { name: 'r', width: 8, height: 8 });
  e2.run('draw', { canvas: 'r', commands: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, color: '#00ff00' }, { op: 'rotate', angle: 45 }] });
  const cut = count(e2.get('r'), 0);
  const r = e.run('draw', { canvas: 're', frame: 0, commands: [{ op: 'rotate', angle: 45, expand: true }] });
  const d = e.get('re');
  assert.ok(d.width > 8 && d.frameHeight > 8, `grew to ${d.width}x${d.frameHeight}`);
  assert.equal(d.frames, 2);
  assert.equal(d.width, d.frameHeight, 'symmetric growth around the centre');
  assert.ok(count(d, 0) > cut, `expand keeps more pixels (${count(d, 0)} vs ${cut})`);
  assert.match(r.notes.join(' '), /expanded/);
  // frame 1 is padded, not shifted into frame 0
  const pad = (d.width - 8) / 2;
  assert.equal(px(e, 're', pad, pad, 1), '#0000ff');
  // 90° in a big enough canvas: no growth
  const e3 = new Engine({ home: tmp() });
  e3.run('create', { name: 'q', width: 8, height: 8 });
  e3.run('draw', { canvas: 'q', commands: [{ op: 'rect', x: 3, y: 3, w: 2, h: 2, color: '#ff0000' }, { op: 'rotate', angle: 90, expand: true }] });
  assert.equal(e3.get('q').width, 8);
  // undo restores the old size
  e.run('undo', { canvas: 're' });
  assert.equal(e.get('re').width, 8);
});

test('spritesheet json:false writes only the png', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'sj', width: 4, height: 4, frames: 2 });
  e.run('draw', { canvas: 'sj', commands: [{ op: 'rect', color: '#123456' }] });
  const out = path.join(tmp(), 'sheet');
  const r = e.run('export_animation', { canvas: 'sj', format: 'spritesheet', path: out, json: false });
  assert.ok(fs.existsSync(out + '.png'));
  assert.ok(!fs.existsSync(out + '.json'));
  assert.equal(r.json, undefined);
  const r2 = e.run('export_animation', { canvas: 'sj', format: 'spritesheet', path: out });
  assert.ok(fs.existsSync(r2.json), 'default still writes the json');
});
