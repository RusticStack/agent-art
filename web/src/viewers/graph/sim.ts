// Pure graph helpers: node building with deterministic seeding, filtering (sub-assets, tag, relations,
// collapsed groups), force step, layered layout, fit, hit test, and the text the viewer shows.
// No DOM; unit-tested in sim.test.ts.
import type { GraphDoc, GraphEdge, GraphNode } from '@/lib/api/types';
import { splitId } from '@/lib/util/ids';

export const SUB_KINDS = new Set(['layer', 'anim', 'frame', 'rigpart', 'modelpart']);
/** Relation colours (data colours, stay literal). */
export const REL_COLOR: Record<string, string> = { part_of: '#64748b', variant_of: '#a78bfa', view_of: '#38bdf8', layer_of: '#475569', uses_palette: '#22c55e', rendered_from: '#f472b6', exports_to: '#94a3b8', depends_on: '#f5a524', replaces: '#e5484d' };
export const relColor = (r: string): string => REL_COLOR[r] || '#c084fc';
/** Column order of the "Layered by kind" layout; unknown kinds go to the 'file' column. */
export const LAYER_ORDER = ['group', 'project', 'rig', 'model', 'canvas', 'audio', 'palette', 'export', 'file', 'layer', 'anim', 'frame', 'rigpart', 'modelpart'];

export const REPULSION_RADIUS = 140;
export const SETTLE_ALPHA = 0.01;
export const COOLING = 0.985;
/** Ticks per layout run before the simulation is stopped (a drag re-heats it). */
export const MAX_TICKS = 300;

export type GraphLayout = 'force' | 'layered';
export const parseLayout = (v: unknown): GraphLayout => (v === 'layered' ? 'layered' : 'force');

/** A graph node with its simulation state. `pinned` = dragged by the user (legacy `fixed`). */
export interface SimNode extends GraphNode {
  name: string;
  x: number; y: number; vx: number; vy: number;
  pinned?: boolean;
  deg: number;
}
export interface VisEdge extends GraphEdge { a: SimNode; b: SimNode }
export interface View { x: number; y: number; k: number }

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Deterministic start position in [-300, 300)² from the id (replaces Math.random()). */
export function seedPos(id: string): { x: number; y: number } {
  const a = hash32(id), b = hash32('y:' + id);
  return { x: (a / 0x100000000 - 0.5) * 600, y: (b / 0x100000000 - 0.5) * 600 };
}

export interface BuiltGraph { nodes: Map<string, SimNode>; edges: GraphEdge[]; rels: string[]; tags: string[] }

/** Nodes keyed by id (surviving nodes keep position and pin), edges between known nodes, relation and tag lists. */
export function buildGraph(g: GraphDoc, old: Map<string, SimNode> = new Map()): BuiltGraph {
  const rels = [...new Set([...(g.rels || []), ...g.edges.map((e) => e.rel)])];
  const nodes = new Map<string, SimNode>();
  for (const n of g.nodes) {
    const o = old.get(n.id);
    const [kind, name] = splitId(n.id);
    const p = o ?? seedPos(n.id);
    nodes.set(n.id, { ...n, kind, name, x: p.x, y: p.y, vx: 0, vy: 0, pinned: o?.pinned, deg: 0 });
  }
  const edges = g.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  for (const e of edges) { nodes.get(e.from)!.deg++; nodes.get(e.to)!.deg++; }
  const tags = [...new Set(g.nodes.flatMap((n) => n.tags || []))].sort();
  return { nodes, edges, rels, tags };
}

export interface FilterOpts { tag: string; showSub: boolean; hiddenRels: ReadonlySet<string>; collapsed: ReadonlySet<string> }

