// What is open where: slot A (and B while comparing), follow mode, the inspected asset, recent targets.
import type { ActivityEntry, Review } from '@/lib/api/types';
import { targetToHash } from '@/lib/util/hash';
import { idOfTarget, splitId } from '@/lib/util/ids';
import { store, readFollowMode, type FollowMode } from '@/lib/util/storage';
import { followTarget, reviewCompareTargets, reviewTarget, switchViewTarget, targetForId, viewerKindFor, type TabId } from '@/lib/util/targets';
import type { CompareOverlay, SlotId, Target, Viewer } from '@/viewers/types';
import { assets } from './assets.svelte';
import { uiState } from './uiState.svelte';

export interface Slot { target: Target | null; error: string | null }
export interface OpenOpts { slot?: SlotId; history?: boolean }
export const RECENT_MAX = 8;

const isSnap = (t: Target | null | undefined): boolean => !!t && 'snap' in t && !!t.snap;

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
  /**
   * Who performs a navigation. Until the Svelte shell owns the slots (step 18) the legacy App sets
   * this to its own open(), which mounts the viewer and then calls workspace.open() for the state.
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
      this.compareOverlay = 'off';
      this.compareStatus = null;
    }
  }
  compare(a: Target, b: Target): void {
    this.setCompare(true);
    this.go(a, { slot: 'A' });
    this.go(b, { slot: 'B' });
  }
  swap(): void {
    const a = this.slots.A.target, b = this.slots.B.target;
    if (a && b) this.compare(b, a);
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
}

export const workspace = new Workspace();
