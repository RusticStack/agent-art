// Software preview shading for materials v2 (used by raster3d's rasterCore when a group has v2
// data, a lightmap, a detail map, parallax, or when a channel view is asked for). Approximations
// tuned to read like the engine at pixel scale, not a reference renderer:
//   lightmap = diffuse irradiance (replaces the preview's Lambert + ambient), AO / bent / thickness
//   from the TEXCOORD_1 charts, clearcoat = a second sharp lobe + sky reflection, anisotropy =
//   Ward lobe stretched along the (rotated) tangent, sheen = grazing rim, transmission = see-through
//   with tint + reflection (drawn with the translucent pass), subsurface = wrapped back light,
//   emissive x strength (overflow kept for bloom), detail = overlay albedo + UDN normal blend,
//   parallax = pixel-snapped steep parallax on the height map.
import { anisotropyTexture } from './materials.js';
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const s2l = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
const SKY = [0.62, 0.72, 0.86], GROUND = [0.18, 0.17, 0.16];

export const CHANNELS = ['lit', 'albedo', 'normal', 'world_normal', 'tangent', 'orm', 'metal', 'rough', 'ao', 'emissive', 'height', 'lightmap', 'bent', 'thickness', 'uv1', 'detail', 'clearcoat', 'sheen', 'transmission', 'anisotropy', 'subsurface'];

/** Does this group need the v2 shader? */
export function wantsShade2(g, opts) {
  const t = g.tex;
  return !g.overlay && !!(opts.channel || t.v2 || t.detail || g.lmTex || g.bentTex || g.thTex || (opts.pom && t.heightOf));
}

/**
 * Per-group shader. -> {pom(u, v, P (world px), N, TT, BU) -> [u, v] | null, color(c) -> [r, g, b]
 * (0..255+, may exceed for bloom), opacity (translucent v2 groups), transmissive}
 * c: {p (texel), u, v, n (unit), TT, BU, L, V, amb, uv1 [u, v] | null, aoV (vertex AO) | 1, ndc}
 */
