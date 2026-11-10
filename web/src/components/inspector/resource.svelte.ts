// A small keyed async resource (plan 2.7, I13): abortable, last-wins, keeps the previous data while the
// next key loads; `slow` turns on after `slowMs` of loading (the inspector then shows a spinner).

export type Loader<T> = (signal: AbortSignal) => Promise<T>;

export class Resource<T> {
  data = $state.raw<T | null>(null);
  /** The key the current `data` was loaded for. */
  dataKey = $state<string | null>(null);
  loading = $state(false);
  slow = $state(false);
  error = $state<string | null>(null);
  private key: string | null = null;
  private seq = 0;
  private ctl: AbortController | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly slowMs = 150) {}

  /** Load `key` (null clears). The same key as the one in flight or loaded does nothing. */
  load(key: string | null, loader: Loader<T>): void {
    if (key !== null && key === this.key) return;
    this.cancel();
    this.key = key;
    if (key === null) {
      this.data = null; this.dataKey = null; this.error = null; this.loading = false;
      return;
    }
    const my = ++this.seq;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.loading = true;
    this.slowTimer = setTimeout(() => { if (my === this.seq) this.slow = true; }, this.slowMs);
    loader(ctl.signal).then(
      (d) => { if (my !== this.seq) return; this.data = d; this.dataKey = key; this.error = null; },
      (e: unknown) => { if (my !== this.seq || ctl.signal.aborted) return; this.error = e instanceof Error ? e.message : String(e); },
    ).finally(() => { if (my === this.seq) this.settle(); });
  }

  /** Forget the key so the next load() of the same key runs again. */
  invalidate(): void { this.key = null; }

  dispose(): void { this.cancel(); this.key = null; }

  private cancel(): void {
    this.seq++;
    this.ctl?.abort();
    this.ctl = null;
    this.settle();
  }
  private settle(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.loading = false;
    this.slow = false;
  }
}
