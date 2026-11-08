// True displacement for art_model parts (terrain, hull panels): faces of a part with displace are
// adaptively subdivided where their height map (the texture's "height" layer / <canvas>_h) is not
// flat, under a triangle budget, then their vertices move along the face normal by
// height * scale + bias px. Subdivision = longest-edge bisection driven by a max-error queue:
// a triangle's error is the largest gap between the height at its texel centres (NEAREST, so pixel
// plateaus stay crisp) and the plane through its corners. Splitting an edge splits every triangle
// on it (no T-junctions, no cracks). Region borders (edges used once among the displaced faces of
// one orientation) stay put by default (seams:"lock"), so a displaced box face still meets its
// side faces and terrain chunks still tile; seams:"open" moves them too.
const qk = (v) => Math.round(v * 1e4);
const pkey = (p) => `${qk(p[0])},${qk(p[1])},${qk(p[2])}`;
const nkey = (n) => n.map((v) => Math.round(v * 1000)).join(',');

/** displace: true | number (scale px) | {scale:2, bias:0, max_triangles:2000, tolerance:0.25, min_texels:1, seams:"lock"|"open"}. */
export function normDisplace(v) {
  if (v === undefined || v === null || v === false) return null;
  const o = v === true ? {} : typeof v === 'number' ? { scale: v } : v;
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('displace must be true, a scale in px, or {scale?:2, bias?:0, max_triangles?:2000, tolerance?:0.25, min_texels?:1, seams?:"lock"|"open"}');
  for (const k of Object.keys(o)) if (!['scale', 'bias', 'max_triangles', 'tolerance', 'min_texels', 'seams'].includes(k)) throw new Error(`displace.${k} is not a field (scale, bias, max_triangles, tolerance, min_texels, seams)`);
  const r = { scale: Number(o.scale ?? 2), bias: Number(o.bias ?? 0), max: Math.round(Number(o.max_triangles ?? 2000)), tol: Number(o.tolerance ?? 0.25), minTexels: Number(o.min_texels ?? 1), seams: o.seams ?? 'lock' };
  if (!(Number.isFinite(r.scale) && Math.abs(r.scale) <= 256) || !Number.isFinite(r.bias)) throw new Error('displace scale must be -256..256 px, bias a number of px');
  if (!(r.max >= 2 && r.max <= 200000)) throw new Error('displace.max_triangles must be 2..200000');
  if (!(r.tol > 0) || !(r.minTexels > 0)) throw new Error('displace tolerance and min_texels must be > 0');
  if (!['lock', 'open'].includes(r.seams)) throw new Error('displace.seams must be "lock" (region borders stay put: watertight) or "open"');
  return r;
}

