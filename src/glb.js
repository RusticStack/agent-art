// glTF 2.0 binary (.glb) writer, no dependencies. Pixel-art materials: NEAREST samplers, REPEAT
// wrap, embedded PNGs, alpha MASK (cutoff 0.5) when a texture has transparency (BLEND for parts with
// opacity < 1 or glass, doubleSided for double_sided / glass), emissive and
// normal textures. glTF is Y-up, metres = units (px / scale). up:"z" adds a +90° X root rotation.
import { encodePNG } from './png.js';
import { weld, applyP } from './model3d.js';

const NEAREST = 9728, REPEAT = 10497, FLOAT = 5126, U16 = 5123, U32 = 5125, ARRAY = 34962, ELEMENTS = 34963;

const hasAlpha = (data) => { for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true; return false; };
/**
 * Does any texel the UVs actually sample have alpha < 255? Unused atlas slots (the empty 48th
 * cell of a 47-tile CTM set, padding) must not force alpha MASK on the material. Each triangle's
 * UV box (REPEAT-wrapped) is scanned; big boxes fall back to the whole texture.
 */
export function referencedAlpha(tex, prims) {
  const { width: W, height: H, data } = tex;
  if (!hasAlpha(data)) return false;
  if (W * H <= 1) return true;
  const seen = new Uint8Array(W * H);
  const eps = 1e-4;
  for (const p of prims) {
    const uv = p.uv, idx = p.idx;
    for (let t = 0; t < idx.length; t += 3) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = idx[t + k] * 2, u = uv[i] * W, v = uv[i + 1] * H;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      if (!Number.isFinite(u0 + u1 + v0 + v1)) return true;
      let x0 = Math.floor(u0 + eps), x1 = Math.ceil(u1 - eps) - 1, y0 = Math.floor(v0 + eps), y1 = Math.ceil(v1 - eps) - 1;
      if (x1 < x0) x1 = x0; if (y1 < y0) y1 = y0;
      if (x1 - x0 >= W) { x0 = 0; x1 = W - 1; }
      if (y1 - y0 >= H) { y0 = 0; y1 = H - 1; }
      for (let y = y0; y <= y1; y++) {
        const yy = ((y % H) + H) % H;
        for (let x = x0; x <= x1; x++) {
          const q = yy * W + ((x % W) + W) % W;
          if (seen[q]) continue;
          seen[q] = 1;
          if (data[q * 4 + 3] < 255) return true;
        }
      }
    }
  }
  return false;
}
const pow2 = (v) => { let p = 1; while (p < v) p *= 2; return p; };

