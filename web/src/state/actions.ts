// Runs the shell actions decided by state/shortcuts.ts (and, from step 18b, by the command palette):
// each one calls the same store method as the top bar button or the tab it stands for.
import { tabsFor, currentTab, viewerKindFor } from '@/lib/util/targets';
import { assets } from './assets.svelte';
import { dialogs } from './dialogs.svelte';
import { editor } from './editor.svelte';
import { layout } from './layout.svelte';
import { install, isInteractive, isTextTarget, type Action, type ShortcutContext } from './shortcuts';
import { workspace } from './workspace.svelte';

/** Set by the shell: things only a mounted component can do. */
export const shellHooks: { focusSearch: () => void } = { focusSearch: () => {} };

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
    case 'blur': (document.activeElement as HTMLElement | null)?.blur?.(); return;
    case 'undo': workspace.viewer('A')?.undo?.(a.redo); return;
    case 'closeDrawer': layout.closeDrawer(); return;
    case 'reviewOff': editor.setReviewMode(false); return;
    case 'closeHelp': dialogs.toggleHelp(); return;
    case 'closeCompare': workspace.setCompare(false); return;
    case 'backToLive': workspace.backToLive(); return;
    case 'graph': workspace.open({ kind: 'graph' }); return;
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
