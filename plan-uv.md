# Plan: model-level UV unwrap + cohesion bake (branch `feat/model-uv`)

Goal: an Agent Art 3D model made of several parts must read as ONE object. Today every part is
textured independently; this plan adds an opt-in model-level UV atlas (`art_model unwrap`), a
world-anchored bake of the existing textures into it, cohesion passes (contact AO, cavity, edge
wear, grime, masonry courses) quantized as pixel art, a paintable canvas with a UV guide, projection
painting, a cohesion critique, and preview / render / export / UI support.

House rules that bind every step:

- Improve, never remove. A model without `def.unwrap` must build, preview and export byte-identical
  to today. The golden tests (`test/materials.test.js` 0.7 digests, `test/limits.test.js`,
  `test/damage.test.js`, `test/skin2d.test.js`) must pass untouched. Never re-record a golden in this work.
- Do not touch `src/fp*.js` (another branch). Do not change defaults of existing builders
  (`cylinder`, `boxFaces`, `worldUV`, `finalize`, `packCharts`, `buildAtlas`).
- Zero runtime dependencies, Node ESM, deterministic output (no `Math.random`, no `Date` in data).
- Git identity for any commit: `KelpHect <kellhect@gmail.com>` (global config; never pass `-c user.email`).
  Commit only the files you changed, never `git add -A`.
- Run `node --test test/` in the background with output to a log file (it takes minutes); run single
  files in the foreground with a timeout: `node --test test/uvunwrap.test.js`.

---

## 1. Findings: why the column looks detached today

All line numbers are in the worktree `C:\Users\KellHect\orca\projects\Agent-Art-uv`.

1. There is no model-level UV layout. `Mesh` (`src/model3d.js:66`) groups triangles by texture
   (`group(tex)` keyed by `tex.key`); every face owns its vertices and gets UVs from its builder.
   `finalize` (`model3d.js:1441`) then runs `worldUV` (`model3d.js:1218`):
   - mode 1 (planar, world tiled): `u = dot(p, t) / W`, `v = -dot(p, b) / H` with `{t, b} = faceBasis(n)`
     (`src/ctm.js:248`), per face, in coordinates shifted by `uv_origin` (default `[grid/2, 0, grid/2]`,
     `model3d.js:1840`).
   - mode 2 (smooth cylinder side): `u` is kept from the builder, only `v = -y / H` comes from the world.
   - mode 0 (image mapped, CTM, `tile:false`, `wrap:"once"`): untouched. mode 3 = trim strip.
   So "world UVs, seamless across pieces" is true only for coplanar mode-1 faces. Vertical courses
   (v = world y) do line up; everything else does not.
2. Cylinder side `u` is local and its seam faces the camera. `cylinder` (`model3d.js:854`): `at(j) =
   [sin th, cos th]`, so `j = 0` is `+z` = the model FRONT, and the default tiled side uses
   `u = circ * j / N / sideT.width`. At `j = N` `u = circ / width`, which is not an integer unless
   `r = k * width / (2 * PI)`: the wrap seam sits in the middle of the front face. Only `wrap:"once"`
   centres the image on `+z`.
3. Horizontal phase differs per face. A box front uses `u = world x`, its right side `u = -world z`,
   the cylinder uses arc length from its own axis. Brick head joints never wrap a corner and never
   agree between a box face and the shaft.
4. Texel density differs. Mode 2 keeps `u` in local units, so a part with `scale` or a frustum
   (`r_top != r_bottom`, `circ` uses the larger radius) stretches `u` while `v` stays 1 texel / px.
   `lathe` / `revolve` / `tube` round the wrap count (`model3d.js:712`), `tile:false` and
   `wrap:"once"` fit the image. `pillar` / `column` (`model3d.js:1008`) mix `boxFaces` and an 8-segment
   `cylinder`.
5. Parts are cut through the pattern. A 6 px slab shows an arbitrary 6 px slice of a 16 px brick
   texture; the same wall texture lands on top faces (`faceTexer` falls back to `texture`).
6. No contact shading in the default pipeline. `bake_ao` is an export option
   (`src/modelexport.js:193`, occlusionTexture on TEXCOORD_1 or COLOR_0); previews only bake AO when
   `ao` is passed (`modelops.js:305`, `modelexport.js:381`); `art_model render` never does. The raster
   lights a group only when its texture has PBR / normal / AO (`src/raster3d.js:135`). Nothing darkens
   the crease where the shaft meets the cap.
7. Overlays (`model3d.js:1264`, `where: all|bottom|top|corners|edges`) are per-plane / per-piece
   gradients on decal shells; they know nothing about where two parts touch. CTM connects coplanar
   cells only.
8. No wear continuity: every part shows the pristine texture edge to edge, so every part edge is a
   hard texture discontinuity.
9. `export {atlas:true}` (`src/glb.js:51` `buildAtlas`) only packs whole small image-mapped textures
   (UVs inside 0..1, <= 256 px); world-tiled kit faces are left out. It is a draw-call merge, not an unwrap.

Reusable pieces: `BVH` / `bvhOf` / `aoAt` / `hemisphere` / `hashf` (`src/bake.js`), `faceBasis`
(`src/ctm.js`), `medianCut` (`src/color.js`), `quantizeFrames` + `BAYER4` (`modelops.js:341`),
`makeCamera` / `renderCamera` / `renderViews` (`src/raster3d.js`), `Doc` / `Layer` creation pattern
(`model_trim`, `src/modelexport.js:394`), fonts (`src/fonts.js` `getFont`), `packImages` (`src/sheet.js`).

Key design insight: cohesion does not need islands to be adjacent in the atlas. It needs (1) one
texel grid at one density for the whole model, (2) texture content that is a function of WORLD
position (pattern space), so it continues across island and part borders, (3) shading computed on the
merged mesh (all parts occlude each other), baked into the same texels. The atlas is storage.

---

## 2. Solution overview

One new model key `unwrap` (stored in the model def) and one new action `unwrap`:

```
art_model unwrap {name:"column"}                      // layout + bake + cohesion with defaults, one call
art_model unwrap {name, unwrap:{do:"layout"|"bake"|"cohesion"|"guide"|"view"|"project"|"check"|"clear", ...}}
art_model create|update {name, ..., unwrap:{...}|true|null}   // stores the options; null removes
```

Pipeline (all in pattern space = built px minus `built.shift` minus `uv_origin`):

1. Topology: planar facets from the built mesh triangles, edge adjacency by welded positions.
2. Charts: hinge-unfold flood fill (isometric, zero distortion, uniform texel density by construction),
   seams pushed to the least visible edges, overlap rejection.
3. Pack: upright shelf packing into a power-of-two atlas, `pad` texel gutters, no silent rescale.
4. Canvas `<model>_uv` with layers `base`, `cohesion`, `paint` (+ `emissive`, hidden data layers
   `metal`, `rough`, `height`, `masks`, `guide`) and `meta.uv` (layout hash, island table).
5. `build()` (`src/modelops.js:176`) swaps the unwrapped faces into ONE group whose texture is that
   canvas, so preview, render, export, rigs, lightmaps and the web UI all see it with no further change.
6. Critique: `do:"check"` plus a short `cohesion` field on export / create / update / info replies.

Files:

| File | Change |
| --- | --- |
| `src/uvunwrap.js` (new) | options, topology, charts, packing, texel map, hash. Pure (no engine). |
| `src/uvbake.js` (new) | base bake, masks (AO, cavity, edges, grime), courses, quantize, guide image, projection. Pure. |
| `src/uvcheck.js` (new) | cohesion metrics + issues. Pure. |
| `src/uvops.js` (new) | `uvOps({getModel, saveModel, build})` -> `{ model_unwrap }`, `applyUnwrap(engine, def, built)`, canvas I/O. |
| `src/modelops.js` | `MODEL_KEYS` += `'unwrap'`; `build()` calls `applyUnwrap`; spread `...uvOps(...)` into `MODEL_OPS`; export `quantizeFrames`-equivalent helper (see 5.4); `summary()` / `model_export` cohesion field; texResolver exclude list. |
| `src/model3d.js` | no behaviour change. Only: `export` the existing `rebuildGroup` if reused (optional). |
| `src/mcp.js` | action enum += `'unwrap'`; property `unwrap`; description sentence; `run` passes it through. |
| `src/docs.js` | `TOPICS['3d']` + `TOPICS.materials` lines (section 9). |
| `src/server.js` | `/api/model/<name>/info` gains `unwrap` (comes from `summary`), new `/api/model/<name>/uv.png`. |
| `test/uvunwrap.test.js` (new), `test/fixtures/uv-corpus.js` (new) | tests + acceptance models. |
| `test/quality.test.js` | tool-list budget bump with a measured note (section 10). |

---

## 3. Options and JSON shapes

### 3.1 `unwrap` (model key and action param)

`normUnwrap(v)` in `src/uvunwrap.js`. `true` = `{}`. Unknown keys throw
`unwrap: unknown option "<k>" (options: ...)`. All fields optional:

