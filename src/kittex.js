// The sci-fi kit texture set: 16-64 px PSX-style pixel-art textures painted in code (painted hull
// panels with seams, bolts, hatches, chipped paint and dirt streaks; tread plate; see-through
// grating; wall and ceiling panels; hazard trim; rust; concrete; rock; pipe; awning fabric; crate,
// barrel and container faces; MFD screen; wear and grime overlays). Each texture carries height
// (-> normal map), metal and rough (-> metallicRoughness) and, where it glows, emissive data.
//
// Two ways in: art_model kit paints them as canvases (editable layers), and texture references
// "kit_<name>" or "kit_<name>_<rrggbb>" (tinted) resolve to the same textures when no canvas of
// that name exists, so kit pieces, templates and generators are textured by default.
import { hash3, BAYER4 } from './util.js';
import { heightToNormal, mrTexture } from './surface.js';

const hex = (c) => { const v = parseInt(String(c).replace('#', '').slice(0, 6), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]; };
const shade = (c, k) => [Math.max(0, Math.min(255, c[0] * k)), Math.max(0, Math.min(255, c[1] * k)), Math.max(0, Math.min(255, c[2] * k)), c[3] ?? 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 255];
const dith = (x, y) => (BAYER4[y & 3][x & 3] / 16 - 0.5) * 0.04;

export const KIT_COLORS = { hull: '#7a8089', hull_dark: '#4f555e', metal: '#5f646d', metal_dark: '#2c2f35', deck: '#50555c', wall: '#5b6068', ceiling: '#33363c', glow: '#7fd8ff', hazard: '#d09a28', accent: '#a8432c', rock: '#5d5650', concrete: '#77736b', glass: '#7fc8e8', screen: '#40ffb0', rust: '#7a4a2c', panel_light: '#b8bcc0', rubber: '#24262a', leather: '#3a3230', fabric: '#a03028', crate: '#5d6a3c', barrel: '#2f5a7a', container: '#8a3a2a', pipe: '#6a6f78', grate: '#4a5058' };

/**
 * Painted metal panels: staggered panels pw x ph with dark seams, a lit top/left bevel, corner
 * bolts, an access hatch on some panels, paint tone per panel, chipped paint (bare metal) along
 * the seams and dirt streaks running down from the bolts.
 */
const panel = (base, seed, { pw = 32, ph = 16, chips = 0.5, dirt = 0.5, hatch = 0.22, bolts = true } = {}) => (x, y) => {
  const N = (a, b, s) => hash3(a, b, seed * 131 + s);
  const row = Math.floor(y / ph), off = row % 2 ? pw / 2 : 0, col = Math.floor((x + off) / pw);
  const px = (x + off) % pw, py = y % ph;
  const seam = px === 0 || py === 0, hl = !seam && (px === 1 || py === 1), lo = px === pw - 1 || py === ph - 1;
  const bolt = bolts && (px === 3 || px === pw - 3) && (py === 3 || py === ph - 3);
  const tone = 0.93 + N(col, row, 1) * 0.12;
  const hasHatch = N(col, row, 2) < hatch, hx = px >= 6 && px <= pw - 7 && py >= 4 && py <= ph - 5;
  const hEdge = hasHatch && hx && (px === 6 || px === pw - 7 || py === 4 || py === ph - 5);
  const hIn = hasHatch && hx && !hEdge;
  const nearSeam = px <= 2 || py <= 2 || px >= pw - 3 || py >= ph - 3;
  const chip = (nearSeam && N(x >> 1, y, 3) < 0.11 * chips) || N(x, y, 4) < 0.006 * chips;
  // dirt streaks: some columns streak down the panel from the top seam / bolts
  const streak = N(x, row, 5) < 0.18 * dirt ? (py / ph) * 0.22 * dirt : 0;
  let c = shade(hex(base), tone - streak + dith(x, y)), h = 0.62, metal = 0.2, rough = 0.55;
  if (seam) { c = shade(hex(base), 0.42); h = 0; rough = 0.9; }
  else if (hl) { c = shade(hex(base), tone * 1.13); h = 0.7; }
  else if (lo) { c = shade(hex(base), tone * 0.8); h = 0.55; }
  if (hEdge) { c = shade(hex(base), 0.6); h = 0.4; }
  else if (hIn) { c = shade(c, 0.97); h = 0.52; }
  if (chip && !seam) { c = shade(hex('#9aa0a6'), 0.9 + N(x, y, 6) * 0.2); metal = 0.9; rough = 0.35; h = 0.55; }
  if (bolt) { c = shade(hex('#b4b8bc'), 1); h = 1; metal = 0.9; rough = 0.3; }
  if (bolt === false && bolts && ((px === 3 || px === pw - 3) && (py === 4 || py === ph - 2))) c = shade(c, 0.85); // bolt shadow
  return { c, h, metal, rough };
};

