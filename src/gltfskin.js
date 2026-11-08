// glTF skin export of a 2D rig (cutout animation for 3D engines): one joint per part, one textured
// quad per part (its base-view cell from the parts canvas, weighted 100% to its joint), the rest
// pose as the bind pose, and each clip as an animation (translation / rotation about Z per joint,
// scale 0 while a part is hidden). Units: `scale` px per unit, Y up, the rig root at the origin,
// draw order as a small z offset per part.
import { solvePose, partIn, poseOf, cellOf } from './rig.js';
import { encodePNG } from './png.js';

const D2R = Math.PI / 180;

/** 2D rigid transform (y up) -> column-major 4x4. */
function mat(tx, ty, tz, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}
function invRigid(m) {
  // rotation about Z + translation
  const c = m[0], s = m[1], tx = m[12], ty = m[13], tz = m[14];
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, -(c * tx + s * ty), -(-s * tx + c * ty), -tz, 1];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return o;
}
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

/**
 * rig, partsDoc, clips: [{name, poses, fps, loop, events}] -> {glb: Buffer, joints}
 * opts: {view (base view), scale (px per unit), name}
 */
export function writeSkinGLB(rig, d, clips, { view, scale = 32, name = 'rig' } = {}) {
  const base = view || rig.views[0];
  const parts = rig.order;
  const zOf = (n) => partIn(rig, n, base).z;
  const zs = [...new Set(parts.map(zOf))].sort((a, b) => a - b);
  const zIdx = (n) => zs.indexOf(zOf(n)) * 0.002;
  const [rx, ry] = rig.root;
  const toM = (T, n) => mat((T.x - rx) / scale, -(T.y - ry) / scale, zIdx(n), -T.rot * D2R);
  const rest = solvePose(rig, {}, base).world;
  const bind = Object.fromEntries(parts.map((n) => [n, toM(rest[n], n)]));
  const parentOf = (n) => rig.parts[n].parent;
  const local = (M, n) => { const p = parentOf(n); return p ? mul(invRigid(M[p]), M[n]) : M[n]; };

  // texture: the parts canvas art (without the cell guides)
  const saved = d.layers;
  d.layers = saved.filter((l) => l.name !== 'cells');
  let comp;
  try { comp = d.composite(); } finally { d.layers = saved; }
  const TW = d.width, TH = d.height;
  const png = encodePNG(TW, TH, comp);

  // mesh: a quad per part, in bind (model) space
  const pos = [], uv = [], joints = [], weights = [], idx = [];
  parts.forEach((n, j) => {
    const p = partIn(rig, n, base);
    if (p.hidden) return;
    const link = p.link && rig.views.includes(p.link.view) ? p.link.view : base;
    const c = cellOf(rig, n, link);
    const v0 = pos.length / 3;
    for (const [u, v] of [[0, 0], [p.w, 0], [p.w, p.h], [0, p.h]]) {
      const q = apply(bind[n], (u - p.pivot[0]) / scale, -(v - p.pivot[1]) / scale, 0);
      pos.push(...q);
      uv.push((c.x + u) / TW, (c.y + v) / TH);
      joints.push(j, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
  });

  // binary buffer
  const chunks = [];
  let len = 0;
  const json = {
    asset: { version: '2.0', generator: 'agent-art (2D rig skin)', extras: { px_per_unit: scale, view: base, note: 'cutout skin: one quad per part, joints = rig parts, clips = animations (events in extras)' } },
    scene: 0, scenes: [{ name, nodes: [] }], nodes: [], meshes: [], skins: [], accessors: [], bufferViews: [], buffers: [], animations: [],
    materials: [{ name: `${name}_parts`, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }],
    textures: [{ sampler: 0, source: 0 }], images: [], samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
  };
  const bview = (buf, target) => {
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; }
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length, ...(target ? { target } : {}) });
    chunks.push(b); len += b.length;
    return json.bufferViews.length - 1;
  };
  const acc = (arr, type, comp, count, extra = {}, target) => { json.accessors.push({ bufferView: bview(arr, target), componentType: comp, count, type, ...extra }); return json.accessors.length - 1; };
  const FLOAT = 5126;
  json.images.push({ name: `${name}_parts`, mimeType: 'image/png', bufferView: bview(new Uint8Array(png)) });
  const P = new Float32Array(pos);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
  const aPos = acc(P, 'VEC3', FLOAT, P.length / 3, { min: mn, max: mx }, 34962);
  const aUV = acc(new Float32Array(uv), 'VEC2', FLOAT, uv.length / 2, {}, 34962);
  const aJ = acc(new Uint16Array(joints), 'VEC4', 5123, joints.length / 4, {}, 34962);
  const aW = acc(new Float32Array(weights), 'VEC4', FLOAT, weights.length / 4, {}, 34962);
  const big = P.length / 3 > 65535;
  const aI = acc(big ? new Uint32Array(idx) : new Uint16Array(idx), 'SCALAR', big ? 5125 : 5123, idx.length, {}, 34963);
  json.meshes.push({ name, primitives: [{ attributes: { POSITION: aPos, TEXCOORD_0: aUV, JOINTS_0: aJ, WEIGHTS_0: aW }, indices: aI, material: 0 }] });

  // joint nodes (rig hierarchy, bind pose as rest TRS)
  const nodeOf = {};
  const quat = (m) => { const a = Math.atan2(m[1], m[0]); return [0, 0, Math.sin(a / 2), Math.cos(a / 2)]; };
  const rootNode = 0;
  json.nodes.push({ name: `${name}_root`, children: [] });
  parts.forEach((n) => { nodeOf[n] = json.nodes.length; const L = local(bind, n); json.nodes.push({ name: n, translation: [L[12], L[13], L[14]], rotation: quat(L), children: [] }); });
  parts.forEach((n) => { const p = parentOf(n); (p ? json.nodes[nodeOf[p]] : json.nodes[rootNode]).children.push(nodeOf[n]); });
  for (const nd of json.nodes) if (!nd.children.length) delete nd.children;
  const ibm = new Float32Array(parts.length * 16);
  parts.forEach((n, j) => ibm.set(invRigid(bind[n]), j * 16));
  json.skins.push({ name, joints: parts.map((n) => nodeOf[n]), skeleton: rootNode, inverseBindMatrices: acc(ibm, 'MAT4', FLOAT, parts.length) });
  json.nodes.push({ name: `${name}_mesh`, mesh: 0, skin: 0 });
  json.scenes[0].nodes.push(rootNode, json.nodes.length - 1);

  // animations: per frame world -> local TRS per joint
  for (const c of clips) {
    const n = c.poses.length, fps = c.fps || 10;
    const times = new Float32Array(n).map((_, f) => f / fps);
    const aT = acc(times, 'SCALAR', FLOAT, n, { min: [0], max: [times[n - 1] || 0] });
    const T = parts.map(() => new Float32Array(n * 3)), R = parts.map(() => new Float32Array(n * 4)), S = parts.map(() => new Float32Array(n * 3));
    c.poses.forEach((Pz, f) => {
      const sv = solvePose(rig, Pz, base);
      const M = Object.fromEntries(parts.map((p) => [p, toM(sv.world[p], p)]));
      parts.forEach((p, j) => {
        const L = local(M, p), q = quat(L);
        T[j].set([L[12], L[13], L[14]], f * 3);
        R[j].set(q, f * 4);
        const hidden = partIn(rig, p, base).hidden || poseOf(rig, sv.VP, p).hide;
        S[j].set(hidden ? [0, 0, 0] : [1, 1, 1], f * 3);
      });
    });
    const samplers = [], channels = [];
    parts.forEach((p, j) => {
      for (const [path, data, type, interp] of [['translation', T[j], 'VEC3', 'LINEAR'], ['rotation', R[j], 'VEC4', 'LINEAR'], ['scale', S[j], 'VEC3', 'STEP']]) {
        samplers.push({ input: aT, output: acc(data, type, FLOAT, n), interpolation: interp });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[p], path } });
      }
    });
    json.animations.push({ name: c.name, samplers, channels, extras: { fps, loop: c.loop !== false, frames: n, ...(c.events?.length ? { events: c.events.map((e) => ({ time: e.frame / fps, frame: e.frame, name: e.name })) } : {}) } });
  }
  const bin = Buffer.concat([...chunks, Buffer.alloc((4 - (len % 4)) % 4)]);
  json.buffers.push({ byteLength: bin.length });
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (b, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, b]); };
  return { glb: Buffer.concat([head, ch(js, 0x4e4f534a), ch(bin, 0x004e4942)]), joints: parts.length };
}
