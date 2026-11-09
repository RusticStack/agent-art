// ElevenLabs voice acting (art_audio voice / voices) against a local mock API: key lookup (env, project .env,
// never tool args), takes reused without a new request, errors with hints, the key kept out of replies and files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTool } from '../src/mcp.js';
import { Engine } from '../src/engine.js';
import { readDotEnv, findApiKey } from '../src/audio/elevenlabs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const text = (c) => c.map((x) => x.text || '').join('\n');

test('voice: .env parsing and key lookup order (environment, project .env, workspace .env)', () => {
  const d = tmp('aa-env-');
  fs.writeFileSync(path.join(d, '.env'), '# comment\nOTHER=1\nexport ELEVENLABS_API_KEY="abc 123" \n');
  assert.equal(readDotEnv(path.join(d, '.env')), 'abc 123');
  fs.writeFileSync(path.join(d, '.env'), 'ELEVENLABS_API_KEY=plain # trailing comment\n');
  assert.equal(readDotEnv(path.join(d, '.env')), 'plain');
  assert.equal(readDotEnv(path.join(d, 'none.env')), null);
  const home = tmp('aa-envh-');
  fs.writeFileSync(path.join(home, '.env'), 'ELEVENLABS_API_KEY=fromhome\n');
  assert.deepEqual(findApiKey({ cwd: d, home, env: { ELEVENLABS_API_KEY: 'fromenv' } }), { key: 'fromenv', from: 'environment variable ELEVENLABS_API_KEY' });
  assert.equal(findApiKey({ cwd: d, home, env: {} }).key, 'plain');
  assert.equal(findApiKey({ cwd: tmp('aa-empty-'), home, env: {} }).key, 'fromhome');
  assert.equal(findApiKey({ cwd: tmp('aa-empty-'), home: null, env: {} }), null);
});