/** The outermost collapsed group containing id, or id itself (cycle safe). */
export function makeRep(edges: readonly GraphEdge[], collapsed: ReadonlySet<string>): (id: string) => string {
  const parentOf = new Map<string, string>();
  for (const e of edges) if (e.rel === 'part_of' && e.to.startsWith('group:')) parentOf.set(e.from, e.to);
  return (id) => {
    let cur = id, out = id;
    const seen = new Set<string>();
    while (parentOf.has(cur) && !seen.has(cur)) { seen.add(cur); cur = parentOf.get(cur)!; if (collapsed.has(cur)) out = cur; }
    return out;
  };
}

/** Visible nodes / edges after filters and group collapse (collapsed members fold into the group). */
export function applyFilter(nodes: Map<string, SimNode>, edges: readonly GraphEdge[], o: FilterOpts): { vis: SimNode[]; edges: VisEdge[] } {
  const rep = makeRep(edges, o.collapsed);
  const vis = new Set<string>();
  for (const n of nodes.values()) {
    if (!o.showSub && SUB_KINDS.has(n.kind)) continue;
    if (o.tag && !(n.tags || []).includes(o.tag) && n.kind !== 'group') continue;
    if (rep(n.id) !== n.id) continue;
    vis.add(n.id);
  }
  const seen = new Set<string>();
  const out: VisEdge[] = [];
  for (const e of edges) {
    if (o.hiddenRels.has(e.rel)) continue;
    const a = rep(e.from), b = rep(e.to);
    if (a === b || !vis.has(a) || !vis.has(b)) continue;
    const k = `${a}|${e.rel}|${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...e, a: nodes.get(a)!, b: nodes.get(b)! });
  }
  // with a tag filter, drop isolated groups
  const linked = new Set<SimNode>();
  if (o.tag) for (const e of out) { linked.add(e.a); linked.add(e.b); }
  const list = [...vis].map((id) => nodes.get(id)!).filter((n) => !o.tag || n.kind !== 'group' || linked.has(n));
  return { vis: list, edges: out };
}

/** One force tick (grid-bucketed repulsion, springs, gravity, damping, velocity cap). Returns the next alpha. */
export function stepForce(ns: readonly SimNode[], edges: readonly VisEdge[], alpha: number, dragId: string | null = null): number {
  if (!ns.length || alpha < SETTLE_ALPHA) return alpha;
  const a = alpha, R = REPULSION_RADIUS;
  const grid = new Map<string, SimNode[]>();
  for (const n of ns) { const k = `${Math.floor(n.x / R)},${Math.floor(n.y / R)}`; let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(n); }
  for (const n of ns) {
    const gx = Math.floor(n.x / R), gy = Math.floor(n.y / R);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const m of grid.get(`${gx + dx},${gy + dy}`) || []) {
      if (m === n) continue;
      let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
      if (d2 > R * R) continue;
      if (d2 < 1) {
        // coincident nodes: deterministic push apart (was Math.random())
        const t = (hash32(n.id + '|' + m.id) / 0x100000000) * Math.PI * 2;
        x = Math.cos(t) * 0.5; y = Math.sin(t) * 0.5; d2 = 1;
      }
      const f = (900 / d2) * a;
      n.vx += x * f * 0.05; n.vy += y * f * 0.05;
    }
  }
  for (const e of edges) {
    const x = e.b.x - e.a.x, y = e.b.y - e.a.y, d = Math.hypot(x, y) || 1;
    const want = e.rel === 'part_of' ? 70 : 110;
    const f = ((d - want) / d) * 0.04 * a;
    e.a.vx += x * f; e.a.vy += y * f; e.b.vx -= x * f; e.b.vy -= y * f;
  }
  for (const n of ns) {
    n.vx -= n.x * 0.002 * a; n.vy -= n.y * 0.002 * a; // gravity
    if (n.pinned || n.id === dragId) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.6; n.vy *= 0.6;
    n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
  }
  return alpha * COOLING;
}

/** Columns by kind order, rows sorted by id. Mutates positions, zeroes velocities. */
export function layeredLayout(vis: readonly SimNode[]): void {
  const cols = new Map<string, SimNode[]>();
  for (const n of vis) { const k = LAYER_ORDER.includes(n.kind) ? n.kind : 'file'; let c = cols.get(k); if (!c) cols.set(k, (c = [])); c.push(n); }
  let ci = 0;
  for (const k of LAYER_ORDER) {
    const list = cols.get(k);
    if (!list) continue;
    list.sort((a, b) => a.id.localeCompare(b.id));
    list.forEach((n, i) => { n.x = ci * 220; n.y = (i - list.length / 2) * 46; n.vx = n.vy = 0; });
    ci++;
  }
}

/** View transform that fits every node with 40 px padding, zoom at most 2. null when empty. */
export function fitView(vis: readonly { x: number; y: number }[], W: number, H: number): View | null {
  if (!vis.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of vis) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const k = Math.min(2, Math.min((W - 80) / Math.max(1, x1 - x0), (H - 80) / Math.max(1, y1 - y0)));
  return { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
}

/** Drawn radius of a node. */
export function radius(n: Pick<SimNode, 'kind' | 'deg'>): number {
  return n.kind === 'group' ? 16 : SUB_KINDS.has(n.kind) ? 6 : 11 + Math.min(6, Math.sqrt(n.deg));
}

/** Nearest node within its hit radius of the world point, or null. */
export function hitTest<N extends { x: number; y: number }>(vis: readonly N[], wx: number, wy: number, k: number, radiusOf: (n: N) => number): N | null {
  let best: N | null = null, bd = Infinity;
  for (const n of vis) { const d = Math.hypot(n.x - wx, n.y - wy); if (d < radiusOf(n) * 1.4 + 4 / k && d < bd) { bd = d; best = n; } }
  return best;
}

export const MIN_ZOOM = 0.05, MAX_ZOOM = 6;
/** Zoom by a factor around a screen point (the point stays put). */
export function zoomAt(v: View, mx: number, my: number, factor: number): View {
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
  return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
}
/** Wheel delta -> zoom factor (legacy). */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY * 0.0015);

/** View that puts world (x, y) at the centre of a W×H stage, zoom raised to at least minZoom. */
export function centerOn(v: View, x: number, y: number, W: number, H: number, minZoom = 0): View {
  const k = Math.max(v.k, minZoom);
  return { k, x: W / 2 - x * k, y: H / 2 - y * k };
}

export function countsText(nodes: number, edges: number, collapsed: number): string {
  return `${nodes} nodes · ${edges} edges${collapsed ? ` · ${collapsed} collapsed` : ''}`;
}

export function tipText(n: GraphNode): string {
  return `${n.id}${n.note ? ` — ${n.note}` : ''}${n.reviews ? ` · ${n.reviews} open review` : ''}${n.approved ? ' · approved' : ''}${n.superseded ? ' · superseded' : ''}${n.orphan ? ' · orphan' : ''}`;
}

/** First visible node whose id or note contains the query (case-insensitive); null for an empty query. */
export function findNode<N extends GraphNode>(vis: readonly N[], q: string): N | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  return vis.find((m) => m.id.toLowerCase().includes(s) || (m.note || '').toLowerCase().includes(s)) ?? null;
}

/** Label drawn next to a node: groups and projects show the full id. */
export const nodeLabel = (n: Pick<SimNode, 'kind' | 'id' | 'name'>): string => (n.kind === 'group' || n.kind === 'project' ? n.id : n.name);

/** Edge label: relation plus attrs. */
export function edgeLabel(e: Pick<GraphEdge, 'rel' | 'attrs'>): string {
  return e.rel + (e.attrs ? ' ' + Object.entries(e.attrs).map(([a, b]) => `${a}:${String(b)}`).join(',') : '');
}

/** Events that reload the graph (structural canvas changes only). */
export function reloadsOn(ev: { type: string; structural?: unknown }): boolean {
  if (ev.type === 'resync') return true;
  return ['graph', 'change', 'deleted', 'model', 'audio', 'project'].includes(ev.type) && (ev.type !== 'change' || !!ev.structural);
}
