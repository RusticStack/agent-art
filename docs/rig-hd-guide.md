# humanoid_hd: a guide for artists

`humanoid_hd` is an `art_rig` template for detailed characters in the style of late-90s pre-rendered sprites or *Replaced*: 64x96 up to 160x240 frames, many colours, 12-24 frame cycles and many body pieces. You draw each part once per view. Every frame of every animation in all 8 directions is then assembled from those same pixels, with bending elbows and knees, IK hands and feet, and cape follow-through.

This guide uses a 128x192 frame. All calls are `art_rig` / `art_draw` / `art_animation` tool calls with JSON arguments.

## 1. Create the rig

```json
art_rig {"action":"create","name":"soldier","frame":[128,192],"template":"humanoid_hd"}
```

The reply lists:

- **cells**: where every part goes on canvas `soldier_parts`. There is one row band per view, in view order, and each band is as tall as the tallest part cell + 1 px. The reply gives them compactly as `cells.rows` (the y where each view's band starts) and `cells.parts` (`[x, w, h]` per part), so a cell is `[x, rows[view], w, h]`; `full:true` lists `[x, y, w, h]` per view. With the default parts at 128x192 the 73 px cape is the tallest cell, so the bands start at y = 0, 74, 148, 222, 296. Remove or resize parts and the bands move: with `cape:null` the 54 px thigh is the tallest, giving 0, 55, 110, 165, 220. Always read the rows from the reply instead of assuming them.
- **views**: `side`, `front_side`, `front`, `back_side`, `back`. **mirror_views**: `side_left`, `front_side_left`, `back_side_left`. Mirrors are generated, not drawn.
- **presets**: `idle` (12f), `blink` (10f), `walk` (16f), `run` (12f), `crouch_walk` (16f), `aim` (1f), `shoot` (6f), `reload` (24f), `hurt` (8f), `death` (20f), `throw` (12f).

Rig options set by the template: `sampling: "rotsprite"` (stable thin limbs, only your own colours), `scale_children: true` (foreshortening moves joints), and `secondary` for `cape` and `gear_hip`. Inspect everything with `art_rig {"action":"info","name":"soldier"}`.

Change anything in the same create call, for example a longer coat-tail cape, no backpack and a bigger head:

```json
art_rig {"action":"create","name":"soldier","frame":[128,192],"template":"humanoid_hd","overwrite":true,"parts":{"cape":{"h":90},"gear_back":null,"head":{"w":30,"h":31}}}
```

## 2. What to draw where

- **side** faces RIGHT. `*_f` is the near side in that view: draw `*_b` parts darker, because they sit behind the body.
- **Pivots** (red dots on the visible `cells` guide layer) are the joints. The pivot sits at the top of each limb piece (shoulder, elbow, wrist, hip, knee, ankle). The pelvis pivot is the hip line. The torso, chest, neck and head pivots are near their bottom.
- **Limb cells overlap their joints** by a few pixels above and below. Paint a rounded end there so a bent elbow or knee stays closed.
- **foot** pivot = ankle; toes point right in `side`. **weapon** pivot = the grip; draw the gun pointing right in `side`, and foreshortened toward the camera in `front` / `back`. With weapon handling (`weapon:{class:"rifle"}`, section 5b) draw the weapon in the `side` row only: the other views project that cell.
- **head:blink** = the same head with closed eyes (used by blink, hurt and death).
- Optional slots (`weapon`, `gear_back`, `gear_hip`, `cape`) can stay empty or be removed with `null`.
- `front_side` = 3/4 toward the camera, `back_side` = 3/4 away. Use the same palette keys in every view.

Block in flat shapes, shade and outline per cell. For example, chest and head in `side`, a thigh, and the chest in `front`:

```json
art_draw {"canvas":"soldier_parts","layer":"parts","commands":[{"op":"rect","x":317,"y":2,"w":34,"h":31,"color":"#4a5a3a"},{"op":"ellipse","x":375,"y":2,"w":19,"h":23,"color":"#c89070"},{"op":"rect","x":206,"y":0,"w":11,"h":54,"color":"#3a4030"},{"op":"rect","x":313,"y":150,"w":42,"h":31,"color":"#4a5a3a"}]}
art_draw {"canvas":"soldier_parts","layer":"parts","commands":[{"op":"shade","region":[311,0,46,35],"colors":["#1e2418","#2e3826","#3e4a32","#4a5a3a","#5e7048","#788c5c"],"of":"#4a5a3a","light":"top-left"},{"op":"outline","color":"#14160f"}]}
```

Then check the assembled character in all views and in a pose:

```json
art_rig {"action":"preview","name":"soldier"}
art_rig {"action":"preview","name":"soldier","pose":"aim"}
art_rig {"action":"turnaround","name":"soldier","canvas":"soldier_turn"}
```

## 3. Animate every preset in every view

A frame strip is at most 8192 px tall (42 frames at 192 px), so give each preset and view its own canvas. Presets already turn on `plant` (IK feet) and `secondary` (cape and pouch follow-through) where they help. Hands in aim, shoot and reload use IK on the weapon and the hip pouch.

```json
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"side","canvas":"soldier_idle_side"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"front_side","canvas":"soldier_idle_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"front","canvas":"soldier_idle_front"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"back_side","canvas":"soldier_idle_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"back","canvas":"soldier_idle_back"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"side_left","canvas":"soldier_idle_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"front_side_left","canvas":"soldier_idle_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"back_side_left","canvas":"soldier_idle_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"side","canvas":"soldier_blink_side"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"front_side","canvas":"soldier_blink_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"front","canvas":"soldier_blink_front"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"back_side","canvas":"soldier_blink_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"back","canvas":"soldier_blink_back"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"side_left","canvas":"soldier_blink_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"front_side_left","canvas":"soldier_blink_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"blink","view":"back_side_left","canvas":"soldier_blink_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"side","canvas":"soldier_walk_side"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"front_side","canvas":"soldier_walk_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"front","canvas":"soldier_walk_front"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"back_side","canvas":"soldier_walk_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"back","canvas":"soldier_walk_back"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"side_left","canvas":"soldier_walk_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"front_side_left","canvas":"soldier_walk_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"back_side_left","canvas":"soldier_walk_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"side","canvas":"soldier_run_side"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"front_side","canvas":"soldier_run_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"front","canvas":"soldier_run_front"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"back_side","canvas":"soldier_run_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"back","canvas":"soldier_run_back"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"side_left","canvas":"soldier_run_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"front_side_left","canvas":"soldier_run_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"run","view":"back_side_left","canvas":"soldier_run_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"side","canvas":"soldier_crouch_walk_side"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"front_side","canvas":"soldier_crouch_walk_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"front","canvas":"soldier_crouch_walk_front"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"back_side","canvas":"soldier_crouch_walk_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"back","canvas":"soldier_crouch_walk_back"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"side_left","canvas":"soldier_crouch_walk_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"front_side_left","canvas":"soldier_crouch_walk_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"crouch_walk","view":"back_side_left","canvas":"soldier_crouch_walk_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"side","canvas":"soldier_aim_side"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"front_side","canvas":"soldier_aim_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"front","canvas":"soldier_aim_front"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"back_side","canvas":"soldier_aim_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"back","canvas":"soldier_aim_back"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"side_left","canvas":"soldier_aim_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"front_side_left","canvas":"soldier_aim_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"aim","view":"back_side_left","canvas":"soldier_aim_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"side","canvas":"soldier_shoot_side"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"front_side","canvas":"soldier_shoot_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"front","canvas":"soldier_shoot_front"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"back_side","canvas":"soldier_shoot_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"back","canvas":"soldier_shoot_back"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"side_left","canvas":"soldier_shoot_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"front_side_left","canvas":"soldier_shoot_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"shoot","view":"back_side_left","canvas":"soldier_shoot_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"side","canvas":"soldier_reload_side"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"front_side","canvas":"soldier_reload_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"front","canvas":"soldier_reload_front"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"back_side","canvas":"soldier_reload_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"back","canvas":"soldier_reload_back"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"side_left","canvas":"soldier_reload_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"front_side_left","canvas":"soldier_reload_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"reload","view":"back_side_left","canvas":"soldier_reload_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"side","canvas":"soldier_hurt_side"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"front_side","canvas":"soldier_hurt_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"front","canvas":"soldier_hurt_front"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"back_side","canvas":"soldier_hurt_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"back","canvas":"soldier_hurt_back"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"side_left","canvas":"soldier_hurt_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"front_side_left","canvas":"soldier_hurt_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"hurt","view":"back_side_left","canvas":"soldier_hurt_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"side","canvas":"soldier_death_side"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"front_side","canvas":"soldier_death_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"front","canvas":"soldier_death_front"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"back_side","canvas":"soldier_death_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"back","canvas":"soldier_death_back"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"side_left","canvas":"soldier_death_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"front_side_left","canvas":"soldier_death_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"death","view":"back_side_left","canvas":"soldier_death_back_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"side","canvas":"soldier_throw_side"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"front_side","canvas":"soldier_throw_front_side"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"front","canvas":"soldier_throw_front"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"back_side","canvas":"soldier_throw_back_side"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"back","canvas":"soldier_throw_back"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"side_left","canvas":"soldier_throw_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"front_side_left","canvas":"soldier_throw_front_side_left"}
art_rig {"action":"animate","name":"soldier","preset":"throw","view":"back_side_left","canvas":"soldier_throw_back_side_left"}
```

Override any preset field per call, for example a faster walk with more frames, or no foot planting:

```json
art_rig {"action":"animate","name":"soldier","preset":"walk","view":"side","canvas":"soldier_walk24_side","animation":"walk24","frames":24,"fps":24}
art_rig {"action":"animate","name":"soldier","preset":"idle","view":"front","canvas":"soldier_idle_front","plant":false,"secondary":false}
```

## 4. Your own poses: per-view overrides, IK and secondary motion

A pose holds offsets per part (`x`, `y` in px, `rot` in degrees, `sx`/`sy`, `variant`, `hide`). Side-view rotations splay sideways in front and back views, so put view-specific values under `views`. Mirror views use their source view's override.

```json
art_rig {"action":"pose","name":"soldier","pose":"kneel_aim","parts":{"pelvis":{"y":24},"thigh_f":{"rot":-80},"shin_f":{"rot":80},"thigh_b":{"rot":10},"shin_b":{"rot":85},"foot_b":{"rot":-60}},"views":{"front":{"thigh_f":{"rot":0,"sy":0.3},"shin_f":{"rot":0},"thigh_b":{"rot":0,"sy":0.95},"shin_b":{"rot":0,"sy":0.2}},"back":{"thigh_f":{"rot":0,"sy":0.3},"shin_f":{"rot":0},"thigh_b":{"rot":0,"sy":0.95},"shin_b":{"rot":0,"sy":0.2}}},"ik":{"hand_f":{"target":{"part":"chest","at":[20,-22]},"bend":-1,"rot":0},"hand_b":{"target":{"part":"weapon","at":[28,-4]},"bend":-1}}}
```

IK in a pose or key: `ik: {end: {target, bend, rot?}}` rotates the end part's parent and grandparent (upper_arm + forearm, thigh + shin) so the end pivot reaches `target`.

- `target: [x, y]` = frame pixels of the drawn view.
- `target: {part, at: [dx, dy]}` = relative to another part's pivot, in that part's rotated frame (a weapon grip, a holster, a ladder rung).
- `bend: 1` points the joint toward +x when the limb hangs down (knees in side view); `-1` points it the other way (elbows).
- `rot` = the end part's world rotation afterwards (keeps the gun level).
- Add per-view targets under `views: {front: {ik: {...}}}`.

Animate custom keys with IK, foot planting and follow-through:

```json
art_rig {"action":"animate","name":"soldier","canvas":"soldier_kneel_side","animation":"kneel_aim","view":"side","keys":[{"pose":"idle_exhale"},{"pose":"kneel_aim","t":0.6}],"frames":10,"fps":16,"loop":false,"plant":true,"secondary":true}
```

Tune secondary motion per part. Stiffness 0..1: higher follows the body more tightly. Damping 0..1: higher settles faster. Gravity pulls the part toward hanging straight down. Add a scarf part first if you want one:

```json
art_rig {"action":"update","name":"soldier","parts":{"scarf":{"w":10,"h":30,"pivot":[5,1],"parent":"neck","at":[-3,-2],"z":-5}},"secondary":{"cape":{"stiffness":0.2,"damping":0.18,"gravity":0.4},"scarf":{"stiffness":0.15,"damping":0.12}}}
```

## 5. Export

```json
art_animation {"canvas":"soldier_walk_side","action":"export","format":"spritesheet","path":"out/soldier_walk_side"}
art_animation {"canvas":"soldier_walk_side","action":"export","format":"spritesheet","path":"out/soldier_walk_side_png_only","json":false}
art_animation {"canvas":"soldier_walk_side","action":"export","format":"gif","scale":2}
```

The spritesheet JSON carries per-frame anchors (each part's pivot x, y and rotation), so a game engine can attach muzzle flashes, held items or particles to `hand_f` or `weapon`.

## Tips

- Check every animation with `art_critique {"canvas":"soldier_walk_side","animation":"walk"}` and `art_animation {"action":"filmstrip"}`.
- Rotation looks best when limbs have clean 1 px outlines and 3-5 shade steps. `sampling: "rotsprite"` keeps only colours that are already in the part, so ramps stay intact.
- For a different look, set `sampling: "smooth"` (supersamples the 1x cell) or `"nearest8"` (the old fast path) with `art_rig update`.
