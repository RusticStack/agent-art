// Baked lighting for art_model exports (materials v2): a coloured lightmap on the unique UV set
// TEXCOORD_1 (one padded planar chart per face, the AO charting with a configurable gutter),
// bent normals and SSS thickness on the same charts, and SH9 light probes on a grid.
//
// Light: a directional sun (shadow rays), a sky dome (cosine-weighted hemisphere rays; open rays
// see the sky colour, closed ones see what they hit), point / spot / area lights from the model's
// light parts (windowed falloff, shadow rays; area lights = 4 x 4 samples over the rectangle),
// emissive surfaces (their emissive texel x KHR emissive strength is radiance that the gather
// rays pick up = bounce from glowing panels), and `bounce` passes of diffuse interreflection
// (albedo x the previous pass at the hit). Units: a lightmap value v means outgoing = albedo x v
// (a sun of intensity 1 straight on gives v = 1).
//
// Output is pixel-art friendly: sRGB encoded, quantised to `levels` per channel, optionally
// ordered-dithered (4x4 Bayer on lightmap texels), NEAREST sampled. Same input = same bytes.
import { BVH, hemisphere, hashf, aoAt, chartFaces, packCharts, chartSamples, chartUV, bakeVertexAO } from './bake.js';
import { srgbToLinear, linearToSrgb } from './materials.js';
import { bayer } from './util.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const hexLin = (s, what) => {
  const m = typeof s === 'string' && s.match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`${what} must be "#rrggbb"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(srgbToLinear);
};

// ---------- options ----------
/**
 * lightmap: true | {texel:4 px, padding:2 texels, samples:32, bounce:1, direct:true,
 * sun:{dir:[x,y,z] (toward the sun), color, intensity} | false, sky:{color, ground, intensity} | false,
 * levels:32 (per channel), dither:true, range:2 (max value), max_size:1024, emissive:1 (gain)}
 */
export function normLightmap(v) {
  if (!v) return null;
  const o = v === true ? {} : v;
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('lightmap must be true or {texel?, padding?, samples?, bounce?, direct?, sun?, sky?, levels?, dither?, range?, max_size?, emissive?}');
  const keys = ['texel', 'padding', 'samples', 'bounce', 'direct', 'sun', 'sky', 'levels', 'dither', 'range', 'max_size', 'emissive'];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`lightmap.${k} is not a field (${keys.join(', ')})`);
  const r = {
    texel: Number(o.texel ?? 4), padding: Math.round(Number(o.padding ?? 2)), samples: Math.max(4, Math.min(512, Math.round(Number(o.samples ?? 32)))), bounce: Math.max(0, Math.min(4, Math.round(Number(o.bounce ?? 1)))),
    direct: o.direct !== false, levels: Math.max(2, Math.min(256, Math.round(Number(o.levels ?? 32)))), dither: o.dither !== false, range: Number(o.range ?? 2), maxSize: Math.max(64, Math.min(4096, Math.round(Number(o.max_size ?? 1024)))), emissive: Number(o.emissive ?? 1),
  };
  if (!(r.texel > 0) || !(r.padding >= 1 && r.padding <= 8) || !(r.range > 0) || !(r.emissive >= 0)) throw new Error('lightmap texel > 0 px, padding 1..8 texels, range > 0, emissive >= 0');
  if (o.sun === false) r.sun = null;
  else {
    const s = o.sun || {};
    const d = norm((s.dir ?? [-0.45, 0.8, 0.4]).map(Number));
    if (d.some((x) => !Number.isFinite(x))) throw new Error('lightmap.sun.dir must be [x,y,z] toward the sun');
    r.sun = { dir: d, color: hexLin(s.color ?? '#fff1dc', 'sun.color'), intensity: Number(s.intensity ?? 1) };
  }
  if (o.sky === false) r.sky = null;
  else { const s = o.sky || {}; r.sky = { color: hexLin(s.color ?? '#9db6d6', 'sky.color'), ground: hexLin(s.ground ?? '#3b3632', 'sky.ground'), intensity: Number(s.intensity ?? 0.5) }; }
  return r;
}
/** probes: true | {spacing: px (default grid), samples:128, max:512, height?: px above the floor} */
export function normProbes(v, grid = 32) {
  if (!v) return null;
  const o = v === true ? {} : v;
  if (typeof o !== 'object') throw new Error('probes must be true or {spacing?:px, samples?:128, max?:512}');
  for (const k of Object.keys(o)) if (!['spacing', 'samples', 'max'].includes(k)) throw new Error(`probes.${k} is not a field (spacing, samples, max)`);
  const r = { spacing: Number(o.spacing ?? grid), samples: Math.max(16, Math.min(1024, Math.round(Number(o.samples ?? 128)))), max: Math.max(1, Math.min(4096, Math.round(Number(o.max ?? 512)))) };
  if (!(r.spacing > 0)) throw new Error('probes.spacing must be > 0 px');
  return r;
}
/** thickness: true | {distance:16 px, samples:16} (SSS thickness map on the lightmap charts) */
export function normThickness(v) {
  if (!v) return null;
  const o = v === true ? {} : typeof v === 'number' ? { distance: v } : v;
  const r = { distance: Number(o.distance ?? 16), samples: Math.max(4, Math.min(128, Math.round(Number(o.samples ?? 16)))) };
  if (!(r.distance > 0)) throw new Error('thickness.distance must be > 0 px');
  return r;
}

// ---------- scene: tagged triangles (for hit lookups) ----------
const translucent = (t) => !!(t.material?.blend || t.v2?.transmission);
/** BVH over opaque triangles of meshes + per triangle {g, i (first index in g.idx)}. */
function taggedBVH(meshes) {
  const tris = [], recs = [];
  for (const m of meshes) for (const g of m.groups.values()) {
    if (g.overlay || translucent(g.tex)) continue;
    for (let i = 0; i < g.idx.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = g.idx[i + k]; tris.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); }
      recs.push({ g, i });
    }
  }
  return { bvh: new BVH(Float32Array.from(tris)), recs };
}
const texel = (tex, data, u, v) => {
  const W = tex.width, H = tex.height;
  let x = Math.floor(u * W) % W, y = Math.floor(v * H) % H;
  if (x < 0) x += W; if (y < 0) y += H;
  return (y * W + x) * 4;
};
/** Surface data at a hit: albedo (linear), emissive radiance (linear x strength), lightmap texel index or -1. */
function surfaceAt(rec, hit, lm) {
  const { g, i } = rec, a = g.idx[i], b = g.idx[i + 1], c = g.idx[i + 2], w0 = 1 - hit.u - hit.v;
  const u = g.uv[a * 2] * w0 + g.uv[b * 2] * hit.u + g.uv[c * 2] * hit.v, v = g.uv[a * 2 + 1] * w0 + g.uv[b * 2 + 1] * hit.u + g.uv[c * 2 + 1] * hit.v;
  const t = g.tex, p = texel(t, t.data, u, v);
  const alb = [srgbToLinear(t.data[p]), srgbToLinear(t.data[p + 1]), srgbToLinear(t.data[p + 2])];
  let em = null;
  if (t.emissive) {
    const e = t.v2?.emissive, s = (e ? e.strength : 1) * lm.emissive, ea = t.emissive[p + 3] / 255;
    if (ea > 0) {
      if (e && e.color) { const m = (Math.max(t.emissive[p], t.emissive[p + 1], t.emissive[p + 2]) / 255) * ea; em = e.color.map((x) => x * m * s); }
      else em = [0, 1, 2].map((k) => srgbToLinear(t.emissive[p + k]) * ea * s);
    }
  } else if (t.v2?.emissive?.color) em = t.v2.emissive.color.map((x) => x * t.v2.emissive.strength * lm.emissive);
  let li = -1;
  if (g.uv1 && g.lmW) {
    const lu = g.uv1[a * 2] * w0 + g.uv1[b * 2] * hit.u + g.uv1[c * 2] * hit.v, lv = g.uv1[a * 2 + 1] * w0 + g.uv1[b * 2 + 1] * hit.u + g.uv1[c * 2 + 1] * hit.v;
    const x = Math.min(g.lmW - 1, Math.max(0, Math.floor(lu * g.lmW))), y = Math.min(g.lmH - 1, Math.max(0, Math.floor(lv * g.lmH)));
    li = y * g.lmW + x;
  }
  return { alb, em, li };
}

// ---------- direct light ----------
const falloff = (d, range) => { const x = Math.max(0, 1 - (d / range) ** 2); return x * x; };
/** Direct irradiance (linear rgb) at p with normal n from sun + light parts (shadow rays). */
function directAt(bvh, p, n, lm, lights, diag, bias = 0.05) {
  const E = [0, 0, 0];
  const org = [p[0] + n[0] * bias, p[1] + n[1] * bias, p[2] + n[2] * bias];
  if (lm.sun && lm.direct) {
    const L = lm.sun.dir, c = dot(n, L);
    if (c > 0 && bvh.hit(org, L, diag) >= diag) for (let k = 0; k < 3; k++) E[k] += lm.sun.color[k] * lm.sun.intensity * c;
  }
  if (!lm.direct) return E;
  for (const Lp of lights) {
    const pts = Lp.kind === 'area' ? areaSamples(Lp) : [[Lp.pos, 1]];
    for (const [q, w] of pts) {
      const dv = [q[0] - org[0], q[1] - org[1], q[2] - org[2]], d = Math.hypot(dv[0], dv[1], dv[2]);
      if (d < 1e-6 || d >= Lp.range) continue;
      const l = [dv[0] / d, dv[1] / d, dv[2] / d], c = dot(n, l);
      if (c <= 0) continue;
      let k = falloff(d, Lp.range) * c * w * Lp.intensity;
      if (Lp.kind === 'area') k *= Math.max(0, -dot(l, Lp.dir)) * 2; // cosine at the emitter (x2: a one-sided panel = a point light of the same intensity, on average)
      if (Lp.kind === 'spot') { const ca = -dot(l, Lp.dir), c0 = Math.cos((Lp.cone * Math.PI) / 360), c1 = Math.cos((Lp.cone * 0.3 * Math.PI) / 180); const s = Math.max(0, Math.min(1, (ca - c0) / Math.max(1e-4, c1 - c0))); k *= s * s * (3 - 2 * s); } // smooth edge from the outer half-angle to 60% of it
      if (k <= 0) continue;
      if (bvh.hit(org, l, d - 0.05) < d - 0.05) continue;
      for (let q2 = 0; q2 < 3; q2++) E[q2] += Lp.color[q2] * k;
    }
  }
  return E;
}
function areaSamples(L) {
  if (L._pts) return L._pts;
  const u = L.u, v = cross(L.dir, u), out = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const a = ((i + 0.5) / 4 - 0.5) * L.size[0], b = ((j + 0.5) / 4 - 0.5) * L.size[1];
    out.push([[L.pos[0] + u[0] * a + v[0] * b, L.pos[1] + u[1] * a + v[1] * b, L.pos[2] + u[2] * a + v[2] * b], 1 / 16]);
  }
  Object.defineProperty(L, '_pts', { value: out, enumerable: false });
  return out;
}
const skyAt = (lm, d) => {
  if (!lm.sky) return [0, 0, 0];
  const t = Math.max(0, Math.min(1, d[1] * 0.5 + 0.5)), s = lm.sky;
  // radiance = intensity / PI: an open up-facing surface receives `intensity`
  return [0, 1, 2].map((k) => ((s.ground[k] * (1 - t) + s.color[k] * t) * s.intensity) / Math.PI);
};
/** Tangent frame + per-sample rotation -> world direction of hemisphere sample (x0, y0, z). */
const frame = (n) => { const t = Math.abs(n[1]) < 0.9 ? norm(cross([0, 1, 0], n)) : norm(cross([1, 0, 0], n)); return [t, cross(n, t)]; };

// ---------- the bake ----------
/**
 * Bake AO (texture, optional bent normals), the lightmap and SSS thickness onto one chart layout.
 * sets: [{meshes, occluders?}] (each set shares one BVH, e.g. one LOD level; all share the atlas).
 * opts: {ao (normAO), lm (normLightmap), thickness, lights (px), bounds (px)}
 * -> {ao?, bent?, lightmap?, thickness?, stats, scene (for probes)}
 */
export function bakeLighting(sets, { ao, lm, thickness, lights = [], bounds }) {
  const t0 = performance.now();
  const prepared = sets.map((s) => { const all = [...s.meshes, ...(s.occluders || [])]; return { meshes: s.meshes, ...taggedBVH(all) }; });
  if (ao && (ao.mode === 'vertex' || ao.mode === 'both')) for (const s of prepared) for (const m of s.meshes) bakeVertexAO(m, s.bvh, ao);
  const wantAOtex = ao && ao.mode !== 'vertex';
  const items = prepared.flatMap((s) => s.meshes.map((mesh) => ({ mesh, bvh: s.bvh, recs: s.recs })));
  const charts = chartFaces(items);
  const texelPx = lm ? lm.texel : ao ? ao.texel : thickness ? 4 : 2;
  const pad = lm ? lm.padding : 1;
  const maxSize = lm ? lm.maxSize : ao ? ao.maxSize : 1024;
  const { W, H, texel } = packCharts(charts, texelPx, maxSize, pad);
  for (const c of charts) { chartUV(c, W, H, texel); c.g.lmW = W; c.g.lmH = H; }
  const out = { stats: { size: [W, H], texel_px: +texel.toFixed(4), charts: charts.length, padding: pad } };
  const diag = bounds ? Math.hypot(...bounds.max.map((v, k) => v - bounds.min[k])) * 2 + 1 : 1e5;
  // per texel buffers (linear), filled chart by chart, padding dilated from the edge texels
  const N = W * H;
  const aoBuf = wantAOtex ? new Float32Array(N).fill(1) : null, bentBuf = ao && ao.bent ? new Float32Array(N * 3) : null;
  const thBuf = thickness ? new Float32Array(N).fill(1) : null;
  const D = lm ? new Float32Array(N * 3) : null; // direct + sky + emissive
  const owner = new Int32Array(N).fill(-1);
  const dirsAO = ao ? hemisphere(ao.samples) : null, dirsL = lm ? hemisphere(lm.samples) : null, dirsT = thickness ? hemisphere(thickness.samples) : null;
  // gather hits for bounce passes: per texel, per sample -> lightmap texel of the hit (or -1) and its albedo
  const hitLi = lm && lm.bounce ? new Int32Array(N * lm.samples).fill(-1) : null, hitAlb = lm && lm.bounce ? new Float32Array(N * lm.samples * 3) : null;
  let texels = 0;
  charts.forEach((c, ci) => {
    const { f } = c, n = f.n, [ft, fb] = frame(n);
    const iw = c.w - 2 * pad, ih = c.h - 2 * pad;
    chartSamples(c, texel, (p, i, j) => {
      const ti = (c.y + pad + j) * W + c.x + pad + i;
      owner[ti] = ci; texels++;
      const rot = hashf(c.x + i, c.y + j) * 2 * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
      const world = (x0, y0, z) => { const x = x0 * cr - y0 * sr, y = x0 * sr + y0 * cr; return [ft[0] * x + fb[0] * y + n[0] * z, ft[1] * x + fb[1] * y + n[1] * z, ft[2] * x + fb[2] * y + n[2] * z]; };
      if (wantAOtex) aoBuf[ti] = aoAt(c.bvh, p, n, dirsAO, ao, rot);
      if (bentBuf) {
        const org = [p[0] + n[0] * ao.bias, p[1] + n[1] * ao.bias, p[2] + n[2] * ao.bias];
        let bx = 0, by = 0, bz = 0;
        for (const [x0, y0, z] of dirsAO) { const d = world(x0, y0, z); if (c.bvh.hit(org, d, ao.distance) >= ao.distance) { bx += d[0]; by += d[1]; bz += d[2]; } }
        const l = Math.hypot(bx, by, bz);
        const b = l > 1e-9 ? [bx / l, by / l, bz / l] : n;
        bentBuf.set(b, ti * 3);
      }
      if (thBuf) {
        const org = [p[0] - n[0] * 0.05, p[1] - n[1] * 0.05, p[2] - n[2] * 0.05];
        let s = 0;
        for (const [x0, y0, z] of dirsT) { const d = world(x0, y0, -z); const h = c.bvh.hit(org, d, thickness.distance); s += Math.min(1, h / thickness.distance); }
        thBuf[ti] = s / dirsT.length;
      }
      if (D) {
        const E = directAt(c.bvh, p, n, lm, lights, diag);
        const org = [p[0] + n[0] * 0.05, p[1] + n[1] * 0.05, p[2] + n[2] * 0.05];
        const k = Math.PI / dirsL.length;
        dirsL.forEach(([x0, y0, z], si) => {
          const d = world(x0, y0, z), h = c.bvh.hitTri(org, d, diag);
          if (!h) { const L = skyAt(lm, d); E[0] += L[0] * k; E[1] += L[1] * k; E[2] += L[2] * k; return; }
          const s = surfaceAt(c.item.recs[h.tri], h, lm);
          if (s.em) { E[0] += s.em[0] * k; E[1] += s.em[1] * k; E[2] += s.em[2] * k; }
          if (hitLi) { hitLi[ti * lm.samples + si] = s.li; hitAlb.set(s.alb, (ti * lm.samples + si) * 3); }
        });
        D.set(E, ti * 3);
      }
      return 0;
    });
    void iw; void ih;
  });
  // bounce passes: each adds albedo x (previous total at the hit) / samples
  let Ltot = D;
  if (D && lm.bounce) {
    for (let pass = 0; pass < lm.bounce; pass++) {
      const next = new Float32Array(D);
      const S = lm.samples;
      for (let ti = 0; ti < N; ti++) {
        if (owner[ti] < 0) continue;
        let r = 0, g = 0, b = 0;
        for (let s = 0; s < S; s++) { const li = hitLi[ti * S + s]; if (li < 0) continue; const q = (ti * S + s) * 3; r += hitAlb[q] * Ltot[li * 3]; g += hitAlb[q + 1] * Ltot[li * 3 + 1]; b += hitAlb[q + 2] * Ltot[li * 3 + 2]; }
        next[ti * 3] += r / S; next[ti * 3 + 1] += g / S; next[ti * 3 + 2] += b / S;
      }
      Ltot = next;
    }
  }
  // padding: copy the nearest owned texel of the same chart (gutter = edge texels, like AO)
  const dilate = (fill) => {
    for (const [ci, c] of charts.entries()) {
      const iw = c.w - 2 * pad, ih = c.h - 2 * pad;
      for (let j = -pad; j < ih + pad; j++) for (let i = -pad; i < iw + pad; i++) {
        if (i >= 0 && i < iw && j >= 0 && j < ih) continue;
        const src = (c.y + pad + Math.max(0, Math.min(ih - 1, j))) * W + c.x + pad + Math.max(0, Math.min(iw - 1, i));
        fill((c.y + pad + j) * W + c.x + pad + i, src, ci);
      }
    }
  };
  const img = () => { const d = new Uint8ClampedArray(N * 4); for (let i = 0; i < N; i++) d.set([255, 255, 255, 255], i * 4); return d; };
  if (aoBuf) {
    dilate((dst, src) => { aoBuf[dst] = aoBuf[src]; });
    const data = img();
    for (let i = 0; i < N; i++) { const g8 = Math.round(aoBuf[i] * 255); data[i * 4] = g8; data[i * 4 + 1] = g8; data[i * 4 + 2] = g8; }
    out.ao = { key: 'ao', name: 'ao', width: W, height: H, data, texel: +texel.toFixed(4), charts: charts.length, texels };
  }
  if (bentBuf) {
    dilate((dst, src) => { bentBuf.copyWithin(dst * 3, src * 3, src * 3 + 3); });
    const data = img();
    for (let i = 0; i < N; i++) { if (owner[i] < 0 && !bentBuf[i * 3] && !bentBuf[i * 3 + 1] && !bentBuf[i * 3 + 2]) { data.set([128, 128, 255], i * 4); continue; } for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round((bentBuf[i * 3 + k] * 0.5 + 0.5) * 255); }
    out.bent = { width: W, height: H, data };
  }
  if (thBuf) {
    dilate((dst, src) => { thBuf[dst] = thBuf[src]; });
    const data = img();
    for (let i = 0; i < N; i++) { const g8 = Math.round(thBuf[i] * 255); data[i * 4] = g8; data[i * 4 + 1] = g8; data[i * 4 + 2] = g8; }
    out.thickness = { width: W, height: H, data, distance: thickness.distance };
  }
  if (Ltot) {
    dilate((dst, src) => { Ltot.copyWithin(dst * 3, src * 3, src * 3 + 3); });
    const data = img();
    let peak = 0, clipped = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, th = lm.dither ? bayer(x, y) : 0.5;
      for (let k = 0; k < 3; k++) {
        const v = Ltot[i * 3 + k];
        if (v > peak) peak = v;
        if (v > lm.range) clipped++;
        const e = linearToSrgb(Math.max(0, Math.min(1, v / lm.range)));
        data[i * 4 + k] = Math.round((Math.min(lm.levels - 1, Math.floor(e * (lm.levels - 1) + th)) / (lm.levels - 1)) * 255);
      }
    }
    out.lightmap = { key: 'lightmap', width: W, height: H, data, range: lm.range, levels: lm.levels, linear: Ltot };
    Object.assign(out.stats, { samples: lm.samples, bounce: lm.bounce, lights: lights.length, sun: !!lm.sun, sky: !!lm.sky, peak: +peak.toFixed(3), clipped_texels: clipped });
  }
  out.stats.texels = texels;
  out.stats.ms = Math.round(performance.now() - t0);
  out.scene = { prepared, lm, lights, diag, Ltot, W, H };
  return out;
}

/** Probe-only scene (no lightmap): tagged BVH of the first set + light options. */
export function probeScene(sets, lm, lights, bounds) {
  const s = sets[0];
  return { prepared: [{ meshes: s.meshes, ...taggedBVH([...s.meshes, ...(s.occluders || [])]) }], lm, lights, diag: Math.hypot(...bounds.max.map((v, k) => v - bounds.min[k])) * 2 + 1, Ltot: null };
}

// ---------- SH9 light probes ----------
/** Real SH basis (three.js SphericalHarmonics3.getBasisAt order: L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22). */
export function shBasis(d) {
  const [x, y, z] = d;
  return [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
}
/** Evenly spread unit directions (Fibonacci sphere, deterministic). */
export function sphereDirs(n) {
  const out = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) { const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * ga; out.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
  return out;
}
/**
 * SH9 radiance probes on a grid over bounds (px). Each probe gathers sky / emissive / lit surfaces
 * (albedo x lightmap / PI) over sphere rays plus the direct lights as deltas (E x Y(dir)).
 * scene: bakeLighting(...).scene, or {prepared, lm, lights, diag} without a lightmap.
 * -> {origin, spacing, dims, count, coefficients: [[27 numbers: 9 x rgb] per probe], ms}
 */
export function bakeProbes(scene, bounds, po, scale) {
  const t0 = performance.now();
  const { lm, lights, diag } = scene;
  const set = scene.prepared[0];
  const size = bounds.max.map((v, k) => v - bounds.min[k]);
  let sp = po.spacing;
  const dimsOf = (s) => size.map((v) => Math.max(1, Math.floor(v / s) + 1));
  while (dimsOf(sp).reduce((a, b) => a * b, 1) > po.max) sp *= 1.25;
  const dims = dimsOf(sp);
  const origin = bounds.min.map((v, k) => v + (size[k] - (dims[k] - 1) * sp) / 2);
  const dirs = sphereDirs(po.samples), basis = dirs.map(shBasis);
  const coefficients = [];
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const p = [origin[0] + x * sp, origin[1] + y * sp, origin[2] + z * sp];
    const c = new Float64Array(27);
    const k = (4 * Math.PI) / dirs.length;
    dirs.forEach((d, i) => {
      const h = set.bvh.hitTri(p, d, diag);
      let L;
      if (!h) L = skyAt(lm, d);
      else {
        const s = surfaceAt(set.recs[h.tri], h, lm);
        L = [0, 0, 0];
        if (s.em) for (let q = 0; q < 3; q++) L[q] += s.em[q];
        if (scene.Ltot && s.li >= 0) for (let q = 0; q < 3; q++) L[q] += (s.alb[q] * scene.Ltot[s.li * 3 + q]) / Math.PI;
      }
      for (let b = 0; b < 9; b++) for (let q = 0; q < 3; q++) c[b * 3 + q] += L[q] * basis[i][b] * k;
    });
    // direct lights as deltas (irradiance at normal incidence x basis at the light direction)
    const delta = (dir, E) => { const Y = shBasis(dir); for (let b = 0; b < 9; b++) for (let q = 0; q < 3; q++) c[b * 3 + q] += E[q] * Y[b]; };
    if (lm.sun && lm.direct && set.bvh.hit(p, lm.sun.dir, diag) >= diag) delta(lm.sun.dir, lm.sun.color.map((v) => v * lm.sun.intensity));
    if (lm.direct) for (const Lp of lights) {
      const pts = Lp.kind === 'area' ? areaSamples(Lp) : [[Lp.pos, 1]];
      for (const [q, w] of pts) {
        const dv = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], dd = Math.hypot(...dv);
        if (dd < 1e-6 || dd >= Lp.range) continue;
        const l = dv.map((v) => v / dd);
        if (set.bvh.hit(p, l, dd - 0.05) < dd - 0.05) continue;
        let kk = falloff(dd, Lp.range) * w * Lp.intensity;
        if (Lp.kind === 'area') kk *= Math.max(0, -dot(l, Lp.dir)) * 2;
        if (Lp.kind === 'spot') { const ca = -dot(l, Lp.dir); if (ca < Math.cos((Lp.cone * Math.PI) / 360)) continue; }
        delta(l, Lp.color.map((v) => v * kk));
      }
    }
    coefficients.push(Array.from(c, (v) => +v.toFixed(5)));
  }
  return { origin: origin.map((v) => +(v / scale).toFixed(5)), spacing: +(sp / scale).toFixed(5), dims, count: coefficients.length, coefficients, samples: po.samples, ms: Math.round(performance.now() - t0) };
}
/** Irradiance at normal n from SH9 radiance coefficients (three.js shGetIrradianceAt). */
export function shIrradiance(c, n) {
  const [x, y, z] = n;
  const C1 = 0.429043, C2 = 0.511664, C3 = 0.743125, C4 = 0.886227, C5 = 0.247708;
  const L = (i, q) => c[i * 3 + q];
  return [0, 1, 2].map((q) => C1 * L(8, q) * (x * x - y * y) + C3 * L(6, q) * z * z + C4 * L(0, q) - C5 * L(6, q) + 2 * C1 * (L(4, q) * x * y + L(7, q) * x * z + L(5, q) * y * z) + 2 * C2 * (L(3, q) * x + L(1, q) * y + L(2, q) * z));
}
