// Runtime weapon layers (game contract: gun-free character strips + per-frame weapon sockets +
// weapons_world sheets): handling class geometry, standalone weapon assets + conform, world sheets
// (<= 1024 px, attachment overlays, manifest), socket mirroring, padding kept, engine-identical
// composite, and the hands-on-grips check across every gun of a class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { normalizeRig } from '../src/rig.js';
import { decodePNG } from '../src/png.js';
import { classGeometry, handlingOf, weaponAssetDef, conformAsset, DEFAULT_PITCH } from '../src/weaponassets.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-wsock-'));
const GUN = '#303338';
const color = (k) => (k === 'weapon' ? GUN : k === 'mag' ? '#c8a040' : k.startsWith('att_') ? '#c040c0' : /hand/.test(k) ? '#d8a070' : k.startsWith('head') ? '#e0b090' : '#6a7a4a');
function paint(e, name) {
  const cells = e.run('rig_info', { name }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) {
    const k = k0.split(':')[0];
    if ((['weapon', 'mag'].includes(k) || k.startsWith('att_')) && v !== 'side') continue;
    if (k === 'cape' || k.startsWith('gear')) continue;
    cmds.push({ op: 'rect', x, y, w, h, color: color(k) });
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
}
const count = (data, hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] === c[0] && data[i + 1] === c[1] && data[i + 2] === c[2]) n++; return n; };
function setup() {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [64, 96], weapon: { class: 'rifle' } });
  e.run('anim_skin', { name: 'mec', skeleton: 'hd' });
  paint(e, 'mec');
  return e;
}

test('shared handling module: class table, grip geometry in body units, conform in any units (2D or 3D)', async () => {
  const H = await import('../src/handling.js');
  for (const c of ['pistol', 'smg', 'rifle', 'dmr', 'shotgun', 'lmg', 'sniper', 'launcher', 'knife', 'grenade', 'med', 'tablet', 'unarmed', 'none']) assert.ok(H.HANDLING_CLASSES[c], c);
  assert.equal(H.classOf('carbine'), 'rifle');
  assert.equal(H.classOf('dmr'), 'dmr');
  assert.equal(H.thirdPersonClass('shotgun'), 'rifle');
  assert.equal(H.thirdPersonClass('knife'), 'none');
  const R = H.gripGeometry('rifle'), D = H.gripGeometry('dmr');
  assert.deepEqual([D.support, D.stock], [R.support, R.stock], 'dmr keeps the rifle grips');
  assert.ok(D.muzzle[0] > R.muzzle[0], 'longer barrel');
  assert.equal(H.gripGeometry('knife'), null);
  assert.ok(H.CARRY.long.aim && H.CARRY.pistol.aim);
  // a 3D first-person gun in metres: 1 body unit = 1.8 m / 98
  const u = 1.8 / 98, g = [0.1, 0.05, 0];
  const pts = { grip_main: g, grip_support: [g[0] + R.support[0] * u, g[1] + R.support[1] * u, 0], stock: [g[0] + R.stock[0] * u, g[1] + R.stock[1] * u, 0] };
  assert.equal(H.conform('rifle', pts, { unit: { u } }).pass, true);
  const off = { ...pts, grip_support: [pts.grip_support[0] + 0.1, pts.grip_support[1], 0] };
  const r = H.conform('dmr', off, { unit: { u }, fix: true });
  assert.equal(r.pass, false);
  assert.equal(H.conform('dmr', r.fixed.points, { unit: { u } }).pass, true);
  assert.equal(H.conform('knife', {}).pass, true);
});

test('handling classes: members map to the class, geometry scales with the frame, every gun of a class conforms', () => {
  assert.equal(handlingOf('dmr'), 'rifle');
  assert.equal(handlingOf('revolver'), 'pistol');
  assert.throws(() => handlingOf('trebuchet'), /handling classes/);
  const a = classGeometry('rifle', [64, 96]), b = classGeometry('rifle', [128, 192]);
  assert.ok(a.support[0] > 0 && a.stock[0] < 0, 'support ahead of the trigger hand, stock behind');
  assert.ok(Math.abs(b.support[0] / a.support[0] - 2) < 0.15, `scales with the frame: ${a.support} / ${b.support}`);
  assert.equal(classGeometry('none', [64, 96]), null);
  // longer or shorter members of the class keep the class grips (only the barrel length changes)
  for (const cls of ['rifle', 'carbine', 'dmr', 'shotgun', 'energy']) {
    const { rig, asset } = weaponAssetDef('x', cls, [128, 192]);
    const r = conformAsset(asset, normalizeRig(rig));
    assert.equal(r.pass, true, `${cls}: ${JSON.stringify(r.checks)}`);
  }
});

