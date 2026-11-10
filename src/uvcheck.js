// Cohesion check (art_model unwrap {do:"check"}, export / create / update replies): does a
// multi-part model read as ONE object? Texel density, seams on the visible front of round parts,
// pattern seams, courses cut by part heights, missing contact shading, flat edges, atlas state.
// Pure: works on a built model with or without an atlas.
import { facetsOf } from './uvunwrap.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const pmod = (a, n) => ((a % n) + n) % n;
const addv3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lum = (d, p) => (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;

/** Display name of a part: its name, else its index. */
export const partLabel = (def, pi) => (pi === undefined || pi === null ? 'model' : def.parts?.[pi]?.name ?? pi);

/** Per-face texel density (texels per px) of textured faces, area-weighted per part. */
function densities(mesh) {
  const faces = [];
  for (const g of mesh.groups.values()) {
    if (g.overlay || !g.faces || g.tex.width * g.tex.height <= 1) continue;
    const TW = g.tex.width, TH = g.tex.height;
    for (const f of g.faces) {
      let A3 = 0, A2 = 0;
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        const [a, b, c] = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
        const P = (v) => [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
        A3 += len(cross(sub(P(b), P(a)), sub(P(c), P(a)))) / 2;
        const u = (v) => [g.uv[v * 2] * TW, g.uv[v * 2 + 1] * TH];
        const [ua, ub, uc] = [u(a), u(b), u(c)];
        A2 += Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) / 2;
      }
      if (A3 > 1e-6 && A2 > 1e-9) faces.push({ pi: f.pi, a: A3, d: Math.sqrt(A2 / A3) });
    }
  }
  return faces;
}
function densityIssue(def, mesh) {
  const fs = densities(mesh);
  if (fs.length < 2) return null;
  const tot = fs.reduce((s, f) => s + f.a, 0), mean = fs.reduce((s, f) => s + f.a * f.d, 0) / tot;
  const cv = Math.sqrt(fs.reduce((s, f) => s + f.a * (f.d - mean) ** 2, 0) / tot) / mean;
  const sorted = [...fs].sort((x, y) => x.d - y.d);
  let acc = 0, med = sorted[0].d;
  for (const f of sorted) { acc += f.a; if (acc >= tot / 2) { med = f.d; break; } }
  const per = new Map();
  for (const f of fs) { const p = per.get(f.pi) || { a: 0, s: 0 }; p.a += f.a; p.s += f.a * f.d; per.set(f.pi, p); }
  if (per.size < 2 && cv <= 0.15) return null;
  const off = [...per].filter(([, p]) => { const r = p.s / p.a / med; return r < 0.8 || r > 1.25; }).map(([pi]) => partLabel(def, pi));
  if (cv <= 0.15 && !off.length) return null;
  return { id: 'texel_density', level: 'error', parts: off.length ? off : [...per.keys()].map((pi) => partLabel(def, pi)), detail: `texel density varies (CV ${cv.toFixed(2)}; ${off.length ? `parts ${off.join(', ')} off the model median ${med.toFixed(2)} texel/px` : 'stretched faces'})`, fix: 'art_model unwrap {name} (uniform density), or per part: tile:true, wrap:"repeat", remove scale' };
}

/** Affine UV map of a facet (from its first triangle), extended past the facet. */
function uvMap(F) {
  const [a, b, c] = F.tris[0], P0 = F.pos[a], e1 = sub(F.pos[b], P0), e2 = sub(F.pos[c], P0);
  const d11 = dot(e1, e1), d12 = dot(e1, e2), d22 = dot(e2, e2), det = d11 * d22 - d12 * d12 || 1;
  const u0 = F.uv[a], u1 = F.uv[b], u2 = F.uv[c];
  return (X) => { const d = sub(X, P0), r1 = dot(d, e1), r2 = dot(d, e2), b1 = (d22 * r1 - d12 * r2) / det, b2 = (d11 * r2 - d12 * r1) / det; return [u0[0] + b1 * (u1[0] - u0[0]) + b2 * (u2[0] - u0[0]), u0[1] + b1 * (u1[1] - u0[1]) + b2 * (u2[1] - u0[1])]; };
}
const texAt = (T, uv) => { const x = pmod(Math.floor(uv[0] * T.width + 1e-7), T.width), y = pmod(Math.floor(uv[1] * T.height + 1e-7), T.height), p = (y * T.width + x) * 4; return (T.data[p] << 24 | T.data[p + 1] << 16 | T.data[p + 2] << 8 | T.data[p + 3]) >>> 0; };
/**
 * Seams on the visible front: smooth edges (dihedral < 46 deg) facing the viewer where the texture
 * does not continue: each side's actual texels 0.5..3.5 px into it against the other side's
 * mapping unfolded across the edge, sampled every 1 px along the edge.
 */
