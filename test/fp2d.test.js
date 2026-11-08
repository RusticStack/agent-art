// Hand-drawn first person (fp2d): key drawings -> the fp v2 sweep contract (palette-exact,
// deterministic warp; anchors exact at the keys and continuous between cells), anchor tools,
// 2D arms skins driven by the same clips, mixed 2D / 3D sources through the unchanged check, and
// #16's 3D outputs untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { steps, MAX_SHEET, PX_PER_M } from '../src/fp.js';
import { unpackSheets, anchorJumps, jumpBound } from '../src/fpsweep.js';
import { bakeClip, sweepOf, classGrid, magGrid, MAG_VISIBLE_MIN } from '../src/fpops.js';
import { KIT_BUILDS } from '../src/fpkit.js';
import { sources2d, sweep2d, colorSet, suggestAnchors, anchorsOffArt, artOf, GUIDES, MASKS } from '../src/fp2d.js';
import { skin2dOf, handPose, POSE_OF, HAND_POSES } from '../src/fp2darms.js';
import { decodePNG } from '../src/png.js';
import { drawDemoSet } from '../scripts/fp2d-art.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp2d-'));
const engine = () => new Engine({ home: tmp() });
const hash = (...bufs) => { const c = crypto.createHash('sha256'); for (const b of bufs) c.update(typeof b === 'string' ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength)); return c.digest('hex').slice(0, 16); };
const KEY_VIEWS = [{ yaw: 40, pitch: 20 }, { yaw: 0, pitch: 20 }, { yaw: 60, pitch: -10 }];
const cellAt = (def, yaw, pitch) => Math.round((pitch - def.pitch[0]) / def.pitch[2]) * steps(def.yaw) + Math.round((yaw - def.yaw[0]) / def.yaw[2]);

test('fp2d: the warp keeps the source palette exactly, keeps hard alpha, and is deterministic', () => {
  const runs = [0, 1].map(() => {
    const e = engine();
    drawDemoSet(e, { arms: false });
    const src = sources2d(e).get('vandal');
    return sweep2d(src, classGrid('smg'));
  });
  const [a, b] = runs;
  assert.equal(a.cells.length, steps(a.def.yaw) * steps(a.def.pitch));
  assert.equal(hash(...a.cells, JSON.stringify(a.def)), hash(...b.cells, JSON.stringify(b.def)), 'same drawings -> same bytes');
  const used = colorSet(...a.cells);
  for (const c of used) assert.ok(a.palette.has(c), `colour #${c.toString(16)} is not in the drawings`);
  for (const cell of a.cells) for (let i = 3; i < cell.length; i += 4) assert.ok(cell[i] === 0 || cell[i] === 255, 'no blended alpha');
  assert.ok(a.def.cell[0] <= MAX_SHEET && a.def.cell[1] <= MAX_SHEET);
  assert.ok(used.size >= 8, 'the drawing keeps its ramps');
});

test('fp2d: drawn anchors are exact at the key angles and continuous between neighbouring cells', () => {
  const e = engine();
  const made = drawDemoSet(e, { arms: false, views: KEY_VIEWS });
  // one key's muzzle and support drawn off the class geometry by a few px: still exact on that key
  const d = e.get(made.gun[0]), m = d.meta.fp2d;
  e.run('fp_anchors', { canvas: d.name, set: { muzzle: [m.anchors.muzzle[0] + 3, m.anchors.muzzle[1] - 2], support: [m.anchors.support[0] - 2, m.anchors.support[1] + 1] } });
  const src = sources2d(e).get('vandal');
  const sw = sweep2d(src, classGrid('smg'));
  const def = sw.def;
  for (const [i, v] of KEY_VIEWS.entries()) {
    const k = e.get(made.gun[i]).meta.fp2d.anchors, c = cellAt(def, v.yaw, v.pitch), g = def.anchors.grip[c];
    for (const [n, at] of Object.entries(k)) {
      const want = [at[0] - k.grip[0], at[1] - k.grip[1]], got = [def.anchors[n][c][0] - g[0], def.anchors[n][c][1] - g[1]];
      assert.ok(Math.hypot(want[0] - got[0], want[1] - got[1]) <= 0.05, `${n} at key ${made.gun[i]}: drawn ${want}, swept ${got}`);
    }
  }
  // continuity: neighbouring cells move like the 3D sweep's anchors do (bounded by the socket radius)
  const s3 = sweepOf(null, 'smg', 'gun', classGrid('smg')), j2 = anchorJumps(def), j3 = anchorJumps(s3.def);
  for (const n of ['support', 'mag_well', 'muzzle', 'sight']) {
    const X = sw.fit.sockets[n];
    assert.ok(j2[n] <= jumpBound(def, Math.hypot(...X)), `${n} jump ${j2[n]} px over the bound`);
    assert.ok(j2[n] <= j3[n] * 1.25 + 4, `${n} jump ${j2[n]} px vs ${j3[n]} px in 3D`);
  }
});

