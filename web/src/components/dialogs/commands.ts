// Command palette items and search (step 18b), pure: no store is read here. The shell builds a
// PaletteContext from the stores and injects how a target opens and how an action runs, so these
// functions are unit-tested without a DOM or app globals.
//
// Assets: every canvas, rig, model, audio, project, group and export that passes the hidden / solo
// filter. Actions: one item per SHORTCUTS row with an `action` that applies in the context (plus the
// paint tools on the canvas editor), the actions that have no key, and the model shading modes and
// view presets while a 3D model is in slot A. Search: fuzzysort over the label (assets also over the
// meta line); prepared targets are cached per item object, so an asset list built once per
// `assets.rev` is prepared once.
import fuzzysort, { type Prepared } from 'fuzzysort';
import type { AssetIndex } from '@/lib/api/types';
import { targetToHash } from '@/lib/util/hash';
import { KIND_LABEL } from '@/lib/util/kinds';
import { currentTab, tabsFor, targetFor, viewerKindFor, type TabId } from '@/lib/util/targets';
import { SHORTCUTS, type ActionId } from '@/state/shortcuts';
import type { CleanupTab } from '@/state/dialogs.svelte';
import type { SlotId, Target, Tool } from '@/viewers/types';
import { MODES, MODE_LABELS, type ShadingMode } from '@/viewers/model/shading';
import { VIEW_LABELS, VIEW_PRESETS, type ViewPreset } from '@/viewers/model/views';

export type PaletteGroup = 'Recent' | 'Actions' | 'Assets';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  meta?: string;
  kind?: string;
  shortcut?: string;
  /** Matched character indexes in `label` (search results only). */
  highlight?: number[];
  /** The URL hash of the target this item opens (assets, and the asset graph action): matched against `workspace.recent`. */
  hash?: string;
  run(opts: { compare: boolean }): void;
}

/**
 * What the palette needs to know about the app. Maps onto step 18's ShortcutContext:
 * `comparing`, `reviewMode`, `browserShown` are the same fields; `slotA` replaces `slotAKind` and
 * `snapOpen` (both are derived from it here: `viewerKindFor(slotA)`, `slotA.snap`); `index`,
 * `following`, `showHidden` and `soloCount` are extra (workspace / assets / prefs / uiState).
 */
export interface PaletteContext {
  slotA: Target | null;
  index: AssetIndex | null;
  comparing: boolean;
  following: boolean;
  reviewMode: boolean;
  browserShown: boolean;
  showHidden: boolean;
  soloCount: number;
}

/** What an action item asks the shell to do (the shell's `runAction` switches on `type`). */
export type PaletteAction =
  /** A SHORTCUTS action that needs no argument: follow, compare, review, filter, graph, overview, dock, help, and any later one. */
  | { type: 'shortcut'; action: ActionId }
  | { type: 'pane'; pane: 'browser' | 'side' }
  | { type: 'tab'; tab: TabId }
  | { type: 'undo'; redo: boolean }
  | { type: 'backToLive' }
  | { type: 'tool'; tool: Tool }
  | { type: 'newCanvas' }
  | { type: 'cleanup'; tab: CleanupTab }
  | { type: 'reviewList' }
  | { type: 'clearSolo' }
  | { type: 'showHidden'; on: boolean }
  | { type: 'shading'; mode: ShadingMode }
  | { type: 'view'; preset: ViewPreset };

export type OpenTarget = (target: Target, slot: SlotId) => void;
export type RunAction = (action: PaletteAction) => void;

