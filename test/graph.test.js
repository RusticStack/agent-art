// Asset graph (art_graph) and review notes (art_review): persistence, automatic edges, compact
// output, cycle safety, region / frame targeting, and the one-line hint in other tools' replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { touchedAssets } from '../src/mcp.js';
import { decodePNG } from '../src/png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-graph-'));

test('graph: links, tags, notes and groups persist per workspace', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'helmet_front', width: 16 });
  e.run('create', { name: 'helmet_side', width: 16 });
  assert.match(e.run('graph_link', { from: 'helmet_side', rel: 'variant_of', to: 'helmet_front', attrs: { view: 'side' } }).text, /linked canvas:helmet_side variant_of> canvas:helmet_front \{view:side\}/);
  e.run('graph_tag', { node: 'helmet_front', add: ['helmet', 'armour'] });
  e.run('graph_note', { node: 'helmet_front', note: 'front-facing reference' });
  e.run('graph_group', { name: 'Armour', note: 'all armour' });
  e.run('graph_group', { name: 'Helmets', members: ['helmet_front', 'helmet_side'], parent: 'Armour' });
  e.run('graph_link', { from: 'helmet_side', rel: 'fits_with', to: 'canvas:helmet_front', label: 'custom rel' });
  e.flush();
  const again = new Engine({ home });
  const q = again.run('graph_query', { node: 'helmet_front' }).text;
  assert.match(q, /^canvas:helmet_front #armour #helmet "front-facing reference"/);
  assert.match(q, /<variant_of canvas:helmet_side \{view:side\}/);
  assert.match(q, /part_of> group:Helmets/);
  assert.match(q, /<fits_with canvas:helmet_side/);
  const sum = again.run('graph_summary', {}).text;
  assert.match(sum, /group:Armour "all armour" \(1\)\n  group:Helmets \(2\)\n    canvas:helmet_front/);
  assert.match(again.run('graph_find', { tag: 'helmet' }).text, /canvas:helmet_front/);
  assert.match(again.run('graph_find', { text: 'reference' }).text, /canvas:helmet_front/);
  assert.match(again.run('graph_path', { from: 'helmet_side', to: 'group:Armour' }).text, /canvas:helmet_side .*group:Armour/);
  // unlink / group remove / delete
  again.run('graph_unlink', { from: 'helmet_side', rel: 'fits_with', to: 'helmet_front' });
  assert.doesNotMatch(again.run('graph_query', { node: 'helmet_front' }).text, /fits_with/);
  again.run('graph_group', { name: 'Helmets', remove: ['helmet_side'] });
  assert.match(again.run('graph_summary', { group: 'Helmets' }).text, /\(1\)/);
  again.run('graph_group', { name: 'Armour', delete: true });
  assert.doesNotMatch(again.run('graph_summary', {}).text, /group:Armour/);
  // errors are actionable
  assert.throws(() => again.run('graph_link', { from: 'nothing_here', rel: 'part_of', to: 'helmet_front' }), /unknown node "nothing_here"/);
  assert.throws(() => again.run('graph_link', { from: 'helmet_side', rel: 'Bad Rel!', to: 'helmet_front' }), /rel must be/);
});

