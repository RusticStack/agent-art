// The seed workspace every e2e spec runs against. Applied through the CLI before the server starts.
import { runTool } from './cli.ts';

const box = (x: number, y: number, w: number, h: number, color: string) => ({ op: 'rect', x, y, w, h, color });
const oval = (cx: number, cy: number, rx: number, ry: number, color: string) => ({ op: 'ellipse', x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, color });
// hero rig part cells on hero_parts: [x, w, h] per part, one band per view (from art_rig create)
const HERO_ROWS: Record<string, number> = { side: 0, front: 11, back: 22 };
const HERO_PARTS: [string, number, number, number, string][] = [['leg_b', 0, 4, 9, '#3b4252'], ['arm_b', 5, 4, 9, '#4c566a'], ['body', 10, 10, 9, '#5e81ac'], ['leg_f', 21, 4, 9, '#434c5e'], ['head', 26, 13, 10, '#d08770'], ['head:blink', 40, 13, 10, '#c07060'], ['arm_f', 54, 4, 9, '#81a1c1']];
const heroCells = Object.values(HERO_ROWS).flatMap((y) => HERO_PARTS.map(([, x, w, h, c]) => box(x, y, w, h, c)));

export const SEED: { tool: string; args: Record<string, unknown>; fails?: boolean }[] = [
  { tool: 'art_project', args: { action: 'create', name: 'severance', description: 'Sci-fi armour set', palette: { k: '#1b1f2a', g: '#4a5568', r: '#e5484d', o: '#f5a524' }, notes: 'Chunky silhouettes, 1 px dark outline.' } },
  { tool: 'art_create_canvas', args: { name: 'helmet_front', width: 24, height: 24, project: 'severance' } },
  { tool: 'art_draw', args: { canvas: 'helmet_front', commands: [oval(12, 12, 9, 10, '#4a5568'), box(6, 11, 12, 4, '#1b1f2a'), box(7, 12, 10, 2, '#38bdf8')] } },
  { tool: 'art_layer', args: { canvas: 'helmet_front', action: 'add', name: 'decals' } },
  { tool: 'art_draw', args: { canvas: 'helmet_front', commands: [box(11, 3, 2, 6, '#e5484d')] } },
  { tool: 'art_create_canvas', args: { name: 'helmet_side', width: 24, height: 24, project: 'severance' } },
  { tool: 'art_draw', args: { canvas: 'helmet_side', commands: [oval(12, 12, 8, 10, '#4a5568'), box(14, 11, 6, 4, '#1b1f2a')] } },
  { tool: 'art_layer', args: { canvas: 'helmet_side', action: 'add', name: 'decals' } },
  { tool: 'art_draw', args: { canvas: 'helmet_side', commands: [box(8, 4, 2, 5, '#e5484d')] } },
  { tool: 'art_create_canvas', args: { name: 'scratch', width: 8, height: 8 } },
  { tool: 'art_create_canvas', args: { name: 'pauldron', width: 16, height: 16, project: 'severance' } },
  { tool: 'art_draw', args: { canvas: 'pauldron', commands: [oval(8, 8, 7, 5, '#4a5568'), box(3, 7, 10, 2, '#f5a524')] } },
  { tool: 'art_create_canvas', args: { name: 'spark', width: 16, height: 16, frames: 4 } },
  { tool: 'art_draw', args: { canvas: 'spark', commands: [0, 1, 2, 3].flatMap((f) => [{ ...oval(8, 8, 2 + f, 2 + f, '#f5a524'), frame: f }, { ...box(7, 1 + f, 2, 2, '#ffd28a'), frame: f }]) } },
  { tool: 'art_animation', args: { canvas: 'spark', action: 'tag', name: 'spin', from: 0, to: 3, duration: 100 } },
  { tool: 'art_rig', args: { action: 'create', name: 'hero', template: 'humanoid', frame: [32, 32] } },
  { tool: 'art_draw', args: { canvas: 'hero_parts', layer: 'parts', commands: heroCells } },
  { tool: 'art_rig', args: { action: 'animate', name: 'hero', preset: 'walk', view: 'side' } },
  { tool: 'art_rig', args: { action: 'animate', name: 'hero', preset: 'walk', view: 'front' } },
  { tool: 'art_rig', args: { action: 'animate', name: 'hero', preset: 'walk', view: 'back' } },
  { tool: 'art_model', args: { action: 'create', name: 'rifle', template: 'fp_rifle' } },
  { tool: 'art_audio', args: { action: 'sfx', name: 'rifle_shot', recipe: 'click', seed: 1 } },
  { tool: 'art_export', args: { canvas: 'helmet_front', path: 'helmet_front.png' } },
  { tool: 'art_animation', args: { canvas: 'spark', action: 'export', format: 'spritesheet' } },
  { tool: 'art_graph', args: { action: 'group', name: 'Severance armour', members: ['helmet_front', 'helmet_side', 'pauldron'], note: 'Everything the armour set needs' } },
  { tool: 'art_graph', args: { action: 'link', from: 'helmet_side', rel: 'variant_of', to: 'helmet_front' } },
  { tool: 'art_graph', args: { action: 'tag', node: 'helmet_front', add: ['armour', 'hero'] } },
  { tool: 'art_graph', args: { action: 'note', node: 'pauldron', note: 'Left shoulder; mirror for the right.' } },
  { tool: 'art_review', args: { action: 'add', asset: 'helmet_side', note: 'Visor line should match the front view', category: 'inconsistent', region: [12, 11, 5, 3], compare_with: 'helmet_front' } },
];

/** Run against the live server once it is up (the activity log is in memory): timeline entries, one error. */
export const LIVE_SEED: { tool: string; args: Record<string, unknown>; fails?: boolean }[] = [
  { tool: 'art_draw', args: { canvas: 'helmet_side', commands: [box(15, 12, 4, 2, '#38bdf8')] } },
  { tool: 'art_draw', args: { canvas: 'spark', commands: [{ ...box(0, 0, 1, 1, '#ffffff'), frame: 0 }] } },
  // one failing op, so the timeline has an error entry
  { tool: 'art_draw', args: { canvas: 'no_such_canvas', commands: [box(0, 0, 1, 1, '#fff')] }, fails: true },
];

export function seed(home: string, port: number, list = SEED, log: (s: string) => void = () => {}) {
  for (const s of list) {
    try {
      log(`${s.tool} ${JSON.stringify(s.args).slice(0, 80)}\n${runTool(s.tool, s.args, { home, port }).slice(0, 400)}\n`);
      if (s.fails) throw new Error(`seed: ${s.tool} was expected to fail`);
    } catch (e) {
      if (!s.fails) throw e;
    }
  }
}
