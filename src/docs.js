// Command reference, served in layers to keep the always-loaded tool surface small:
//   - SIGS: one short line per command (inside the art_draw description)
//   - art_help {topic | op}: full details, tips and a working example on demand
//   - errors: a failing command's usage + example is appended automatically
// Keep SIGS terse; put explanations in DETAILS.
import { PART_DOCS } from './model3d.js';
import { AUDIO_TOPICS } from './audio/docs.js';

/** op -> [signature, short purpose]. Field names are exact; "?" = optional. */
export const SIGS = {
  // shapes
  grid: ['x?,y?,rows:[str],legend?,cpp?', 'paint from text rows (1 char = 1 px; "." keeps)'],
  pixels: ['points:[[x,y,color?]],color?', 'single pixels'],
  line: ['x1,y1,x2,y2|points,color,width?,pixel_perfect?', 'line/polyline'],
  curve: ['points:[3|4 pts],color,width?', 'bezier'],
  polygon: ['points,color?,outline?,fill?', 'polygon'],
  rect: ['x,y,w,h,color?,outline?,fill?,thickness?', 'rectangle'],
  ellipse: ['x,y,w,h,color?,outline?,fill?,thickness?', 'ellipse in a box'],
  fill: ['x,y,color,tolerance?,contiguous?', 'flood fill'],
  text: ['x,y,text,color,font?,scale?,align?,shadow?', 'pixel font'],
  // color
  replace: ['from,to,tolerance?,region', 'swap one color'],
  remap: ['map:{from:to},tolerance?,region', 'swap several colors (variants)'],
  gradient: ['colors,direction?,dither?,region', 'banded gradient'],
  adjust: ['hue?,saturation?,lightness?,jitter?,alpha?,region', 'HSL adjust'],
  quantize: ['colors?,dither?,alpha_threshold?,region', 'snap to palette'],
  // surfaces + form
  shade: ['colors:[dark..light],light?,of?,depth?,profile?,per_color?,region', 'AUTO form shading of drawn shapes (use instead of hand shading)'],
  cells: ['colors:[dark..light],gap_color?,size?,gap?,layout?,stretch?,seed?,region', 'tileable shaded stones/scales/cracks'],
  noise: ['colors,weights?,scale?,octaves?,despeckle?,seed?,region', 'tileable noise'],
  scatter: ['colors|color,density?|count,size?,seed?,region', 'random specks'],
  outline: ['color,mode?,of?,from_layer?,diagonal?,region', 'outline shapes'],
  bevel: ['light?,dark?,size?,region', 'block edge highlight/shadow'],
  // transform
  copy: ['x,y,w,h,to_x,to_y,from_canvas?,from_layer?,from_frame?,scale?,flip_x?,tint?,opacity?', 'copy/stamp (also across canvases/frames)'],
  flip: ['axis,region', 'flip'],
  rotate: ['turns|angle,expand?,region', 'rotate (90° steps or any angle)'],
  shift: ['dx,dy,wrap?,region', 'move pixels (wrap = fix seams)'],
  mirror: ['axis,source', 'mirror half'],
  clear: ['region?', 'erase'],
  // light + atmosphere
  light: ['x,y,radius,color,intensity?,mode?,steps?', 'point light'],
  fog: ['color,from?,to?,direction?,noise?,steps?,region', 'haze'],
  rays: ['x,y,angle,spread,count,width,color,alpha?', 'god rays'],
  glow: ['threshold?,radius?,intensity?,gain?,normalize?,wrap?', 'bloom'],
  blur: ['radius,region', 'blur'],
  vignette: ['strength?,radius?,color?', 'darken edges'],
  cast_shadow: ['from_layer,dx,dy,color,squash?,skew?,soft?', 'drop shadow from a layer'],
  // iso
  iso_box: ['at:[gx,gy,gz]|x,y,tile,origin,w|size_left/right,height,top,left?,right?,outline?,edge?,anchor?,inset?', 'iso block'],
  iso_tile: ['same as iso_box without height,color', 'iso floor diamond'],
};

const REGION = 'region = x?,y?,w?,h? (defaults to the whole canvas/frame).';

