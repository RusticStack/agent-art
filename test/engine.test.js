import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { encodePNG, decodePNG, crc32 } from '../src/png.js';
import { parseColor, makeRamp } from '../src/color.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-'));

test('png roundtrip', () => {
  const data = new Uint8ClampedArray(3 * 2 * 4).map((_, i) => (i * 37) % 256);
  const img = decodePNG(encodePNG(3, 2, data));
  assert.equal(img.width, 3);
  assert.deepEqual([...img.data], [...data]);
});

test('png decode palette + tRNS', () => {
  // build a 2x1 indexed PNG by hand
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 3;
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])), chunk('tRNS', Buffer.from([0])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 1]))), chunk('IEND', Buffer.alloc(0))]);
  const img = decodePNG(png);
  assert.deepEqual([...img.data], [255, 0, 0, 0, 0, 0, 255, 255]);
});

test('colors and ramps', () => {
  assert.deepEqual(parseColor('#f00'), [255, 0, 0, 255]);
  assert.deepEqual(parseColor('#00ff0080'), [0, 255, 0, 128]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.deepEqual(parseColor('a', { a: '#123456' }), [0x12, 0x34, 0x56, 255]);
  const r = makeRamp('#7a7a7a', { steps: 5 });
  assert.equal(r.length, 5);
  const lum = (h) => parseColor(h).slice(0, 3).reduce((a, b) => a + b);
  for (let i = 1; i < r.length; i++) assert.ok(lum(r[i]) > lum(r[i - 1]), 'ramp goes dark -> light');
});

test('draw commands, undo, read, persistence', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 't', width: 8, height: 8, palette: { a: '#ff0000', b: '#0000ff' } });
  e.run('draw', { canvas: 't', commands: [
    { op: 'rect', x: 0, y: 0, w: 8, h: 8, color: 'a' },
    { op: 'grid', x: 1, y: 1, rows: ['b.b', '.b.'] },
    { op: 'pixels', points: [[7, 7, '#00ff00']] },
  ] });
  const rd = e.run('read', { canvas: 't', x: 0, y: 0, w: 4, h: 3 });
  assert.deepEqual(rd.rows, ['aaaa', 'abab', 'aaba']);
  e.run('draw', { canvas: 't', commands: [{ op: 'clear' }] });
  assert.equal(e.run('read', { canvas: 't', w: 1, h: 1 }).rows[0], '.');
  e.run('undo', { canvas: 't' });
  assert.equal(e.run('read', { canvas: 't', w: 1, h: 1 }).rows[0], 'a');
  e.run('undo', { canvas: 't', redo: true });
  e.run('undo', { canvas: 't' });
  // atomic failure leaves canvas unchanged
  assert.throws(() => e.run('draw', { canvas: 't', commands: [{ op: 'rect', color: 'b' }, { op: 'bogus' }] }), /command #1/);
  assert.equal(e.run('read', { canvas: 't', w: 1, h: 1 }).rows[0], 'a');
  e.flush();
  const e2 = new Engine({ home });
  assert.deepEqual(e2.run('read', { canvas: 't', x: 0, y: 0, w: 4, h: 3 }).rows, ['aaaa', 'abab', 'aaba']);
  const info = e2.run('info', { canvas: 't' });
  assert.equal(info.colors.unique, 3);
});

