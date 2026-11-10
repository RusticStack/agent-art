import { describe, expect, it, vi } from 'vitest';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { AssetIndex, ModelSummary, RigSummary } from '@/lib/api/types';
import { fmtBytes } from '@/lib/util/format';
import { isSeparator, type MenuAction, type MenuItem } from '@/components/ui/menu';
import {
  buildTree, menuFor, moreText, NO_CANVASES, NO_MATCHES, rangeSelect, selectableIds,
  type MenuContext, type TreeInput, type TreeItem, type TreeRow, type TreeSection,
} from './tree';
import { DRAG_TYPE, parseDragTarget, readDragTarget, hasDragTarget, setDragTarget } from './drag';

const rig = (name: string, o: Partial<RigSummary> = {}): RigSummary => ({
  name, canvas: `${name}_parts`, frame: [32, 32], views: ['front', 'side'], mirror: [], parts: [], poses: [], presets: [], outputs: [], version: '3', ...o,
});
const model = (name: string, o: Partial<ModelSummary> = {}): ModelSummary => ({
  name, parts: 4, named: [], types: [], poses: [], clips: [], sockets: [], updated: 7, ...o,
});

function input(index: AssetIndex, o: Partial<TreeInput> = {}): TreeInput {
  return {
    index, hidden: new Set(), pinned: [], solo: new Set(), showHidden: false, filter: '', collapsed: new Set(), expanded: new Set(),
    selectMode: false, reviewCounts: {}, approved: new Set(), ...o,
  };
}
const sections = (items: TreeItem[]) => items.filter((i): i is TreeSection => i.type === 'section');
const rows = (items: TreeItem[]) => items.filter((i): i is TreeRow => i.type === 'row');
const notes = (items: TreeItem[]) => items.filter((i) => i.type === 'note').map((n) => (n.type === 'note' ? n.text : ''));
const ids = (items: TreeItem[]) => rows(items).map((r) => r.id);
const row = (items: TreeItem[], id: string) => rows(items).find((r) => r.id === id)!;
const inSection = (items: TreeItem[], key: string) => items.filter((i) => i.type !== 'section' && i.section === key);

const full = (): AssetIndex => assetIndex({
  canvases: [canvasSummary('spark'), canvasSummary('helmet', { project: 'sev' }), canvasSummary('hero_parts', { kind: 'rigparts' })],
  rigs: [rig('hero')], models: [model('rifle')], audio: [{ name: 'shot', kind: 'gunshot', duration: 1.4667, lufs: -20.2, updated: 1 }],
  projects: [{ name: 'sev', description: 'Severance', palette: 8 }],
  groups: [{ name: 'kit', parent: null, members: ['canvas:spark'] }],
  exports: [{ path: 'a.png', size: 2048, mtime: 5 }],
});

