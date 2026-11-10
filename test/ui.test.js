// Web UI plumbing: activity events over SSE, tool-call tracing, snapshots, asset index, model GLB,
// rig layer stack, audio, exports, per-workspace UI state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Engine } from '../src/engine.js';
import { startServer } from '../src/server.js';
import { summarizeArgs, summarizeResult } from '../src/activity.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-ui-'));
let nextPort = 7860 + Math.floor(Math.random() * 60);
const close = (srv) => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });

/** Collect SSE events from /api/events until stop(). */
function listen(port) {
  const events = [];
  let req;
  const ready = new Promise((resolve) => {
    req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) { const ev = JSON.parse(chunk.slice(6)); events.push(ev); if (ev.type === 'hello') resolve(); }
        }
      });
    });
  });
  return { events, ready, stop: () => req.destroy() };
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
const post = (port, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('ui: SSE streams activity entries (tool call + its ops, timing, snapshots) and /api/activity lists them', async () => {
  const e = new Engine({ home: tmp() });
  const port = nextPort++;
  const srv = await startServer(e, { port });
  const sse = listen(port);
  try {
    await sse.ready;
    // a proxied MCP tool call: start trace, ops tagged with the call, end trace
    assert.equal((await post(port, '/api/trace', { phase: 'start', call: 'c1', tool: 'art_draw', args: { canvas: 'hat', commands: [{ op: 'rect' }] } })).status, 200);
    let j = await (await post(port, '/api/op', { op: 'create', args: { name: 'hat', width: 8 }, source: 'agent', trace: { call: 'c1', tool: 'art_draw' } })).json();
    assert.ok(j.ok);
    j = await (await post(port, '/api/op', { op: 'draw', args: { canvas: 'hat', commands: [{ op: 'rect', x: 1, y: 1, w: 3, h: 3, color: '#f00' }] }, source: 'agent', trace: { call: 'c1', tool: 'art_draw' } })).json();
    assert.ok(j.ok);
    await post(port, '/api/trace', { phase: 'end', call: 'c1', ok: true, ms: 12, summary: 'drew a hat' });
    // a failing op is an error entry
    j = await (await post(port, '/api/op', { op: 'draw', args: { canvas: 'nope', commands: [{ op: 'rect' }] }, source: 'agent' })).json();
    assert.equal(j.ok, false);

    const toolEnd = await until(() => sse.events.find((x) => x.type === 'activity' && x.entry.type === 'tool' && !x.entry.running));
    const t = toolEnd.entry;
    assert.equal(t.tool, 'art_draw');
    assert.equal(t.ops.length, 2);
    assert.equal(t.ms, 12);
    assert.equal(t.summary, 'drew a hat');
    assert.deepEqual(t.args.commands, '1 cmd: rect');
    const hat = t.assets.find((a) => a.name === 'hat');
    assert.ok(hat.after, 'after snapshot');
    const draw = sse.events.find((x) => x.type === 'activity' && x.entry.op === 'draw' && x.entry.ok);
    assert.ok(draw.entry.assets[0].before && draw.entry.assets[0].after, 'draw has before and after');
    assert.equal(draw.entry.call, 'c1');
    assert.ok(typeof draw.entry.ms === 'number');
    const err = await until(() => sse.events.find((x) => x.type === 'activity' && x.entry.ok === false));
    assert.match(err.entry.error, /No canvas "nope"/);
    assert.ok(sse.events.some((x) => x.type === 'change' && x.canvas === 'hat'), 'workspace events still flow');

    // snapshots: PNG + meta
    const png = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/snapshot/${hat.after}.png`)).arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/snapshot/${hat.after}`)).json();
    assert.equal(meta.name, 'hat');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/snapshot/s999999.png`)).status, 404);

    const act = await (await fetch(`http://127.0.0.1:${port}/api/activity?since=0`)).json();
    assert.ok(act.entries.some((x) => x.type === 'tool' && x.call === 'c1'));
    const later = await (await fetch(`http://127.0.0.1:${port}/api/activity?since=${act.seq}`)).json();
    assert.equal(later.entries.length, 0);
    // UI reads are not activity
    await fetch(`http://127.0.0.1:${port}/api/canvases`);
    await fetch(`http://127.0.0.1:${port}/api/canvas/hat`);
    assert.equal(e.activity.seq, act.seq);
    // trace needs a call id, and cross-origin writes are refused
    assert.equal((await post(port, '/api/trace', { phase: 'start' })).status, 400);
    assert.equal((await post(port, '/api/trace', { phase: 'start', call: 'x' }, { origin: 'http://evil.example' })).status, 403);
  } finally {
    sse.stop();
    await close(srv);
  }
});

