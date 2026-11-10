// Pure helpers of the cleanup dialogs (C1-C7): plan tiles / lists / apply state, the trash batch
// summary line, the usage bars and the toast texts. The components only render these.
import type { CleanupPlan, TrashBatch, TrashList } from '@/lib/api/types';
import type { ToastKind } from '@/lib/util/notify';
import { fmtBytes } from '@/lib/util/format';
import { splitId } from '@/lib/util/ids';

export interface StatTile { label: string; value: string; tone?: 'bad' | 'good' }
export interface PlanView {
  tiles: StatTile[];
  blocked: { id: string; why: string }[];
  next: string;
  warnings: string[];
  refused: string[];
  items: { id: string; reason: string; size: string }[];
  unknown: string;
  applyLabel: string;
  applyDisabled: boolean;
}

/** C2 / C3: what the plan dialog shows for a dry-run result. */
export function planView(plan: CleanupPlan): PlanView {
  const blocked = plan.blocked ?? [];
  return {
    tiles: [
      { label: 'assets', value: String(plan.remove.count) },
      { label: 'on disk', value: plan.remove.size },
      ...Object.entries(plan.remove.by_kind ?? {}).map(([k, n]) => ({ label: k, value: String(n) })),
      blocked.length ? { label: 'blocked', value: String(blocked.length), tone: 'bad' as const } : { label: 'blocked', value: '0', tone: 'good' as const },
    ],
    blocked: blocked.map((b) => ({ id: b.id, why: b.why === 'approved' ? ' approved in review' : ` needed by ${(b.by ?? []).join(', ')}` })),
    next: blocked.length ? (plan.next ?? '') : '',
    warnings: plan.warnings ?? [],
    refused: plan.refused_files ?? [],
    items: plan.items.map((it) => ({ id: it.id, reason: it.reason ?? '', size: fmtBytes(it.bytes) })),
    unknown: plan.unknown?.length ? `not removable / unknown: ${plan.unknown.join(', ')}` : '',
    applyLabel: blocked.length ? 'Blocked' : `Move ${plan.items.length} to trash`,
    applyDisabled: !plan.items.length || !!blocked.length,
  };
}

/** C3 toast after a successful apply. */
export const applyToast = (r: { removed: number; size: string; trash: string }): string =>
  `${r.removed} asset(s), ${r.size} moved to the trash (${r.trash}): Cleanup › Trash restores them`;

/** C5 summary line of a trash batch: first 6 names, +N, graph links, review notes, manifests. */
export function batchSummary(b: Pick<TrashBatch, 'assets' | 'edges' | 'reviews' | 'manifests'>): string {
  const names = b.assets.slice(0, 6).map((x) => splitId(x.id)[1]).join(', ');
  const more = b.assets.length > 6 ? `, +${b.assets.length - 6}` : '';
  const edges = b.edges ? ` · ${b.edges} graph link(s)` : '';
  const reviews = b.reviews ? ` · ${b.reviews} review note(s)` : '';
  const manifests = b.manifests?.length ? ` · manifest ${b.manifests.join(', ')}` : '';
  return names + more + edges + reviews + manifests;
}

/** C5 restore toast; error style when something could not be put back. */
export function restoreToast(r: { restored: number; conflicts?: string[] }): { text: string; kind: ToastKind } {
  const c = r.conflicts ?? [];
  return { text: `restored ${r.restored} asset(s)${c.length ? ` · ${c.length} conflict(s): ${c[0]}` : ''}`, kind: c.length ? 'error' : 'ok' };
}

export type TrashAge = '' | '1d' | '7d' | '30d';
export const AGE_OPTIONS: readonly { value: TrashAge; label: string }[] = [
  { value: '', label: 'everything' }, { value: '1d', label: 'older than 1 day' },
  { value: '7d', label: 'older than 7 days' }, { value: '30d', label: 'older than 30 days' },
];

/** C5 confirm text: "Permanently delete <what>?" (the body adds "This cannot be undone."). */
export function emptyWhat(t: Pick<TrashList, 'batches' | 'size'>, age: TrashAge): string {
  const label = AGE_OPTIONS.find((o) => o.value === age)?.label ?? '';
  return age ? `trash batches ${label}` : `all ${t.batches} trash batch(es), ${t.size}`;
}

export interface UsageBar { name: string; text: string; pct: number }

/** C6 bars: first `max` entries in server order, width relative to the biggest entry (at least 1 %). */
export function usageBars(obj: Record<string, { count: number; bytes: number }>, max = 14): UsageBar[] {
  const rows = Object.entries(obj ?? {});
  const top = Math.max(1, ...rows.map(([, v]) => v.bytes));
  return rows.slice(0, max).map(([name, v]) => ({ name, text: `${v.count} · ${fmtBytes(v.bytes)}`, pct: Math.max(1, (v.bytes / top) * 100) }));
}

/** C6 tiles: the total plus each `other` entry (key underscores as spaces). */
export const usageTiles = (u: { total: string; other: Record<string, number> }): StatTile[] => [
  { label: 'assets + exports', value: u.total },
  ...Object.entries(u.other ?? {}).map(([k, v]) => ({ label: k.replace('_', ' '), value: fmtBytes(v) })),
];

/** C7: the textarea as a list of folders (trimmed, blank lines dropped). */
export const parseAllowPaths = (text: string): string[] => text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
