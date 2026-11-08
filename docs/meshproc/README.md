# Mesh processing and cluster LOD

`art_model` has five actions for heavy hard-surface meshes, such as walkable true-scale ships of 40k to 200k+ triangles:

- `boolean`
- `remesh`
- `decimate`
- `cluster_lod`
- `visibility`

Everything is pure JavaScript with no native dependencies, and the output is deterministic: the same input always gives the same bytes.

To rebuild the demo renders and `demo-stats.json`, run `node docs/meshproc/build-demos.mjs`.

## Units

API arguments are in model units, which are metres at the default 32 px = 1 m (`def.scale`).

Results of `boolean`, `remesh` and `decimate` are saved as a new model named `out` (default `<name>_<op>`). That model has one part, `{type: "baked", mesh: "<out>"}`. Its mesh is stored next to the model JSON as `<models>/<out>.mesh.bin`, textures included. Because it is an ordinary model, `preview`, `export`, `lods`, `bake_ao`, `cull` and placing it in layouts (`{type: "model"}`) all work. `delete` removes the `.mesh.bin` too.

`preview: true` on any of these actions adds a render with a wireframe overlay.

## boolean

```
art_model boolean {name, op?: "union"|"subtract"|"intersect", with?: "<other model>", out?}
```

- **With `with`:** a boolean of the two models.
- **Without `with`:** union of every shell of the model into one outer shell. A shell is an edge-connected piece: a part, plate, pod or greeble. Faces inside another shell are removed, and so are touching faces that face each other. This turns a kitbashed ship into one hull with no hidden interior faces.

### Algorithm (`src/meshbool.js`, `src/arrange.js`)

1. **Intersection graph.** Every intersection point gets one symbolic key, and every triangle that touches the point uses the same key. That means the point is computed once and the result cannot crack. The keys are:
   - `v<id>`: an input vertex
   - `e<a>_<b>f<tri>`: an edge crossing a plane
   - `E<edge>|<edge>`: two edges crossing
   - `x<t1>,<t2>,<t3>`: a triple point
2. **Snapping.** Near-coplanar cases are decided by an orientation predicate: a float filter with an exact BigInt fallback. Distances within `eps` (1e-7 of the bounding diagonal) are snapped.
3. **Splitting.** Each cut triangle is split into the faces of its planar graph:
   - a half-edge walk finds the faces
   - holes are bridged
   - ear clipping triangulates them, without cutting ears across points that lie on a split edge
   - points found on an edge are also inserted into the triangle across that edge, so there are no T-junctions
4. **Classification.** Each face is classified at an interior point by winding-number tests: a majority of 3 skew rays on a BVH. Each test also checks coplanar same-facing and opposite-facing contact. Uncut triangles are flood-filled into regions and classified once per region.
5. **Weld.** A final weld at 1e-7 of the bounding diagonal merges points that were computed two ways.

Measured timings and triangle counts are in *Numbers* below.

### Part booleans

Part booleans (`boolean: "subtract"` on a part) switch to this path when the two operands have more than 4000 triangles together (`ROBUST_THRESHOLD` in `csg.js`). Below that, the BSP path is kept, so existing outputs stay byte-identical. To choose the path yourself, set `boolean_method: "auto"|"robust"|"bsp"` on the cutter part.

### Inputs that cannot become watertight

Open shells pass through and are not capped. Greeble cables and bottomless panels are examples. Use `remesh {method: "voxel"}` when you need a watertight result from such input.

Two solids that touch only along an edge produce an edge with 4 faces (non-manifold). That is the correct result for that contact.

## remesh

```
art_model remesh {name, method: "voxel", voxel?: 0.1 (m) | resolution?: 64, sharp?: true, simplify?: true, max_error?, feature_angle?: 35, out?}
art_model remesh {name, method: "quad", faces?: <target>, feature_angle?: 40, symmetry?: "x"|"y"|"z"|{axis, at}, iterations?: 3, out?}
art_model remesh {name, method: "cleanup", weld?, holes?: 16, out?}
```

### voxel

1. **Occupancy.** Each voxel is classified by its winding number, computed by casting rays along the three grid axes and taking a majority vote. This copes with self-intersecting, non-manifold and overlapping soups such as greeble piles.
2. **Topology fix.** The occupancy is made well-composed, so the contoured surface is always manifold.
3. **Dual contouring.** One vertex per cell, placed by a QEF built from Hermite data. The Hermite data are ray hits on the source and their normals. The QEF is regularised toward the mass point (λ = 0.05) and clamped to the cell. The result keeps sharp features.
4. **Simplify.** A QEM pass with error ≤ 0.25 voxel.
5. **Attribute transfer.** UVs, materials (one group per source material), normals and vertex colours are copied from the closest point on the source, found with a BVH.

