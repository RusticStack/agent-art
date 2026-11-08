// Export corpus for the damage PR: models WITHOUT damage / fracture, exported through every path
// the PR touches (plain, lods, bake_ao, collision, rig, overlays, CTM, booleans, merge). The
// digests in damage-golden-0.8.json were recorded on 0.8.0 (origin/main 6dc1fff) without any
// damage code; the branch must reproduce them (glb: JSON chunk + non-image buffers + decoded image
// RGBA, as test/fixtures/corpus.js, so the zlib build does not matter; meta.json byte for byte).
// Also covers materials v2 (profile three / roblox, v2 presets) since #15.
// Regenerate (only when main legitimately changes its exports): node test/fixtures/damage-corpus.js <src dir> > test/fixtures/damage-golden-0.8.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function corpus(e, decodePNG) {
  e.run('create', { name: 'stone', width: 16, height: 16 });
  e.run('draw', { canvas: 'stone', commands: [{ op: 'cells', colors: ['#3a3a44', '#55555f', '#70707a', '#90909a'], gap_color: '#22222a', size: 5, seed: 3 }] });
  e.run('create', { name: 'grime', width: 16, height: 16 });
  e.run('draw', { canvas: 'grime', commands: [{ op: 'noise', colors: ['#00000000', '#30281e'], weights: [0.6, 0.4], seed: 2 }] });
  e.run('model_create', { name: 'kit_wall', parts: [{ type: 'wall', texture: 'stone' }, { type: 'floor', texture: 'stone', at: [0, 0, 20] }, { type: 'wall', texture: 'stone', at: [32, 0, 0] }], overlays: [{ texture: 'grime', where: 'bottom', falloff: 12 }] });
  e.run('model_create', { name: 'prop', origin: 'bottom', parts: [{ type: 'box', w: 20, h: 14, d: 12, texture: 'stone', bevel: 2 }, { type: 'cylinder', r: 3, h: 10, at: [0, 14, 0], color: '#8899aa', material: 'bare_metal' }, { type: 'box', w: 6, h: 6, d: 20, at: [0, 4, 0], boolean: 'subtract' }] });
  e.run('model_create', { name: 'merged', merge: true, parts: [{ type: 'box', w: 16, h: 16, d: 16, color: '#aa6633' }, { type: 'box', w: 16, h: 16, d: 16, at: [16, 0, 0], color: '#aa6633' }] });
  e.run('model_create', { name: 'v2prop', parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'stone', material: 'painted_hull' }, { type: 'box', w: 8, h: 8, d: 8, color: '#9fd8ff', material: 'glass_canopy', at: [0, 16, 0] }] });
  e.run('model_create', { name: 'door_rig', parts: [{ type: 'box', w: 4, h: 40, d: 4, at: [-14, 0, 0], color: '#555a63' }, { type: 'box', w: 24, h: 38, d: 2, at: [0, 1, 0], color: '#6d7a88', name: 'leaf', pivot: [-12, 0, 0] }], sockets: { handle: { part: 'leaf', at: [8, 20, 2] } } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-corpus-'));
  const runs = [
    ['kit_wall', {}], ['kit_wall', { lods: [1, 0.5], tag: 'lods' }], ['prop', {}], ['prop', { bake_ao: { samples: 8 }, collision: true, tag: 'ao' }],
    ['merged', {}], ['door_rig', {}], ['prop', { atlas: true, tag: 'atlas' }],
    ['prop', { profile: 'three', tag: 'three' }], ['prop', { profile: 'roblox', tag: 'roblox' }], ['v2prop', {}], ['v2prop', { profile: 'three', lods: [1, 0.5], tag: 'three' }],
  ];
  const digests = {};
  for (const [name, o] of runs) {
    const { tag, ...args } = o;
    const file = path.join(out, `${name}${tag ? '_' + tag : ''}.glb`);
    e.run('model_export', { name, path: file, ...args });
    const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    digests[path.basename(file)] = glbDigest(fs.readFileSync(file), decodePNG);
    digests[path.basename(file).replace(/\.glb$/, '.meta.json')] = h(file.replace(/\.glb$/, '.meta.json'));
  }
  fs.rmSync(out, { recursive: true, force: true });
  return digests;
}

/** sha256 over the JSON chunk, the non-image bufferViews and the decoded RGBA of each image. */
export function glbDigest(buf, decodePNG) {
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

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const src = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'src'));
  const { Engine } = await import(pathToFileURL(path.join(src, 'engine.js')).href);
  const { decodePNG } = await import(pathToFileURL(path.join(src, 'png.js')).href);
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-corpus-home-')) });
  process.stdout.write(JSON.stringify(corpus(e, decodePNG), null, 1) + '\n');
}