test('ui: activity summaries stay short and never carry pixel data', () => {
  const s = summarizeArgs({ canvas: 'a', base64: 'x'.repeat(5000), image: 'data:image/png;base64,' + 'A'.repeat(9000), commands: Array(40).fill({ op: 'rect' }), points: Array(100).fill([1, 2]), note: 'n'.repeat(300) });
  assert.equal(s.base64, '<5000 chars>');
  assert.match(s.image, /^<\d+ chars>$/);
  assert.equal(s.commands, '40 cmds: rect');
  assert.equal(s.points, '[100 items]');
  assert.ok(s.note.length <= 80);
  assert.ok(JSON.stringify(s).length < 400);
  assert.ok(summarizeResult({ image: Buffer.alloc(10), canvas: 'a', frames: [1, 2] }).includes('image'));
});

test('ui: asset index, model GLB, rig layer stack + debug render, audio, exports, ui-state', async () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'tex', width: 8 });
  e.run('draw', { canvas: 'tex', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#888' }] });
  const rc = e.run('rig_create', { name: 'bob', template: 'humanoid', frame: [32, 32] });
  const cmds = Object.values(rc.cells.side).map(([x, y, w, h], i) => ({ op: 'rect', x, y, w, h, color: ['#f00', '#0f0', '#00f', '#ff0', '#0ff', '#f0f', '#fff'][i % 7] }));
  e.run('draw', { canvas: 'bob_parts', layer: 'parts', commands: cmds });
  e.run('rig_animate', { name: 'bob', preset: 'walk' });
  e.run('model_create', { name: 'crate', parts: [{ type: 'box', w: 32, h: 32, d: 32, texture: 'tex', name: 'body' }], sockets: { top: { part: 'body', at: [0, 32, 0] } } });
  e.run('export', { canvas: 'tex' });
  const port = nextPort++;
  const srv = await startServer(e, { port });
  const U = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const a = await (await fetch(U('/api/assets'))).json();
    assert.ok(a.canvases.some((c) => c.name === 'tex' && c.layers.length === 1));
    assert.equal(a.canvases.find((c) => c.name === 'bob_parts').kind, 'rigparts');
    assert.equal(a.canvases.find((c) => c.name === 'bob').kind, 'rigout');
    assert.deepEqual(a.rigs.map((r) => r.name), ['bob']);
    assert.deepEqual(a.rigs[0].outputs, ['bob']);
    assert.ok(a.models.some((m) => m.name === 'crate' && m.named.includes('body') && m.sockets.includes('top')));
    assert.ok(a.exports.some((f) => f.path === 'tex.png'));

    const glb = Buffer.from(await (await fetch(U('/api/model/crate/glb'))).arrayBuffer());
    assert.equal(glb.subarray(0, 4).toString(), 'glTF');
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
    assert.ok(gltf.nodes.some((n) => n.name === 'socket_top'), 'sockets are nodes');
    const thumb = Buffer.from(await (await fetch(U('/api/model/crate/thumb.png'))).arrayBuffer());
    assert.equal(thumb.subarray(1, 4).toString(), 'PNG');
    // the thumbnail cache is keyed by size too (a cached 128 px image must not answer ?size=512)
    const thumbWidth = (b) => b.readUInt32BE(16);
    const big = Buffer.from(await (await fetch(U('/api/model/crate/thumb.png?size=512'))).arrayBuffer());
    assert.ok(thumbWidth(big) > thumbWidth(thumb), `size=512 gives a larger image (${thumbWidth(big)} vs ${thumbWidth(thumb)})`);
    const again = Buffer.from(await (await fetch(U('/api/model/crate/thumb.png'))).arrayBuffer());
    assert.equal(thumbWidth(again), thumbWidth(thumb), 'the default size is still served from its own cache entry');
    assert.equal((await fetch(U('/api/model/nope/glb'))).status, 404);
    // the viewer does not write files (export does)
    assert.ok(!fs.existsSync(path.join(home, 'exports', 'crate.glb')));

    const layers = await (await fetch(U('/api/rig/bob/layers?canvas=bob&tag=walk_side'))).json();
    assert.equal(layers.frames.length, e.docs.get('bob').animations.walk_side.frames.length);
    const st = layers.frames[0].stack;
    assert.deepEqual([...st].map((s) => s.z), [...st].map((s) => s.z).sort((x, y) => x - y), 'bottom to top');
    assert.ok(st.every((s) => s.part && typeof s.rule === 'string' && s.rule.length));
    const dbg = await (await fetch(U('/api/rig/bob/debug?canvas=bob&tag=walk_side&frame=2'))).json();
    assert.deepEqual(dbg.size, [32, 32]);
    assert.ok(dbg.atlas_parts.length >= 5);
    assert.equal(Buffer.from(dbg.atlas, 'base64').subarray(1, 4).toString(), 'PNG');
    const rest = await (await fetch(U('/api/rig/bob/layers?view=front'))).json();
    assert.equal(rest.view, 'front');
    assert.equal(rest.frames.length, 1);

    // exports: served from the exports folder only
    assert.equal((await fetch(U('/api/export-file?path=tex.png'))).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(U('/api/export-file?path=../graph.json'))).status, 404);
    assert.equal((await fetch(U(`/api/export-file?path=${encodeURIComponent(path.join(home, 'canvases', 'tex.json'))}`))).status, 404);

    // ui state persists per workspace
    let r = await (await post(port, '/api/ui-state', { hidden: ['canvas:tex', 3], pinned: ['model:crate'] })).json();
    assert.deepEqual(r.state.hidden, ['canvas:tex']);
    assert.deepEqual((await (await fetch(U('/api/ui-state'))).json()).pinned, ['model:crate']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'ui-state.json'), 'utf8')).hidden, ['canvas:tex']);
    assert.equal((await post(port, '/api/ui-state', {}, { origin: 'http://evil.example' })).status, 403);

    // graph for the UI, and one node's relations
    const g = await (await fetch(U('/api/graph'))).json();
    assert.ok(g.nodes.some((n) => n.id === 'rig:bob'));
    assert.ok(g.edges.some((x) => x.from === 'canvas:bob' && x.rel === 'rendered_from' && x.to === 'rig:bob'));
    const n = await (await fetch(U('/api/graph/node?id=crate'))).json();
    assert.equal(n.id, 'model:crate');
    assert.ok(n.out.some((x) => x.rel === 'depends_on' && x.to === 'canvas:tex'));
  } finally {
    await close(srv);
  }
});

