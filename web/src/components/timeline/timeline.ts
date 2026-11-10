// Pure timeline logic (TL5, TL7, TL10, TL11): key args, status, thumbnails, and the targets a click or
// the compare button opens. No DOM, no stores.
import type { ActivityAsset, ActivityEntry, AssetIndex } from '@/lib/api/types';
import { entryLabel } from '@/state/activity.svelte';
import { snapTarget, targetFor } from '@/lib/util/targets';
import type { Target } from '@/viewers/types';

export { entryLabel };

/** TL5: the args shown on a row, in this order, at most 4. */
export const KEY_ARGS = ['canvas', 'name', 'new_name', 'action', 'label', 'preset', 'animation', 'clip', 'pose', 'view', 'recipe', 'node', 'from', 'rel', 'to', 'id', 'status', 'asset', 'commands', 'path'] as const;
export const MAX_KEY_ARGS = 4;
export const MAX_THUMBS = 3;
/** TL10: kinds a row click may open live when no asset has an `after` snapshot. */
const OPENABLE = ['canvas', 'model', 'rig', 'audio', 'project'];

/** TL5: up to 4 key args, `k=v` (strings raw, others JSON), `commands` printed raw, `skip` left out. */
export function keyArgs(args: Record<string, unknown> | undefined | null, skip?: string | null): string {
  const a = args ?? {};
  const out: string[] = [];
  for (const k of KEY_ARGS) {
    if (out.length >= MAX_KEY_ARGS) break;
    if (k === skip) continue;
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    out.push(k === 'commands' ? String(v) : `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return out.join('  ');
}

export type EntryStatus = 'running' | 'err' | 'ok';
/** TL5: status dot. */
export const statusOf = (e: ActivityEntry): EntryStatus => (e.running ? 'running' : e.ok === false ? 'err' : 'ok');

/** TL5: the name shown on a row: tool without `art_`, or the op. */
export const displayName = (e: ActivityEntry): string => (e.type === 'tool' ? e.tool.replace(/^art_/, '') : e.op);

/** TL5: the expand button exists when the entry has child ops or args. */
export const hasDetails = (e: ActivityEntry, ops: readonly ActivityEntry[]): boolean => ops.length > 0 || Object.keys(e.args ?? {}).length > 0;

/** TL5: the compare button exists when an asset has both a before and an after snapshot. */
export const canCompare = (e: ActivityEntry): boolean => !!e.assets?.some((a) => a.before && a.after);

/** TL9: every asset of the entry is hidden. */
export const allHidden = (e: ActivityEntry, isHidden: (id: string) => boolean): boolean =>
  !!e.assets?.length && e.assets.every((a) => isHidden(`${a.kind}:${a.name}`));

export interface Thumb {
  asset: ActivityAsset;
  /** snapshot ids: [before, after] for a pair, else the one there is */
  images: string[];
  title: string;
}

/** TL7: up to 3 assets with snapshots, each a before → after pair or a single image. */
export function thumbsOf(e: ActivityEntry): Thumb[] {
  const out: Thumb[] = [];
  for (const a of e.assets ?? []) {
    if (out.length >= MAX_THUMBS) break;
    if (!a.before && !a.after) continue;
    const images = a.before && a.after ? [a.before, a.after] : [(a.after || a.before)!];
    out.push({ asset: a, images, title: `${a.kind} ${a.name}${a.created ? ' (new)' : ''}` });
  }
  return out;
}

export interface Hit {
  /** the thumbnail pair clicked (its asset name) */
  pairName?: string;
  /** which image of the pair was clicked (undefined: the pair outside its images) */
  imageIndex?: 0 | 1;
}

/**
 * TL10: what a click opens. A row: the first asset with an `after` snapshot (as snapshot `#<id>`), else
 * the first non-deleted canvas / model / rig / audio / project live. A thumbnail: the first image of a
 * before / after pair opens `before`, any other image `after || before`, the pair outside its images
 * `after`. Deleted assets open live; rig snapshots open the parts canvas.
 */
export function clickTarget(entry: ActivityEntry, hit: Hit = {}, index?: AssetIndex | null): Target | null {
  const assets = entry.assets ?? [];
  const a = hit.pairName !== undefined
    ? assets.find((x) => x.name === hit.pairName)
    : assets.find((x) => x.after) || assets.find((x) => !x.deleted && OPENABLE.includes(x.kind));
  if (!a) return null;
  const snap = hit.pairName !== undefined && hit.imageIndex !== undefined
    ? (hit.imageIndex === 0 && a.before && a.after ? a.before : a.after || a.before)
    : a.after;
  return snap && !a.deleted ? snapTarget(a, snap, `#${entry.id}`) : targetFor(a.kind, a.name, index);
}

/** TL11: slot A = before snapshot, slot B = after snapshot of the first asset that has both. */
export function compareTargets(entry: ActivityEntry): [Target, Target] | null {
  const a = entry.assets?.find((x) => x.before && x.after);
  if (!a?.before || !a.after) return null;
  return [snapTarget(a, a.before, 'before'), snapTarget(a, a.after, 'after')];
}
