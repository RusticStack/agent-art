// First-person viewmodel pipeline (art_fp, fp v2 contract): arms IK onto drawn anchors, finger
// presets, sweep anchors and sheets, attachment snapping, ADS centring, socket export, runtime
// draw order, determinism and palette stability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { FRAME, CENTRE, D, composite, cellIndex, anchorOf, placeAnchor, sheetLayout, apparent, ypr, project, steps, MAX_SHEET } from '../src/fp.js';
import { gunModel, attachModel, magModel, ATTACH, GUN_CLASSES, fpGeometry } from '../src/fpkit.js';
import { buildRig, renderSweep, renderObject, packSheets, unpackSheets, anchorJumps, jumpBound } from '../src/fpsweep.js';
import { FINGERS, blendFingers, solveArm, handFrame, partSprite, renderBones } from '../src/fparms.js';
import { classClips, solveClip, STATIONS } from '../src/fpclips.js';
import { classCtx, bakeClip, classGrid, clearFpCache, sweepOf, attachGrid } from '../src/fpops.js';
import { drawRot, colorsOf, fpPalette } from '../src/fppaint.js';
import { posedWorld } from '../src/modelrig.js';
import { decodePNG } from '../src/png.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp-'));
const R = (v) => Math.round(v * 100) / 100;

test('fp: arms IK lands both palms on the drawn grip / support anchors across the sweep', () => {
  const ctx = classCtx('rifle');
  const keys = [];
  let f = 0;
  // walk the gun through the hip neighbourhood of its sweep: yaw / pitch / roll offsets
  for (const dy of [-10, 0, 10]) for (const dp of [-8, 0, 8]) keys.push({ f: f++, gun: { st: 'hip', d: [0, 0, 0], r: [dy, dp, dy / 2] }, R: { at: 'grip', grasp: 'grip' }, L: { at: 'support', grasp: 'support' }, mag: 'in' });
  // each key held for one frame (u = 0 at keys)
  const sol = solveClip({ frames: keys.length, fps: 10, keys }, ctx);
  for (const fr of sol.frames) {
    for (const side of ['R', 'L']) {
      const h = fr.hands[side];
      assert.ok(h.target2, 'hand locked to an anchor');
      const p = project(h.palm);
      assert.ok(Math.hypot(p[0] - h.target2[0], p[1] - h.target2[1]) < 0.5, `${side} palm ${p} vs ${h.target2} (frame ${fr.f})`);
      assert.equal(h.clamped, false, `${side} arm over-reaches at frame ${fr.f}`);
    }
    // the targets ARE the anchors the runtime draws (grip at the socket, support placed from the cell)
    const def = ctx.gun.def, s = fr.gun, i = cellIndex(def, s.yaw, s.pitch), g = anchorOf(def, 'grip', i);
    const sup = placeAnchor(def, i, 'support', g, s.x, s.y, s.rot);
    const pal = project(fr.hands.L.palm);
    assert.ok(Math.hypot(pal[0] - sup[0], pal[1] - sup[1]) < 14, `support palm ${pal} near the drawn support ${sup}`);
  }
});