test('ui: serves the built bundle with the UI token, a clear page when it is not built', async () => {
  // a stand-in for dist/ui (npm run build:ui output): index.html + hashed assets
  const dist = tmp();
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="./assets/index-abc.js"></script></head><body></body></html>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'import("./three-def.js");');
  fs.writeFileSync(path.join(dist, 'assets', 'three-def.js'), 'export const REVISION = "170";');
  const e = new Engine({ home: tmp() });
  let port = nextPort++;
  let srv = await startServer(e, { port, uiDir: dist });
  let U = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const page = await fetch(U('/'));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /<meta name="agent-art-ui-token" content="[0-9a-f]{48}">/);
    const js = await fetch(U('/assets/index-abc.js'));
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(js.headers.get('cache-control'), /immutable/);
    assert.equal(await (await fetch(U('/assets/three-def.js'))).text(), 'export const REVISION = "170";');
    assert.equal((await fetch(U('/assets/nope.js'))).status, 404);
    assert.equal((await fetch(U('/vendor/three/three.module.min.js'))).status, 404);
  } finally {
    await close(srv);
  }
  // no build: a page that says what to run (still carrying the token for npm run dev:ui), API unaffected
  port = nextPort++;
  srv = await startServer(e, { port, uiDir: path.join(dist, 'missing') });
  U = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const page = await fetch(U('/'));
    assert.equal(page.status, 503);
    const html = await page.text();
    assert.match(html, /npm run build:ui/);
    assert.match(html, /<meta name="agent-art-ui-token" content="[0-9a-f]{48}">/);
    const asset = await fetch(U('/assets/index-abc.js'));
    assert.equal(asset.status, 404);
    assert.match((await asset.json()).error, /npm run build:ui/);
    assert.equal((await (await fetch(U('/api/health'))).json()).app, 'agent-art');
  } finally {
    await close(srv);
  }
});

test('ui: sources load three.js from the npm package through the bundler (no vendored copy, no import map)', () => {
  const web = (p) => new URL(`../web/${p}`, import.meta.url);
  assert.ok(!fs.existsSync(web('vendor')));
  const html = fs.readFileSync(web('index.html'), 'utf8');
  assert.doesNotMatch(html, /importmap/);
  // step 18: the Svelte shell is the only entry; the legacy app.js / ui/ / svelte/ are gone
  assert.match(html, /<script type="module" src="\.\/src\/main\.ts"><\/script>/);
  for (const gone of ['app.js', 'ui', 'svelte', 'style.css']) assert.ok(!fs.existsSync(web(gone)), gone);
  assert.ok(fs.existsSync(web('src/main.ts')) && fs.existsSync(web('src/App.svelte')));
  const viewer = ['three.ts', 'channels.ts', 'ModelViewer.ts'].map((f) => fs.readFileSync(web(`src/viewers/model/${f}`), 'utf8')).join('\n');
  for (const m of ['three', 'three/addons/controls/OrbitControls.js', 'three/addons/loaders/GLTFLoader.js', 'three/addons/helpers/VertexNormalsHelper.js']) assert.ok(viewer.includes(`import('${m}')`), m);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.ok(pkg.devDependencies.three && pkg.files.includes('dist/ui/') && !pkg.files.includes('public/'));
  assert.equal(pkg.scripts.prepack, 'npm run build:ui');
  assert.ok(!pkg.scripts.postinstall && !pkg.scripts.prepare);
});