export const RECENT_SHOWN = 8;
const TOOLS: readonly Tool[] = ['pencil', 'eraser', 'fill', 'line', 'rect', 'picker', 'hand'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const isSnap = (t: Target | null): boolean => !!t && 'snap' in t && !!t.snap;

// ---------------------------------------------------------------- assets

/** Every asset of the index that `visible(id)` lets through; `open` is called with slot B for compare. */
export function assetItems(index: AssetIndex | null, visible: (id: string) => boolean, open: OpenTarget): PaletteItem[] {
  if (!index) return [];
  const out: PaletteItem[] = [];
  const add = (kind: string, name: string, project?: string | null) => {
    const id = `${kind}:${name}`;
    if (!visible(id)) return;
    const target = targetFor(kind, name, index);
    // groups open the graph focused on them: their hash is 'graph', which is the graph's own recent entry
    const hash = kind === 'group' ? undefined : targetToHash(target) ?? undefined;
    out.push({
      id, group: 'Assets', label: name, kind, hash,
      meta: (KIND_LABEL[kind] ?? kind) + (project ? ` · ${project}` : ''),
      run: ({ compare }) => open(target, compare ? 'B' : 'A'),
    });
  };
  for (const c of index.canvases) add('canvas', c.name, c.project);
  for (const r of index.rigs) add('rig', r.name, r.project);
  for (const m of index.models) add('model', m.name, m.project);
  for (const a of index.audio) add('audio', a.name);
  for (const p of index.projects) add('project', p.name);
  for (const g of index.groups) add('group', g.name);
  for (const e of index.exports) add('export', e.path);
  return out;
}

// ---------------------------------------------------------------- actions

/** The actions that apply in `ctx`, in SHORTCUTS order, then the ones without a key. */
export function actionItems(ctx: PaletteContext, run: RunAction): PaletteItem[] {
  const out: PaletteItem[] = [];
  const add = (key: string, label: string, action: PaletteAction, extra: Partial<PaletteItem> = {}) =>
    out.push({ id: `action:${key}`, group: 'Actions', label, ...extra, run: () => run(action) });
  const onOff = (on: boolean) => (on ? 'on' : 'off');

  const t = ctx.slotA;
  const vk = viewerKindFor(t);
  const snap = isSnap(t);
  const editor = vk === 'canvas' && !snap;
  const canvas = t?.kind === 'canvas' && !snap ? ctx.index?.canvases.find((c) => c.name === t.name) : undefined;

  for (const row of SHORTCUTS) {
    if (row.id.startsWith('tool-')) {
      const tool = row.id.slice(5) as Tool;
      if (editor && TOOLS.includes(tool)) add(row.id, `Tool: ${row.label}`, { type: 'tool', tool }, { shortcut: row.keys });
      continue;
    }
    const a = row.action;
    if (!a) continue;
    switch (a) {
      case 'tabs': {
        const cur = currentTab(t);
        tabsFor(t, ctx.index).forEach((tab, i) => {
          if (tab.id !== cur) add(`tab-${tab.id}`, `Tab: ${tab.label}`, { type: 'tab', tab: tab.id }, i < 5 ? { shortcut: String(i + 1) } : {});
        });
        break;
      }
      case 'panes':
        add('pane-browser', 'Toggle assets pane', { type: 'pane', pane: 'browser' }, { shortcut: '[' });
        add('pane-side', 'Toggle side pane', { type: 'pane', pane: 'side' }, { shortcut: ']' });
        break;
      case 'undo':
        if (editor) {
          add('undo', 'Undo', { type: 'undo', redo: false }, { shortcut: 'Ctrl+Z' });
          add('redo', 'Redo', { type: 'undo', redo: true }, { shortcut: 'Ctrl+Y' });
        }
        break;
      case 'escape':
        if (snap) add('back-to-live', 'Back to live', { type: 'backToLive' }, { shortcut: row.keys });
        break;
      case 'palette':
        break; // the palette itself (Ctrl+K) is not one of its own items
      case 'help':
        add(row.id, 'Help: keyboard shortcuts', { type: 'shortcut', action: a }, { shortcut: row.keys });
        break;
      case 'overview':
        if (canvas?.project) add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys, meta: canvas.project });
        break;
      case 'filter':
        if (ctx.browserShown) add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys });
        break;
      case 'graph':
        add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys, kind: 'graph', hash: 'graph' });
        break;
      case 'follow':
        add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys, meta: onOff(ctx.following) });
        break;
      case 'compare':
        add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys, meta: onOff(ctx.comparing) });
        break;
      case 'review':
        add(row.id, cap(row.label), { type: 'shortcut', action: a }, { shortcut: row.keys, meta: onOff(ctx.reviewMode) });
        break;
      default:
        add(row.id, cap(row.label), { type: 'shortcut', action: a }, row.keys ? { shortcut: row.keys } : {});
    }
  }

  add('new-canvas', 'New canvas…', { type: 'newCanvas' });
  add('cleanup-trash', 'Cleanup: Trash', { type: 'cleanup', tab: 'trash' });
  add('cleanup-usage', 'Cleanup: Disk usage', { type: 'cleanup', tab: 'usage' });
  add('cleanup-settings', 'Cleanup: Settings', { type: 'cleanup', tab: 'settings' });
  add('review-list', 'Review notes', { type: 'reviewList' });
  if (ctx.soloCount > 0) add('clear-solo', 'Clear solo', { type: 'clearSolo' }, { meta: `${ctx.soloCount} solo` });
  if (ctx.showHidden) add('show-hidden', 'Stop showing hidden assets', { type: 'showHidden', on: false });
  else add('show-hidden', 'Show hidden assets', { type: 'showHidden', on: true });

  if (vk === 'model') {
    for (const mode of MODES) add(`shading-${mode}`, `Shading: ${MODE_LABELS[mode]}`, { type: 'shading', mode });
    for (const preset of VIEW_PRESETS) add(`view-${preset}`, `View: ${VIEW_LABELS[preset]}`, { type: 'view', preset });
  }
  return out;
}

