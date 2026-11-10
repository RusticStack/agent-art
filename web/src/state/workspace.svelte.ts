// What is open where: slot A (and B while comparing), follow mode, the inspected asset, recent targets.
import type { ActivityEntry, Review } from '@/lib/api/types';
import { targetToHash } from '@/lib/util/hash';
import { idOfTarget, splitId } from '@/lib/util/ids';
import { toast } from '@/lib/util/notify';
import { store, readFollowMode, type FollowMode } from '@/lib/util/storage';
import { followTarget, reviewCompareTargets, reviewTarget, switchViewTarget, targetForId, viewerKindFor, type TabId } from '@/lib/util/targets';
import type { CompareOverlay, ReviewDraft, SlotId, Target, Viewer, ViewerHostApi } from '@/viewers/types';
import { assets } from './assets.svelte';
import { dialogs } from './dialogs.svelte';
import { editor } from './editor.svelte';
import { reviews } from './reviews.svelte';
import { bumpInspector } from './signals.svelte';
import { uiState } from './uiState.svelte';

export interface Slot { target: Target | null; error: string | null }
export interface OpenOpts { slot?: SlotId; history?: boolean }
export const RECENT_MAX = 8;

const isSnap = (t: Target | null | undefined): boolean => !!t && 'snap' in t && !!t.snap;
const other = (s: SlotId): SlotId => (s === 'A' ? 'B' : 'A');

export class Workspace {
  slots = $state<{ A: Slot; B: Slot }>({ A: { target: null, error: null }, B: { target: null, error: null } });
  comparing = $state(false);
  compareLink = $state(true);
  compareOverlay = $state<CompareOverlay>('off');
  compareStatus = $state<string | null>(null);
  peerRev = $state({ A: 0, B: 0 });
  recent = $state.raw<string[]>(store.get<string[]>('recent', []));
  inspected = $state.raw<Target | null>(null);
  followMode = $state<FollowMode>(readFollowMode());
  private viewers: Record<SlotId, Viewer | null> = { A: null, B: null };
  private hosts: Partial<Record<SlotId, ViewerHostApi>> = {};
  /**
   * Optional interceptor for navigation (tests spy on it). Null in the app: open() sets the slot state
   * and the shell's ViewerSlot mounts / updates the viewer from it.
   */
  navigator: ((t: Target, o?: OpenOpts) => void) | null = null;
  /** Is a blocking dialog open (follow mode pauses)? Set by the shell. */
  dialogOpen: () => boolean = () => false;
  /** Hash writer (tests replace it). */
  writeHash = (h: string): void => {
    if (typeof location !== 'undefined' && location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h);
  };

  get current(): Target | null { return this.slots.A.target; }
  get currentId(): string | null { return this.current ? idOfTarget(this.current) : null; }
  get following(): boolean { return this.followMode !== 'off'; }

  private go(t: Target, o?: OpenOpts): void { if (this.navigator) this.navigator(t, o); else this.open(t, o); }

