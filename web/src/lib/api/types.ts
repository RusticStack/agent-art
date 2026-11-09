// Request / response / event types of the agent-art server, derived from src/server.js, src/assets.js,
// src/activity.js, src/doc.js info(), src/review.js, src/graph.js, src/cleanup.js and src/rigdebug.js.
// Fields marked (UI-derived) were inferred from how the UI reads them.

export type Source = 'agent' | 'user';
export interface Rect { x: number; y: number; w: number; h: number }

export interface Health { app: 'agent-art'; version: string; pid: number; home: string; canvases: number; ui?: { built: boolean; stale: boolean } }

// GET /api/assets
export interface AssetIndex {
  canvases: CanvasSummary[]; rigs: RigSummary[]; models: ModelSummary[]; audio: AudioSummary[];
  projects: ProjectSummary[]; groups: GroupSummary[]; exports: ExportFile[];
  home: string; flags: { superseded: string[]; orphans: string[] }; tags: Record<string, string[]>;
}
export interface CanvasSummary {
  name: string; project?: string | null; width: number; height: number; frames: number;
  layers: { name: string; visible: boolean }[]; animations: string[];
  version: string; updated: number;
  kind: 'canvas' | 'rigparts' | 'rigout' | 'render' | 'ctm' | 'normal' | string;
  rig?: string; model?: string; texture?: string | string[]; anchors?: string[];
}
export interface RigSummary {
  name: string; canvas: string; project?: string | null; frame: [number, number]; views: string[]; mirror: string[];
  parts: string[]; poses: string[]; presets: string[]; template?: string; outputs: string[]; version: string;
}
export interface ModelSummary {
  name: string; project?: string | null; parts: number; named: string[]; types: string[]; poses: string[]; clips: string[];
  sockets: string[]; template?: string; updated: number;
}
export interface AudioSummary { name: string; kind?: string; recipe?: string; duration?: number; lufs?: number; score?: number; updated: number }
export interface ProjectSummary { name: string; description?: string; palette: number }
export interface GroupSummary { name: string; parent: string | null; note?: string; members: string[] }
export interface ExportFile { path: string; size: number; mtime: number }

// GET /api/ui-state
export interface UiStateDoc { hidden: string[]; pinned: string[]; updated?: number }

// GET /api/canvas/<n>
export interface AnimTag { frames: number[]; durations: number[]; loop?: boolean; direction?: 'forward' | 'reverse' | 'pingpong' | string }
export interface CanvasLayer { index: number; name: string; visible: boolean; opacity: number; blend?: string }
export interface CanvasInfo {
  name: string; width: number; height: number; frames: number; frameHeight: number | null;
  activeLayer: number; layers: CanvasLayer[];
  animations: Record<string, AnimTag>; project?: string | null; meta?: CanvasMeta;
  palette?: Record<string, string>; inheritedPalette?: Record<string, string> | null;
  undo: number; redo: number; version: number;
  colors?: { unique: number; top: { color: string; count: number }[] }; ui?: string;
}
export interface CanvasMeta {
  rig?: string | { parts?: Record<string, unknown> };
  anchors?: Record<string, Record<string, number[]>[]>;
  texture?: string | string[]; [k: string]: unknown;
}

// GET /api/snapshot/<id>
export interface SnapshotMeta {
  id: string; kind: 'canvas' | 'model'; name: string; bytes: number; hasDef: boolean;
  width?: number; height?: number; scale?: number; frames?: number; frameHeight?: number | null; version?: number;
}

// activity
export interface ActivityAsset { kind: string; name: string; before?: string; after?: string; created?: boolean; deleted?: boolean }
interface ActivityBase {
  id: number; source: Source; ts: number; args: Record<string, unknown>; assets: ActivityAsset[];
  ok?: boolean; error?: string; ms?: number; summary?: string;
}
export interface ToolEntry extends ActivityBase { type: 'tool'; call: string; tool: string; action?: string; running?: boolean; ops: number[] }
export interface OpEntry extends ActivityBase { type: 'op'; op: string; call?: string; tool?: string; action?: string; running?: boolean; files?: string[]; files_total?: number }
export type ActivityEntry = ToolEntry | OpEntry;

// SSE
export type ServerEvent =
  | { type: 'hello'; ts: number }
  | { type: 'activity'; entry: ActivityEntry; ts: number }
  | { type: 'change'; canvas: string; project?: string | null; version: number; op: string; source: Source; label?: string; dirty: Rect | null; structural?: boolean; ts: number }
  | { type: 'deleted'; canvas: string; source: Source; ts: number }
  | { type: 'model'; model: string; source: Source; label?: string; deleted?: boolean; ts: number }
  | { type: 'audio'; name: string; kind?: string; source: Source; deleted?: boolean; ts: number }
  | { type: 'project'; project: string; source: Source; label?: string; deleted?: boolean; ts: number }
  | { type: 'graph'; action?: string; review?: boolean; id?: string; status?: string; asset?: string; ts: number }
  | { type: 'ui-state'; ts: number }
  | { type: 'anim_library'; kind: string; name: string; source: Source; ts: number }
  | { type: 'planet'; name: string; source: Source; ts: number }
  | { type: 'resync'; ts?: number };