describe('buildTree: sections', () => {
  it('lists the sections in order with counts', () => {
    const t = buildTree(input(full(), { pinned: ['canvas:spark'] }));
    expect(sections(t).map((s) => [s.section, s.title, s.count])).toEqual([
      ['pinned', 'Pinned', 1], ['groups', 'Groups', 1], ['projects', 'Projects', 1], ['canvases', 'Canvases', 1],
      ['rigs', 'Rigs', 1], ['models', '3D models', 1], ['audio', 'Audio', 1], ['exports', 'Exports', 1],
    ]);
  });
  it('omits empty sections except Canvases, which says how to start', () => {
    const t = buildTree(input(assetIndex()));
    expect(sections(t).map((s) => s.section)).toEqual(['canvases']);
    expect(notes(t)).toEqual([NO_CANVASES]);
  });
  it('collapsed sections list no rows; the section header says so', () => {
    const t = buildTree(input(full(), { collapsed: new Set(['canvases', 'exports']) }));
    const c = sections(t).find((s) => s.section === 'canvases')!;
    expect(c.collapsed).toBe(true);
    expect(inSection(t, 'canvases')).toEqual([]);
    expect(inSection(t, 'exports')).toEqual([]);
    expect(inSection(t, 'rigs').length).toBe(1);
  });
  it('filtering expands everything (collapsed sections and rows) and says "no matches" per empty section', () => {
    const idx = full();
    idx.canvases[0] = canvasSummary('spark', { layers: [{ name: 'a', visible: true }, { name: 'b', visible: true }] });
    const t = buildTree(input(idx, { filter: '  SPARK ', collapsed: new Set(['canvases', 'groups']) }));
    expect(ids(inSection(t, 'canvases'))).toEqual(['canvas:spark', 'layer:spark/b', 'layer:spark/a']);
    expect(row(t, 'canvas:spark').expanded).toBe(true);
    // groups: group rows are not filtered, their members are
    expect(ids(inSection(t, 'groups'))).toContain('group:kit');
    for (const key of ['rigs', 'models', 'audio', 'exports']) expect(notes(inSection(t, key))).toEqual([NO_MATCHES]);
    // projects without matching canvases (and not matching by name) disappear: "no matches"
    expect(notes(inSection(t, 'projects'))).toEqual([NO_MATCHES]);
  });
  it('a project matching by name stays while filtering', () => {
    const t = buildTree(input(full(), { filter: 'sev' }));
    expect(ids(inSection(t, 'projects'))).toEqual(['project:sev']);
    expect(row(t, 'project:sev').badge).toBe('0');
  });
});

describe('buildTree: visibility', () => {
  it('hidden assets are left out unless show hidden is on; then they are flagged', () => {
    const hidden = new Set(['canvas:spark']);
    expect(ids(buildTree(input(full(), { hidden })))).not.toContain('canvas:spark');
    const t = buildTree(input(full(), { hidden, showHidden: true }));
    expect(row(t, 'canvas:spark').hidden).toBe(true);
  });
  it('solo shows only the solo ids (hidden filter still applies after it)', () => {
    const t = buildTree(input(full(), { solo: new Set(['model:rifle']) }));
    expect(ids(t)).toContain('model:rifle');
    expect(ids(t)).not.toContain('canvas:spark');
    expect(ids(t)).not.toContain('rig:hero');
    expect(row(t, 'model:rifle').solo).toBe(true);
    const t2 = buildTree(input(full(), { solo: new Set(['model:rifle']), hidden: new Set(['model:rifle']) }));
    expect(ids(t2)).not.toContain('model:rifle');
  });
  it('pinned lists visible pins in order, without the filter', () => {
    const t = buildTree(input(full(), { pinned: ['model:rifle', 'canvas:spark', 'audio:shot'], hidden: new Set(['audio:shot']), filter: 'zzz' }));
    const p = sections(t).find((s) => s.section === 'pinned')!;
    expect(p.count).toBe(2);
    expect(ids(inSection(t, 'pinned'))).toEqual(['model:rifle', 'canvas:spark']);
  });
  it('a pinned canvas renders as a full canvas row (meta, thumb, children)', () => {
    const idx = full();
    idx.canvases[0] = canvasSummary('spark', { frames: 3, animations: ['spin'], version: '9' });
    const t = buildTree(input(idx, { pinned: ['canvas:spark'], expanded: new Set(['canvas:spark']) }));
    const pinned = inSection(t, 'pinned');
    expect(ids(pinned)).toEqual(['canvas:spark', 'anim:spark/spin', 'layer:spark/base']);
    const r = rows(pinned)[0];
    expect(r.meta).toBe('16×16 ·3f');
    expect(r.thumb).toBe('/api/canvas/spark/png?v=9');
    expect(r.section).toBe('pinned');
    expect(r.pinned).toBe(true);
    // the same asset in its own section has its own key
    expect(rows(inSection(t, 'canvases'))[0].key).not.toBe(r.key);
    expect(new Set(t.map((i) => i.key)).size).toBe(t.length);
  });
  it('a pinned model / rig gets its thumbnail; a pinned group opens the graph', () => {
    const idx = full();
    idx.groups.push({ name: 'g2', parent: null, members: [] });
    const t = buildTree(input(idx, { pinned: ['model:rifle', 'rig:hero', 'group:g2'] }));
    const p = rows(inSection(t, 'pinned'));
    expect(p[0].thumb).toBe('/api/model/rifle/thumb.png?v=7');
    expect(p[1].thumb).toBe('/api/canvas/hero_parts/png?v=3');
    expect(p[2].open).toEqual({ kind: 'graph', focus: 'group:g2' });
  });
});