test('voice: art_audio voice / voices against a mock ElevenLabs API', async (t) => {
  const log = path.join(tmp('aa-mocklog-'), 'requests.jsonl');
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'elevenlabs-mock.js'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => mock.kill());
  const port = await new Promise((res, rej) => { mock.stdout.once('data', (d) => res(Number(String(d).trim()))); mock.once('error', rej); });
  const saved = Object.fromEntries(['ELEVENLABS_API_KEY', 'XI_API_KEY', 'AGENT_ART_ELEVENLABS_URL'].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.ELEVENLABS_API_KEY; delete process.env.XI_API_KEY;
  process.env.AGENT_ART_ELEVENLABS_URL = `http://127.0.0.1:${port}`;
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  const project = tmp('aa-proj-'), home = tmp('aa-home-');
  const engine = new Engine({ home, cwd: project });
  const call = (a) => runTool('art_audio', a, (op, args) => engine.run(op, args));

  // no key anywhere: a clear error naming the env var and the project .env path, no request sent
  await assert.rejects(call({ action: 'voice', name: 'halt', text: 'Halt!', voice: 'Rachel' }), (e) => /ELEVENLABS_API_KEY/.test(e.message) && e.message.includes(path.join(project, '.env')));
  assert.equal(requests().length, 0);

  // a wrong key in the project .env: the API's 401 comes back with a hint
  fs.writeFileSync(path.join(project, '.env'), 'ELEVENLABS_API_KEY=wrong\n');
  await assert.rejects(call({ action: 'voices' }), /401[\s\S]*check the API key/);
  fs.writeFileSync(path.join(project, '.env'), 'ELEVENLABS_API_KEY=test-key\n');

  const vs = JSON.parse(text(await call({ action: 'voices' })));
  assert.equal(vs.count, 2);
  assert.deepEqual(vs.voices.map((v) => v.name), ['Rachel', 'Grim Guard']);
  assert.equal(JSON.parse(text(await call({ action: 'voices', search: 'grim' }))).voices[0].voice_id, 'BBBBBBBBBBBBBBBBBBB2');

  // a voice by name: resolved to its id, 24 kHz WAV requested, stored as a 44.1 kHz sample asset
  const n0 = requests().length;
  const r = JSON.parse(text(await call({ action: 'voice', name: 'guard_halt', text: 'Halt! Who goes there?', voice: 'grim guard', stability: 0.3, speed: 1.1, seed: 7, language: 'en' })));
  assert.equal(r.voice, 'Grim Guard'); assert.equal(r.voice_id, 'BBBBBBBBBBBBBBBBBBB2'); assert.equal(r.format, 'wav_24000'); assert.equal(r.key_from, '.env');
  assert.ok(r.duration > 0.7 && r.duration < 0.9, `duration ${r.duration}`);
  const tts = requests().slice(n0).find((q) => q.method === 'POST');
  assert.equal(tts.path, '/v1/text-to-speech/BBBBBBBBBBBBBBBBBBB2');
  assert.equal(tts.query.output_format, 'wav_24000');
  assert.ok(tts.key_ok);
  assert.deepEqual(tts.body, { text: 'Halt! Who goes there?', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.3, speed: 1.1 }, seed: 7, language_code: 'en' });
  const info = JSON.parse(text(await call({ action: 'info', name: 'guard_halt' })));
  assert.equal(info.kind, 'sample'); assert.equal(info.voice.provider, 'elevenlabs'); assert.equal(info.voice.text, 'Halt! Who goes there?');
  assert.ok(fs.existsSync(info.source));
  const an = await call({ action: 'analyze', name: 'guard_halt' });
  assert.ok(an.some((c) => c.type === 'image'));

  // the same line again: the saved take, no request; force: a new request
  const n1 = requests().length;
  const again = JSON.parse(text(await call({ action: 'voice', name: 'guard_halt', text: 'Halt! Who goes there?', voice: 'grim guard', stability: 0.3, speed: 1.1, seed: 7, language: 'en' })));
  assert.equal(again.reused, true); assert.equal(requests().length, n1);
  await call({ action: 'voice', name: 'guard_halt', text: 'Halt! Who goes there?', voice: 'grim guard', stability: 0.3, speed: 1.1, seed: 7, language: 'en', force: true });
  assert.ok(requests().length > n1);
  // a voice_id skips the voice lookup
  const n2 = requests().length;
  await call({ action: 'voice', name: 'rachel_hi', text: 'Hello.', voice: 'AAAAAAAAAAAAAAAAAAA1' });
  assert.deepEqual(requests().slice(n2).map((q) => q.method), ['POST']);

  // errors: unknown voice lists the voices; 44.1 kHz on a lower plan explains the plan limit
  await assert.rejects(call({ action: 'voice', name: 'x', text: 'Hi', voice: 'Nobody' }), /no ElevenLabs voice matches "Nobody"[\s\S]*Rachel/);
  await assert.rejects(call({ action: 'voice', name: 'x', text: 'Hi', voice: 'Rachel', sample_rate: 44100 }), /403[\s\S]*Pro tier[\s\S]*sample_rate 24000/);
  await assert.rejects(call({ action: 'voice', name: 'x', voice: 'Rachel' }), /needs "text"/);

  // the environment variable wins over the .env; the key never shows up in replies or workspace files
  process.env.ELEVENLABS_API_KEY = 'test-key';
  fs.writeFileSync(path.join(project, '.env'), 'ELEVENLABS_API_KEY=wrong\n');
  const envr = JSON.parse(text(await call({ action: 'voice', name: 'env_line', text: 'From the environment.', voice: 'Rachel' })));
  assert.equal(envr.key_from, 'environment');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
  for (const f of walk(home)) if (!f.endsWith('.wav')) assert.ok(!fs.readFileSync(f, 'utf8').includes('test-key'), f);

  // delete removes the take file too
  await call({ action: 'delete', name: 'rachel_hi' });
  assert.ok(!fs.existsSync(path.join(home, 'audio', 'voices', 'rachel_hi.wav')));
});
