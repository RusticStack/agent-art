// MikkTSpace-compatible vertex tangents for glTF TANGENT (vec4, w = handedness). Per triangle
// T = dP/du; the glTF bitangent is cross(N, T.xyz) * w and points to image up (-dP/dv: glTF UVs
// have v down the image, normal maps are green-up). Corners are weighted by their angle (like
// MikkTSpace), tangents are Gram-Schmidt orthogonalised against the vertex normal, and a vertex
// shared by triangles of opposite handedness (a mirrored UV island meeting the original) is split
// so each side keeps its own sign, as MikkTSpace does.
//
// three.js: with a TANGENT attribute GLTFLoader keeps normalScale (1, 1) and the shader builds
// tbn = (vTangent, cross(vNormal, vTangent) * tangent.w, vNormal); without it, it uses screen
// derivatives (B = dP/dv) and flips normalScale.y. Both give the same normal for these tangents
// (test/materials.test.js checks it on a quad and a rotated UV island).

const EPS = 1e-12;

/** Unit vector perpendicular to n (stable). */
function perp(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
  const t = [a[0] - n[0] * d, a[1] - n[1] * d, a[2] - n[2] * d], l = Math.hypot(t[0], t[1], t[2]) || 1;
  return [t[0] / l, t[1] / l, t[2] / l];
}

/**
 * Tangents for an indexed triangle list. prim: {pos: Float32Array (xyz), nrm, uv, idx, ...}.
 * extra: names of other per-vertex arrays on prim to duplicate when a vertex splits, with their
 * component counts ({uv1: 2, ao: 1, ...}; morph targets: prim.morphs[k].pos / .nrm are handled).
 * -> {tangent: Float32Array (xyzw per vertex), prim (the same object, or a copy with split
 * vertices), split: number of vertices split}.
 */
export function computeTangents(prim, extra = {}) {
  const { pos, nrm, uv, idx } = prim;
  const vc = pos.length / 3, tc = idx.length / 3;
  // per triangle: tangent (dP/du), handedness, corner angles
  const triT = new Float64Array(tc * 3), triS = new Int8Array(tc);
  for (let t = 0; t < tc; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const e1 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
    const e2 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1], du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const r = du1 * dv2 - du2 * dv1;
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.abs(r) < EPS) {
      // no UV area: any tangent in the face plane, right-handed
      const l = Math.hypot(...fn) || 1, p = perp([fn[0] / l, fn[1] / l, fn[2] / l]);
      triT.set(p, t * 3); triS[t] = 1;
      continue;
    }
    const T = [(e1[0] * dv2 - e2[0] * dv1) / r, (e1[1] * dv2 - e2[1] * dv1) / r, (e1[2] * dv2 - e2[2] * dv1) / r];
    const Bv = [(e2[0] * du1 - e1[0] * du2) / r, (e2[1] * du1 - e1[1] * du2) / r, (e2[2] * du1 - e1[2] * du2) / r]; // dP/dv
    // glTF bitangent = image up = -dP/dv; w = sign(dot(cross(N, T), -dP/dv)) with the face normal
    const c3 = [fn[1] * T[2] - fn[2] * T[1], fn[2] * T[0] - fn[0] * T[2], fn[0] * T[1] - fn[1] * T[0]];
    triS[t] = -(c3[0] * Bv[0] + c3[1] * Bv[1] + c3[2] * Bv[2]) < 0 ? -1 : 1;
    const l = Math.hypot(T[0], T[1], T[2]) || 1;
    triT.set([T[0] / l, T[1] / l, T[2] / l], t * 3);
  }
  // corners per vertex, split by handedness
  const sideOf = new Int32Array(vc * 2).fill(-1); // [vertex*2 + (sign<0)] -> output vertex
  const outOf = []; // output vertex -> source vertex
  const newIdx = new Uint32Array(idx.length);
  let split = 0;
  // the first side of each vertex keeps the vertex index; the other side is appended
  for (let v = 0; v < vc; v++) outOf.push(v);
  for (let k = 0; k < idx.length; k++) {
    const v = idx[k], s = triS[(k / 3) | 0] < 0 ? 1 : 0;
    if (sideOf[v * 2 + s] >= 0) { newIdx[k] = sideOf[v * 2 + s]; continue; }
    if (sideOf[v * 2 + (1 - s)] < 0) { sideOf[v * 2 + s] = v; newIdx[k] = v; continue; }
    const o = outOf.length;
    outOf.push(v);
    sideOf[v * 2 + s] = o; newIdx[k] = o; split++;
  }
  const n = outOf.length;
  const acc = new Float64Array(n * 3), sign = new Int8Array(n).fill(1);
  for (let k = 0; k < newIdx.length; k++) {
    const t = (k / 3) | 0, o = newIdx[k], src = idx[k];
    const c0 = k - (k % 3), i0 = idx[c0 + ((k % 3) + 1) % 3], i1 = idx[c0 + ((k % 3) + 2) % 3];
    const a = [pos[i0 * 3] - pos[src * 3], pos[i0 * 3 + 1] - pos[src * 3 + 1], pos[i0 * 3 + 2] - pos[src * 3 + 2]];
    const b = [pos[i1 * 3] - pos[src * 3], pos[i1 * 3 + 1] - pos[src * 3 + 1], pos[i1 * 3 + 2] - pos[src * 3 + 2]];
    const la = Math.hypot(...a), lb = Math.hypot(...b);
    const ang = la > EPS && lb > EPS ? Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)))) : 0;
    for (let q = 0; q < 3; q++) acc[o * 3 + q] += triT[t * 3 + q] * ang;
    sign[o] = triS[t];
  }
  const tangent = new Float32Array(n * 4);
  for (let o = 0; o < n; o++) {
    const s = outOf[o], N = [nrm[s * 3], nrm[s * 3 + 1], nrm[s * 3 + 2]];
    let T = [acc[o * 3], acc[o * 3 + 1], acc[o * 3 + 2]];
    const d = T[0] * N[0] + T[1] * N[1] + T[2] * N[2];
    T = [T[0] - N[0] * d, T[1] - N[1] * d, T[2] - N[2] * d];
    let l = Math.hypot(T[0], T[1], T[2]);
    if (l < 1e-9) { T = perp(N); l = 1; }
    tangent.set([T[0] / l, T[1] / l, T[2] / l, sign[o]], o * 4);
  }
  if (!split) return { tangent, prim, split: 0 };
  // copy the prim with the split vertices appended
  const dup = (arr, size) => {
    const out = new arr.constructor(n * size);
    out.set(arr);
    for (let o = vc; o < n; o++) for (let q = 0; q < size; q++) out[o * size + q] = arr[outOf[o] * size + q];
    return out;
  };
  const out = { ...prim, pos: dup(pos, 3), nrm: dup(nrm, 3), uv: dup(uv, 2), idx: newIdx };
  for (const [k, size] of Object.entries(extra)) if (prim[k]) out[k] = dup(prim[k], size);
  if (prim.vattr) out.vattr = Object.fromEntries(Object.entries(prim.vattr).map(([k, a]) => [k, { size: a.size, data: dup(a.data, a.size) }]));
  if (prim.morphs) out.morphs = prim.morphs.map((m) => ({ name: m.name, pos: dup(m.pos, 3), nrm: dup(m.nrm, 3) }));
  // skinned vertices: JOINTS_0 / WEIGHTS_0 must stay as long as POSITION (4 per vertex)
  if (prim.skin) out.skin = { j: dup(prim.skin.j, 4), w: dup(prim.skin.w, 4) };
  return { tangent, prim: out, split };
}

