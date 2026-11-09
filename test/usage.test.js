import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { debugLevel, usageFile, estimateTokens, pngSize, imageTokens, measureContent, callAction, UsageLog, summarizeUsage, formatUsage, transcriptUsage, readUsage } from '../src/usage.js';
import { encodePNG } from '../src/png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-usage-'));

test('usage: debug level from flag and env', () => {
  assert.equal(debugLevel(undefined, {}), null);
  assert.equal(debugLevel(true, {}), 'on');
  assert.equal(debugLevel('full', {}), 'full');
  assert.equal(debugLevel(undefined, { AGENT_ART_DEBUG: '1' }), 'on');
  assert.equal(debugLevel(undefined, { AGENT_ART_DEBUG: 'FULL' }), 'full');
  assert.equal(debugLevel(undefined, { AGENT_ART_DEBUG: 'off' }), null);
  assert.equal(debugLevel('off', { AGENT_ART_DEBUG: '1' }), null, 'the flag wins over the env');
  assert.equal(usageFile('/h', {}, new Date('2026-11-09T10:00:00Z')), path.join('/h', 'debug', 'usage-2026-11-09.jsonl'));
  assert.equal(usageFile('/h', { AGENT_ART_DEBUG_FILE: 'x.jsonl' }), path.resolve('x.jsonl'));
});

test('usage: token and image estimates', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('{"a":1}'), 5); // {" a ": 1 } -> punctuation runs, word, digits
  assert.ok(estimateTokens('internationalization') >= 3);
  const png = encodePNG(64, 32, new Uint8ClampedArray(64 * 32 * 4)).toString('base64');
  assert.deepEqual(pngSize(png), { w: 64, h: 32 });
  assert.equal(pngSize('bm90IGEgcG5n'), null);
  assert.equal(imageTokens(750, 1), 1);
  assert.equal(imageTokens(1000, 1000), 1334);
  assert.ok(imageTokens(4000, 4000) <= 1534, 'big images are scaled to ~1.15 MP first');
  const m = measureContent([{ type: 'text', text: 'hello world' }, { type: 'image', data: png, mimeType: 'image/png' }]);
  assert.equal(m.images[0].w, 64);
  assert.equal(m.tokens, m.text_tokens + m.image_tokens);
  assert.equal(callAction('art_help', { topic: 'rig' }), 'topic:rig');
  assert.equal(callAction('art_draw', { commands: [{ op: 'rect' }, { op: 'rect' }, { op: 'shade' }] }), 'rect+shade');
  assert.equal(callAction('art_rig', { action: 'animate' }), 'animate');
});

test('usage: log records, repeats, retries and the report', () => {
  const lines = [];
  const u = new UsageLog({ file: 'unused', write: (l) => lines.push(l), version: 't' });
  u.start({ client: { name: 'c', version: '1' }, instructions: 'hi there', tools: [{ name: 'art_a', description: 'x'.repeat(60), inputSchema: {} }], prompts: [] });
  u.call({ tool: 'art_a', args: { action: 'go', path: 'C:/secret/file.png' }, content: [{ type: 'text', text: 'Error: bad' }], ok: false, error: 'bad width 12' });
  u.call({ tool: 'art_a', args: { action: 'go', w: 1 }, content: [{ type: 'text', text: 'ok' }], ms: 5, ops: [{ op: 'draw', ms: 4 }] });
  u.call({ tool: 'art_a', args: { action: 'go', w: 1 }, content: [{ type: 'text', text: 'ok' }], ms: 7 });
  u.call({ tool: 'art_help', args: { topic: 'rig' }, content: [{ type: 'text', text: 'x '.repeat(50) }] });
  const recs = lines.map((l) => JSON.parse(l));
  assert.equal(recs[0].type, 'session');
  assert.equal(recs[0].tools, 1);
  assert.equal(recs[1].args.path, '<str 18>', 'default level keeps the argument shape, not paths');
  assert.equal(recs[2].retry_of, 1);
  assert.equal(recs[3].repeat, 2);
  const full = new UsageLog({ file: 'unused', level: 'full', write: (l) => lines.push(l) });
  full.call({ tool: 'art_a', args: { path: 'C:/x' } });
  assert.equal(JSON.parse(lines.at(-1)).args.path, 'C:/x', 'full keeps the arguments');
  const rep = summarizeUsage(recs);
  assert.equal(rep.calls, 4);
  assert.equal(rep.errors, 1);
  assert.equal(rep.repeats, 1);
  assert.equal(rep.retries, 1);
  assert.equal(rep.by_tool.find((t) => t.key === 'art_a').calls, 3);
  assert.deepEqual(rep.help_topics, [['topic:rig', 1]]);
  assert.match(rep.errors_top[0].error, /^art_a go: bad width N$/);
  assert.deepEqual(rep.clients, ['c 1']);
  const text = formatUsage(rep);
  assert.match(text, /1 session\(s\), 4 tool calls, 1 errors/);
  assert.match(text, /By tool/);
  assert.equal(summarizeUsage(recs, { tool: 'art_help' }).calls, 1);
  assert.equal(summarizeUsage(recs, { since: '2999' }).calls, 0);
  // a logging failure never throws into the server
  new UsageLog({ write: () => { throw new Error('disk full'); } }).call({ tool: 'x' });
});

