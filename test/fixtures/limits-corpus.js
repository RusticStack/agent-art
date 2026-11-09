// Unchanged-output corpus for the 0.9 limits pass (fp aim variants, diagonal muzzles, steam sfx,
// damage UV channel / LOD blend / rigs / sprite overlay / open-mesh fracture, gun disarm, front /
// back contact checks, per-skeleton takedowns). Everything here does NOT use a changed feature, so
// the branch must reproduce the digests in limits-golden-0.9.json, recorded on 0.9.0 (origin/main
// 503bdfe) before any of the changes:
//   - damage exports of rigid, rig-less models without model overlays, AO, lightmaps or LODs
//     (nodes / files / blend modes, vertex channel, Roblox profile, fracture of closed parts)
//   - art_fx sheets + metadata of every effect except fp / side muzzles and steam (whose metadata
//     changes on purpose); the side / front muzzle and steam sheets (pixels unchanged)
//   - art_audio renders of the recipes that existed in 0.9.0
//   - melee clip JSONs and the batch manifest of a knife skeleton / skin without proportions, and
//     the 0.9.0 clips of a rifle skeleton
// glb digests as test/fixtures/damage-corpus.js (JSON chunk + non-image buffers + decoded RGBA).
// Regenerate (only when main legitimately changes these outputs):
//   node test/fixtures/limits-corpus.js <src dir> > test/fixtures/limits-golden-0.9.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { glbDigest } from './damage-corpus.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = (f) => sha(fs.readFileSync(f));
const pngDigest = (f, decodePNG) => { const p = decodePNG(fs.readFileSync(f)); return sha(Buffer.concat([Buffer.from(`${p.width}x${p.height}`), Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength)])); };
/** The recipes that existed in 0.9.0 (new ones are added by the limits pass). */
export const RECIPES_090 = ['gib_burst', 'flesh_squelch', 'bone_crunch', 'hit_light', 'hit_heavy', 'explosion', 'fire_burst', 'click', 'gunshot_rifle', 'gunshot_pistol', 'gunshot_suppressed', 'mag_out', 'casing_drop', 'laser_bolt', 'shield_hit', 'glitch_tear', 'drone_rotor', 'alarm_klaxon', 'ricochet', 'footstep'];
const RIFLE_CLIPS_090 = ['butt_stroke', 'kick', 'shove', 'block', 'parry', 'hit_front', 'hit_back', 'hit_left', 'hit_right', 'stagger_front', 'knockdown', 'get_up', 'takedown_rear_attacker', 'takedown_rear_victim'];

