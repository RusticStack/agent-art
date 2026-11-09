// e2e global setup: temp workspace, free port, seed through the CLI, start the server, write the state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, STATE_FILE } from './cli.ts';
import { LIVE_SEED, seed, SEED } from './seed.ts';
import { freePort, startServer } from './server.ts';

export default async function globalSetup() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'ui', 'index.html'))) throw new Error('dist/ui is missing: run npm run build:ui');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-'));
  const port = await freePort();
  const log = path.join(home, 'server.log');
  const seedLog: string[] = [];
  seed(home, port, SEED, (s) => seedLog.push(s));
  const pid = await startServer(home, port, log);
  seed(home, port, LIVE_SEED, (s) => seedLog.push(s));
  fs.writeFileSync(path.join(home, 'seed.log'), seedLog.join(''));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port, home, pid, log }, null, 2));
  process.env.AA_E2E_PORT = String(port);
}
