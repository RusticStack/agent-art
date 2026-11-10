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

// ---- step 21: build stamp, staleness, startup line, health, art_open_ui note, pack checks ----

/** A source checkout (web/src + web/index.html) or a package layout (no web/), with dist/ui. */
function uiLayout({ checkout = true, built = true, stamp } = {}) {
  const root = tmp();
  const dist = path.join(root, 'dist', 'ui');
  if (checkout) {
    fs.mkdirSync(path.join(root, 'web', 'src', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(root, 'web', 'src', 'main.ts'), 'export {};');
    fs.writeFileSync(path.join(root, 'web', 'src', 'state', 'x.ts'), 'export {};');
  }
  if (built) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    if (stamp) fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify(stamp));
  }
  // every source an hour old, so a stamp of "now" is fresh
  const old = new Date(Date.now() - 3600e3);
  if (checkout) for (const f of ['web/index.html', 'web/src/main.ts', 'web/src/state/x.ts']) fs.utimesSync(path.join(root, f), old, old);
  return { root, dist };
}

/** Run fn while collecting process.stderr.write. */
async function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s, ...rest) => { lines.push(String(s)); return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true; };
  try { return { result: await fn(), lines }; } finally { process.stderr.write = orig; }
}

test('ui: uiBuildStatus (missing, checkout without stamp, fresh, older than a source, version, package layout)', async () => {
  const { uiBuildStatus, uiSourcesMtime, VERSION } = await import('../src/server.js');
  // missing dir
  let L = uiLayout({ built: false });
  assert.deepEqual({ ...uiBuildStatus(L.dist), reason: undefined }, { built: false, stale: false, reason: undefined });
  assert.match(uiBuildStatus(L.dist).reason, /is missing/);
  // built, checkout layout, no build.json: stale
  L = uiLayout();
  assert.deepEqual(uiBuildStatus(L.dist), { built: true, stale: true, reason: 'build.json is missing' });
  // fresh stamp
  L = uiLayout({ stamp: { version: VERSION, builtAt: Date.now() } });
  assert.deepEqual(uiBuildStatus(L.dist), { built: true, stale: false });
  // a source touched after the build (nested under web/src), and web/index.html alone
  const later = new Date(Date.now() + 60e3);
  fs.utimesSync(path.join(L.root, 'web/src/state/x.ts'), later, later);
  assert.equal(uiBuildStatus(L.dist).stale, true);
  assert.match(uiBuildStatus(L.dist).reason, /sources changed/);
  L = uiLayout({ stamp: { version: VERSION, builtAt: Date.now() } });
  fs.utimesSync(path.join(L.root, 'web/index.html'), later, later);
  assert.equal(uiBuildStatus(L.dist).stale, true);
  // another version
  L = uiLayout({ stamp: { version: '0.0.1', builtAt: Date.now() } });
  assert.equal(uiBuildStatus(L.dist).stale, true);
  assert.match(uiBuildStatus(L.dist).reason, /0\.0\.1/);
  // unreadable stamp
  L = uiLayout();
  fs.writeFileSync(path.join(L.dist, 'build.json'), '{oops');
  assert.equal(uiBuildStatus(L.dist).stale, true);
  // package layout (no web/): never stale, even without build.json or with an old one
  L = uiLayout({ checkout: false });
  assert.deepEqual(uiBuildStatus(L.dist), { built: true, stale: false });
  assert.equal(uiSourcesMtime(L.root), null);
  L = uiLayout({ checkout: false, stamp: { version: '0.0.1', builtAt: 1 } });
  assert.deepEqual(uiBuildStatus(L.dist), { built: true, stale: false });
  // a precomputed sources mtime skips the walk
  L = uiLayout({ stamp: { version: VERSION, builtAt: 1000 } });
  assert.equal(uiBuildStatus(L.dist, { sourcesMtime: 999 }).stale, false);
  assert.equal(uiBuildStatus(L.dist, { sourcesMtime: 1001 }).stale, true);
  assert.equal(uiBuildStatus(L.dist, { sourcesMtime: null }).stale, false);
});

test('ui: startup prints one stderr line when the UI is stale or missing; /api/health has ui {built, stale}', async () => {
  const { UI_STALE, UI_NOT_BUILT, VERSION } = await import('../src/server.js');
  const e = new Engine({ home: tmp() });
  // stale checkout
  let L = uiLayout();
  let port = nextPort++;
  let { result: srv, lines } = await captureStderr(() => startServer(e, { port, uiDir: L.dist }));
  try {
    assert.deepEqual(lines, [`${UI_STALE}\n`], 'one line, at startup (before any request)');
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.app, 'agent-art');
    assert.ok(h.version && h.pid && h.home && 'canvases' in h, 'existing fields unchanged');
    assert.deepEqual(h.ui, { built: true, stale: true });
    // a rebuild while the server runs clears it (only build.json is re-read; the sources were walked at startup)
    fs.writeFileSync(path.join(L.dist, 'build.json'), JSON.stringify({ version: VERSION, builtAt: Date.now() }));
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ui, { built: true, stale: false });
  } finally {
    await close(srv);
  }
  // fresh: nothing printed
  L = uiLayout({ stamp: { version: VERSION, builtAt: Date.now() } });
  port = nextPort++;
  ({ result: srv, lines } = await captureStderr(() => startServer(e, { port, uiDir: L.dist })));
  try {
    assert.deepEqual(lines, []);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ui, { built: true, stale: false });
  } finally {
    await close(srv);
  }
  // not built: the existing text at startup, not again on the first page request
  L = uiLayout({ built: false });
  port = nextPort++;
  const cap = await captureStderr(async () => {
    const s = await startServer(e, { port, uiDir: L.dist });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 503);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ui, { built: false, stale: false });
    return s;
  });
  try {
    assert.deepEqual(cap.lines, [`${UI_NOT_BUILT} (${path.resolve(L.dist)} is missing)\n`]);
  } finally {
    await close(cap.result);
  }
});

