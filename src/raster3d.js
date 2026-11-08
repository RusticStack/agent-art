// Software rasterizer for model previews: z-buffer, nearest texture sampling, alpha test (0.5),
// alpha BLEND for translucent parts (drawn last, no depth write), backface culling (not on double_sided), Lambert light from the top-left plus ambient, emissive. Orthographic views
// share one scale (sizes compare across views); "game" is a 38° pitch perspective 3/4 camera.
import { packImages } from './sheet.js';
import { cross, dot, norm } from './model3d.js';

export const VIEWS = {
  front: { yaw: 0, pitch: 0 }, back: { yaw: 180, pitch: 0 }, side: { yaw: 90, pitch: 0 }, right: { yaw: 90, pitch: 0 }, left: { yaw: -90, pitch: 0 },
  top: { yaw: 0, pitch: 90 }, iso: { yaw: 45, pitch: 30 }, game: { yaw: 0, pitch: 38, perspective: true, fov: 30 },
};
const LIGHT = norm([-0.5, 0.8, 0.45]);
const BG = [30, 33, 40];

export function resolveView(v) {
  const o = typeof v === 'string' ? (VIEWS[v] ? { ...VIEWS[v], label: v } : null) : { ...(VIEWS[v.view] || {}), ...v, label: v.label || v.view || 'custom' };
  if (!o) throw new Error(`Unknown view "${v}". Views: ${Object.keys(VIEWS).join(', ')} or {yaw, pitch, perspective?, fov?}`);
  return { yaw: Number(o.yaw ?? 0), pitch: Number(o.pitch ?? 0), perspective: !!o.perspective, fov: Number(o.fov ?? 30), label: o.label };
}

/** Project every vertex of every group: sx, sy (unscaled), depth (bigger = closer), w (1/dist or 1). */
function project(groups, v, center, radius) {
  const yr = (v.yaw * Math.PI) / 180, pr = (v.pitch * Math.PI) / 180;
  const zc = [Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
  const up = Math.abs(zc[1]) > 0.999 ? [-Math.sin(yr), 0, -Math.cos(yr)] : [0, 1, 0];
  const xc = norm(cross(up, zc)), yc = cross(zc, xc);
  const dist = v.perspective ? radius / Math.sin(((v.fov / 2) * Math.PI) / 180) : 0;
  const cam = [center[0] + zc[0] * dist, center[1] + zc[1] * dist, center[2] + zc[2] * dist];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const out = groups.map((g) => {
    const n = g.pos.length / 3, X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), W = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = [g.pos[i * 3] - (v.perspective ? cam : center)[0], g.pos[i * 3 + 1] - (v.perspective ? cam : center)[1], g.pos[i * 3 + 2] - (v.perspective ? cam : center)[2]];
      let x = dot(q, xc), y = dot(q, yc);
      if (v.perspective) { const zd = Math.max(1e-3, -dot(q, zc)); x /= zd; y /= zd; W[i] = Z[i] = 1 / zd; } else { Z[i] = dot(q, zc); W[i] = 1; }
      X[i] = x; Y[i] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { X, Y, Z, W };
  });
  return { out, box: [minX, maxX, minY, maxY] };
}

function raster(groups, proj, k, cx, cy, S) {
  const screen = proj.map(({ X, Y, Z, W }) => {
    const n = X.length, sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) { sx[i] = S / 2 + (X[i] - cx) * k; sy[i] = S / 2 - (Y[i] - cy) * k; }
    return { sx, sy, Z, W };
  });
  return rasterCore(groups, screen, S, S);
}

/**
 * Rasterize projected groups into a W x H RGBA image. screen[gi] = {sx, sy (screen px), Z (bigger
 * = closer), W (perspective 1/depth or 1), clip? (1 = vertex behind the near plane: its triangles
 * are skipped)}. opts: bg (RGB, default the preview grey; null = transparent), light (unit vector
 * toward the light), ambient (0..1), color ([r,g,b] 0..1 light tint).
 */
