// Regression tests for issues a benchmark agent hit while making the README art (v1 polish).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { runTool } from '../src/mcp.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-v1-'));
const tool = async (e, name, args) => runTool(name, args, (op, a) => e.run(op, a));
const text = (content) => content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const colorsOf = (e, canvas) => {
  const d = e.get(canvas).layers[0].data, s = new Set();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) s.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  return s;
};
const painted = (e, canvas) => { const d = e.get(canvas).layers[0].data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };

test('quantize colors:<n> picks n colors from the canvas; lists still work; bad input is a clear error', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'q', width: 16, height: 16 });
  e.run('draw', { canvas: 'q', commands: [{ op: 'gradient', colors: ['#102030', '#405060', '#8090a0', '#c0d0e0', '#f0a040', '#a02020'], direction: 'horizontal' }, { op: 'noise', colors: ['#203040', '#304050', '#506070', '#708090'], region: [0, 8, 16, 8], seed: 2 }] });
  assert.ok(colorsOf(e, 'q').size > 4);
  e.run('draw', { canvas: 'q', commands: [{ op: 'quantize', colors: 4 }] });
  const first = [...colorsOf(e, 'q')].sort();
  assert.ok(first.length <= 4 && first.length >= 2, `${first.length} colors`);
  // deterministic: the same input gives the same palette
  const e2 = new Engine({ home: tmp() });
  e2.run('create', { name: 'q', width: 16, height: 16 });
  e2.run('draw', { canvas: 'q', commands: [{ op: 'gradient', colors: ['#102030', '#405060', '#8090a0', '#c0d0e0', '#f0a040', '#a02020'], direction: 'horizontal' }, { op: 'noise', colors: ['#203040', '#304050', '#506070', '#708090'], region: [0, 8, 16, 8], seed: 2 }, { op: 'quantize', colors: 4 }] });
  assert.deepEqual([...colorsOf(e2, 'q')].sort(), first);
  // a list is unchanged behaviour
  e.run('draw', { canvas: 'q', commands: [{ op: 'quantize', colors: ['#000000', '#ffffff'] }] });
  assert.ok([...colorsOf(e, 'q')].every((c) => c === '0,0,0' || c === '255,255,255'));
  assert.throws(() => e.run('draw', { canvas: 'q', commands: [{ op: 'quantize', colors: 2.5 }] }), /whole number 1\.\.256/);
  assert.throws(() => e.run('draw', { canvas: 'q', commands: [{ op: 'quantize', colors: { a: 1 } }] }), /list of colors .* or a count/);
  e.run('create', { name: 'empty', width: 4, height: 4 });
  assert.throws(() => e.run('draw', { canvas: 'empty', commands: [{ op: 'quantize', colors: 3 }] }), /no painted pixels/);
});

test('light region:[x,y,w,h] and {box} clip the light; an unknown region form is an error, not ignored', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'l', width: 32, height: 32 });
  const light = (region) => { e.run('draw', { canvas: 'l', commands: [{ op: 'clear' }, { op: 'light', x: 16, y: 16, radius: 20, color: '#ffffff', intensity: 1, region }] }); return painted(e, 'l'); };
  const all = light(undefined), clipped = light([0, 0, 10, 10]);
  assert.ok(clipped > 0 && clipped <= 100 && clipped < all);
  assert.equal(light({ x: 0, y: 0, w: 10, h: 10 }), clipped);
  assert.equal(light({ box: [0, 0, 10, 10] }), clipped);
  assert.throws(() => light({ rect: [0, 0, 10, 10] }), /region must be \[x,y,w,h\]/);
  assert.throws(() => light('top-left'), /region must be/);
  // ordinary ops get the same check
  assert.throws(() => e.run('draw', { canvas: 'l', commands: [{ op: 'clear', region: 'all' }] }), /region must be/);
});

test('stamp_visible names the layers it hid and how to keep them', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 's', width: 8, height: 8 });
  e.run('layer', { canvas: 's', action: 'add', name: 'glow' });
  e.run('layer', { canvas: 's', action: 'add', name: 'off' });
  e.run('layer', { canvas: 's', action: 'visibility', layer: 'off', visible: false });
  const r = JSON.stringify(e.run('layer', { canvas: 's', action: 'stamp_visible' }));
  assert.match(r, /hidden: base, glow;/);
  assert.match(r, /keep_visible:true keeps them/);
  assert.doesNotMatch(r, /hidden: [^;]*off/);
  const k = JSON.stringify(e.run('layer', { canvas: 's', action: 'stamp_visible', keep_visible: true }));
  assert.doesNotMatch(k, /hidden/);
});