function frontSeams(def, built, anchor, front = [0, 0.45, 1]) {
  const topo = facetsOf(built.mesh, anchor, (g) => g.tex.width * g.tex.height > 1);
  const fr = norm(front), out = new Map();
  for (const [, us] of topo.edges) {
    if (us.length !== 2) continue;
    const A = topo.facets[us[0].fi], B = topo.facets[us[1].fi];
    if (A.src.tex.key !== B.src.tex.key || A.pi !== B.pi) continue;
    const dih = (Math.acos(Math.max(-1, Math.min(1, dot(A.n, B.n)))) * 180) / Math.PI;
    if (dih >= 46) continue;
    const vis = 0.5 + 0.5 * dot(norm([A.n[0] + B.n[0], A.n[1] + B.n[1], A.n[2] + B.n[2]]), fr);
    if (vis <= 0.6) continue;
    const P = A.pos[us[0].a], Q = A.pos[us[0].b], L = len(sub(Q, P));
    if (L < 2) continue;
    const ex = norm(sub(Q, P));
    const inward = (F) => { let m = norm(cross(F.n, ex)); if (dot(m, sub(F.c, P)) < 0) m = m.map((v) => -v); return m; };
    const mA = inward(A), mB = inward(B), uA = uvMap(A), uB = uvMap(B), T = A.src.tex;
    // only a seam when the texture keeps its direction across the edge (a wrap / phase seam): where
    // the pattern turns (a box's top against its side bevel) the edge is a corner, not a seam
    const gA = [uA(addv3(P, ex))[0] - uA(P)[0], uA(addv3(P, mA))[0] - uA(P)[0]], gB = [uB(addv3(P, ex))[0] - uB(P)[0], uB(addv3(P, mB))[0] - uB(P)[0]];
    const ua = [gA[0], -gA[1]], ub = [gB[0], gB[1]], la = Math.hypot(...ua), lb = Math.hypot(...ub);
    if (la < 1e-9 || lb < 1e-9 || (ua[0] * ub[0] + ua[1] * ub[1]) / (la * lb) < Math.cos(Math.PI / 6)) continue;
    const steps = Math.floor(L);
    let bad = 0;
    for (let s = 0; s < steps; s++) {
      const E = P.map((v, k) => v + ex[k] * (s + 0.5) * (L / steps));
      let diff = 0;
      for (const d of [0.5, 1.5, 2.5, 3.5]) {
        const inB = E.map((v, k) => v + mB[k] * d), inA = E.map((v, k) => v + mA[k] * d);
        if (texAt(T, uB(inB)) !== texAt(T, uA(E.map((v, k) => v - mA[k] * d)))) diff++;
        if (texAt(T, uA(inA)) !== texAt(T, uB(E.map((v, k) => v - mB[k] * d)))) diff++;
      }
      if (diff > 1) bad++;
    }
    if (steps >= 4 && bad / steps > 0.25) { const r = out.get(A.pi) || { edges: 0, steps: 0 }; r.edges++; r.steps += bad; out.set(A.pi, r); }
  }
  return out;
}
/** Course period of a texture: the smallest autocorrelation lag (4..min(64, height/2)) within 10% of the best, of its row-mean luminance, when the peak > 0.3. */
export function coursePeriod(T) {
  if (!T || T.width * T.height <= 1 || T.height < 8) return null;
  const m = new Float64Array(T.height);
  for (let y = 0; y < T.height; y++) { let s = 0, n = 0; for (let x = 0; x < T.width; x++) { const p = (y * T.width + x) * 4; if (T.data[p + 3]) { s += lum(T.data, p); n++; } } m[y] = n ? s / n : 0; }
  const mean = m.reduce((s, v) => s + v, 0) / m.length, x = m.map((v) => v - mean), e = x.reduce((s, v) => s + v * v, 0);
  if (e < 1e-6) return null;
  // up to half the height: the circular autocorrelation is symmetric (lag H-1 scores like lag 1);
  // multiples of the course height score about as high, so take the smallest lag near the best
  const rs = [];
  for (let lag = 4; lag <= Math.min(64, Math.floor(T.height / 2)); lag++) {
    let s = 0;
    for (let y = 0; y < T.height; y++) s += x[y] * x[(y + lag) % T.height];
    rs.push([lag, s / e]);
  }
  const best = rs.reduce((m, [, r]) => Math.max(m, r), 0);
  if (!(best > 0.3)) return null;
  return rs.find(([, r]) => r >= best * 0.9)[0];
}
const texRef = (p) => (p ? p.side ?? p.texture ?? p.faces?.front ?? null : null);
function courseCuts(def, built, anchor, skipParts) {
  const cuts = [];
  const cache = new Map();
  let ph0 = null;
  (def.parts || []).forEach((p, pi) => {
    const b = built.partBounds?.[pi];
    if (!b || !p || p.tile === false || p.wrap || p.type === 'model' || skipParts.has(pi)) return;
    const ref = texRef(p);
    if (!ref || typeof built.tex !== 'function') return;
    let T;
    try { T = built.tex(ref); } catch { return; }
    if (!T || T.ctm) return;
    if (!cache.has(T.key)) cache.set(T.key, coursePeriod(T));
    const ph = cache.get(T.key);
    if (!ph) return;
    const off = (y) => { const r = pmod(y, ph); return Math.min(r, ph - r); };
    const y0 = b.min[1] - anchor[1], y1 = b.max[1] - anchor[1];
    if (off(y0) > 1 || off(y1) > 1) { cuts.push(pi); ph0 = ph0 ?? ph; }
  });
  return { cuts, ph: ph0 };
}
/** Pairs of parts whose bounds touch or overlap (0.5 px tolerance). */
function touching(built) {
  const B = (built.partBounds || []).map((b, i) => [i, b]).filter(([, b]) => b);
  const parts = new Set();
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const a = B[i][1], b = B[j][1];
    if ([0, 1, 2].every((k) => a.min[k] <= b.max[k] + 0.5 && b.min[k] <= a.max[k] + 0.5)) { parts.add(B[i][0]); parts.add(B[j][0]); }
  }
  return [...parts];
}
/** Textured parts (texture > 1x1) of a built model. */
export function texturedParts(built) {
  const s = new Set();
  for (const g of built.mesh.groups.values()) if (!g.overlay && g.faces && g.tex.width * g.tex.height > 1) for (const f of g.faces) if (f.pi !== undefined) s.add(f.pi);
  return s;
}