test('fp2d: anchor tools suggest from the silhouette and warn off-art / inconsistent anchors', () => {
  const e = engine();
  const made = drawDemoSet(e, { arms: false });
  const name = made.gun[0], d = e.get(name), m = d.meta.fp2d;
  const s = suggestAnchors(artOf(d), m);
  for (const n of ['grip', 'muzzle']) {
    assert.ok(s[n], `suggests ${n}`);
    assert.ok(s[n].confidence > 0 && s[n].confidence <= 1);
    assert.ok(Math.hypot(s[n].at[0] - m.anchors[n][0], s[n].at[1] - m.anchors[n][1]) < 14, `${n} suggestion near the drawn one`);
  }
  assert.equal(e.run('fp_anchors', { canvas: name }).ok, true);
  // off the opaque pixels
  assert.deepEqual(anchorsOffArt(artOf(d), { sight: [1, 1] }).map((w) => w.anchor), ['sight']);
  const r = e.run('fp_anchors', { canvas: name, set: { muzzle: [m.anchors.muzzle[0] - 25, m.anchors.muzzle[1] - 30] } });
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some((w) => /off|opaque|outside/i.test(JSON.stringify(w))), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /other drawings/.test(w.issue)), 'inconsistent with the other keys');
  // accept moves only confident suggestions onto empty anchors
  e.run('fp_anchors', { canvas: name, remove: ['muzzle'] });
  const acc = e.run('fp_anchors', { canvas: name, accept: 0.3 });
  assert.ok(acc.anchors.muzzle, 'muzzle re-placed from the suggestion');
});

test('fp2d: a 2D-only build (drawn SMG and rifle, magazines and arms) passes fp check with the #16 tolerances', () => {
  const e = engine(), out = tmp();
  drawDemoSet(e, { rifle: true });
  const s = e.run('fp_sweep2d', { out });
  assert.equal(s.sweeps.vandal.palette_ok, true);
  assert.equal(s.sweeps.vandal_mag.palette_ok, true);
  assert.equal(s.sweeps.warden.palette_ok, true);
  const b = e.run('fp_batch', { out, skins: ['ink'], classes: ['smg', 'rifle'], guns: { smg: 'vandal', rifle: 'warden' }, clips: ['idle', 'ads_idle', 'reload_empty'], variants: false });
  assert.ok(b.frames > 60);
  const ck = e.run('fp_check', { out, classes: ['smg', 'rifle'] });
  assert.equal(ck.worst.finger_out_px, 0);
  assert.ok(ck.worst.mag_visible_min >= 0.5, `magazine ${ck.worst.mag_visible_min} visible`);
  assert.equal(ck.pass, true, JSON.stringify(ck.issues));
  assert.ok(ck.worst.hand_px <= 1, `hands ${ck.worst.hand_px} px`);
  assert.ok(ck.worst.ads_px <= 1, `ADS sight ${ck.worst.ads_px} px`);
  assert.ok(ck.worst.mag_handoff_px <= 1, `mag hand-off ${ck.worst.mag_handoff_px} px`);
  assert.ok(ck.hand_checks > 0 && ck.mag_handoffs > 0 && ck.ads_frames > 0, JSON.stringify(ck));
  // the frames come from the exported files through the runtime compositor
  const c = e.run('fp_composite', { out, class: 'smg', clip: 'ads_idle', frame: 0, gun: 'vandal', zoom: 1 });
  assert.ok(c.sight);
});

