# Changelog

## Unreleased

### Skeletal skinning in `art_model`

- `skeleton`: bone hierarchies with rest poses, joint limits, IK chains (two-bone with pole, or CCD), aim / look_at / copy_rotation constraints and bone sockets.
  - Sources: templates (`humanoid`, `exosuit`, `quadruped`, `chain`, `landing_gear`), rigid-rig parts (`from_parts`), an art_anim library skeleton (`library`) or explicit bones.
  - The humanoid and exosuit templates use the art_anim humanoid_hd bone names.
  - `cable` builds a tube along a chain, with automatic weights.
- `skin`: vertex weights with at most 4 influences, normalised.
  - Methods: `heat` (diffusion), `distance` and `rigid` (blended seams), plus smoothing and `subdivide`.
  - Painting by region (box, sphere, part, below, above) or from a weight canvas.
  - Blend shapes: sculpted shapes or variants, and correctives driven by a joint angle.
- `weights`: the weights check (unweighted vertices, more than 4 influences, non-normalised weights) and a per-bone heat map.
- `animate` / `pose` on skinned models:
  - Bone keys, easing, events, morph weights, IK targets and foot plants.
  - `retarget` maps art_anim clips onto 3D bones by name.
- `preview` and `render` deform skinned clips, so `render` sweeps bake one 3D body into 8-direction pixel sprites with the same quantize and outline options.
- `export`: glTF `skins` (joints, inverseBindMatrices), JOINTS_0 / WEIGHTS_0, morph targets on skinned primitives, and TRS + weights animations.
  - Every skinned export is checked by a new structural validator (`src/gltfvalidate.js`).
  - `profile:"roblox"`: at most `max_bones` joints per mesh (default 50, assumed), split across several skins when needed; sanitised names; R15 names; no morphs.
- Exports of models without a skeleton and skin are byte-identical.
- The tool-list size limit rises from 32650 to 33000 (32847 measured).

### 2D skinning, deform shapes and constraints (`art_rig`)

- New `art_rig` actions, the 2D counterpart of `art_model` skinning:
  - `skin`: binds a part's cell (`part`, with `absorb` for the joints it replaces) or a whole drawn canvas (`canvas`, `bones:"all"`) to the bones as a lattice mesh clipped to the opaque pixels (cut where pixels do not connect). Weights: `heat` (default), `distance` or `rigid`, at most 4 influences summing to 1, `paint` regions, `weight_canvas`, `smooth`; per-view meshes and weights (`views`) for 8-direction rigs.
  - `weights`: weights check (unweighted, pruned, non-normalised, unused bones) plus an image: the drawing with its lattice and a bone's heat map (or the dominant bone per pixel).
  - `shapes`: deform shapes (sculpt move / scale / rotate / inflate in a region, or a variant drawing fitted to the silhouette that swaps in at >= 0.5) and correctives driven by a joint angle (`driver:{bone, from, to}`). Keys, poses and `preview` take `shapes:{name: w}`.
  - `chain`: cable / strap / sling helper. It adds bone-only segments along a drawn strip, heat-skins it and returns the CCD end.
  - `export`: `<name>.skin2d.json` (bones, rigid part cells, meshes with vertices / uvs / triangles / joints / weights / shapes, baked clips) + textures + strips; with `layers:true`, one strip per drawn part / mesh.
- Pixel-art-safe deformation: inverse-mapped nearest sampling in a Scale2x 8x copy with a 3x3 majority, exact copies for triangles that only move (the rest pose is the drawing), pinhole / stray cleanup and outline repair. Only the drawing's colours; deterministic.
- Part option `bone:true` (a joint without a drawing). Rig options `limits:{part:[min,max]}` and `constrain:[{type:"aim"|"look_at"|"copy_rotation", ...}]` with named targets from pose / key `targets`. IK ends take `chain:n` for damped CCD over n bones.
- `art_anim` clips, `render` and `batch` play on skinned rigs unchanged. Rigs without `skin`, `constrain`, `limits` or `chain:n` render byte-identical to before.
- Web UI: the rig viewer's "Skin mesh + weights" mode (`/api/rig/<name>/weights.png`). Help topic `skin2d`; demos and the runtime format in `docs/skin2d/`.
- The tool-list size limit in `test/quality.test.js` rises from 32650 to 33100 (33038 measured).

### Animation library (`art_anim`) and 2D rotated-sprite tooling

- New tool `art_anim`:
  - `skeleton`: a rig definition with named proportions and masks; template presets become the clip library, plus the standard `walk_aim`, `flinch` and `walk_hit`.
  - `clip`: keys, events, and `layers` with masks, weights and additive layers.
  - `skin`: creates a rig sized for the proportions, or binds an existing one; equipment and loadouts.
  - `retarget`, `render` and `list` / `info`.
  - `batch`: skins × loadouts × clips × views written as game strips with `__front` splits, merged into a manifest with frame, anchor, padding, events and draw order.
  - `gltf`: a skinned cutout mesh with the clips as animations.
- `art_rig`:
  - `depth` model: per-frame arm order from a 3D proxy, with hysteresis and split parts.
  - z keyframes (`key.z`).
  - New actions: `zcheck` (z-flicker and depth violations), `consistency` (cross-view checks) and `derive` (copy cells between views).
  - Part options `link` (draw another view's cell), `art` (draw another part's cell) and `hide` (hidden by default).
  - `animate` options `stable` (quantized drawing angles with hysteresis) and `events`. `animate` stores per-frame order and events in the canvas meta and the spritesheet JSON.
- Weapon handling:
  - Front-view aim: a short barrel canted inward toward the centre line, drawn over the forearms and under the hands, with a head tilt onto the stock (`foreshorten.aim_floor`, `aim_cant`, `weld_tilt`).
  - New weapon point `charge` (charging handle) and state `reload_charge`. The `reload` carry is now muzzle-up at the chest instead of muzzle-down.
  - `humanoid_hd` with a weapon adds `mag` and `mag_hand` parts and a reload preset (grab, strip, pouch, seat, charge) with events.
- Export fixes:
  - `./` and `../` paths resolve against the server's working directory, and bare relative paths report that they went to the workspace exports folder.
  - `art_animation export {layout: "files"}` writes one strip per tag, and the default `rows` layout says it stacked several tags.
