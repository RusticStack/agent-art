// Melee: weapon model kit (art_model melee_<id>), the melee clip library on humanoid_hd skeletons
// (strikes, blocks, reactions, paired takedowns), hit events + volumes in the batch manifest, the
// validator (event order, sweep coverage, paired alignment), world weapon sheets, determinism, and
// that nothing changes for skeletons / clips / exports that do not use melee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { MELEE_WEAPONS, MELEE_IDS, meleeCell } from '../src/meleekit.js';
import { meleeEvents, segDist, inPoly, hull } from '../src/melee.js';
import { helpText } from '../src/docs.js';
import { runTool } from '../src/mcp.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-melee-'));
const PAL = { head: '#e0b090', weapon: '#c0c8d0', shield: '#404850', arm: '#7a8a5a', hand: '#d8a070', leg: '#5a6a7a', body: '#6a7a4a', foot: '#3a3020' };
const kind = (k) => (k.startsWith('head') ? 'head' : k === 'weapon' ? 'weapon' : k === 'shield' ? 'shield' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');
/** Flat art in every cell, one colour per part kind. */
function paint(e, name) {
  const cells = e.run('rig_info', { name }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) {
    const [k] = k0.split(':');
    if (k === 'cape' || k.startsWith('gear') || ['mag'].includes(k) || k.startsWith('att_')) continue;
    cmds.push({ op: 'rect', x, y, w, h, color: PAL[kind(k)] });
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
}
const lib = (e, ...p) => JSON.parse(fs.readFileSync(path.join(e.home, 'library', ...p), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
/** Every file under a directory -> {relative path: sha256}. */
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = sha(p); } };
  walk(dir);
  return out;
}
function setup(e, { name = 'kn', weapon = 'combat_knife', shield = false, gun = null, frame = [64, 96] } = {}) {
  e.run('anim_skeleton', { name, template: 'humanoid_hd', frame, ...(gun ? { weapon: { class: gun } } : {}) });
  return e.run('anim_melee', { skeleton: name, ...(weapon && !gun ? { weapon } : {}), ...(shield ? { shield: true } : {}) });
}

test('melee kit: every weapon model builds with grip / guard / tip / edge / strike sockets, clips and a melee block', () => {
  const e = new Engine({ home: tmp() });
  assert.deepEqual(MELEE_IDS, ['combat_knife', 'machete', 'baton', 'stun_baton', 'vibro_blade', 'breach_axe', 'breach_hammer', 'riot_shield']);
  for (const id of MELEE_IDS) {
    e.run('model_create', { name: id, template: `melee_${id}` });
    const info = e.run('model_info', { name: id, full: true });
    const sockets = JSON.stringify(info);
    const need = id === 'riot_shield' ? ['grip', 'face', 'edge_a', 'edge_b', 'strike'] : ['grip', 'guard', 'pommel', 'tip', 'edge_a', 'edge_b', 'strike'];
    for (const s of need) assert.match(sockets, new RegExp(`"${s}"`), `${id} socket ${s}`);
    const W = MELEE_WEAPONS[id];
    assert.ok(['blunt', 'slash', 'pierce', 'shock'].includes(Object.values(W.damage)[0]), `${id} damage`);
    assert.ok(W.length_cm > 10 && W.mass_kg > 0, `${id} size`);
    const c = meleeCell(id, [64, 96]);
    assert.ok(c.w > 0 && c.h > 0 && c.edge.length === 2, `${id} cell`);
  }
  // rig clips: baton extend / collapse, stun arc, vibro fold, shield deploy
  for (const [id, clips] of [['baton', ['extend', 'collapse']], ['stun_baton', ['arc_on', 'arc_off', 'arc_loop']], ['vibro_blade', ['unfold', 'fold', 'hum']], ['riot_shield', ['deploy', 'fold']]]) {
    const info = JSON.stringify(e.run('model_info', { name: id, full: true }));
    for (const c of clips) assert.match(info, new RegExp(`"${c}"`), `${id} clip ${c}`);
  }
  // the sockets come back per rendered frame
  const r = e.run('model_render', { name: 'machete', canvas: 'm', camera: { yaw: 0, pitch: 0 }, zoom: 0.5, size: [64, 64], angles: [{ yaw: -90, pitch: 0 }] });
  const a = e.docs.get(r.canvas).meta.anchors[r.animation][0];
  assert.ok(a.socket_grip && a.socket_tip && a.socket_edge_a && a.socket_edge_b);
  assert.ok(a.socket_tip[0] > a.socket_grip[0] + 10, 'side view (yaw -90): the blade points right');
});

test('melee: clip sets per weapon, gun skeletons get butt-stroke / pistol whip, shield adds bash + knockdown', () => {
  const e = new Engine({ home: tmp() });
  const kn = setup(e, { name: 'kn', weapon: 'combat_knife' });
  assert.equal(kn.set, 'knife');
  for (const c of ['knife_slash', 'knife_stab', 'knife_combo', 'kick', 'shove', 'block', 'parry', 'hit_front', 'hit_back', 'hit_left', 'hit_right', 'stagger_front', 'stagger_back', 'stagger_left', 'stagger_right', 'knockdown', 'get_up', 'takedown_rear_attacker', 'takedown_rear_victim', 'disarm_front_attacker', 'disarm_front_victim']) assert.ok(kn.clips.includes(c), c);
  assert.equal(setup(e, { name: 'ax', weapon: 'breach_axe' }).set, 'heavy');
  const sb = setup(e, { name: 'sb', weapon: 'stun_baton', shield: true });
  assert.equal(sb.set, 'baton');
  for (const c of ['baton_strike', 'shield_bash', 'shield_up', 'shield_knockdown_attacker', 'shield_knockdown_victim']) assert.ok(sb.clips.includes(c), c);
  assert.deepEqual(sb.paired, ['takedown_rear', 'disarm_front', 'shield_knockdown']);
  const sk = lib(e, 'skeletons', 'sb.json');
  assert.equal(sk.def.parts.shield.parent, 'forearm_b');
  assert.ok(sk.masks.upper.includes('shield'));
  const rf = setup(e, { name: 'rf', gun: 'rifle' });
  assert.equal(rf.set, 'rifle');
  assert.ok(rf.clips.includes('butt_stroke') && !rf.clips.includes('disarm_front_attacker'));
  assert.ok(setup(e, { name: 'pi', gun: 'pistol' }).clips.includes('pistol_whip'));
  assert.throws(() => e.run('anim_melee', { skeleton: 'kn', weapon: 'riot_shield' }), /shield:true/);
  assert.throws(() => e.run('anim_melee', { skeleton: 'kn', weapon: 'lightsaber' }), /melee weapons are/);
  assert.throws(() => e.run('anim_melee', { skeleton: 'rf', weapon: 'machete' }), /gun skeleton/);
});

test('melee events: per-hit order windup < active_start <= impact <= active_end < recovery, sorted, phases agree', () => {
  const e = new Engine({ home: tmp() });
  setup(e, { name: 'kn', weapon: 'combat_knife' });
  e.run('anim_skin', { name: 'k1', skeleton: 'kn' });
  paint(e, 'k1');
  const out = path.join(tmp(), 'out');
  e.run('anim_batch', { skins: ['k1'], clips: ['knife_slash', 'knife_combo', 'kick', 'block', 'parry', 'hit_front', 'takedown_rear_attacker'], views: ['side', 'back_side'], out });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  const anims = man.sprites.k1.anims;
  let attacks = 0;
  for (const [n, a] of Object.entries(anims)) {
    const m = a.melee;
    assert.ok(m, `${n} has melee`);
    assert.equal(m.phase.length, a.frames, `${n} phase per frame`);
    for (let i = 1; i < m.events.length; i++) assert.ok(m.events[i].frame >= m.events[i - 1].frame, `${n} events sorted`);
    if (m.kind !== 'attack') continue;
    attacks++;
    const wu = m.events.find((x) => x.name === 'windup').frame;
    m.windows.forEach(([f0, f1], i) => {
      const at = (name) => m.events.find((x) => x.name === name && x.hit === i).frame;
      assert.ok(wu < at('active_start'), `${n} windup before hit ${i}`);
      assert.ok(at('active_start') <= at('impact') && at('impact') <= at('active_end'), `${n} impact inside hit ${i}`);
      assert.ok(at('active_end') < at('recovery'), `${n} recovery after hit ${i}`);
      assert.deepEqual([at('active_start'), at('active_end')], [f0, f1]);
      for (let f = f0; f <= f1; f++) {
        assert.equal(m.phase[f], 'active');
        const h = m.hits.find((x) => x.frame === f);
        assert.ok(h && h.hit === i && h.volumes.length, `${n} volume on active frame ${f}`);
        for (const v of h.volumes) assert.ok(v.r > 0 && v.space && v.a.length === 2 && v.b.length === 2);
      }
    });
    assert.ok(m.hits.every((h) => m.phase[h.frame] === 'active'), `${n}: volumes only on active frames`);
  }
  assert.ok(attacks >= 3);
  // the combo has three hits with input windows, the slash a sweep polygon, the kick a sole capsule
  const combo = anims.knife_combo_side.melee;
  assert.equal(combo.windows.length, 3);
  assert.equal(combo.combo.length, 3);
  assert.ok(anims.knife_slash_side.melee.hits.some((h) => h.volumes[0].sweep?.length >= 3));
  assert.equal(anims.kick_side.melee.hits[0].volumes[0].source, 'foot_f');
  assert.deepEqual(anims.block_side.melee.block.length, 2);
  assert.ok(anims.parry_side.melee.phase.includes('parry'));
  // the held weapon socket per frame (grip px, angle, pitch, order)
  const s0 = anims.knife_slash_side.melee.socket[0];
  assert.ok(Number.isFinite(s0.x) && Number.isFinite(s0.rot) && ['behind', 'between'].includes(s0.order));
  // pure helper agrees with the manifest
  const ev = meleeEvents({ windup: [0, 0.3], active: [[0.4, 0.6]], impact: [0.5] }, 11);
  assert.deepEqual(ev.windows, [[4, 6]]);
  assert.deepEqual(ev.events.filter((x) => x.hit === 0).map((x) => [x.name, x.frame]), [['active_start', 4], ['impact', 5], ['active_end', 6], ['recovery', 7]]);
});

test('melee check: coverage + order pass on the library; broken clips are reported', () => {
  const e = new Engine({ home: tmp() });
  setup(e, { name: 'kn', weapon: 'combat_knife' });
  const ck = e.run('anim_melee_check', { skeleton: 'kn' });
  assert.equal(ck.pass, true, JSON.stringify(Object.entries(ck.clips).filter(([, v]) => !v.pass)));
  for (const n of ['knife_slash', 'knife_stab', 'knife_combo', 'kick', 'shove']) {
    assert.ok(ck.clips[n].sweep_points > 100, `${n} sampled`);
    assert.ok(ck.clips[n].sweep_miss_px <= 2, `${n} sweep covered`);
  }
  // a windup that ends after the active window, and an impact outside it
  const f = path.join(e.home, 'library', 'clips', 'kn', 'knife_stab.json');
  const clip = JSON.parse(fs.readFileSync(f, 'utf8'));
  clip.melee.windup = [0.5, 0.9];
  clip.melee.impact = [0.95];
  fs.writeFileSync(f, JSON.stringify(clip));
  const bad = e.run('anim_melee_check', { skeleton: 'kn', clips: ['knife_stab'] });
  assert.equal(bad.pass, false);
  const issues = bad.clips.knife_stab.issues.join(' | ');
  assert.match(issues, /windup/);
  assert.match(issues, /impact .* outside active/);
  // an attack with no active window
  clip.melee.active = [];
  fs.writeFileSync(f, JSON.stringify(clip));
  assert.match(e.run('anim_melee_check', { skeleton: 'kn', clips: ['knife_stab'] }).clips.knife_stab.issues.join(' '), /no active window/);
  // user-authored clips are validated on the way in
  assert.throws(() => e.run('anim_clip', { skeleton: 'kn', name: 'jab', keys: [{ pose: 'idle', t: 0 }], frames: 4, melee: { damage: 'laser' } }), /damage/);
  assert.throws(() => e.run('anim_clip', { skeleton: 'kn', name: 'jab', keys: [{ pose: 'idle', t: 0 }], frames: 4, melee: { hits: [{ part: 'tail' }] } }), /not in the rig/);
});

test('melee paired: shared alignment, feet hold, contacts meet, partners agree; a moved partner fails', () => {
  const e = new Engine({ home: tmp() });
  setup(e, { name: 'sb', weapon: 'stun_baton', shield: true });
  const ck = e.run('anim_melee_check', { skeleton: 'sb', clips: ['takedown_rear_attacker', 'disarm_front_attacker', 'shield_knockdown_attacker'] });
  assert.equal(ck.pass, true, JSON.stringify(ck.clips));
  for (const c of Object.values(ck.clips)) {
    assert.ok(c.foot_slide_px <= 2 && c.feet_relative_px <= 2 && c.foot_sink_px <= 2, JSON.stringify(c));
    assert.ok(c.contact_px <= c.contact_tolerance_px);
  }
  const att = lib(e, 'clips', 'sb', 'takedown_rear_attacker.json'), vic = lib(e, 'clips', 'sb', 'takedown_rear_victim.json');
  assert.equal(att.frames, vic.frames);
  assert.deepEqual(att.melee.paired.offset, vic.melee.paired.offset);
  assert.equal(att.melee.paired.partner, 'takedown_rear_victim');
  assert.equal(vic.melee.paired.role, 'victim');
  // manifest: both sides of the pair point at each other with mirrored offsets
  e.run('anim_skin', { name: 's1', skeleton: 'sb' });
  paint(e, 's1');
  const out = path.join(tmp(), 'out');
  e.run('anim_batch', { skins: ['s1'], clips: ['shield_knockdown_attacker', 'shield_knockdown_victim'], views: ['side'], out });
  const anims = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8')).sprites.s1.anims;
  const pa = anims.shield_knockdown_attacker_side.melee.paired, pv = anims.shield_knockdown_victim_side.melee.paired;
  assert.equal(pa.sync_frame, pv.sync_frame);
  assert.equal(pa.partner_dx, -pv.partner_dx);
  assert.equal(pa.partner_view, 'side_left');
  assert.ok(pa.release_frame > pa.sync_frame);
  assert.equal(anims.shield_knockdown_attacker_side.melee.root_end, 7);
  assert.ok(anims.shield_knockdown_victim_side.melee.events.some((x) => x.name === 'down'));
  // composite preview
  const r = e.run('anim_paired', { skin: 's1', pair: 'shield_knockdown', view: 'side' });
  assert.equal(r.frames, lib(e, 'clips', 'sb', 'shield_knockdown_attacker.json').frames);
  const doc = e.docs.get(r.canvas);
  assert.equal(doc.frames, r.frames);
  assert.ok(doc.frameData(r.sync_frame).some((v, i) => i % 4 === 3 && v), 'both actors drawn on the sync frame');
  assert.ok(decodePNG(Buffer.from(r.image)).width > 64);
  // move the victim 12 units: contacts and feet against each other no longer hold
  const f = path.join(e.home, 'library', 'clips', 'sb', 'disarm_front_attacker.json');
  const moved = JSON.parse(fs.readFileSync(f, 'utf8'));
  moved.melee.paired.offset = [moved.melee.paired.offset[0] + 12, 0];
  fs.writeFileSync(f, JSON.stringify(moved));
  const bad = e.run('anim_melee_check', { skeleton: 'sb', clips: ['disarm_front_attacker'] });
  assert.equal(bad.pass, false);
  assert.match(bad.clips.disarm_front_attacker.issues.join(' '), /contact points/);
});

test('melee on gun skeletons: butt-stroke volumes from the gun points, takedown with the gun slung', () => {
  const e = new Engine({ home: tmp() });
  setup(e, { name: 'rf', gun: 'rifle' });
  const ck = e.run('anim_melee_check', { skeleton: 'rf', clips: ['butt_stroke', 'takedown_rear_attacker'] });
  assert.equal(ck.pass, true, JSON.stringify(ck.clips));
  const clip = lib(e, 'clips', 'rf', 'butt_stroke.json');
  assert.deepEqual(clip.melee.hits, [{ part: 'weapon', points: ['grip_main', 'stock'] }]);
  assert.equal(lib(e, 'clips', 'rf', 'takedown_rear_attacker.json').keys[2].parts.carry, 'slung');
});

test('melee sheet: world sprites per view x pitch, grip on one pixel, edge / tip per cell', () => {
  const e = new Engine({ home: tmp() });
  const out = path.join(tmp(), 'out');
  const r = e.run('anim_melee_sheet', { weapons: ['machete', 'riot_shield'], out });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'melee_weapons.json'), 'utf8')).melee_world;
  for (const id of ['machete', 'riot_shield']) {
    const m = man[id];
    assert.deepEqual(m.views, ['front', 'front_side', 'side', 'back_side', 'back']);
    assert.deepEqual(m.pitch, [-45, -30, -15, 0, 15, 30, 45]);
    assert.equal(m.cells.length, 5);
    assert.ok(m.cells.every((row) => row.length === 7));
    const png = decodePNG(fs.readFileSync(path.join(out, m.file)));
    assert.deepEqual([png.width, png.height], [m.frame[0] * 7, m.frame[1] * 5]);
    assert.deepEqual(r.weapons[id].sheet, [png.width, png.height]);
    // the grip pixel (or its neighbour) is painted in every cell
    for (let row = 0; row < 5; row++) for (let col = 0; col < 7; col++) {
      let hit = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = col * m.frame[0] + m.grip[0] + dx, y = row * m.frame[1] + m.grip[1] + dy;
        if (png.data[(y * png.width + x) * 4 + 3]) hit = true;
      }
      assert.ok(hit, `${id} grip painted in cell ${row},${col}`);
    }
  }
  // side view, pitch 0: the machete points right, edge below the spine
  const side0 = man.machete.cells[2][3];
  assert.ok(side0.tip[0] > man.machete.grip[0] + 10);
  assert.ok(Math.abs(side0.angle) < 10);
  // pitch +45 points up (screen y smaller)
  assert.ok(man.machete.cells[2][6].tip[1] < man.machete.grip[1]);
});

