// Runtime weapon layers (game contract "Runtime weapon layers for characters", ASSETS.md):
// handling classes with a standard grip geometry, standalone weapon assets checked against it
// (conform), 5-view x pitch weapon world sheets (+ attachment overlays), per-frame weapon sockets for
// gun-free character strips, an engine-identical composite, and the hands-on-grips check across
// every gun of a class.
//
// Engine (Fragmentation src/entities/actor.ts updateGun): the weapon cell for (view row, nearest
// pitch column) is placed so its grip pixel lands on the socket (x, y) of the body frame and
// rotated by socket.rot degrees clockwise about it; order: behind | between (body, gun, __front) |
// front. Mirrored views mirror the whole actor, so sockets are in drawn-view frame pixels.
import { normalizeRig, renderPose, partIn } from './rig.js';
import { projectWeapon, weaponDefaults, WEAPON_CLASSES } from './weapon.js';
import { ATT_CELL } from './rigtemplates.js';
import { HANDLING_CLASSES, ATTACHMENT_TYPES, classOf, thirdPersonClass, gripGeometry, scaleGeometry, conform } from './handling.js';

const D2R = Math.PI / 180;
const r1 = (v) => Math.round(v * 10) / 10;
const rot2 = (deg, x, y) => { const r = deg * D2R, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };
const norm180 = (a) => { let d = a % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
export const DEFAULT_PITCH = [-45, -30, -15, 0, 15, 30, 45];
export const SHEET_VIEWS = ['front', 'front_side', 'side', 'back_side', 'back'];

/**
 * Third-person handling classes (animation sets): the shared classes (handling.js) a character
 * exports. dmr / shotgun map to rifle (they keep the rifle grips); knife, grenade, med, tablet and
 * unarmed map to none.
 */
export const HANDLING = Object.fromEntries(Object.entries(HANDLING_CLASSES).filter(([c, d]) => d.third_person === c).map(([c, d]) => [c, {
  members: Object.entries(HANDLING_CLASSES).filter(([, x]) => x.third_person === c).flatMap(([k, x]) => [...new Set([k, ...x.members])]),
  cell: d.cell, kind: d.kind,
}]));
/** Third-person handling class of a weapon class name (rifle, dmr, carbine ... -> rifle). */
export const handlingOf = (cls) => thirdPersonClass(cls);

/** Body units -> px for a humanoid_hd character frame [W, H] (template scale: u for lengths, uw for widths). */
export function unitsOf([W, H]) { const u = (H - 4) / 98; return { u, uw: Math.min(u, W / 66) }; }

/**
 * Standard geometry of a handling class in px for a character frame: offsets from grip_main (x
 * forward along the barrel, y down) of the support grip and the stock, and the tolerance
 * (handling.js gripGeometry scaled to the frame).
 */
export function classGeometry(handling, frame) {
  if (!HANDLING_CLASSES[handling]?.cell) return null;
  const G = scaleGeometry(gripGeometry(handling), unitsOf(frame));
  return { handling, ...G };
}

/** Rig definition for a standalone weapon asset (one side cell + attachment cells + magazine). */
export function weaponAssetDef(name, cls, frame, attachments = {}) {
  const handling = handlingOf(cls);
  const H = HANDLING_CLASSES[classOf(cls)];
  if (!H.cell) throw new Error(`class "${classOf(cls)}" has no gun geometry (knife, grenade, med, tablet, unarmed, none)`);
  const { u, uw } = unitsOf(frame);
  const cellU = H.cell;
  const w = Math.max(2, Math.round(cellU[0] * uw)), h = Math.max(1, Math.round(cellU[1] * u));
  const { points, sockets } = weaponDefaults(H.kind, [w, h]);
  // every gun of a class: grips and stock at the class offsets from grip_main (the barrel, muzzle
  // and receiver length vary); grip_main moves back so the stock stays in the cell
  const G = classGeometry(handling, frame);
  const g = [Math.round(G.stock ? Math.max(points.grip_main.x, -G.stock[0]) : points.grip_main.x), Math.round(points.grip_main.y)];
  const shift = g[0] - points.grip_main.x;
  for (const k of ['grip_main', 'optic', 'mag', 'charge']) if (points[k]) points[k].x += shift;
  for (const k of Object.keys(sockets)) if (k !== 'muzzle') sockets[k] = [sockets[k][0] + shift, sockets[k][1]];
  if (G.support && points.grip_support) Object.assign(points.grip_support, { x: g[0] + G.support[0], y: Math.min(h - 0.5, Math.max(0, points.grip_main.y + G.support[1])) });
  if (G.stock && points.stock) Object.assign(points.stock, { x: Math.max(0, g[0] + G.stock[0]), y: Math.min(h - 0.5, Math.max(0, points.grip_main.y + G.stock[1])) });
  const parts = { weapon: { w, h, pivot: g } };
  const atts = {};
  for (const [n, a0] of Object.entries(attachments)) {
    const type = typeof a0 === 'string' ? a0 : a0?.type;
    if (!ATTACHMENT_TYPES[type]) throw new Error(`attachments.${n}: type must be one of ${Object.keys(ATTACHMENT_TYPES).join(', ')}`);
    const [aw, ah, mount] = ATT_CELL[type] || [6, 6, 'top'];
    const W2 = Math.max(1, Math.round(aw * uw)), H2 = Math.max(1, Math.round(ah * u));
    const pivot = mount === 'top' ? [Math.floor(W2 / 2), 0] : mount === 'bottom' ? [Math.floor(W2 / 2), H2 - 1] : [0, Math.floor(H2 / 2)];
    const sock = sockets[ATTACHMENT_TYPES[type].socket];
    parts[`att_${n}`] = { w: W2, h: H2, pivot, parent: 'weapon', at: [r1(sock[0] - g[0]), r1(sock[1] - g[1])], z: 0.1 };
    atts[n] = { type, part: `att_${n}`, socket: ATTACHMENT_TYPES[type].socket };
  }
  const [mw, mh] = H.kind === 'pistol' ? [3, 6] : [5, 9];
  const MW = Math.max(1, Math.round(mw * uw)), MH = Math.max(1, Math.round(mh * u));
  parts.mag = { w: MW, h: MH, pivot: [Math.floor(MW / 2), 0], parent: 'weapon', at: [r1(points.mag.x - g[0]), r1(points.mag.y - g[1])], z: -0.1 };
  const S = 2 * Math.ceil(Math.hypot(w, h)) + 8;
  return {
    rig: { frame: [S, S], views: ['side'], root: [S / 2, S / 2], parts, sampling: 'rotsprite' },
    asset: { name, class: cls, handling, kind: H.kind, frame, cell: [w, h], points: Object.fromEntries(Object.entries(points).map(([k, p]) => [k, { at: [r1(p.x), r1(p.y)], angle: p.angle }])), sockets: Object.fromEntries(Object.entries(sockets).map(([k, s]) => [k, [r1(s[0]), r1(s[1])]])), attachments: atts },
  };
}

/** A point of an asset (cell px), an attachment taking it over when `attach` lists it. */
export function assetPoint(asset, rig, name, attach = []) {
  for (const n of attach) {
    const a = asset.attachments[n];
    const over = a && ATTACHMENT_TYPES[a.type]?.[name];
    if (over) {
      const p = rig.parts[a.part], at = p.at;
      const g = asset.points.grip_main.at;
      return [g[0] + at[0] + over.at[0] * p.w - p.pivot[0], g[1] + at[1] + over.at[1] * p.h - p.pivot[1]];
    }
  }
  return asset.points[name]?.at ?? null;
}

/**
 * conform: the asset's grips against its class geometry. -> {pass, checks:[{point, offset, standard,
 * along, across, tolerance, ok}], fixed?:{points}}
 */
export function conformAsset(asset, rig, { fix = false } = {}) {
  // foregrip attachments may move the support grip within the attachment tolerance
  const atts = {};
  for (const n of Object.keys(asset.attachments)) { const p = assetPoint(asset, rig, 'grip_support', [n]); if (p && p !== asset.points.grip_support?.at) atts[n] = p; }
  const pts = { grip_main: asset.points.grip_main.at, grip_support: asset.points.grip_support?.at, stock: asset.points.stock?.at };
  const r = conform(asset.handling, pts, { unit: unitsOf(asset.frame), attachments: atts, fix });
  const out = { pass: r.pass, handling: asset.handling, checks: r.checks };
  if (r.fixed) {
    const P = structuredClone(asset.points);
    for (const k of ['grip_support', 'stock']) if (P[k] && r.fixed.points[k]) P[k].at = r.fixed.points[k];
    out.fixed = { points: P, note: r.fixed.note };
  }
  return out;
}

/** The cell transform of a weapon at elevation `pitch` (deg, up +) in a view: {phi, sxs, alpha (muzzle screen angle)}. */
export function cellTransform(W, view, pitch, base = 'side') {
  const u = [Math.cos(pitch * D2R), -Math.sin(pitch * D2R), 0];
  // facing the camera, near-level guns are drawn as aimed (inward cant); away from it, shouldered
  const front = (W.views?.[view]?.yaw ?? { side: 0, front_side: 45, front: 90, back_side: -45, back: -90 }[view] ?? 0) > 0;
  const { Mu, L } = projectWeapon(W, u, view, { aimF: front ? 1 : 0, weld: front ? 0 : 1, out: 1, side: 1 });
  const flip = view !== base && Mu[0] < 0;
  const phi = flip ? Math.atan2(-Mu[1], -Mu[0]) / D2R : Math.atan2(Mu[1], Mu[0]) / D2R;
  return { phi, sxs: flip ? -L : L, flip, L, alpha: Math.atan2(Mu[1], Mu[0]) / D2R };
}

/** Projection settings for sheets: a character rig's weapon (same rules as its frames) or the defaults. */
export function projectionOf(rigW) {
  if (rigW) return rigW;
  return { foreshorten: { floor: 0.42, cant: 16, aim_floor: 0.24, aim_cant: 9 }, base: 'side', cfg: {}, views: {} };
}

/**
 * Render every (view, pitch) cell of a weapon asset (rotsprite, grip at a fixed pixel), cropped to
 * the union of all cells. only: [parts] renders an overlay (an attachment alone, same grid).
 * -> {frame:[w, h], grip:[x, y], cells: [view][pitch] RGBA, pts: [view][pitch] {muzzle, support}}
 */
export function renderWeaponCells(asset, rigDef, doc, { views = SHEET_VIEWS, pitch = DEFAULT_PITCH, attach = [], W = null, layers = null } = {}) {
  const rig = normalizeRig(rigDef);
  const P = projectionOf(W);
  const [S] = rig.frame;
  const g = asset.points.grip_main.at, pv = partIn(rig, 'weapon', 'side').pivot;
  const cache = new Map();
  const atParts = new Set(Object.values(asset.attachments).map((a) => a.part));
  const hideAll = (keep) => rig.order.filter((n) => n !== 'weapon' && n !== 'mag' && !keep.includes(n) && atParts.has(n));
  const sets = { base: { hide: hideAll(attach.map((n) => asset.attachments[n].part)) } };
  for (const n of layers || []) sets[n] = { only: [asset.attachments[n].part] };
  const raw = {}, pts = [];
  let ub = null;
  for (const v of views) {
    const row = [];
    for (const p of pitch) {
      const T = cellTransform(P, v, p);
      // grip_main on the frame root: offset the pivot by the transformed (grip - pivot)
      const [dx, dy] = rot2(T.phi, T.sxs * (g[0] - pv[0]), g[1] - pv[1]);
      const pose = { weapon: { rot: T.phi, sx: T.sxs, x: -dx, y: -dy } };
      // attachments and magazine foreshorten with the gun (as on the character: mount moved, sx = L)
      for (const n of rig.order) if (rig.parts[n].parent === 'weapon') pose[n] = { x: rig.parts[n].at[0] * (Math.abs(T.sxs) - 1), sx: Math.abs(T.sxs) };
      for (const [k, o] of Object.entries(sets)) {
        const img = renderPose(rig, doc, pose, 'side', cache, o);
        (raw[k] ||= []).push(img);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (img[(y * S + x) * 4 + 3]) { if (!ub) ub = [x, y, x, y]; else { if (x < ub[0]) ub[0] = x; if (y < ub[1]) ub[1] = y; if (x > ub[2]) ub[2] = x; if (y > ub[3]) ub[3] = y; } }
      }
      const at = (q) => { if (!q) return null; const [qx, qy] = rot2(T.phi, T.sxs * (q[0] - g[0]), q[1] - g[1]); return [qx, qy]; };
      row.push({ muzzle: at(assetPoint(asset, rig, 'muzzle', attach)), support: at(assetPoint(asset, rig, 'grip_support', attach)), T });
    }
    pts.push(row);
  }
  if (!ub) ub = [S / 2 - 2, S / 2 - 2, S / 2 + 2, S / 2 + 2];
  const x0 = ub[0] - 1, y0 = ub[1] - 1, fw = ub[2] - ub[0] + 3, fh = ub[3] - ub[1] + 3;
  const crop = (img) => { const o = new Uint8ClampedArray(fw * fh * 4); for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) { const sx = x0 + x, sy = y0 + y; if (sx < 0 || sy < 0 || sx >= S || sy >= S) continue; o.set(img.subarray((sy * S + sx) * 4, (sy * S + sx) * 4 + 4), (y * fw + x) * 4); } return o; };
  const grip = [Math.round(rig.root[0]) - x0, Math.round(rig.root[1]) - y0];
  const cells = {};
  for (const [k, list] of Object.entries(raw)) cells[k] = views.map((_, vi) => pitch.map((__, pi) => crop(list[vi * pitch.length + pi])));
  return { frame: [fw, fh], grip, cells, pts: pts.map((row) => row.map((c) => ({ muzzle: c.muzzle && [r1(grip[0] + c.muzzle[0]), r1(grip[1] + c.muzzle[1])], support: c.support && [r1(grip[0] + c.support[0]), r1(grip[1] + c.support[1])], alpha: c.T.alpha }))), views, pitch };
}

