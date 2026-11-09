// Pure helpers of the Cards renderer (plan 5.9b): which renderer to use, the card coordinate scale, and the
// data each card shows. No DOM, no Svelte; unit-tested in cards.test.ts and shared by the controller and
// graph/flow/*.
import { KIND_COLOR, KIND_ICON_NAME, KIND_LABEL } from '@/lib/util/kinds';
import type { IconName } from '@/lib/util/icons';
import { edgeLabel, nodeLabel, relColor, type SimNode, type VisEdge } from './sim';

export type RendererPref = 'auto' | 'cards' | 'canvas';
export type RendererKind = 'cards' | 'canvas';
/** Stored View choice; an unknown value falls back to 'auto'. */
export const parseRendererPref = (v: unknown): RendererPref => (v === 'cards' || v === 'canvas' ? v : 'auto');

/** Auto uses Cards up to these counts (inclusive). */
export const AUTO_CARDS_MAX_NODES = 400;
export const AUTO_CARDS_MAX_EDGES = 1200;
/** Cards are refused above this many nodes, even when chosen. */
export const CARDS_MAX_NODES = 1500;
export const CARDS_REFUSED_MSG = 'Too many nodes for cards: filter by tag or collapse groups';

export interface RendererChoice {
  kind: RendererKind;
  /** Auto picked Canvas because the graph is large. */
  large: boolean;
  /** Cards was chosen explicitly but the graph is over CARDS_MAX_NODES. */
  refused: boolean;
}

/** Renderer for the filtered graph. `cardsBroken` = the cards chunk failed to load (use Canvas). */
export function chooseRenderer(pref: RendererPref, nodes: number, edges: number, cardsBroken = false): RendererChoice {
  if (pref === 'canvas') return { kind: 'canvas', large: false, refused: false };
  if (pref === 'cards') {
    if (nodes > CARDS_MAX_NODES) return { kind: 'canvas', large: false, refused: true };
    return { kind: cardsBroken ? 'canvas' : 'cards', large: false, refused: false };
  }
  const small = nodes <= AUTO_CARDS_MAX_NODES && edges <= AUTO_CARDS_MAX_EDGES;
  return { kind: small && !cardsBroken ? 'cards' : 'canvas', large: !small, refused: false };
}

/** Suffix of the counts text: " · cards", " · canvas", " · canvas (large graph)". */
export const rendererSuffix = (c: RendererChoice): string => ` · ${c.kind}${c.large && c.kind === 'canvas' ? ' (large graph)' : ''}`;

/** Cards are wide: layout x distances are stretched when handed to the Cards renderer. */
export const CARD_SCALE_X = 2.2;
export const CARD_SCALE_Y = 1;
export const toCards = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * CARD_SCALE_X, y: p.y * CARD_SCALE_Y });
export const fromCards = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x / CARD_SCALE_X, y: p.y / CARD_SCALE_Y });

/** Card box (px at zoom 1); the Hierarchy layout uses the same size. */
export const CARD_W = 156;
export const CARD_H = 44;
/** Below this zoom the cards collapse to name pills (data-lod="far"). */
export const LOD_FAR_ZOOM = 0.45;
/** Edge labels show above this zoom when there are fewer than LABEL_MAX_EDGES visible edges. */
export const LABEL_ZOOM = 0.9;
export const LABEL_MAX_EDGES = 600;

const THUMB_KINDS = new Set(['canvas', 'model', 'rig']);

export interface CardData extends Record<string, unknown> {
  id: string;
  kind: string;
  kindLabel: string;
  label: string;
  /** Second line: the first two tags, else the note. */
  sub: string;
  color: string;
  icon: IconName;
  thumb: string | null;
  reviews: number;
  approved: boolean;
  superseded: boolean;
  orphan: boolean;
  missing: boolean;
  group: boolean;
  /** Folded members of a collapsed group ("+N"), else 0. */
  folded: number;
  collapsed: boolean;
  pinned: boolean;
  hidden: boolean;
  /** Unrelated to the selection (drawn at 35% opacity). */
  dim: boolean;
  relations: number;
  aria: string;
}

