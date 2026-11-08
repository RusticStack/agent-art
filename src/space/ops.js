// art_planet engine ops: planets, star systems, ground terrain, rock kits, asteroid fields, skyboxes
// and space FX. Outputs go to <exports>/<name>/ (PNG maps, .glb, JSON meta); planet specs are kept
// in <workspace>/planets/<name>.json so terrain can be sampled from a planet later.
import fs from 'node:fs';
import path from 'node:path';
import { writeGLB } from '../glb.js';
import { encodePNG } from '../png.js';
import { packImages } from '../sheet.js';
import { Doc } from '../doc.js';
import { renderCamera, makeCamera } from '../raster3d.js';
import { simplifyMesh, switchDistance } from '../lod.js';
import { bakeImpostor } from '../impostor.js';
import { mulberry32 } from '../util.js';
import { seedOf, hexRGB, toHex, upscale, FACES, r4, texLimit, MAX_TEX, shiftColor } from './noise.js';
import {
  PRESETS, PRESET_NAMES, normPlanet, bakeEquirect, bakeFace, bakeRegion, heightImage, bakeCloudsEquirect, bakeCloudsFace, bakeRings, cubeSphere, facePatch,
  patchError, tileId, tileBounds, tileSkirt, atmosphereParams, renderPlanet, specPalette, elevKm,
} from './planet.js';
import { normTerrain, buildTerrain, latLonDir } from './terrain.js';
import { rockMesh, crystalMesh, grassCard, grassTexture, formationMesh, texOf, ROCK_KINDS } from './rocks.js';
import { makeTile } from './tiles.js';
import { normSky, SKY_PRESETS, bakeSkyFaces, bakeSkyEquirect, crossPreview } from './skybox.js';
import { sunSprite, flareSheet, debrisCard, dustStorm, lightning, SUN_COLORS } from './fx.js';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const f6 = (v) => +(+v).toFixed(6);
const SCREEN = { height: 720, fov: 70, px: 1 };

// ---------- helpers ----------
function outDir(engine, a, name) {
  const d = engine.resolvePath(a.path || name, engine.exportDir);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writer(dir) {
  const files = [], textures = [];
  return {
    files, textures,
    png(rel, w, h, data) {
      texLimit(w, h, rel);
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, encodePNG(w, h, data));
      files.push(rel); textures.push({ file: rel, size: [w, h] });
      return rel;
    },
    json(rel, obj) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 1)); files.push(rel); return rel; },
    glb(rel, scene, opts) {
      const r = writeGLB(scene, { scale: 1, ...opts });
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, r.glb);
      files.push(rel);
      return r.stats;
    },
  };
}
const timer = () => { const t0 = Date.now(), laps = {}; let last = t0; return { lap(k) { const n = Date.now(); laps[k] = (laps[k] || 0) + n - last; last = n; }, laps, total: () => Date.now() - t0 }; };
const groups = (m) => [...m.groups.values()].filter((g) => g.idx.length);
const tris = (gs) => gs.reduce((s, g) => s + g.idx.length / 3, 0);
function toCanvas(engine, name, im, source) {
  const d = new Doc({ name, width: im.width, height: im.height });
  d.layers[0].data.set(im.data);
  d.meta = { generated: 'art_planet' };
  engine.attach(d);
  engine.changed(d, { op: 'planet', source, label: 'art_planet render', structural: true });
  return name;
}
function resolvePalette(engine, v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.map(hexRGB);
  if (typeof v === 'string' && v.startsWith('project:')) {
    const p = engine.getProject(v.slice(8));
    const pal = Object.values(p.palette || {}).map((c) => hexRGB(String(c).slice(0, 7)));
    if (!pal.length) throw new Error(`project "${p.name}" has no palette`);
    return pal;
  }
  throw new Error('palette must be a list of colours or "project:<name>"');
}
function planetDir(engine) { const d = path.join(engine.home, 'planets'); fs.mkdirSync(d, { recursive: true }); return d; }
function loadPlanet(engine, ref) {
  if (ref && typeof ref === 'object') return { args: ref, P: normPlanet(ref) };
  const f = path.join(planetDir(engine), `${ref}.json`);
  if (!ref || !fs.existsSync(f)) {
    const have = fs.readdirSync(planetDir(engine)).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5));
    throw new Error(`No planet "${ref}". Make one with art_planet {action:"planet", name}; existing: ${have.join(', ') || '(none)'}`);
  }
  const args = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { args, P: normPlanet(args) };
}
/** Disc + palette swatches for a system strip cell. */
function discCell(P, maps, size, opts = {}) {
  const im = renderPlanet(P, maps, { size, ...opts });
  const pal = specPalette(P).slice(0, 12), sw = Math.max(4, Math.floor((opts.swatch_frame ?? size) / Math.max(6, pal.length))), rows = Math.ceil((pal.length * sw) / size);
  const H = size + 4 + rows * sw, out = new Uint8ClampedArray(size * H * 4);
  out.set(im.data);
  pal.forEach((c, i) => {
    const x0 = (i * sw) % size, y0 = size + 4 + Math.floor((i * sw) / size) * sw;
    for (let y = 0; y < sw - 1; y++) for (let x = 0; x < sw - 1; x++) out.set([c[0], c[1], c[2], 255], ((y0 + y) * size + x0 + x) * 4);
  });
  return { width: size, height: H, data: out };
}
const MAT_BLEND = (opacity = 1, double_sided = false) => ({ blend: true, opacity, double_sided });

// ---------- planet ----------
function planetMaps(P, a, palette, T) {
  const eqW = Math.round(Number(a.equirect ?? 1024));
  if (!(eqW >= 64 && eqW <= MAX_TEX && eqW % 2 === 0)) throw new Error(`equirect must be an even width 64..${MAX_TEX}`);
  const eq = bakeEquirect(P, eqW, { palette });
  T.lap('equirect');
  if (P.clouds) eq.clouds = bakeCloudsEquirect(P, eqW);
  if (P.rings) eq.rings = bakeRings(P, Math.min(MAX_TEX, Number(a.ring_px ?? 512)));
  T.lap('clouds_rings');
  return eq;
}

/** Ring annulus mesh group (units), u = radial. */
function ringGroup(P, tex, segs = 96) {
  const g = { tex, pos: [], nrm: [], uv: [], idx: [] }, r0 = P.radius * P.rings.inner, r1 = P.radius * P.rings.outer;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), v = i / segs;
    g.pos.push(c * r0, 0, s * r0, c * r1, 0, s * r1); g.nrm.push(0, 1, 0, 0, 1, 0); g.uv.push(0, v, 1, v);
  }
  for (let i = 0; i < segs; i++) { const a = i * 2; g.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  return g;
}