export function rasterCore(groups, screen, IW, IH, opts = {}) {
  const bg = opts.bg === undefined ? BG : opts.bg;
  const L = opts.light || LIGHT, amb = opts.ambient ?? 0.45, lc = opts.color || null;
  const img = new Uint8ClampedArray(IW * IH * 4);
  if (bg) for (let i = 0; i < IW * IH; i++) img.set(bg, i * 4), (img[i * 4 + 3] = 255);
  const zbuf = new Float32Array(IW * IH).fill(-Infinity);
  let drawn = 0;
  // opaque / alpha-tested groups first, then translucent ones (opacity, glass) blended over them
  const order = groups.map((g, gi) => gi).sort((a, b) => (groups[a].tex.material?.blend ? 1 : 0) - (groups[b].tex.material?.blend ? 1 : 0));
  for (const gi of order) {
    const g = groups[gi];
    const { sx, sy, Z, W, clip } = screen[gi];
    const mat = g.tex.material, blend = !!mat?.blend, twoSided = !!mat?.double_sided, opacity = blend ? mat.opacity : 1;
    const t = g.tex, tw = t.width, th = t.height, td = t.data, te = t.emissive;
    const { idx, uv, nrm } = g, al = g.alpha; // overlay shells: per-vertex strength
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], c = idx[f + 2];
      if (clip && (clip[a] || clip[b] || clip[c])) continue;
      const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
      if (Math.abs(area) < 1e-9 || (area > 0 && !twoSided)) continue; // degenerate or back-facing
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(IW - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(IH - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      if (x0 > x1 || y0 > y1) continue;
      const wa = W[a], wb = W[b], wc = W[c];
      const ua = uv[a * 2] * wa, va = uv[a * 2 + 1] * wa, ub = uv[b * 2] * wb, vb = uv[b * 2 + 1] * wb, uc = uv[c * 2] * wc, vc = uv[c * 2 + 1] * wc;
      // Gouraud: Lambert per vertex (flat faces have equal normals, so they stay flat)
      const sh = (i) => amb + (1 - amb) * Math.max(0, nrm[i * 3] * L[0] + nrm[i * 3 + 1] * L[1] + nrm[i * 3 + 2] * L[2]);
      const sa = sh(a), sb = sh(b), sc = sh(c);
      const inv = 1 / area;
      for (let py = y0; py <= y1; py++) {
        const qy = py + 0.5;
        for (let px = x0; px <= x1; px++) {
          const qx = px + 0.5;
          const l0 = ((sx[c] - sx[b]) * (qy - sy[b]) - (sy[c] - sy[b]) * (qx - sx[b])) * inv;
          const l1 = ((sx[a] - sx[c]) * (qy - sy[c]) - (sy[a] - sy[c]) * (qx - sx[c])) * inv;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const z = l0 * Z[a] + l1 * Z[b] + l2 * Z[c], o = py * IW + px;
          if (z <= zbuf[o]) continue;
          const iw = l0 * wa + l1 * wb + l2 * wc;
          const u = (l0 * ua + l1 * ub + l2 * uc) / iw, v = (l0 * va + l1 * vb + l2 * vc) / iw;
          let tx = Math.floor(u * tw) % tw, ty = Math.floor(v * th) % th;
          if (tx < 0) tx += tw;
          if (ty < 0) ty += th;
          const p = (ty * tw + tx) * 4;
          const k = al ? (l0 * al[a] * wa + l1 * al[b] * wb + l2 * al[c] * wc) / iw : 1;
          const shade = l0 * sa + l1 * sb + l2 * sc;
          let r = td[p] * shade, gg = td[p + 1] * shade, bb = td[p + 2] * shade;
          if (lc) { r *= lc[0]; gg *= lc[1]; bb *= lc[2]; }
          if (te && te[p + 3]) { const ea = te[p + 3] / 255; r += te[p] * ea; gg += te[p + 1] * ea; bb += te[p + 2] * ea; }
          if (blend) {
            // BLEND: alpha = texel alpha x opacity, no depth write (like glTF BLEND in engines)
            const a = (td[p + 3] / 255) * opacity;
            if (a <= 0) continue;
            const da = img[o * 4 + 3] / 255;
            if (da >= 1) { img[o * 4] = img[o * 4] * (1 - a) + r * a; img[o * 4 + 1] = img[o * 4 + 1] * (1 - a) + gg * a; img[o * 4 + 2] = img[o * 4 + 2] * (1 - a) + bb * a; }
            else {
              // over a transparent background (sprite renders): "over" compositing
              const oa = a + da * (1 - a);
              img[o * 4] = (r * a + img[o * 4] * da * (1 - a)) / oa; img[o * 4 + 1] = (gg * a + img[o * 4 + 1] * da * (1 - a)) / oa; img[o * 4 + 2] = (bb * a + img[o * 4 + 2] * da * (1 - a)) / oa;
              img[o * 4 + 3] = oa * 255;
            }
            drawn++;
            continue;
          }
          if (td[p + 3] * k < 128) continue; // alpha test (MASK 0.5; overlays x COLOR_0 alpha)
          zbuf[o] = z;
          img[o * 4] = r; img[o * 4 + 1] = gg; img[o * 4 + 2] = bb; img[o * 4 + 3] = 255;
          drawn++;
        }
      }
    }
  }
  return { width: IW, height: IH, data: img, drawn };
}

