// Toast queue (O1): info / ok live 3.5 s, errors 6 s, then a 0.5 s fade. Hovering or focusing the stack
// holds every timer (new); errors can be dismissed (new). The UI shows the newest MAX_VISIBLE.
import { onToast, type ToastKind } from '@/lib/util/notify';

export type { ToastKind };
export interface Toast { id: number; text: string; kind: ToastKind; until: number; leaving: boolean }

export const LIFETIME: Record<ToastKind, number> = { info: 3500, ok: 3500, error: 6000 };
export const FADE_MS = 500;
export const MAX_VISIBLE = 4;

export class Toasts {
  list = $state<Toast[]>([]);
  held = $state(false);
  private seq = 0;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private remaining = new Map<number, number>();

  /** The newest MAX_VISIBLE toasts, oldest first. */
  get visible(): Toast[] { return this.list.slice(-MAX_VISIBLE); }
  /** Live toasts collapsed behind the visible ones. */
  get collapsed(): number { return Math.max(0, this.list.length - MAX_VISIBLE); }

  push(text: string, kind: ToastKind = 'info'): number {
    const id = ++this.seq;
    const life = LIFETIME[kind] ?? LIFETIME.info;
    this.list.push({ id, text, kind, until: Date.now() + life, leaving: false });
    if (this.held) this.remaining.set(id, life);
    else this.arm(id, life);
    return id;
  }

  /** Start the fade now; removed FADE_MS later. */
  dismiss(id: number): void {
    const t = this.list.find((x) => x.id === id);
    if (!t || t.leaving) return;
    this.clear(id);
    t.leaving = true;
    this.timers.set(id, setTimeout(() => this.remove(id), FADE_MS));
  }

  /** Hold (pointer over or focus inside the stack) pauses every live toast; releasing resumes them. */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    const now = Date.now();
    for (const t of this.list) {
      if (t.leaving) continue;
      if (on) { this.remaining.set(t.id, Math.max(0, t.until - now)); this.clear(t.id); }
      else {
        const left = this.remaining.get(t.id) ?? Math.max(0, t.until - now);
        this.remaining.delete(t.id);
        t.until = now + left;
        this.arm(t.id, left);
      }
    }
  }

  /** Drop everything at once (tests). */
  reset(): void {
    for (const id of this.timers.keys()) this.clear(id);
    this.remaining.clear();
    this.list = [];
    this.held = false;
  }

  private arm(id: number, ms: number): void {
    this.clear(id);
    this.timers.set(id, setTimeout(() => this.dismiss(id), ms));
  }
  private clear(id: number): void {
    const h = this.timers.get(id);
    if (h !== undefined) clearTimeout(h);
    this.timers.delete(id);
  }
  private remove(id: number): void {
    this.clear(id);
    this.remaining.delete(id);
    const i = this.list.findIndex((x) => x.id === id);
    if (i >= 0) this.list.splice(i, 1);
  }
}

export const toasts = new Toasts();
export const toast = (text: string, kind: ToastKind = 'info'): void => { toasts.push(text, kind); };

/** Route the lib-level toast bus (API client, stores) into this queue. */
export function connectToastBus(): void { onToast((text, kind) => toasts.push(text, kind)); }