test('fp: finger presets are complete, blend continuously, and close the hand (fist) or open it (open_palm)', () => {
  const need = ['trigger', 'support_under', 'vgrip', 'agrip', 'mag_grasp', 'pinch', 'pistol_cup', 'knife_hammer', 'grenade_hold', 'pin_pull', 'open_palm', 'fist'];
  for (const n of need) {
    const p = FINGERS[n];
    assert.ok(p && p.index.length === 2 && p.group.length === 2 && p.thumb.length === 3, n);
    for (const v of [...p.index, ...p.group, ...p.thumb]) assert.ok(v >= 0 && v <= 120, `${n}: ${v}`);
  }
  assert.deepEqual(blendFingers('fist', 'open_palm', 0), { index: FINGERS.fist.index, group: FINGERS.fist.group, thumb: FINGERS.fist.thumb });
  assert.deepEqual(blendFingers('fist', 'open_palm', 1), { index: FINGERS.open_palm.index, group: FINGERS.open_palm.group, thumb: FINGERS.open_palm.thumb });
  const tipDist = (preset) => {
    const s = solveArm('r', [10, -15, -32], handFrame([0, 0, -1], [0, 1, 0]), FINGERS[preset]);
    const d = (a) => Math.hypot(a[0] - s.palm[0], a[1] - s.palm[1], a[2] - s.palm[2]);
    return { index: d(s.tips.index), group: d(s.tips.group) };
  };
  const fist = tipDist('fist'), open = tipDist('open_palm');
  assert.ok(fist.index < open.index - 3 && fist.group < open.group - 3, JSON.stringify({ fist, open }));
  // the trigger finger stays straighter than the gripping fingers
  const trig = tipDist('trigger');
  assert.ok(trig.index > trig.group + 1, JSON.stringify(trig));
});

test('fp: sweep anchors move continuously between neighbouring cells; every anchor listed per cell', () => {
  const def = gunModel('rifle');
  const grid = classGrid('rifle');
  const sw = sweepOf(null, 'rifle', 'gun', grid);
  const n = steps(sw.def.yaw) * steps(sw.def.pitch);
  assert.equal(sw.cells.length, n);
  for (const k of ['grip', 'support', 'mag_well', 'muzzle', 'optic', 'muzzle_mount', 'underbarrel', 'sight']) assert.equal(sw.def.anchors[k]?.length, n, k);
  const jumps = anchorJumps(sw.def);
  for (const [k, j] of Object.entries(jumps)) {
    const s = def.sockets[k]?.at;
    if (!s) continue;
    const bound = jumpBound(sw.def, Math.hypot(...s));
    assert.ok(j <= bound, `${k}: neighbour jump ${j} px > ${R(bound)}`);
  }
  assert.ok(jumps.grip < 0.01, 'grip is the reference: the same pixel in every cell');
});

test('fp: sheets stay within 1024 px and split row-major; the runtime layout reads every cell back', () => {
  for (const [cell, count] of [[[228, 260], 143], [[400, 300], 40], [[64, 64], 30], [[1024, 1024], 3]]) {
    const L = sheetLayout(cell, count);
    let seen = 0;
    for (let s = 0; s < L.sheets; s++) { const [w, h] = L.size(s); assert.ok(w <= MAX_SHEET && h <= MAX_SHEET && w % cell[0] === 0 && h % cell[1] === 0); seen += (w / cell[0]) * (h / cell[1]); }
    assert.ok(seen >= count);
  }
  const sw = renderSweep(buildRig(null, magModel('rifle_mag_30')), { yaw: [-40, 40, 10], pitch: [-24, 24, 8], cell: [300, 300] });
  const { sheets, layout } = packSheets(sw);
  assert.ok(sheets.length > 1, 'a 63-cell sweep of 300 px cells splits');
  for (const s of sheets) assert.ok(s.width <= MAX_SHEET && s.height <= MAX_SHEET);
  const back = unpackSheets(sw.def, sheets);
  assert.equal(back.length, sw.cells.length);
  for (let i = 0; i < back.length; i++) assert.deepEqual(back[i], sw.cells[i], `cell ${i}`);
  assert.equal(layout.cols, 3);
});