test('fill, mask, symmetry, noise weights, shift wrap', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'm', width: 6, height: 6 });
  e.run('draw', { canvas: 'm', commands: [
    { op: 'rect', x: 1, y: 1, w: 4, h: 4, fill: false, color: '#000' },
    { op: 'fill', x: 2, y: 2, color: '#fff' },
  ] });
  let r = e.run('read', { canvas: 'm' });
  assert.equal(r.rows[2], '.ABBA.'.replace(/A/g, r.rows[1][1]).replace(/B/g, r.rows[2][2]));
  e.run('draw', { canvas: 'm', commands: [{ op: 'rect', color: '#f00', mask: 'transparent' }] });
  r = e.run('read', { canvas: 'm' });
  assert.notEqual(r.rows[0][0], '.');
  assert.equal(r.legend[r.rows[2][2]], '#ffffff');

  e.run('create', { name: 's', width: 5, height: 1 });
  e.run('draw', { canvas: 's', commands: [{ op: 'pixels', symmetry: 'x', points: [[0, 0, '#123']] }] });
  r = e.run('read', { canvas: 's' });
  assert.equal(r.rows[0][0], r.rows[0][4]);
  e.run('draw', { canvas: 's', commands: [{ op: 'shift', dx: 1 }] });
  r = e.run('read', { canvas: 's' });
  assert.equal(r.rows[0], `${r.rows[0][0]}${r.rows[0][0]}...`);

  e.run('create', { name: 'n', width: 16, height: 16 });
  e.run('draw', { canvas: 'n', commands: [{ op: 'noise', colors: ['#000', '#fff'], weights: [3, 1], scale: 4, octaves: 2 }] });
  const stats = e.run('info', { canvas: 'n' }).colors.top;
  assert.equal(stats.find((s) => s.color === '#000000').count, 192);
});

test('frames, minecraft pack and zip', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'lava', width: 4, height: 4, frames: 3, background: '#f80' });
  e.run('draw', { canvas: 'lava', frame: 1, commands: [{ op: 'rect', color: '#f00' }] });
  const f1 = e.run('read', { canvas: 'lava', frame: 1 });
  assert.equal(f1.rows.length, 4);
  assert.equal(f1.legend[f1.rows[0][0]], '#ff0000');
  assert.equal(e.run('read', { canvas: 'lava', frame: 0 }).legend[e.run('read', { canvas: 'lava', frame: 0 }).rows[0][0]], '#ff8800');
  e.run('pack_init', { pack: 'mypack', description: 'test' });
  const added = e.run('pack_add', { pack: 'mypack', canvas: 'lava', texture: 'block/lava_still', frametime: 3 });
  assert.equal(added.written.length, 2);
  const meta = JSON.parse(fs.readFileSync(added.written[1], 'utf8'));
  assert.equal(meta.animation.frametime, 3);
  const png = decodePNG(fs.readFileSync(added.written[0]));
  assert.equal(png.height, 12);
  const z = e.run('pack_zip', { pack: 'mypack' });
  assert.equal(z.files, 3);
  assert.equal(fs.readFileSync(z.zip).readUInt32LE(0), 0x04034b50);
  // re-import detects frames from .mcmeta
  const imp = e.run('import', { path: added.written[0], canvas: 'lava2' });
  assert.equal(imp.created.frames, 3);
});

test('render produces an upscaled png', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'r', width: 16, height: 16, background: '#00f' });
  const v = e.run('render', { canvas: 'r', tile: 3 });
  const img = decodePNG(v.image);
  assert.equal(img.width, 16 * 3 * v.scale);
});

test('mcp stdio handshake and tool call', async () => {
  const home = tmp();
  const port = 17000 + Math.floor(Math.random() * 2000);
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'mcp', '--port', String(port), '--home', home], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const waitFor = async (id) => {
    for (let k = 0; k < 100; k++) {
      const m = lines.find((l) => l.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal((await waitFor(1)).result.serverInfo.name, 'agent-art');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await waitFor(2)).result.tools.map((t) => t.name);
    assert.ok(tools.includes('art_draw') && tools.includes('art_view'));
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'art_create_canvas', arguments: { name: 'x', width: 4 } } });
    assert.ok(!(await waitFor(3)).result.isError);
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'art_draw', arguments: { canvas: 'x', preview: true, commands: [{ op: 'rect', color: '#0f0' }] } } });
    const r4 = (await waitFor(4)).result;
    assert.equal(r4.content[1].type, 'image');
    // the live UI server is up and serves the canvas
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.app, 'agent-art');
    const bad = await fetch(`http://127.0.0.1:${port}/api/op`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(bad.status, 403);
  } finally {
    p.kill();
  }
});

