import { describe, expect, it } from 'vitest';
import { keyTokens, SHORTCUTS } from './shortcuts';

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
