// Which viewer shows a target, and the viewer classes: the canvas editor is static (the default view);
// every other kind is its own lazy chunk (plan 2.3, 7.1). One cached promise per kind, so a kind's class
// is the same object every time (the shell reuses a viewer while the kind stays the same).
import type { ViewerCtor, ViewerKind } from './types';
import { CanvasViewer } from './canvas/CanvasViewer';

export { viewerKindFor } from '@/lib/util/targets';

type Loader = () => Promise<ViewerCtor>;
const LOADERS: Record<ViewerKind, Loader> = {
  canvas: async () => CanvasViewer,
  anim: () => import('./anim/AnimViewer').then((m) => m.AnimViewer),
  sheet: () => import('./sheet/SheetViewer').then((m) => m.SheetViewer),
  layers: () => import('./layers/LayersViewer').then((m) => m.LayersViewer),
  rig: () => import('./rig/RigViewer').then((m) => m.RigViewer),
  model: () => import('./model/ModelViewer').then((m) => m.ModelViewer),
  audio: () => import('./audio/AudioViewer').then((m) => m.AudioViewer),
  graph: () => import('./graph/GraphViewer').then((m) => m.GraphViewer),
  export: () => import('./export/ExportViewer').then((m) => m.ExportViewer),
  project: () => import('./project/ProjectViewer').then((m) => m.ProjectViewer),
};

const cache = new Map<ViewerKind, Promise<ViewerCtor>>();

/** The viewer class of a kind; a failed chunk load is not cached (the next open retries). */
export function loadViewer(kind: ViewerKind): Promise<ViewerCtor> {
  let p = cache.get(kind);
  if (!p) {
    const l = LOADERS[kind];
    if (!l) return Promise.reject(new Error(`No viewer for "${kind}"`));
    p = l();
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}
