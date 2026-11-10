// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decide, install, isInteractive, isTextTarget, keyTokens, SHORTCUTS, type KeyEventLike, type ShortcutContext } from './shortcuts';

describe('shortcut table', () => {
  it('ids are unique', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });

  it('splits keys strings into keys, joiners and spaces', () => {
    const text = (k: string) => keyTokens(k).map((t) => (t.k === 'key' ? `[${t.v}]` : t.v)).join('');
    expect(text('Shift+G')).toBe('[Shift]+[G]');
    expect(text('Ctrl+Z/Y')).toBe('[Ctrl]+[Z]/[Y]');
    expect(text('[ ]')).toBe('[[] []]');
    expect(text('1–5')).toBe('[1]–[5]');
    expect(text('+ - 0')).toBe('[+] [-] [0]');
    expect(text('/')).toBe('[/]');
    expect(text('')).toBe('');
  });
});

// ---- decide(): K1–K10 in order, the viewer hand-off and the 4.4 rules (step 18) ----

const ev = (key: string, m: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
const ctx = (o: Partial<ShortcutContext> = {}): ShortcutContext => ({
  inText: false, onInteractive: false, dialogBlocking: false, helpOpen: false, reviewMode: false, comparing: false,
  snapOpen: false, drawerOpen: false, pixelCanvasFocused: false, slotAKind: 'canvas', browserShown: true, tabCount: 5, ...o,
});
/** the shell action decide() falls back to when the viewer declines */
const fb = (key: string, c: Partial<ShortcutContext> = {}, m: Partial<KeyEventLike> = {}) => {
  const d = decide(ev(key, m), ctx(c));
  return d?.action.type === 'viewer' ? d.action.fallback : d?.action ?? null;
};

describe('decide()', () => {
  it('K1: in a text field only Esc acts, and it blurs', () => {
    expect(decide(ev('Escape'), ctx({ inText: true }))).toEqual({ action: { type: 'blur' } });
    expect(decide(ev('f'), ctx({ inText: true }))).toBeNull();
    expect(decide(ev('z', { ctrlKey: true }), ctx({ inText: true }))).toBeNull(); // the field's own undo
  });
  it('K2: a blocking dialog owns every key, Esc included', () => {
    expect(decide(ev('Escape'), ctx({ dialogBlocking: true, comparing: true }))).toBeNull();
    expect(decide(ev('f'), ctx({ dialogBlocking: true }))).toBeNull();
  });
  it('K3: Ctrl/Cmd+Z undo, with Shift redo, Ctrl+Y redo, default prevented', () => {
    expect(decide(ev('z', { ctrlKey: true }), ctx())).toEqual({ action: { type: 'undo', redo: false }, preventDefault: true });
    expect(decide(ev('Z', { metaKey: true, shiftKey: true }), ctx())).toEqual({ action: { type: 'undo', redo: true }, preventDefault: true });
    expect(decide(ev('y', { ctrlKey: true }), ctx())).toEqual({ action: { type: 'undo', redo: true }, preventDefault: true });
  });
  it('K4: other modifier combinations are left to the browser', () => {
    expect(decide(ev('f', { ctrlKey: true }), ctx())).toBeNull();
    expect(decide(ev('c', { altKey: true }), ctx())).toBeNull();
    expect(decide(ev('r', { metaKey: true }), ctx())).toBeNull();
  });
  it('4.4: Space and Enter on a focused button stay with the button', () => {
    expect(decide(ev(' '), ctx({ onInteractive: true }))).toBeNull();
    expect(decide(ev('Enter'), ctx({ onInteractive: true }))).toBeNull();
    expect(fb('f', { onInteractive: true })).toEqual({ type: 'follow' }); // other keys still work
  });
  it('K5: the Esc chain, first match wins', () => {
    const all = { drawerOpen: true, reviewMode: true, helpOpen: true, comparing: true, snapOpen: true };
    const esc = (c: Partial<ShortcutContext>) => decide(ev('Escape'), ctx(c))?.action.type ?? null;
    expect(esc(all)).toBe('closeDrawer');
    expect(esc({ ...all, drawerOpen: false })).toBe('reviewOff');
    expect(esc({ ...all, drawerOpen: false, reviewMode: false })).toBe('closeHelp');
    expect(esc({ comparing: true, snapOpen: true })).toBe('closeCompare');
    expect(esc({ snapOpen: true })).toBe('backToLive');
    expect(esc({})).toBeNull();
  });
  it('K6: Space on a focused pixel canvas belongs to the canvas', () => {
    expect(decide(ev(' '), ctx({ pixelCanvasFocused: true }))).toBeNull();
    expect(decide(ev(' '), ctx())?.action.type).toBe('viewer');
  });
  it('K7: other keys go to the slot A viewer first, lower-cased, with the shell fallback', () => {
    expect(decide(ev('B'), ctx())).toEqual({ action: { type: 'viewer', key: 'b', fallback: { type: 'tool', tool: 'pencil' } }, preventDefault: undefined });
    expect(decide(ev('ArrowLeft'), ctx())).toEqual({ action: { type: 'viewer', key: 'ArrowLeft', fallback: null }, preventDefault: undefined });
    expect(decide(ev('+'), ctx())?.action).toEqual({ type: 'viewer', key: '+', fallback: null });
  });
  it('K8: Shift+G opens the graph from any viewer', () => {
    expect(fb('G', { slotAKind: 'model' }, { shiftKey: true })).toEqual({ type: 'graph' });
  });
  it('K9: paint tool keys only while slot A is a canvas editor', () => {
    expect(fb('e')).toEqual({ type: 'tool', tool: 'eraser' });
    expect(fb('g')).toEqual({ type: 'tool', tool: 'fill' });
    expect(fb('h')).toEqual({ type: 'tool', tool: 'hand' });
    expect(fb('e', { slotAKind: 'model' })).toBeNull();
    expect(fb('b', { slotAKind: null })).toBeNull();
  });
  it('K10: the shell keys', () => {
    expect(fb('f')).toEqual({ type: 'follow' });
    expect(fb('c')).toEqual({ type: 'compare' });
    expect(fb('m')).toEqual({ type: 'review' });
    expect(fb('?')).toEqual({ type: 'help' });
    expect(fb('p')).toEqual({ type: 'dock' });
    expect(fb('[')).toEqual({ type: 'pane', which: 'browser' });
    expect(fb(']')).toEqual({ type: 'pane', which: 'side' });
    expect(fb('o')).toEqual({ type: 'overview' });
    expect(fb('1')).toEqual({ type: 'tab', index: 0 });
  });
  it('`/` focuses the filter (default prevented) only while the browser is shown', () => {
    expect(decide(ev('/'), ctx())).toEqual({ action: { type: 'viewer', key: '/', fallback: { type: 'filter' } }, preventDefault: true });
    expect(decide(ev('/'), ctx({ browserShown: false }))).toEqual({ action: { type: 'viewer', key: '/', fallback: null }, preventDefault: undefined });
  });
  it('18b: Ctrl/Cmd+K opens the palette (default prevented), also while Help is open', () => {
    const open = { action: { type: 'palette' }, preventDefault: true };
    expect(decide(ev('k', { ctrlKey: true }), ctx())).toEqual(open);
    expect(decide(ev('K', { metaKey: true }), ctx())).toEqual(open);
    expect(decide(ev('k', { ctrlKey: true }), ctx({ helpOpen: true }))).toEqual(open);
    // over a focused button and during compare / review mode too (it is a modifier chord, not Space / Enter)
    expect(decide(ev('k', { ctrlKey: true }), ctx({ onInteractive: true, comparing: true, reviewMode: true }))).toEqual(open);
  });
  it('18b: Ctrl+K does nothing in a text field, in a blocking dialog, or with Alt / Shift', () => {
    expect(decide(ev('k', { ctrlKey: true }), ctx({ inText: true }))).toBeNull();
    expect(decide(ev('k', { ctrlKey: true }), ctx({ dialogBlocking: true }))).toBeNull();
    expect(decide(ev('k', { ctrlKey: true, altKey: true }), ctx())).toBeNull();
    expect(decide(ev('K', { ctrlKey: true, shiftKey: true }), ctx())).toBeNull();
    // plain k is still the viewer's / nothing
    expect(fb('k')).toBeNull();
  });
  it('18b: the palette row is in the table (Everywhere, new)', () => {
    expect(SHORTCUTS.find((s) => s.id === 'palette')).toMatchObject({ keys: 'Ctrl+K', group: 'Everywhere', action: 'palette', isNew: true });
  });
  it('digits past the tab count do nothing; an unknown count allows 1–5', () => {
    expect(fb('2', { tabCount: 2 })).toEqual({ type: 'tab', index: 1 });
    expect(fb('3', { tabCount: 2 })).toBeNull();
    expect(fb('5', { tabCount: undefined })).toEqual({ type: 'tab', index: 4 });
    expect(fb('6')).toBeNull();
  });
});

describe('install() and the focus helpers', () => {
  it('runs the decision and prevents default when asked or when the viewer took the key', () => {
    const target = new EventTarget() as unknown as Window;
    const seen: string[] = [];
    const off = install({ context: () => ctx(), run: (a) => { seen.push(a.type); return a.type === 'viewer' && a.key === '+'; } }, target);
    const fire = (key: string, m: Partial<KeyEventLike> = {}) => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), ev(key, m));
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire('+')).toBe(true); // the viewer took it
    expect(fire('f')).toBe(false); // declined: the shell fallback, no preventDefault
    expect(fire('z', { ctrlKey: true })).toBe(true);
    expect(fire('x', { altKey: true })).toBe(false);
    expect(fire('k', { ctrlKey: true })).toBe(true);
    expect(seen).toEqual(['viewer', 'viewer', 'undo', 'palette']);
    off();
    fire('f');
    expect(seen).toHaveLength(4);
  });
  it('isInteractive / isTextTarget', () => {
    const b = document.createElement('button'); const span = document.createElement('span'); b.append(span);
    const tab = document.createElement('div'); tab.setAttribute('role', 'tab');
    expect(isInteractive(span)).toBe(true);
    expect(isInteractive(tab)).toBe(true);
    expect(isInteractive(document.createElement('div'))).toBe(false);
    expect(isInteractive(null)).toBe(false);
    expect(isTextTarget(document.createElement('input'))).toBe(true);
    expect(isTextTarget(document.createElement('select'))).toBe(true);
    expect(isTextTarget(b)).toBe(false);
    expect(isTextTarget(null)).toBe(false);
  });
});
