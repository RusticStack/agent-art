// Asset browser preferences persisted in localStorage (plan 1.12 S3): collapsed sections
// (agent-art:collapsed, default exports + groups), expanded rows (agent-art:expanded, last 500) and
// "show hidden" (agent-art:showHidden). Filter, select mode and the selection are session state of
// the component, not stored.
import { store } from '@/lib/util/storage';

export const EXPANDED_MAX = 500;
const DEFAULT_COLLAPSED = ['exports', 'groups'];

export class BrowserPrefs {
  collapsed = $state.raw<ReadonlySet<string>>(new Set());
  expanded = $state.raw<ReadonlySet<string>>(new Set());
  showHidden = $state(false);

  constructor() { this.load(); }

  /** (Re)read the stored values (tests, another tab). */
  load(): void {
    const c = store.get<unknown>('collapsed', DEFAULT_COLLAPSED);
    const e = store.get<unknown>('expanded', []);
    this.collapsed = new Set(Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : DEFAULT_COLLAPSED);
    this.expanded = new Set(Array.isArray(e) ? e.filter((x): x is string => typeof x === 'string') : []);
    this.showHidden = store.get<unknown>('showHidden', false) === true;
  }
  isCollapsed(section: string): boolean { return this.collapsed.has(section); }
  toggleCollapsed(section: string): void {
    const next = new Set(this.collapsed);
    if (next.has(section)) next.delete(section); else next.add(section);
    this.collapsed = next;
    store.set('collapsed', [...next]);
  }
  isExpanded(id: string): boolean { return this.expanded.has(id); }
  setExpanded(id: string, on: boolean): void {
    if (this.expanded.has(id) === on) return;
    const next = new Set(this.expanded);
    if (on) next.add(id); else next.delete(id);
    this.expanded = next;
    store.set('expanded', [...next].slice(-EXPANDED_MAX));
  }
  toggleExpanded(id: string): void { this.setExpanded(id, !this.expanded.has(id)); }
  setShowHidden(on: boolean): void {
    this.showHidden = on;
    store.set('showHidden', on);
  }
  toggleShowHidden(): void { this.setShowHidden(!this.showHidden); }
}

export const prefs = new BrowserPrefs();
