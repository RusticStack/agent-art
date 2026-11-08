// Back-view holding: the gun seen from behind is a real 3D outward yaw projected (pitch kept, one
// length, frames and sheet cells agree), the arms follow the projected 3D arm (elbow out and below
// the shoulder, regression: the #8 back aim raised the arm over the shoulder), arms holding the
// gun in front of the body are drawn under the whole trunk, the support shoulder protracts, and
// the validator catches a raised elbow and an arm drawn over the torso from behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { solvePose, poseOf, partIn } from '../src/rig.js';
import { weaponMetrics } from '../src/weapon.js';
import { getRig } from '../src/rigops.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-back-'));
const color = (k) => (k === 'weapon' ? '#303338' : k === 'mag' ? '#c8a040' : k.startsWith('att_') ? '#c040c0' : /hand/.test(k) ? '#d8a070' : k.startsWith('head') ? '#e0b090' : /_b$/.test(k) ? '#3a4a2a' : '#6a7a4a');
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
/** The #8 MEC setup: humanoid_hd 128x192, heavy proportions, rifle. */
function mec(weapon = {}) {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [128, 192], weapon: { class: 'rifle', ...weapon }, proportions: { heavy: { width: 1.15, spine: 1.04, arms: 1.03 } } });
  e.run('anim_skin', { name: 'mec', skeleton: 'hd', proportions: 'heavy' });
  paint(e, 'mec');
  return { e, rig: getRig(e, 'mec').rig };
}
const trunkZ = (rig, sv) => Math.min(...rig.weapon.spine.filter((n) => rig.parts[n]).map((n) => poseOf(rig, sv.VP, n).z ?? partIn(rig, n, 'back').z));
const zOf = (rig, sv, n) => poseOf(rig, sv.VP, n).z ?? partIn(rig, n, 'back').z;

test('regression (#8): back-view aim keeps the trigger elbow out and below the shoulder, as the 3D arm', () => {
  const { rig } = mec();
  const sv = solvePose(rig, { carry: 'aim' }, 'back');
  const R = sv.weapon, h = R.hands.main, A = R.s.arms.main;
  const S = sv.world[h.up], E = sv.world[h.fore];
  assert.ok(A.E[1] > A.S[1], '3D elbow below the shoulder');
  assert.ok(E.y > S.y + 2, `drawn elbow below the shoulder: elbow y ${E.y.toFixed(1)}, shoulder y ${S.y.toFixed(1)}`);
  // the drawn elbow is the projected 3D one (screen x = lateral in the back view)
  assert.ok(Math.abs((E.x - S.x) - (A.E[2] - A.S[2])) < 2.5 && Math.abs((E.y - S.y) - (A.E[1] - A.S[1])) < 2.5, `elbow ${[E.x - S.x, E.y - S.y].map((v) => v.toFixed(1))} vs 3D ${[A.E[2] - A.S[2], A.E[1] - A.S[1]].map((v) => v.toFixed(1))}`);
  assert.ok(R.hands.main.weight >= 0.999 && weaponMetrics(rig, sv).hand_grip.main <= 1.5, 'hand still on the grip');
  assert.deepEqual(weaponMetrics(rig, sv).elbow_raised, []);
  // the validator catches the #8 look (the elbow on the other side of the shoulder -> grip line)
  const so = solvePose(rig, { carry: 'aim', _weapon: { flip_elbow: ['main'] } }, 'back');
  assert.ok(so.world[so.weapon.hands.main.fore].y < so.world[so.weapon.hands.main.up].y, 'flipped: the arm raised over the shoulder');
  assert.deepEqual(weaponMetrics(rig, so).elbow_raised, ['main']);
});

test('back view: the gun is yawed outward in 3D (pitch kept, one length) and still visible; frames and sheet cells agree', () => {
  const { e, rig } = mec();
  const floor = 0.55;
  const aim = solvePose(rig, { carry: 'aim' }, 'back').weapon;
  assert.equal(aim.canted, 'back');
  assert.ok(Math.abs(aim.phi) < 5, `level aim stays level from behind: ${aim.phi}`);
  assert.ok(Math.abs(aim.L - floor) < 1e-6);
  const low = solvePose(rig, { carry: 'ready_low' }, 'back').weapon;
  assert.ok(low.phi > 20, `muzzle-down carry reads down from behind: ${low.phi}`);
  assert.ok(Math.abs(low.L - floor) < 1e-6);
  // every frame of the main clips passes the weapon check from behind (hands on grips, visible, order, elbows)
  for (const clip of ['aim', 'idle', 'walk_aim', 'reload']) for (const view of ['back', 'back_side']) {
    const r = e.run('anim_render', { skin: 'mec', clip, view });
    assert.equal(r.weapon.pass, true, `${clip} ${view}: ${JSON.stringify(r.weapon)}`);
  }
  // sheet cells drawn with the same rule: the composite lands the support grip within 1.5 px, back aim rot is small
  e.run('anim_weapon', { name: 'issued', from_skin: 'mec' });
  for (const clip of ['aim', 'idle', 'walk_aim']) for (const view of ['back', 'back_side']) {
    const c = e.run('anim_composite', { skin: 'mec', weapon: 'issued', clip, view, select: [0] });
    assert.ok(c.worst_support_error <= 1.5, `${clip} ${view}: ${c.worst_support_error}px`);
    if (clip === 'aim' && view === 'back') assert.ok(Math.abs(c.sockets[0].rot) < 10, `back aim socket rot ${c.sockets[0].rot}`);
  }
});

test('back view: arms holding the gun in front of the body are drawn under the whole trunk; the support shoulder protracts; the validator flags an arm drawn over the torso', () => {
  const { rig } = mec();
  for (const carry of ['aim', 'hip', 'ready_low']) {
    const sv = solvePose(rig, { carry }, 'back');
    const R = sv.weapon, t = trunkZ(rig, sv);
    // the forearm's tip piece (split at the torso's centre) and the hand go under the trunk
    for (const n of [R.hands.support.fore, R.hands.support.hand]) {
      const sp = poseOf(rig, sv.VP, n).split, z = sp ? sp.z[1] : zOf(rig, sv, n);
      assert.ok(z < t, `${carry}: ${n} z ${z} under the trunk (${t})`);
    }
    assert.deepEqual(weaponMetrics(rig, sv).layer, [], carry);
    // the support shoulder moves toward the centre line (protraction: the far side's lateral is -,
    // so inward is +z), and that shows from behind as the shoulder joint moving in
    const p = R.s.arms.support.protract;
    assert.ok(p[2] > 0.5, `${carry}: protraction ${p}`);
  }
  // without back occlusion (old order) the support forearm is drawn over the lower torso: flagged
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [128, 192], weapon: { class: 'rifle' }, depth: { back_occlusion: false } });
  e.run('anim_skin', { name: 'mec', skeleton: 'hd' });
  paint(e, 'mec');
  const r2 = getRig(e, 'mec').rig;
  const so = solvePose(r2, { carry: 'hip' }, 'back');
  assert.ok(weaponMetrics(r2, so).layer.some((x) => /over the torso from behind/.test(x)), JSON.stringify(weaponMetrics(r2, so).layer));
});