function planetCreate(a, source) {
  const name = a.name;
  if (!NAME_RE.test(name || '')) throw new Error('planet "name" must be 1-64 chars of letters, digits, _ - .');
  const T = timer();
  const args = { ...a };
  for (const k of ['action', 'path', 'canvas', 'preview_size']) delete args[k];
  const P = normPlanet(args);
  fs.writeFileSync(path.join(planetDir(this), `${name}.json`), JSON.stringify(args, null, 1));
  const dir = outDir(this, a, name), W = writer(dir), palette = resolvePalette(this, a.palette);
  // ---- equirect maps
  const eq = planetMaps(P, a, palette, T);
  let lo = Infinity, hi = -Infinity;
  for (const v of eq.heightKm) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const eqFiles = {
    albedo: W.png(`${name}_albedo.png`, eq.width, eq.height, eq.albedo),
    height: W.png(`${name}_height.png`, eq.width, eq.height, heightImage(eq.heightKm, lo, hi)),
    height16: W.png(`${name}_height16.png`, eq.width, eq.height, heightImage(eq.heightKm, lo, hi, true)),
    normal: P.gas ? undefined : W.png(`${name}_normal.png`, eq.width, eq.height, eq.normal),
    roughness: W.png(`${name}_rough.png`, eq.width, eq.height, eq.rough),
    emissive: eq.glow ? W.png(`${name}_emissive.png`, eq.width, eq.height, eq.glow) : undefined,
    night: eq.night ? W.png(`${name}_night.png`, eq.width, eq.height, eq.night) : undefined,
    clouds: eq.clouds ? W.png(`${name}_clouds.png`, eq.width, eq.height, eq.clouds) : undefined,
    rings: eq.rings ? W.png(`${name}_rings.png`, eq.rings.width, eq.rings.height, eq.rings.data) : undefined,
  };
  T.lap('write_equirect');
  // ---- cube faces
  const S = Math.round(Number(a.face ?? 256));
  if (!(S >= 16 && S <= MAX_TEX)) throw new Error(`face must be 16..${MAX_TEX} px`);
  const faceTex = [], cubeFiles = {}, cloudTex = [];
  for (let f = 0; f < 6; f++) {
    const m = bakeFace(P, f, S, { palette }), F = FACES[f];
    cubeFiles[F] = { albedo: W.png(`cube/${F}_albedo.png`, S, S, m.albedo), height: W.png(`cube/${F}_height.png`, S, S, heightImage(m.heightKm, lo, hi)), roughness: W.png(`cube/${F}_rough.png`, S, S, m.rough) };
    if (!P.gas) cubeFiles[F].normal = W.png(`cube/${F}_normal.png`, S, S, m.normal);
    if (m.glow) cubeFiles[F].emissive = W.png(`cube/${F}_emissive.png`, S, S, m.glow);
    if (m.night) cubeFiles[F].night = W.png(`cube/${F}_night.png`, S, S, m.night);
    faceTex.push({ key: `${name}:face:${F}`, name: `${name}_${F}`, width: S, height: S, data: m.albedo, mr: m.rough, mrKey: `${name}:mr:${F}`, ...(P.gas ? {} : { normal: m.normal, normalKey: `${name}:n:${F}` }), ...(m.glow ? { emissive: m.glow, emissiveKey: `${name}:e:${F}` } : {}) });
    if (P.clouds) {
      const cs = Math.min(S, 256), cd = bakeCloudsFace(P, f, cs);
      cubeFiles[F].clouds = W.png(`cube/${F}_clouds.png`, cs, cs, cd);
      cloudTex.push({ key: `${name}:clouds:${F}`, name: `${name}_clouds_${F}`, width: cs, height: cs, data: cd, material: MAT_BLEND(1) });
    }
  }
  T.lap('cube_faces');
  // ---- LOD meshes (cube-sphere, integer lattice: crack-free face seams)
  const lodSegs = (a.lods ?? [48, 24, 12, 6]).map(Number);
  if (!lodSegs.length || lodSegs.some((s, i) => !(Number.isInteger(s) && s >= 2 && s <= 128 && (i === 0 || s < lodSegs[i - 1])))) throw new Error('lods must be decreasing cells per face edge, 2..128, e.g. [48, 24, 12, 6]');
  const meshes = [], nodes = [], levels = [];
  let prev = 0;
  for (const [i, segs] of lodSegs.entries()) {
    const gs = cubeSphere(P, segs, faceTex);
    let err = 0;
    for (let f = 0; f < 6; f++) err = Math.max(err, patchError(P, f, 0, 0, segs, segs));
    // chord sagitta of a cell (the sphere itself) counts too
    err = Math.max(err, P.radius * (1 - Math.cos(Math.PI / (4 * segs))));
    const dist = i ? Math.max(prev, f6(switchDistance(err, SCREEN))) : 0;
    prev = dist;
    meshes.push({ name: `${name}_LOD${i}`, groups: gs });
    levels.push({ level: i, segments: segs, triangles: tris(gs), error: f6(err), distance: dist });
  }
  T.lap('lod_meshes');
  const root = { name, children: [], ...(P.tilt ? { rotation: [0, 0, Math.sin((P.tilt * Math.PI) / 360), Math.cos((P.tilt * Math.PI) / 360)] } : {}), extras: { planet: name, preset: P.preset, radius: P.radius, tilt_deg: P.tilt } };
  nodes.push(root);
  const group = { name: `${name}_lods`, children: [], extras: { lod_group: true, levels: levels.map((L) => ({ level: L.level, distance: L.distance, triangles: L.triangles })) } };
  nodes.push(group); root.children.push(1);
  levels.forEach((L, i) => { nodes.push({ name: `${name}_LOD${i}`, mesh: i, extras: { lod: i, distance: L.distance }, ...(i ? { lodHidden: true } : {}) }); group.children.push(nodes.length - 1); });
  const extra = {};
  if (P.clouds) {
    const rc = P.radius * (1 + P.clouds.height);
    meshes.push({ name: `${name}_clouds`, groups: FACES.map((_, f) => facePatch(P, cloudTex[f], f, 0, 0, 16, 16, { shell: rc })) });
    nodes.push({ name: `${name}_clouds`, mesh: meshes.length - 1, extras: { clouds: true, radius: r4(rc), note: 'alpha BLEND shell; rotate slowly about Y for drift' } });
    root.children.push(nodes.length - 1);
    extra.clouds = { radius: r4(rc), coverage: P.clouds.coverage, levels: P.clouds.levels, triangles: tris(meshes[meshes.length - 1].groups) };
  }
  const atm = atmosphereParams(P);
  if (atm) {
    const tex = { key: `${name}:atmo`, name: `${name}_atmosphere`, width: 1, height: 1, data: Uint8ClampedArray.from([...P.atmosphere.color, 255]), material: MAT_BLEND(0.15) };
    meshes.push({ name: `${name}_atmosphere`, groups: FACES.map((_, f) => facePatch(P, tex, f, 0, 0, 12, 12, { shell: atm.shell_radius })) });
    nodes.push({ name: `${name}_atmosphere`, mesh: meshes.length - 1, extras: { atmosphere: atm, replace_material: 'docs: atmosphere shader (fresnel rim + terminator)' } });
    root.children.push(nodes.length - 1);
    extra.atmosphere = { ...atm, triangles: tris(meshes[meshes.length - 1].groups) };
  }
  if (P.rings) {
    const tex = { key: `${name}:rings`, name: `${name}_rings`, width: eq.rings.width, height: eq.rings.height, data: eq.rings.data, material: MAT_BLEND(1, true) };
    meshes.push({ name: `${name}_rings`, groups: [ringGroup(P, tex)] });
    const rings = { inner: r4(P.radius * P.rings.inner), outer: r4(P.radius * P.rings.outer), normal: [0, 1, 0], planet_radius: P.radius, shadow: { planet_on_rings: 'darken where the segment ring point -> sun hits the planet sphere', rings_on_planet: 'surface point -> sun ray meets the ring plane at radius r: multiply by 1 - 0.75 * ringAlpha(r)' } };
    nodes.push({ name: `${name}_rings`, mesh: meshes.length - 1, extras: { rings } });
    root.children.push(nodes.length - 1);
    extra.rings = { ...rings, texture: eqFiles.rings, triangles: 192 };
  }
  const glbStats = W.glb(`${name}.glb`, { meshes, nodes }, { name, extras: { planet: name } });
  T.lap('glb');
  // ---- far LOD: octahedral impostor atlas (#7 bakeImpostor) + a lit disc sprite
  let impostor = null;
  if (a.impostor !== false) {
    const low = cubeSphere(P, lodSegs[lodSegs.length - 1], faceTex);
    const imp = bakeImpostor(low, { layout: 'octahedral', grid: 4, size: 64, full: true });
    W.png(`${name}_impostor.png`, imp.albedo.width, imp.albedo.height, imp.albedo.data);
    W.png(`${name}_impostor_n.png`, imp.normal.width, imp.normal.height, imp.normal.data);
    const disc = renderPlanet(P, eq, { size: 128, rings: false });
    W.png(`${name}_disc.png`, 128, 128, disc.data);
    const quad = (2 * imp.meta.radius_px);
    impostor = {
      atlas: `${name}_impostor.png`, normal: `${name}_impostor_n.png`, disc: `${name}_disc.png`, layout: 'octahedral (full sphere)', grid: 4, cell_px: 64, quad_size: r4(quad),
      switch_distance: r4((quad * SCREEN.height) / (2 * Math.tan((SCREEN.fov * Math.PI) / 360) * 64)),
      note: 'Past switch_distance draw a camera-facing quad: disc.png (pre-lit, sun from the left) for the cheapest path, or the impostor atlas relit with its normals, or the sphere-on-quad shader in docs (samples the equirect maps).',
    };
    W.json(`${name}_impostor.json`, { ...imp.meta, ...impostor });
    T.lap('impostor');
  }
  // ---- quadtree tiles
  let tiles = null;
  if (a.tiles !== false) {
    const to = a.tiles === true || a.tiles === undefined ? {} : a.tiles;
    const maxL = Math.round(Number(to.levels ?? 2)), n = Math.round(Number(to.segments ?? 16)), tpx = Math.round(Number(to.px ?? 64));
    if (!(maxL >= 0 && maxL <= 4)) throw new Error('tiles.levels must be 0..4');
    if (!(n >= 2 && n <= 64 && n % 2 === 0)) throw new Error('tiles.segments must be even, 2..64');
    const list = [];
    let ttris = 0;
    for (let f = 0; f < 6; f++) for (let L = 0; L <= maxL; L++) {
      const k = 1 << L;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
        const id = tileId(f, L, x, y), N = n << L;
        const m = bakeRegion(P, f, x / k, y / k, 1 / k, tpx, { palette });
        const tex = { key: `tile:${id}`, name: id.replace(/\//g, '_'), width: tpx, height: tpx, data: m.albedo, ...(P.gas ? {} : { normal: m.normal }), ...(m.glow ? { emissive: m.glow } : {}) };
        const err = Math.max(patchError(P, f, x * n, y * n, n, N), P.radius * (1 - Math.cos(Math.PI / (4 * N))));
        const skirt = tileSkirt(P, f, L, x, y, n);
        const g = facePatch(P, tex, f, x * n, y * n, n, N, { skirt, uv: 'tile' });
        const file = `tiles/${id}.glb`;
        W.glb(file, { meshes: [{ name: id, groups: [g] }], nodes: [{ name: id, mesh: 0, extras: { tile: id, level: L, error: f6(err) } }] }, { name: id });
        ttris += g.idx.length / 3;
        list.push({ id, face: FACES[f], level: L, x, y, file, ...tileBounds(P, f, L, x, y, n), error: f6(err), skirt: f6(skirt), children: L < maxL ? [0, 1, 2, 3].map((c) => tileId(f, L + 1, 2 * x + (c & 1), 2 * y + (c >> 1))) : [] });
      }
    }
    tiles = {
      scheme: 'cube-quadtree', faces: FACES, face_convention: 'OpenGL / three.js cube map: face px nx py ny pz nz; tile x = column along s (image right), y = row along t (image down)',
      segments: n, tile_px: tpx, max_level: maxL, radius: P.radius, roots: FACES.map((_, f) => tileId(f, 0, 0, 0)), tiles: list,
      refine: 'Screen-space error: sse = error * screen_height / (2 * distance * tan(fov / 2)); draw a tile if sse <= 1 px (or it has no children), else draw its 4 children. distance = max(0, |camera - center| - radius).',
      cracks: 'Same-level neighbours (also across cube faces) share edge vertices exactly (integer lattice). Next to a coarser / finer neighbour every tile has a skirt (edges pushed toward the centre by tiles[].skirt, sized from its own error and its parent tile error), which covers the gap; keep neighbours within one level for the guarantee.',
    };
    W.json(`${name}.tiles.json`, tiles);
    T.lap('tiles');
    tiles = { file: `${name}.tiles.json`, count: list.length, max_level: maxL, segments: n, tile_px: tpx, triangles_per_tile: Math.round(ttris / list.length) };
  }
  // ---- preview (orbit view with atmosphere, clouds, rings)
  const ps = Math.round(Number(a.preview_size ?? 256));
  const view = renderPlanet(P, eq, { size: ps, spin: a.spin ?? 25 });
  W.png(`${name}_orbit.png`, ps, ps, view.data);
  T.lap('preview');
  if (a.canvas) toCanvas(this, `${name}_orbit`, view, source);
  const meta = {
    name, generator: 'agent-art art_planet', preset: P.preset, seed: P.seed, radius: P.radius, real_radius_km: P.real_radius_km, relief_km: P.relief_km, mesh_relief: P.mesh_relief, tilt_deg: P.tilt,
    height_range_km: [r4(lo), r4(hi)], sea_level_km: P.sea_level === null || P.sea_level === undefined ? null : 0,
    equirect: { size: [eq.width, eq.height], convention: 'three.js equirectUv: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5, row 0 = north', files: eqFiles },
    cube: { face_px: S, order: FACES, convention: 'OpenGL / three.js CubeTextureLoader order + orientation', files: cubeFiles },
    maps_note: 'albedo = pixel palette colours (NEAREST); normal = tangent space (+x = +u, +y = image up); rough = glTF metallicRoughness (G = roughness, B = metal 0); emissive = always-on glow (lava, acid); night = city lights, show on the night side only; height = gray over height_range_km, height16 = R high byte + G low byte',
    glb: { file: `${name}.glb`, ...glbStats, nodes_note: '<name> root (axial tilt) > <name>_lods (LOD0..n, extras.distance), <name>_clouds, <name>_atmosphere (replace the material with the docs shader), <name>_rings' },
    lods: { screen: SCREEN, levels }, ...extra, impostor, tiles,
    palette: specPalette(P).map(toHex),
    timings_ms: { ...T.laps, total: T.total() },
  };
  W.json(`${name}.planet.json`, meta);
  const texMax = Math.max(...W.textures.map((t) => Math.max(...t.size)));
  return {
    planet: name, dir, preset: P.preset, files: W.files.length, glb: path.join(dir, `${name}.glb`), meta: path.join(dir, `${name}.planet.json`),
    lods: levels.map((L) => ({ level: L.level, triangles: L.triangles, distance: L.distance })), triangles_lod0: levels[0].triangles,
    textures: { count: W.textures.length, max_px: texMax, equirect: `${eq.width}x${eq.height}`, face: S }, tiles, ms: T.total(),
    image: encodePNG(...(() => { const u = upscale(view, ps <= 256 ? 2 : 1); return [u.width, u.height, u.data]; })()),
    next: `terrain from this planet: art_planet {action:"terrain", planet:"${name}", lat, lon}; preview faces: open ${name}_albedo.png / cube/`,
  };
}

// ---------- system ----------
const SYL = ['ka', 'vel', 'or', 'thi', 'sun', 'dra', 'qui', 'zen', 'lo', 'ves', 'ta', 'ri', 'nox', 'pha', 'ul', 'sel', 'bri', 'tor', 'ae', 'mi', 'gau', 'ish', 'rek', 'yo', 'cen', 'dul', 'hav', 'iru'];
function coinName(r, n = 2) { let s = ''; for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)]; return s[0].toUpperCase() + s.slice(1); }
const ORDER = { 4: ['lava', 'bloom', 'gas', 'ice'], 5: ['lava', 'desert', 'bloom', 'gas', 'ice'], 6: ['lava', 'toxic', 'desert', 'bloom', 'gas', 'ice'] };

