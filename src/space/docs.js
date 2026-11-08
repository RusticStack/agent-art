// art_help {topic:"planets"} and the planets-space skill, including the reference three.js snippets
// (atmosphere shell, night lights, quadtree tile streaming, far-planet impostor, terrain loading).
const J = (o) => JSON.stringify(o);

export const ATMOSPHERE_SNIPPET = `// three.js (r150+): atmosphere shell for <name>_atmosphere (params: <name>.planet.json -> atmosphere)
const A = meta.atmosphere; // {shell_radius, color, sunset, density, falloff, terminator}
const atmoMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
  uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uColor: { value: new THREE.Color(...A.color) }, uSunset: { value: new THREE.Color(...A.sunset) },
              uDensity: { value: A.density }, uFalloff: { value: A.falloff }, uTerm: { value: new THREE.Vector2(...A.terminator) } },
  vertexShader: \`varying vec3 vN; varying vec3 vV;
    void main() { vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }\`,
  fragmentShader: \`uniform vec3 uSun, uColor, uSunset; uniform float uDensity, uFalloff; uniform vec2 uTerm;
    varying vec3 vN; varying vec3 vV;
    void main() {
      float rim = pow(1.0 - max(dot(vN, vV), 0.0), uFalloff) * uDensity;     // fresnel rim
      float ndl = dot(vN, normalize(uSun));
      float day = smoothstep(uTerm.x, uTerm.y, ndl);                           // day / night terminator
      vec3 col = mix(uColor, uSunset, 1.0 - smoothstep(0.0, 0.45, abs(ndl))); // warm band at the terminator
      col = floor(col * rim * day * 6.0 + 0.5) / 6.0;                           // banded: PSX / pixel look
      gl_FragColor = vec4(col, 1.0);
    }\`,
});
gltf.scene.getObjectByName(name + '_atmosphere').material = atmoMat; // uSun = sun direction in world space`;

export const NIGHT_SNIPPET = `// night-side city lights (<name>_night.png or cube/<face>_night.png): emissive only where N.L < 0
mat.onBeforeCompile = (s) => {
  s.uniforms.uNight = { value: nightTex }; s.uniforms.uSun = { value: sunDir };
  s.fragmentShader = 'uniform sampler2D uNight; uniform vec3 uSun;\\n' + s.fragmentShader.replace('#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\\n float nd = 1.0 - smoothstep(-0.2, 0.05, dot(normalize(vNormal), normalize((viewMatrix * vec4(uSun, 0.0)).xyz)));\\n totalEmissiveRadiance += texture2D(uNight, vMapUv).rgb * nd;');
};
nightTex.magFilter = nightTex.minFilter = THREE.NearestFilter;`;

export const QUADTREE_SNIPPET = `// quadtree streaming of tiles/<face>/<level>/<x>_<y>.glb (index: <name>.tiles.json)
const idx = await (await fetch(base + name + '.tiles.json')).json();
const byId = new Map(idx.tiles.map((t) => [t.id, t])), loaded = new Map(), loader = new GLTFLoader();
const K = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
function want(t, camLocal, out) {                       // camLocal = camera position in planet space
  const d = Math.max(1e-3, camLocal.distanceTo(new THREE.Vector3(...t.center)) - t.radius);
  const sse = t.error * K / d;                          // screen-space error in px
  if (sse <= 1 || !t.children.length) out.push(t.id); else for (const c of t.children) want(byId.get(c), camLocal, out);
}
function update() {
  const camLocal = planet.worldToLocal(camera.position.clone()), ids = [];
  for (const r of idx.roots) want(byId.get(r), camLocal, ids);
  for (const id of ids) if (!loaded.has(id)) { loaded.set(id, null); loader.load(base + byId.get(id).file, (g) => { loaded.set(id, g.scene); planet.add(g.scene); }); }
  for (const [id, obj] of loaded) if (obj) obj.visible = ids.includes(id);   // keep parents until children arrive in a real build
}
// equal-level tiles share edges exactly; skirts (tiles[].skirt) cover the gap next to a tile one level coarser`;