export function makeShade2(g, opts) {
  const t = g.tex, v2 = t.v2 || {}, W = t.width, H = t.height;
  const ch = opts.channel || 'lit';
  const height = (opts.pom || ch === 'height') && t.heightOf ? (t._h || (t._h = t.heightOf())) : null;
  const pomScale = opts.pom && height ? (v2.height ? v2.height.scale : 2) : 0;
  const det = t.detail || null;
  const lm = g.lmTex || null, lmLin = lm && lm.linear ? lm.linear : null;
  const sample = (img, w, h, u, v) => { let x = Math.floor(u * w) % w, y = Math.floor(v * h) % h; if (x < 0) x += w; if (y < 0) y += h; return (y * w + x) * 4; };
  const at1 = (img, uv1) => { const x = Math.min(img.width - 1, Math.max(0, Math.floor(uv1[0] * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor(uv1[1] * img.height))); return y * img.width + x; };
  const em = v2.emissive || null;
  const tr = v2.transmission || null;
  const out = { transmissive: !!tr, opacity: tr ? Math.max(0.12, 1 - 0.85 * tr.factor) : null };
  if (pomScale) {
    // steep parallax in texel space (world-tiled UVs: 1 texel = 1 px), then snap to the texel centre
    out.pom = (u, v, P, N, TT, BU) => {
      if (!TT || !opts.eye) return [u, v];
      const Vw = norm([opts.eye[0] - P[0], opts.eye[1] - P[1], opts.eye[2] - P[2]]);
      const vt = [dot(Vw, TT), dot(Vw, BU), Math.max(0.15, dot(Vw, N))];
      const steps = Math.max(4, Math.min(24, Math.ceil(pomScale * 2 / vt[2])));
      const du = (-vt[0] / vt[2]) * pomScale / W, dv = (vt[1] / vt[2]) * pomScale / H; // BU = image up = -v
      let cu = u, cv = v;
      for (let s = 0; s <= steps; s++) {
        const depth = s / steps, hu = u + du * depth, hv = v + dv * depth;
        const h = height[(((Math.floor(hv * H) % H) + H) % H) * W + (((Math.floor(hu * W) % W) + W) % W)];
        cu = hu; cv = hv;
        if (1 - h <= depth) break;
      }
      return [(Math.floor(cu * W) + 0.5) / W, (Math.floor(cv * H) + 0.5) / H];
    };
  }
  out.color = (c) => {
    const { p } = c, td = t.data;
    let n = c.n;
    // detail: tiling albedo (overlay around mid grey) + normal (UDN blend), at uv * scale
    let albedo = [td[p], td[p + 1], td[p + 2]];
    let dp = -1;
    if (det) {
      dp = sample(det.data, det.width, det.height, c.u * W / det.width * det.scale, c.v * H / det.height * det.scale);
      const k = det.strength;
      if (!opts.noDetail) albedo = albedo.map((x, i) => x * (1 + k * ((det.data[dp + i] / 127.5) - 1)));
    }
    if (t.normal && c.TT) {
      const nx = t.normal[p] / 127.5 - 1, ny = t.normal[p + 1] / 127.5 - 1, nz = t.normal[p + 2] / 127.5 - 1;
      let tx = nx, ty = ny, tz = nz;
      if (det && det.normal && !opts.noDetail) { const ex = det.normal[dp] / 127.5 - 1, ey = det.normal[dp + 1] / 127.5 - 1; tx += ex * det.strength; ty += ey * det.strength; }
      n = norm([c.TT[0] * tx + c.BU[0] * ty + n[0] * tz, c.TT[1] * tx + c.BU[1] * ty + n[1] * tz, c.TT[2] * tx + c.BU[2] * ty + n[2] * tz]);
    } else if (det && det.normal && c.TT && !opts.noDetail) {
      const ex = (det.normal[dp] / 127.5 - 1) * det.strength, ey = (det.normal[dp + 1] / 127.5 - 1) * det.strength;
      n = norm([n[0] + c.TT[0] * ex + c.BU[0] * ey, n[1] + c.TT[1] * ex + c.BU[1] * ey, n[2] + c.TT[2] * ex + c.BU[2] * ey]);
    }
    const metal = t.mr ? t.mr[p + 2] / 255 : t.pbr ? t.pbr.metal : 0, rough = t.mr ? t.mr[p + 1] / 255 : t.pbr ? t.pbr.rough : 1;
    let ao = c.aoV;
    if (g.aoTex && c.uv1) ao *= g.aoTex.data[at1(g.aoTex, c.uv1) * 4] / 255;
    // ---- channel views (unlit)
    if (ch !== 'lit') {
      const grey = (v) => [v * 255, v * 255, v * 255];
      switch (ch) {
        case 'albedo': return albedo;
        case 'normal': return t.normal ? [t.normal[p], t.normal[p + 1], t.normal[p + 2]] : [128, 128, 255];
        case 'world_normal': return n.map((x) => (x * 0.5 + 0.5) * 255);
        case 'tangent': return c.TT ? c.TT.map((x) => (x * 0.5 + 0.5) * 255) : [128, 128, 128];
        case 'orm': { const o = t.aoData ? t.aoData[p] : 255; return [o * ao, rough * 255, metal * 255]; }
        case 'metal': return grey(metal);
        case 'rough': return grey(rough);
        case 'ao': return grey(ao);
        case 'emissive': {
          if (!t.emissive && !(em && em.color)) return [0, 0, 0];
          const s = em ? em.strength : 1;
          if (em && em.color) { const m = t.emissive ? (Math.max(t.emissive[p], t.emissive[p + 1], t.emissive[p + 2]) / 255) * (t.emissive[p + 3] / 255) : 1; return em.color.map((x) => l2s(Math.min(1, x * m * Math.min(1, s)))); }
          const ea = t.emissive[p + 3] / 255; return [t.emissive[p] * ea, t.emissive[p + 1] * ea, t.emissive[p + 2] * ea].map((x) => x * Math.min(1, s));
        }
        case 'height': return height ? grey(height[Math.floor(p / 4)]) : [0, 0, 0];
        case 'lightmap': { if (!lm || !c.uv1) return [255, 0, 255]; const q = at1(lm, c.uv1) * 4; return [lm.data[q], lm.data[q + 1], lm.data[q + 2]]; }
        case 'bent': { if (!g.bentTex || !c.uv1) return [255, 0, 255]; const q = at1(g.bentTex, c.uv1) * 4; return [g.bentTex.data[q], g.bentTex.data[q + 1], g.bentTex.data[q + 2]]; }
        case 'thickness': { if (!g.thTex || !c.uv1) return [255, 0, 255]; const q = at1(g.thTex, c.uv1) * 4; return [g.thTex.data[q], g.thTex.data[q + 1], g.thTex.data[q + 2]]; }
        case 'uv1': { if (!c.uv1) return [255, 0, 255]; const cx = Math.floor(c.uv1[0] * 64), cy = Math.floor(c.uv1[1] * 64); return [c.uv1[0] * 255, c.uv1[1] * 255, (cx + cy) % 2 ? 200 : 60]; }
        case 'detail': return det ? [det.data[dp], det.data[dp + 1], det.data[dp + 2]] : [128, 128, 128];
        case 'clearcoat': return grey(v2.clearcoat ? v2.clearcoat.factor * (1 - v2.clearcoat.rough) : 0);
        case 'sheen': return v2.sheen ? v2.sheen.color.map((x) => l2s(x * (1 - v2.sheen.rough * 0.5))) : [0, 0, 0];
        case 'transmission': return grey(tr ? tr.factor : 0);
        case 'subsurface': return v2.subsurface ? v2.subsurface.color.map((x) => l2s(x * v2.subsurface.factor)) : [0, 0, 0];
        case 'anisotropy': {
          if (!v2.anisotropy) return [128, 128, 0];
          if (v2.anisotropy.pattern === 'flat') { const r = (v2.anisotropy.rotation * Math.PI) / 180; return [(Math.cos(r) * 0.5 + 0.5) * 255, (Math.sin(r) * 0.5 + 0.5) * 255, v2.anisotropy.strength * 255]; }
          const at = t._aniso || (t._aniso = anisotropyTexture(W, H, v2.anisotropy.pattern));
          return [at[p], at[p + 1], at[p + 2] * v2.anisotropy.strength];
        }
        default: return albedo;
      }
    }
    // ---- lit
    const { L, V, amb } = c;
    const ndl = Math.max(0, dot(n, L)), ndv = Math.max(1e-3, dot(n, V));
    const Hh = norm([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
    let diffL;
    if (lm && c.uv1) {
      const q = at1(lm, c.uv1);
      const irr = lmLin ? [lmLin[q * 3], lmLin[q * 3 + 1], lmLin[q * 3 + 2]] : [0, 1, 2].map((k) => s2l(lm.data[q * 4 + k]) * lm.range);
      diffL = irr.map((x) => Math.pow(Math.min(2, x), 1 / 2.2)); // irradiance as a brightness multiplier on the (sRGB) albedo
    } else {
      let a2 = amb;
      if (g.bentTex && c.uv1) { const q = at1(g.bentTex, c.uv1) * 4, b = [g.bentTex.data[q] / 127.5 - 1, g.bentTex.data[q + 1] / 127.5 - 1, g.bentTex.data[q + 2] / 127.5 - 1]; a2 = amb * (0.6 + 0.4 * (b[1] * 0.5 + 0.5)); }
      const d = a2 + (1 - a2) * ndl;
      diffL = [d, d, d];
    }
    // subsurface: wrapped light + light through the back
    if (v2.subsurface) {
      const s = v2.subsurface, back = Math.max(0, -dot(n, L)) * 0.8 + Math.max(0, (dot(n, L) + 0.5) / 1.5) * 0.3;
      let th = 0.5;
      if (g.thTex && c.uv1) th = g.thTex.data[at1(g.thTex, c.uv1) * 4] / 255;
      diffL = diffL.map((x, k) => x + back * s.factor * s.color[k] * (1.2 - th));
    }
    // specular: isotropic Blinn-Phong, or Ward along the anisotropy direction
    let spec;
    if (v2.anisotropy && c.TT) {
      const a = v2.anisotropy, r = (a.rotation * Math.PI) / 180;
      let dx = Math.cos(r), dy = Math.sin(r), st = a.strength;
      if (a.pattern !== 'flat') {
        const at = t._aniso || (t._aniso = anisotropyTexture(W, H, a.pattern));
        const ex = at[p] / 127.5 - 1, ey = at[p + 1] / 127.5 - 1;
        dx = ex * Math.cos(r) - ey * Math.sin(r); dy = ex * Math.sin(r) + ey * Math.cos(r); st *= at[p + 2] / 255;
      }
      const Ta = norm([c.TT[0] * dx + c.BU[0] * dy, c.TT[1] * dx + c.BU[1] * dy, c.TT[2] * dx + c.BU[2] * dy]), Ba = cross(n, Ta);
      const ax = Math.max(0.04, rough * rough * (1 + 2.5 * st)), ay = Math.max(0.02, rough * rough * Math.max(0.08, 1 - st));
      const hn = Math.max(1e-3, dot(Hh, n)), ht = dot(Hh, Ta) / ax, hb = dot(Hh, Ba) / ay;
      spec = ndl > 0 ? Math.min(2.5, (Math.exp(-(ht * ht + hb * hb) / (hn * hn)) / (4 * Math.PI * ax * ay * Math.sqrt(ndl * ndv))) * ndl * 0.6) : 0;
    } else {
      const al2 = Math.max(0.03, rough * rough), shin = Math.max(0, 2 / (al2 * al2) - 2);
      spec = shin > 0 ? Math.min(1.5, ((shin + 2) / 8) * Math.pow(Math.max(0, dot(n, Hh)), shin)) * ndl : 0;
    }
    if (lm && c.uv1) spec *= Math.min(1, (diffL[0] + diffL[1] + diffL[2]) / 3 + 0.25);
    const kd = (1 - metal), f0 = 0.04 * (1 - metal);
    let col = [0, 1, 2].map((k) => (albedo[k] * kd * diffL[k] + metal * albedo[k] * (amb * 0.55 + 0.35 * ndl) * (lm ? diffL[k] : 1) + (f0 * 255 + albedo[k] * metal) * spec) * ao);
    // clearcoat: a second sharp lobe + a sky reflection with Fresnel
    if (v2.clearcoat) {
      const cc = v2.clearcoat, Fr = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
      const R = [2 * dot(c.n, V) * c.n[0] - V[0], 2 * dot(c.n, V) * c.n[1] - V[1], 2 * dot(c.n, V) * c.n[2] - V[2]];
      const sk = R[1] * 0.5 + 0.5, env = SKY.map((x, k) => GROUND[k] * (1 - sk) + x * sk);
      const al2 = Math.max(0.002, cc.rough * cc.rough), shin = 2 / (al2 * al2) - 2;
      const ccs = Math.min(3, ((shin + 2) / 8) * Math.pow(Math.max(0, dot(c.n, Hh)), shin)) * ndl;
      col = col.map((x, k) => x * (1 - Fr * cc.factor) + cc.factor * (Fr * env[k] * 255 * (1 - cc.rough) * ao + ccs * 255 * 0.5));
    }
    if (v2.sheen) {
      const sh = v2.sheen, rim = Math.pow(1 - ndv, 2.5) * (0.35 + 0.65 * (amb + (1 - amb) * Math.max(0, dot(n, L) * 0.5 + 0.5)));
      col = col.map((x, k) => x + l2s(sh.color[k]) * rim * (1 - sh.rough * 0.4) * 0.9 * ao);
    }
    if (tr) {
      // see-through: the colour drawn over the background is tint + reflections (opacity from out.opacity)
      const Fr = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
      const R = [2 * dot(n, V) * n[0] - V[0], 2 * dot(n, V) * n[1] - V[1], 2 * dot(n, V) * n[2] - V[2]];
      const sk = R[1] * 0.5 + 0.5, env = SKY.map((x, k) => GROUND[k] * (1 - sk) + x * sk);
      const tint = tr.attenuation ? tr.attenuation.color : [1, 1, 1];
      col = col.map((x, k) => x * 0.35 + tint[k] * 90 + Fr * env[k] * 255 * 1.6 + spec * 255);
    }
    // emissive x strength (overflow above 255 feeds bloom)
    if (t.emissive || (em && em.color)) {
      const s = em ? em.strength : 1;
      let e;
      if (em && em.color) { const m = t.emissive ? (Math.max(t.emissive[p], t.emissive[p + 1], t.emissive[p + 2]) / 255) * (t.emissive[p + 3] / 255) : 1; e = em.color.map((x) => l2s(Math.min(1, x)) * m * s); }
      else { const ea = t.emissive[p + 3] / 255; e = [t.emissive[p] * ea * s, t.emissive[p + 1] * ea * s, t.emissive[p + 2] * ea * s]; }
      col = col.map((x, k) => x + e[k]);
    }
    return col;
  };
  return out;
}
