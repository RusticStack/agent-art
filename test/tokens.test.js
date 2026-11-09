// Token diet: sectioned help topics stay complete and reachable; Git Bash paths land where meant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOPICS, TOPIC_SECTIONS, topicParts, helpText } from '../src/docs.js';
import { Engine, msysPath } from '../src/engine.js';
import { runTool } from '../src/mcp.js';

test('help sections: every heading is found, in order, and core + sections == the full topic', () => {
  for (const t of Object.keys(TOPIC_SECTIONS)) {
    const { core, sections } = topicParts(t); // throws on a missing or out-of-order heading
    assert.equal(sections.length, TOPIC_SECTIONS[t].length, t);
    assert.equal([core, ...sections.map((s) => s.text)].join('\n'), TOPICS[t], `${t}: nothing lost or duplicated`);
    assert.equal(helpText({ topic: t, full: true }), TOPICS[t], `${t}: full:true is the old reply`);
    for (const s of sections) assert.ok(s.about && s.about.length > 10, `${t}.${s.id} has a written summary`);
  }
});

test('help sections: the default reply is the core + an index; sections on request; errors list the ids', () => {
  const r = helpText({ topic: '3d' });
  assert.ok(r.length < TOPICS['3d'].length / 5, `3d default reply ${r.length} chars`);
  assert.match(r, /MORE \(art_help \{topic:"3d", section:"<id>"\}/);
  for (const [id] of TOPIC_SECTIONS['3d']) assert.match(r, new RegExp(`^- ${id} \\(~\\d+ tok\\): `, 'm'));
  const two = helpText({ topic: '3d', section: 'render-cost,skinning' });
  assert.match(two, /^RENDER COST/);
  assert.match(two, /\nSKINNING/);
  assert.equal(helpText({ topic: '3d', section: ['render-cost', 'skinning'] }), two, 'array form');
  assert.throws(() => helpText({ topic: '3d', section: 'nope' }), /Unknown section nope of topic "3d"\. Sections: parts, /);
  assert.equal(helpText({ topic: 'workflow' }), TOPICS.workflow, 'short topics are unchanged');
  assert.equal(helpText({ topic: 'workflow', section: 'x' }), TOPICS.workflow, 'section is ignored on unsectioned topics');
});

test('msys paths: /c/x -> C:/x on Windows only, when the drive exists', () => {
  const yes = () => true, no = () => false;
  assert.equal(msysPath('/c/Users/x/out', 'win32', yes), 'C:/Users/x/out');
  assert.equal(msysPath('/d', 'win32', yes), 'D:/');
  assert.equal(msysPath('/c/x', 'win32', no), '/c/x', 'no such drive: unchanged');
  assert.equal(msysPath('/c/x', 'linux', yes), '/c/x', 'POSIX: unchanged');
  assert.equal(msysPath('/usr/lib', 'win32', yes), '/usr/lib', 'not a drive letter');
  assert.equal(msysPath('C:/a', 'win32', yes), 'C:/a');
  assert.equal(msysPath('./a', 'win32', yes), './a');
  assert.equal(msysPath(5, 'win32', yes), 5);
});

test('msys paths: an export to a Git Bash path lands on the drive (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-msys-'));
  const e = new Engine({ home: path.join(dir, 'home') });
  const call = async (op, a) => e.run(op, a);
  await runTool('art_create_canvas', { name: 'm', width: 4 }, call);
  const target = path.join(dir, 'out', 'm.png');
  const bash = '/' + target[0].toLowerCase() + target.slice(2).replace(/\\/g, '/'); // C:\x\y -> /c/x/y
  await runTool('art_export', { canvas: 'm', path: bash }, call);
  assert.ok(fs.existsSync(target), `written to ${target}`);
});
