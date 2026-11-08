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
    // static UI and the vendored three.js
    assert.match(await (await fetch(U('/'))).text(), /importmap/);
    assert.equal((await fetch(U('/vendor/three/three.module.min.js'))).status, 200);
    assert.equal((await fetch(U('/ui/viewers/model.js'))).headers.get('content-type'), 'text/javascript; charset=utf-8');
  } finally {
    await close(srv);
  }
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
