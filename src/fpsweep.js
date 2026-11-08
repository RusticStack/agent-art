// Sweeps: an art_model gun, magazine, attachment or item rendered over a yaw x pitch grid into
// sheets of equal cells (at most 1024 px a side, split across sheets), with every anchor per cell.
// Each cell is the object seen from the fp eye with its reference point (gun / item: grip,
// magazine / attachment: mount) on the optical axis at depth D, so pixels per metre match across
// every asset and the runtime only translates and rotates cells (see fp.js).
import { buildModel } from './model3d.js';
import { texResolver } from './modelops.js';
import { rigInfo, posedWorld, resolveOffsets, subtree } from './modelrig.js';
import { encodePNG, decodePNG } from './png.js';
import { D, F, LIGHT, MAX_SHEET, cellRotation, anglesOf, steps, sheetLayout, r1, mv, sub } from './fp.js';
import { paint, materialOfRGB, rampsFor, MAT } from './fppaint.js';

/** The anchor names the contract lists per kind (plus extras the clips use). */
export const ANCHORS = {
  gun: ['grip', 'support', 'mag_well', 'muzzle', 'optic', 'muzzle_mount', 'underbarrel', 'sight', 'charging', 'pump', 'bolt_handle'],
  mag: ['mount'],
  attachment: ['mount', 'sight', 'muzzle', 'support'],
  item: ['grip', 'grip_r', 'tip', 'pin', 'screen'],
};
/** Gun cells drop surfaces nearer than this to the eye (cm). Kit guns also leave their stock node out
 * of sweeps (fp.sweep_hide): it sits at the cheek, off frame in play, and would dominate every cell. */
export const NEAR_GUN = 12;
export const REF = { gun: 'grip', item: 'grip', mag: 'mount', attachment: 'mount' };

/** Build a model definition into a rig (colour textures work without an engine). */
export function buildRig(engine, def, getModel) {
  const tex = texResolver(engine || { get: (n) => { throw new Error(`fp kit models use colours, not canvas "${n}"`); }, docs: new Map() });
  const built = buildModel(def, { tex, getModel: getModel || ((n) => { throw new Error(`no model "${n}"`); }), greebleKinds: () => ({}) });
  if (built.gpu) { for (const it of built.gpu) for (const M of it.mats) built.mesh.add(it.mesh.clone().transform(M)); delete built.gpu; }
  const info = rigInfo(def, built, true);
  return { def, built, info };
}

/**
 * Rasterize a mesh already in eye space (cm) with the fp camera: float depth, material id, normal
 * per pixel, inside the rect [x0, y0, w, h] of a virtual image whose optical centre is (cx, cy).
 */
