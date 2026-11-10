// Skills: step-by-step recipes with concrete, copyable command batches. Weaker models do far
// better adapting a worked example than composing from a reference. Served via art_help
// {skill}, as MCP prompts, and as Claude Code / agent skill files (agent-art skills --out DIR
// writes DIR/agent-art-<name>/SKILL.md). `desc` is the frontmatter description: what the skill
// makes and when to use it, with the words an agent harness matches on.
import { AUDIO_SKILLS } from './audio/docs.js';
import { PLANET_SKILLS } from './space/docs.js';
import { FX_SKILLS } from './fx/docs.js';

const J = (o) => JSON.stringify(o);

export const SKILLS = {
  'tileable-texture': {
    title: 'Tileable block/floor texture (stone, cobble, dirt, wood, metal)',
    when: 'Any seamless texture: Minecraft blocks, RPG floor/wall tiles.',
    desc: 'Makes seamless, tileable pixel-art textures (stone, cobble, bricks, dirt, sand, planks, metal) with Agent Art. Use when asked for a tileable or seamless texture, a Minecraft block texture, or RPG floor and wall tiles.',
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
    desc: 'Draws one pixel-art sprite (hero, enemy, monster, item, prop) with palette ramps, form shading and an outline in Agent Art. Use for a single sprite or icon-sized character; for several views or animations use agent-art-rig.',
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
    desc: 'Builds a rigged pixel-art character or creature (humanoid, blob, flyer or custom) whose parts are drawn once and tweened into side, front and back views and animations (walk, idle, attack, jump, death). Use whenever a sprite needs more than one direction or frame.',
    body: `Fast path (any humanoid, blob/slime, bat/bird): a template is a starting point you can reshape:
   art_rig ${J({ action: 'create', name: 'knight', frame: [32, 32], template: 'humanoid', parts: { head: { w: 12, h: 10 }, cape: { w: 8, h: 12, pivot: [4, 0], parent: 'body', at: [-2, -6], z: -4 } } })}
   draw every listed cell (step 2), art_rig preview, then one call per animation:
   art_rig ${J({ action: 'animate', name: 'knight', preset: 'walk', view: 'side' })}  -> tag "walk_side" on canvas "knight" (preset tags are always <preset>_<view>; animation:"<name>" picks your own; override any field: frames, fps, keys, loop)
High-detail character (64x96 .. 160x240, 8 directions, IK, foot planting, follow-through): use the "rig-hd" skill (template:"humanoid_hd").
Custom rig (anything else: quadrupeds, vehicles, props with moving parts):
1. Create the rig (parts are drawn once per view; frames are generated from them):
   art_rig ${J({ action: 'create', name: 'knight', frame: [32, 32], views: ['side', 'front', 'back'], parts: { body: { w: 12, h: 12, pivot: [6, 10] }, head: { w: 12, h: 12, pivot: [6, 11], parent: 'body', at: [0, -9] }, arm_f: { w: 5, h: 9, pivot: [2, 1], parent: 'body', at: [2, -8], z: 2 }, arm_b: { w: 5, h: 9, pivot: [2, 1], parent: 'body', at: [-2, -8], z: -1 }, leg_f: { w: 5, h: 8, pivot: [2, 1], parent: 'body', at: [1, 0], z: 1 }, leg_b: { w: 5, h: 8, pivot: [2, 1], parent: 'body', at: [-2, 0], z: -2 } }, root: [16, 22] })}
2. The reply (and art_rig info) lists the part cells on the "<name>_parts" canvas compactly: cells.rows = the y of each view's band, cells.parts = [x, w, h] per part, so a part's cell in a view is [x, rows[view], w, h] (full:true returns the complete JSON). Draw every part in every view there with art_draw (flat colors -> shade -> outline), using the SAME palette keys. Pivot (red dot) = the joint. Mirror views (mirror:{side_left:"side"}) are generated, not drawn.
3. Key poses (offset px and rotation degrees per part, relative to the rest pose):
   art_rig ${J({ action: 'pose', name: 'knight', pose: 'walk_contact', parts: { leg_f: { rot: -25 }, leg_b: { rot: 25 }, arm_f: { rot: 20 }, arm_b: { rot: -20 } } })}
   art_rig ${J({ action: 'pose', name: 'knight', pose: 'walk_pass', parts: { body: { y: -1 }, leg_f: { rot: 5 }, leg_b: { rot: -5 } } })}
4. Animate (tweened in-betweens, any fps):
   art_rig ${J({ action: 'animate', name: 'knight', animation: 'walk', view: 'side', keys: [{ pose: 'walk_contact' }, { pose: 'walk_pass' }, { pose: 'walk_contact', mirror_pairs: true }, { pose: 'walk_pass' }], frames: 8, fps: 10, loop: true, plant_feet: true })}
5. art_rig preview {name} (all views + a pose) and art_critique {canvas:"knight", animation:"walk"} (volume_drift, ground_line). Export with art_animation export.`,
  },
  'rig-hd': {
    title: 'High-detail character rig (humanoid_hd: 8 directions, per-view poses, IK, foot planting, follow-through)',
    when: 'Detailed characters at 64x96 .. 160x240 (late-90s pre-rendered look, shooters, action games) that need many smooth animations in several directions.',
    desc: 'Builds a high-detail humanoid_hd character rig (64x96 to 160x240, 8 directions) with per-view poses, two-bone IK, foot planting and cape follow-through. Use for detailed, pre-rendered-style or shooter characters with many smooth animations.',
    body: `1. Create from the template (sizes scale with the frame; cape/gear_hip follow-through, RotSprite sampling and scale_children are already on):
   art_rig ${J({ action: 'create', name: 'soldier', frame: [128, 192], template: 'humanoid_hd', secondary: { cape: { stiffness: 0.15, damping: 0.2, gravity: 0.5 } } })} (merged over the template's cape/gear_hip springs)
   Parts: pelvis (root), torso, chest, neck, head (+head:blink), upper_arm/forearm/hand and thigh/shin/foot _f (near) / _b (far), slots weapon (child of hand_f), gear_back, gear_hip, cape. Remove a slot with parts:{cape:null}.
2. Draw every cell in the 5 drawn views (side faces RIGHT, front_side, front, back_side, back) on "soldier_parts"; the _left views are mirrors. The reply gives cells.rows (band y per view) and cells.parts ([x, w, h]): a cell is [x, rows[view], w, h]. Pivot = joint at the top of each limb part; let limb cells overlap the joint a few px so bent knees and elbows stay closed. Draw *_b darker. Check: art_rig ${J({ action: 'preview', name: 'soldier', pose: 'walk_contact' })}
3. Presets, one canvas per preset and view (a frame strip is at most 8192 px tall):
   art_rig ${J({ action: 'animate', name: 'soldier', preset: 'walk', view: 'front_side', canvas: 'soldier_walk_front_side' })}
   presets: idle walk run crouch_walk aim shoot reload hurt death throw blink (planting, IK and secondary are set in them). Tags are <preset>_<view>: this one is "walk_front_side".
4. Fix a pose in one view only (merged over the base pose there; mirror views follow their source):
   art_rig ${J({ action: 'pose', name: 'soldier', pose: 'aim', merge: true, views: { front: { head: { rot: 0 } } } })}
   Forward swings in front/back views: override rot with sy foreshortening, e.g. views:{front:{thigh_f:{rot:0, sy:0.8}}}.
5. Two-bone IK in a pose or key: ik:{end:{target:[x,y] (frame px) | {part, at:[dx,dy]}, bend:1 (knees) | -1 (elbows), rot? (world rot of the end: keep a gun level), weight?}}:
   art_rig ${J({ action: 'pose', name: 'soldier', pose: 'brace', parts: { chest: { rot: -4 } }, ik: { hand_b: { target: { part: 'weapon', at: [20, -3] }, bend: -1 } } })}
6. Custom cycle with planted feet and follow-through:
   art_rig ${J({ action: 'animate', name: 'soldier', animation: 'patrol', view: 'side', keys: [{ pose: 'walk_contact' }, { pose: 'walk_pass' }, { pose: 'walk_contact', mirror_pairs: true }, { pose: 'walk_pass', mirror_pairs: true }], frames: 16, fps: 12, plant: true, secondary: true, canvas: 'soldier_patrol_side' })}
   plant:["foot_f"] picks feet; secondary:{gear_hip:{stiffness:0.4, damping:0.5}} inline uses only these springs for this call.
7. Limbs look jagged or change thickness: rig sampling "rotsprite" (default here) or "smooth"; art_rig update {name, sampling}. art_critique {canvas, animation} for drift, then art_animation export {format:"spritesheet"} (json:false skips the sidecar). Guide: docs/rig-hd-guide.md, art_help {topic:"rig"}.
Armed characters: use the "weapon-handling" skill (hands on grips in every frame and view, carry states, validation).`,
  },
  'weapon-handling': {
    title: 'Characters holding guns: grips, carry states, reach, dead zone, validation (2D rigs and FP arms)',
    when: 'Any character sprite or first-person arms holding a rifle, SMG, shotgun, DMR, LMG or pistol, including attachments (vertical / angled grip, bipod, suppressor), in every direction and animation.',
    desc: 'Makes characters hold guns correctly: both hands on the grips, carry states (aim, ready, sprint, reload, holster), reach, no clipping and draw order, with validation, for 2D rigs and first-person arms. Use for any armed character or viewmodel with a rifle, SMG, shotgun, pistol or attachments.',
    body: `2D characters (art_rig, humanoid_hd):
1. Create with the weapon declared (cell sized for the class; attachment cells added):
   art_rig ${J({ action: 'create', name: 'soldier', frame: [128, 192], template: 'humanoid_hd', weapon: { class: 'rifle', attachments: { vgrip: 'vertical_grip' } } })}
2. Draw the weapon and att_vgrip in the SIDE row only, pointing right (stock left, pistol grip ~30% in, handguard / muzzle right). The other views project that cell (canted outward with a length floor where the barrel points at the camera).
3. Check the hold: art_rig ${J({ action: 'preview', name: 'soldier', pose: 'idle_exhale', carry: 'aim' })} then art_rig ${J({ action: 'check', name: 'soldier' })} (every preset x 8 views: hands on grips, reach, elbows, penetration, muzzle, layering, visibility).
4. Animate as usual: presets carry the weapon (walk = ready_low, run = sprint, aim / shoot = aim with cheek weld (front view: short barrel canted toward the centre line), reload = mag out -> chest pouch -> mag in -> charging handle with events (draw the "mag" cell in the side row too), throw = slung, death drops it). Per call: carry:"ready_high", attach:[] (no attachment), variant:"heavy" (equipment set). animate refuses violating frames by default; constraints:"fix" auto-corrects, "warn" writes and reports.
5. Tune: weapon.points {grip_main:{at:[x,y], angle}, grip_support, stock, muzzle, optic, mag} in weapon-cell px; weapon.states {name:{base:"ready_low", angle:30}}; weapon.layer {pin:{side:"front"}} for draw order; art_rig ${J({ action: 'layers', name: 'soldier', preset: 'walk', frame: 3, view: 'side' })} / explain {part_a:"chest", part_b:"weapon"} to see why.
6. Left-handed beat or shoulder switch: key mirror_hands:true. mirror_pairs keeps the held hands on their side.
First-person (art_model):
1. art_model ${J({ action: 'create', name: 'ar', template: 'fp_rifle', weapon: { attach: ['vertical_grip'] } })} and create {name:"arms", template:"fp_arms"}.
2. art_model ${J({ action: 'render', name: 'arms', canvas: 'arms_aim', size: [160, 120], camera: 'fp', hold: { weapon: 'ar', carry: 'aim' } })} (hands on the grips, optic on the eye line); render the gun layer with hold:{arms:"arms", carry:"aim"} so both layers match.
3. art_model ${J({ action: 'check', name: 'arms', hold: { weapon: 'ar' } })} validates every clip x carry state; animate {name:"arms", clip:"reload_empty", hold:{weapon:"ar", carry:"reload", bake_weapon:"reload_empty_held"}} bakes held clips for glTF.`,
  },
  'anim-library': {
    title: 'Animation library: one skeleton + clip library, many skins, batch render to game strips + manifest',
    when: 'Several characters (factions, armour sets, body types) sharing the same motion set, or rendering a whole character roster for a game manifest.',
    desc: 'Authors motion once on a skeleton and renders it on many skins and loadouts (art_anim), batching game sprite strips and a characters manifest, with optional runtime gun layers. Use for a roster of characters that share a clip library, for retargeting, or for exporting every animation to a game.',
    body: `1. Skeleton (rig definition + the standard clips): art_anim ${J({ action: 'skeleton', name: 'hd', template: 'humanoid_hd', frame: [128, 192], weapon: { class: 'rifle' }, proportions: { heavy: { width: 1.15, spine: 1.04 }, lean: { width: 0.9, legs: 1.04 } } })}
2. One skin per character: art_anim ${J({ action: 'skin', name: 'mec', skeleton: 'hd', proportions: 'heavy' })} creates rig "mec" with cells sized for its proportions. Draw the cells (art_rig info {name:"mec"} lists them). Linked cells save work: parts.<p>.link:{back_side:"side"}; art_rig derive {name:"mec", from:"side", to:["front_side"]} copies a view to paint over.
3. Check the drawing before rendering: art_rig ${J({ action: 'consistency', name: 'mec' })} (views agree: palette, bone lengths, joints, silhouette) and art_rig ${J({ action: 'zcheck', name: 'mec' })} (no z-flicker, arm order agrees with depth).
4. New motion once for everyone: art_anim clip {skeleton:"hd", name:"walk_aim", layers:[{clip:"walk"}, {clip:"aim", mask:"upper"}]} (layers + masks), {name:"limp", layers:[{clip:"walk"}, {clip:"flinch", additive:true}]} (additive), events:[{t:0.5, name:"step"}]. Preview on a skin: art_anim ${J({ action: 'render', skin: 'mec', clip: 'walk_aim', view: 'front' })}.
5. Equipment: skin {equipment:{helmet:{variant:"helmet"}, pack:{part:"gear_back"}}, loadouts:{light:{equip:["helmet"]}, heavy:{equip:["helmet","pack"]}}}.
6. Ship it: art_anim ${J({ action: 'batch', skins: ['mec', 'sev'], loadouts: 'all', out: 'C:/game/public/assets', front: 'auto' })} -> characters/<set>/<clip>_<view>.png (+ __front), manifest/characters.json (frame grown by pad:"auto" to fit the barrel, anchor, events, per-frame draw order).
6b. Guns drawn by the game (runtime weapon layers): art_anim ${J({ action: 'batch', skins: ['mec'], out: 'C:/game/public/assets', weapon: 'runtime' })} (gun-free body + __front strips, per-frame sockets); one asset per gun: art_anim ${J({ action: 'weapon', name: 'ar', class: 'rifle', skin: 'mec' })} (draw it), conform {weapon:"ar"}, weapon_sheet {weapon:"ar", out} (weapons_world sheet + manifest), composite {skin:"mec", weapon:"ar", clip:"walk_aim", view:"front"} to see it, weapon_check {skin:"mec"} = hands on the grips of every rifle-class gun.
7. Other engines: art_anim gltf {skin:"mec", clips:["walk","reload"]} (skinned cutout mesh + animations). Another skeleton: art_anim retarget {clip:"walk", from:"hd", to:"hd_small"}.`,
  },
  'walk-cycle': {
    title: 'Walk cycle without a rig (frame-by-frame)',
    when: 'Quick hand-drawn animation of an existing sprite.',
    desc: 'Hand-animates a short frame-by-frame walk cycle for an existing pixel sprite without a rig. Use for a quick 4-frame walk or bob; for 8+ frames or several directions use agent-art-rig.',
    body: `1. art_animation ${J({ canvas: 'hero', action: 'insert', count: 3, copy_from: 0 })}  -> 4 identical frames to edit.
2. Poses: 0 contact (legs apart), 1 down (body 1px lower), 2 contact mirrored, 3 up (body 1px higher). Only redraw legs/arms per frame: art_draw {frame:N, commands:[clear the leg area, grid new legs]}.
3. Keep head/torso pixels identical (copy from_frame 0) and the feet on the same ground row.
4. art_animation ${J({ canvas: 'hero', action: 'tag', name: 'walk', from: 0, to: 3, duration: 120 })}; check art_view {frame, onion:1} and art_critique (volume_drift, ground_line).
For 8+ frames or several directions use the rig skill.`,
  },
  'iso-scene': {
    title: 'Isometric scene (tactics map, room, courtyard)',
    when: '2:1 pixel isometric dioramas.',
    desc: 'Builds a 2:1 isometric pixel-art scene (tactics map, room, courtyard) from iso tiles and boxes with light and shadow layers. Use when asked for an isometric map, diorama or iso tiles.',
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
    desc: 'Paints a layered 2.5D / HD-2D pixel-art scene: sky, parallax far / mid / foreground layers, light rays, fog, glow and vignette. Use for backgrounds, title screens and atmospheric scenes.',
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
    desc: 'Makes a Minecraft Java resource pack: textures under the real vanilla names and sizes, animated textures, and the built pack zip. Use when asked for Minecraft block or item textures or a resource pack.',
    body: `1. art_project create {name, meta:{minecraft:"1.12.2", pack:"my-pack"}, palette, notes (style rules)}.
2. art_minecraft vanilla {version:"1.12.2", filter:"stone|planks"} -> real names/sizes (1.12: blocks/planks_oak; 1.13+: block/oak_planks).
3. One canvas per texture with meta.texture (e.g. "blocks/stone"), using the tileable-texture skill; animated ones with frames + meta.frametime.
4. Grass/leaves: grayscale + meta.tint for previews.
5. Review the whole set: art_sheet {project, tile:3}. Then art_minecraft build {project}.`,
  },
  '3d-kit': {
    title: 'HD-2D 3D environment kit (modular pieces -> .glb) and props',
    when: 'Map environments for a 3D game in the HD-2D look (pixel textures on low-poly meshes): floors, walls, arches, stairs, ruins, dioramas; also extruded/lathed props.',
    desc: 'Builds a modular HD-2D 3D environment kit (floors, walls, arches, stairs, ruins, dioramas) and extruded or lathed props from pixel textures, exported as .glb. Use for low-poly 3D map pieces with pixel-art textures, connected textures (CTM) or moss and grime overlays.',
    body: `1. Tileable textures at the game density (32 px = 1 unit = one grid cell), using the tileable-texture skill:
   art_create_canvas ${J({ name: 'stone', width: 32 })}  -> cells/noise, check art_view tile:3.  Also e.g. "floor_tile", "cap" (wall top), "grime" (mostly transparent dirt for overlays), "crack" (a transparent canvas with painted cracks = holes mask).
2. One model per kit piece (pieces snap on the 32 px grid; textures repeat at 1 texel = 1 px so neighbours line up). Each new model is baked onto ONE atlas canvas <name>_uv (world-aligned texture + contact AO, edge wear, grime), so its parts read as one object; unwrap:false keeps per-part textures:
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
7. The atlas (column_a -> canvas column_a_uv): paint transitions on its "paint" layer (art_draw), or in a view: art_model ${J({ action: 'unwrap', name: 'column_a', unwrap: { do: 'view', view: 'front' } })} then do:"project". unwrap:{do:"check"} reports detached parts; art_model ${J({ action: 'unwrap', name: 'old_piece' })} converts a model saved before (or with unwrap:false). Layouts of placed models (step 5) keep per-part textures so pieces stay instanced.
Props: extrude ${J({ type: 'extrude', canvas: 'barrel', depth: 6 })}; relief: depth_map:"<height canvas>"; lathe ${J({ type: 'lathe', canvas: 'candle', segments: 12 })} (draw the RIGHT half from x=0; flame on an "emissive" layer).
Keep pieces light (< 500 tris), reuse a few textures, characters stay 2D billboards.`,
  },
  'ship-model': {
    title: 'Spaceship / vehicle 3D model (low-poly + pixel textures -> .glb)',
    when: 'Ships, fighters, dropships, cars, tanks, turrets, drones: standalone 3D models with hulls, wings, canopies, engines and panels.',
    desc: 'Models a low-poly spaceship or vehicle (lofted hull, wedges, cones, canopy, engines, inset panels, mirrored parts) with pixel textures and exports it as .glb. Use for ships, fighters, cars, tanks, drones or turrets as standalone 3D models.',
    body: `1. Textures: a tileable hull plate (32x32, cells/noise + panel lines) and small decals (an "emissive" layer for lights and engine glow):
   art_create_canvas ${J({ name: 'hull', width: 32 })}  -> tileable-texture skill.
2. Build with origin:"bottom" (centred, sits on y=0). Y-up, +z = nose, units px (32 px = 1 unit). mirror:"x" makes the other side:
   art_model ${J({ action: 'create', name: 'scout', origin: 'bottom', preview: true, parts: [
    { type: 'loft', points: [[-12, 0], [12, 0], [10, 10], [-10, 10]], d: 64, scale_end: [0.3, 0.4], texture: 'hull' },
    { type: 'wedge', w: 40, h: 3, d: 24, top_w: 8, shift: [16, 0], at: [14, 2, 0], mirror: 'x' },
    { type: 'cone', r: 3, h: 8, rotate: [90, 0, 0], at: [0, 5, 32] },
    { type: 'cylinder', r_bottom: 5, r_top: 4, h: 10, rotate: [-90, 0, 0], at: [10, 5, -32], mirror: 'x' },
    { type: 'box', w: 10, h: 6, d: 14, bevel: 2, glass: true, color: '#9fd8ff', at: [0, 10, 8] },
    { type: 'box', w: 6, h: 6, d: 6, at: [0, 0, -20], insets: [{ face: 'back', rect: [1, 1, 4, 4], depth: 3, texture: '#f80' }] }] })}
3. Pieces: loft (a shape whose far section is scaled by scale_end: hulls, fuselages), shape plane:"zy" (side profile [z,y], extruded along x), wedge (top_w, top_d:0 = ridge, shift:[x,z]: wings, fins, ramps), box taper:[sx,sy] (nose) | bevel:px | insets:[{face, rect:[u,v,w,h], depth}] (>0 recess: intakes, hatches; <0 raised panel; touching an edge = hangar mouth), only one of taper|bevel|insets per box. cylinder r_top/r_bottom (nozzles), cone, wrap:"once" + u_offset (turns) for a decal round a tank.
4. Transforms: scale, rotate:[x,y,z] (deg, X then Y then Z), turn, all about the part origin or pivot:[x,y,z] (hinges, wing roots), then at. Radial arrays: array:{count:6, rotate:[0,60,0], about:[0,0,0]} (engine rings, rotor blades). Canopies, visors, shields: glass:true or opacity:0..1 (glTF BLEND).
5. Look and iterate: art_model ${J({ action: 'preview', name: 'scout' })}, update {set:{0:{d:72}}} / add / remove. Keep it light (< 1000 tris). The ship is baked onto one atlas scout_uv (contact AO, edge wear; re-baked on update; glass keeps its material); unwrap:false = per-part textures.
6. Export: art_model ${J({ action: 'export', name: 'scout' })} -> exports/scout.glb (up:"z" for Z-up engines). Options and recipes: art_help {topic:"3d"}.`,
  },
  'hard-surface': {
    title: 'Hard-surface sci-fi detail: greebles, trim sheets, PBR, normals, baked AO, LODs + impostors (.glb)',
    when: 'Big-budget sci-fi look at a pixel-texture budget: ship hull sections, stations, carrier corridors, city blocks; anything that needs greebles, pipes, panel trims, metal/rough, contact shadows, and must stay fast in a browser.',
    desc: 'Adds sci-fi hard-surface detail to .glb models: greebles, pipes and cables, trim sheets, PBR metal / rough, pixel-correct height normals, baked AO, LODs, impostors and collision proxies. Use for hull sections, stations, corridors and city blocks that must look rich and stay fast in a browser.',
    body: `1. Textures with surface data layers (left out of the colour): a 32x32 hull plate with panel lines, then layers "height" (white = high: grooves black, rivets white), "metal" and "rough" (grey = value):
   art_create_canvas ${J({ name: 'hull', width: 32 })}; art_layer ${J({ canvas: 'hull', action: 'add', name: 'height' })} (and "metal", "rough") -> art_draw on each layer. Canvas-wide PBR instead of layers: art_canvas ${J({ canvas: 'hull', action: 'meta', meta: { material: 'painted_metal' } })}.
2. One trim sheet for edges, seams, pipes, hazard and light strips: art_model ${J({ action: 'trim', canvas: 'hull_trim' })} (or strips:{name:[y,h]} on your own sheet).
3. Hull section: art_model ${J({ action: 'create', name: 'hull_a', origin: 'bottom', parts: [
    { type: 'box', id: 'hull', w: 160, h: 40, d: 96, bevel: 3, texture: 'hull', material: 'painted_metal', trim: 'hull_trim:bevel', greebles: [{ face: 'top', seed: 11, grid: 2, density: 0.35, avoid: [[64, 0, 32, 96]] }, { face: 'right', seed: 12, density: 0.3, size: [2, 8], kinds: { vent: 3, pipe: 2, bolts: 2, panel: 3 } }] },
    { type: 'box', w: 52, h: 22, d: 30, at: [0, 0, 36], boolean: 'subtract', target: 'hull' },
    { type: 'tube', path: [[-82, 30, 44], [-82, 30, -40], [-60, 30, -46]], r: 2, trim: 'hull_trim:pipe', mirror: 'x' },
    { type: 'tube', from: [-12, 50, 30], to: [-12, 50, -30], sag: 3, r: 0.6, sides: 4, color: '#24272c' },
    { type: 'cylinder', r_bottom: 9, r_top: 7, h: 14, rotate: [-90, 0, 0], at: [-50, 20, -48], mirror: 'x', color: '#4a4f57', material: 'bare_metal' }] })}
4. Corridor module (one trim sheet everywhere): floor {texture:"deck"} + a grate strip box {h:0.5, trim:{sheet:"hull_trim", strip:"grate", faces:"all"}}; walls box {insets:[{face:"right", rect, depth:1.5}]}; ribs box {bevel:1, material:"bare_metal", trim:"hull_trim:rib"} every 32 px; ceiling light strip {trim:{sheet:"hull_trim", strip:"light", faces:"all"}}; wall greeble part {w:20, d:110, rotate:[0,0,-90], mirror:"x"}; pipe runs and sagging cables (tube); a bulkhead doorway = box {boolean:"subtract", target:"bulkhead"}.
5. Look: art_model ${J({ action: 'preview', name: 'hull_a', views: ['game'], ao: true })} (also lod:1|2, morph:{open:1}). Iterate seeds, density, avoid rects. A section under 6000 triangles is baked onto one atlas hull_a_uv (contact AO, edge wear; unwrap:false = per-part); bigger ones keep per-part textures (art_model unwrap {name, unwrap:{parts:["hull"]}} bakes the hero part).
6. Export for the browser: art_model ${J({ action: 'export', name: 'hull_a', bake_ao: true, lods: [1, 0.5, 0.2], impostor: { grid: 8, size: 64 }, collision: 'hull', occluder: 'boxes' })}: AO lightmap (TEXCOORD_1), <name>_lods > LOD0..2 with switch distances (THREE.LOD), impostor atlas + json, hidden collision / occluder nodes. Repeated greebles: greeble {instanced:true} -> EXT_mesh_gpu_instancing (InstancedMesh).
7. Interiors: layout model with cull:{rooms:[{name, min, max}, ...]} -> room_<name> nodes, auto doorways, meta.cull.pvs. Budget: 3-8k tris per hero section at LOD0, < 1k per kit piece.`,
  },
  'ships-structures': {
    title: 'Sci-fi ships, ship interiors, industrial exteriors, underground cities and megastructures (.glb, pixel textures)',
    when: 'Big-budget sci-fi set pieces at a PSX pixel-texture budget for a browser game (later Roblox): fighters, dropships, haulers, capital ring modules, ship interiors that fit the hull, mining colonies, neon market districts, stations. Designs stay ORIGINAL (no real ship designs, names or marks).',
    desc: 'Builds original sci-fi ships with walkable interiors, industrial exteriors, mining colonies, neon markets and megastructures from templates, hull curves and kits (art_model), with player-metric checks and triangle budgets. Use for gunships, fighters, dropships, haulers, capital ships, ship interiors or sci-fi set pieces.',
    body: `0. Hero / walkable ship at true scale (32 px = 1 m): art_model ${J({ action: 'create', name: 'tern', template: 'gunship' })} then ${J({ action: 'walk_check', name: 'tern' })} (player metrics: doors 1.2 x 2.1 m, corridors 1.4 x 2.3 m, stairs 0.2 m, ramps 20 deg) and ${J({ action: 'export', name: 'tern', static: 'landed', lods: [1, 0.5, 0.25], split: true, walk: true })}. Your own: hull {shell:6, openings:[{t, u}]} + glazing / ring_door in the openings + interior parts tagged inside:"<hull id>" (portal_arch, locker_wall, pilot_seat, screen_arm, decals) + walk markers; preview mood + ao, a figure for scale.
1. Kit textures + trim sheet once: art_model ${J({ action: 'kit' })} (kit_hull, kit_deck, kit_wall, kit_screen, kit_glow, kit_hazard, kit_rock, ... with height / metal / rough / emissive layers).
2. Ship from a template (original, seeded), then refine by part name:
   art_model ${J({ action: 'create', name: 'vk7', template: 'fighter', seed: 7, textures: 'kit' })} (dropship | hauler {bays} | capital_ring {radius, segments}; rigged:false = one static mesh, canopy:"open", gear:"up", ramp:"open")
   art_model ${J({ action: 'update', name: 'vk7', set: { wings: { span: 120, dihedral: 6 } } })}; info lists every part, node and clip (canopy_open, gear_retract, gear_deploy, wings_fold, ramp_open, ...).
3. Hull by hand (design curves): ${J({ type: 'hull', id: 'hull', length: 480, plan: [[0, 30], [0.4, 56], [0.85, 18], [1, 2]], profile: [[0, 40, 6], [0.5, 50, 0], [1, 18, 14]], sections: [[0, 'hex'], [0.9, 'wedge']], panel_lines: { every: 64, seams: [0.17] }, plates: [{ t: [0.3, 0.5], u: [0.2, 0.3], lift: 1.2 }], texture: 'kit_hull', groove: 'kit_metal_dark' })}
   Components ride the surface: ${J({ type: 'engine', on_hull: { hull: 'hull', t: 0.02, u: 0.2, mirror: true }, rotate: [-90, 0, 0], r: 16 })}, ${J({ type: 'canopy', name: 'canopy', on_hull: { hull: 'hull', t: 0.72, u: 0 } })}, landing_gear {name, at} (contact socket), ramp, cargo_door, wing / fin, turret / rotary_cannon / hardpoint, antenna, sensor_dome, rcs_quad, intake, vent, armor_plate, container_rack. Named = animated nodes + clips; unnamed = static (open / deployed state).
4. Livery: art_model ${J({ action: 'livery', name: 'vk7', primary: '#6e7682', secondary: '#2f343b', stripes: [{ t: [0.6, 0.64], color: '#b8462e' }], decals: [{ text: 'VK-07', t: 0.45 }], mark: { t: 0.18, seed: 11 }, wear: 0.4 })} (paint masks, hazard, stencils, an original seeded emblem, scratches; mapped once over the hull). Ship templates are over the automatic atlas size, so they keep per-part textures (create says so in unwrap_note).
5. Look: preview ${J({ action: 'preview', name: 'vk7', views: [{ yaw: 35, pitch: 24, perspective: true, fov: 30 }], size: 384, mood: true })} (dark scene lit by its own engines / lights), pose / clip previews as usual.
6. Interior that fits: art_model ${J({ action: 'generate', kind: 'interior', name: 'vk7_int', hull: 'dropship', textures: { floor: 'kit_deck', wall: 'kit_wall' } })} -> rooms on a corridor spine, doors at the exterior ramp / hatches (report.alignment), windows written back onto the ship, cull rooms. Rooms by hand: corridor {kind:"T"}, room {cells, openings}, door {name}, airlock, ladder, lift, bridge, engine_room, quarters, cargo_bay, hangar, med_bay, armoury, console (MFD screen markers for UI textures), seat.
7. Places: generate ${J({ kind: 'mining_colony', name: 'colony', seed: 9 })} / ${J({ kind: 'market', name: 'market', seed: 4 })} (instanced kit models <name>_k_*); kit by hand: tower, dish, tank, silo, crane, gantry, pipeline, scaffold, truss, catwalk, landing_pad, hangar_shell, hab_module, rock_platform, shaft, atrium, bridge_walk, lift_shaft, cable_web, pipe_wall, market_stall, sign_frame, neon {text}, sign, holo, light, fog_card, god_ray.
8. Budget + export: art_model ${J({ action: 'budget', name: 'vk7' })} (class, LOD estimate, draw calls, costliest parts); export ${J({ action: 'export', name: 'vk7', static: 'rest', lods: [1, 0.5, 0.2], split: true, budget: 'fighter' })} (rigged ships: export without static keeps nodes + clips); layouts: export ${J({ action: 'export', name: 'colony', instances: true, collision: 'boxes' })}. Lights / sockets / doors / screens come out as empty nodes with extras.`,
  },
  'fp-weapon': {
    title: 'First-person weapon + arms: 3D rig with clips (.glb) or pre-rendered pixel sprites',
    when: 'FPS viewmodels: a gun with moving parts (magazine, bolt, slide) and separate arms, either shipped as true 3D (glTF animations, Roblox Motor6D) or rendered to 2D sprite layers with per-frame hand anchors.',
    desc: 'Builds a first-person gun and arms as a rigid 3D rig (art_model fp_rifle / fp_pistol / fp_arms) with fire and reload clips and sockets, exported as an animated .glb or rendered to pixel sprite layers with per-frame hand anchors. Use for an FPS viewmodel; for the sprite-composed art_fp pipeline see art_help {topic:"fp"}.',
    body: `1. Textures first: small tileable canvases (32 px = 1 m; a slot also takes a colour). Texture canvases must exist before create:
   art_create_canvas ${J({ name: 'gun_metal', width: 16, height: 16, background: '#2c2e33' })} (also gun_poly, sleeve, glove; then noise / cells, tileable-texture skill)
2. Gun rig from a template (view space: origin = the eye, -Z forward, +Y up): art_model ${J({ action: 'create', name: 'ar', template: 'fp_rifle', textures: { metal: 'gun_metal', polymer: 'gun_poly' } })}
   Slots: fp_rifle {metal, polymer, magazine, optic, lens}, fp_pistol {metal, slide, polymer, magazine}, fp_arms {sleeve, cuff, glove}. Change parts by name: update ${J({ action: 'update', name: 'ar', set: { magazine: { h: 5 } } })} (also add:[..], remove:["optic"]).
   Arms (3D): create ${J({ action: 'create', name: 'arms', template: 'fp_arms', textures: { sleeve: 'sleeve', glove: 'glove' } })} (poses rest, grip_rifle, grip_pistol; clip idle_breathe).
3. Clips: fp_rifle has fire, reload_tactical, reload_empty (fp_pistol: fire, reload). Add your own: pose ${J({ action: 'pose', name: 'ar', pose: 'inspect', parts: { receiver: { rot: [0, 25, -30] } } })} then animate ${J({ action: 'animate', name: 'ar', clip: 'inspect', keys: [{ t: 0, pose: 'rest' }, { t: 0.6, pose: 'inspect', ease: 'smooth' }, { t: 1.4, pose: 'rest', ease: 'smooth' }], events: [{ t: 0.6, name: 'cloth' }] })}
   Keys: t in seconds (strictly increasing), pose and/or parts {<node>:{rot:[x,y,z] deg, at:[dx,dy,dz] px in the parent's frame, scale}}; ease = the motion INTO the key (linear | smooth | step). Rotations take the short way: split turns over 180° with an extra key.
4. Check by eye: preview ${J({ action: 'preview', name: 'ar', clip: 'reload_empty', frames: 8, view: 'side' })} and ${J({ action: 'preview', name: 'arms', pose: 'grip_rifle', views: ['fp', 'side'] })}
5a. True 3D: export ${J({ action: 'export', name: 'ar' })} and ${J({ action: 'export', name: 'arms' })} -> one node per part, empty nodes socket_muzzle / socket_sight / socket_grip_r / socket_grip_l / socket_mag_well, one glTF animation per clip (events in extras), meta.json rig table (Roblox Motor6D C0). Parent both to the camera; socket_sight on screen centre for ADS.
5b. 2D sprites (PS1 technique): one canvas per layer, all with the same size and camera so they stack:
   gun: render ${J({ action: 'render', name: 'ar', canvas: 'ar_reload', clip: 'reload_empty', fps: 12, size: [160, 120], camera: 'fp', hide: ['magazine'], quantize: { colors: 16, dither: true }, outline: '#14141a' })}
   magazine: render ${J({ action: 'render', name: 'ar', canvas: 'ar_reload_mag', clip: 'reload_empty', fps: 12, size: [160, 120], camera: 'fp', only: ['magazine'] })}
   sway / turn frames: render ${J({ action: 'render', name: 'ar', canvas: 'ar_sway', sweep: { yaw: [-6, 6, 3], pitch: [-4, 4, 2] }, size: [160, 120] })} (row-major: pitch rows x yaw columns, tag "angles")
   Every frame stores each socket's screen anchor [x, y, rot] in the canvas meta.anchors. The fp camera drops (does not clip) triangles crossing the near plane, so a part reaching behind the eye (a long stock) can vanish: shorten it, move the gun forward, or use camera:"side".
6. 2D arms that follow the gun: an art_rig with the render's frame size and one chain per arm (shoulders at the bottom edge):
   art_rig ${J({ action: 'create', name: 'arms2d', frame: [160, 120], views: ['side'], root: [80, 119], parts: { body: { w: 2, h: 2, pivot: [1, 1] }, upper_r: { w: 8, h: 32, pivot: [4, 0], parent: 'body', at: [68, 0] }, fore_r: { w: 7, h: 30, pivot: [3, 0], parent: 'upper_r', at: [0, 30] }, hand_r: { w: 8, h: 8, pivot: [4, 0], parent: 'fore_r', at: [0, 28] }, upper_l: { w: 8, h: 32, pivot: [4, 0], parent: 'body', at: [-30, 0] }, fore_l: { w: 7, h: 30, pivot: [3, 0], parent: 'upper_l', at: [0, 30] }, hand_l: { w: 8, h: 8, pivot: [4, 0], parent: 'fore_l', at: [0, 28] } } })}
   Draw each part in the cells the reply lists (canvas arms2d_parts, layer "parts"; cell = [x, cells.rows.side, w, h] from cells.parts[part] = [x, w, h]), then:
   art_rig ${J({ action: 'animate', name: 'arms2d', animation: 'reload_empty', canvas: 'arms_reload', ik_from: { canvas: 'ar_reload', animation: 'reload_empty', map: { hand_r: { anchor: 'socket_grip_r', bend: -1 }, hand_l: 'socket_grip_l' } } })}
   Same frame count, timing and loop as the gun clip, with the hands solved onto the grips in every frame. Map value: "<anchor>" or {anchor, bend?, rot?:true|deg, at?:[dx,dy], weight?}; offset:[dx,dy] when the frames differ. A humanoid / humanoid_hd rig maps hand_f and hand_b.
7. Paint over any frame by hand, then art_animation ${J({ canvas: 'ar_reload', action: 'export', format: 'spritesheet' })} for each layer (json frames[].anchors line the layers up in-engine).`,
  },
  'prop-rig': {
    title: 'Rigid prop rig: doors, chests, turrets, levers (named parts, pivots, poses, clips -> animated .glb)',
    when: 'A 3D prop with moving parts and no skinning: a door or gate on a hinge, a chest lid, a turret that yaws and pitches, a lever, a drawbridge. Exported as glTF nodes + animations (in Roblox: one MeshPart per node + Motor6D).',
    desc: 'Rigs a 3D prop with rigid moving parts (door, chest lid, turret, lever, drawbridge): named parts, pivots, poses and clips, exported as an animated .glb. Use for any hinged or rotating prop that needs no skinning.',
    body: `1. Parts: name a part to make it its own node (own mesh); parent nests it (children follow the parent). pivot:[x,y,z] (part-local px; most builders have their origin at the bottom centre) is the JOINT the node rotates about: a lid's back edge, a door's hinge side. Unnamed parts merge into their named parent (latches, rivets) or the root mesh. origin:"bottom" for a standalone prop. Texture canvases must exist first (or use color).
   art_model ${J({ action: 'create', name: 'chest', origin: 'bottom', parts: [{ type: 'box', name: 'base', w: 16, h: 10, d: 10, texture: 'wood' }, { type: 'box', name: 'lid', parent: 'base', w: 16, h: 4, d: 10, texture: 'wood', at: [0, 10, 0], pivot: [0, 0, -5] }, { type: 'box', parent: 'lid', w: 2, h: 2, d: 1, color: '#d9b44a', at: [0, 10, 5] }], sockets: { loot: { part: 'base', at: [0, 8, 0], look: [0, 1, 0] } } })}
   Turret: base cylinder (root mesh) > box name:"yaw" > box name:"pitch" (parent yaw, pivot at its centre) > cylinder name:"barrel" (parent pitch, rotate:[90,0,0]) + sockets:{muzzle:{part:"barrel", at, look:[0,0,1]}}. Door: frame > leaf with pivot:[-w/2,0,0]. rig:{merge:false} = every part its own node.
2. Poses = offsets from rest per node (rot deg X then Y then Z about the joint, at px in the parent's frame, scale): art_model ${J({ action: 'pose', name: 'chest', pose: 'open', parts: { lid: { rot: [-105, 0, 0] } } })}. base:"<pose>" starts from another pose.
3. Clips: art_model ${J({ action: 'animate', name: 'chest', clip: 'open', keys: [{ t: 0, pose: 'rest' }, { t: 0.15, parts: { lid: { rot: [-8, 0, 0] } }, ease: 'step' }, { t: 0.6, pose: 'open', ease: 'smooth' }], events: [{ t: 0.15, name: 'unlock' }, { t: 0.6, name: 'lid_thud' }] })}
   Loops: ${J({ action: 'animate', name: 'turret', clip: 'scan', loop: true, duration: 4, keys: [{ t: 0, parts: { yaw: { rot: [0, -45, 0] } } }, { t: 2, parts: { yaw: { rot: [0, 45, 0] } }, ease: 'smooth' }] })} (a duration past the last key closes back on the first key). keys:null deletes a clip; pose with parts:null deletes a pose.
4. Check: art_model ${J({ action: 'preview', name: 'chest', clip: 'open', frames: 4, view: 'side' })} (view iso | front | side | {pos, look, fov}); info lists nodes, sockets, poses and clips. The prop is baked onto one atlas canvas chest_uv (contact AO where the lid meets the base, edge wear); paint it on its "paint" layer, and every node keeps using it when posed or exported (unwrap:false = per-part textures).
5. Export: art_model ${J({ action: 'export', name: 'chest' })} -> one node per named part, socket_<name> empty nodes, one glTF animation per clip (all-linear = LINEAR, all-step = STEP, otherwise baked at 30 fps; events in extras), meta.json rig table with parent-space transforms. Play clips by name in-engine.
6. Optional 2D: render ${J({ action: 'render', name: 'turret', canvas: 'turret_scan', clip: 'scan', fps: 8, size: [48, 48], camera: 'iso', outline: '#14141a' })} gives pixel sprite frames with per-frame socket anchors (e.g. where to draw the muzzle flash).`,
  },
  'ui-icons': {
    title: 'UI icons / item icons set',
    when: 'Inventory icons, ability icons, HUD elements.',
    desc: 'Makes a consistent set of pixel-art UI, inventory or ability icons and HUD elements with a shared palette and light direction. Use when asked for an icon set or HUD art.',
    body: `1. Project with a shared palette; 16x16 or 24x24 canvases, 1px transparent margin.
2. Same light direction, outline color and ramp structure for every icon (consistency beats detail).
3. Silhouette -> shade -> outline -> one bright highlight pixel cluster.
4. art_sheet {project} to compare the set; art_critique each.`,
  },
};