/** Painters: name -> {w, h, fn(x, y) -> {c, h?, metal?, rough?, emissive?}} for a base colour. */
const PAINTERS = {
  hull: { w: 64, h: 64, base: 'hull', fn: (b, s) => panel(b, s, { pw: 32, ph: 16 }) },
  armor: { w: 64, h: 64, base: 'hull', fn: (b, s) => panel(b, s + 3, { pw: 64, ph: 32, chips: 0.25, dirt: 0.35, hatch: 0.12 }) },
  // one armour slab fitted per face (tile:false): worn bare-metal edges along the border (chamfers
  // read as edge wear), a lit inner lip, a calm painted field with faint scuffs, corner bolts
  slab: {
    w: 32, h: 32, base: 'hull',
    fn: (b, s) => (x, y) => {
      const N = (a, c, k) => hash3(a, c, s * 97 + k);
      const e = Math.min(x, y, 31 - x, 31 - y);
      const tone = 0.95 + N(x >> 3, y >> 3, 1) * 0.07 + dith(x, y) - (y / 31) * 0.06;
      if (e === 0) return { c: shade(hex('#a2a6aa'), 0.85 + N(x, y, 2) * 0.25), h: 0.5, metal: 0.9, rough: 0.35 };
      if (e === 1) return N(x, y, 3) < 0.45 ? { c: shade(hex('#8e9296'), 0.9 + N(x, y, 4) * 0.2), h: 0.6, metal: 0.85, rough: 0.4 } : { c: shade(hex(b), 1.16), h: 0.7 };
      if (e === 2 && N(x >> 1, y >> 1, 5) < 0.18) return { c: shade(hex('#7c8084'), 1), h: 0.6, metal: 0.8, rough: 0.45 };
      if ((x === 4 || x === 27) && (y === 4 || y === 27)) return { c: shade(hex(b), 0.55), h: 0.3 };
      const scuff = N(x, y, 6) < 0.012 ? 1.25 : 1;
      return { c: shade(hex(b), tone * scuff), h: 0.62, metal: 0.25, rough: 0.5 };
    },
  },
  hull_dark: { w: 64, h: 64, base: 'hull_dark', fn: (b, s) => panel(b, s + 1, { pw: 32, ph: 16, chips: 0.7, dirt: 0.7 }) },
  accent: { w: 32, h: 32, base: 'accent', fn: (b, s) => panel(b, s + 2, { pw: 32, ph: 16, hatch: 0, chips: 0.8 }) },
  metal: {
    w: 32, h: 32, base: 'metal',
    fn: (b, s) => (x, y) => {
      const seam = y % 16 === 0, bolt = (x % 16 === 3 || x % 16 === 12) && y % 16 === 3;
      const brush = 0.92 + hash3(0, y, s * 7 + 1) * 0.1 + hash3(x >> 2, y, s * 7 + 2) * 0.05 + dith(x, y);
      if (seam) return { c: shade(hex(b), 0.5), h: 0, metal: 0.8, rough: 0.7 };
      if (bolt) return { c: shade(hex('#b8bcc0'), 1), h: 1, metal: 1, rough: 0.3 };
      return { c: shade(hex(b), y % 16 === 1 ? brush * 1.12 : brush), h: 0.6, metal: 0.85, rough: 0.38 + hash3(x, y, s) * 0.08 };
    },
  },
  metal_dark: {
    w: 32, h: 32, base: 'metal_dark',
    fn: (b, s) => (x, y) => {
      const g = x % 8 === 0, n = 0.85 + hash3(x, y, s * 5 + 4) * 0.25 + dith(x, y);
      return { c: shade(hex(b), g ? 0.6 : x % 8 === 1 ? n * 1.2 : n), h: g ? 0.1 : 0.6, metal: 0.6, rough: 0.6 };
    },
  },
  deck: {
    // diamond tread plate in 32 px plates, corner bolts, dirt in the seams
    w: 32, h: 32, base: 'deck',
    fn: (b, s) => (x, y) => {
      const seam = x === 0 || y === 0, bolt = (x === 3 || x === 28) && (y === 3 || y === 28);
      const cx = x >> 3, cy = y >> 3, lx = x & 7, ly = y & 7;
      const lug = (cx + cy) % 2 ? (lx + ly === 7 && lx >= 2 && lx <= 5) : (lx === ly && lx >= 2 && lx <= 5);
      const lugLo = (cx + cy) % 2 ? (lx + ly === 8 && lx >= 3 && lx <= 6) : (lx === ly + 1 && lx >= 3 && lx <= 6);
      const grime = (x <= 2 || y <= 2 || x >= 29 || y >= 29) && hash3(x, y, s * 3 + 9) < 0.45;
      if (seam) return { c: shade(hex(b), 0.4), h: 0, metal: 0.5, rough: 0.9 };
      if (bolt) return { c: shade(hex('#a8acb0'), 1), h: 1, metal: 0.9, rough: 0.35 };
      if (lug) return { c: shade(hex(b), 1.32), h: 0.95, metal: 0.85, rough: 0.3 };
      if (lugLo) return { c: shade(hex(b), 0.78), h: 0.5, metal: 0.7, rough: 0.5 };
      return { c: shade(hex(b), (grime ? 0.72 : 0.95 + hash3(x >> 1, y >> 1, s * 3 + 8) * 0.08) + dith(x, y)), h: 0.55, metal: 0.65, rough: 0.55 };
    },
  },
  grate: {
    // see-through floor grating (alpha holes): bars every 4 px, cross bars every 8, solid border
    w: 32, h: 32, base: 'grate',
    fn: (b) => (x, y) => {
      const edge = x === 0 || y === 0, bar = x % 4 === 0 || y % 8 === 0, lit = x % 4 === 1 || y % 8 === 1;
      if (edge) return { c: shade(hex(b), 0.7), h: 0.8, metal: 0.8, rough: 0.5 };
      if (bar) return { c: shade(hex(b), 1.05), h: 1, metal: 0.85, rough: 0.4 };
      if (lit && (x % 4 === 1 ? y % 8 !== 0 : true)) return { c: shade(hex(b), 0.62), h: 0.7, metal: 0.8, rough: 0.5 };
      return { c: [0, 0, 0, 0], h: 0 };
    },
  },
  wall: {
    // two wall panels per tile: inset panel with vent slots | inset panel with a stencil label and status light
    w: 64, h: 32, base: 'wall',
    fn: (b, s, C) => (x, y) => {
      const lx = x % 32, right = x >= 32;
      const frame = lx === 0 || y === 0, hl = lx === 1 || y === 1, inEdge = lx >= 4 && lx <= 27 && y >= 4 && y <= 27 && (lx === 4 || lx === 27 || y === 4 || y === 27), inset = lx > 4 && lx < 27 && y > 4 && y < 27;
      const bolt = (lx === 2 || lx === 29) && (y === 2 || y === 29);
      const grime = y >= 24 && hash3(x, y, s * 9 + 1) < (y - 23) / 14;
      let c = shade(hex(b), 1 + dith(x, y)), h = 0.7, metal = 0.25, rough = 0.6, emissive;
      if (frame) { c = shade(hex(b), 0.45); h = 0; }
      else if (hl) c = shade(hex(b), 1.15);
      else if (bolt) { c = hex('#a8acb0'); h = 1; metal = 0.9; rough = 0.3; }
      else if (inEdge) { c = shade(hex(b), y === 4 || lx === 4 ? 0.62 : 1.12); h = 0.35; }
      else if (inset) {
        c = shade(hex(b), 0.86 + hash3(x >> 2, y >> 2, s * 9 + 2) * 0.06 + dith(x, y)); h = 0.3;
        if (!right && y >= 14 && y <= 24 && lx >= 8 && lx <= 23 && y % 3 === 2) { c = shade(hex(b), 0.35); h = 0.05; }
        if (right && y >= 8 && y <= 10 && lx >= 8 && lx <= 20) { c = hash3(lx, y, 4) < 0.7 ? hex('#d8d2c0') : c; }
        if (right && y >= 20 && y <= 21 && lx >= 21 && lx <= 23) { c = hex(C.glow); emissive = hex(C.glow); h = 0.4; }
      }
      if (grime && !frame) c = shade(c, 0.78);
      return { c, h, metal, rough, ...(emissive ? { emissive } : {}) };
    },
  },
  ceiling: {
    w: 32, h: 32, base: 'ceiling',
    fn: (b, s, C) => (x, y) => {
      const seam = x === 0 || y === 0, grille = x >= 6 && x <= 25 && y >= 10 && y <= 21, slot = grille && x % 3 === 0;
      const lamp = x >= 12 && x <= 19 && y >= 2 && y <= 3;
      if (seam) return { c: shade(hex(b), 0.45), h: 0, metal: 0.4, rough: 0.8 };
      if (lamp) return { c: hex('#e8f0ff'), emissive: hex('#c8d8f0'), h: 0.6 };
      if (slot) return { c: shade(hex(b), 0.3), h: 0.1, metal: 0.4, rough: 0.9 };
      if (grille) return { c: shade(hex(b), 1.25), h: 0.8, metal: 0.7, rough: 0.4 };
      return { c: shade(hex(b), 0.95 + hash3(x >> 1, y >> 1, s * 11) * 0.1 + dith(x, y)), h: 0.6, metal: 0.4, rough: 0.6 };
    },
  },
  hazard: {
    // diagonal hazard stripes with worn edges and dirt
    w: 32, h: 32, base: 'hazard',
    fn: (b, s) => (x, y) => {
      const yel = ((x + y) >> 2) % 2 === 0, wear = hash3(x, y, s * 13 + 1) < 0.07 || (y >= 29 && hash3(x, y, s * 13 + 2) < 0.5);
      const c = wear ? shade(hex('#8a8e92'), 0.9) : yel ? shade(hex(b), 0.94 + hash3(x >> 1, y >> 1, s * 13 + 3) * 0.1) : shade(hex('#1c1d20'), 1 + hash3(x, y, s * 13 + 4) * 0.3);
      return { c, h: wear ? 0.45 : 0.6, metal: wear ? 0.9 : 0.15, rough: wear ? 0.4 : 0.65 };
    },
  },
  rust: {
    w: 32, h: 32, base: 'rust',
    fn: (b, s) => (x, y) => {
      const v = hash3(x >> 2, y >> 2, s * 17) * 0.6 + hash3(x, y, s * 17 + 1) * 0.4, pit = hash3(x, y, s * 17 + 2) < 0.05;
      const bare = hash3(x >> 3, y >> 3, s * 17 + 3) > 0.78;
      const c = bare ? shade(hex('#6a6f78'), 0.9 + v * 0.2) : shade(hex(b), 0.7 + v * 0.55 - (pit ? 0.3 : 0));
      return { c, h: bare ? 0.7 : pit ? 0.2 : 0.4 + v * 0.3, metal: bare ? 0.85 : 0.1, rough: bare ? 0.45 : 0.95 };
    },
  },
  concrete: {
    w: 32, h: 32, base: 'concrete',
    fn: (b, s) => (x, y) => {
      const seam = x === 0 || y === 0, stain = hash3(x >> 3, (y + Math.floor(x * 0.2)) >> 2, s * 19) > 0.78;
      const crack = (x + Math.floor(hash3(0, y >> 2, s * 19 + 1) * 3)) % 23 === 7 && hash3(x, y >> 1, s * 19 + 2) < 0.6;
      const c = shade(hex(b), seam ? 0.6 : crack ? 0.55 : stain ? 0.78 : 0.9 + hash3(x, y, s * 19 + 3) * 0.14 + dith(x, y));
      return { c, h: seam || crack ? 0.1 : 0.5 + hash3(x, y, s * 19 + 4) * 0.1, rough: 0.92, metal: 0 };
    },
  },
  rock: {
    w: 32, h: 32, base: 'rock',
    fn: (b, s) => (x, y) => {
      const v = hash3(x >> 2, y >> 2, s * 23) * 0.5 + hash3(x, y, s * 23 + 1) * 0.3 + (hash3(x >> 3, y >> 3, s * 23 + 2) > 0.8 ? -0.2 : 0);
      const strata = (y + Math.floor(hash3(x >> 3, 0, s * 23 + 3) * 4)) % 11 === 0;
      return { c: shade(hex(b), (strata ? 0.6 : 0.68 + v * 0.6) + dith(x, y)), h: strata ? 0.1 : v, rough: 0.97 };
    },
  },
  pipe: {
    w: 16, h: 16, base: 'pipe',
    fn: (b) => (x, y) => {
      const band = y % 16 < 2, k = 0.72 + Math.sin(((x + 0.5) / 16) * Math.PI) * 0.42;
      return { c: band ? shade(hex('#2a2d33'), 1.2) : shade(hex(b), k), h: band ? 1 : 0.6, metal: band ? 0.5 : 0.85, rough: band ? 0.6 : 0.32 };
    },
  },
  fabric: {
    // awning canvas: woven stripes of the base colour and cream, dirty bottom edge
    w: 32, h: 32, base: 'fabric',
    fn: (b, s) => (x, y) => {
      const stripe = (x >> 3) % 2 === 0, weave = (x + y) % 2 ? 0.94 : 1.02;
      const dirt = y >= 26 ? (y - 25) * 0.05 : 0;
      const c = shade(stripe ? hex(b) : hex('#d8ccb0'), weave - dirt + hash3(x, y, s * 29) * 0.05);
      return { c, h: (x + y) % 2 ? 0.45 : 0.55, metal: 0, rough: 1 };
    },
  },
  crate: {
    // supply crate face: reinforced frame, corner plates, stencil stripe
    w: 32, h: 32, base: 'crate',
    fn: (b, s) => (x, y) => {
      const frame = x <= 2 || y <= 2 || x >= 29 || y >= 29, corner = (x <= 5 || x >= 26) && (y <= 5 || y >= 26);
      const brace = Math.abs(x - y) <= 1 && !frame, stencil = y >= 13 && y <= 18 && x >= 8 && x <= 23 && hash3(x >> 1, y, s * 31) < 0.55;
      let c = shade(hex(b), 0.94 + hash3(x >> 1, y >> 1, s * 31 + 1) * 0.1 + dith(x, y)), h = 0.5, metal = 0.1, rough = 0.75;
      if (frame) { c = shade(hex(b), x === 0 || y === 0 ? 0.5 : 0.78); h = 0.85; }
      if (corner) { c = shade(hex('#8a8e92'), 1); metal = 0.85; rough = 0.4; h = 1; }
      if (brace) { c = shade(hex(b), 0.82); h = 0.7; }
      if (stencil && !brace) c = shade(hex('#e0d8c0'), 0.9);
      return { c, h, metal, rough };
    },
  },
  barrel: {
    // barrel wrap: two rolled hoops, a hazard label, chipped paint
    w: 32, h: 32, base: 'barrel',
    fn: (b, s) => (x, y) => {
      const hoop = y === 6 || y === 7 || y === 24 || y === 25, rim = y === 0 || y === 31;
      const label = x >= 10 && x <= 21 && y >= 11 && y <= 19, labelHaz = label && ((x + y) >> 1) % 2 === 0 && y <= 12;
      const chip = hash3(x, y, s * 37) < 0.04;
      const k = 0.78 + Math.sin(((x + 0.5) / 32) * Math.PI * 2) * 0.12;
      let c = shade(hex(b), k + dith(x, y)), h = 0.5, metal = 0.3, rough = 0.5;
      if (hoop) { c = shade(hex(b), k * 1.25); h = 1; }
      if (rim) { c = shade(hex('#2a2d33'), 1); h = 0.3; }
      if (label) c = labelHaz ? hex('#d09a28') : shade(hex('#d8d4c8'), 0.95);
      if (chip && !label) { c = shade(hex('#9aa0a6'), 0.9); metal = 0.9; rough = 0.35; }
      return { c, h, metal, rough };
    },
  },
  container: {
    // corrugated side: ribs every 4 px, top / bottom rails, rust speckle, an ID stencil block
    w: 32, h: 32, base: 'container',
    fn: (b, s) => (x, y) => {
      const rib = x % 4, rail = y <= 1 || y >= 30, rust = hash3(x, y, s * 41) > 0.95 || (y >= 27 && hash3(x, y, s * 41 + 1) > 0.7);
      const id = y >= 4 && y <= 7 && x >= 4 && x <= 15 && hash3(x, y, s * 41 + 2) < 0.6 && rib !== 0;
      let c = shade(hex(b), rib === 0 ? 0.66 : rib === 1 ? 1.14 : 0.92 + hash3(x, y, s * 41 + 3) * 0.06), h = rib === 0 ? 0.2 : rib === 1 ? 1 : 0.7, metal = 0.35, rough = 0.6;
      if (rail) { c = shade(hex(b), 0.55); h = 0.9; }
      if (id) c = hex('#e8e4d8');
      if (rust && !rail) { c = shade(hex('#7a4a2c'), 0.9 + hash3(x, y, 3) * 0.2); rough = 0.95; metal = 0.05; }
      return { c, h, metal, rough };
    },
  },
  container_end: {
    // door end: two leaves, four locking bars, hinge blocks
    w: 32, h: 32, base: 'container',
    fn: (b, s) => (x, y) => {
      const bar = (x === 6 || x === 12 || x === 19 || x === 25) && y >= 2 && y <= 29, split = x === 15 || x === 16, rim = x <= 1 || x >= 30 || y <= 1 || y >= 30;
      const handle = (x === 7 || x === 13 || x === 20 || x === 26) && y >= 14 && y <= 17;
      let c = shade(hex(b), 0.9 + hash3(x >> 1, y >> 1, s * 43) * 0.08 + dith(x, y)), h = 0.5, metal = 0.35, rough = 0.6;
      if (rim) { c = shade(hex(b), 0.55); h = 0.9; }
      if (split) { c = shade(hex(b), 0.4); h = 0.1; }
      if (bar) { c = shade(hex('#9aa0a6'), 0.95); h = 1; metal = 0.9; rough = 0.35; }
      if (handle) { c = hex('#c8ccd0'); h = 1; metal = 0.9; }
      return { c, h, metal, rough };
    },
  },
  panel_light: {
    // neutral grey / white interior wall module: 32 x 64 panel, seams, an inset lower panel, bolts, a small grey label
    w: 32, h: 64, base: 'panel_light',
    fn: (b, s) => (x, y) => {
      const seam = x === 0 || y === 0 || y === 40, hl = x === 1 || y === 1 || y === 41, inset = x >= 4 && x <= 27 && y >= 44 && y <= 60;
      const inEdge = inset && (x === 4 || x === 27 || y === 44 || y === 60), bolt = (x === 3 || x === 28) && (y === 3 || y === 37);
      const label = x >= 6 && x <= 13 && y >= 6 && y <= 7, scuff = y > 56 && hash3(x, y, s * 61) < 0.12;
      let c = shade(hex(b), 0.96 + hash3(x >> 2, y >> 2, s * 61 + 1) * 0.05 + dith(x, y)), h = 0.7, rough = 0.55;
      if (seam) { c = shade(hex(b), 0.55); h = 0; }
      else if (hl) c = shade(hex(b), 1.06);
      else if (inEdge) { c = shade(hex(b), y === 44 || x === 4 ? 0.7 : 1.05); h = 0.4; }
      else if (inset) { c = shade(hex(b), 0.9); h = 0.35; }
      if (bolt) { c = hex('#8a8e92'); h = 1; }
      if (label) c = hex('#6a6e74');
      if (scuff) c = shade(c, 0.8);
      return { c, h, metal: 0.05, rough };
    },
  },
  rubber: {
    // dark rubber mat: raised rib grid, worn ribs
    w: 16, h: 16, base: 'rubber',
    fn: (b, s) => (x, y) => {
      const rib = x % 4 === 0 || y % 4 === 0;
      return { c: shade(hex(b), rib ? 1.25 - hash3(x, y, s * 67) * 0.15 : 0.85 + dith(x, y)), h: rib ? 0.8 : 0.4, metal: 0, rough: 0.95 };
    },
  },
  leather: {
    // perforated seat leather: quilted panels with a perforation dot grid, stitched seams
    w: 16, h: 16, base: 'leather',
    fn: (b, s) => (x, y) => {
      const stitch = (x === 0 && y % 2 === 0) || (y === 8 && x % 2 === 0), seam = x === 15 || y === 7;
      const perf = x % 3 === 1 && y % 3 === 1 && !seam;
      let c = shade(hex(b), 0.95 + hash3(x, y, s * 71) * 0.08 + dith(x, y)), h = 0.65;
      if (seam) { c = shade(hex(b), 0.6); h = 0.2; }
      if (stitch) c = shade(hex(b), 1.35);
      if (perf) { c = shade(hex(b), 0.45); h = 0.3; }
      return { c, h, metal: 0, rough: 0.7 };
    },
  },
  glow: { w: 8, h: 8, base: 'glow', fn: (b) => () => ({ c: hex(b), emissive: hex(b) }) },
  glass: {
    w: 16, h: 16, base: 'glass',
    fn: (b) => (x, y) => ({ c: shade(hex(b), x + y < 3 ? 1.3 : (x * 3 + y) % 23 === 0 ? 1.08 : 0.9), metal: 0, rough: 0.05 }),
  },
  screen: {
    w: 32, h: 16, base: 'screen',
    fn: (b, s) => (x, y) => {
      const bars = y > 9 && x > 2 && x < 29 && x % 3 !== 0 && y > 15 - Math.floor(hash3(x, 0, s * 47) * 6) - 1, line = y === 4 && x > 2 && x < 29, frame = x === 0 || y === 0 || x === 31 || y === 15;
      const lit = bars || line || (y === 7 && (x * 7) % 5 === 0);
      const c = frame ? hex('#1a1c20') : lit ? hex(b) : shade(hex(b), 0.12);
      return { c, emissive: frame ? [0, 0, 0, 0] : lit ? hex(b) : shade(hex(b), 0.1) };
    },
  },
  scratches: {
    // wear overlay (alpha): bright scratches and chips
    w: 32, h: 32, base: 'metal',
    fn: (b, s) => (x, y) => {
      const sc = (hash3(Math.floor((x + y * 2) / 3), 0, s * 53) > 0.93 && hash3(x >> 2, y >> 2, s * 53 + 1) > 0.55) || hash3(x, y, s * 53 + 2) > 0.985;
      return { c: sc ? [210, 214, 220, 200] : [0, 0, 0, 0] };
    },
  },
  grime: {
    // grime overlay (alpha): dark blotches, drip streaks
    w: 32, h: 32, base: 'metal_dark',
    fn: (b, s) => (x, y) => {
      const blot = hash3(x >> 2, y >> 2, s * 59) * 0.6 + hash3(x >> 1, y >> 1, s * 59 + 1) * 0.4;
      const drip = hash3(x, 0, s * 59 + 2) < 0.15 && hash3(x, y >> 3, s * 59 + 3) < 0.7;
      const a = drip ? 150 : blot > 0.62 ? Math.round((blot - 0.62) * 500) : 0;
      return { c: a ? [28, 26, 22, Math.min(190, a)] : [0, 0, 0, 0] };
    },
  },
};
export const KIT_TEXTURES = Object.keys(PAINTERS);