/** Binary max-heap on [error, id]. */
class Heap {
  constructor() { this.a = []; }
  push(e, id) { const a = this.a; a.push([e, id]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] > a[i][0] || (a[p][0] === a[i][0] && a[p][1] < a[i][1])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; const gt = (x, y) => a[x][0] > a[y][0] || (a[x][0] === a[y][0] && a[x][1] < a[y][1]); if (l < a.length && gt(l, m)) m = l; if (r < a.length && gt(r, m)) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

/**
 * Displace the faces tagged f.disp = {spec, part} of every base group of mesh (px, world UVs).
 * -> {parts: {part: {before, after, max_error_px}}}
 */
export function displaceMesh(mesh) {
  const stats = {};
  const heights = new Map();
  const heightOf = (t) => { if (!heights.has(t)) heights.set(t, t.heightOf ? t.heightOf() : null); return heights.get(t); };
  for (const g of mesh.groups.values()) {
    if (g.overlay || !g.faces || !g.faces.some((f) => f.disp)) continue;
    const t = g.tex, H = heightOf(t);
    if (!H) throw new Error(`displace: texture ${t.name} has no height source (a "height" layer or a <canvas>_h canvas)`);
    const TW = t.width, TH = t.height;
    const hAt = (u, v) => { let x = Math.floor(u * TW) % TW, y = Math.floor(v * TH) % TH; if (x < 0) x += TW; if (y < 0) y += TH; return H[y * TW + x]; };
    // working set: vertices (per face) and triangles
    const V = []; // {p, uv, f}
    const T = []; // {v:[a,b,c], f, live}
    const faceVerts = new Map();
    const dispFaces = g.faces.filter((f) => f.disp);
    for (const f of dispFaces) {
      const base = V.length;
      for (let v = f.v; v < f.v + f.vc; v++) V.push({ p: [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], uv: [g.uv[v * 2], g.uv[v * 2 + 1]], f });
      faceVerts.set(f, base);
      for (let i = f.i; i < f.i + f.ic; i += 3) T.push({ v: [g.idx[i] - f.v + base, g.idx[i + 1] - f.v + base, g.idx[i + 2] - f.v + base], f, live: true });
    }
    // edges by position (across faces of the same orientation) -> triangles
    const ekey = (a, b, f) => { const ka = pkey(V[a].p), kb = pkey(V[b].p); return `${nkey(f.n)}|${ka < kb ? ka + '|' + kb : kb + '|' + ka}`; };
    const edgeTris = new Map();
    const addTri = (ti) => { const tr = T[ti]; for (let k = 0; k < 3; k++) { const e = ekey(tr.v[k], tr.v[(k + 1) % 3], tr.f); if (!edgeTris.has(e)) edgeTris.set(e, new Set()); edgeTris.get(e).add(ti); } };
    T.forEach((_, i) => addTri(i));
    const boundary = new Set();
    for (const [e, s] of edgeTris) if (s.size === 1) boundary.add(e);
    const locked = new Set(); // vertex position keys (+ orientation) that stay put
    const lockKey = (vi) => `${nkey(V[vi].f.n)}|${pkey(V[vi].p)}`;
    for (const tr of T) for (let k = 0; k < 3; k++) { const a = tr.v[k], b = tr.v[(k + 1) % 3]; if (boundary.has(ekey(a, b, tr.f))) { locked.add(lockKey(a)); locked.add(lockKey(b)); } }
    // per part budgets
    const budget = new Map();
    for (const f of dispFaces) { const k = f.disp.part; if (!budget.has(k)) budget.set(k, { spec: f.disp.spec, tris: 0, before: 0, err: 0 }); }
    for (const tr of T) { const b = budget.get(tr.f.disp.part); b.tris++; b.before++; }
    const texLen = (a, b) => Math.hypot((V[a].uv[0] - V[b].uv[0]) * TW, (V[a].uv[1] - V[b].uv[1]) * TH);
    /** max |height - plane| (px) over the texel centres inside the triangle's UV footprint */
    const triError = (tr) => {
      const [a, b, c] = tr.v.map((i) => V[i].uv);
      const ha = hAt(...a), hb = hAt(...b), hc = hAt(...c);
      const x0 = Math.floor(Math.min(a[0], b[0], c[0]) * TW), x1 = Math.ceil(Math.max(a[0], b[0], c[0]) * TW);
      const y0 = Math.floor(Math.min(a[1], b[1], c[1]) * TH), y1 = Math.ceil(Math.max(a[1], b[1], c[1]) * TH);
      const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(den) < 1e-14) return 0;
      let e = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const u = (x + 0.5) / TW, v = (y + 0.5) / TH;
        const l0 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / den, l1 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / den, l2 = 1 - l0 - l1;
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
        e = Math.max(e, Math.abs(hAt(u, v) - (l0 * ha + l1 * hb + l2 * hc)));
      }
      return e * Math.abs(tr.f.disp.spec.scale);
    };
    const heap = new Heap();
    T.forEach((tr, i) => heap.push(triError(tr), i));
    const mid = new Map(); // face + edge key -> vertex
    const midOf = (a, b, f, e) => {
      const k = `${faceVerts.get(f)}|${e}`;
      if (mid.has(k)) return mid.get(k);
      const m = V.length;
      V.push({ p: V[a].p.map((x, q) => (x + V[b].p[q]) / 2), uv: [(V[a].uv[0] + V[b].uv[0]) / 2, (V[a].uv[1] + V[b].uv[1]) / 2], f });
      if (boundary.has(e)) locked.add(lockKey(m));
      mid.set(k, m);
      return m;
    };
    while (heap.size) {
      const [err, ti] = heap.pop();
      const tr = T[ti];
      if (!tr.live) continue;
      const b = budget.get(tr.f.disp.part), sp = b.spec;
      if (err <= sp.tol) { b.err = Math.max(b.err, err); continue; }
      // longest edge in texels
      let k = 0, best = -1;
      for (let q = 0; q < 3; q++) { const L = texLen(tr.v[q], tr.v[(q + 1) % 3]); if (L > best) { best = L; k = q; } }
      if (best < sp.minTexels * 2) { b.err = Math.max(b.err, err); continue; }
      const a = tr.v[k], c = tr.v[(k + 1) % 3], e = ekey(a, c, tr.f);
      const tris = [...edgeTris.get(e)].filter((i) => T[i].live);
      // budget: each split triangle becomes two
      const adds = new Map();
      for (const i of tris) { const k = T[i].f.disp.part; adds.set(k, (adds.get(k) || 0) + 1); }
      if ([...adds].some(([k, n]) => { const bb = budget.get(k); return bb.tris + n > bb.spec.max; })) { b.err = Math.max(b.err, err); continue; }
      const wasB = boundary.has(e);
      edgeTris.delete(e);
      boundary.delete(e);
      for (const i of tris) {
        const o = T[i];
        o.live = false;
        for (let q = 0; q < 3; q++) { const s = edgeTris.get(ekey(o.v[q], o.v[(q + 1) % 3], o.f)); if (s) s.delete(i); }
        // the split edge in this triangle's winding
        let j = 0;
        for (let q = 0; q < 3; q++) if (ekey(o.v[q], o.v[(q + 1) % 3], o.f) === e) j = q;
        const A = o.v[j], B = o.v[(j + 1) % 3], C = o.v[(j + 2) % 3], M = midOf(A, B, o.f, e);
        for (const nv of [[A, M, C], [M, B, C]]) {
          T.push({ v: nv, f: o.f, live: true });
          const ni = T.length - 1;
          addTri(ni);
          heap.push(triError(T[ni]), ni);
        }
        budget.get(o.f.disp.part).tris++;
        if (wasB) { boundary.add(ekey(A, M, o.f)); boundary.add(ekey(M, B, o.f)); }
      }
    }
    // displace + smooth normals per orientation region
    const P = V.map((vx, i) => {
      const sp = vx.f.disp.spec;
      if (sp.seams === 'lock' && locked.has(lockKey(i))) return vx.p.slice();
      const d = hAt(vx.uv[0], vx.uv[1]) * sp.scale + sp.bias, n = vx.f.n;
      return [vx.p[0] + n[0] * d, vx.p[1] + n[1] * d, vx.p[2] + n[2] * d];
    });
    const nacc = new Map();
    for (const tr of T) {
      if (!tr.live) continue;
      const [a, b, c] = tr.v.map((i) => P[i]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (n[0] * tr.f.n[0] + n[1] * tr.f.n[1] + n[2] * tr.f.n[2] < 0) n = n.map((x) => -x);
      for (const i of tr.v) { const k = lockKey(i); const s = nacc.get(k) || [0, 0, 0]; nacc.set(k, [s[0] + n[0], s[1] + n[1], s[2] + n[2]]); }
    }
    // rebuild the group: displaced faces get their new vertices / triangles, others are copied
    const pos = [], nrm = [], uv = [], idx = [], faces = [];
    const byFace = new Map();
    for (const tr of T) if (tr.live) { if (!byFace.has(tr.f)) byFace.set(tr.f, []); byFace.get(tr.f).push(tr.v); }
    for (const f of g.faces) {
      const base = pos.length / 3, i0 = idx.length;
      if (!f.disp) {
        for (let v = f.v; v < f.v + f.vc; v++) { pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); }
        for (let i = f.i; i < f.i + f.ic; i++) idx.push(g.idx[i] - f.v + base);
        faces.push({ ...f, v: base, i: i0 });
        continue;
      }
      const remap = new Map();
      for (const tri of byFace.get(f) || []) for (const vi of tri) {
        if (!remap.has(vi)) {
          remap.set(vi, pos.length / 3);
          const n = nacc.get(lockKey(vi)) || f.n, l = Math.hypot(...n) || 1;
          pos.push(...P[vi]); nrm.push(n[0] / l, n[1] / l, n[2] / l); uv.push(...V[vi].uv);
        }
        idx.push(remap.get(vi));
      }
      const { disp, ...rest } = f;
      faces.push({ ...rest, v: base, vc: remap.size, i: i0, ic: idx.length - i0, displaced: true });
    }
    Object.assign(g, { pos, nrm, uv, idx, faces });
    for (const [part, b] of budget) {
      const s = stats[part] || (stats[part] = { before: 0, after: 0, max_error_px: 0 });
      s.before += b.before; s.after += b.tris; s.max_error_px = +Math.max(s.max_error_px, b.err).toFixed(3);
    }
  }
  return { parts: stats };
}
