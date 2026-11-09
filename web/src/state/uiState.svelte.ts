// Hidden / pinned assets (saved on the server, shared by every open page) and solo (session only).
import { api } from '@/lib/api/client';
import { toast } from '@/lib/util/notify';

export class UiState {
  hidden = $state.raw<ReadonlySet<string>>(new Set());
  pinned = $state.raw<readonly string[]>([]);
  solo = $state.raw<ReadonlySet<string>>(new Set());

  async load(): Promise<void> {
    try {
      const s = await api.uiState();
      this.hidden = new Set(s.hidden || []);
      this.pinned = s.pinned || [];
    } catch { /* keep what we have */ }
  }
  isHidden(id: string): boolean { return this.hidden.has(id); }
  isPinned(id: string): boolean { return this.pinned.includes(id); }
  isSolo(id: string): boolean { return this.solo.has(id); }
  toggleHidden(id: string): Promise<void> {
    const next = new Set(this.hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.hidden = next;
    return this.save();
  }
  /** Pinning puts the asset first. */
  togglePinned(id: string): Promise<void> {
    this.pinned = this.pinned.includes(id) ? this.pinned.filter((x) => x !== id) : [id, ...this.pinned];
    return this.save();
  }
  toggleSolo(id: string): void {
    const next = new Set(this.solo);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.solo = next;
  }
  clearSolo(): void { this.solo = new Set(); }
  /** Solo filter first, then the hidden filter (unless hidden assets are shown). */
  visible(id: string, showHidden: boolean): boolean {
    if (this.solo.size && !this.solo.has(id)) return false;
    return showHidden || !this.hidden.has(id);
  }
  private async save(): Promise<void> {
    const r = await api.saveUiState({ hidden: [...this.hidden], pinned: [...this.pinned] }).catch(() => null);
    if (!r?.ok) {
      toast('Could not save the hidden / pinned state', 'error');
      await this.load();
    }
  }
}

export const uiState = new UiState();