/** Original star system: 4-8 bodies (planets + moons), distinct biomes, orbits, names. */
export function generateSystem({ seed = 1, count = 6, name } = {}) {
  count = Math.round(Number(count));
  if (!(count >= 4 && count <= 8)) throw new Error('count (planets + moons) must be 4..8');
  const r = mulberry32(seedOf(seed, 501));
  const star = { name: name || coinName(r, 2) + ' ' + coinName(r, 1), class: ['yellow', 'orange', 'white', 'red'][Math.floor(r() * 4)] };
  const order = ORDER[Math.min(6, count)];
  const bodies = [];
  let dist = 0.25 + r() * 0.15;
  for (const [i, preset] of order.entries()) {
    const big = preset === 'gas';
    bodies.push({
      name: coinName(r, 2 + (r() < 0.3 ? 1 : 0)), preset, seed: Math.floor(r() * 1e6), hue: Math.round((r() - 0.5) * 24), kind: 'planet',
      radius: big ? 260 + Math.round(r() * 80) : 70 + Math.round(r() * 50), real_radius_km: big ? 52000 + Math.round(r() * 20000) : 2400 + Math.round(r() * 4400),
      orbit: { au: r4(dist), period_days: Math.round(365 * Math.pow(dist, 1.5)), phase_deg: Math.round(r() * 360) }, tilt: Math.round((r() - 0.5) * (big ? 50 : 40)),
    });
    dist *= 1.55 + r() * 0.5;
    void i;
  }
  // moons: barren / icy, around the gas giant first, then the bloom world
  const hosts = bodies.filter((b) => b.preset === 'gas').concat(bodies.filter((b) => b.preset === 'bloom'));
  for (let m = 0; bodies.length < count; m++) {
    const host = hosts[m % hosts.length];
    bodies.push({ name: `${host.name} ${['I', 'II', 'III'][Math.floor(m / hosts.length)]}`, preset: m % 2 ? 'ice' : 'barren', seed: Math.floor(r() * 1e6), hue: Math.round((r() - 0.5) * 30), kind: 'moon', host: host.name, radius: 30 + Math.round(r() * 20), real_radius_km: 600 + Math.round(r() * 1400), orbit: { host_radii: 4 + m * 2 + Math.round(r() * 3), period_days: Math.round(3 + r() * 20), phase_deg: Math.round(r() * 360) }, tilt: 0 });
  }
  return { star, bodies };
}

