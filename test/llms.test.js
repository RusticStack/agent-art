// Docs drift: llms-full.txt is regenerated in memory and must equal the committed file; the README,
// llms.txt and the MCP strings must list every tool action, help topic and skill; doc links resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLlmsFull, LLMS_FULL } from '../scripts/build-llms.js';
import { INSTRUCTIONS, TOOLS } from '../src/mcp.js';
import { TOPICS } from '../src/docs.js';
import { SKILLS, skillFile } from '../src/skills.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

test('llms-full.txt is up to date (run npm run docs:llms)', () => {
  const committed = fs.readFileSync(LLMS_FULL, 'utf8').replace(/\r\n/g, '\n');
  const fresh = buildLlmsFull();
  if (committed === fresh) return;
  const a = committed.split('\n'), b = fresh.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  assert.fail(`llms-full.txt is stale at line ${i + 1}:\n  committed: ${JSON.stringify((a[i] ?? '<end>').slice(0, 160))}\n  generated: ${JSON.stringify((b[i] ?? '<end>').slice(0, 160))}\nRun: npm run docs:llms`);
});

test('every help topic is named in the art_help description and the MCP instructions', () => {
  const help = TOOLS.find((t) => t.name === 'art_help').description;
  for (const k of Object.keys(TOPICS)) {
    assert.match(help, new RegExp(`(^|[\\s:|])${k}([\\s;|]|$)`), `art_help description lists ${k}`);
    assert.match(INSTRUCTIONS, new RegExp(`[\\s|]${k}[|}]`), `INSTRUCTIONS list ${k}`);
  }
});

test('README and llms.txt list every tool action, help topic and skill', () => {
  const readme = read('README.md'), llms = read('llms.txt');
  const rows = readme.split('\n').filter((l) => l.startsWith('| `'));
  for (const t of TOOLS) {
    const row = rows.find((l) => l.startsWith(`| \`${t.name}\` |`));
    assert.ok(row, `README tools table has ${t.name}`);
    for (const a of t.inputSchema.properties?.action?.enum || []) assert.ok(row.includes(`\`${a}\``), `README ${t.name} row lists action ${a}`);
  }
  for (const k of Object.keys(TOPICS)) {
    assert.ok(rows.some((l) => l.startsWith(`| \`${k}\` |`)), `README help topics table has ${k}`);
    assert.ok(llms.includes(`\n- ${k}: `), `llms.txt lists topic ${k}`);
  }
  for (const k of Object.keys(SKILLS)) {
    assert.ok(rows.some((l) => l.startsWith(`| \`${k}\` |`)), `README skills table has ${k}`);
    assert.ok(llms.includes(`\n- ${k}: `), `llms.txt lists skill ${k}`);
    assert.match(skillFile(k), /^---\nname: agent-art-[a-z0-9-]+\ndescription: "[^\n]+"\n---\n/, `${k} SKILL.md frontmatter`);
  }
});

test('links in the README, llms.txt and docs pages point to files that exist', () => {
  const pages = ['README.md', 'llms.txt'];
  for (const d of fs.readdirSync(path.join(ROOT, 'docs'), { withFileTypes: true })) {
    if (d.isFile() && d.name.endsWith('.md')) pages.push(`docs/${d.name}`);
    else if (d.isDirectory() && fs.existsSync(path.join(ROOT, 'docs', d.name, 'README.md'))) pages.push(`docs/${d.name}/README.md`);
  }
  const missing = [];
  for (const page of pages) {
    const text = read(page).replace(/```[\s\S]*?```/g, '');
    for (const [, raw] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      let target = raw.split('#')[0];
      const gh = target.match(/^https:\/\/github\.com\/RusticStack\/agent-art\/blob\/main\/(.+)$/);
      if (gh) target = gh[1];
      else if (!target || /^[a-z]+:/i.test(target)) continue;
      else target = path.posix.join(path.posix.dirname(page), target);
      if (!fs.existsSync(path.join(ROOT, target))) missing.push(`${page}: ${raw}`);
    }
  }
  assert.deepEqual(missing, []);
});