describe('buildTree: canvases and projects', () => {
  it('project rows: description meta, item count badge, canvases as children', () => {
    const t = buildTree(input(full(), { expanded: new Set(['project:sev']) }));
    const p = row(t, 'project:sev');
    expect([p.meta, p.badge, p.hasKids, p.expanded]).toEqual(['Severance', '1', true, true]);
    expect(ids(inSection(t, 'projects'))).toEqual(['project:sev', 'canvas:helmet']);
    expect(row(t, 'canvas:helmet').depth).toBe(1);
  });
  it('caps a project at 400 canvases with a note (401 canvases -> "+1 more")', () => {
    const canvases = Array.from({ length: 401 }, (_, i) => canvasSummary(`c${String(i).padStart(3, '0')}`, { project: 'big' }));
    const t = buildTree(input(assetIndex({ canvases, projects: [{ name: 'big', palette: 0 }] }), { expanded: new Set(['project:big']) }));
    const proj = inSection(t, 'projects');
    expect(rows(proj).length).toBe(401); // project row + 400 canvases
    expect(row(t, 'project:big').badge).toBe('401');
    expect(notes(proj)).toEqual([moreText(1)]);
    expect(notes(proj)[0]).toBe('+1 more: open the project overview');
    const t400 = buildTree(input(assetIndex({ canvases: canvases.slice(0, 400), projects: [{ name: 'big', palette: 0 }] }), { expanded: new Set(['project:big']) }));
    expect(notes(t400)).toEqual([]);
  });
  it('loose canvases exclude project, rigparts and rigout canvases; the count is all loose canvases', () => {
    const idx = assetIndex({ canvases: [canvasSummary('a'), canvasSummary('b'), canvasSummary('p', { project: 'x' }), canvasSummary('r_parts', { kind: 'rigparts' }), canvasSummary('r_out', { kind: 'rigout' })] });
    const t = buildTree(input(idx, { hidden: new Set(['canvas:b']) }));
    const sec = sections(t).find((s) => s.section === 'canvases')!;
    expect(sec.count).toBe(2);
    expect(ids(inSection(t, 'canvases'))).toEqual(['canvas:a']);
    expect(notes(t)).toEqual([]); // canvases exist: no "No canvases yet"
  });
  it('canvas meta and children: animation tags, then layers top-first, hidden layers say so', () => {
    const idx = assetIndex({ canvases: [canvasSummary('s', { width: 8, height: 4, frames: 4, animations: ['walk', 'run'], layers: [{ name: 'bottom', visible: true }, { name: 'top', visible: false }] })] });
    const t = buildTree(input(idx, { expanded: new Set(['canvas:s']) }));
    expect(row(t, 'canvas:s').meta).toBe('8×4 ·4f ·2L');
    expect(ids(t)).toEqual(['canvas:s', 'anim:s/walk', 'anim:s/run', 'layer:s/top', 'layer:s/bottom']);
    expect(row(t, 'anim:s/run').open).toEqual({ kind: 'canvas', name: 's', view: 'anim', tag: 'run' });
    expect(row(t, 'layer:s/top').meta).toBe('hidden');
    expect(row(t, 'layer:s/bottom').meta).toBe('');
    expect(row(t, 'layer:s/top').actions).toBe(false);
    // a single-layer canvas without tags has no children
    const t2 = buildTree(input(assetIndex({ canvases: [canvasSummary('one')] })));
    expect(row(t2, 'canvas:one').hasKids).toBe(false);
  });
});

