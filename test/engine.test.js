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
