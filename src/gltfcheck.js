// Structural glTF 2.0 / .glb validator (no dependencies): container, buffers, accessors (ranges,
// alignment, min/max, finite values), attribute semantics (types, unit normals / tangents with
// w = +-1, consecutive TEXCOORD_n / COLOR_n), indices, materials (factor ranges, texCoord sets that
// exist on every primitive using them), the KHR material extensions agent-art writes (schema of
// each, unknown keys rejected), extensionsUsed / extensionsRequired bookkeeping, textures / images
// (PNG signature), node graph (no cycles, matrix xor TRS), animations, and texture indices inside
// agent-art extras (lightMap, heightTexture, bentNormalTexture, thicknessTexture, detail, masks).
// It is not the Khronos validator, but it fails on the mistakes that make engines reject a file.

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const CSIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const in01 = (v) => isNum(v) && v >= 0 && v <= 1;
const vecIn01 = (v, n) => Array.isArray(v) && v.length === n && v.every(in01);

/** Material extension schemas: field -> check(value, ctx) returning an error string or null. */
const tex = (v, c) => c.textureInfo(v);
const EXT = {
  KHR_materials_emissive_strength: { emissiveStrength: (v) => (isNum(v) && v >= 0 ? null : 'emissiveStrength must be >= 0') },
  KHR_materials_clearcoat: {
    clearcoatFactor: (v) => (in01(v) ? null : 'clearcoatFactor 0..1'), clearcoatRoughnessFactor: (v) => (in01(v) ? null : 'clearcoatRoughnessFactor 0..1'),
    clearcoatTexture: tex, clearcoatRoughnessTexture: tex, clearcoatNormalTexture: tex,
  },
  KHR_materials_anisotropy: { anisotropyStrength: (v) => (in01(v) ? null : 'anisotropyStrength 0..1'), anisotropyRotation: (v) => (isNum(v) ? null : 'anisotropyRotation must be a number (radians)'), anisotropyTexture: tex },
  KHR_materials_transmission: { transmissionFactor: (v) => (in01(v) ? null : 'transmissionFactor 0..1'), transmissionTexture: tex },
  KHR_materials_volume: {
    thicknessFactor: (v) => (isNum(v) && v >= 0 ? null : 'thicknessFactor >= 0'), thicknessTexture: tex,
    attenuationDistance: (v) => (isNum(v) && v > 0 ? null : 'attenuationDistance > 0'), attenuationColor: (v) => (vecIn01(v, 3) ? null : 'attenuationColor [r,g,b] 0..1'),
  },
  KHR_materials_ior: { ior: (v) => (isNum(v) && (v === 0 || v >= 1) ? null : 'ior must be 0 or >= 1') },
  KHR_materials_sheen: { sheenColorFactor: (v) => (vecIn01(v, 3) ? null : 'sheenColorFactor [r,g,b] 0..1'), sheenRoughnessFactor: (v) => (in01(v) ? null : 'sheenRoughnessFactor 0..1'), sheenColorTexture: tex, sheenRoughnessTexture: tex },
  KHR_materials_diffuse_transmission: {
    diffuseTransmissionFactor: (v) => (in01(v) ? null : 'diffuseTransmissionFactor 0..1'), diffuseTransmissionTexture: tex,
    diffuseTransmissionColorFactor: (v) => (vecIn01(v, 3) ? null : 'diffuseTransmissionColorFactor [r,g,b] 0..1'), diffuseTransmissionColorTexture: tex,
  },
  KHR_materials_specular: { specularFactor: (v) => (in01(v) ? null : 'specularFactor 0..1'), specularColorFactor: (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && x >= 0) ? null : 'specularColorFactor [r,g,b] >= 0'), specularTexture: tex, specularColorTexture: tex },
};
/** Extensions on other objects that the checker understands (not validated field by field). */
const KNOWN_OTHER = new Set(['EXT_mesh_gpu_instancing', 'KHR_lights_punctual', 'KHR_texture_transform', 'KHR_mesh_quantization']);

/** Texture indices inside agent-art extras: path in material.extras -> textureInfo-like {index, texCoord?}. */
const EXTRA_TEXTURES = ['lightMap', 'heightTexture', 'bentNormalTexture', 'thicknessTexture', 'unityMaskTexture', 'emissiveMaskTexture'];