```json
{
  "do": "all",
  "canvas": "<model>_uv",
  "method": "smart",
  "texel": 1,
  "pad": 2,
  "max_size": 1024,
  "angle": 46,
  "front": [0, 0.45, 1],
  "max_island": 512,
  "parts": null,
  "exclude": null,
  "bake": { "tile": "auto", "fit": "auto", "fit_max": 0.13, "top": null },
  "cohesion": {
    "ao": { "samples": 16, "distance": 24, "strength": 1, "levels": 4 },
    "contact": { "width": 4, "strength": 1, "line": true },
    "edges": { "width": 1, "strength": 1, "wear": 0.65, "min_angle": 30 },
    "grime": { "height": 12, "strength": 0.5, "noise": 8 },
    "courses": null,
    "overlays": [],
    "palette": "auto",
    "colors": 32,
    "dither": true,
    "shadow": "#1a1420",
    "highlight": "#fff2d0",
    "seed": 1,
    "across_nodes": false
  },
  "overwrite": false
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `do` | `"all"` (default: layout + bake + cohesion), `"layout"`, `"bake"`, `"cohesion"`, `"guide"`, `"view"`, `"project"`, `"check"`, `"clear"`, or a list of the first three | Sub-step. Action only; never stored in the def. |
| `canvas` | name, default `<model>_uv` | Atlas canvas. Must match `NAME_RE`. |
| `method` | `"smart"` (hinge unfold, default), `"box"` (6-direction world projection, one chart per connected same-direction region), `"faces"` (one chart per facet) | Chart method. `"auto"` = `"smart"`, falls back to `"box"` when facets > 6000. |
| `texel` | 0.5, 1, 2, 4 (any > 0, <= 8) | Model px per atlas texel. 1 = the model's pixel scale (32 px = 1 unit at scale 32). |
| `pad` | 1..8 | Gutter texels around every island (bleed for NEAREST + mip safety). |
| `max_size` | 64, 128, 256, 512, 1024, 2048 | Atlas side cap. 4096 is rejected. |
| `angle` | 1..120 deg | Max dihedral angle joined inside a chart. 46 keeps a 12- or 8-segment cylinder in one strip and gives a box 6 islands; 91 unfolds boxes into crosses. |
| `front` | `[x,y,z]` | Preferred viewing direction (toward the viewer). Seams go where `dot(n, front)` is lowest. |
| `max_island` | px | A chart stops growing past this bbox side. |
| `parts` / `exclude` | lists of part indices or names | Restrict the unwrap. Faces left out keep their per-part textures. |
| `bake.tile` | `"auto"`, `"island"`, `"uv"` | How base texels are sampled (5.1). |
| `bake.fit` | `"auto"`, `true`, `false` | Close ring patterns (cylinder shafts) by rescaling u up to `fit_max`. |
| `bake.top` | texture ref or null | Optional texture for up-facing facets that fell back to the side texture. |
| `cohesion` | object, `true` (defaults) or `false` (skip) | Section 5. Any sub-pass set to `false` is skipped. |
| `overwrite` | bool | `do:"layout"` on an existing canvas whose hash differs: required to drop unmatched paint (5.6). |

Action-only extras inside `unwrap`: `view` (`"front"|"back"|"side"|"left"|"top"|{yaw,pitch}`),
`zoom` (int 1..8, default 1), `from` (view canvas for `project`), `layer` (target layer, default `"paint"`).

`do`, `view`, `zoom`, `from`, `layer`, `overwrite` are stripped before the def is saved.

### 3.2 `courses` (inside `cohesion`)

```json
{ "h": 8, "len": 16, "bond": "running", "joint": 1, "color": null, "light": null,
  "snap": "parts", "caps": "edge", "parts": null, "jitter": 0 }
```

`h` = course height px, `len` = stone length px, `bond`: `running` (half offset on odd courses),
`stack`, `drums` (bed joints only), `joint` = joint width texels, `color` / `light` = joint and
highlight colours (null = darkest / lightest palette colour near the local base colour),
`snap`: `"parts"` (each part's height is divided into whole courses) or `"world"` (bed joints at
world multiples of `h`), `caps`: `"edge"` (up faces get only an edge line) or `"grid"`, `parts` = filter.

### 3.3 `overlays` (inside `cohesion`): the atlas-native "overlay where:contact"

```json
[{ "texture": "moss", "where": "contact", "amount": 0.6, "noise": 8, "threshold": 0.5 }]
```

`where`: `contact` (cavity mask), `cavity` (long AO < 0.6), `top` (n.y > 0.7), `bottom` (grime height
ramp), `edges` (edge mask), `all`. The texture is world-tiled in pattern space and composited where
`mask * (0.5 + vnoise) * amount > threshold` (hard, per texel: no alpha blends).

### 3.4 Canvas `meta.uv`

```json
{ "model": "column", "v": 1, "hash": "a1b2c3d4", "size": [128, 128], "texel": 1, "pad": 2,
  "method": "smart", "anchor": [16, 0, 16],
  "islands": [{ "id": 0, "key": "9f3e12aa", "rect": [2, 2, 28, 6], "part": "plinth", "pi": 0,
                "role": "front", "facets": 1, "ring": false, "area": 168 }],
  "baked": { "base": true, "cohesion": true, "ao_step": 1, "ring_fit": [{ "island": 4, "scale": 1.03 }] },
  "build": false }
```

`rect` = `[x, y, w, h]` of the island interior (gutter excluded), `role` = `top|bottom|front|back|left|right|strip|mixed`,
`build:false` keeps the canvas out of texture builds (same flag `model_ctm` sets, `modelops.js:505`).
Island table is capped at 4096 entries.

### 3.5 Reply of `art_model unwrap`

```json
{ "model": "column", "canvas": "column_uv", "size": "128x128", "texel_px": 1, "islands": 23,
  "fill": 0.71, "seams": { "total": 31, "visible": 2 }, "kept": [],
  "baked": ["base", "cohesion"], "cohesion": { "pass": true, "score": 92, "issues": [] },
  "image": "<png: left = atlas with guide, right = game + front + side views>",
  "ms": 640,
  "next": "paint transitions on layer \"paint\" of column_uv (art_draw {canvas:\"column_uv\", layer:\"paint\"}); art_model unwrap {name, unwrap:{do:\"view\", view:\"front\"}} to paint in a view; preview / export use the atlas" }
