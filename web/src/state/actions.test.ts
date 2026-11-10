// @vitest-environment jsdom
// The shell action runner (step 18) and the command palette's context / runner (step 18b).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { Viewer } from '@/viewers/types';
import { paletteContext, runAction, runPaletteAction, shellHooks } from './actions';
import { assets } from './assets.svelte';
import { dialogs } from './dialogs.svelte';
import { editor } from './editor.svelte';
import { layout } from './layout.svelte';
import { prefs } from './prefs.svelte';
import { uiState } from './uiState.svelte';
import { workspace } from './workspace.svelte';

beforeEach(() => {
  workspace.writeHash = () => {};
  assets.set(assetIndex({ canvases: [canvasSummary('hero', { project: 'p', frames: 4 }), canvasSummary('b')] }));
  workspace.setCompare(false);
  workspace.open({ kind: 'canvas', name: 'hero' });
  uiState.clearSolo();
  dialogs.closeAll();
});
afterEach(() => {
  dialogs.closeAll();
  workspace.registerViewer('A', null);
  localStorage.clear();
});

describe('runAction', () => {
  it("'palette' opens the palette once", () => {
    runAction({ type: 'palette' });
    runAction({ type: 'palette' });
    expect(dialogs.stack.filter((d) => d.type === 'palette')).toHaveLength(1);
  });
  it("K1 'blur' blurs the field the key came from only while it still has focus", () => {
    const field = document.createElement('input');
    const opener = document.createElement('button');
    document.body.append(field, opener);
    field.focus();
    runAction({ type: 'blur' }, { target: field } as unknown as KeyboardEvent);
    expect(document.activeElement).toBe(document.body);
    // the Esc closed a dialog and focus is back on its opener: it stays there
    opener.focus();
    runAction({ type: 'blur' }, { target: field } as unknown as KeyboardEvent);
    expect(document.activeElement).toBe(opener);
    field.remove(); opener.remove();
  });
});

describe('paletteContext', () => {
  it('reads slot A, the index and the toggles from the stores', () => {
    uiState.toggleSolo('canvas:b');
    const c = paletteContext();
    expect(c.slotA).toEqual({ kind: 'canvas', name: 'hero' });
    expect(c.index?.canvases.map((x) => x.name)).toEqual(['hero', 'b']);
    expect(c).toMatchObject({ comparing: false, reviewMode: editor.reviewMode, showHidden: prefs.showHidden, soloCount: 1, browserShown: layout.shown('browser') });
  });
});

describe('runPaletteAction', () => {
  it('shortcut actions run as their key does', () => {
    runPaletteAction({ type: 'shortcut', action: 'compare' });
    expect(workspace.comparing).toBe(true);
    runPaletteAction({ type: 'shortcut', action: 'graph' });
    expect(workspace.current).toEqual({ kind: 'graph' });
    runPaletteAction({ type: 'shortcut', action: 'help' });
    expect(dialogs.helpOpen).toBe(true);
  });
  it('tab, tool, cleanup, review list, clear solo, show hidden', () => {
    runPaletteAction({ type: 'tab', tab: 'anim' });
    expect(workspace.current).toMatchObject({ kind: 'canvas', name: 'hero', view: 'anim' });
    runPaletteAction({ type: 'tool', tool: 'fill' });
    expect(editor.tool).toBe('fill');
    runPaletteAction({ type: 'cleanup', tab: 'usage' });
    expect(dialogs.stack.at(-1)).toEqual({ type: 'cleanup', tab: 'usage' });
    runPaletteAction({ type: 'reviewList' });
    expect(dialogs.isOpen('reviewList')).toBe(true);
    uiState.toggleSolo('canvas:b');
    runPaletteAction({ type: 'clearSolo' });
    expect(uiState.solo.size).toBe(0);
    runPaletteAction({ type: 'showHidden', on: true });
    expect(prefs.showHidden).toBe(true);
    runPaletteAction({ type: 'showHidden', on: false });
    expect(prefs.showHidden).toBe(false);
  });
  it('undo, shading and view go to the slot A viewer', () => {
    const v = { mount() {}, update() {}, destroy() {}, undo: vi.fn(), setMode: vi.fn(), setViewPreset: vi.fn() };
    workspace.registerViewer('A', v as unknown as Viewer);
    runPaletteAction({ type: 'undo', redo: true });
    runPaletteAction({ type: 'shading', mode: 'wire' });
    runPaletteAction({ type: 'view', preset: 'top' });
    expect(v.undo).toHaveBeenCalledWith(true);
    expect(v.setMode).toHaveBeenCalledWith('wire');
    expect(v.setViewPreset).toHaveBeenCalledWith('top');
  });
  it('new canvas shows the browser pane, then asks the browser for its form', async () => {
    const spy = vi.fn();
    shellHooks.newCanvas = spy;
    if (layout.shown('browser')) layout.togglePane('browser');
    runPaletteAction({ type: 'newCanvas' });
    expect(layout.shown('browser')).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(spy).toHaveBeenCalledOnce();
    shellHooks.newCanvas = () => {};
  });
});
