// URL builders (no fetch). Every viewer uses these instead of string concatenation.
const enc = encodeURIComponent;

function q(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    parts.push(`${k}=${v === true ? 1 : enc(String(v))}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

export const canvasInfo = (name: string) => `/api/canvas/${enc(name)}`;

export function canvasPng(name: string, o: { v?: string | number; t?: number | string; layer?: number | string; frame?: number; scale?: number; download?: boolean } = {}): string {
  return `/api/canvas/${enc(name)}/png` + q({ v: o.v, t: o.t, layer: o.layer, frame: o.frame, scale: o.scale, download: o.download });
}
export function canvasGif(name: string, o: { animation?: string; scale?: number; download?: boolean } = {}): string {
  return `/api/canvas/${enc(name)}/anim.gif` + q({ scale: o.scale ?? 4, download: o.download, animation: o.animation });
}
export const snapshotPng = (id: string) => `/api/snapshot/${enc(id)}.png`;
export const snapshotMeta = (id: string) => `/api/snapshot/${enc(id)}`;

export function modelGlb(name: string, o: { snap?: string; profile?: 'three'; bake?: boolean; download?: boolean } = {}): string {
  return `/api/model/${enc(name)}/glb` + q({ snap: o.snap, profile: o.profile, bake: o.bake, download: o.download });
}
export function modelThumb(name: string, o: { v?: string | number; size?: number; snap?: string } = {}): string {
  return `/api/model/${enc(name)}/thumb.png` + q({ v: o.v, size: o.size, snap: o.snap });
}
export function rigPreview(name: string, o: { pose?: string; view?: string; scale?: number; t?: number } = {}): string {
  return `/api/rig/${enc(name)}/preview.png` + q({ pose: o.pose, view: o.view, scale: o.scale, t: o.t });
}
export function rigWeights(name: string, o: { mesh: string; bone?: string; view?: string; scale?: number; t?: number }): string {
  return `/api/rig/${enc(name)}/weights.png` + q({ mesh: o.mesh, bone: o.bone, view: o.view, scale: o.scale, t: o.t });
}
export function audioWav(name: string, o: { t?: number; download?: boolean } = {}): string {
  return `/api/audio/${enc(name)}.wav` + q({ t: o.t, download: o.download });
}
export function exportFile(path: string, o: { download?: boolean; m?: number } = {}): string {
  return `/api/export-file?path=${enc(path)}` + (o.download ? '&download=1' : '') + (o.m !== undefined ? `&m=${enc(String(o.m))}` : '');
}
export const reviewImage = (file: string) => `/api/review-image/${enc(file)}`;

/** Thumbnail URL for an asset (cacheable, version keyed): canvas, model, rig (= its parts canvas); else null. */
export function thumbUrl(kind: string, name: string, version?: string | number): string | null {
  const v = version ?? '0';
  if (kind === 'canvas') return canvasPng(name, { v });
  if (kind === 'model') return modelThumb(name, { v });
  if (kind === 'rig') return canvasPng(name + '_parts', { v });
  return null;
}