export function rasterEye(mesh, cx, cy, rect, near = 0.5) {
  const [x0, y0, w, h] = rect, N = w * h;
  const depth = new Float32Array(N).fill(Infinity), mat = new Int16Array(N).fill(-1), nrm = new Float32Array(N * 3);
  for (const g of mesh.groups.values()) {
    if (!g.idx.length || g.overlay) continue;
    const t = g.tex, one = t.width * t.height === 1;
    const flatMat = one ? materialOfRGB(t.data[0], t.data[1], t.data[2]) : -1;
    const n = g.pos.length / 3, sx = new Float64Array(n), sy = new Float64Array(n), iz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const z = Math.max(0.5, -g.pos[i * 3 + 2]);
      sx[i] = cx + (F * g.pos[i * 3]) / z - x0; sy[i] = cy - (F * g.pos[i * 3 + 1]) / z - y0; iz[i] = 1 / z;
    }
    for (let f = 0; f < g.idx.length; f += 3) {
      const a = g.idx[f], b = g.idx[f + 1], c = g.idx[f + 2];
      const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
      if (Math.abs(area) < 1e-9 || area > 0) continue; // back-facing (y down)
      const bx0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), bx1 = Math.min(w - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const by0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), by1 = Math.min(h - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      const inv = 1 / area;
      for (let py = by0; py <= by1; py++) for (let px = bx0; px <= bx1; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const l0 = ((sx[c] - sx[b]) * (qy - sy[b]) - (sy[c] - sy[b]) * (qx - sx[b])) * inv;
        const l1 = ((sx[a] - sx[c]) * (qy - sy[c]) - (sy[a] - sy[c]) * (qx - sx[c])) * inv;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const izp = l0 * iz[a] + l1 * iz[b] + l2 * iz[c], z = 1 / izp, o = py * w + px;
        if (z >= depth[o] || z < near) continue;
        let m = flatMat;
        if (m < 0) {
          const u = (l0 * g.uv[a * 2] * iz[a] + l1 * g.uv[b * 2] * iz[b] + l2 * g.uv[c * 2] * iz[c]) / izp, v = (l0 * g.uv[a * 2 + 1] * iz[a] + l1 * g.uv[b * 2 + 1] * iz[b] + l2 * g.uv[c * 2 + 1] * iz[c]) / izp;
          let tx = Math.floor(u * t.width) % t.width, ty = Math.floor(v * t.height) % t.height;
          if (tx < 0) tx += t.width; if (ty < 0) ty += t.height;
          const p = (ty * t.width + tx) * 4;
          if (t.data[p + 3] < 128) continue;
          m = materialOfRGB(t.data[p], t.data[p + 1], t.data[p + 2]);
        }
        depth[o] = z; mat[o] = m;
        let nx = l0 * g.nrm[a * 3] + l1 * g.nrm[b * 3] + l2 * g.nrm[c * 3], ny = l0 * g.nrm[a * 3 + 1] + l1 * g.nrm[b * 3 + 1] + l2 * g.nrm[c * 3 + 1], nz = l0 * g.nrm[a * 3 + 2] + l1 * g.nrm[b * 3 + 2] + l2 * g.nrm[c * 3 + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[o * 3] = nx / l; nrm[o * 3 + 1] = ny / l; nrm[o * 3 + 2] = nz / l;
      }
    }
  }
  return { depth, mat, nrm };
}

/** 3x4 matrix (row-major, as model3d) of rotation R about point ref, then the reference to (0, 0, -D). */
const preOf = (R, ref) => { const t = mv(R, ref); return [R[0][0], R[0][1], R[0][2], -t[0], R[1][0], R[1][1], R[1][2], -t[1], R[2][0], R[2][1], R[2][2], -t[2] - D]; };

/**
 * Render one object at (yaw, pitch): {rgba, depth (cm, eye), anchors {name: [x, y]}, rect} in a
 * virtual image whose reference pixel is (0, 0) (anchors and rect relative to the reference).
 * opts: {pose (Map), hide, only, ramps, ref ([x,y,z] model), names}
 */
export function renderObject(rig, yaw, pitch, opts = {}) {
  const R = cellRotation(yaw, pitch);
  const { mesh, sockets } = posedWorld(rig.info, opts.pose || new Map(), { pre: preOf(R, opts.ref || [0, 0, 0]), only: opts.only, hide: opts.hide });
  const anchors = {};
  for (const [name, s] of sockets) {
    const k = name.replace(/^socket_/, '');
    if (opts.names && !opts.names.includes(k)) continue;
    const z = Math.max(0.5, -s.pos[2]);
    anchors[k] = [(F * s.pos[0]) / z, (-F * s.pos[1]) / z, z];
  }
  // projected bounds of the posed mesh
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of mesh.groups.values()) for (let i = 0; i < g.pos.length; i += 3) {
    const z = Math.max(0.5, -g.pos[i + 2]), x = (F * g.pos[i]) / z, y = (-F * g.pos[i + 1]) / z;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return { rgba: new Uint8ClampedArray(4), depth: new Float32Array(1), rect: [0, 0, 1, 1], anchors, empty: true };
  const rect = [Math.floor(x0) - 2, Math.floor(y0) - 2, Math.ceil(x1) - Math.floor(x0) + 4, Math.ceil(y1) - Math.floor(y0) + 4];
  const ras = rasterEye(mesh, 0, 0, rect, opts.near ?? 0.5);
  const rgba = paint(rect[2], rect[3], ras.mat, ras.nrm, ras.depth, LIGHT, { ramps: opts.ramps, ditherOffset: [((rect[0] % 4) + 4) % 4, ((rect[1] % 4) + 4) % 4] });
  return { rgba, depth: ras.depth, rect, anchors };
}