/** Pack small image-mapped textures (UVs inside 0..1, or 1x1 colours) into one atlas. */
function buildAtlas(meshes, maxSize = 256) {
  const users = new Map();
  for (const m of meshes) for (const p of m.prims) {
    const k = p.tex.key;
    if (!users.has(k)) users.set(k, { tex: p.tex, prims: [], ok: true });
    const u = users.get(k);
    u.prims.push(p);
    if (p.overlay || p.tex.material) { u.ok = false; continue; } // decal shells keep their own texture (TEXCOORD_1); glass/opacity keep their own material
    if (p.tex.width * p.tex.height > 1) for (const v of p.uv) if (v < -1e-4 || v > 1 + 1e-4) { u.ok = false; break; }
  }
  const items = [...users.values()].filter((u) => u.ok && u.tex.width <= maxSize && u.tex.height <= maxSize);
  if (items.length < 2) return 0;
  items.sort((a, b) => b.tex.height - a.tex.height);
  const area = items.reduce((s, u) => s + (u.tex.width + 2) * (u.tex.height + 2), 0);
  const W = pow2(Math.max(Math.ceil(Math.sqrt(area)), ...items.map((u) => u.tex.width + 2)));
  let x = 0, y = 0, rowH = 0;
  for (const u of items) {
    const w = u.tex.width + 2, h = u.tex.height + 2;
    if (x + w > W) { x = 0; y += rowH; rowH = 0; }
    u.x = x; u.y = y; x += w; rowH = Math.max(rowH, h);
  }
  const H = pow2(y + rowH);
  const anyE = items.some((u) => u.tex.emissive), anyN = items.some((u) => u.tex.normal);
  const data = new Uint8ClampedArray(W * H * 4), emissive = anyE ? new Uint8ClampedArray(W * H * 4) : null, normal = anyN ? new Uint8ClampedArray(W * H * 4) : null;
  if (normal) for (let i = 0; i < normal.length; i += 4) normal.set([128, 128, 255, 255], i);
  for (const u of items) {
    const { width: tw, height: th } = u.tex;
    // 1 px border copies the edge texels so nearest sampling never bleeds a neighbour
    for (let yy = -1; yy <= th; yy++) for (let xx = -1; xx <= tw; xx++) {
      const sx = Math.max(0, Math.min(tw - 1, xx)), sy = Math.max(0, Math.min(th - 1, yy));
      const s = (sy * tw + sx) * 4, d = ((u.y + 1 + yy) * W + u.x + 1 + xx) * 4;
      data.set(u.tex.data.subarray(s, s + 4), d);
      if (emissive && u.tex.emissive) emissive.set(u.tex.emissive.subarray(s, s + 4), d);
      if (normal && u.tex.normal) normal.set(u.tex.normal.subarray(s, s + 4), d);
    }
  }
  const atlas = { key: 'atlas', name: 'atlas', width: W, height: H, data, emissive, normal };
  const moved = new Set();
  for (const u of items) for (const p of u.prims) {
    const { width: tw, height: th } = u.tex;
    for (let i = 0; i < p.uv.length; i += 2) {
      if (tw * th === 1) { p.uv[i] = (u.x + 1.5) / W; p.uv[i + 1] = (u.y + 1.5) / H; continue; }
      p.uv[i] = (u.x + 1 + p.uv[i] * tw) / W;
      p.uv[i + 1] = (u.y + 1 + p.uv[i + 1] * th) / H;
    }
    p.tex = atlas;
    moved.add(p);
  }
  // one primitive per mesh for everything now on the atlas
  for (const m of meshes) {
    const on = m.prims.filter((p) => moved.has(p));
    if (on.length < 2) continue;
    const vc = on.reduce((s, p) => s + p.pos.length / 3, 0);
    const merged = { tex: atlas, pos: new Float32Array(vc * 3), nrm: new Float32Array(vc * 3), uv: new Float32Array(vc * 2), idx: new Uint32Array(on.reduce((s, p) => s + p.idx.length, 0)) };
    let vo = 0, io = 0;
    for (const p of on) {
      merged.pos.set(p.pos, vo * 3); merged.nrm.set(p.nrm, vo * 3); merged.uv.set(p.uv, vo * 2);
      for (let i = 0; i < p.idx.length; i++) merged.idx[io + i] = p.idx[i] + vo;
      vo += p.pos.length / 3; io += p.idx.length;
    }
    m.prims = [...m.prims.filter((p) => !moved.has(p)), merged];
  }
  return items.length;
}

/** World placement of an instance node (units): offset, rotation quaternion [x,y,z,w], scale. */
function instanceExtras(M, scale, info) {
  const sx = Math.hypot(M[0], M[4], M[8]) || 1, sy = Math.hypot(M[1], M[5], M[9]) || 1, sz = Math.hypot(M[2], M[6], M[10]) || 1;
  const r = [M[0] / sx, M[1] / sy, M[2] / sz, M[4] / sx, M[5] / sy, M[6] / sz, M[8] / sx, M[9] / sy, M[10] / sz];
  const tr = r[0] + r[4] + r[8];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s, s / 4]; }
  else if (r[0] > r[4] && r[0] > r[8]) { const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = [s / 4, (r[1] + r[3]) / s, (r[2] + r[6]) / s, (r[7] - r[5]) / s]; }
  else if (r[4] > r[8]) { const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[2] - r[6]) / s]; }
  else { const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = [(r[2] + r[6]) / s, (r[5] + r[7]) / s, s / 4, (r[3] - r[1]) / s]; }
  const f = (v) => +v.toFixed(6);
  return { ...(typeof info === 'object' ? info : {}), world_offset: [M[3], M[7], M[11]].map((v) => f(v / scale)), world_rotation: q.map(f), world_scale: [sx, sy, sz].map(f), px_per_unit: scale };
}

