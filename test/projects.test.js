import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, packFormatFor } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { createZip, readZip } from '../src/zip.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-p-'));

test('pack formats by version', () => {
  assert.equal(packFormatFor('1.12.2'), 3);
  assert.equal(packFormatFor('1.8.9'), 1);
  assert.equal(packFormatFor('1.16.5'), 6);
  assert.equal(packFormatFor('1.20.1'), 15);
  assert.equal(packFormatFor('1.21.4'), 46);
});

test('zip roundtrip', () => {
  const z = readZip(createZip([{ name: 'a/b.txt', data: Buffer.from('hello hello hello') }, { name: 'c', data: Buffer.from([1, 2]) }]));
  assert.equal(z.get('a/b.txt')().toString(), 'hello hello hello');
  assert.deepEqual([...z.get('c')()], [1, 2]);
});

test('project palette inheritance, meta, sheet, build', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('project_create', { name: 'p', palette: { g: '#00ff00', o: '#000000' }, meta: { minecraft: '1.12.2' }, notes: 'thick outlines' });
  e.run('create', { name: 'grass', project: 'p', meta: { texture: 'blocks/grass_top' } });
  e.run('create', { name: 'icon', project: 'p', meta: { pack_icon: true }, palette: { g: '#ff0000' } });
  e.run('draw', { canvas: 'grass', commands: [{ op: 'grid', rows: ['go'] }] });
  assert.equal(e.run('read', { canvas: 'grass', w: 2, h: 1 }).legend.g, '#00ff00');
  e.run('draw', { canvas: 'icon', commands: [{ op: 'rect', color: 'g' }] }); // canvas palette overrides project
  assert.equal(e.run('info', { canvas: 'icon' }).colors.top[0].color, '#ff0000');
  e.run('palette', { project: 'p', action: 'set', colors: { s: '#123456' } });
  e.run('draw', { canvas: 'grass', commands: [{ op: 'pixels', points: [[3, 3, 's']] }] });
  assert.equal(e.run('project_info', { name: 'p' }).canvases.length, 2);
  const sh = e.run('sheet', { project: 'p' });
  assert.equal(sh.count, 2);
  assert.ok(decodePNG(sh.image).width > 32);
  const b = e.run('pack_build', { project: 'p' });
  assert.equal(b.textures, 1);
  const root = path.join(home, 'packs', 'p');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pack.mcmeta'))).pack.pack_format, 3);
  assert.ok(fs.existsSync(path.join(root, 'assets/minecraft/textures/blocks/grass_top.png')));
  assert.ok(fs.existsSync(path.join(root, 'pack.png')));
  assert.ok(fs.existsSync(b.zip));
  e.flush();
  const e2 = new Engine({ home });
  assert.equal(e2.run('read', { canvas: 'grass', x: 3, y: 3, w: 1, h: 1 }).legend.s, '#123456');
});

test('text, polygon, curve, remap, region render', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'c', width: 32, height: 16 });
  e.run('draw', { canvas: 'c', commands: [{ op: 'text', x: 1, y: 1, text: 'Hi!', color: '#fff' }] });
  const r = e.run('read', { canvas: 'c', x: 1, y: 1, w: 9, h: 5 });
  const W = r.rows[0][0] === '.' ? null : r.rows[0][0];
  assert.equal(r.rows[0].replace(/[^.]/g, '#'), '#.#.###.#');
  assert.ok(W);
  e.run('create', { name: 'poly', width: 8, height: 8 });
  e.run('draw', { canvas: 'poly', commands: [{ op: 'polygon', points: [[0, 0], [8, 0], [8, 8], [0, 8]], color: '#f00' }] });
  assert.equal(e.run('info', { canvas: 'poly' }).colors.top[0].count, 64);
  e.run('draw', { canvas: 'poly', commands: [{ op: 'remap', map: { '#f00': '#0f0' } }] });
  assert.equal(e.run('info', { canvas: 'poly' }).colors.top[0].color, '#00ff00');
  e.run('draw', { canvas: 'poly', commands: [{ op: 'clear' }, { op: 'curve', points: [[0, 7], [4, -4], [7, 7]], color: '#000' }] });
  const n = e.run('info', { canvas: 'poly' }).colors.top[0].count;
  assert.ok(n >= 8 && n <= 20, `curve pixels ${n}`);
  const v = e.run('render', { canvas: 'c', x: 0, y: 0, w: 8, h: 8 });
  assert.equal(decodePNG(v.image).width, 8 * v.scale);
});