test('graph: automatic edges for projects, layers, tags, rigs, renders, textures and exports', () => {
  const e = new Engine({ home: tmp() });
  e.run('project_create', { name: 'set', palette: { a: '#123456' } });
  e.run('create', { name: 'tex', width: 8, project: 'set' });
  e.run('layer', { canvas: 'tex', action: 'add', name: 'ink' });
  e.run('create', { name: 'strip', width: 8, frames: 4 });
  e.run('animation', { canvas: 'strip', action: 'tag', name: 'spin', from: 0, to: 3 });
  e.run('rig_create', { name: 'bob', template: 'blob', frame: [32, 32] });
  e.run('rig_animate', { name: 'bob', preset: 'idle' });
  e.run('model_create', { name: 'crate', parts: [{ type: 'box', w: 32, h: 32, d: 32, texture: 'tex', name: 'lid' }] });
  e.run('model_render', { name: 'crate', canvas: 'crate_spr', size: [32, 32] });
  e.run('export', { canvas: 'tex' });
  e.run('export_animation', { canvas: 'strip', format: 'spritesheet' });
  e.run('model_export', { name: 'crate' });
  const g = e.graph;
  const has = (from, rel, to) => g.all().edges.some((x) => x.from === from && x.rel === rel && x.to === to);
  assert.ok(has('canvas:tex', 'part_of', 'project:set'));
  assert.ok(has('canvas:tex', 'uses_palette', 'palette:set'));
  assert.ok(has('layer:tex/ink', 'layer_of', 'canvas:tex'));
  assert.ok(has('anim:strip/spin', 'part_of', 'canvas:strip'));
  // rig: parts canvas part of the rig, parts drawn on it, the animated canvas rendered from it
  assert.ok(has('canvas:bob_parts', 'part_of', 'rig:bob'));
  assert.ok(g.all().edges.some((x) => x.from.startsWith('rigpart:bob/') && x.rel === 'part_of' && x.to === 'canvas:bob_parts'));
  assert.ok(has('canvas:bob', 'rendered_from', 'rig:bob'));
  // model: render output, texture, named part
  assert.ok(has('canvas:crate_spr', 'rendered_from', 'model:crate'));
  assert.ok(has('model:crate', 'depends_on', 'canvas:tex'));
  assert.ok(has('modelpart:crate/lid', 'part_of', 'model:crate'));
  // exports (recorded when the export ops run, stored)
  assert.ok(has('canvas:tex', 'exports_to', 'export:tex.png'));
  assert.ok(has('canvas:strip', 'exports_to', 'export:strip.png'));
  assert.ok(has('canvas:strip', 'exports_to', 'export:strip.json'));
  assert.ok(has('model:crate', 'exports_to', 'export:crate.glb'));
  assert.match(e.run('graph_query', { node: 'crate' }).text, /exports_to> export:crate\.glb/);
  // derived edges follow the workspace (no stale edge after a delete)
  e.run('delete', { canvas: 'crate_spr' });
  assert.ok(!has('canvas:crate_spr', 'rendered_from', 'model:crate'));
});

test('graph: query output stays compact (ids, rels, notes; capped)', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'hub', width: 4 });
  for (let i = 0; i < 12; i++) e.run('layer', { canvas: 'hub', action: 'add', name: `l${i}` });
  for (let i = 0; i < 60; i++) {
    e.run('create', { name: `spoke_${i}`, width: 4 });
    e.run('graph_link', { from: `spoke_${i}`, rel: 'variant_of', to: 'hub', attrs: { view: `v${i}` } });
    e.run('graph_note', { node: `spoke_${i}`, note: `variant number ${i} with a fairly long description to stress the cap` });
  }
  const q = e.run('graph_query', { node: 'hub' }).text;
  assert.ok(q.length <= 1600, `default query ${q.length} chars`);
  assert.match(q, /<layer_of base, l0, l1/, 'leaf sub-assets on one line');
  assert.match(q, /\+\d+/, 'says how much more there is');
  assert.doesNotMatch(q, /data:image|base64|"rows"/);
  const one = e.run('graph_query', { node: 'spoke_3' }).text;
  assert.ok(one.length < 300, one);
  const deep = e.run('graph_query', { node: 'hub', depth: 3, limit: 100, max_chars: 900 }).text;
  assert.ok(deep.length <= 900);
  const sum = e.run('graph_summary', {}).text;
  assert.ok(sum.length <= 2400);
});

test('graph: cycles are safe (group nesting refused, traversal terminates)', () => {
  const e = new Engine({ home: tmp() });
  for (const n of ['a', 'b', 'c']) e.run('create', { name: n, width: 4 });
  e.run('graph_link', { from: 'a', rel: 'depends_on', to: 'b' });
  e.run('graph_link', { from: 'b', rel: 'depends_on', to: 'c' });
  e.run('graph_link', { from: 'c', rel: 'depends_on', to: 'a' });
  const q = e.run('graph_query', { node: 'a', depth: 4, dir: 'out' }).text;
  assert.equal(q.split('\n').filter((l) => /depends_on>/.test(l)).length, 3, q);
  assert.match(e.run('graph_path', { from: 'a', to: 'c' }).text, /canvas:a .*canvas:c/);
  e.run('graph_group', { name: 'G1' });
  e.run('graph_group', { name: 'G2', parent: 'G1' });
  e.run('graph_group', { name: 'G3', parent: 'G2' });
  assert.throws(() => e.run('graph_group', { name: 'G1', parent: 'G3' }), /cycle/);
  assert.throws(() => e.run('graph_group', { name: 'G3', members: ['group:G1'] }), /cycle/);
  assert.throws(() => e.run('graph_group', { name: 'G1', parent: 'G1' }), /cycle/);
  // a cycle written into the file by hand still terminates
  e.graph.data.groups.G1.parent = 'G3';
  assert.ok(e.graph.summary({}).text.length > 0);
  assert.ok(e.run('graph_query', { node: 'group:G1', depth: 4 }).text.length > 0);
});

