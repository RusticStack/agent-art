// Reactive state shared by the Cards renderer class (mountFlow.ts) and the Svelte Flow components.
// The renderer replaces `nodes` / `edges` / `selected`; the library writes positions and measurements
// back into `nodes` (bound); FlowApi.svelte reports the zoom and registers the viewport helpers.
import type { Edge, Node } from '@xyflow/svelte';
import type { CardData, RelData } from '../cards';
import type { NodeAction } from '../renderer';

/** Svelte context key of the FlowBridge (set by FlowGraph, read by AssetNode / RelEdge). */
export const BRIDGE_KEY = Symbol('aa-flow-bridge');

export type CardNode = Node<CardData, 'asset'>;
export type RelFlowEdge = Edge<RelData, 'rel'>;

/** Viewport helpers, available once the flow is mounted (FlowApi.svelte). */
export interface FlowApi {
  fit(): void;
  /** Centre on a flow point; zoom raised to at least minZoom (0 = keep). */
  center(x: number, y: number, minZoom: number): void;
  viewport(): { x: number; y: number; zoom: number };
}

/** What the components report back to the renderer class (flow coordinates, card space). */
export interface FlowCallbacks {
  select(id: string | null): void;
  /** Double-click or Enter on the selected node: open it, or fold / unfold a group. */
  activate(id: string): void;
  moved(id: string, x: number, y: number): void;
  action(id: string, action: NodeAction | 'open'): void;
  /** Nodes are measured (edges can be drawn, fit works). */
  initialized(on: boolean): void;
}

export class FlowBridge {
  nodes = $state.raw<CardNode[]>([]);
  edges = $state.raw<RelFlowEdge[]>([]);
  selected = $state<string | null>(null);
  zoom = $state(1);
  api: FlowApi | null = null;
  constructor(readonly cb: FlowCallbacks) {}
}
