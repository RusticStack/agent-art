// Fixture models for art_model unwrap (test/uvunwrap.test.js + acceptance renders): the stone
// column from the plan (named and unnamed parts), a ruined arch, a bevelled crate with metal
// straps, a ship hull section with a glass canopy, and a box-only model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../src/engine.js';

export const COLUMN_PARTS = [
  { type: 'box', name: 'plinth', w: 28, h: 6, d: 28, texture: 'brick' },
  { type: 'box', name: 'base', w: 22, h: 4, d: 22, at: [0, 6, 0], texture: 'brick' },
  { type: 'cylinder', name: 'shaft', r: 8, h: 44, segments: 12, at: [0, 10, 0], texture: 'brick' },
  { type: 'box', name: 'cap', w: 24, h: 6, d: 24, at: [0, 54, 0], texture: 'brick' },
];
const unnamed = (parts) => parts.map(({ name, ...p }) => p);

export const UV_MODELS = {
  column: { origin: 'bottom', parts: COLUMN_PARTS },
  column_static: { origin: 'bottom', parts: unnamed(COLUMN_PARTS) },
  arch: { origin: 'bottom', parts: [
    { type: 'pillar', w: 12, h: 56, at: [-26, 0, 0], texture: 'brick' },
    { type: 'pillar', w: 12, h: 56, at: [26, 0, 0], texture: 'brick' },
    { type: 'arch', span: 40, spring: 36, w: 64, h: 80, d: 10, at: [0, 0, 0], texture: 'brick', broken: { amount: 14, step: 4, seed: 3 } },
    { type: 'rubble', w: 28, d: 20, count: 7, size: [3, 7], seed: 5, at: [6, 0, 14], texture: 'brick' },
  ] },
  crate: { origin: 'bottom', parts: [
    { type: 'box', w: 32, h: 32, d: 32, bevel: 2, texture: 'planks' },
    { type: 'box', w: 34, h: 4, d: 34, at: [0, 5, 0], texture: 'strap' },
    { type: 'box', w: 34, h: 4, d: 34, at: [0, 23, 0], texture: 'strap' },
  ] },
  hull: { origin: 'bottom', parts: [
    { type: 'box', w: 40, h: 16, d: 48, taper: [0.6, 0.7], texture: 'plate' },
    { type: 'cylinder', r: 6, r_top: 5, r_bottom: 7, h: 20, segments: 12, rotate: [-90, 0, 0], at: [-12, 8, -24], texture: 'plate' },
    { type: 'cylinder', r: 6, r_top: 5, r_bottom: 7, h: 20, segments: 12, rotate: [-90, 0, 0], at: [12, 8, -24], texture: 'plate' },
    { type: 'tube', from: [-20, 4, 10], to: [20, 4, 10], r: 2, sides: 8, texture: 'plate' },
    { type: 'box', w: 14, h: 6, d: 14, at: [0, 16, 6], color: '#9fd8ff', glass: true },
  ] },
  boxes: { origin: 'bottom', parts: [
    { type: 'box', w: 32, h: 16, d: 32, texture: 'brick' },
    { type: 'box', w: 16, h: 16, d: 16, at: [0, 16, 0], texture: 'brick' },
  ] },
};

export function drawTextures(e) {
  const draw = (canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });
  e.run('create', { name: 'brick', width: 16 });
  draw('brick', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#8a8478' }, { op: 'line', x1: 0, y1: 7, x2: 15, y2: 7, color: '#4a463e' }, { op: 'line', x1: 0, y1: 15, x2: 15, y2: 15, color: '#4a463e' }, { op: 'line', x1: 7, y1: 0, x2: 7, y2: 7, color: '#4a463e' }, { op: 'line', x1: 15, y1: 8, x2: 15, y2: 15, color: '#4a463e' }]);
  e.run('create', { name: 'stone', width: 16 });
  draw('stone', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#8a8478' }, { op: 'rect', x: 3, y: 4, w: 2, h: 1, color: '#7a7468' }, { op: 'rect', x: 10, y: 11, w: 3, h: 1, color: '#9a9488' }]);
  e.run('create', { name: 'moss', width: 16 });
  draw('moss', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#4f6b32' }, { op: 'rect', x: 2, y: 3, w: 3, h: 2, color: '#6b8a40' }, { op: 'rect', x: 9, y: 9, w: 4, h: 2, color: '#3a5226' }]);
  e.run('create', { name: 'planks', width: 16 });
  draw('planks', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#9a6a3a' }, { op: 'line', x1: 0, y1: 4, x2: 15, y2: 4, color: '#5a3a1e' }, { op: 'line', x1: 0, y1: 10, x2: 15, y2: 10, color: '#5a3a1e' }, { op: 'line', x1: 0, y1: 15, x2: 15, y2: 15, color: '#5a3a1e' }, { op: 'rect', x: 5, y: 1, w: 3, h: 1, color: '#b07c48' }, { op: 'rect', x: 11, y: 7, w: 2, h: 1, color: '#86592e' }]);
  e.run('create', { name: 'strap', width: 8 });
  draw('strap', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#6a6e74' }, { op: 'rect', x: 3, y: 3, w: 1, h: 1, color: '#a8acb2' }, { op: 'line', x1: 0, y1: 7, x2: 7, y2: 7, color: '#4a4e54' }]);
  e.run('create', { name: 'plate', width: 16 });
  draw('plate', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#7c8490' }, { op: 'line', x1: 0, y1: 15, x2: 15, y2: 15, color: '#4c525c' }, { op: 'line', x1: 15, y1: 0, x2: 15, y2: 15, color: '#4c525c' }, { op: 'rect', x: 2, y: 2, w: 1, h: 1, color: '#aab2bc' }]);
}

/** Engine on a scratch home with the textures and every UV fixture model created. */
export function uvCorpusEngine(home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-uv-'))) {
  const e = new Engine({ home });
  drawTextures(e);
  for (const [name, def] of Object.entries(UV_MODELS)) e.run('model_create', { name, ...def });
  return e;
}