```

`kept` lists parts left on their own texture with the reason (`glass`, `opacity`, `materials v2`,
`excluded`). `do:"check"` returns only `{model, cohesion:{...}}` (section 8). Keep replies under
1500 chars without the image: at most 3 issues inline, island table only in `meta.uv`.

---

## 4. Layout algorithm (`src/uvunwrap.js`)

Exports: `normUnwrap`, `facetsOf`, `buildCharts`, `packIslands`, `layoutOf`, `layoutHash`,
`texelMap`, `regroup`, `UNWRAP_LIMITS`.

`UNWRAP_LIMITS = { facets: 20000, islands: 4096, maxSize: 2048, texels: 2048 * 2048, rays: 12e6 }`.

### 4.1 Input

`layoutOf(mesh, opts, { anchor, include })`.

- `mesh` = `built.mesh` after `buildModel` (CTM, worldUV, overlays, displace, origin shift all done).
- `anchor = built.shift + (def.uv_origin ?? [grid/2, 0, grid/2])`. Every position is used as
  `p - anchor` (pattern space). With this, `s = dot(p, t)`, `q = -dot(p, b)` of an axis-aligned
  mode-1 face equals its existing world UV times the texture size: the base bake becomes a 1:1 texel copy.
- `include(g, f)` decides which faces are unwrapped. Exclude: overlay groups (`g.overlay`), faces
  whose `g.tex.material` exists (opacity / glass / blend), `g.tex.v2` (materials v2 extensions),
  faces filtered out by `parts` / `exclude` (use `f.pi`, the top-level part index set at
  `model3d.js:1800`), zero-area faces. Everything else is included, including CTM faces, trim faces and 1x1 colour faces.

### 4.2 Facets (topology on triangles, never on polygon rings)

CSG, displace and merge do not guarantee ring-ordered face vertices, so work on triangles:

1. For every included face record `f` of group `g`, take its triangles `g.idx[f.i .. f.i + f.ic)`.
2. If all the face's vertices lie within 0.05 px of the plane through the first non-degenerate
   triangle, the face is one facet; otherwise each triangle is its own facet.
3. Facet record: `{ id, g, f, tris: [[a,b,c] vertex indices into g], n (geometric unit normal:
   normalised sum of triangle cross products), area, c (centroid), pi: f.pi, pid: f.pid, node: f.node,
   src: { tex: g.tex, uv: copy of the vertices' current UVs, mode: f.mode, ctm: !!f.ctm } }`.
   Copy the UVs now: `regroup` overwrites them later.
4. Welded vertex key: `Math.round(x * 1000) + ',' + ...` on pattern-space positions. Edge key =
   the two vertex keys sorted. Facet boundary edges = triangle edges that occur once inside the facet.
5. `edges: Map<edgeKey, [{facet, a, b}]>`. Two facets are neighbours across an edge when the edge has
   exactly two users. Edges with 1 user = open border; 3+ users = non-manifold: never joined.
6. Throw when facets > `UNWRAP_LIMITS.facets`:
   `unwrap: <n> facets (max 20000): decimate / remesh first, or unwrap only parts:[..]`.

### 4.3 Charts (`method:"smart"`)

Visibility of a facet: `vis = 0.5 + 0.5 * dot(n, norm(front))` (0..1).

```
order seeds by (vis desc, area desc, id asc)
for each unassigned seed:
  chart = new chart; place seed with the world frame:
     {t, b} = faceBasis(seed.n); P2(p) = [dot(p, t), -dot(p, b)]          // u right, v down, world anchored
     chart.sign = sign of the signed 2D area of the seed's first triangle
  heap = candidate edges of the seed (max-heap by priority)
  while heap not empty:
     pop edge (a placed, b unassigned)
     reject unless: b unassigned, dihedral(a.n, b.n) <= angle + 0.5 deg,
                    same material class (see below), chart bbox with b <= max_island
     place b by hinge (below); reject when b's 2D winding sign != chart.sign (flipped / mirrored)
     reject when any of b's 2D triangles overlaps a placed triangle of this chart
     accept: add b, push b's other boundary edges
```

- Priority of an edge = `(vis(a) + vis(b)) / 2 - dihedralDeg / 360`. High-visibility, flat edges are
  joined first, so the cuts that remain (seams) are the least visible ones: for a vertical cylinder
  seeded on the front facet, the strip grows both ways and the seam ends on the back.
- Material class: `'opaque'` for all included faces in v1 (hook kept for later classes).
- Hinge placement of `b` across shared edge with 3D endpoints `P, Q` whose chart coordinates `p2, q2` are known:
  `ex = norm(Q - P)`, `ey = cross(b.n, ex)`; local coords of a vertex `X`: `[dot(X - P, ex), dot(X - P, ey)]`;
  chart direction `d = norm(q2 - p2)`, `e = perp(d)` with the sign chosen so that `b`'s centroid falls on
  the opposite side of the line `p2 q2` from `a`'s centroid; `X2 = p2 + d * lx + e * ly`.
  This is a rigid motion: every facet keeps its true size (zero stretch, exact texel density).
- Overlap test: triangle-triangle SAT in 2D with both triangles shrunk toward their centroid by
  0.02 px (shared edges do not count). Use a uniform grid hash (cell 8 px) over placed triangles.
- `method:"box"`: chart = connected facets (shared edges) whose dominant normal axis and sign match;
  coordinates = world projection along that axis (`faceBasis` of the axis direction). Slanted facets
  stretch up to 1 / cos: report it in the check (`texel_density`).
- `method:"faces"`: every facet is a chart (seed frame only).
- After a chart is complete: `o = [floor(min u), floor(min v)]`; store 2D coords minus `o`, and
  `chart.o = o`. Island texel `(i, j)` covers pattern px `[o + i * texel, o + (i + 1) * texel)`:
  the texel grid is the world px grid for the seed plane. With `texel != 1` use
  `o = floor(min / texel) * texel`.
- Ring detection: a chart is a ring when an edge has both users in this chart but was cut (the two
  copies of the edge lie at different 2D places). `ring.L` = distance between the two 2D copies of
  one endpoint; valid only when it is the same (+-0.01 px) for both endpoints (cylinder: yes, cone
  sector: no -> `ring: false`, `sector: true`).
- Role: all facets up (n.y > 0.7) `top`, down `bottom`, single direction `front|back|left|right`
  by the same rule as `ROLE` (`model3d.js:249`), ring / multi-direction vertical `strip`, else `mixed`.
- Seam list for the guide and the check: every edge with two users in different charts or cut in a
  ring: `{ edge, vis: (vis(a) + vis(b)) / 2, dihedral, smooth: dihedral < angle }`.
  "Visible seam" = `smooth && vis > 0.6`.
- Throw when charts > `UNWRAP_LIMITS.islands` (fix: `method:"box"`, larger `angle`, or decimate).

### 4.4 Packing

- Island size in texels: `w = ceil(bboxW / texel - 1e-6)`, `h` likewise, min 1; cell = `w + 2 * pad`, `h + 2 * pad`.
- No rotation (islands stay upright and world-grid aligned). Order: `h desc, w desc, id asc`.
- For each power-of-two width `W` from `max(16, pow2(widest cell))` to `max_size`: shelf-pack, `H = pow2(used height)`.
  Keep candidates with `H <= max_size`; choose the smallest area, ties: the more square, then the smaller `W`.
- No candidate: throw, never rescale silently:
  `unwrap: <area> texels do not fit <max_size>x<max_size> at texel <t> px. Fix: unwrap:{max_size:2048} | {texel:2} | parts:[..] (unwrap the hero parts, the rest stays tiled)`.
- Island `rect = [x + pad, y + pad, w, h]`. `fill = sum(island interior texels) / (W * H)`.

### 4.5 Hash and island key

FNV-1a 32-bit over a canonical string, hex 8 chars:

- `island.key`: sorted list of its facets' vertex positions rounded to 0.01 px, plus `texel`.
- `layout.hash`: all island keys in id order + their rects + `method, texel, pad, angle, front`.

Deterministic for a given def. Cache the layout on the engine: `engine._uv ??= new Map()`,
`name -> { geo: <hash of all included facet positions + options>, layout }`; compute `geo` first
(one pass over vertices) and reuse the layout when equal.

### 4.6 Texel map

`texelMap(layout)` -> `{ W, H, facet: Int32Array(W*H) (-1 = empty), bary: Float32Array(W*H*3),
tri: Int32Array(W*H), island: Int32Array(W*H) }`. For every island triangle, rasterise in atlas
space: a texel belongs to the triangle when its centre `(i + 0.5, j + 0.5)` is inside (edge
tolerance 1e-4, lowest facet id wins ties). Helpers: `posAt(k)` (pattern-space position from the
barycentrics), `nrmAt(k)` (facet normal; use the interpolated vertex normal only for AO smoothing on
ring charts), `srcUV(k)` (interpolated copy of the original UVs), `st(k)` = island pattern coords
`[chart.o[0] + (i + 0.5 - rect.x) * texel, chart.o[1] + (j + 0.5 - rect.y) * texel]`.

Gutter: after any bake, `dilate(data, mask, pad)`: `pad` iterations, each empty texel with a filled
4-neighbour copies it (scan order fixed: up, left, right, down). This also fills texels a rotated
island edge only partly covers.

### 4.7 Regroup (`regroup(mesh, layout, atlasTex)`)

- New group `mesh.group(atlasTex)` (not overlay). For every unwrapped face record, append its
  vertices (pos, nrm) and indices, set `uv = [(rect.x + u2 / texel) / W, (rect.y + v2 / texel) / H]`
  (u2, v2 = chart coords of that vertex), push `{ ...f, v, i, mode: 0, uvi: islandId }`. Every
  original face property (`pid, pi, node, tag, ov, mat, cs, rs, paint, wet, disp, ctm, edge, trim`) is kept,
  so rigs (`modelrig.js:82` splits by `f.node` per `g.tex`), lightmaps (`chartFaces` reads `g.faces`),
  skin weights and damage keep working.
- Non-planar faces that were split into triangle facets: vertices get per-triangle UVs; when two
  triangles of one face land in different charts, duplicate the shared vertices (emit the face as
  separate face records, one per chart, each with the original properties).
- Remove the moved faces from their old groups (same compaction as `rebuildGroup`, `model3d.js:1465`;
  export it or copy the 10 lines) and delete groups left empty. Put the atlas group first in `mesh.groups`
  (rebuild the Map: atlas, then the rest in their old order).
- Overlay shell groups stay as they are (they render over the atlas with their own texture and UV set).

---

## 5. Bakes (`src/uvbake.js`)

All bakes write RGBA `Uint8ClampedArray(W * H * 4)` buffers for canvas layers. Colours are never
blended into in-between values: every pass ends in a palette lookup.

### 5.1 Base bake: `bakeBase(layout, map, opts)` -> `{ color, emissive?, metal?, rough?, height?, notes }`

Per filled texel `k`, with `F` = its facet and `T = F.src.tex`:

- `tile` resolved per facet: `"auto"` -> `"island"` when `F.src.mode` is 1 or 2 and `!F.src.ctm` and
  `T.width * T.height > 1`; else `"uv"`. Forced `"island"` / `"uv"` apply to every facet that has a texture > 1x1.
- `"uv"`: `[u, v] = map.srcUV(k)`; sample `T.data` at `x = floor(u * T.width) mod T.width`,
  `y = floor(v * T.height) mod T.height` (positive modulo). Faithful to today's look. Used for
  image-mapped faces (extrude sprites, `wrap:"once"`, CTM tiles, trim strips).
- `"island"`: `[S, Q] = map.st(k)`; when the chart is a fitted ring, `S = chart.o[0] + (S - chart.o[0]) * ring.scale`;
  sample at `x = floor(S) mod T.width`, `y = floor(Q) mod T.height`. For an axis-aligned mode-1
  face this equals `"uv"` exactly (unit test). Across a hinge (bevel, cylinder strip) the pattern
  continues isometrically, and the cylinder seam moves to the chart's cut (the back).
- Ring fit (`fit`): for ring charts whose facets are all vertical-ish (`|n.y| < 0.5`):
  `n = max(1, round(L / T.width))`, `scale = n * T.width / L`. Apply when `|scale - 1| <= fit_max`
  (`"auto"` / `true`); the pattern then closes with no seam (NEAREST resample duplicates or drops
  about one texel column per `1 / |scale - 1|` texels: documented). Otherwise leave `scale = 1` and
  record `{ island, L, period: T.width, suggest_r: [r for n - 1, n, n + 1] }` where
  `r = n * T.width / (2 * N * sin(PI / N))` (N = facets in the ring) for the check (`pattern_seam`).
- 1x1 colour textures: the colour.
- `bake.top`: facets with role `top` whose source texture equals the texture of an adjacent vertical
  facet of the same part (the `faceTexer` fallback) sample `bake.top` in `"island"` mode instead.
- Alpha is copied as is (MASK textures and `holes` keep working).
- Emissive: when any source `T.emissive` exists, bake an `emissive` buffer with the same sampler (transparent elsewhere).
- PBR: when any source has `T.mr` or `T.pbr`, bake grey `metal` and `rough` buffers (value from
  `T.mr` texel channels B = metal, G = rough, or the `T.pbr` factors x 255; default metal 0, rough 255).
- Height: when any source has `T.heightOf`, bake a grey `height` buffer from it (verify the return
  type of `heightOf()` in `modelops.js:164` / `surface.js` before coding; it feeds `heightFromData`).
  Sources that only have a `<canvas>_n` normal map: add the note
  `normal map of <canvas> not carried into the atlas: add a "height" layer to it`.
- End with `dilate` on every buffer.

### 5.2 Masks: `bakeMasks(layout, map, mesh, opts)` -> `{ ao, cavity, edge, crease, grime, up: Float32Array(W*H) }`

- Occluders: BVH of the WHOLE built mesh (`bvhOf([mesh])`, unwrapped and kept faces, overlay shells
  excluded). Rigs (`built.layout` non-null) with `across_nodes:false`: one BVH per `f.node` value
  (faces of the same node only), so parts that move do not carry each other's shadow.
- `ao[k] = aoAt(bvh, p, n, hemisphere(samples), { distance, strength: 1, bias: 0.05, levels: 0 }, hashf(i, j) * 2 * PI)`
  (`src/bake.js:181`), `p` in built px (pattern position + anchor), `n` = `map.nrmAt(k)`.
- `cavity[k] = 1 - aoAt(... 8 samples, distance: contact.width ...)`: short range = where another
  part or a crease is within `width` px: the contact mask.
- Ray budget: `rays = filled * (samples + 8)`. When `rays > UNWRAP_LIMITS.rays`, compute both on a
  lattice of `step = ceil(sqrt(rays / UNWRAP_LIMITS.rays))` texels per island and fill the rest by
  bilinear interpolation over filled lattice texels (nearest when a neighbour is missing). Report `ao_step`.
- `edge[k]`: 1 when the texel centre is within `edges.width` texels (2D distance, chart space) of a
  CONVEX sharp boundary edge of its facet: the neighbour across that edge exists, dihedral >=
  `edges.min_angle`, and `dot(a.n, b.c - a.c) < 0`. Open border edges count as convex only when
  `cavity < 0.3` at the texel (a slab resting on another part gets no highlight in the contact).
  Break-up: keep the texel only when `vnoise(p, 6, seed) < wear` (copy the 12-line `vnoise` from
  `model3d.js:1277` into `uvbake.js`; do not export-refactor it).
- `crease[k]`: 1 in two cases. (a) The texel is within 1 texel of a CONCAVE sharp edge of its facet
  (same test as above with `> 0`). (b) `contact.line` is on and the texel is a local contact maximum:
  `cavity[k] > 0.75` and no 4-neighbour inside the island has a higher `cavity` by more than 0.02 in
  the direction away from the contact (in practice: the one texel row nearest the other part). This
  gives a 1 px contact line where the shaft meets the cap even though the two parts share no edge.
  If (b) produces lines thicker than 1 texel on the fixtures, thin them by keeping only texels whose
  `cavity` is the maximum of their 3x3 neighbourhood along the steepest axis.
- `grime[k]`: vertical-ish facets only: `clamp01(1 - (y - yMin) / grime.height) * (0.5 + vnoise(p, grime.noise, seed + 7))`,
  `yMin` = model bounds min y; plus `0.5 * clamp01((0.6 - ao) / 0.6)` everywhere (dirt collects in occluded places).
- `up[k] = max(0, n.y)`.
- Also return an RGBA `masks` image (R = ao, G = cavity, B = edge, A = 255 on filled texels) for the hidden `masks` layer.

### 5.3 Courses: `bakeCourses(layout, map, spec, parts)` -> `{ joint: Uint8Array(W*H) (0 none, 1 joint, 2 highlight) }`

Per unwrapped part (`f.pi`), with `y0, y1` = the part's vertical extent in pattern space
(`built.partBounds[pi]`, minus anchor) and `Hpart = y1 - y0`:

- Bed joints (`snap:"parts"`): `n = max(1, round(Hpart / h))`, joints at `y0 + k * Hpart / n`, `k = 0..n`
  (the part's own bottom and top are joints: a slab becomes one course, the shaft whole drums, and
  the joint between two stacked parts is one shared line). `snap:"world"`: joints at multiples of `h`.
  A vertical-ish texel is a bed joint when `floor` of its `y` lies in `[jointY, jointY + joint)`.
- Head joints (`bond != "drums"`), vertical-ish facets: coordinate `S` = island `st` u (ring charts:
  scaled so `L` holds a whole number of stones: `m = max(1, round(L / len))`, `period = L / m`);
  non-ring charts: `period = len`, anchored at world. Course index `c = floor((y - y0) / (Hpart / n))`;
  offset `period / 2` on odd `c` for `running`. Texel is a head joint when
  `floor(positive_mod(S - offset, period)) < joint`. `jitter` (0..0.4) shifts each joint by
  `(hash(c, stoneIndex, seed) - 0.5) * jitter * period`, rounded to whole texels.
- Up / down facets (`caps:"edge"`): no joints. `caps:"grid"`: joints at world multiples of `len` on both axes.
- Highlight (`2`): the texel directly below a bed joint and directly right of a head joint (light from the upper left), unless it is a joint.
- `parts` filter limits it to those parts.

### 5.4 Compose and quantize: `composeCohesion(base, masks, courses, opts, palette)` -> `cohesion` RGBA

Move `BAYER4` and the nearest-palette search out of `quantizeFrames` (`modelops.js:341`) into a small
exported helper in `src/color.js`: `nearestColor(pal, r, g, b, cache)` (same metric, same results;
`quantizeFrames` then calls it: byte-identical renders, covered by existing render tests) and export `BAYER4`.

Palette:

- `"auto"`: unique opaque colours of `base`; when > 48, `medianCut([base], colors)`. Then, for the 8
  most frequent colours add `mix(c, shadow, 0.3)`, `mix(c, shadow, 0.55)`, `mix(c, highlight, 0.35)`
  (so a 3-colour texture still has room to shade). Deduplicate.
- `"project"` / `"canvas"`: the model's project palette / the atlas canvas palette (same lookup as
  `model_render`, `modelops.js:686`); `[hex, ...]`: exactly those. Strict: nothing is added.

Per filled texel with base colour `c` (skip alpha 0):

```
aoq   = levels ? round(ao * (levels - 1)) / (levels - 1) : ao
dark  = clamp01(ao.strength * (1 - aoq) + contact.strength * 0.5 * cavity + grime.strength * grime)
light = edges.strength * edge
if crease or joint == 1:        target = mix(c, shadow, 0.6)        // crisp line
else if joint == 2:             target = mix(c, highlight, 0.3)
else if light > 0 and dark < 0.35: target = mix(c, highlight, 0.4 * light)
else:                           target = mix(c, shadow, 0.7 * dark)
off   = dither ? ((BAYER4[(j - rect.y) & 3][(i - rect.x) & 3] + 0.5) / 16 - 0.5) * 24 : 0   // stable under repacking
out   = nearestColor(palette, target + off)      // no offset on crease / joint texels
```

Overlays (3.3) are applied to `target` before the lookup. Write `out` into the `cohesion` layer only
when it differs from `c` (transparent otherwise), then `dilate` using the base mask so gutters match.
`joint.color` / `joint.light` given: use them directly (added to the palette).

### 5.5 Guide: `guideImage(layout, parts)` -> RGBA (hidden `guide` layer) and `guideSheet(...)` for replies

- Per island: 1 px outline on the interior border, colour by part (`hsl(pi * 47 mod 360, 70%, 60%)`),
  alpha 255; interior 8 px checker at alpha 40 aligned to pattern px (shows the texel grid and scale).
- Seams: boundary texels along visible seam edges in `#ff3030`.
- Label at the island's top-left (3x5 font from `getFont('3x5')`, `src/fonts.js:120`; read its glyph
  format first): `<id>` always; `<id> <part name or type> <role>` when the island is wide enough;
  skip the label when the island is smaller than 5x7.