  /** State part of opening a target (the viewer follows the state). */
  open(target: Target, { slot = 'A', history = true }: OpenOpts = {}): void {
    if (slot === 'B' && !this.comparing) this.setCompare(true);
    this.slots[slot] = { target, error: null };
    // RV7: the compare overlay only exists between two canvas viewers
    if (this.comparing && viewerKindFor(target) !== 'canvas') this.resetOverlay();
    if (slot !== 'A') return;
    this.inspected = target.kind === 'graph' ? { kind: 'graph' } : target;
    const h = targetToHash(target);
    if (h === null) return;
    if (history) this.writeHash(h);
    this.recent = [h, ...this.recent.filter((x) => x !== h)].slice(0, RECENT_MAX);
    store.set('recent', this.recent);
  }
  setError(slot: SlotId, error: string | null): void { this.slots[slot] = { ...this.slots[slot], error }; }
  openNode(id: string): void {
    const t = targetForId(id, assets.index);
    if (viewerKindFor(t)) this.go(t);
  }
  inspectNode(id: string): void {
    const [kind, name] = splitId(id);
    this.inspected = { kind, name } as Target;
  }
  /** L9: tab switch in a slot. */
  switchView(slot: SlotId, view: TabId): void {
    const t = switchViewTarget(this.slots[slot].target, view, assets.index);
    if (t) this.go(t, { slot });
  }
  setCompare(on: boolean): void {
    this.comparing = on;
    if (!on) {
      this.slots.B = { target: null, error: null };
      this.resetOverlay();
    }
  }
  /** RV7: overlay back to Off, status cleared (compare closed, swap, a non-canvas viewer). */
  resetOverlay(): void {
    this.compareOverlay = 'off';
    this.compareStatus = null;
  }
  compare(a: Target, b: Target): void {
    this.setCompare(true);
    this.go(a, { slot: 'A' });
    this.go(b, { slot: 'B' });
  }
  swap(): void {
    const a = this.slots.A.target, b = this.slots.B.target;
    if (!a || !b) return;
    this.resetOverlay(); // Link stays as it is
    this.compare(b, a);
  }
  backToLive(): void {
    const t = this.current;
    if (t && isSnap(t) && 'name' in t) this.go({ kind: t.kind, name: t.name } as Target);
  }
  setFollowMode(m: FollowMode): void {
    this.followMode = m;
    store.set('follow', m);
    store.setRaw('agent-art-follow', m);
  }
  /** T5 / T6: off <-> the last non-off mode (remembered as followOn). */
  toggleFollow(): void {
    const next: FollowMode = this.following ? 'off' : store.get<FollowMode>('followOn', 'canvas');
    this.followMode = next;
    if (next !== 'off') store.set('followOn', next);
    store.set('follow', next);
  }
  /** E10..E13: open what the agent touches. */
  follow(entry: ActivityEntry): void {
    const t = followTarget(entry, { mode: this.followMode, dialogOpen: this.dialogOpen(), current: this.current, isHidden: (id) => uiState.isHidden(id), solo: uiState.solo, index: assets.index });
    if (t) this.go(t);
  }
  openReview(r: Review): void { this.go(reviewTarget(r.asset, r.target, assets.index)); }
  openReviewCompare(r: Review): void {
    const pair = reviewCompareTargets(r, assets.index);
    if (pair) this.compare(pair[0], pair[1]);
  }
  viewer(slot: SlotId): Viewer | null { return this.viewers[slot]; }
  registerViewer(slot: SlotId, v: Viewer | null): void { this.viewers[slot] = v; }

  /** R3: the review note dialog; on success toast and leave review mode. Resolves with the new note. */
  async requestReview(draft: ReviewDraft, leaveReviewMode: () => void = () => editor.setReviewMode(false)): Promise<{ id: string } | null> {
    const r = await dialogs.reviewNote(draft);
    if (r) {
      toast(`Review note ${r.id} added — the agent sees it in art_review list and in replies about this asset`, 'ok');
      leaveReviewMode();
    }
    return r;
  }

  /** What a viewer in a slot may ask of the app (one object per slot). Slot B is read-only. */
  hostApi(slot: SlotId): ViewerHostApi {
    const cached = this.hosts[slot];
    if (cached) return cached;
    const host: ViewerHostApi = {
      slot,
      readOnly: slot === 'B',
      assets: () => assets.index,
      isHidden: (id) => uiState.isHidden(id),
      reviewMarks: (a) => reviews.marks(a),
      open: (t, o) => this.go(t, o),
      openNode: (id) => this.openNode(id),
      inspectNode: (id) => this.inspectNode(id),
      requestReview: (d) => { void this.requestReview(d); },
      setTool: (t) => editor.setTool(t),
      setColor: (hex) => editor.setColor(hex),
      canvasInfoChanged: (name) => {
        const ins = this.inspected;
        if (ins?.kind === 'canvas' && ins.name === name) bumpInspector();
      },
      toast: (text, kind) => toast(text, kind),
      peerViewer: () => (this.comparing ? this.viewers[other(slot)] : null),
      notifyPeer: () => {
        const peer = other(slot);
        if (this.comparing && this.viewers[peer]) this.peerRev = { ...this.peerRev, [peer]: this.peerRev[peer] + 1 };
      },
      compareStatus: (text) => { if (slot === 'A' && this.compareStatus !== text) this.compareStatus = text; },
      setCompareOverlay: (mode) => { if (this.comparing) this.compareOverlay = mode; },
      togglePinned: (id) => { void uiState.togglePinned(id); },
      toggleHidden: (id) => { void uiState.toggleHidden(id); },
      isPinned: (id) => uiState.isPinned(id),
      followMode: () => this.followMode,
    };
    this.hosts[slot] = host;
    return host;
  }
}

export const workspace = new Workspace();