- Web UI Layers view: `/api/rig/<name>/layers` and `/debug` are now served by `art_rig layers {tag | all_frames}` (every frame's stack with the rule that placed each part: depth model, weapon layer, z keys, split parts, hidden reasons) and the new `art_rig debug_render` (per-part atlas), instead of the static order derived from the rig definition.
- Skill `anim-library`; help topic `library`.

### First-person viewmodels (`art_fp`)

- New tool `art_fp` for the fp v2 runtime contract (rigged arms per handling class plus gun, magazine, attachment and item sweeps composed at runtime):
  - `kit`: editable `art_model` kit, with the standard gun of every class built to its `handling.js` grip geometry, magazines, generic attachments and items.
  - `sweep`: yaw × pitch sheets (at most 1024 px, split across sheets) with every anchor per cell, written to `fp_guns`, `fp_mags` and `fp_attach`. Moving-part state variants and optic lens layers are included.
  - `batch`: skins × classes × clips as back and front strips with per-frame gun, magazine and item sockets and events, plus `@vgrip` / `@agrip` variants, written to `fp`.
  - `composite`: one frame exactly as the game draws it (the `fpv2.ts` cell pick, anchors and render order).
  - `check` and `paint` (sweep sheets out to canvases and back, anchors kept).
- Arms: an eye-space skeleton with finger chains and two-bone IK onto the drawn anchors. Bones are part sprites per view bucket with RotSprite rotation. Arm pixels behind a prop go to the back layer.
- `art_model` keeps an `fp` key on models (kit metadata). Help topic `fp`.

### Hand-drawn first person (`art_fp` 2D sources)

- The fp v2 contract from pure 2D art; `fpv2.ts`, `composite` and `check` are unchanged.
- `template`: blank key canvases for guns, magazines, attachments and items (named views hip, ads, reload, side, rear, top and others, or yaw / pitch / roll), with a guides layer showing the class anchors in that view. Arm part canvases (upper arm and forearm per view bucket, hand per pose with back / front layers) with joint / wrist / grip guides.
- `anchors`: place, move and remove anchors in the canvas meta; suggestions from the silhouette with a confidence; warnings for anchors off the opaque pixels or inconsistent between keys.
- `sweep2d`: a few key drawings -> the full yaw × pitch sweep in the same files and manifests as `sweep`. Nearest key, card-plane perspective warp plus a correction field through the anchors, nearest sampling from a Scale2x upscale and re-outlining: source palette only, hard alpha, deterministic; anchors take the same warp and are exact at the keys. Painted cells (`paint` import) are kept as override canvases.
- 2D arms skins: `batch {skins:[...]}` resolves a skin to its drawings, driven by the same `classClips` / `solveClip`; the hand pose drawing is picked per frame from the finger preset. Locks carry per-hand `pose`, `vis` and `clamped` for 2D skins; `check` warns on hidden hands and clamped reach. `setDeformer(skin, fn)` is the seam for a mesh deformer.
- `trace`: a 3D arms skin exported as an editable 2D skin.
- Mixed sources: 2D gun + 3D arms, 3D gun + 2D arms, all 2D. The all-2D path builds no kit 3D model; hand-drawn guns take their prior anchors from the class table (`classSockets`, `CLASS_MAG`; `KIT_BUILDS` counts kit builds).
- Hands against the gun, for any set with a 2D skin or gun:
  - Hand drawings have `back` / `front` / `trigger` layers.
  - Keys carry paintable contact zones (`mask_grip`, `mask_guard`, `mask_fore`, `mask_pinch`; automatic when empty) warped with the sweep, and an optional `height` layer for per-pixel depth (automatic from the distance to the outline).
  - Front finger pixels over a prop outside its zones go behind it; the trigger finger shows only in the guard opening.
  - Batch nudges hidden hands and hands that hide the magazine (fallback poses, half-pixel offsets inside the tolerance).
  - Locks carry `contact` and `mag_visible`. `check` fails on finger pixels outside the zones or a magazine in hand under 50 % visible, and reports `contact_checks`, `worst.finger_out_px` and `worst.mag_visible_min`.
- New hand pose `pinch` (charging handle), falling back to `mag_pinch`.
- `fpclips` hands carry the finger preset name (`pose`), additive. #16's 3D outputs are byte-identical (tested).
- Demos in `docs/fp2d/` (`scripts/fp2d-demos.js`), drawn with Agent Art's own drawing ops (`scripts/fp2d-art.js`).

### Planets and space (`art_planet`)

- New tool `art_planet`: `planet` (presets ice, toxic, bloom, lava, desert, gas, barren; biome rules, fbm / ridged / billow noise with domain warp, continents, craters, canyons, emissive seams, night lights, clouds, rings, atmosphere) writes equirect and cube-face maps (albedo, height, height16, normal, roughness, emissive, night, clouds), a cube-sphere `.glb` with LODs, a cloud shell, an atmosphere shell with shader parameters and a ring annulus, quadtree tiles with a `.tiles.json` index, an octahedral impostor and a disc sprite. All textures are pixel-art palette ramps with ordered dither and at most 1024 px.
- `system` generates an original star system of 4 to 8 bodies with distinct biomes, plus a palette strip.
- `terrain` builds a landing zone sampled from a planet: chunk `.glb`s with LODs, skirts and collision meshes, an RGBA splat map, a tileset, `heightfield.json`, GPU-instanced rocks, crystals and grass, arches, and colony anchors.
- `rocks` (boulders, slabs, shards, crystals, grass cards, mesas, buttes, spires, arches), `asteroids` (shapes, LODs, belt / ring / cluster fields), `skybox` (nebula and starfield cube faces plus an equirect) and `fx` (sun, flare, debris, dust storm, lightning).
- `art_help {topic:"planets"}` and the `planets-space` skill, with three.js snippets for the atmosphere, night lights, quadtree streaming, far-planet impostors and terrain loading. Demo renders are in `docs/planets/`.
- Existing `art_model` exports are unchanged byte for byte (tested).

### Back-view holding

- **Gun seen from behind:** it is yawed outward in 3D and projected, instead of being forced to a 45° screen angle. A level aim stays level, a muzzle-down carry points down, and every yawed back view has one length (`foreshorten.back_floor`). Runtime sheet cells now match the frames: the back-aim socket `rot` drops from ±45° to a few degrees, and the composite error to 0.1 px.
- **Arms:** the arms in the back view follow the projected 3D arm solution, so the elbow sits out and below the shoulder. This fixes the #8 back aim that raised the arm over the shoulder. `weapon.back_elbow: false` restores the 2D IK.
- **Draw order:** in back-facing views, the forearms and hands of arms holding the gun, and their upper arms past the torso's centre, are drawn under the whole trunk (the chest and its parents). Any arm part already behind the torso from the camera's view also goes under the whole trunk. `depth.back_occlusion: false` turns this off.
- **Weapon check:** two new issues, "elbow raised above the shoulder (seen from behind)" and "<part> drawn over the torso from behind while in front of the body".
- **Socket pitch:** sockets now choose the better-fitting of the two pitch cells around the elevation, and emit that cell's pitch when it is not the nearest.
- **Composite and class check:** both account for the support hand sliding along the handguard.

### Runtime weapon layers (`art_anim`)

- Handling classes (pistol, smg, rifle, lmg, sniper, launcher, none) with a standard grip geometry and tolerance per class, scaled to the character frame.
- New actions:
  - `weapon`: a standalone gun asset (rig plus `library/weapons/<name>.json`) with its grips at the class geometry, or copied from a skin's gun.
  - `conform`: checks the gun against its class geometry; `fix` moves the points onto it.
  - `weapon_sheet`: a 5-view × pitch world sheet without the magazine, a magazine overlay (`<name>_mag.png`, manifest key `mag`; left out on `mag:false` frames) and attachment overlays. Each sheet is at most 1024 px, and the result is merged into `manifest/weapons_world.json`.
  - `composite`: the baked frame next to the engine-identical runtime frame.
  - `weapon_check`: hands on the grips across every gun of a class.
- `batch {weapon: "runtime"}`: exports gun-free body and `__front` strips with per-frame sockets `{x, y, rot, pitch, order, hidden?}`. The sockets are mirrored for mirror views, and the auto `pad`, `frame` and `anchor` are kept.
- New shared module `src/handling.js`, with no view or frame assumptions. It holds:
  - the class table: pistol, smg, rifle, dmr, shotgun, lmg, sniper and launcher, plus knife, grenade, med, tablet, unarmed and none;
  - grip geometry and tolerance in body units, and `scaleGeometry`;
  - the carry positions, the default points and sockets, and the attachment types;
  - `conform`, which works in 2D or 3D and in any units.

  `dmr` and `shotgun` keep the rifle grips and map to the third-person `rifle` set. `weapon.js` now imports its carry and point data from this module.
- Weapon projection is shared between frames and sheet cells (`projectWeapon`). Template weapon defaults are exported as `weaponDefaults`.

### Cleanup (`art_cleanup`)

- New tool `art_cleanup` for bulk, dependency-aware cleanup of superseded assets. `plan {select, include_exports?, include_dependents?, prune_manifest?}` is a dry run with counts, sizes, blockers and warnings. `apply {plan_id, confirm:true}` moves exactly the planned assets to `<workspace>/trash/<batch>/` (a soft delete). `trash` lists the batches, `restore {ids|all}` puts back files, graph edges (in their original order), tags, notes, approvals, review notes and their images, pins and pruned manifest entries byte for byte, and `empty {older_than?, confirm:true}` is the only hard delete. `usage` reports disk use by kind, project and group, with the biggest offenders. `replace {old, new}` (or `pairs`) records `new replaces old`, moves old's semantic edges and open review notes to new, and marks old superseded.
- Selectors: `names` (globs; `*` stops at `/`, `**` does not), `ids`, `kind`, `tag`, `group` (nested), `project`, `rel:{rel, to|from}`, `superseded`, `orphans`, `stale_exports`, `older_than`, `unused_since` and `exclude`. An array of selects is a union.
- Safety: hard dependencies (`depends_on`, `uses_palette`, `part_of` a project; a rig and its parts canvas are one asset) block a plan unless `include_dependents` or `force` is set. Approved assets need `allow_approved`. Pinned assets warn. Export files are only touched inside `workspace/exports` or the user's `cleanup.allow_paths` (`config.json`, which the agent cannot set). Symlinks, traversal, paths that resolve outside and workspace internals are refused. Every apply and restore is logged as a `removed` / `restored` activity entry and graph event with the plan id.
- Compact replies: counts plus the first 10 items (`limit`, or `full:true`).
- `src/assettypes.js` adds `registerAssetType(kind, spec)`, the one hook through which a new asset kind joins the graph (resolve, exists, derived edges) and cleanup. Built-in kinds: canvas, rig, model, audio, project, export.
- Web UI: multi-select in the asset browser (checkboxes, Shift+click range, all shown, by tag) with *Plan cleanup…* (dry run with blockers and sizes, then apply). The *Cleanup* panel has Trash (restore / empty, sizes), Disk usage and Settings (allowlist). Superseded and orphan badges appear in the browser and the graph. `/api/assets` adds `flags` and `tags`, and `/api/graph` nodes carry `superseded` and `orphan`.
- `art_help {topic:"cleanup"}`.

### Changed

- `art_canvas delete`, `art_model delete`, `art_audio delete` and `art_project delete` now move the files to the trash instead of deleting them. Replies gain a `trash` id. Graph edges and review notes are left as before. Set `cleanup.trash_deletes: false` in `config.json` to get hard deletes back.
- Tool list: the size test limit rose from 28380 to 29400 characters (`art_cleanup` adds ~1.15k; 29285 measured).

## 0.7.0

### Weapon handling (`art_rig`, `art_model`)

- `art_rig` `weapon:{class, points, attachments, attach, carry, poses, states, standoff, foreshorten, layer, ...}`. Both hands use IK on the grips every frame with wrist orientation, and a pistol support hand cups the trigger hand. Reach limits apply: shoulder protraction, then the support hand slides along the rail, then the weapon moves back, or the frame is flagged; limbs never stretch. Torso, head and limb capsules form a dead zone: the weapon is pushed out forward first, then outward, and the stock stays in the pocket. Aim has a cheek weld. The muzzle stays down outside firing states. Carry states: long guns `aim`, `ready_low`, `ready_high`, `hip`, `sprint`, `reload`, `slung`, `one_hand_low`, `drop` and `holster`; pistols `aim`, `compressed`, `low`, `reload`, `one_hand_low` and `holster`. `humanoid_hd {weapon}` maps every preset to a carry state and adds attachment cells.
- Weapon draw order is driven by depth (over the torso when held in front). New actions `check` (per-frame hand-grip distance, over-extension, inverted elbows, penetration, muzzle flags, layering, visibility, with a pass/fail summary), `layers` (draw order with the reasons) and `explain` (why A is drawn over B). `animate {constraints:"refuse"|"fix"|"warn"|"off"}` defaults to refusing to write violating frames when a weapon is set.
- Front-view readability: a barrel pointing at the camera gets an outward cant with a length floor. In back views the muzzle angles out past the silhouette.
- `art_model` `fp_rifle` / `fp_pistol {weapon}`, with the attachments `vertical_grip`, `angled_grip`, `bipod` and `suppressor`. `render`, `animate` and `check` take `{hold}`, which solves the `fp_arms` hands onto the grips per carry state, with reach and dead-zone correction and muzzle discipline. `animate {hold}` bakes the arms clip and, with `bake_weapon`, the gun clip.
- Equipment sets: `variant_sets` and `animate`/`preview {variant:"heavy"}`.
- Skill `weapon-handling`.

### Changed defaults and fixes

- `mirror_pairs` no longer swaps arm chains that are held by IK onto a weapon (the gun used to change hands). This also applies to rigs without a weapon: an arm chain with a non-foot IK end in the key (a hand on a prop) keeps its side, so such existing clips render differently. Set `mirror_hands: true` on a key to swap them deliberately.
- `humanoid_hd`: the `_f` limbs were on the wrong screen side in the 3/4, front and back views; they are now on the correct side. In the front and back views the thighs draw above the pelvis, which removes the "shorts" look.
- Preset animation tags are always `<preset>_<view>` (previously `idle` for the first view and `idle_<view>` for the rest).
- The `preview` ground line is drawn at the feet instead of at the root.
- `art_critique`: HD sprites (64x96 and up: longest side >= 96 px and at least 6144 px) get a 48-128 colour budget, with 32 kept for low-res. Ordered dithering in HD is no longer flagged as noise. `style` overrides the detection.
- Compact replies: `art_info` and `art_rig` `info`, `create` and `update` reply with a summary. `full: true` returns everything; `fields:[...]` returns only the fields named.
- `docs/rig-hd-guide.md`: the view-band offsets are the tallest cell + 1 (0, 74, 148, 222, 296 by default; 55, 110, 165, 220 with `cape: null`). The doc was wrong; the code was right.

### Web UI redesign

- Activity timeline: every MCP tool call (and every UI or CLI op) is a live entry with tool, action, key arguments, duration, result summary or error, and before/after snapshots of the canvases and models it changed. Filters (tool, current asset, errors, agent only) and search; click opens the asset at that state, `⇆` compares before and after.
- Asset browser for canvases (layers, animation tags), rigs, 3D models, audio, exports, projects and groups, with hide / pin / solo per item. Hidden and pinned state is saved per workspace in `ui-state.json`.
- Viewers: canvas editor (zoom at cursor, pan, grid, tile, frame scrubber, onion skin), animation player with a per-view (8-direction) grid, rig viewer with a skeleton overlay, 3D viewer (three.js r170 vendored in `public/vendor/three`), audio player with waveform, spectrum and the analysis report, sprite sheet and export preview with anchors, project overview, asset graph, and a Layers view (draw order per frame with the rule that placed each part, debug tint, overlaps, hover hit-test, z-order lanes).
- Compare mode, follow mode, resizable / dockable panes, keyboard shortcuts, narrow-screen layout.
- Server: `/api/events` also streams `activity` and `graph` events. New endpoints: `/api/activity`, `/api/trace`, `/api/snapshot/<id>[.png]`, `/api/assets`, `/api/graph`, `/api/graph/node`, `/api/reviews`, `/api/review-image/<file>`, `/api/model/<name>/glb|thumb.png|info`, `/api/rig/<name>`, `/api/rig/<name>/preview.png|layers|debug`, `/api/audio/<name>`, `/api/audio/<name>.wav|/analysis`, `/api/export-file`, `/api/ui-state`. `/api/op` accepts an optional `trace: {call, tool}`. `art_model export` builds its .glb through the same in-memory path the 3D viewer uses (output unchanged).

### Asset graph (`art_graph`)

- Typed relations between assets (`part_of`, `variant_of`, `view_of`, `layer_of`, `uses_palette`, `rendered_from`, `exports_to`, `depends_on`, `replaces`, or a custom label with optional attrs such as `{view:"side"}`), tags, one-line notes and nested groups, stored in `graph.json`.
- Structural edges are derived from the workspace: project membership, layers, animation tags, rig parts, rig animate and model render outputs, model textures, normal maps, CTM tilesets. Exports are recorded as `exports_to` edges when they run.
- `summary`, `query {node, depth, rel, dir}`, `find {tag|rel|text|kind}` and `path {from, to}` answer in compact text (default cap 1600 characters). Group nesting refuses cycles; traversal is cycle safe.

### Review notes (`art_review`)

- The user marks a frame, view, layer, part, model view or audio range in the UI with a category (`fix`, `redo`, `inconsistent`, `layering`, `style`, `question`, `approve`), priority, note and an optional asset to compare with.
- `list` returns one line per note, `get` an image of the marked region when noted, now, and the compared asset, plus the history; `update` moves notes through `open` -> `in_progress` -> `fixed` (attaching the new version) -> `accepted` or `reopened`.
- Replies of other tools get one extra line when the asset they touch has open notes, or when it is approved by the user.

### Hard-surface detail (`art_model`)

- PBR materials: part `material` = `painted_metal` | `bare_metal` | `rubber` | `plastic` | `glass` | `emissive_panel` | `fabric` or `{metal, rough}`, written as glTF `metallicFactor` / `roughnessFactor`. Canvas layers `metal` and `rough` become a `metallicRoughnessTexture`, and canvas `meta.material` sets a whole canvas. `atlas:true` merges them into one metallicRoughness atlas.
- Height and normals: a `height` layer (or `<canvas>_h` with `bump`) gives a pixel-correct normal map: no blur, bevel-aware, the high side gets the chamfer, tiles wrap. `bump:{strength, bevel, auto:"luminance"|"panels", ...}` on a part, on the canvas meta, or on export/preview. The preview lights normal maps, metalness and roughness per pixel.
- Greebles: a `greeble` part and box/wall/floor `greebles:[{face, ...}]`. A seeded, non-overlapping scatter of 13 built-in pieces (panel, vent, pipe, conduit, antenna, bolts, hatch, heatsink, nozzle, dome, cables, tank, block) or your own models (`"model:<name>"`, `greeble_kind`), with density, size, height, panel grid, alignment and an avoid mask or rectangles. Pieces merge into the model's materials, or `instanced:true` exports them with `EXT_mesh_gpu_instancing`. `drop_lod` (auto: flat pieces at LOD 1, tall ones at LOD 2).
- Sweeps: `tube` / `sweep` sweeps a circle or a custom `profile` along a polyline, Catmull-Rom or Bezier path, with rotation-minimising frames, mitred corners, twist, taper, caps and texture wrap. `from` + `to` + `sag` makes a hanging cable.
- Trim sheets: `art_model trim {canvas}` paints a sci-fi sheet (colour, height, metal, rough and emissive layers) or marks your own (`strips:{name:[y,h]}`). Part `trim:"sheet:strip"` maps bevels, inset walls and thin faces to that strip (u along the face at world scale, v across the strip). Tubes map the strip around their section.
- Mesh ops: part `boolean:"subtract"|"union"|"intersect"` with `target` (index, `id` or name). It runs BSP CSG per closed piece and splits T-junctions, so results stay edge-manifold. Model `merge` welds vertices and drops hidden faces. Model `morphs` export glTF morph targets with named weights, and `preview {morph}` shows them.
- Part `cast_shadow` / `receive_shadow` become node extras.

### Render cost (`art_model export`)

- `bake_ao`: a BVH ray-cast hemisphere AO into a lightmap (`occlusionTexture`, unique `TEXCOORD_1`, NEAREST) and/or `COLOR_0`. It is deterministic. Each LOD level bakes against itself into one shared lightmap.
- `lods:[1, 0.5, 0.2]`: quadric half-edge collapse that keeps each triangle's own UVs, material and open borders, and drops hidden faces between pieces first. Output goes to `<name>_lods > <name>_LOD0..n` nodes (or `lod_mode:"files"`) with recommended switch distances in `meta.lods`.
- `impostor`: a hemi-octahedral or ring billboard atlas (albedo, world normal, depth) plus `<name>.impostor.json`.
- `collision` (convex hull or box set) and `occluder` (conservative box set): hidden named nodes, not counted in triangles. `stats:true` adds per-part triangles and bounds.
- `cull` (layout rooms): one `room_<name>` node per room, doorways found automatically, and `meta.cull` with rooms, portals, PVS and usage.
- `preview {ao, lod, morph}`.

### Breaking / behaviour changes

- Layer names `height`, `metal` and `rough` are now material channels: a texture canvas with a layer of that name no longer shows it in the base colour (like `emissive`), it becomes the height (normal map), metalness or roughness input. Rename such layers to keep them as paint.

### Compatibility

- Models and exports that use none of the new options are byte-for-byte the same as before hard-surface detail (md5 of `.glb`, `meta.json`, `ctm.json`, preview and render PNGs). `assembleGLB` (export and the 3D viewer) builds both, so the viewer's .glb carries the PBR materials, greebles and morphs too.
- The npm package grows from 362 kB to 770 kB packed (2.6 MB unpacked) because the web UI vendors three.js r170 (MIT) in `public/vendor/three`.
- The tool-list size limit in `test/quality.test.js` goes from 27400 to 28380 (28133 measured) for the new `art_model` options.

### Docs

- `art_help {topic:"3d"}`: new "Hard-surface detail" and "Render cost" sections, plus recipes for hull greebling, a corridor with one trim sheet, a pipe run, and LOD + impostor for a city block. README section with renders (`docs/surface/`, rebuilt by `node docs/surface/build-demos.mjs`). New skill `hard-surface`.
- README for 0.7: the feature list covers weapon handling, the web UI (timeline, asset browser, viewers, graph, review notes) and hard-surface detail + render cost; an "Upgrading to 0.7" note lists the behaviour changes; the tools table lists `art_rig` `weapon` / `check` / `layers` / `explain`, `art_model` `hold`, `art_review add` and the `graph` help topic; `weapon-handling` is in the skills list; a tested `art_graph` / `art_review` example. The outdated 0.5 behaviour note is gone.
- Skills `rig`, `rig-hd` and `fp-weapon` explain the compact cells reply (`[x, rows[view], w, h]`) and the `<preset>_<view>` tags (`walk_side`); `rig` critiques the tag it made.
- `art_help {topic:"3d"}`: first-person guns name their grips under `weapon.grips` (with the default sockets) and `weapon.frames`; `art_help {topic:"rig"}`: `weapon.layer.pin` is keyed by view or `all`. The `art_help` tool description lists the `graph` topic. `docs/rig-hd-guide.md` critiques `walk_side`, not `walk`.

## 0.6.0

### 3D rigs, clips and pre-rendered sprites (`art_model`)

- Rigid-part rigs: a part with `name` becomes its own glTF node and mesh. `parent` nests it under another named part, and its transform is local to that parent (translation = joint offset, rotation, scale). `pivot` is the joint. Unnamed parts merge into the root mesh or into their named parent's mesh, and `rig:{merge:false}` makes every part a node. `create` and `info` report the node tree. Models without named parts, sockets or clips export byte-for-byte as before.
- `pose {name, pose, parts:{<part>:{rot, at, scale}}, base?}` stores per-node offsets from the rest pose. `animate {name, clip, keys:[{pose|parts, t, ease?}], loop?, duration?, events?}` stores a clip. Export writes a glTF animation per clip. All-linear clips use LINEAR samplers at the key times, all-step clips use STEP, and smooth or mixed clips are baked at 30 fps. Events go in the animation `extras`.
- `sockets:{muzzle:{part, at, look?}, ...}` export as empty child nodes `socket_<name>`. `meta.json` gets a `rig` table with parent-space node transforms (Roblox Motor6D C0).
- `preview {name, pose}` renders a pose. `preview {name, clip, frames, view}` renders a contact sheet of the clip. The new `fp` view is a first-person camera at the model origin looking down -Z with a 60° fov.
- New templates in view space (32 px = 1 m): `fp_arms` (clavicle > upper arm > forearm > hand > fingers + thumb per side; poses `rest`, `grip_rifle`, `grip_pistol`; clip `idle_breathe`), `fp_rifle` (receiver, barrel, handguard, stock, magazine, bolt, charging handle, optic, trigger; five sockets; clips `fire`, `reload_tactical`, `reload_empty`) and `fp_pistol` (frame, slide, barrel, magazine, trigger; clips `fire`, `reload`). Override them with `textures`, `set` by part name, `add`, `remove`, `poses`, `clips` and `sockets`.
- `update` `set` and `remove` accept part names as well as indices.
- `render {name, canvas, pose|clip, frames|fps, angles|sweep, camera, size, light, outline, quantize, only|hide}` renders pixel-art frames into a canvas animation: nearest texels, no anti-aliasing, transparent background, optional median-cut or palette quantize with ordered dither, and a 1 px outline. Every frame stores socket anchors (screen x, y and rotation) in `meta.anchors`, which spritesheet JSON exports as `frames[].anchors`. `sweep:{yaw, pitch, roll}` renders a row-major angle grid tagged `angles`. `only` and `hide` render aligned layers.
- Skill `fp-weapon`. `art_help {topic:"3d"}` has new "Rigs & clips" and "Pre-rendered sprites" sections, each with a first-person weapon example.

### Rigs (`art_rig`)

- `animate {..., ik_from:{canvas, animation?, map:{hand_f:"socket_grip_r" | {anchor, bend?, rot?, at?}}, offset?}}` takes per-frame IK targets from another canvas's anchors and copies its frame count, timing and loop, so 2D arms follow a pre-rendered gun clip.

### Docs

- README: rigid-part rigs, poses, clips, sockets, FP templates and `render` in the feature list, the `art_model` section, the `art_rig` section (`ik_from`) and the tools table; a tested end-to-end example (`fp_rifle` > reload clip > `.glb` > sprite frames > 2D arms with `ik_from`); the fp-camera near-plane limitation.
- Skill `fp-weapon` now runs as written in a fresh workspace (texture canvases, every render layer, a 2D arms rig for `ik_from`). New skill `prop-rig` (doors, chests, turrets: named parts, pivots, poses, clips, export).
- `art_help {topic:"3d"}`: template part, pose and slot names, clip-level `ease`, loop closing, deleting clips and poses, render defaults and limits, `ik_from` map options, the near-plane limitation; the pre-rendered example no longer needs a project palette.

## 0.5.1

### Docs

- README: tested examples for the ship kit, `humanoid_hd` (plant, secondary, IK), FPS/sci-fi SFX and custom glide/glitch sounds; 0.5 behaviour changes; updated tools table.
- New built-in skills `ship-model` and `rig-hd`; `sfx-pack` covers firearms, weapon handling, footsteps and sci-fi sounds.

## 0.5.0

### Audio

- New SFX recipes for a sci-fi FPS, each with pitch/length/intensity/variation/wet vars:
  - Firearms: `gunshot_rifle`, `gunshot_pistol`, `gunshot_marksman` (long outdoor slapback), `gunshot_shotgun`, `gunshot_smg`, `gunshot_lmg`, `gunshot_suppressed`. Each layers a crack, body, thump, sub, mechanical click and an environment tail (`vars.environment: "outdoor"|"indoor"|"canyon"`).
  - Weapon handling: `mag_out`, `mag_in`, `bolt_rack`, `dry_fire`, `shotgun_pump`, `casing_drop` (`vars.surface: metal|concrete`).
  - Sci-fi: `laser_bolt`, `plasma_shot`, `shield_hit`, `glitch_tear`, `teleport_swell`, `servo`, `drone_rotor` (loops), `hologram_ui`, `alarm_klaxon` (loops), `radio_squelch_on`/`_off`, `bullet_whiz`, `ricochet`.
  - Movement: `footstep` (`vars.surface: metal|dirt|concrete|snow|grate`).
- New layer kinds: `glide` (a tone or noise band following a frequency path, with AM, vibrato and a swell envelope) and `glitch` (stutter, bitcrush shards, dropouts).
- `fx`, `reverb`, `target`, `loop`, `tail` and `names` are declared in the `art_audio` schema. Top-level `fx` and `reverb` now work on custom layered sfx. `fx` accepts `[{type}]`, `"dc"`, `{comp:{...}}` or a JSON string; this fixes `fx type "undefined" unknown`. `reverb` accepts `{preset, wet}`, a preset name or a JSON string, where before it was silently ignored. On recipes, `reverb` overrides the recipe's own.
- `vars.target` (peak dBFS) is honoured for recipes and custom layers; the hover recipe used to peak at -9 dBFS while asked for -3. The critique's `too_quiet` respects the requested target.
- A `note`/`voice` layer without an instrument or patch uses a default triangle tone instead of crashing. Bad layers (unknown kind, instrument or recipe) fail before anything is saved, and a failed render no longer leaves an empty asset behind.
- `pitch_env`, `amp`, `filter`, `vibrato` and `oneshot` set on a layer override its patch. A negative `pitch_env.amount` rises, and `pitch_env.shape:"linear"` sweeps evenly over `time`. The recipe helper's `up` option now actually rises.
- sfxr layers with a DC offset (square/saw slides) get a 20 Hz DC-blocking high-pass; `dc:false` keeps the raw output. Pitch clarity is measured on mean-removed frames, so an offset no longer reads as a clear tone.
- `loop:true` (or `{length, crossfade}`) on sfx gives a seamless equal-power crossfaded loop, with loop points in the export (WAV `smpl`, OGG tags, sidecar).
- `delete` accepts wildcards (`"pew_*"`) and `names:[...]`, like `export`.
- Partial song update: re-sending a saved song with only `tracks` or only `sections` merges them into it per track/section (`null` removes one).
- Analysis: drumless material (pads, drones) prefers the half-tempo candidate when its onset strength is comparable, so slow pads are no longer felt at double tempo. `loop_level_change` compares beat-aligned RMS windows when the tempo is known and discounts level changes the loop itself makes, so rhythmic loops with intended gaps no longer trigger it.
- `info` on a recipe-made sfx shows `resolved: {layers, fx, reverb, target}`; sending these back with the same seed reproduces the sound.

### Canvas and animation

- `art_canvas crop` on frame strips crops every frame with the same rect (in frame coordinates) and keeps frames, animations, tags and rig anchors. It used to flatten the canvas to one frame.
- `rotate {angle, expand:true}` grows the canvas (every frame) to fit the rotated content, so nothing is cut off. The default is unchanged.
- `outline` no longer doubles to 2 px when re-run. `skip_existing:true` treats pixels already in the outline colour as outline. It is on by default when the layer already contains that exact colour; `skip_existing:false` restores the old behaviour.
- `clear` with no region clears the whole layer (or the whole frame when `frame` is set). This is now documented.
- `stamp_visible {keep_visible:true}` keeps the source layers visible.
- `ellipse` honours `thickness`, like `rect`.
- `text {font:"5x7"|"7x9"}` adds two larger built-in fonts (A-Z, 0-9 and punctuation); 3x5 stays the default.
- Spritesheet export `json:false` skips the sidecar json. The shared exporter checks `a.json === false`.
- `noise` accepts a `"keep"` colour that leaves pixels unchanged. Under a `mask`, transparent noise colours only erase with `erase:true`.
- `adjust {alpha}` is a change in opacity (-1..1), clamped to 0..1, and bad values get a clear error. `set_alpha` sets opacity directly. Behaviour change: `alpha:0.5` no longer means "half opacity"; use `set_alpha:0.5`.
- `mask:"!<color>"` paints everywhere except that colour.
- `glow {select:"value"|"luma"|"saturation"}` defaults to HSV value, so saturated neon blooms; `luma` gives the old behaviour.
- `gradient {dither:false}` means no dither. Radial gradients fill the corners with the outer colour, so there is no rectangle at the region edge.
- `art_view {tile>1}` uses more of `max_size` (larger zoom plus a nearest-neighbour downscale). For example, `{tile:3, max_size:300}` on a 64 px texture gives 300 px instead of 192.
- `art_draw {commands_file:"<path>.json"}` reads a JSON array of commands, or `{commands:[...]}`, from a file.
- `art_critique {tileable:true}` returns `seams: {ok, edge, interior, worst:[x,y,delta]}`.

### Rigs

- **`humanoid_hd` rig template** for detailed characters (64x96 up to 160x240 frames).
  - 21 parts: a pelvis/torso/chest spine, neck, head, two-bone arms with hands, two-bone legs with feet, and optional `weapon`, `gear_back`, `gear_hip` and `cape` slots.
  - Views `side`, `front_side`, `front`, `back_side` and `back`, plus 3 mirrors (8 directions). Part sizes scale with the frame.
  - Presets with contact, down, passing and up keys: idle (12 frames), walk (16), run (12), crouch_walk (16), aim (1), shoot (6), reload (24), hurt (8), death (20), throw (12) and blink. Each comes with per-view overrides.
- **Per-view poses:** `views: {front: {part: {...}}}` inside a pose or key is merged over the base pose in that view (mirror views use their source view), and tweens with it. `art_rig pose` accepts `views`.
- **Two-bone IK:** `ik: {end: {target: [x,y] | {part, at}, bend, rot?, weight?, plane?}}` in poses and keys, solved per frame after FK in each view. Targets tween between keys, and a key without an entry fades back to FK.
- **Foot planting:** `art_rig animate {plant: true | [parts]}` (alias `ik_feet`) pins stance feet on contact frames with leg IK. Rig `feet` sets which parts count as feet.
- **Secondary motion:** rig `secondary: {part: {stiffness, damping, gravity?, inertia?}}` and `animate {secondary: true}` add a damped angular spring for follow-through. Loops are simulated until the seam repeats.
- **Rig `sampling`:** `"rotsprite"` (3x3 supersampling of the 8x Scale2x cell, majority colour, hole and stray-pixel cleanup) and `"smooth"`. `"nearest8"` (the old path) remains the default for existing rigs.
- **Rig `scale_children`:** a part's `sx`/`sy` also moves its children's joints (foreshortening, breathing).
- docs/rig-hd-guide.md: a step-by-step guide for artists.

### Rig fixes

- A template pose that names a removed variant (the humanoid hurt/death poses use `head:blink`) no longer breaks the rig. `mergeTemplate` drops the reference, and rendering falls back to the base cell.
- `art_rig animate` now explains when a canvas would exceed 8192 px of frames, instead of failing on a generic size error.

## 0.4.0

### Added

- **`art_model` ship and vehicle kit:**
  - Translucent materials: `opacity:0..1` and `glass:true` export glTF `alphaMode:"BLEND"` (opacity in `baseColorFactor`, texture alpha respected). Glass is double-sided, and extras carry `depthWrite:false`. The image is shared with the opaque material, atlas skips these materials, and the preview blends them. `double_sided:true` is also available on its own.
  - New primitives:
    - `wedge` (`top_w`, `top_d`, `shift:[x,z]`).
    - Box `taper` (front-face scale), `bevel` (chamfer px) and `insets` (recessed or raised panels, no CSG), plus the `inset` part.
    - Cylinder `r_top`/`r_bottom` (frustum), and `cone`.
    - `loft` (`shape` with `scale_end`, `shift_end`, `about`).
  - `shape` `plane:"zy"`: side profile `[z,y]`, extruded along x.
  - Part `mirror:"x"|"y"|"z"|[...]` emits mirrored copies with correct winding and normals.
  - `pivot:[x,y,z]` rotates and scales about a local point.
  - Radial arrays: `array.about:[x,y,z]`.
  - Cylinder `wrap:"once"|"repeat"` (`repeat:n`) and `u_offset` (turns).
  - `art_model create` suggests `origin:"bottom"` for off-centre models.
  - `art_help 3d` and the README document the transform order: scale, then rotate X then Y then Z about the part origin or pivot, then turn, then `at`.
  - `art_model` schema: a typed part object (`pivot`, `mirror`, `opacity`, `glass`, `plane`).

### Fixed

- `shape` with an unknown `plane` (for example `"zy"` before this release) silently built `xy` geometry. `zy` is now supported, and any other plane throws a clear error.

## 0.3.0

Everything since 0.2.1.

### Added

- **`art_model` (3D, HD-2D):** low-poly models textured with pixel art, exported as glTF 2.0 `.glb` with no dependencies.
  - Modular kit pieces: `floor`, `wall`, `corner`, `pillar`, `column`, `arch`, `vault`, `stairs`, `ledge`, `balustrade`, `roof`, `rubble`, `box`, `cylinder`/`prism`, `plane`, `shape`.
  - Props: `extrude` (with `depth_map` relief) and `lathe`. Layouts: `model` places other models.
  - Ruins: `broken` edges, `holes` from mask canvases, and scattered `rubble`.
  - Smooth outlines (marching squares plus simplification); `style:"voxel"` keeps the blocky look.
  - World-space UVs at 1 texel = 1 px, continuous across placed pieces (`uv_origin`).
  - Overlays: grime, moss, blood and wear decal shells on `TEXCOORD_1`.
  - Emissive layers and normal maps.
  - Preview contact sheets from a software rasterizer: game camera, front, side, top and iso.
  - Export modes: one baked mesh, `instances`, or `atlas`. `up:"z"` for Z-up engines.
- **Connected textures (`art_model ctm`):** OptiFine/Continuity-style tilesets.
  - Methods: `full` (47), `compact`, `horizontal`, `vertical`, `horizontal+vertical`, `top`, `random`, `repeat`, `overlay`.
  - Baked per world cell from the neighbours across all placed pieces.
  - Export writes `<name>.ctm.json` plus the tileset PNGs, and the README gives a reference `ctmTileFor`.
- **`art_audio`:** sound effects, music, mixing and mastering, with analysis an agent can read.
  - SFX: 31 seeded recipes, sfxr, and custom layers.
  - Instrument presets as JSON patches, plus samplers.
  - Song text notation and generators.
  - Buses, sends, automation and sidechain.
  - A mastering chain to a LUFS target with a true-peak ceiling.
  - Analysis: an analysis image, a listener report, critique and reference compare.
  - Export: WAV with `smpl` loops and JSON sidecars; mp3/ogg/opus through ffmpeg; stems and adaptive-music layers.
- Help topics `3d`, `audio`, `music`, `mixing`, `perception`, and skills `3d-kit`, `sfx-pack`, `music-track`.
- `sample_rate: 44100 | 48000` on audio song, sfx, render and export.
  - Renders run at 44.1 kHz. 48 kHz delivery uses a Kaiser-windowed sinc resampler.
  - The loop body is resampled as a periodic segment, so loop points stay sample-exact and the seam stays clean.
  - Sidecars and layer manifests report the delivered rate. Imported WAVs at other rates use the same resampler.
- `/api/health` reports the server's workspace (`home`).
- One-shot analysis reports `sweep_octaves`. Timbre reports `reverb_confidence` and `harmonic_extension_db`.

### Changed

- **Workspace:** there is no implicit fallback to a `./workspace` folder next to a source checkout. The workspace is `--home`, then `AGENT_ART_HOME`, then `~/.agent-art`. `serve` and `mcp` print a note when a legacy `./workspace` exists.
- **MCP proxy backend:** it proxies only to a server on the same workspace. If the proxied server dies mid-session, it re-probes ports 7420-7440 for a server on the same workspace; otherwise it hosts one itself on that workspace. Each switch is logged to stderr, and the failed call is retried once.
- `lathe` simplifies its profile before revolving: collinear runs are merged, then Douglas-Peucker runs with `simplify` px (default 0.75). Flat steps keep their texture rows.
- Overlay shells are tessellated adaptively: `detail` defaults from the falloff and face size (16-64 px). Uniform areas, such as `where:"all"` or a constant weight, are not split.
- glTF alpha MASK is used only when a triangle samples a transparent texel. Unused CTM atlas slots no longer force MASK.
- Rhythm perception gates kicks and snares:
  - An absolute level gate.
  - Transient sharpness and noisiness.
  - A 35-110 Hz filter-bank low band.
  - Percussive-only snare and hat onsets.
- Distortion is measured from harmonic and intermodulation structure on loud, pitched frames, discounting reverb tails. Spectral flatness is no longer used, and drum stems are excluded from the mix distortion verdict.
- The reverb RT60 is estimated from free decays (note endings) per octave band, with a confidence value. The space description says when confidence is low.
- The critique `loop_seam` is reported only for a real waveform discontinuity. A level change at the seam is a low-weight `loop_level_change`.
- The SFX classifier separates pitch sweeps from impact transients. A sweep is a steady one-way glide while the level holds, so lasers and power-ups are no longer called impacts and impacts with a falling body are no longer called falling tones.
- Docs: the music topic and the `music-track` skill explain that song `text` plus JSON `tracks`/`buses`/`master` deep-merge.

### Fixed

- `model_create` keeps the model-level options `overlays` and `uv_origin` (and `grid`, `scale`, `origin`, `notes`, `project`). `update` can set them, and `null` clears them.
- CTM `random` with only `variants` uses `variants[0]` as the base.
- The `emissive` layer is left out of the albedo and used only for the emissive texture.
- `line` and `curve` no longer report `width`, `brush` or `pixel_perfect` as ignored fields. They always worked; the warning was wrong.
- In CLI `batch`, an absolute `out` path is used as is instead of being joined to `--out-dir`.
- Choir, wind, organ, drones and sub bass no longer read as `double_kick` or `backbeat`.