export const IMPOSTOR_SNIPPET = `// far planet: camera-facing quad that ray-traces a sphere and samples the equirect albedo
const farMat = new THREE.ShaderMaterial({ transparent: true, uniforms: { uMap: { value: albedoTex }, uSun: { value: sunDir } },
  vertexShader: \`varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0) + vec4(position.xy, 0.0, 0.0)); }\`,
  fragmentShader: \`uniform sampler2D uMap; uniform vec3 uSun; varying vec2 vUv;
    void main() { float r2 = dot(vUv, vUv); if (r2 > 1.0) discard;
      vec3 n = vec3(vUv, sqrt(1.0 - r2));                    // view-space sphere normal
      vec3 d = transpose(mat3(viewMatrix)) * n;              // world direction (rotation is orthonormal; add planet spin here)
      vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
      vec3 c = texture2D(uMap, uv).rgb * (0.05 + 0.95 * max(dot(d, normalize(uSun)), 0.0));
      gl_FragColor = vec4(c, 1.0); }\`,
});  // quad side = 2 * radius; or just billboard <name>_disc.png (pre-lit) past impostor.switch_distance`;

export const GROUND_SNIPPET = `// near-ground pixel detail at any distance (same rules as the baked chunk / detail textures):
// splat (LinearFilter), tileset atlas + masks + noise (NearestFilter, RepeatWrapping)
const groundMat = new THREE.ShaderMaterial({ uniforms: { uSplat: { value: splat }, uAtlas: { value: atlas }, uMask: { value: masks }, uNoise: { value: noise },
    uSize: { value: meta.size_m }, uTileM: { value: meta.ground.tile_m }, uNoiseP: { value: meta.ground.noise.period_m } },
  vertexShader: \`varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }\`,
  fragmentShader: \`uniform sampler2D uSplat, uAtlas, uMask, uNoise; uniform float uSize, uTileM, uNoiseP; varying vec3 vW;
    void main() {
      vec2 nz = texture2D(uNoise, vW.xz / uNoiseP).rg - 0.5;
      vec4 w = texture2D(uSplat, (vW.xz + nz * 5.0) / uSize + 0.5);                 // noise-perturbed splat lookup
      float ws[4] = float[4](w.r, w.g, w.b, w.a); int A = 0, B = 1;
      for (int i = 1; i < 4; i++) if (ws[i] > ws[A]) A = i;
      B = A == 0 ? 1 : 0; for (int i = 0; i < 4; i++) if (i != A && ws[i] > ws[B]) B = i;
      float t = ws[B] / max(ws[A] + ws[B], 1e-4);
      vec2 tuv = fract(vW.xz / uTileM);                                               // one tile per tile_m metres
      float m = texture2D(uMask, vec2(tuv.x, (tuv.y + float(B)) / 4.0)).r;
      int L = m < t ? B : A;                                                          // organic, noise-masked border
      float variant = floor(texture2D(uNoise, vW.xz / (uNoiseP * 2.0)).r * 3.99);
      vec2 auv = vec2((variant + tuv.x) / 6.0, (float(L) + tuv.y) / 4.0);            // atlas: 6 columns x 4 layers
      gl_FragColor = vec4(texture2D(uAtlas, auv).rgb, 1.0);                         // + lighting / fog chunks as usual
    }\`,
});  // swap it in for the chunks within ~64 m of the camera; keep the baked textures beyond`;

export const TERRAIN_SNIPPET = `// ground patch: chunks + props + heightfield for physics
for (const c of meta.chunk_files) loader.load(base + c.file, (g) => {
  const lods = new THREE.LOD();
  for (const n of g.scene.getObjectByName(\`chunk_\${c.x}_\${c.z}_lods\`).children) lods.addLevel(n, n.userData.distance);
  g.scene.getObjectByName(\`chunk_\${c.x}_\${c.z}_collision\`).visible = false;   // physics mesh
  scene.add(lods);
});
loader.load(base + name + '_props.glb', (g) => scene.add(g.scene));    // EXT_mesh_gpu_instancing -> InstancedMesh
for (const d of meta.detail_files) loader.load(base + d.file, (g) => { g.scene.traverse((o) => { if (o.material) { o.material.polygonOffset = true; o.material.polygonOffsetFactor = -1; } }); scene.add(g.scene); });
if (meta.horizon) loader.load(base + meta.horizon.file, (g) => scene.add(g.scene));    // ring out to the far ranges
scene.fog = new THREE.FogExp2(meta.fog.color, meta.fog.density);         // sky: gradient meta.fog.sky.horizon -> zenith
const hf = await (await fetch(base + name + '.heightfield.json')).json();
const heightAt = (x, z) => { const i = Math.round((x + hf.size_m / 2) / hf.spacing_m), j = Math.round((z + hf.size_m / 2) / hf.spacing_m);
  return hf.heights[j * (hf.grid + 1) + i]; };                             // or feed hf.heights to a physics heightfield`;

