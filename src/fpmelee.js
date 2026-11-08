// First-person melee: hit metadata for the fp v2 clips (gun bash, knife slash / stab / combo,
// punch, baton strike, riot shield bash / raise) and the per-frame hit volumes they export. A clip's
// melee block is authored in frames: windup [f0, f1], active [[f0, f1], ...], impact [f, ...],
// damage, stamina, source (what strikes: the gun, the held item, the second item or a fist) with
// its strike line in the source's own space (cm). fpMeleeAnim solves the line on every active
// frame (eye space, cm: x right, y up, -z forward) and projects it into the frame (px), so a
// runtime can test either the camera-space capsule or the screen capsule.
import { project, add, mv } from './fp.js';
import { meleeEvents, hull } from './melee.js';
import { FP_SHIELD_SCALE } from './fpkit.js';

const r1 = (v) => Math.round(v * 10) / 10;

/** Strike lines per source (cm, source space; the gun's comes from its class geometry). */
export const FP_SOURCES = {
  knife: { a: [0, 0.4, -7], b: [0, 0.6, -22], r: 1.5 },
  baton: { a: [0, -0.8, -24], b: [0, -0.8, -45], r: 2 }, // edge_a -> edge_b of melee_baton
  // the fp shield is the view model at FP_SHIELD_SCALE (fpkit.js): its face from rim to rim
  riot_shield: { a: [0, r1(40 * FP_SHIELD_SCALE), r1(-8.2 * FP_SHIELD_SCALE)], b: [0, r1(-44 * FP_SHIELD_SCALE), r1(-8.2 * FP_SHIELD_SCALE)], r: r1(26 * FP_SHIELD_SCALE) },
  fist: { a: [0, 0, 0], b: [0, 0, 0], r: 4.5 },
};

/**
 * Melee metadata of the fp clips: {class: {clip: melee}}; '*gun' = every gun class. Frames are
 * clip frames (0-based).
 */
export const FP_MELEE = {
  '*gun': {
    melee: { kind: 'attack', damage: 'blunt', stamina: 10, windup: [0, 3], active: [[4, 6]], impact: [5], source: 'gun', sfx: [[3, 'swish_heavy'], [5, 'butt_impact']], vfx: [[5, 'impact_blunt']] },
  },
  knife: {
    slash: { kind: 'attack', damage: 'slash', stamina: 6, windup: [0, 3], active: [[4, 7]], impact: [6], source: 'item', sfx: [[4, 'swish_light']], vfx: [[6, 'slash_trail']] },
    stab: { kind: 'attack', damage: 'pierce', stamina: 6, windup: [0, 3], active: [[4, 5]], impact: [5], source: 'item', sfx: [[4, 'swish_short']], vfx: [[5, 'stab_spark']] },
    combo: { kind: 'attack', damage: 'slash', damage_per_hit: ['slash', 'slash', 'pierce'], stamina: 13, windup: [0, 2], active: [[4, 6], [9, 11], [14, 16]], impact: [5, 10, 15], source: 'item', combo: [{ from: 0, to: 6, next_by: 6 }, { from: 6, to: 12, next_by: 12 }, { from: 12, to: 21 }], sfx: [[4, 'swish_light'], [9, 'swish_light'], [14, 'swish_short']], vfx: [[5, 'slash_trail'], [10, 'slash_trail'], [15, 'stab_spark']] },
  },
  unarmed: {
    melee: { kind: 'attack', damage: 'blunt', stamina: 5, windup: [0, 1], active: [[2, 4]], impact: [3], source: 'fist', sfx: [[2, 'swish_light'], [3, 'punch']], vfx: [[3, 'impact_blunt']] },
  },
  baton: {
    strike: { kind: 'attack', damage: 'blunt', stamina: 9, windup: [0, 3], active: [[4, 7]], impact: [6], source: 'item', shock: { from: 0.82, damage: 'shock' }, sfx: [[4, 'swish_baton'], [6, 'stun_crack']], vfx: [[6, 'stun_arc']] },
    shield_bash: { kind: 'attack', damage: 'blunt', stamina: 12, windup: [0, 3], active: [[4, 6]], impact: [5], source: 'item2', push: 24, stagger: 'heavy', sfx: [[4, 'shield_whoosh'], [5, 'shield_impact']], vfx: [[5, 'impact_heavy']] },
    shield_up: { kind: 'block', damage: null, stamina: 4, block: [3, 9], block_arc: 140, source: null, sfx: [[3, 'shield_ready']] },
  },
};

