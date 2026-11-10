// Compare tools (RV7, step 18c), pure parts: the overlay cycle, what slot A draws over itself given the
// peer's image, and the status texts.
import type { Rect } from '@/lib/api/types';
import { viewerKindFor } from '@/lib/util/targets';
import type { CompareImage, CompareOverlay, Target } from '../types';

export const OVERLAY_ORDER: readonly CompareOverlay[] = ['off', 'diff', 'swipe', 'blink'];
export const OVERLAY_LABEL: Readonly<Record<CompareOverlay, string>> = { off: 'Off', diff: 'Difference', swipe: 'Swipe', blink: 'Blink' };
export const SIZE_MISMATCH = 'Overlay needs two canvases of the same size';

/** The D key: Off → Difference → Swipe → Blink → Off. */
export function nextOverlay(mode: CompareOverlay): CompareOverlay {
  return OVERLAY_ORDER[(OVERLAY_ORDER.indexOf(mode) + 1) % OVERLAY_ORDER.length];
}

export interface OverlayPlan {
  overlay: { image: ImageBitmap; rect: Rect; mode: Exclude<CompareOverlay, 'off'> } | null;
  /** text for slot B's header; 'diff' = ask the view for the difference counts (diffStatus) */
  status: string | null | 'diff';
}

/** What slot A shows for an overlay mode, its own frame rect and the peer's image (step 18c). */
export function overlayPlan(mode: CompareOverlay, own: Rect | null, peer: CompareImage | null): OverlayPlan {
  if (mode === 'off' || !peer || !own) return { overlay: null, status: null };
  if (peer.rect.w !== own.w || peer.rect.h !== own.h) return { overlay: null, status: SIZE_MISMATCH };
  const overlay = { image: peer.image, rect: peer.rect, mode };
  if (mode === 'diff') return { overlay, status: 'diff' };
  return { overlay, status: null };
}

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Difference status: "<changed> px differ (<pct>%) · bbox x,y w×h", "identical", or why it was skipped. */
export function diffStatus(info: { changed: number; total: number; bbox: Rect | null; tooLarge?: boolean } | null): string | null {
  if (!info) return null;
  if (info.tooLarge) return 'Difference skipped: over 16 megapixels';
  if (!info.changed) return 'identical';
  const pct = info.total ? (info.changed / info.total) * 100 : 0;
  const b = info.bbox;
  return `${group(info.changed)} px differ (${pct.toFixed(1)}%)${b ? ` · bbox ${b.x},${b.y} ${b.w}×${b.h}` : ''}`;
}

/** Status line hint for swipe / blink. */
export function modeHint(mode: CompareOverlay, blinkManual: boolean): string | null {
  if (mode === 'swipe') return 'Swipe: drag the bar (or ← → with the canvas focused)';
  if (mode === 'blink') return blinkManual ? 'Blink: press X to swap' : 'Blink: X swaps by hand';
  return null;
}

/** The Link / Overlay controls exist only while both slots hold a canvas viewer (live or snapshot). */
export function compareToolsShown(a: Target | null | undefined, b: Target | null | undefined): boolean {
  return viewerKindFor(a) === 'canvas' && viewerKindFor(b) === 'canvas';
}
