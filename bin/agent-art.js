#!/usr/bin/env node
// Agent Art CLI: `serve` (web UI + API), `mcp` (MCP stdio server), `op` (one-off operation).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Engine, OP_NAMES } from '../src/engine.js';
import { helpText, TOPICS } from '../src/docs.js';
import { SKILLS, skillFile, skillText } from '../src/skills.js';
import { startServer, APP_ID, packResult, VERSION } from '../src/server.js';
import { runMcp, openBrowser, runTool, TOOLS, INSTRUCTIONS } from '../src/mcp.js';
import { resolveHome, batchOutPath } from '../src/cli.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
};
const port = Number(flag('port') || process.env.AGENT_ART_PORT || 7420);
// Workspace: --home / AGENT_ART_HOME, else always ~/.agent-art. No implicit fallback to a
// ./workspace folder next to a source checkout (that silently split workspaces between clients).
const home = resolveHome(flag('home'), process.env, os.homedir());
const legacy = path.join(ROOT, 'workspace');
const legacyNote = () => {
  if (fs.existsSync(legacy) && path.resolve(legacy) !== home) console.error(`note: ${legacy} is no longer used implicitly (since 0.3.0); the workspace is ${home}. Pass --home "${legacy}" to use it.`);
};
const open = flag('open');
const [cmd = 'help', ...rest] = argv;

const USAGE = `agent-art — pixel art editor for AI agents, with a live web UI

  agent-art serve [--port 7420] [--home DIR] [--open]   run the web UI + API
  agent-art mcp   [--port 7420] [--home DIR] [--open]   MCP stdio server; always runs the web UI (reuses a running
        'serve', else hosts it; next free port if taken). --open / AGENT_ART_OPEN=1 opens the browser
  agent-art op <op> [json | @file.json | -] [--out f.png]  run one operation ("-" reads the JSON from stdin)
  agent-art batch <file.jsonl | file.json | -> [--out-dir DIR] [--keep-going]
        run many ops in order; each item is {"op": "...", "args": {...}, "out": "optional.png"}
  agent-art tools                      the MCP tool list + server instructions (for agents without MCP)
  agent-art tool <art_tool> [json | @file.json | -] [--out view.png]
        call one MCP tool exactly as an MCP client would; an image reply is written to --out
  agent-art help [topic | op]          guides (workflow, textures, characters, animation, rig, 3d, ...) or a draw command's usage
  agent-art skills [--out DIR]         write the agent skills as <DIR>/<name>/SKILL.md (default ./agent-art-skills)

Tip (Windows / any shell): avoid quoting problems by piping JSON on stdin:
  node bin/agent-art.js op draw - <<'EOF'
  {"canvas":"stone","commands":[{"op":"rect","color":"#888"}]}
  EOF

ops: ${OP_NAMES.join(', ')}
env: AGENT_ART_PORT, AGENT_ART_HOME, AGENT_ART_OPEN (workspace: ${home})`;

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function parseArgs(json) {
  if (!json) return {};
  if (json === '-') return JSON.parse(readStdin() || '{}');
  if (json.startsWith('@')) return JSON.parse(fs.readFileSync(json.slice(1), 'utf8'));
  return JSON.parse(json);
}

/** Runner: through the live server when it is up (so the UI updates), else in-process. */
async function makeRunner() {
  let remote = false;
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
    // the CLI is a thin client: it still uses the running server (so the UI and the shared
    // workspace stay in sync) but warns when versions differ
    remote = h.app === APP_ID;
    if (remote && h.version !== VERSION) console.error(`note: server on port ${port} is Agent Art ${h.version || '<0.2.1'}, this CLI is ${VERSION}; ops run on the server's version`);
  } catch { /* not running */ }
  if (remote) {
    return {
      run: async (op, args) => {
        const r = await (await fetch(`http://127.0.0.1:${port}/api/op`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })).json();
        if (!r.ok) throw new Error(r.error);
        return r.result;
      },
      close: () => {},
    };
  }
  const engine = new Engine({ home });
  return { run: async (op, args) => packResult(await engine.run(op, args)), close: () => engine.flush() };
}