test('melee: deterministic (same calls -> same clips, strips, manifests, sheets)', () => {
  const run = () => {
    const e = new Engine({ home: tmp() });
    setup(e, { name: 'kn', weapon: 'machete', shield: true });
    e.run('anim_skin', { name: 'k1', skeleton: 'kn' });
    paint(e, 'k1');
    const out = path.join(tmp(), 'out');
    e.run('anim_batch', { skins: ['k1'], clips: ['heavy_swing', 'shield_bash', 'takedown_rear_attacker'], views: ['side', 'front_side'], out });
    e.run('anim_melee_sheet', { weapons: ['machete'], out });
    return { lib: tree(path.join(e.home, 'library', 'clips')), out: tree(out), sk: sha(path.join(e.home, 'library', 'skeletons', 'kn.json')) };
  };
  const a = run(), b = run();
  assert.ok(Object.keys(a.out).length >= 8);
  assert.deepEqual(a, b);
});

test('melee unused: skeletons, clips, batch strips and manifests are byte-identical with or without melee in the workspace', () => {
  const run = (withMelee) => {
    const e = new Engine({ home: tmp() });
    e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [64, 96], weapon: { class: 'rifle' } });
    if (withMelee) { setup(e, { name: 'other', weapon: 'baton', shield: true }); e.run('model_create', { name: 'kb', template: 'melee_combat_knife' }); }
    e.run('anim_skin', { name: 'h1', skeleton: 'hd' });
    paint(e, 'h1');
    const out = path.join(tmp(), 'out');
    e.run('anim_batch', { skins: ['h1'], clips: ['idle', 'walk', 'aim', 'walk_aim', 'flinch'], views: ['side', 'front'], out });
    e.run('model_create', { name: 'ar', template: 'fp_rifle' });
    const glb = path.join(tmp(), 'ar.glb');
    e.run('model_export', { name: 'ar', path: glb });
    return { clips: tree(path.join(e.home, 'library', 'clips', 'hd')), sk: sha(path.join(e.home, 'library', 'skeletons', 'hd.json')), out: tree(out), glb: sha(glb) };
  };
  const plain = run(false), mixed = run(true);
  assert.deepEqual(mixed, plain);
  // no melee fields leak into non-melee anims
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_skin', { name: 'h1', skeleton: 'hd' });
  paint(e, 'h1');
  const out = path.join(tmp(), 'out');
  e.run('anim_batch', { skins: ['h1'], clips: ['idle', 'walk'], views: ['side'], out });
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'), /melee|hits|root_motion/);
});

