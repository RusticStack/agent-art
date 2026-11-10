import { describe, expect, it, vi } from 'vitest';
import type { AssetIndex, ModelSummary, RigSummary } from '@/lib/api/types';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { Target } from '@/viewers/types';
import { actionItems, assetItems, search, segments, type PaletteAction, type PaletteContext, type PaletteItem } from './commands';

const rig = (name: string): RigSummary => ({ name, canvas: `${name}_parts`, project: null, frame: [16, 16], views: [], mirror: [], parts: [], poses: [], presets: [], outputs: [], version: '1' });
const model = (name: string, project: string | null = null): ModelSummary => ({ name, project, parts: 1, named: [], types: [], poses: [], clips: [], sockets: [], updated: 0 });

const INDEX: AssetIndex = assetIndex({
  canvases: [canvasSummary('helmet_front', { project: 'severance' }), canvasSummary('helmet_back'), canvasSummary('hull_frame'), canvasSummary('spark', { frames: 4 })],
  rigs: [rig('hero')],
  models: [model('rifle', 'severance')],
  audio: [{ name: 'rifle_shot', updated: 0 }],
  projects: [{ name: 'severance', palette: 8 }],
  groups: [{ name: 'armour', parent: null, members: ['canvas:helmet_front'] }],
  exports: [{ path: 'icons/helmet_front.png', size: 10, mtime: 0 }],
});

const ctx = (o: Partial<PaletteContext> = {}): PaletteContext => ({
  slotA: null, index: INDEX, comparing: false, following: false, reviewMode: false, browserShown: true, showHidden: false, soloCount: 0, ...o,
});
const labels = (items: PaletteItem[]) => items.map((i) => i.label);
const byLabel = (items: PaletteItem[], label: string) => items.find((i) => i.label === label);

describe('assetItems', () => {
  it('lists every asset kind of the index with kind label (+ project) as meta', () => {
    const items = assetItems(INDEX, () => true, () => {});
    expect(items.map((i) => i.id)).toEqual([
      'canvas:helmet_front', 'canvas:helmet_back', 'canvas:hull_frame', 'canvas:spark', 'rig:hero', 'model:rifle', 'audio:rifle_shot',
      'project:severance', 'group:armour', 'export:icons/helmet_front.png',
    ]);
    expect(byLabel(items, 'helmet_front')!.meta).toBe('canvas · severance');
    expect(byLabel(items, 'rifle')!.meta).toBe('3D model · severance');
    expect(items.every((i) => i.group === 'Assets')).toBe(true);
  });

  it('respects the hidden and solo filter (the visible callback)', () => {
    const hidden = new Set(['canvas:hull_frame', 'model:rifle']);
    expect(labels(assetItems(INDEX, (id) => !hidden.has(id), () => {}))).not.toContain('hull_frame');
    expect(labels(assetItems(INDEX, (id) => !hidden.has(id), () => {}))).not.toContain('rifle');
    const solo = new Set(['canvas:spark']);
    expect(labels(assetItems(INDEX, (id) => solo.has(id), () => {}))).toEqual(['spark']);
    expect(assetItems(null, () => true, () => {})).toEqual([]);
  });

  it('opens targetFor(kind, name) in slot A, or slot B with compare', () => {
    const open = vi.fn<(t: Target, slot: 'A' | 'B') => void>();
    const items = assetItems(INDEX, () => true, open);
    byLabel(items, 'hero')!.run({ compare: false });
    byLabel(items, 'armour')!.run({ compare: true });
    expect(open.mock.calls).toEqual([[{ kind: 'rig', name: 'hero' }, 'A'], [{ kind: 'graph', focus: 'group:armour' }, 'B']]);
  });
});

