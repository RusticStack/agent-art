// Sweeps: a cross-section (circle or custom 2D profile) swept along a 3D path (polyline,
// Catmull-Rom, cubic Bezier, or a hanging cable between two points). Pipes, cables, hoses,
// railings and conduits. Rotation-minimising frames (no twisting flips), mitred polyline corners,
// end caps, twist, taper and texture wrap (u around the section, v = world px along the length),
// or a trim-sheet strip across the section.
import { Mesh } from './model3d.js';
import { triangulate } from './poly2d.js';
import { trimStrips, normTrim } from './surface.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const v3 = (p, name) => {
  if (!Array.isArray(p) || p.length !== 3 || p.some((x) => !Number.isFinite(Number(x)))) throw new Error(`${name} must be [x,y,z] px (got ${JSON.stringify(p)})`);
  return p.map(Number);
};

/** Rotate v about unit axis k by angle (rad), Rodrigues. */
function rot(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/**
 * Path points of a sweep definition: path:[[x,y,z],..] with curve linear|catmull|bezier, or
 * from/to + sag (hanging cable: a catenary-like parabola dipping `sag` px at the middle).
 * -> {pts, sharp:[bool] (polyline corners to mitre), closed}
 */
export function sweepPath(a) {
  const closed = !!a.closed;
  if (a.from !== undefined || a.to !== undefined) {
    const A = v3(a.from, 'from'), B = v3(a.to, 'to');
    const sag = Number(a.sag ?? 0);
    if (!Number.isFinite(sag)) throw new Error('sag must be px');
    const n = Math.max(1, Math.min(256, Math.round(Number(a.segments ?? (sag ? 12 : 1)))));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = add(A, mul(sub(B, A), t));
      p[1] -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    return { pts, sharp: pts.map(() => false), closed: false };
  }
  // default: a 16 px upright run (like a cylinder)
  const P = a.path ?? [[0, 0, 0], [0, 16, 0]];
  if (!Array.isArray(P) || P.length < 2) throw new Error('sweep needs path:[[x,y,z], ...] (2+ points, px) or from:[x,y,z] + to:[x,y,z] (+ sag)');
  const pts0 = P.map((p, i) => v3(p, `path[${i}]`));
  const curve = a.curve ?? (a.smooth ? 'catmull' : 'linear');
  const seg = Math.max(1, Math.min(64, Math.round(Number(a.segments ?? 6))));
  if (curve === 'linear') return { pts: pts0, sharp: pts0.map((_, i) => closed || (i > 0 && i < pts0.length - 1)), closed };
  if (curve === 'catmull') {
    const n = pts0.length, out = [];
    const at = (i) => (closed ? pts0[((i % n) + n) % n] : pts0[Math.max(0, Math.min(n - 1, i))]);
    const spans = closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let k = 0; k < seg; k++) {
        const t = k / seg, t2 = t * t, t3 = t2 * t;
        out.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    if (!closed) out.push(pts0[n - 1]);
    return { pts: out, sharp: out.map(() => false), closed };
  }
  if (curve === 'bezier') {
    if ((pts0.length - 1) % 3) throw new Error('bezier path needs 3n+1 points: start, control, control, end, control, control, end, ...');
    const out = [];
    for (let i = 0; i + 3 < pts0.length; i += 3) {
      const [p0, p1, p2, p3] = pts0.slice(i, i + 4);
      for (let k = 0; k < seg; k++) {
        const t = k / seg, u = 1 - t;
        out.push([0, 1, 2].map((c) => u * u * u * p0[c] + 3 * u * u * t * p1[c] + 3 * u * t * t * p2[c] + t * t * t * p3[c]));
      }
    }
    out.push(pts0[pts0.length - 1]);
    return { pts: out, sharp: out.map(() => false), closed: false };
  }
  throw new Error(`curve must be linear, catmull or bezier (got ${JSON.stringify(curve)})`);
}

/** Cross-section: circle (sides) or a custom closed profile [[x,y],..] px (x = side, y = up). CCW. */
function section(a) {
  if (a.profile !== undefined) {
    if (!Array.isArray(a.profile) || a.profile.length < 3) throw new Error('profile must be [[x,y], ...] (3+ points, px; x = side, y = up of the section)');
    let pr = a.profile.map((p) => [Number(p[0]), Number(p[1])]);
    let ar = 0;
    for (let i = 0; i < pr.length; i++) { const p = pr[i], q = pr[(i + 1) % pr.length]; ar += p[0] * q[1] - q[0] * p[1]; }
    if (ar < 0) pr = pr.reverse();
    return { pts: pr, smooth: !!a.smooth_profile };
  }
  const r = Number(a.r ?? a.radius ?? 2);
  if (!(r > 0)) throw new Error('"r" (radius px) must be > 0');
  const n = Math.max(3, Math.min(64, Math.round(Number(a.sides ?? a.segments_around ?? 8))));
  const pts = [];
  // first vertex straight up (y), going CCW seen from the path start looking along it
  for (let j = 0; j < n; j++) { const t = (2 * Math.PI * j) / n; pts.push([-Math.sin(t) * r, Math.cos(t) * r]); }
  return { pts, smooth: a.flat !== true && n > 4, circle: true, r };
}

/** Sweep / tube builder. */
export function sweep(a, ctx) {
  const { pts, sharp, closed } = sweepPath(a);
  // drop repeated points
  const P = [], S = [];
  pts.forEach((p, i) => { if (!P.length || len(sub(p, P[P.length - 1])) > 1e-6) { P.push(p); S.push(sharp[i]); } });
  if (closed && P.length > 2 && len(sub(P[0], P[P.length - 1])) < 1e-6) { P.pop(); S.pop(); }
  if (P.length < 2) throw new Error('sweep path has fewer than 2 distinct points');
  const sec = section(a);
  const n = P.length, ns = sec.pts.length;
  const segT = (i) => norm(sub(P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)], P[closed ? i : Math.min(n - 2, i)]));
  // tangents: polyline corners use the bisector (mitre), smooth paths the central difference
  const T = P.map((_, i) => {
    if (!closed && i === 0) return segT(0);
    if (!closed && i === n - 1) return segT(n - 2);
    const tin = segT((i - 1 + n) % n), tout = segT(i);
    return norm(add(tin, tout));
  });
  // rotation-minimising frames (double reflection would be overkill for these spans: parallel transport)
  const up0 = a.up ? norm(v3(a.up, 'up')) : Math.abs(T[0][1]) > 0.95 ? [0, 0, -1] : [0, 1, 0];
  let N0 = norm(sub(up0, mul(T[0], dot(up0, T[0]))));
  const F = [{ N: N0, B: cross(T[0], N0) }];
  for (let i = 1; i < n; i++) {
    const t0 = T[i - 1], t1 = T[i], ax = cross(t0, t1), s = len(ax);
    let N = F[i - 1].N;
    if (s > 1e-9) N = rot(N, mul(ax, 1 / s), Math.atan2(s, dot(t0, t1)));
    N = norm(sub(N, mul(t1, dot(N, t1))));
    F.push({ N, B: cross(t1, N) });
  }
  // closed loops: spread the frame mismatch at the seam evenly as extra twist
  let seamTwist = 0;
  if (closed) {
    const t0 = T[n - 1], t1 = T[0], ax = cross(t0, t1), s = len(ax);
    let N = F[n - 1].N;
    if (s > 1e-9) N = rot(N, mul(ax, 1 / s), Math.atan2(s, dot(t0, t1)));
    seamTwist = Math.atan2(dot(cross(N, F[0].N), T[0]), dot(N, F[0].N));
  }
  // arc length
  const L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + len(sub(P[i], P[i - 1])));
  const total = closed ? L[n - 1] + len(sub(P[0], P[n - 1])) : L[n - 1];
  const twist = (Number(a.twist ?? 0) * Math.PI) / 180;
  const rEnd = a.r_end ?? a.radius_end;
  const taper = rEnd === undefined ? null : Number(rEnd) / Number(a.r ?? a.radius ?? 2);
  if (taper !== null && !(taper >= 0)) throw new Error('r_end must be >= 0');
  // ring of section vertices at path point i
  const ring = (i) => {
    const f = F[i], tp = T[i], u = total ? L[i] / total : 0;
    const ang = twist * u + seamTwist * u;
    const c = Math.cos(ang), s = Math.sin(ang);
    const N = add(mul(f.N, c), mul(f.B, s)), B = add(mul(f.B, c), mul(f.N, -s));
    const k = taper === null ? 1 : 1 + (taper - 1) * u;
    // mitre: stretch along the bend direction at polyline corners
    let mdir = null, mk = 1;
    if (S[i] && (closed || (i > 0 && i < n - 1))) {
      const tin = segT((i - 1 + n) % n), tout = segT(i), d = sub(tout, tin);
      if (len(d) > 1e-6) { mdir = norm(sub(d, mul(tp, dot(d, tp)))); mk = 1 / Math.max(0.25, dot(tp, tout)); }
    }
    return sec.pts.map(([x, y]) => {
      let o = add(mul(B, x * k), mul(N, y * k));
      if (mdir) o = add(o, mul(mdir, dot(o, mdir) * (mk - 1)));
      // section x = -B so the profile reads (side, up) looking along the path
      return { p: add(P[i], o), r: norm(o) };
    });
  };
  const rings = P.map((_, i) => ring(i));
  // texture: plain wrap (u around, v world px along) or a trim strip across the section
  const trim = normTrim(a.trim);
  let tex, uvAt;
  const perim = [];
  { let acc = 0; for (let j = 0; j <= ns; j++) { perim.push(acc); const p = sec.pts[j % ns], q = sec.pts[(j + 1) % ns]; acc += Math.hypot(q[0] - p[0], q[1] - p[1]); } }
  const circ = perim[ns];
  if (trim) {
    tex = ctx.tex(trim.sheet);
    const strips = trimStrips({ trim: tex.trim }, tex.width, tex.height, trim.sheet);
    const st = strips[trim.strip];
    if (!st) throw new Error(`trim sheet "${trim.sheet}" has no strip "${trim.strip}" (strips: ${Object.keys(strips).join(', ')})`);
    const e = 0.02;
    uvAt = (j, l) => { const f = perim[j] / circ; const v = trim.flip ? 1 - f : f; return [l / (tex.width * trim.scale), (st[0] + e + v * (st[1] - 2 * e)) / tex.height]; };
  } else {
    tex = ctx.tex(a.texture ?? a.side ?? a.color ?? '#6a6e78');
    const wrap = Number(a.wrap ?? Math.max(1, Math.round(circ / tex.width)));
    uvAt = (j, l) => [(wrap * perim[j]) / circ, l / tex.height];
  }
  const m = new Mesh();
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const i1 = (i + 1) % n, A = rings[i], B = rings[i1];
    const la = L[i], lb = closed && i1 === 0 ? total : L[i1];
    for (let j = 0; j < ns; j++) {
      const j1 = (j + 1) % ns;
      const Q = [A[j].p, A[j1].p, B[j1].p, B[j].p];
      let Nv;
      const fn = norm(cross(sub(Q[1], Q[0]), sub(Q[3], Q[0])));
      // outward = away from the path
      const mid = mul(add(add(Q[0], Q[1]), add(Q[2], Q[3])), 0.25), axis = mul(add(P[i], P[i1]), 0.5);
      const out = norm(sub(mid, axis));
      const nominal = dot(fn, out) >= 0 ? fn : mul(fn, -1);
      if (sec.smooth) Nv = [A[j].r, A[j1].r, B[j1].r, B[j].r];
      else Nv = nominal;
      const UV = [uvAt(j, la), uvAt(j + 1, la), uvAt(j + 1, lb), uvAt(j, lb)];
      const f = m.face(tex, Q, Nv, UV, nominal, 0);
      if (trim) f.trimmed = true;
    }
  }
  // caps
  const caps = a.caps ?? !closed;
  if (!closed && caps) {
    const which = caps === 'start' ? [0] : caps === 'end' ? [n - 1] : [0, n - 1];
    const capT = a.cap ? ctx.tex(a.cap) : trim ? tex : tex;
    const tris = triangulate(sec.pts);
    for (const i of which) {
      const R = rings[i].map((v) => v.p), nn = i === 0 ? mul(T[0], -1) : T[n - 1];
      const UV = capT === tex && trim ? R.map(() => uvAt(0, 0)) : sec.pts.map(([x, y]) => [x / capT.width + 0.5, -y / capT.height + 0.5]);
      m.polygon(capT, R, nn, UV, tris, 0);
    }
  }
  return m;
}
