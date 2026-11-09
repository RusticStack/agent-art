// Core viewer types: targets, the Viewer contract, and what a viewer may ask of the app (ViewerHostApi).
// Viewers know only these types, lib/api and lib/util; never Svelte stores or components.
import type { AssetIndex, AnyEvent, ReviewMark, Rect } from '@/lib/api/types';

export type SlotId = 'A' | 'B';
export type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'picker' | 'hand';
export type CanvasView = 'edit' | 'anim' | 'sheet' | 'layers';
export type CompareOverlay = 'off' | 'diff' | 'swipe' | 'blink';

export type CanvasTarget = { kind: 'canvas'; name: string; view?: CanvasView; tag?: string; frame?: number; snap?: string; label?: string };
export type RigTarget = { kind: 'rig'; name: string; view?: 'layers'; mode?: 'clip' | 'pose' | 'parts' | 'skin'; clip?: string; canvas?: string; tag?: string; frame?: number };
export type ModelTarget = { kind: 'model'; name: string; clip?: string; snap?: string; label?: string };
export type Target =
  | CanvasTarget
  | RigTarget
  | ModelTarget
  | { kind: 'audio'; name: string }
  | { kind: 'project'; name: string }
  | { kind: 'export'; name: string }            // name = path relative to the exports folder
  | { kind: 'graph'; focus?: string };

export type ViewerKind = 'canvas' | 'anim' | 'sheet' | 'layers' | 'rig' | 'model' | 'audio' | 'graph' | 'export' | 'project';

/** Reactive values a viewer may need; a new object is passed on every change. */
export interface ViewerEnv {
  tool: Tool;
  color: { hex: string; hex8: string };
  reviewMode: boolean;
  following: boolean;
  reviewsRev: number;
  assetsRev: number;
  compareLink: boolean;
  compareOverlay: CompareOverlay;
  peerRev: number;
}

export interface ViewerProps { target: Target; env: ViewerEnv }

export interface ReviewDraft {
  asset: string;
  frame?: number; view?: string; tag?: string; layer?: string; part?: string; clip?: string;
  region?: [number, number, number, number]; point?: [number, number]; time?: [number, number];
  image?: string;
  where?: string; category?: string; priority?: 'low' | 'normal' | 'high'; note?: string;
  compare_with?: string; compare_view?: string;
}

export interface LinkState { zoom: number; cx: number; cy: number; frame: number }
export interface CompareImage { image: ImageBitmap; rect: Rect; key: string }

/** What a viewer may ask of the app. Implemented once by the workspace. */
export interface ViewerHostApi {
  readonly slot: SlotId;
  readonly readOnly: boolean;
  assets(): AssetIndex | null;
  isHidden(id: string): boolean;
  reviewMarks(asset: { kind: string; name: string }): ReviewMark[];
  open(target: Target, opts?: { slot?: SlotId }): void;
  openNode(id: string): void;
  inspectNode(id: string): void;
  requestReview(draft: ReviewDraft): void;
  setTool(tool: Tool): void;
  setColor(hex: string): void;
  canvasInfoChanged(name: string): void;
  toast(text: string, kind?: 'info' | 'ok' | 'error'): void;
  peerViewer(): Viewer | null;
  notifyPeer(): void;
  compareStatus(text: string | null): void;
  setCompareOverlay(mode: CompareOverlay): void;
  /** Pin / hide an asset (graph cards hover toolbar). */
  togglePinned?(id: string): void;
  toggleHidden?(id: string): void;
  isPinned?(id: string): boolean;
  /** Current follow mode ('project' matters to the project overview). */
  followMode?(): 'canvas' | 'project' | 'off';
}

export interface Viewer {
  mount(el: HTMLElement, props: ViewerProps): void | Promise<void>;
  update(props: ViewerProps): void | Promise<void>;
  destroy(): void;
  onEvent?(ev: AnyEvent): void;
  onKey?(e: KeyboardEvent, key: string): boolean;
  undo?(redo: boolean): void;
  applyLinkState?(s: LinkState): void;
  compareImage?(): CompareImage | null;
  debugInfo?(): unknown;
}

export type ViewerCtor = new (host: ViewerHostApi) => Viewer;