// ---------- cameras for sprite renders (art_model render / clip previews) ----------
const D2R = Math.PI / 180;
/**
 * A camera for a W x H image. spec: "fp" (eye at the model origin looking down -Z, 60° vertical
 * fov), a VIEWS name (orthographic, fitted to `fit` points; "game" = fitted perspective), or
 * {pos:[x,y,z], look:[x,y,z], fov?:60, up?} (perspective, px). zoom = screen px per model px
 * for orthographic views (default: fit). -> {project(p) -> [sx, sy, Z, W, behind], perspective, label}
 */
export function makeCamera(spec, IW, IH, fit = [], opts = {}) {
  const margin = opts.margin ?? Math.max(2, Math.round(Math.min(IW, IH) * 0.06));
  const persp = (pos, zc, fov, label) => {
    const up = Math.abs(zc[1]) > 0.999 ? [0, 0, -1] : opts.up || [0, 1, 0];
    const xc = norm(cross(up, zc)), yc = cross(zc, xc), f = IH / 2 / Math.tan((fov / 2) * D2R), near = opts.near ?? 0.5;
    return {
      perspective: true, label, pos, basis: [xc, yc, zc],
      project(p) {
        const q = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]], zd = -dot(q, zc);
        const z = Math.max(1e-3, zd);
        return [IW / 2 + (dot(q, xc) / z) * f, IH / 2 - (dot(q, yc) / z) * f, 1 / z, 1 / z, zd < near];
      },
    };
  };
  if (spec === 'fp' || spec === undefined || spec === null) return persp([0, 0, 0], [0, 0, 1], Number(opts.fov ?? 60), 'fp');
  if (typeof spec === 'object' && Array.isArray(spec.pos)) {
    const pos = spec.pos.map(Number), look = (spec.look || [0, 0, 0]).map(Number);
    const zc = norm([pos[0] - look[0], pos[1] - look[1], pos[2] - look[2]]);
    return persp(pos, zc, Number(spec.fov ?? 60), spec.label || 'camera');
  }
  const v = resolveView(spec);
  const yr = v.yaw * D2R, pr = v.pitch * D2R;
  const zc = [Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
  const up = Math.abs(zc[1]) > 0.999 ? [-Math.sin(yr), 0, -Math.cos(yr)] : [0, 1, 0];
  const xc = norm(cross(up, zc)), yc = cross(zc, xc);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of fit) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  if (min[0] === Infinity) { min.fill(-16); max.fill(16); }
  const center = min.map((x, i) => (x + max[i]) / 2);
  if (v.perspective) {
    const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const dist = radius / Math.sin((v.fov / 2) * D2R);
    return persp([center[0] + zc[0] * dist, center[1] + zc[1] * dist, center[2] + zc[2] * dist], zc, v.fov, v.label);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of fit) {
    const q = [p[0] - center[0], p[1] - center[1], p[2] - center[2]], x = dot(q, xc), y = dot(q, yc);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) { x0 = y0 = -16; x1 = y1 = 16; }
  const k = opts.zoom ? Number(opts.zoom) : Math.min((IW - 2 * margin) / Math.max(1e-6, x1 - x0), (IH - 2 * margin) / Math.max(1e-6, y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    perspective: false, label: v.label, basis: [xc, yc, zc], zoom: k,
    project(p) {
      const q = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      return [IW / 2 + (dot(q, xc) - cx) * k, IH / 2 - (dot(q, yc) - cy) * k, dot(q, zc), 1, false];
    },
  };
}