test('batch weapon:"runtime": gun-free body + __front strips, sockets per frame, pad/frame/anchor as the baked export, mirrored sockets', () => {
  const e = setup();
  const out = tmp(), baked = tmp();
  e.run('anim_batch', { skins: ['mec'], clips: ['aim', 'walk_aim'], views: 'all', out, weapon: 'runtime' });
  e.run('anim_batch', { skins: ['mec'], clips: ['aim', 'walk_aim'], views: 'all', out: baked });
  const A = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8')).sprites.mec;
  const B = JSON.parse(fs.readFileSync(path.join(baked, 'manifest', 'characters.json'), 'utf8')).sprites.mec;
  assert.deepEqual([A.frame, A.anchor, A.pad], [B.frame, B.anchor, B.pad], 'the gun-free export keeps the auto padding (the engine reads frame / anchor per set)');
  assert.equal(A.class, 'rifle');
  assert.equal(A.weapon, 'runtime');
  const X = A.anims.walk_aim_side;
  assert.equal(X.class, 'rifle');
  assert.equal(X.weapon.length, X.frames);
  for (const s of X.weapon) {
    assert.ok(['between', 'behind', 'front'].includes(s.order));
    for (const k of ['x', 'y', 'rot', 'pitch']) assert.equal(typeof s[k], 'number');
    assert.ok(s.x >= 0 && s.x < A.frame[0] && s.y >= 0 && s.y < A.frame[1], `socket in the frame: ${s.x},${s.y}`);
  }
  assert.ok(A.anims.aim_back.weapon[0].order === 'behind', 'back view: the gun is under the torso');
  // the body strip has no gun pixels, the baked one has
  const body = decodePNG(fs.readFileSync(path.join(out, X.file))).data, full = decodePNG(fs.readFileSync(path.join(baked, B.anims.walk_aim_side.file))).data;
  assert.equal(count(body, GUN), 0);
  assert.ok(count(full, GUN) > 100);
  assert.ok(X.front && fs.existsSync(path.join(out, X.front)), '__front strip');
  // mirrored views: x mirrored about the anchor column, rot negated, the rest unchanged
  for (const [m, s] of [['side_left', 'side'], ['front_side_left', 'front_side'], ['back_side_left', 'back_side']]) {
    A.anims[`walk_aim_${s}`].weapon.forEach((p, i) => {
      const q = A.anims[`walk_aim_${m}`].weapon[i];
      assert.ok(Math.abs(p.x + q.x - (2 * A.anchor[0] - 1)) <= 0.11, `${m}[${i}] x ${p.x} / ${q.x}`);
      assert.ok(Math.abs(p.rot + q.rot) <= 0.11 && p.y === q.y && p.pitch === q.pitch && p.order === q.order, `${m}[${i}]`);
    });
  }
  // reload: the magazine is out (mag:false) on some frames, the gun never hidden
  e.run('anim_batch', { skins: ['mec'], clips: ['reload'], views: ['side'], out, weapon: 'runtime' });
  const RL = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8')).sprites.mec.anims.reload_side.weapon;
  assert.ok(RL.some((s) => s.mag === false) && RL.every((s) => !s.hidden));
  assert.ok(Math.max(...RL.map((s) => s.pitch)) > 15, 'reload raises the muzzle');
});

