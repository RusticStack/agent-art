// Rebuilds the art_planet demo renders in docs/planets/:
//   node docs/planets/build-demos.mjs [out dir]
// An original 6-world system strip, a ringed bloom world from orbit (atmosphere, clouds, rings) with
// its maps, a desert landing zone (rocks, mesas, arch), a nebula skybox and an asteroid belt.
// Writes demo-stats.json (triangles, texture sizes, generation times) next to the images.
// landing_before_*.png are the first terrain version (commit a61c4d9) rendered through
// landing_cams.json (same x / z framing, heights re-based on that version's ground); when present,
// they are combined with the new renders into landing_before_after.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { packImages } from '../../src/sheet.js';
import { upscale } from '../../src/space/noise.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-planets-demo-')) });
const stats = {};
const png = (f) => decodePNG(fs.readFileSync(f));
const save = (name, im) => fs.writeFileSync(path.join(OUT, name), encodePNG(im.width, im.height, im.data));
const texStats = (dir) => {
  const files = [];
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else files.push(f); } };
  walk(dir);
  const pngs = files.filter((f) => f.endsWith('.png') && !f.endsWith('_strip.png') && !f.endsWith('_orbit.png') && !f.endsWith('_preview.png'));
  let maxPx = 0;
  for (const f of pngs) { const b = fs.readFileSync(f); maxPx = Math.max(maxPx, b.readUInt32BE(16), b.readUInt32BE(20)); }
  return { textures: pngs.length, max_texture_px: maxPx, files: files.length, bytes: files.reduce((s, f) => s + fs.statSync(f).size, 0) };
};

// 1. system strip: six distinct worlds (ice, toxic, bloom, lava, desert, ringed gas giant)
const sys = e.run('planet_system', { seed: 2251, count: 6, cell: 160 });
save('system_strip.png', png(sys.strip));
stats.system = { star: sys.star, bodies: sys.bodies, ms: sys.ms };
console.log('system', sys.star.name, sys.bodies.map((b) => `${b.name}:${b.preset}`).join(' '), `${sys.ms} ms`);

// 2. one world from orbit: bloom world with rings, clouds, atmosphere, full maps + tiles
const bloom = sys.bodies.find((b) => b.preset === 'bloom'), PN = bloom.name.toLowerCase();
const p = e.run('planet_create', { name: PN, preset: 'bloom', seed: bloom.seed, hue: bloom.hue, radius: 100, real_radius_km: 4800, rings: { inner: 1.45, outer: 2.25, ramp: ['#5a6a70', '#8a9aa0', '#b8c4c4', '#e0e8e4'], gaps: 2, tilt: 22 }, equirect: 1024, face: 256, tiles: { levels: 2, segments: 16, px: 64 }, preview_size: 384 });
const pd = p.dir;
const maps = ['albedo', 'height', 'normal', 'rough', 'clouds', 'night'].map((k) => ({ img: png(path.join(pd, `${PN}_${k}.png`)), label: k.toUpperCase() }));
const sheet = packImages(maps, { columns: 2, checker: true });
save('orbit_maps.png', sheet);
const cube = packImages(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => ({ img: upscale(png(path.join(pd, 'cube', `${f}_albedo.png`)), 1), label: f.toUpperCase() })), { columns: 6, checker: false });
save('orbit_cube_faces.png', cube);
stats.planet = { name: PN, lods: p.lods, tiles: p.tiles, textures: p.textures, ms: p.ms, ...texStats(pd), meta_timings: JSON.parse(fs.readFileSync(path.join(pd, `${PN}.planet.json`), 'utf8')).timings_ms };
console.log('planet', JSON.stringify(p.lods), `${p.ms} ms`);