test('usage: Claude Code transcript gives the real token usage', () => {
  const t = [
    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'mcp__agent-art__art_draw', input: { canvas: 'a' } }] } },
    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: 'text', text: 'same message, second block' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done!' }] }] } },
    { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } },
    'not json',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  const u = transcriptUsage(t);
  assert.equal(u.turns, 2, 'one streamed message counts once');
  assert.equal(u.input, 13);
  assert.equal(u.cache_read, 100);
  assert.equal(u.calls, 1);
  assert.equal(u.by_tool.art_draw.result_chars, 5);
});

test('usage: mcp --debug logs every call, `agent-art usage` reports it', async () => {
  const home = tmp();
  const port = 7970 + Math.floor(Math.random() * 20);
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), '--debug', 'mcp', '--port', String(port), '--home', home], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_ART_DEBUG: '', AGENT_ART_DEBUG_FILE: '' } });
  const replies = new Map();
  let buf = '', err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); }
  });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const call = (id, name, args) => send({ id, method: 'tools/call', params: { name, arguments: args } });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '9' } } });
  send({ id: 2, method: 'tools/list' });
  call(3, 'art_create_canvas', { name: 'u', width: 8 });
  call(4, 'art_draw', { canvas: 'u', commands: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#f00' }], preview: true });
  call(5, 'art_draw', { canvas: 'nope', commands: [] });
  call(6, 'art_help', { topic: 'rig' });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  assert.match(err, /debug: logging tool usage \(on\)/, '--debug before the command still runs mcp');
  assert.ok(replies.get(4).result.content.some((c) => c.type === 'image'));
  const dir = path.join(home, 'debug');
  const recs = readUsage([dir]);
  const calls = recs.filter((r) => r.type === 'call');
  assert.equal(recs[0].type, 'session');
  assert.equal(recs[0].client.name, 'test-client');
  assert.ok(recs[0].tools_tokens > 1000, 'tool definitions measured');
  assert.equal(recs.filter((r) => r.type === 'list')[0].method, 'tools/list');
  assert.equal(calls.length, 4);
  const draw = calls.find((c) => c.seq === 2);
  assert.equal(draw.tool, 'art_draw');
  assert.ok(draw.reply_image_tokens > 0 && draw.images[0].w > 0);
  assert.ok(draw.ops.some((o) => o.op === 'draw'));
  assert.equal(calls.find((c) => c.seq === 3).ok, false);
  assert.equal(calls.find((c) => c.seq === 4).action, 'topic:rig');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'usage', '--home', home], { encoding: 'utf8', env: { ...process.env, AGENT_ART_DEBUG_FILE: '' } });
  assert.match(out, /1 session\(s\), 4 tool calls, 1 errors/);
  assert.match(out, /clients: test-client 9/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'usage', dir, '--json', '--tool', 'art_draw'], { encoding: 'utf8' }));
  assert.equal(json.calls, 2);
});

test('usage: off by default (no debug folder)', async () => {
  const home = tmp();
  const port = 7990 + Math.floor(Math.random() * 9);
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'agent-art.js'), 'mcp', '--port', String(port), '--home', home], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_ART_DEBUG: '' } });
  p.stdout.on('data', () => {});
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'art_list', arguments: {} } }) + '\n');
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  assert.equal(fs.existsSync(path.join(home, 'debug')), false);
});