- Reply image: nearest upscale of (composite + guide) so the long side is >= 384 px (integer factor,
  max 8), beside `renderViews(groups, { views: ['game', 'front', 'side'], size: 192 })` of the
  unwrapped model, joined with `packImages` (`src/sheet.js:43`).

### 5.6 Canvas I/O and paint preservation (`src/uvops.js`)

Create (pattern: `model_trim`, `modelexport.js:394`): `new Doc({ name, width: W, height: H })`,
layers in order: `base`, `cohesion`, `paint`, then `emissive` (if baked), hidden (`visible = false`)
`metal`, `rough`, `height` (if baked), `masks`, `guide`. `d.meta = { uv: {...}, build: false }`,
`engine.attach(d)`, `engine.changed(d, { op: 'unwrap', source, label, structural: true })`. Active layer = `paint`.

Re-running on an existing canvas:

- `do:"bake"` / `"cohesion"` rewrite only their own layers (`base` + data layers, or `cohesion` + `masks`). `paint` is never touched.
- `do:"layout"` (or `"all"`) when the new hash equals `meta.uv.hash`: keep everything, refresh `guide`.
- Hash differs: for every new island whose `key` matches an old island with the same `w, h`, copy
  that rect of `paint` (and of `cohesion` when cohesion is not being re-baked) to the new rect.
  If any old island with non-transparent `paint` texels has no match: without `overwrite:true` throw
  `unwrap: the model changed; <n> painted islands (<part names>) no longer exist. overwrite:true drops their paint (the rest is kept)`.
  A canvas named `canvas` that exists without `meta.uv`: throw unless `overwrite:true`.
