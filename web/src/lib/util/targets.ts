// Pure target logic shared by the shell: which viewer shows a target, default targets per kind, the
// viewer tabs, view switching, review targets, follow mode and snapshot targets.
import type { ActivityAsset, ActivityEntry, AssetIndex, CanvasSummary, Review, ReviewTarget } from '@/lib/api/types';
import type { CanvasView, Target, ViewerKind } from '@/viewers/types';
import { splitId } from './ids';

export function viewerKindFor(t: Target | null | undefined): ViewerKind | null {
  if (!t) return null;
  switch (t.kind) {
    case 'canvas': {
      if (t.snap) return 'canvas';
      const map: Record<string, ViewerKind> = { edit: 'canvas', anim: 'anim', sheet: 'sheet', layers: 'layers' };
      return map[t.view ?? 'edit'] ?? 'canvas';
    }
    case 'rig': return t.view === 'layers' ? 'layers' : 'rig';
    case 'model': return 'model';
    case 'audio': return 'audio';
    case 'project': return 'project';
    case 'graph': return 'graph';
    case 'export':
      if (/\.glb$/i.test(t.name)) return 'model';
      if (/\.(wav|mp3|ogg|opus)$/i.test(t.name)) return 'audio';
      return 'export';
    default: return null;
  }
}

/** Default target for an asset of a kind (browser, graph nodes, timeline). */
export function targetFor(kind: string, name: string, index?: AssetIndex | null): Target {
  if (kind === 'layer' || kind === 'anim' || kind === 'frame') {
    const i = name.indexOf('/');
    const c = name.slice(0, i), sub = name.slice(i + 1);
    return kind === 'anim' ? { kind: 'canvas', name: c, view: 'anim', tag: sub } : { kind: 'canvas', name: c };
  }
  if (kind === 'rigpart') return { kind: 'rig', name: name.split('/')[0], mode: 'parts' };
  if (kind === 'modelpart') return { kind: 'model', name: name.split('/')[0] };
  if (kind === 'group') return { kind: 'graph', focus: `group:${name}` };
  if (kind === 'palette') return index?.projects.some((p) => p.name === name) ? { kind: 'project', name } : { kind: 'canvas', name };
  if (kind === 'graph') return { kind: 'graph' };
  return { kind, name } as Target;
}

export const targetForId = (id: string, index?: AssetIndex | null): Target => { const [k, n] = splitId(id); return targetFor(k, n, index); };

export type TabId = CanvasView | 'rig';
export interface TabSpec { id: TabId; label: string }

const canvasOf = (index: AssetIndex | null | undefined, name: string): CanvasSummary | undefined => index?.canvases.find((x) => x.name === name);

/** L8: viewer tabs of a target. */
export function tabsFor(t: Target | null | undefined, index?: AssetIndex | null): TabSpec[] {
  if (!t) return [];
  if (t.kind === 'canvas' && !t.snap) {
    const c = canvasOf(index, t.name);
    const tabs: TabSpec[] = [{ id: 'edit', label: 'Canvas' }];
    if (!c || c.frames > 1 || c.animations.length) tabs.push({ id: 'anim', label: 'Animation' });
    tabs.push({ id: 'sheet', label: 'Sheet' }, { id: 'layers', label: 'Layers' });
    if (c?.rig || c?.kind === 'rigparts') tabs.push({ id: 'rig', label: 'Rig' });
    return tabs;
  }
  if (t.kind === 'rig') return [{ id: 'rig', label: 'Rig' }, { id: 'layers', label: 'Layers' }];
  return [];
}

export function currentTab(t: Target | null | undefined): TabId | null {
  if (!t) return null;
  if (t.kind === 'rig') return t.view === 'layers' ? 'layers' : 'rig';
  if (t.kind === 'canvas') return t.view ?? 'edit';
  return null;
}

