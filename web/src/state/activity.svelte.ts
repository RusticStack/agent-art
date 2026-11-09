// Activity log (every tool call and op): a plain Map + order array, trimmed to 3000; `version` is
// bumped at most once per animation frame so a burst of events renders once.
import type { ActivityEntry } from '@/lib/api/types';
import { store } from '@/lib/util/storage';
import type { Target } from '@/viewers/types';

export interface TimelineFilter { tool: string; errors: boolean; current: boolean; agent: boolean }
export const MAX_ENTRIES = 3000;
const DEFAULT_FILTER: TimelineFilter = { tool: '', errors: false, current: false, agent: false };

const raf = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn); else setTimeout(fn, 16);
};

export const entryLabel = (e: ActivityEntry | undefined): string => (e ? (e.type === 'tool' ? e.tool : e.op) : '');

/** Does an entry touch the open asset (rig outputs and parts count as the rig)? */
export function touches(e: ActivityEntry, cur: Target | null): boolean {
  if (!cur || !('name' in cur)) return false;
  const n = cur.name;
  return !!e.assets?.some((a) => a.name === n || `${a.name}_parts` === n || a.name === `${n}_parts`);
}

export class Activity {
  version = $state(0);
  filter = $state<TimelineFilter>({ ...DEFAULT_FILTER, ...store.get<Partial<TimelineFilter>>('tlFilter', {}) });
  search = $state('');
  expanded = $state.raw<ReadonlySet<number>>(new Set());
  private entries = new Map<number, ActivityEntry>();
  private order: number[] = [];
  private pending = false;

  private bump(): void {
    if (this.pending) return;
    this.pending = true;
    raf(() => { this.pending = false; this.version++; });
  }
  load(list: ActivityEntry[]): void {
    for (const e of list) this.put(e);
    this.bump();
  }
  upsert(e: ActivityEntry): void { this.put(e); this.bump(); }
  private put(e: ActivityEntry): void {
    if (!this.entries.has(e.id)) this.order.push(e.id);
    this.entries.set(e.id, e);
    if (this.order.length > MAX_ENTRIES) for (const id of this.order.splice(0, this.order.length - MAX_ENTRIES)) this.entries.delete(id);
  }
  /** Server restart: ids start again from 1. */
  reset(): void {
    this.entries.clear();
    this.order = [];
    this.expanded = new Set();
    this.bump();
  }
  /** Every kept entry in arrival order (tool calls and their ops). */
  all(): ActivityEntry[] { return this.order.map((id) => this.entries.get(id)!); }
  get(id: number): ActivityEntry | undefined { return this.entries.get(id); }
  get size(): number { return this.order.length; }
  get lastId(): number { return this.order.length ? Math.max(...this.order.slice(-50)) : 0; }
  /** Top-level entries in arrival order: tool calls, and ops that are not part of a known tool call. */
  topLevel(): ActivityEntry[] {
    const calls = new Set<string>();
    for (const id of this.order) { const e = this.entries.get(id); if (e?.type === 'tool') calls.add(e.call); }
    return this.order.map((id) => this.entries.get(id)!).filter((e) => e && (e.type === 'tool' || !e.call || !calls.has(e.call)));
  }
  passes(e: ActivityEntry, current: Target | null, q = this.search.trim().toLowerCase()): boolean {
    const f = this.filter;
    if (f.tool && entryLabel(e) !== f.tool) return false;
    if (f.errors && e.ok !== false) return false;
    if (f.agent && e.source === 'user') return false;
    if (f.current && !touches(e, current)) return false;
    if (q && !JSON.stringify([e.tool, e.type === 'op' ? e.op : undefined, e.args, e.summary, e.error, e.assets?.map((a) => a.name)]).toLowerCase().includes(q)) return false;
    return true;
  }
  /** Newest first. */
  rows(current: Target | null): { shown: ActivityEntry[]; total: number; errors: number; tools: string[] } {
    const top = this.topLevel();
    const q = this.search.trim().toLowerCase();
    const shown = top.filter((e) => this.passes(e, current, q)).reverse();
    return { shown, total: top.length, errors: top.filter((e) => e.ok === false).length, tools: this.tools() };
  }
  tools(): string[] { return [...new Set(this.order.map((id) => entryLabel(this.entries.get(id))).filter(Boolean))].sort(); }
  setFilter(patch: Partial<TimelineFilter>): void {
    this.filter = { ...this.filter, ...patch };
    store.set('tlFilter', this.filter);
  }
  toggleExpanded(id: number): void {
    const next = new Set(this.expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.expanded = next;
  }
}

export const activity = new Activity();
