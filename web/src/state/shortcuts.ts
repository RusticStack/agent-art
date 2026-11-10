// The one shortcut table (4.4) and the global key handler. Help renders the table; the tooltips' <kbd>
// hints and the command palette read it. decide() is the pure decision (K1–K10 in order, plus the 4.4
// rule for Space / Enter on interactive elements and the narrow drawer Esc); install() adds the single
// window keydown listener and hands the decided action to the shell's runner (state/actions.ts).
//
// `keys` syntax: space-separated groups; inside a group `+`, `/` and `–` join keys (`Ctrl+Z/Y`, `1–5`);
// a group that is only `+` or `/` is the key itself. An empty `keys` is a pointer gesture written out in
// the label. `label` of every legacy row is the legacy help text verbatim.
import type { Tool, ViewerKind } from '@/viewers/types';

export type ShortcutGroup = 'Everywhere' | 'Canvas' | 'Players' | '3D view' | 'Graph';
export type ActionId =
  | 'follow' | 'compare' | 'review' | 'filter' | 'graph' | 'overview' | 'dock' | 'panes' | 'tabs' | 'escape' | 'help'
  | 'undo';
export interface Shortcut {
  id: string;
  keys: string;
  label: string;
  group: ShortcutGroup;
  action?: ActionId;
  /** Not in the legacy help (added by this rewrite). */
  isNew?: boolean;
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Everywhere', 'Canvas', 'Players', '3D view', 'Graph'];

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'follow', keys: 'F', label: 'follow the agent', group: 'Everywhere', action: 'follow' },
  { id: 'compare', keys: 'C', label: 'compare', group: 'Everywhere', action: 'compare' },
  { id: 'review', keys: 'M', label: 'review mode', group: 'Everywhere', action: 'review' },
  { id: 'filter', keys: '/', label: 'filter assets', group: 'Everywhere', action: 'filter' },
  { id: 'graph', keys: 'Shift+G', label: 'asset graph', group: 'Everywhere', action: 'graph' },
  { id: 'overview', keys: 'O', label: 'project overview', group: 'Everywhere', action: 'overview' },
  { id: 'dock', keys: 'P', label: 'timeline right / bottom', group: 'Everywhere', action: 'dock' },
  { id: 'panes', keys: '[ ]', label: 'side panes', group: 'Everywhere', action: 'panes' },
  { id: 'tabs', keys: '1–5', label: 'viewer tabs', group: 'Everywhere', action: 'tabs' },
  { id: 'escape', keys: 'Esc', label: 'back to live / close', group: 'Everywhere', action: 'escape' },
  { id: 'help', keys: '?', label: 'this help', group: 'Everywhere', action: 'help' },

  { id: 'tool-pencil', keys: 'B', label: 'pencil', group: 'Canvas' },
  { id: 'tool-eraser', keys: 'E', label: 'eraser', group: 'Canvas' },
  { id: 'tool-fill', keys: 'G', label: 'fill', group: 'Canvas' },
  { id: 'tool-line', keys: 'L', label: 'line', group: 'Canvas' },
  { id: 'tool-rect', keys: 'R', label: 'rectangle (Shift = filled)', group: 'Canvas' },
  { id: 'tool-picker', keys: 'I', label: 'pick', group: 'Canvas' },
  { id: 'tool-hand', keys: 'H', label: 'pan', group: 'Canvas' },
  { id: 'undo', keys: 'Ctrl+Z/Y', label: 'undo/redo', group: 'Canvas', action: 'undo' },
  { id: 'canvas-wheel', keys: '', label: 'Wheel = zoom at cursor', group: 'Canvas' },
  { id: 'canvas-pan', keys: '', label: 'Space/middle drag = pan', group: 'Canvas' },
  { id: 'canvas-zoom', keys: '+ - 0', label: 'zoom/fit', group: 'Canvas' },
  { id: 'canvas-grid', keys: '#', label: 'grid', group: 'Canvas' },
  { id: 'canvas-tile', keys: 'T', label: 'tile 3×3', group: 'Canvas' },
  { id: 'canvas-frames', keys: ', .', label: 'frames', group: 'Canvas' },
  { id: 'canvas-onion', keys: 'N', label: 'onion skin', group: 'Canvas' },
  { id: 'compare-overlay', keys: 'D', label: 'compare overlay: off / difference / swipe / blink (two canvases side by side)', group: 'Canvas', isNew: true },
  { id: 'compare-blink', keys: 'X', label: 'swap the blink image', group: 'Canvas', isNew: true },

  { id: 'play', keys: 'Space', label: 'play / pause (animation, rig clip, 3D clip, audio)', group: 'Players' },
  { id: 'wireframe', keys: 'W', label: 'wireframe (3D)', group: 'Players' },
  { id: 'reset-view', keys: '0', label: 'reset view', group: 'Players' },

  { id: 'model-orbit', keys: 'Arrows', label: 'orbit (3D view focused)', group: '3D view', isNew: true },
  { id: 'model-dolly', keys: '+ -', label: 'dolly (3D view focused)', group: '3D view', isNew: true },

  { id: 'graph-fit', keys: '0', label: 'fit', group: 'Graph', isNew: true },
  { id: 'graph-pan', keys: 'Arrows', label: 'pan (graph focused)', group: 'Graph', isNew: true },
  { id: 'graph-zoom', keys: '+ -', label: 'zoom (graph focused)', group: 'Graph', isNew: true },
];

