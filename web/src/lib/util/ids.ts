// Asset ids shared by the browser, timeline, graph and UI state: "canvas:name", "model:name", ...
import type { Target } from '@/viewers/types';

export const assetId = (kind: string, name: string): string => `${kind}:${name}`;

/** "kind:name" -> [kind, name]; an id without a colon is a canvas name. Names may contain ':' and '/'. */
export function splitId(id: string): [string, string] {
  const i = id.indexOf(':');
  return i < 0 ? ['canvas', id] : [id.slice(0, i), id.slice(i + 1)];
}

/** The asset id a target shows ('graph' for the graph). */
export function idOfTarget(t: Target): string {
  if (t.kind === 'graph') return 'graph';
  return `${t.kind}:${t.name}`;
}