const rgba = (e, c, x, y, layer = 0) => { const d = e.get(c); const p = (y * d.width + x) * 4; return [...d.layers[layer].data.slice(p, p + 4)]; };
const opaque = (e, c, layer = 0) => { const d = e.get(c); let n = 0; for (let i = 3; i < d.layers[layer].data.length; i += 4) if (d.layers[layer].data[i]) n++; return n; };

test('outline is idempotent: re-running does not double it (skip_existing)', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'ol', width: 12, height: 12 });
  e.run('draw', { canvas: 'ol', commands: [{ op: 'rect', x: 4, y: 4, w: 4, h: 4, color: '#ff0000' }, { op: 'outline', color: '#101010' }] });
  const once = opaque(e, 'ol');
  assert.equal(once, 16 + 16);
  const r = e.run('draw', { canvas: 'ol', commands: [{ op: 'outline', color: '#101010' }] });
  assert.equal(opaque(e, 'ol'), once, 'second run adds nothing');
  assert.match(r.notes.join(' '), /skip_existing:false/);
  // gaps in an existing outline still get filled
  e.run('draw', { canvas: 'ol', commands: [{ op: 'clear', x: 5, y: 3, w: 1, h: 1 }, { op: 'outline', color: '#101010' }] });
  assert.deepEqual(rgba(e, 'ol', 5, 3), [16, 16, 16, 255]);
  assert.equal(opaque(e, 'ol'), once);
  // explicit skip_existing:false restores the old behaviour (second ring)
  e.run('draw', { canvas: 'ol', commands: [{ op: 'outline', color: '#101010', skip_existing: false }] });
  assert.ok(opaque(e, 'ol') > once);
});

test('clear without region clears the whole layer (or frame); stamp_visible keep_visible', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'cl', width: 6, height: 6, frames: 2 });
  e.run('draw', { canvas: 'cl', commands: [{ op: 'rect', color: '#00ff00' }] });
  e.run('draw', { canvas: 'cl', frame: 1, commands: [{ op: 'clear' }] });
  assert.equal(opaque(e, 'cl'), 36, 'only frame 1 cleared');
  e.run('draw', { canvas: 'cl', commands: [{ op: 'clear' }] });
  assert.equal(opaque(e, 'cl'), 0);
  e.run('create', { name: 'st', width: 4, height: 4 });
  e.run('draw', { canvas: 'st', commands: [{ op: 'rect', color: '#ff0000' }] });
  e.run('layer', { canvas: 'st', action: 'stamp_visible', keep_visible: true });
  assert.ok(e.get('st').layers.every((l) => l.visible), 'source layers stay visible');
  e.run('layer', { canvas: 'st', action: 'stamp_visible' });
  assert.equal(e.get('st').layers.filter((l) => l.visible).length, 1, 'default still hides the others');
});

test('ellipse thickness and 5x7 / 7x9 text fonts', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'el', width: 20, height: 20 });
  e.run('draw', { canvas: 'el', commands: [{ op: 'ellipse', x: 0, y: 0, w: 20, h: 20, color: '#ffffff', fill: false }] });
  const thin = opaque(e, 'el');
  e.run('draw', { canvas: 'el', commands: [{ op: 'clear' }, { op: 'ellipse', x: 0, y: 0, w: 20, h: 20, color: '#ffffff', fill: false, thickness: 3 }] });
  const thick = opaque(e, 'el');
  assert.ok(thick > thin * 2.2 && thick < thin * 3.5, `thickness 3 ring ${thick} vs 1 px ${thin}`);
  assert.equal(rgba(e, 'el', 10, 2)[3], 255, 'third ring pixel painted');
  assert.equal(rgba(e, 'el', 10, 3)[3], 0, 'inside stays empty');
  assert.equal(rgba(e, 'el', 10, 10)[3], 0);
  // fonts: width per glyph + spacing, height from the font
  e.run('create', { name: 'tx', width: 80, height: 12 });
  const bbox = () => { const d = e.get('tx'); let x1 = -1, y1 = -1; for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.layers[0].data[(y * d.width + x) * 4 + 3]) { x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x1 + 1, y1 + 1]; };
  e.run('draw', { canvas: 'tx', commands: [{ op: 'text', x: 0, y: 0, text: 'HE', color: '#fff' }] });
  assert.deepEqual(bbox(), [7, 5], 'default 3x5');
  e.run('draw', { canvas: 'tx', commands: [{ op: 'clear' }, { op: 'text', x: 0, y: 0, text: 'HE', color: '#fff', font: '5x7' }] });
  assert.deepEqual(bbox(), [11, 7]);
  e.run('draw', { canvas: 'tx', commands: [{ op: 'clear' }, { op: 'text', x: 0, y: 0, text: 'HE', color: '#fff', font: '7x9' }] });
  assert.deepEqual(bbox(), [15, 9]);
  assert.throws(() => e.run('draw', { canvas: 'tx', commands: [{ op: 'text', text: 'A', color: '#fff', font: '9x9' }] }), /font must be one of/);
  // every glyph exists in both new fonts, all rows the font height
  for (const font of ['5x7', '7x9']) {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?-:/()+=#%*&@') {
      e.run('draw', { canvas: 'tx', commands: [{ op: 'clear' }, { op: 'text', x: 0, y: 0, text: ch, color: '#fff', font }] });
      assert.ok(opaque(e, 'tx') > 0, `${font} ${ch} draws`);
    }
  }
});

