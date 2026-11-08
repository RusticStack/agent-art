// art_help {topic:"fx"} and the combat-fx skill, with the reference three.js snippet (flipbook sprite,
// additive / premultiplied material, point-light curve) and Roblox ParticleEmitter notes.
const J = (o) => JSON.stringify(o);

export const FX_THREE_SNIPPET = `// three.js (r150+): play one art_fx flipbook from <group>.fx.json
const man = await (await fetch('fx/fx.fx.json')).json(), m = man.effects['muzzle_rifle_side'];
const tex = new THREE.TextureLoader().load('fx/' + m.file);
tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
tex.repeat.set(m.cell[0] / m.sheet[0], m.cell[1] / m.sheet[1]);
const blending = { additive: THREE.AdditiveBlending, alpha: THREE.NormalBlending, premultiplied: THREE.CustomBlending }[m.blend];
const mat = new THREE.SpriteMaterial({ map: tex, blending, depthWrite: false, transparent: true, alphaTest: m.blend === 'alpha' ? 0.5 : 0 });
if (m.blend === 'premultiplied') { mat.premultipliedAlpha = true; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor; } // alpha-0 texels add light, alpha-255 texels occlude
const spr = new THREE.Sprite(mat); spr.center.set(m.pivot_uv[0], 1 - m.pivot_uv[1]); spr.scale.set(m.size_m, m.size_m * m.cell[1] / m.cell[0], 1);
const light = m.light && new THREE.PointLight(m.light.color, 0, m.light.radius_m);
function setFrame(k) { // k = frame index; cells row-major from the top-left
  const c = k % m.grid[0], r = Math.floor(k / m.grid[0]);
  tex.offset.set(c * m.cell[0] / m.sheet[0], 1 - (r + 1) * m.cell[1] / m.sheet[1]);
}
function lightAt(ms) { // piecewise-linear [[ms, intensity]]; loop: ms %= the last key
  const I = m.light.intensity, t = m.light.loop ? ms % I[I.length - 1][0] : ms;
  for (let i = 1; i < I.length; i++) if (t <= I[i][0]) { const a = I[i - 1], b = I[i]; return a[1] + (b[1] - a[1]) * (t - a[0]) / Math.max(1, b[0] - a[0]); }
  return m.light.loop ? I[0][1] : 0;
}
// each tick: const ms = now - start, k = Math.floor(ms * m.fps / 1000);
// if (!m.loop && k >= m.frames) remove(); else { setFrame(m.loop ? k % m.frames : k); if (light) light.intensity = lightAt(ms); }
// fp muzzle (m.facing "screen"): draw on the HUD / viewmodel layer with the pivot on the frame's muzzle anchor;
// m.fp.shake -> camera shake (amp_px at the 384x216 frame), m.fp.flash -> full-screen tint for flash.ms.
// emitters: spawn extra particles from particles.png cells (m.emitters[i].cell = "particles:spark" etc.).`;