/** Any event, including types this UI does not know (never throw on those). */
export type AnyEvent = ServerEvent | { type: string; ts?: number; [k: string]: unknown };
export type EventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;
export function isEvent<T extends ServerEvent['type']>(ev: AnyEvent, type: T): ev is EventOf<T> { return ev.type === type; }

// reviews
export type ReviewStatus = 'open' | 'in_progress' | 'fixed' | 'accepted' | 'reopened';
export interface ReviewTarget {
  frame?: number; view?: string; tag?: string; layer?: string; part?: string; clip?: string;
  region?: [number, number, number, number]; point?: [number, number]; time?: [number, number];
}
export interface ReviewHistory { ts: number; by: string; status?: ReviewStatus; img?: string; version?: number; reply?: string }
export interface Review {
  id: string; asset: string; target: ReviewTarget; category: string; priority: 'low' | 'normal' | 'high' | string; note: string;
  status: ReviewStatus; by: 'agent' | 'user' | string; created: number; updated: number; version?: number;
  compare_with?: { asset: string } & ReviewTarget;
  history: ReviewHistory[];
}
export interface ReviewsDoc { reviews: Review[]; counts: Record<string, number>; approved: string[] }
export interface ReviewMark { id: string; status: ReviewStatus; region?: [number, number, number, number]; frame?: number; time?: [number, number] }
export interface ReviewAddArgs extends ReviewTarget {
  asset: string; category: string; priority: string; note: string; image?: string;
  compare_with?: { asset: string; view?: string; frame?: number };
}

// graph
export interface GraphNode {
  id: string; kind: string; tags?: string[]; note?: string; approved?: boolean; reviews?: number;
  superseded?: boolean; orphan?: boolean; parent?: string; version?: string; missing?: boolean;
}
export interface GraphEdge { from: string; rel: string; to: string; attrs?: Record<string, unknown>; derived?: boolean; auto?: boolean }
export interface GraphDoc { nodes: GraphNode[]; edges: GraphEdge[]; rels: string[] }
export interface GraphNodeInfo { id: string; exists: boolean; tags: string[]; note?: string; out: GraphEdge[]; in: GraphEdge[]; text: string }

// project / rig / model / audio (UI-derived)
export interface ProjectInfo {
  name: string; description?: string; notes?: string; palette?: Record<string, string>;
  meta?: { minecraft?: string; [k: string]: unknown };
  canvases: { name: string; meta?: { texture?: string | string[] } }[];
}
export interface RigInfo {
  name?: string; canvas?: string; frame: [number, number]; views: string[]; mirror?: Record<string, string>; sampling?: string; root?: number[];
  parts: Record<string, { parent?: string; z?: number; [k: string]: unknown }>; poses?: Record<string, unknown>; presets?: Record<string, unknown>;
  skin?: Record<string, { bones?: string[] }>;
}
export interface RawStackEntry {
  part?: string; name?: string; layer?: string; z?: number; order?: number; rule?: string; reason?: string; why?: string;
  hidden?: boolean; visible?: boolean; why_hidden?: string; parent?: string | null;
}
export interface RigLayers {
  frames: { frame?: number; stack?: RawStackEntry[]; parts?: RawStackEntry[]; layers?: RawStackEntry[] }[];
  views?: string[]; view?: string; source?: string;
}
export interface RigDebug { size: [number, number]; atlas: string; atlas_parts?: string[]; stack?: RawStackEntry[] }
export interface ModelInfo {
  triangles?: number; parts_def?: unknown[]; materials?: string[]; size_units?: number[]; size_cells?: number[]; origin?: unknown;
  template?: string;
  rig?: { nodes?: ({ name: string } | string)[]; sockets?: ({ name: string } | string)[]; poses?: string[]; clips?: ({ name: string } | string)[] };
  warnings?: string[]; notes?: string;
}
export interface AudioStats { duration?: number; lufs?: number; peak_dbfs?: number; score?: number; issues?: string[]; [k: string]: unknown }
export interface AudioInfo { name: string; kind?: string; recipe?: string; seed?: number; intent?: string; genre?: string; stats?: AudioStats; cache?: AudioStats }
export interface AudioAnalysis { name: string; stats?: Record<string, unknown>; report?: string | object; image: string; views?: string[] }

// cleanup (called with full: true)
export interface CleanupPlan {
  plan_id: string; remove: { count: number; bytes: number; size: string; by_kind: Record<string, number> };
  items: { id: string; bytes: number; reason?: string }[]; blocked?: { id: string; why: string; by: string[] }[];
  warnings?: string[]; refused_files?: string[]; unknown?: string[]; next?: string;
}
export interface TrashBatch {
  id: string; ts: number; age: string; via: string; plan?: string; items: number; bytes: number; size: string;
  assets: { id: string; bytes: number; files: string[] }[]; edges: number; reviews: number; manifests: string[];
}
export interface TrashList { batches: number; bytes: number; size: string; trash: TrashBatch[] }
export interface DiskUsage {
  total: string; other: Record<string, number>; by_kind: Record<string, { count: number; bytes: number }>;
  by_project: Record<string, { count: number; bytes: number }>; by_group: Record<string, { count: number; bytes: number }>;
  biggest: { id: string; bytes: number }[];
}
export interface CleanupConfig { exports: string; allow_paths: string[]; trash_deletes: boolean; file: string }
