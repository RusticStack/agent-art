// "Hierarchy" layout (plan 5.9b): a layered, edge-aware layout by dagre, loaded on first use so the
// library lands in its own lazy chunk (graph-layout). Containment relations (part_of, layer_of) are
// reversed so the container sits left of its parts; every other relation keeps its direction.
// Unconnected nodes are stacked in a last column (kind order, then id). Positions are node centres.
import { LAYER_ORDER } from './sim';

export const HIER_MAX_NODES = 1500;
export const HIER_MAX_EDGES = 4000;
/** Box sizes handed to dagre: a card (Cards renderer) or a dot with its label clearance (Canvas). */
export const CARD_BOX = { w: 156, h: 44 } as const;
export const DOT_BOX = { w: 28, h: 28 } as const;
/** Relations whose arrow points from the part to its container; added reversed. */
export const CONTAINMENT = new Set(['part_of', 'layer_of']);
// The ranker is dagre's default (network simplex); it is not named here because that string is the
// build check's marker for dagre leaking into the initial bundle (scripts/check-ui-build.js).
export const HIER_OPTS = { rankdir: 'LR', nodesep: 14, ranksep: 64, acyclicer: 'greedy' } as const;
export const HIER_LIMIT_MSG = `Hierarchy needs ≤ ${HIER_MAX_NODES} nodes: filter by tag or collapse groups`;

export interface HierNode { id: string; w: number; h: number; kind?: string }
export interface HierEdge { from: string; to: string; rel: string }
export type Positions = Map<string, { x: number; y: number }>;

type Dagre = typeof import('@dagrejs/dagre');
let dagreP: Promise<Dagre> | null = null;
/** The dagre module, imported once (a failed import is retried on the next call). */
export function loadDagre(): Promise<Dagre> {
  if (!dagreP) {
    dagreP = import('@dagrejs/dagre');
    dagreP.catch(() => { dagreP = null; });
  }
  return dagreP;
}

export const hierarchyFits = (nodes: number, edges: number): boolean => nodes <= HIER_MAX_NODES && edges <= HIER_MAX_EDGES;

/** Directed, de-duplicated layout edges between known nodes (self loops dropped, containment reversed). */
export function layoutEdges(ids: ReadonlySet<string>, edges: readonly HierEdge[]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const [v, w] = CONTAINMENT.has(e.rel) ? [e.to, e.from] : [e.from, e.to];
    const k = v + '\u0000' + w;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([v, w]);
  }
  return out;
}

const kindRank = (k: string | undefined): number => { const i = LAYER_ORDER.indexOf(k ?? 'file'); return i < 0 ? LAYER_ORDER.indexOf('file') : i; };

/**
 * Layered layout. Returns null (without importing dagre) when the graph is over the limits: the caller
 * falls back to "Layered by kind" for this run.
 */
export async function hierarchyLayout(nodes: readonly HierNode[], edges: readonly HierEdge[]): Promise<Positions | null> {
  if (!hierarchyFits(nodes.length, edges.length)) return null;
  const out: Positions = new Map();
  if (!nodes.length) return out;
  const ids = new Set(nodes.map((n) => n.id));
  const links = layoutEdges(ids, edges);
  const linked = new Set<string>();
  for (const [v, w] of links) { linked.add(v); linked.add(w); }
  let x1 = 0, y0 = 0;
  if (links.length) {
    const { graphlib, layout } = await loadDagre();
    const g = new graphlib.Graph({ directed: true, multigraph: false, compound: false });
    g.setGraph({ ...HIER_OPTS });
    // insertion order matters to dagre's ordering heuristics: sort for repeatable output
    const sorted = nodes.filter((n) => linked.has(n.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const n of sorted) g.setNode(n.id, { width: n.w, height: n.h });
    for (const [v, w] of links) g.setEdge(v, w, {});
    layout(g);
    x1 = -Infinity; y0 = Infinity;
    for (const n of sorted) {
      const p = g.node(n.id);
      const x = p.x ?? 0, y = p.y ?? 0;
      out.set(n.id, { x, y });
      x1 = Math.max(x1, x + n.w / 2);
      y0 = Math.min(y0, y - n.h / 2);
    }
  }
  // unconnected nodes: one last column, kind order then id
  const loose = nodes.filter((n) => !linked.has(n.id)).sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (loose.length) {
    const w = Math.max(...loose.map((n) => n.w));
    const cx = (links.length ? x1 + HIER_OPTS.ranksep : 0) + w / 2;
    let y = y0;
    for (const n of loose) { out.set(n.id, { x: cx, y: y + n.h / 2 }); y += n.h + HIER_OPTS.nodesep; }
  }
  return out;
}
