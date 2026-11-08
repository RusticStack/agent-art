// Interior, industrial-exterior and city kit assemblies for art_model (see kitparts.js for the
// expansion rules). Interior pieces snap to a deck grid: cell 64 px (2 m), deck height 96 px (3 m),
// floor top at y = 0, cells centred on the piece origin. Sides: n = +z (toward the nose), s = -z,
// e = +x, w = -x.
import { registerAssembly, ASSEMBLIES } from './assemblies.js';

export const DECK = { cell: 64, h: 96, wall: 4, floor: 4, door_w: 40, door_h: 76 };
const n = (v, d) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`expected a number, got ${JSON.stringify(v)}`); return x; };
const tx = (p, k, d) => (p.textures && p.textures[k] !== undefined ? p.textures[k] : p[k] !== undefined ? p[k] : d);
const r2 = (v) => Math.round(v * 100) / 100;
const glow = (c) => ({ color: c, material: { preset: 'emissive_panel' }, emissive_part: true });
const SIDES = ['n', 's', 'e', 'w'];

// ---------- room shell ----------
/**
 * Room shell over cw x cd cells: floor, ceiling, walls with door / window openings, ribs, a light
 * strip per cell row, light markers. openings: {n|s|e|w: [{at (cell index along the side), w?, h?, kind:"door"|"open"|"window", sill?}]}.
 * -> {parts, W, D, H}
 */
export function roomShell(p, opts = {}) {
  const C = n(p.cell, DECK.cell), cw = Math.max(1, Math.round(n(p.cells?.[0] ?? p.cw, opts.cw ?? 1))), cd = Math.max(1, Math.round(n(p.cells?.[1] ?? p.cd, opts.cd ?? 1)));
  const W = cw * C, D = cd * C, H = n(p.h, opts.h ?? DECK.h), th = DECK.wall;
  const floorT = tx(p, 'floor', opts.floor ?? '#4a4f57'), wallT = tx(p, 'wall', opts.wall ?? '#5b6068'), ceilT = tx(p, 'ceiling', opts.ceiling ?? '#3a3e45'), ribT = tx(p, 'rib', '#33373e'), glassT = tx(p, 'glass', '#7fc8e8');
  const lightC = p.light_color ?? opts.light ?? '#cfe6ff';
  const parts = [{ type: 'box', w: W, h: DECK.floor, d: D, at: [0, -DECK.floor, 0], texture: floorT, faces: { top: floorT }, material: 'painted_metal' }];
  if (p.ceiling !== false) parts.push({ type: 'box', w: W, h: DECK.floor, d: D, at: [0, H, 0], texture: ceilT });
  const open = p.openings || {};
  for (const side of SIDES) {
    if (open[side] === 'open' || open[side] === true) continue;
    const list = [].concat(open[side] || []).map((o) => (typeof o === 'number' ? { at: o } : o));
    const along = side === 'n' || side === 's' ? W : D, cells = side === 'n' || side === 's' ? cw : cd;
    // wall runs along +x (n/s) or +z (e/w): split around openings
    const holes = list.map((o) => { const w = n(o.w, o.kind === 'window' ? C * 0.7 : o.kind === 'open' ? C : DECK.door_w); const c = -along / 2 + (n(o.at, Math.floor(cells / 2)) + 0.5) * C; return { a: c - w / 2, b: c + w / 2, kind: o.kind ?? 'door', h: n(o.h, o.kind === 'window' ? H * 0.35 : DECK.door_h), sill: n(o.sill, o.kind === 'window' ? H * 0.38 : 0) }; }).sort((x, y) => x.a - y.a);
    const seg = (a, b, y0, y1) => {
      if (b - a < 0.5 || y1 - y0 < 0.5) return;
      const mid = (a + b) / 2, len = b - a;
      const at = side === 'n' ? [mid, y0, D / 2 + th / 2] : side === 's' ? [mid, y0, -D / 2 - th / 2] : side === 'e' ? [W / 2 + th / 2, y0, mid] : [-W / 2 - th / 2, y0, mid];
      parts.push({ type: 'box', w: side === 'n' || side === 's' ? len : th, h: y1 - y0, d: side === 'n' || side === 's' ? th : len, at, texture: wallT, material: 'painted_metal' });
    };
    let x = -along / 2 - (side === 'e' || side === 'w' ? 0 : th);
    const end = along / 2 + (side === 'e' || side === 'w' ? 0 : th);
    for (const h of holes) {
      seg(x, h.a, 0, H);
      seg(h.a, h.b, h.sill + h.h, H);
      if (h.sill > 0) seg(h.a, h.b, 0, h.sill);
      if (h.kind === 'window') {
        const mid = (h.a + h.b) / 2, len = h.b - h.a, y = h.sill;
        const at = side === 'n' ? [mid, y, D / 2 + th / 2] : side === 's' ? [mid, y, -D / 2 - th / 2] : side === 'e' ? [W / 2 + th / 2, y, mid] : [-W / 2 - th / 2, y, mid];
        parts.push({ type: 'box', w: side === 'n' || side === 's' ? len : 1, h: h.h, d: side === 'n' || side === 's' ? 1 : len, at, texture: glassT, glass: { opacity: 0.3 } });
      }
      x = h.b;
    }
    seg(x, end, 0, H);
  }
  // ribs at cell borders along the long axis + ceiling light strips + light markers
  const longZ = D >= W;
  const nr = longZ ? cd : cw;
  for (let i = 0; i <= nr; i++) {
    const c = (longZ ? -D / 2 : -W / 2) + i * C;
    if (p.ribs !== false) for (const sgn of [1, -1]) {
      const at = longZ ? [sgn * (W / 2 - 2), 0, c] : [c, 0, sgn * (D / 2 - 2)];
      const sideOpen = longZ ? open[sgn > 0 ? 'e' : 'w'] : open[sgn > 0 ? 'n' : 's'];
      if (sideOpen === 'open' || sideOpen === true) continue;
      parts.push({ type: 'box', w: longZ ? 4 : 6, h: H, d: longZ ? 6 : 4, at, texture: ribT, bevel: 1 });
    }
    if (i < nr && p.lights !== false) {
      const cc = c + C / 2;
      parts.push({ type: 'box', w: longZ ? Math.min(16, W * 0.3) : C * 0.6, h: 1, d: longZ ? C * 0.6 : Math.min(16, D * 0.3), at: longZ ? [0, H - 1, cc] : [cc, H - 1, 0], ...glow(lightC) });
      if (i % 2 === 0) parts.push({ type: 'light', at: longZ ? [0, H - 6, cc] : [cc, H - 6, 0], color: lightC, intensity: 0.7, range: Math.max(W, D, C * 2.5), bulb: false });
    }
  }
  if (p.pipes !== false) for (const sgn of [1, -1]) {
    const y = H - 10;
    const pts = longZ ? [[sgn * (W / 2 - 6), y, -D / 2], [sgn * (W / 2 - 6), y, D / 2]] : [[-W / 2, y, sgn * (D / 2 - 6)], [W / 2, y, sgn * (D / 2 - 6)]];
    parts.push({ type: 'tube', path: pts, r: 2, sides: 6, texture: tx(p, 'pipe', '#5a5f68'), caps: false });
  }
  parts.push({ type: 'marker', kind: 'room', at: [0, 0, 0], data: { room: p.room ?? p.kind ?? 'room', w: W, d: D, h: H } });
  return { parts, W, D, H, C };
}