describe('actionItems', () => {
  const run = () => {};

  it('without anything open: global actions and the key-less ones, no tabs, tools, undo or back to live', () => {
    const l = labels(actionItems(ctx(), run));
    expect(l).toEqual(expect.arrayContaining(['Follow the agent', 'Compare', 'Review mode', 'Filter assets', 'Asset graph', 'Timeline right / bottom',
      'Toggle assets pane', 'Toggle side pane', 'Help: keyboard shortcuts', 'New canvas…', 'Cleanup: Trash', 'Cleanup: Disk usage', 'Cleanup: Settings',
      'Review notes', 'Show hidden assets']));
    expect(l.some((x) => x.startsWith('Tab:') || x.startsWith('Tool:') || x.startsWith('Shading:') || x.startsWith('View:'))).toBe(false);
    expect(l).not.toContain('Undo');
    expect(l).not.toContain('Back to live');
    expect(l).not.toContain('Project overview');
    expect(l).not.toContain('Clear solo');
  });

  it('the palette row (Ctrl+K) is not one of its own items', () => {
    const items = actionItems(ctx(), run);
    expect(items.some((i) => i.id === 'action:palette' || i.shortcut === 'Ctrl+K')).toBe(false);
  });

  it('canvas editor: tabs of slot A (not the current one) with digits, tool keys, undo / redo, overview of its project', () => {
    const items = actionItems(ctx({ slotA: { kind: 'canvas', name: 'helmet_front' } }), run);
    const l = labels(items);
    expect(l.filter((x) => x.startsWith('Tab:'))).toEqual(['Tab: Sheet', 'Tab: Layers']);
    expect(byLabel(items, 'Tab: Sheet')!.shortcut).toBe('2');
    expect(l.filter((x) => x.startsWith('Tool:'))).toEqual(['Tool: pencil', 'Tool: eraser', 'Tool: fill', 'Tool: line', 'Tool: rectangle (Shift = filled)', 'Tool: pick', 'Tool: pan']);
    expect(byLabel(items, 'Tool: pencil')!.shortcut).toBe('B');
    expect(l).toEqual(expect.arrayContaining(['Undo', 'Redo']));
    expect(byLabel(items, 'Project overview')!.meta).toBe('severance');
    expect(l).not.toContain('Back to live');
  });

  it('animation tab: no tool keys; the Canvas tab is offered', () => {
    const l = labels(actionItems(ctx({ slotA: { kind: 'canvas', name: 'spark', view: 'anim' } }), run));
    expect(l.filter((x) => x.startsWith('Tab:'))).toEqual(['Tab: Canvas', 'Tab: Sheet', 'Tab: Layers']);
    expect(l.some((x) => x.startsWith('Tool:'))).toBe(false);
  });

  it("'Back to live' only on a snapshot (and no tabs, tools or undo there)", () => {
    const l = labels(actionItems(ctx({ slotA: { kind: 'canvas', name: 'spark', snap: 's1', label: 'x' } }), run));
    expect(l).toContain('Back to live');
    expect(l.some((x) => x.startsWith('Tab:') || x.startsWith('Tool:'))).toBe(false);
    expect(l).not.toContain('Undo');
  });

  it('a model in slot A adds the four shading modes and the six view presets', () => {
    const l = labels(actionItems(ctx({ slotA: { kind: 'model', name: 'rifle' } }), run));
    expect(l.filter((x) => x.startsWith('Shading:'))).toEqual(['Shading: Wireframe', 'Shading: Solid', 'Shading: Material preview', 'Shading: Rendered']);
    expect(l.filter((x) => x.startsWith('View:'))).toEqual(['View: Front', 'View: Back', 'View: Right', 'View: Left', 'View: Top', 'View: Bottom']);
    expect(l.some((x) => x.startsWith('Tool:'))).toBe(false);
  });

  it('filter needs the browser pane; clear solo needs a solo; show hidden flips; toggles show their state', () => {
    const items = actionItems(ctx({ browserShown: false, soloCount: 2, showHidden: true, following: true, comparing: true }), run);
    const l = labels(items);
    expect(l).not.toContain('Filter assets');
    expect(l).toContain('Clear solo');
    expect(l).toContain('Stop showing hidden assets');
    expect(l).not.toContain('Show hidden assets');
    expect(byLabel(items, 'Follow the agent')!.meta).toBe('on');
    expect(byLabel(items, 'Compare')!.meta).toBe('on');
    expect(byLabel(items, 'Review mode')!.meta).toBe('off');
  });

  it('runs through the injected callback', () => {
    const got: PaletteAction[] = [];
    const items = actionItems(ctx({ slotA: { kind: 'canvas', name: 'helmet_front' } }), (a) => got.push(a));
    for (const l of ['Asset graph', 'Tab: Layers', 'Tool: fill', 'Redo', 'Cleanup: Disk usage', 'Show hidden assets', 'Toggle side pane']) byLabel(items, l)!.run({ compare: false });
    expect(got).toEqual([
      { type: 'shortcut', action: 'graph' }, { type: 'tab', tab: 'layers' }, { type: 'tool', tool: 'fill' }, { type: 'undo', redo: true },
      { type: 'cleanup', tab: 'usage' }, { type: 'showHidden', on: true }, { type: 'pane', pane: 'side' },
    ]);
  });
});

