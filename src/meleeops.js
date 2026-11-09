// Engine ops for melee (art_anim melee | melee_check | melee_sheet | paired): install the melee
// clip library on a skeleton (weapon / shield cells + strikes, reactions, paired takedowns with
// fitted contacts), validate it (event order, active frames, hit-volume coverage of the weapon path,
// paired alignment), render melee weapon world sheets (views x pitch, grip on a fixed pixel, edge
// line per cell) and preview paired clips. anim_batch calls meleeBatchAnim for the manifest fields.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRig, resolvePose, lerpPose, solvePose, partIn, poseOf, renderPose, ikChain, footLow, groundRow, groundEnds } from './rig.js';
import { getRig, framePoses } from './rigops.js';
import { normalizeClip, evalClip, applyProportions, retargetClip, LIB_NAME } from './animlib.js';
import { meleeLibrary, meleeParts, meleeAnim, meleeEvents, hitSources, frameVolumes, segDist, inPoly, pairedOut, turnedView, VIEW_YAW8, normalizeMelee, frameOfT, HD_VIEWS } from './melee.js';
import { MELEE_IDS, meleeWeapon, meleeCell, CM_PER_UNIT } from './meleekit.js';
import { checkName } from './util.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { socketOf } from './weaponassets.js';

const libDir = (e, ...p) => path.join(e.home, 'library', ...p);
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const r1 = (v) => Math.round(v * 10) / 10;
const D2R = Math.PI / 180;
/** World-sheet rows (the runtime weapon-layer layout) and pitch columns. */
export const MELEE_SHEET_VIEWS = ['front', 'front_side', 'side', 'back_side', 'back'];
export const MELEE_PITCH = [-45, -30, -15, 0, 15, 30, 45];
/** Model yaw that turns a weapon held pointing along the character's facing into each view (model -Z = forward). */
const VIEW_MODEL_YAW = { side: -90, front_side: -135, front: 180, back_side: -45, back: 0 };

