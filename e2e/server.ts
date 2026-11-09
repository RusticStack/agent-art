// Start / stop the agent-art server for e2e: always with --home and --port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { ROOT } from './cli.ts';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => (port === 7420 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

export async function waitHealthy(port: number, ms = 15_000): Promise<{ pid: number }> {
  const t0 = Date.now();
  let last: unknown = null;
  while (Date.now() - t0 < ms) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
      if (h.app === 'agent-art') return h;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agent-art server on ${port} did not come up: ${String(last)}`);
}

export async function startServer(home: string, port: number, log: string): Promise<number> {
  if (port === 7420) throw new Error('refusing port 7420');
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, ['bin/agent-art.js', 'serve', '--port', String(port), '--home', home], { cwd: ROOT, stdio: ['ignore', fd, fd], detached: false });
  child.unref();
  await waitHealthy(port);
  return child.pid!;
}

export function stopServer(pid: number) {
  try { process.kill(pid); } catch { /* already gone */ }
}

export async function waitDown(port: number, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} is still up`);
}