test('fp2d: manifests have #16 format (same keys as the 3D export, plus the 2D extras)', () => {
  const e = engine(), o2 = tmp(), o3 = tmp();
  drawDemoSet(e, { arms: false });
  e.run('fp_sweep2d', { out: o2 });
  e.run('fp_sweep', { out: o3, guns: ['smg'], mags: ['smg_mag'], attachments: [], items: [], states: false });
  const read = (root, n) => JSON.parse(fs.readFileSync(path.join(root, 'manifest', `${n}.json`), 'utf8'));
  const extras = ['source', 'source2d', 'sockets3d', 'check2d'];
  for (const [group, n2, n3] of [['fp_guns', 'vandal', 'smg'], ['fp_mags', 'vandal_mag', 'smg_mag']]) {
    const m2 = read(o2, group).sweeps[n2], m3 = read(o3, group).sweeps[n3];
    // every #16 key is there; anything else is an optional contract field (class / mag / slot) or a 2D extra
    for (const k of Object.keys(m3)) assert.ok(k in m2, `${group} ${k}`);
    for (const k of Object.keys(m2)) assert.ok(k in m3 || extras.includes(k) || ['class', 'mag', 'slot'].includes(k), `${group} unexpected ${k}`);
    assert.equal(m2.source, '2d');
    assert.equal(m2.px_per_m, PX_PER_M);
    assert.deepEqual([m2.yaw, m2.pitch], [m3.yaw, m3.pitch], 'same grid as the kit');
    assert.ok(m2.cell.every((v) => Number.isInteger(v) && v % 2 === 0));
    const n = steps(m2.yaw) * steps(m2.pitch);
    for (const k of Object.keys(m3.anchors)) assert.ok(m2.anchors[k], `${group} anchor ${k}`);
    for (const [k, list] of Object.entries(m2.anchors)) { assert.equal(list.length, n, k); assert.ok(list.every((p) => p.length === 2 && p.every(Number.isFinite)), k); }
    const sheets = m2.sheets.map((s) => decodePNG(fs.readFileSync(path.join(o2, s))));
    assert.ok(sheets.every((s) => s.width <= MAX_SHEET && s.height <= MAX_SHEET));
    assert.equal(unpackSheets(m2, sheets).length, n);
  }
  assert.equal(read(o2, 'fp_guns').sweeps.vandal.mag, 'vandal_mag');
  assert.equal(read(o2, 'fp_guns').sweeps.vandal.class, 'smg');
});

test('fp2d: painted cells come back as overrides and survive the next sweep2d', () => {
  const e = engine(), out = tmp();
  drawDemoSet(e, { arms: false });
  e.run('fp_sweep2d', { out });
  const ex = e.run('fp_paint', { out, sweep: 'vandal' });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp_guns.json'), 'utf8')).sweeps.vandal;
  const c = cellAt(man, 40, 20), cols = Math.floor(e.get(ex.canvases[0]).width / man.cell[0]), per = cols * Math.floor(e.get(ex.canvases[0]).height / man.cell[1]);
  const sheet = ex.canvases[Math.floor(c / per)], k = c % per, [cx, cy] = [(k % cols) * man.cell[0], Math.floor(k / cols) * man.cell[1]];
  const g = man.anchors.grip[c];
  e.run('draw', { canvas: sheet, commands: [{ op: 'rect', x: cx + Math.round(g[0]) - 2, y: cy + Math.round(g[1]) - 2, w: 5, h: 5, color: '#ff00ff', fill: true }] });
  const im = e.run('fp_paint', { out, sweep: 'vandal', action: 'import' });
  assert.equal(im.overrides?.length, 1, JSON.stringify(im.overrides));
  const s2 = e.run('fp_sweep2d', { out });
  assert.equal(s2.sweeps.vandal.overrides, 1);
  const m2 = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp_guns.json'), 'utf8')).sweeps.vandal;
  const cells = unpackSheets(m2, m2.sheets.map((s) => decodePNG(fs.readFileSync(path.join(out, s)))));
  const g2 = m2.anchors.grip[c], i = (Math.round(g2[1]) * m2.cell[0] + Math.round(g2[0])) * 4;
  assert.deepEqual([...cells[c].subarray(i, i + 4)], [255, 0, 255, 255], 'the painted pixel is kept at the grip');
  assert.equal(s2.sweeps.vandal.palette_ok, true, 'override colours join the palette');
});