The output is closed, manifold, and has no non-manifold vertices. `stats` reports the grid size, voxel size, timings and how many critical cells were filled.

### quad

1. Cleanup.
2. QEM to twice the target face count, keeping feature edges.
3. Tangential relaxation, projected back onto the source.
4. Edge flips that improve valence.
5. Greedy pairing of triangles into quads by corner-angle quality.

`symmetry` clips the mesh to one half, locks the seam, remeshes and mirrors it back. Quads are written as two-triangle face records, so the wireframe preview shows quads. `stats` reports:

- `quads`
- `triangles_left`
- `quad_ratio`
- `feature_edges`
- the valence histogram

### cleanup

Welds vertices, removes degenerate and duplicate triangles, makes winding consistent per shell (outward), and fills holes of up to `holes` edges.

## decimate

```
art_model decimate {name, ratio? | triangles? | max_error? (m), feature_angle?: 45, seams?: true, out?}
```

This is a half-edge QEM collapse: vertices only ever move onto existing vertices, so triangle UVs stay pixel-exact.

- **Constraint edges** slide only along themselves. They are:
  - open borders
  - material borders
  - UV seams (unless `seams: false`)
  - feature and silhouette edges (dihedral angle ≥ `feature_angle`)
- **Corners** never move.
- **Attributes kept:** normals, vertex colours and skin (`g.skin = {j, w}`, the JOINTS/WEIGHTS layout of the skinning PR) are carried per corner.
- **Rejected collapses:** a link-condition check keeps the result manifold, and a flip check rejects collapses that fold triangles.

With `max_error`, every triangle carries sample points from the source. A collapse that would take any sample farther than the bound is rejected, with a 0.9 internal margin. The report gives `error_units`:

- `bound`
- `tracked`
- `hausdorff`: the measured symmetric distance, sampled
- `source_to_result`
- `result_to_source`

## cluster_lod

```
art_model cluster_lod {name, path?, cluster_size?: 128, group_size?: 4, levels?: 4, max_part_tris?: 20000,
                       lod_screen?: {height: 720, fov: 70, px: 1}, visibility?: true | {cells, ...}, distances?: [m, m, m], preview?}
```

This builds a Nanite-style cluster DAG (`src/clusterlod.js`):

1. **Clusters.** Leaf clusters of ≤ 128 triangles are grown greedily, seeded in Morton order. Each cluster gets a bounds sphere and a normal cone.
2. **Groups.** Groups of 4 adjacent clusters (sharing the most edges) are merged and simplified to half their triangles. The group's outer border is locked, and frozen context triangles stop collapses from folding into neighbouring groups.
3. **Re-split and repeat.** The simplified group is split back into ≤ 128-triangle clusters. Groups that cannot reduce retry with UV seams unlocked (`seam_free_groups`). This repeats until one root level remains.
4. **Error.** Group error is the maximum of its children's errors plus the simplification error, so error is monotonic up the DAG. Group lod sphere = the bounding sphere of its children's lod spheres.

### Files written (default `<name>_lod.*` in the export folder)

- **`<name>_lod.clod`:** the DAG sidecar (format below).
- **`<name>_lod.glb`:** discrete LODs cut from the DAG at uniform errors.
  - Node tree: `<name>_lods` > `<name>_LOD<i>` > `<name>_LOD<i>_p<k>`.
  - Each `_p<k>` part has ≤ `max_part_tris` triangles, so it fits one Roblox MeshPart.
  - `<name>_LOD<i>.extras`: `lod`, `distance`, `error` and `triangles`. Levels above 0 are hidden.
  - `asset.extras.cluster_lod` names the `.clod`.
- **`<name>_lod.meta.json`:** DAG stats, LOD levels and part sizes. With `visibility`, it also holds a summary of the visibility block.

In three.js, use `THREE.LOD` with `lod.addLevel(node, node.userData.distance)`, or stream the `.clod` with the selector. In Roblox, use one MeshPart per `_p<k>` node and swap LOD groups by distance.

### Runtime selector: `src/clodselect.js` (no dependencies, no DOM)