/**
 * scene: { meshes: [{ name, groups: Iterable<group> (px) }], nodes: [{ name, mesh, matrix? (3x4, px) }] }
 * opts: { scale = 32 (px per unit), up = 'y'|'z', atlas = false, name, extras }
 * -> { glb: Buffer, stats }
 */
export function writeGLB(scene, opts = {}) {
  const scale = Number(opts.scale ?? 32);
  if (!(scale > 0)) throw new Error('scale (px per unit) must be > 0');
  const meshes = scene.meshes.map((m) => ({ name: m.name, prims: [...m.groups].filter((g) => g.idx.length).map(weld) }));
  const atlased = opts.atlas ? buildAtlas(meshes) : 0;

  const bin = [];
  let binLen = 0;
  const view = (buf, target) => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const v = { buffer: 0, byteOffset: binLen, byteLength: b.length };
    if (target) v.target = target;
    bin.push(b); binLen += b.length;
    json.bufferViews.push(v);
    return json.bufferViews.length - 1;
  };
  const json = {
    asset: { version: '2.0', generator: 'agent-art', extras: { px_per_unit: scale, up: opts.up === 'z' ? 'z (root node rotated +90deg about X)' : 'y', ...(opts.extras || {}) } },
    scene: 0, scenes: [{ name: opts.name || 'scene', nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [{ magFilter: NEAREST, minFilter: NEAREST, wrapS: REPEAT, wrapT: REPEAT }],
    accessors: [], bufferViews: [], buffers: [],
  };
  const imageOf = new Map();
  const texture = (key, w, h, data, name) => {
    if (!imageOf.has(key)) {
      json.images.push({ name, mimeType: 'image/png', bufferView: view(encodePNG(w, h, data)) });
      json.textures.push({ sampler: 0, source: json.images.length - 1 });
      imageOf.set(key, json.textures.length - 1);
    }
    return { index: imageOf.get(key) };
  };
  // alpha MASK only when a texel the UVs reference is transparent
  const usersOf = new Map();
  for (const m of meshes) for (const p of m.prims) if (!p.overlay) { if (!usersOf.has(p.tex.key)) usersOf.set(p.tex.key, []); usersOf.get(p.tex.key).push(p); }
  const alphaOf = new Map();
  const needsAlpha = (t) => { if (!alphaOf.has(t.key)) alphaOf.set(t.key, usersOf.has(t.key) ? referencedAlpha(t, usersOf.get(t.key)) : hasAlpha(t.data)); return alphaOf.get(t.key); };
  const matOf = new Map();
  const material = (t, overlay = false) => {
    const mk = overlay ? `ov:${t.key}` : t.key;
    if (matOf.has(mk)) return matOf.get(mk);
    const name = (overlay ? 'overlay_' : '') + (t.name || t.key);
    const ik = t.imageKey ?? t.key; // material variants (glass, opacity) share the image
    const m = { name, pbrMetallicRoughness: { baseColorTexture: texture(ik, t.width, t.height, t.data, t.name || t.key), metallicFactor: 0, roughnessFactor: 1 } };
    const spec = !overlay && t.material;
    // overlay (grime/moss/...): own UV set TEXCOORD_1, strength in COLOR_0 alpha, cut out by MASK
    if (overlay) m.pbrMetallicRoughness.baseColorTexture.texCoord = 1;
    if (spec && spec.blend) {
      // translucent (opacity / glass): BLEND, alpha = texture alpha x opacity. Engines draw BLEND after
      // opaque geometry without depth writes (three.js GLTFLoader: transparent, depthWrite false).
      m.alphaMode = 'BLEND';
      m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, spec.opacity];
      if (spec.glass) { m.pbrMetallicRoughness.roughnessFactor = 0.1; }
      m.extras = { transparent: true, depthWrite: false, opacity: spec.opacity, ...(spec.glass ? { glass: true } : {}) };
    } else if (overlay || needsAlpha(t)) { m.alphaMode = 'MASK'; m.alphaCutoff = 0.5; }
    if (overlay) m.extras = { overlay: true };
    if (spec && spec.double_sided) m.doubleSided = true;
    if (t.emissive) { m.emissiveTexture = texture(ik + '#e', t.width, t.height, t.emissive, name + '_emissive'); m.emissiveFactor = [1, 1, 1]; }
    if (t.normal) m.normalTexture = texture(ik + '#n', t.width, t.height, t.normal, name + '_normal');
    json.materials.push(m);
    matOf.set(mk, json.materials.length - 1);
    return json.materials.length - 1;
  };

  let triangles = 0, vertices = 0;
  const meshTris = [];
  for (const m of meshes) {
    const prims = [];
    let mt = 0;
    for (const p of m.prims) {
      const vc = p.pos.length / 3;
      const P = new Float32Array(p.pos.length);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.pos.length; i++) {
        const v = Math.fround(p.pos[i] / scale);
        P[i] = v;
        if (v < min[i % 3]) min[i % 3] = v;
        if (v > max[i % 3]) max[i % 3] = v;
      }
      const big = vc > 65535;
      const I = big ? Uint32Array.from(p.idx) : Uint16Array.from(p.idx);
      const acc = (bv, componentType, count, type, extra = {}) => { json.accessors.push({ bufferView: bv, componentType, count, type, ...extra }); return json.accessors.length - 1; };
      const attributes = {
        POSITION: acc(view(P, ARRAY), FLOAT, vc, 'VEC3', { min, max }),
        NORMAL: acc(view(p.nrm, ARRAY), FLOAT, vc, 'VEC3'),
        TEXCOORD_0: acc(view(p.overlay ? p.uv0 : p.uv, ARRAY), FLOAT, vc, 'VEC2'),
      };
      if (p.overlay) {
        attributes.TEXCOORD_1 = acc(view(p.uv, ARRAY), FLOAT, vc, 'VEC2');
        const col = new Float32Array(vc * 4);
        for (let i = 0; i < vc; i++) col.set([1, 1, 1, p.alpha[i]], i * 4);
        attributes.COLOR_0 = acc(view(col, ARRAY), FLOAT, vc, 'VEC4');
      }
      prims.push({ attributes, indices: acc(view(I, ELEMENTS), big ? U32 : U16, I.length, 'SCALAR'), material: material(p.tex, !!p.overlay), mode: 4 });
      mt += p.idx.length / 3;
      vertices += vc;
    }
    json.meshes.push({ name: m.name, primitives: prims });
    meshTris.push(mt);
  }
  // nodes (instances share meshes)
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  const top = [];
  for (const n of scene.nodes) {
    const node = { name: n.name, mesh: n.mesh };
    const M = n.matrix;
    if (M && M.some((v, i) => v !== [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0][i])) {
      node.matrix = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, M[3] / scale, M[7] / scale, M[11] / scale, 1];
    }
    if (n.instance) node.extras = instanceExtras(M || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], scale, n.instance);
    triangles += meshTris[n.mesh];
    for (const p of meshes[n.mesh].prims) for (let i = 0; i < p.pos.length; i += 3) {
      const q = M ? applyP(M, [p.pos[i], p.pos[i + 1], p.pos[i + 2]]) : [p.pos[i], p.pos[i + 1], p.pos[i + 2]];
      for (let k = 0; k < 3; k++) { const v = q[k] / scale; if (v < bmin[k]) bmin[k] = v; if (v > bmax[k]) bmax[k] = v; }
    }
    json.nodes.push(node);
    top.push(json.nodes.length - 1);
  }
  if (opts.up === 'z') {
    json.nodes.push({ name: 'z_up', rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: top });
    json.scenes[0].nodes = [json.nodes.length - 1];
  } else json.scenes[0].nodes = top;

  const binBuf = Buffer.concat([...bin, Buffer.alloc((4 - (binLen % 4)) % 4)]);
  json.buffers.push({ byteLength: binBuf.length });
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + js.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const glb = Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(binBuf.length, 0x004e4942), binBuf]);
  const fin = (v) => (Number.isFinite(v) ? +v.toFixed(4) : 0);
  return {
    glb,
    stats: {
      bytes: glb.length, triangles, vertices, meshes: json.meshes.length, nodes: scene.nodes.length, materials: json.materials.length, textures: json.textures.length,
      atlased: atlased || undefined, bounds: { min: bmin.map(fin), max: bmax.map(fin), size: bmax.map((v, i) => fin(v - bmin[i])) },
    },
  };
}
