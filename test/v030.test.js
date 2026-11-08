// Regression tests for the 0.3.0 fix pass (issues reported by the Sanctum Burn agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { startServer } from '../src/server.js';
import { Backend, probe, sameHome } from '../src/mcp.js';
import { resolveHome, batchOutPath } from '../src/cli.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-v3-'));
// test servers stay well away from the shared 7420-7440 range
const PORT = 7561;
const closeServer = (srv) => new Promise((res) => { srv.close(() => res()); srv.closeAllConnections?.(); });

// --- 1. workspace: no implicit legacy fallback --------------------------------------------------
test('workspace defaults to ~/.agent-art unless --home or AGENT_ART_HOME', () => {
  const hd = path.join(tmp(), 'user');
  assert.equal(resolveHome(undefined, {}, hd), path.join(hd, '.agent-art'));
  assert.equal(resolveHome(true, {}, hd), path.join(hd, '.agent-art'));
  assert.equal(resolveHome(undefined, { AGENT_ART_HOME: '/x/env' }, hd), path.resolve('/x/env'));
  assert.equal(resolveHome('/x/flag', { AGENT_ART_HOME: '/x/env' }, hd), path.resolve('/x/flag'));
  // the bin no longer probes ROOT/workspace to pick a home
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'agent-art.js'), 'utf8');
  assert.doesNotMatch(src, /existsSync\(legacy\) \? legacy/);
  assert.match(src, /resolveHome\(flag\('home'\)/);
});

// --- 10. batch: absolute out paths are used as they are ----------------------------------------
test('batch: absolute out path is not joined onto --out-dir', () => {
  const abs = path.join(tmp(), 'abs.png');
  assert.equal(batchOutPath('renders', abs, 0), abs);
  assert.equal(batchOutPath('renders', 'k.png', 0), path.join('renders', 'k.png'));
  assert.equal(batchOutPath('renders', undefined, 3), path.join('renders', 'batch_3.png'));
  const home = tmp();
  const env = { ...process.env, AGENT_ART_HOME: home, AGENT_ART_PORT: '1' };
  const outDir = tmp();
  const batch = [
    { op: 'create', args: { name: 'k', width: 4 } },
    { op: 'render', args: { canvas: 'k' }, out: abs },
  ].map((x) => JSON.stringify(x)).join('\n');
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'batch', '-', '--out-dir', outDir], { input: batch, env, encoding: 'utf8' });
  assert.ok(fs.existsSync(abs));
  assert.equal(fs.readdirSync(outDir).length, 0);
});

// --- 2. MCP backend: a dead proxied server never switches the session's workspace ---------------
test('health reports home; backend recovers on the same workspace', async () => {
  const homeA = tmp();
  const homeB = tmp();
  const engA = new Engine({ home: homeA });
  const srvA = await startServer(engA, { port: PORT });
  const srvB = await startServer(new Engine({ home: homeB }), { port: PORT + 1 });
  const logs = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { logs.push(String(s)); return true; };
  const be = new Backend({ port: PORT, home: tmp(), span: 3 });
  try {
    const h = await probe(PORT);
    assert.equal(h.ok, true);
    assert.ok(sameHome(h.home, homeA));
    await be.init();
    assert.equal(be.remote, true);
    assert.ok(sameHome(be.home, homeA), 'proxying adopts the server workspace');
    await be.call('create', { name: 'before', width: 4 });
    engA.flush();
    await closeServer(srvA); // the shared server dies mid-session
    const r = await be.call('list', {});
    assert.equal(be.remote, false, 'the server on a different home (B) is not used');
    assert.equal(be.port, PORT);
    assert.ok(sameHome(be.engine.home, homeA), 'hosts locally on the same workspace');
    assert.ok(JSON.stringify(r).includes('before'));
    assert.ok(logs.some((l) => /went away/.test(l)) && logs.some((l) => /same workspace/.test(l)));
  } finally {
    process.stderr.write = orig;
    await be.close();
    await closeServer(srvB);
  }
});

test('backend switches to another live server on the same workspace', async () => {
  const homeA = tmp();
  const eA = new Engine({ home: homeA });
  const srvA = await startServer(eA, { port: PORT + 4 });
  const srvA2 = await startServer(new Engine({ home: homeA }), { port: PORT + 6 });
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const be = new Backend({ port: PORT + 4, home: homeA, span: 3 });
  try {
    await be.init();
    await closeServer(srvA);
    await be.call('list', {});
    assert.equal(be.remote, true);
    assert.equal(be.port, PORT + 6);
  } finally {
    process.stderr.write = orig;
    await be.close();
    await closeServer(srvA2);
  }
});

test('fix 18: release 0.3.0: version, changelog, README', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 0.3.0 or any later release (the 0.3.0 changelog entry must stay)
  const [maj, min] = pkg.version.split('.').map(Number);
  assert.ok(maj > 0 || min >= 3, `version ${pkg.version} >= 0.3.0`);
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(cl, /^## 0\.3\.0/m);
  for (const k of ['art_model', 'art_audio', 'workspace', 'sample_rate', 'lathe', 'MASK', 'emissive', 'loop_seam']) assert.ok(cl.includes(k), `changelog mentions ${k}`);
  const rd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(rd, /no implicit fallback to a `\.\/workspace`/);
  assert.match(rd, /sample_rate:48000/);
  assert.match(rd, /simplify/);
});