/** Paint one kit texture: {w, h, color, height, metal?, rough?, emissive?} (RGBA arrays). */
export function paintKit(name, { colors = {}, seed = 1, base } = {}) {
  const P = PAINTERS[name];
  if (!P) throw new Error(`unknown kit texture "${name}" (${KIT_TEXTURES.join(', ')})`);
  const C = { ...KIT_COLORS, ...colors };
  const fn = P.fn(base ?? C[P.base] ?? '#808080', Number(seed) || 1, C);
  const { w, h } = P;
  const color = new Uint8ClampedArray(w * h * 4), height = new Uint8ClampedArray(w * h * 4), extra = {};
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = fn(x, y), o = (y * w + x) * 4;
    color.set(r.c.map((v) => Math.round(v)), o);
    const hv = Math.round((r.h ?? 0.5) * 255); height.set([hv, hv, hv, 255], o);
    for (const k of ['emissive', 'metal', 'rough']) {
      if (r[k] === undefined) continue;
      if (!extra[k]) extra[k] = new Uint8ClampedArray(w * h * 4);
      extra[k].set(Array.isArray(r[k]) ? r[k] : [Math.round(r[k] * 255), Math.round(r[k] * 255), Math.round(r[k] * 255), 255], o);
    }
  }
  return { w, h, color, height, ...extra };
}