/** Footnotes of the legacy help, verbatim: one under "Everywhere", one under the grid. */
export const HELP_GROUP_NOTES: Partial<Record<ShortcutGroup, string>> = {
  Everywhere: 'Alt/Shift+click an asset = open it in the comparison pane.',
};
export const HELP_FOOTER = 'Your edits use the same API as the agent, so it sees them. Hidden / pinned assets are saved per workspace.';

export type KeyToken = { k: 'key' | 'sep' | 'space'; v: string };

/** Split a `keys` string into keys, joiners and spaces (see the syntax note at the top). */
export function keyTokens(keys: string): KeyToken[] {
  const out: KeyToken[] = [];
  keys.split(' ').filter(Boolean).forEach((g, gi) => {
    if (gi) out.push({ k: 'space', v: ' ' });
    if (g === '+' || g === '/') { out.push({ k: 'key', v: g }); return; }
    for (const part of g.split(/([+/–])/)) if (part) out.push({ k: /^[+/–]$/.test(part) ? 'sep' : 'key', v: part });
  });
  return out;
}

export const shortcutById = (id: string): Shortcut | undefined => SHORTCUTS.find((s) => s.id === id);

// ---------------------------------------------------------------------------------------------------
// Global key handler (K1–K10)

/** What decide() reads from a keyboard event. */
export interface KeyEventLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** The app state decide() needs; built by the shell for every key press. */
export interface ShortcutContext {
  /** focus is in input / textarea / select / contenteditable (K1) */
  inText: boolean;
  /** the event target is a button, link, tab, tree item, menu item or summary (4.4) */
  onInteractive: boolean;
  /** a dialog other than Help is open (K2) */
  dialogBlocking: boolean;
  helpOpen: boolean;
  reviewMode: boolean;
  comparing: boolean;
  /** slot A shows a snapshot */
  snapOpen: boolean;
  /** a narrow-layout drawer is open */
  drawerOpen: boolean;
  /** a pixel canvas has focus (K6) */
  pixelCanvasFocused: boolean;
  slotAKind: ViewerKind | null;
  /** the asset browser is on screen (`/`) */
  browserShown: boolean;
  /** number of viewer tabs of slot A (`1`–`5`); unknown = 5 */
  tabCount?: number;
}

export type Action =
  | { type: 'blur' }
  | { type: 'undo'; redo: boolean }
  | { type: 'closeDrawer' } | { type: 'reviewOff' } | { type: 'closeHelp' } | { type: 'closeCompare' } | { type: 'backToLive' }
  | { type: 'graph' }
  | { type: 'tool'; tool: Tool }
  | { type: 'follow' } | { type: 'compare' } | { type: 'review' } | { type: 'filter' } | { type: 'help' } | { type: 'dock' }
  | { type: 'pane'; which: 'browser' | 'side' }
  | { type: 'overview' }
  | { type: 'tab'; index: number }
  /** K7: offer the key to the slot A viewer; when it does not take it, run `fallback` (K8–K10). */
  | { type: 'viewer'; key: string; fallback: Action | null };

export interface Decision { action: Action; preventDefault?: boolean }

/** Paint tool keys (K9), the same letters CanvasViewer uses. */
export const TOOL_KEY_MAP: Readonly<Record<string, Tool>> = { b: 'pencil', e: 'eraser', g: 'fill', l: 'line', r: 'rect', i: 'picker', h: 'hand' };