// ---------------------------------------------------------------- search

interface Prep { label: Prepared; meta: Prepared | null }
const prepared = new WeakMap<PaletteItem, Prep>();
function prep(item: PaletteItem): Prep {
  let p = prepared.get(item);
  if (!p) {
    p = { label: fuzzysort.prepare(item.label), meta: item.meta ? fuzzysort.prepare(item.meta) : null };
    prepared.set(item, p);
  }
  return p;
}

/**
 * Within 10 % of the best asset score, the Actions block comes first. fuzzysort 4's default
 * threshold (.5) drops sparse subsequences such as `hlmfr` -> `helmet_front`; 0 keeps every match.
 */
export const ACTIONS_FIRST_RATIO = 0.9;
export const THRESHOLD = 0;

/** The Recent items: the asset (or graph) items whose hash is in `recent`, newest first, at most 8. */
export function recentItems(items: PaletteItem[], recent: readonly string[]): PaletteItem[] {
  const byHash = new Map<string, PaletteItem>();
  for (const it of items) if (it.hash && !byHash.has(it.hash)) byHash.set(it.hash, it);
  const out: PaletteItem[] = [];
  for (const h of recent) {
    const it = byHash.get(h);
    if (it) out.push({ ...it, id: `recent:${it.id}`, group: 'Recent', highlight: undefined });
    if (out.length >= RECENT_SHOWN) break;
  }
  return out;
}

export function search(query: string, items: PaletteItem[], recent: readonly string[], limit = 50): PaletteItem[] {
  const q = query.trim();
  if (!q) return [...recentItems(items, recent), ...items.filter((i) => i.group === 'Actions')].slice(0, limit);

  const actions = items.filter((i) => i.group === 'Actions');
  const assetList = items.filter((i) => i.group === 'Assets');
  const ra = fuzzysort.go(q, actions, { key: (i: PaletteItem) => prep(i).label, limit, threshold: THRESHOLD });
  const rs = fuzzysort.go(q, assetList, { keys: [(i: PaletteItem) => prep(i).label, (i: PaletteItem) => prep(i).meta], limit, threshold: THRESHOLD });

  const A = ra.map((r) => ({ ...r.obj, highlight: [...r.indexes] }));
  const S = rs.map((r) => ({ ...r.obj, highlight: r[0] ? [...r[0].indexes] : [] }));
  const actionsFirst = ra.length > 0 && (rs.length === 0 || ra[0].score >= rs[0].score * ACTIONS_FIRST_RATIO);
  return (actionsFirst ? [...A, ...S] : [...S, ...A]).slice(0, limit);
}

/** Label split into plain and matched runs for rendering (`<mark>` around matched characters). */
export function segments(label: string, highlight: readonly number[] | undefined): { text: string; hit: boolean }[] {
  if (!highlight?.length) return [{ text: label, hit: false }];
  const hits = new Set(highlight);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = hits.has(i);
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += label[i]; else out.push({ text: label[i], hit });
  }
  return out;
}