export const PLANET_TOPICS = {
  planets: `PLANETS AND SPACE (art_planet) — pixel-art planets you see from orbit and land on, terrain, skyboxes
One seeded field per planet (3D noise on the unit sphere) drives every output, so orbit maps, cube faces, mesh LODs,
quadtree tiles and ground patches agree. Textures are palette ramps (banded + ordered dither), NEAREST, max 1024 px.
1. Planet: ${J({ action: 'planet', name: 'kethra', preset: 'bloom', seed: 7 })}
   presets: ice toxic bloom lava desert gas barren. Override anything: radius (mesh units, 100), real_radius_km, relief_km,
   mesh_relief (x4 exaggeration on the mesh), sea_level (0..1 | null), noise {type: fbm|ridged|billow, octaves, frequency, warp},
   continents {frequency, weight}, moisture, biomes:[{name, where:{water?, height?:[a,b], lat?:[a,b], moisture?:[a,b]}, ramp:[dark..light],
   by: height|moisture|lat|noise|depth, rough, emissive?, glow?}] (first match wins, last = fallback), ramps:{<biome>: [...]} (recolour),
   hue (deg), seams {ramp, width, frequency, emissive}, craters {count, min, max, depth}, canyons {amount, width, depth},
   cities {density, color}, clouds {coverage, frequency, color, shadow, levels} | false, rings {inner, outer, ramp, gaps, tilt} | false,
   atmosphere {color, sunset, density, height, falloff} | false, palette:[..] | "project:<name>" (quantise albedo), dither:false.
   Output sizes: equirect (1024 wide), face (256), lods ([48,24,12,6] cells per face edge), tiles {levels:2, segments:16, px:64} | false.
   Files in exports/<name>/: <name>_albedo|height|height16|normal|rough|emissive|night|clouds|rings.png (equirect), cube/<face>_*.png,
   <name>.glb (root with tilt > _lods LOD0..n, _clouds, _atmosphere, _rings), tiles/*.glb + <name>.tiles.json,
   <name>_impostor(_n).png + _disc.png (far LOD), <name>_orbit.png, <name>.planet.json (params, numbers, timings).
2. System: ${J({ action: 'system', seed: 3, count: 6 })} -> original star + 4..8 bodies (distinct biomes, orbits, moons),
   <name>.system.json + palette strip render. bake:{equirect:512, face:128} also bakes each body.
3. Ground: ${J({ action: 'terrain', planet: 'kethra', lat: 12, lon: 30, size: 512 })} -> landing zone (+X east, +Z south, m).
   Relief: planet elevation + detail + ridged-multifractal mountain ranges on some sides of the horizon + dunes (desert) +
   mesas / escarpments, then thermal (scree) + droplet hydraulic (gullies) erosion; a flat pad (pad {radius:40}) stays put.
   Ground: per-biome tilesets painted with cells / noise / scatter / line (plates, ripples, gravel, mud, ice, toxic, moss, snow,
   glow, regolith), 4 variants + 2 transition tiles per layer, 64 px per 2 m (32 px/m); per texel a noise-perturbed splat lookup,
   noise-masked dithered borders with a 1 px rim, strata bands on steep faces. chunks/*.glb (8 px/m, LOD steps [1,2,4,8], skirts,
   collision), detail/*.glb (32 px/m decals around the pad), <name>_horizon.glb (ring to horizon.radius, fogged), splat.png
   (ground, rock, low, scree; bytes sum to 255), tileset / ground_masks / ground_noise png (runtime shader), heightfield.json,
   props.glb (instanced, clustered: boulder clusters at cliff bases / gullies, debris, spires, shrub clumps, crystal outcrops),
   formations.glb (arches), anchors + fog {color, density, sky} in .terrain.json, renders overview / eye (1.7 m) / wide.
   Options: grid (256), chunks (4), chunk_px (1024), detail_patches (3), mountains {height, wavelength} | false,
   dunes | false, erosion {droplets, thermal, talus} | false, horizon {radius, rings, segments} | false,
   rocks, debris, shrubs, crystals, spires, mesas, cliffs, arches (counts or false), detail {amplitude, wavelength}.
4. Kits: ${J({ action: 'rocks', planet: 'kethra', kinds: ['boulder', 'rock', 'slab', 'shard', 'pebble', 'crystal', 'mesa', 'arch'] })}
   ${J({ action: 'asteroids', field: { shape: 'belt', count: 600, inner: 600, outer: 900, thickness: 60, size: [2, 40] } })}
5. Backdrops: ${J({ action: 'skybox', preset: 'ember', size: 512, format: 'both' })} (presets ember tide verdigris void; layers, galaxy, stars {density})
   ${J({ action: 'fx', kinds: ['sun', 'flare', 'debris', 'dust', 'lightning'] })}
6. info lists presets and stored planets. Conventions: equirect = three.js equirectUv (row 0 north); cube faces px nx py ny pz nz
   (OpenGL / CubeTextureLoader); terrain axes +X east, +Z south, metres. Shaders: art_help {skill:"planets-space"}.`,
};