test('fp: generic attachments snap onto every compatible gun (drawn on the anchor = assembled in 3D)', () => {
  for (const name of Object.keys(ATTACH)) {
    const adef = attachModel(name), slot = adef.fp.slot, anchor = { optic: 'optic', muzzle: 'muzzle_mount', underbarrel: 'underbarrel' }[slot];
    const arig = buildRig(null, adef);
    const classes = GUN_CLASSES.filter((c) => gunModel(c).sockets[anchor]);
    assert.ok(classes.length >= 3, `${name} fits ${classes}`);
    for (const cls of classes) {
      const gdef = gunModel(cls), at = gdef.sockets[anchor].at;
      for (const [yaw, pitch] of [[30, 20], [0, 24], [45, 8]]) {
        // runtime: the attachment cell (rendered as mounted on its host gun) with its mount on this gun's anchor
        const host = gunModel(classes.includes('rifle') ? 'rifle' : classes[0]).sockets[anchor].at;
        const a = renderObject(arig, yaw, pitch, { ref: host.map((v) => -v), names: ['mount'] });
        const g = renderObject(buildRig(null, gdef), yaw, pitch, { names: [anchor] });
        const target = g.anchors[anchor], mount = a.anchors.mount;
        // ground truth: the attachment assembled on this gun, seen with the gun's grip as reference
        const t = renderObject(arig, yaw, pitch, { ref: at.map((v) => -v) });
        const cen = (o, dx, dy) => { let sx = 0, sy = 0, n = 0; const [x0, y0, w, h] = o.rect; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (o.rgba[(y * w + x) * 4 + 3]) { sx += x0 + x + dx; sy += y0 + y + dy; n++; } return [sx / n, sy / n, n]; };
        const drawn = cen(a, target[0] - mount[0], target[1] - mount[1]), truth = cen(t, 0, 0);
        // exact on the host gun; on a gun whose anchor sits elsewhere the generic cell is off by about
        // 1.6 px per cm of difference (perspective: a different depth), the documented budget
        const off = Math.hypot(at[0] - host[0], at[1] - host[1], at[2] - host[2]);
        const tol = 1.5 + off * 1.8;
        if (cls === 'rifle') assert.ok(off < 1e-9);
        assert.ok(Math.hypot(drawn[0] - truth[0], drawn[1] - truth[1]) < tol, `${name} on ${cls} @${yaw}/${pitch}: drawn ${drawn.map(R)} vs 3D ${truth.map(R)} (tol ${R(tol)})`);
        assert.ok(Math.abs(drawn[2] - truth[2]) / truth[2] < 0.06 + off * 0.08, `${name} on ${cls}: pixel count ${drawn[2]} vs ${truth[2]}`);
      }
    }
  }
});

test('fp: ADS puts the iron sight on the frame centre (1 px); an optic moves the aim point to its own sight', () => {
  const b = bakeClip('rifle', 'ads_idle');
  const sw = b.sweeps.gun;
  for (let f = 0; f < b.anim.frames; f++) {
    const c = composite({ anim: b.anim, f, gun: sw });
    assert.ok(Math.hypot(c.sight[0] - CENTRE[0], c.sight[1] - CENTRE[1]) <= 1, `irons ${c.sight}`);
    for (const optic of ['reflex', 'scope_4x']) {
      const at = sweepOf(null, optic, 'attachment', attachGrid(optic));
      const co = composite({ anim: b.anim, f, gun: sw, attachments: { optic: at } });
      // the optic sits on the rail: its sight is above the irons' line, close to the centre column
      assert.ok(Math.abs(co.sight[0] - CENTRE[0]) <= 2.5 && co.sight[1] < CENTRE[1] + 1 && co.sight[1] > CENTRE[1] - 40, `${optic} sight ${co.sight}`);
      // the runtime then shifts the frame by (centre - sight): after it, the optic's sight is centred
      const shift = [CENTRE[0] - co.sight[0], CENTRE[1] - co.sight[1]];
      assert.ok(Math.hypot(co.sight[0] + shift[0] - CENTRE[0], co.sight[1] + shift[1] - CENTRE[1]) < 1e-9);
    }
  }
  // pistol irons too
  const p = bakeClip('pistol', 'ads_idle');
  const cp = composite({ anim: p.anim, f: 0, gun: p.sweeps.gun });
  assert.ok(Math.hypot(cp.sight[0] - CENTRE[0], cp.sight[1] - CENTRE[1]) <= 1, `pistol irons ${cp.sight}`);
});

