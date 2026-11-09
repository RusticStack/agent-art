// Review notes (/api/reviews): the list, counts per asset, approved assets, marks for viewers.
import { api } from '@/lib/api/client';
import type { Review, ReviewMark } from '@/lib/api/types';
import { debounce } from '@/lib/util/format';

export const ACTIVE_REVIEW: ReadonlySet<string> = new Set(['open', 'in_progress', 'reopened']);
const MARKED: ReadonlySet<string> = new Set(['open', 'in_progress', 'reopened', 'fixed']);

export class Reviews {
  list = $state.raw<Review[]>([]);
  counts = $state.raw<Record<string, number>>({});
  approved = $state.raw<ReadonlySet<string>>(new Set());
  rev = $state(0);
  readonly refreshSoon = debounce(() => { void this.refresh(); }, 200);

  async refresh(): Promise<void> {
    const r = await api.reviews().catch(() => null);
    if (!r) return;
    this.list = r.reviews || [];
    this.counts = r.counts || {};
    this.approved = new Set(r.approved || []);
    this.rev++;
  }
  get openCount(): number { return this.list.filter((r) => ACTIVE_REVIEW.has(r.status)).length; }
  /** Notes on the asset or comparing with it, newest update first. */
  forAsset(id: string): Review[] {
    return this.list.filter((r) => r.asset === id || r.compare_with?.asset === id).sort((a, b) => b.updated - a.updated);
  }
  marks(asset: { kind: string; name: string }): ReviewMark[] {
    const id = `${asset.kind}:${asset.name}`;
    return this.list.filter((r) => r.asset === id && MARKED.has(r.status))
      .map((r) => ({ id: r.id, status: r.status, region: r.target?.region, frame: r.target?.frame, time: r.target?.time }));
  }
  /** Active first, then most recently updated. */
  sortedAll(): Review[] {
    return this.list.slice().sort((a, b) => Number(ACTIVE_REVIEW.has(b.status)) - Number(ACTIVE_REVIEW.has(a.status)) || b.updated - a.updated);
  }
}

export const reviews = new Reviews();
