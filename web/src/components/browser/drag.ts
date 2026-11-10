// Drag an asset row onto a viewer slot (Review 2, RV3). Native HTML drag and drop: the row is the
// source (setDragTarget); the shell's drop zones use hasDragTarget (dragenter / dragover, where the
// data itself cannot be read) and readDragTarget (drop). Drags without the custom type (files, text
// from other apps) are ignored.
import type { Target } from '@/viewers/types';

export const DRAG_TYPE = 'application/x-agent-art-target';

const KINDS = new Set(['canvas', 'rig', 'model', 'audio', 'project', 'export', 'graph']);

/** dragstart: the row's target as JSON plus its name as plain text. */
export function setDragTarget(e: DragEvent, target: Target, name: string): void {
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(DRAG_TYPE, JSON.stringify(target));
  dt.setData('text/plain', name);
  dt.effectAllowed = 'copy';
}

/** Is this a drag from an asset row? (usable in dragenter / dragover) */
export function hasDragTarget(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes(DRAG_TYPE);
}

/** Parse and check a dragged target (JSON text); null when it is not one. */
export function parseDragTarget(text: string | null | undefined): Target | null {
  if (!text) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { kind?: unknown; name?: unknown };
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (o.kind !== 'graph' && (typeof o.name !== 'string' || !o.name)) return null;
  return v as Target;
}

/** drop: the dragged target, or null for any other drag. */
export function readDragTarget(e: DragEvent): Target | null {
  if (!hasDragTarget(e)) return null;
  return parseDragTarget(e.dataTransfer?.getData(DRAG_TYPE));
}
