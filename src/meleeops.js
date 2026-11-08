// Engine ops for melee (art_anim melee | melee_check | melee_sheet | paired): install the melee
// clip library on a skeleton (weapon / shield cells + strikes, reactions, paired takedowns with
// fitted contacts), validate it (event order, active frames, hit-volume coverage of the weapon path,
// paired alignment), render melee weapon world sheets (views x pitch, grip on a fixed pixel, edge
// line per cell) and preview paired clips. anim_batch calls meleeBatchAnim for the manifest fields.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRig, resolvePose, lerpPose, solvePose, partIn, poseOf, renderPose } from './rig.js';
import { getRig, framePoses } from './rigops.js';
import { normalizeClip, evalClip, applyProportions, retargetClip, LIB_NAME } from './animlib.js';
import { meleeLibrary, meleeParts, meleeAnim, meleeEvents, hitSources, frameVolumes, segDist, inPoly, pairedOut, turnedView, VIEW_YAW8, normalizeMelee, frameOfT, HD_VIEWS } from './melee.js';
import { MELEE_IDS, meleeWeapon, meleeCell, CM_PER_UNIT } from './meleekit.js';
import { checkName } from './util.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';

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
const SWEEP_SUB = 4;

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
 * on the partner's contact point at each attacker key inside the contact window.
 */
function fitPaired(rig, att, vic, cells) {
  const m = att.melee, p = m.paired;
  const u = (rig.frame[1] - 4) / 98;
  // a rigid contact (a shield) or one marked fit sets the offset so the authored poses meet there;
  // hand contacts are then held by IK
  for (const c of p.contacts || []) {
    if (/^hand_/.test(c.attacker) && !c.fit) continue;
    const t = c.t[0];
    const AP = poseAtT(rig, att.keys, t), VP = poseAtT(rig, vic.keys, t);
    // per screen-spread view: the attacker's point x and the victim's point x before the partner shift
    const gaps = [];
    for (const view of rig.views.filter((w) => HD_VIEWS.includes(w) && !/^(front|back)$/.test(w))) {
      const A = solvePose(rig, AP, view), V = solvePose(rig, VP, turnedView(view, p.facing));
      const v = contactPoint(rig, V, c.victim, cells);
      const a = c.attacker === 'shield' && cells?.shield ? faceAtY(shieldFace(rig, A, cells), v[1]) : contactPoint(rig, A, c.attacker, cells);
      const k = Math.cos(VIEW_YAW8[view] * D2R); // partner_dx per unit of forward offset (px / u)
      gaps.push({ ax: a[0], vx: v[0], k, w: view === 'side' ? 1 : 0 });
    }
    // the forward offset that minimises the worst gap over those views (side alone when only side)
    const worst = (f) => Math.max(...gaps.map((g) => Math.abs(g.ax - (g.vx + f * g.k * u))));
    let best = p.offset[0], bw = Infinity;
    for (let f = p.offset[0] - 30; f <= p.offset[0] + 30; f += 0.05) { const w = worst(f); if (w < bw - 1e-9) { bw = w; best = f; } }
    p.offset = [Math.round(best * 100) / 100, p.offset[1]];
  }
  vic.melee.paired.offset = p.offset;
  const views = rig.views.filter((v) => HD_VIEWS.includes(v));
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
      const VP = poseAtT(rig, vic.keys, k.t);
      for (const view of views) {
        const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
        const V = solvePose(rig, VP, po.partner_view);
        const [x, y] = contactPoint(rig, V, c.victim, cells);
        const target = [Math.round((x + po.partner_dx) * 100) / 100, Math.round(y * 100) / 100];
        const bend = c.attacker === 'hand_b' ? (view === 'front' ? 1 : -1) : view === 'front' ? -1 : view === 'back' ? 1 : -1;
        const spec = { target, bend, weight: 1 };
        if (view === 'side') k.parts.ik = { ...(k.parts.ik || {}), [c.attacker]: spec };
        else {
          k.parts.views = k.parts.views || {};
          k.parts.views[view] = { ...(k.parts.views[view] || {}), ik: { ...(k.parts.views[view]?.ik || {}), [c.attacker]: spec } };
        }
      }
    }
  }
}

