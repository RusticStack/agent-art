// Export corpus for the byte-identity check (materials v2): models covering every 0.7 export path
// (plain, PBR maps, bump, emissive, glass, atlas, baked AO, morphs, LODs, rig). The hashes in
// golden-0.7.json were recorded on 0.7.0 (origin/main 7bfa3f8) before any materials-v2 code.
// Hashes cover the JSON chunk and every non-image bufferView (PNG bytes depend on the zlib build),
// plus each decoded image's RGBA, so they are stable across Node versions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../../src/engine.js';
import { decodePNG } from '../../src/png.js';

export function corpusEngine() {
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-corpus-')) });
  const draw = (canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });
  e.run('create', { name: 'hull', width: 16 });
  draw('hull', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#707680' }, { op: 'line', x1: 0, y1: 7, x2: 15, y2: 7, color: '#30343a' }]);
  e.run('create', { name: 'plate', width: 16 });
  draw('plate', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#808890' }, { op: 'rect', x: 4, y: 4, w: 8, h: 8, color: '#9098a0' }]);
  e.run('create', { name: 'gun', width: 8 });
  draw('gun', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#555555' }]);
  for (const l of ['metal', 'rough', 'height', 'emissive']) e.run('layer', { canvas: 'gun', action: 'add', name: l });
  draw('gun', [{ op: 'rect', x: 0, y: 0, w: 4, h: 8, color: '#ffffff' }], 'metal');
  draw('gun', [{ op: 'rect', x: 0, y: 0, w: 8, h: 4, color: '#333333' }], 'rough');
  draw('gun', [{ op: 'rect', x: 2, y: 2, w: 4, h: 4, color: '#ffffff' }], 'height');
  draw('gun', [{ op: 'rect', x: 6, y: 6, w: 2, h: 2, color: '#40e0ff' }], 'emissive');
  const models = {
    plain: { parts: [{ type: 'box', w: 16, h: 16, d: 16, color: '#8a8a94' }] },
    kit: { parts: [{ type: 'floor', texture: 'plate' }, { type: 'wall', texture: 'hull', at: [0, 0, -16] }, { type: 'pillar', texture: 'hull', at: [16, 0, -16] }] },
    pbr: { parts: [
      { type: 'box', w: 16, h: 16, d: 16, texture: 'hull', material: 'bare_metal', bump: { auto: 'panels' } },
      { type: 'box', w: 8, h: 8, d: 8, texture: 'gun', at: [20, 0, 0] },
      { type: 'box', w: 8, h: 2, d: 8, texture: 'plate', material: 'emissive_panel', at: [-20, 0, 0] },
      { type: 'box', w: 8, h: 8, d: 8, color: '#9fd8ff', material: 'glass', at: [0, 0, 20] },
      { type: 'cylinder', r: 4, h: 8, texture: 'plate', material: { metal: 0.5, rough: 0.25 }, at: [0, 0, -20] },
    ] },
    pair: { parts: [{ type: 'box', w: 8, h: 8, d: 8, color: '#a04040' }, { type: 'box', w: 8, h: 8, d: 8, color: '#40a040', at: [12, 0, 0] }, { type: 'plane', w: 8, h: 8, texture: 'gun', at: [-12, 0, 0] }] },
    morph: { parts: [{ type: 'box', w: 16, h: 4, d: 16, color: '#666' }], morphs: { open: { set: { 0: { at: [0, 8, 0] } } } } },
  };
  for (const [name, def] of Object.entries(models)) e.run('model_create', { name, ...def });
  e.run('model_create', { name: 'rifle', template: 'fp_rifle' });
  return e;
}

export const CORPUS = [
  ['plain', {}], ['kit', {}], ['pair', {}], ['pair', { atlas: true }], ['pbr', {}], ['pbr', { up: 'z' }],
  ['pbr', { bake_ao: { samples: 8 } }], ['pbr', { bake_ao: { mode: 'vertex', samples: 8 } }], ['kit', { lods: [1, 0.5] }],
  ['morph', {}], ['rifle', {}], ['pbr', { normal_maps: false, stats: true }],
];

/** sha256 over the JSON chunk, the non-image bufferViews and the decoded RGBA of each image. */
export function glbDigest(buf) {
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bin = buf.subarray(20 + jlen + 8);
  const h = crypto.createHash('sha256');
  h.update(buf.subarray(20, 20 + jlen));
  const img = new Set((json.images || []).map((i) => i.bufferView));
  json.bufferViews.forEach((v, i) => {
    const b = bin.subarray(v.byteOffset, v.byteOffset + v.byteLength);
    if (img.has(i)) { const p = decodePNG(Buffer.from(b)); h.update(`${p.width}x${p.height}`); h.update(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength)); } else h.update(b);
  });
  return h.digest('hex');
}

export function corpusDigests(e = corpusEngine(), extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-corpus-out-'));
  return CORPUS.map(([name, args], i) => {
    const r = e.run('model_export', { name, path: path.join(dir, `${name}_${i}.glb`), ...args, ...extra });
    const meta = crypto.createHash('sha256').update(fs.readFileSync(r.meta)).digest('hex').slice(0, 16);
    return `${name} ${JSON.stringify(args)} ${glbDigest(fs.readFileSync(r.file))} meta:${meta}`;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  console.log(JSON.stringify(corpusDigests(), null, 1));
}