function saveImage(result, file) {
  if (!result || !result.image) return result;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(result.image, 'base64'));
  return { ...result, image: `written to ${path.resolve(file)}` };
}

async function main() {
  if (cmd === 'serve') {
    legacyNote();
    const engine = new Engine({ home });
    await startServer(engine, { port });
    console.log(`Agent Art UI: http://localhost:${port}  (workspace: ${home})`);
    if (open) openBrowser(`http://localhost:${port}`);
    const stop = () => { engine.flush(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else if (cmd === 'mcp') {
    legacyNote();
    await runMcp({ port, home, open: open || /^(1|true|yes)$/i.test(process.env.AGENT_ART_OPEN || '') });
  } else if (cmd === 'op') {
    const [op, json] = rest;
    if (!op) throw new Error('usage: agent-art op <op> <json>');
    const out = flag('out');
    const args = parseArgs(json);
    const runner = await makeRunner();
    try {
      const result = saveImage(await runner.run(op, args), out || 'render.png');
      console.log(JSON.stringify(result, null, 2));
    } finally {
      runner.close();
    }
  } else if (cmd === 'batch') {
    const outDir = flag('out-dir') || '.';
    const keepGoing = flag('keep-going');
    const [file] = rest;
    if (!file) throw new Error('usage: agent-art batch <file.jsonl|file.json|->');
    const text = file === '-' ? readStdin() : fs.readFileSync(file, 'utf8');
    const trimmed = text.trim();
    const items = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('//')).map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`line ${i + 1}: ${e.message}`); }
    });
    const runner = await makeRunner();
    let failed = 0;
    try {
      for (const [i, it] of items.entries()) {
        const op = it.op;
        const args = it.args ?? Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'op' && k !== 'out'));
        try {
          let r = await runner.run(op, args);
          if (r && r.image) r = saveImage(r, batchOutPath(outDir, it.out, i));
          const short = JSON.stringify(r);
          console.log(`[${i}] ${op} ok ${short.length > 300 ? short.slice(0, 300) + '…' : short}`);
        } catch (e) {
          failed++;
          console.log(`[${i}] ${op} FAILED: ${e.message}`);
          if (!keepGoing) { console.log(`stopped at item ${i} of ${items.length}`); process.exitCode = 1; break; }
        }
      }
    } finally {
      runner.close();
    }
    if (failed) process.exitCode = 1;
  } else if (cmd === 'tools') {
    console.log(`${INSTRUCTIONS}
`);
    for (const t of TOOLS) console.log(`${t.name}: ${t.description}
  args: ${Object.keys(t.inputSchema.properties || {}).join(', ')}
`);
  } else if (cmd === 'tool') {
    const [name, json] = rest;
    if (!name) throw new Error('usage: agent-art tool <art_tool> <json>');
    const out = flag('out') || 'view.png';
    const runner = await makeRunner();
    try {
      const content = await runTool(name, parseArgs(json), runner.run);
      for (const c of content) {
        if (c.type === 'text') console.log(c.text);
        else if (c.type === 'image') { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, Buffer.from(c.data, 'base64')); console.log(`[image written to ${path.resolve(out)}]`); }
      }
    } finally {
      runner.close();
    }
  } else if (cmd === 'help' && rest[0]) {
    const [what] = rest;
    if (SKILLS[what]) console.log(skillText(what));
    else if (TOPICS[what] || what === 'index' || what === 'ops') console.log(helpText({ topic: what }));
    else console.log(helpText({ op: what }));
  } else if (cmd === 'skills') {
    const out = path.resolve(String(flag('out') || 'agent-art-skills'));
    for (const name of Object.keys(SKILLS)) {
      const dir = path.join(out, `agent-art-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(name));
    }
    console.log(`wrote ${Object.keys(SKILLS).length} skills to ${out}`);
  } else {
    console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
