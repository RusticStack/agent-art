// First-person viewmodel (fp v2) core: the eye-space camera every fp asset shares, the apparent
// angle a sweep cell is picked by, and a compositor that draws a frame exactly like the game's
// runtime (Fragmentation src/entities/fpv2.ts: cell pick, anchor placement, rotation, render
// order). Units: eye space in centimetres, x right, y up, -z forward; frame pixels y down.
//
// One camera for everything: focal F px, frame 384 x 216 with the optical axis on the frame
// centre. Sweep cells are rendered with the object's reference point (gun: grip, attachment and
// magazine: mount, item: grip) on the axis at depth D, so every gun, magazine and attachment has
// the same pixels per metre at its reference point (F / D * 100). A gun held anywhere in the frame
// is drawn with the cell of its APPARENT orientation: its eye-space rotation seen from the ray
// through its grip.

export const FRAME = [384, 216];
export const CENTRE = [FRAME[0] / 2, FRAME[1] / 2];
export const F = 180; // focal length, px (vertical fov ~62°, horizontal ~94°)
export const D = 34; // reference depth of sweep cells (the hip grip depth), cm
export const PX_PER_M = Math.round((F / D) * 100 * 10) / 10;
export const LIGHT = norm([-0.55, 0.7, 0.45]); // toward the light, eye space (upper left, front)
export const MAX_SHEET = 1024;

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- 3-vectors, 3x3 rotations (rows) ----------
export function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export function rx(d) { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
export function ry(d) { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
export function rz(d) { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
export const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export const mv = (A, v) => [dot(A[0], v), dot(A[1], v), dot(A[2], v)];
export const tr = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
/** Eye-space orientation from yaw (about +Y, + = muzzle left), pitch (about +X, + = up), roll (about the barrel, + = counter-clockwise as seen from behind). */
export const ypr = (yaw = 0, pitch = 0, roll = 0) => mm(ry(yaw), mm(rx(pitch), rz(roll)));
/** Columns as vectors. */
export const col = (A, j) => [A[0][j], A[1][j], A[2][j]];
export const fromCols = (x, y, z) => [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
/** Rotation taking local -Z to fwd and local +Y toward up. */
export function frameOf(fwd, up) {
  const z = norm(mul(fwd, -1)), x = norm(cross(up, z)), y = cross(z, x);
  return fromCols(x, y, z);
}
/** Quaternion helpers for slerping hand frames. */
export function quatOf(R) {
  const t = R[0][0] + R[1][1] + R[2][2];
  let q;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, 0.25 * s]; }
  else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2; q = [0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s]; }
  else if (R[1][1] > R[2][2]) { const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2; q = [(R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s]; }
  else { const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2; q = [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s, (R[1][0] - R[0][1]) / s]; }
  return q;
}
export function matOfQuat([x, y, z, w]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
export function slerpR(A, B, t) {
  const a = quatOf(A); let b = quatOf(B);
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  let q;
  if (d > 0.9995) q = a.map((v, i) => v + (b[i] - v) * t);
  else { const th = Math.acos(d), s = Math.sin(th); q = a.map((v, i) => (v * Math.sin((1 - t) * th) + b[i] * Math.sin(t * th)) / s); }
  const l = Math.hypot(...q);
  return matOfQuat(q.map((v) => v / l));
}

// ---------- projection ----------
/** Eye-space point (cm) -> frame px [x, y] (y down), depth cm. */
export function project(p) {
  const z = Math.max(0.5, -p[2]);
  return [CENTRE[0] + (F * p[0]) / z, CENTRE[1] - (F * p[1]) / z, z];
}
/** Frame px + depth (cm) -> eye-space point. */
export function unproject(x, y, depth) {
  return [((x - CENTRE[0]) * depth) / F, (-(y - CENTRE[1]) * depth) / F, -depth];
}

/**
 * Apparent orientation of an object at eye-space point P with eye-space rotation R: the sweep
 * cell (yaw, pitch) to draw and the in-plane rotation (deg, clockwise on screen) that turns it
 * into place. The cell camera looks along the ray through P (no roll), so the object's rotation
 * relative to that ray is R_app = Rz(-rot) * Ry(yaw) * Rx(pitch).
 */
export function apparent(P, R) {
  const d = norm(P);
  const ay = Math.atan2(-d[0], -d[2]) * R2D, ap = Math.asin(clamp(d[1], -1, 1)) * R2D;
  const Rr = mm(ry(ay), rx(ap));
  const A = mm(tr(Rr), R);
  const pitch = Math.atan2(A[2][1], A[2][2]) * R2D;
  const yaw = Math.asin(clamp(-A[2][0], -1, 1)) * R2D;
  const c = Math.atan2(A[1][0], A[0][0]) * R2D;
  // the ray camera's x axis seen through the real camera: its screen tilt adds to the roll
  const xr = col(Rr, 0), p0 = project(P), p1 = project(add(P, mul(xr, 2)));
  const tilt = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * R2D;
  return { yaw, pitch, rot: -c + tilt };
}
/** The eye-space rotation a sweep cell shows (object reference on the axis at depth D). */
export const cellRotation = (yaw, pitch) => mm(ry(yaw), rx(pitch));

// ---------- sweep grids (the engine's indexing) ----------
export const steps = (a) => Math.round((a[1] - a[0]) / Math.max(1e-6, a[2])) + 1;
export const anglesOf = (a) => Array.from({ length: steps(a) }, (_, i) => +(a[0] + i * a[2]).toFixed(6));
/** Nearest cell index, row-major (yaw columns, pitch rows), clamped: fpv2.ts cellIndex. */
export function cellIndex(def, yaw, pitch) {
  const [y0, , ys] = def.yaw, [p0, , ps] = def.pitch;
  const c = clamp(Math.round((yaw - y0) / ys), 0, steps(def.yaw) - 1);
  const r = clamp(Math.round((pitch - p0) / ps), 0, steps(def.pitch) - 1);
  return r * steps(def.yaw) + c;
}
export function anchorOf(def, name, idx) {
  const list = def.anchors?.[name];
  return list ? list[Math.min(idx, list.length - 1)] ?? null : null;
}
/** Frame position of anchor `name` of a cell placed with anchor `a` at (x, y), rotated rot (deg cw), scaled. */
export function placeAnchor(def, idx, name, a, x, y, rot = 0, scale = 1) {
  const p = anchorOf(def, name, idx);
  if (!p) return null;
  const r = rot * D2R, dx = (p[0] - a[0]) * scale, dy = (p[1] - a[1]) * scale;
  return [x + dx * Math.cos(r) - dy * Math.sin(r), y + dx * Math.sin(r) + dy * Math.cos(r)];
}
/** Sheet layout the engine derives from sheet 0: columns and cells per sheet. */
export function sheetLayout(cell, count) {
  const cols = Math.max(1, Math.floor(MAX_SHEET / cell[0]));
  const rowsMax = Math.max(1, Math.floor(MAX_SHEET / cell[1]));
  const perSheet = cols * rowsMax;
  const sheets = Math.ceil(count / perSheet);
  const rows0 = sheets > 1 ? rowsMax : Math.ceil(count / cols);
  return { cols, rowsMax, perSheet: cols * rows0, sheets, size: (i) => [Math.min(cols, count) * cell[0], (i < sheets - 1 ? rowsMax : Math.ceil((count - i * perSheet) / cols)) * cell[1]] };
}

// ---------- the runtime compositor ----------
/**
 * Draw one sweep cell into an RGBA frame: anchor `a` (cell px) lands on (x, y), rotated rot (deg,
 * clockwise), scaled; nearest sampling at pixel centres, alpha test 0.5 (three.js alphaTest).
 * sweep = {def, cells: [RGBA cell images]} (cell images are cell[0] x cell[1]).
 * depth: optional {buf: Float32Array (frame), cell: Float32Array per cell, base} writes depth.
 */
export function drawCell(dst, W, H, sweep, idx, a, x, y, rot = 0, scale = 1, opts = {}) {
  const [cw, ch] = sweep.def.cell, img = sweep.cells[idx];
  if (!img) return 0;
  const r = rot * D2R, c = Math.cos(r), s = Math.sin(r);
  // bounding box of the rotated cell
  const pts = [[0, 0], [cw, 0], [0, ch], [cw, ch]].map(([u, v]) => { const dx = (u - a[0]) * scale, dy = (v - a[1]) * scale; return [x + dx * c - dy * s, y + dx * s + dy * c]; });
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...pts.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  let n = 0;
  const cd = opts.depth?.cells?.[idx];
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    const qx = px + 0.5 - x, qy = py + 0.5 - y;
    const u = Math.floor(a[0] + (qx * c + qy * s) / scale), v = Math.floor(a[1] + (-qx * s + qy * c) / scale);
    if (u < 0 || v < 0 || u >= cw || v >= ch) continue;
    const si = (v * cw + u) * 4;
    if (img[si + 3] < 128) continue;
    const o = (py * W + px) * 4;
    dst[o] = img[si]; dst[o + 1] = img[si + 1]; dst[o + 2] = img[si + 2]; dst[o + 3] = 255;
    if (opts.depth && cd) opts.depth.buf[py * W + px] = opts.depth.base + cd[v * cw + u];
    if (opts.mask) opts.mask[py * W + px] = opts.maskValue ?? 1;
    n++;
  }
  return n;
}

/** Strip frame f (RGBA, fw x fh) over dst. */
function drawStrip(dst, strip, f, W, H) {
  if (!strip) return;
  const SW = strip.width;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (y * SW + f * W + x) * 4;
    if (strip.data[si + 3] < 128) continue;
    const o = (y * W + x) * 4;
    dst[o] = strip.data[si]; dst[o + 1] = strip.data[si + 1]; dst[o + 2] = strip.data[si + 2]; dst[o + 3] = 255;
  }
}

/** Runtime render order (fpv2.ts quads: renderOrder, then creation order). */
export const RENDER_ORDER = { back: 10, gun_back: 9, gun_mid: 11, gun_front: 16, attachment: 0.5, mag_in: -0.25, mag_hand: 13, mid: 14, front: 15, item_back: 9, item_mid: 12, item_front: 17 };
const CREATION = ['back', 'gun', 'att0', 'att1', 'att2', 'mag', 'mid', 'front', 'gunFront', 'item'];
export const SLOT_ANCHOR = { optic: 'optic', muzzle: 'muzzle_mount', underbarrel: 'underbarrel', magazine: 'mag_well' };
const pick = (list, f) => (list?.length ? list[Math.min(f, list.length - 1)] : null);

/**
 * Compose frame f of an fp animation exactly like the game: arms layers {back, mid?, front} (strip
 * images {width, height, data}), sockets {gun, mag, item}, gun / mag / attachment {slot: sweep} /
 * item {id: sweep} sweeps ({def, cells}). yawOff / pitchOff = look sway (deg).
 * -> {data, width, height, sight, muzzle, layers: [{name, order}] (draw order)}
 */
export function composite({ anim, f = 0, layers = {}, gun = null, mag = null, attachments = {}, items = {}, yawOff = 0, pitchOff = 0, frame = FRAME, background = null }) {
  const [W, H] = frame;
  const out = new Uint8ClampedArray(W * H * 4);
  if (background) for (let i = 0; i < W * H; i++) out.set(background, i * 4);
  const draws = []; // {order, id, fn}
  const put = (id, order, fn) => draws.push({ id, order, rank: CREATION.indexOf(id), fn });
  if (layers.back) put('back', RENDER_ORDER.back, () => drawStrip(out, layers.back, f, W, H));
  if (layers.mid) put('mid', RENDER_ORDER.mid, () => drawStrip(out, layers.mid, f, W, H));
  if (layers.front) put('front', RENDER_ORDER.front, () => drawStrip(out, layers.front, f, W, H));
  let sight = null, muzzle = null;
  const gs = pick(anim.gun, f);
  if (gun && gs && !gs.hidden) {
    const sw = gun.states?.[gs.state] && gs.state ? gun.states[gs.state] : gun;
    const idx = cellIndex(sw.def, (gs.yaw ?? 0) + yawOff, (gs.pitch ?? 0) + pitchOff);
    const grip = anchorOf(sw.def, 'grip', idx) ?? [sw.def.cell[0] / 2, sw.def.cell[1] / 2];
    const sc = gs.scale ?? 1, rot = gs.rot ?? 0;
    const gx = gs.x ?? W * 0.7, gy = gs.y ?? H * 0.7;
    const order = gs.order ?? 'mid';
    const go = order === 'back' ? RENDER_ORDER.gun_back : order === 'front' ? RENDER_ORDER.gun_front : RENDER_ORDER.gun_mid;
    put(order === 'front' ? 'gunFront' : 'gun', go, () => drawCell(out, W, H, sw, idx, grip, gx, gy, rot, sc));
    const at = (name) => placeAnchor(sw.def, idx, name, grip, gx, gy, rot, sc);
    sight = at('sight');
    muzzle = at('muzzle');
    ['optic', 'muzzle', 'underbarrel'].filter((slot) => attachments[slot]).map((slot) => [slot, attachments[slot]]).forEach(([slot, as], i) => {
      const target = at(SLOT_ANCHOR[slot]);
      if (!target || i > 2) return;
      const ai = cellIndex(as.def, (gs.yaw ?? 0) + yawOff, (gs.pitch ?? 0) + pitchOff);
      const mount = anchorOf(as.def, 'mount', ai) ?? [as.def.cell[0] / 2, as.def.cell[1] / 2];
      put(`att${i}`, go + RENDER_ORDER.attachment, () => drawCell(out, W, H, as, ai, mount, target[0], target[1], rot, sc));
      const own = (name) => placeAnchor(as.def, ai, name, mount, target[0], target[1], rot, sc);
      if (slot === 'optic') sight = own('sight') ?? sight;
      if (slot === 'muzzle') muzzle = own('muzzle') ?? muzzle;
    });
    const M = attachments.magazine || mag;
    const ms = pick(anim.mag, f);
    if (M && (!ms || ms.state !== 'hidden')) {
      const mi = (s) => cellIndex(M.def, (s?.yaw ?? gs.yaw ?? 0) + yawOff, (s?.pitch ?? gs.pitch ?? 0) + pitchOff);
      if (!ms || ms.state === 'in' || ms.state == null) {
        const well = at('mag_well');
        if (well) { const i2 = mi(gs); put('mag', go + RENDER_ORDER.mag_in, () => drawCell(out, W, H, M, i2, anchorOf(M.def, 'mount', i2) ?? [0, 0], well[0], well[1], rot, sc)); }
      } else if (ms.state === 'hand') {
        const i2 = mi(ms);
        put('mag', RENDER_ORDER.mag_hand, () => drawCell(out, W, H, M, i2, anchorOf(M.def, 'mount', i2) ?? [0, 0], ms.x ?? 0, ms.y ?? 0, ms.rot ?? 0, ms.scale ?? 1));
      }
    }
  }
  // held items: item, and item2 (a second item in the other hand, e.g. a riot shield)
  for (const key of anim.item2 ? ['item', 'item2'] : ['item']) {
    const is = pick(anim[key], f);
    const isw = is?.id ? items[is.id] : null;
    if (is && isw && !is.hidden) {
      const ii = cellIndex(isw.def, is.yaw ?? 0, is.pitch ?? 0);
      const io = is.order === 'back' ? RENDER_ORDER.item_back : is.order === 'mid' ? RENDER_ORDER.item_mid : RENDER_ORDER.item_front;
      put(key, io, () => drawCell(out, W, H, isw, ii, anchorOf(isw.def, 'grip', ii) ?? [0, 0], is.x ?? 0, is.y ?? 0, is.rot ?? 0, is.scale ?? 1));
    }
  }
  draws.sort((p, q) => p.order - q.order || p.rank - q.rank);
  for (const d of draws) d.fn();
  return { data: out, width: W, height: H, sight, muzzle, layers: draws.map((d) => ({ name: d.id, order: d.order })) };
}
