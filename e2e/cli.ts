// The only way the e2e suite calls the agent-art CLI: always with --home and --port, so it can never
// reach the user's workspace or the server on 7420. JSON goes over stdin (no shell quoting on Windows).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, '..');
export const STATE_FILE = path.join(import.meta.dirname, '.state.json');

export interface E2EState { port: number; home: string; pid: number; log: string }
export const readState = (): E2EState => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

function guard(home: string, port: number) {
  if (!home || !port) throw new Error('e2e cli: --home and --port are required');
  if (port === 7420) throw new Error('e2e cli: refusing port 7420 (the user server)');
}

/** Run one MCP tool through the CLI bridge (agent-art tool <name> -). Returns stdout. */
export function runTool(name: string, args: unknown, o: { home?: string; port?: number; out?: string } = {}): string {
  const st = o.home && o.port ? { home: o.home, port: o.port } : readState();
  guard(st.home, st.port);
  const argv = ['bin/agent-art.js', '--home', st.home, '--port', String(st.port), 'tool', name, '-'];
  if (o.out) argv.push('--out', o.out);
  return execFileSync(process.execPath, argv, { cwd: ROOT, input: JSON.stringify(args), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
}

/** Run a list of engine ops in one process (agent-art batch -). */
export function runBatch(items: { op: string; args: unknown }[], o: { home?: string; port?: number } = {}): string {
  const st = o.home && o.port ? { home: o.home, port: o.port } : readState();
  guard(st.home, st.port);
  return execFileSync(process.execPath, ['bin/agent-art.js', '--home', st.home, '--port', String(st.port), 'batch', '-', '--keep-going'], { cwd: ROOT, input: JSON.stringify(items), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
}
