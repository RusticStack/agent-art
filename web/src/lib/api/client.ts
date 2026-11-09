// One typed function per endpoint, plus op() for POST /api/op.
import type {
  ActivityEntry, AssetIndex, AudioAnalysis, AudioInfo, CanvasInfo, CleanupConfig, CleanupPlan, DiskUsage, GraphDoc, GraphNodeInfo,
  Health, ModelInfo, ProjectInfo, Rect, ReviewAddArgs, ReviewsDoc, RigDebug, RigInfo, RigLayers, SnapshotMeta, TrashList, UiStateDoc,
} from './types';
import { ApiError, getJSON, getText, postJSON, refreshUiToken } from './http';
import { toast } from '@/lib/util/notify';

const enc = encodeURIComponent;

export type DrawCommand =
  | { op: 'pixels'; color: string; points: [number, number][] }
  | { op: 'fill'; x: number; y: number; color: string }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { op: 'rect'; x: number; y: number; w: number; h: number; color: string; fill?: false };

export interface OpMap {
  create: { args: { name: string; width: number; height: number }; result: { created: CanvasInfo; ui?: string } };
  draw: { args: { canvas: string; commands: DrawCommand[]; label?: string; frame?: number }; result: { canvas: string; version: number; commands: number; dirty: Rect | null } };
  undo: { args: { canvas: string; redo?: boolean }; result: unknown };
  layer: { args: { canvas: string; action: 'select' | 'visibility' | 'blend'; layer: number; blend?: string }; result: unknown };
  review_add: { args: ReviewAddArgs; result: { text: string; id: string } };
  review_update: { args: { id: string; status: 'accepted' | 'reopened'; reply?: string }; result: { text: string } };
  review_delete: { args: { id: string }; result: { text: string } };
  review_approve: { args: { asset: string; approved: boolean }; result: { text: string } };
  cleanup_plan: { args: { select: { ids: string[] }; include_exports: boolean; include_dependents: boolean; allow_approved: boolean; full: true }; result: CleanupPlan };
  cleanup_apply: { args: { plan_id: string; confirm: true }; result: { removed: number; size: string; trash: string } };
  cleanup_trash: { args: { full: true }; result: TrashList };
  cleanup_restore: { args: { ids: string[] }; result: { restored: number; conflicts?: string[] } };
  cleanup_empty: { args: { confirm: true; older_than?: '1d' | '7d' | '30d' }; result: { emptied: number; size: string } };
  cleanup_usage: { args: { full: true }; result: DiskUsage };
  cleanup_config: { args: { allow_paths?: string[]; trash_deletes?: boolean }; result: CleanupConfig };
}
export type OpName = keyof OpMap;

/** POST /api/op as the user. On { ok:false }: toast `${op}: ${error}` (unless quiet) and throw ApiError. */
export async function op<K extends OpName>(name: K, args: OpMap[K]['args'], o: { quiet?: boolean } = {}): Promise<OpMap[K]['result']> {
  let j: { ok: boolean; result?: OpMap[K]['result']; error?: string };
  try {
    j = await postJSON('/api/op', { op: name, args, source: 'user' });
  } catch (e) {
    const msg = (e as Error).message;
    if (!o.quiet) toast(`${name}: ${msg}`, 'error');
    throw new ApiError(msg, (e as ApiError).status ?? 0, name);
  }
  if (!j.ok) {
    // a user-only setting refused: the token may be stale after a server restart; refresh once, retry once
    if (name === 'cleanup_config' && /set by the user/i.test(j.error || '') && !retried.has(j)) {
      if (await refreshUiToken()) {
        const r2 = await postJSON<typeof j>('/api/op', { op: name, args, source: 'user' }).catch(() => null);
        if (r2) { retried.add(r2); if (r2.ok) return r2.result as OpMap[K]['result']; j = r2; }
      }
    }
    if (!o.quiet) toast(`${name}: ${j.error}`, 'error');
    throw new ApiError(j.error || 'failed', 200, name);
  }
  return j.result as OpMap[K]['result'];
}
const retried = new WeakSet<object>();

export const api = {
  health: () => getJSON<Health>('/api/health'),
  assets: (signal?: AbortSignal) => getJSON<AssetIndex>('/api/assets', { signal }),
  uiState: () => getJSON<UiStateDoc>('/api/ui-state'),
  saveUiState: (s: { hidden: string[]; pinned: string[] }) => postJSON<{ ok: boolean; state: UiStateDoc }>('/api/ui-state', s),
  activity: (o: { since?: number; limit?: number } = {}) => {
    const qs = [o.since !== undefined ? `since=${o.since}` : '', o.limit !== undefined ? `limit=${o.limit}` : ''].filter(Boolean).join('&');
    return getJSON<{ entries: ActivityEntry[]; seq: number }>('/api/activity' + (qs ? '?' + qs : ''));
  },
  reviews: () => getJSON<ReviewsDoc>('/api/reviews'),
  graph: (signal?: AbortSignal) => getJSON<GraphDoc>('/api/graph', { signal }),
  graphNode: (id: string, signal?: AbortSignal) => getJSON<GraphNodeInfo>(`/api/graph/node?id=${enc(id)}`, { signal }),
  canvas: (name: string, signal?: AbortSignal) => getJSON<CanvasInfo>(`/api/canvas/${enc(name)}`, { signal }),
  snapshot: (id: string, signal?: AbortSignal) => getJSON<SnapshotMeta>(`/api/snapshot/${enc(id)}`, { signal }),
  project: (name: string, signal?: AbortSignal) => getJSON<ProjectInfo>(`/api/project/${enc(name)}`, { signal }),
  rig: (name: string, signal?: AbortSignal) => getJSON<RigInfo>(`/api/rig/${enc(name)}`, { signal }),
  rigLayers: (name: string, q: { canvas?: string; tag?: string; view?: string }, signal?: AbortSignal) => getJSON<RigLayers>(`/api/rig/${enc(name)}/layers${qs(q)}`, { signal }),
  rigDebug: (name: string, q: { canvas?: string; tag?: string; view?: string; frame?: number }, signal?: AbortSignal) => getJSON<RigDebug>(`/api/rig/${enc(name)}/debug${qs(q)}`, { signal }),
  modelInfo: (name: string, signal?: AbortSignal) => getJSON<ModelInfo>(`/api/model/${enc(name)}/info`, { signal }),
  audio: (name: string, signal?: AbortSignal) => getJSON<AudioInfo>(`/api/audio/${enc(name)}`, { signal }),
  audioAnalysis: (name: string, view?: string, signal?: AbortSignal) => getJSON<AudioAnalysis>(`/api/audio/${enc(name)}/analysis${qs({ view })}`, { signal }),
  exportJSON: <T = unknown>(path: string, signal?: AbortSignal) => getJSON<T>(`/api/export-file?path=${enc(path)}`, { signal }),
  exportText: (path: string, signal?: AbortSignal) => getText(`/api/export-file?path=${enc(path)}`, { signal }),
};

function qs(o: Record<string, string | number | undefined>): string {
  const parts = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? '?' + parts.join('&') : '';
}