test('ui: audio wav + analysis endpoints', async () => {
  const e = new Engine({ home: tmp() });
  e.run('audio_sfx', { name: 'blip', recipe: 'click', seed: 1 });
  const port = nextPort++;
  const srv = await startServer(e, { port });
  try {
    const wav = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/audio/blip.wav`)).arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    const an = await (await fetch(`http://127.0.0.1:${port}/api/audio/blip/analysis`)).json();
    assert.ok(an.image && an.report && an.stats);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/audio/blip`)).json()).kind, 'sfx');
  } finally {
    await close(srv);
  }
});

test('ui: build notices plugin collects one notice per bundled package and enforces the licence allow-list', async () => {
  const { noticesFor, packageRootOf, licenceIds, formatNotices } = await import('../scripts/vite-notices.js');
  const files = {
    '/r/node_modules/svelte/package.json': JSON.stringify({ name: 'svelte', version: '5.0.0', license: 'MIT' }),
    '/r/node_modules/svelte/LICENSE.md': 'MIT text svelte',
    '/r/node_modules/@xyflow/svelte/package.json': JSON.stringify({ name: '@xyflow/svelte', version: '1.7.1', license: 'MIT' }),
    '/r/node_modules/@xyflow/svelte/node_modules/d3-zoom/package.json': JSON.stringify({ name: 'd3-zoom', version: '3.0.0', license: 'ISC' }),
    '/r/node_modules/@xyflow/svelte/node_modules/d3-zoom/LICENSE': 'ISC text',
    '/r/node_modules/gpl/package.json': JSON.stringify({ name: 'gpl', version: '1.0.0', license: 'GPL-3.0' }),
    '/r/node_modules/@internationalized/date/package.json': JSON.stringify({ name: '@internationalized/date', version: '3.0.0', license: 'Apache-2.0' }),
    '/r/node_modules/toolbelt/package.json': JSON.stringify({ name: 'toolbelt', version: '0.10.7' }),
    '/r/node_modules/toolbelt/LICENSE': 'MIT License\n\nCopyright (c) 2024',
    '/r/node_modules/nolicence/package.json': JSON.stringify({ name: 'nolicence', version: '1.0.0' }),
  };
  const read = (p) => files[p] ?? null;
  const list = (dir) => Object.keys(files).filter((f) => f.startsWith(dir + '/') && !f.slice(dir.length + 1).includes('/')).map((f) => f.slice(dir.length + 1));
  assert.equal(packageRootOf('C:\\r\\node_modules\\@xyflow\\svelte\\dist\\index.js'), 'C:/r/node_modules/@xyflow/svelte');
  assert.equal(packageRootOf('/r/web/src/main.ts'), null);
  assert.deepEqual(licenceIds('(MIT OR Apache-2.0)'), ['MIT', 'Apache-2.0']);
  const ids = ['/r/node_modules/svelte/src/index.js', '/r/node_modules/svelte/src/other.js', '/r/node_modules/@xyflow/svelte/dist/a.js', '/r/node_modules/@xyflow/svelte/node_modules/d3-zoom/src/zoom.js', '/r/web/src/main.ts'];
  const n = noticesFor(ids, read, list);
  assert.deepEqual(n.map((x) => x.name), ['@xyflow/svelte', 'd3-zoom', 'svelte']);
  assert.equal(n.find((x) => x.name === 'd3-zoom').text, 'ISC text');
  assert.match(n.find((x) => x.name === '@xyflow/svelte').text, /no licence file/);
  assert.match(formatNotices(n), /svelte 5\.0\.0\nLicence: MIT/);
  assert.throws(() => noticesFor(['/r/node_modules/gpl/index.js'], read, list), /GPL-3\.0.*not in the allow-list/);
  assert.throws(() => noticesFor(['/r/node_modules/@internationalized/date/x.js'], read, list), /must not be bundled/);
  assert.equal(noticesFor(['/r/node_modules/toolbelt/dist/index.js'], read, list)[0].licence, 'MIT');
  assert.throws(() => noticesFor(['/r/node_modules/nolicence/index.js'], read, list), /licence "none" is not in the allow-list/);
});