Object.assign(SKILLS, AUDIO_SKILLS, PLANET_SKILLS, FX_SKILLS);

/** art_help {skill:"list"}: one line per skill. */
export const skillList = () => `Skills (art_help {skill:"<name>"}):\n${Object.entries(SKILLS).map(([n, x]) => `- ${n}: ${x.title}`).join('\n')}`;

/**
 * A skill's text. Skills with long code (sections) answer with the steps + a section index; opts
 * {section:"a,b"} = those sections, {full:true} = steps + every section (SKILL.md files, llms-full).
 */
export function skillText(name, opts = {}) {
  const s = SKILLS[name];
  if (!s) throw new Error(`Unknown skill "${name}". Skills: ${Object.keys(SKILLS).join(', ')}`);
  const secs = Object.entries(s.sections || {});
  if (opts.section && secs.length) {
    const want = [].concat(opts.section).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    const bad = want.filter((w) => !Object.hasOwn(s.sections, w));
    if (bad.length) throw new Error(`Unknown section ${bad.join(', ')} of skill "${name}". Sections: ${secs.map(([k]) => k).join(', ')}`);
    return want.map((w) => `[code: ${w}]\n${s.sections[w].text}`).join('\n\n');
  }
  const head = `# ${s.title}\nWhen: ${s.when}\n\n${s.body}`;
  if (!secs.length) return head;
  if (opts.full) return `${head}\n\n${secs.map(([k, x]) => `[code: ${k}]\n${x.text}`).join('\n\n')}`;
  return `${head}\nCODE (art_help {skill:"${name}", section:"<id>"}; several: "a,b"; everything: full:true):\n${secs.map(([k, x]) => `- ${k}: ${x.about}`).join('\n')}`;
}

/**
 * Frontmatter description of a skill: what it makes and when to use it (`desc`, written with the
 * trigger words an agent harness matches on), else the title + when.
 */
export function skillDescription(name) {
  const s = SKILLS[name];
  return `${s.desc || `${s.title}. ${s.when}`} Uses the Agent Art MCP tools (art_*).`;
}

/** SKILL.md file content (Claude Code / Agent Skills format) for a skill. */
export function skillFile(name) {
  if (!SKILLS[name]) skillText(name); // throws the "Unknown skill" error with the list
  // JSON string = a valid YAML double-quoted scalar, so colons and quotes in the text are safe
  return `---\nname: agent-art-${name}\ndescription: ${JSON.stringify(skillDescription(name))}\n---\n\n${skillText(name, { full: true })}\n`;
}
