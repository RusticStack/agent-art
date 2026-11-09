// e2e global teardown: stop the server, remove the temp workspace and the state file.
import fs from 'node:fs';
import { readState, STATE_FILE } from './cli.ts';
import { stopServer } from './server.ts';

export default async function globalTeardown() {
  let st;
  try { st = readState(); } catch { return; }
  stopServer(st.pid);
  await new Promise((r) => setTimeout(r, 300));
  if (!process.env.AA_E2E_KEEP) { try { fs.rmSync(st.home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
  try { fs.rmSync(STATE_FILE); } catch { /* ignore */ }
}