describe('buildTree: rigs, models, audio, exports, groups', () => {
  it('rig rows: meta, parts thumbnail, filter by output name; children: parts canvas, outputs, poses', () => {
    const idx = assetIndex({
      canvases: [canvasSummary('hero_parts', { kind: 'rigparts' }), canvasSummary('hero_walk', { kind: 'rigout' })],
      rigs: [rig('hero', { outputs: ['hero_walk', 'missing_out'], poses: ['idle', 'jump'] })],
    });
    const t = buildTree(input(idx, { expanded: new Set(['rig:hero']) }));
    const r = row(t, 'rig:hero');
    expect(r.meta).toBe('32×32 · 2 views');
    expect(r.thumb).toBe('/api/canvas/hero_parts/png?v=3');
    expect(ids(inSection(t, 'rigs'))).toEqual(['rig:hero', 'canvas:hero_parts', 'canvas:hero_walk', 'rigpose:hero/idle', 'rigpose:hero/jump']);
    const pose = row(t, 'rigpose:hero/idle');
    expect([pose.kind, pose.name, pose.actions]).toEqual(['rigpart', 'pose idle', false]);
    expect(pose.open).toEqual({ kind: 'rig', name: 'hero', mode: 'pose' });
    expect(ids(buildTree(input(idx, { filter: 'walk' })))).toContain('rig:hero');
  });
  it('model rows: meta, thumbnail, children clips then named parts', () => {
    const idx = assetIndex({ models: [model('rifle', { parts: 6, clips: ['fire'], named: ['barrel', 'stock'] }), model('crate')] });
    const t = buildTree(input(idx, { expanded: new Set(['model:rifle']) }));
    expect(row(t, 'model:rifle').meta).toBe('6 parts · 1 clips');
    expect(row(t, 'model:crate').meta).toBe('4 parts');
    expect(row(t, 'model:crate').hasKids).toBe(false);
    expect(row(t, 'model:rifle').thumb).toBe('/api/model/rifle/thumb.png?v=7');
    expect(ids(inSection(t, 'models'))).toEqual(['model:rifle', 'modelclip:rifle/fire', 'modelpart:rifle/barrel', 'modelpart:rifle/stock', 'model:crate']);
    expect(row(t, 'modelclip:rifle/fire')).toMatchObject({ kind: 'anim', meta: 'clip', open: { kind: 'model', name: 'rifle', clip: 'fire' } });
    expect(row(t, 'modelpart:rifle/barrel').open).toEqual({ kind: 'model', name: 'rifle' });
  });
  it('audio meta; the filter also matches the recipe', () => {
    const idx = assetIndex({ audio: [{ name: 'shot', kind: 'gunshot', recipe: 'rifle_crack', duration: 1.4667, lufs: -20.2, updated: 1 }, { name: 'bare', updated: 1 }] });
    const t = buildTree(input(idx));
    expect(row(t, 'audio:shot').meta).toBe('gunshot · 1.47s · -20.2 LUFS');
    expect(row(t, 'audio:bare').meta).toBe('');
    expect(ids(buildTree(input(idx, { filter: 'crack' })))).toEqual(['audio:shot']);
  });
  it('exports: sorted, grouped by folder (folder rows toggle only), file meta = size, thumbnails for png / gif', () => {
    const idx = assetIndex({ exports: [
      { path: 'sheets/b.gif', size: 10, mtime: 2 }, { path: 'z.json', size: 2048, mtime: 1 }, { path: 'sheets/a.png', size: 5, mtime: 3 }, { path: 'a.txt', size: 1, mtime: 1 },
    ] });
    const t = buildTree(input(idx, { expanded: new Set(['dir:sheets']) }));
    expect(ids(inSection(t, 'exports'))).toEqual(['export:a.txt', 'export:z.json', 'dir:sheets', 'export:sheets/a.png', 'export:sheets/b.gif']); // folders in order of their first file
    const dir = row(t, 'dir:sheets');
    expect([dir.kind, dir.name, dir.badge, dir.open, dir.actions]).toEqual(['file', 'sheets/', '2', null, false]);
    const f = row(t, 'export:sheets/a.png');
    expect([f.name, f.depth, f.actions, f.thumb]).toEqual(['a.png', 1, false, '/api/export-file?path=sheets%2Fa.png&m=3']);
    expect(f.open).toEqual({ kind: 'export', name: 'sheets/a.png' });
    expect(row(t, 'export:z.json').meta).toBe(fmtBytes(2048));
    expect(row(t, 'export:z.json').thumb).toBeNull();
    // selectable in select mode although they have no hover actions; folders never
    const s = buildTree(input(idx, { expanded: new Set(['dir:sheets']), selectMode: true }));
    expect(row(s, 'export:z.json').selectable).toBe(true);
    expect(row(s, 'dir:sheets').selectable).toBe(false);
  });
  it('groups: roots only, nested groups recurse, a missing sub-group is skipped, members filtered, group rows not selectable', () => {
    const idx = assetIndex({
      canvases: [canvasSummary('spark')], models: [model('rifle')],
      groups: [
        { name: 'root', parent: null, note: 'kit', members: ['group:child', 'group:gone', 'canvas:spark', 'model:rifle', 'audio:x'] },
        { name: 'child', parent: 'root', members: ['canvas:spark'] },
      ],
    });
    const t = buildTree(input(idx, { expanded: new Set(['group:root', 'group:child']), hidden: new Set(['audio:x']), selectMode: true }));
    expect(ids(inSection(t, 'groups'))).toEqual(['group:root', 'group:child', 'canvas:spark', 'canvas:spark', 'model:rifle']);
    const root = row(t, 'group:root');
    expect([root.meta, root.badge, root.selectable, root.actions]).toEqual(['kit', '5', false, true]);
    expect(root.open).toEqual({ kind: 'graph', focus: 'group:root' });
    expect(row(t, 'group:child').depth).toBe(1);
    expect(rows(inSection(t, 'groups'))[2].depth).toBe(2);
    expect(row(t, 'model:rifle').thumb).toBe('/api/model/rifle/thumb.png?v=7');
    expect(row(t, 'model:rifle').selectable).toBe(true);
    // a cycle does not recurse forever
    const cyc = assetIndex({ groups: [{ name: 'a', parent: null, members: ['group:b'] }, { name: 'b', parent: 'a', members: ['group:a'] }] });
    expect(ids(buildTree(input(cyc, { expanded: new Set(['group:a', 'group:b']) })))).toEqual(['group:a', 'group:b']);
  });
});