test('fp2d arms: the same clips drive the drawn skin; poses per frame; colours only from the drawings', () => {
  const e = engine();
  drawDemoSet(e, { views: ['hip'] });
  const sk = skin2dOf(e, 'ink');
  assert.ok(sk.parts.upper.length && sk.parts.fore.length && sk.parts.hand.length);
  const skinColors = colorSet(...[...e.docs.values()].filter((d) => d.meta?.fp2d?.skin === 'ink').map((d) => d.composite({ exclude: [GUIDES] })));
  const b = bakeClip('smg', 'reload_empty', { skin: 'ink', engine: e });
  for (const c of colorSet(b.back.data, b.front.data)) assert.ok(skinColors.has(c), `arm colour #${c.toString(16)} not drawn`);
  const poses = { R: new Set(), L: new Set() };
  for (const L of b.locks) for (const s of ['R', 'L']) if (L[s]?.pose) poses[s].add(L[s].pose);
  assert.ok(poses.R.has('trigger'), [...poses.R].join());
  assert.ok(poses.L.has('mag_pinch'), `left hand pinches the magazine: ${[...poses.L].join()}`);
  assert.ok([...poses.L, ...poses.R].every((p) => HAND_POSES.includes(p)));
  assert.ok(b.metrics.worst_hand_miss_px <= 1);
  // thumb on the release only on release events
  assert.equal(handPose({ hands: { R: { pose: 'trigger' } }, events: ['mag_release'] }, 'R'), 'thumb_release');
  assert.equal(handPose({ hands: { R: { pose: 'trigger' } }, events: [] }, 'R'), 'trigger');
  assert.equal(handPose({ hands: { L: { pose: 'mag_grasp' } } }, 'L'), POSE_OF.mag_grasp);
  // determinism
  assert.equal(hash(b.back.data, b.front.data), hash(...(() => { const c = bakeClip('smg', 'reload_empty', { skin: 'ink', engine: e }); return [c.back.data, c.front.data]; })()));
});

test('fp2d: mixed sources (2D gun + 3D arms, 3D gun + 2D arms) pass the unchanged check', () => {
  const e = engine();
  drawDemoSet(e);
  for (const [o, gun] of [[{ skins: ['mec'], guns: { smg: 'vandal' } }, 'vandal'], [{ skins: ['ink'] }, 'smg']]) {
    const out = tmp();
    e.run('fp_sweep2d', { out });
    e.run('fp_sweep', { out, guns: ['smg'], mags: ['smg_mag'], attachments: [], items: [], states: false });
    e.run('fp_batch', { out, classes: ['smg'], clips: ['idle', 'ads_idle', 'reload_empty'], variants: false, ...o });
    const ck = e.run('fp_check', { out, classes: ['smg'] });
    assert.equal(ck.pass, true, `${gun}: ${JSON.stringify(ck.issues)}`);
    assert.ok(ck.worst.hand_px <= 1 && ck.worst.ads_px <= 1 && ck.worst.mag_handoff_px <= 1, JSON.stringify(ck.worst));
  }
});

test('fp2d contact: no finger pixels over the gun outside its zones; the trigger finger in the guard; the magazine stays visible', () => {
  const e = engine();
  drawDemoSet(e);
  let held = 0, clipped = 0, pinch = 0;
  for (const clip of ['idle', 'ads_idle', 'reload_empty', 'fire']) {
    const b = bakeClip('smg', clip, { skin: 'ink', engine: e, gun: 'vandal' });
    b.locks.forEach((L, f) => {
      for (const sd of ['R', 'L']) {
        if (L[sd]) assert.ok(L[sd].miss <= 1, `${clip} ${f} ${sd}: hand ${L[sd].miss} px (nudges stay in the tolerance)`);
        const c = L.contact?.[sd];
        if (L[sd]) assert.ok(c, `${clip} ${f} ${sd}: contact report on a lock`);
        if (!c) continue;
        held++;
        assert.equal(c.out, 0, `${clip} ${f} ${sd}: finger px outside the zones`);
        clipped += c.clipped;
      }
      if (L.mag_visible != null) { pinch++; assert.ok(L.mag_visible >= MAG_VISIBLE_MIN, `${clip} ${f}: magazine ${L.mag_visible} visible`); }
    });
    if (clip === 'fire') {
      // every fire frame: the trigger finger is drawn and shows inside the guard opening
      b.locks.forEach((L, f) => { const c = L.contact?.R; assert.ok(c?.trigger > 0, `fire ${f}: trigger finger drawn`); assert.ok(c.trigger_guard > 0, `fire ${f}: trigger finger in the guard opening`); });
    }
  }
  assert.ok(held > 40 && pinch > 0, `${held} held hands, ${pinch} pinch frames`);
  assert.ok(clipped > 0, 'the zones did clip something (the check is live)');
});