- `do:"clear"`: delete `def.unwrap`, save the model; the canvas is left alone (the reply says so and names `art_canvas delete`).

`applyUnwrap(engine, def, built, opts)` (called from `build()`):

```
if (!def.unwrap || opts.noUnwrap) return
if (isSkinned(def) || def.morphs) -> do nothing here (model_unwrap already refused; see 7)
o = normUnwrap(def.unwrap); doc = engine.docs.get(o.canvas ?? `${def.name}_uv`)
layout = cached layoutOf(built.mesh, o, { anchor, include })
if (!doc || !doc.meta?.uv)                      -> built.unwrap = { missing: true }; return   // per-part textures, check reports it
if (doc.meta.uv.hash !== layout.hash)           -> built.unwrap = { stale: true, canvas }; return   // never show a scrambled atlas
tex = built.tex({ canvas: doc.name })           // texResolver: emissive / metal / rough / height layers come for free
regroup(built.mesh, layout, tex)
built.unwrap = { canvas: doc.name, size: [W, H], texel, islands: n, hash, fill }
```

`build()` change (`modelops.js:176`): after the GPU flatten, `applyUnwrap(engine, def, r2, opts)` where `r2`
includes `tex`. When `def.unwrap` is set: force `instances: false` and flatten `r.gpu` regardless of
`keepGpu` (unique texels per copy), and add `built.unwrap.notes` saying so when the caller asked for instances.
`ctx.nested` builds go through `buildModel` directly, so a sub-model's own `unwrap` is ignored when
it is placed with `type:"model"`: document it and report it as an info issue (`nested_unwrap`).

texResolver (`modelops.js:107`): when `d.meta?.uv`, add `'masks'` and `'guide'` to the exclude list
passed to `grab` (they are hidden already; this keeps the texture right if the agent shows them).
No change for canvases without `meta.uv`.

The base pass needs the per-part look: `model_unwrap` builds with `build(engine, def, { noUnwrap: true })`.

### 5.7 Projection painting (`do:"view"` / `do:"project"`)

- `view`: orthographic only (`front|back|side|right|left|top` or `{yaw, pitch}`; `game` / `fp` /
  perspective specs throw `unwrap view must be orthographic`). Camera:
  `makeCamera(view, IW, IH, fit, { zoom: zoom / texel, margin: 2 })` with `fit` = the 8 bounds corners
  and `IW, IH` = projected extents x zoom + 4, capped at 1024 (throw with the zoom to use otherwise).
  1 view px = 1 atlas texel at `zoom:1`. Render the unwrapped model with
  `renderCamera(groupsOf(mesh), cam, IW, IH, { bg: null, ambient: 1 })` (flat, unlit: the colours are
  the atlas colours; check that `ambient: 1` gives unshaded albedo in `rasterCore`, else pass a
  light equal to the view direction and document it).
  Canvas `<model>_uv_<view>`: layer `render` (reference) + empty active layer `paint`;
  `meta.uv_view = { model, canvas: <atlas>, view, zoom, size, hash }`.
- `project {from}`: rebuild the same camera from `meta.uv_view` (refuse when its `hash` differs from
  the atlas hash). For every filled atlas texel: `p` = position, `n` = facet normal, `zc = cam.basis[2]`
  (points toward the camera). Visible when `dot(n, zc) > 0.25` and `bvh.hit(p + n * 0.05, zc, 1e6) >= 1e6`.
  `[sx, sy] = cam.project(p)`; take the `paint` pixel at `floor(sx), floor(sy)`; when its alpha > 0,
  write it to the atlas layer `layer` (default `paint`). Reply: `{ projected: <texels>, islands: [ids], skipped_hidden }`.
  Then `dilate` within island gutters. The view canvas is left for further passes.

---

## 6. `model_unwrap` flow (`src/uvops.js`)

```
model_unwrap(a, source):
  def = getModel(this, a.name); o = normUnwrap(a.unwrap ?? def.unwrap ?? true); step = o.do ?? 'all'
  refuse: isSkinned(def) -> 'unwrap: not on skinned models yet (skeleton / skin): unwrap before skinning is planned'
          def.morphs     -> 'unwrap: not with morphs yet'
  check   -> return { model, cohesion: cohesionCheck(...) }                 // works with or without an atlas
  clear   -> remove def.unwrap, save
  view / project -> 5.7 (needs a current atlas)
  guide   -> refresh guide layer, return image
  plain = build(this, def, { noUnwrap: true }); layout = layoutOf(plain.mesh, o, ...); map = texelMap(layout)
  layout  -> create / migrate the canvas (5.6); when the canvas is new also run bake (an empty atlas is never left behind)
  bake    -> bakeBase -> write base (+ data layers)
  cohesion-> bakeMasks (+ bakeCourses) -> composeCohesion -> write cohesion + masks
  save def.unwrap = stored options (without action-only keys) via saveModel(this, next, source, 'model unwrapped')
  reply (3.5) with cohesionCheck on the final build
```

`all` = `layout` + `bake` + `cohesion`. `bake` and `cohesion` on a missing canvas run `layout` first.
`cohesion` reads `base` from the canvas layer `base` (so the agent may repaint `base`).
`mcp.js` `run` needs no special case: the generic `call('model_' + a.action, rest)` path handles it.
`modelops.js` `applyPatch` already copies `MODEL_KEYS`; store through `normUnwrap` validation in
`model_create` / `model_update` (throw early on bad options).

---

## 7. Preview, render, export, rigs, UI

- Preview / render: nothing to change beyond `build()`. The atlas texture has no PBR by default,
  so `rasterCore` draws it unlit-flat + Lambert exactly like any texture; baked AO is in the albedo,
  so every preview and every `render` frame shows contact shading without `ao`.
- Export (`assembleGLB`, `modelops.js:1000`): the unwrapped faces export as one primitive / material.
  Add to the meta JSON and to `extras` passed to `writeGLB`:
  `uv: { canvas, size: [W, H], texel_px, islands, hash, cohesion: ['ao', 'contact', 'edges', ...] }`.
  Export reply gains `unwrap: { canvas, size }`. `atlas:true` keeps working on the remaining small textures.
- `bake_ao` / `lightmap` / `uv2` / `uv3`: unchanged (`chartFaces` works on `g.faces`; TEXCOORD_1 is
  free because the atlas uses TEXCOORD_0). When `def.unwrap` has cohesion AO and `bake_ao` is also
  asked, add the note `AO is already painted into <canvas>; bake_ao adds engine AO on top: use strength 0.5 or drop it`.
- LODs / decimate: UVs ride along as today; `pad:2` covers simplification drift. Add a test.
- Rigs (named parts): works through face `node`. AO is baked at rest, per node by default (5.2).
- Damage / fracture: must not throw on an unwrapped model (test). Interior cut faces keep their own
  textures. If `damagedBuilt` cannot carry atlas UVs through a path, make that path build with
  `{ noUnwrap: true }` and report `unwrap ignored for damage states` (do not edit damage goldens).
- Skinned / morphs: refused in v1 (clear error); `build()` ignores a leftover `def.unwrap` there.
- Stale or missing atlas: the model builds with per-part textures and replies carry
  `cohesion: "atlas <canvas> is stale: art_model unwrap {name:\"<n>\"}"`. Never render a scrambled atlas.

