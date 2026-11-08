// Runtime side of the cluster LOD sidecar (.clod, written by art_model cluster_lod): a parser and a
// pure per-frame selector (camera + hierarchy -> visible cluster list). No dependencies, no DOM:
// import it in the game (Three.js) as is. Format: docs/meshproc/README.md#clod-format.

export const CLOD_MAGIC = 0x444f4c43; // "CLOD"
export const CLUSTER_STRIDE = 112; // bytes per cluster record
export const RANGE_STRIDE = 12; // bytes per material range record
export const NONE = 0xffffffff;

/**
 * Parse a .clod ArrayBuffer (or Node Buffer / Uint8Array). -> {json, count, f32, u32, positions,
 * normals, uvs, colors?, indices, ranges} (typed array views over the file, no copies).
 */
export function parseClod(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== CLOD_MAGIC) throw new Error('not a .clod file (magic)');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`unsupported .clod version ${version}`);
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
  const binOff = 20 + jlen + 8;
  const view = (v, T, comps = 1) => (v ? new T(buf, binOff + v.offset, (v.count ?? v.length) * comps) : null);
  const cl = json.views.clusters;
  return {
    json, count: json.counts.clusters,
    f32: new Float32Array(buf, binOff + cl.offset, (json.counts.clusters * CLUSTER_STRIDE) / 4),
    u32: new Uint32Array(buf, binOff + cl.offset, (json.counts.clusters * CLUSTER_STRIDE) / 4),
    positions: view(json.views.positions, Float32Array, 3), normals: view(json.views.normals, Float32Array, 3), uvs: view(json.views.uvs, Float32Array, 2),
    colors: view(json.views.colors, Float32Array, 4), indices: view(json.views.indices, Uint16Array),
    ranges: new Uint32Array(buf, binOff + json.views.ranges.offset, json.views.ranges.count * 3),
  };
}

/** Cluster i as a plain object (fields of the 112-byte record). */
export function clusterInfo(h, i) {
  const f = h.f32, u = h.u32, o = (i * CLUSTER_STRIDE) / 4;
  return {
    center: [f[o], f[o + 1], f[o + 2]], radius: f[o + 3], cone: { axis: [f[o + 4], f[o + 5], f[o + 6]], cutoff: f[o + 7] },
    lod: { center: [f[o + 8], f[o + 9], f[o + 10]], radius: f[o + 11] }, error: f[o + 12], parentError: f[o + 13],
    parentLod: { center: [f[o + 14], f[o + 15], f[o + 16]], radius: f[o + 17] },
    firstVertex: u[o + 18], vertexCount: u[o + 19], firstIndex: u[o + 20], triangles: u[o + 21], firstRange: u[o + 22], rangeCount: u[o + 23],
    level: u[o + 24], group: u[o + 25], parentGroup: u[o + 26], flags: u[o + 27],
  };
}

/** Triangles of cluster i as [[x,y,z] x 3] (units). */
export function clusterTriangles(h, i) {
  const c = clusterInfo(h, i), out = [];
  for (let t = 0; t < c.triangles; t++) {
    const tri = [];
    for (let k = 0; k < 3; k++) { const v = c.firstVertex + h.indices[c.firstIndex + t * 3 + k]; tri.push([h.positions[v * 3], h.positions[v * 3 + 1], h.positions[v * 3 + 2]]); }
    out.push(tri);
  }
  return out;
}

/**
 * Projected error in pixels of an error (units) bounded by a sphere, seen from cam.
 * err_px = error * height / (2 tan(fov/2) * max(d - r, near)), d = |center - camera|.
 */
export function projectedError(error, cx, cy, cz, r, cam) {
  if (error === Infinity) return Infinity;
  const p = cam.position, dx = cx - p[0], dy = cy - p[1], dz = cz - p[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
  const k = cam.height / (2 * Math.tan(((cam.fov ?? 60) * Math.PI) / 360));
  return (error * k) / Math.max(d, cam.near ?? 1e-4);
}

/**
 * Frustum planes from a column-major 4x4 view-projection matrix (Three.js camera.projectionMatrix
 * x matrixWorldInverse). -> [[nx, ny, nz, d] x 6], inside when n.p + d >= 0.
 */
export function frustumPlanes(m) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const pl = [r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]), r3.map((v, i) => v + r2[i]), r3.map((v, i) => v - r2[i])];
  return pl.map((p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return p.map((v) => v / l); });
}