describe('buildTree: badges and aria', () => {
  it('review count, approved, superseded, orphan', () => {
    const idx = full();
    idx.flags = { superseded: ['canvas:spark'], orphans: ['model:rifle'] };
    const t = buildTree(input(idx, { reviewCounts: { 'canvas:spark': 2 }, approved: new Set(['model:rifle']) }));
    expect(row(t, 'canvas:spark')).toMatchObject({ reviews: 2, superseded: true, orphan: false, approved: false });
    expect(row(t, 'model:rifle')).toMatchObject({ reviews: 0, superseded: false, orphan: true, approved: true });
  });
  it('levels, set sizes and positions per parent', () => {
    const idx = assetIndex({ canvases: [canvasSummary('a', { animations: ['t'] }), canvasSummary('b')] });
    const t = buildTree(input(idx, { expanded: new Set(['canvas:a']) }));
    expect(sections(t)[0]).toMatchObject({ level: 1, setsize: 1, posinset: 1 });
    expect(row(t, 'canvas:a')).toMatchObject({ level: 2, setsize: 2, posinset: 1 });
    expect(row(t, 'canvas:b')).toMatchObject({ level: 2, setsize: 2, posinset: 2 });
    expect(row(t, 'anim:a/t')).toMatchObject({ level: 3, setsize: 2, posinset: 1 });
    expect(row(t, 'layer:a/base')).toMatchObject({ level: 3, setsize: 2, posinset: 2 });
    expect(row(t, 'anim:a/t').parent).toBe(row(t, 'canvas:a').key);
  });
  it('select mode makes asset rows selectable, child rows never', () => {
    const idx = assetIndex({ canvases: [canvasSummary('a', { animations: ['t'] })] });
    expect(row(buildTree(input(idx)), 'canvas:a').selectable).toBe(false);
    const t = buildTree(input(idx, { selectMode: true, expanded: new Set(['canvas:a']) }));
    expect(row(t, 'canvas:a').selectable).toBe(true);
    expect(row(t, 'anim:a/t').selectable).toBe(false);
  });
});