Web UI (the Blender-like shading modes are planned on another branch; this is the data contract only):

- `GET /api/model/<name>/glb`: already unwrapped (goes through `assembleGLB`). Scene `extras.agent_art.uv`
  as above (check how `extras` is nested in `writeGLB` and follow it).
- `GET /api/model/<name>/info`: `summary` gains `unwrap: { canvas, size, texel_px, islands, fill, hash, stale?, missing? }`.
- `GET /api/model/<name>/uv.png?layer=guide|masks|base|cohesion|paint|texture` (new, `src/server.js`
  next to the `thumb.png` route): PNG of that layer of the atlas canvas (`texture` = the composite the
  model uses). 404 with `{ok:false, error}` when the model has no atlas.
- Shading modes the UI can build from this: Textured (glb), Albedo-only (`base`), AO / cavity / edge
  (`masks` R / G / B), UV checker (`guide`), Islands (`guide` colours), Texel density (constant by
  construction; per-part values from `do:"check"`). The atlas canvas is a normal canvas, so the
  existing canvas `event`s refresh the viewer when it is painted; emit the usual model event after `unwrap`.

---

## 8. Cohesion check (`src/uvcheck.js`)

`cohesionCheck(def, built, { atlasDoc, layout, full })` -> `{ pass, score, issues: [{ id, level:
'error'|'warn'|'info', parts: [names or indices], detail, fix }] }`. Works on models with and without an atlas.

| id | Level | Metric | Fix text |
| --- | --- | --- | --- |
| `texel_density` | error when CV > 0.15 or a part's median is outside 0.8..1.25 of the model median | Per face `density = sqrt(uvArea * texW * texH / worldArea)` (texels per px) on textured faces (> 1x1), area-weighted per part | `art_model unwrap {name}` (uniform density), or the per-part hint (`tile:true`, `wrap:"repeat"`, remove `scale`) |
| `front_seam` | error | Smooth edges (dihedral < 46 deg) with `vis > 0.6` where texels sampled on both sides differ on > 25% of 1 px steps (catches the default cylinder seam at +z; under an atlas: visible seams from 4.3 whose two sides differ) | `unwrap` (seam moves to the back, ring fit closes it) or `r = k * W / (2 * PI)`: suggest the two nearest radii |
| `pattern_seam` | warn | Ring charts whose fit was refused (5.1) | The `suggest_r` values, or `bake:{fit_max:0.2}` |
| `course_cut` | warn | Course period `ph` of each wall texture = best autocorrelation lag (4..64) of its row-mean luminance, used when the peak > 0.3; a part whose bottom or top y (pattern space) is > 1 px off a multiple of `ph` | `set h / at.y to multiples of <ph>` or `unwrap:{cohesion:{courses:{h:<ph>}}}` with a jointless stone texture |
| `no_contact_shading` | error | >= 2 parts whose bounds touch or overlap (`partBounds`, 0.5 px tolerance) and: no atlas, or atlas where mean luminance of texels with `cavity > 0.5` is > 0.95 x the mean of texels with `cavity < 0.1` (masks recomputed at 8 samples when the `masks` layer is absent) | `art_model unwrap {name}` or `unwrap:{do:"cohesion"}` |
| `flat_edges` | info | Atlas present, `edges` pass off and no `paint` texels within 1 px of convex edges | `unwrap:{do:"cohesion", cohesion:{edges:{}}}` |
| `stale_atlas` / `missing_atlas` | error | From `built.unwrap` | `art_model unwrap {name}` |
| `guide_visible` | error | `guide` or `masks` layer visible | `art_layer visibility` call |
| `atlas_fill` | info | `fill < 0.4` | smaller `max_size` or `pad` |
| `nested_unwrap` | info | A `type:"model"` part whose model has `unwrap` | unwrap the parent |

`score = 100 - 25 * errors - 8 * warns` (min 0); `pass = errors === 0`. `full:false` (used by
`summary`) computes only `texel_density`, `course_cut` (cached per texture key), `no_contact_shading`
(bounds part only), `stale_atlas`, `missing_atlas`, and skips everything when faces > 5000.

Where it is reported:

- `art_model unwrap {do:"check"}`: the full report.
- `model_export` reply: `cohesion: { pass, score, issues: [first 3], fix }` when `pass` is false; nothing when it passes.
- `summary()` (create / update / info): one string field `cohesion` (not inside `warnings`, so tests
  that assert on `warnings` are untouched), only when the quick check fails and the model has >= 2
  textured parts: `"detached look: <ids>; art_model unwrap {name:\"<n>\"} bakes one cohesive texture (check: unwrap:{do:\"check\"})"`.
  If any existing test compares a whole create / update reply and now fails, gate the field to
  models with >= 2 touching parts and re-run; do not edit the old test's expectation unless the new
  field is the only difference, and say so in the commit message.

---

## 9. Docs (`src/docs.js`, terse)

`TOPICS['3d']`: after the `TEXTURES:` line add one paragraph (<= 900 chars):

```
ONE OBJECT, NOT PARTS (unwrap): parts textured separately read as separate objects (courses cut at part edges, cylinder seam on the front, no contact shadow). art_model unwrap {name} = one UV atlas canvas <name>_uv for the whole model at 1 texel = 1 px (islands unfolded with no stretch, seams on the back), the part textures baked in world-aligned (patterns run on across parts), plus contact AO, crease lines, edge wear and ground grime quantized to the palette. Then paint transitions on its "paint" layer (art_draw), or in a view: unwrap:{do:"view",view:"front"} -> paint -> unwrap:{do:"project",from:"<name>_uv_front"}. unwrap:{do:"check"} = cohesion report (texel density, front seams, cut courses, missing contact shading). Options: unwrap:{texel:1|2, max_size:256..2048, angle:46, parts|exclude, bake:{fit}, cohesion:{ao,contact,edges,grime,courses:{h,len},overlays:[{texture,where:contact|cavity|top|bottom|edges}],palette}}. Masonry: jointless stone texture + courses = joints drawn model-wide (each part = whole courses). Preview / render / export use the atlas; unwrap:null on update removes it. Not yet: skinned models, morphs; glass / opacity parts keep their own material.
```

`TOPICS.materials`: one line: `UNWRAP ATLAS: metal / rough / height / emissive of the part textures are baked into hidden layers of <name>_uv (edit them like any canvas); bake_ao / lightmap still use TEXCOORD_1; AO is already in the atlas colour, so use bake_ao strength 0.5 or none.`

`art_model` description (`src/mcp.js:296`): append one sentence, as short as possible:
`unwrap {name, unwrap?:{do,texel,max_size,cohesion}} = one cohesive UV atlas canvas <name>_uv for the whole model (world-aligned bake + contact AO + edge wear; paint it; do:"check" = cohesion report).`

Also add `unwrap` to the list in `art_help` skills / workflow text only if a 3D recipe exists there
(search `src/skills.js` for `art_model`); one line, no new skill.

---

## 10. MCP tool-list budget

`test/quality.test.js:143` asserts `size < 43615` (about 43.5k today). The feature needs:

- action enum `'unwrap'`: +9 chars;
- one property `unwrap: { type: ['object', 'boolean', 'null'] }`: +46 chars (everything else is nested inside it; no other new top-level params);
- the description sentence above: about +200 chars.

Procedure: measure before (`node -e` snippet printing `JSON.stringify(TOOLS-as-listed).length`, or
temporarily log `size` in the test), apply, measure after. Set the new limit to `after + 60` rounded
up to a multiple of 5 and prepend to the existing comment chain, in its style:
`// <old limit> before model UV unwrap (art_model unwrap action + nested unwrap param: <before> -> <after> measured); ...`.
Do not shorten any existing description to make room.

---

## 11. Performance limits

| Limit | Value | Behaviour past it |
| --- | --- | --- |
| Atlas side | 64..2048 (default 1024) | error with fixes (4.4); never a silent rescale |
| Facets | 20000 | error (decimate / parts filter); `method:"auto"` uses `box` above 6000 |
| Islands | 4096 | error |
| AO rays | 12e6 per bake | lattice + bilinear (`ao_step` in the reply) |
| View canvas | 1024 px side | error naming the zoom that fits |
| Layout per `build()` | cached by geometry hash | target < 30 ms for 2000 faces uncached, < 3 ms cached |

Targets to measure and write in the PR description (machine-dependent; record the numbers, do not
assert tight times in tests): column `unwrap` all steps < 1.5 s; a 512x512 atlas < 8 s; 1024x1024 < 30 s.
Tests assert only generous ceilings (10x the targets).

---

## 12. Worked example: the stone column

Textures (any 16x16 brick and a jointless stone; shown with existing tools):

