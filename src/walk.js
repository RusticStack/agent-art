// Walkable ships and structures: the player metrics every interior is built and validated against
// (32 px = 1 m), helpers that fit decks and bulkheads inside a hull's inner skin, the walk_check
// analysis (blocked doors, headroom, unreachable areas, floor gaps, interior parts poking through
// the hull, metric violations) and the walkability export (navmesh of the walk areas; collider,
// trigger, spawn and seat marker nodes).
//
// Walk data rides on markers, so it follows every transform, array and assembly:
//   walk     {w, d, room?, kind?:"walk"|"ramp"|"stairs"|"seat", headroom?}  quad centred on pos, d along dir (3D: slopes)
//   ladder   {h, w?}           climbable from pos (bottom) to pos + h (top)
//   lift     {travel}          platform from pos to pos + travel
//   door     {w, h, door, style|kind}
//   collider {w, h, d, room}   box collider (centre pos, axis-aligned in the part frame: dir = +z)
//   trigger  {trigger, w, h, d, id}
//   spawn / seat
import { hullSurface } from './hull.js';
import { bvhOf } from './bake.js';
import { Mesh } from './model3d.js';

// ---------- player metrics ----------
/** Player and level-design metrics in metres (the shared constant every kit piece is checked against). */
export const PLAYER_M = Object.freeze({
  height: 1.8, radius: 0.35, eye: 1.65, seated_eye: 1.2, seated_head: 1.38,
  door_w: 1.2, door_h: 2.1, corridor_w: 1.4, corridor_h: 2.3,
  step_rise: 0.2, stair_deg: 38, slope_deg: 35, ramp_deg: 20, hull_min: 0.15,
});
/** The metrics in px for a model scale (px per metre, default 32). */
export const playerPx = (scale = 32) => Object.fromEntries(Object.entries(PLAYER_M).map(([k, v]) => [k, k.endsWith('_deg') ? v : v * scale]));
export const PX = playerPx(32);
/** Real-world size classes in metres (length) used by the templates and the docs. */
export const SHIP_SIZES_M = { snub: [10, 14], fighter: [18, 24], dropship: [30, 40], hauler: [80, 120], corvette: [150, 300], capital: [500, 2000] };

const r2 = (v) => Math.round(v * 100) / 100;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- fitting inside a hull ----------
/** Inner skin section of a hull at station t as a polygon [[x, y], ..] (world y, x), inset by shell + inset px. */
export function innerSection(H, t, inset = 0, n = 32) {
  const S = hullSurface(H), off = (H.at || [0, 0, 0]).map(Number), sh = Number(H.shell ?? (H.openings ? 6 : 0)) + inset;
  const pts = [];
  for (let k = 0; k < n; k++) { const u = k / n, p = S.point(t, u), q = S.normal(t, u); pts.push([r2(p[0] - q[0] * sh), r2(p[1] - q[1] * sh + off[1])]); }
  return pts;
}
/** Keep the part of a convex polygon where a*x + b*y + c >= 0 (Sutherland-Hodgman, one plane). */
export function clipPoly(poly, a, b, c) {
  const out = [], f = (p) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length], fp = f(P), fq = f(Q);
    if (fp >= 0) out.push(P);
    if (fp * fq < 0) { const k = fp / (fp - fq); out.push([r2(P[0] + (Q[0] - P[0]) * k), r2(P[1] + (Q[1] - P[1]) * k)]); }
  }
  return out;
}
const area2 = (P) => P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
/**
 * A bulkhead that fills the hull's inner section at station t (world z = hull z(t) + offset), with
 * an optional doorway {w, h, y (floor)} or window {w, h, y}: shape parts (plane xy) in world space.
 */