/** Detailed docs + example per op (shown by art_help op:<name> and on errors). */
export const DETAILS = {
  grid: { doc: 'Each char is a palette key or a legend entry. "." and " " leave pixels unchanged; legend {"_":"transparent"} erases. cpp:2 = two chars per pixel for multi-char palette keys ("s1"). Best tool for deliberate hand-placed detail (faces, icons, outlines).', ex: { op: 'grid', x: 4, y: 2, legend: { o: '#2a1a22', s: '#e8b090' }, rows: ['.oo.', 'osso', 'osso', '.oo.'] } },
  pixels: { doc: 'points may carry their own color: [x,y,"#f00"].', ex: { op: 'pixels', color: '#fff', points: [[3, 3], [4, 3, '#ff0']] } },
  line: { doc: 'brush: round|square. pixel_perfect:true removes L-shaped doubles (clean 1px lines). points:[[x,y],...] draws a polyline.', ex: { op: 'line', x1: 0, y1: 15, x2: 15, y2: 0, color: 'o', pixel_perfect: true } },
  curve: { doc: '3 points = quadratic, 4 = cubic bezier. Pixel-perfect. Use for hair, tails, round outlines.', ex: { op: 'curve', points: [[2, 12], [8, 0], [14, 12]], color: 'o' } },
  polygon: { doc: 'fill defaults to true; outline = border color.', ex: { op: 'polygon', points: [[8, 1], [15, 14], [1, 14]], color: 'g2', outline: 'o' } },
  rect: { doc: 'fill:false with color draws only the border.', ex: { op: 'rect', x: 2, y: 2, w: 12, h: 8, color: 'w2', outline: 'o' } },
  ellipse: { doc: 'Bounding box x,y,w,h. fill:false with color draws only the border; thickness = border width in px (like rect).', ex: { op: 'ellipse', x: 2, y: 2, w: 12, h: 12, color: 'r2', outline: 'o' } },
  fill: { doc: 'Flood fill on the target layer; contiguous:false replaces the color everywhere; diagonal:true spreads through corners.', ex: { op: 'fill', x: 8, y: 8, color: 'b2' } },
  text: { doc: 'Built-in pixel fonts, uppercase (A-Z 0-9 punctuation, \\n). font "3x5" (default, tiny), "5x7" (readable UI/labels) or "7x9" (titles). scale multiplies; align left|center|right around x; spacing, line_spacing in px.', ex: { op: 'text', x: 32, y: 4, text: 'HELLO', color: '#fff', align: 'center', shadow: '#000' } },
  replace: { doc: REGION, ex: { op: 'replace', from: '#ff0000', to: 'r2' } },
  remap: { doc: `Swap several colors at once (derive color variants of an asset). Errors listing the colors present if nothing matched (allow_none:true to skip). ${REGION}`, ex: { op: 'remap', map: { r1: 'b1', r2: 'b2', r3: 'b3' } } },
  gradient: { doc: `direction: vertical|horizontal|diagonal|diagonal-reverse|radial. dither: bayer (default)|noise|none (false = none). Banded to the given colors. radial reaches the last color on the region edge (corners filled with it). ${REGION}`, ex: { op: 'gradient', colors: ['#1a1030', '#4a2a60', '#c06070'], direction: 'vertical' } },
  adjust: { doc: `hue in degrees, saturation/lightness -1..1, jitter = random ±lightness per pixel, alpha = opacity change -1..1 (-0.3 = 30% more transparent; result clamped 0..1), set_alpha = absolute opacity 0..1. ${REGION}`, ex: { op: 'adjust', lightness: -0.1, hue: 10 } },
  quantize: { doc: `Snap pixels to colors (default: the palette). dither none|bayer, strength. alpha_threshold:0.5 makes alpha binary. Run after effects to keep a coherent palette. ${REGION}`, ex: { op: 'quantize', dither: 'bayer' } },
  shade: { doc: `Shades shapes you already drew (any flat color) from ONE light direction using a ramp dark->light: rounded volume from the shape outline, no pillow shading. of: which colors form the shape (default every painted pixel in the region). light: top-left (default)|top|top-right|left|right|bottom-left|bottom|bottom-right or degrees. profile: round (dome, default)|flat (bevelled edges + flat top, set depth px)|sharp. per_color:true shades each flat color as its own part (e.g. arm vs body). bias -0.3..0.3 shifts lighter/darker; contrast; dither:true; wrap:true for tileable textures; cleanup:0 keeps lone pixels. Workflow: block in flat silhouettes -> shade -> outline -> hand detail. ${REGION}`, ex: { op: 'shade', colors: ['r0', 'r1', 'r2', 'r3', 'r4'], of: 'r2', light: 'top-left' } },
  cells: { doc: `Fills the region with a tileable pattern of separately shaded cells: cobblestone (size 5, gap 1), scales (layout brick), bricks (layout brick, stretch 2, profile flat, depth 1), cracked earth (gap_color dark, size 8), gravel (size 3). variation = per-cell tone shift (steps), jitter 0..1, depth/profile/light like shade. ${REGION}`, ex: { op: 'cells', colors: ['s0', 's1', 's2', 's3'], gap_color: '#2e2c36', size: 5, seed: 3 } },
  noise: { doc: `Tileable value noise. weights = exact share of each color. scale = feature size px (1 = per-pixel). despeckle:1-2 absorbs lone pixels (flat cartoon surfaces). Prefer cells/shade for stone; noise is for subtle variation. "keep" in colors leaves those pixels unchanged (sparse noise). Under a mask, transparent colors do not erase (no holes in the masked art) unless erase:true. ${REGION}`, ex: { op: 'noise', colors: ['d1', 'd2', 'd3'], weights: [0.3, 0.5, 0.2], scale: 3, despeckle: 1 } },
  scatter: { doc: `Random specks/blobs of size px. ${REGION}`, ex: { op: 'scatter', colors: ['g3', 'g4'], density: 0.05, size: 1, seed: 2 } },
  outline: { doc: 'mode outer (around shapes, default)|inner (on the shape edge). of: only shapes of these colors (selective outline). from_layer: outline another layer\'s shapes onto this layer. diagonal:true = 8-connected. skip_existing:true = pixels already in the outline color count as outline, not shape, so re-running never doubles it to 2 px (only fills gaps); it is the default when the layer already has that exact color (pass skip_existing:false for a second ring). Region limits where it writes; honours mask. Use a dark hue-shifted color, not pure black.', ex: { op: 'outline', color: '#2a1a22' } },
  bevel: { doc: `Light top/left and dark bottom/right edge lines of size px (blocks, planks, buttons). ${REGION}`, ex: { op: 'bevel', light: 'w3', dark: 'w0' } },
  copy: { doc: 'Copy a block (from this layer, from_layer, from_frame or from_canvas = asset stamp). Order: scale/flip, then hue/saturation/lightness, then tint (multiply), then opacity. skip_transparent defaults true. Build animation frames from a base frame: copy from_frame then move parts.', ex: { op: 'copy', from_frame: 0, x: 0, y: 0, w: 32, h: 32, to_x: 0, to_y: 1 } },
  flip: { doc: `axis x|y. ${REGION}`, ex: { op: 'flip', axis: 'x' } },
  rotate: { doc: 'turns:1..3 = 90° steps (square region). angle:<deg> = any angle with pixel-art-safe rotsprite-style sampling (no new colors). Region defaults to the whole canvas; pivot cx,cy defaults to its centre. Without expand, pixels rotated past the region/frame edge are cut. expand:true = nothing is cut: the canvas (every frame) grows just enough to hold the rotated content (content shifts by the left/top growth) and the result may extend past the region.', ex: { op: 'rotate', angle: 30, x: 8, y: 8, w: 16, h: 16 } },
  shift: { doc: `Move pixels by dx,dy (wrap:true default wraps around: shift by half the size to see/fix tile seams in the middle). ${REGION}`, ex: { op: 'shift', dx: 8, dy: 8 } },
  mirror: { doc: 'Copy one half onto the other mirrored: axis x|y, source left|right|top|bottom. Symmetric sprites: draw the left half, mirror.', ex: { op: 'mirror', axis: 'x', source: 'left' } },
  clear: { doc: `No region = the whole layer (with frame: the whole frame). ${REGION} Honours mask.`, ex: { op: 'clear', x: 0, y: 0, w: 4, h: 4 } },
  light: { doc: 'mode add|screen|multiply|paint; falloff smooth|linear|sharp; radius_y for ellipses; steps bands (0 = smooth). Paints empty pixels too (on_empty:false = only painted ones). Put lights on their own layer with blend screen/add.', ex: { op: 'light', x: 40, y: 30, radius: 18, color: '#ffb060', intensity: 0.8, mode: 'add' } },
  fog: { doc: `direction vertical|up|horizontal|radial; from/to = alpha; noise 0..1 wisps. For big smooth fog use steps:0 then quantize dither bayer once (a few steps + bayer looks like a screen door). ${REGION}`, ex: { op: 'fog', color: '#8fa6c0', from: 0, to: 0.4, direction: 'up', noise: 0.4 } },
  rays: { doc: 'God rays from x,y: angle (deg, 90 = down), spread, count, width (deg), length, alpha. Draw on a layer with blend screen/add.', ex: { op: 'rays', x: 20, y: -10, angle: 60, spread: 30, count: 4, width: 6, color: '#ffe7a8', alpha: 0.4 } },
  glow: { doc: 'Bloom around pixels brighter than threshold. select: value (default, HSV max channel: saturated neon blooms too) | luma (perceived brightness, the previous default) | saturation. Tiny 1-2 px emitters need gain:3-6 or normalize:true. wrap:true for tiling textures. steps bands it.', ex: { op: 'glow', threshold: 0.7, radius: 2, gain: 3 } },
  blur: { doc: `Depth of field for far/near layers (passes:1 for lighter). ${REGION}`, ex: { op: 'blur', radius: 1 } },
  vignette: { doc: 'strength 0..1, radius 0..1 where darkening starts.', ex: { op: 'vignette', strength: 0.5 } },
  cast_shadow: { doc: 'Projects from_layer\'s shapes onto this layer: dx,dy offset, squash (0.3-0.6 = on the ground), skew, base_y (ground row, default lowest painted row), soft = blur px (banded).', ex: { op: 'cast_shadow', from_layer: 'hero', dx: 3, dy: 0, squash: 0.4, color: '#00000066', soft: 1 } },
  iso_box: { doc: '2:1 pixel iso. Position with at:[gx,gy,gz] + tile + origin:[ox,oy] (origin = top vertex of cell 0,0) or x,y bbox. w = tile width (multiple of 4) or size_left/size_right; tiles_x/tiles_y; height px. Faces auto-shade from top; outline/edge colors. anchor:"center" centres a smaller box on its cell; inset shrinks it; fractional at allowed. Draw back to front (increasing gx+gy). Texture faces afterwards with mask:<face color>.', ex: { op: 'iso_box', at: [1, 1, 0], tile: 32, origin: [64, 20], height: 16, top: '#b89a72', outline: '#3a2a20' } },
  iso_tile: { doc: 'Flat iso diamond with the iso_box positioning; inset:1 leaves grout gaps.', ex: { op: 'iso_tile', at: [0, 0, 0], tile: 32, origin: [64, 20], color: '#6a7a5a', inset: 1 } },
};

