// BaseViewer: lifecycle (mount / update / destroy), load tokens, and helpers whose resources are
// released on destroy (timers, rAF loops, ResizeObserver, DPR listeners, window / document listeners).
import type { AnyEvent } from '@/lib/api/types';
import type { Target, Viewer, ViewerEnv, ViewerHostApi, ViewerProps } from './types';

export abstract class BaseViewer implements Viewer {
  protected root!: HTMLElement;
  protected props!: ViewerProps;
  /** Pass { signal: this.dispose.signal } to every addEventListener on window / document. */
  protected readonly dispose = new AbortController();
  protected dead = false;
  private loadSeq = 0;
  private cleanups: (() => void)[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private anon = 0;

  constructor(protected readonly host: ViewerHostApi) {}

  mount(el: HTMLElement, props: ViewerProps): void | Promise<void> {
    this.props = props;
    this.root = this.build();
    el.append(this.root);
    return this.load(props.target, null);
  }

  update(props: ViewerProps): void | Promise<void> {
    const prev = this.props;
    this.props = props;
    if (this.key(props.target) !== this.key(prev.target)) return this.load(props.target, prev.target);
    if (prev.target !== props.target) this.targetChanged(prev.target, props.target);
    if (prev.env !== props.env) this.envChanged(prev.env, props.env);
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.loadSeq++;
    this.dispose.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const f of this.cleanups.splice(0).reverse()) { try { f(); } catch { /* keep going */ } }
    this.root?.remove();
  }

  onEvent?(ev: AnyEvent): void;

  protected abstract build(): HTMLElement;
  protected abstract load(target: Target, prev: Target | null): void | Promise<void>;
  /** Same key, different target object (e.g. a new frame or tag on the same canvas). */
  protected targetChanged(_prev: Target, _next: Target): void {}
  protected envChanged(_prev: ViewerEnv, _next: ViewerEnv): void {}
  protected key(t: Target): string { return JSON.stringify(t); }

  protected get env(): ViewerEnv { return this.props.env; }
  protected get target(): Target { return this.props.target; }

  /** Start a load; compare with isCurrent(token) after every await. */
  protected nextLoad(): number { return ++this.loadSeq; }
  protected isCurrent(token: number): boolean { return !this.dead && token === this.loadSeq; }

  /** setTimeout released on destroy. A named slot replaces its previous timer (debounce). */
  protected later(ms: number, fn: () => void, slot?: string): void {
    if (this.dead) return;
    const key = slot ?? `#${++this.anon}`;
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); if (!this.dead) fn(); }, ms));
  }
  protected cancelLater(slot: string): void { const t = this.timers.get(slot); if (t) clearTimeout(t); this.timers.delete(slot); }

  /** requestAnimationFrame loop: fn returns false to stop. Cancelled on destroy. Returns a stop function. */
  protected animate(fn: (t: number) => boolean | void): () => void {
    let id = 0, stopped = false;
    const tick = (t: number) => { if (stopped || this.dead) return; if (fn(t) === false) { stopped = true; return; } id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    const stop = () => { stopped = true; cancelAnimationFrame(id); };
    this.addCleanup(stop);
    return stop;
  }

  /** ResizeObserver, rAF-coalesced, disconnected on destroy. */
  protected onResize(el: Element, fn: () => void): void {
    if (typeof ResizeObserver === 'undefined') return;
    let pending = 0;
    const ro = new ResizeObserver(() => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; if (!this.dead) fn(); }); });
    ro.observe(el);
    this.addCleanup(() => { ro.disconnect(); if (pending) cancelAnimationFrame(pending); });
  }

  /** Calls fn when devicePixelRatio changes (re-armed each time). */
  protected onDprChange(fn: () => void): void {
    this.addCleanup(watchDpr(fn));
  }

  protected addCleanup(fn: () => void): void { if (this.dead) fn(); else this.cleanups.push(fn); }
}

/** matchMedia('(resolution: Xdppx)') watcher, re-armed on every change. Returns a stop function. */
export function watchDpr(fn: () => void): () => void {
  if (typeof matchMedia !== 'function' || typeof window === 'undefined') return () => {};
  let mq: MediaQueryList | null = null;
  let stopped = false;
  const handler = () => { arm(); if (!stopped) fn(); };
  const arm = () => {
    mq?.removeEventListener('change', handler);
    if (stopped) return;
    mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', handler);
  };
  arm();
  return () => { stopped = true; mq?.removeEventListener('change', handler); };
}