/** The melee block of a clip of a class (or null). */
export function fpMeleeOf(cls, clipName, gunClass) {
  const t = FP_MELEE[cls]?.[clipName] ?? (gunClass ? FP_MELEE['*gun'][clipName] : null);
  return t ? structuredClone(t) : null;
}

/** Frame-based melee block -> the 0..1 timing meleeEvents reads (frames land back exactly). */
function asTimes(m, n) {
  const T = (f) => (n > 1 ? f / (n - 1) : 0);
  const o = { ...m };
  if (m.windup) o.windup = m.windup.map(T);
  if (m.active) o.active = m.active.map((w) => w.map(T));
  if (m.impact) o.impact = m.impact.map(T);
  if (m.block) o.block = m.block.map(T);
  for (const k of ['sfx', 'vfx', 'events']) if (m[k]) o[k] = m[k].map(([f, name]) => ({ t: T(f), name }));
  return o;
}

/** Strike line of the source in eye space (cm) on a solved frame, or null when it is not there. */
function lineOf(fr, m, cls, geo) {
  const P3 = fr.pose3;
  if (!P3 || !m.source) return null;
  if (m.source === 'gun') {
    if (!P3.gun || !geo) return null;
    // long guns jab with the front of the gun (support -> muzzle), pistols whip with the slide
    const a = geo.kind === 'pistol' ? geo.grip : geo.support, b = geo.muzzle;
    return { a: add(P3.gun.P, mv(P3.gun.R, a)), b: add(P3.gun.P, mv(P3.gun.R, b)), r: geo.kind === 'pistol' ? 2.5 : 3.5 };
  }
  if (m.source === 'fist') {
    const H = P3.hands.R;
    const fwd = [-H.R[0][2], -H.R[1][2], -H.R[2][2]]; // hand frame columns s, d, b; b = -fingers
    return { a: H.P, b: add(H.P, fwd.map((v) => v * 7)), r: FP_SOURCES.fist.r };
  }
  const it = m.source === 'item2' ? P3.item2 : P3.item;
  if (!it || it.hidden) return null;
  const S = FP_SOURCES[it.id];
  if (!S) return null;
  return { a: add(it.P, mv(it.R, S.a)), b: add(it.P, mv(it.R, S.b)), r: S.r };
}

/** Near plane of the strike lines (cm): a line reaching behind it is cut there (project() clamps). */
const NEAR = 6;
function clipNear(L) {
  const za = -L.a[2], zb = -L.b[2];
  if (za >= NEAR && zb >= NEAR) return L;
  if (za < NEAR && zb < NEAR) return null;
  const t = (NEAR - za) / (zb - za), p = L.a.map((v, i) => v + (L.b[i] - v) * t);
  return za < NEAR ? { ...L, a: p } : { ...L, b: p };
}

/** Screen radius (px) of a sphere of radius r cm at eye-space point p. */
function pxRadius(p, r) {
  const q = project(p), s = project([p[0] + r, p[1], p[2]]);
  return Math.hypot(s[0] - q[0], s[1] - q[1]);
}

/**
 * Manifest melee block of a baked fp clip: phases, events (fp {f, e} plus hit / damage / sound /
 * effect), active windows, per active frame the strike capsule in eye space (cm) and on screen (px,
 * the fp frame), a swept screen polygon since the previous active frame, block / combo windows.
 */
