// Server-sent events with our own reconnect (exponential backoff, never gives up) and a resync hook.
import type { AnyEvent } from './types';

export interface EventStreamOptions {
  url?: string;
  onEvent(ev: AnyEvent): void;
  /** After the hello event. reconnect is false only for the very first open. */
  onOpen(info: { reconnect: boolean }): void;
  onDown(info: { attempt: number; retryInMs: number }): void;
  makeSource?: (url: string) => EventSource;
  now?: () => number;
  random?: () => number;
}
export type StreamState = 'idle' | 'connecting' | 'open' | 'waiting';

export const HELLO_TIMEOUT_MS = 10_000;

/** min(15 s, 500 ms * 2^n), jittered by 0.8..1.2. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(15000, 500 * 2 ** attempt) * (0.8 + 0.4 * random());
}

export class EventStream {
  private o: EventStreamOptions;
  private src: EventSource | null = null;
  private attempt = 0;
  private everOpened = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private _state: StreamState = 'idle';
  private onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this._state === 'waiting') {
      this.clearRetry();
      this.connect();
    }
  };

  constructor(o: EventStreamOptions) { this.o = o; }
  get state(): StreamState { return this._state; }

  start(): void {
    if (this._state !== 'idle') return;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    this.clearRetry();
    this.clearHello();
    this.closeSource();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    this._state = 'idle';
  }

  private connect(): void {
    this.closeSource();
    this._state = 'connecting';
    const make = this.o.makeSource ?? ((u: string) => new EventSource(u));
    let src: EventSource;
    try { src = make(this.o.url ?? '/api/events'); } catch { this.fail(); return; }
    this.src = src;
    src.onmessage = (m: MessageEvent) => {
      if (this.src !== src) return;
      let ev: AnyEvent;
      try { ev = JSON.parse(String(m.data)); } catch { console.warn('agent-art: dropped a malformed event frame'); return; }
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') { console.warn('agent-art: dropped an event without a type'); return; }
      if (ev.type === 'hello') {
        this.clearHello();
        this.attempt = 0;
        this._state = 'open';
        const reconnect = this.everOpened;
        this.everOpened = true;
        this.o.onOpen({ reconnect });
        return;
      }
      this.o.onEvent(ev);
    };
    src.onerror = () => { if (this.src === src) this.fail(); };
    this.clearHello();
    this.helloTimer = setTimeout(() => { this.helloTimer = null; if (this.src === src && this._state === 'connecting') this.fail(); }, HELLO_TIMEOUT_MS);
  }

  private fail(): void {
    this.clearHello();
    this.closeSource();
    const retryInMs = backoffMs(this.attempt, this.o.random);
    this.attempt++;
    this._state = 'waiting';
    this.o.onDown({ attempt: this.attempt, retryInMs });
    this.clearRetry();
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, retryInMs);
  }

  private closeSource(): void {
    const s = this.src;
    this.src = null;
    if (s) { s.onmessage = null; s.onerror = null; try { s.close(); } catch { /* ignore */ } }
  }
  private clearRetry(): void { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; }
  private clearHello(): void { if (this.helloTimer) clearTimeout(this.helloTimer); this.helloTimer = null; }
}
