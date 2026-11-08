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
    if (p.overlay || p.tex.material || p.morphs || p.skin) { u.ok = false; continue; } // decal shells keep their own texture (TEXCOORD_1); glass/opacity keep their own material; morph targets / skin weights keep their own primitive
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
  const anyE = items.some((u) => u.tex.emissive), anyN = items.some((u) => u.tex.normal), anyMR = items.some((u) => u.tex.mr || u.tex.pbr);
  const data = new Uint8ClampedArray(W * H * 4), emissive = anyE ? new Uint8ClampedArray(W * H * 4) : null, normal = anyN ? new Uint8ClampedArray(W * H * 4) : null;
  if (normal) for (let i = 0; i < normal.length; i += 4) normal.set([128, 128, 255, 255], i);
  // PBR on the atlas: per-item factors / maps become one metallicRoughness atlas (factors 1)
  const mr = anyMR ? new Uint8ClampedArray(W * H * 4) : null;
  if (mr) for (let i = 0; i < mr.length; i += 4) mr.set([255, 255, 0, 255], i);
  for (const u of items) {
    const { width: tw, height: th } = u.tex;
    // 1 px border copies the edge texels so nearest sampling never bleeds a neighbour
    for (let yy = -1; yy <= th; yy++) for (let xx = -1; xx <= tw; xx++) {
      const sx = Math.max(0, Math.min(tw - 1, xx)), sy = Math.max(0, Math.min(th - 1, yy));
      const s = (sy * tw + sx) * 4, d = ((u.y + 1 + yy) * W + u.x + 1 + xx) * 4;
      data.set(u.tex.data.subarray(s, s + 4), d);
      if (emissive && u.tex.emissive) emissive.set(u.tex.emissive.subarray(s, s + 4), d);
      if (normal && u.tex.normal) normal.set(u.tex.normal.subarray(s, s + 4), d);
      if (mr) {
        if (u.tex.mr) mr.set(u.tex.mr.subarray(s, s + 4), d);
        else { const f = u.tex.pbr || { metal: 0, rough: 1 }; mr.set([255, Math.round(f.rough * 255), Math.round(f.metal * 255), 255], d); }
      }
    }
  }
  const atlas = { key: 'atlas', name: 'atlas', width: W, height: H, data, emissive, normal, ...(mr ? { mr } : {}) };
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
    // baked AO rides along (every primitive of a mesh shares the AO lightmap / has vertex AO)
    if (on.every((p) => p.uv1)) merged.uv1 = new Float32Array(vc * 2);
    if (on.every((p) => p.ao)) merged.ao = new Float32Array(vc);
    const vkeys = on[0].vattr ? Object.keys(on[0].vattr).join() : '';
    if (vkeys && on.every((p) => p.vattr && Object.keys(p.vattr).join() === vkeys)) merged.vattr = Object.fromEntries(Object.entries(on[0].vattr).map(([k, a]) => [k, { size: a.size, data: new Float32Array(vc * a.size) }]));
    let vo = 0, io = 0;
    for (const p of on) {
      merged.pos.set(p.pos, vo * 3); merged.nrm.set(p.nrm, vo * 3); merged.uv.set(p.uv, vo * 2);
      if (merged.uv1) merged.uv1.set(p.uv1, vo * 2);
      if (merged.ao) merged.ao.set(p.ao, vo);
      if (merged.vattr) for (const [k, a] of Object.entries(merged.vattr)) a.data.set(p.vattr[k].data, vo * a.size);
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

/** 3x4 (px) local matrix of a TRS node: translation px, rotation quaternion [x,y,z,w], scale. */
export function trsMatrix(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  return [r[0] * s[0], r[1] * s[1], r[2] * s[2], t[0], r[3] * s[0], r[4] * s[1], r[5] * s[2], t[1], r[6] * s[0], r[7] * s[1], r[8] * s[2], t[2]];
}
const mul34 = (A, B) => {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
    r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
  }
  return r;
};