test('melee geometry helpers: convex sweep hull, capsule distance, polygon margin', () => {
  const h = hull([[0, 0], [4, 0], [2, 1], [4, 4], [0, 4], [2, 2]]);
  assert.equal(h.length, 4);
  assert.ok(inPoly([2, 2], h) && !inPoly([5, 2], h) && inPoly([4.5, 2], h, 0.6));
  assert.equal(segDist([0, 3], [0, 0], [4, 0]), 3);
  assert.equal(segDist([6, 0], [0, 0], [4, 0]), 2);
});

test('melee: art_anim actions, art_model melee templates and the help topic over MCP', async () => {
  const e = new Engine({ home: tmp() });
  const call = (op, a) => e.run(op, a);
  await runTool('art_anim', { action: 'skeleton', name: 'kn', template: 'humanoid_hd', frame: [64, 96] }, call);
  const r = await runTool('art_anim', { action: 'melee', skeleton: 'kn', weapon: 'baton' }, call);
  assert.match(JSON.stringify(r), /baton_strike/);
  const c = await runTool('art_anim', { action: 'melee_check', skeleton: 'kn', clips: ['baton_strike'] }, call);
  assert.match(JSON.stringify(c), /"pass\\?":true/);
  const m = await runTool('art_model', { action: 'create', name: 'vb', template: 'melee_vibro_blade' }, call);
  assert.doesNotMatch(JSON.stringify(m), /error/i);
  const help = helpText({ topic: 'melee' });
  for (const s of ['hits', 'sweep', 'paired', 'root_motion', 'THREE.JS', 'ROBLOX', 'melee_world']) assert.ok(help.includes(s), s);
});