describe('search', () => {
  const assets = assetItems(INDEX, () => true, () => {});
  const actions = actionItems(ctx(), () => {});
  const all = [...actions, ...assets];

  it('empty query: Recent (opened targets that still exist) then all Actions', () => {
    const r = search('', all, ['spark', 'model:rifle', 'graph']);
    expect(r.slice(0, 3).map((i) => [i.group, i.label])).toEqual([['Recent', 'spark'], ['Recent', 'rifle'], ['Recent', 'Asset graph']]);
    expect(r.slice(3)).toEqual(actions);
    expect(new Set(r.map((i) => i.id)).size).toBe(r.length);
  });

  it('a recent entry for a deleted asset is dropped; at most 8 recent', () => {
    expect(search('', all, ['gone_canvas', 'audio:deleted', 'spark']).filter((i) => i.group === 'Recent').map((i) => i.label)).toEqual(['spark']);
    const many = Array.from({ length: 12 }, (_, i) => canvasSummary(`c${i}`));
    const items = assetItems(assetIndex({ canvases: many }), () => true, () => {});
    expect(search('', items, many.map((c) => c.name)).length).toBe(8);
  });

  it('a subsequence query (hlmfr) ranks helmet_front first and returns its highlight indexes', () => {
    const r = search('hlmfr', all, []);
    expect(r[0].label).toBe('helmet_front');
    expect(r[0].group).toBe('Assets');
    expect(r[0].highlight).toEqual([0, 2, 3, 7, 8]);
    expect(segments(r[0].label, r[0].highlight)).toEqual([
      { text: 'h', hit: true }, { text: 'e', hit: false }, { text: 'lm', hit: true }, { text: 'et_', hit: false }, { text: 'fr', hit: true }, { text: 'ont', hit: false },
    ]);
  });

  it('actions come first when their score is within 10% of the best asset', () => {
    const r = search('graph', [...all, ...assetItems(assetIndex({ canvases: [canvasSummary('graph_test')] }), () => true, () => {})], []);
    expect(r[0].label).toBe('Asset graph');
    const s = search('spark', all, []);
    expect(s[0].label).toBe('spark');
  });

  it('assets are also matched over the meta line (kind, project)', () => {
    const r = search('severance', all, []);
    expect(labels(r)).toEqual(expect.arrayContaining(['helmet_front', 'rifle', 'severance']));
  });

  it('limit', () => {
    const many = assetItems(assetIndex({ canvases: Array.from({ length: 200 }, (_, i) => canvasSummary(`tile_${i}`)) }), () => true, () => {});
    expect(search('tile', many, []).length).toBe(50);
    expect(search('tile', many, [], 7).length).toBe(7);
    expect(search('', actions, [], 3).length).toBe(3);
  });

  it('5000 assets: a keystroke filters in under 30 ms (median of 20)', () => {
    const words = ['helmet', 'rifle', 'crate', 'spark', 'hero', 'tree', 'rock', 'grass', 'wall', 'door'];
    const canvases = Array.from({ length: 5000 }, (_, i) => canvasSummary(`${words[i % 10]}_${words[(i * 7) % 10]}_${i}`, { project: i % 3 ? null : `p${i % 17}` }));
    const items = [...actions, ...assetItems(assetIndex({ canvases }), () => true, () => {})];
    search('warm', items, []);
    const times: number[] = [];
    const qs = ['h', 'he', 'hel', 'helm', 'helme', 'rk', 'rck', 'tr', 'gr_w', 'dr'];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      search(qs[i % qs.length], items, []);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = (times[9] + times[10]) / 2;
    if (!process.env.CI_SLOW) expect(median).toBeLessThan(30);
  });
});