export const PLANET_SKILLS = {
  'planets-space': {
    title: 'Planets, ground terrain and space backdrops (art_planet)',
    when: 'Planets seen from orbit and landed on, star systems, landing-zone terrain, rocks and colony anchors, asteroid fields, nebula skyboxes, sun / flare / storm sprites for a browser (three.js) or Roblox game.',
    body: `1. Pick the system first: art_planet ${J({ action: 'system', seed: 11, count: 6 })} and read the strip (one biome each, distinct palettes). Keep names original.
2. Bake each world: art_planet ${J({ action: 'planet', name: 'kethra', preset: 'bloom', seed: 7, hue: -6, equirect: 1024, face: 256 })}. Look at the orbit image; iterate on biomes / ramps / sea_level / clouds before going bigger.
   Same palette as your project: palette:"project:<name>" (dither stays ordered).
3. In three.js: GLTFLoader the .glb; THREE.LOD from <name>_lods children (userData.distance); swap <name>_atmosphere's material for:
${ATMOSPHERE_SNIPPET}
   City lights (night side only):
${NIGHT_SNIPPET}
4. Close approach: stream quadtree tiles instead of LOD0:
${QUADTREE_SNIPPET}
5. Far away (a few px): the disc sprite (<name>_disc.png) or:
${IMPOSTOR_SNIPPET}
6. Landing zone: art_planet ${J({ action: 'terrain', planet: 'kethra', lat: 12, lon: 30, size: 512 })}. The patch base elevation and colours come from the same planet field (orbit and ground match). Use anchors (landing_pad, mesa_top, arch) to place colony modules. Look at the overview / eye / wide renders; set scene.fog from meta.fog and add the horizon ring.
${TERRAIN_SNIPPET}
   Pixel ground detail everywhere near the camera (instead of only the detail decals):
${GROUND_SNIPPET}
7. Space: skybox (scene.background = new THREE.CubeTextureLoader().load([px, nx, py, ny, pz, nz]) with NearestFilter, or the equirect with EquirectangularReflectionMapping), asteroids (field glb is GPU-instanced per variant and LOD; the LOD1+ nodes (userData.lod > 0) are in the file too, so set them visible = false on load or show one level by camera distance), fx sprites (additive planes).
8. Roblox later: every texture is <= 1024 px; meshes per chunk / tile stay well under 20k triangles; Sky faces map px->Rt, nx->Lf, py->Up, ny->Dn, pz->Ft, nz->Bk; heightfield.json can drive Terrain:WriteVoxels or a MeshPart grid; instanced props become cloned MeshParts from scatter.json.`,
  },
};
