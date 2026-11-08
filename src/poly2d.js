// 2D polygon tools for smooth (non-voxel) geometry: marching-squares contours of a signed field,
// Douglas-Peucker simplification, outer/hole nesting, hole bridging and ear-clipping triangulation.

export const area2 = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const cr2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Point inside triangle; closed = a point on an edge counts (blocks ears whose diagonal touches another vertex). */
function inTri(p, a, b, c, closed) {
  const e = closed ? -1e-9 : 1e-9;
  return cr2(a, b, p) > e && cr2(b, c, p) > e && cr2(c, a, p) > e;
}
/** Ear clipping for a simple CCW polygon (bridged holes allowed: duplicate points) -> [[i,j,k]]. */
export function triangulate(pts) {
  const idx = pts.map((_, i) => i), out = [];
  const same = (o, p) => Math.abs(pts[o][0] - p[0]) < 1e-9 && Math.abs(pts[o][1] - p[1]) < 1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 200000) {
    let done = false;
    for (const closed of [true, false]) {
      for (let k = 0; k < idx.length; k++) {
        const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        const cr = cr2(a, b, c);
        if (Math.abs(cr) < 1e-9) {
          // spike (c folds back over a): drop it. Straight run: keep b as long as other ears exist, so
          // the caps share every outline vertex with the side walls (no T-junctions).
          const straight = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0;
          if (!straight || !closed) { idx.splice(k, 1); done = true; break; }
          continue;
        }
        if (cr < 0) continue;
        let blocked = false;
        for (const o of idx) if (o !== ia && o !== ib && o !== ic && !same(o, a) && !same(o, b) && !same(o, c) && inTri(pts[o], a, b, c, closed)) { blocked = true; break; }
        if (blocked) continue;
        out.push([ia, ib, ic]);
        idx.splice(k, 1);
        done = true;
        break;
      }
      if (done) break;
    }
    if (!done) break;
  }
  if (idx.length === 3 && Math.abs(cr2(pts[idx[0]], pts[idx[1]], pts[idx[2]])) > 1e-9) out.push(idx.slice());
  return out;
}

export function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
/** Signed distance to a polygon (positive inside). */
export function polySDF(poly) {
  return (x, y) => {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
    return pointInPoly(poly, x, y) ? d : -d;
  };
}

/**
 * Marching squares on f(x, y) (inside = f >= 0) over an (nx+1) x (ny+1) grid from (x0, y0) with
 * steps gx, gy. Linear interpolation on edges; saddles resolved by the cell centre. Points are
 * keyed by position, so contours running exactly along grid lines keep sharp corners.
 */
export function contour(f, x0, y0, nx, ny, gx, gy) {
  const W = nx + 1, V = new Float64Array(W * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) V[j * W + i] = f(x0 + i * gx, y0 + j * gy);
  const pts = new Map(), adj = new Map();
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const link = (a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === kb) return;
    pts.set(ka, a); pts.set(kb, b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(kb); adj.get(kb).push(ka);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    const v = c.map(([a, b]) => V[b * W + a]);
    const ins = v.map((x) => x >= 0);
    const idx = ins[0] | (ins[1] << 1) | (ins[2] << 2) | (ins[3] << 3);
    if (idx === 0 || idx === 15) continue;
    const xp = (k) => [x0 + c[k][0] * gx, y0 + c[k][1] * gy];
    const edge = (e) => {
      const a = e, b = (e + 1) % 4;
      const [va, vb] = [v[a], v[b]];
      const t = va / (va - vb);
      const pa = xp(a), pb = xp(b);
      return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
    };
    const crossing = [0, 1, 2, 3].filter((e) => ins[e] !== ins[(e + 1) % 4]);
    if (crossing.length === 2) { link(edge(crossing[0]), edge(crossing[1])); continue; }
    // saddle: 4 crossings
    const centre = (v[0] + v[1] + v[2] + v[3]) / 4 >= 0;
    const around02 = (idx === 5) !== centre; // segments cut off corners 0 and 2 (else 1 and 3)
    if (around02) { link(edge(3), edge(0)); link(edge(1), edge(2)); } else { link(edge(0), edge(1)); link(edge(2), edge(3)); }
  }
  const used = new Set(), loops = [];
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const start of adj.keys()) {
    for (const first of adj.get(start)) {
      if (used.has(ek(start, first))) continue;
      const loop = [pts.get(start)];
      let prev = start, cur = first;
      used.add(ek(start, first));
      while (cur !== start) {
        loop.push(pts.get(cur));
        const next = adj.get(cur).find((n) => !used.has(ek(cur, n)));
        if (next === undefined) break;
        used.add(ek(cur, next));
        prev = cur; cur = next;
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Open polyline simplification: drop exactly collinear points, then Douglas-Peucker with tol (px).
 * Endpoints are kept; tol <= 0 only merges collinear runs.
 */
export function simplifyPath(pts, tol = 0) {
  const merged = [];
  for (const p of pts) {
    if (merged.length && Math.hypot(p[0] - merged[merged.length - 1][0], p[1] - merged[merged.length - 1][1]) < 1e-9) continue;
    while (merged.length >= 2) {
      const a = merged[merged.length - 2], b = merged[merged.length - 1];
      if (Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > 1e-9) break;
      // collinear and continuing in the same direction: b is redundant
      if ((b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]) < 0) break;
      merged.pop();
    }
    merged.push(p);
  }
  if (!(tol > 0) || merged.length < 3) return merged;
  const dp = (lo, hi, out) => {
    const a = merged[lo], b = merged[hi];
    let k = -1, md = tol;
    for (let i = lo + 1; i < hi; i++) { const d = segDist(merged[i][0], merged[i][1], a[0], a[1], b[0], b[1]); if (d > md) { md = d; k = i; } }
    if (k < 0) { out.push(b); return; }
    dp(lo, k, out); dp(k, hi, out);
  };
  const out = [merged[0]];
  dp(0, merged.length - 1, out);
  return out;
}

/** Douglas-Peucker on a closed loop. */
export function simplifyLoop(loop, tol) {
  if (loop.length < 4 || !(tol > 0)) return loop;
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]); if (d > fd) { fd = d; far = i; } }
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let k = -1, md = tol;
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]); if (d > md) { md = d; k = i; } }
    if (k < 0) return [a, b];
    return [...dp(pts.slice(0, k + 1)).slice(0, -1), ...dp(pts.slice(k))];
  };
  const out = [...dp(loop.slice(0, far + 1)).slice(0, -1), ...dp([...loop.slice(far), loop[0]]).slice(0, -1)];
  return out.length >= 3 ? out : loop;
}