/**
 * Sweep of a model: {def: {cell, yaw, pitch, anchors, ...}, cells: [RGBA], depths: [Float32 (cm,
 * relative to D)], stats}. o: {yaw: [min, max, step], pitch, state (pose name), only, hide,
 * palette ([[r,g,b]]), kind, ref (anchor name), cell (force [w, h]), pad}
 */
export function renderSweep(rig, o = {}) {
  const { def } = rig;
  const kind = o.kind || def.fp?.kind || 'gun';
  const refName = o.ref || REF[kind];
  const yaws = anglesOf(o.yaw || [0, 0, 1]), pitches = anglesOf(o.pitch || [0, 0, 1]);
  if (yaws.length * pitches.length > 2000) throw new Error('sweep: too many cells (max 2000)');
  const pose = o.state ? resolveOffsets(def, rig.info, { pose: o.state }) : new Map();
  const restSockets = posedWorld(rig.info, pose, { mesh: false }).sockets;
  const refS = restSockets.get(`socket_${refName}`);
  if (!refS) throw new Error(`model "${def.name}" has no "${refName}" socket (the sweep reference for a ${kind}); sockets: ${[...restSockets.keys()].map((k) => k.slice(7)).join(', ') || 'none'}`);
  // o.host: the anchor this object mounts on, in its host gun's space (gun grip = origin): the cell then
  // shows it where it sits on that gun (true depth and offset); the reference pixel stays the gun grip
  const ref = o.host ? sub(refS.pos, o.host) : refS.pos;
  const names = (ANCHORS[kind] || []).filter((n) => restSockets.has(`socket_${n}`));
  for (const k of restSockets.keys()) { const n = k.slice(7); if (!names.includes(n) && !/^(tip|pin|stock)$/.test(n)) names.push(n); }
  const ramps = rampsFor(o.palette);
  const only = o.only ? [...subtree(rig.info, o.only)] : undefined;
  const t0 = performance.now();
  const raw = [];
  for (const pitch of pitches) for (const yaw of yaws) raw.push({ yaw, pitch, ...renderObject(rig, yaw, pitch, { pose, ref, ramps, only, hide: o.hide ?? def.fp?.sweep_hide, names, near: o.near ?? (kind === 'gun' ? NEAR_GUN : 0.5) }) });
  // one cell size for the whole sweep: union of every cell's pixels and anchors around the reference
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const c of raw) {
    if (!c.empty) {
      const [x0, y0, w, h] = c.rect;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (c.rgba[(y * w + x) * 4 + 3]) { ux0 = Math.min(ux0, x0 + x); ux1 = Math.max(ux1, x0 + x + 1); uy0 = Math.min(uy0, y0 + y); uy1 = Math.max(uy1, y0 + y + 1); }
    }
    for (const a of Object.values(c.anchors)) { ux0 = Math.min(ux0, Math.floor(a[0])); ux1 = Math.max(ux1, Math.ceil(a[0]) + 1); uy0 = Math.min(uy0, Math.floor(a[1])); uy1 = Math.max(uy1, Math.ceil(a[1]) + 1); }
  }
  if (ux0 === Infinity) { ux0 = 0; uy0 = 0; ux1 = 1; uy1 = 1; }
  const pad = o.pad ?? 1;
  ux0 -= pad; uy0 -= pad; ux1 += pad; uy1 += pad;
  let cw = ux1 - ux0, ch = uy1 - uy0;
  cw += cw & 1; ch += ch & 1;
  if (o.cell) { const [fw, fh] = o.cell; ux0 -= Math.floor((fw - cw) / 2); uy0 -= Math.floor((fh - ch) / 2); cw = fw; ch = fh; }
  if (cw > MAX_SHEET || ch > MAX_SHEET) throw new Error(`sweep "${def.name}": a cell would be ${cw}x${ch} px (max ${MAX_SHEET}): narrow the yaw / pitch range`);
  const cells = [], depths = [], anchors = Object.fromEntries(names.map((n) => [n, []]));
  for (const c of raw) {
    const img = new Uint8ClampedArray(cw * ch * 4), dep = new Float32Array(cw * ch).fill(Infinity);
    if (!c.empty) {
      const [x0, y0, w, h] = c.rect;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = y * w + x;
        if (!c.rgba[s * 4 + 3]) continue;
        const X = x0 + x - ux0, Y = y0 + y - uy0;
        if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
        img.set(c.rgba.subarray(s * 4, s * 4 + 4), (Y * cw + X) * 4);
        dep[Y * cw + X] = c.depth[s] - D - (c.anchors[refName] ? c.anchors[refName][2] - D : 0);
      }
    }
    cells.push(img); depths.push(dep);
    for (const n of names) { const a = c.anchors[n]; anchors[n].push(a ? [r1(a[0] - ux0), r1(a[1] - uy0)] : anchors[n][anchors[n].length - 1] ?? [0, 0]); }
  }
  const def2 = {
    ...(def.fp?.class ? { class: def.fp.class } : {}), cell: [cw, ch], yaw: o.yaw || [0, 0, 1], pitch: o.pitch || [0, 0, 1], anchors,
    ...(kind === 'gun' && def.fp?.mag ? { mag: def.fp.mag } : {}), ...(def.fp?.slot ? { slot: def.fp.slot } : {}),
  };
  return { def: def2, cells, depths, kind, ref: refName, stats: { cells: cells.length, cell: [cw, ch], ms: Math.round(performance.now() - t0), px_per_m: Math.round((F / D) * 1000) / 10 } };
}