const room = (kind, def = {}, furnish = () => []) => (p, k) => {
  const r = roomShell({ ...def, ...p, kind }, def);
  return { parts: [...r.parts, ...furnish(p, k, r)] };
};

// ---------- corridors ----------
const CORR = { straight: { n: 'open', s: 'open' }, L: { n: 'open', e: 'open' }, T: { n: 'open', e: 'open', w: 'open' }, X: { n: 'open', s: 'open', e: 'open', w: 'open' }, end: { n: 'open' } };
registerAssembly('corridor', (p, k) => {
  const kind = p.kind ?? p.shape ?? 'straight';
  if (!CORR[kind]) throw new Error('corridor kind must be straight|L|T|X|end');
  const len = Math.max(1, Math.round(n(p.len ?? p.cells?.[1], 1)));
  const r = roomShell({ ...p, cells: [1, kind === 'straight' || kind === 'end' ? len : 1], openings: { ...CORR[kind], ...(p.openings || {}) }, kind: 'corridor' });
  const parts = r.parts;
  // floor grating strip + cable trays
  parts.push({ type: 'box', w: r.W * 0.36, h: 0.4, d: r.D, at: [0, 0, 0], texture: tx(p, 'grate', '#2c3036') });
  if (p.greebles !== false) parts.push({ type: 'greeble', w: r.W * 0.5, d: r.D, at: [0, r.H - 0.01, 0], rotate: [180, 0, 0], seed: Number(p.seed ?? 1), density: 0.35, size: [3, 10], height: [0.5, 2], kinds: ['conduit', 'pipe', 'vent', 'panel', 'cables'], texture: tx(p, 'wall', '#5b6068'), dark: '#2a2d33' });
  return { parts };
}, 'kind?:straight|L|T|X|end (open sides: n always; L adds e, T adds e+w, X all), len?:1 (cells, straight/end), h?:96, textures:{floor,wall,ceiling,rib,pipe,grate}, light_color?, openings? (override per side)');
registerAssembly('room', room('room'), 'cells?:[cw,cd] (64 px cells),h?:96,openings?:{n|s|e|w:"open"|[{at, kind:door|window|open, w?, h?, sill?}]},textures:{floor,wall,ceiling,rib,glass},ribs?,lights?,pipes?,light_color?');

// ---------- doors ----------
registerAssembly('door', (p, k) => {
  const style = p.style ?? 'bulkhead', w = n(p.w, DECK.door_w), h = n(p.h, DECK.door_h), th = n(p.thick, DECK.wall + 2);
  if (!['bulkhead', 'blast', 'hatch'].includes(style)) throw new Error('door style must be bulkhead|blast|hatch');
  const frame = tx(p, 'frame', '#2c3036'), leaf = tx(p, 'texture', '#6b717b'), haz = tx(p, 'hazard', '#d09a28');
  const open = k.rig ? 0 : Math.max(0, Math.min(1, n(p.open, 0)));
  const fw = style === 'blast' ? 8 : 5;
  const parts = [
    { type: 'box', w: fw, h: h + fw, d: th, at: [-(w / 2 + fw / 2), 0, 0], texture: frame, bevel: 0.8 },
    { type: 'box', w: fw, h: h + fw, d: th, at: [w / 2 + fw / 2, 0, 0], texture: frame, bevel: 0.8 },
    { type: 'box', w: w + 2 * fw, h: fw, d: th, at: [0, h, 0], texture: frame, bevel: 0.8 },
  ];
  const clips = {}, keys = {};
  if (style === 'bulkhead') {
    for (const s of [1, -1]) {
      const nm = k.node(s > 0 ? 'l' : 'r');
      parts.push({ type: 'box', name: nm, w: w / 2, h, d: 2, at: [s * (w / 4 + (open * w) / 2), 0, 0], texture: leaf, insets: [{ face: 'front', rect: [2, 4, w / 2 - 4, h * 0.35], depth: 0.5 }] });
      parts.push({ type: 'box', w: 1.2, h: h * 0.8, d: 2.4, at: [s * (0.6 + (open * w) / 2), h * 0.1, 0], ...(nm ? { parent: nm } : {}), color: haz });
      if (nm) keys[nm] = { at: [s * (w / 2 - 1), 0, 0] };
    }
  } else if (style === 'blast') {
    const nm = k.node();
    parts.push({ type: 'box', name: nm, w, h, d: 4, at: [0, open * (h - 6), 0], texture: leaf, bevel: 1 });
    for (let i = 0; i < 4; i++) parts.push({ type: 'box', w: w * 0.9, h: 2, d: 4.6, at: [0, 6 + i * (h / 4) + open * (h - 6), 0], ...(nm ? { parent: nm, at: [0, 6 + i * (h / 4), 0] } : {}), color: i % 2 ? haz : '#1c1d20' });
    if (nm) keys[nm] = { at: [0, h - 6, 0] };
  } else {
    const nm = k.node();
    parts.push({ type: 'cylinder', name: nm, r: Math.min(w, h) / 2 - 1, h: 2, segments: 12, rotate: [90, 0, 0], at: [0, h / 2, -1], pivot: [-(Math.min(w, h) / 2 - 1), 1, 0], texture: leaf, ...(open ? { rotate: [90, 0, -95 * open] } : {}) });
    if (nm) keys[nm] = { rot: [0, 0, -95] };
  }
  parts.push({ type: 'light', at: [w / 2 + fw + 2, h + 2, th / 2 + 1], color: '#40ff70', intensity: 0.25, range: 40, bulb: 1.5 });
  if (k.rig) clips[p.clip ?? `${k.id}_open`] = { keys: [{ t: 0, parts: {} }, { t: 0.15, parts: {}, ease: 'step' }, { t: n(p.duration, style === 'blast' ? 2.4 : 0.8), parts: keys, ease: 'smooth' }] };
  parts.push({ type: 'marker', kind: 'door', at: [0, 0, 0], data: { door: k.id, style, w, h }, dir: [0, 0, 1] });
  return { parts, clips };
}, 'style?:bulkhead (2 sliding leaves)|blast (heavy, rises)|hatch (round, swings),w?:40,h?:76,thick?,open?:0..1 (static) -> named: clip <name>_open; door marker; sits in a wall gap (plane xy, facing +z)');
registerAssembly('airlock', (p, k) => {
  const r = roomShell({ ...p, cells: [1, 1], openings: { n: [{ at: 0, kind: 'door' }], s: [{ at: 0, kind: 'door' }] }, kind: 'airlock', light_color: '#ff5040' });
  const parts = r.parts;
  for (const [side, z] of [['inner', -r.D / 2 - DECK.wall / 2], ['outer', r.D / 2 + DECK.wall / 2]]) parts.push({ type: 'door', ...(k.rig ? { name: `${k.id}_${side}` } : { open: n(p[`${side}_open`], 0) }), style: side === 'outer' ? 'blast' : 'bulkhead', at: [0, 0, z] });
  parts.push({ type: 'box', w: r.W * 0.8, h: 0.3, d: r.D * 0.8, at: [0, 0, 0], texture: tx(p, 'hazard', '#d09a28') });
  return { parts };
}, '1-cell airlock: inner bulkhead (s) + outer blast door (n), red cycle light; named: doors <name>_inner / <name>_outer with their open clips');