export const COMMON = 'Every command may set: layer, frame (frame-local coords), mask ("opaque" | "transparent" | color | "!<color>" | "layer:<name>" | "!layer:<name>"), blend ("replace" | "over"), symmetry ("x"|"y"|"xy").';

/** art_draw description: compact signatures grouped by purpose. */
export function drawDescription() {
  const groups = [
    ['SHAPES', ['grid', 'pixels', 'line', 'curve', 'polygon', 'rect', 'ellipse', 'fill', 'text']],
    ['FORM/SURFACE', ['shade', 'cells', 'noise', 'scatter', 'outline', 'bevel']],
    ['COLOR', ['replace', 'remap', 'gradient', 'adjust', 'quantize']],
    ['TRANSFORM', ['copy', 'flip', 'rotate', 'shift', 'mirror', 'clear']],
    ['LIGHT', ['light', 'fog', 'rays', 'glow', 'blur', 'vignette', 'cast_shadow']],
    ['ISO', ['iso_box', 'iso_tile']],
  ];
  const lines = groups.map(([g, ops]) => `${g}: ` + ops.map((o) => `${o}{${SIGS[o][0]}}`).join(' '));
  return [
    'Run drawing commands on a canvas as ONE atomic undo step. commands: [{"op":"rect","x":0,"y":0,"w":4,"h":4,"color":"#c33"}, ...] (each name{fields} below is {"op":"name", fields}). Pixels, origin top-left. Colors: #rgb #rrggbb #rrggbbaa, rgb(), hsl(), "transparent" or a palette key.',
    COMMON,
    ...lines,
    'region = x?,y?,w?,h?. art_help {op:"<name>"} = full options + example; errors include usage.',
  ].join('\n');
}