/** L9: the target a tab click opens (null = nothing to do). */
export function switchViewTarget(t: Target | null | undefined, v: TabId, index?: AssetIndex | null): Target | null {
  if (!t) return null;
  if (t.kind === 'canvas' && v === 'rig') {
    const c = canvasOf(index, t.name);
    const rig = c?.rig || (c?.kind === 'rigparts' ? t.name.replace(/_parts$/, '') : null);
    if (!rig) return null;
    return { kind: 'rig', name: rig, clip: c?.rig && c.animations[0] ? `${t.name}/${c.animations[0]}` : undefined };
  }
  if (t.kind === 'rig') return { kind: 'rig', name: t.name, view: v === 'layers' ? 'layers' : undefined };
  if (t.kind === 'canvas') return { ...t, view: v as CanvasView };
  return t;
}

/** R5: where a review note's "Show" goes. */
export function reviewTarget(asset: string, rt: ReviewTarget = {}, index?: AssetIndex | null): Target {
  const [k, n] = splitId(asset);
  if (k === 'canvas') return { kind: 'canvas', name: n, frame: rt.frame, tag: rt.tag, view: rt.tag && rt.view ? 'anim' : undefined };
  return targetFor(k, n, index);
}

/** R5: "Side by side": both forced out of the anim view. */
export function reviewCompareTargets(r: Review, index?: AssetIndex | null): [Target, Target] | null {
  if (!r.compare_with) return null;
  const a = reviewTarget(r.asset, r.target, index);
  const ct = { ...r.target, ...r.compare_with };
  const b = reviewTarget(r.compare_with.asset, ct, index);
  if (a.kind === 'canvas' && a.view === 'anim') delete a.view;
  if (b.kind === 'canvas' && b.view === 'anim') delete b.view;
  return [a, b];
}

export interface FollowContext {
  mode: 'canvas' | 'project' | 'off';
  dialogOpen: boolean;
  current: Target | null;
  isHidden(id: string): boolean;
  solo: ReadonlySet<string>;
  index: AssetIndex | null;
}

/** E10..E13: the target follow mode opens for an activity entry, or null. */
export function followTarget(entry: ActivityEntry, ctx: FollowContext): Target | null {
  if (ctx.mode === 'off' || ctx.dialogOpen) return null;
  const ok = (a: ActivityAsset) => !ctx.isHidden(`${a.kind}:${a.name}`) && (!ctx.solo.size || ctx.solo.has(`${a.kind}:${a.name}`)) && !a.deleted;
  const list = (entry.assets || []).filter((a) => ['canvas', 'model', 'audio', 'rig'].includes(a.kind) && ok(a));
  const a = list.find((x) => x.kind === 'canvas' && x.after) || list.find((x) => x.after) || list[0];
  if (!a) return null;
  const cur = ctx.current;
  if (ctx.mode === 'project') {
    const c = a.kind === 'canvas' ? canvasOf(ctx.index, a.name) : undefined;
    const proj = c?.project;
    if (proj && !(cur?.kind === 'project' && cur.name === proj)) return { kind: 'project', name: proj };
    return null;
  }
  const t: Target = a.kind === 'rig' ? { kind: 'canvas', name: `${a.name}_parts` } : ({ kind: a.kind, name: a.name } as Target);
  if (cur && !('snap' in cur && cur.snap) && cur.kind === t.kind && 'name' in cur && 'name' in t && cur.name === t.name) return null;
  // stay in the same viewer mode when following within canvases (animation stays animation)
  if (cur?.kind === 'canvas' && t.kind === 'canvas' && cur.view && cur.view !== 'layers') t.view = cur.view;
  return t;
}

/** A snapshot target of an activity asset (rig snapshots are of the parts canvas). */
export function snapTarget(a: ActivityAsset, snap: string, label: string): Target {
  const kind = a.kind === 'rig' ? 'canvas' : a.kind;
  const name = a.kind === 'rig' ? `${a.name}_parts` : a.name;
  return { kind, name, snap, label } as Target;
}
