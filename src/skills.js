// Skills: step-by-step recipes with concrete, copyable command batches. Weaker models do far
// better adapting a worked example than composing from a reference. Served via art_help
// {skill}, as MCP prompts, and as Claude Code / agent skill files (skills/<name>/SKILL.md).
import { AUDIO_SKILLS } from './audio/docs.js';

const J = (o) => JSON.stringify(o);

export const SKILLS = {
  'tileable-texture': {
    title: 'Tileable block/floor texture (stone, cobble, dirt, wood, metal)',
    when: 'Any seamless texture: Minecraft blocks, RPG floor/wall tiles.',
    body: `1. Canvas + ramp (4-5 shades, hue-shifted):
   art_create_canvas ${J({ name: 'cobble', width: 16 })}
   art_palette ${J({ canvas: 'cobble', action: 'ramp', base: '#8a8a94', steps: 5, prefix: 's' })}
2. Surface in ONE command (pick by material):
   - stone/cobble: ${J({ op: 'cells', colors: ['s0', 's1', 's2', 's3', 's4'], gap_color: '#2e2c36', size: 5, seed: 3 })}
   - bricks: ${J({ op: 'cells', colors: ['b1', 'b2', 'b3'], gap_color: '#3a2a28', size: 4, stretch: 2, layout: 'brick', jitter: 0, profile: 'flat', depth: 1 })}
   - dirt/sand: ${J({ op: 'noise', colors: ['d1', 'd2', 'd3'], weights: [0.3, 0.5, 0.2], scale: 3, despeckle: 1 })} then ${J({ op: 'scatter', colors: ['d4'], density: 0.03 })}
   - planks: rect bands per plank (h 4), ${J({ op: 'bevel', light: 'w3', dark: 'w0' })} per band, a few line grain marks.
3. Hand details with grid (cracks, moss, highlights) — few and deliberate.
4. art_critique ${J({ canvas: 'cobble' })} -> fix tiling_seam / orphan_pixels / noisy, then art_view ${J({ canvas: 'cobble', tile: 3 })}.
5. Variants: art_canvas duplicate + art_draw remap of the ramp.`,
  },
  'sprite': {
    title: 'Character / item / monster sprite',
    when: 'A single sprite (hero, enemy, item icon, prop).',
    body: `1. Size (16/24/32/48) and ramps: one 4-5 shade ramp per material (skin, cloth, metal) + one dark outline color (hue-shifted, not black).
2. Flat silhouette, one mid color per part (head, body, limbs, gear) with rect/ellipse/polygon/grid. Keep it chunky: thin 1px limbs vanish.
3. Form shading per part, one light (top-left):
   ${J({ op: 'shade', colors: ['r0', 'r1', 'r2', 'r3', 'r4'], of: 'r2' })}  (or per_color:true over the whole sprite when each part has its own flat color — then remap each part to its ramp)
4. ${J({ op: 'outline', color: '#2a1a22' })}  (outer). Optional: inner lines between parts with grid.
5. Face/details by hand with grid rows: eyes (2px), highlight pixels on metal, belt, buttons.
6. art_critique ${J({ canvas: 'hero' })} (pillow_shading, weak_outline, orphan_pixels, too_many_colors) -> fix -> art_view.
Multiple views or animations of this sprite -> use the "rig" skill so it stays identical.`,
  },
  'rig': {
    title: 'Consistent character: views (front/side/back) + animations from one rig',
    when: 'A character/creature needed in several directions or animations (walk, idle, attack) — keeps it the SAME everywhere.',
    body: `Fast path (any humanoid, blob/slime, bat/bird): a template is a starting point you can reshape:
   art_rig ${J({ action: 'create', name: 'knight', frame: [32, 32], template: 'humanoid', parts: { head: { w: 12, h: 10 }, cape: { w: 8, h: 12, pivot: [4, 0], parent: 'body', at: [-2, -6], z: -4 } } })}
   draw every listed cell (step 2), art_rig preview, then one call per animation:
   art_rig ${J({ action: 'animate', name: 'knight', preset: 'walk', view: 'side' })}  (override any field: frames, fps, keys, loop)
High-detail character (64x96 .. 160x240, 8 directions, bending elbows/knees, IK, cape follow-through):
   art_rig ${J({ action: 'create', name: 'soldier', frame: [128, 192], template: 'humanoid_hd' })}
   draw every cell in all 5 drawn views, then one call per preset and view (one canvas each: a frame strip is at most 8192 px tall):
   art_rig ${J({ action: 'animate', name: 'soldier', preset: 'walk', view: 'front_side', canvas: 'soldier_walk_front_side' })}  (presets: idle walk run crouch_walk aim shoot reload hurt death throw blink)
   Fix one view only: art_rig ${J({ action: 'pose', name: 'soldier', pose: 'aim', merge: true, views: { front: { head: { rot: 0 } } } })}; hands on props with ik:{hand_b:{target:{part:'weapon', at:[14,-2]}, bend:-1}}.
Custom rig (anything else: quadrupeds, vehicles, props with moving parts):
1. Create the rig (parts are drawn once per view; frames are generated from them):
   art_rig ${J({ action: 'create', name: 'knight', frame: [32, 32], views: ['side', 'front', 'back'], parts: { body: { w: 12, h: 12, pivot: [6, 10] }, head: { w: 12, h: 12, pivot: [6, 11], parent: 'body', at: [0, -9] }, arm_f: { w: 5, h: 9, pivot: [2, 1], parent: 'body', at: [2, -8], z: 2 }, arm_b: { w: 5, h: 9, pivot: [2, 1], parent: 'body', at: [-2, -8], z: -1 }, leg_f: { w: 5, h: 8, pivot: [2, 1], parent: 'body', at: [1, 0], z: 1 }, leg_b: { w: 5, h: 8, pivot: [2, 1], parent: 'body', at: [-2, 0], z: -2 } }, root: [16, 22] })}
2. The reply (and art_rig info) lists each part cell [x,y,w,h] on the "<name>_parts" canvas per view. Draw every part in every view there with art_draw (flat colors -> shade -> outline), using the SAME palette keys. Pivot (red dot) = the joint. Mirror views (mirror:{side_left:"side"}) are generated, not drawn.
3. Key poses (offset px and rotation degrees per part, relative to the rest pose):
   art_rig ${J({ action: 'pose', name: 'knight', pose: 'walk_contact', parts: { leg_f: { rot: -25 }, leg_b: { rot: 25 }, arm_f: { rot: 20 }, arm_b: { rot: -20 } } })}
   art_rig ${J({ action: 'pose', name: 'knight', pose: 'walk_pass', parts: { body: { y: -1 }, leg_f: { rot: 5 }, leg_b: { rot: -5 } } })}
4. Animate (tweened in-betweens, any fps):
   art_rig ${J({ action: 'animate', name: 'knight', animation: 'walk', view: 'side', keys: [{ pose: 'walk_contact' }, { pose: 'walk_pass' }, { pose: 'walk_contact', mirror_pairs: true }, { pose: 'walk_pass' }], frames: 8, fps: 10, loop: true, plant_feet: true })}
5. art_rig preview {name} (all views + a pose) and art_critique on the output canvas (volume_drift, ground_line). Export with art_animation export.`,
  },
  'walk-cycle': {
    title: 'Walk cycle without a rig (frame-by-frame)',
    when: 'Quick hand-drawn animation of an existing sprite.',
    body: `1. art_animation ${J({ canvas: 'hero', action: 'insert', count: 3, copy_from: 0 })}  -> 4 identical frames to edit.
2. Poses: 0 contact (legs apart), 1 down (body 1px lower), 2 contact mirrored, 3 up (body 1px higher). Only redraw legs/arms per frame: art_draw {frame:N, commands:[clear the leg area, grid new legs]}.
3. Keep head/torso pixels identical (copy from_frame 0) and the feet on the same ground row.
4. art_animation ${J({ canvas: 'hero', action: 'tag', name: 'walk', from: 0, to: 3, duration: 120 })}; check art_view {frame, onion:1} and art_critique (volume_drift, ground_line).
For 8+ frames or several directions use the rig skill.`,
  },
  'iso-scene': {
    title: 'Isometric scene (tactics map, room, courtyard)',
    when: '2:1 pixel isometric dioramas.',
    body: `1. Canvas e.g. 160x120 with a background gradient; origin = top vertex of cell 0,0 (e.g. [80,24]), tile 32.
2. Floor back to front: ${J({ op: 'iso_tile', at: [0, 0, 0], tile: 32, origin: [80, 24], color: '#6a7a5a', outline: '#2a3326', inset: 1 })} for each cell (increasing gx+gy).
3. Blocks/props back to front: ${J({ op: 'iso_box', at: [1, 1, 0], tile: 32, origin: [80, 24], height: 16, top: '#b89a72', outline: '#3a2a20', edge: '#e0c79c' })}; small props with w:16 anchor:"center".
4. Texture faces with mask:<face color> (noise/scatter/grid), props as separate canvases stamped with copy from_canvas.
5. Light layer: art_layer add {blend:"screen"} + light / glow; shadows with cast_shadow or a multiply layer.
6. art_layer stamp_visible + quantize; art_critique {kind:"scene"}.`,
  },
  'hd2d-scene': {
    title: '2.5D / HD-2D scene (parallax layers, light, fog)',
    when: 'Backgrounds, title screens, atmospheric scenes.',
    body: `1. Layers bottom->top: sky (gradient), far (silhouettes, low contrast, bluish), mid, play, foreground. art_layer add {position:"top"} each.
2. Far layers: shapes + adjust lightness/saturation down; blur radius 1 optional.
3. Light: layer blend "screen": rays from the light source, light at lamps/windows; shadows: layer blend "multiply".
4. fog {direction:"up", to:0.4, steps:0} between far and mid layers; glow {gain:3} on emissive pixels.
5. art_layer stamp_visible -> quantize {dither:"bayer"} on the stamp -> vignette.
6. art_critique {kind:"scene"}, art_view.`,
  },
  'minecraft-pack': {
    title: 'Minecraft resource pack',
    when: 'Making block/item textures for a Minecraft Java version.',
    body: `1. art_project create {name, meta:{minecraft:"1.12.2", pack:"my-pack"}, palette, notes (style rules)}.
2. art_minecraft vanilla {version:"1.12.2", filter:"stone|planks"} -> real names/sizes (1.12: blocks/planks_oak; 1.13+: block/oak_planks).
3. One canvas per texture with meta.texture (e.g. "blocks/stone"), using the tileable-texture skill; animated ones with frames + meta.frametime.
4. Grass/leaves: grayscale + meta.tint for previews.
5. Review the whole set: art_sheet {project, tile:3}. Then art_minecraft build {project}.`,
  },
  '3d-kit': {
    title: 'HD-2D 3D environment kit (modular pieces -> .glb) and props',
    when: 'Map environments for a 3D game in the HD-2D look (pixel textures on low-poly meshes): floors, walls, arches, stairs, ruins, dioramas; also extruded/lathed props.',
    body: `1. Tileable textures at the game density (32 px = 1 unit = one grid cell), using the tileable-texture skill:
   art_create_canvas ${J({ name: 'stone', width: 32 })}  -> cells/noise, check art_view tile:3.  Also e.g. "floor_tile", "cap" (wall top), "grime" (mostly transparent dirt for overlays), "crack" (a transparent canvas with painted cracks = holes mask).
2. One model per kit piece (pieces snap on the 32 px grid; textures repeat at 1 texel = 1 px so neighbours line up):
   art_model ${J({ action: 'create', name: 'wall_a', parts: [{ type: 'wall', w: 32, h: 64, d: 8, texture: { canvas: 'stone', overlay: 'grime' }, top: 'cap' }], preview: true })}
   art_model ${J({ action: 'create', name: 'arch_a', parts: [{ type: 'arch', span: 24, spring: 20, d: 8, texture: 'stone' }] })}
   art_model ${J({ action: 'create', name: 'floor_a', parts: [{ type: 'floor', texture: 'floor_tile' }] })}
   Ruined variants: ${J({ type: 'wall', texture: 'stone', broken: { amount: 24, step: 4, seed: 3 }, holes: 'crack' })}, arch with broken:true, plus ${J({ type: 'rubble', count: 10, texture: 'stone', at: [0, 0, 12] })}.
   Others: corner, pillar, column, vault, stairs {steps, rise, run, tread}, ledge, balustrade, roof {style: gable|shed}. Ships/vehicles: wedge, box taper|bevel|insets, cone, loft {scale_end}, mirror:"x", glass:true, origin:"bottom". art_help {topic:"3d"} lists every option.
3. Look: art_model ${J({ action: 'preview', name: 'wall_a' })} (game = the 38° game camera, plus front/side/top/iso). Iterate with update ${J({ action: 'update', name: 'wall_a', set: { 0: { h: 96 } } })}.
4. Export each piece: art_model ${J({ action: 'export', name: 'wall_a' })} -> exports/wall_a.glb + wall_a.meta.json. Z-up engine: object.rotation.x = Math.PI/2, or up:"z".
5. Diorama section from placed pieces (cell = grid coords, turn = 90° steps):
   art_model ${J({ action: 'create', name: 'crypt_a', parts: [{ type: 'model', model: 'floor_a', array: { count: 4, cell_step: [1, 0, 0] } }, { type: 'model', model: 'wall_a', cell: [0, 0, -1] }, { type: 'model', model: 'arch_a', cell: [1, 0, -1] }] })}
   preview {views:["game"], size:512}; export bakes one .glb (instances:true = shared meshes + nodes). UVs are computed in world space after placement, so the stone continues across every piece.
6. Connected textures (CTM) and decay:
   Marble floor groups: art_model ${J({ action: 'ctm', name: 'marble_ctm', ctm: { base: 'marble', method: 'full', border: { width: 2, style: 'bevel' } } })} then floors use texture:"marble_ctm" (border only around each connected group).
   Wall trims: ctm {base:"trim", method:"horizontal"} on a ledge run; random {weights:[6,1,1], variants:[...]} for cracked blocks; repeat (base 96x64 = 3x2 cells) for big slab patterns.
   Moss / grime / wear: ${J({ type: 'wall', texture: 'stone', overlays: [{ texture: 'grime', where: ['bottom', 'corners'], falloff: 20 }, { texture: 'moss', where: 'top', falloff: 10 }] })} (own UV set, cut out by strength).
Props: extrude ${J({ type: 'extrude', canvas: 'barrel', depth: 6 })}; relief: depth_map:"<height canvas>"; lathe ${J({ type: 'lathe', canvas: 'candle', segments: 12 })} (draw the RIGHT half from x=0; flame on an "emissive" layer).
Keep pieces light (< 500 tris), reuse a few textures, characters stay 2D billboards.`,
  },
  'ui-icons': {
    title: 'UI icons / item icons set',
    when: 'Inventory icons, ability icons, HUD elements.',
    body: `1. Project with a shared palette; 16x16 or 24x24 canvases, 1px transparent margin.
2. Same light direction, outline color and ramp structure for every icon (consistency beats detail).
3. Silhouette -> shade -> outline -> one bright highlight pixel cluster.
4. art_sheet {project} to compare the set; art_critique each.`,
  },
};

Object.assign(SKILLS, AUDIO_SKILLS);

export function skillText(name) {
  const s = SKILLS[name];
  if (!s) throw new Error(`Unknown skill "${name}". Skills: ${Object.keys(SKILLS).join(', ')}`);
  return `# ${s.title}\nWhen: ${s.when}\n\n${s.body}`;
}

/** SKILL.md file content (Claude Code / Agent Skills format) for a skill. */
export function skillFile(name) {
  const s = SKILLS[name];
  return `---\nname: agent-art-${name}\ndescription: ${s.title}. ${s.when} Uses the Agent Art MCP tools (art_*).\n---\n\n${skillText(name)}\n`;
}