```js
import { parseClod, selectClusters, frustumPlanes } from './clodselect.js';
const h = parseClod(arrayBuffer);                     // typed-array views, no copies
const { clusters, triangles, stats } = selectClusters(h, {
  position: [x, y, z], fov: 70, height: canvasHeightPx,
  viewProj: camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements, // or planes
}, { pixelError: 1 });
// draw cluster i: indices h.indices[firstIndex .. firstIndex + 3*triangles] + firstVertex (clusterInfo(h, i))
```

**Selection.** Draw a cluster when `err(own) <= τ < err(parent)`, where:

```
err(e, sphere) = e · H / (2 · tan(fov / 2) · max(|c − cam| − r, near))
```

The own value uses the cluster's error and lod sphere; the parent value uses the parent error and parent lod sphere. Every cluster made from one group shares that group's values, and every cluster of a group shares the same parent values. So any camera gives a crack-free cut. The tests check that the cut is a closed manifold at five distances.

**Culling.** After selection, clusters are culled against:

- the frustum: the bounds sphere against 6 planes
- the back-face normal cone: culled when `dot(c − cam, axis) ≥ cutoff · |c − cam| + r · (1 + cutoff)`

`stats` reports `lod_rejected`, `frustum_culled`, `cone_culled` and `triangles`.

<a id="clod-format"></a>
### .clod format, version 1 (little endian)

The container has the same shape as GLB:

| offset | type | value |
|---|---|---|
| 0 | u32 | magic `0x444F4C43` ("CLOD") |
| 4 | u32 | version = 1 |
| 8 | u32 | total file length |
| 12 | u32 | JSON chunk length (padded to 4 with spaces) |
| 16 | u32 | `0x4E4F534A` ("JSON") |
| 20 | … | JSON (UTF-8) |
| 20+J | u32 | BIN chunk length |
| 24+J | u32 | `0x004E4942` ("BIN") |
| 28+J | … | BIN: views, each 4-byte aligned |

**JSON.** It contains:

- `format`, `version`
- `units`: glTF units, which is px / `px_per_unit`, +Y up
- `px_per_unit`
- `counts`: `{clusters, groups, vertices, indices, ranges, levels}`
- `cluster_size`, `group_size`
- `materials`: `[{index, name, key}]`, in glb material order
- `cluster_fields`: the table below
- `views`: `{name: {offset, byteLength, count, stride?, type}}`, with offsets relative to the BIN start
- `root_error`
- added by `art_model`: `screen`, `lods`, `glb`, and when visibility was requested, `visibility` (see below)

**Views:**

| view | element |
|---|---|
| `clusters` | 112-byte records, below |
| `positions` | f32 x 3 (units) |
| `normals` | f32 x 3 |
| `uvs` | f32 x 2 |
| `colors` (optional) | f32 x 4 |
| `indices` | u16, cluster-local: add the cluster's first vertex |
| `ranges` | 12-byte records: u32 material, u32 first triangle (relative to the cluster), u32 triangle count |

Vertices are unique per cluster, keyed by (position, uv, normal, colour). Triangles inside a cluster are sorted by material, so one cluster draws as `rangeCount` sub-ranges.

**Cluster record (112 bytes):**

| byte | type | field |
|---|---|---|
| 0 | f32 x 3 | bounds centre (culling sphere) |
| 12 | f32 | bounds radius |
| 16 | f32 x 3 | normal cone axis |
| 28 | f32 | normal cone cutoff = sin(half angle); ≥ 1 = never cone-culled |
| 32 | f32 x 3 | lod sphere centre (own) |
| 44 | f32 | lod sphere radius |
| 48 | f32 | error (units; 0 = full detail) |
| 52 | f32 | parent error (units; +Infinity = root) |
| 56 | f32 x 3 | parent lod sphere centre |
| 68 | f32 | parent lod sphere radius |
| 72 | u32 | first vertex |
| 76 | u32 | vertex count |
| 80 | u32 | first index |
| 84 | u32 | triangle count |
| 88 | u32 | first material range |
| 92 | u32 | material range count |
| 96 | u32 | level (0 = leaf) |
| 100 | u32 | group it was made from (0xFFFFFFFF = leaf) |
| 104 | u32 | parent group (0xFFFFFFFF = root) |
| 108 | u32 | flags: 1 root, 2 leaf |

## visibility

```
art_model visibility {name, path?, cells?: [{name, min: [x,y,z], max: [x,y,z]}] (m), step?: 0.25 (m), probe?: 0.4, depth?: 4,
                      pvs?: true, occluder?: {voxel?, resolution?: 48, max_boxes?: 32} | false}
```

**Cells** come from the first of these that is present:

1. `cells`
2. the model's `cull.rooms`
3. parts tagged `room: "<name>"`, using the union of their bounds

**Portals.** Each cell wall is sampled on a `step` grid. From each sample, a ray probe is cast through the wall's plane. Where the ray is free and the first other cell along it is a cell (or open space, which counts as `outside`), that sample is an opening. Openings are merged into one rectangle per (cell pair, wall). A doorway found from both sides becomes one portal spanning the wall thickness.

**PVS.** A breadth-first walk over portals, up to `depth` steps.

**Occluders.** Conservative boxes inside the surface: solid voxels, greedily merged into boxes, keeping the largest `max_boxes`. They are safe for occlusion queries.

The output is `<name>.vis.json`, with these fields:

- `cells`
- `portals`: `[{id, cells: [a, b], min, max, center, normal, samples}]`
- `pvs`: `{cell: [visible cells]}`
- `occluders`: `{boxes, voxel}`
- `stats`

`cluster_lod {visibility: ...}` puts the same block into the `.clod` JSON as `visibility`. It also adds `visibility.cluster_cell[i]`, the cell index of cluster i, or -1 when the cluster is outside every cell. At runtime, draw only the clusters of visible cells.

## Numbers

These are from `node docs/meshproc/build-demos.mjs` and the test suite: single-threaded, Node 26, on a desktop. The full output is in `demo-stats.json`.

**Union of all shells** (closed, 0 non-manifold edges and vertices in every case):

| input | output | time |
|---|---|---|
| 5,568 tris, 33 shells | 6,884 tris | 0.16 s |
| 138,720 tris | 123,154 tris | 2.6 s |
| 348,096 tris | 286,658 tris | 5.7 s |

**Two-solid booleans.** Sphere/box union, subtract and intersect give exactly the same volume as BSP and come out closed.

**Voxel remesh** of a pile of 60 intersecting greebles (2,340 tris). Both results are closed and manifold.

| resolution | output | time | Hausdorff, remesh to source |
|---|---|---|---|
| 32 | 1,990 tris | 0.34 s | 3.7 px (1 voxel) |
| 64 | 2,672 tris | 1.5 s | 1.7 px |

**Quad remesh:**

| input | quads | quad ratio | Hausdorff | time | closed |
|---|---|---|---|---|---|
| sphere, 2,208 tris | 527 | 0.78 | 1.98 px | 53 ms | yes |
| symmetric hull, 5,280 tris | 1,064 | 0.80 | – | 82 ms | yes |

**Decimation** of a 16,128-triangle sphere of radius 320 px. The bound is always respected by the measured Hausdorff distance.

| bound | output | measured Hausdorff | time |
|---|---|---|---|
| 0.5 px | 6,734 | 0.454 px | 0.33 s |
| 1 px | 3,320 | 0.948 px | 0.30 s |
| 4 px | 1,282 | 3.61 px | 0.37 s |

**Cluster LOD** of a 22,594-triangle unioned hull:

- 998 clusters on 14 levels
- 688 root triangles
- 65 groups simplified with seams unlocked
- built in 1.0 s
- `.clod` size: 2.7 MB

Cuts at 1080 px with 1 px error:

| distance | triangles in the cut | drawn after culling |
|---|---|---|
| 17 u | 7,728 | 6,689 |
| 85 u | 5,434 | 5,102 |
| 426 u | 3,766 | 3,628 |

From a close camera looking along the hull, frustum and cone culling remove 129 of 209 clusters, drawing 4,775 of 8,800 triangles.

## Limitations

- **`.clod` size.** Vertex attributes are f32, and vertices are duplicated per cluster and per normal at flat-shaded edges. A 22.6k-triangle hull is 2.7 MB, and a 48k-triangle one about 5.9 MB. Quantising to snorm16 or u16 would roughly halve that; the format version field leaves room for it.
- **Selection cost.** The selector is a flat per-cluster loop with no hierarchical culling of groups. It is fine for thousands of clusters per object; for very many objects, add a BVH over group spheres.
- **Booleans and open shells.** Open shells (no bottoms, cables) are passed through, not capped. Voxel remesh makes such soups watertight.
- **Voxel remesh detail.** Thin features below about one voxel are lost, and the attribute transfer uses the closest point, so UV seams on thin walls can pick the wrong side.
- **Quad remesh.** The result is quad-dominant (typically 70–80% quads), not pure quads, and there is no global field alignment.
- **Visibility.** Portals are axis-aligned rectangles per cell wall, and cells are boxes.