export const FX_TOPICS = {
  fx: `COMBAT FX (art_fx): seeded pixel-art effect flipbooks + engine metadata -> exports/<path|fx>/
Every frame is a pure function of (options, seed, t): same input = byte-identical sheet. Colours come from hue-shifted ramps (emission: dark red -> white core; matter: cool shadow -> warm light) with ordered Bayer dither; alpha is 0 or 255 only.
- make {type, variant?, seed?, size? (cell px or [w,h]), frames? (1-64), fps?, hue? (deg, rotates emission ramps), palette? (["#rrggbb"..] | "project:<name>": every colour snapped onto it), name?, group? ("fx"; letters, digits, _ -), path?, canvas? (true | name: open the frames in the UI; overwrite:true replaces an existing canvas)}
  -> <group>/<id>.png (sheet <= 1024 px; square cells use a Roblox grid: 4 frames = 2x2, 16 = 4x4, 64 = 8x8) and the entry in fx.json (groups -> id -> metadata). premultiplied sheets also get <group>/<id>_straight.png (Roblox). File paths in the metadata are relative to the fx folder.
- types / variants:
  muzzle: pistol smg rifle dmr shotgun lmg sniper launcher energy plasma; view side (third person, points +x, pivot at the muzzle) | front (into camera) | fp (screen space, centred on the fp muzzle anchor, flame cone toward the frame centre: aim_deg or anchor:[x,y] + frame_size [384,216]); suppressed:true.
  tracer: ballistic energy plasma (head at the right edge; stretch along velocity). casing: rifle pistol shotgun (spin loop). dust: mag_drop landing.
  impact: metal concrete stone glass dirt sand water flesh armor shield electronics (sprite up = surface normal, pivot at the hit point).
  decal: all | bullet_metal bullet_concrete bullet_glass bullet_armor bullet_electronics bullet_dirt scorch blood energy_burn (list ok); variants (per kind, 4), size (cell, power of two) -> <group>/<id>.png albedo, <id>_n.png normal (tangent, +Y up), <id>_h.png height (128 = surface), <id>_e.png emissive; cells:{kind:[[x,y,w,h]..]}, material hints (alpha_test, emissive_strength, polygon_offset).
  explosion: frag plasma emp incendiary. smoke: column grenade (color:"#rrggbb") muzzle trail. fire: small large. sparks: shower arc. steam: vent leak. strobe: red amber blue green (mode pulse | beacon). haze: flame sheet (distortion mask: RG offset, A strength). particles: 8x8 cells spark ember glint hex chip shard droplet dust blood smoke.
  Loops (tracer casing smoke column/grenade/trail fire sparks steam strobe haze) are periodic: the last frame flows into the first.
- metadata per effect: blend (additive | alpha | premultiplied: alpha-0 texels add light, 255 occlude | distortion), frames, fps, loop, duration_ms, cell, grid, pivot (+ pivot_uv), facing (camera | camera_up | camera_axis | velocity | surface | screen), size_m, emitters [{cell: particles:<name> | fx:<id>, count, rate_per_s?, velocity {dir, cone_deg, speed_mps}, gravity_mps2, drag, lifetime_s, bounce?, size_over_life, color_over_life, alpha_over_life?}], light {color, radius_m, intensity [[ms, v]], loop?} (dynamic point light), fp {shake {amp_px, freq_hz, decay_ms}, flash {color, alpha, ms}, anchor, events} for first person, sound [art_audio recipe names: art_audio sfx {recipe}], decal (what to stamp), roblox {flipbook, light_emission, file, note}.
- batch {preset: all | muzzle | impact | items:[{type, ...}], seed?, hue?, palette?, group?} = many makes + <group>_contact.png.
- preview {...make options, scale?:3 (1-8; lowered so frames stay <= 1024 px and the strip fits one sheet), over?:{canvas, frame?, anchor?:"socket_muzzle" | [x,y]}} -> previews/<id>.gif + frame strip; over composites the effect on a canvas frame at an anchor (art_model render fp frames store socket_muzzle per frame; its screen rotation becomes aim_deg).
- list = types, variants, weapon classes, surfaces, limits, manifest groups. export {group?} validates every entry (schema, files on disk, PNG size = sheet, <= 1024 px) and writes <group>.fx.json for the game.
three.js:
${FX_THREE_SNIPPET}
Roblox: ParticleEmitter.Texture = the sheet (or <id>_straight.png for premultiplied), FlipbookLayout = roblox.flipbook (Grid2x2 / Grid4x4 / Grid8x8; only square sheets, frames = 4 / 16 / 64 for no blank cells), FlipbookMode OneShot (loop: Loop), Lifetime = duration_ms / 1000, LightEmission = roblox.light_emission (1 additive, 0.5 premultiplied fallback, 0 alpha), Size from size_m (studs = m / 0.28), ResampleMode Pixelated on ImageLabels; tracers (non-square) -> Beam with the sheet; decals -> crop cells into Decal / SurfaceAppearance images (no UV rects); dynamic light: PointLight Brightness from light.intensity. Distortion masks have no Roblox equivalent (skip haze).`,
};

export const FX_SKILLS = {
  'combat-fx': {
    title: 'Combat visual effects for a pixel-art shooter (art_fx)',
    when: 'Muzzle flashes, tracers, casings, bullet impacts and decals, explosions, smoke, fire, sparks, alarms for a browser (three.js) or Roblox FPS / TPS with pixel-art sprites.',
    body: `1. Lock the look first: art_fx ${J({ action: 'make', type: 'muzzle', variant: 'rifle', view: 'side', seed: 3 })} and ${J({ action: 'make', type: 'impact', variant: 'metal' })}. Shift hue (hue:-8 warmer) or palette:"project:<name>" so effects share the game palette.
2. Whole set in one call: ${J({ action: 'batch', preset: 'all', seed: 3, group: 'combat' })} -> read <group>_contact.png; remake single effects with another seed or size where they read badly at game scale (impacts must read at 1-2 px per detail in a 384x216 frame).
3. First person: render the gun with art_model render {camera:"fp", size:[384,216]} (socket_muzzle per frame), then ${J({ action: 'preview', type: 'muzzle', variant: 'rifle', over: { canvas: 'ar_fire', anchor: 'socket_muzzle' } })}; make the fp variant with the same anchor / aim_deg for the game.
4. Pair sounds: each entry's sound list = art_audio sfx recipes (gunshot_rifle, ricochet, explosion ...). Pair lights: entry.light drives a point light per frame.
5. ${J({ action: 'export', group: 'combat' })} -> combat.fx.json (validated). Load it with the snippet in art_help {topic:"fx"}; Roblox notes there too.`,
  },
};