export function bulkhead(H, t, { thick = 6, door = null, window: win = null, texture, inset = 0.5, floor = null } = {}) {
  const S = hullSurface(H), off = (H.at || [0, 0, 0]).map(Number);
  let sec = innerSection(H, t, inset);
  if (floor !== null) sec = clipPoly(sec, 0, 1, -floor); // only above the deck
  const z = r2(S.z(t) + off[2]);
  const pieces = [];
  const cut = door || win;
  if (!cut) pieces.push(sec);
  else {
    const x0 = -cut.w / 2, x1 = cut.w / 2, y0 = cut.y, y1 = cut.y + cut.h;
    pieces.push(clipPoly(sec, -1, 0, x0)); // x <= x0
    pieces.push(clipPoly(sec, 1, 0, -x1)); // x >= x1
    const mid = clipPoly(clipPoly(sec, 1, 0, -x0), -1, 0, x1);
    pieces.push(clipPoly(mid, 0, 1, -y1)); // above
    if (y0 > Math.min(...sec.map((p) => p[1])) + 0.5) pieces.push(clipPoly(mid, 0, -1, y0)); // below (window sill)
  }
  return pieces.filter((P) => P.length >= 3 && Math.abs(area2(P)) > 4).map((P) => ({ type: 'shape', points: area2(P) < 0 ? P.slice().reverse() : P, d: thick, plane: 'xy', at: [off[0], 0, z], ...(texture !== undefined ? { texture } : {}), inside: H.id ?? H.name ?? 'hull' }));
}
/** Widest half-width (px, centred on x = 0) a deck from y to y + headroom fits over stations t0..t1 inside the inner skin. */
export function deckHalfWidth(H, t0, t1, y, headroom, margin = 4) {
  const S = hullSurface(H), off = (H.at || [0, 0, 0]).map(Number), sh = Number(H.shell ?? (H.openings ? 6 : 0));
  let w = Infinity;
  for (let k = 0; k <= 12; k++) {
    const t = t0 + ((t1 - t0) * k) / 12;
    for (let j = 0; j <= 4; j++) w = Math.min(w, S.halfWidthAt(t, y - off[1] + (headroom * j) / 4) - sh - margin);
  }
  return Math.max(0, r2(w));
}
/** Lowest y (world) a deck top can sit at over t0..t1: the inner bottom of the hull + deck thickness. */
export function deckFloorY(H, t0, t1, deck = 4) {
  const S = hullSurface(H), off = (H.at || [0, 0, 0]).map(Number), sh = Number(H.shell ?? (H.openings ? 6 : 0));
  let y = -Infinity;
  for (let k = 0; k <= 12; k++) { const t = t0 + ((t1 - t0) * k) / 12; const p = S.point(t, 0.5), n = S.normal(t, 0.5); y = Math.max(y, p[1] - n[1] * sh); }
  return r2(y + off[1] + deck);
}
/** Walk-area marker part. */
export const walkMarker = (at, w, d, data = {}, dir = [0, 0, 1]) => ({ type: 'marker', kind: 'walk', at, dir, data: { w: r2(w), d: r2(d), ...data } });

// ---------- analysis ----------
const quadOf = (k) => {
  const f = norm(k.dir || [0, 0, 1]);
  let s = cross([0, 1, 0], f);
  if (Math.hypot(...s) < 1e-6) s = [1, 0, 0];
  s = norm(s);
  const w = Number(k.data.w), d = Number(k.data.d), c = k.pos;
  return { c, f, s, w, d, up: norm(cross(f, s)), corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => add(c, add(mul(s, (a * w) / 2), mul(f, (b * d) / 2)))) };
};
/** Distance from point p to a walk quad (3D). */
const distToQuad = (p, q) => {
  const v = sub(p, q.c), a = Math.max(-q.w / 2, Math.min(q.w / 2, dot(v, q.s))), b = Math.max(-q.d / 2, Math.min(q.d / 2, dot(v, q.f)));
  return Math.hypot(...sub(p, add(q.c, add(mul(q.s, a), mul(q.f, b)))));
};
const edgePts = (q) => { const out = []; for (let i = 0; i < 4; i++) { const A = q.corners[i], B = q.corners[(i + 1) % 4], n = Math.max(4, Math.ceil(Math.hypot(...sub(B, A)) / 12)); for (let k = 0; k < n; k++) out.push(add(A, mul(sub(B, A), (k + 0.5) / n))); } return out; };