function planetSystem(a, source) {
  const T = timer();
  const sys = generateSystem({ seed: a.seed ?? 1, count: a.count ?? 6, name: a.star });
  const name = a.name || sys.star.name.toLowerCase().replace(/\W+/g, '_');
  if (!NAME_RE.test(name)) throw new Error('system "name" must be 1-64 chars of letters, digits, _ - .');
  const dir = outDir(this, a, name), W = writer(dir);
  const cellPx = Math.round(Number(a.cell ?? 128));
  const items = [];
  for (const b of sys.bodies) {
    const P = normPlanet({ preset: b.preset, seed: b.seed, hue: b.hue, radius: b.radius, real_radius_km: b.real_radius_km, tilt: b.tilt });
    b.palette = specPalette(P).map(toHex);
    const eq = bakeEquirect(P, 256);
    if (P.clouds) eq.clouds = bakeCloudsEquirect(P, 256);
    if (P.rings) eq.rings = bakeRings(P, 256);
    const size = b.kind === 'moon' ? Math.round(cellPx * 0.55) : P.rings ? Math.round(cellPx * 1.8) : cellPx; // ringed: wider frame, same disc scale
    const cell = discCell(P, eq, size, { spin: 30, sun: [-0.9, 0.25, 0.45], swatch_frame: Math.min(size, cellPx) });
    items.push({ img: cell, label: b.name.toUpperCase(), sub: `${b.preset}${b.kind === 'moon' ? ' moon' : ''}` });
    if (a.bake) {
      const pn = `${name}_${b.name.toLowerCase().replace(/\W+/g, '_')}`;
      planetCreate.call(this, { name: pn, preset: b.preset, seed: b.seed, hue: b.hue, radius: b.radius, real_radius_km: b.real_radius_km, tilt: b.tilt, equirect: a.bake.equirect ?? 512, face: a.bake.face ?? 128, tiles: a.bake.tiles ?? false, path: path.join(dir, pn) }, source);
      b.files = pn;
    }
  }
  T.lap('bodies');
  const sheet = packImages(items, { columns: Math.min(items.length, 8), checker: false, padding: 8 });
  fs.writeFileSync(path.join(dir, `${name}_strip.png`), encodePNG(sheet.width, sheet.height, sheet.data)); W.files.push(`${name}_strip.png`); // overview image, not a game texture
  W.json(`${name}.system.json`, { name, ...sys, note: 'Original names, palettes and layout. Orbits: au from the star (moons: host radii). Bake a body with art_planet {action:"planet", preset, seed, hue, radius, real_radius_km, tilt}.' });
  T.lap('strip');
  if (a.canvas) toCanvas(this, `${name}_strip`, sheet, source);
  return { system: name, star: sys.star, bodies: sys.bodies.map((b) => ({ name: b.name, preset: b.preset, kind: b.kind, seed: b.seed, hue: b.hue, ...(b.host ? { host: b.host } : {}) })), dir, strip: path.join(dir, `${name}_strip.png`), ms: T.total(), image: encodePNG(sheet.width, sheet.height, sheet.data) };
}

