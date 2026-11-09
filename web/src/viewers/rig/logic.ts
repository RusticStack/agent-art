// Pure rig-viewer logic (unit-tested): mode fallback, clip list, anchor index mapping, scale fit, status texts.
import type { AnimTag, RigInfo } from '@/lib/api/types';

export type RigMode = 'clip' | 'pose' | 'parts' | 'skin';
export const RIG_MODES: { value: RigMode; label: string }[] = [
  { value: 'clip', label: 'Clip + skeleton' },
  { value: 'pose', label: 'Pose (all views)' },
  { value: 'parts', label: 'Parts sheet' },
  { value: 'skin', label: 'Skin mesh + weights' },
];
export const NO_CLIPS = 'No clips yet: art_rig animate {name, preset} renders them.';

/** Max canvas side and area (browser limits). */
export const MAX_SIDE = 8192;
export const MAX_AREA = 32_000_000;

/**
 * The mode to show. Legacy order: the current mode falls back from skin (no skin) and from clip (no clips) to
 * pose; then an explicitly requested mode wins. A requested skin mode on a rig without a skin also falls back.
 */
export function pickMode(o: { current: RigMode; requested?: RigMode; hasClips: boolean; hasSkin: boolean }): RigMode {
  let m = o.current;
  if (m === 'skin' && !o.hasSkin) m = 'pose';
  if (m === 'clip' && !o.hasClips) m = 'pose';
  if (o.requested) m = o.requested;
  if (m === 'skin' && !o.hasSkin) m = 'pose';
  return m;
}

/** `<output canvas>/<tag>` for every tag on the rig's output canvases (outputs order, then tag order). */
export function clipList(outputs: string[], infos: Record<string, { animations?: Record<string, AnimTag> } | null | undefined>): string[] {
  const clips: string[] = [];
  for (const o of outputs) for (const t of Object.keys(infos[o]?.animations || {})) clips.push(`${o}/${t}`);
  return clips;
}

/** Split `canvas/tag` (tags may not contain '/', canvases may not either). */
export function splitClip(v: string): [string, string] {
  const i = v.indexOf('/');
  return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
}

/**
 * Anchors are stored per frame of the tag, in tag order; the play list may reverse / pingpong the frames.
 * Map the shown absolute frame back through the tag's frame list; fall back to the play index.
 */
export function anchorIndex(tagFrames: number[], frame: number, playIdx: number): number {
  const ai = tagFrames.indexOf(frame);
  return ai >= 0 ? ai : playIdx;
}

/** Integer clip scale that fits the stage (40 px margin), 1..16. */
export function clipScale(boxW: number, boxH: number, w: number, h: number): number {
  return Math.max(1, Math.min(16, Math.floor(Math.min((boxW - 40) / w, (boxH - 40) / h))));
}

/**
 * Clamp a scale (and, as a last resort, the device pixel ratio) so the backing store stays within
 * MAX_SIDE per side and MAX_AREA pixels. clamped = something was reduced.
 */
export function fitCanvas(w: number, h: number, scale: number, dpr: number): { scale: number; dpr: number; clamped: boolean } {
  const fits = (s: number, d: number) => w * s * d <= MAX_SIDE && h * s * d <= MAX_SIDE && w * h * s * s * d * d <= MAX_AREA;
  let s = Math.max(1, Math.floor(scale));
  const s0 = s;
  while (s > 1 && !fits(s, dpr)) s--;
  let d = dpr;
  if (!fits(s, d)) d = Math.min(d, MAX_SIDE / (w * s), MAX_SIDE / (h * s), Math.sqrt(MAX_AREA / (w * h * s * s)));
  return { scale: s, dpr: d, clamped: s < s0 || d < dpr };
}

export function baseStatus(name: string, r: Pick<RigInfo, 'frame' | 'parts' | 'views' | 'mirror'>): string {
  const mir = Object.keys(r.mirror || {});
  return `${name} · frame ${r.frame.join('×')} · ${Object.keys(r.parts).length} parts · views ${r.views.join(', ')}${mir.length ? ` (+ mirrored ${mir.join(', ')})` : ''}`;
}

export function modeStatus(base: string, o:
  | { mode: 'parts'; name: string }
  | { mode: 'skin'; mesh: string; bone: string }
  | { mode: 'pose'; pose: string }
  | { mode: 'clip'; clip: string; frames: number; anchors: boolean }
  | { mode: 'none' }): string {
  switch (o.mode) {
    case 'parts': return `${base} · parts canvas ${o.name}_parts (red dot = pivot)`;
    case 'skin': return `${base} · skin ${o.mesh}: drawing + lattice | ${o.bone ? `weight of ${o.bone} (blue 0 .. red 1)` : 'dominant bone per pixel'}`;
    case 'pose': return `${base} · pose ${o.pose || 'rest'} · red dashes = ground line`;
    case 'clip': return `${base} · clip ${o.clip}: ${o.frames} frames${o.anchors ? ' · skeleton from part anchors' : ' · no anchors on this clip'}`;
    default: return base;
  }
}

/** Label of the clip frame scrubber: play position and the absolute frame on the output canvas. */
export const clipFrameLabel = (idx: number, n: number, frame: number): string => `${idx + 1} / ${n} · f${frame}`;