/** The whole set as canvases-to-be: `${prefix}_${name}` -> paintKit result. */
export function paintKitTextures({ prefix = 'kit', colors = {}, seed = 1 } = {}) {
  return Object.fromEntries(KIT_TEXTURES.map((n) => [`${prefix}_${n}`, paintKit(n, { colors, seed })]));
}

const RE = /^kit_([a-z_]+?)(?:_([0-9a-fA-F]{6}))?$/;
/** Is this texture reference a built-in kit texture ("kit_deck", "kit_fabric_a03028")? */
export const isKitRef = (ref) => typeof ref === 'string' && RE.test(ref) && !!PAINTERS[RE.exec(ref)[1]];
const cache = new Map();
/**
 * A resolved texture object for a built-in kit reference (used when no canvas has that name):
 * colour + emissive + normal map (from height) + metallicRoughness map, like a kit canvas.
 */
export function kitTexture(ref) {
  if (cache.has(ref)) return cache.get(ref);
  const m = RE.exec(ref);
  if (!m || !PAINTERS[m[1]]) return null;
  const name = m[1], p = paintKit(name, { base: m[2] ? `#${m[2]}` : undefined });
  const hf = new Float32Array(p.w * p.h);
  for (let i = 0; i < hf.length; i++) hf[i] = p.height[i * 4] / 255;
  const t = {
    key: `kit:${ref}`, canvas: ref, name: ref, width: p.w, height: p.h, data: p.color, builtin: true,
    ...(p.emissive ? { emissive: p.emissive } : {}),
    normal: p.color.some((v, i) => i % 4 === 3 && v === 0) && name !== 'grate' ? null : heightToNormal(hf, p.w, p.h, { strength: 1, bevel: 1 }),
    heightOf: () => hf,
  };
  if (p.metal || p.rough) t.mr = mrTexture(p.w, p.h, p.metal, p.rough, { metal: 0, rough: 1 });
  if (!t.normal) delete t.normal;
  cache.set(ref, t);
  return t;
}