// ---------- vertical circulation ----------
registerAssembly('ladder', (p) => {
  const h = n(p.h, DECK.h + DECK.floor), w = n(p.w, 16), T = tx(p, 'texture', '#8a6a2a');
  const parts = [-1, 1].map((s) => ({ type: 'beam', from: [s * w / 2, 0, 0], to: [s * w / 2, h, 0], s: 1.6, texture: T }));
  const rungs = Math.max(2, Math.round(h / 10));
  for (let i = 1; i < rungs; i++) parts.push({ type: 'beam', from: [-w / 2, (h * i) / rungs, 0], to: [w / 2, (h * i) / rungs, 0], s: 1.1, texture: T });
  return { parts };
}, 'h?:100,w?:16 (rails + rungs in the xy plane)');
registerAssembly('lift', (p, k) => {
  const w = n(p.w, 56), d = n(p.d, 56), travel = n(p.travel, DECK.h + DECK.floor), frame = tx(p, 'frame', '#33373e'), deck = tx(p, 'floor', '#4a4f57');
  const N = k.node();
  const parts = [];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'beam', from: [x * w / 2, 0, z * d / 2], to: [x * w / 2, travel + DECK.h, z * d / 2], s: 3, texture: frame });
  parts.push({ type: 'box', name: N, w: w - 4, h: 3, d: d - 4, at: [0, -3, 0], texture: deck, insets: [{ face: 'top', rect: [2, 2, w - 8, d - 8], depth: 0.6 }] });
  for (const s of [1, -1]) parts.push({ type: 'beam', from: [s * (w / 2 - 3), 0, -d / 2 + 3], to: [s * (w / 2 - 3), 0, d / 2 - 3], s: 1.5, texture: tx(p, 'rail', '#8a6a2a'), ...(N ? { parent: N } : {}) });
  parts.push({ type: 'light', at: [w / 2 + 2, 60, d / 2 + 2], color: '#ffb040', intensity: 0.3, range: 50, bulb: 1.5 });
  const clips = N ? { [p.clip ?? `${k.id}_up`]: { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 3), parts: { [N]: { at: [0, travel, 0] } }, ease: 'smooth' }] } } : {};
  return { parts, clips };
}, 'w?:56,d?:56,travel?:100 (one deck),textures:{frame,floor,rail} -> named: platform node, clip <name>_up');

// ---------- furniture + consoles ----------
registerAssembly('seat', (p) => {
  const T = tx(p, 'texture', '#3a3e45'), pad = tx(p, 'pad', '#5a3a2a');
  return { parts: [
    { type: 'cylinder', r: 3, h: 12, segments: 6, texture: T },
    { type: 'box', w: 18, h: 4, d: 18, at: [0, 12, 0], texture: pad, bevel: 1 },
    { type: 'box', w: 18, h: 26, d: 4, at: [0, 14, -8], rotate: [-10, 0, 0], texture: pad, bevel: 1 },
    { type: 'box', w: 10, h: 6, d: 3, at: [0, 41, -12], texture: pad, bevel: 1 },
    ...[1, -1].map((s) => ({ type: 'box', w: 2, h: 3, d: 14, at: [s * 10, 18, 0], texture: T })),
  ] };
}, 'pilot / crew seat facing +z');
registerAssembly('console', (p, k) => {
  const w = n(p.w, 56), screens = Math.max(1, Math.round(n(p.screens, 2))), T = tx(p, 'texture', '#2c3036'), scr = tx(p, 'screen', null);
  const parts = [{ type: 'box', w, h: 30, d: 16, texture: T, bevel: 1 }, { type: 'box', w, h: 2, d: 22, at: [0, 30, 3], rotate: [-18, 0, 0], texture: T }];
  const sockets = {}, sw = (w - 6) / screens;
  for (let i = 0; i < screens; i++) {
    const x = -w / 2 + 3 + sw * (i + 0.5), y = 34, z = -2;
    parts.push({ type: 'box', w: sw * 0.85, h: sw * 0.55, d: 1, at: [x, y, z], rotate: [-15, 0, 0], ...(scr ? { faces: { front: scr }, color: '#101114', tile: false, material: { preset: 'emissive_panel' } } : glow(p.screen_color ?? '#30d0a0')) });
    const name = `${k.id}_mfd${i}`;
    if (k.rig) sockets[name] = { at: [x, y + sw * 0.27, z + 0.6], look: [0, 0, 1] };
    parts.push({ type: 'marker', kind: 'screen', at: [x, y + sw * 0.27, z + 0.6], data: { screen: name, w: sw * 0.85, h: sw * 0.55, ui: true }, dir: [0, 0.26, 0.97] });
  }
  return { parts, sockets };
}, 'w?:56,screens?:2,textures:{texture,screen (emissive UI canvas; default a glowing colour)},screen_color? -> screen markers <id>_mfd<i> (size for UI textures), sockets when named');

