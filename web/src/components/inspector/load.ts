// What the inspector fetches for a target: the kind section's data and the graph node (relations).
// A failing kind section keeps reviews + relations (I14); a failing relations request leaves them out.
import { api } from '@/lib/api/client';
import type { AudioInfo, CanvasInfo, GraphNodeInfo, ModelInfo, ProjectInfo, RigInfo, SnapshotMeta } from '@/lib/api/types';
import type { Target } from '@/viewers/types';

export type KindData =
  | { kind: 'canvas'; info: CanvasInfo; project: ProjectInfo | null }
  | { kind: 'snapshot'; meta: SnapshotMeta | null }
  | { kind: 'model'; info: ModelInfo }
  | { kind: 'rig'; info: RigInfo }
  | { kind: 'audio'; info: AudioInfo }
  | { kind: 'project'; info: ProjectInfo }
  | { kind: 'none' };

export interface InspectorData {
  target: Target;
  id: string;
  kind: string;
  name: string;
  data: KindData;
  error: string | null;
  node: GraphNodeInfo | null;
}

/** Identity of what is inspected: (id, snap, tick). null = nothing to load (no target, or the graph). */
export function inspectKey(t: Target | null | undefined, tick: number): string | null {
  if (!t || t.kind === 'graph') return null;
  const snap = 'snap' in t && t.snap ? t.snap : '';
  return `${t.kind}:${t.name}|${snap}|${tick}`;
}

async function kindData(t: Target, signal: AbortSignal): Promise<KindData> {
  if (t.kind === 'graph') return { kind: 'none' };
  const name = t.name;
  switch (t.kind) {
    case 'canvas': {
      if (t.snap) return { kind: 'snapshot', meta: await api.snapshot(t.snap, signal).catch(() => null) };
      const info = await api.canvas(name, signal);
      const project = info.project ? await api.project(info.project, signal).catch(() => null) : null;
      return { kind: 'canvas', info, project };
    }
    case 'model': return { kind: 'model', info: await api.modelInfo(name, signal) };
    case 'rig': return { kind: 'rig', info: await api.rig(name, signal) };
    case 'audio': return { kind: 'audio', info: await api.audio(name, signal) };
    case 'project': return { kind: 'project', info: await api.project(name, signal) };
    default: return { kind: 'none' };
  }
}

export async function loadInspector(t: Target, signal: AbortSignal): Promise<InspectorData> {
  if (t.kind === 'graph') return { target: t, id: 'graph', kind: 'graph', name: 'graph', data: { kind: 'none' }, error: null, node: null };
  const id = `${t.kind}:${t.name}`;
  const [d, node] = await Promise.all([
    kindData(t, signal).then((data) => ({ data, error: null }), (e: unknown) => ({ data: { kind: 'none' } as KindData, error: e instanceof Error ? e.message : String(e) })),
    api.graphNode(id, signal).catch(() => null),
  ]);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  return { target: t, id, kind: t.kind, name: t.name, data: d.data, error: d.error, node };
}