/**
 * Cohesion report. ctx: {anchor, atlasDoc?, full?, plainFor?() (a build without the atlas, for
 * seams on the per-part look)}. -> {pass, score, issues:[{id, level, parts, detail, fix}]}
 */
export function cohesionCheck(def, built, ctx = {}) {
  const full = ctx.full !== false, issues = [], n = def.name;
  const faces = built.mesh.faces.length;
  const uw = built.unwrap || null, doc = ctx.atlasDoc || null, meta = doc?.meta?.uv || (uw?.baked ? { baked: uw.baked } : null);
  const atlasOk = !!(uw && uw.canvas && !uw.stale && !uw.missing);
  if (uw?.stale) issues.push({ id: 'stale_atlas', level: 'error', parts: [], detail: `atlas ${uw.canvas} is stale (the model changed): per-part textures shown`, fix: `art_model unwrap {name:"${n}"}` });
  if (uw?.missing) issues.push({ id: 'missing_atlas', level: 'error', parts: [], detail: `unwrap is set but canvas ${uw.canvas} has no atlas`, fix: `art_model unwrap {name:"${n}"}` });
  if (!full && faces > 5000) return finish(issues);
  const anchor = ctx.anchor;
  const d = densityIssue(def, built.mesh);
  if (d) issues.push(d);
  if (full) {
    const fs = frontSeams(def, built, anchor, ctx.front);
    for (const [pi, r] of fs) {
      const p = def.parts?.[pi] || {};
      let fix = `art_model unwrap {name:"${n}"} (seam moves to the back, ring fit closes it)`;
      const T = typeof built.tex === 'function' && texRef(p) ? (() => { try { return built.tex(texRef(p)); } catch { return null; } })() : null;
      const rr = Number(p.r ?? p.radius ?? p.r_bottom);
      if (T && T.width > 1 && rr > 0) {
        const k = (2 * Math.PI * rr) / T.width, lo = Math.max(1, Math.floor(k)), hi = Math.ceil(k) === lo ? lo + 1 : Math.ceil(k);
        fix += ` or r:${((lo * T.width) / (2 * Math.PI)).toFixed(2)} | r:${((hi * T.width) / (2 * Math.PI)).toFixed(2)} (circumference ${(2 * Math.PI * rr).toFixed(2)} px is not a multiple of ${T.width})`;
      }
      issues.push({ id: 'front_seam', level: 'error', parts: [partLabel(def, pi)], detail: `texture seam on the visible front (${r.edges} edge${r.edges > 1 ? 's' : ''})`, fix });
    }
    if (atlasOk && meta?.baked?.pattern_seams?.length) for (const s of meta.baked.pattern_seams) issues.push({ id: 'pattern_seam', level: 'warn', parts: [partLabel(def, s.pi)], detail: `ring of ${s.L} px does not close the ${s.period} px pattern (fit refused)`, fix: `r:${s.suggest_r.join(' | r:')} or unwrap:{bake:{fit_max:0.2}}` });
  }
  const coursed = new Set();
  if (atlasOk && meta?.baked?.courses) for (const pi of meta.baked.courses === true ? (def.parts || []).map((_, i) => i) : meta.baked.courses) coursed.add(pi);
  const cc = courseCuts(def, built, anchor, coursed);
  if (cc.cuts.length) issues.push({ id: 'course_cut', level: 'warn', parts: cc.cuts.map((pi) => partLabel(def, pi)), detail: `part heights cut the ${cc.ph} px courses of their texture`, fix: `set h / at.y to multiples of ${cc.ph}, or unwrap:{cohesion:{courses:{h:${cc.ph}}}} with a jointless stone texture` });
  const touch = touching(built);
  if (touch.length >= 2) {
    let flat = !atlasOk || !meta?.baked?.cohesion;
    if (!flat && full && doc) {
      const masks = doc.layers.find((l) => l.name === 'masks');
      if (masks) {
        const comp = doc.composite({ exclude: ['emissive', 'height', 'metal', 'rough', 'masks', 'guide'] });
        let a = 0, na = 0, b = 0, nb = 0;
        for (let p = 0; p < comp.length; p += 4) {
          if (!masks.data[p + 3] || !comp[p + 3]) continue;
          const cv = masks.data[p + 1] / 255;
          if (cv > 0.5) { a += lum(comp, p); na++; } else if (cv < 0.1) { b += lum(comp, p); nb++; }
        }
        if (na && nb && a / na > 0.95 * (b / nb)) flat = true;
      }
    }
    if (flat) issues.push({ id: 'no_contact_shading', level: 'error', parts: touch.map((pi) => partLabel(def, pi)), detail: `${touch.length} touching parts with no contact shading where they meet`, fix: atlasOk ? `art_model unwrap {name:"${n}", unwrap:{do:"cohesion"}}` : `art_model unwrap {name:"${n}"}` });
  }
  if (full && atlasOk && meta) {
    if (meta.baked && meta.baked.edges === false) {
      const paint = doc.layers.find((l) => l.name === 'paint');
      if (!paint || !paint.data.some((v, i) => i % 4 === 3 && v)) issues.push({ id: 'flat_edges', level: 'info', parts: [], detail: 'edge wear is off and no edges are painted', fix: `art_model unwrap {name:"${n}", unwrap:{do:"cohesion", cohesion:{edges:{}}}}` });
    }
    for (const ln of ['guide', 'masks']) if (doc.layers.find((l) => l.name === ln)?.visible) issues.push({ id: 'guide_visible', level: 'error', parts: [], detail: `layer "${ln}" of ${doc.name} is visible (it would paint over the texture)`, fix: `art_layer {canvas:"${doc.name}", action:"visibility", layer:"${ln}", visible:false}` });
    if (uw.fill < 0.4) issues.push({ id: 'atlas_fill', level: 'info', parts: [], detail: `atlas fill ${uw.fill}`, fix: 'smaller max_size or pad' });
  }
  if (full && ctx.nested) for (const pi of ctx.nested) issues.push({ id: 'nested_unwrap', level: 'info', parts: [partLabel(def, pi)], detail: 'a placed sub-model has its own unwrap: it is ignored when placed', fix: 'unwrap the parent model' });
  return finish(issues);
}
function finish(issues) {
  const e = issues.filter((x) => x.level === 'error').length, w = issues.filter((x) => x.level === 'warn').length;
  return { pass: e === 0, score: Math.max(0, 100 - 25 * e - 8 * w), issues };
}