export function fpMeleeAnim(m, sol, { cls, geo }) {
  const n = sol.frames.length;
  const ev = meleeEvents(asTimes(m, n), n);
  const events = ev.events.map(({ frame, name, ...rest }) => ({ f: frame, e: name, ...rest }));
  const active = new Set();
  for (const [a, b] of ev.windows) for (let f = a; f <= b; f++) active.add(f);
  const lines = sol.frames.map((fr) => { const L = lineOf(fr, m, cls, geo); return L && clipNear(L); });
  const hits = [];
  for (const f of [...active].sort((x, y) => x - y)) {
    const L = lines[f];
    if (!L) continue;
    const pa = project(L.a), pb = project(L.b);
    const vol = { source: m.source, a: [r1(pa[0]), r1(pa[1])], b: [r1(pb[0]), r1(pb[1])], r: r1(Math.max(pxRadius(L.a, L.r), pxRadius(L.b, L.r))), eye: { a: L.a.map(r1), b: L.b.map(r1), r: L.r } };
    const prev = active.has(f - 1) && ev.windows.some(([w0, w1]) => f - 1 >= w0 && f <= w1) ? lines[f - 1] : null;
    if (prev) vol.sweep = hull([prev.a, prev.b, L.a, L.b].map((p) => project(p)).map((q) => [r1(q[0]), r1(q[1])]));
    if (m.shock) vol.shock_from = m.shock.from;
    hits.push({ f, hit: ev.windows.findIndex(([a, b]) => f >= a && f <= b), volumes: [vol] });
  }
  const out = { kind: m.kind, damage: m.damage ?? null, ...(m.damage_per_hit ? { damage_per_hit: m.damage_per_hit } : {}), stamina: m.stamina ?? 0, phase: ev.phase, events, windows: ev.windows };
  if (hits.length) out.hits = hits;
  if (m.block) out.block = m.block;
  for (const k of ['block_arc', 'combo', 'push', 'stagger', 'shock']) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

/**
 * Check a baked fp melee block: event order per hit, a capsule on every active frame, no active
 * frame inside the windup, and the strike line sampled between active frames stays in the swept
 * polygons (screen px, tolerance tol). -> {pass, issues, metrics}
 */
export function fpMeleeCheck(anim, tol = 2) {
  const issues = [];
  const m = anim.melee;
  if (!m) return { pass: false, issues: ['no melee block'], metrics: {} };
  const at = (e, i) => m.events.find((x) => x.e === e && x.hit === i)?.f;
  const wu = m.events.find((x) => x.e === 'windup')?.f;
  if (m.kind === 'attack') {
    if (!m.windows.length) issues.push('no active window');
    if (wu === undefined) issues.push('no windup event');
    m.windows.forEach(([a, b], i) => {
      if (!(wu < at('active_start', i))) issues.push(`hit ${i}: windup not before active_start`);
      const imp = at('impact', i);
      if (imp !== undefined && !(a <= imp && imp <= b)) issues.push(`hit ${i}: impact ${imp} outside ${a}..${b}`);
      for (let f = a; f <= b; f++) if (!m.hits?.some((h) => h.f === f)) issues.push(`hit ${i}: no volume on active frame ${f}`);
    });
  }
  let worst = 0;
  for (const h of m.hits || []) for (const v of h.volumes) if (v.sweep) {
    const prev = m.hits.find((x) => x.f === h.f - 1)?.volumes[0];
    for (const q of [v.a, v.b, prev?.a, prev?.b].filter(Boolean)) {
      let inside = false;
      for (let i = 0, j = v.sweep.length - 1; i < v.sweep.length; j = i++) {
        const [xi, yi] = v.sweep[i], [xj, yj] = v.sweep[j];
        if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
      }
      if (!inside) {
        let d = Infinity;
        for (let i = 0, j = v.sweep.length - 1; i < v.sweep.length; j = i++) d = Math.min(d, segD(q, v.sweep[j], v.sweep[i]));
        worst = Math.max(worst, d);
      }
    }
  }
  if (worst > tol) issues.push(`strike line leaves the swept area by ${r1(worst)} px`);
  return { pass: !issues.length, issues, metrics: { windows: m.windows.length, volumes: (m.hits || []).length, sweep_miss_px: r1(worst) } };
}
function segD(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