test('art_help {skill:"list"} lists the skills', async () => {
  const e = new Engine({ home: tmp() });
  const t = text(await tool(e, 'art_help', { skill: 'list' }));
  assert.match(t, /^Skills/);
  assert.match(t, /- sprite: /);
  assert.match(t, /- combat-fx: /);
  await assert.rejects(tool(e, 'art_help', { skill: 'nope' }), /Unknown skill/);
});

test('art_model render outline:true uses a dark default; colour strings still work', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'b', parts: [{ type: 'box', w: 16, h: 16, d: 16, color: '#c08040' }] });
  const ring = (canvas) => {
    const d = e.get(canvas).layers[0].data, W = e.get(canvas).width, s = new Set();
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const x = (i / 4) % W, y = Math.floor(i / 4 / W);
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const xx = x + dx, yy = y + dy; return xx < 0 || yy < 0 || xx >= W || yy >= W || !d[(yy * W + xx) * 4 + 3]; });
      if (edge) s.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    return s;
  };
  e.run('model_render', { name: 'b', canvas: 'o1', camera: 'iso', size: [32, 32], outline: true });
  assert.deepEqual([...ring('o1')], ['26,26,26']);
  e.run('model_render', { name: 'b', canvas: 'o2', camera: 'iso', size: [32, 32], outline: '#ff0000' });
  assert.deepEqual([...ring('o2')], ['255,0,0']);
  // with quantize: the darkest quantize colour
  const q = e.run('model_render', { name: 'b', canvas: 'o3', camera: 'iso', size: [32, 32], quantize: { colors: ['#202010', '#c08040', '#e0a060', '#804020'] }, outline: true });
  assert.equal(q.colors, 4);
  assert.deepEqual([...ring('o3')], ['32,32,16']);
});

test('art_fx make reply: abs_file is the real sheet path (dir + file)', async () => {
  const e = new Engine({ home: tmp() });
  const r = JSON.parse(text(await tool(e, 'art_fx', { action: 'make', type: 'muzzle', variant: 'rifle', view: 'side' })).split('\n')[0]);
  assert.equal(r.abs_file, path.join(r.dir, r.file));
  assert.ok(fs.existsSync(r.abs_file), r.abs_file);
});

test('sfx listener report: no tempo, and a wet tail does not contradict "stops dead"', async () => {
  const e = new Engine({ home: tmp() });
  await tool(e, 'art_audio', { action: 'sfx', name: 'shot', recipe: 'gunshot_rifle' });
  const r = JSON.parse(text(await tool(e, 'art_audio', { action: 'analyze', name: 'shot' })).split('\n')[0]);
  assert.doesNotMatch(r.report, /BPM/);
  if (/stops dead/.test(r.report)) assert.doesNotMatch(r.report, /space: (small room|hall|large hall|cathedral)[^(;]*;/, r.report);
});

test('usage log: a reply without text never throws; the usage CLI takes --tool / --json as flags, not files', async () => {
  const { UsageLog, measureContent } = await import('../src/usage.js');
  assert.equal(measureContent([{ type: 'text' }]).chars, 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-usage-'));
  const log = new UsageLog({ file: path.join(home, 'u.jsonl'), level: 'on' });
  assert.doesNotThrow(() => log.call({ tool: 'art_help', content: [{ type: 'text', text: undefined }] }));
  const { execFileSync } = await import('node:child_process');
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-art.js');
  const env = { ...process.env, AGENT_ART_DEBUG: '', AGENT_ART_DEBUG_FILE: '' };
  execFileSync(process.execPath, [bin, '--home', home, '--debug', 'tool', 'art_help', '{}'], { env, encoding: 'utf8' });
  const plain = execFileSync(process.execPath, [bin, '--home', home, 'usage'], { env, encoding: 'utf8' });
  assert.match(plain, /1 tool calls?/);
  assert.match(execFileSync(process.execPath, [bin, '--home', home, 'usage', '--tool', 'art_help'], { env, encoding: 'utf8' }), /1 tool calls?/);
  assert.ok(JSON.parse(execFileSync(process.execPath, [bin, '--home', home, 'usage', '--json'], { env, encoding: 'utf8' })).calls >= 1);
});