```
art_create_canvas {name:"brick", width:16}
art_draw {canvas:"brick", commands:[{op:"rect",x:0,y:0,w:16,h:16,color:"#8a8478"},{op:"line",x1:0,y1:7,x2:15,y2:7,color:"#4a463e"},{op:"line",x1:0,y1:15,x2:15,y2:15,color:"#4a463e"},{op:"line",x1:7,y1:0,x2:7,y2:7,color:"#4a463e"},{op:"line",x1:15,y1:8,x2:15,y2:15,color:"#4a463e"}]}
art_create_canvas {name:"stone", width:16}
art_draw {canvas:"stone", commands:[{op:"rect",x:0,y:0,w:16,h:16,color:"#8a8478"},{op:"rect",x:3,y:4,w:2,h:1,color:"#7a7468"},{op:"rect",x:10,y:11,w:3,h:1,color:"#9a9488"}]}
```

Before (today; looks like four objects):

```
art_model create {name:"column", origin:"bottom", parts:[
  {type:"box", name:"plinth", w:28, h:6, d:28, texture:"brick"},
  {type:"box", name:"base", w:22, h:4, d:22, at:[0,6,0], texture:"brick"},
  {type:"cylinder", name:"shaft", r:8, h:44, segments:12, at:[0,10,0], texture:"brick"},
  {type:"box", name:"cap", w:24, h:6, d:24, at:[0,54,0], texture:"brick"}]}
art_model preview {name:"column", views:["game","front"], size:384}
art_model unwrap {name:"column", unwrap:{do:"check"}}
```

Note: named parts create a rig layout; for a static prop use `tag` or no names if the rig is unwanted
(the example keeps names for readable guide labels; the test fixture has both variants).

Expected check (before): `front_seam` (shaft: circumference 50.27 px is not a multiple of 16; suggest
`r:7.64` or `r:10.19`), `course_cut` (plinth h 6, base h 4, cap h 6 against the 8 px course),
`no_contact_shading` (4 touching parts), `pass:false`.

After, step 1 (one call, keeps the brick textures):

```
art_model unwrap {name:"column"}
```

Result: canvas `column_uv` (expected 128x128 at texel 1: surface about 7100 px2 plus gutters),
shaft = one strip island with the seam at the back and the brick pattern closed by ring fit
(50.27 -> 48 px, scale 0.955, inside `fit_max`), courses still on world y, contact AO and a crease
line under the cap and around the shaft foot, highlighted worn top edges of plinth / base / cap,
ground grime on the plinth. `front_seam` and `no_contact_shading` are gone; `course_cut` remains (warn).

After, step 2 (masonry that belongs together: jointless stone + model-wide courses):

```
art_model update {name:"column", set:{plinth:{texture:"stone"}, base:{texture:"stone"}, shaft:{texture:"stone"}, cap:{texture:"stone"}}}
art_model unwrap {name:"column", unwrap:{cohesion:{courses:{h:8, len:16}, overlays:[{texture:"moss", where:"contact", amount:0.5}]}}}
```

(`overlays` needs a `moss` canvas; drop it otherwise.) Result: plinth, base and cap are one course
each, the shaft is 5 or 6 whole drums (44 / 8 -> 6 courses of 7.33 px, drawn on whole texels), head
joints run round the shaft with no seam, joints between parts coincide with the part borders.
Check passes.

Hand finish and export:

```
art_model unwrap {name:"column", unwrap:{do:"view", view:"front", zoom:2}}
art_draw {canvas:"column_uv_front", layer:"paint", commands:[{op:"line", x1:20, y1:30, x2:26, y2:44, color:"#4a463e"}]}   // a crack across shaft and base
art_model unwrap {name:"column", unwrap:{do:"project", from:"column_uv_front"}}
art_model preview {name:"column", views:["game","front","side"], size:384}
art_model export {name:"column"}
```

(Check the exact `art_draw` layer parameter name in `src/mcp.js` / `engine.run('draw', {canvas, commands, layer})` as used in `test/fixtures/corpus.js:16`.)

---

## 13. Tests (`test/uvunwrap.test.js`, fixtures in `test/fixtures/uv-corpus.js`)

Fixture models (`uvCorpusEngine()` like `corpusEngine()` in `test/fixtures/corpus.js`):

- `column` (section 12, unnamed-part variant `column_static` and named variant `column`),
- `arch`: ruined arch: two `pillar`s, an `arch` part with `broken`, a `rubble` pile, brick texture,
- `crate`: `box` with `bevel:2` and `insets`, wood planks texture + a metal strap box overlapping it,
- `hull`: ship hull section: `box` with `taper`, a `cylinder` engine (frustum `r_top != r_bottom`),
  a `tube`, plate texture, one `glass:true` canopy part (must be kept out of the atlas).

Tests (each a `test(...)`):

1. No unwrap = no change: build `column_static` before and after importing the new modules; group
   keys and `uv` arrays identical; and the existing golden tests still pass (run them).
2. Layout determinism: two `layoutOf` runs give the same hash and rects; hash changes when a part moves.
3. Zero stretch: for every facet, 2D triangle area = 3D area (tolerance 1e-3 px2) and every 2D edge length = 3D length, `method:"smart"`.
4. Box = 6 islands at `angle:46`, 1 island at `angle:91`; 12-segment cylinder side = 1 ring island
   with `ring.L = 2 * N * r * sin(PI / N)`; its seam facet edges have `dot(n, front) < 0`.
5. No overlap: no atlas texel is claimed by two islands; gutters >= `pad` between island rects; all UVs in [0, 1].
6. World grid: an axis-aligned mode-1 box: `bake.tile:"island"` and `"uv"` give identical `base` buffers; and
   rendering `front` at 1 px per px before and after `unwrap {cohesion:false}` gives an identical image
   for a model made only of axis-aligned boxes (the bake is lossless there).
7. Ring fit: column shaft `ring_fit.scale` about 0.955; the `base` columns at both ends of the ring
   are consecutive columns of the brick texture (no seam); with `fit:false` the check reports `pattern_seam`.
8. Packing: error (not rescale) when `max_size:64` cannot hold `column`; message names `max_size` and `texel`.
9. Cohesion: texels of the cap underside ring and the shaft top row are darker (lower mean
   luminance) than the shaft mid-height texels; convex top edges of the plinth contain highlight
   colours; every `cohesion` texel colour is in the palette; `palette:[...]` strict adds no colour;
   same input twice = identical bytes.
10. Courses: with `snap:"parts"`, bed-joint rows of plinth / base / cap sit exactly on their first and last texel rows; head-joint count round the shaft = `round(L / len)`.
11. Canvas: layers `base, cohesion, paint, masks, guide` exist, `masks` / `guide` hidden, `meta.uv.hash` set, `meta.build === false`; texture used by the build has no guide pixels even when `guide` is made visible.
12. Paint preservation: paint a pixel in an island, move a different part, re-run `do:"layout"`: the pixel is at the island's new rect; changing that island's part throws without `overwrite`.
13. Stale: change a part without re-running: build falls back to per-part groups, `summary.cohesion` mentions stale; `do:"check"` reports `stale_atlas`.
14. Export: `.glb` of `column` has 1 material / 1 image for the unwrapped faces, passes `src/gltfvalidate.js` (use the helper the other tests use), meta has `uv`; with `bake_ao:true` TEXCOORD_1 still exists; `lods:[0.5]` exports; `hull` keeps a second material for the glass part.
15. Rig: named-part `column` exports nodes with atlas UVs; pose preview renders.
16. Damage: `preview {damage: ...}` on `crate` does not throw (or reports `unwrap ignored for damage states`).
17. Projection: `do:"view"` front, paint one pixel on `paint`, `do:"project"`: exactly the atlas texels of the front-facing island at that position change; back-facing islands unchanged.
18. Check: before-unwrap `column` reports `front_seam`, `course_cut`, `no_contact_shading`, `pass:false`; after section-12 step 2, `pass:true`. A single box passes with no issues (no false alarms). A `tile:false` part next to a tiled part reports `texel_density`.
19. Refusals: skinned model and `morphs` throw the documented errors; unknown option throws; `max_size:4096` throws.
20. MCP: tool list under the new measured limit; `art_help {topic:"3d"}` contains `unwrap`; `test/tokens.test.js` still passes.
21. Acceptance renders: when `AA_UV_RENDERS=<dir>` is set, write `<model>_before.png`, `<model>_after.png`
    (views `game, front, side`, size 384) and `<model>_uv.png` (atlas + guide) for column, arch, crate,
    hull. Without the env var the test only asserts that `after` differs from `before` and that the check passes.

Commands:

```
node --test test/uvunwrap.test.js
node --test test/model3d.test.js test/materials.test.js test/surface3d.test.js test/ctm3d.test.js test/meshproc.test.js test/quality.test.js test/tokens.test.js
node --test test/ > C:\dev-overflow\claude-tmp\uv-test.log 2>&1      (background; read the tail of the log)
AA_UV_RENDERS=C:\dev-overflow\claude-tmp\uv-renders node --test test/uvunwrap.test.js   (PowerShell: $env:AA_UV_RENDERS = '...')
```

Look at the eight before / after PNGs yourself (Read tool) and attach them to the PR: the after images
must show (a) no seam on the front of round parts, (b) a dark contact line where parts meet,
(c) lighter worn convex edges, (d) the pattern running on across part borders.

---

## 14. Risks and do-not rules

