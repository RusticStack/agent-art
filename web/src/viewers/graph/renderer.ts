// The renderer contract between the graph controller (GraphViewer) and whatever draws the graph.
// Step 10 ships the canvas renderer (CanvasRenderer.ts); step 10b adds a Cards renderer behind the
// same interface (plan 5.9b). Positions live on the SimNode objects, so every renderer and the
// controller share them and a reload keeps them.
import type { GraphLayout, SimNode, VisEdge } from './sim';

export type VisNode = SimNode;
export type { VisEdge };

export interface GraphData {
  nodes: VisNode[];
  edges: VisEdge[];
  /** id -> node; the node objects carry x / y / pinned. */
  positions: Map<string, VisNode>;
  selected: string | null;
  /** Bumps on every setData (renderers may cache per version). */
  version: number;
  /** 'force' starts a live simulation run; any other layout has already placed the nodes. */
  layout: GraphLayout;
  /** Collapsed group ids (drawn with a "+"). */
  collapsed: ReadonlySet<string>;
}

export interface GraphRenderer {
  setData(d: GraphData): void;
  setSelected(id: string | null): void;
  fit(): void;
  /** Centre on a node; zoom is raised to at least minZoom (0 = keep zoom). */
  center(id: string, minZoom: number): void;
  resize(): void;
  destroy(): void;
  /** Layout finished moving (force alpha below 0.01, or a static layout). */
  readonly settled: boolean;
  /** Keyboard focus target for the drawing surface (canvas), if any. */
  readonly focusEl: HTMLElement | null;
}

export interface GraphRendererHost {
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  onToggleGroup(id: string): void;
  /** Drag end: the node is pinned at (x, y). */
  onMoved(id: string, x: number, y: number): void;
  /** The settled flag changed. */
  onSettled(settled: boolean): void;
  /** Thumbnail URL for a node, or null. */
  thumb(node: VisNode): string | null;
}
