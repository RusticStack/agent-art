// Dialog stack + promise helpers. DialogHost renders the stack; the promise-returning helpers resolve
// when the dialog closes (close(spec, result)). Help does not block global keys (K2) or follow (E10).
import type { ReviewDraft } from '@/viewers/types';

export type CleanupTab = 'trash' | 'usage' | 'settings';
export interface ConfirmOptions { title: string; body?: string; confirmLabel: string; danger?: boolean }
export interface PromptOptions { title: string; label: string; placeholder?: string; value?: string; confirmLabel?: string }

export type DialogSpec =
  | { type: 'help' } | { type: 'reviewList' } | { type: 'palette' }
  | { type: 'reviewNote'; draft: ReviewDraft; resolve(r: { id: string } | null): void }
  | { type: 'planCleanup'; ids: string[]; resolve(done: boolean): void }
  | { type: 'cleanup'; tab: CleanupTab }
  | ({ type: 'confirm'; resolve(ok: boolean): void } & ConfirmOptions)
  | ({ type: 'prompt'; resolve(v: string | null): void } & PromptOptions);
export type DialogType = DialogSpec['type'];

const isId = (v: unknown): v is { id: string } => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';

export class Dialogs {
  stack = $state.raw<DialogSpec[]>([]);

  /** Any dialog except Help is open (K2, E10). */
  get blocking(): boolean { return this.stack.some((d) => d.type !== 'help'); }
  get helpOpen(): boolean { return this.stack.some((d) => d.type === 'help'); }
  get top(): DialogSpec | null { return this.stack.at(-1) ?? null; }
  isOpen(type: DialogType): boolean { return this.stack.some((d) => d.type === type); }

  toggleHelp(): void {
    const h = this.stack.find((d) => d.type === 'help');
    if (h) this.close(h); else this.push({ type: 'help' });
  }
  openReviewList(): void { if (!this.isOpen('reviewList')) this.push({ type: 'reviewList' }); }
  openCleanup(tab: CleanupTab = 'trash'): void {
    const cur = this.stack.find((d) => d.type === 'cleanup');
    if (cur) this.stack = this.stack.map((d) => (d === cur ? { type: 'cleanup', tab } : d));
    else this.push({ type: 'cleanup', tab });
  }
  openPalette(): void { if (!this.isOpen('palette')) this.push({ type: 'palette' }); }

  reviewNote(draft: ReviewDraft): Promise<{ id: string } | null> {
    return new Promise((resolve) => this.push({ type: 'reviewNote', draft, resolve }));
  }
  planCleanup(ids: string[]): Promise<boolean> {
    return new Promise((resolve) => this.push({ type: 'planCleanup', ids: [...ids], resolve }));
  }
  confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => this.push({ type: 'confirm', ...o, resolve }));
  }
  prompt(o: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => this.push({ type: 'prompt', ...o, resolve }));
  }

  /**
   * Remove a dialog and settle its promise: confirm / planCleanup -> result === true, prompt -> the
   * string or null, reviewNote -> { id } or null. Closing a spec that is not open does nothing.
   */
  close(spec: DialogSpec, result?: unknown): void {
    if (!this.stack.includes(spec)) return;
    this.stack = this.stack.filter((d) => d !== spec);
    switch (spec.type) {
      case 'confirm': spec.resolve(result === true); break;
      case 'planCleanup': spec.resolve(result === true); break;
      case 'prompt': spec.resolve(typeof result === 'string' ? result : null); break;
      case 'reviewNote': spec.resolve(isId(result) ? { id: result.id } : null); break;
      default: break;
    }
  }
  /** Close the top dialog (its promise resolves as cancelled). */
  closeTop(): void { const t = this.top; if (t) this.close(t); }
  /** Close everything, settling each promise as cancelled (tests, server restart). */
  closeAll(): void { for (const d of [...this.stack].reverse()) this.close(d); }

  private push(spec: DialogSpec): void { this.stack = [...this.stack, spec]; }
}

export const dialogs = new Dialogs();