/** The key as viewers get it: lower-cased single characters, else e.key. */
export const normKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/** K8–K10: the shell's own keys, after the slot A viewer declined. */
function shellKey(e: KeyEventLike, k: string, ctx: ShortcutContext): Decision | null {
  if (e.shiftKey && k === 'g') return { action: { type: 'graph' } };
  if (ctx.slotAKind === 'canvas' && TOOL_KEY_MAP[k]) return { action: { type: 'tool', tool: TOOL_KEY_MAP[k] } };
  switch (k) {
    case 'f': return { action: { type: 'follow' } };
    case 'c': return { action: { type: 'compare' } };
    case 'm': return { action: { type: 'review' } };
    // legacy: `/` never types into the page; it focuses the filter only while the browser is shown
    case '/': return ctx.browserShown ? { action: { type: 'filter' }, preventDefault: true } : null;
    case '?': return { action: { type: 'help' } };
    case 'p': return { action: { type: 'dock' } };
    case '[': return { action: { type: 'pane', which: 'browser' } };
    case ']': return { action: { type: 'pane', which: 'side' } };
    case 'o': return { action: { type: 'overview' } };
    default: break;
  }
  if (/^[1-5]$/.test(k)) {
    const i = Number(k) - 1;
    return i < (ctx.tabCount ?? 5) ? { action: { type: 'tab', index: i } } : null;
  }
  return null;
}

/** K1–K10 in order (plan 1.10) plus the 4.4 rules. null = the shell does nothing with this key. */
export function decide(e: KeyEventLike, ctx: ShortcutContext): Decision | null {
  // K1: typing in a field: only Esc acts (blurs it)
  if (ctx.inText) return e.key === 'Escape' ? { action: { type: 'blur' } } : null;
  // K2: a dialog other than Help is open: it handles its own keys (Esc closes it)
  if (ctx.dialogBlocking) return null;
  const k = normKey(e.key);
  const mod = e.ctrlKey || e.metaKey;
  // K3: undo / redo of the slot A viewer
  if (mod && k === 'z') return { action: { type: 'undo', redo: e.shiftKey }, preventDefault: true };
  if (mod && k === 'y') return { action: { type: 'undo', redo: true }, preventDefault: true };
  // K4: any other modifier combination is not ours
  if (mod || e.altKey) return null;
  // 4.4: Space / Enter on a button, link, tab, tree item, menu item or summary belong to that element
  if (ctx.onInteractive && (e.key === ' ' || e.key === 'Enter')) return null;
  // K5: Esc, first match wins (the narrow drawer first, 2.6)
  if (e.key === 'Escape') {
    if (ctx.drawerOpen) return { action: { type: 'closeDrawer' } };
    if (ctx.reviewMode) return { action: { type: 'reviewOff' } };
    if (ctx.helpOpen) return { action: { type: 'closeHelp' } };
    if (ctx.comparing) return { action: { type: 'closeCompare' } };
    if (ctx.snapOpen) return { action: { type: 'backToLive' } };
    return null;
  }
  // K6: Space on a focused pixel canvas is the canvas's (hold-space panning)
  if (e.key === ' ' && ctx.pixelCanvasFocused) return null;
  // K7: the slot A viewer next, then K8–K10
  const fallback = shellKey(e, k, ctx);
  return { action: { type: 'viewer', key: k, fallback: fallback?.action ?? null }, preventDefault: fallback?.preventDefault };
}

/** Is this element one whose Space / Enter must not trigger a global shortcut (4.4)? */
export function isInteractive(el: Element | null): boolean {
  return !!el?.closest?.('button, a[href], summary, [role=button], [role=tab], [role=treeitem], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]');
}
/** Is focus in a text field (K1)? */
export function isTextTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

export interface ShortcutRunner {
  context(e: KeyboardEvent): ShortcutContext;
  /** Run an action; for `viewer`, return true when the viewer took the key. */
  run(action: Action, e: KeyboardEvent): boolean | void;
}

/** The single window keydown listener. Returns the uninstall function. */
export function install(runner: ShortcutRunner, target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    const d = decide(e, runner.context(e));
    if (!d) return;
    const taken = runner.run(d.action, e) === true;
    if (d.preventDefault || taken) e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