// 3. landing zone on the desert world of the system: overview, eye height (1.7 m), wide with horizon
const desertBody = sys.bodies.find((b) => b.preset === 'desert');
e.run('planet_create', { name: 'dulpha', preset: 'desert', seed: desertBody.seed, hue: desertBody.hue, equirect: 512, face: 128, tiles: false });
const t = e.run('planet_terrain', { planet: 'dulpha', name: 'dulpha_lz', lat: 14, lon: 32, size: 512, mesas: 2, arches: 1, preview_size: 512 });
const tm = JSON.parse(fs.readFileSync(path.join(t.dir, 'dulpha_lz.terrain.json'), 'utf8'));
const views = ['overview', 'eye', 'wide'];
for (const k of views) save(`landing_${k}.png`, png(path.join(t.dir, `dulpha_lz_${k}.png`)));
save('landing_zone.png', packImages(views.map((k) => ({ img: png(path.join(t.dir, `dulpha_lz_${k}.png`)), label: k === 'eye' ? 'EYE HEIGHT 1.7 M' : k.toUpperCase() })), { columns: 3, checker: false }));
// cameras + ground heights under them, so a re-render of another version keeps the same framing above its own ground
const hf = JSON.parse(fs.readFileSync(path.join(t.dir, 'dulpha_lz.heightfield.json'), 'utf8'));
const gAt = (x, z) => { const i = Math.round((x + hf.size_m / 2) / hf.spacing_m), j = Math.round((z + hf.size_m / 2) / hf.spacing_m); return hf.heights[Math.max(0, Math.min(hf.grid, j)) * (hf.grid + 1) + Math.max(0, Math.min(hf.grid, i))]; };
fs.writeFileSync(path.join(OUT, 'landing_cams.json'), JSON.stringify(Object.fromEntries(Object.entries(tm.cameras).map(([k, c]) => [k, { ...c, ground: gAt(c.pos[0], c.pos[2]), pad: gAt(0, 0) }])), null, 1));
// before / after: landing_before_*.png are the renders of the first version (commit a61c4d9) through the same cameras
if (views.every((k) => fs.existsSync(path.join(OUT, `landing_before_${k}.png`)))) {
  const items = [];
  for (const k of views) items.push({ img: png(path.join(OUT, `landing_before_${k}.png`)), label: `BEFORE ${k.toUpperCase()}` });
  for (const k of views) items.push({ img: png(path.join(OUT, `landing_${k}.png`)), label: `AFTER ${k.toUpperCase()}` });
  save('landing_before_after.png', packImages(items, { columns: 3, checker: false }));
}
const crop = (im, x0, y0, w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) d.set(im.data.subarray(((y0 + y) * im.width + x0) * 4, ((y0 + y) * im.width + x0 + w) * 4), y * w * 4); return { width: w, height: h, data: d }; };
const det = tm.detail_files[Math.floor(tm.detail_files.length / 2)];
const lz = packImages([
  { img: upscale(png(path.join(t.dir, 'dulpha_lz_tileset.png')), 2), label: 'TILESET (4 VARIANTS + 2 EDGE TILES PER LAYER)' },
  { img: (() => { const im = png(path.join(t.dir, 'dulpha_lz_splat.png')); for (let i = 3; i < im.data.length; i += 4) im.data[i] = 255; return upscale(im, 2); })(), label: 'SPLAT RGB = GROUND ROCK LOW (A = SCREE)' },
  { img: upscale(crop(png(path.join(t.dir, det.albedo)), 384, 384, 192, 192), 2), label: 'DETAIL 32 PX/M (6 X 6 M)' },
], { columns: 3, checker: false });
save('landing_zone_maps.png', lz);
stats.terrain = { biome: t.biome, base_elevation_m: t.base_elevation_m, height_range_m: t.height_range_m, chunks: t.chunks, triangles_lod0: t.triangles_lod0, lod_triangles_per_chunk: t.lod_triangles_per_chunk, detail_patches: t.detail_patches, horizon_triangles: t.horizon_triangles, props: t.props, prop_stats: tm.stats.props, anchors: tm.anchors, fog: tm.fog, ms: t.ms, ...texStats(t.dir), timings: tm.timings_ms };
console.log('terrain', JSON.stringify(t.props), `${t.ms} ms`);

// 4. nebula skybox (all faces + preview + equirect)
const s = e.run('planet_skybox', { name: 'ember_sky', preset: 'ember', seed: 2251, size: 512, format: 'both' });
save('skybox_preview.png', png(path.join(s.dir, 'ember_sky_preview.png')));
const eqSky = png(path.join(s.dir, 'ember_sky_equirect.png'));
save('skybox_equirect.png', { width: 512, height: 256, data: (() => { const d = new Uint8ClampedArray(512 * 256 * 4); for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) d.set(eqSky.data.subarray(((y * 2) * eqSky.width + x * 2) * 4, ((y * 2) * eqSky.width + x * 2) * 4 + 4), (y * 512 + x) * 4); return d; })() });
save('skybox_faces.png', packImages(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => ({ img: png(path.join(s.dir, `ember_sky_${f}.png`)), label: f.toUpperCase() })), { columns: 3, checker: false }));
// orbit render composited over the skybox face it would sit in front of
const orbit = upscale(png(path.join(pd, `${PN}_orbit.png`)), 2), bgFace = upscale(png(path.join(s.dir, 'ember_sky_pz.png')), 2);
const comp = { width: orbit.width, height: orbit.height, data: new Uint8ClampedArray(orbit.width * orbit.height * 4) };
for (let i = 0; i < comp.data.length; i += 4) {
  const px = (i / 4) % orbit.width, py = Math.floor(i / 4 / orbit.width), a = orbit.data[i + 3] / 255, j = ((py % bgFace.height) * bgFace.width + (px % bgFace.width)) * 4;
  for (let k = 0; k < 3; k++) comp.data[i + k] = orbit.data[i + k] * a + bgFace.data[j + k] * (1 - a);
  comp.data[i + 3] = 255;
}
save('orbit.png', comp);
stats.skybox = { face_px: s.face_px, stars: s.stars, ms: s.ms, ...texStats(s.dir) };
console.log('skybox', `${s.ms} ms`);

// 5. asteroid belt
const a = e.run('planet_asteroids', { name: 'belt', seed: 2251, field: { shape: 'belt', count: 1200, inner: 600, outer: 900, thickness: 50, size: [2, 36] }, preview_size: 512 });
save('asteroid_field.png', png(path.join(a.dir, 'belt_preview.png')));
stats.asteroids = { instances: a.instances, variants: a.variants, field_triangles_lod0: a.field_triangles_lod0, glb_bytes: a.glb_bytes, ms: a.ms, ...texStats(a.dir) };
console.log('asteroids', `${a.ms} ms`);

// 6. fx sprites
const fx = e.run('planet_fx', { name: 'fx', seed: 3 });
const fxImgs = ['sun', 'flare', 'debris', 'dust', 'lightning'].map((k) => ({ img: png(path.join(fx.dir, `fx_${k}.png`)), label: k.toUpperCase() }));
save('fx_sprites.png', packImages(fxImgs, { columns: 3, checker: true }));
stats.fx = { ms: fx.ms, ...texStats(fx.dir) };

fs.writeFileSync(path.join(OUT, 'demo-stats.json'), JSON.stringify(stats, null, 1));
console.log('wrote', OUT);
