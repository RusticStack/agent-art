// Pure project-overview logic (unit-tested): the description line and what a live event does to the tiles.
import type { AnyEvent, ProjectInfo } from '@/lib/api/types';

export function descriptionLine(p: Pick<ProjectInfo, 'canvases' | 'meta' | 'description'>, hidden: number): string {
  const fmt = p.meta?.minecraft ? ` · Minecraft ${p.meta.minecraft}` : '';
  return `${p.canvases.length} canvases${hidden ? ` · ${hidden} hidden` : ''}${fmt}${p.description ? ' — ' + p.description : ''}`;
}

export type TilePlan =
  | { action: 'none' }
  | { action: 'reload' }
  | { action: 'remove'; name: string }
  | { action: 'update'; name: string; version: string; isNew: boolean; flash: boolean };

export function planTileUpdate(ev: AnyEvent, project: string, tiles: ReadonlySet<string>, isHidden: (id: string) => boolean): TilePlan {
  const e = ev as { type: string; project?: string | null; canvas?: string; version?: number; ts?: number; source?: string };
  if (e.type === 'resync') return { action: 'reload' };
  if (e.type === 'project' && e.project === project) return { action: 'reload' };
  if (e.type === 'deleted' && e.canvas && tiles.has(e.canvas)) return { action: 'remove', name: e.canvas };
  if (e.type !== 'change' || e.project !== project || !e.canvas) return { action: 'none' };
  if (isHidden(`canvas:${e.canvas}`)) return { action: 'none' };
  return { action: 'update', name: e.canvas, version: `${e.version}-${e.ts}`, isNew: !tiles.has(e.canvas), flash: e.source === 'agent' };
}

/** Auto-scroll to the changed tile unless the user scrolled in the last 3 s while following the project. */
export const shouldAutoScroll = (followMode: string, lastUserScroll: number, now: number): boolean => !(followMode === 'project' && now - lastUserScroll < 3000);