test('fp2d contact: painted masks replace the automatic zones and travel with the sweep', () => {
  const e = engine();
  const made = drawDemoSet(e, { arms: false, views: KEY_VIEWS });
  // no painted grip zone on any key: automatic
  for (const n of made.gun) e.run('draw', { canvas: n, layer: 'mask_grip', commands: [{ op: 'clear' }] });
  const auto = sweep2d(sources2d(e).get('vandal'), classGrid('smg'));
  const def = auto.def, c = cellAt(def, 40, 20);
  const d = e.get(made.gun[0]), g = d.meta.fp2d.anchors.grip;
  // a 5x5 grip zone painted at the drawn grip anchor
  e.run('draw', { canvas: d.name, layer: 'mask_grip', commands: [{ op: 'rect', x: Math.round(g[0]) - 2, y: Math.round(g[1]) - 2, w: 5, h: 5, color: '#ffffff' }] });
  const sw = sweep2d(sources2d(e).get('vandal'), classGrid('smg'));
  const z = sw.zones[c], [cw] = sw.def.cell, ga = sw.def.anchors.grip[c];
  const n = [...z].filter((v) => v & MASKS.grip).length;
  assert.ok(n > 0 && n < [...auto.zones[c]].filter((v) => v & MASKS.grip).length, `painted grip zone ${n} px (smaller than the auto one)`);
  assert.ok(z[Math.floor(ga[1]) * cw + Math.floor(ga[0])] & MASKS.grip, 'the painted zone sits on the grip anchor at the key angle');
  // the guard opening stays automatic (not painted) and is see-through
  assert.ok([...z].some((v, i) => v & MASKS.guard && !sw.cells[c][i * 4 + 3]), 'auto guard opening');
});

test('fp2d: the all-2D pipeline builds no kit 3D model (sweep2d, batch, check, composite)', () => {
  const e = engine(), out = tmp();
  drawDemoSet(e);
  for (const k of Object.keys(KIT_BUILDS)) KIT_BUILDS[k] = 0;
  e.run('fp_sweep2d', { out });
  e.run('fp_batch', { out, skins: ['ink'], classes: ['smg'], guns: { smg: 'vandal' }, clips: ['idle', 'reload_empty'], variants: false });
  const ck = e.run('fp_check', { out, classes: ['smg'] });
  e.run('fp_composite', { out, class: 'smg', clip: 'idle', frame: 0, gun: 'vandal' });
  assert.deepEqual(KIT_BUILDS, { gun: 0, mag: 0, attachment: 0, item: 0 });
  assert.ok(ck.contact_checks > 0 && ck.worst.finger_out_px === 0, JSON.stringify(ck.worst));
});

test('fp2d: #16 3D outputs are byte-identical', () => {
  const b = bakeClip('smg', 'reload_empty', { variant: 'vgrip' });
  assert.equal(hash(b.back.data, b.front.data, JSON.stringify(b.anim), JSON.stringify(b.locks)), '4574e39f15a10c9d');
  const k = bakeClip('knife', 'slash', { skin: 'severance' });
  assert.equal(hash(k.back.data, k.front.data, JSON.stringify(k.anim)), 'ee083e12a90cd584');
  const s = sweepOf(null, 'smg', 'gun', classGrid('smg'));
  assert.equal(hash(...s.cells, ...s.depths, JSON.stringify(s.def)), '1fd1c6b1d4b6d757');
  const m = sweepOf(null, 'smg_mag', 'mag', magGrid('smg_mag'));
  assert.equal(hash(...m.cells, JSON.stringify(m.def)), '741fe40d49efd1bc');
});
