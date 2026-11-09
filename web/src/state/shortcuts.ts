// The one shortcut table (4.4). Help renders it; the tooltips' <kbd> hints and the command palette read
// it later (steps 18, 18b). Data only: the key handler itself arrives in step 18.
//
// `keys` syntax: space-separated groups; inside a group `+`, `/` and `–` join keys (`Ctrl+Z/Y`, `1–5`);
// a group that is only `+` or `/` is the key itself. An empty `keys` is a pointer gesture written out in
// the label. `label` of every legacy row is the legacy help text verbatim.

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