// ---------- rooms ----------
registerAssembly('bridge', room('bridge', { cw: 3, cd: 2, light: '#a8c8ff' }, (p, k, r) => {
  const out = [];
  const seats = Math.max(1, Math.round(n(p.seats, 3)));
  for (let i = 0; i < seats; i++) { const x = (i - (seats - 1) / 2) * (r.W / (seats + 0.5)); out.push({ type: 'console', id: `${k.id}_c${i}`, turn: 2, at: [r2(x), 0, r2(r.D / 2 - 24)], w: 44, screens: 2, textures: p.textures }); out.push({ type: 'seat', at: [r2(x), 0, r2(r.D / 2 - 52)], textures: p.textures }); }
  out.push({ type: 'seat', at: [0, 0, r2(-r.D / 2 + 30)], pad: '#2a3a5a' });
  out.push({ type: 'holo', w: 40, h: 24, at: [0, 30, 0], text: p.holo_text ?? 'NAV', color: '#40d0ff', opacity: 0.6 });
  return out;
}), 'bridge / cockpit: room (default 3x2 cells) + consoles with MFD screen markers, seats, a holo table; openings for the canopy / windows (n)');
registerAssembly('engine_room', room('engine_room', { cw: 3, cd: 3, h: 160, light: '#ff9a50' }, (p, k, r) => {
  const R = n(p.core_r, Math.min(r.W, r.D) * 0.14), core = p.core_color ?? '#60c8ff', H = r.H;
  const out = [
    { type: 'cylinder', r: R * 1.6, h: 10, segments: 12, texture: tx(p, 'metal', '#3a3e45') },
    { type: 'cylinder', r: R * 1.6, h: 10, segments: 12, at: [0, H - 10, 0], texture: tx(p, 'metal', '#3a3e45') },
    { type: 'cylinder', r: R, h: H - 20, segments: 12, at: [0, 10, 0], ...glow(core) },
    { type: 'cylinder', r: R * 1.08, h: H - 20, segments: 12, at: [0, 10, 0], glass: { opacity: 0.25 }, color: '#a0e0ff' },
    { type: 'beam', from: [R * 1.35, 10, 0], to: [R * 1.35, H - 10, 0], s: 3, texture: tx(p, 'metal', '#3a3e45'), array: { count: 8, rotate: [0, 45, 0], about: [0, 0, 0] } },
    { type: 'tube', path: [[0, H * 0.7, 0], [r.W / 2 - 6, H * 0.7, 0], [r.W / 2 - 6, H * 0.7, r.D / 3]], r: 5, sides: 8, texture: tx(p, 'pipe', '#5a5f68'), array: { count: 4, rotate: [0, 90, 0], about: [0, 0, 0] } },
    { type: 'tube', path: [[0, H * 0.35, 0], [-r.W / 2 + 10, H * 0.2, -r.D / 2 + 10]], r: 3, sides: 6, ...glow('#ff7a30'), array: { count: 3, rotate: [0, 120, 0], about: [0, 0, 0] } },
    { type: 'light', at: [0, H * 0.5, 0], color: core, intensity: 2.2, range: Math.max(r.W, r.D) * 1.1, bulb: false },
    { type: 'fog_card', w: R * 6, h: H * 0.8, at: [0, H * 0.9, 0], color: core, opacity: 0.18, cross: 3 },
  ];
  // catwalk ring at mid height around the core
  const cy = Math.round(H * 0.45);
  for (let i = 0; i < 4; i++) { const ang = i * 90, rad = (ang * Math.PI) / 180; out.push({ type: 'catwalk', len: r2(R * 5.2), w: 24, rails: 'left', at: [r2(Math.sin(rad) * R * 2.6), cy, r2(Math.cos(rad) * R * 2.6)], rotate: [0, ang + 90, 0] }); }
  out.push({ type: 'ladder', at: [0, 0, r2(R * 2.6 + 14)], h: cy });
  return out;
}), 'engine room (default 3x3 cells, h 160): reactor core (emissive column in a glass sleeve, cage, caps), conduits, glowing feed lines, catwalk ring + ladder, strong core light, glow fog card; core_r?, core_color?');
registerAssembly('quarters', room('quarters', { cw: 2, cd: 2, light: '#ffd8a8' }, (p, k, r) => {
  const out = [];
  for (const s of [1, -1]) {
    for (const y of [0, 34]) out.push({ type: 'box', w: 30, h: 8, d: 64, at: [s * (r.W / 2 - 20), y + 6, -r.D / 2 + 40], texture: tx(p, 'frame', '#3a3e45'), bevel: 1 }, { type: 'box', w: 28, h: 3, d: 60, at: [s * (r.W / 2 - 20), y + 14, -r.D / 2 + 40], color: tx(p, 'fabric', '#405a6a'), material: 'fabric' });
    out.push({ type: 'box', w: 20, h: 72, d: 18, at: [s * (r.W / 2 - 14), 0, r.D / 2 - 14], texture: tx(p, 'locker', '#4b5059'), insets: [{ face: 'front', rect: [2, 4, 16, 64], depth: 0.8 }], turn: s > 0 ? 3 : 1 });
  }
  return out;
}), 'crew quarters (2x2): bunks, lockers');
registerAssembly('cargo_bay', room('cargo_bay', { cw: 3, cd: 4, h: 128, light: '#ffe0b0' }, (p, k, r) => [
  { type: 'container_rack', at: [-r.W / 4, 0, 0], cols: 1, rows: 2, layers: Math.max(1, Math.floor((r.D - 40) / 100)), size: [40, 40, 96], seed: Number(p.seed ?? 3), fill: 0.8, frame: false },
  { type: 'box', w: 4, h: 0.3, d: r.D * 0.9, at: [r.W / 8, 0, 0], color: '#d09a28' },
  { type: 'box', w: 4, h: 0.3, d: r.D * 0.9, at: [r.W * 0.42, 0, 0], color: '#d09a28' },
  { type: 'beam', from: [-r.W / 2 + 6, r.H - 12, -r.D / 2], to: [-r.W / 2 + 6, r.H - 12, r.D / 2], s: 6, texture: '#4b5059' },
  { type: 'beam', from: [r.W / 2 - 6, r.H - 12, -r.D / 2], to: [r.W / 2 - 6, r.H - 12, r.D / 2], s: 6, texture: '#4b5059' },
  { type: 'box', w: r.W - 12, h: 8, d: 10, at: [0, r.H - 20, 0], texture: '#d09a28', bevel: 1 },
]), 'cargo bay (3x4, h 128): containers, floor hazard lines, overhead crane rails + bridge beam');
registerAssembly('hangar', room('hangar', { cw: 6, cd: 6, h: 224, light: '#d8e8ff' }, (p, k, r) => [
  { type: 'landing_pad', w: Math.min(r.W, r.D) * 0.6, h: 2, mark: p.mark ?? 'H' },
  { type: 'truss', from: [-r.W / 2, r.H - 24, 0], to: [r.W / 2, r.H - 24, 0], w: 16, h: 24, bay: 24, texture: '#4b5059', array: { count: 3, step: [0, 0, r.D / 3] }, at: [0, 0, -r.D / 3] },
  { type: 'god_ray', w: 48, h: r.H * 0.9, at: [0, r.H - 6, 0], color: '#c8dcff', opacity: 0.16, array: { count: 3, step: [0, 0, r.D / 3] } },
]), 'hangar (6x6, h 224): pad with markings, roof trusses, light shafts');
registerAssembly('med_bay', room('med_bay', { cw: 2, cd: 3, light: '#e0fff4' }, (p, k, r) => [
  ...[1, -1].map((s) => ({ type: 'box', w: 26, h: 18, d: 60, at: [s * (r.W / 2 - 22), 0, 0], color: '#c8ccd0', bevel: 2 })),
  { type: 'tube', path: [[-24, 0, 30], [-24, 52, 30], [24, 52, 30], [24, 0, 30]], r: 3, sides: 6, ...glow('#60ffc8') },
  { type: 'box', w: 30, h: 60, d: 16, at: [0, 0, -r.D / 2 + 12], color: '#e8ecf0', insets: [{ face: 'front', rect: [3, 4, 24, 24], depth: 0.6 }] },
]), 'med bay (2x3): beds, scanner arch (emissive), cabinet');
registerAssembly('armoury', room('armoury', { cw: 2, cd: 2, light: '#ffd0a0' }, (p, k, r) => {
  const out = [];
  for (const s of [1, -1]) {
    out.push({ type: 'box', w: 8, h: 72, d: r.D - 24, at: [s * (r.W / 2 - 8), 0, 0], texture: tx(p, 'rack', '#33373e') });
    for (let i = 0; i < 5; i++) out.push({ type: 'box', w: 3, h: 30, d: 4, at: [s * (r.W / 2 - 14), 30, -r.D / 2 + 24 + i * ((r.D - 48) / 4)], color: '#1e2024', rotate: [0, 0, s * 8] });
  }
  out.push({ type: 'box', w: 40, h: 28, d: 20, at: [0, 0, 0], color: '#4b5059', bevel: 1 });
  return out;
}), 'armoury (2x2): weapon racks, ammo crate');

