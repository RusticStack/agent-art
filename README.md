# Agent Art

**Pixel art for AI agents.** An MCP server with a live web UI that lets any agent (Claude, GPT, DeepSeek, local models) make real pixel art: sprites, characters, tilesets, seamless textures, icons, UI, isometric and HD-2D scenes, and animations. Every asset is built from tools the agent can reason about: shapes, form shading, Voronoi cells, outlines, lighting and rigs. It looks at its own work as an image, gets a critique, fixes what's wrong and exports PNGs, GIFs and spritesheets for any engine.

- **Works with weak models too.** Tool descriptions are compact, and details load on demand through `art_help`. Images are sized to their token cost. Errors print the correct usage. Rig templates turn "draw a walking character" into "draw six parts, call one preset".
- **The same asset in every view and frame.** Rigs draw each part once per view (side/front/back plus mirrored views) and generate frames by tweening poses, at any frame rate.
- **Low-res to high-res.** 8×8 icons up to 2048² scenes. Shading and cells are geometry-based, so they scale. Scale2x/EPX upscaling and RotSprite rotation keep edges clean.
- **You can watch and paint along.** The web UI updates live as the agent draws. Your edits go through the same API, so the agent sees them.
- **Zero dependencies.** Plain Node.js 20+, no native modules.