/** Usage text for one op (errors + art_help). */
export function opUsage(op) {
  const s = SIGS[op], d = DETAILS[op];
  if (!s) return null;
  return `${op} {${s[0]}} — ${s[1]}.${d ? ' ' + d.doc + '\nexample: ' + JSON.stringify(d.ex) : ''}`;
}

/** Topics for art_help. Short, task-oriented guidance (skills reference these). */
export const TOPICS = {
  workflow: `GOOD PIXEL ART, STEP BY STEP
1. Palette first: art_palette ramp per material (4-5 shades, hue-shifted: cool shadows, warm highlights). Few colors total.
2. Block in flat silhouettes (rect/ellipse/polygon/grid) in one mid color per part.
3. Form: shade {colors:[ramp], of:<part color>} per part (or per_color:true) — one light direction (top-left).
4. Outline: outline {color:<dark hue-shifted>} (outer). Optionally inner lines with grid.
5. Detail by hand (grid rows): eyes, highlights, texture marks. 1px details only where they read.
6. Check: art_critique (numbers + coordinates), then art_view. Fix, repeat. Finish with quantize if effects were used.
Avoid: pillow shading (light on every edge), noise/speckle everywhere, pure black outlines, too many colors, isolated stray pixels.`,
  textures: `TILEABLE TEXTURES (blocks, floors, walls)
- Stone/cobble/scales/bricks/gravel: cells (one command) with a 3-5 shade ramp + gap_color; then a few hand details.
- Organic (dirt, sand, grass top): base fill, noise scale 2-4 despeckle:1 with 3 shades, scatter a few highlight specks.
- Wood planks: rect bands, bevel per plank, line grain, a knot with ellipse.
- Metal/gems: rect/polygon facets in a flat color, shade profile:flat depth 2-3, bright 1px highlight, outline.
- Always: art_view tile:3 or art_critique (tiling_seam). Fix seams: shift dx,dy = half size (wrap), repair the middle cross, shift back.
- Variants (colors/dyes): duplicate canvas + remap the ramp.`,
  characters: `CHARACTERS & SPRITES
- Pick a frame size and keep it (16, 24, 32, 48). Ground line = same row in every frame; leave 1px margin.
- Proportions are a style choice (chibi big head, heroic, realistic, monstrous); keep them identical between frames. Readable silhouette, 1px dark outline.
- Draw on layers per part (body, head, arms, gear) so parts can be shaded (shade per_color) and moved per frame.
- Directions/turnarounds + animations stay consistent with art_rig (parts + poses → generated frames). See art_help topic:"rig".
- Without a rig: draw frame 0, then copy from_frame 0 into the next frame and only move/redraw the parts that change.
- Check animation with art_critique (volume_drift, ground_line, palette_drift) and art_animation filmstrip.`,
  animation: `ANIMATION
- A canvas with frames = vertical strip of equal frames. art_animation: insert/duplicate/move/delete frames; tag {name, from,to, duration|durations|fps, loop, direction}.
- Key poses first, then in-betweens. Walk: contact, down, passing, up (x2 for left/right). Idle: 2-4 frames, 1px breathing bob. Attack: anticipation, smear, impact, recovery.
- High frame rates (12-24 fps): use art_rig — poses on keyframes, tween generates the in-betweens with sub-pixel-safe rotation.
- Draw a frame: art_draw {frame:N}. Check: art_view {frame, onion:1}, art_animation filmstrip, art_critique.
- Export: art_animation export format gif (preview) | spritesheet (png + Aseprite-style json) | frames. path "out/knight" writes out/knight.png+.json (json:false = png only); a folder path ("out/knight/") writes out/knight/<canvas>.*.`,
  scenes: `2.5D / HD-2D SCENES
Layers back to front: sky, far, mid, play, foreground. Far = lower contrast, bluer; optional blur. Lights on their own layers (art_layer add blend:"screen"/"add"), shadows blend "multiply", color grade "overlay". fog between depth layers, rays from windows/canopies, glow on emissive pixels. Finish: art_layer stamp_visible + quantize the stamp. Stamp repeated props with copy from_canvas (scaled/tinted for distance). Iso: iso_box/iso_tile back to front. art_canvas normal_map for engine lighting.`,
  hires: `HIGH-RESOLUTION PIXEL ART (128px .. 2048px)
- Work in regions: art_view x,y,w,h zooms (a big canvas view is downsampled overview), art_read only small regions.
- Block in with shapes + shade (geometry based, resolution independent), cells/noise for surfaces, then detail per region.
- Upscale a small sketch: art_canvas scale {factor, method:"scale2x"} keeps clean pixel edges, then refine.
- Use layers per depth/part; effects (light/fog/glow) scale well.`,
  minecraft: `MINECRAFT RESOURCE PACKS
Blocks/items 16x16 (Java). Names differ by version: 1.12 textures/blocks + textures/items (planks_oak), 1.13+ block/ + item/ (oak_planks). art_minecraft vanilla lists real names/sizes (references only, never ship vanilla art). Set canvas meta.texture (e.g. "blocks/stone"); art_minecraft build {project} writes the pack + zip. Animated textures = frames. Grass/leaves are grayscale + biome tint (meta.tint for previews).`,
  rig: `RIGS: CONSISTENT MULTI-VIEW, MULTI-ANIMATION ASSETS (art_rig)
Coordinates: root = where the root part's pivot sits in the frame; a child's "at" = offset of its pivot from the PARENT'S PIVOT (not its corner), so a head on a body with pivot at the body's bottom needs at:[0,-bodyHeight].
A rig = parts (drawn ONCE per view on the "<name>_parts" canvas), joints (pivot + parent + rest offset "at"), and poses (per-part x,y offsets px, rot degrees, sx/sy scale for squash & stretch, variant, hide). Every generated frame is assembled from the same part pixels, so the character stays identical across directions and animations, and in-betweens are tweened at any fps.
0. Quick start: create {name, frame:[32,32], template:"humanoid"|"blob"|"flyer"} gives parts, views, poses and presets (humanoid: idle, blink, walk, run, attack, hurt, jump, death; blob: idle, hop, blink, hurt, death; flyer: fly, hurt, death). Templates are only starting points: in the same create pass parts:{head:{w:14,h:10}, tail:{w,h,pivot,parent:"body",at,z}, arm_b:null}, views, root, poses or presets to change anything; later art_rig update / pose. Then draw the cells and animate {preset:"walk", view:"side"} (any preset field can be overridden, e.g. frames:16, fps:20).
1. Custom: create {name, frame:[w,h], views:["side","front","back"], mirror:{side_left:"side"}, root:[x,y] (where the root part's pivot sits in a frame), parts:{body:{w,h,pivot:[x,y]}, head:{w,h,pivot,parent:"body",at:[dx,dy],z}, arm_f:{..., views:{front:{at:[..],z}, back:{hidden:true}}}, eyes:{..., variants:["closed"]}}}. The reply lists every cell [x,y,w,h] per view; the visible "cells" guide layer marks cells (blue) and pivots (red) and never reaches frames.
2. Draw each part in its cell (flat colors -> shade -> outline), same palette keys in every view. Pivot = the joint (top of a limb, bottom of the neck).
3. pose {pose:"contact", parts:{leg_f:{rot:-30}, leg_b:{rot:30}, arm_f:{rot:25}}} — offsets from the rest pose; from:"<pose>" copies one as a base. Poses work in every view.
4. animate {animation:"walk_side", view:"side", keys:[{pose:"contact"},{pose:"pass"},{pose:"contact",mirror_pairs:true},{pose:"pass"}], frames:12, fps:12, plant_feet:true} -> frames + tag on canvas <name> (or canvas). mirror_pairs swaps *_f/*_b, *_l/*_r parts (second half of a walk). keys may set t (0..1) and ease (smooth|linear|step).
4b. One canvas holds everything: every animate call (default canvas = rig name) appends its frames under its own tag (walk, walk_front, idle, ...). turnaround {pose?, views?} = one frame per view (tags = view names) for a still front/side/back sheet.
4c. Game-engine extras: every animate saves per-frame anchors (each part's pivot x,y,rot) and spritesheet json frames[].anchors carries them (attach weapons, hats, backpacks, particles). Paper-doll layers: animate the same keys with hide:["head"] (body layer) and only:["head"] (head layer) into different canvases: identical timing and ground shift, so they stack exactly and the head can be swapped in-engine.
5. preview {pose} shows all views side by side with the ground line; art_critique {canvas, animation} checks drift. update {parts:{...}, presets:{...}} resizes/adds parts (keeps drawn pixels) and saves reusable animations.
HIGH-DETAIL CHARACTERS (late-90s pre-rendered / "Replaced" look, 64x96 .. 160x240 frames):
6. create {name, frame:[128,192], template:"humanoid_hd"}: pelvis (root), torso, chest, neck, head(+blink), upper_arm/forearm/hand _f/_b, thigh/shin/foot _f/_b, plus optional slots weapon (child of hand_f), gear_back, gear_hip, cape. Views side, front_side (3/4), front, back_side (3/4), back + mirrors side_left, front_side_left, back_side_left = 8 directions. Presets: idle 12f, blink, walk 16f, run 12f, crouch_walk 16f, aim 1f, shoot 6f, reload 24f, hurt 8f, death 20f, throw 12f (IK, foot planting, cape follow-through on). Elbows/knees bend because limbs are parent chains. Leave unused slots empty or remove them with null.
7. Per-view poses: a pose may hold views:{front:{thigh_f:{rot:0, sy:0.8}}} merged over the base pose in that view (mirror views use their source view); tweening blends them. pose {pose, parts, views}. Side-view rotations splay sideways in front/back: override them there (humanoid_hd presets already do: forward swings become sy foreshortening).
8. IK (two-bone, solved per frame after FK, in each view): pose or key ik:{hand_b:{target:{part:"weapon", at:[14,-2]}, bend:-1}, hand_f:{target:[70,60], rot:0}} rotates the end's parent + grandparent so the end pivot reaches the target. target = frame px of the drawn view, or {part, at:[dx,dy]} in that part's rotated frame (a grip, a holster). bend 1 = joint toward +x when the limb hangs (knees in side view), -1 = elbows. rot = world rotation of the end afterwards (keep a gun level). A key without the entry fades back to FK. plane:"depth" bends toward the camera (front/back views, needs scale_children).
9. animate {..., plant:true} (alias ik_feet) pins stance feet: frames whose ankle is within ~2% of the frame height of the rest ground are contact frames; the ankle sits on the ground row and slides at constant speed through each contact (a standing foot stays put), solved with leg IK. plant:["foot_f"] picks parts; rig "feet" sets the default (auto: parts named foot* with a two-bone chain).
10. Secondary motion: rig secondary:{cape:{stiffness:0..1, damping:0..1, gravity?, inertia?}}; animate {secondary:true} (or an inline map) runs a damped angular spring driven by the parent's motion, so capes, scarves, straps and pouches lag and follow through. Loops are simulated until the seam repeats, so loops stay seamless.
11. Rig options: sampling:"rotsprite" (3x3 supersampling of the 8x Scale2x cell + majority colour + hole/stray cleanup: stable limb thickness, only existing colours; humanoid_hd default) | "smooth" (same on the 1x cell) | "nearest8" (old rigs' default). scale_children:true makes a part's sx/sy also move its children's joints (foreshortening, breathing). Frames per canvas are limited to 8192 px of height: at 128x192 that is 42 frames, so give each preset+view its own canvas (canvas:"hero_walk_side").
12. Export: art_animation export {format:"spritesheet", json:false} skips the sidecar json.`,
};