// ---------- exterior industrial kit ----------
registerAssembly('tower', (p) => {
  const h = n(p.h, 320), w = n(p.w, 32), T = tx(p, 'texture', '#5a5f68'), lv = Math.max(0, Math.round(n(p.platforms, 2)));
  const parts = p.style === 'solid' ? [{ type: 'cylinder', r_bottom: w / 2, r_top: w * 0.35, h, segments: 8, texture: T }] : [{ type: 'truss', from: [0, 0, 0], to: [0, h, 0], w, h: w, bay: w, style: 'x', chord: 2.4, brace: 1.4, texture: T }];
  for (let i = 1; i <= lv; i++) parts.push({ type: 'box', w: w * 2.2, h: 3, d: w * 2.2, at: [0, (h * i) / (lv + 1), 0], texture: tx(p, 'deck', '#4a4f57') }, { type: 'catwalk', len: w * 2.2, w: 6, at: [w * 1.1 - 3, (h * i) / (lv + 1) + 3, 0], rails: 'left', texture: '#3a3e45' });
  if (p.beacon !== false) parts.push({ type: 'light', at: [0, h + 4, 0], color: '#ff3030', intensity: 0.8, range: 120, bulb: 3 });
  parts.push({ type: 'ladder', at: [0, 0, w / 2 + 2], h });
  return { parts };
}, 'h?:320,w?:32,style?:lattice|solid,platforms?:2,beacon?:true');
registerAssembly('dish', (p, k) => {
  const r = n(p.r, 64), depth = n(p.depth, r * 0.3), tilt = n(p.tilt, 35), mh = n(p.mount_h, r * 0.8), T = tx(p, 'texture', '#a8acb0');
  const prof = [...Array(7).keys()].map((i) => { const x = (r * i) / 6; return [x, (depth * x * x) / (r * r)]; });
  const N = k.node();
  const parts = [{ type: 'cylinder', r: r * 0.18, h: mh, segments: 8, texture: tx(p, 'mount', '#4b5059') }];
  parts.push({ type: 'revolve', name: N, profile: prof, segments: 16, inside: true, texture: T, at: [0, mh, 0], rotate: [tilt, 0, 0] });
  parts.push({ type: 'beam', from: [0, 0, 0], to: [0, depth * 2.2, 0], s: 1.5, texture: '#3a3e45', at: [0, mh, 0], rotate: [tilt, 0, 0], ...(N ? { parent: N } : {}) });
  parts.push({ type: 'cylinder', r: 2.5, h: 5, segments: 6, at: [0, mh, 0], pivot: [0, -depth * 2.2, 0], rotate: [tilt, 0, 0], ...(N ? { parent: N } : {}), color: '#2a2c30' });
  const clips = N ? { [p.clip ?? `${k.id}_track`]: { loop: true, duration: 12, keys: [{ t: 0, parts: { [N]: { rot: [0, -40, 0] } } }, { t: 6, parts: { [N]: { rot: [0, 40, 0] } }, ease: 'smooth' }] } } : {};
  return { parts, clips };
}, 'r?:64,depth?,tilt?:35,mount_h?, textures:{texture,mount} (parabolic comms dish; named: clip <name>_track)');
registerAssembly('tank', (p) => {
  const r = n(p.r, 40), h = n(p.h, 96), style = p.style ?? 'cylinder', T = tx(p, 'texture', '#8a8e92'), leg = n(p.leg_h, style === 'sphere' ? r * 0.8 : 8);
  const parts = [];
  if (style === 'sphere') parts.push({ type: 'dome', r, sphere: true, rings: 4, segments: 14, at: [0, leg + r, 0], texture: T });
  else if (style === 'capsule') parts.push({ type: 'revolve', profile: [[0, 0], [r * 0.7, r * 0.08], [r, r * 0.4], [r, h - r * 0.4], [r * 0.7, h - r * 0.08], [0, h]], segments: 14, at: [0, leg, 0], texture: T });
  else parts.push({ type: 'cylinder', r, h, segments: 14, at: [0, leg, 0], texture: T }, { type: 'dome', r, h: r * 0.3, at: [0, leg + h, 0], segments: 14, texture: T, base: false });
  const legs = Math.max(0, Math.round(n(p.legs, 4)));
  for (let i = 0; i < legs; i++) { const a = (2 * Math.PI * (i + 0.5)) / legs; parts.push({ type: 'beam', from: [Math.sin(a) * r * 0.9, 0, Math.cos(a) * r * 0.9], to: [Math.sin(a) * r * 0.75, leg + (style === 'sphere' ? r : 6), Math.cos(a) * r * 0.75], s: 4, texture: '#4b5059' }); }
  if (style !== 'sphere') for (let b = 1; b <= Math.round(n(p.bands, 2)); b++) parts.push({ type: 'cylinder', r: r + 1, h: 3, segments: 14, at: [0, leg + (h * b) / (Math.round(n(p.bands, 2)) + 1), 0], color: tx(p, 'band', '#d09a28') });
  if (p.ladder !== false && style !== 'sphere') parts.push({ type: 'ladder', at: [0, leg, r + 2], h });
  return { parts };
}, 'r?:40,h?:96,style?:cylinder|sphere|capsule,legs?:4,bands?:2,ladder?:true,textures:{texture,band}');
registerAssembly('silo', (p) => {
  const r = n(p.r, 48), h = n(p.h, 240), T = tx(p, 'texture', '#77736b');
  return { parts: [{ type: 'cylinder', r, h, segments: 16, texture: T }, { type: 'cone', r: r + 2, h: r * 0.5, segments: 16, at: [0, h, 0], texture: tx(p, 'roof', '#5a5f68') }, { type: 'ladder', at: [0, 0, r + 2], h }, { type: 'catwalk', len: r * 1.2, w: 16, at: [r + 8, h * 0.6, 0], rails: 'left' }, { type: 'light', at: [0, h + r * 0.5 + 4, 0], color: '#ff3030', intensity: 0.5, range: 90, bulb: 2 }] };
}, 'r?:48,h?:240 (silo with cone roof, ladder, catwalk, beacon)');
registerAssembly('crane', (p, k) => {
  const h = n(p.h, 240), boom = n(p.boom, 200), T = tx(p, 'texture', '#c89a28'), N = k.node();
  const parts = [{ type: 'truss', from: [0, 0, 0], to: [0, h, 0], w: 16, h: 16, bay: 16, style: 'warren', chord: 2, brace: 1.2, texture: T }];
  parts.push({ type: 'truss', name: N, from: [0, h + 8, -boom * 0.3], to: [0, h + 8, boom], w: 10, h: 14, bay: 16, section: 'tri', chord: 1.8, brace: 1, texture: T });
  const at = (q) => (N ? { parent: N, ...q } : q);
  parts.push({ type: 'box', w: 14, h: 12, d: 14, at: [0, h - 2, 10], texture: tx(p, 'cab', '#3a3e45'), ...(N ? { parent: N } : {}) });
  parts.push({ type: 'box', w: 18, h: 14, d: 20, at: [0, h - 4, -boom * 0.3], color: '#55585e', ...(N ? { parent: N } : {}) });
  parts.push({ type: 'tube', from: [0, h + 2, boom * 0.8], to: [0, h * 0.4, boom * 0.8], r: 0.5, sides: 4, color: '#1e2024', ...at({}) });
  parts.push({ type: 'box', w: 8, h: 6, d: 8, at: [0, h * 0.4 - 6, boom * 0.8], color: '#d09a28', ...at({}) });
  parts.push({ type: 'light', at: [0, h + 24, boom], color: '#ff3030', intensity: 0.6, range: 90, bulb: 2, ...at({}) });
  const clips = N ? { [p.clip ?? `${k.id}_slew`]: { loop: true, duration: 16, keys: [{ t: 0, parts: { [N]: { rot: [0, -60, 0] } } }, { t: 8, parts: { [N]: { rot: [0, 60, 0] } }, ease: 'smooth' }] } } : {};
  return { parts, clips };
}, 'h?:240,boom?:200 (tower crane: lattice mast, jib, counterweight, cab, hook cable; named: clip <name>_slew)');
registerAssembly('gantry', (p) => {
  const span = n(p.span, 192), h = n(p.h, 128), T = tx(p, 'texture', '#c89a28');
  return { parts: [
    { type: 'truss', from: [-span / 2, 0, 0], to: [-span / 2, h, 0], w: 16, bay: 16, texture: T },
    { type: 'truss', from: [span / 2, 0, 0], to: [span / 2, h, 0], w: 16, bay: 16, texture: T },
    { type: 'truss', from: [-span / 2 - 8, h + 8, 0], to: [span / 2 + 8, h + 8, 0], w: 16, h: 16, bay: 16, style: 'pratt', texture: T },
    { type: 'box', w: 20, h: 12, d: 22, at: [n(p.trolley, 0), h - 6, 0], color: '#3a3e45' },
  ] };
}, 'span?:192,h?:128,trolley?:0 (gantry: two lattice legs + beam + trolley)');
registerAssembly('pipeline', (p) => {
  const path = p.path ?? [[0, 24, -128], [0, 24, 128]], r = n(p.r, 6), every = n(p.supports, 64), T = tx(p, 'texture', '#6a6f78');
  const parts = [{ type: 'tube', path, r, sides: 8, texture: T, curve: p.curve }];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), k2 = Math.max(1, Math.round(L / every));
    for (let j = 0; j < k2; j++) { const f = (j + 0.5) / k2, q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; if (q[1] > r + 1) parts.push({ type: 'beam', from: [q[0], 0, q[2]], to: [q[0], q[1] - r, q[2]], s: 3, texture: '#4b5059' }); parts.push({ type: 'tube', path: [[q[0] - 0.1 * (b[0] - a[0]) / L * 6, q[1], q[2] - 0.1 * (b[2] - a[2]) / L * 6], [q[0] + 0.1 * (b[0] - a[0]) / L * 6, q[1], q[2] + 0.1 * (b[2] - a[2]) / L * 6]], r: r * 1.25, sides: 8, color: '#3a3e45' }); }
  }
  return { parts };
}, 'path:[[x,y,z],..],r?:6,supports?:64 px,curve? (pipe + support legs + flanges)');
registerAssembly('scaffold', (p) => {
  const w = n(p.w, 96), d = n(p.d, 32), h = n(p.h, 192), levels = Math.max(1, Math.round(n(p.levels, 3))), T = tx(p, 'texture', '#8a8e92');
  const parts = [];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'beam', from: [x * w / 2, 0, z * d / 2], to: [x * w / 2, h, z * d / 2], s: 2, texture: T });
  for (let i = 1; i <= levels; i++) { const y = (h * i) / levels; parts.push({ type: 'catwalk', len: w, w: d, at: [0, y, 0], rotate: [0, 90, 0], rails: 'both' }); }
  for (const z of [1, -1]) parts.push({ type: 'truss', from: [-w / 2, 0, z * d / 2], to: [w / 2, 0, z * d / 2], section: 'flat', w: 2, h: h, bay: w / 3, style: 'x', chord: 1.2, brace: 1, texture: T, at: [0, h / 2, 0] });
  return { parts };
}, 'w?:96,d?:32,h?:192,levels?:3 (scaffold: posts, x-braced faces, grated decks with rails)');
registerAssembly('ladder_cage', (p) => ASSEMBLIES.ladder(p, {}), 'ladder alias');
registerAssembly('hangar_shell', (p) => {
  const w = n(p.w, 384), d = n(p.d, 512), h = n(p.h, 192), th = n(p.thick, 8), segs = Math.max(4, Math.round(n(p.segments, 10)));
  const arc = (r, rev) => { const pts = []; for (let i = 0; i <= segs; i++) { const a = Math.PI * (i / segs); pts.push([r2(-Math.cos(a) * r * (w / 2) / (w / 2)), r2(Math.sin(a) * r * (h / (w / 2)))]); } return rev ? pts.reverse() : pts; };
  const outer = arc(w / 2), inner = arc(w / 2 - th, true);
  const parts = [{ type: 'shape', points: [...outer, ...inner], d, plane: 'xy', texture: tx(p, 'texture', '#6a6f78'), material: 'painted_metal' }];
  for (let i = 0; i <= 4; i++) parts.push({ type: 'tube', path: arc(w / 2 + 1).map(([x, y]) => [x, y, -d / 2 + (d * i) / 4]), r: 3, sides: 4, texture: '#3a3e45', caps: false });
  parts.push({ type: 'box', w: w * 0.6, h: 3, d: 6, at: [0, h * 0.82, d / 2], ...glow('#ffd890') });
  parts.push({ type: 'light', at: [0, h * 0.8, 0], color: '#d8e8ff', intensity: 1.2, range: w, bulb: false });
  return { parts };
}, 'w?:384,d?:512,h?:192,thick?:8,segments?:10 (arched hangar shell open at both ends, ribs, door light bar)');
registerAssembly('hab_module', (p) => {
  const L = n(p.len, 192), r = n(p.r, 48), T = tx(p, 'texture', '#c8c4b8');
  const parts = [{ type: 'hull', length: L, width: r * 2, height: r * 2, plan: [[0, r * 0.8], [0.08, r], [0.92, r], [1, r * 0.8]], profile: [[0, r * 1.8 + 20, 20 + r * 0.2], [0.08, r * 2 + 20, 20], [0.92, r * 2 + 20, 20], [1, r * 1.8 + 20, 20 + r * 0.2]], section: 2, rings: 6, segments: 12, panel_lines: { rings: [0.33, 0.66], width: 2, depth: 1 }, texture: T, rotate: [0, 90, 0] }];
  parts.push({ type: 'box', w: L * 0.7, h: 4, d: 1, at: [0, 20 + r * 1.25, r - 2], ...glow(p.window ?? '#ffd890') }, { type: 'box', w: L * 0.7, h: 4, d: 1, at: [0, 20 + r * 1.25, -r + 2], ...glow(p.window ?? '#ffd890') });
  for (const x of [-L * 0.35, L * 0.35]) for (const z of [r * 0.6, -r * 0.6]) parts.push({ type: 'beam', from: [x, 0, z], to: [x, 24, z * 0.7], s: 4, texture: '#4b5059' });
  parts.push({ type: 'box', w: 24, h: 40, d: 30, at: [L / 2 + 8, 20, 0], texture: T, bevel: 2 }, { type: 'light', at: [L / 2 + 22, 58, 0], color: '#ffb040', intensity: 0.5, range: 80, bulb: 2 });
  return { parts };
}, 'len?:192,r?:48,window? (colony habitat module: cylinder on legs, window bands, airlock porch)');
registerAssembly('rock_platform', (p, k) => {
  const w = n(p.w, 256), d = n(p.d, 192), h = n(p.h, 96), seed = Number(p.seed ?? 1);
  const parts = [{ type: 'rock', w: w * 1.15, h: h * 1.3, d: d * 1.15, at: [0, -h * 1.1, 0], seed, detail: 2, rough: 0.3, texture: tx(p, 'rock', '#5d5650') }];
  parts.push({ type: 'box', w, h: 6, d, at: [0, 0, 0], texture: tx(p, 'deck', '#4a4f57'), material: 'painted_metal' });
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'beam', from: [x * w * 0.45, -h * 0.5, z * d * 0.45], to: [x * w * 0.4, 0, z * d * 0.4], s: 6, texture: '#4b5059' });
  for (const [side, len, at, rot] of [['n', w, [0, 6, d / 2 - 2], 90], ['s', w, [0, 6, -d / 2 + 2], 90], ['e', d, [w / 2 - 2, 6, 0], 0], ['w', d, [-w / 2 + 2, 6, 0], 0]]) if (!(p.open || []).includes(side)) parts.push({ type: 'catwalk', len, w: 4, at, rotate: [0, rot, 0], rails: 'left', texture: '#3a3e45', kick: false });
  parts.push({ type: 'marker', kind: 'walkable', at: [0, 6, 0], data: { w, d } });
  return { parts };
}, 'w?:256,d?:192,h?:96,seed?,open?:[sides without rails] (deck anchored on a rock outcrop by struts)');