export function corpus(e, { decodePNG, renderSfx }) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-limits-corpus-'));
  const D = {};
  // ---- damage (rigid, no overlays / AO / LODs)
  e.run('create', { name: 'hull', width: 16 });
  e.run('draw', { canvas: 'hull', commands: [{ op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 3, seed: 3 }, { op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#2a2e35', fill: false }] });
  e.run('create', { name: 'plank', width: 16 });
  e.run('draw', { canvas: 'plank', commands: [{ op: 'noise', colors: ['#7a5630', '#835d34', '#8c6538'], scale: 3, seed: 2 }] });
  // unwrap:false: the legacy per-part path (new models are unwrapped by default since the golden was recorded)
  e.run('model_create', { name: 'crate', unwrap: false, origin: 'bottom', parts: [
    { type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'plank' },
    { type: 'box', id: 'lid', w: 26, h: 2, d: 26, at: [0, 24, 0], texture: 'hull' },
    { type: 'box', id: 'slat', w: 18, h: 18, d: 1.5, at: [0, 3, 12.75], texture: 'hull' },
  ] });
  e.run('model_create', { name: 'hull_panel', unwrap: false, origin: 'bottom', parts: [
    { type: 'box', id: 'plate', w: 64, h: 32, d: 6, texture: 'hull' },
    { type: 'box', id: 'hatch', w: 16, h: 12, d: 1.5, at: [-16, 10, 3.75], texture: 'hull' },
    { type: 'cylinder', id: 'pipe', r: 1, h: 56, rotate: [0, 0, 90], at: [0, 26, 4.5], color: '#b08a4a' },
  ] });
  e.run('model_damage', { name: 'crate', kind: 'crate', seed: 7, states: ['scuffed', 'damaged', 'wrecked'] });
  e.run('model_damage', { name: 'hull_panel', kind: 'hull', seed: 11, states: ['scuffed', { name: 'damaged', amount: 0.6 }, 'wrecked'] });
  e.run('model_fracture', { name: 'crate', parts: [{ part: 'body', pieces: 5, seed: 2 }] });
  const runs = [
    ['crate', {}], ['hull_panel', {}], ['hull_panel', { damage: { mode: 'files' }, tag: 'files' }], ['crate', { damage: { mode: 'blend', vertex: 'attribute' }, tag: 'blend' }],
    ['hull_panel', { damage: { vertex: 'color', mask_channels: true }, tag: 'vcol' }], ['crate', { profile: 'roblox', tag: 'roblox' }], ['hull_panel', { profile: 'three', tag: 'three' }],
  ];
  for (const [name, o] of runs) {
    const { tag, ...args } = o;
    const dir = path.join(out, `${name}${tag ? '_' + tag : ''}`);
    fs.mkdirSync(dir, { recursive: true });
    e.run('model_export', { name, path: path.join(dir, `${name}.glb`), ...args });
    for (const f of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) continue;
      const k = `damage/${path.basename(dir)}/${f.split(path.sep).join('/')}`;
      D[k] = f.endsWith('.glb') ? glbDigest(fs.readFileSync(p), decodePNG) : f.endsWith('.png') ? pngDigest(p, decodePNG) : shaFile(p);
    }
  }
  // ---- art_fx
  const fx = path.join(out, 'fx');
  e.run('fx_batch', { preset: 'all', seed: 3, group: 'c', path: fx });
  const man = JSON.parse(fs.readFileSync(path.join(fx, 'fx.json'), 'utf8')).groups.c;
  for (const [id, m] of Object.entries(man)) {
    const muzzle = m.type === 'muzzle';
    if (muzzle && m.view === 'fp') continue;
    const metaChanges = (muzzle && m.view === 'side') || m.type === 'steam';
    if (!metaChanges) D[`fx/${id}.json`] = sha(JSON.stringify(m));
    for (const f of [m.file, m.roblox?.file, ...Object.values(m.maps || {})].filter(Boolean)) D[`fx/${f}`] = pngDigest(path.join(fx, f), decodePNG);
  }
  // ---- art_audio (0.9.0 recipes)
  for (const r of RECIPES_090) {
    // 1.0: the gunshot_* names play recordings; the 0.9 synthesis is gunshot_*_synth (must stay byte-identical)
    const s = renderSfx({ recipe: /^gunshot_/.test(r) ? `${r}_synth` : r, seed: 5 });
    D[`audio/${r}`] = sha(Buffer.concat(s.chs.map((c) => Buffer.from(Float32Array.from(c).buffer))));
  }
  // ---- melee: knife skeleton (no proportions) + 0.9.0 rifle clips
  e.run('anim_skeleton', { name: 'kn', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_melee', { skeleton: 'kn', weapon: 'combat_knife' });
  for (const f of fs.readdirSync(path.join(e.home, 'library', 'clips', 'kn')).sort()) D[`melee/kn/${f}`] = shaFile(path.join(e.home, 'library', 'clips', 'kn', f));
  D['melee/kn.skeleton'] = shaFile(path.join(e.home, 'library', 'skeletons', 'kn.json'));
  e.run('anim_skin', { name: 'k1', skeleton: 'kn' });
  const mo = path.join(out, 'melee');
  e.run('anim_batch', { skins: ['k1'], clips: ['knife_slash', 'kick', 'takedown_rear_attacker', 'takedown_rear_victim', 'disarm_front_attacker', 'disarm_front_victim'], views: ['side', 'front_side'], out: mo });
  D['melee/k1/characters.json'] = shaFile(path.join(mo, 'manifest', 'characters.json'));
  e.run('anim_skeleton', { name: 'rf', template: 'humanoid_hd', frame: [64, 96], weapon: { class: 'rifle' } });
  e.run('anim_melee', { skeleton: 'rf' });
  for (const c of RIFLE_CLIPS_090) D[`melee/rf/${c}.json`] = shaFile(path.join(e.home, 'library', 'clips', 'rf', `${c}.json`));
  fs.rmSync(out, { recursive: true, force: true });
  return D;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const src = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'src'));
  const { Engine } = await import(pathToFileURL(path.join(src, 'engine.js')).href);
  const { decodePNG } = await import(pathToFileURL(path.join(src, 'png.js')).href);
  const { renderSfx } = await import(pathToFileURL(path.join(src, 'audio', 'sfx.js')).href);
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-limits-home-')) });
  process.stdout.write(JSON.stringify(corpus(e, { decodePNG, renderSfx }), null, 1) + '\n');
}