/**
 * Perturbed normal the way three.js shades a glTF normal map (texel n = [x, y, z] in -1..1).
 * With tangents: tbn = (T, cross(N, T) * w, N), normalScale (1, 1). Without: the derivative frame
 * (perturbNormal2Arb: T ~ dP/du, B ~ dP/dv) with GLTFLoader's normalScale.y = -1.
 */
export function threeNormal(n, N, tangent) {
  const [tx, ty, tz, w] = tangent;
  const B = [(N[1] * tz - N[2] * ty) * w, (N[2] * tx - N[0] * tz) * w, (N[0] * ty - N[1] * tx) * w];
  const r = [tx * n[0] + B[0] * n[1] + N[0] * n[2], ty * n[0] + B[1] * n[1] + N[1] * n[2], tz * n[0] + B[2] * n[1] + N[2] * n[2]];
  const l = Math.hypot(...r) || 1;
  return r.map((v) => v / l);
}
/** three.js getTangentFrame (screen derivatives) for one triangle, then normalScale (1, -1). */
export function threeDerivativeNormal(n, N, tri) {
  // q0 / q1 = position derivatives, st0 / st1 = uv derivatives along two screen axes; any two
  // independent directions in the triangle give the same frame up to scale
  const { p, uv } = tri;
  const q0 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], q1 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const st0 = [uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]], st1 = [uv[2][0] - uv[0][0], uv[2][1] - uv[0][1]];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q1perp = cr(q1, N), q0perp = cr(N, q0);
  const T = [0, 1, 2].map((k) => q1perp[k] * st0[0] + q0perp[k] * st1[0]);
  const B = [0, 1, 2].map((k) => q1perp[k] * st0[1] + q0perp[k] * st1[1]);
  const det = Math.max(T[0] ** 2 + T[1] ** 2 + T[2] ** 2, B[0] ** 2 + B[1] ** 2 + B[2] ** 2), s = det ? 1 / Math.sqrt(det) : 0;
  const m = [n[0], -n[1], n[2]];
  const r = [0, 1, 2].map((k) => T[k] * s * m[0] + B[k] * s * m[1] + N[k] * m[2]);
  const l = Math.hypot(...r) || 1;
  return r.map((v) => v / l);
}