/** One sheet image from cells [view][pitch]: rows = views, columns = pitch (the engine's layout). */
export function sheetImage(cells, [fw, fh]) {
  const rows = cells.length, cols = cells[0].length, W = cols * fw, H = rows * fh;
  const out = new Uint8ClampedArray(W * H * 4);
  cells.forEach((row, r) => row.forEach((img, c) => { for (let y = 0; y < fh; y++) out.set(img.subarray(y * fw * 4, (y + 1) * fw * 4), ((r * fh + y) * W + c * fw) * 4); }));
  return { data: out, W, H };
}

/** Nearest pitch column (the engine's rule). */
export const pitchCol = (pitch, p) => { let c = 0; for (let i = 1; i < pitch.length; i++) if (Math.abs(pitch[i] - p) < Math.abs(pitch[c] - p)) c = i; return c; };

/**
 * The weapon socket of a solved frame (drawn view): grip_main frame px (+ padding), rot = the
 * frame's muzzle screen angle minus the angle drawn in the (view, nearest pitch) cell, pitch =
 * elevation (up +), order from the drawn stack, hidden when the carry state hides the gun.
 */
export function socketOf(rig, solved, trace, { pad = [0, 0, 0, 0], pitch = DEFAULT_PITCH, view }) {
  const W = rig.weapon, R = solved.weapon;
  const src = rig.mirror[view] || view;
  const pv = partIn(rig, W.part, W.base).pivot, gm = W.points.grip_main;
  let [x, y] = R.scr({ x: gm.x - pv[0], y: gm.y - pv[1] });
  const elev = -R.s.theta;
  const col = pitchCol(pitch, elev);
  const cell = cellTransform(W, src, pitch[col], W.base);
  const alphaF = R.flip ? R.phi + 180 : R.phi;
  let rot = norm180(alphaF - cell.alpha);
  // drawn order: behind = the gun under the torso, else body / gun / __front
  const idx = (n) => trace.order.findIndex((e) => e.part === n);
  const wi = idx(W.part), ti = Math.min(...W.spine.map(idx).filter((i) => i >= 0));
  const order = wi >= 0 && Number.isFinite(ti) && wi < ti ? 'behind' : 'between';
  x += pad[0]; y += pad[1];
  if (solved.flip) {
    // mirror views (when exported): mirror about the padded root column, rotation mirrored
    x = (rig.root[0] + pad[2]) + (rig.root[0] + pad[0]) - 1 - (x - pad[0] + pad[2]);
    rot = norm180(-rot);
  }
  const s = { x: r1(x), y: r1(y), rot: r1(rot), pitch: r1(elev), order };
  if (R.s.pl.hidden >= 0.5) s.hidden = true;
  if (W.mag && solved.VP[W.mag.part]?.hide && !s.hidden) s.mag = false;
  return s;
}