// ---------- rock kits ----------
const rampFor = (P) => {
  const b = P.biomes.find((x) => ['mesa', 'highland', 'peaks', 'ash', 'basalt'].includes(x.name)) || P.biomes[P.biomes.length - 1];
  return b.ramp;
};
function lodSet(mesh, ratios) {
  const out = [{ level: 0, mesh, triangles: mesh.triangles, error: 0 }];
  for (const [i, r] of ratios.slice(1).entries()) { const s = simplifyMesh(mesh, { ratio: r, level: i + 1 }); out.push({ level: i + 1, mesh: s.mesh, triangles: s.triangles, error: s.error }); }
  return out;
}
/** LOD group nodes (#7 convention) for one variant; returns root node index. */
function pushLodGroup(meshes, nodes, name, lods, at) {
  let prev = 0;
  const levels = lods.map((L) => { const d = L.level ? Math.max(prev, f6(switchDistance(L.error, SCREEN))) : 0; prev = d; return { level: L.level, distance: d, triangles: L.triangles }; });
  nodes.push({ name: `${name}_lods`, children: [], ...(at ? { translation: at } : {}), extras: { lod_group: true, levels } });
  const g = nodes.length - 1;
  lods.forEach((L, i) => { meshes.push({ name: `${name}_LOD${i}`, groups: groups(L.mesh) }); nodes.push({ name: `${name}_LOD${i}`, mesh: meshes.length - 1, extras: { lod: i, distance: levels[i].distance }, ...(i ? { lodHidden: true } : {}) }); nodes[g].children.push(nodes.length - 1); });
  return { index: g, levels };
}
function previewMeshes(list, size = 384, cam = 'iso') {
  const gs = list.flatMap((m) => groups(m));
  const fit = [];
  for (const g of gs) for (let i = 0; i < g.pos.length; i += 3) fit.push([g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
  const c = makeCamera(cam, size, size, fit, {});
  return renderCamera(gs, c, size, size, {});
}

function rockKit(P, a, seed) {
  const ramp = a.ramp ? a.ramp.map(hexRGB) : rampFor(P);
  const tile = makeTile('rock', ramp, { size: Number(a.tile_px ?? 32), seed });
  const tex = texOf(`rock:${seed}`, tile);
  return { ramp, tex };
}

function planetRocks(a, source) {
  const T = timer();
  const name = a.name || 'rocks';
  if (!NAME_RE.test(name)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  const P = a.planet ? loadPlanet(this, a.planet).P : normPlanet({ preset: a.preset ?? 'desert', seed: a.seed ?? 1 });
  const seed = seedOf(a.seed ?? P.seed, 601);
  const { ramp, tex } = rockKit(P, a, seed);
  const kinds = a.kinds ?? ['boulder', 'rock', 'slab', 'shard', 'pebble'];
  for (const k of kinds) if (!ROCK_KINDS[k] && !['crystal', 'grass', 'mesa', 'butte', 'spire', 'arch'].includes(k)) throw new Error(`kinds: unknown "${k}" (rocks: ${Object.keys(ROCK_KINDS).join(', ')}; crystal, grass; formations: mesa, butte, spire, arch)`);
  const variants = Math.max(1, Math.min(8, Math.round(Number(a.variants ?? 2))));
  const dir = outDir(this, a, name), W = writer(dir), meshes = [], nodes = [], report = [];
  const ratios = a.lods ?? [1, 0.5, 0.25];
  const strata = texOf(`strata:${seed}`, makeTile('strata', ramp, { size: 32, seed }));
  const cap = texOf(`cap:${seed}`, makeTile('ground', ramp.map((c) => shiftColor(c, 0, 1, 1.12)), { size: 32, seed: seed + 1 }));
  const crystalTex = texOf(`crystal:${seed}`, makeTile('ground', (a.crystal_ramp ?? ['#2a8a7a', '#3fc0a0', '#8af0d0', '#e0fff4']).map(hexRGB), { size: 16, seed }), {});
  const grassTex = { ...texOf(`grass:${seed}`, grassTexture((a.grass_ramp ?? ['#6a5a2a', '#8a7a3a', '#b8a050', '#d8c878']).map(hexRGB), { seed })), material: { double_sided: true } };
  const shown = [];
  let x = 0;
  for (const k of kinds) for (let v = 0; v < variants; v++) {
    const s = seedOf(seed, 700 + kinds.indexOf(k) * 16 + v);
    let mesh, anchor;
    if (ROCK_KINDS[k]) mesh = rockMesh({ kind: k, size: (a.size ?? 1) * (k === 'boulder' ? 1.6 : k === 'pebble' ? 0.35 : k === 'slab' ? 1.2 : 1), seed: s, detail: k === 'pebble' ? 1 : 2, tex });
    else if (k === 'crystal') mesh = crystalMesh({ size: a.size ?? 1, seed: s, tex: crystalTex });
    else if (k === 'grass') mesh = grassCard({ size: 0.8, tex: grassTex });
    else ({ mesh, anchor } = formationMesh({ kind: k, size: k === 'arch' ? 30 : 20, seed: s, tex: strata, top: cap }));
    const lods = k === 'grass' ? [{ level: 0, mesh, triangles: mesh.triangles, error: 0 }] : lodSet(mesh, ratios);
    const b = mesh.bounds(), w = b.max[0] - b.min[0];
    const g = pushLodGroup(meshes, nodes, `${k}_${v}`, lods, [x - b.min[0], 0, 0]);
    if (anchor) nodes[g.index].extras.anchor = anchor;
    x += w + 1;
    report.push({ variant: `${k}_${v}`, lods: g.levels.map((L) => L.triangles), ...(anchor ? { anchor } : {}) });
    if (v === 0) shown.push(mesh);
  }
  const stats = W.glb(`${name}.glb`, { meshes, nodes }, { name, extras: { kit: 'rocks', palette: ramp.map(toHex) } });
  W.png(`${name}_rock_tile.png`, tex.width, tex.height, tex.data);
  T.lap('kit');
  // preview: first variant of each kind in a row
  const row = []; let ox = 0;
  for (const m of shown) { const c = m.clone(); const b = c.bounds(); c.transform([1, 0, 0, ox - b.min[0], 0, 1, 0, 0, 0, 0, 1, 0]); ox += b.max[0] - b.min[0] + 0.6; row.push(c); }
  const img = previewMeshes(row, 384, 'iso');
  return { kit: name, dir, glb: path.join(dir, `${name}.glb`), variants: report, triangles: stats.triangles, ms: T.total(), image: encodePNG(img.width, img.height, img.data) };
}

// ---------- terrain ----------
function planetTerrain(a, source) {
  const T = timer();
  const { P } = loadPlanet(this, a.planet);
  const t = normTerrain(P, a);
  const name = a.name || `${typeof a.planet === 'string' ? a.planet : 'planet'}_lz`;
  if (!NAME_RE.test(name)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  const B = buildTerrain(P, t);
  T.lap('heights_splat_chunks');
  const dir = outDir(this, a, name), W = writer(dir);
  // chunks: one glb each, LOD group + hidden collision proxy
  let tri0 = 0;
  const chunkFiles = [];
  for (const c of B.chunks) {
    const meshes = [], nodes = [];
    let prev = 0;
    const levels = t.lods.map((s, i) => { const d = i ? Math.max(prev, f6(switchDistance(B.lodErr[i], SCREEN))) : 0; prev = d; return { level: i, step: s, distance: d, triangles: c.lods[i].idx.length / 3, error_m: f6(B.lodErr[i]) }; });
    nodes.push({ name: `chunk_${c.cx}_${c.cz}_lods`, children: [], extras: { lod_group: true, levels: levels.map((L) => ({ level: L.level, distance: L.distance, triangles: L.triangles })) } });
    c.lods.forEach((g, i) => { meshes.push({ name: `chunk_${c.cx}_${c.cz}_LOD${i}`, groups: [g] }); nodes.push({ name: `chunk_${c.cx}_${c.cz}_LOD${i}`, mesh: i, extras: { lod: i, distance: levels[i].distance }, ...(i ? { lodHidden: true } : {}) }); nodes[0].children.push(i + 1); });
    meshes.push({ name: `chunk_${c.cx}_${c.cz}_collision`, groups: [c.collision] });
    nodes.push({ name: `chunk_${c.cx}_${c.cz}_collision`, mesh: meshes.length - 1, proxy: true, extras: { collision: true, visible: false } });
    const file = `chunks/chunk_${c.cx}_${c.cz}.glb`;
    W.glb(file, { meshes, nodes }, { name: `chunk_${c.cx}_${c.cz}` });
    W.png(`chunks/chunk_${c.cx}_${c.cz}_albedo.png`, c.tex.width, c.tex.height, c.tex.data);
    tri0 += levels[0].triangles;
    chunkFiles.push({ x: c.cx, z: c.cz, file, levels });
  }
  T.lap('chunk_glbs');
  const V = t.grid + 1;
  W.png(`${name}_splat.png`, V, V, B.splat);
  const ts = t.tile_px, sheet = new Uint8ClampedArray(ts * 4 * ts * 4);
  B.layers.forEach((L, k) => { for (let y = 0; y < ts; y++) sheet.set(L.tile.data.subarray(y * ts * 4, (y + 1) * ts * 4), (y * ts * 4 + k * ts) * 4); });
  W.png(`${name}_tileset.png`, ts * 4, ts, sheet);
  W.json(`${name}.heightfield.json`, {
    planet: typeof a.planet === 'string' ? a.planet : null, lat: t.lat, lon: t.lon, size_m: t.size, grid: t.grid, spacing_m: B.step, origin: 'patch centre (heights relative to it)', axes: '+X east, +Z south, +Y up (metres)',
    base_elevation_m: r4(B.H.base), min: r4(B.lo), max: r4(B.hi), layout: 'row-major: heights[z * (grid + 1) + x], x = -size/2 + i * spacing', heights: Array.from(B.heights, (v) => Math.round(v * 100) / 100),
  });
  T.lap('splat_heightfield');
  // props: variants per kind, GPU instanced (EXT_mesh_gpu_instancing)
  const seed = seedOf(t.seed, 801);
  const { tex } = rockKit(P, {}, seed);
  const crystalTex = texOf(`crystal:${seed}`, makeTile('ground', (P.preset === 'ice' ? ['#3a6a9a', '#6aa8d8', '#b8e0ff', '#ffffff'] : P.preset === 'lava' ? ['#8a2a0a', '#e0521a', '#ffa21f', '#ffe45c'] : ['#5a7a10', '#8fae10', '#c4d82b', '#f0ff8a']).map(hexRGB), { size: 16, seed }));
  if (P.preset === 'lava' || P.preset === 'toxic') crystalTex.emissive = crystalTex.data.map((v, i) => (i % 4 === 3 ? 255 : v * 0.5));
  const groundRamp = B.layers[0].ramp;
  const grassTex = { ...texOf(`grass:${seed}`, grassTexture(groundRamp.map((c) => shiftColor(c, -8, 0.9, 0.95)), { seed })), material: { double_sided: true } };
  const variantMesh = { rocks: (v) => rockMesh({ kind: ['boulder', 'rock', 'slab', 'pebble'][v], size: [1.4, 1, 1.1, 0.4][v], seed: seedOf(seed, 810 + v), detail: v === 3 ? 1 : 2, tex }), crystals: (v) => crystalMesh({ size: 1, seed: seedOf(seed, 820 + v), count: 3 + v, tex: crystalTex }), grass: () => grassCard({ size: 0.9, tex: grassTex }) };
  const meshes = [], nodes = [], scatterOut = {}, placedMeshes = [];
  let propTris = 0, instances = 0;
  for (const kind of ['rocks', 'crystals', 'grass']) {
    const list = B.scatter[kind];
    scatterOut[kind] = { requested: B.requested[kind], placed: list.length, variants: [] };
    for (let v = 0; v < 4; v++) {
      const its = list.filter((it) => (kind === 'grass' ? 0 : it.v) === v);
      if (!its.length) continue;
      const mesh = variantMesh[kind](v);
      meshes.push({ name: `${kind}_${v}`, groups: groups(mesh) });
      const quatM = (q, s, p) => { const [x, y, z, w] = q; return [(1 - 2 * (y * y + z * z)) * s, 2 * (x * y - z * w) * s, 2 * (x * z + y * w) * s, p[0], 2 * (x * y + z * w) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z - x * w) * s, p[1], 2 * (x * z - y * w) * s, 2 * (y * z + x * w) * s, (1 - 2 * (x * x + y * y)) * s, p[2]]; };
      const mats = its.map((it) => quatM(it.r, it.s, it.p));
      nodes.push({ name: `${kind}_${v}_instances`, mesh: meshes.length - 1, instancing: { t: its.flatMap((it) => it.p), r: its.flatMap((it) => it.r), s: its.flatMap((it) => [it.s, it.s, it.s]), mats }, extras: { scatter: kind, variant: v, count: its.length } });
      scatterOut[kind].variants.push({ variant: v, node: `${kind}_${v}_instances`, count: its.length, triangles: mesh.triangles, instances: its.map((it) => ({ p: it.p, r: it.r, s: it.s })) });
      propTris += mesh.triangles * its.length; instances += its.length;
      for (const M of mats.slice(0, kind === 'grass' ? 120 : 400)) placedMeshes.push(mesh.clone().transform(M));
    }
  }
  const propStats = meshes.length ? W.glb(`${name}_props.glb`, { meshes, nodes }, { name: `${name}_props` }) : null;
  W.json(`${name}.scatter.json`, { seed: t.seed, kinds: scatterOut, note: 'Instance transforms: p = position (m, patch frame), r = rotation quaternion [x, y, z, w], s = uniform scale. The props glb carries the same as EXT_mesh_gpu_instancing (three.js GLTFLoader -> InstancedMesh).' });
  T.lap('scatter');
  // formations (arches) + anchors
  const strata = texOf(`strata:${seed}`, makeTile('strata', B.layers[1].ramp, { size: 32, seed }));
  const fm = [], fn = [];
  const formMeshes = [];
  for (const [i, f] of B.forms.entries()) {
    const { mesh, anchor } = formationMesh({ kind: f.kind, size: f.size, seed: seedOf(seed, 900 + i), tex: strata });
    fm.push({ name: `${f.kind}_${i}`, groups: groups(mesh) });
    const yaw = (f.yaw * Math.PI) / 180;
    fn.push({ name: `${f.kind}_${i}`, mesh: fm.length - 1, translation: f.p, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], extras: { formation: f.kind, anchor } });
    const c = Math.cos(yaw), s = Math.sin(yaw);
    formMeshes.push(mesh.clone().transform([c, 0, s, f.p[0], 0, 1, 0, f.p[1], -s, 0, c, f.p[2]]));
    propTris += mesh.triangles;
  }
  if (fm.length) W.glb(`${name}_formations.glb`, { meshes: fm, nodes: fn }, { name: `${name}_formations` });
  // preview: perspective from the south-east over the landing pad
  const ps = Math.round(Number(a.preview_size ?? 384));
  const sceneGroups = [...B.chunks.flatMap((c) => [c.lods[0]]), ...placedMeshes.flatMap(groups), ...formMeshes.flatMap(groups)];
  const light = { light: [-0.45, 0.8, 0.35].map((v, i, A) => v / Math.hypot(...A)), ambient: 0.4 };
  const view = renderCamera(sceneGroups, makeCamera({ pos: [t.size * 0.05, B.hi + t.size * 0.62, t.size * 0.82], look: [0, B.lo, -t.size * 0.08], fov: 55 }, ps, ps, []), ps, ps, light);
  W.png(`${name}_preview.png`, ps, ps, view.data);
  // close-up at the landing pad (props at human scale)
  const h0 = B.anchors[0].p[1];
  const close = renderCamera(sceneGroups, makeCamera({ pos: [16, h0 + 8, 30], look: [-4, h0, -8], fov: 60 }, ps, ps, [], { near: 0.2 }), ps, ps, light);
  W.png(`${name}_closeup.png`, ps, ps, close.data);
  if (a.canvas) toCanvas(this, `${name}_preview`, view, source);
  T.lap('preview');
  const meta = {
    name, planet: typeof a.planet === 'string' ? a.planet : null, lat: t.lat, lon: t.lon, centre_biome: B.centreBiome, size_m: t.size, grid: t.grid, chunks: t.chunks, chunk_m: B.cm,
    base_elevation_m: r4(B.H.base), height_range_m: [r4(B.lo), r4(B.hi)], frame: { up: B.H.frame.up.map(r4), east: B.H.frame.east.map(r4), north: B.H.frame.north.map(r4), axes: '+X east, +Z south, +Y up' },
    chunk_files: chunkFiles, lods: { steps: t.lods, error_m: B.lodErr.map(f6), screen: SCREEN },
    textures: { chunk_albedo_px: B.px, texel_m: t.texel, splat: `${name}_splat.png`, splat_channels: B.layers.map((L) => L.name), tileset: `${name}_tileset.png`, tile_px: ts, layers: B.layers.map((L) => ({ name: L.name, kind: L.kind, ramp: L.ramp.map(toHex) })) },
    heightfield: `${name}.heightfield.json`, props: propStats ? `${name}_props.glb` : null, scatter: `${name}.scatter.json`, formations: fm.length ? `${name}_formations.glb` : null, anchors: B.anchors,
    stats: { terrain_triangles_lod0: tri0, prop_instances: instances, prop_triangles: propTris },
    timings_ms: { ...T.laps, total: T.total() },
  };
  W.json(`${name}.terrain.json`, meta);
  return {
    terrain: name, dir, planet: meta.planet, lat: t.lat, lon: t.lon, biome: B.centreBiome, base_elevation_m: meta.base_elevation_m, height_range_m: meta.height_range_m,
    chunks: chunkFiles.length, triangles_lod0: tri0, lod_triangles_per_chunk: chunkFiles[0].levels.map((L) => L.triangles), props: { instances, triangles: propTris, ...Object.fromEntries(Object.entries(scatterOut).map(([k, v]) => [k, `${v.placed}/${v.requested}`])) },
    anchors: B.anchors.length, chunk_texture_px: B.px, ms: T.total(), image: encodePNG(view.width, view.height, view.data),
  };
}

// ---------- asteroids ----------
function planetAsteroids(a, source) {
  const T = timer();
  const name = a.name || 'asteroids';
  if (!NAME_RE.test(name)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  const seed = seedOf(a.seed ?? 1, 1001);
  const ramp = (a.ramp ?? ['#2a2426', '#3e3434', '#564842', '#6e5e52', '#8a7a68']).map(hexRGB);
  const tex = texOf(`asteroid:${seed}`, makeTile('rock', ramp, { size: 32, seed }));
  const kinds = a.kinds ?? ['potato', 'binary', 'shard', 'cratered', 'rock', 'boulder'];
  for (const k of kinds) if (!ROCK_KINDS[k]) throw new Error(`kinds: unknown "${k}" (${Object.keys(ROCK_KINDS).join(', ')})`);
  const dir = outDir(this, a, name), W = writer(dir);
  const ratios = a.lods ?? [1, 0.4, 0.15];
  const kit = kinds.map((k, i) => {
    const mesh = rockMesh({ kind: k, size: 1, seed: seedOf(seed, 1010 + i), detail: 2, cuts: k === 'shard' ? 6 : 3, ground: false, tex, world: 1.5 });
    return { kind: k, mesh, lods: lodSet(mesh, ratios) };
  });
  T.lap('kit');
  // field: belt (annulus), ring (thin), or cluster (sphere)
  const F = { shape: a.field?.shape ?? 'belt', count: Math.round(Number(a.field?.count ?? 400)), inner: Number(a.field?.inner ?? 600), outer: Number(a.field?.outer ?? 900), thickness: Number(a.field?.thickness ?? 60), size: a.field?.size ?? [2, 40], power: Number(a.field?.power ?? 2.6) };
  if (!['belt', 'ring', 'cluster'].includes(F.shape)) throw new Error('field.shape must be belt, ring or cluster');
  if (!(F.count >= 1 && F.count <= 20000)) throw new Error('field.count must be 1..20000');
  const r = mulberry32(seedOf(seed, 1020)), insts = [];
  for (let i = 0; i < F.count; i++) {
    let p;
    if (F.shape === 'cluster') { const z = r() * 2 - 1, t = r() * Math.PI * 2, q = Math.sqrt(1 - z * z), rr = F.outer * Math.cbrt(r()); p = [q * Math.cos(t) * rr, z * rr * 0.6, q * Math.sin(t) * rr]; }
    else { const ang = r() * Math.PI * 2, rad = F.inner + (F.outer - F.inner) * (F.shape === 'ring' ? r() : Math.sqrt(r())), th = (F.shape === 'ring' ? 0.15 : 1) * F.thickness * (r() + r() - 1); p = [Math.cos(ang) * rad, th, Math.sin(ang) * rad]; }
    const s = F.size[0] + (F.size[1] - F.size[0]) * Math.pow(r(), F.power);
    const ax = [r() - 0.5, r() - 0.5, r() - 0.5], al = Math.hypot(...ax) || 1, ang = r() * Math.PI * 2;
    const q = [Math.sin(ang / 2) * ax[0] / al, Math.sin(ang / 2) * ax[1] / al, Math.sin(ang / 2) * ax[2] / al, Math.cos(ang / 2)];
    insts.push({ v: Math.floor(r() * kit.length), p: p.map(r4), r: q.map(r4), s: r4(s), spin: { axis: ax.map((v) => r4(v / al)), deg_per_s: r4((r() * 20 + 2) / Math.sqrt(s)) } });
  }
  const meshes = [], nodes = [];
  const kitLevels = [];
  // kit: each variant as a LOD group, laid out on X
  kit.forEach((k, i) => { const g = pushLodGroup(meshes, nodes, `${k.kind}`, k.lods, [i * 3 - kit.length * 1.5, 0, -F.outer * 1.2]); kitLevels.push({ kind: k.kind, lods: g.levels }); });
  W.glb(`${name}_kit.glb`, { meshes, nodes }, { name: `${name}_kit` });
  // field glb: per variant + LOD level, GPU-instanced nodes (LOD1+ hidden; pick by distance in-engine)
  const fm = [], fn = [];
  let tri = 0;
  kit.forEach((k, v) => {
    const its = insts.filter((it) => it.v === v);
    if (!its.length) return;
    k.lods.forEach((L, li) => {
      fm.push({ name: `${k.kind}_LOD${li}`, groups: groups(L.mesh) });
      const mats = its.map((it) => { const [x, y, z, w] = it.r, s = it.s; return [(1 - 2 * (y * y + z * z)) * s, 2 * (x * y - z * w) * s, 2 * (x * z + y * w) * s, it.p[0], 2 * (x * y + z * w) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z - x * w) * s, it.p[1], 2 * (x * z - y * w) * s, 2 * (y * z + x * w) * s, (1 - 2 * (x * x + y * y)) * s, it.p[2]]; });
      fn.push({ name: `${k.kind}_LOD${li}_instances`, mesh: fm.length - 1, instancing: { t: its.flatMap((it) => it.p), r: its.flatMap((it) => it.r), s: its.flatMap((it) => [it.s, it.s, it.s]), mats }, ...(li ? { lodHidden: true } : {}), extras: { variant: k.kind, lod: li, count: its.length } });
      if (!li) tri += L.triangles * its.length;
    });
  });
  const fstats = W.glb(`${name}_field.glb`, { meshes: fm, nodes: fn }, { name: `${name}_field` });
  W.png(`${name}_tile.png`, tex.width, tex.height, tex.data);
  W.json(`${name}.field.json`, { field: F, variants: kitLevels, instances: insts, note: 'p = position (units), r = quaternion, s = scale (the kit meshes are 1 unit half-extent), spin = slow tumble for the engine to animate. LOD per instance: pick the variant LOD by distance (kit lods[].distance x scale).' });
  T.lap('field');
  // preview: the field from above at an angle (LOD1 meshes, every instance)
  const ps = Math.round(Number(a.preview_size ?? 384));
  const scene = [];
  for (const it of insts) { const [x, y, z, w] = it.r, s = it.s; scene.push(kit[it.v].lods[Math.min(1, kit[it.v].lods.length - 1)].mesh.clone().transform([(1 - 2 * (y * y + z * z)) * s, 2 * (x * y - z * w) * s, 2 * (x * z + y * w) * s, it.p[0], 2 * (x * y + z * w) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z - x * w) * s, it.p[1], 2 * (x * z - y * w) * s, 2 * (y * z + x * w) * s, (1 - 2 * (x * x + y * y)) * s, it.p[2]])); }
  const gs = scene.flatMap(groups);
  const view = renderCamera(gs, makeCamera(F.shape === 'cluster' ? { pos: [0, F.outer * 0.6, F.outer * 1.6], look: [0, 0, 0], fov: 55 } : { pos: [0, F.thickness * 1.6, ((F.inner + F.outer) / 2) * 1.12], look: [-((F.inner + F.outer) / 2) * 0.55, 0, ((F.inner + F.outer) / 2) * 0.75], fov: 60 }, ps, ps, []), ps, ps, { bg: [6, 6, 12], ambient: 0.25, light: [-0.6, 0.55, 0.58] });
  W.png(`${name}_preview.png`, ps, ps, view.data);
  if (a.canvas) toCanvas(this, `${name}_preview`, view, source);
  T.lap('preview');
  return { field: name, dir, shape: F.shape, instances: insts.length, variants: kitLevels.map((k) => ({ kind: k.kind, triangles: k.lods.map((L) => L.triangles) })), field_triangles_lod0: tri, glb_bytes: fstats.bytes, ms: T.total(), image: encodePNG(view.width, view.height, view.data) };
}

// ---------- skybox ----------
function planetSkybox(a, source) {
  const T = timer();
  const name = a.name || 'sky';
  if (!NAME_RE.test(name)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  const S = normSky(a), size = Math.round(Number(a.size ?? 512)), fmt = a.format ?? 'both';
  if (!['cube', 'equirect', 'both'].includes(fmt)) throw new Error('format must be cube, equirect or both');
  texLimit(size, size, 'skybox face');
  const dir = outDir(this, a, name), W = writer(dir), out = { name, preset: S.preset, seed: S.seed, face_px: size };
  let faces = null;
  if (fmt !== 'equirect') {
    const r = bakeSkyFaces(S, size);
    faces = r.faces;
    out.faces = FACES.map((f, i) => W.png(`${name}_${f}.png`, size, size, faces[i]));
    out.order = 'px nx py ny pz nz (three.js CubeTextureLoader().load([...]))';
    out.stars = r.stars;
    T.lap('faces');
  }
  if (fmt !== 'cube') {
    const ew = Math.min(MAX_TEX, size * 2);
    out.equirect = W.png(`${name}_equirect.png`, ew, ew / 2, bakeSkyEquirect(S, ew, size));
    T.lap('equirect');
  }
  const prev = faces ? crossPreview(faces, size, 128) : null;
  if (prev) W.png(`${name}_preview.png`, prev.width, prev.height, prev.data);
  W.json(`${name}.sky.json`, { ...out, layers: S.layers.map((L) => ({ ramp: L.ramp.map(toHex), frequency: L.frequency, density: L.density })), galaxy: S.galaxy ? { ...S.galaxy, color: toHex(S.galaxy.color) } : null, roblox: 'Sky object: SkyboxRt = px, SkyboxLf = nx, SkyboxUp = py, SkyboxDn = ny, SkyboxFt = pz, SkyboxBk = nz (check orientation in Studio; faces may need a 90 deg turn for Up / Dn)', timings_ms: { ...T.laps, total: T.total() } });
  if (a.canvas && prev) toCanvas(this, `${name}_preview`, prev, source);
  return { sky: name, dir, files: W.files, face_px: size, ms: T.total(), ...(out.stars ? { stars: out.stars } : {}), ...(prev ? { image: encodePNG(prev.width, prev.height, prev.data) } : {}) };
}

// ---------- fx ----------
function planetFx(a, source) {
  const T = timer();
  const name = a.name || 'space_fx';
  if (!NAME_RE.test(name)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  const kinds = a.kinds ?? ['sun', 'flare', 'debris', 'dust', 'lightning'];
  const dir = outDir(this, a, name), W = writer(dir), meta = {}, shown = [];
  const seed = a.seed ?? 1;
  for (const k of kinds) {
    let im, info;
    if (k === 'sun') { im = sunSprite({ size: a.sun_size ?? 256, color: a.sun_color ?? 'yellow', spikes: a.spikes ?? 4, seed }); info = { blend: 'additive', note: 'camera-facing quad at the star direction; scale with distance; colours: ' + Object.keys(SUN_COLORS).join(', ') }; }
    else if (k === 'flare') { im = flareSheet({ cell: 64, color: a.flare_color ?? '#a8c8ff' }); info = { blend: 'additive', cells: im.cells, cell_px: im.cell, ghosts: [{ cell: 'glow', t: 0, scale: 1.5 }, { cell: 'ring', t: 0.35, scale: 0.6 }, { cell: 'hex', t: 0.6, scale: 0.4 }, { cell: 'hex', t: 0.85, scale: 0.25 }, { cell: 'ring', t: 1.2, scale: 0.9 }, { cell: 'streak', t: 0, scale: 4 }], note: 'place element i at sun_screen + (centre - sun_screen) * 2 * t; fade by sun visibility' }; }
    else if (k === 'debris') { im = debrisCard({ size: 256, seed }); info = { blend: 'alpha (MASK 0.5)', tileable: true, note: 'stack 3-5 parallax planes drifting at different speeds' }; }
    else if (k === 'dust') { im = dustStorm({ size: 256, frames: 4, seed, color: a.dust_color ?? '#c89a6a' }); info = { blend: 'alpha', frames: im.frames, cell_px: im.cell, tileable: true, fps: 6, note: 'scroll UVs too; tint per planet palette' }; }
    else if (k === 'lightning') { im = lightning({ size: 128, frames: 4, seed, color: a.bolt_color ?? '#c8b8ff' }); info = { blend: 'additive', frames: im.frames, cell_px: im.cell, fps: 12, note: 'flash 2-3 frames then hide; pair with a point light pulse' }; }
    else throw new Error(`fx kinds: sun, flare, debris, dust, lightning (got "${k}")`);
    meta[k] = { file: W.png(`${name}_${k}.png`, im.width, im.height, im.data), size: [im.width, im.height], ...info };
    shown.push({ img: im, label: k.toUpperCase() });
  }
  W.json(`${name}.fx.json`, { ...meta, timings_ms: { total: T.total() } });
  const sheet = packImages(shown, { checker: true, columns: 3 });
  return { fx: name, dir, files: W.files, ms: T.total(), image: encodePNG(sheet.width, sheet.height, sheet.data) };
}

function planetInfo() {
  const stored = fs.readdirSync(planetDir(this)).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5));
  return {
    planet_presets: Object.fromEntries(PRESET_NAMES.map((k) => [k, PRESETS[k].about])), sky_presets: Object.fromEntries(Object.entries(SKY_PRESETS).map(([k, v]) => [k, v.about])),
    rock_kinds: [...Object.keys(ROCK_KINDS), 'crystal', 'grass', 'mesa', 'butte', 'spire', 'arch'], fx_kinds: ['sun', 'flare', 'debris', 'dust', 'lightning'], planets: stored,
    limits: { texture_px: MAX_TEX, lods: 'planet lods = cells per face edge, decreasing', tiles_levels: '0..4' },
  };
}

export const PLANET_OPS = {
  planet_create: planetCreate, planet_system: planetSystem, planet_terrain: planetTerrain, planet_rocks: planetRocks,
  planet_asteroids: planetAsteroids, planet_skybox: planetSkybox, planet_fx: planetFx, planet_info: planetInfo,
};
export { latLonDir, elevKm };
