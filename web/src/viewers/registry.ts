// Which viewer shows a target, and the viewer classes (canvas static; every other kind is its own chunk).
import type { ViewerCtor, ViewerKind } from './types';
import { CanvasViewer } from './canvas/CanvasViewer';

export { viewerKindFor } from '@/lib/util/targets';

type Loader = () => Promise<ViewerCtor>;
const LOADERS: Partial<Record<ViewerKind, Loader>> = {
  canvas: async () => CanvasViewer,
};

const cache = new Map<ViewerKind, Promise<ViewerCtor>>();

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

/** Register a lazy loader (used while viewers are being ported; the final table is static). */
export function registerViewer(kind: ViewerKind, loader: Loader): void { LOADERS[kind] = loader; cache.delete(kind); }