/** Group loops into shapes: outer loops CCW with their holes CW (nesting depth decides). */
export function nestLoops(loops) {
  const info = loops.filter((l) => Math.abs(area2(l)) > 1e-6).map((l) => ({ l, a: Math.abs(area2(l)) }));
  for (const it of info) {
    const [x, y] = [(it.l[0][0] + it.l[1][0]) / 2, (it.l[0][1] + it.l[1][1]) / 2];
    it.parents = info.filter((o) => o !== it && o.a > it.a && pointInPoly(o.l, x, y));
    it.depth = it.parents.length;
  }
  const shapes = [];
  for (const it of info.filter((i) => i.depth % 2 === 0)) {
    const outer = area2(it.l) > 0 ? it.l : it.l.slice().reverse();
    shapes.push({ outer, holes: [], it });
  }
  for (const it of info.filter((i) => i.depth % 2 === 1)) {
    const parent = it.parents.filter((p) => p.depth === it.depth - 1).sort((a, b) => a.a - b.a)[0];
    const s = shapes.find((sh) => sh.it === parent);
    if (s) s.holes.push(area2(it.l) < 0 ? it.l : it.l.slice().reverse());
  }
  return shapes.map(({ outer, holes }) => ({ outer, holes }));
}

function segsCross(a, b, c, d) {
  const d1 = cr2(c, d, a), d2 = cr2(c, d, b), d3 = cr2(a, b, c), d4 = cr2(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
/** Merge holes into the outer loop with bridge edges, then ear-clip. -> { pts, tris } */
export function triangulateShape({ outer, holes }) {
  let poly = outer.slice();
  const rest = holes.map((h) => h.slice()).sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  for (let hi = 0; hi < rest.length; hi++) {
    const hole = rest[hi];
    let mi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[mi][0]) mi = i;
    const M = hole[mi];
    const others = rest.slice(hi + 1);
    const order = poly.map((p, j) => [j, Math.hypot(p[0] - M[0], p[1] - M[1])]).sort((a, b) => a[1] - b[1]);
    let best = order[0][0];
    for (const [j] of order) {
      const P = poly[j];
      let ok = true;
      const test = (loop) => { for (let i = 0; i < loop.length && ok; i++) if (segsCross(M, P, loop[i], loop[(i + 1) % loop.length])) ok = false; };
      test(poly); test(hole);
      for (const o of others) test(o);
      if (ok) { best = j; break; }
    }
    poly = [...poly.slice(0, best + 1), ...hole.slice(mi), ...hole.slice(0, mi + 1), ...poly.slice(best)];
  }
  return { pts: poly, tris: triangulate(poly) };
}