describe('rangeSelect', () => {
  const idx = assetIndex({ canvases: ['a', 'b', 'c', 'd', 'e'].map((n) => canvasSummary(n)) });
  const t = buildTree(input(idx, { selectMode: true }));
  const sel = (...n: string[]) => new Set(n.map((x) => `canvas:${x}`));

  it('lists selectable ids in display order', () => {
    expect(selectableIds(t)).toEqual(['canvas:a', 'canvas:b', 'canvas:c', 'canvas:d', 'canvas:e']);
  });
  it('without a last row it toggles the one row', () => {
    expect(rangeSelect(t, null, 'canvas:b', new Set())).toEqual(sel('b'));
    expect(rangeSelect(t, null, 'canvas:b', sel('b'))).toEqual(new Set());
  });
  it('forward range selects everything between the last row and this one', () => {
    expect(rangeSelect(t, 'canvas:b', 'canvas:d', sel('b'))).toEqual(sel('b', 'c', 'd'));
  });
  it('backward range works the same way', () => {
    expect(rangeSelect(t, 'canvas:d', 'canvas:a', sel('d'))).toEqual(sel('a', 'b', 'c', 'd'));
  });
  it('deselects the range when this row is selected and the last one is not', () => {
    expect(rangeSelect(t, 'canvas:a', 'canvas:d', sel('b', 'c', 'd', 'e'))).toEqual(sel('e'));
  });
  it('selects the range when both ends are selected', () => {
    expect(rangeSelect(t, 'canvas:a', 'canvas:c', sel('a', 'c'))).toEqual(sel('a', 'b', 'c'));
  });
  it('falls back to a toggle when the last row is no longer listed', () => {
    expect(rangeSelect(t, 'canvas:zz', 'canvas:c', sel('a'))).toEqual(sel('a', 'c'));
  });
  it('does not change the input set', () => {
    const s = sel('a');
    rangeSelect(t, 'canvas:a', 'canvas:e', s);
    expect(s).toEqual(sel('a'));
  });
});

