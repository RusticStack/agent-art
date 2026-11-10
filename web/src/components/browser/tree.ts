// Asset browser tree (pure): the flat list of section headers, rows and notes in display order
// (plan 1.4 B4-B16, all caps and texts), range selection on that list (B21) and the row context menu
// (Review 2, RV2). The component renders the list through VirtualList; nothing here touches the DOM.
import type { AssetIndex, CanvasSummary, GroupSummary } from '@/lib/api/types';
import { canvasPng, exportFile, thumbUrl } from '@/lib/api/urls';
import { fmtBytes } from '@/lib/util/format';
import { targetToHash } from '@/lib/util/hash';
import { assetId, splitId } from '@/lib/util/ids';
import { switchViewTarget, tabsFor, targetFor } from '@/lib/util/targets';
import type { MenuItem } from '@/components/ui/menu';
import type { ReviewDraft, SlotId, Target } from '@/viewers/types';

export type SectionKey = 'pinned' | 'groups' | 'projects' | 'canvases' | 'rigs' | 'models' | 'audio' | 'exports';
export const SECTIONS: readonly (readonly [SectionKey, string])[] = [
  ['pinned', 'Pinned'], ['groups', 'Groups'], ['projects', 'Projects'], ['canvases', 'Canvases'],
  ['rigs', 'Rigs'], ['models', '3D models'], ['audio', 'Audio'], ['exports', 'Exports'],
];
/** Children of a project, files of an export folder. */
export const MAX_PER_GROUP = 400;
/** Loose canvases shown. */
export const MAX_LOOSE = MAX_PER_GROUP * 2;
/** Items (rows + notes, children included) listed per section. */
export const MAX_SECTION_ITEMS = 4000;
export const DEFAULT_COLLAPSED: readonly string[] = ['exports', 'groups'];

export const NO_MATCHES = 'no matches';
export const NO_CANVASES = 'No canvases yet. Ask the agent to draw something, or create one.';
export const moreText = (n: number): string => `+${n} more: open the project overview`;

export interface TreeInput {
  index: AssetIndex;
  hidden: ReadonlySet<string>;
  pinned: readonly string[];
  solo: ReadonlySet<string>;
  showHidden: boolean;
  /** raw filter text (trimmed and lower-cased here) */
  filter: string;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  selectMode: boolean;
  reviewCounts: Readonly<Record<string, number>>;
  approved: ReadonlySet<string>;
}

interface Aria { level: number; setsize: number; posinset: number }

export interface TreeSection extends Aria {
  type: 'section';
  /** unique item key ("section:<key>") */
  key: string;
  section: SectionKey;
  title: string;
  count: number;
  collapsed: boolean;
}

export interface TreeNote {
  type: 'note';
  key: string;
  section: SectionKey;
  text: string;
  depth: number;
}

export interface TreeRow extends Aria {
  type: 'row';
  /** unique item key: the same asset can be listed twice (Pinned + its own section, group members) */
  key: string;
  /** key of the parent item (a section or a row) */
  parent: string;
  section: SectionKey;
  id: string;
  kind: string;
  name: string;
  label: string;
  meta: string;
  thumb: string | null;
  depth: number;
  hasKids: boolean;
  expanded: boolean;
  badge: string | null;
  /** what a click opens; null = the row only toggles (export folders) */
  open: Target | null;
  /** hover actions (solo / pin / hide) */
  actions: boolean;
  /** has a checkbox (select mode only) */
  selectable: boolean;
  hidden: boolean;
  pinned: boolean;
  solo: boolean;
  reviews: number;
  approved: boolean;
  superseded: boolean;
  orphan: boolean;
}

export type TreeItem = TreeSection | TreeRow | TreeNote;

interface RowSpec {
  id: string; kind: string; name: string; label?: string; meta?: string; thumb?: string | null; depth?: number;
  kids?: ((parent: string) => TreeItem[]) | null; badge?: string | null; open?: Target | null; actions?: boolean; sel?: boolean;
}

const basename = (p: string): string => p.split('/').pop() ?? p;