function loadSkeleton(e, name) {
  if (!LIB_NAME.test(name || '')) throw new Error('melee needs skeleton:"<name>" (art_anim skeleton first)');
  checkName(name, 'skeleton');
  const f = libDir(e, 'skeletons', `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`no skeleton "${name}" (art_anim skeleton {name, template:"humanoid_hd", frame} first)`);
  return readJSON(f);
}
const clipFile = (e, sk, name) => libDir(e, 'clips', checkName(sk, 'skeleton'), `${checkName(name, 'clip')}.json`);
/** A library skin by name (validated: it becomes a path under the library). */
const loadSkin = (e, name, what = 'skin') => {
  const f = libDir(e, 'skins', `${checkName(name, what)}.json`);
  if (!fs.existsSync(f)) throw new Error(`no skin "${name}" (art_anim skin first)`);
  return readJSON(f);
};
const loadClip = (e, sk, name) => { const f = clipFile(e, sk, name); return fs.existsSync(f) ? readJSON(f) : null; };
const listClips = (e, sk) => { const d = libDir(e, 'clips', sk); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : []; };

/** Cells of the skeleton's melee hold (weapon / shield) in frame px, for hit sources. */
const cellsOf = (sk) => (sk.melee ? { weapon: sk.melee.cell ?? null, shield: sk.melee.shield_cell ?? null } : null);

/** Sub-samples per frame step for the exported swept hit polygons. */
const SWEEP_SUB = 8; // sub-steps of the exported swept hulls (the check samples twice as densely)
/** foot | hand: which ground-contact metric a limb end counts toward. */
const endKind = (n) => (/^hand(_|$)/.test(n) ? 'hand' : 'foot');

// ---------- paired fitting ----------
/** A contact point of a part: hands / fists at the knuckles, heads and chests at their centre, a shield on its face. */
function contactPoint(rig, solved, part, cells) {
  const src = solved.src, p = partIn(rig, part, src);
  // hands: the wrist (the IK end point); heads / chests: the centre; a shield: the middle of its face
  let uv = [p.w / 2, p.h / 2];
  if (/^hand_/.test(part)) uv = [p.pivot[0], p.pivot[1]];
  if (part === 'shield' && cells?.shield) uv = [(cells.shield.edge[0][0] + cells.shield.edge[1][0]) / 2, (cells.shield.edge[0][1] + cells.shield.edge[1][1]) / 2];
  return cellPoint(rig, solved, part, uv);
}
/** The shield's face line (its edge segment) in frame px. */
function shieldFace(rig, solved, cells) {
  return cells.shield.edge.map((uv) => cellPoint(rig, solved, 'shield', uv));
}
/** A point of a part's cell (u, v px) in frame px for a solved pose (mirror views flipped). */
function cellPoint(rig, solved, part, uv) {
  const src = solved.src, p = partIn(rig, part, src);
  const T = solved.world[part], v = poseOf(rig, solved.VP, part);
  const sx = (T.flip ? -1 : 1) * Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy);
  const lx = (uv[0] - p.pivot[0]) * sx, ly = (uv[1] - p.pivot[1]) * sy;
  const c = Math.cos(T.rot * D2R), s = Math.sin(T.rot * D2R);
  let x = T.x + lx * c - ly * s;
  const y = T.y + lx * s + ly * c;
  if (solved.flip) x = 2 * rig.root[0] - x;
  return [x, y];
}

/** The point of segment [a, b] at height y (clamped to the segment). */
function faceAtY([a, b], y) {
  const t = Math.abs(b[1] - a[1]) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (y - a[1]) / (b[1] - a[1])));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** The nearest point of segment [a, b] to q. */
function nearestOn([a, b], q) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}

/** Gap between a segment and a convex polygon (0 when they touch or overlap). */
function segPolyGap([a, b], poly) {
  if (inPoly(a, poly) || inPoly(b, poly)) return 0;
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (cross(a, b, p) * cross(a, b, q) < 0 && cross(p, q, a) * cross(p, q, b) < 0) return 0;
    d = Math.min(d, segDist(p, a, b), segDist(a, p, q), segDist(b, p, q));
  }
  return d;
}

/** Pose of a clip's keys at time t (0..1), tweened like animatePoses. */
function poseAtT(rig, keys, t) {
  const ks = keys.map((k) => ({ pose: resolvePose(rig, k), t: Number(k.t ?? 0), ease: k.ease || 'smooth' }));
  let i = ks.length - 1;
  while (i > 0 && ks[i].t > t + 1e-9) i--;
  const a = ks[i], b = ks[i + 1] || a;
  const u = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
  const e = b.ease === 'linear' ? u : b.ease === 'step' ? 0 : u * u * (3 - 2 * u);
  return lerpPose(rig, a.pose, b.pose, e);
}

/**
 * Fit a paired clip pair on the skeleton rig: rigid contacts (a shield on a chest) and contacts
 * marked fit move the offset so they meet at the contact start; hand contacts get IK targets (frame px, every drawn view)
 * on the partner's contact point at each attacker key inside the contact window. rigV: the victim's
 * rig when the partners have different proportions (per-skeleton takedowns; default the same rig).
 */
const FIT_STEP = 20; // offset grid: 1 / 20 body unit
/**
 * The forward offset (body units) minimising the worst contact gap max |ax - (vx + f k u)| over the
 * views. The worst gap is convex in f, so its minimum on a fixed absolute grid (multiples of 1/20 u,
 * independent of where the search starts) is found by widening the window around the start until the
 * minimum lies inside it; ties (a flat bottom) take the middle of the tied run. The result therefore
 * depends only on the gaps: refitting a fitted pair returns the same offset (idempotent).
 */
export function fitOffset(gaps, u, start) {
  const worst = (i) => { const f = i / FIT_STEP; let w = 0; for (const g of gaps) w = Math.max(w, Math.abs(g.ax - (g.vx + f * g.k * u))); return w; };
  const c = Math.round(start * FIT_STEP);
  for (let half = 40 * FIT_STEP; ; half *= 2) {
    const lo = c - half, hi = c + half;
    let bw = Infinity, b0 = lo, b1 = lo;
    for (let i = lo; i <= hi; i++) {
      const w = Math.round(worst(i) * 1e6) / 1e6; // 1e-6 px: no float noise in the comparison
      if (w < bw) { bw = w; b0 = b1 = i; } else if (w === bw && b1 === i - 1) b1 = i;
    }
    if ((b0 > lo && b1 < hi) || half >= 640 * FIT_STEP) return Math.round(((b0 + b1) >> 1)) / FIT_STEP;
  }
}

/** The partner's solved pose in its view (mirrored when the pair is staged in depth: partner_flip). */
const partnerSolve = (rigV, P, po) => { const s = solvePose(rigV, P, po.partner_view); return po.partner_flip ? { ...s, flip: !s.flip } : s; };

function fitPaired(rig, att, vic, cells, rigV = rig) {
  const m = att.melee, p = m.paired;
  const u = (rig.frame[1] - 4) / 98;
  // a rigid contact (a shield) or one marked fit sets the offset so the authored poses meet there;
  // hand contacts are then held by IK
  for (const c of p.contacts || []) {
    if (/^hand_/.test(c.attacker) && !c.fit) continue;
    const t = c.t[0];
    const AP = poseAtT(rig, att.keys, t), VP = poseAtT(rigV, vic.keys, t);
    // per screen-spread view: the attacker's point x and the victim's point x before the partner shift
    const gaps = [];
    for (const view of rig.views.filter((w) => HD_VIEWS.includes(w) && !/^(front|back)$/.test(w))) {
      const A = solvePose(rig, AP, view), V = solvePose(rigV, VP, turnedView(view, p.facing));
      const v = contactPoint(rigV, V, c.victim, cells);
      const a = c.attacker === 'shield' && cells?.shield ? faceAtY(shieldFace(rig, A, cells), v[1]) : contactPoint(rig, A, c.attacker, cells);
      const k = Math.cos(VIEW_YAW8[view] * D2R); // partner_dx per unit of forward offset (px / u)
      gaps.push({ ax: a[0], vx: v[0], k, w: view === 'side' ? 1 : 0 });
    }
    // the forward offset that minimises the worst gap over those views (side alone when only side)
    p.offset = [fitOffset(gaps, u, p.offset[0]), p.offset[1]];
  }
  vic.melee.paired.offset = p.offset;
  const views = rig.views.filter((v) => HD_VIEWS.includes(v));
  const reachTol = u * 4;
  // a key on every frame inside a hand contact window (the pose there unchanged), so the grip holds
  // frame by frame instead of drifting between keys
  const n = att.frames, times = new Set();
  for (const c of p.contacts || []) if (/^hand_/.test(c.attacker)) for (let f = frameOfT(c.t[0], n); f <= frameOfT(c.t[1], n); f++) times.add(Math.round((f / (n - 1)) * 1e6) / 1e6);
  const have = new Set(att.keys.map((k) => Math.round(k.t * 1e6) / 1e6));
  const extra = [...times].filter((t) => !have.has(t)).map((t) => ({ parts: poseAtT(rig, att.keys, t), t, ease: 'linear' }));
  if (extra.length) att.keys = [...att.keys, ...extra].sort((x, y) => x.t - y.t);
  for (const c of p.contacts || []) {
    if (!/^hand_/.test(c.attacker)) continue;
    const f0 = frameOfT(c.t[0], n), f1 = frameOfT(c.t[1], n);
    for (const k of att.keys) {
      const kf = k.t * (n - 1);
      if (kf < f0 - 1e-3 || kf > f1 + 1e-3) continue;
      const VP = poseAtT(rigV, vic.keys, k.t);
      for (const view of views) {
        const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
        const V = partnerSolve(rigV, VP, po);
        const [x, y] = contactPoint(rigV, V, c.victim, cells);
        const target = [Math.round((x + po.partner_dx) * 100) / 100, Math.round(y * 100) / 100];
        const bend = c.attacker === 'hand_b' ? (view === 'front' ? 1 : -1) : view === 'front' ? -1 : view === 'back' ? 1 : -1;
        let spec = { target, bend, weight: 1 }, full = null;
        // front / back: an arm reaching toward / away from the camera is foreshortened, so the planar
        // chain can fall short (a light attacker on a taller victim, a hand crossing the chest).
        // When the planar solve misses by more than the contact tolerance, two reaches are tried in
        // order and the closest is kept (ties keep the earlier): the arm extending in depth
        // (plane:"depth": the foreshortened bones lengthen toward full length), and the arm swung into
        // the frontal plane (both bones at full screen length, sy 1, planar IK: a hand reaching across
        // the body). Poses that reach keep the planar solve.
        if (view !== 'side' && rig.scaleChildren) {
          const chain = ikChain(rig, c.attacker);
          const keyWith = (sp, fl) => {
            const kk = structuredClone(k); kk.parts.views = kk.parts.views || {};
            const o = { ...(kk.parts.views[view] || {}), ik: { ...(kk.parts.views[view]?.ik || {}), [c.attacker]: sp } };
            if (fl) for (const b of chain) o[b] = { ...(o[b] || {}), sy: 1 };
            kk.parts.views[view] = o;
            return kk;
          };
          const miss = (sp, fl) => { const q = contactPoint(rig, solvePose(rig, poseAtT(rig, [keyWith(sp, fl)], 0), view), c.attacker, cells); return Math.hypot(q[0] - target[0], q[1] - target[1]); };
          let best = miss(spec, false);
          if (best > reachTol) {
            for (const [sp, fl] of [[{ ...spec, plane: 'depth' }, false], [spec, true]]) { const m = miss(sp, fl); if (m < best - 1e-6) { best = m; spec = sp; full = fl ? chain : null; } }
          }
        }
        if (view === 'side') k.parts.ik = { ...(k.parts.ik || {}), [c.attacker]: spec };
        else {
          k.parts.views = k.parts.views || {};
          k.parts.views[view] = { ...(k.parts.views[view] || {}), ik: { ...(k.parts.views[view]?.ik || {}), [c.attacker]: spec } };
          if (full) for (const b of full) k.parts.views[view][b] = { ...(k.parts.views[view][b] || {}), sy: 1 };
        }
      }
    }
  }
}

/**
 * Per-skeleton takedowns: refit a paired pair (retargeted to a skin's proportions, or attacker and
 * victim with different proportions) on their own rigs: the offset of fit / rigid contacts and the
 * hand IK targets inside the contact windows are solved again. Copies; -> {att, vic, offset}
 */
export function refitPaired(rigA, att, vic, cells, rigV = rigA) {
  const a = structuredClone(att), v = structuredClone(vic);
  // drop the hand IK targets the first fit put inside the contact windows (frame px of the old rigs):
  // the fit measures the authored poses again
  const n = a.frames;
  for (const c of a.melee.paired.contacts || []) {
    if (!/^hand_/.test(c.attacker)) continue;
    const f0 = frameOfT(c.t[0], n), f1 = frameOfT(c.t[1], n);
    for (const k of a.keys) {
      const kf = k.t * (n - 1);
      if (kf < f0 - 1e-3 || kf > f1 + 1e-3 || !k.parts) continue;
      if (k.parts.ik) { delete k.parts.ik[c.attacker]; if (!Object.keys(k.parts.ik).length) delete k.parts.ik; }
      for (const [vw, o] of Object.entries(k.parts.views || {})) {
        if (o.ik) { delete o.ik[c.attacker]; if (!Object.keys(o.ik).length) delete o.ik; }
        if (!Object.keys(o).length) delete k.parts.views[vw];
      }
      if (k.parts.views && !Object.keys(k.parts.views).length) delete k.parts.views;
    }
  }
  fitPaired(rigA, a, v, cells, rigV);
  return { att: a, vic: v, offset: a.melee.paired.offset };
}

// ---------- disarm transfer (gun disarm_front) ----------
const n180 = (r) => ((((r + 180) % 360) + 360) % 360) - 180;
/** Screen angle (deg) of a part in a solved frame, mirrored like the weapon sockets. */
function partRot(s, part) {
  let rot = s.world[part].rot;
  if (s.world[part].flip) rot = 180 - rot;
  if (s.flip) rot = 180 - rot;
  return n180(rot);
}
/**
 * Per-frame track of the disarmed gun of a paired pair with melee.paired.transfer, in the attacker's
 * frame px (no pad): {owner: victim | attacker | world, state: held | grabbed | dropped, x, y (the
 * gun's grip_main), rot (weapon-cell rotation, as the runtime weapon sockets), pitch (sheet
 * column)}. Before the transfer the gun is the victim's (its weapon solver socket); after it the
 * attacker's main hand carries it with the grip offset it had at the transfer (take), or it lies
 * where the victim's drop state puts it (drop).
 */
export function transferTrack(e, rig, def, att, vic, getClip, sk, view, rigV = rig, defV = def, lat = null) {
  const p = att.melee.paired, tr = p.transfer, n = att.frames;
  const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
  const A = clipFrames(e, rig, def, att, getClip, sk, view), V = clipFrames(e, rigV, defV, vic, getClip, sk, po.partner_view);
  const f0 = frameOfT(tr.t, n), fg = frameOfT(tr.grab ?? 0, n);
  const gunAt = (P, f) => { const s = partnerSolve(rigV, P, po); const q = socketOf(rigV, s, { order: [] }, { view: po.partner_view }); return { x: q.x + po.partner_dx + (lat ? lat[f] : 0), y: q.y, rot: q.rot, pitch: q.pitch, s }; };
  const handAt = (P) => { const s = solvePose(rig, P, view); const q = contactPoint(rig, s, tr.hand, null); return { x: q[0], y: q[1], rot: partRot(s, tr.hand) }; };
  // the gun's grip offset in the taking hand: where the victim's hand still holds it (the frame before the transfer)
  const fT = Math.max(0, f0 - 1), g0 = gunAt(V[fT], fT), h0 = handAt(A[fT]);
  const c0 = Math.cos(-h0.rot * D2R), s0 = Math.sin(-h0.rot * D2R);
  const off = [(g0.x - h0.x) * c0 - (g0.y - h0.y) * s0, (g0.x - h0.x) * s0 + (g0.y - h0.y) * c0], drot = g0.rot - h0.rot;
  const track = A.map((Pa, f) => {
    if (f < f0 || tr.mode === 'drop') {
      const g = gunAt(V[f], f);
      return f < f0 ? { owner: 'victim', state: f >= fg ? 'grabbed' : 'held', x: r1(g.x), y: r1(g.y), rot: r1(g.rot), pitch: g.pitch } : { owner: 'world', state: 'dropped', x: r1(g.x), y: r1(g.y), rot: r1(g.rot), pitch: g.pitch };
    }
    const h = handAt(Pa), c = Math.cos(h.rot * D2R), s = Math.sin(h.rot * D2R);
    return { owner: 'attacker', state: 'held', x: r1(h.x + off[0] * c - off[1] * s), y: r1(h.y + off[0] * s + off[1] * c), rot: r1(n180(drot + h.rot)), pitch: g0.pitch };
  });
  // how far the taking hand is from the gun's grip when it takes it (frame px)
  track.grip = r1(Math.hypot(g0.x - h0.x, g0.y - h0.y));
  return track;
}
/**
 * Disarm checks: the victim's hands let go after the transfer; take: the attacker's hand is at the
 * gun when it takes it (the gun then rides that hand); drop: the gun lands and lies still, and it
 * does not jump before the transfer.
 */
function checkTransfer(e, rig, def, att, vic, getClip, sk, views, tol, rigV = rig, defV = def) {
  const issues = [], p = att.melee.paired, tr = p.transfer, n = att.frames;
  const u = (rig.frame[1] - 4) / 98, jumpTol = Math.max(tol * 3, u * 12), gripTol = Math.max(tol * 3, u * 10);
  const f0 = frameOfT(tr.t, n), fFree = frameOfT(Math.min(1, tr.t + 0.08), n);
  let jump = 0, held = 0, released = true, grip = 0, rest = 0;
  for (const view of views) {
    const lat = deepView(rig, view) ? lateralFit(pairedTrack(e, rig, def, att, vic, getClip, sk, view, cellsOf(sk), rigV, defV), n) : null;
    const T = transferTrack(e, rig, def, att, vic, getClip, sk, view, rigV, defV, lat);
    // before the transfer the gun rides the victim's weapon socket: no frame-to-frame jumps
    for (let f = 1; f < f0; f++) jump = Math.max(jump, Math.hypot(T[f].x - T[f - 1].x, T[f].y - T[f - 1].y));
    if (tr.mode === 'take') grip = Math.max(grip, T.grip);
    // drop: once fallen (the last quarter) the gun lies still
    else for (let f = Math.max(f0 + 1, Math.round(n * 0.75)); f < n; f++) rest = Math.max(rest, Math.hypot(T[f].x - T[f - 1].x, T[f].y - T[f - 1].y));
    if (T.slice(0, f0).some((q) => q.owner !== 'victim') || T.slice(f0).some((q) => q.owner !== (tr.mode === 'drop' ? 'world' : 'attacker'))) issues.push(`${view}: transfer owners out of order`);
    held = Math.max(held, T.filter((q) => q.state === 'grabbed').length);
    // the victim's hands are off the gun once the release has played (take: the gun is hidden on the victim)
    const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
    const V = clipFrames(e, rigV, defV, vic, getClip, sk, po.partner_view);
    for (let f = fFree; f < n; f++) {
      const pl = solvePose(rigV, V[f], po.partner_view).weapon?.s?.pl;
      if (!pl || pl.lock.main >= 0.5 || pl.lock.support >= 0.5 || (tr.mode === 'take' && pl.hidden < 0.5)) released = false;
    }
  }
  if (grip > gripTol) issues.push(`the taking hand is ${r1(grip)} px from the gun at the transfer (tolerance ${r1(gripTol)})`);
  if (rest > tol) issues.push(`the dropped gun still moves ${r1(rest)} px per frame at the end (tolerance ${r1(tol)})`);
  if (jump > jumpTol) issues.push(`disarmed gun jumps ${r1(jump)} px between frames (tolerance ${r1(jumpTol)})`);
  if (!released) issues.push('the victim still holds the gun after the transfer');
  if (!held) issues.push('the gun is never grabbed before the transfer');
  return { issues, metrics: { transfer_frame: f0, transfer_mode: tr.mode, transfer_jump_px: r1(jump), transfer_jump_tolerance_px: r1(jumpTol), ...(tr.mode === 'take' ? { transfer_grip_px: r1(grip), transfer_grip_tolerance_px: r1(gripTol) } : { drop_rest_px: r1(rest) }), victim_released: released } };
}

// ---------- shared clip evaluation ----------
/** Frame poses of a skeleton clip on a rig (the batch pipeline: eval + plant + secondary + depth). */
function clipFrames(e, rig, def, clip, getClip, sk, view) {
  const ev = evalClip(rig, clip, getClip, sk);
  const a = { animation: `${clip.name}_${view}`, view, _poses: ev.poses, frames: ev.poses.length, loop: ev.loop, fps: ev.fps, ...(clip.plant !== undefined ? { plant: clip.plant } : {}), ...(clip.secondary !== undefined ? { secondary: clip.secondary } : {}), ...((clip.ground ?? !!clip.melee) ? { ground: true } : {}) };
  return framePoses(e, rig, def, a).poses;
}
/** Sub-frame poses: the clip evaluated k times denser (raw keys; arms and weapon are what the sweep needs). */
function subPoses(rig, clip, getClip, sk, k) {
  const n = clip.frames;
  const dense = { ...clip, frames: (n - 1) * k + 1 };
  return evalClip(rig, dense, getClip, sk).poses;
}

/**
 * Manifest melee block for one batch anim (called by anim_batch): events with frames, phases,
 * hit volumes per active frame in the set's frame px (pad), swept polygons, body-space volumes,
 * root motion, paired offsets for this view, weapon sockets. -> object | null
 */
export function meleeBatchAnim(e, { skin, sk, rig, def, clip, view, poses, pad, getClip }) {
  if (!clip?.melee) return null;
  const k = SWEEP_SUB;
  const sources = hitSources(rig, clip.melee, cellsOf(sk));
  let sub = null;
  if (sources.length && clip.melee.active?.length) {
    const sp = subPoses(rig, clip, getClip, sk, k);
    sub = { k, caps: sp.map((P) => frameVolumes(rig, P, view, sources).caps) };
  }
  const { anim } = meleeAnim(rig, poses, view, clip.melee, { pad, cell: cellsOf(sk), sub });
  if (sk.melee?.weapon && rig.parts.weapon) {
    const socket = poses.map((P) => weaponSocket(rig, P, view, pad));
    if (socket.some((q) => !q.hidden)) anim.socket = socket;
  }
  const pp = clip.melee.paired;
  const att = pp && def ? (pp.role === 'attacker' ? clip : getClip(pp.partner)) : null, vic = pp && def ? (pp.role === 'attacker' ? getClip(pp.partner) : clip) : null;
  if (att && vic) {
    const aView = pp.role === 'attacker' ? view : turnedView(view, -pp.facing);
    // front / back: the partner's per-frame sideways staging that makes the contacts meet (lateralFit)
    const lat = deepView(rig, aView) ? lateralFit(pairedTrack(e, rig, def, att, vic, getClip, sk, aView, cellsOf(sk)), att.frames) : null;
    if (lat && anim.paired && lat.some((v) => v)) anim.paired.partner_dx_track = lat.map((v) => r1(anim.paired.partner_dx + (pp.role === 'attacker' ? v : -v)));
    // gun disarm: the disarmed gun's track for the runtime weapon layers of both actors (this clip's frame)
    if (pp.transfer && rig.weapon) {
      const po = pairedOut(rig, { ...att.melee.paired, role: 'attacker' }, aView, 2);
      const dx = (f) => (pp.role === 'attacker' ? 0 : -(po.partner_dx + (lat ? lat[f] : 0)));
      anim.transfer = { mode: pp.transfer.mode, frame: frameOfT(pp.transfer.t, clip.frames), track: transferTrack(e, rig, def, att, vic, getClip, sk, aView, rig, def, lat).map((q, f) => ({ ...q, x: r1(q.x + dx(f) + pad[0]), y: r1(q.y + pad[1]) })) };
    }
  }
  return anim;
}

/** The held melee weapon's socket in a frame: grip px (+pad), screen angle of its axis, length scale, draw order. */
export function weaponSocket(rig, P, view, pad = [0, 0, 0, 0]) {
  const s = solvePose(rig, P, view), src = s.src;
  const v = poseOf(rig, s.VP, 'weapon'), T = s.world.weapon;
  if (v.hide || partIn(rig, 'weapon', src).hidden) return { hidden: true };
  let x = T.x, rot = T.rot;
  if (T.flip) rot = 180 - rot;
  if (s.flip) { x = 2 * rig.root[0] - x; rot = 180 - rot; }
  rot = ((((rot + 180) % 360) + 360) % 360) - 180;
  const z = (n) => poseOf(rig, s.VP, n).z ?? partIn(rig, n, src).z;
  const order = z('weapon') < z('chest') ? 'behind' : 'between';
  // elevation in the base view (the sheet column the engine picks: nearest pitch)
  const sd = view === 'side' ? s : solvePose(rig, P, 'side');
  const Ts = sd.world.weapon;
  const pitch = -(((Ts.flip ? 180 - Ts.rot : Ts.rot) + 540) % 360 - 180);
  return { x: r1(x + pad[0]), y: r1(T.y + pad[1]), rot: r1(rot), pitch: r1(Math.max(-90, Math.min(90, pitch))), scale: r1(Math.abs(v.sx)), order };
}

// ---------- validation ----------
/**
 * Check one melee clip on a rig: event order, active frames, hit before windup, sweep coverage of
 * the weapon path (sub-frames k=8 inside the frame capsules / swept polygons), per view.
 */
function checkClip(e, rig, def, clip, getClip, sk, views, tol) {
  const issues = [];
  const m = clip.melee, n = clip.frames;
  const { events, windows, phase } = meleeEvents(m, n);
  const attack = (m.hits || []).length > 0;
  const metrics = { frames: n, windows: windows.length };
  if (attack) {
    if (!windows.length) issues.push('no active window');
    windows.forEach(([a, b], i) => { if (b < a) issues.push(`active window ${i} is empty`); });
    const wu = events.find((x) => x.name === 'windup');
    if (!wu) issues.push('no windup event');
    // event order per hit: windup < active_start <= impact <= active_end < recovery
    windows.forEach((w, i) => {
      const at = (name) => events.find((x) => x.name === name && x.hit === i)?.frame;
      const s = at('active_start'), imp = at('impact'), en = at('active_end'), rec = at('recovery');
      if (wu && !(wu.frame < s)) issues.push(`hit ${i}: windup (frame ${wu.frame}) is not before active_start (${s})`);
      if (imp !== undefined && !(s <= imp && imp <= en)) issues.push(`hit ${i}: impact ${imp} outside active ${s}..${en}`);
      if (rec !== undefined && !(en < rec)) issues.push(`hit ${i}: recovery ${rec} not after active_end ${en}`);
      if (i > 0 && !(windows[i - 1][1] < s)) issues.push(`hit ${i}: overlaps hit ${i - 1}`);
    });
    // every impact lands inside an active window
    for (const t of m.impact || []) { const f = frameOfT(t, n); if (!windows.some(([w0, w1]) => f >= w0 && f <= w1)) issues.push(`impact at frame ${f} outside active windows ${JSON.stringify(windows)}`); }
    // no hit volume before the windup has played (the first active frame is past the windup end)
    const wEnd = m.windup ? frameOfT(m.windup[1], n) : -1;
    const firstActive = phase.indexOf('active');
    if (firstActive >= 0 && firstActive < Math.min(wEnd, frameOfT(m.windup?.[0] ?? 0, n) + 1)) issues.push(`hit volume at frame ${firstActive}, before the windup`);
    metrics.first_active = firstActive;
    // coverage: the edge line at 16 sub-steps between active frames lies inside the frame
    // capsules or the swept polygon (r + tol)
    const k = SWEEP_SUB * 2;
    const sources = hitSources(rig, m, cellsOf(sk));
    const dense = subPoses(rig, clip, getClip, sk, k);
    let worst = 0, checked = 0;
    for (const view of views) {
      const poses = clipFrames(e, rig, def, clip, getClip, sk, view);
      const { anim } = meleeAnim(rig, poses, view, m, { cell: cellsOf(sk), sub: { k: SWEEP_SUB, caps: subPoses(rig, clip, getClip, sk, SWEEP_SUB).map((P) => frameVolumes(rig, P, view, sources).caps) } });
      const byFrame = new Map((anim.hits || []).map((h) => [h.frame, h]));
      const denseCaps = dense.map((P) => frameVolumes(rig, P, view, sources).caps);
      for (const [a, b] of windows) for (let f = a + 1; f <= b; f++) {
        const H = byFrame.get(f), H0 = byFrame.get(f - 1);
        if (!H || !H0) continue;
        for (let j = 0; j <= k; j++) {
          const caps = denseCaps[(f - 1) * k + j];
          caps.forEach((c, si) => {
            if (!c) return;
            const vol = H.volumes.find((x) => x.source === sources[si].part), vol0 = H0.volumes.find((x) => x.source === sources[si].part);
            if (!vol || !vol0) return;
            for (const q of [c.a, c.b, [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]]) {
              checked++;
              const d = Math.min(segDist(q, vol.a, vol.b), segDist(q, vol0.a, vol0.b)) - vol.r;
              const inside = d <= tol || (vol.sweep && inPoly(q, vol.sweep, vol.r + tol));
              if (!inside) worst = Math.max(worst, d);
            }
          });
        }
      }
    }
    metrics.sweep_points = checked;
    metrics.sweep_miss_px = r1(worst);
    if (worst > tol) issues.push(`weapon path leaves the hit volumes by ${r1(worst)} px`);
  }
  // ground contact: no foot or hand drawn below the view's ground row, in any view (every melee clip)
  const feet = rig.feet || ['foot_f', 'foot_b'], ends = groundEnds(rig);
  const sink = { foot: [0, ''], hand: [0, ''] };
  for (const view of views) {
    const g = groundRow(rig, view, feet);
    clipFrames(e, rig, def, clip, getClip, sk, view).forEach((P, f) => {
      const s = solvePose(rig, P, view);
      for (const n of ends) { const d = (footLow(rig, s, n) ?? -Infinity) - g, w = sink[endKind(n)]; if (d > w[0]) { w[0] = d; w[1] = `${n}, ${view} frame ${f}`; } }
    });
  }
  metrics.foot_sink_px = r1(sink.foot[0]);
  metrics.hand_sink_px = r1(sink.hand[0]);
  for (const k of ['foot', 'hand']) if (sink[k][0] > tol) issues.push(`a ${k} sinks ${r1(sink[k][0])} px below the ground (${sink[k][1]})`);
  return { issues, metrics };
}

/** Feet (bottom centre of each foot cell) and contact points of a paired pair, per frame, in the attacker's frame px. */
function pairedTrack(e, rig, def, att, vic, getClip, sk, view, cells, rigV = rig, defV = def) {
  const p = att.melee.paired;
  const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
  const A = clipFrames(e, rig, def, att, getClip, sk, view), V = clipFrames(e, rigV, defV, vic, getClip, sk, po.partner_view);
  const feet = rig.feet || ['foot_f', 'foot_b'], feetV = rigV.feet || ['foot_f', 'foot_b'];
  const foot = (r, solved, n, dx) => { const q = contactPoint(r, solved, n, cells); const pp = partIn(r, n, solved.src); return [q[0] + dx, solved.world[n].y + (pp.h - 1 - pp.pivot[1])]; };
  // each actor's drawn foot rows against its own rig's ground row in the view it is drawn in
  const gA = groundRow(rig, view, feet), gV = groundRow(rigV, po.partner_view, feetV);
  const sinkOf = (r, solved, fs, g) => Object.fromEntries(groundEnds(r).map((n) => [n, (footLow(r, solved, n) ?? -Infinity) - g]));
  return A.map((Pa, f) => {
    const sa = solvePose(rig, Pa, view), sv = partnerSolve(rigV, V[f], po);
    return {
      sink: { a: sinkOf(rig, sa, feet, gA), v: sinkOf(rigV, sv, feetV, gV) },
      a: Object.fromEntries(feet.map((n) => [n, foot(rig, sa, n, 0)])), v: Object.fromEntries(feet.map((n) => [n, foot(rigV, sv, n, po.partner_dx)])),
      contacts: (p.contacts || []).map((c) => {
        const q = contactPoint(rigV, sv, c.victim, cells), v = [q[0] + po.partner_dx, q[1]];
        if (c.attacker === 'shield' && cells?.shield) {
          // a shield meets the victim with its face: the gap between the face line and the victim
          // part's cell outline (0 when they touch or overlap)
          const face = shieldFace(rig, sa, cells);
          const pp = partIn(rigV, c.victim, sv.src);
          const box = [[0, 0], [pp.w, 0], [pp.w, pp.h], [0, pp.h]].map((uv) => { const k = cellPoint(rigV, sv, c.victim, uv); return [k[0] + po.partner_dx, k[1]]; });
          return { c, a: nearestOn(face, v), v, gap: segPolyGap(face, box) };
        }
        return { c, a: contactPoint(rig, sa, c.attacker, cells), v };
      }),
    };
  });
}

/**
 * Front / back views: the partners stand in depth on one screen column, and the mirrored side views
 * swap a character's handedness (a 2.5D arm swings in the side plane, it cannot reach across the
 * body), so the partner is staged sideways (screen x) until the contact points meet: each contact
 * window gets the midrange of its screen x gaps, frames between windows ease (smoothstep), frames
 * before the first / after the last hold. -> per-frame px added to partner_dx in that view (all 0
 * when the clip has no contacts)
 */
export function lateralFit(tr, n) {
  const wins = [];
  (tr[0]?.contacts || []).forEach((c0, i) => {
    const f0 = frameOfT(c0.c.t[0], n), f1 = Math.min(tr.length - 1, frameOfT(c0.c.t[1], n));
    let lo = Infinity, hi = -Infinity;
    for (let f = f0; f <= f1; f++) { const c = tr[f].contacts[i]; if (c.gap !== undefined) continue; const d = c.a[0] - c.v[0]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    if (lo !== Infinity) wins.push({ f0, f1, v: (lo + hi) / 2 });
  });
  if (!wins.length) return tr.map(() => 0);
  wins.sort((a, b) => a.f0 - b.f0 || a.f1 - b.f1);
  return tr.map((_, f) => {
    const inside = wins.filter((w) => f >= w.f0 && f <= w.f1);
    if (inside.length) return r1(inside.reduce((s, w) => s + w.v, 0) / inside.length);
    const prev = wins.filter((w) => w.f1 < f).pop(), next = wins.find((w) => w.f0 > f);
    if (!prev) return r1(next.v);
    if (!next) return r1(prev.v);
    const t = (f - prev.f1) / (next.f0 - prev.f1), s = t * t * (3 - 2 * t);
    return r1(prev.v + (next.v - prev.v) * s);
  });
}
const latMax = (L) => L.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
const deepView = (rig, view) => /^(front|back)$/.test(rig.mirror[view] || view);

/**
 * Paired alignment: planted feet do not slide (each actor and against each other), contacts meet in
 * every view. Front / back views overlap the partners on screen, so their contacts are measured in
 * 3D: screen x / y of that view + the depth (the forward gap) from the side view.
 */
function checkPaired(e, rig, def, att, vic, getClip, sk, views, tol, cells, rigV = rig, defV = def) {
  const issues = [];
  const n = att.frames;
  if (vic.frames !== n) issues.push(`attacker ${n} frames, victim ${vic.frames}`);
  const ground = solvePose(rig, {}, 'side');
  const gy = Math.max(...(rig.feet || ['foot_f', 'foot_b']).map((f) => { const pp = partIn(rig, f, 'side'); return ground.world[f].y + pp.h - 1 - pp.pivot[1]; }));
  const contactTol = Math.max(tol * 2, ((rig.frame[1] - 4) / 98) * 4);
  let slide = 0, rel = 0, worstContact = 0;
  const sink = { foot: [0, ''], hand: [0, ''] };
  const byView = {}, lateral = {};
  let sideTr = null;
  const sideTrack = () => sideTr || (sideTr = pairedTrack(e, rig, def, att, vic, getClip, sk, 'side', cells, rigV, defV));
  // after the release frame the victim is free (a fall): its feet may drag, they only must not sink
  const release = att.melee.paired.release !== undefined ? frameOfT(att.melee.paired.release, n) : n;
  for (const view of views) {
    const tr = pairedTrack(e, rig, def, att, vic, getClip, sk, view, cells, rigV, defV);
    if (view === 'side') sideTr = tr;
    const planted = (q) => q[1] >= gy - 1.5;
    // no foot of either actor drawn below its ground row, in every view
    for (let f = 0; f < tr.length; f++) for (const who of ['a', 'v']) for (const [ft, d] of Object.entries(tr[f].sink[who])) { const w = sink[endKind(ft)]; if (d > w[0]) { w[0] = d; w[1] = `${who === 'a' ? 'attacker' : 'victim'} ${ft}, ${view} frame ${f}`; } }
    if (view === 'side') {
      for (let f = 1; f < tr.length; f++) for (const who of ['a', 'v']) for (const [ft, q] of Object.entries(tr[f][who])) {
        const q0 = tr[f - 1][who][ft];
        if (who === 'v' && f > release) continue;
        if (planted(q) && planted(q0)) slide = Math.max(slide, Math.abs(q[0] - q0[0]));
      }
      // against each other: the gap between any attacker foot and any victim foot that are both
      // planted on two consecutive frames stays the same (until the release)
      for (let f = 1; f <= Math.min(release, tr.length - 1); f++) for (const [fa, qa] of Object.entries(tr[f].a)) for (const [fv, qv] of Object.entries(tr[f].v)) {
        const qa0 = tr[f - 1].a[fa], qv0 = tr[f - 1].v[fv];
        if (planted(qa) && planted(qa0) && planted(qv) && planted(qv0)) rel = Math.max(rel, Math.abs((qa[0] - qv[0]) - (qa0[0] - qv0[0])));
      }
    }
    // front / back: the partners stand in depth and overlap on screen: the screen gap of this view
    // plus the depth gap (forward axis) from the side view
    const deep = deepView(rig, view), lat = deep ? lateralFit(tr, n) : null;
    if (deep) lateral[view] = latMax(lat);
    let vw = 0;
    for (let f = 0; f < tr.length; f++) tr[f].contacts.forEach((c, i) => {
      if (f < frameOfT(c.c.t[0], n) || f > frameOfT(c.c.t[1], n)) return;
      let d = c.gap ?? Math.hypot(c.a[0] - c.v[0], c.a[1] - c.v[1]);
      if (deep) { const s = sideTrack()[f].contacts[i]; d = c.gap !== undefined ? Math.hypot(c.gap, s.gap ?? 0) : Math.hypot(c.a[0] - c.v[0] - lat[f], c.a[1] - c.v[1], s.a[0] - s.v[0]); }
      vw = Math.max(vw, d);
    });
    byView[view] = r1(vw);
    worstContact = Math.max(worstContact, vw);
  }
  if (slide > tol) issues.push(`a planted foot slides ${r1(slide)} px`);
  if (rel > tol) issues.push(`feet slide against each other by ${r1(rel)} px`);
  for (const k of ['foot', 'hand']) if (sink[k][0] > tol) issues.push(`a ${k} sinks ${r1(sink[k][0])} px below the ground (${sink[k][1]})`);
  for (const [v, d] of Object.entries(byView)) if (d > contactTol) issues.push(`${v}: contact points ${d} px apart${/^(front|back)$/.test(rig.mirror[v] || v) ? ' in 3D (screen + side-view depth)' : ''} (tolerance ${r1(contactTol)})`);
  const metrics = { foot_slide_px: r1(slide), feet_relative_px: r1(rel), foot_sink_px: r1(Math.max(0, sink.foot[0])), hand_sink_px: r1(Math.max(0, sink.hand[0])), contact_px: r1(worstContact), contact_tolerance_px: r1(contactTol), contact_by_view: byView, ...(Object.keys(lateral).length ? { lateral_px: lateral } : {}), ...(release < n ? { release_frame: release } : {}) };
  if (att.melee.paired.transfer && rig.weapon) { const t = checkTransfer(e, rig, def, att, vic, getClip, sk, views, tol, rigV, defV); issues.push(...t.issues); Object.assign(metrics, t.metrics); }
  return { issues, metrics };
}

// ---------- world sheets ----------
/** Render a melee weapon's world sheet through art_model render: cells [view][pitch], grip fixed, edge per cell. */
function weaponSheet(e, id, { frame = [64, 96], pitch = MELEE_PITCH, views = MELEE_SHEET_VIEWS, outline = '#15161a', model } = {}, source) {
  const W = meleeWeapon(id);
  if (!W) throw new Error(`unknown melee weapon "${id}" (${MELEE_IDS.join(', ')})`);
  const name = model ?? `melee_${id}`;
  if (!modelExists(e, name)) e.run('model_create', { name, template: `melee_${id}` }, source);
  const pxPerM = (frame[1] - 4) / 1.8;
  const zoom = pxPerM / 100; // model units are cm
  const S = 2 * Math.ceil(W.length_cm * zoom * (W.shield ? 0.75 : 1)) + 10;
  const angles = [];
  for (const v of views) for (const p of pitch) angles.push({ yaw: VIEW_MODEL_YAW[v], pitch: p });
  const canvas = `_melee_sheet_${id}`;
  const r = e.run('model_render', { name, canvas, camera: { yaw: 0, pitch: 0 }, zoom, size: [S, S], angles, outline, light: { dir: [-0.5, 0.7, 0.6], ambient: 0.45 } }, source);
  const d = e.docs.get(r.canvas);
  const anchors = d.meta.anchors[r.animation];
  const imgs = angles.map((_, i) => d.frameData(r.frames[0] + i));
  e.docs.delete(r.canvas);
  // grip on one pixel in every cell
  const G = [Math.floor(S / 2), Math.floor(S / 2)];
  const shifted = imgs.map((img, i) => {
    const g = anchors[i].socket_grip, dx = Math.round(G[0] - g[0]), dy = Math.round(G[1] - g[1]);
    const out = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const sx = x - dx, sy = y - dy; if (sx < 0 || sy < 0 || sx >= S || sy >= S) continue; const o = (sy * S + sx) * 4; if (img[o + 3]) out.set(img.subarray(o, o + 4), (y * S + x) * 4); }
    return { img: out, dx, dy };
  });
  let ub = null;
  for (const { img } of shifted) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (img[(y * S + x) * 4 + 3]) { if (!ub) ub = [x, y, x, y]; else { ub[0] = Math.min(ub[0], x); ub[1] = Math.min(ub[1], y); ub[2] = Math.max(ub[2], x); ub[3] = Math.max(ub[3], y); } }
  ub = ub || [G[0] - 2, G[1] - 2, G[0] + 2, G[1] + 2];
  const x0 = Math.min(ub[0], G[0]) - 1, y0 = Math.min(ub[1], G[1]) - 1, fw = Math.max(ub[2], G[0]) - x0 + 2, fh = Math.max(ub[3], G[1]) - y0 + 2;
  const cells = shifted.map(({ img }) => { const o = new Uint8ClampedArray(fw * fh * 4); for (let y = 0; y < fh; y++) o.set(img.subarray(((y0 + y) * S + x0) * 4, ((y0 + y) * S + x0 + fw) * 4), y * fw * 4); return o; });
  const grip = [G[0] - x0, G[1] - y0];
  const at = (i, n) => { const q = anchors[i][`socket_${n}`]; if (!q) return null; return [r1(q[0] + shifted[i].dx - x0), r1(q[1] + shifted[i].dy - y0)]; };
  const meta = views.map((v, vi) => pitch.map((p, pi) => {
    const i = vi * pitch.length + pi;
    const tip = at(i, 'tip'), a = at(i, 'edge_a'), b = at(i, 'edge_b'), st = at(i, 'strike');
    const angle = tip ? r1(Math.atan2(tip[1] - grip[1], tip[0] - grip[0]) / D2R) : 0;
    return { edge: [a, b], tip, strike: st, angle, length: tip ? r1(Math.hypot(tip[0] - grip[0], tip[1] - grip[1])) : 0 };
  }));
  return { cells, frame: [fw, fh], grip, meta, px_per_m: r1(pxPerM), views, pitch };
}
function modelExists(e, name) { try { e.run('model_info', { name }); return true; } catch { return false; } }

/** Rows = views, columns = pitch. */
function sheetPNG(cells, [fw, fh], cols) {
  const rows = Math.ceil(cells.length / cols), W = cols * fw, H = rows * fh, out = new Uint8ClampedArray(W * H * 4);
  cells.forEach((img, i) => { const cx = (i % cols) * fw, cy = Math.floor(i / cols) * fh; for (let y = 0; y < fh; y++) out.set(img.subarray(y * fw * 4, (y + 1) * fw * 4), ((cy + y) * W + cx) * 4); });
  return { W, H, data: out };
}

export const MELEE_OPS = {
  /**
   * Install the melee clip set on a skeleton: weapon cell (weapon:"combat_knife" ...), shield part
   * (shield:true), strikes / combos for the weapon (or butt-stroke / pistol whip on gun skeletons),
   * kick, shove, block, parry, hit / stagger reactions x4, knockdown, get-up, paired takedowns.
   */
  anim_melee(a) {
    const sk = loadSkeleton(this, a.skeleton);
    const weapon = a.weapon === undefined ? sk.melee?.weapon : a.weapon;
    const shield = a.shield === undefined ? !!sk.melee?.shield : !!a.shield;
    if (weapon && !meleeWeapon(weapon)) throw new Error(`weapon "${weapon}": melee weapons are ${MELEE_IDS.join(', ')}`);
    if (weapon && meleeWeapon(weapon).shield) throw new Error('riot_shield goes in the support hand: shield:true (with weapon:"baton" etc. in the main hand)');
    if (weapon && sk.def.weapon) throw new Error(`skeleton "${sk.name}" holds a ${sk.def.weapon.class}: melee on a gun skeleton uses the gun (butt-stroke / pistol whip); make a separate skeleton for a melee weapon`);
    const mp = meleeParts(sk.def, { weapon, shield });
    const def = structuredClone(sk.def);
    for (const [n, p] of Object.entries(mp.parts)) def.parts[n] = p;
    sk.def = def;
    if (mp.parts.shield) for (const m of ['upper', 'arms', 'all']) if (sk.masks[m] && !sk.masks[m].includes('shield')) sk.masks[m] = [...sk.masks[m], 'shield'];
    sk.melee = { ...(weapon ? { weapon, cell: mp.cell } : {}), ...(shield ? { shield: true, shield_cell: mp.shieldCell } : {}), kind: undefined };
    if (a.disarm !== undefined && !['take', 'drop'].includes(a.disarm)) throw new Error('disarm must be "take" (the attacker takes the gun, default) or "drop" (it falls) for the gun disarm_front');
    if (a.disarm !== undefined && !sk.def.weapon) throw new Error('disarm:"take"|"drop" is for gun skeletons (melee sets disarm the weapon by dropping it)');
    const lib = meleeLibrary(def, { weapon, shield, clips: a.clips, disarm: a.disarm });
    sk.melee.kind = lib.kind;
    const rig = normalizeRig(def);
    // paired: fit offsets and hand contacts on this skeleton
    const byName = new Map(lib.clips.map((c) => [c.name, c]));
    for (const c of lib.clips) if (c.melee.paired?.role === 'attacker' && byName.get(c.melee.paired.partner)) fitPaired(rig, c, byName.get(c.melee.paired.partner), cellsOf(sk));
    // every conflict and every clip is checked / built before anything is written (no partial installs)
    if (!a.overwrite) for (const c of lib.clips) { const old = loadClip(this, sk.name, c.name); if (old && !old.melee) throw new Error(`skeleton "${sk.name}" already has a non-melee clip "${c.name}" (overwrite:true replaces it)`); }
    const getClip = (n) => byName.get(n) ?? loadClip(this, sk.name, n);
    const built = lib.clips.map((c) => { normalizeMelee(c.melee, rig); return [c.name, normalizeClip(c, rig, sk, getClip)]; });
    writeJSON(libDir(this, 'skeletons', `${sk.name}.json`), sk);
    const saved = [];
    for (const [name, clip] of built) { writeJSON(clipFile(this, sk.name, name), clip); saved.push(name); }
    return {
      skeleton: sk.name, set: lib.kind, ...(weapon ? { weapon, cell: { w: mp.cell.w, h: mp.cell.h, pivot: mp.cell.pivot, edge: mp.cell.edge } } : {}), ...(shield ? { shield: { w: mp.shieldCell.w, h: mp.shieldCell.h } } : {}),
      clips: saved, paired: saved.filter((n) => n.endsWith('_attacker')).map((n) => n.slice(0, -9)),
      next: `art_anim skin {name, skeleton:"${sk.name}"} (draw ${weapon ? 'the weapon cell pointing RIGHT, edge on the bottom, ' : ''}${shield ? 'the shield: face in front views, edge strip in side views, ' : ''}cells), melee_check {skeleton:"${sk.name}"}, batch -> anim.melee in the manifest`,
    };
  },

  /** Validate melee clips: event order, active frames, no hit before the windup, sweep coverage, paired alignment. */
  anim_melee_check(a) {
    const skinDef = a.skin !== undefined ? loadSkin(this, a.skin) : null;
    const sk = loadSkeleton(this, a.skeleton ?? skinDef?.skeleton);
    let rig, def;
    let getClip = (n) => loadClip(this, sk.name, n);
    if (skinDef) {
      const skin = skinDef;
      ({ rig, def } = getRig(this, skin.rig));
      if (skin.proportions && Object.keys(skin.proportions).length) { const raw = getClip; getClip = (n) => { const c = raw(n); return c ? retargetClip(c, sk.def, def, skin.map).clip : null; }; }
    } else { def = sk.def; rig = normalizeRig(def); }
    // per-skeleton takedowns: a victim skin with its own proportions; paired pairs are refit on the two rigs
    const vSkin = a.victim_skin !== undefined ? loadSkin(this, a.victim_skin, 'victim_skin') : null;
    let rigV = rig, defV = def, getClipV = getClip;
    if (vSkin) {
      if (vSkin.skeleton !== sk.name) throw new Error(`victim_skin "${a.victim_skin}" is on skeleton "${vSkin.skeleton}", not "${sk.name}"`);
      ({ rig: rigV, def: defV } = getRig(this, vSkin.rig));
      const raw = (n) => loadClip(this, sk.name, n);
      getClipV = vSkin.proportions && Object.keys(vSkin.proportions).length ? (n) => { const c = raw(n); return c ? retargetClip(c, sk.def, defV, vSkin.map).clip : null; } : raw;
    }
    const propOf = (s) => (s?.proportions && Object.keys(s.proportions).length ? s.proportions : null);
    const refit = !!(propOf(skinDef) || propOf(vSkin));
    const tol = a.tolerance ?? 2;
    if (!(typeof tol === 'number' && Number.isFinite(tol) && tol >= 0)) throw new Error(`"tolerance" must be a finite number >= 0 px (got ${JSON.stringify(a.tolerance)})`);
    const asked = a.clips !== undefined ? [].concat(a.clips) : null;
    if (asked) for (const n of asked) checkName(n, 'clip');
    const names = (asked ?? listClips(this, sk.name)).filter((n) => getClip(n)?.melee);
    if (!names.length) throw new Error(`skeleton "${sk.name}" has no melee clips (art_anim melee {skeleton:"${sk.name}"})`);
    const views = a.views ? [].concat(a.views) : rig.views.filter((v) => HD_VIEWS.includes(v));
    const cells = cellsOf(sk);
    const clips = {};
    let fails = 0;
    for (const n of names) {
      let clip = getClip(n);
      const p = clip.melee.paired;
      let vic = p?.role === 'attacker' ? getClipV(p.partner) : null, refitOffset = null;
      if (p?.role === 'attacker' && vic && refit) { const f = refitPaired(rig, clip, vic, cells, rigV); clip = f.att; vic = f.vic; refitOffset = f.offset; }
      const r = checkClip(this, rig, def, clip, getClip, sk, views, tol);
      if (p?.role === 'attacker') {
        if (!vic) r.issues.push(`paired partner "${p.partner}" missing`);
        else { const pr = checkPaired(this, rig, def, clip, vic, getClip, sk, views, tol, cells, rigV, defV); r.issues.push(...pr.issues); Object.assign(r.metrics, pr.metrics); }
        if (refitOffset) r.metrics.refit_offset = refitOffset;
      }
      if (r.issues.length) fails++;
      clips[n] = { pass: !r.issues.length, ...r.metrics, ...(r.issues.length ? { issues: r.issues } : {}) };
    }
    return { skeleton: sk.name, ...(a.skin ? { skin: a.skin } : {}), ...(vSkin ? { victim_skin: a.victim_skin } : {}), ...(refit ? { refit: 'paired pairs solved on the skins\' proportions (offset + hand IK)' } : {}), pass: fails === 0, clips_checked: names.length, failing: fails, tolerance_px: tol, views, clips };
  },

  /** World sheets of melee weapons (rows = views, columns = pitch, grip on one pixel) + manifest/melee_weapons.json. */
  anim_melee_sheet(a, source) {
    const ids = a.weapons ? [].concat(a.weapons) : a.weapon ? [a.weapon] : MELEE_IDS;
    const out = this.resolvePath(a.out ?? 'assets', this.exportDir);
    const frame = a.frame ?? [64, 96];
    if (!(Array.isArray(frame) && frame.length === 2 && frame.every((v) => Number.isInteger(v) && v > 0 && v <= 1024))) throw new Error(`"frame" must be [w, h]: two positive integers <= 1024 (got ${JSON.stringify(a.frame)})`);
    const pitch = a.pitch ?? MELEE_PITCH;
    if (!(Array.isArray(pitch) && pitch.length && pitch.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90))) throw new Error(`"pitch" must be a non-empty list of degrees in -90..90 (got ${JSON.stringify(a.pitch)})`);
    if (a.model !== undefined) checkName(a.model, 'model');
    for (const id of ids) if (!meleeWeapon(id)) throw new Error(`unknown melee weapon ${JSON.stringify(id)} (${MELEE_IDS.join(', ')})`);
    const mf = path.join(out, 'manifest', 'melee_weapons.json');
    const man = fs.existsSync(mf) ? readJSON(mf) : {};
    man.melee_world = man.melee_world || {};
    const report = {};
    for (const id of ids) {
      const s = weaponSheet(this, id, { frame, pitch, outline: a.outline === undefined ? '#15161a' : a.outline, model: a.model }, source);
      const img = sheetPNG(s.cells, s.frame, pitch.length);
      const file = `weapons_melee/${id}.png`;
      fs.mkdirSync(path.join(out, 'weapons_melee'), { recursive: true });
      fs.writeFileSync(path.join(out, file), encodePNG(img.W, img.H, img.data));
      const W = meleeWeapon(id);
      man.melee_world[id] = { file, frame: s.frame, grip: s.grip, views: s.views, pitch: s.pitch, px_per_m: s.px_per_m, set: W.set, hands: W.hands, damage: W.damage, stamina: W.stamina, radius_px: r1(W.cell.radius * ((frame[1] - 4) / 98)), radius_cm: r1(W.cell.radius * CM_PER_UNIT), cells: s.meta, ...(W.shield ? { shield: true } : {}), ...(W.shock ? { shock: true } : {}) };
      report[id] = { file, frame: s.frame, sheet: [img.W, img.H] };
    }
    writeJSON(mf, man);
    return { out, manifest: mf, weapons: report, ...this.pathNote(a.out, out) };
  },

  /**
   * Paired preview: attacker + victim skins composited per frame in a view (the shared root
   * alignment), into a canvas strip + a contact sheet.
   */
  anim_paired(a, source) {
    const skinA = loadSkin(this, a.skin);
    const skinV = a.victim_skin !== undefined ? loadSkin(this, a.victim_skin, 'victim_skin') : skinA;
    const sk = loadSkeleton(this, skinA.skeleton);
    const pair = checkName(a.pair ?? a.clip, 'pair');
    const att = loadClip(this, sk.name, `${pair}_attacker`), vic = loadClip(this, sk.name, `${pair}_victim`);
    if (!att || !vic) throw new Error(`skeleton "${sk.name}" has no paired clip "${pair}" (${listClips(this, sk.name).filter((n) => n.endsWith('_attacker')).map((n) => n.slice(0, -9)).join(', ') || 'none: art_anim melee'})`);
    const view = a.view ?? 'side';
    const A = getRig(this, skinA.rig), V = getRig(this, skinV.rig);
    const getClip = (n) => loadClip(this, sk.name, n);
    // per-skeleton takedowns: skins with proportions get the pair retargeted and refit on their rigs
    const propOf = (s) => (s.proportions && Object.keys(s.proportions).length ? s.proportions : null);
    let attC = att, vicC = vic, refit = null;
    if (propOf(skinA) || propOf(skinV)) {
      const rA = propOf(skinA) ? retargetClip(att, sk.def, A.def, skinA.map).clip : att, rV = propOf(skinV) ? retargetClip(vic, sk.def, V.def, skinV.map).clip : vic;
      const f = refitPaired(A.rig, rA, rV, cellsOf(sk), V.rig);
      attC = f.att; vicC = f.vic; refit = f.offset;
    }
    const po = pairedOut(A.rig, attC.melee.paired, view, attC.frames);
    const pa = clipFrames(this, A.rig, A.def, attC, getClip, sk, view), pv = clipFrames(this, V.rig, V.def, vicC, getClip, sk, po.partner_view);
    const [W, H] = A.rig.frame;
    // front / back: the per-frame lateral staging of the manifest (partner_dx_track)
    const lat = deepView(A.rig, view) ? lateralFit(pairedTrack(this, A.rig, A.def, attC, vicC, getClip, sk, view, cellsOf(sk), V.rig, V.def), attC.frames) : null;
    const dxs = pa.map((_, f) => Math.round(po.partner_dx + (lat ? lat[f] : 0)));
    const dlo = Math.min(...dxs), dhi = Math.max(...dxs);
    const padL = Math.ceil(W / 2) + Math.max(0, -dlo), padR = Math.ceil(W / 2) + Math.max(0, dhi), padT = Math.ceil(H / 4), padB = 4;
    const pad = [padL, padT, padR, padB];
    const FW = W + padL + padR, FH = H + padT + padB;
    const cache = new Map(), cacheV = new Map();
    const frames = pa.map((Pa, f) => {
      const ia = renderPose(A.rig, A.d, Pa, view, cache, { pad });
      const dx = dxs[f];
      const iv = renderPose(V.rig, V.d, pv[f], po.partner_view, cacheV, { mirror: !!po.partner_flip, pad: [padL + dx, padT, padR - dx, padB].map((x) => Math.max(0, x)) });
      const out = new Uint8ClampedArray(FW * FH * 4);
      const over = (img) => { for (let i = 0; i < img.length; i += 4) if (img[i + 3]) out.set(img.subarray(i, i + 4), i); };
      if (po.order === 'partner_front') { over(ia); over(iv); } else { over(iv); over(ia); }
      return out;
    });
    const canvas = checkName(a.canvas ?? `${a.skin}_${pair}_${view}`, 'canvas');
    this.run('create', { name: canvas, width: FW, height: FH, frames: frames.length, overwrite: true }, source);
    const d = this.docs.get(canvas);
    frames.forEach((img, i) => d.layers[0].data.set(img, i * FW * FH * 4));
    d.setAnimation(pair, { from: 0, to: frames.length - 1, fps: att.fps ?? 16, loop: false });
    this.changed(d, { op: 'paired', source, label: `paired ${pair} ${view}`, structural: true });
    const shown = frames.filter((_, i) => i % Math.max(1, Math.round(frames.length / 8)) === 0).map((img, i) => ({ img: { width: FW, height: FH, data: img }, label: String(i * Math.max(1, Math.round(frames.length / 8))) }));
    const sheet = packImages(shown, { labels: true, checker: true, columns: Math.min(4, shown.length) });
    return { canvas, frames: frames.length, size: `${FW}x${FH}`, pad, partner_view: po.partner_view, partner_dx: po.partner_dx, ...(lat && lat.some((v) => v) ? { partner_dx_track: dxs } : {}), order: po.order, sync_frame: po.sync_frame, ...(refit ? { refit_offset: refit } : {}), image: encodePNG(sheet.width, sheet.height, sheet.data) };
  },
};

export { cellsOf };