/** Engine-identical compositing of one frame: body, gun cell rotated about its grip onto the socket, __front. */
export function compositeFrame(body, front, cell, [fw, fh], grip, sock, [FW, FH]) {
  const out = new Uint8ClampedArray(FW * FH * 4);
  const over = (src) => { if (!src) return; for (let i = 0; i < src.length; i += 4) if (src[i + 3]) out.set(src.subarray(i, i + 4), i); };
  const gun = new Uint8ClampedArray(FW * FH * 4);
  if (cell && !sock.hidden) {
    const r = (sock.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      // inverse: frame px -> cell px (rotation about the grip, clockwise rot on screen)
      const dx = x + 0.5 - sock.x - 0.5, dy = y + 0.5 - sock.y - 0.5;
      const u = Math.floor(dx * c + dy * s + grip[0] + 0.5), v = Math.floor(-dx * s + dy * c + grip[1] + 0.5);
      if (u < 0 || v < 0 || u >= fw || v >= fh) continue;
      const o = (v * fw + u) * 4;
      if (cell[o + 3]) gun.set(cell.subarray(o, o + 4), (y * FW + x) * 4);
    }
  }
  const order = sock.order || 'between';
  if (order === 'behind') { over(gun); over(body); over(front); }
  else if (order === 'front') { over(body); over(front); over(gun); }
  else { over(body); over(gun); over(front); }
  return out;
}

export { WEAPON_CLASSES };