export interface CardContext {
  thumb(n: SimNode): string | null;
  isPinned(id: string): boolean;
  isHidden(id: string): boolean;
  collapsed: ReadonlySet<string>;
  folded?: ReadonlyMap<string, number>;
}

/** Number of visible edges touching each node. */
export function relationCounts(edges: readonly VisEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) { m.set(e.a.id, (m.get(e.a.id) ?? 0) + 1); m.set(e.b.id, (m.get(e.b.id) ?? 0) + 1); }
  return m;
}

/** Ids related to the selection (the selection and its neighbours); null when nothing is selected. */
export function relatedTo(sel: string | null, edges: readonly VisEdge[]): Set<string> | null {
  if (!sel) return null;
  const s = new Set([sel]);
  for (const e of edges) { if (e.a.id === sel) s.add(e.b.id); if (e.b.id === sel) s.add(e.a.id); }
  return s;
}

export function cardData(n: SimNode, relations: number, related: ReadonlySet<string> | null, c: CardContext): CardData {
  const kindLabel = KIND_LABEL[n.kind] ?? n.kind;
  const label = nodeLabel(n);
  const tags = n.tags ?? [];
  const sub = tags.length ? tags.slice(0, 2).map((t) => '#' + t).join(' ') : (n.note ?? '');
  const thumb = THUMB_KINDS.has(n.kind) && !n.missing ? c.thumb(n) : null;
  return {
    id: n.id, kind: n.kind, kindLabel, label, sub,
    color: KIND_COLOR[n.kind] ?? '#94a3b8',
    icon: KIND_ICON_NAME[n.kind] ?? 'file',
    thumb,
    reviews: n.reviews ?? 0,
    approved: !!n.approved, superseded: !!n.superseded, orphan: !!n.orphan, missing: !!n.missing,
    group: n.kind === 'group',
    folded: c.collapsed.has(n.id) ? c.folded?.get(n.id) ?? 0 : 0,
    collapsed: c.collapsed.has(n.id),
    pinned: c.isPinned(n.id), hidden: c.isHidden(n.id),
    dim: !!related && !related.has(n.id),
    relations,
    aria: `${kindLabel} ${label}, ${relations} relation${relations === 1 ? '' : 's'}`,
  };
}

export interface RelData extends Record<string, unknown> {
  rel: string;
  label: string;
  color: string;
  derived: boolean;
  /** Touches the selected node. */
  sel: boolean;
  /** Another node is selected and this edge does not touch it. */
  dim: boolean;
  /** Label allowed when zoomed in (fewer than LABEL_MAX_EDGES edges, not derived: canvas parity). */
  labelOk: boolean;
}

export function relData(e: VisEdge, sel: string | null, edgeCount: number): RelData {
  const on = !!sel && (e.a.id === sel || e.b.id === sel);
  return { rel: e.rel, label: edgeLabel(e), color: relColor(e.rel), derived: !!e.derived, sel: on, dim: !!sel && !on, labelOk: edgeCount < LABEL_MAX_EDGES && !e.derived };
}

/** Members folded into each collapsed group (all descendants whose outermost collapsed group it is). */
export function foldedCounts(ids: Iterable<string>, rep: (id: string) => string, collapsed: ReadonlySet<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) { const r = rep(id); if (r !== id && collapsed.has(r)) m.set(r, (m.get(r) ?? 0) + 1); }
  return m;
}

/** Straight edge between two card boxes: from border to border (the arrow tip stops `gap` px short). */
export function clipToBoxes(sx: number, sy: number, tx: number, ty: number, hw = CARD_W / 2, hh = CARD_H / 2, gap = 2): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = tx - sx, dy = ty - sy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  // distance from a box centre to its border along (dx, dy)
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const r = t * d;
  if (2 * r + gap >= d) return null; // overlapping boxes
  const ux = dx / d, uy = dy / d;
  return { x1: sx + ux * r, y1: sy + uy * r, x2: tx - ux * (r + gap), y2: ty - uy * (r + gap) };
}