/**
 * scene: { meshes: [{ name, groups: Iterable<group> (px) }], nodes: [{ name, mesh?, matrix? (3x4,
 * px) | translation? (px) + rotation? [x,y,z,w] + scale?, children?: [node indices], extras? }],
 * animations?: [{ name, channels: [{ node, path: translation|rotation|scale, interpolation:
 * LINEAR|STEP, times: seconds, values: flat (translation px) }], extras? }] }. Nodes that are no
 * one's child are scene roots. opts: { scale = 32 (px per unit), up = 'y'|'z', atlas = false, name, extras,
 * v2? (materials v2 hooks from materials.js makeV2: extensions, ORM packing, texture dedupe,
 * TANGENT, vertex data) } -> { glb: Buffer, stats }
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
  const v2 = opts.v2 || null, byHash = v2 ? new Map() : null;
  const texture = (key, w, h, data, name) => {
    if (!imageOf.has(key) && v2) {
      // v2: identical images are written once (shared across materials)
      const hk = v2.hash(w, h, data);
      if (byHash.has(hk)) { imageOf.set(key, byHash.get(hk)); v2.deduped(); }
      else byHash.set(hk, json.textures.length);
    }
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
  const material = (t, overlay = false, noAO = false) => {
    // noAO: a primitive without the lightmap UVs (TEXCOORD_1) gets a variant without occlusionTexture
    const mk = overlay ? `ov:${t.key}` : noAO ? `noao:${t.key}` : t.key;
    if (matOf.has(mk)) return matOf.get(mk);
    const name = (overlay ? 'overlay_' : '') + (t.name || t.key);
    const ik = t.imageKey ?? t.key; // material variants (glass, opacity) share the image
    const pbr = !overlay && t.pbr, mrMap = !overlay && t.mr;
    // metallicRoughness: maps carry the factors baked in (factors 1); plain PBR = factors; default dielectric rough
    const m = { name, pbrMetallicRoughness: { baseColorTexture: texture(ik, t.width, t.height, t.data, t.name || t.key), metallicFactor: mrMap ? 1 : pbr ? pbr.metal : 0, roughnessFactor: mrMap ? 1 : pbr ? pbr.rough : 1 } };
    if (mrMap) m.pbrMetallicRoughness.metallicRoughnessTexture = v2 ? v2.mr(t, texture, name, ik, m) : texture(t.mrKey ?? ik + '#mr', t.width, t.height, t.mr, name + '_mr');
    const spec = !overlay && t.material;
    // overlay (grime/moss/...): own UV set TEXCOORD_1, strength in COLOR_0 alpha, cut out by MASK
    if (overlay) m.pbrMetallicRoughness.baseColorTexture.texCoord = 1;
    if (spec && spec.blend) {
      // translucent (opacity / glass): BLEND, alpha = texture alpha x opacity. Engines draw BLEND after
      // opaque geometry without depth writes (three.js GLTFLoader: transparent, depthWrite false).
      m.alphaMode = 'BLEND';
      m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, spec.opacity];
      if (spec.glass && !pbr && !mrMap) { m.pbrMetallicRoughness.roughnessFactor = 0.1; }
      m.extras = { transparent: true, depthWrite: false, opacity: spec.opacity, ...(spec.glass ? { glass: true } : {}) };
    } else if (overlay || needsAlpha(t)) { m.alphaMode = 'MASK'; m.alphaCutoff = 0.5; }
    if (overlay) m.extras = { overlay: true };
    if (spec && spec.double_sided) m.doubleSided = true;
    if (t.emissive) { m.emissiveTexture = texture(t.emissiveKey ?? ik + '#e', t.width, t.height, t.emissive, name + '_emissive'); m.emissiveFactor = [1, 1, 1]; }
    if (t.normal) m.normalTexture = texture(t.normalKey ?? ik + '#n', t.width, t.height, t.normal, name + '_normal');
    // baked AO lightmap: every opaque material samples it with TEXCOORD_1
    if (!overlay && !noAO && opts.ao && !(spec && spec.blend)) m.occlusionTexture = { ...texture('ao#map', opts.ao.width, opts.ao.height, opts.ao.data, 'ao'), texCoord: 1 };
    if (v2) v2.material(m, t, { texture, overlay, noAO, name, ik });
    json.materials.push(m);
    matOf.set(mk, json.materials.length - 1);
    return json.materials.length - 1;
  };

  let triangles = 0, vertices = 0;
  const meshTris = [];
  for (const m of meshes) {
    const prims = [];
    let mt = 0, morphNames = null;
    for (let p of m.prims) {
      if (v2) p = v2.prepare(p);
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
      if (!p.overlay && p.uv1) attributes.TEXCOORD_1 = acc(view(p.uv1, ARRAY), FLOAT, vc, 'VEC2');
      if (!p.overlay && p.ao && !(p.vattr && p.vattr.COLOR_0)) {
        const col = new Float32Array(vc * 3);
        for (let i = 0; i < vc; i++) col.fill(p.ao[i], i * 3, i * 3 + 3);
        attributes.COLOR_0 = acc(view(col, ARRAY), FLOAT, vc, 'VEC3');
      }
      if (p.overlay) {
        attributes.TEXCOORD_1 = acc(view(p.uv, ARRAY), FLOAT, vc, 'VEC2');
        const col = new Float32Array(vc * 4);
        for (let i = 0; i < vc; i++) col.set([1, 1, 1, p.alpha[i]], i * 4);
        attributes.COLOR_0 = acc(view(col, ARRAY), FLOAT, vc, 'VEC4');
      }
      if (p.skin) {
        // skinned primitive: 4 joints (UNSIGNED_SHORT, indices into skin.joints) + 4 weights (FLOAT, sum 1)
        attributes.JOINTS_0 = acc(view(p.skin.j, ARRAY), U16, vc, 'VEC4');
        attributes.WEIGHTS_0 = acc(view(p.skin.w, ARRAY), FLOAT, vc, 'VEC4');
      }
      if (v2) v2.attributes(p, attributes, (arr, type) => acc(view(arr, ARRAY), FLOAT, vc, type));
      const prim = { attributes, indices: acc(view(I, ELEMENTS), big ? U32 : U16, I.length, 'SCALAR'), material: material(p.tex, !!p.overlay, !p.overlay && (!!opts.ao || !!(v2 && v2.bakedUV)) && !p.uv1), mode: 4 };
      if (p.morphs) {
        // morph targets: POSITION / NORMAL deltas (units), names in mesh.extras.targetNames
        prim.targets = p.morphs.map((t) => {
          const dp = new Float32Array(vc * 3), dn = new Float32Array(vc * 3), mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < vc * 3; i++) {
            const v = Math.fround(t.pos[i] / scale) - P[i];
            dp[i] = v; dn[i] = t.nrm[i] - p.nrm[i];
            if (dp[i] < mn[i % 3]) mn[i % 3] = dp[i]; if (dp[i] > mx[i % 3]) mx[i % 3] = dp[i];
          }
          return { POSITION: acc(view(dp, ARRAY), FLOAT, vc, 'VEC3', { min: mn, max: mx }), NORMAL: acc(view(dn, ARRAY), FLOAT, vc, 'VEC3') };
        });
        morphNames = p.morphs.map((t) => t.name);
      }
      prims.push(prim);
      mt += p.idx.length / 3;
      vertices += vc;
    }
    const jm = { name: m.name, primitives: prims };
    if (morphNames) {
      if (prims.some((p) => !p.targets || p.targets.length !== morphNames.length)) throw new Error(`mesh ${m.name}: every primitive needs the same morph targets`);
      jm.weights = morphNames.map(() => 0);
      jm.extras = { targetNames: morphNames };
    }
    json.meshes.push(jm);
    meshTris.push(mt);
  }
  // nodes (instances share meshes; rigs nest children with TRS)
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  const isChild = new Set(), parentOf = new Map();
  for (const [i, n] of scene.nodes.entries()) for (const c of n.children || []) { isChild.add(c); parentOf.set(c, i); }
  const top = [];
  let gpuUsed = false;
  const f6 = (v) => +(+v).toFixed(6);
  const localM = (n) => (n.matrix ? n.matrix : n.translation || n.rotation || n.scale ? trsMatrix(n.translation, n.rotation, n.scale) : null);
  const worldM = new Map();
  const worldOf = (i) => {
    if (worldM.has(i)) return worldM.get(i);
    const L = localM(scene.nodes[i]), P = parentOf.has(i) ? worldOf(parentOf.get(i)) : null;
    const W = P ? (L ? mul34(P, L) : P) : L;
    worldM.set(i, W);
    return W;
  };
  for (const [ni, n] of scene.nodes.entries()) {
    const node = { name: n.name };
    if (n.mesh !== undefined && n.mesh !== null) node.mesh = n.mesh;
    if (n.skin !== undefined && n.skin !== null) node.skin = n.skin;
    const M = n.matrix;
    if (M && M.some((v, i) => v !== [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0][i])) {
      node.matrix = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, M[3] / scale, M[7] / scale, M[11] / scale, 1];
    }
    if (n.translation && n.translation.some((v) => Math.abs(v) > 1e-9)) node.translation = n.translation.map((v) => f6(v / scale));
    if (n.rotation && Math.abs(n.rotation[3]) < 1 - 1e-12) node.rotation = n.rotation.map(f6);
    if (n.scale && n.scale.some((v) => v !== 1)) node.scale = n.scale.map(f6);
    if (n.children && n.children.length) node.children = [...n.children];
    if (n.instance) node.extras = instanceExtras(M || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], scale, n.instance);
    else if (n.extras) node.extras = n.extras;
    if (n.instancing) {
      // EXT_mesh_gpu_instancing (three.js GLTFLoader -> InstancedMesh): per-instance TRS accessors
      const it = n.instancing, cnt = it.t.length / 3;
      const T = Float32Array.from(it.t, (v) => v / scale), R = Float32Array.from(it.r), S = Float32Array.from(it.s);
      const acc3 = (arr, type) => { json.accessors.push({ bufferView: view(arr), componentType: FLOAT, count: cnt, type }); return json.accessors.length - 1; };
      node.extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: acc3(T, 'VEC3'), ROTATION: acc3(R, 'VEC4'), SCALE: acc3(S, 'VEC3') } } };
      gpuUsed = true;
    }
    if (node.mesh !== undefined && !n.proxy && !n.lodHidden) {
      const W0 = worldOf(ni);
      const insts = n.instancing ? n.instancing.mats : [null];
      triangles += meshTris[n.mesh] * insts.length;
      for (const IM of insts) {
        const W = IM ? (W0 ? mul34(W0, IM) : IM) : W0;
        for (const p of meshes[n.mesh].prims) for (let i = 0; i < p.pos.length; i += 3) {
          const q = W ? applyP(W, [p.pos[i], p.pos[i + 1], p.pos[i + 2]]) : [p.pos[i], p.pos[i + 1], p.pos[i + 2]];
          for (let k = 0; k < 3; k++) { const v = q[k] / scale; if (v < bmin[k]) bmin[k] = v; if (v > bmax[k]) bmax[k] = v; }
        }
      }
    }
    json.nodes.push(node);
    if (!isChild.has(ni)) top.push(json.nodes.length - 1);
  }
  // animations: one sampler per channel; inputs = seconds (min/max), outputs = translation (units) / rotation / scale
  if (scene.animations && scene.animations.length) {
    json.animations = [];
    const accF = (arr, type, extra = {}) => {
      const F = Float32Array.from(arr);
      json.accessors.push({ bufferView: view(F), componentType: FLOAT, count: F.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4 })[type], type, ...extra });
      return json.accessors.length - 1;
    };
    for (const an of scene.animations) {
      const samplers = [], channels = [];
      for (const ch of an.channels) {
        const times = Array.from(ch.times, (t) => Math.fround(t));
        const vals = ch.path === 'translation' ? Array.from(ch.values, (v) => v / scale) : Array.from(ch.values);
        const input = accF(times, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] });
        const output = accF(vals, ch.path === 'rotation' ? 'VEC4' : ch.path === 'weights' ? 'SCALAR' : 'VEC3');
        samplers.push({ input, output, interpolation: ch.interpolation || 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } });
      }
      const a = { name: an.name, channels, samplers };
      if (an.extras) a.extras = an.extras;
      json.animations.push(a);
    }
  }
  // skins: joints = node indices, inverseBindMatrices from 3x4 px matrices (column-major MAT4, units)
  if (scene.skins && scene.skins.length) {
    json.skins = scene.skins.map((sk) => {
      const ibm = new Float32Array(sk.ibm.length * 16);
      sk.ibm.forEach((M, i) => ibm.set([M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, M[3] / scale, M[7] / scale, M[11] / scale, 1], i * 16));
      json.accessors.push({ bufferView: view(ibm), componentType: FLOAT, count: sk.ibm.length, type: 'MAT4' });
      return { name: sk.name, joints: sk.joints.slice(), ...(sk.skeleton !== undefined ? { skeleton: sk.skeleton } : {}), inverseBindMatrices: json.accessors.length - 1 };
    });
  }
  if (opts.up === 'z') {
    json.nodes.push({ name: 'z_up', rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: top });
    json.scenes[0].nodes = [json.nodes.length - 1];
  } else json.scenes[0].nodes = top;

  if (gpuUsed) json.extensionsUsed = [...(json.extensionsUsed || []), 'EXT_mesh_gpu_instancing'];
  if (v2) v2.finish(json);
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
      animations: json.animations ? json.animations.length : undefined,
      atlased: atlased || undefined, ...(v2 ? { v2: v2.report } : {}), bounds: { min: bmin.map(fin), max: bmax.map(fin), size: bmax.map((v, i) => fin(v - bmin[i])) },
    },
  };
}