test('review: notes target frames, views and regions; list is compact; status workflow persists', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'helmet_front', width: 16, frames: 2 });
  e.run('create', { name: 'helmet_side', width: 16, frames: 2 });
  e.run('draw', { canvas: 'helmet_side', frame: 1, commands: [{ op: 'rect', x: 4, y: 4, w: 6, h: 3, color: '#38bdf8' }] });
  const r = e.run('review_add', { asset: 'helmet_side', frame: 1, view: 'side', region: [4, 4, 6, 3], category: 'inconsistent across views', priority: 'high', note: 'visor sits lower than on the front view', compare_with: { asset: 'helmet_front', view: 'front' } }, 'user');
  assert.equal(r.id, 'r1');
  const note = e.reviews.get('r1');
  assert.deepEqual(note.target, { frame: 1, view: 'side', region: [4, 4, 6, 3] });
  assert.equal(note.category, 'inconsistent');
  assert.equal(note.compare_with.asset, 'canvas:helmet_front');
  // the noted crop is the region (plus a little context) of frame 1, scaled up
  const crop = decodePNG(fs.readFileSync(path.join(home, 'reviews', note.history[0].img)));
  // 6x3 box + 2 px context each side (25% of the box) = 10x7 px, scaled by an integer
  const k = crop.width / 10;
  assert.ok(Number.isInteger(k) && k > 1 && crop.height === 7 * k, `crop ${crop.width}x${crop.height}`);
  const px = (x, y) => [...crop.data.subarray((y * crop.width + x) * 4, (y * crop.width + x) * 4 + 4)];
  assert.deepEqual(px(Math.floor(k * 3.5), Math.floor(k * 3.5)), [56, 189, 248, 255], 'frame 1 pixels, not frame 0');
  assert.deepEqual(px(Math.floor(k * 0.5), Math.floor(k * 0.5)), [0, 0, 0, 0], 'context around the box');
  // pins too
  e.run('review_add', { asset: 'helmet_front', point: [3, 5], note: 'stray pixel', category: 'fix' }, 'user');
  assert.deepEqual(e.reviews.get('r2').target, { region: [3, 5, 1, 1], pin: true });
  for (let i = 0; i < 35; i++) e.run('review_add', { asset: 'helmet_front', frame: 0, region: [i % 10, 2, 3, 3], note: `note ${i} about something that needs a fix in this area`, category: 'style' }, 'user');
  const list = e.run('review_list', {}).text;
  const lines = list.split('\n');
  assert.equal(lines.length, 31, 'default limit 30 + a "more" line');
  assert.ok(lines.every((l) => l.length < 260), 'one short line per note');
  assert.match(lines[0], /^r1 open high inconsistent canvas:helmet_side f1 view:side \[4,4,6,3\] vs canvas:helmet_front view:front: "visor sits lower/);
  assert.doesNotMatch(list, /base64|data:image/);
  assert.match(e.run('review_list', { asset: 'helmet_side' }).text, /^r1 /);
  // get: image of then / now / compare + history
  const g = e.run('review_get', { id: 'r1' });
  assert.ok(Buffer.isBuffer(g.image));
  assert.match(g.text, /user open/);
  // workflow: in_progress -> fixed (new version attached) -> reopened -> accepted
  e.run('review_update', { id: 'r1', status: 'in_progress', reply: 'on it' }, 'agent');
  e.run('draw', { canvas: 'helmet_side', frame: 1, commands: [{ op: 'rect', x: 4, y: 2, w: 6, h: 3, color: '#38bdf8' }] });
  e.run('review_update', { id: 'r1', status: 'fixed', reply: 'visor raised 2 px' }, 'agent');
  const fixed = e.reviews.get('r1').history.at(-1);
  assert.ok(fixed.img && fixed.version > note.history[0].version, 'fixed attaches the new version');
  e.run('review_update', { id: 'r1', status: 'reopened', reply: 'still 1 px off' }, 'user');
  assert.match(e.run('review_list', {}).text, /r1 reopened .*still 1 px off/);
  assert.throws(() => e.run('review_update', { id: 'r1', status: 'done' }), /status must be/);
  e.flush();
  const again = new Engine({ home });
  assert.equal(again.reviews.get('r1').status, 'reopened');
  assert.equal(again.reviews.get('r1').history.length, 4);
  assert.equal(again.run('review_add', { asset: 'helmet_side', note: 'next', category: 'question' }, 'user').id, 'r38', 'ids keep counting after a restart');
});

