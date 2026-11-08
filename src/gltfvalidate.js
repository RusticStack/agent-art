// Structural glTF 2.0 (.glb) validator, no dependencies: container, buffer views, accessors (range,
// component types, POSITION min/max), meshes (attribute counts, indices in range, morph targets),
// skins (joints are nodes under one root, inverseBindMatrices MAT4 with an affine last row,
// JOINTS_0 < joint count, WEIGHTS_0 non-negative and summing to 1), the node tree (one parent, no
// cycles) and animations (increasing SCALAR inputs, output counts per path, weights channels on
// meshes with targets). Not a replacement for the Khronos validator; it catches what our writers
// could get wrong.

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** Parse a .glb Buffer -> {json, bin} (throws on a broken container). */
export function parseGLB(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb (magic)');
  if (buf.readUInt32LE(4) !== 2) throw new Error('glb version must be 2');
  if (buf.readUInt32LE(8) !== buf.length) throw new Error(`glb length ${buf.readUInt32LE(8)} != file size ${buf.length}`);
  const jlen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk must be JSON');
  if (jlen % 4) throw new Error('JSON chunk not 4-byte aligned');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  let bin = null;
  const bo = 20 + jlen;
  if (bo < buf.length) {
    const blen = buf.readUInt32LE(bo);
    if (buf.readUInt32LE(bo + 4) !== 0x004e4942) throw new Error('second chunk must be BIN');
    if (bo + 8 + blen !== buf.length) throw new Error('BIN chunk length mismatch');
    bin = buf.subarray(bo + 8, bo + 8 + blen);
  }
  return { json, bin };
}

/** Read an accessor as a plain array (tightly packed views, as our writers emit). */
export function readAccessor(json, bin, ai) {
  const a = json.accessors[ai];
  const v = json.bufferViews[a.bufferView];
  const T = TYPED[a.componentType], n = a.count * COMP[a.type];
  const off = bin.byteOffset + v.byteOffset + (a.byteOffset || 0);
  return Array.from(new T(bin.buffer.slice(off, off + n * SIZE[a.componentType])));
}

