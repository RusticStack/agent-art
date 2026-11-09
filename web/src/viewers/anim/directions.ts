// Pure direction logic for the animation player (unit-tested): compass names, grouping the tags of one
// animation by view ("walk", "walk_front", "walk_back", ...) and the cell layout of the per-view grid.

export type CompassDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const COMPASS: Record<CompassDir, string[]> = {
  n: ['back', 'north', 'up', 'n'], s: ['front', 'south', 'down', 's'], e: ['side', 'right', 'east', 'e'], w: ['side_left', 'left', 'west', 'w'],
  ne: ['back_side', 'back_right', 'ne'], nw: ['back_side_left', 'back_left', 'nw'], se: ['front_side', 'front_right', 'se'], sw: ['front_side_left', 'front_left', 'sw'],
};
/** Index of each compass direction in a 3x3 grid (4 = centre). */
export const SLOT: Record<string, number> = { nw: 0, n: 1, ne: 2, w: 3, e: 5, sw: 6, s: 7, se: 8 };
/** Every built-in view name, longest first (so "front_side_left" wins over "left"). */
export const ALL_VIEWS: string[] = Object.values(COMPASS).flat().sort((a, b) => b.length - a.length);

export function compassOf(view: string | undefined): CompassDir | undefined {
  if (!view) return undefined;
  return (Object.keys(COMPASS) as CompassDir[]).find((k) => COMPASS[k].includes(view));
}

/** Group tags by base animation: {base: {view: tag}} (views from the rig, else the compass names). */
export function directionGroups(tags: string[], views: string[] | null, firstView: string | null): Map<string, Record<string, string>> {
  const known = views?.length ? [...views].sort((a, b) => b.length - a.length) : ALL_VIEWS;
  const groups = new Map<string, Record<string, string>>();
  for (const t of tags) {
    let base = t, view: string | null = firstView || null;
    for (const v of known) if (t.endsWith('_' + v)) { base = t.slice(0, -v.length - 1); view = v; break; }
    let g = groups.get(base);
    if (!g) groups.set(base, (g = {}));
    g[view || 'default'] = t;
  }
  return groups;
}

export interface AnimCellSpec { tag: string; label: string; view?: string }
export interface AnimLayout {
  cells: AnimCellSpec[];
  /** 3x3 compass layout (cells placed by SLOT). */
  compass: boolean;
  /** Base animation name when several views are shown (for the centre of the compass). */
  base?: string;
  cols: number;
  rows: number;
}

/** Cells to play for the selected tag: one, or every view of the same animation when the grid is on. */
export function layoutFor(tag: string, tags: string[], views: string[] | null, firstView: string | null, grid: boolean): AnimLayout {
  let cells: AnimCellSpec[] = [{ tag, label: tag || 'all frames' }];
  let compass = false;
  let base: string | undefined;
  if (tag && grid) {
    const groups = directionGroups(tags, views, firstView);
    const hit = [...groups.entries()].find(([, v]) => Object.values(v).includes(tag));
    if (hit && Object.keys(hit[1]).length > 1) {
      base = hit[0];
      cells = Object.entries(hit[1]).map(([view, t]) => ({ tag: t, label: view === 'default' ? t : view, view }));
      compass = cells.every((x) => compassOf(x.view)) && cells.length >= 3;
    }
  }
  const cols = compass ? 3 : Math.min(cells.length, 4);
  const rows = compass ? 3 : Math.ceil(cells.length / cols);
  return { cells, compass, base, cols, rows };
}

/** The 9 grid positions of a compass layout: index of the cell in each slot, or null. */
export function compassSlots(cells: AnimCellSpec[]): (number | null)[] {
  const slots: (number | null)[] = Array(9).fill(null);
  cells.forEach((c, i) => { const d = compassOf(c.view); if (d) slots[SLOT[d]] = i; });
  return slots;
}