describe('menuFor', () => {
  const ctx = (o: Partial<MenuContext> = {}): MenuContext & { calls: Record<string, ReturnType<typeof vi.fn>> } => {
    const calls = {
      open: vi.fn(), togglePinned: vi.fn(), toggleHidden: vi.fn(), toggleSolo: vi.fn(), reviewNote: vi.fn(), copy: vi.fn(), select: vi.fn(), planCleanup: vi.fn(),
    };
    return { index: null, selected: new Set(), base: 'http://localhost:9/', ...calls, ...o, calls };
  };
  const labels = (m: MenuItem[] | null) => (m ?? []).map((x) => (isSeparator(x) ? '—' : x.label));
  const item = (m: MenuItem[] | null, id: string) => (m ?? []).find((x): x is MenuAction => !isSeparator(x) && x.id === id)!;
  const idx = assetIndex({
    canvases: [canvasSummary('spark', { frames: 2, animations: ['spin'] }), canvasSummary('flat')],
    models: [model('rifle', { clips: ['fire'] })],
    groups: [{ name: 'kit', parent: null, members: [] }],
    exports: [{ path: 'dir/a.png', size: 1, mtime: 1 }],
  });
  const tree = buildTree(input(idx, { expanded: new Set(['canvas:spark', 'model:rifle', 'dir:dir', 'group:kit']), collapsed: new Set() }));

  it('canvas row: full menu in order, with the view tabs L8 shows', () => {
    const m = menuFor(row(tree, 'canvas:spark'), ctx({ index: idx }));
    expect(labels(m)).toEqual(['Open', 'Open in compare', 'Animation', 'Sheet', 'Layers', '—', 'Pin', 'Hide', 'Solo', '—', 'Show in graph', 'Add review note…', '—', 'Copy name', 'Copy link', '—', 'Select', 'Plan cleanup…']);
    // a one-frame canvas without tags has no Animation tab
    expect(labels(menuFor(row(tree, 'canvas:flat'), ctx({ index: idx })))).not.toContain('Animation');
  });
  it('canvas row items call the same store methods', () => {
    const c = ctx({ index: idx });
    const m = menuFor(row(tree, 'canvas:spark'), c);
    item(m, 'open').onselect();
    expect(c.calls.open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark' }, 'A');
    item(m, 'compare').onselect();
    expect(c.calls.open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark' }, 'B');
    item(m, 'view-anim').onselect();
    expect(c.calls.open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark', view: 'anim' }, 'A');
    item(m, 'pin').onselect(); item(m, 'hide').onselect(); item(m, 'solo').onselect();
    expect(c.calls.togglePinned).toHaveBeenCalledWith('canvas:spark');
    expect(c.calls.toggleHidden).toHaveBeenCalledWith('canvas:spark');
    expect(c.calls.toggleSolo).toHaveBeenCalledWith('canvas:spark');
    item(m, 'graph').onselect();
    expect(c.calls.open).toHaveBeenLastCalledWith({ kind: 'graph', focus: 'canvas:spark' }, 'A');
    item(m, 'review').onselect();
    expect(c.calls.reviewNote).toHaveBeenCalledWith({ asset: 'canvas:spark' });
    item(m, 'copy-name').onselect();
    expect(c.calls.copy).toHaveBeenLastCalledWith('spark');
    item(m, 'copy-link').onselect();
    expect(c.calls.copy).toHaveBeenLastCalledWith('http://localhost:9/#spark');
    item(m, 'select').onselect();
    expect(c.calls.select).toHaveBeenCalledWith('canvas:spark');
    item(m, 'cleanup').onselect();
    expect(c.calls.planCleanup).toHaveBeenLastCalledWith(['canvas:spark']);
  });
  it('labels follow the state: Unpin / Show / Unsolo', () => {
    const t = buildTree(input(idx, { pinned: ['model:rifle'], hidden: new Set(['model:rifle']), showHidden: true, solo: new Set(['model:rifle']) }));
    const m = menuFor(rows(t).find((r) => r.id === 'model:rifle')!, ctx());
    expect(labels(m)).toEqual(['Open', 'Open in compare', '—', 'Unpin', 'Show', 'Unsolo', '—', 'Show in graph', 'Add review note…', '—', 'Copy name', 'Copy link', '—', 'Select', 'Plan cleanup…']);
    item(m, 'copy-link').onselect();
  });
  it('Plan cleanup… takes the whole selection when the row is part of it', () => {
    const c = ctx({ selected: new Set(['canvas:spark', 'model:rifle']) });
    item(menuFor(row(tree, 'canvas:spark'), c), 'cleanup').onselect();
    expect(c.calls.planCleanup).toHaveBeenLastCalledWith(['canvas:spark', 'model:rifle']);
    item(menuFor(row(tree, 'canvas:flat'), c), 'cleanup').onselect();
    expect(c.calls.planCleanup).toHaveBeenLastCalledWith(['canvas:flat']);
  });
  it('model row: link uses the model hash', () => {
    const c = ctx();
    item(menuFor(row(tree, 'model:rifle'), c), 'copy-link').onselect();
    expect(c.calls.copy).toHaveBeenLastCalledWith('http://localhost:9/#model:rifle');
  });
  it('group row: no review note, no select / cleanup (groups are never selectable)', () => {
    const m = menuFor(row(tree, 'group:kit'), ctx());
    expect(labels(m)).toEqual(['Open', 'Open in compare', '—', 'Pin', 'Hide', 'Solo', '—', 'Show in graph', '—', 'Copy name', 'Copy link']);
    item(m, 'open').onselect();
  });
  it('export file row: no pin / hide / solo, no graph; copy name is the path', () => {
    const c = ctx();
    const m = menuFor(row(tree, 'export:dir/a.png'), c);
    expect(labels(m)).toEqual(['Open', 'Open in compare', '—', 'Add review note…', '—', 'Copy name', 'Copy link', '—', 'Select', 'Plan cleanup…']);
    item(m, 'copy-name').onselect();
    expect(c.calls.copy).toHaveBeenLastCalledWith('dir/a.png');
    item(m, 'copy-link').onselect();
    expect(c.calls.copy).toHaveBeenLastCalledWith('http://localhost:9/#export:dir%2Fa.png');
  });
  it('child rows (animation tag, layer, clip): open, compare, copy', () => {
    for (const id of ['anim:spark/spin', 'layer:spark/base', 'modelclip:rifle/fire']) {
      expect(labels(menuFor(row(tree, id), ctx()))).toEqual(['Open', 'Open in compare', '—', 'Copy name', 'Copy link']);
    }
    const c = ctx();
    item(menuFor(row(tree, 'anim:spark/spin'), c), 'compare').onselect();
    expect(c.calls.open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark', view: 'anim', tag: 'spin' }, 'B');
  });
  it('sections, notes and folder rows have no menu', () => {
    expect(menuFor(sections(tree)[0], ctx())).toBeNull();
    expect(menuFor({ type: 'note', key: 'n', section: 'canvases', text: 'x', depth: 0 }, ctx())).toBeNull();
    expect(menuFor(row(tree, 'dir:dir'), ctx())).toBeNull();
  });
});

describe('drag', () => {
  class FakeDT {
    data = new Map<string, string>();
    effectAllowed = 'all';
    get types() { return [...this.data.keys()]; }
    setData(t: string, v: string) { this.data.set(t, v); }
    getData(t: string) { return this.data.get(t) ?? ''; }
  }
  const ev = (dt: FakeDT | null) => ({ dataTransfer: dt }) as unknown as DragEvent;

  it('round-trips a target with the custom type and the name as text', () => {
    const dt = new FakeDT();
    setDragTarget(ev(dt), { kind: 'model', name: 'rifle' }, 'rifle');
    expect(dt.types).toEqual([DRAG_TYPE, 'text/plain']);
    expect(dt.getData('text/plain')).toBe('rifle');
    expect(dt.effectAllowed).toBe('copy');
    expect(hasDragTarget(ev(dt))).toBe(true);
    expect(readDragTarget(ev(dt))).toEqual({ kind: 'model', name: 'rifle' });
  });
  it('ignores drags without the type (files, text) and bad payloads', () => {
    const dt = new FakeDT();
    dt.setData('text/plain', 'hello');
    expect(hasDragTarget(ev(dt))).toBe(false);
    expect(readDragTarget(ev(dt))).toBeNull();
    expect(readDragTarget(ev(null))).toBeNull();
    expect(parseDragTarget('{')).toBeNull();
    expect(parseDragTarget('{"kind":"evil","name":"x"}')).toBeNull();
    expect(parseDragTarget('{"kind":"canvas"}')).toBeNull();
    expect(parseDragTarget('{"kind":"graph","focus":"group:kit"}')).toEqual({ kind: 'graph', focus: 'group:kit' });
  });
});