/**
 * Select the clusters to draw this frame. A cluster is drawn when its own error is small enough
 * on screen and its parent's is not: projectedError(error, lod sphere) <= pixelError <
 * projectedError(parentError, parent lod sphere). Every cluster of a group shares the parent
 * values and every cluster made from a group shares that group's own values, so a cut is always
 * crack-free. Then per-cluster culling: frustum (bounds sphere vs planes) and back-facing normal
 * cone: culled when dot(c - cam, axis) >= cutoff * |c - cam| + radius * (1 + cutoff).
 * cam: {position:[x,y,z], fov (deg, vertical), height (px), near?, planes? | viewProj?}.
 * opts: {pixelError = 1, frustum = true, cone = true}. -> {clusters: [i], triangles, stats}
 */
export function selectClusters(h, cam, opts = {}) {
  const tau = opts.pixelError ?? 1;
  const planes = opts.frustum === false ? null : cam.planes || (cam.viewProj ? frustumPlanes(cam.viewProj) : null);
  const useCone = opts.cone !== false;
  const f = h.f32, u = h.u32, p = cam.position;
  const out = [];
  let tris = 0, lodRejected = 0, frustumCulled = 0, coneCulled = 0;
  for (let i = 0; i < h.count; i++) {
    const o = (i * CLUSTER_STRIDE) / 4;
    const own = projectedError(f[o + 12], f[o + 8], f[o + 9], f[o + 10], f[o + 11], cam);
    if (own > tau) { lodRejected++; continue; }
    const par = projectedError(f[o + 13], f[o + 14], f[o + 15], f[o + 16], f[o + 17], cam);
    if (!(par > tau)) { lodRejected++; continue; }
    const cx = f[o], cy = f[o + 1], cz = f[o + 2], r = f[o + 3];
    if (planes) {
      let outF = false;
      for (const pl of planes) if (pl[0] * cx + pl[1] * cy + pl[2] * cz + pl[3] < -r) { outF = true; break; }
      if (outF) { frustumCulled++; continue; }
    }
    if (useCone) {
      const cut = f[o + 7];
      if (cut < 1) {
        const dx = cx - p[0], dy = cy - p[1], dz = cz - p[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dx * f[o + 4] + dy * f[o + 5] + dz * f[o + 6] >= cut * d + r * (1 + cut)) { coneCulled++; continue; }
      }
    }
    out.push(i);
    tris += u[o + 21];
  }
  return { clusters: out, triangles: tris, stats: { clusters: h.count, selected: out.length, lod_rejected: lodRejected, frustum_culled: frustumCulled, cone_culled: coneCulled, triangles: tris } };
}

/**
 * Frustum planes of a look-at perspective camera (no matrix library needed): {position, target,
 * up = [0,1,0], fov (deg, vertical), aspect, near, far}. -> [[nx, ny, nz, d] x 6]
 */
export function lookAtPlanes({ position, target, up = [0, 1, 0], fov = 60, aspect = 16 / 9, near = 0.1, far = 1e5 }) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nz = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = nz(sub(target, position)), r = nz(cr(f, up)), u = cr(r, f);
  const th = Math.tan((fov * Math.PI) / 360), tw = th * aspect;
  const plane = (n) => { const m = nz(n); return [m[0], m[1], m[2], -dt(m, position)]; };
  const dir = (a, k) => [f[0] + a[0] * k, f[1] + a[1] * k, f[2] + a[2] * k];
  const planes = [plane(cr(dir(r, -tw), u)), plane(cr(u, dir(r, tw))), plane(cr(r, dir(u, -th))), plane(cr(dir(u, th), r))]; // left, right, bottom, top (normals inward)
  planes.push([f[0], f[1], f[2], -dt(f, position) - near]);
  planes.push([-f[0], -f[1], -f[2], dt(f, position) + far]);
  return planes;
}