test('review: the hint line appears only for assets with open notes or approvals', () => {
  const e = new Engine({ home: tmp() });
  for (const n of ['a', 'b', 'c']) e.run('create', { name: n, width: 4 });
  e.run('review_add', { asset: 'a', note: 'fix the outline', category: 'fix' }, 'user');
  const hint = (ids, mutated) => e.run('review_hint', { ids, mutated }).text;
  assert.equal(hint(['canvas:a']), 'review: 1 open review note on a (r1): art_review list');
  assert.equal(hint(['canvas:b']), '');
  assert.equal(hint([]), '');
  e.run('review_approve', { asset: 'b' }, 'user');
  assert.match(hint(['canvas:b'], false), /b is approved by the user: ask before changing it/);
  assert.match(hint(['canvas:b'], true), /b was approved by the user and this call changed it/);
  assert.ok(!hint(['canvas:a', 'canvas:b'], true).includes('\n'), 'one line');
  e.run('review_update', { id: 'r1', status: 'fixed' }, 'agent');
  assert.equal(hint(['canvas:a']), '', 'fixed notes are no longer open');
  // which assets a tool call touches
  assert.deepEqual(touchedAssets('art_draw', { canvas: 'a' }), ['canvas:a']);
  assert.deepEqual(touchedAssets('art_rig', { action: 'animate', name: 'bob' }), ['rig:bob', 'canvas:bob', 'canvas:bob_parts']);
  assert.deepEqual(touchedAssets('art_model', { name: 'crate', canvas: 'spr' }), ['model:crate', 'canvas:spr']);
  assert.deepEqual(touchedAssets('art_audio', { name: 'gib_*' }), []);
  assert.deepEqual(touchedAssets('art_review', { asset: 'a' }), []);
});

test('mcp: art_graph + art_review end to end, hint only when relevant', async () => {
  const home = tmp();
  const port = 7930 + Math.floor(Math.random() * 40);
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'mcp', '--port', String(port), '--home', home], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); }
  });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const call = (id, name, args) => send({ id, method: 'tools/call', params: { name, arguments: args } });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  call(2, 'art_create_canvas', { name: 'helm', width: 8 });
  call(3, 'art_create_canvas', { name: 'other', width: 8 });
  call(4, 'art_review', { action: 'add', asset: 'helm', note: 'too dark', category: 'fix', region: [1, 1, 3, 3] });
  call(5, 'art_draw', { canvas: 'helm', commands: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#fff' }] });
  call(6, 'art_draw', { canvas: 'other', commands: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#fff' }] });
  call(7, 'art_review', { action: 'list' });
  call(8, 'art_graph', { action: 'summary' });
  call(9, 'art_graph', { action: 'query', node: 'helm' });
  call(10, 'art_review', { action: 'get', id: 'r1' });
  send({ id: 11, method: 'tools/list' });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  const texts = (id) => replies.get(id).result.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(!replies.get(2).result.isError);
  const withNote = texts(5);
  assert.equal(withNote.length, 2, 'draw reply + one hint line');
  assert.match(withNote[1], /^review: 1 open review note on helm \(r1\)/);
  assert.equal(texts(6).length, 1, 'no hint for an asset without notes');
  assert.match(texts(7)[0], /^r1 open fix canvas:helm \[1,1,3,3\]: "too dark"$/);
  assert.match(texts(8)[0], /^workspace: 2 canvases/);
  assert.match(texts(9)[0], /^canvas:helm/);
  assert.ok(replies.get(10).result.content.some((c) => c.type === 'image'));
  const tools = replies.get(11).result.tools.map((t) => t.name);
  assert.ok(tools.includes('art_graph') && tools.includes('art_review'));
});

test('graph: group names like "__proto__" stay plain groups (no prototype pollution)', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('graph_group', { name: '__proto__', note: 'polluted?' });
  assert.equal(({}).note, undefined);
  assert.throws(() => e.run('graph_group', { name: 'constructor', delete: true }), /no group "constructor"/);
  e.flush();
  const again = new Engine({ home });
  assert.match(again.run('graph_summary', {}).text, /group:__proto__ "polluted\?"/);
  assert.equal(({}).note, undefined);
});