/** Render groups (px, world) through a camera from makeCamera into a W x H image (rasterCore opts). */
export function renderCamera(groups, cam, IW, IH, opts = {}) {
  const screen = groups.map((g) => {
    const n = g.pos.length / 3, sx = new Float32Array(n), sy = new Float32Array(n), Z = new Float32Array(n), W = new Float32Array(n), clip = cam.perspective ? new Uint8Array(n) : null;
    for (let i = 0; i < n; i++) {
      const r = cam.project([g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
      sx[i] = r[0]; sy[i] = r[1]; Z[i] = r[2]; W[i] = r[3];
      if (clip && r[4]) clip[i] = 1;
    }
    return { sx, sy, Z, W, clip };
  });
  return rasterCore(groups, screen, IW, IH, opts);
}

/**
 * Contact sheet of views. groups: [{tex:{width,height,data,emissive?}, pos, nrm, uv, idx}] in px.
 * -> { width, height, data, views:[{label, pixels}] }
 */
export function renderViews(groups, { views = ['game', 'front', 'side', 'top', 'iso'], size = 192, labels = true } = {}) {
  const S = Math.max(32, Math.min(1024, Math.round(size)));
  // "fp" / {pos, look, fov}: a placed camera (first-person viewmodels), not fitted to the model
  const isCam = (v) => v === 'fp' || (v && typeof v === 'object' && Array.isArray(v.pos));
  const vs = views.map((v) => (isCam(v) ? { cam: v, label: v === 'fp' ? 'fp' : v.label || 'camera', perspective: true } : resolveView(v)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], g.pos[i + k]); max[k] = Math.max(max[k], g.pos[i + k]); }
  if (min[0] === Infinity) throw new Error('model has no triangles to preview');
  const center = min.map((v, i) => (v + max[i]) / 2);
  const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const margin = Math.max(4, Math.round(S * 0.06));
  const projs = vs.map((v) => (v.cam ? null : project(groups, v, center, radius)));
  const fit = (box) => (S - 2 * margin) / Math.max(1e-6, box[1] - box[0], box[3] - box[2]);
  const orthoK = Math.min(...projs.filter((_, i) => !vs[i].perspective).map((p) => fit(p.box)), Infinity);
  const items = vs.map((v, i) => {
    if (v.cam) return { img: renderCamera(groups, makeCamera(v.cam, S, S, [], { fov: v.cam.fov }), S, S), label: v.label, sub: v.cam === 'fp' ? '60 DEG EYE' : null };
    const { out, box } = projs[i];
    const k = v.perspective || !Number.isFinite(orthoK) ? fit(box) : orthoK;
    const img = raster(groups, out, k, (box[0] + box[1]) / 2, (box[2] + box[3]) / 2, S);
    return { img, label: v.label, sub: v.perspective ? `${v.pitch} DEG PERSP` : v.label === 'iso' ? 'ORTHO 3/4' : null };
  });
  const sheet = items.length === 1 && !labels ? items[0].img : packImages(items, { labels, checker: false, columns: Math.min(items.length, 3) });
  return { width: sheet.width, height: sheet.height, data: sheet.data, views: items.map((it) => ({ view: it.label, pixels: it.img.drawn })) };
}
