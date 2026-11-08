// Procedural meshes for the mesh-processing tests and demos (px units, 32 px = 1 m): boxes, UV
// spheres, a kitbashed hull (hull + overlapping plates + pods + greebles), a greeble pile, a
// subdivided slab and a skinned bar. Deterministic (hash-seeded), colour textures only.
import { Mesh } from './model3d.js';

const tex = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { key: `color:${hex}`, name: `color_${hex.slice(1)}`, width: 1, height: 1, data: Uint8ClampedArray.from([...c, 255]) };
};
export const fixtureTex = tex;
const hash = (i, s = 1) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(s + 0x632be5ab, 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };

/** Axis box [min, max] subdivided n x n per face (closed, outward). */
export function boxMesh(min, max, { color = '#8a8a94', n = 1, m = new Mesh(), pid = 0 } = {}) {
  const t = typeof color === 'string' ? tex(color) : color;
  const faces = [
    [0, 1, [1, 2]], [0, 0, [2, 1]], [1, 1, [2, 0]], [1, 0, [0, 2]], [2, 1, [0, 1]], [2, 0, [1, 0]],
  ];
  for (const [ax, hi, [u, v]] of faces) {
    const nrm = [0, 0, 0]; nrm[ax] = hi ? 1 : -1;
    const at = (i, j) => { const p = [0, 0, 0]; p[ax] = hi ? max[ax] : min[ax]; p[u] = min[u] + ((max[u] - min[u]) * i) / n; p[v] = min[v] + ((max[v] - min[v]) * j) / n; return p; };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const P = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const f = m.face(t, P, nrm, P.map((p) => [p[u] / 32, -p[v] / 32]), nrm, 0);
      f.pid = pid;
    }
  }
  return m;
}

/** UV sphere (closed): seg around, rings top to bottom. */
export function sphereMesh(c, r, { seg = 32, rings = 16, color = '#a0a8b0', m = new Mesh(), pid = 0 } = {}) {
  const t = tex(color);
  const pt = (i, j) => { const th = (i / seg) * 2 * Math.PI, ph = (j / rings) * Math.PI; return [c[0] + r * Math.sin(ph) * Math.cos(th), c[1] + r * Math.cos(ph), c[2] + r * Math.sin(ph) * Math.sin(th)]; };
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = pt(i, j), b = pt(i + 1, j), d = pt(i, j + 1), e = pt(i + 1, j + 1);
    const nrmOf = (p) => [(p[0] - c[0]) / r, (p[1] - c[1]) / r, (p[2] - c[2]) / r];
    const uv = (i2, j2) => [i2 / seg, j2 / rings];
    const out = (P) => { const cc = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length, s[2] + p[2] / P.length], [0, 0, 0]); return [cc[0] - c[0], cc[1] - c[1], cc[2] - c[2]]; };
    if (j === 0) { const f = m.face(t, [a, e, d], [a, e, d].map(nrmOf), [uv(i, j), uv(i + 1, j + 1), uv(i, j + 1)], out([a, e, d])); f.pid = pid; }
    else if (j === rings - 1) { const f = m.face(t, [a, b, d], [a, b, d].map(nrmOf), [uv(i, j), uv(i + 1, j), uv(i, j + 1)], out([a, b, d])); f.pid = pid; }
    else { const f = m.face(t, [a, b, e, d], [a, b, e, d].map(nrmOf), [uv(i, j), uv(i + 1, j), uv(i + 1, j + 1), uv(i, j + 1)], out([a, b, e, d])); f.pid = pid; }
  }
  return m;
}

/**
 * Kitbashed hull: a long faceted hull box, overlapping armour plates, two engine pods (spheres)
 * pushed into the sides and a row of greeble boxes half sunk into the top. Every piece is a closed
 * solid; they overlap (hidden interior faces everywhere) until unioned. detail scales density.
 */
export function kitbashHull({ detail = 1, greebles = 24 } = {}) {
  const m = new Mesh();
  const n = Math.max(1, Math.round(4 * detail));
  boxMesh([-400, 0, -96], [400, 128, 96], { color: '#6c7480', n: n * 4, m, pid: 0 });
  let pid = 1;
  for (let i = 0; i < 6; i++) { const x0 = -360 + i * 120; boxMesh([x0, 96.5, -104], [x0 + 100, 140, 104], { color: '#7d8794', n, m, pid: pid++ }); }
  sphereMesh([-150, 64, 130], 70, { seg: Math.round(24 * detail), rings: Math.round(12 * detail), color: '#9aa3ad', m, pid: pid++ });
  sphereMesh([150, 64, -130], 70, { seg: Math.round(24 * detail), rings: Math.round(12 * detail), color: '#9aa3ad', m, pid: pid++ });
  for (let i = 0; i < greebles; i++) {
    const x = -380 + hash(i, 3) * 740, z = -80 + hash(i, 5) * 160, w = 8 + hash(i, 7) * 20, d = 8 + hash(i, 9) * 20, h = 6 + hash(i, 11) * 14;
    boxMesh([x, 134 - h * 0.4, z], [x + w, 134 + h, z + d], { color: '#c9a14a', n: 1, m, pid: pid++ });
  }
  return m;
}

/** A pile of overlapping greeble boxes + small spheres (self-intersecting soup). */
export function greebleBlob({ count = 40, seed = 1 } = {}) {
  const m = new Mesh();
  for (let i = 0; i < count; i++) {
    const c = [hash(i, seed) * 96 - 48, hash(i, seed + 1) * 48, hash(i, seed + 2) * 96 - 48], s = 10 + hash(i, seed + 3) * 22;
    if (i % 4 === 3) sphereMesh(c, s * 0.6, { seg: 12, rings: 6, color: '#b08850', m, pid: i });
    else boxMesh([c[0] - s / 2, c[1] - s / 3, c[2] - s / 2], [c[0] + s / 2, c[1] + s / 3, c[2] + s / 2], { color: i % 2 ? '#7a828c' : '#5d6670', m, pid: i });
  }
  return m;
}

/**
 * Skinned bar along +x: a subdivided box with JOINTS/WEIGHTS (two joints blending across the
 * middle) as group skin {j, w} (4 per vertex; the art_model skin layout).
 */
export function skinnedBar({ n = 8, len = 256 } = {}) {
  const m = boxMesh([0, 0, 0], [len, 32, 32], { color: '#c08060', n });
  for (const g of m.groups.values()) {
    const vc = g.pos.length / 3, j = new Array(vc * 4).fill(0), w = new Array(vc * 4).fill(0);
    for (let i = 0; i < vc; i++) { const t = Math.max(0, Math.min(1, (g.pos[i * 3] / len - 0.3) / 0.4)); j[i * 4] = 0; j[i * 4 + 1] = 1; w[i * 4] = 1 - t; w[i * 4 + 1] = t; }
    g.skin = { j, w };
  }
  return m;
}
