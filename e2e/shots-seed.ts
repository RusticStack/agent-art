// Extra data for the documentation screenshots only (screenshots.spec.ts, @shots). Applied to the live
// e2e server through the CLI, after the shots that need the plain seed; the normal e2e run never calls it.
import { runBatch, runTool } from './cli.ts';

const done = new Set<string>();
/** Run fn once per workspace: skipped when this worker already did it or the probe finds the data (a
 *  restarted worker after a failed test). */
function once(key: string, probe: () => boolean, fn: () => void) {
  if (done.has(key)) return;
  if (!probe()) fn();
  done.add(key);
}
/** Is there a canvas with this name? (art_list: a probe that never fails, so no error entry in the timeline) */
const hasCanvas = (name: string) => (JSON.parse(runTool('art_list', {})).canvases as { name: string }[]).some((c) => c.name === name);

const PART_COLORS: Record<string, [string, string]> = {
  head: ['#d9a07a', '#7a4a33'], 'head:blink': ['#c8906c', '#7a4a33'], neck: ['#c08060', '#6b3d2a'],
  chest: ['#5e81ac', '#2e3a52'], torso: ['#4c6a94', '#2e3a52'], pelvis: ['#3b4252', '#1f242e'],
  upper_arm_f: ['#81a1c1', '#3b4b63'], forearm_f: ['#88c0d0', '#3b5a63'], hand_f: ['#d9a07a', '#7a4a33'],
  upper_arm_b: ['#4c566a', '#262b36'], forearm_b: ['#55606f', '#262b36'], hand_b: ['#a87a5c', '#5a3626'],
  thigh_f: ['#a3be8c', '#4a5e3a'], shin_f: ['#8fbc8f', '#3f5a3f'], foot_f: ['#bf616a', '#5e2a2f'],
  thigh_b: ['#6b7f5a', '#323d29'], shin_b: ['#5f7a5f', '#2d3a2d'], foot_b: ['#8c4a50', '#3e1f22'],
  cape: ['#b48ead', '#4f3a4c'], gear_back: ['#d08770', '#5e3a2f'], gear_hip: ['#ebcb8b', '#6b5a35'], weapon: ['#3b4252', '#15171c'],
};

/** An 8-direction HD rig ("trooper", 64×96) with drawn parts and a 6-frame walk in every view, plus its spritesheet export. */
export function seedTrooper() {
  once('trooper', () => hasCanvas('trooper'), () => {
    const out = runTool('art_rig', { action: 'create', name: 'trooper', template: 'humanoid_hd', frame: [64, 96] });
    const created = JSON.parse(out.slice(out.indexOf('{')));
    const rows: Record<string, number> = created.cells.rows;
    const parts: Record<string, [number, number, number]> = created.cells.parts;
    const commands = Object.values(rows).flatMap((y) => Object.entries(parts).map(([name, [x, w, h]]) => {
      const [fill, line] = PART_COLORS[name] ?? ['#7a8699', '#2e3440'];
      return { op: 'rect', x, y, w, h, color: fill, outline: line };
    }));
    runTool('art_draw', { canvas: created.parts_canvas, layer: 'parts', commands });
    for (const view of ['side', 'front_side', 'front', 'back_side', 'back', 'side_left', 'front_side_left', 'back_side_left']) {
      runTool('art_rig', { action: 'animate', name: 'trooper', preset: 'walk', view, frames: 6 });
    }
    runTool('art_animation', { canvas: 'trooper', action: 'export', format: 'spritesheet' });
  });
}

/** Retire-able assets for the cleanup shots: a superseded canvas with an export, an orphan, an old variant. */
export function seedCleanup() {
  once('cleanup', () => hasCanvas('helmet_old'), () => {
    runTool('art_create_canvas', { name: 'helmet_old', width: 24, height: 24, project: 'severance' });
    runTool('art_draw', { canvas: 'helmet_old', commands: [{ op: 'ellipse', x: 4, y: 3, w: 16, h: 18, color: '#4a5568' }, { op: 'rect', x: 6, y: 11, w: 12, h: 3, color: '#1b1f2a' }] });
    runTool('art_export', { canvas: 'helmet_old', path: 'helmet_old.png' });
    runTool('art_graph', { action: 'link', from: 'helmet_front', rel: 'replaces', to: 'helmet_old' });
    runTool('art_create_canvas', { name: 'pauldron_v1', width: 16, height: 16, project: 'severance' });
    runTool('art_draw', { canvas: 'pauldron_v1', commands: [{ op: 'ellipse', x: 2, y: 4, w: 12, h: 8, color: '#4a5568' }] });
    runTool('art_graph', { action: 'link', from: 'pauldron', rel: 'replaces', to: 'pauldron_v1' });
    runTool('art_create_canvas', { name: 'visor_wip', width: 8, height: 8 });
    runTool('art_draw', { canvas: 'visor_wip', commands: [{ op: 'rect', x: 1, y: 3, w: 6, h: 2, color: '#38bdf8' }] });
    runTool('art_create_canvas', { name: 'decal_test', width: 8, height: 8 });
    runTool('art_draw', { canvas: 'decal_test', commands: [{ op: 'rect', x: 3, y: 1, w: 2, h: 6, color: '#e5484d' }] });
  });
}

/** Move a few assets to the trash through the agent's side (art_cleanup plan + apply), in two batches. */
export function trashSome() {
  once('trash', () => !hasCanvas('decal_test'), () => {
    for (const select of [['decal_test'], ['visor_wip', 'pauldron_v1']]) {
      const plan = runTool('art_cleanup', { action: 'plan', select: { names: select }, include_exports: true });
      const id = plan.match(/"plan_id":\s*"([^"]+)"/)?.[1];
      if (!id) throw new Error(`cleanup plan: no plan id in ${plan.slice(0, 300)}`);
      runTool('art_cleanup', { action: 'apply', plan_id: id, confirm: true });
    }
  });
}

/** 300 extra 8×8 canvases in a second project ("props"), in one `agent-art batch` call (19, 32). */
export function seedManyCanvases() {
  once('many', () => hasCanvas('prop_299'), () => {
    const items = [
      { op: 'project_create', args: { name: 'props', description: 'Bulk test props' } },
      ...Array.from({ length: 300 }, (_, i) => ({ op: 'create', args: { name: `prop_${String(i).padStart(3, '0')}`, width: 8, height: 8, project: 'props' } })),
    ];
    const out = runBatch(items);
    if (/FAILED/.test(out)) throw new Error(`batch: ${out.split('\n').filter((l) => /FAILED/.test(l)).slice(0, 3).join('\n')}`);
  });
}
