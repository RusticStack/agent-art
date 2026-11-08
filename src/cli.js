// Small pure helpers for bin/agent-art.js, kept here so they can be unit-tested in-process.
import path from 'node:path';
import os from 'node:os';

/**
 * The workspace folder: --home, else AGENT_ART_HOME, else ~/.agent-art. There is deliberately no
 * implicit fallback (0.3.0 removed the legacy ./workspace next to a source checkout): an MCP started
 * from the repo must use the same workspace as every other client.
 */
export function resolveHome(flagHome, env = process.env, homedir = os.homedir()) {
  if (flagHome && flagHome !== true) return path.resolve(String(flagHome));
  if (env && env.AGENT_ART_HOME) return path.resolve(String(env.AGENT_ART_HOME));
  return path.join(homedir, '.agent-art');
}

/** Where `batch` writes an item's image: absolute `out` paths are used as they are. */
export function batchOutPath(outDir, out, index) {
  const file = out || `batch_${index}.png`;
  return path.isAbsolute(file) ? file : path.join(outDir || '.', file);
}