/** -> {ok, errors: [..], warnings: [..], stats} */
export function validateGLB(buf) {
  const errors = [], warnings = [];
  const E = (m) => { if (errors.length < 60) errors.push(m); };
  let json, bin;
  try { ({ json, bin } = parseGLB(buf)); } catch (e) { return { ok: false, errors: [e.message], warnings, stats: {} }; }
  if (json.asset?.version !== '2.0') E('asset.version must be "2.0"');
  const nb = (k) => (json[k] || []).length;
  // buffers / views
  if (json.buffers?.[0] && bin && json.buffers[0].byteLength > bin.length) E('buffers[0].byteLength exceeds the BIN chunk');
  for (const [i, v] of (json.bufferViews || []).entries()) {
    if (v.buffer !== 0) E(`bufferViews[${i}].buffer must be 0 (single BIN buffer)`);
    if (!bin || v.byteOffset + v.byteLength > bin.length) E(`bufferViews[${i}] outside the BIN chunk`);
  }
  const accOk = new Set();
  for (const [i, a] of (json.accessors || []).entries()) {
    const v = json.bufferViews?.[a.bufferView];
    if (!v) { E(`accessors[${i}].bufferView missing`); continue; }
    if (!SIZE[a.componentType] || !COMP[a.type]) { E(`accessors[${i}] bad componentType/type`); continue; }
    const cs = SIZE[a.componentType];
    if (((v.byteOffset || 0) + (a.byteOffset || 0)) % cs) E(`accessors[${i}] not aligned to its component size`);
    if ((a.byteOffset || 0) + a.count * COMP[a.type] * cs > v.byteLength) { E(`accessors[${i}] (${a.count} x ${a.type}) overruns its bufferView`); continue; }
    if (!(a.count >= 1)) E(`accessors[${i}].count must be >= 1`);
    accOk.add(i);
  }
  const read = (ai, what) => { if (!accOk.has(ai)) { E(`${what}: accessor ${ai} invalid`); return null; } return readAccessor(json, bin, ai); };
  // nodes
  const parent = new Map();
  for (const [i, n] of (json.nodes || []).entries()) {
    for (const c of n.children || []) {
      if (!(c >= 0 && c < nb('nodes')) || c === i) E(`nodes[${i}].children: bad index ${c}`);
      else if (parent.has(c)) E(`node ${c} has two parents`);
      else parent.set(c, i);
    }
    if (n.matrix && (n.translation || n.rotation || n.scale)) E(`nodes[${i}] has both matrix and TRS`);
    if (n.rotation && Math.abs(Math.hypot(...n.rotation) - 1) > 1e-5) E(`nodes[${i}].rotation is not a unit quaternion`);
    if (n.mesh !== undefined && !json.meshes?.[n.mesh]) E(`nodes[${i}].mesh ${n.mesh} missing`);
    if (n.skin !== undefined && (!json.skins?.[n.skin] || n.mesh === undefined)) E(`nodes[${i}].skin needs a mesh and an existing skin`);
  }
  for (const [i] of (json.nodes || []).entries()) { let k = i, g = 0; while (parent.has(k) && g++ <= nb('nodes')) k = parent.get(k); if (g > nb('nodes')) { E(`node ${i}: cycle`); break; } }
  const rootOf = (i) => { let k = i; while (parent.has(k)) k = parent.get(k); return k; };
  for (const r of json.scenes?.[json.scene ?? 0]?.nodes || []) if (parent.has(r)) E(`scene root ${r} is a child`);
  // meshes
  const meshTargets = new Map();
  const skinnedMeshes = new Map();
  for (const [ni, n] of (json.nodes || []).entries()) if (n.skin !== undefined && n.mesh !== undefined) skinnedMeshes.set(n.mesh, n.skin);
  let vertices = 0, skinnedVerts = 0, maxInf = 0;
  for (const [mi, m] of (json.meshes || []).entries()) {
    let targets = null;
    for (const [pi, p] of m.primitives.entries()) {
      const w = `meshes[${mi}].primitives[${pi}]`;
      const pa = p.attributes || {};
      if (pa.POSITION === undefined) { E(`${w}: no POSITION`); continue; }
      const pos = json.accessors[pa.POSITION], n = pos?.count;
      vertices += n || 0;
      if (pos && (pos.type !== 'VEC3' || pos.componentType !== 5126 || !pos.min || !pos.max)) E(`${w}: POSITION must be FLOAT VEC3 with min/max`);
      for (const [k, ai] of Object.entries(pa)) if (json.accessors[ai]?.count !== n) E(`${w}: ${k} count ${json.accessors[ai]?.count} != POSITION ${n}`);
      if (p.indices !== undefined) { const I = read(p.indices, `${w} indices`); if (I && I.some((x) => x >= n)) E(`${w}: index out of range`); }
      if (p.material !== undefined && !json.materials?.[p.material]) E(`${w}: material missing`);
      const tc = (p.targets || []).length;
      if (targets === null) targets = tc; else if (targets !== tc) E(`meshes[${mi}]: primitives have different morph target counts`);
      for (const [ti, t] of (p.targets || []).entries()) for (const [k, ai] of Object.entries(t)) {
        if (json.accessors[ai]?.count !== n) E(`${w}.targets[${ti}].${k} count != POSITION`);
        if (k === 'POSITION' && !(json.accessors[ai]?.min && json.accessors[ai]?.max)) E(`${w}.targets[${ti}].POSITION needs min/max`);
      }
      if ((pa.JOINTS_0 === undefined) !== (pa.WEIGHTS_0 === undefined)) E(`${w}: JOINTS_0 and WEIGHTS_0 come together`);
      if (pa.JOINTS_0 !== undefined) {
        const ja = json.accessors[pa.JOINTS_0], wa = json.accessors[pa.WEIGHTS_0];
        if (ja.type !== 'VEC4' || ![5121, 5123].includes(ja.componentType)) E(`${w}: JOINTS_0 must be VEC4 UNSIGNED_BYTE|UNSIGNED_SHORT`);
        if (wa.type !== 'VEC4' || ![5126, 5121, 5123].includes(wa.componentType) || (wa.componentType !== 5126 && !wa.normalized)) E(`${w}: WEIGHTS_0 must be VEC4 FLOAT (or normalized UBYTE/USHORT)`);
        if (!skinnedMeshes.has(mi)) E(`${w}: JOINTS_0 on a mesh no node skins`);
        const J = read(pa.JOINTS_0, `${w} JOINTS_0`), Wt = read(pa.WEIGHTS_0, `${w} WEIGHTS_0`);
        const sk = json.skins?.[skinnedMeshes.get(mi)];
        if (J && Wt && sk) {
          const div = wa.componentType === 5126 ? 1 : wa.componentType === 5121 ? 255 : 65535;
          let bad = 0, neg = 0, range = 0;
          for (let v = 0; v < n; v++) {
            let s = 0, c = 0;
            for (let k = 0; k < 4; k++) { const x = Wt[v * 4 + k] / div; if (x < 0) neg++; s += x; if (x > 0) { c++; if (J[v * 4 + k] >= sk.joints.length) range++; } }
            if (Math.abs(s - 1) > 2e-3) bad++;
            maxInf = Math.max(maxInf, c);
          }
          skinnedVerts += n;
          if (bad) E(`${w}: ${bad} vertices whose weights do not sum to 1`);
          if (neg) E(`${w}: negative weights`);
          if (range) E(`${w}: ${range} JOINTS_0 entries >= skin joint count ${sk.joints.length}`);
        }
      }
    }
    meshTargets.set(mi, targets || 0);
    if (m.weights && m.weights.length !== targets) E(`meshes[${mi}].weights length != morph target count`);
  }
  // skins
  for (const [si, s] of (json.skins || []).entries()) {
    if (!s.joints?.length) { E(`skins[${si}] has no joints`); continue; }
    if (new Set(s.joints).size !== s.joints.length) E(`skins[${si}]: duplicate joints`);
    for (const j of s.joints) if (!json.nodes?.[j]) E(`skins[${si}]: joint ${j} is not a node`);
    const roots = new Set(s.joints.map(rootOf));
    if (roots.size !== 1) E(`skins[${si}]: joints must share one root (found ${roots.size})`);
    if (s.skeleton !== undefined && !s.joints.every((j) => { for (let k = j; ; k = parent.get(k)) { if (k === s.skeleton) return true; if (!parent.has(k)) return false; } })) E(`skins[${si}].skeleton is not a common ancestor of the joints`);
    if (s.inverseBindMatrices !== undefined) {
      const a = json.accessors[s.inverseBindMatrices];
      if (!a || a.type !== 'MAT4' || a.componentType !== 5126 || a.count !== s.joints.length) E(`skins[${si}].inverseBindMatrices must be FLOAT MAT4 x joint count`);
      else {
        const M = read(s.inverseBindMatrices, `skins[${si}] ibm`);
        for (let j = 0; M && j < a.count; j++) if (Math.abs(M[j * 16 + 3]) > 1e-6 || Math.abs(M[j * 16 + 7]) > 1e-6 || Math.abs(M[j * 16 + 11]) > 1e-6 || Math.abs(M[j * 16 + 15] - 1) > 1e-6) { E(`skins[${si}]: inverseBindMatrix ${j} is not affine`); break; }
      }
    }
  }
  // animations
  let channels = 0;
  for (const [ai, an] of (json.animations || []).entries()) {
    for (const [ci, c] of an.channels.entries()) {
      channels++;
      const w = `animations[${ai}].channels[${ci}]`;
      const s = an.samplers[c.sampler];
      if (!s) { E(`${w}: sampler missing`); continue; }
      const t = c.target || {};
      if (!['translation', 'rotation', 'scale', 'weights'].includes(t.path)) E(`${w}: bad path ${t.path}`);
      if (!json.nodes?.[t.node]) { E(`${w}: node missing`); continue; }
      const inp = json.accessors[s.input], out = json.accessors[s.output];
      if (!inp || inp.type !== 'SCALAR' || inp.componentType !== 5126 || !inp.min || !inp.max) { E(`${w}: input must be FLOAT SCALAR with min/max`); continue; }
      const T = read(s.input, `${w} input`);
      if (T) for (let i = 1; i < T.length; i++) if (!(T[i] > T[i - 1])) { E(`${w}: input times not strictly increasing`); break; }
      const k = s.interpolation === 'CUBICSPLINE' ? 3 : 1;
      if (t.path === 'weights') {
        const mi = json.nodes[t.node].mesh, nt = meshTargets.get(mi) || 0;
        if (mi === undefined || !nt) E(`${w}: weights channel on a node without morph targets`);
        else if (out.count !== inp.count * nt * k) E(`${w}: weights output ${out.count} != ${inp.count} times x ${nt} targets`);
      } else {
        const want = t.path === 'rotation' ? 'VEC4' : 'VEC3';
        if (out.type !== want) E(`${w}: ${t.path} output must be ${want}`);
        if (out.count !== inp.count * k) E(`${w}: output count ${out.count} != input ${inp.count}`);
        if (t.path === 'rotation') { const R = read(s.output, `${w} output`); if (R) for (let i = 0; i < R.length; i += 4) if (Math.abs(Math.hypot(R[i], R[i + 1], R[i + 2], R[i + 3]) - 1) > 1e-3) { E(`${w}: non-unit rotation`); break; } }
      }
    }
  }
  if (!json.scenes?.length) warnings.push('no scenes');
  return {
    ok: !errors.length, errors, warnings,
    stats: { nodes: nb('nodes'), meshes: nb('meshes'), skins: nb('skins'), joints: (json.skins || []).reduce((s, k) => s + k.joints.length, 0), vertices, skinned_vertices: skinnedVerts, max_influences: maxInf, morph_targets: Math.max(0, ...meshTargets.values()), animations: nb('animations'), channels },
  };
}