test('weapon assets: conform against the class geometry (fix), world sheet <= 1024 px with overlays + manifest', () => {
  const e = setup();
  const w = e.run('anim_weapon', { name: 'ar', class: 'dmr', skin: 'mec', attachments: { scope: 'optic' } });
  assert.equal(w.handling, 'rifle');
  assert.equal(w.conform.pass, true);
  assert.ok(w.cells.weapon && w.cells.att_scope && w.cells.mag);
  paint(e, w.rig);
  // a gun off the class grips fails conform; fix moves the points back
  e.run('anim_weapon', { name: 'bad', class: 'carbine', skin: 'mec' });
  e.run('anim_weapon', { name: 'bad', points: { grip_support: [w.points.grip_support[0] + 9, w.points.grip_support[1]] } });
  const c = e.run('anim_conform', { weapon: 'bad' });
  assert.equal(c.pass, false);
  assert.match(c.summary, /off the rifle class geometry/);
  assert.equal(e.run('anim_conform', { weapon: 'bad', fix: true }).fixed !== undefined, true);
  assert.equal(e.run('anim_conform', { weapon: 'bad' }).pass, true);
  assert.throws(() => e.run('anim_weapon', { name: 'x', class: 'rifle' }), /frame/);
  // sheet: rows = 5 views, columns = pitch, grip per cell, overlay per attachment, <= 1024
  const out = tmp();
  const s = e.run('anim_weapon_sheet', { weapon: 'ar', out });
  assert.deepEqual(s.pitch, DEFAULT_PITCH);
  const png = decodePNG(fs.readFileSync(s.file));
  assert.deepEqual([png.width, png.height], [s.frame[0] * 7, s.frame[1] * 5]);
  assert.ok(png.width <= 1024 && png.height <= 1024);
  assert.ok(count(png.data, GUN) > 0);
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'weapons_world.json'), 'utf8')).weapons_world.ar;
  assert.equal(man.class, 'rifle');
  assert.deepEqual(man.views, ['front', 'front_side', 'side', 'back_side', 'back']);
  assert.equal(man.file, 'weapons_world/ar.png');
  assert.equal(man.grip.length, 35);
  assert.equal(man.muzzle.length, 35);
  // the side, level cell: muzzle ahead of the grip, about level
  const side0 = 2 * 7 + 3;
  assert.ok(man.muzzle[side0][0] > man.grip[side0][0] + 10 && Math.abs(man.muzzle[side0][1] - man.grip[side0][1]) < 6, JSON.stringify([man.grip[side0], man.muzzle[side0]]));
  // an overlay sheet per attachment, same grid; the base sheet has no attachment pixels
  const ov = decodePNG(fs.readFileSync(path.join(out, man.attach.scope)));
  assert.deepEqual([ov.width, ov.height], [png.width, png.height]);
  assert.ok(count(ov.data, '#c040c0') > 0 && count(png.data, '#c040c0') === 0);
  // the magazine: its own overlay sheet (same grid), not in the gun cells (engine hides it on mag:false)
  assert.equal(man.mag, 'weapons_world/ar_mag.png');
  const mg = decodePNG(fs.readFileSync(path.join(out, man.mag)));
  assert.deepEqual([mg.width, mg.height], [png.width, png.height]);
  assert.ok(count(mg.data, '#c8a040') > 0 && count(png.data, '#c8a040') === 0, 'magazine only on the mag sheet');
  // a big sniper still fits in 1024 px (fewer pitch steps when needed)
  const e2 = new Engine({ home: tmp() });
  e2.run('anim_skeleton', { name: 'big', template: 'humanoid_hd', frame: [256, 384], weapon: { class: 'sniper' } });
  e2.run('anim_skin', { name: 'b', skeleton: 'big' });
  const sn = e2.run('anim_weapon', { name: 'sn', class: 'sniper', skin: 'b' });
  paint(e2, sn.rig);
  const ss = e2.run('anim_weapon_sheet', { weapon: 'sn', out: tmp() });
  assert.ok(ss.size[0] <= 1024 && ss.size[1] <= 1024, `sniper sheet ${ss.size}`);
});

test('composite = engine draw order; weapon_check: hands on the grips of every gun of the class, an off-geometry gun fails', () => {
  const e = setup();
  e.run('anim_weapon', { name: 'issued', from_skin: 'mec' });
  const ar = e.run('anim_weapon', { name: 'dmr', class: 'dmr', skin: 'mec' });
  paint(e, ar.rig);
  for (const view of ['side', 'front', 'back', 'front_side', 'back_side']) {
    const c = e.run('anim_composite', { skin: 'mec', weapon: 'issued', clip: 'walk_aim', view, select: [0, 5] });
    assert.ok(Buffer.isBuffer(c.image));
    assert.equal(c.sockets.length, 2);
    assert.ok(c.worst_support_error <= 1.5, `${view}: support grip ${c.worst_support_error}px from the baked hand`);
  }
  const ok = e.run('anim_weapon_check', { skin: 'mec', clips: ['aim', 'walk_aim', 'idle'] });
  assert.equal(ok.pass, true, JSON.stringify(ok.weapons));
  assert.ok(ok.weapons.dmr.frames_checked > 20);
  const bad = e.run('anim_weapon', { name: 'bad', class: 'carbine', skin: 'mec' });
  paint(e, bad.rig);
  e.run('anim_weapon', { name: 'bad', points: { grip_support: [ar.points.grip_support[0] + 12, ar.points.grip_support[1]] } });
  const r = e.run('anim_weapon_check', { skin: 'mec', clips: ['aim'], views: ['side', 'front'] });
  assert.equal(r.pass, false);
  assert.equal(r.weapons.bad.pass, false);
  assert.ok(r.weapons.bad.worst_support_error > r.tolerance_px);
  assert.equal(r.weapons.dmr.pass, true);
  // a gun drawn for another character size is flagged
  e.run('anim_weapon', { name: 'big', class: 'rifle', frame: [128, 192] });
  assert.equal(e.run('anim_weapon_check', { skin: 'mec', weapons: ['big'], clips: ['aim'], views: ['side'] }).weapons.big.pass, false);
});