- Do not touch `src/fp*.js`. Do not change `cylinder`, `worldUV`, `finalize`, `faceTexer`, `packCharts`, `buildAtlas`, `aoAt` behaviour.
- Do not re-record goldens. If a golden fails, the new code leaked into the default path: fix the leak.
- `quantizeFrames` refactor (5.4) must be byte-identical: run the render tests before and after; if any doubt, copy the 12 lines into `uvbake.js` instead of refactoring.
- The atlas canvas is a user-editable canvas: never overwrite `paint`; never delete the canvas implicitly.
- Never show a stale atlas on changed geometry (fall back to per-part textures and say so).
- Hinge unfolding of non-developable surfaces (domes, rocks) yields many small islands: fine, but watch the island cap and `fill`; `method:"box"` is the escape hatch. Add the `arch` / `rubble` fixture to catch this.
- Fractional geometry (hinged islands not on the texel grid) relies on dilation for edge texels; check the bevelled `crate` render for edge sparkle and raise the default `pad` only if needed.
- AO baked into albedo + engine AO = double darkening: note in docs and export reply (section 7).
- Large kit rooms do not fit an atlas at texel 1: that is expected; the error must tell the agent to unwrap hero parts or use `texel:2`.
- Reply size: keep the `unwrap` reply (without image) under 1500 chars; `summary.cohesion` under 200 chars.
- Unknowns to verify in code before relying on them: `heightOf()` return type; `extras` nesting in `writeGLB`; `rasterCore` unlit option for the projection view; font glyph format; the `damagedBuilt` UV path; whether any test deep-equals a create / update reply.

---

## 15. Implementation steps (ordered, each shippable)

Each step: implement, add the listed tests, run the listed commands, commit only the touched files.

1. Layout core. `src/uvunwrap.js`: `normUnwrap`, `facetsOf`, `buildCharts` (`smart`, `box`, `faces`), `packIslands`, hashes, `layoutOf`, `texelMap`, `dilate`. Tests 2-5, 8, 19 (options part). No engine wiring. Acceptance: tests pass; full suite unchanged.
2. Base bake + canvas + build swap. `src/uvbake.js` `bakeBase`; `src/uvops.js` `model_unwrap` (`layout`, `bake`, `clear`), `applyUnwrap`, `regroup`; `modelops.js` wiring (`MODEL_KEYS`, `build()`, `...uvOps`, texResolver exclude). Tests 1, 6, 7, 11, 13, 14 (basic export), 19. Acceptance: `unwrap {cohesion:false}` on the box-only model renders identically to before; goldens pass.
3. MCP + docs. `src/mcp.js` enum / property / sentence; `src/docs.js`; budget bump with measured note. Test 20. Acceptance: the action is callable through the MCP bridge (`agent-art tool` CLI) end to end on `column`.
4. Masks + cohesion compose. `bakeMasks`, `composeCohesion`, palette modes, `nearestColor` helper. Test 9. Acceptance: column after-render shows contact line, edge wear, grime; deterministic bytes.
5. Guide + reply image + paint preservation. `guideImage`, `guideSheet`, layout migration. Tests 11 (guide), 12. Acceptance: reply image shows labelled islands beside the views.
6. Cohesion check. `src/uvcheck.js`, `do:"check"`, `summary.cohesion`, export reply field. Test 18, 13. Acceptance: section-12 before / after reports match.
7. Courses + overlays. `bakeCourses`, cohesion `overlays`. Test 10. Acceptance: section-12 step 2 passes the check and the render shows whole courses per part.
8. Projection painting. `do:"view"` / `do:"project"`. Test 17.
9. Export / rig / LOD / damage hardening + UI data. Meta `uv`, `extras`, notes, `/api/model/<name>/uv.png`, `info.unwrap`. Tests 14-16, plus a `test/ui.test.js`-style request for `uv.png` if that file tests routes.
10. Acceptance renders + performance numbers. Test 21; record timings (section 11) and the tool-list sizes in the PR description; weak-model check: one Haiku subagent given only `art_help {topic:"3d"}` must produce a column that passes `do:"check"` using `art_model unwrap` (project memory: benchmark through the `agent-art tool` CLI bridge).

## 16. Definition of done

- `node --test test/` passes with no golden re-recorded and no existing assertion weakened (only the tool-list limit raised, with the measured note).
- A model without `unwrap` is byte-identical in build, preview, render and export.
- `art_model unwrap {name}` on column, arch, crate and hull produces an atlas canvas, a passing cohesion check, and after-renders that show: no front seam on round parts, contact shading where parts meet, worn convex edges, patterns continuing across part borders.
- Preview, render, export (.glb validates), rigs, `bake_ao` / lightmap, LODs work on unwrapped models; skinned / morph models refuse with a clear message; glass / opacity parts keep their materials.
- The agent can paint the atlas directly and through a view projection, and paint survives re-layout of unchanged islands.
- `art_help {topic:"3d"}` and `{topic:"materials"}` document it tersely; the tool list is within the new measured budget.
- Before / after PNGs of the four models and the measured timings are attached to the PR.

---

## Implementation notes

Verified in code (section 14 unknowns):

- `heightOf()` returns a `Float32Array` (0..1) or `null`.
- `writeGLB` puts `opts.extras` in `asset.extras`, so the export carries `asset.extras.uv` (not scene extras).
- `rasterCore` `ambient:1` gives albedo only for groups that are not lit (no pbr / mr / normal / ao). The projection view renders groups with those fields stripped.
- Font glyphs are arrays of '0'/'1' row strings (uppercase only). `BAYER4` was already exported from `util.js`.
- `damagedBuilt` works on the unwrapped build: the damage preview test passes.
- No test deep-equals a create / update reply. The new `cohesion` summary field appears only on multi-part textured models that fail the quick check, and on stale or missing atlases.

Deviations (smallest correct change; each covered by `test/uvunwrap.test.js`):

- `quantizeFrames` was not refactored. `nearestColor` (redmean metric) was added to `color.js` as a copy, so existing renders cannot change.
- Cavity is `clamp01(2 * (1 - aoAt(...)))`. The raw short-range value peaked near 0.5 at real contacts, so the contact line and `overlays` never triggered.
- Compose dither amplitude is 16 (plan: 24), and texels the passes leave untouched (darkening under 0.02, no light, line or overlay) are skipped. With 24, flat stone was checkerboarded by speck colours.
- A sharp edge is `dihedral >= min_angle + 0.5`, so the 30-degree cylinder facets are not "edges" at the default `min_angle:30`.
- Charts carry an orientation (`phi`): a facet joins a chart only if its texture u direction stays within 30 degrees. Otherwise hinge unfolding rotated the pattern on the bevelled crate corners.
- `front_seam` only counts smooth visible edges where the u direction continues across the edge. Box corners, where the texture direction legitimately turns, were false alarms.
- Atlas staleness includes the part textures (`meta.uv.src`, a hash of the source texture keys), so a texture swap with unchanged geometry re-bakes instead of showing the old base.
- Ring fit scales around the ring start `ring.u0` (the seam), so the cut lands on a whole period.
- Faces that the triangle topology splits get one face record per facet in the atlas group (`regroup`), with `mode:0` and `uvi` = island id.
- `flat_edges` is simplified: it is reported (info) when the atlas has no edge pass and the `paint` layer is empty, without testing paint within 1 px of convex edges.
- A fresh or re-laid atlas always runs layout + bake + cohesion, whatever `do` asks for. This means a new layout is never left empty or scrambled.
- `do:"check"` and `do:"view"` use the stored `def.unwrap` merged with the call's options.
- AO / contact occluders are per node only when parts can move (`poses` or `clips` present, `across_nodes:false`). The plan's per-node rule for every rig layout contradicted its own worked example: named parts alone make a rig layout, and the named column must get contact shading under the cap and at the shaft foot.
- `migrated` (reply note) counts islands that carried paint, not every matched island.
- The section-9 docs paragraph is the plan's text (over 900 characters); the tool list (MCP) holds only one sentence.
- Test 1 is done in-process: one engine builds, previews, exports and inspects `column_static` before and after `column` is unwrapped (byte-identical). The goldens run unchanged in the full suite.
- Test 6 renders at 1 screen px per model px (orthographic, pixel centres on texel centres). At preview sizes, pixels on texel borders round differently with the atlas UVs, which is a sampling-phase difference and not a bake loss.

Measured (Windows dev box, node 22, `accept.mjs`):

| model | atlas | islands | fill | unwrap ms | check before -> after |
| --- | --- | --- | --- | --- | --- |
| column | 128x128 | 21 | 0.49 | ~190 | FAIL 42 -> PASS 92 (course_cut warn); stone + courses: PASS 100 |
| arch | 256x256 | 95 | 0.37 | ~460 | FAIL 42 -> PASS 92 |
| crate | 256x256 | 13 | 0.29 | ~250 | FAIL 42 -> PASS 92 |
| hull | 128x256 | 15 | 0.31 | ~170 | FAIL 0 -> PASS 100 (glass kept) |

Tool list: 43520 -> 43777 chars (`art_model` `unwrap` action, `unwrap` property and one sentence). The limit is 43840.