test('fp: batch + sweep export the fp v2 contract (files, sockets, manifests) and fp check passes', () => {
  const e = new Engine({ home: tmp() }), out = path.join(e.home, 'assets');
  const s = e.run('fp_sweep', { out, guns: ['rifle'], mags: ['rifle_mag_30'], attachments: ['reflex', 'vertical_grip'], items: [] });
  assert.ok(s.guns.rifle.sheets >= 1 && s.px_per_m > 400);
  const b = e.run('fp_batch', { out, classes: ['rifle'], clips: ['idle', 'reload_empty'] });
  assert.equal(b.worst_hand_miss_px, 0);
  const fp = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp.json'), 'utf8'));
  const set = fp.sprites.fp_rifle;
  assert.deepEqual(set.frame, [384, 216]);
  assert.ok(set.anims['idle@vgrip'] && set.anims['idle@agrip'], 'foregrip variants');
  const A = set.anims.reload_empty;
  assert.equal(A.back, 'fp/arms_rifle/reload_empty_back.png');
  assert.equal(A.front, 'fp/arms_rifle/reload_empty_front.png');
  assert.equal(A.gun.length, A.frames);
  for (const g of A.gun) {
    for (const k of Object.keys(g)) assert.ok(['x', 'y', 'rot', 'yaw', 'pitch', 'scale', 'order', 'hidden', 'state'].includes(k), k);
    assert.ok(['back', 'mid', 'front'].includes(g.order));
  }
  const states = new Set(A.mag.map((m) => m.state));
  assert.deepEqual([...states].sort(), ['hand', 'hidden', 'in']);
  for (const m of A.mag.filter((x) => x.state === 'hand')) for (const k of ['x', 'y', 'rot', 'yaw', 'pitch']) assert.ok(Number.isFinite(m[k]), k);
  const ev = A.events.map((x) => x.e);
  for (const k of ['mag_out', 'mag_in', 'charge']) assert.ok(ev.includes(k), k);
  const strip = decodePNG(fs.readFileSync(path.join(out, A.back)));
  assert.equal(strip.width, 384 * A.frames);
  assert.equal(strip.height, 216);
  const g = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp_guns.json'), 'utf8')).sweeps.rifle;
  for (const k of ['class', 'cell', 'yaw', 'pitch', 'sheets', 'anchors', 'mag']) assert.ok(g[k] !== undefined, k);
  assert.equal(g.mag, 'rifle_mag_30');
  for (const sh of g.sheets) { const p = decodePNG(fs.readFileSync(path.join(out, sh))); assert.ok(p.width <= 1024 && p.height <= 1024); }
  const at = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp_attach.json'), 'utf8')).sweeps;
  assert.ok(at['att:reflex'].anchors.mount && at['att:reflex'].anchors.sight && at['att:vertical_grip'].anchors.support);
  const ck = e.run('fp_check', { out, classes: ['rifle'] });
  assert.equal(ck.pass, true, ck.summary + JSON.stringify(ck.issues?.slice(0, 4)));
  assert.ok(ck.hand_checks > 50 && ck.mag_handoffs >= 2 && ck.worst.mag_handoff_px <= 2);
  // composite from the files = composite in memory
  const c = e.run('fp_composite', { out, class: 'rifle', clip: 'reload_empty', frame: 12, attachments: { optic: 'reflex', underbarrel: 'vertical_grip' }, zoom: 1 });
  assert.ok(c.image.length > 1000 && c.draw_order[0] === 'back');
});