/** B4-B16: the whole tree, flat, in display order. */
export function buildTree(input: TreeInput): TreeItem[] {
  const a = input.index;
  const filter = input.filter.trim().toLowerCase();
  const flags = { superseded: new Set(a.flags?.superseded ?? []), orphans: new Set(a.flags?.orphans ?? []) };
  const canvasesByName = new Map(a.canvases.map((c) => [c.name, c]));
  const out: TreeItem[] = [];
  const used = new Set<string>();
  let section: SectionKey = 'pinned';

  const uniq = (k: string): string => {
    let key = k, n = 1;
    while (used.has(key)) key = `${k}#${++n}`;
    used.add(key);
    return key;
  };
  const match = (...names: (string | null | undefined)[]): boolean => !filter || names.some((n) => !!n && n.toLowerCase().includes(filter));
  const visible = (id: string): boolean => {
    if (input.solo.size && !input.solo.has(id)) return false;
    return input.showHidden || !input.hidden.has(id);
  };
  const keep = (id: string, ...names: (string | null | undefined)[]): boolean => visible(id) && match(...names);
  const note = (text: string, depth = 0): TreeNote => ({ type: 'note', key: uniq(`note:${section}:${text}`), section, text, depth });

  const row = (s: RowSpec, parent: string): TreeItem[] => {
    const actions = s.actions ?? true;
    const sel = s.sel ?? actions;
    const key = uniq(`${parent}>${s.id}`);
    const hasKids = !!s.kids;
    const expanded = hasKids && (filter ? true : input.expanded.has(s.id));
    const r: TreeRow = {
      type: 'row', key, parent, section, id: s.id, kind: s.kind, name: s.name, label: s.label ?? s.name, meta: s.meta ?? '',
      thumb: s.thumb ?? null, depth: s.depth ?? 0, hasKids, expanded, badge: s.badge ?? null,
      open: s.open === undefined ? targetFor(s.kind, s.name, a) : s.open,
      actions, selectable: sel && s.kind !== 'group' && input.selectMode,
      hidden: input.hidden.has(s.id), pinned: input.pinned.includes(s.id), solo: input.solo.has(s.id),
      reviews: input.reviewCounts[s.id] ?? 0, approved: input.approved.has(s.id),
      superseded: flags.superseded.has(s.id), orphan: flags.orphans.has(s.id),
      level: 0, setsize: 0, posinset: 0,
    };
    const list: TreeItem[] = [r];
    if (expanded && s.kids) list.push(...s.kids(key));
    return list;
  };

  const canvasRow = (c: CanvasSummary, parent: string, depth = 0): TreeItem[] => {
    const meta = `${c.width}×${c.height}${c.frames > 1 ? ` ·${c.frames}f` : ''}${c.layers.length > 1 ? ` ·${c.layers.length}L` : ''}`;
    const kids = c.layers.length > 1 || c.animations.length ? (p: string) => [
      ...c.animations.flatMap((t) => row({ id: `anim:${c.name}/${t}`, kind: 'anim', name: t, depth: depth + 1, actions: false, open: { kind: 'canvas', name: c.name, view: 'anim', tag: t } }, p)),
      ...[...c.layers].reverse().flatMap((l) => row({ id: `layer:${c.name}/${l.name}`, kind: 'layer', name: l.name, meta: l.visible ? '' : 'hidden', depth: depth + 1, actions: false, open: { kind: 'canvas', name: c.name } }, p)),
    ] : null;
    return row({ id: assetId('canvas', c.name), kind: 'canvas', name: c.name, meta, thumb: canvasPng(c.name, { v: c.version }), depth, kids, open: { kind: 'canvas', name: c.name } }, parent);
  };

  const thumbOf = (kind: string, name: string): string | null => {
    if (kind === 'canvas') return thumbUrl(kind, name, canvasesByName.get(name)?.version);
    if (kind === 'rig') return thumbUrl(kind, name, a.rigs.find((x) => x.name === name)?.version);
    if (kind === 'model') return thumbUrl(kind, name, a.models.find((x) => x.name === name)?.updated);
    return null;
  };

  const addSection = (key: SectionKey, title: string, count: number, rows: (parent: string) => TreeItem[]): void => {
    if (!count && key !== 'canvases') return;
    section = key;
    const collapsed = input.collapsed.has(key) && !filter;
    const head: TreeSection = { type: 'section', key: uniq(`section:${key}`), section: key, title, count, collapsed, level: 1, setsize: 0, posinset: 0 };
    out.push(head);
    if (collapsed) return;
    const r = rows(head.key);
    if (!r.length && filter) out.push(note(NO_MATCHES));
    out.push(...r.slice(0, MAX_SECTION_ITEMS));
  };

  // B8 pinned (visibility only, the filter does not apply; canvases render as full canvas rows)
  const pinned = input.pinned.filter((id) => visible(id));
  addSection('pinned', 'Pinned', pinned.length, (p) => pinned.flatMap((id) => {
    const [kind, name] = splitId(id);
    const c = kind === 'canvas' ? canvasesByName.get(name) : undefined;
    if (c) return canvasRow(c, p);
    return row({ id, kind, name, thumb: thumbOf(kind, name) }, p);
  }));

  // B9 groups (asset graph): roots, nested groups recurse, members filtered; a missing sub-group is skipped
  const groupsByName = new Map(a.groups.map((g) => [g.name, g]));
  const groupRows = (g: GroupSummary, depth: number, parent: string, seen: ReadonlySet<string>): TreeItem[] => row({
    id: `group:${g.name}`, kind: 'group', name: g.name, meta: g.note || '', depth, badge: String(g.members.length), open: { kind: 'graph', focus: `group:${g.name}` },
    kids: (p) => g.members.flatMap((m) => {
      const [k, n] = splitId(m);
      if (k === 'group') {
        const sub = groupsByName.get(n);
        return sub && !seen.has(n) ? groupRows(sub, depth + 1, p, new Set([...seen, n])) : [];
      }
      if (!keep(m, n)) return [];
      const c = k === 'canvas' ? canvasesByName.get(n) : undefined;
      if (c) return canvasRow(c, p, depth + 1);
      return row({ id: m, kind: k, name: n, depth: depth + 1, thumb: k === 'model' || k === 'rig' ? thumbOf(k, n) : null }, p);
    }),
  }, parent);
  addSection('groups', 'Groups', a.groups.length, (p) => a.groups.filter((g) => !g.parent).flatMap((g) => groupRows(g, 0, p, new Set([g.name]))));

  // B10 projects: children are its canvases (capped); hidden when the filter matches neither
  addSection('projects', 'Projects', a.projects.length, (p) => a.projects.flatMap((pr) => {
    const items = a.canvases.filter((c) => c.project === pr.name && keep(assetId('canvas', c.name), c.name));
    if (filter && !items.length && !match(pr.name)) return [];
    if (!visible(`project:${pr.name}`)) return [];
    return row({
      id: `project:${pr.name}`, kind: 'project', name: pr.name, meta: pr.description || '', badge: String(items.length),
      kids: (k) => [...items.slice(0, MAX_PER_GROUP).flatMap((c) => canvasRow(c, k, 1)), ...(items.length > MAX_PER_GROUP ? [note(moreText(items.length - MAX_PER_GROUP), 1)] : [])],
    }, p);
  }));

  // B11 loose canvases (no project, not rig parts / rig outputs); the count is all loose canvases
  const loose = a.canvases.filter((c) => !c.project && c.kind !== 'rigparts' && c.kind !== 'rigout');
  const shown = loose.filter((c) => keep(assetId('canvas', c.name), c.name));
  addSection('canvases', 'Canvases', loose.length, (p) => [
    ...shown.slice(0, MAX_LOOSE).flatMap((c) => canvasRow(c, p)),
    ...(!a.canvases.length ? [note(NO_CANVASES)] : []),
  ]);

  // B13 rigs: the filter also matches output canvas names
  addSection('rigs', 'Rigs', a.rigs.length, (p) => a.rigs.filter((r) => keep(`rig:${r.name}`, r.name, ...r.outputs)).flatMap((r) => row({
    id: `rig:${r.name}`, kind: 'rig', name: r.name, meta: `${r.frame?.join('×')} · ${r.views?.length} views`, thumb: thumbUrl('rig', r.name, r.version),
    kids: (k) => {
      const parts = canvasesByName.get(r.canvas);
      return [
        ...(parts ? canvasRow(parts, k, 1) : []),
        ...r.outputs.flatMap((o) => { const c = canvasesByName.get(o); return c ? canvasRow(c, k, 1) : []; }),
        ...r.poses.flatMap((ps) => row({ id: `rigpose:${r.name}/${ps}`, kind: 'rigpart', name: `pose ${ps}`, depth: 1, actions: false, open: { kind: 'rig', name: r.name, mode: 'pose' } }, k)),
      ];
    },
  }, p)));

  // B14 3D models: clips, then named parts
  addSection('models', '3D models', a.models.length, (p) => a.models.filter((m) => keep(`model:${m.name}`, m.name)).flatMap((m) => row({
    id: `model:${m.name}`, kind: 'model', name: m.name, meta: `${m.parts} parts${m.clips.length ? ` · ${m.clips.length} clips` : ''}`, thumb: thumbUrl('model', m.name, m.updated),
    kids: m.named.length || m.clips.length ? (k) => [
      ...m.clips.flatMap((c) => row({ id: `modelclip:${m.name}/${c}`, kind: 'anim', name: c, meta: 'clip', depth: 1, actions: false, open: { kind: 'model', name: m.name, clip: c } }, k)),
      ...m.named.flatMap((n) => row({ id: `modelpart:${m.name}/${n}`, kind: 'modelpart', name: n, depth: 1, actions: false, open: { kind: 'model', name: m.name } }, k)),
    ] : null,
  }, p)));

  // B15 audio: the filter also matches the recipe
  addSection('audio', 'Audio', a.audio.length, (p) => a.audio.filter((s) => keep(`audio:${s.name}`, s.name, s.recipe)).flatMap((s) => row({
    id: `audio:${s.name}`, kind: 'audio', name: s.name,
    meta: [s.kind, s.duration !== undefined ? `${(+s.duration).toFixed(2)}s` : '', s.lufs !== undefined ? `${s.lufs} LUFS` : ''].filter(Boolean).join(' · '),
  }, p)));

  // B16 exports: sorted by path, grouped by folder (folder rows only toggle), capped per folder
  addSection('exports', 'Exports', a.exports.length, (p) => {
    const files = a.exports.filter((f) => keep(`export:${f.path}`, f.path)).sort((x, y) => x.path.localeCompare(y.path));
    const dirs = new Map<string, typeof files>();
    for (const f of files) {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const list = dirs.get(d);
      if (list) list.push(f); else dirs.set(d, [f]);
    }
    const rows: TreeItem[] = [];
    for (const [d, list] of dirs) {
      const fileRows = (k: string) => list.slice(0, MAX_PER_GROUP).flatMap((f) => row({
        id: `export:${f.path}`, kind: 'export', name: basename(f.path), meta: fmtBytes(f.size), depth: d ? 1 : 0, actions: false, sel: true,
        thumb: /\.(png|gif)$/i.test(f.path) ? exportFile(f.path, { m: f.mtime }) : null, open: { kind: 'export', name: f.path },
      }, k));
      if (d) rows.push(...row({ id: `dir:${d}`, kind: 'file', name: d + '/', badge: String(list.length), actions: false, kids: fileRows, open: null }, p));
      else rows.push(...fileRows(p));
    }
    return rows;
  });

  return withAria(out);
}

