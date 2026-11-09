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
import { debugLevel, readUsage, summarizeUsage, formatUsage, transcriptUsage, formatTranscript, UsageLog, usageFile } from '../src/usage.js';

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
// --debug [full|on|off]: only those words are its value, so `--debug mcp` still runs mcp
const debugFlag = (() => {
  const i = argv.indexOf('--debug');
  if (i < 0) return undefined;
  const v = argv[i + 1];
  const takes = v && /^(full|on|off|1|0|true|false)$/i.test(v);
  argv.splice(i, takes ? 2 : 1);
  return takes ? v : true;
})();
const [cmd = 'help', ...rest] = argv;

const USAGE = `agent-art — pixel art editor for AI agents, with a live web UI

  agent-art serve [--port 7420] [--home DIR] [--open]   run the web UI + API
  agent-art mcp   [--port 7420] [--home DIR] [--open] [--debug [full]]   MCP stdio server; always runs the web UI
        (reuses a running 'serve', else hosts it; next free port if taken). --open / AGENT_ART_OPEN=1 opens the browser.
        --debug / AGENT_ART_DEBUG=1 logs every tool call (estimated tokens, time, errors, engine ops) to
        <home>/debug/usage-<date>.jsonl; "full" also keeps the arguments; AGENT_ART_DEBUG_FILE picks the file
  agent-art usage [FILE|DIR ...] [--since 2026-11-01] [--session ID] [--tool art_x] [--json] [--transcript F.jsonl]
        report from the debug logs (default <home>/debug): cost per tool and action, biggest replies, errors,
        repeats, help reads, suggestions. --transcript adds the real token usage from a Claude Code session log
  agent-art op <op> [json | @file.json | -] [--out f.png]  run one operation ("-" reads the JSON from stdin)
  agent-art batch <file.jsonl | file.json | -> [--out-dir DIR] [--keep-going]
        run many ops in order; each item is {"op": "...", "args": {...}, "out": "optional.png"}
  agent-art tools                      the MCP tool list + server instructions (for agents without MCP)
  agent-art tool <art_tool> [json | @file.json | -] [--out view.png]
        call one MCP tool exactly as an MCP client would; an image reply is written to --out
  agent-art help [topic [section] | op] [--full]   guides (workflow, textures, characters, animation, rig, 3d, ...;
        long ones print a core + section index) or a draw command's usage
  agent-art skills [--out DIR]         write the agent skills as <DIR>/<name>/SKILL.md (default ./agent-art-skills)

Tip (Windows / any shell): avoid quoting problems by piping JSON on stdin:
  node bin/agent-art.js op draw - <<'EOF'
  {"canvas":"stone","commands":[{"op":"rect","color":"#888"}]}
  EOF

ops: ${OP_NAMES.join(', ')}
env: AGENT_ART_PORT, AGENT_ART_HOME, AGENT_ART_OPEN, AGENT_ART_DEBUG, AGENT_ART_DEBUG_FILE (workspace: ${home})`;

/** Debug usage log for CLI calls (--debug / AGENT_ART_DEBUG); AGENT_ART_DEBUG_SESSION groups a run's calls. */
let cliLog;
function cliUsage() {
  if (cliLog !== undefined) return cliLog;
  const level = debugLevel(debugFlag);
  cliLog = level ? new UsageLog({ file: usageFile(home), level, version: VERSION, session: process.env.AGENT_ART_DEBUG_SESSION || undefined }) : null;
  return cliLog;
}

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
    const debug = debugLevel(debugFlag); // --debug [full] or AGENT_ART_DEBUG
    await runMcp({ port, home, open: open || /^(1|true|yes)$/i.test(process.env.AGENT_ART_OPEN || ''), debug });
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
    const cliNote = 'CLI bridge: agent-art tool <art_tool> <json|-> [--out view.png]. --out is only written when the reply has an image. Each call is a fresh process: art_undo history only survives between calls while "agent-art serve" is running (same AGENT_ART_HOME / port).\n';
    const text = [`${INSTRUCTIONS}\n`, cliNote, ...TOOLS.map((t) => `${t.name}: ${t.description}\n  args: ${Object.keys(t.inputSchema.properties || {}).join(', ')}\n`)].join('\n');
    console.log(text);
    // what a CLI agent loads instead of the MCP tool list
    cliUsage()?.start({ client: { name: 'cli' }, instructions: INSTRUCTIONS, tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), prompts: [] });
    cliUsage()?.list('cli/tools', text);
  } else if (cmd === 'tool') {
    const [name, json] = rest;
    if (!name) throw new Error('usage: agent-art tool <art_tool> <json>');
    const out = flag('out') || 'view.png';
    const runner = await makeRunner();
    const usage = cliUsage();
    const args = parseArgs(json);
    const ops = [];
    const run = !usage ? runner.run : async (op, a) => { const o0 = performance.now(); try { return await runner.run(op, a); } finally { ops.push({ op, ms: Math.round(performance.now() - o0) }); } };
    const t0 = performance.now();
    try {
      const content = await runTool(name, args, run);
      usage?.call({ tool: name, args, content, ms: performance.now() - t0, ok: true, ops });
      for (const c of content) {
        if (c.type === 'text') console.log(c.text);
        else if (c.type === 'image') { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, Buffer.from(c.data, 'base64')); console.log(`[image written to ${path.resolve(out)}]`); }
      }
    } catch (e) {
      usage?.call({ tool: name, args, content: [{ type: 'text', text: `Error: ${e.message}` }], ms: performance.now() - t0, ok: false, error: e.message, ops });
      throw e;
    } finally {
      runner.close();
    }
  } else if (cmd === 'help' && rest[0]) {
    const full = rest.includes('--full');
    const [what, section] = rest.filter((r) => r !== '--full');
    if (SKILLS[what]) console.log(skillText(what));
    else if (TOPICS[what] || what === 'index' || what === 'ops') console.log(helpText({ topic: what, section, full }));
    else console.log(helpText({ op: what }));
  } else if (cmd === 'usage') {
    const opt = (n) => { const v = flag(n); return v === true ? undefined : v; };
    const since = opt('since'), session = opt('session'), tool = opt('tool'), transcript = opt('transcript');
    const json = flag('json');
    const sources = rest.length ? rest : [process.env.AGENT_ART_DEBUG_FILE || path.join(home, 'debug')];
    const rep = summarizeUsage(readUsage(sources), { since, session, tool });
    const tr = transcript ? transcriptUsage(fs.readFileSync(transcript, 'utf8')) : null;
    if (json) console.log(JSON.stringify(tr ? { ...rep, transcript: tr } : rep, null, 2));
    else {
      if (!rep.calls && !rep.sessions) console.log(`no usage records in ${sources.join(', ')} (run the MCP server with --debug or AGENT_ART_DEBUG=1)`);
      else console.log(formatUsage(rep));
      if (tr) console.log('\n' + formatTranscript(tr));
    }
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