/**
 * Validate a .glb buffer (or {json, bin}). -> {ok, errors: [string], warnings: [string], stats}.
 */
export function validateGLB(input) {
  const errors = [], warnings = [];
  const err = (m) => { errors.push(m); };
  let json, bin;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return { ok: false, errors: ['not a .glb (magic)'], warnings };
    if (buf.readUInt32LE(4) !== 2) err('glb version must be 2');
    if (buf.readUInt32LE(8) !== buf.length) err(`glb length ${buf.readUInt32LE(8)} != file ${buf.length}`);
    const jlen = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) err('first chunk must be JSON');
    if (jlen % 4) err('JSON chunk length must be 4-byte aligned');
    try { json = JSON.parse(buf.toString('utf8', 20, 20 + jlen)); } catch (e) { return { ok: false, errors: [`JSON chunk: ${e.message}`], warnings }; }
    const bo = 20 + jlen;
    if (bo < buf.length) {
      const blen = buf.readUInt32LE(bo);
      if (buf.readUInt32LE(bo + 4) !== 0x004e4942) err('second chunk must be BIN');
      if (blen % 4) err('BIN chunk length must be 4-byte aligned');
      bin = buf.subarray(bo + 8, bo + 8 + blen);
    } else bin = Buffer.alloc(0);
  } else ({ json, bin } = input);

  const A = (k) => (Array.isArray(json[k]) ? json[k] : []);
  if (json.asset?.version !== '2.0') err('asset.version must be "2.0"');
  const used = { accessors: new Set(), bufferViews: new Set(), textures: new Set(), materials: new Set(), meshes: new Set(), samplers: new Set(), images: new Set() };
  const extUsed = new Set();
  const noteExt = (obj, where) => { if (obj && obj.extensions) for (const k of Object.keys(obj.extensions)) { extUsed.add(k); if (!EXT[k] && !KNOWN_OTHER.has(k)) warnings.push(`${where}: extension ${k} not checked`); } };

  // ---- buffers / views
  A('buffers').forEach((b, i) => {
    if (!(b.byteLength >= 1)) err(`buffers[${i}].byteLength must be >= 1`);
    if (b.uri === undefined && i !== 0) err(`buffers[${i}] without uri must be the GLB buffer 0`);
    if (b.uri === undefined && b.byteLength > bin.length) err(`buffers[${i}].byteLength ${b.byteLength} > BIN ${bin.length}`);
  });
  A('bufferViews').forEach((v, i) => {
    const b = A('buffers')[v.buffer];
    if (!b) { err(`bufferViews[${i}].buffer invalid`); return; }
    if (!((v.byteOffset ?? 0) >= 0) || !(v.byteLength >= 1) || (v.byteOffset ?? 0) + v.byteLength > b.byteLength) err(`bufferViews[${i}] outside its buffer`);
    if (v.byteStride !== undefined && !(v.byteStride >= 4 && v.byteStride <= 252 && v.byteStride % 4 === 0)) err(`bufferViews[${i}].byteStride must be 4..252, multiple of 4`);
    if (v.target !== undefined && ![34962, 34963].includes(v.target)) err(`bufferViews[${i}].target invalid`);
  });
  // ---- accessors
  const accData = new Map();
  const readAcc = (ai) => {
    if (accData.has(ai)) return accData.get(ai);
    const a = A('accessors')[ai];
    let out = null;
    if (a && a.bufferView !== undefined) {
      const v = A('bufferViews')[a.bufferView], T = ARRAYS[a.componentType], n = COMP[a.type];
      if (v && T && n) {
        const stride = v.byteStride || n * CSIZE[a.componentType], off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
        if (off + stride * (a.count - 1) + n * CSIZE[a.componentType] <= bin.length) {
          out = new Float64Array(a.count * n);
          const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
          const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
          for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[get](off + i * stride + k * CSIZE[a.componentType], true);
        }
      }
    }
    accData.set(ai, out);
    return out;
  };
  A('accessors').forEach((a, i) => {
    const where = `accessors[${i}]`;
    if (!CSIZE[a.componentType]) { err(`${where}.componentType invalid`); return; }
    if (!COMP[a.type]) { err(`${where}.type invalid`); return; }
    if (!(a.count >= 1)) err(`${where}.count must be >= 1`);
    if (a.bufferView === undefined) return;
    used.bufferViews.add(a.bufferView);
    const v = A('bufferViews')[a.bufferView];
    if (!v) { err(`${where}.bufferView invalid`); return; }
    const cs = CSIZE[a.componentType], n = COMP[a.type], stride = v.byteStride || n * cs;
    if (((v.byteOffset ?? 0) + (a.byteOffset ?? 0)) % cs) err(`${where} not aligned to its component size`);
    if ((a.byteOffset ?? 0) + stride * (a.count - 1) + n * cs > v.byteLength) err(`${where} does not fit its bufferView`);
    if (a.normalized && (a.componentType === 5126 || a.componentType === 5125)) err(`${where}.normalized only for 8/16-bit integers`);
    if ((a.min && a.min.length !== n) || (a.max && a.max.length !== n)) err(`${where}.min/max must have ${n} components`);
    const d = readAcc(i);
    if (d && a.componentType === 5126) for (let k = 0; k < d.length; k++) if (!Number.isFinite(d[k])) { err(`${where} has non-finite values`); break; }
    if (d && a.min && a.max) for (let k = 0; k < d.length; k++) { const c = k % n; if (d[k] < a.min[c] - 1e-5 * Math.max(1, Math.abs(a.min[c])) || d[k] > a.max[c] + 1e-5 * Math.max(1, Math.abs(a.max[c]))) { err(`${where} value outside min/max`); break; } }
  });
  const accOf = (ai, where) => { const a = A('accessors')[ai]; if (!a) { err(`${where}: accessor ${ai} invalid`); return null; } used.accessors.add(ai); return a; };

  // ---- textures / images / samplers
  A('textures').forEach((t, i) => {
    noteExt(t, `textures[${i}]`);
    if (t.source !== undefined) { if (!A('images')[t.source]) err(`textures[${i}].source invalid`); else used.images.add(t.source); }
    if (t.sampler !== undefined) { if (!A('samplers')[t.sampler]) err(`textures[${i}].sampler invalid`); else used.samplers.add(t.sampler); }
  });
  A('images').forEach((im, i) => {
    if (im.bufferView !== undefined) {
      used.bufferViews.add(im.bufferView);
      const v = A('bufferViews')[im.bufferView];
      if (!v) { err(`images[${i}].bufferView invalid`); return; }
      if (!im.mimeType) err(`images[${i}] with bufferView needs mimeType`);
      const off = v.byteOffset ?? 0;
      if (im.mimeType === 'image/png' && PNG_SIG.some((b, k) => bin[off + k] !== b)) err(`images[${i}] is not a PNG`);
    } else if (!im.uri) err(`images[${i}] needs uri or bufferView`);
  });
  A('samplers').forEach((s, i) => {
    if (s.magFilter !== undefined && ![9728, 9729].includes(s.magFilter)) err(`samplers[${i}].magFilter invalid`);
    if (s.wrapS !== undefined && ![33071, 33648, 10497].includes(s.wrapS)) err(`samplers[${i}].wrapS invalid`);
  });

  // ---- materials (texCoord sets checked per primitive below)
  const matTexCoords = A('materials').map(() => new Set());
  const matNeedsTangent = A('materials').map(() => false);
  A('materials').forEach((m, i) => {
    const where = `materials[${i}]`;
    const ctx = {
      textureInfo(t) {
        if (!t || typeof t !== 'object' || !Number.isInteger(t.index)) return 'texture info needs an integer index';
        if (!A('textures')[t.index]) return `texture ${t.index} does not exist`;
        used.textures.add(t.index);
        matTexCoords[i].add(t.texCoord ?? 0);
        return null;
      },
    };
    const ti = (t, name) => { if (t === undefined) return; const e = ctx.textureInfo(t); if (e) err(`${where}.${name}: ${e}`); };
    const pbr = m.pbrMetallicRoughness || {};
    if (pbr.baseColorFactor && !vecIn01(pbr.baseColorFactor, 4)) err(`${where} baseColorFactor must be 4 numbers 0..1`);
    if (pbr.metallicFactor !== undefined && !in01(pbr.metallicFactor)) err(`${where} metallicFactor 0..1`);
    if (pbr.roughnessFactor !== undefined && !in01(pbr.roughnessFactor)) err(`${where} roughnessFactor 0..1`);
    ti(pbr.baseColorTexture, 'baseColorTexture'); ti(pbr.metallicRoughnessTexture, 'metallicRoughnessTexture');
    ti(m.normalTexture, 'normalTexture'); ti(m.occlusionTexture, 'occlusionTexture'); ti(m.emissiveTexture, 'emissiveTexture');
    if (m.occlusionTexture && m.occlusionTexture.strength !== undefined && !in01(m.occlusionTexture.strength)) err(`${where} occlusionTexture.strength 0..1`);
    if (m.emissiveFactor && !vecIn01(m.emissiveFactor, 3)) err(`${where} emissiveFactor must be 3 numbers 0..1 (use KHR_materials_emissive_strength for > 1)`);
    if (m.alphaMode !== undefined && !['OPAQUE', 'MASK', 'BLEND'].includes(m.alphaMode)) err(`${where}.alphaMode invalid`);
    if (m.alphaCutoff !== undefined && m.alphaMode !== 'MASK') err(`${where}.alphaCutoff only with alphaMode MASK`);
    if (m.normalTexture) matNeedsTangent[i] = matNeedsTangent[i] || 'soft';
    noteExt(m, where);
    for (const [name, body] of Object.entries(m.extensions || {})) {
      const schema = EXT[name];
      if (!schema) continue;
      if (!body || typeof body !== 'object') { err(`${where}.${name} must be an object`); continue; }
      for (const [k, v] of Object.entries(body)) {
        if (k === 'extras' || k === 'extensions') continue;
        if (!schema[k]) { err(`${where}.${name}.${k} is not a field of ${name}`); continue; }
        const e = schema[k](v, ctx);
        if (e) err(`${where}.${name}: ${e}`);
      }
      if (name === 'KHR_materials_anisotropy') matNeedsTangent[i] = true;
    }
    if (m.extensions?.KHR_materials_volume && !m.extensions?.KHR_materials_transmission && !m.extensions?.KHR_materials_diffuse_transmission) err(`${where}: KHR_materials_volume needs transmission or diffuse_transmission`);
    // agent-art extras with texture indices
    const ex = m.extras || {};
    for (const k of EXTRA_TEXTURES) if (ex[k] !== undefined) { const e = ctx.textureInfo(ex[k]); if (e) err(`${where}.extras.${k}: ${e}`); }
    if (ex.detail) for (const k of ['texture', 'normal']) if (ex.detail[k] !== undefined) { const e = ctx.textureInfo(ex.detail[k]); if (e) err(`${where}.extras.detail.${k}: ${e}`); }
  });

  // ---- meshes
  A('meshes').forEach((mesh, mi) => {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) { err(`meshes[${mi}] needs primitives`); return; }
    mesh.primitives.forEach((p, pi) => {
      const where = `meshes[${mi}].primitives[${pi}]`;
      noteExt(p, where);
      const at = p.attributes || {};
      if (at.POSITION === undefined) { err(`${where} needs POSITION`); return; }
      const pa = accOf(at.POSITION, where);
      if (!pa) return;
      const n = pa.count;
      if (pa.type !== 'VEC3' || pa.componentType !== 5126) err(`${where} POSITION must be float VEC3`);
      if (!pa.min || !pa.max) err(`${where} POSITION needs min/max`);
      const sets = { TEXCOORD: [], COLOR: [], JOINTS: [], WEIGHTS: [] };
      for (const [k, ai] of Object.entries(at)) {
        const a = accOf(ai, `${where}.${k}`);
        if (!a) continue;
        if (a.count !== n) err(`${where}.${k} count ${a.count} != POSITION ${n}`);
        const m = k.match(/^(TEXCOORD|COLOR|JOINTS|WEIGHTS)_(\d+)$/);
        if (m) sets[m[1]].push(Number(m[2]));
        if (k === 'NORMAL' || k === 'TANGENT') {
          if (k === 'NORMAL' && (a.type !== 'VEC3' || a.componentType !== 5126)) err(`${where} NORMAL must be float VEC3`);
          if (k === 'TANGENT' && (a.type !== 'VEC4' || a.componentType !== 5126)) err(`${where} TANGENT must be float VEC4`);
          const d = readAcc(ai), c = COMP[a.type];
          if (d) for (let i = 0; i < a.count; i++) {
            const l = Math.hypot(d[i * c], d[i * c + 1], d[i * c + 2]);
            if (Math.abs(l - 1) > 5e-3) { err(`${where}.${k}[${i}] is not unit length (${l.toFixed(4)})`); break; }
            if (k === 'TANGENT' && d[i * 4 + 3] !== 1 && d[i * 4 + 3] !== -1) { err(`${where}.TANGENT[${i}].w must be +1 or -1`); break; }
          }
        }
        if (m && m[1] === 'TEXCOORD' && (a.type !== 'VEC2' || !(a.componentType === 5126 || (a.normalized && [5121, 5123].includes(a.componentType))))) err(`${where}.${k} must be VEC2 float (or normalized u8/u16)`);
        if (m && m[1] === 'COLOR' && (!['VEC3', 'VEC4'].includes(a.type) || !(a.componentType === 5126 || (a.normalized && [5121, 5123].includes(a.componentType))))) err(`${where}.${k} must be VEC3/VEC4 float (or normalized u8/u16)`);
        if (m && m[1] === 'COLOR' && a.componentType === 5126) { const d = readAcc(ai); if (d) for (let q = 0; q < d.length; q++) if (d[q] < -1e-6 || d[q] > 1 + 1e-6) { err(`${where}.${k} values must be 0..1`); break; } }
      }
      for (const [s, list] of Object.entries(sets)) { list.sort((x, y) => x - y); if (list.some((v, i) => v !== i)) err(`${where} ${s}_n sets must be consecutive from 0 (have ${list.join(', ')})`); }
      if (p.indices !== undefined) {
        const ia = accOf(p.indices, `${where}.indices`);
        if (ia) {
          if (ia.type !== 'SCALAR' || ![5121, 5123, 5125].includes(ia.componentType)) err(`${where}.indices must be unsigned SCALAR`);
          const d = readAcc(p.indices);
          if (d) for (let i = 0; i < d.length; i++) if (d[i] >= n) { err(`${where} index ${d[i]} >= vertex count ${n}`); break; }
          if ((p.mode ?? 4) === 4 && ia.count % 3) err(`${where} TRIANGLES index count not a multiple of 3`);
        }
      }
      if (p.mode !== undefined && !(p.mode >= 0 && p.mode <= 6)) err(`${where}.mode invalid`);
      if (p.material !== undefined) {
        const m = A('materials')[p.material];
        if (!m) err(`${where}.material invalid`);
        else {
          used.materials.add(p.material);
          for (const tc of matTexCoords[p.material]) if (at[`TEXCOORD_${tc}`] === undefined) err(`${where}: material ${p.material} samples TEXCOORD_${tc}, which the primitive lacks`);
          if (matNeedsTangent[p.material] === true && at.TANGENT === undefined) err(`${where}: anisotropic material without TANGENT`);
          if (matNeedsTangent[p.material] === 'soft' && at.TANGENT === undefined) warnings.push(`${where}: normal map without TANGENT (engines derive tangents)`);
        }
      }
      for (const [ti, t] of (p.targets || []).entries()) for (const [k, ai] of Object.entries(t)) { const a = accOf(ai, `${where}.targets[${ti}].${k}`); if (a && a.count !== n) err(`${where}.targets[${ti}].${k} count != POSITION`); }
      if (p.targets && mesh.weights && mesh.weights.length !== p.targets.length) err(`meshes[${mi}].weights length != targets`);
    });
  });

  // ---- nodes / scenes
  const nodes = A('nodes');
  nodes.forEach((nd, i) => {
    const where = `nodes[${i}]`;
    noteExt(nd, where);
    if (nd.mesh !== undefined) { if (!A('meshes')[nd.mesh]) err(`${where}.mesh invalid`); else used.meshes.add(nd.mesh); }
    if (nd.matrix && (nd.translation || nd.rotation || nd.scale)) err(`${where}: matrix and TRS are exclusive`);
    if (nd.matrix && nd.matrix.length !== 16) err(`${where}.matrix must have 16 numbers`);
    if (nd.rotation && Math.abs(Math.hypot(...nd.rotation) - 1) > 1e-3) err(`${where}.rotation must be a unit quaternion`);
    for (const c of nd.children || []) if (!nodes[c]) err(`${where}.children has invalid ${c}`);
    const ins = nd.extensions?.EXT_mesh_gpu_instancing;
    if (ins) for (const [k, ai] of Object.entries(ins.attributes || {})) accOf(ai, `${where}.EXT_mesh_gpu_instancing.${k}`);
  });
  const parent = new Map();
  nodes.forEach((nd, i) => { for (const c of nd.children || []) { if (parent.has(c)) err(`nodes[${c}] has two parents`); parent.set(c, i); } });
  for (let i = 0; i < nodes.length; i++) { let k = i, steps = 0; while (parent.has(k) && steps++ <= nodes.length) k = parent.get(k); if (steps > nodes.length) { err(`node cycle through nodes[${i}]`); break; } }
  A('scenes').forEach((s, i) => { for (const n of s.nodes || []) { if (!nodes[n]) err(`scenes[${i}] has invalid node ${n}`); else if (parent.has(n)) err(`scenes[${i}] root ${n} is a child`); } });
  if (json.scene !== undefined && !A('scenes')[json.scene]) err('scene invalid');
  A('animations').forEach((an, i) => {
    for (const s of an.samplers || []) { accOf(s.input, `animations[${i}] input`); accOf(s.output, `animations[${i}] output`); }
    for (const c of an.channels || []) if (!an.samplers?.[c.sampler] || (c.target?.node !== undefined && !nodes[c.target.node])) err(`animations[${i}] channel invalid`);
  });
  for (const sk of A('skins')) { if (sk.inverseBindMatrices !== undefined) accOf(sk.inverseBindMatrices, 'skin'); }

  // ---- extension bookkeeping
  noteExt(json, 'root');
  const listed = new Set(json.extensionsUsed || []);
  for (const e of extUsed) if (!listed.has(e)) err(`extension ${e} is used but not in extensionsUsed`);
  for (const e of listed) if (!extUsed.has(e)) warnings.push(`extensionsUsed lists ${e}, which nothing uses`);
  for (const e of json.extensionsRequired || []) if (!listed.has(e)) err(`extensionsRequired ${e} missing from extensionsUsed`);
  // ---- unused objects (warnings, like the Khronos validator's info)
  A('accessors').forEach((_, i) => { if (!used.accessors.has(i)) warnings.push(`accessors[${i}] unused`); });
  A('bufferViews').forEach((_, i) => { if (!used.bufferViews.has(i)) warnings.push(`bufferViews[${i}] unused`); });
  A('materials').forEach((_, i) => { if (!used.materials.has(i)) warnings.push(`materials[${i}] unused`); });
  return { ok: !errors.length, errors, warnings, stats: { extensions: [...extUsed].sort(), materials: A('materials').length, textures: A('textures').length, images: A('images').length, meshes: A('meshes').length, accessors: A('accessors').length } };
}

/** Parse a .glb into {json, bin, accessor(i) -> Float64Array, image(textureIndex) -> PNG bytes}. */
export function parseGLB(buf) {
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bin = buf.subarray(20 + jlen + 8, 20 + jlen + 8 + buf.readUInt32LE(20 + jlen));
  const accessor = (ai) => {
    const a = json.accessors[ai], v = json.bufferViews[a.bufferView], n = COMP[a.type], T = ARRAYS[a.componentType];
    const off = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from(new T(bin.buffer.slice(off, off + a.count * n * CSIZE[a.componentType])));
  };
  const image = (ti) => { const im = json.images[json.textures[ti].source], v = json.bufferViews[im.bufferView]; return Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); };
  return { json, bin, accessor, image };
}