// ---------- interior city kit ----------
registerAssembly('shaft', (p) => {
  const R = n(p.r, 256), depth = n(p.depth, 768), levels = Math.max(1, Math.round(n(p.levels, 3))), sides = Math.max(8, Math.round(n(p.sides, 16))), T = tx(p, 'texture', '#55524c');
  const parts = [{ type: 'revolve', profile: [[R, 0], [R, depth]], segments: sides, smooth: false, inside: 'only', texture: T }];
  for (let i = 0; i < levels; i++) {
    const y = r2((depth * (i + 0.6)) / (levels + 0.4)), wk = n(p.walk_w, 48);
    parts.push({ type: 'revolve', profile: [[R - wk, y], [R, y], [R, y - 4], [R - wk, y - 4], [R - wk, y]], segments: sides, smooth: false, texture: tx(p, 'deck', '#4a4f57') });
    parts.push({ type: 'tube', path: [...Array(sides + 1).keys()].map((j) => { const a = (2 * Math.PI * j) / sides; return [r2(Math.sin(a) * (R - wk + 1)), y + 32, r2(Math.cos(a) * (R - wk + 1))]; }), r: 1.2, sides: 4, texture: '#8a6a2a', caps: false });
    parts.push({ type: 'light', at: [0, y + 40, R - wk - 10], color: i % 2 ? '#ff6a30' : '#60c8ff', intensity: 1, range: R * 1.2, bulb: false, array: { count: 3, rotate: [0, 120, 0], about: [0, 0, 0] } });
  }
  parts.push({ type: 'god_ray', w: R * 0.5, h: depth * 0.9, at: [0, depth, 0], color: '#a8c8ff', opacity: 0.12, cross: 3 });
  return { parts };
}, 'r?:256,depth?:768,levels?:3,sides?:16,walk_w?:48 (vertical city shaft: inward wall, ring walkways with rails, level lights, light shaft)');
registerAssembly('atrium', (p) => {
  const w = n(p.w, 384), d = n(p.d, 384), h = n(p.h, 480), levels = Math.max(1, Math.round(n(p.levels, 3))), T = tx(p, 'texture', '#55524c'), bal = n(p.balcony, 48);
  const parts = [];
  for (const [x, z, ww, dd] of [[0, d / 2, w, 8], [0, -d / 2, w, 8], [w / 2, 0, 8, d], [-w / 2, 0, 8, d]]) parts.push({ type: 'box', w: ww, h, d: dd, at: [x, 0, z], texture: T });
  for (let i = 1; i <= levels; i++) {
    const y = r2((h * i) / (levels + 1));
    for (const [x, z, len, rot] of [[0, d / 2 - bal / 2, w - 8, 90], [0, -d / 2 + bal / 2, w - 8, 90], [w / 2 - bal / 2, 0, d - 8 - 2 * bal, 0], [-w / 2 + bal / 2, 0, d - 8 - 2 * bal, 0]]) parts.push({ type: 'catwalk', len, w: bal, at: [x, y, z], rotate: [0, rot, 0], rails: 'right', texture: tx(p, 'deck', '#4a4f57') });
  }
  return { parts };
}, 'w?:384,d?:384,h?:480,levels?:3,balcony?:48 (rectangular atrium well with balcony levels)');
registerAssembly('bridge_walk', (p) => {
  const L = n(p.len, 192), w = n(p.w, 40);
  return { parts: [{ type: 'catwalk', len: L, w }, { type: 'truss', from: [0, -14, -L / 2], to: [0, -14, L / 2], w: w * 0.8, h: 22, bay: 24, style: 'warren', chord: 2, brace: 1.2, texture: tx(p, 'texture', '#4b5059') }] };
}, 'len?:192,w?:40 (walkway bridge: grated deck over a truss)');
registerAssembly('lift_shaft', (p, k) => {
  const h = n(p.h, 480), w = n(p.w, 64), T = tx(p, 'texture', '#4b5059'), N = k.node(), ride = n(p.ride, h * 0.7);
  const parts = [{ type: 'truss', from: [0, 0, 0], to: [0, h, 0], w, h: w, bay: w, style: 'x', chord: 3, brace: 1.5, texture: T }];
  parts.push({ type: 'box', w: w + 12, h: 8, d: w + 12, at: [0, h, 0], texture: T });
  parts.push({ type: 'box', name: N, w: w - 10, h: 2, d: w - 10, at: [0, 8, 0], texture: tx(p, 'floor', '#3a3e45') });
  const cage = N ? { parent: N } : {};
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'beam', from: [x * (w / 2 - 5), 8, z * (w / 2 - 5)], to: [x * (w / 2 - 5), 70, z * (w / 2 - 5)], s: 1.5, texture: '#8a6a2a', ...cage });
  parts.push({ type: 'box', w: w - 10, h: 2, d: w - 10, at: [0, 70, 0], texture: T, ...cage });
  parts.push({ type: 'tube', from: [0, 72, 0], to: [0, h, 0], r: 0.8, sides: 4, color: '#1e2024' });
  parts.push({ type: 'light', at: [0, 64, 0], color: '#ffb060', intensity: 0.6, range: 80, bulb: 2, ...cage });
  const clips = N ? { [p.clip ?? `${k.id}_ride`]: { loop: true, duration: 14, keys: [{ t: 0, parts: {} }, { t: 6, parts: { [N]: { at: [0, ride, 0] } }, ease: 'smooth' }, { t: 7, parts: { [N]: { at: [0, ride, 0] } } }, { t: 13, parts: {}, ease: 'smooth' }] } } : {};
  return { parts, clips };
}, 'h?:480,w?:64,ride? (open lattice lift shaft with a hanging cage on a cable; named: cage node, clip <name>_ride)');
registerAssembly('cable_web', (p, k) => {
  const A = p.from ?? [-128, 200, 0], B = p.to ?? [128, 200, 0], count = Math.max(1, Math.round(n(p.count, 6))), sag = n(p.sag, 24), spread = n(p.spread, 32);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const j = () => (k.rnd() - 0.5) * spread;
    parts.push({ type: 'tube', from: [A[0] + j(), A[1] + j() * 0.5, A[2] + j()], to: [B[0] + j(), B[1] + j() * 0.5, B[2] + j()], sag: r2(sag * (0.6 + k.rnd() * 0.8)), r: r2(0.5 + k.rnd() * 0.8), sides: 4, segments: 10, color: tx(p, 'color', '#18191c') });
  }
  if (p.lamps) for (let i = 0; i < Math.round(n(p.lamps, 0)); i++) { const f = (i + 1) / (Number(p.lamps) + 1); parts.push({ type: 'light', at: [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f - sag * 0.9, A[2] + (B[2] - A[2]) * f], color: p.lamp_color ?? '#ffb060', intensity: 0.5, range: 90, bulb: 2.5 }); }
  return { parts };
}, 'from,to,count?:6,sag?:24,spread?:32,seed?,lamps?:0 (sagging cable bundle between two anchors; lamps hang from it)');
registerAssembly('pipe_wall', (p, k) => {
  const w = n(p.w, 128), h = n(p.h, 96), count = Math.max(1, Math.round(n(p.count, 6))), T = tx(p, 'texture', '#3a3e45');
  const parts = [{ type: 'box', w, h, d: 4, at: [0, 0, -2], texture: T }];
  for (let i = 0; i < count; i++) {
    const r = r2(1.5 + k.rnd() * 3.5), x = r2(-w / 2 + ((i + 0.5) * w) / count + (k.rnd() - 0.5) * 6);
    const bend = k.rnd() > 0.6;
    parts.push({ type: 'tube', path: bend ? [[x, 0, r + 1], [x, h * 0.6, r + 1], [x + 12, h * 0.6 + 8, r + 1], [x + 12, h, r + 1]] : [[x, 0, r + 1], [x, h, r + 1]], r, sides: 6, texture: tx(p, 'pipe', '#6a6f78'), caps: false });
    if (k.rnd() > 0.5) parts.push({ type: 'cylinder', r: r * 1.5, h: 3, segments: 6, at: [x, r2(h * (0.2 + k.rnd() * 0.3)), r + 1], color: '#a03028' });
  }
  parts.push({ type: 'light', at: [w / 2 - 6, h - 10, 6], color: '#ff6a30', intensity: 0.3, range: 60, bulb: 1.5 });
  return { parts };
}, 'w?:128,h?:96,count?:6,seed? (backing wall with vertical / bent pipes and valves)');
registerAssembly('market_stall', (p, k) => {
  const w = n(p.w, 64), d = n(p.d, 48), h = n(p.h, 72), aw = p.awning ?? ['#a03028', '#2f6a5a', '#c89a28', '#4a3a7a'][Math.floor(k.rnd() * 4)];
  const parts = [{ type: 'box', w, h: 30, d: 14, at: [0, 0, d / 2 - 7], texture: tx(p, 'counter', '#5a4a3a'), bevel: 1 }];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'beam', from: [x * w / 2, 0, z * d / 2], to: [x * w / 2, h, z * d / 2], s: 2, texture: '#3a3e45' });
  parts.push({ type: 'wedge', w: w + 8, h: 10, d: d + 12, top_d: 0, at: [0, h, 0], color: aw });
  for (let i = 0; i < 3; i++) parts.push({ type: 'box', w: r2(10 + k.rnd() * 8), h: r2(8 + k.rnd() * 8), d: r2(10 + k.rnd() * 6), at: [r2((k.rnd() - 0.5) * w * 0.7), 0, r2(-d / 2 + 10 + k.rnd() * 10)], color: ['#6a5040', '#4a5a3a', '#5a5a60'][i] });
  parts.push({ type: 'light', at: [0, h - 6, 0], color: p.lamp ?? '#ffb060', intensity: 0.7, range: 80, bulb: 2.5 });
  if (p.sign !== false) parts.push(k.rnd() > 0.5 || p.neon ? { type: 'neon', text: String(p.sign ?? pickText(k)), px: 2, r: 0.6, color: p.sign_color ?? ['#ff3fd0', '#40e0ff', '#ffd040', '#60ff80'][Math.floor(k.rnd() * 4)], at: [0, h + 12, d / 2 + 2] } : { type: 'sign', text: String(p.sign ?? pickText(k)), h: 12, color: '#ffd040', at: [0, h + 12, d / 2 + 2] });
  return { parts };
}, 'w?:64,d?:48,h?:72,awning?,sign?:<text>|false,neon?,sign_color?,lamp?,seed? (stall facing +z: counter, posts, awning, crates, lamp, neon or lit sign)');
const STALL_WORDS = ['NOODLE', 'FIX', 'AIR', 'PARTS', 'BAR', 'SCRAP', 'TEA', 'CHIPS', 'OPEN', 'MEDS', 'ORE', 'SLEEP'];
const pickText = (k) => STALL_WORDS[Math.floor(k.rnd() * STALL_WORDS.length)];
registerAssembly('sign_frame', (p, k) => {
  const style = p.style ?? 'neon', w = n(p.w, 64), h = n(p.h, 24), text = String(p.text ?? 'OPEN'), c = p.color ?? '#ff3fd0';
  const parts = [{ type: 'beam', from: [0, h + 4, 0], to: [0, h + 4, -16], s: 2, texture: '#2a2c31' }];
  if (style === 'neon') parts.push({ type: 'neon', text, px: n(p.px, Math.max(1.5, h / 9)), color: c, at: [0, 2, 1] });
  else if (style === 'blade') parts.push({ type: 'sign', text, h: w, d: 4, color: c, double: true, at: [0, -w / 2 + h, 0], rotate: [0, 90, 90] });
  else parts.push({ type: 'sign', text, h, w, color: c });
  return { parts };
}, 'text,style?:neon|box|blade,w?,h?,color?,px? (bracket + neon tube text / lit sign box / vertical blade sign)');
