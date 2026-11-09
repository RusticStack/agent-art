// URL hash <-> target. Formats are fixed (the server and the MCP hand out #<canvas> and #project:<name>).
import type { Target } from '@/viewers/types';

/** null for snapshots (they are never written to the hash). */
export function targetToHash(t: Target): string | null {
  if ('snap' in t && t.snap) return null;
  if (t.kind === 'graph') return 'graph';
  if (t.kind === 'canvas') return encodeURIComponent(t.name);
  return `${t.kind}:${encodeURIComponent(t.name)}`;
}

/** The whole hash is decodeURIComponent-ed first; '' -> null; anything unknown is a canvas name. */
export function hashToTarget(hash: string): Target | null {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  if (!h) return null;
  if (h === 'graph') return { kind: 'graph' };
  const m = h.match(/^(project|model|rig|audio|export|canvas):(.+)$/s);
  if (m) return { kind: m[1] as 'project' | 'model' | 'rig' | 'audio' | 'export' | 'canvas', name: m[2] } as Target;
  return { kind: 'canvas', name: h };
}