/** Pack sweep cells into sheets (row-major across sheets): [{width, height, data}] (+ the layout). */
export function packSheets(sweep) {
  const [cw, ch] = sweep.def.cell, n = sweep.cells.length;
  const L = sheetLayout([cw, ch], n);
  const sheets = [];
  for (let s = 0; s < L.sheets; s++) {
    const [W, H] = L.size(s), data = new Uint8ClampedArray(W * H * 4);
    for (let k = 0; k < L.cols * L.rowsMax; k++) {
      const i = s * L.cols * L.rowsMax + k;
      if (i >= n) break;
      const col = k % L.cols, row = Math.floor(k / L.cols);
      const img = sweep.cells[i];
      for (let y = 0; y < ch; y++) data.set(img.subarray(y * cw * 4, (y + 1) * cw * 4), ((row * ch + y) * W + col * cw) * 4);
    }
    sheets.push({ width: W, height: H, data });
  }
  return { sheets, layout: L };
}

/** Cells back out of sheet images (what the game loads): sheet 0 sets the layout, like the engine. */
export function unpackSheets(def, sheets) {
  const [cw, ch] = def.cell, n = steps(def.yaw) * steps(def.pitch);
  const cols = Math.max(1, Math.floor(sheets[0].width / cw)), perSheet = cols * Math.max(1, Math.floor(sheets[0].height / ch));
  const cells = [];
  for (let i = 0; i < n; i++) {
    const s = Math.min(sheets.length - 1, Math.floor(i / perSheet)), k = i - s * perSheet, S = sheets[s];
    const col = k % cols, row = Math.floor(k / cols), img = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const sy = row * ch + y;
      if (sy >= S.height) break;
      img.set(S.data.subarray((sy * S.width + col * cw) * 4, (sy * S.width + col * cw + cw) * 4), y * cw * 4);
    }
    cells.push(img);
  }
  return cells;
}
export const sheetPNGs = (sweep) => packSheets(sweep).sheets.map((s) => encodePNG(s.width, s.height, s.data));
export const decodeSheets = (bufs) => bufs.map((b) => { const p = decodePNG(b); return { width: p.width, height: p.height, data: p.data }; });

/** Anchor continuity: the largest jump (px) of any anchor between neighbouring cells (yaw or pitch step). */
export function anchorJumps(def) {
  const cols = steps(def.yaw), rows = steps(def.pitch);
  const out = {};
  for (const [n, list] of Object.entries(def.anchors)) {
    let worst = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = list[r * cols + c];
      if (c + 1 < cols) { const b = list[r * cols + c + 1]; worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1])); }
      if (r + 1 < rows) { const b = list[(r + 1) * cols + c]; worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1])); }
    }
    out[n] = Math.round(worst * 10) / 10;
  }
  return out;
}
/** Expected neighbour jump bound for an anchor at distance r (cm) from the reference: r * step (rad) * F / (D - r) px. */
export function jumpBound(def, rCm) {
  const st = Math.max(def.yaw[2], def.pitch[2]) * Math.PI / 180;
  return (rCm * st * F) / Math.max(5, D - rCm) + 1.5;
}
export { MAT, sub };