test('ui: art_open_ui reply note (not built / stale / fine) with its input schema unchanged', async () => {
  const { uiBuildNote } = await import('../src/server.js');
  const { TOOLS } = await import('../src/mcp.js');
  assert.equal(uiBuildNote({ built: false, stale: false }, '/repo'), 'web UI not built: run npm run build:ui in /repo');
  assert.equal(uiBuildNote({ built: true, stale: true }, '/repo'), 'web UI build is older than the web/ sources: run npm run build:ui in /repo');
  assert.equal(uiBuildNote({ built: true, stale: false }, '/repo'), null);
  assert.equal(uiBuildNote(undefined), null);
  assert.match(uiBuildNote({ built: false, stale: false }), /run npm run build:ui in .+/);
  const t = TOOLS.find((x) => x.name === 'art_open_ui');
  assert.deepEqual(t.inputSchema, { type: 'object', properties: { canvas: { type: 'string' } } });
});

test('ui: the build stamp plugin writes build.json {version, builtAt} into the resolved outDir', async () => {
  const { buildStamp } = await import('../vite.config.js');
  const root = tmp();
  const p = buildStamp('9.9.9', () => 1234);
  assert.equal(p.apply, 'build');
  p.configResolved({ root, build: { outDir: 'out/ui' } });
  p.closeBundle();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'out', 'ui', 'build.json'), 'utf8')), { version: '9.9.9', builtAt: 1234 });
  const cfg = (await import('../vite.config.js')).default;
  assert.ok(cfg.plugins.some((x) => x && x.name === 'agent-art-build-stamp'));
});

test('ui: pack checks (plan 7.2) on a package file list', async () => {
  const { packProblems, packFileList } = await import('../scripts/check-ui-build.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const good = ['package.json', 'README.md', 'LICENSE', 'bin/agent-art.js', 'src/server.js', 'dist/ui/index.html', 'dist/ui/build.json', 'dist/ui/THIRD-PARTY-NOTICES.txt',
    'dist/ui/assets/index-Ab1.js', 'dist/ui/assets/index-Cd2.css', 'dist/ui/assets/three-Ef3.js'];
  assert.deepEqual(packProblems(good, pkg), [], 'the real package.json passes');
  assert.deepEqual(packProblems(good.map((f) => f.replace(/\//g, '\\')), pkg), [], 'Windows separators');
  const missing = packProblems(good.filter((f) => !/build\.json|three-/.test(f)), pkg);
  assert.ok(missing.includes('package lacks dist/ui/build.json'));
  assert.ok(missing.some((m) => /three-/.test(m)));
  const extra = packProblems([...good, 'web/src/main.ts', 'e2e/a.spec.ts', 'test/ui.test.js', 'docs/ui/01.png', 'scripts/x.js', 'node_modules/a/b.js', 'test-results/x',
    'playwright.config.ts', 'vite.config.js', 'svelte.config.js', 'tsconfig.json', 'dist/ui/assets/index-Ab1.js.map', 'src/meshfixtures.js'], pkg);
  assert.equal(extra.length, 13);
  const bad = packProblems(good, { ...pkg, dependencies: { three: '1' }, scripts: { ...pkg.scripts, postinstall: 'x', prepack: 'vite build' }, files: ['src/'] });
  assert.deepEqual(bad, ['package.json dependencies must be empty', 'no postinstall / prepare script allowed', 'files must list dist/ui/', 'prepack must be npm run build:ui']);
  // npm may print lines before the JSON
  const out = 'npm notice something\n' + JSON.stringify([{ name: 'x', files: [{ path: 'dist\\ui\\index.html' }, { path: 'README.md' }] }]);
  assert.deepEqual(packFileList(out), ['dist/ui/index.html', 'README.md']);
  // npm 11: an object keyed by package name
  const out11 = '> prepack\n> vite build\n\n' + JSON.stringify({ '@rusticstack/agent-art': { name: 'x', files: [{ path: 'README.md' }] } }, null, 2);
  assert.deepEqual(packFileList(out11), ['README.md']);
  assert.throws(() => packFileList('nothing'), /no JSON/);
});
