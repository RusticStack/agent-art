// Runs the shell actions decided by state/shortcuts.ts (and, from step 18b, by the command palette):
// each one calls the same store method as the top bar button or the tab it stands for.
import { tick } from 'svelte';
import type { PaletteAction, PaletteContext } from '@/components/dialogs/commands';
import { tabsFor, currentTab, viewerKindFor } from '@/lib/util/targets';
import type { ShadingMode } from '@/viewers/model/shading';
import type { ViewPreset } from '@/viewers/model/views';
import { assets } from './assets.svelte';
import { dialogs } from './dialogs.svelte';
import { editor } from './editor.svelte';
import { layout } from './layout.svelte';
import { prefs } from './prefs.svelte';
import { install, isInteractive, isTextTarget, type Action, type ActionId, type ShortcutContext } from './shortcuts';
import { uiState } from './uiState.svelte';
import { workspace } from './workspace.svelte';

/** Set by the shell: things only a mounted component can do. */
export const shellHooks: { focusSearch: () => void; newCanvas: () => void } = { focusSearch: () => {}, newCanvas: () => {} };

const isSnap = (t: unknown): boolean => !!t && typeof t === 'object' && 'snap' in t && !!(t as { snap?: string }).snap;

/** The context decide() needs, read from the stores and the event target. */
export function shortcutContext(e?: Pick<KeyboardEvent, 'target'> | null): ShortcutContext {
  const target = (e?.target instanceof Element ? e.target : null) ?? (typeof document !== 'undefined' ? document.activeElement : null);
  const cur = workspace.current;
  return {
    inText: isTextTarget(target),
    onInteractive: isInteractive(target),
    dialogBlocking: dialogs.blocking,
    helpOpen: dialogs.helpOpen,
    reviewMode: editor.reviewMode,
    comparing: workspace.comparing,
    snapOpen: isSnap(cur),
    drawerOpen: layout.narrow && layout.drawer !== null,
    pixelCanvasFocused: typeof document !== 'undefined' && !!document.activeElement?.classList.contains('pixel-canvas'),
    slotAKind: viewerKindFor(cur),
    browserShown: layout.shown('browser'),
    tabCount: tabsFor(cur, assets.index).length,
  };
}

/** O: the project overview of the open canvas (when it has a project). */
function openOverview(): void {
  const cur = workspace.current;
  if (cur?.kind !== 'canvas') return;
  const project = assets.canvas(cur.name)?.project;
  if (project) workspace.open({ kind: 'project', name: project });
}

/** Run one action. For `viewer`: true when the slot A viewer took the key (then nothing else runs). */
export function runAction(a: Action, e?: KeyboardEvent): boolean | void {
  switch (a.type) {
    case 'blur': {
      // K1: blur the field the Esc was typed in, and only while it still has focus: when that Esc closed
      // a dialog (the palette input), focus has already gone back to the opener and must stay there
      const field = e?.target instanceof HTMLElement ? e.target : (document.activeElement as HTMLElement | null);
      if (field && field === document.activeElement) field.blur();
      return;
    }
    case 'undo': workspace.viewer('A')?.undo?.(a.redo); return;
    case 'closeDrawer': layout.closeDrawer(); return;
    case 'reviewOff': editor.setReviewMode(false); return;
    case 'closeHelp': dialogs.toggleHelp(); return;
    case 'closeCompare': workspace.setCompare(false); return;
    case 'backToLive': workspace.backToLive(); return;
    case 'graph': workspace.open({ kind: 'graph' }); return;
    case 'palette': dialogs.openPalette(); return;
    case 'tool': editor.setTool(a.tool); return;
    case 'follow': workspace.toggleFollow(); return;
    case 'compare': workspace.setCompare(!workspace.comparing); return;
    case 'review': editor.setReviewMode(!editor.reviewMode); return;
    case 'filter': shellHooks.focusSearch(); return;
    case 'help': dialogs.toggleHelp(); return;
    case 'dock': layout.toggleDock(); return;
    case 'pane': layout.togglePane(a.which); return;
    case 'overview': openOverview(); return;
    case 'tab': {
      const cur = workspace.current;
      const tab = tabsFor(cur, assets.index)[a.index];
      if (tab && tab.id !== currentTab(cur)) workspace.switchView('A', tab.id);
      return;
    }
    case 'viewer': {
      const v = workspace.viewer('A');
      if (v?.onKey && e && v.onKey(e, a.key)) return true;
      if (a.fallback) runAction(a.fallback, e);
      return false;
    }
  }
}

/** The single global keydown listener of the app. */
export function installShortcuts(): () => void {
  return install({ context: (e) => shortcutContext(e), run: (a, e) => runAction(a, e) });
}

// ---------------------------------------------------------------------------------------------------
// Command palette (step 18b): its context and its action runner.

/** What the palette needs to know about the app (read inside a $derived, so it follows the stores). */
export function paletteContext(): PaletteContext {
  return {
    slotA: workspace.slots.A.target,
    index: assets.index,
    comparing: workspace.comparing,
    following: workspace.following,
    reviewMode: editor.reviewMode,
    browserShown: layout.shown('browser'),
    showHidden: prefs.showHidden,
    soloCount: uiState.solo.size,
  };
}

/** SHORTCUTS actions the palette runs as the key would (the ones with an argument have their own PaletteAction). */
const SIMPLE: Partial<Record<ActionId, Action>> = {
  follow: { type: 'follow' }, compare: { type: 'compare' }, review: { type: 'review' }, filter: { type: 'filter' }, graph: { type: 'graph' },
  overview: { type: 'overview' }, dock: { type: 'dock' }, help: { type: 'help' }, escape: { type: 'backToLive' }, palette: { type: 'palette' },
};

/** The slot A model viewer's palette hooks (duck-typed: the viewer class lives in a lazy chunk). */
interface ModelHooks { setMode?(m: ShadingMode): void; setViewPreset?(p: ViewPreset): void }

/** Run a palette action item; each one calls what its key, button or menu item calls. */
export function runPaletteAction(a: PaletteAction): void {
  switch (a.type) {
    case 'shortcut': { const act = SIMPLE[a.action]; if (act) runAction(act); return; }
    case 'pane': runAction({ type: 'pane', which: a.pane }); return;
    case 'tab': if (a.tab !== currentTab(workspace.current)) workspace.switchView('A', a.tab); return;
    case 'undo': runAction({ type: 'undo', redo: a.redo }); return;
    case 'backToLive': workspace.backToLive(); return;
    case 'tool': editor.setTool(a.tool); return;
    case 'newCanvas':
      // the browser's own "New" form; show the pane (or its narrow drawer) first so the form can take focus
      if (!layout.shown('browser')) layout.togglePane('browser');
      void tick().then(() => shellHooks.newCanvas());
      return;
    case 'cleanup': dialogs.openCleanup(a.tab); return;
    case 'reviewList': dialogs.openReviewList(); return;
    case 'clearSolo': uiState.clearSolo(); return;
    case 'showHidden': prefs.setShowHidden(a.on); return;
    case 'shading': (workspace.viewer('A') as ModelHooks | null)?.setMode?.(a.mode); return;
    case 'view': (workspace.viewer('A') as ModelHooks | null)?.setViewPreset?.(a.preset); return;
  }
}