/** aria-level / aria-setsize / aria-posinset of every section and row (siblings share a parent key). */
function withAria(items: TreeItem[]): TreeItem[] {
  const groups = new Map<string, Aria[]>();
  const levels = new Map<string, number>();
  for (const it of items) {
    if (it.type === 'note') continue;
    const parent = it.type === 'section' ? '' : it.parent;
    it.level = it.type === 'section' ? 1 : (levels.get(parent) ?? 1) + 1;
    levels.set(it.key, it.level);
    const g = groups.get(parent);
    if (g) g.push(it); else groups.set(parent, [it]);
  }
  for (const g of groups.values()) g.forEach((it, i) => { it.setsize = g.length; it.posinset = i + 1; });
  return items;
}

const isSelectableRow = (it: TreeItem): it is TreeRow => it.type === 'row' && it.selectable;

/** Ids of the selectable rows, in display order (duplicates kept: the first one counts). */
export const selectableIds = (items: readonly TreeItem[]): string[] => items.filter(isSelectableRow).map((r) => r.id);

/**
 * B21 click / Shift+click on a selectable row. With `lastId` (the last toggled row) and both rows in
 * the list: every row between them (inclusive) is selected, or deselected when `id` is selected and
 * `lastId` is not. Otherwise `id` alone toggles. Returns a new set.
 */