TOPICS['3d'] = `3D MODELS FROM PIXEL ART (art_model -> glTF .glb, HD-2D look)
Pixel textures on low-poly meshes, NEAREST filtering, alpha MASK (BLEND for opacity/glass parts). Units = art px; export divides by scale (32 px = 1 unit). Y-up, +Z = front. Each builder's origin is bottom-centre (floor: top-centre; extrude/lathe: canvas meta.pivot). Model origin:"auto" (default) keeps part coordinates so kit pieces snap to the grid; for a standalone prop, ship or vehicle set origin:"bottom" (bbox centred on X/Z, bottom on y=0) or "center". Z-up engines (Sanctum Burn / Three.js camera.up=Z): object.rotation.x = Math.PI/2, or export {up:"z"}.
WORKFLOW: 1. Paint tileable textures first (32x32 = one grid cell; art_help topic:"textures"). 2. One model per kit piece: art_model create {name, parts:[...]}. 3. art_model preview {name} (game = 38° pitch perspective like the game camera, plus front/side/top/iso; views:["game"], size:512 for a big diorama look). 4. update {set:{0:{h:96}}} / add / remove and re-preview. 5. export {name} -> exports/<name>.glb + <name>.meta.json (bounds, triangles, units).
PARTS (every part: at:[x,y,z] px, cell:[gx,gy,gz] = x grid (32), turn:0-3 = 90° about y, rotate:[x,y,z] deg, scale, pivot:[x,y,z], mirror, array:{count, step:[x,y,z] | cell_step:[1,0,0], turn?, rotate?, about?}, opacity, glass, double_sided, hidden):
TRANSFORM ORDER: scale, then rotate X then Y then Z (fixed axes, degrees), then turn, all about the part's own origin (local 0,0,0) or about pivot:[x,y,z] (local px, e.g. a door hinge or a wing root); then at + cell*grid. mirror:"x"|"y"|"z" (or a list = every combination) also emits the copy mirrored across the model's x=0 / y=0 / z=0 plane, winding and normals fixed (image-mapped faces show the mirrored image). array copies: rotate/turn k steps about the copy's own origin, or with about:[x,y,z] (model px) about that point = radial array (engine rings, rotor blades, turret ports).
MATERIALS: opacity:0..1 (< 1 = glTF alphaMode BLEND, baseColorFactor alpha = opacity, texture alpha multiplies) and glass:true (BLEND, opacity 0.35 unless set, doubleSided, low roughness) for canopies, cockpit domes, visors, force fields. double_sided:true = doubleSided material. Translucent materials keep their own material (not atlased); engines draw them after opaque meshes without depth writes (material extras depthWrite:false), the preview blends them the same way.
${Object.entries(PART_DOCS).map(([k, v]) => `- ${k} {${v}}`).join('\n')}
TEXTURES: texture = canvas name | "#rrggbb" | {canvas, frame?, layer?, region:[x,y,w,h], overlay:<grime canvas>}. Per face: faces:{top,bottom,front,back,left,right} or the same keys on the part; side = every vertical face; cap = top+bottom. Kit pieces get WORLD UVs after placement (1 texel = 1 px, planar per face direction, lattice origin at the grid cell edge): any offset, turn, array or nested layout continues the texture across touching pieces and courses run on around corners; tile:false fits one copy per face. three.js runtime version of the same mapping: README "World-space UVs". Emissive = a layer named "emissive" (or canvas <name>_emissive). export normal_maps:true makes/uses <canvas>_n.
RUINS: broken:true | {amount px, step px, seed} = jagged top (walls/arches) or eroded edges (floors). holes:<mask canvas> = painted pixels of the mask (stretched over the face) are cut out (cracks, breaches). Outlines are smooth polygons (marching squares + simplify; res = sampling px, default 1); style:"voxel" (arch: voxel:true) gives the old blocky look. Arch curves get segments from their size.
OVERLAYS (grime, decay, moss, blood, wear) = alpha-cut decal shells with their own UV set (glTF TEXCOORD_1, strength in COLOR_0 alpha): overlays:[{texture:"grime", where:"bottom"|"top"|"corners"|"edges"|"all" (or a list), falloff:24 px, amount:1, jitter:0.5, map:"world" (own scale, scale:1) | "face" | "piece" | "surface" (stretched 0..1), seed}] on a part or on the model (all parts). Gradients use the whole continuous surface, not one piece.
CTM (connected textures, OptiFine/Continuity style): art_model ctm {name:"marble_ctm", ctm:{base:"marble", method:"full", border:{width:2, style:"bevel"|"line", color?}}} makes a tileset canvas; texture:"marble_ctm" on floors/walls then picks a tile per world cell from its 8 neighbours across ALL pieces (same plane + same connect key: material | texture | tag via ctm_tag; walls fold around vertical corners). Methods: full (47 blob), compact (5 tiles, quarters), horizontal, vertical, horizontal+vertical, top, random (weights, variants:[canvases] or auto flips), repeat (base = cols x rows cells, one big pattern), overlay (creep tiles from overlay:<canvas>; used as overlays:[{texture:"moss_ctm", from:"grass"}]). Hand-drawn: template:<canvas> with all tiles, or the 5 compact tiles (none, all, horizontal, vertical, inner corners) -> 47. Export writes <name>.ctm.json + tileset PNGs for runtime re-tiling (ctmTileFor in README). rubble {count, size, seed} scatters chunks.
LAYOUTS / DIORAMAS: a model whose parts are {type:"model", model:"wall_a", cell:[2,0,0], turn:1}. export bakes it into one mesh (fewest draw calls), or export {instances:true} = one shared mesh per kit piece + one node per placement. atlas:true packs small image-mapped textures (and colours) into one material.
RECIPES:
- Gothic arch kit: arch {texture:"stone", span:24, point:1, spring:20, d:8} (style:"solid" = door/window panel; style:"ring" = rib); vault {texture:"stone", span:64, d:32}; pillar/column between arches at cell edges; broken:{seed:3} for the ruined variant.
- Floor + walls: floor {texture:"tile", array:{count:4, cell_step:[1,0,0]}}; wall {texture:"brick", at:[0,0,-12], top:"cap_stone"}; corner for room corners; ledge/balustrade along edges; stairs {steps:4, rise:8, run:8, tread:"tile"}.
- HD-2D prop: extrude {canvas:"barrel", depth:6} (front/back = the sprite, sides = edge pixel colours).
- Gargoyle / carved relief: draw the gargoyle + a grayscale height canvas (light = thick), extrude {canvas:"gargoyle", depth_map:"gargoyle_h", depth:8, levels:4}.
- Lathed candle / urn / baluster / bell: draw the RIGHT HALF of the silhouette from x=0 (axis) on a canvas, lathe {canvas:"candle", segments:12}; flame pixels on an "emissive" layer glow.
- Chain: extrude a link sprite and alternate it: {type:"extrude", canvas:"link", depth:2, array:{count:6, step:[0,-6,0], rotate:[0,90,0]}}.
- Marble floor groups: ctm {name:"marble_ctm", ctm:{base:"marble", method:"full", border:{width:2}}}; floors {texture:"marble_ctm", cell:[..]}: one bevelled border around each connected group, none on the seams. Separate rooms: ctm_tag:"hall" vs "chapel" with ctm:{connect:"tag"}.
- Gothic stone walls: wall {texture:"stone"} runs at any offset (world UVs keep the bricks continuous); base trim = ctm {name:"trim_h", ctm:{base:"trim", method:"horizontal"}} on a ledge row (end caps only where the run stops); random {weights:[6,1,1]} for occasional cracked blocks.
- Spaceship hull: loft {points:[[-12,0],[12,0],[10,10],[-10,10]], d:64, scale_end:[0.3,0.4]} (narrows toward the +z nose), wings = wedge {w:40, h:3, d:24, top_w:8, shift:[16,0], at:[14,2,0], mirror:"x"}, nose cone {type:"cone", r:6, h:12, rotate:[90,0,0], at:[0,5,32]}, engines = cylinder {r_bottom:5, r_top:4, h:10, rotate:[-90,0,0], at:[10,5,-32], mirror:"x"}, canopy box {w:10, h:6, d:14, bevel:2, glass:true, color:"#9fd8ff", at:[0,10,12]}, intakes/hatches = box insets:[{face:"front", rect:[4,2,8,4], depth:3}] (recess) or depth:-1 (raised panel), hangar mouth = an inset touching the bottom edge. Side profile of a fuselage: shape {plane:"zy", points:[[z,y],...], d:<width>}. Export with origin:"bottom".
- Radial engine ring: cylinder {r:3, h:6, at:[16,0,0], array:{count:6, rotate:[0,60,0], about:[0,0,0]}}. Hinged door: box {w:16, h:24, d:2, rotate:[0,-70,0], pivot:[-8,0,0]}. Decal on a fuel tank: cylinder {side:"tank_decal", wrap:"once", u_offset:0.25} (image centre faces +x; u_offset in turns), wrap:"repeat" (repeat:n) = seamless repeats.
- Moss + grime: overlays:[{texture:"grime", where:["bottom","corners"], falloff:20}, {texture:"moss", where:"top", falloff:10}, {texture:"wear", where:"edges", falloff:3}].
Keep it light: kit pieces < 500 tris, few textures shared by many pieces.`;

Object.assign(TOPICS, AUDIO_TOPICS);

export function helpText(a = {}) {
  if (a.op) {
    const u = opUsage(a.op);
    if (!u) throw new Error(`"${a.op}" is not a draw command (art_help {op} covers art_draw commands: ${Object.keys(SIGS).join(', ')}). Tool actions (e.g. art_rig animate) are in each tool's description and the guides: art_help {topic: ${Object.keys(TOPICS).join('|')}}.`);
    return u;
  }
  const t = a.topic || 'index';
  if (t === 'index') {
    return `Topics: ${Object.keys(TOPICS).join(', ')}. Ops: art_help {op:"name"} for: ${Object.keys(SIGS).join(', ')}.`;
  }
  if (t === 'ops') return Object.keys(SIGS).map(opUsage).join('\n\n');
  if (!TOPICS[t]) throw new Error(`Unknown topic "${t}". Topics: ${Object.keys(TOPICS).join(', ')}`);
  return TOPICS[t];
}
