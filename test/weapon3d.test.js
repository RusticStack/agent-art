// Weapon handling for first-person 3D rigs (art_model weapon + hold): grips with wrist
// orientation, attachments, carry states, reach, dead zone, muzzle discipline, check, baked clips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-weapon3d-'));

function kit(weapon = { attach: ['vertical_grip'] }, template = 'fp_rifle', states) {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'arms', template: 'fp_arms' });
  e.run('model_create', { name: 'gun', template, weapon: states ? { ...(weapon === true ? {} : weapon), states } : weapon });
  return e;
}
const holdOf = (e, carry, extra = {}) => e.run('model_render', { name: 'arms', canvas: `h_${carry}_${Math.random().toString(36).slice(2, 7)}`, size: [64, 48], camera: 'fp', hold: { weapon: 'gun', carry, ...extra } });

test('fp: both hands on their grips in every carry state; a vertical grip takes the support hand', () => {
  const e = kit();
  const c = e.run('model_check', { name: 'arms', hold: { weapon: 'gun' } });
  assert.equal(c.pass, true, c.summary + JSON.stringify(c.issues?.slice(0, 3)));
  assert.ok(c.worst.hand_grip <= 0.3 && c.worst.reach <= 0.99 && c.worst.penetration <= 0.5, JSON.stringify(c.worst));
  assert.deepEqual(c.carries.sort(), ['aim', 'hip', 'holster', 'ready_high', 'ready_low', 'reload', 'sprint']);
  // aim puts the optic on the screen centre
  const r = e.run('model_render', { name: 'gun', canvas: 'aim', size: [64, 48], camera: 'fp', hold: { arms: 'arms', carry: 'aim' } });
  const sight = e.get('aim').meta.anchors.rest[0].socket_sight;
  assert.ok(Math.abs(sight[0] - 31.5) < 0.6 && Math.abs(sight[1] - 23.5) < 0.6, `sight ${sight}`);
  assert.equal(r.hold.pass, true);
  // the support hand follows the attachment: on the vgrip socket, not the handguard
  const g = JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'gun.json'), 'utf8'));
  assert.ok(g.parts.some((p) => p.name === 'att_vgrip') && g.sockets.vgrip && g.weapon.attachments.vertical_grip.grip_support === 'vgrip');
  // pistol: support hand cups, low ready / compressed / aim all clean
  const p = kit(true, 'fp_pistol');
  assert.equal(p.run('model_check', { name: 'arms', hold: { weapon: 'gun' } }).pass, true);
});

test('fp: a grip out of reach moves the gun back (no stretched arm); a gun inside the chest is pushed out; muzzle discipline', () => {
  const e = kit({ attach: [] }, 'fp_rifle', { far: { base: 'hip', at: [0, 0, -16] }, into: { base: 'hip', at: [-4, -7, 7] }, level: { base: 'ready_low', rot: [8, 0, 0], at: [0, 0, 0] } });
  const far = holdOf(e, 'far');
  assert.ok(far.hold.corrections.some((c) => ['moved_back', 'support_slid'].includes(c)), `far: ${far.hold.corrections}`);
  assert.equal(far.hold.pass, true, JSON.stringify(far.hold.issues));
  const into = holdOf(e, 'into');
  assert.ok(into.hold.corrections.some((c) => /^pushed_/.test(c)), `into: ${into.hold.corrections}`);
  assert.equal(into.hold.pass, true, JSON.stringify(into.hold.issues));
  const lv = e.run('model_check', { name: 'arms', hold: { weapon: 'gun', carry: 'level' }, clips: [null] });
  assert.equal(lv.pass, false);
  assert.match(lv.issues[0].issues.join(), /muzzle not down/);
  const fx = holdOf(e, 'level', { fix: true });
  assert.ok(fx.hold.corrections.includes('muzzle_lowered') && fx.hold.pass, JSON.stringify(fx.hold));
  // holster hides the gun; hidden is not a visibility failure
  const h = e.run('model_render', { name: 'gun', canvas: 'hol', size: [32, 24], camera: 'fp', hold: { arms: 'arms', carry: 'holster' } });
  assert.equal(h.hold.states[0], 'holster');
  const px = e.get('hol').frameData(0);
  let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
  assert.equal(n, 0, 'holstered: no gun pixels');
});

test('fp: animate {hold} bakes an arms clip that holds the gun through its reload; exported as glTF', () => {
  const e = kit();
  const r = e.run('model_animate', { name: 'arms', clip: 'reload_empty', hold: { weapon: 'gun', carry: 'reload', fps: 10, bake_weapon: 'reload_empty_held' } });
  assert.equal(r.held.pass, true, JSON.stringify(r.held));
  assert.ok(r.keys >= 20 && Math.abs(r.duration - 2.8) < 1e-6);
  assert.equal(r.weapon_clip, 'gun/reload_empty_held');
  // the baked clips, played back without the solver, keep the hands on the grips (contact within 0.5 px)
  const c = e.run('model_check', { name: 'arms', hold: { weapon: 'gun', carry: 'reload', clip: 'reload_empty' }, frames: 6 });
  assert.equal(c.pass, true, c.summary);
  assert.equal(e.run('model_render', { name: 'arms', canvas: 'held_reload', size: [32, 24], camera: 'fp', frames: 3, hold: { weapon: 'gun', carry: 'reload', clip: 'reload_empty' } }).animation, 'reload_empty', 'hold.clip names the tag');
  const dir = tmp();
  const x = e.run('model_export', { name: 'arms', path: path.join(dir, 'arms.glb') });
  assert.ok(x.animations.includes('reload_empty'));
  const g = e.run('model_export', { name: 'gun', path: path.join(dir, 'gun.glb') });
  assert.ok(g.animations.includes('reload_empty_held'));
  assert.throws(() => e.run('model_animate', { name: 'gun', clip: 'x', hold: { arms: 'arms' } }), /on the arms model/);
});

test('fp templates without weapon stay as before; validation errors are clear', () => {
  const e = new Engine({ home: tmp() });
  const r = e.run('model_create', { name: 'plain', template: 'fp_rifle' });
  assert.deepEqual(r.rig.sockets.map((s) => s.name).sort(), ['socket_grip_l', 'socket_grip_r', 'socket_mag_well', 'socket_muzzle', 'socket_sight']);
  const def = JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'plain.json'), 'utf8'));
  assert.equal(def.weapon, undefined);
  e.run('model_create', { name: 'arms', template: 'fp_arms' });
  assert.throws(() => e.run('model_render', { name: 'arms', canvas: 'x', hold: { weapon: 'plain' } }), /no weapon setting/);
  assert.throws(() => e.run('model_create', { name: 'g2', template: 'fp_rifle', weapon: { attach: ['laser_cannon'] } }), /unknown attachment/);
  e.run('model_create', { name: 'g3', template: 'fp_rifle', weapon: true });
  assert.throws(() => e.run('model_render', { name: 'arms', canvas: 'y', hold: { weapon: 'g3', carry: 'flying' } }), /unknown state/);
});