test('fp: composite draws in the runtime order (fpv2.ts render orders)', () => {
  // solid single-colour assets stacked on one pixel
  const cell = (rgb) => ({ def: { cell: [8, 8], yaw: [0, 0, 1], pitch: [0, 0, 1], anchors: { grip: [[4, 4]], mount: [[4, 4]], mag_well: [[4, 4]], optic: [[4, 4]], muzzle_mount: [[4, 4]], underbarrel: [[4, 4]] } }, cells: [Uint8ClampedArray.from({ length: 256 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]))] });
  const W = FRAME[0], H = FRAME[1];
  const stripOf = (rgb) => { const d = new Uint8ClampedArray(W * H * 4); const o = (100 * W + 100) * 4; d.set([...rgb, 255], o); return { width: W, height: H, data: d }; };
  const top = (anim, extra) => { const c = composite({ anim, f: 0, gun: cell([10, 0, 0]), mag: cell([20, 0, 0]), ...extra }); const o = (100 * W + 100) * 4; return c.data[o]; };
  const gunAt = (order) => ({ gun: [{ x: 100.5, y: 100.5, rot: 0, yaw: 0, pitch: 0, order }], mag: [{ state: 'in' }], item: [{ id: 'k', x: 100.5, y: 100.5, order: 'mid' }] });
  // back strip < gun (mid) < attachment < item (mid) < front strip < gun (front)
  assert.equal(top(gunAt('mid'), { layers: { back: stripOf([1, 0, 0]) } }), 10, 'gun over back');
  assert.equal(top(gunAt('mid'), { attachments: { optic: cell([30, 0, 0]) } }), 30, 'attachment over gun');
  assert.equal(top({ ...gunAt('mid'), item: [] }, {}), 10, 'mag (in) under gun');
  assert.equal(top(gunAt('mid'), { items: { k: cell([40, 0, 0]) }, attachments: { optic: cell([30, 0, 0]) } }), 40, 'item (mid) over attachments');
  assert.equal(top(gunAt('mid'), { items: { k: cell([40, 0, 0]) }, layers: { front: stripOf([50, 0, 0]) } }), 50, 'front over item (mid)');
  assert.equal(top(gunAt('front'), { layers: { front: stripOf([50, 0, 0]) } }), 10, 'gun order front over the front layer');
  assert.equal(top(gunAt('back'), { layers: { back: stripOf([1, 0, 0]) } }), 1, 'gun order back under the back layer');
  const hand = { gun: [{ x: 100.5, y: 100.5, order: 'mid' }], mag: [{ state: 'hand', x: 100.5, y: 100.5 }] };
  assert.equal(top(hand, { layers: { mid: stripOf([60, 0, 0]) } }), 60, 'mid layer over the magazine in the hand');
  assert.equal(top(hand, {}), 20, 'magazine in the hand over the gun');
  const c = composite({ anim: gunAt('mid'), f: 0, gun: cell([10, 0, 0]), mag: cell([20, 0, 0]), layers: { back: stripOf([1, 0, 0]), front: stripOf([2, 0, 0]) }, attachments: { optic: cell([30, 0, 0]) }, items: { k: cell([40, 0, 0]) } });
  assert.deepEqual(c.layers.map((l) => l.name), ['back', 'mag', 'gun', 'att0', 'item', 'front']);
});

test('fp: generation is deterministic', () => {
  const a = bakeClip('pistol', 'reload');
  clearFpCache();
  const b = bakeClip('pistol', 'reload');
  assert.deepEqual(a.back.data, b.back.data);
  assert.deepEqual(a.front.data, b.front.data);
  assert.deepEqual(a.anim, b.anim);
});

test('fp: RotSprite keeps the palette: rotated parts and whole arm frames use only ramp colours', () => {
  const sp = partSprite('fore', 'mec', [0.3, 0.2, 0.93], 6, [-0.5, 0.7, 0.5]);
  const own = colorsOf(sp.data);
  const pal = fpPalette();
  for (const c of own) assert.ok(pal.has(c), 'sprite colours are ramp colours');
  for (let deg = 0; deg < 360; deg += 7) {
    const buf = { W: 160, H: 160, rgba: new Uint8ClampedArray(160 * 160 * 4) };
    drawRot(buf, sp, sp.ax, sp.ay, 80, 80, deg);
    for (const c of colorsOf(buf.rgba)) assert.ok(own.has(c), `new colour at ${deg}°`);
  }
  // a whole clip: every arm pixel from the skin ramps, and a still pose draws the same pixels twice
  const ctx = classCtx('knife');
  const sol = solveClip(classClips('knife').slash, ctx);
  const cols = new Set();
  for (const fr of sol.frames) for (const c of colorsOf(renderBones([...fr.hands.R.bones, ...fr.hands.L.bones], 'severance').rgba)) cols.add(c);
  for (const c of cols) assert.ok(pal.has(c));
  assert.ok(cols.size >= 16 && cols.size <= 128, `${cols.size} colours`);
  const f0 = sol.frames[0];
  const x = renderBones([...f0.hands.R.bones, ...f0.hands.L.bones], 'mec').rgba, y = renderBones([...f0.hands.R.bones, ...f0.hands.L.bones], 'mec').rgba;
  assert.deepEqual(x, y);
});