/**
 * Walkability report. closed / open: built meshes of the model as authored and with every door,
 * ramp and canopy open; markers from the open build; hulls: [{part, interior: Mesh}] (interior =
 * the parts tagged inside:<hull id>). -> report
 */
export function walkAnalyze({ markers = [], closed, open, hulls = [], scale = 32 }) {
  const P = playerPx(scale);
  const bOpen = bvhOf([open]), bClosed = bvhOf([closed]);
  const areas = markers.filter((k) => k.kind === 'walk').map((k, i) => ({ i, k, q: quadOf(k), name: k.data.room ?? `walk_${i}`, kind: k.data.kind ?? 'walk' }));
  const out = { blocked_doors: [], headroom: [], unreachable: [], floor_gaps: [], hull_pokes: [], metrics: [] };
  const U = (v) => r2(v / scale);
  const at = (p) => p.map(U);
  // samples on each area: a grid inset by the capsule radius
  for (const A of areas) {
    const { q } = A, step = Math.max(8, Math.min(16, q.w / 3, q.d / 3));
    const iw = Math.max(0, q.w / 2 - P.radius), id = Math.max(0, q.d / 2 - P.radius);
    const nx = Math.max(1, Math.round((2 * iw) / step)), nz = Math.max(1, Math.round((2 * id) / step));
    const need = Number(A.k.data.headroom ?? (A.kind === 'seat' ? P.seated_head : P.height + 0.1 * scale));
    let worst = Infinity, bad = 0, gaps = 0, n = 0, first = null, firstGap = null;
    for (let a = 0; a <= nx; a++) for (let b = 0; b <= nz; b++) {
      const x = nx ? -iw + (2 * iw * a) / nx : 0, z = nz ? -id + (2 * id * b) / nz : 0;
      const p = add(q.c, add(mul(q.s, x), mul(q.f, z)));
      n++;
      const h = bOpen.hit(add(p, [0, 1.5, 0]), [0, 1, 0], need);
      if (h < need - 1.5) { bad++; worst = Math.min(worst, h + 1.5); if (!first) first = p; }
      const g = bOpen.hit(add(p, [0, 4, 0]), [0, -1, 0], 10);
      if (!(g < 10)) { gaps++; if (!firstGap) firstGap = p; }
    }
    if (bad) out.headroom.push({ area: A.name, samples: n, blocked: bad, clearance_m: U(worst), need_m: U(need), at_m: at(first) });
    if (gaps) out.floor_gaps.push({ area: A.name, samples: n, gaps, at_m: at(firstGap) });
    const slope = (Math.asin(Math.min(1, Math.abs(q.f[1]))) * 180) / Math.PI;
    const lim = A.kind === 'ramp' ? P.ramp_deg : A.kind === 'stairs' ? P.stair_deg : P.slope_deg;
    if (slope > lim + 0.05) out.metrics.push({ check: `${A.kind} slope`, area: A.name, value: r2(slope), limit: lim, unit: 'deg' });
    if (A.kind === 'stairs' && Number(A.k.data.rise) > P.step_rise + 0.01) out.metrics.push({ check: 'stair rise', area: A.name, value: U(Number(A.k.data.rise)), limit: PLAYER_M.step_rise, unit: 'm' });
    if (A.kind !== 'seat' && Math.min(q.w, q.d) < P.radius * 2) out.metrics.push({ check: 'walk area narrower than the capsule', area: A.name, value: U(Math.min(q.w, q.d)), limit: PLAYER_M.radius * 2, unit: 'm' });
  }
  // doors: size + a clear passage through the opening (doors open)
  for (const k of markers.filter((m) => m.kind === 'door')) {
    const w = Number(k.data.w ?? 0), h = Number(k.data.h ?? 0), id = k.data.door ?? k.data.id ?? 'door';
    const hatch = ['ramp', 'hatch'].includes(k.data.kind) || /^cargo_/.test(k.data.kind || '') || k.data.style === 'hatch';
    if (!hatch && (w < P.door_w - 0.01 || h < P.door_h - 0.01)) out.metrics.push({ check: 'door size', door: id, value: [U(w), U(h)], limit: [PLAYER_M.door_w, PLAYER_M.door_h], unit: 'm' });
    if (hatch || !k.dir) continue;
    const f = norm([k.dir[0], 0, k.dir[2]]), s = norm(cross([0, 1, 0], f));
    const hits = [];
    for (const y of [0.3, 0.95, 1.6].map((m) => m * scale).filter((y) => y < h - 2)) for (const x of [-(w / 2 - P.radius), 0, w / 2 - P.radius]) {
      const o = add(add(k.pos, add(mul(s, x), [0, y, 0])), mul(f, -24));
      const t = bOpen.hit(o, f, 48);
      if (t < 48) hits.push(r2(t - 24));
    }
    if (hits.length) out.blocked_doors.push({ door: id, at_m: at(k.pos), blocked_rays: hits.length });
  }
  // corridors
  for (const k of markers.filter((m) => m.kind === 'room' && m.data.room === 'corridor')) {
    const w = Math.min(Number(k.data.w), Number(k.data.d)) - 2 * 4, h = Number(k.data.h);
    if (w < P.corridor_w - 0.01 || h < P.corridor_h - 0.01) out.metrics.push({ check: 'corridor size', at_m: at(k.pos), value: [U(w), U(h)], limit: [PLAYER_M.corridor_w, PLAYER_M.corridor_h], unit: 'm' });
  }
  // seats: a seated head clears the canopy / ceiling (closed)
  const seats = markers.filter((m) => m.kind === 'seat');
  for (const k of seats) {
    const y0 = P.seated_eye - 0.15 * scale, need = P.seated_head - y0 + 0.05 * scale;
    const hh = bClosed.hit(add(k.pos, [0, y0, 0]), [0, 1, 0], need);
    if (hh < need) out.headroom.push({ seat: k.data.seat ?? 'seat', clearance_m: U(y0 + hh), need_m: U(P.seated_head + 0.05 * scale), at_m: at(k.pos) });
  }
  // reachability: areas touching each other, the ground, ladders, lifts, doors
  const adj = areas.map(() => new Set());
  const link = (a, b) => { if (a !== b) { adj[a].add(b); adj[b].add(a); } };
  const GROUND = areas.length;
  adj.push(new Set());
  // a step across an area edge is open when a chest-high ray over it is not blocked (walls without a doorway are)
  const open1 = (p, dir) => { const d = norm([dir[0], 0, dir[2]]); return !(bOpen.hit(add(p, [0, P.height * 0.55, 0]), d, 20) < 20); };
  for (let a = 0; a < areas.length; a++) {
    const A = areas[a], ep = edgePts(A.q);
    for (let b = a + 1; b < areas.length; b++) {
      const B = areas[b];
      const cross1 = (X, Y) => edgePts(X.q).some((p) => { if (distToQuad(p, Y.q) > 14) return false; const out = sub(p, X.q.c); return open1(sub(p, mul(norm([out[0], 0, out[2]]), 6)), out); });
      if (cross1(A, B) || cross1(B, A)) link(a, b);
    }
    if (ep.some((p) => { if (p[1] > P.step_rise + 0.5) return false; const out = sub(p, A.q.c); return open1(sub(p, mul(norm([out[0], 0, out[2]]), 6)), out); })) link(a, GROUND);
  }
  const near = (p, tol = 24) => areas.filter((A) => distToQuad(p, A.q) <= tol).map((A) => A.i);
  for (const k of markers.filter((m) => m.kind === 'ladder' || m.kind === 'lift')) {
    const h = Number(k.data.h ?? k.data.travel ?? 0), bot = k.pos, top = add(k.pos, [0, h, 0]);
    const lo = near(bot, 30), hi = near(top, 30);
    if (bot[1] <= 8) lo.push(GROUND);
    for (const a of lo) for (const b of hi) link(a, b);
  }
  for (const k of markers.filter((m) => m.kind === 'door' && m.dir)) {
    const f = norm([k.dir[0], 0, k.dir[2]]);
    const A = near(add(k.pos, add(mul(f, 20), [0, 1, 0])), 28), B = near(add(k.pos, add(mul(f, -20), [0, 1, 0])), 28);
    for (const a of A) for (const b of B) link(a, b);
  }
  const spawns = markers.filter((m) => m.kind === 'spawn');
  const start = new Set();
  for (const s of spawns) for (const a of near(s.pos, 32)) start.add(a);
  if (!start.size) start.add(adj[GROUND].size ? GROUND : 0);
  const seen = new Set(start), stack = [...start];
  while (stack.length) { const a = stack.pop(); for (const b of adj[a]) if (!seen.has(b)) { seen.add(b); stack.push(b); } }
  for (const A of areas) if (!seen.has(A.i)) out.unreachable.push({ area: A.name, kind: A.kind, at_m: at(A.q.c) });
  // interior parts poking through the hull (inner skin)
  for (const { part: H, interior } of hulls) {
    if (!interior || !interior.triangles) continue;
    const S = hullSurface(H), off = (H.at || [0, 0, 0]).map(Number), sh = Number(H.shell ?? (H.openings ? 6 : 0));
    let bad = 0, n = 0, worst = -Infinity, wp = null;
    for (const g of interior.groups.values()) {
      if (g.tex?.material?.additive) continue;
      for (let i = 0; i < g.pos.length; i += 3) {
        const x = g.pos[i], y = g.pos[i + 1], z = g.pos[i + 2], t = S.tOf(z - off[2]);
        const hw = t <= 0 || t >= 1 ? -1 : S.halfWidthAt(t, y - off[1]) - sh;
        const over = Math.abs(x - off[0]) - hw;
        n++;
        if (over > 1) { bad++; if (over > worst) { worst = over; wp = [x, y, z]; } }
      }
    }
    if (H.openings && sh < P.hull_min - 0.01) out.metrics.push({ check: 'hull thickness', hull: H.id ?? H.name, value: U(sh), limit: PLAYER_M.hull_min, unit: 'm' });
    if (bad) out.hull_pokes.push({ hull: H.id ?? H.name ?? 'hull', vertices: n, outside: bad, worst_m: U(worst), at_m: at(wp) });
  }
  const problems = Object.values(out).reduce((s, l) => s + l.length, 0);
  return {
    ok: problems === 0, problems,
    player_m: PLAYER_M,
    areas: areas.map((A) => ({ name: A.name, kind: A.kind, size_m: [U(A.q.w), U(A.q.d)], at_m: at(A.q.c) })),
    counts: { areas: areas.length, doors: markers.filter((m) => m.kind === 'door').length, ladders: markers.filter((m) => m.kind === 'ladder').length, lifts: markers.filter((m) => m.kind === 'lift').length, seats: seats.length, spawns: spawns.length, reachable: [...seen].filter((a) => a !== GROUND).length },
    ...out,
  };
}

// ---------- export ----------
export const WALK_KINDS = new Set(['walk', 'collider', 'trigger']);
/** Navmesh (walkable surface) from the walk markers: one quad per area, 1x1 texture. */
export function navMesh(markers) {
  const m = new Mesh(), tex = { key: 'walk:nav', name: 'navmesh', width: 1, height: 1, data: Uint8ClampedArray.from([64, 255, 128, 255]) };
  for (const k of markers.filter((x) => x.kind === 'walk')) {
    const q = quadOf(k), n = q.up[1] < 0 ? mul(q.up, -1) : q.up;
    const C = q.up[1] < 0 ? q.corners.slice().reverse() : q.corners;
    // face winding: counter-clockwise seen from above
    const P = dot(cross(sub(C[1], C[0]), sub(C[3], C[0])), n) < 0 ? C.slice().reverse() : C;
    m.face(tex, P, P.map(() => n), [[0, 0], [1, 0], [1, 1], [0, 1]], n, 0);
  }
  return m;
}
