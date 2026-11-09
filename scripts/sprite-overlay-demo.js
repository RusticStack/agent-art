// Renders docs/limits/sprite_overlay_before_after.png: art_draw damage at 0.25 / 0.6 / 1.0 on a
// 128x192 armour plate, 0.9.0 (top row) against this checkout (bottom row). The 0.9.0 sources come
// from git (git archive <ref> src, extracted into the work dir), so the image reproduces from any
// branch: no second checkout needed.
// Usage: node scripts/sprite-overlay-demo.js [ref = 503bdfe (Release 0.9.0)] [workDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packImages } from '../src/sheet.js';
import { encodePNG } from '../src/png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.argv[2] || '503bdfe';
const work = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-sprite-demo-')));

/** Extract a (ustar / pax) tar buffer into dir. */
function untar(buf, dir) {
  let longName = null;
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(o + 512, o + 512 + size);
    let name = longName ?? ((str(345, 500) ? `${str(345, 500)}/` : '') + str(0, 100));
    longName = null;
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); if (m) longName = m[1]; }
    else if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') { const f = path.join(dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
    else if (type === '5') fs.mkdirSync(path.join(dir, name), { recursive: true });
    o += 512 + Math.ceil(size / 512) * 512;
  }
}

const oldDir = path.join(work, `src-${ref}`);
fs.rmSync(oldDir, { recursive: true, force: true });
fs.mkdirSync(oldDir, { recursive: true });
untar(execFileSync('git', ['archive', '--format=tar', ref, 'src', 'package.json'], { cwd: ROOT, maxBuffer: 1 << 30 }), oldDir);

async function renders(srcDir, home) {
  const { Engine } = await import(pathToFileURL(path.join(srcDir, 'engine.js')).href);
  const e = new Engine({ home });
  const plate = ['#232a33', '#2e3640', '#3c4652', '#5a6878', '#7a8898', '#a4b0bc', '#c8d0d6'];
  const paint = ['#3a4a2e', '#4c6038', '#5f7644', '#7a8f58'];
  e.run('create', { name: 'p', width: 128, height: 192 });
  e.run('draw', { canvas: 'p', commands: [
    { op: 'rect', x: 14, y: 10, w: 100, h: 172, color: plate[3] },
    { op: 'shade', colors: plate.slice(1, 6), of: plate[3] },
    { op: 'rect', x: 24, y: 22, w: 80, h: 70, color: paint[2] },
    { op: 'rect', x: 24, y: 102, w: 80, h: 70, color: paint[2] },
    { op: 'shade', colors: paint, of: paint[2] },
    { op: 'rect', x: 14, y: 96, w: 100, h: 2, color: plate[1] },
    { op: 'outline', color: '#161a20' },
  ] });
  const imgs = [];
  for (const amount of [0, 0.25, 0.6, 1]) {
    e.run('duplicate', { canvas: 'p', new_name: `p${amount}` });
    if (amount) e.run('draw', { canvas: `p${amount}`, commands: [{ op: 'damage', amount, seed: 4, on: [...plate, ...paint] }] });
    imgs.push({ amount, data: e.get(`p${amount}`).composite() });
  }
  return imgs;
}
const homes = ['old', 'new'].map((k) => { const h = path.join(work, `home-${k}`); fs.rmSync(h, { recursive: true, force: true }); return h; });
const before = await renders(path.join(oldDir, 'src'), homes[0]), after = await renders(path.join(ROOT, 'src'), homes[1]);
const up = (d) => { const W = 128, H = 192, o = new Uint8ClampedArray(W * 2 * H * 2 * 4); for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) o.set(d.subarray(((y >> 1) * W + (x >> 1)) * 4, ((y >> 1) * W + (x >> 1)) * 4 + 4), (y * W * 2 + x) * 4); return { width: W * 2, height: H * 2, data: o }; };
const items = [...before.map((b) => ({ img: up(b.data), label: `0.9.0 ${b.amount}` })), ...after.map((b) => ({ img: up(b.data), label: `now ${b.amount}` }))];
const img = packImages(items, { labels: true, checker: false, columns: 4 });
const out = path.join(ROOT, 'docs', 'limits', 'sprite_overlay_before_after.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(img.width, img.height, img.data));
console.log('wrote', out, `${img.width}x${img.height}`, `(before = ${ref})`);