> Example: [Sanctum Burn](https://sanctum-burn.vercel.app), a co-op 2.5D survivor game. All of its art was made by an agent with Agent Art.

## Install

```sh
# Claude Code
claude mcp add agent-art -s user -- npx -y @rusticstack/agent-art mcp

# any MCP client (stdio)
{ "mcpServers": { "agent-art": { "command": "npx", "args": ["-y", "@rusticstack/agent-art", "mcp"] } } }
```

Then ask the agent: *"open the art UI and make a 32×32 knight with a walk cycle"*.

The MCP process hosts the UI at http://localhost:7420. If an `agent-art serve` is already running on the same workspace, it uses that one, so the UI outlives agent sessions and several agents can share it. If that server goes away mid-session, the MCP process looks for another server on the same workspace (ports 7420-7440) and otherwise hosts one itself, on the same workspace; it logs each switch to stderr.

From a source checkout: `npm start` (UI), `npm test`. The included `.mcp.json` registers the server for Claude Code in this folder.

## How an agent works with it

1. **Palette first:** `art_palette ramp` builds hue-shifted shading ramps. `art_project` shares a palette and style notes across a whole asset set.
2. **Block in** flat silhouettes with `art_draw` commands: `rect`, `ellipse`, `polygon`, `line`, `curve`, `grid` (pixel rows plus a legend), `fill`, `text`, ...
3. **Form and surface:** `shade` gives volume shading from one light direction, based on the shape's geometry, with no pillow shading. `cells` makes tileable stones, scales and bricks. `noise` makes dithered textures with exact color weights. `outline` and `bevel` finish edges.
4. **Look and check:** `art_view` renders the image with a grid, seam-check tiling and onion skin. `art_critique` scores orphan pixels, noise, contrast, colour count, seams, weak outline, jaggies, pillow shading, and animation drift (volume, ground line, palette, duplicate frames).
5. **Export:** `art_export` (PNG). `art_animation export` (GIF, or a spritesheet plus Aseprite-style JSON). `art_sheet` gives a contact sheet of a whole set.

### Characters, views and animations: `art_rig`

```jsonc
// 1. start from a template (humanoid | blob | flyer): only a starting point
{ "action": "create", "name": "knight", "frame": [32, 32], "template": "humanoid",
  "parts": { "head": { "w": 14, "h": 11 }, "cape": { "w": 8, "h": 12, "pivot": [4, 0], "parent": "body", "at": [-2, -6], "z": -4 } } }
// 2. draw each part in the cells the reply lists (one row per view) on canvas "knight_parts"
// 3. generate animations: frames are assembled from the same part pixels, so the knight never drifts
{ "action": "animate", "name": "knight", "preset": "walk", "view": "side", "frames": 16, "fps": 20 }
```

Templates set up parts, joints, views, poses and presets: humanoid has idle, blink, walk, run, attack, hurt, jump and death; blob has idle, hop, blink, hurt and death; flyer has fly, hurt and death. Every size, joint, view, pose and preset can be changed. You can add parts (tails, capes, weapons) or remove them. For anything else (quadrupeds, vehicles, props with moving parts), define your own rig. Poses set per-part offsets, rotation, squash and stretch (`sx`/`sy`), variants (a blinking head) and visibility. `mirror_pairs` swaps left and right limbs for the second half of a walk, and `plant_feet` keeps feet on the ground line.

#### High-detail characters: `humanoid_hd`

For detailed sprites in the style of late-90s pre-rendered games or *Replaced* (64x96 up to 160x240 frames, rich shading, 12-24 frame cycles), `template: "humanoid_hd"` gives 21 parts: `pelvis` (root), `torso`, `chest`, `neck`, `head`, `upper_arm`/`forearm`/`hand` and `thigh`/`shin`/`foot` on both sides, plus optional `weapon` (child of `hand_f`), `gear_back`, `gear_hip` and `cape` slots. Limbs are parent chains, so elbows and knees bend. It draws five views (`side`, `front_side`, `front`, `back_side`, `back`) and mirrors three more, for 8 directions. Presets: idle (12 frames), walk (16), run (12), crouch_walk (16), aim (1), shoot (6), reload (24), hurt (8), death (20), throw (12) and blink.

```jsonc
{ "action": "create", "name": "soldier", "frame": [128, 192], "template": "humanoid_hd" }
// draw the cells, then one canvas per preset and view (frame strips are at most 8192 px tall)
{ "action": "animate", "name": "soldier", "preset": "reload", "view": "front_side", "canvas": "soldier_reload_front_side" }
// a pose with a view-specific override and two-bone IK (hand on the weapon's foregrip)
{ "action": "pose", "name": "soldier", "pose": "brace", "parts": { "chest": { "rot": -4 } },
  "views": { "front": { "head": { "rot": 0 } } },
  "ik": { "hand_b": { "target": { "part": "weapon", "at": [20, -3] }, "bend": -1 } } }
```

- **Per-view poses:** `views: {front: {part: {...}}}` is merged over the base pose in that view; mirror views use their source view, and tweening blends the overrides. The template's poses come with front, back and 3/4 overrides already, so forward swings foreshorten (thigh and shin `sy` with `scale_children`) instead of splaying sideways.
- **Two-bone IK:** `ik: {end: {target: [x, y] | {part, at: [dx, dy]}, bend: 1 | -1, rot?}}` in a pose or key rotates the end's parent and grandparent so the end pivot reaches the target. It is solved per frame after FK, in each view. `rot` sets the end part's world rotation afterwards, for example to keep a gun level.
- **Foot planting:** `animate {plant: true}` (alias `ik_feet`) keeps stance feet on the ground through every contact frame with leg IK. A standing foot stays put and a walking stance foot moves at constant speed.
- **Secondary motion:** rig `secondary: {cape: {stiffness, damping, gravity?}}` plus `animate {secondary: true}` adds lag and follow-through to capes, straps and pouches. Loops are simulated until they repeat, so they stay seamless.
- **Rotation sampling:** rig `sampling: "rotsprite"` (the humanoid_hd default) supersamples the Scale2x image, keeps only the part's own colours and cleans up holes and stray pixels, so thin limbs keep their thickness from frame to frame. `"smooth"` does the same on the 1x cell, and `"nearest8"` is the old behaviour, still the default for existing rigs.
- `art_animation export {format: "spritesheet", json: false}` skips the sidecar JSON.

See [docs/rig-hd-guide.md](docs/rig-hd-guide.md) for a step-by-step guide.

### 3D environments and props (HD-2D): `art_model`

Turn pixel art into low-poly game assets in the HD-2D style (pixel textures on low-poly meshes, nearest filtering), exported as glTF 2.0 `.glb` with no dependencies. The focus is modular map kits; characters stay 2D billboards.

```jsonc
// a kit piece: tileable textures repeat at 1 texel = 1 px, so every piece keeps 32 px per unit
{ "action": "create", "name": "wall_ruin", "parts": [
  { "type": "wall", "w": 32, "h": 64, "d": 8, "texture": { "canvas": "stone", "overlay": "grime" }, "broken": { "seed": 3 }, "holes": "crack" },
  { "type": "rubble", "texture": "stone", "count": 6, "at": [0, 0, 10] } ], "preview": true }
// a diorama section from placed pieces (cell = 32 px grid, turn = 90° steps)
{ "action": "create", "name": "crypt", "parts": [
  { "type": "model", "model": "floor_a", "array": { "count": 4, "cell_step": [1, 0, 0] } },
  { "type": "model", "model": "wall_ruin", "cell": [1, 0, -1] } ] }
{ "action": "export", "name": "crypt" }          // exports/crypt.glb + crypt.meta.json (or instances:true)
```

- **Kit pieces:** `floor`, `wall`, `corner`, `pillar`, `column`, `arch` (gothic or round; frame, solid or ring), `vault`, `stairs`, `ledge`, `balustrade`, `roof`, `rubble`, `box`, `cylinder`/`prism`, `plane`, `shape` (any outline). **Props:** `extrude` (sprite to solid; side walls take the edge pixel's colour; `depth_map` gives voxel relief) and `lathe` (revolve a right-half silhouette). **Layouts:** `model` places other models.
- **Ruins:** `broken` gives jagged tops or edges, `holes` takes a mask canvas whose painted pixels become cracks and breaches, and `rubble` scatters chunks. Outlines are smooth polygons (marching squares, then simplified) and arch curves get a segment count from their size. `style:"voxel"` (arches: `voxel:true`) keeps the old blocky look.
- **Smooth geometry:** `lathe` profiles are simplified before revolving (collinear runs merged, then Douglas-Peucker with `simplify` px, default 0.75), so a pixel silhouette gives a few clean rings instead of one ring per pixel row.
- **World-space UVs:** tiled faces get their UVs from the world position after placement, planar per face direction, at 1 texel = 1 px. The texture lattice starts at a grid-cell edge (`uv_origin`, default `[16,0,16]`, settable per model). Offsets, turns, arrays and nested layouts all continue the texture across touching pieces.
- **Overlays:** grime, decay, moss, blood and edge wear become decal shells on a second UV set (glTF `TEXCOORD_1`, strength in `COLOR_0` alpha, alpha MASK). Example: `overlays:[{texture:"grime", where:["bottom","corners"], falloff:20}, {texture:"moss", where:"top"}]`. `map` is `world` (the overlay's own scale) or `face`/`piece`/`surface` (stretched 0..1). Overlays go on a part or on the whole model (model-level `overlays`, kept by `create` and `update`). Decal shells are tessellated adaptively (`detail` defaults from the falloff and face size, 16-64 px), and uniform areas such as `where:"all"` are not split at all.
- **Connected textures (CTM):** `art_model ctm` builds an OptiFine/Continuity-style tileset; see below.
- **Textures:** set them per face (`faces`, `top`, `side`), use a colour, or add a grime `overlay`. Emissive comes from a layer named `emissive`; that layer is left out of the base colour, so a glow-only pixel is black in the albedo and lit only by the emissive texture. `normal_maps:true` adds normal maps.
- **Preview:** `art_model preview` renders a contact sheet with a software rasterizer. It includes the 38° game camera plus front, side, top and iso views.
- **Export:** NEAREST samplers, REPEAT wrap, embedded PNGs, alpha MASK (cutoff 0.5) only when a triangle actually samples a transparent texel (unused tileset slots no longer force it), and emissive/normal textures. The file is Y-up with 32 px = 1 unit (`scale`). For a Z-up engine set `object.rotation.x = Math.PI / 2` or export with `up:"z"`. Options: one baked mesh, `instances:true` (shared meshes and nodes), or `atlas:true`.

`art_help {topic:"3d"}` has every option plus recipes for a gothic arch kit, a gargoyle relief, chains, lathed candles, CTM marble floors, wall trims and moss. Skill: `3d-kit`.

#### Connected textures (CTM)

```jsonc
{ "action": "ctm", "name": "marble_ctm", "ctm": { "base": "marble", "method": "full", "border": { "width": 2, "style": "bevel" } } }
{ "action": "create", "name": "hall", "parts": [ { "type": "floor", "texture": "marble_ctm", "cell": [0, 0, 0], "array": { "count": 4, "cell_step": [1, 0, 0] } } ] }
```

- **Methods:**
  - `full`: the 47-tile blob set.
  - `compact`: 5 tiles, combined by quarters.
  - `horizontal`, `vertical` and `horizontal+vertical`.
  - `top`.
  - `random`: weighted, picked deterministically from the world cell. `variants:[...]` lists the canvases; without `base`, the first variant is the base.
  - `repeat`: one big pattern over cols × rows cells.
  - `overlay`: tiles that creep in from neighbouring cells of another material.
- **Tileset sources:** a base texture plus a border style, or a hand-drawn `template`. A template holds either all the tiles, or the 5 compact tiles, which are expanded to 47.
- **Bake:** every world-tiled face using the tileset is split into world cells. Each cell takes its tile from its 8 neighbours across all placed pieces. A neighbour counts when it is on the same plane and has the same connect key: `material`, `texture`, or `tag` via `ctm_tag`. Walls fold around vertical corners.
- **Export:** writes `<name>.ctm.json` (method, tile order, masks, connect rule) and the tileset PNGs, for re-tiling at runtime.

Neighbour bits: N=1 NE=2 E=4 SE=8 S=16 SW=32 W=64 NW=128 (N = up on walls, −Z on floors). Reference selection for engines:

```js
/**
 * ctmTileFor(neighbors, method, opts) -> tile index into the tileset (compact: [tl, tr, br, bl]
 * indices of the 5 compact tiles). neighbors: 8-bit mask (N1 NE2 E4 SE8 S16 SW32 W64 NW128),
 * an array of 8 booleans in that order, or {n, ne, e, se, s, sw, w, nw}.
 * opts: cell [x, y, z?] (random, repeat), weights (random), seed (random), repeat [cols, rows].
 */
function ctmTileFor(neighbors, method = 'full', opts = {}) {
  const K = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  let m = 0;
  if (typeof neighbors === 'number') m = neighbors & 255;
  else if (Array.isArray(neighbors)) neighbors.forEach((v, i) => { if (v) m |= 1 << i; });
  else K.forEach((k, i) => { if (neighbors && neighbors[k]) m |= 1 << i; });
  const blob = (x) => {
    let r = x & 85; // edges N E S W
    if (x & 1 && x & 4 && x & 2) r |= 2;
    if (x & 4 && x & 16 && x & 8) r |= 8;
    if (x & 16 && x & 64 && x & 32) r |= 32;
    if (x & 64 && x & 1 && x & 128) r |= 128;
    return r;
  };
  const N = !!(m & 1), E = !!(m & 4), S = !!(m & 16), W = !!(m & 64);
  const cell = opts.cell || [0, 0, 0];
  const hash = () => {
    let h = (opts.seed ?? 1) ^ 0x9e3779b9;
    for (const v of [cell[0] | 0, cell[1] | 0, (cell[2] ?? 0) | 0]) { h = Math.imul(h ^ v, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; }
    return (h >>> 0) / 4294967296;
  };
  switch (method) {
    case 'full':
    case 'overlay': {
      if (!ctmTileFor.blobIndex) {
        const masks = [...new Set([...Array(256).keys()].map(blob))].sort((a, b) => a - b);
        ctmTileFor.blobIndex = new Map(masks.map((x, i) => [x, i]));
      }
      // overlay: bits mean "the other material is there"; its tiles are the blob set of the complement
      return ctmTileFor.blobIndex.get(blob(method === 'overlay' ? ~m & 255 : m));
    }
    case 'compact': {
      const q = (v, h, d) => (v && h ? (d ? 1 : 4) : v ? 3 : h ? 2 : 0);
      return [q(N, W, m & 128), q(N, E, m & 2), q(S, E, m & 8), q(S, W, m & 32)];
    }
    case 'horizontal': return (W ? 1 : 0) | (E ? 2 : 0);
    case 'vertical': return (N ? 1 : 0) | (S ? 2 : 0);
    case 'horizontal+vertical': return (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0);
    case 'top': return N ? 0 : 1;
    case 'random': {
      const w = opts.weights && opts.weights.length ? opts.weights : [1];
      let r = hash() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
      return w.length - 1;
    }
    case 'repeat': {
      const [cw, ch] = opts.repeat || [1, 1];
      const mod = (a, n) => ((a % n) + n) % n;
      return mod(cell[0], cw) + mod(cell[1], ch) * cw;
    }
    default: throw new Error(`unknown CTM method "${method}"`);
  }
}
```

#### World-space UVs at runtime (three.js)

The same mapping the exporter bakes, for runtime-placed tiles. Shown for a Z-up scene; for Y-up swap `up` to `(0,1,0)` and the cap branch accordingly.

```js
const pxPerUnit = 32, texSize = 32; // texels per tile
material.onBeforeCompile = (shader) => {
  shader.uniforms.uvScale = { value: pxPerUnit / texSize };
  shader.uniforms.uvOrigin = { value: new THREE.Vector3(0.5, -0.5, 0) }; // uv_origin [16,0,16] px, glTF Y-up -> Z-up
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform float uvScale;
      uniform vec3 uvOrigin;`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>
      vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz - uvOrigin;
      vec3 wn = normalize(mat3(modelMatrix) * normal);
      vec3 up = vec3(0.0, 0.0, 1.0);
      vec3 t = abs(dot(wn, up)) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(up, wn));
      vec3 b = abs(dot(wn, up)) > 0.999 ? (dot(wn, up) > 0.0 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0)) : cross(wn, t);
      vMapUv = vec2(dot(wp, t), -dot(wp, b)) * uvScale;`);
};
```

### Sound effects and music: `art_audio`

Agents cannot hear, so `art_audio` turns audio into things they can read: an analysis image (waveform with beat grid and onsets, log spectrogram, loudness and energy per section, goniometer, band balance; `view:"mix"` overlays stem spectra and marks masking) and a **listener report** in plain words: what a listener taps along to versus the written BPM, the drum feel per section (half-time, blast, double-kick, four-on-the-floor, ...), the key/mode and chord progression, timbre words (dark, muddy, harsh, distorted and which stem, reverb size), what stands out or is buried, what gets repetitive, and how it compares with a genre profile and the stated intent. `critique` ranks issues by audibility and names the parameter to change.

- **SFX:** 31 seeded recipes (gore, combat, holy, UI, monsters, sfxr classics) with `vars` (pitch, length, intensity, variation, wet) and `variants` for batches; or sfxr params, or your own layers. Normalised to -1 dBFS, head silence trimmed.
- **Music:** a compact text notation (`tempo`, `key e phrygian`, `track gtr metal_guitar gain=-3 hp=80`, `section verse 8`, `gtr: E5' E5' _ F5!`), generators (`@doom_riff`, `@organ_progression`, `@blast_beat`, `@dread_ambient`), instrument presets as JSON patches (pipe organ with wind and chiff, formant choir, modal bells, Karplus-Strong guitars double-tracked through amp and cab, bowed strings, metal and industrial kits), humanised timing, round robin, sends, buses, automation, sidechain, a cathedral reverb, and a mastering chain to a LUFS target with a true-peak ceiling. Loops wrap their reverb tail so the seam is clean.
- **Song text + JSON:** send `text` together with JSON `tracks`, `buses` or `master`; the JSON deep-merges over the parsed text, so notes stay in the text and mix tweaks go in JSON.
- **Analysis:** kick and snare detection is gated (a low-band transient with a sharp, noisy attack near the loudest hits), so choirs, wind, organ, drones and sub bass do not read as double-kick or backbeat. Distortion is measured from harmonic and intermodulation structure on loud, pitched frames, not spectral flatness, so reverb tails and drum kits do not count. The reverb RT60 comes from free decays and has a `reverb_confidence`. `loop_seam` is only reported for a real discontinuity; a level change at the seam is `loop_level_change`. One-shots get `sweep_octaves`, which tells a laser or power-up glide from an impact.
- **Export:** WAV 16/24/32-bit float with a `smpl` loop chunk and a JSON sidecar; mp3/ogg/opus through ffmpeg (`AGENT_ART_FFMPEG` or PATH). Stems and adaptive-music intensity layers with a crossfade manifest. Renders run at 44.1 kHz; `sample_rate:48000` delivers 48 kHz through a windowed-sinc resampler with sample-exact loop points.

```js
art_audio { action:"sfx", name:"gib", recipe:"gib_burst", variants:3 }
art_audio { action:"song", name:"crypt", text:"<notation>", intent:"gothic cathedral doom", genre:"cathedral_doom" }
art_audio { action:"analyze", name:"crypt" }        // image + listener report
art_audio { action:"export", name:"gib_*", format:"ogg" }
```

`art_help {topic:"music"}` has the full worked "gothic cathedral doom" track; topics `audio`, `mixing` and `perception` cover the rest.

## Tools

| Tool | What it does |
| --- | --- |
| `art_create_canvas` | New canvas: size, frames, background, palette, project |
| `art_draw` | Batch of drawing commands as one undo step. `preview` returns the image, `critique` the score |
| `art_view` | The canvas as an image: zoom/region, pixel grid, `tile` seam check, `onion`, guides (`grid:16`, `iso:32`), tint preview. Large canvases get a token-cheap overview |
| `art_critique` | Heuristic quality report and score for a frame, an animation or every frame |
| `art_help` | Usage and examples for any command (`{op}`), guides (`{topic}`: workflow, textures, characters, animation, rig, scenes, hires, minecraft, 3d), and step-by-step recipes (`{skill}`) |
| `art_rig` | Multi-view, multi-animation characters from parts and poses (templates, presets, tweening) |
| `art_model` | 3D: modular HD-2D kit pieces, ruins, extruded/lathed props and dioramas, previewed from the game camera, exported to `.glb` |
| `art_audio` | Sound effects, music, mixing and mastering; analysis images, listener reports and critiques; WAV/mp3/ogg/opus export |
| `art_read` | Exact pixels as text rows plus a legend, in the format `grid` accepts |
| `art_palette` | Named colors per canvas or project. `ramp` builds shading ramps |
| `art_project` / `art_sheet` | Group assets with a shared palette and notes; contact sheets to check consistency |
| `art_layer` | Layers with blend modes (multiply, screen, add, overlay, ...), opacity, order, merge, flatten, `stamp_visible` |
| `art_canvas` | Resize, crop, scale (`nearest` or `scale2x` pixel-art upscaling), frames, metadata, `normal_map` |
| `art_animation` | Frame ops, tags with per-frame durations, forward/reverse/pingpong, filmstrip, GIF/spritesheet export |
| `art_undo`, `art_import`, `art_export`, `art_list`, `art_info`, `art_open_ui` | The rest |
| `art_minecraft` | Optional: Minecraft Java resource packs (vanilla texture names and sizes for reference, pack build plus zip) |

**Drawing commands** (`art_help {op}` for each): `grid`, `pixels`, `line`, `curve`, `polygon`, `rect`, `ellipse`, `fill`, `replace`, `remap`, `text`, `gradient`, `noise`, `scatter`, `cells`, `shade`, `adjust`, `outline`, `bevel`, `flip`, `rotate` (RotSprite for any angle), `shift`, `mirror`, `copy` (across canvases: scale, tint, opacity), `clear`, `quantize`.
**Light and 2.5D:** `light`, `fog`, `rays`, `glow`, `blur`, `vignette`, `cast_shadow`, `iso_tile`, `iso_box`.
Every command takes `layer`, `frame`, `mask` (opaque / transparent / a colour / `layer:name`), `blend` and `symmetry`.

## Skills

The recipes behind `art_help {skill}` are also served as MCP prompts and can be installed as agent skills:

```sh
npx @rusticstack/agent-art skills --out ~/.claude/skills   # tileable-texture, sprite, rig, walk-cycle, iso-scene, hd2d-scene, 3d-kit, ui-icons, minecraft-pack, sfx-pack, music-track
```

## CLI (no MCP needed)

```sh
agent-art tools                                   # tool list + instructions (for agents without MCP)
agent-art tool art_draw - --out view.png <<'EOF'  # call any MCP tool; image replies go to --out
{"canvas":"stone","commands":[{"op":"cells","size":5,"colors":["#555","#777","#999"]}],"preview":true}
EOF
agent-art op create '{"name":"stone","width":16}' # raw engine ops
agent-art batch steps.jsonl --out-dir renders     # many ops in order (an absolute "out" is used as is)
agent-art help shade                              # docs for a command, topic or skill
```

## Web UI

- Live canvas list and project overview grids. Changed regions flash. "Follow agent" jumps to whatever the agent is editing.
- Animation timeline with onion skin and tag playback at the tagged timing.
- Layers with blend modes, palette and used colours, undo/redo.
- Pencil, eraser, fill, line, rectangle and picker, with 3×3 tile preview (painting wraps).
- Zoom (Ctrl+wheel, `+`/`-`, `0`), grid (`#`), tile mode (`t`).

## Data and configuration

The workspace is `~/.agent-art` (`--home` or `AGENT_ART_HOME` changes it). Since 0.3.0 there is no implicit fallback to a `./workspace` folder next to a source checkout, because it silently split work between clients started from different folders. If that folder exists, `serve` and `mcp` print a note; pass `--home ./workspace` to keep using it. It holds `canvases/*.json` (layers stored as PNG), `models/*.json` (3D model definitions), `projects/`, `exports/` and `packs/`. The port is `AGENT_ART_PORT` (default 7420). The server binds to 127.0.0.1 and refuses cross-origin writes.

## License

MIT