test('noise keep + masks, adjust alpha delta, negated color mask, glow select, gradient fixes', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'nz', width: 16, height: 16 });
  e.run('draw', { canvas: 'nz', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 16, color: '#808080' }] });
  // transparent noise under a mask no longer punches holes; "keep" leaves pixels alone
  e.run('draw', { canvas: 'nz', commands: [{ op: 'noise', colors: ['transparent', '#a0a0a0', 'keep'], mask: 'opaque', seed: 4 }] });
  assert.equal(opaque(e, 'nz'), 128, 'no holes in masked art');
  let kept = 0, lit = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) { const c = rgba(e, 'nz', x, y)[0]; if (c === 0x80) kept++; else if (c === 0xa0) lit++; }
  assert.ok(kept > 20 && lit > 20, `keep ${kept} / painted ${lit}`);
  e.run('draw', { canvas: 'nz', commands: [{ op: 'noise', colors: ['transparent', 'keep'], mask: 'opaque', erase: true }] });
  assert.ok(opaque(e, 'nz') < 128, 'erase:true restores hole punching');
  // adjust alpha is a delta, clamped; nonsense rejected
  e.run('create', { name: 'al', width: 2, height: 1 });
  e.run('draw', { canvas: 'al', commands: [{ op: 'rect', color: '#ff0000' }, { op: 'adjust', alpha: -0.3 }] });
  assert.equal(rgba(e, 'al', 0, 0)[3], 179);
  e.run('draw', { canvas: 'al', commands: [{ op: 'adjust', alpha: 1 }] });
  assert.equal(rgba(e, 'al', 0, 0)[3], 255);
  e.run('draw', { canvas: 'al', commands: [{ op: 'adjust', set_alpha: 0.5 }] });
  assert.equal(rgba(e, 'al', 0, 0)[3], 128);
  assert.throws(() => e.run('draw', { canvas: 'al', commands: [{ op: 'adjust', alpha: 30 }] }), /-1\.\.1/);
  assert.throws(() => e.run('draw', { canvas: 'al', commands: [{ op: 'adjust', alpha: 'x' }] }), /alpha/);
  // "!<color>" mask = every pixel except that color
  e.run('create', { name: 'nm', width: 3, height: 1 });
  e.run('draw', { canvas: 'nm', commands: [{ op: 'pixels', points: [[0, 0, '#ff0000'], [1, 0, '#00ff00']] }, { op: 'rect', color: '#0000ff', mask: '!#ff0000' }] });
  assert.deepEqual(rgba(e, 'nm', 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(rgba(e, 'nm', 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(rgba(e, 'nm', 2, 0), [0, 0, 255, 255]);
  // glow: saturated red neon blooms with the default select:value, not with luma
  const halo = (sel) => {
    const n = `g${sel}`;
    e.run('create', { name: n, width: 15, height: 15 });
    e.run('draw', { canvas: n, commands: [{ op: 'rect', x: 6, y: 6, w: 3, h: 3, color: '#ff0000' }, { op: 'glow', threshold: 0.5, radius: 2, ...(sel ? { select: sel } : {}) }] });
    return opaque(e, n) - 9;
  };
  assert.ok(halo(null) > 0, 'value (default) blooms red');
  assert.equal(halo('luma'), 0, 'luma 0.21 < threshold');
  assert.ok(halo('saturation') > 0);
  assert.throws(() => halo('hue'), /select/);
  // gradient dither:false = no dither; radial reaches the outer color on the region edge
  e.run('create', { name: 'gr', width: 9, height: 9 });
  e.run('draw', { canvas: 'gr', commands: [{ op: 'gradient', colors: ['#000000', '#ffffff'], direction: 'horizontal', dither: false }] });
  const row = [...Array(9).keys()].map((x) => rgba(e, 'gr', x, 0)[0]);
  assert.deepEqual(row, [...row].sort((p, q) => p - q), 'monotonic without checker dithering');
  for (let y = 1; y < 9; y++) assert.deepEqual([...Array(9).keys()].map((x) => rgba(e, 'gr', x, y)[0]), row);
  e.run('draw', { canvas: 'gr', commands: [{ op: 'gradient', colors: ['#ffffff', '#808080', '#000000'], direction: 'radial' }] });
  for (const [x, y] of [[0, 0], [8, 0], [0, 8], [8, 8], [4, 0], [0, 4], [8, 4], [4, 8]]) assert.deepEqual(rgba(e, 'gr', x, y), [0, 0, 0, 255], `edge ${x},${y} is the outer color`);
  assert.deepEqual(rgba(e, 'gr', 4, 4), [255, 255, 255, 255]);
});

test('art_view tile fits max_size, draw commands_file, critique seams field', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'tl', width: 64, height: 64 });
  e.run('draw', { canvas: 'tl', commands: [{ op: 'noise', colors: ['#204020', '#306030'], seed: 2 }] });
  const v = e.run('render', { canvas: 'tl', tile: 3, max_size: 300 });
  const img = decodePNG(v.image);
  assert.ok(img.width > 192 && img.width <= 300, `tiled view ${img.width} px`);
  assert.equal(e.run('render', { canvas: 'tl', tile: 3 }).scale, 2, 'integer scale when it fits');
  // commands from a file, before inline commands
  const f = path.join(home, 'cmds.json');
  fs.writeFileSync(f, JSON.stringify({ commands: [{ op: 'rect', color: '#ff0000' }] }));
  e.run('create', { name: 'cf', width: 4, height: 4 });
  e.run('draw', { canvas: 'cf', commands_file: f, commands: [{ op: 'pixels', points: [[0, 0]], color: '#0000ff' }] });
  assert.deepEqual(rgba(e, 'cf', 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(rgba(e, 'cf', 0, 0), [0, 0, 255, 255]);
  fs.writeFileSync(f, JSON.stringify([{ op: 'clear' }]));
  e.run('draw', { canvas: 'cf', commands_file: f });
  assert.equal(opaque(e, 'cf'), 0);
  fs.writeFileSync(f, '{"nope":1}');
  assert.throws(() => e.run('draw', { canvas: 'cf', commands_file: f }), /commands_file/);
  // critique tileable: explicit seams verdict
  const ok = e.run('critique', { canvas: 'tl', tileable: true });
  assert.equal(typeof ok.seams.ok, 'boolean');
  assert.equal(ok.seams.worst.length, 3);
  e.run('create', { name: 'sm', width: 16, height: 16 });
  e.run('draw', { canvas: 'sm', commands: [{ op: 'gradient', colors: ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'], direction: 'horizontal', dither: 'none' }] });
  const bad = e.run('critique', { canvas: 'sm', tileable: true });
  assert.equal(bad.seams.ok, false);
  assert.equal(bad.seams.worst[0], 15);
  assert.ok(bad.seams.worst[2] > 100);
});
