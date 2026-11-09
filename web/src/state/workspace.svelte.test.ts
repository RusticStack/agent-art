// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { ActivityEntry } from '@/lib/api/types';
import { Workspace } from './workspace.svelte';
import { assets } from './assets.svelte';
import { uiState } from './uiState.svelte';

let ws: Workspace;
let hashes: string[];
beforeEach(() => {
  ws = new Workspace();
  hashes = [];
  ws.writeHash = (h) => hashes.push(h);
  assets.set(assetIndex({ canvases: [canvasSummary('hero', { project: 'p', frames: 4, rig: 'r', kind: 'rigout', animations: ['walk'] }), canvasSummary('b')] }));
  uiState.hidden = new Set();
  uiState.clearSolo();
});
afterEach(() => localStorage.clear());

describe('workspace.open', () => {
  it('slot A writes the hash and the recent list; snapshots and slot B do not', () => {
    ws.open({ kind: 'canvas', name: 'hero' });
    expect(hashes).toEqual(['hero']);
    expect(ws.currentId).toBe('canvas:hero');
    expect(ws.inspected).toEqual({ kind: 'canvas', name: 'hero' });
    ws.open({ kind: 'canvas', name: 'hero', snap: 's1', label: '#3' });
    ws.open({ kind: 'model', name: 'm' }, { slot: 'B' });
    expect(hashes).toEqual(['hero']);
    expect(ws.comparing).toBe(true);
    ws.open({ kind: 'model', name: 'm' }, { history: false });
    expect(hashes).toEqual(['hero']);
    expect(ws.recent).toEqual(['model:m', 'hero']);
    expect(JSON.parse(localStorage.getItem('agent-art:recent')!)).toEqual(['model:m', 'hero']);
    ws.open({ kind: 'graph' });
    expect(ws.inspected).toEqual({ kind: 'graph' });
  });
  it('recent keeps 8, newest first, no duplicates', () => {
    for (let i = 0; i < 10; i++) ws.open({ kind: 'canvas', name: 'c' + i });
    ws.open({ kind: 'canvas', name: 'c5' });
    expect(ws.recent.length).toBe(8);
    expect(ws.recent[0]).toBe('c5');
    expect(new Set(ws.recent).size).toBe(8);
  });
  it('switchView, swap, setCompare(false), backToLive go through the navigator', () => {
    const nav = vi.fn((t, o) => ws.open(t, o));
    ws.navigator = nav;
    ws.open({ kind: 'canvas', name: 'hero' });
    ws.switchView('A', 'anim');
    expect(ws.current).toMatchObject({ kind: 'canvas', name: 'hero', view: 'anim' });
    ws.switchView('A', 'rig');
    expect(ws.current).toMatchObject({ kind: 'rig', name: 'r' });
    ws.open({ kind: 'canvas', name: 'b' }, { slot: 'B' });
    ws.swap();
    expect(ws.slots.A.target).toMatchObject({ name: 'b' });
    expect(ws.slots.B.target).toMatchObject({ name: 'r' });
    ws.compareOverlay = 'diff';
    ws.setCompare(false);
    expect(ws.slots.B.target).toBeNull();
    expect(ws.compareOverlay).toBe('off');
    ws.open({ kind: 'canvas', name: 'b', snap: 'x', label: 'before' });
    ws.backToLive();
    expect(ws.current).toEqual({ kind: 'canvas', name: 'b' });
  });
});

const entry = (assetsList: ActivityEntry['assets']): ActivityEntry => ({ id: 1, type: 'op', op: 'draw', source: 'agent', ts: 0, args: {}, assets: assetsList } as ActivityEntry);

describe('follow (E10..E13, T5, T6)', () => {
  it('opens the touched canvas, keeps the view, skips hidden / non-solo / dialogs / off', () => {
    ws.open({ kind: 'canvas', name: 'b', view: 'anim' });
    ws.follow(entry([{ kind: 'canvas', name: 'hero', after: 's' }]));
    expect(ws.current).toEqual({ kind: 'canvas', name: 'hero', view: 'anim' });
    uiState.hidden = new Set(['canvas:b']);
    ws.follow(entry([{ kind: 'canvas', name: 'b' }]));
    expect(ws.currentId).toBe('canvas:hero');
    uiState.hidden = new Set();
    ws.dialogOpen = () => true;
    ws.follow(entry([{ kind: 'canvas', name: 'b' }]));
    expect(ws.currentId).toBe('canvas:hero');
    ws.dialogOpen = () => false;
    uiState.toggleSolo('canvas:hero');
    ws.follow(entry([{ kind: 'canvas', name: 'b' }]));
    expect(ws.currentId).toBe('canvas:hero');
    uiState.clearSolo();
    ws.setFollowMode('project');
    ws.follow(entry([{ kind: 'canvas', name: 'hero' }]));
    expect(ws.current).toEqual({ kind: 'project', name: 'p' });
    ws.setFollowMode('off');
    ws.follow(entry([{ kind: 'canvas', name: 'b' }]));
    expect(ws.currentId).toBe('project:p');
  });
  it('setFollowMode writes both keys; toggleFollow remembers the last mode', () => {
    ws.setFollowMode('project');
    expect(localStorage.getItem('agent-art:follow')).toBe('"project"');
    expect(localStorage.getItem('agent-art-follow')).toBe('project');
    ws.toggleFollow();
    expect(ws.followMode).toBe('off');
    expect(ws.following).toBe(false);
    localStorage.setItem('agent-art:followOn', '"project"');
    ws.toggleFollow();
    expect(ws.followMode).toBe('project');
    expect(localStorage.getItem('agent-art:follow')).toBe('"project"');
  });
});