// ---------- shared clip evaluation ----------
/** Frame poses of a skeleton clip on a rig (the batch pipeline: eval + plant + secondary + depth). */
function clipFrames(e, rig, def, clip, getClip, sk, view) {
  const ev = evalClip(rig, clip, getClip, sk);
  const a = { animation: `${clip.name}_${view}`, view, _poses: ev.poses, frames: ev.poses.length, loop: ev.loop, fps: ev.fps, ...(clip.plant !== undefined ? { plant: clip.plant } : {}), ...(clip.secondary !== undefined ? { secondary: clip.secondary } : {}) };
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
export function meleeBatchAnim(e, { skin, sk, rig, clip, view, poses, pad, getClip }) {
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
    // coverage: the edge line at 8 sub-steps between active frames lies inside the frame
    // capsules or the swept polygon (r + tol)
    const k = 8;
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
  return { issues, metrics };
}

/** Feet (bottom centre of each foot cell) and contact points of a paired pair, per frame, in the attacker's frame px. */
function pairedTrack(e, rig, def, att, vic, getClip, sk, view, cells) {
  const p = att.melee.paired;
  const po = pairedOut(rig, { ...p, role: 'attacker' }, view, 2);
  const A = clipFrames(e, rig, def, att, getClip, sk, view), V = clipFrames(e, rig, def, vic, getClip, sk, po.partner_view);
  const feet = rig.feet || ['foot_f', 'foot_b'];
  const foot = (solved, n, dx) => { const q = contactPoint(rig, solved, n, cells); const pp = partIn(rig, n, solved.src); return [q[0] + dx, solved.world[n].y + (pp.h - 1 - pp.pivot[1])]; };
  return A.map((Pa, f) => {
    const sa = solvePose(rig, Pa, view), sv = solvePose(rig, V[f], po.partner_view);
    return {
      a: Object.fromEntries(feet.map((n) => [n, foot(sa, n, 0)])), v: Object.fromEntries(feet.map((n) => [n, foot(sv, n, po.partner_dx)])),
      contacts: (p.contacts || []).map((c) => {
        const q = contactPoint(rig, sv, c.victim, cells), v = [q[0] + po.partner_dx, q[1]];
        if (c.attacker === 'shield' && cells?.shield) {
          // a shield meets the victim with its face: the gap between the face line and the victim
          // part's cell outline (0 when they touch or overlap)
          const face = shieldFace(rig, sa, cells);
          const pp = partIn(rig, c.victim, sv.src);
          const box = [[0, 0], [pp.w, 0], [pp.w, pp.h], [0, pp.h]].map((uv) => { const k = cellPoint(rig, sv, c.victim, uv); return [k[0] + po.partner_dx, k[1]]; });
          return { c, a: nearestOn(face, v), v, gap: segPolyGap(face, box) };
        }
        return { c, a: contactPoint(rig, sa, c.attacker, cells), v };
      }),
    };
  });
}

/** Paired alignment: planted feet do not slide (each actor and against each other), contacts meet. */
function checkPaired(e, rig, def, att, vic, getClip, sk, views, tol, cells) {
  const issues = [];
  const n = att.frames;
  if (vic.frames !== n) issues.push(`attacker ${n} frames, victim ${vic.frames}`);
  const ground = solvePose(rig, {}, 'side');
  const gy = Math.max(...(rig.feet || ['foot_f', 'foot_b']).map((f) => { const pp = partIn(rig, f, 'side'); return ground.world[f].y + pp.h - 1 - pp.pivot[1]; }));
  const contactTol = Math.max(tol * 2, ((rig.frame[1] - 4) / 98) * 4);
  let slide = 0, rel = 0, worstContact = 0, sink = 0;
  // after the release frame the victim is free (a fall): its feet may drag, they only must not sink
  const release = att.melee.paired.release !== undefined ? frameOfT(att.melee.paired.release, n) : n;
  for (const view of views) {
    const tr = pairedTrack(e, rig, def, att, vic, getClip, sk, view, cells);
    const planted = (q) => q[1] >= gy - 1.5;
    if (view === 'side') {
      for (let f = 0; f < tr.length; f++) for (const who of ['a', 'v']) for (const q of Object.values(tr[f][who])) sink = Math.max(sink, q[1] - gy);
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
    // front / back: the partners stand in depth and overlap on screen; contacts are checked where
    // the pair spreads across the screen (side, front_side, back_side and mirrors)
    if (/^(front|back)$/.test(rig.mirror[view] || view)) continue;
    for (let f = 0; f < tr.length; f++) for (const c of tr[f].contacts) {
      if (f < frameOfT(c.c.t[0], n) || f > frameOfT(c.c.t[1], n)) continue;
      worstContact = Math.max(worstContact, c.gap ?? Math.hypot(c.a[0] - c.v[0], c.a[1] - c.v[1]));
    }
  }
  if (slide > tol) issues.push(`a planted foot slides ${r1(slide)} px`);
  if (rel > tol) issues.push(`feet slide against each other by ${r1(rel)} px`);
  if (worstContact > contactTol) issues.push(`contact points ${r1(worstContact)} px apart (tolerance ${r1(contactTol)})`);
  if (sink > tol) issues.push(`a foot sinks ${r1(sink)} px below the ground`);
  return { issues, metrics: { foot_slide_px: r1(slide), feet_relative_px: r1(rel), foot_sink_px: r1(Math.max(0, sink)), contact_px: r1(worstContact), contact_tolerance_px: r1(contactTol), ...(release < n ? { release_frame: release } : {}) } };
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
    const lib = meleeLibrary(def, { weapon, shield, clips: a.clips });
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
      const clip = getClip(n);
      const r = checkClip(this, rig, def, clip, getClip, sk, views, tol);
      const p = clip.melee.paired;
      if (p?.role === 'attacker') {
        const vic = getClip(p.partner);
        if (!vic) r.issues.push(`paired partner "${p.partner}" missing`);
        else { const pr = checkPaired(this, rig, def, clip, vic, getClip, sk, views, tol, cells); r.issues.push(...pr.issues); Object.assign(r.metrics, pr.metrics); }
      }
      if (r.issues.length) fails++;
      clips[n] = { pass: !r.issues.length, ...r.metrics, ...(r.issues.length ? { issues: r.issues } : {}) };
    }
    return { skeleton: sk.name, ...(a.skin ? { skin: a.skin } : {}), pass: fails === 0, clips_checked: names.length, failing: fails, tolerance_px: tol, views, clips };
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
    const po = pairedOut(A.rig, att.melee.paired, view, att.frames);
    const pa = clipFrames(this, A.rig, A.def, att, getClip, sk, view), pv = clipFrames(this, V.rig, V.def, vic, getClip, sk, po.partner_view);
    const [W, H] = A.rig.frame;
    const dx = Math.round(po.partner_dx);
    const padL = Math.ceil(W / 2) + Math.max(0, -dx), padR = Math.ceil(W / 2) + Math.max(0, dx), padT = Math.ceil(H / 4), padB = 4;
    const pad = [padL, padT, padR, padB];
    const FW = W + padL + padR, FH = H + padT + padB;
    const cache = new Map(), cacheV = new Map();
    const frames = pa.map((Pa, f) => {
      const ia = renderPose(A.rig, A.d, Pa, view, cache, { pad });
      const iv = renderPose(V.rig, V.d, pv[f], po.partner_view, cacheV, { pad: [padL + dx, padT, padR - dx, padB].map((x) => Math.max(0, x)) });
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
    return { canvas, frames: frames.length, size: `${FW}x${FH}`, partner_view: po.partner_view, partner_dx: po.partner_dx, order: po.order, sync_frame: po.sync_frame, image: encodePNG(sheet.width, sheet.height, sheet.data) };
  },
};

export { cellsOf };
