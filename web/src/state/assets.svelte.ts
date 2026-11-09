// The asset index (/api/assets) with fast lookups. A failed refresh keeps the old index.
import { api } from '@/lib/api/client';
import type { AssetIndex, CanvasSummary, ModelSummary, RigSummary } from '@/lib/api/types';
import { debounce } from '@/lib/util/format';

export class Assets {
  index = $state.raw<AssetIndex | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  rev = $state(0);
  private canvases = new Map<string, CanvasSummary>();
  private rigs = new Map<string, RigSummary>();
  private models = new Map<string, ModelSummary>();
  private superseded = new Set<string>();
  private orphans = new Set<string>();
  readonly refreshSoon = debounce(() => { void this.refresh(); }, 350);

  async refresh(): Promise<void> {
    try {
      this.set(await api.assets());
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
  /** Replace the index (also used by tests). */
  set(index: AssetIndex): void {
    this.canvases = new Map(index.canvases.map((c) => [c.name, c]));
    this.rigs = new Map(index.rigs.map((r) => [r.name, r]));
    this.models = new Map(index.models.map((m) => [m.name, m]));
    this.superseded = new Set(index.flags?.superseded || []);
    this.orphans = new Set(index.flags?.orphans || []);
    this.index = index;
    this.rev++;
  }
  canvas(name: string): CanvasSummary | undefined { return this.canvases.get(name); }
  rig(name: string): RigSummary | undefined { return this.rigs.get(name); }
  model(name: string): ModelSummary | undefined { return this.models.get(name); }
  isSuperseded(id: string): boolean { return this.superseded.has(id); }
  isOrphan(id: string): boolean { return this.orphans.has(id); }
  /** canvas:, model:, rig:, audio: ids (review "compare with" suggestions). */
  choices(): string[] {
    const a = this.index;
    if (!a) return [];
    return [...a.canvases.map((c) => `canvas:${c.name}`), ...a.models.map((m) => `model:${m.name}`), ...a.rigs.map((r) => `rig:${r.name}`), ...a.audio.map((s) => `audio:${s.name}`)];
  }
  allTags(): string[] {
    const t = new Set<string>();
    for (const list of Object.values(this.index?.tags || {})) for (const x of list) t.add(x);
    return [...t].sort();
  }
}

export const assets = new Assets();
