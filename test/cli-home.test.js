// CLI bridge: --home wins over a live server on another workspace; images never land in the cwd;
// art_fp anchors remove on an arm drawing only takes arm points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-art.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (args, cwd) => new Promise((resolve) => {
  execFile(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, AGENT_ART_HOME: '', AGENT_ART_PORT: '' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

test('CLI runs in-process when the server on the port serves another workspace', async () => {
  const home = tmp('aa-cli-home-'), cwd = tmp('aa-cli-cwd-');
  let ops = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ app: 'agent-art', version: 'x', home: path.join(os.tmpdir(), 'someone-else') })); }
    ops++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'went to the wrong server' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = String(srv.address().port);
  try {
    const r = await cli(['--home', home, '--port', port, 'op', 'create', '{"name":"cli_home_probe","width":8,"height":8}'], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /runs in-process/);
    assert.equal(ops, 0, 'no op was sent to the other server');
    assert.ok(fs.existsSync(path.join(home, 'canvases', 'cli_home_probe.json')) || fs.readdirSync(home).length > 0, 'the canvas went to --home');
    // an image reply without --out goes to <home>/views, not the cwd
    const v = await cli(['--home', home, '--port', port, 'tool', 'art_view', '{"canvas":"cli_home_probe"}'], cwd);
    assert.equal(v.code, 0, v.stderr);
    assert.ok(fs.existsSync(path.join(home, 'views', 'view.png')), v.stdout);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written to the cwd');
  } finally { srv.close(); }
});

test('art_fp anchors remove on an arm drawing refuses non-arm names and keeps the drawing meta', () => {
  const e = new Engine({ home: tmp('aa-arm-') });
  const t = e.run('fp_template', { kind: 'arm', name: 'rm_arm', part: 'fore' });
  assert.throws(() => e.run('fp_anchors', { canvas: t.canvas, remove: ['kind'] }), /arm points/);
  assert.throws(() => e.run('fp_anchors', { canvas: t.canvas, remove: true }), /anchor names/);
  assert.equal(e.get(t.canvas).meta.fp2d.kind, 'arm');
  e.run('fp_anchors', { canvas: t.canvas, remove: ['grip'] });
  assert.equal(e.get(t.canvas).meta.fp2d.grip, undefined);
  assert.equal(e.get(t.canvas).meta.fp2d.kind, 'arm');
});