export function rangeSelect(items: readonly TreeItem[], lastId: string | null, id: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const ids = selectableIds(items);
  const ia = lastId === null ? -1 : ids.indexOf(lastId), ib = ids.indexOf(id);
  if (lastId !== null && ia >= 0 && ib >= 0) {
    const [from, to] = ia < ib ? [ia, ib] : [ib, ia];
    const on = !selected.has(id) || selected.has(lastId);
    for (const x of ids.slice(from, to + 1)) { if (on) next.add(x); else next.delete(x); }
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** What the row context menu calls: the same store methods as the row buttons and keys. */
export interface MenuContext {
  index: AssetIndex | null;
  selected: ReadonlySet<string>;
  /** location.origin + location.pathname (Copy link) */
  base: string;
  open(target: Target, slot: SlotId): void;
  togglePinned(id: string): void;
  toggleHidden(id: string): void;
  toggleSolo(id: string): void;
  reviewNote(draft: ReviewDraft): void;
  copy(text: string): void;
  /** enter select mode with this id checked */
  select(id: string): void;
  planCleanup(ids: string[]): void;
}

const REVIEWABLE = new Set(['canvas', 'rig', 'model', 'audio', 'project', 'export']);
const VIEW_TABS = new Set(['anim', 'sheet', 'layers']);

/** Drop leading, trailing and doubled separators. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const m of items) {
    const sep = 'separator' in m;
    if (sep && (!out.length || 'separator' in out[out.length - 1])) continue;
    out.push(m);
  }
  while (out.length && 'separator' in out[out.length - 1]) out.pop();
  return out;
}

/**
 * RV2: the context menu of a tree item. Asset rows (hover actions) get the full menu; export files get
 * the menu without pin / hide / solo; child rows (layers, animation tags, poses, clips, model parts)
 * get open / compare / copy; sections, notes and export folders get none (the browser's own menu stays).
 */
export function menuFor(item: TreeItem, ctx: MenuContext): MenuItem[] | null {
  if (item.type !== 'row' || !item.open) return null;
  const row = item;
  const open = row.open;
  if (!open) return null;
  const asset = row.actions || row.kind === 'export';
  const sep = (id: string): MenuItem => ({ separator: true, id: `sep-${id}` });
  const items: MenuItem[] = [
    { id: 'open', label: 'Open', onselect: () => ctx.open(open, 'A') },
    { id: 'compare', label: 'Open in compare', icon: 'columns-2', onselect: () => ctx.open(open, 'B') },
  ];
  if (row.kind === 'canvas' && asset) {
    const t: Target = { kind: 'canvas', name: row.name };
    for (const tab of tabsFor(t, ctx.index)) {
      if (!VIEW_TABS.has(tab.id)) continue;
      const vt = switchViewTarget(t, tab.id, ctx.index);
      if (vt) items.push({ id: `view-${tab.id}`, label: tab.label, onselect: () => ctx.open(vt, 'A') });
    }
  }
  if (row.actions) {
    items.push(sep('state'),
      { id: 'pin', label: row.pinned ? 'Unpin' : 'Pin', icon: 'star', onselect: () => ctx.togglePinned(row.id) },
      { id: 'hide', label: row.hidden ? 'Show' : 'Hide', icon: row.hidden ? 'eye' : 'eye-off', onselect: () => ctx.toggleHidden(row.id) },
      { id: 'solo', label: row.solo ? 'Unsolo' : 'Solo', icon: 'scan-eye', onselect: () => ctx.toggleSolo(row.id) });
  }
  if (asset) {
    items.push(sep('graph'));
    if (row.actions) items.push({ id: 'graph', label: 'Show in graph', icon: 'waypoints', onselect: () => ctx.open({ kind: 'graph', focus: row.id }, 'A') });
    if (REVIEWABLE.has(row.kind)) items.push({ id: 'review', label: 'Add review note…', icon: 'flag', onselect: () => ctx.reviewNote({ asset: row.id }) });
  }
  const copyName = asset ? splitId(row.id)[1] : row.name;
  const hash = targetToHash(open);
  items.push(sep('copy'), { id: 'copy-name', label: 'Copy name', icon: 'copy', onselect: () => ctx.copy(copyName) });
  if (hash !== null) items.push({ id: 'copy-link', label: 'Copy link', icon: 'copy', onselect: () => ctx.copy(`${ctx.base}#${hash}`) });
  if (asset && row.kind !== 'group') {
    const ids = ctx.selected.has(row.id) ? [...ctx.selected] : [row.id];
    items.push(sep('select'),
      { id: 'select', label: 'Select', icon: 'square-check', onselect: () => ctx.select(row.id) },
      { id: 'cleanup', label: 'Plan cleanup…', icon: 'trash-2', onselect: () => ctx.planCleanup(ids) });
  }
  return tidy(items);
}