test('fp: every class has its contract clips; apparent angles match the cell camera', () => {
  const core = ['idle', 'walk', 'sprint', 'fire', 'fire_ads', 'ads_in', 'ads_idle', 'reload', 'reload_empty', 'draw', 'holster', 'inspect', 'jam_clear', 'firemode', 'check_mag', 'melee', 'throw', 'use_med', 'interact'];
  for (const c of GUN_CLASSES) { const C = classClips(c); for (const n of core) assert.ok(C[n], `${c}.${n}`); }
  for (const [c, ex] of [['knife', ['slash', 'stab', 'idle']], ['grenade', ['cook', 'throw']], ['med', ['bandage', 'stim', 'kit']], ['tablet', ['raise', 'use']], ['unarmed', ['idle', 'interact']]]) for (const n of ex) assert.ok(classClips(c)[n], `${c}.${n}`);
  for (const n of ['reload_start', 'reload_shell', 'reload_end']) assert.ok(classClips('shotgun')[n], n);
  assert.ok(classClips('rifle').charge && classClips('pistol').charge);
  // a gun on the optical axis at the reference depth, unrotated: apparent = its own yaw / pitch
  const a = apparent([0, 0, -D], ypr(20, -10, 0));
  assert.ok(Math.abs(a.yaw - 20) < 1e-6 && Math.abs(a.pitch + 10) < 1e-6 && Math.abs(a.rot) < 1e-6, JSON.stringify(a));
  // grid of a class covers the hip station
  const g = classGrid('rifle'), hip = apparent(STATIONS.long.hip.P, ypr(...STATIONS.long.hip.r));
  assert.ok(hip.yaw >= g.yaw[0] && hip.yaw <= g.yaw[1] && hip.pitch >= g.pitch[0] && hip.pitch <= g.pitch[1]);
  assert.ok(fpGeometry('dmr').support[2] === fpGeometry('rifle').support[2], 'dmr shares the rifle grip geometry (handling.js)');
  void posedWorld;
});

test('fp: step / offsets / frame / zoom / accept must be finite numbers (no 0-cell sweeps, no silently dropped magazine)', () => {
  const e = new Engine({ home: tmp() }), out = tmp();
  for (const step of ['abc', 0, -5, NaN, '']) {
    assert.throws(() => e.run('fp_sweep', { out, guns: ['pistol'], mags: false, attachments: false, items: false, step }), /step must be a finite number > 0/, JSON.stringify(step));
    assert.throws(() => e.run('fp_sweep2d', { out, step }), /step must be a finite number > 0/);
    assert.throws(() => e.run('fp_batch', { out, classes: ['pistol'], clips: ['idle'], variants: false, step }), /step must be a finite number > 0/);
  }
  for (const k of ['yaw_offset', 'pitch_offset', 'frame']) assert.throws(() => e.run('fp_composite', { out, class: 'rifle', clip: 'idle', [k]: 'x' }), new RegExp(`${k} must be a finite number`));
  e.run('fp_template', { kind: 'mag', name: 'm1', class: 'rifle', canvas: 'm1c' });
  assert.throws(() => e.run('fp_anchors', { canvas: 'm1c', accept: 'most' }), /accept must be a finite number/);
});
