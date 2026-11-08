# Changelog

## Unreleased

### Audio

- New SFX recipes for a sci-fi FPS, each with pitch/length/intensity/variation/wet vars:
  - Firearms: `gunshot_rifle`, `gunshot_pistol`, `gunshot_marksman` (long outdoor slapback), `gunshot_shotgun`, `gunshot_smg`, `gunshot_lmg`, `gunshot_suppressed`. Each layers a crack, body, thump, sub, mechanical click and an environment tail (`vars.environment: "outdoor"|"indoor"|"canyon"`).
  - Weapon handling: `mag_out`, `mag_in`, `bolt_rack`, `dry_fire`, `shotgun_pump`, `casing_drop` (`vars.surface: metal|concrete`).
  - Sci-fi: `laser_bolt`, `plasma_shot`, `shield_hit`, `glitch_tear`, `teleport_swell`, `servo`, `drone_rotor` (loops), `hologram_ui`, `alarm_klaxon` (loops), `radio_squelch_on`/`_off`, `bullet_whiz`, `ricochet`.
  - Movement: `footstep` (`vars.surface: metal|dirt|concrete|snow|grate`).
- New layer kinds: `glide` (a tone or noise band following a frequency path, with AM, vibrato and a swell envelope) and `glitch` (stutter, bitcrush shards, dropouts).
- `fx`, `reverb`, `target`, `loop`, `tail` and `names` are declared in the `art_audio` schema. Top-level `fx` and `reverb` now work on custom layered sfx. `fx` accepts `[{type}]`, `"dc"`, `{comp:{...}}` or a JSON string; this fixes `fx type "undefined" unknown`. `reverb` accepts `{preset, wet}`, a preset name or a JSON string, where before it was silently ignored. On recipes, `reverb` overrides the recipe's own.
- `vars.target` (peak dBFS) is honoured for recipes and custom layers; the hover recipe used to peak at -9 dBFS while asked for -3. The critique's `too_quiet` respects the requested target.
- A `note`/`voice` layer without an instrument or patch uses a default triangle tone instead of crashing. Bad layers (unknown kind, instrument or recipe) fail before anything is saved, and a failed render no longer leaves an empty asset behind.
- `pitch_env`, `amp`, `filter`, `vibrato` and `oneshot` set on a layer override its patch. A negative `pitch_env.amount` rises, and `pitch_env.shape:"linear"` sweeps evenly over `time`. The recipe helper's `up` option now actually rises.
- sfxr layers with a DC offset (square/saw slides) get a 20 Hz DC-blocking high-pass; `dc:false` keeps the raw output. Pitch clarity is measured on mean-removed frames, so an offset no longer reads as a clear tone.
- `loop:true` (or `{length, crossfade}`) on sfx gives a seamless equal-power crossfaded loop, with loop points in the export (WAV `smpl`, OGG tags, sidecar).
- `delete` accepts wildcards (`"pew_*"`) and `names:[...]`, like `export`.
- Partial song update: re-sending a saved song with only `tracks` or only `sections` merges them into it per track/section (`null` removes one).
- Analysis: drumless material (pads, drones) prefers the half-tempo candidate when its onset strength is comparable, so slow pads are no longer felt at double tempo. `loop_level_change` compares beat-aligned RMS windows when the tempo is known and discounts level changes the loop itself makes, so rhythmic loops with intended gaps no longer trigger it.
- `info` on a recipe-made sfx shows `resolved: {layers, fx, reverb, target}`; sending these back with the same seed reproduces the sound.

### Canvas and animation

- `art_canvas crop` on frame strips crops every frame with the same rect (in frame coordinates) and keeps frames, animations, tags and rig anchors. It used to flatten the canvas to one frame.
- `rotate {angle, expand:true}` grows the canvas (every frame) to fit the rotated content, so nothing is cut off. The default is unchanged.
- `outline` no longer doubles to 2 px when re-run. `skip_existing:true` treats pixels already in the outline colour as outline. It is on by default when the layer already contains that exact colour; `skip_existing:false` restores the old behaviour.
- `clear` with no region clears the whole layer (or the whole frame when `frame` is set). This is now documented.
- `stamp_visible {keep_visible:true}` keeps the source layers visible.
- `ellipse` honours `thickness`, like `rect`.
- `text {font:"5x7"|"7x9"}` adds two larger built-in fonts (A-Z, 0-9 and punctuation); 3x5 stays the default.
- Spritesheet export `json:false` skips the sidecar json. The shared exporter checks `a.json === false`.
- `noise` accepts a `"keep"` colour that leaves pixels unchanged. Under a `mask`, transparent noise colours only erase with `erase:true`.
- `adjust {alpha}` is a change in opacity (-1..1), clamped to 0..1, and bad values get a clear error. `set_alpha` sets opacity directly. Behaviour change: `alpha:0.5` no longer means "half opacity"; use `set_alpha:0.5`.
- `mask:"!<color>"` paints everywhere except that colour.
- `glow {select:"value"|"luma"|"saturation"}` defaults to HSV value, so saturated neon blooms; `luma` gives the old behaviour.
- `gradient {dither:false}` means no dither. Radial gradients fill the corners with the outer colour, so there is no rectangle at the region edge.
- `art_view {tile>1}` uses more of `max_size` (larger zoom plus a nearest-neighbour downscale). For example, `{tile:3, max_size:300}` on a 64 px texture gives 300 px instead of 192.
- `art_draw {commands_file:"<path>.json"}` reads a JSON array of commands, or `{commands:[...]}`, from a file.
- `art_critique {tileable:true}` returns `seams: {ok, edge, interior, worst:[x,y,delta]}`.

## 0.4.0

### Added

- **`art_model` ship and vehicle kit:**
  - Translucent materials: `opacity:0..1` and `glass:true` export glTF `alphaMode:"BLEND"` (opacity in `baseColorFactor`, texture alpha respected). Glass is double-sided, and extras carry `depthWrite:false`. The image is shared with the opaque material, atlas skips these materials, and the preview blends them. `double_sided:true` is also available on its own.
  - New primitives:
    - `wedge` (`top_w`, `top_d`, `shift:[x,z]`).
    - Box `taper` (front-face scale), `bevel` (chamfer px) and `insets` (recessed or raised panels, no CSG), plus the `inset` part.
    - Cylinder `r_top`/`r_bottom` (frustum), and `cone`.
    - `loft` (`shape` with `scale_end`, `shift_end`, `about`).
  - `shape` `plane:"zy"`: side profile `[z,y]`, extruded along x.
  - Part `mirror:"x"|"y"|"z"|[...]` emits mirrored copies with correct winding and normals.
  - `pivot:[x,y,z]` rotates and scales about a local point.
  - Radial arrays: `array.about:[x,y,z]`.
  - Cylinder `wrap:"once"|"repeat"` (`repeat:n`) and `u_offset` (turns).
  - `art_model create` suggests `origin:"bottom"` for off-centre models.
  - `art_help 3d` and the README document the transform order: scale, then rotate X then Y then Z about the part origin or pivot, then turn, then `at`.
  - `art_model` schema: a typed part object (`pivot`, `mirror`, `opacity`, `glass`, `plane`).

### Fixed

- `shape` with an unknown `plane` (for example `"zy"` before this release) silently built `xy` geometry. `zy` is now supported, and any other plane throws a clear error.

## 0.3.0

Everything since 0.2.1.

### Added

- **`art_model` (3D, HD-2D):** low-poly models textured with pixel art, exported as glTF 2.0 `.glb` with no dependencies.
  - Modular kit pieces: `floor`, `wall`, `corner`, `pillar`, `column`, `arch`, `vault`, `stairs`, `ledge`, `balustrade`, `roof`, `rubble`, `box`, `cylinder`/`prism`, `plane`, `shape`.
  - Props: `extrude` (with `depth_map` relief) and `lathe`. Layouts: `model` places other models.
  - Ruins: `broken` edges, `holes` from mask canvases, and scattered `rubble`.
  - Smooth outlines (marching squares plus simplification); `style:"voxel"` keeps the blocky look.
  - World-space UVs at 1 texel = 1 px, continuous across placed pieces (`uv_origin`).
  - Overlays: grime, moss, blood and wear decal shells on `TEXCOORD_1`.
  - Emissive layers and normal maps.
  - Preview contact sheets from a software rasterizer: game camera, front, side, top and iso.
  - Export modes: one baked mesh, `instances`, or `atlas`. `up:"z"` for Z-up engines.
- **Connected textures (`art_model ctm`):** OptiFine/Continuity-style tilesets.
  - Methods: `full` (47), `compact`, `horizontal`, `vertical`, `horizontal+vertical`, `top`, `random`, `repeat`, `overlay`.
  - Baked per world cell from the neighbours across all placed pieces.
  - Export writes `<name>.ctm.json` plus the tileset PNGs, and the README gives a reference `ctmTileFor`.
- **`art_audio`:** sound effects, music, mixing and mastering, with analysis an agent can read.
  - SFX: 31 seeded recipes, sfxr, and custom layers.
  - Instrument presets as JSON patches, plus samplers.
  - Song text notation and generators.
  - Buses, sends, automation and sidechain.
  - A mastering chain to a LUFS target with a true-peak ceiling.
  - Analysis: an analysis image, a listener report, critique and reference compare.
  - Export: WAV with `smpl` loops and JSON sidecars; mp3/ogg/opus through ffmpeg; stems and adaptive-music layers.
- Help topics `3d`, `audio`, `music`, `mixing`, `perception`, and skills `3d-kit`, `sfx-pack`, `music-track`.
- `sample_rate: 44100 | 48000` on audio song, sfx, render and export.
  - Renders run at 44.1 kHz. 48 kHz delivery uses a Kaiser-windowed sinc resampler.
  - The loop body is resampled as a periodic segment, so loop points stay sample-exact and the seam stays clean.
  - Sidecars and layer manifests report the delivered rate. Imported WAVs at other rates use the same resampler.
- `/api/health` reports the server's workspace (`home`).
- One-shot analysis reports `sweep_octaves`. Timbre reports `reverb_confidence` and `harmonic_extension_db`.

### Changed

- **Workspace:** there is no implicit fallback to a `./workspace` folder next to a source checkout. The workspace is `--home`, then `AGENT_ART_HOME`, then `~/.agent-art`. `serve` and `mcp` print a note when a legacy `./workspace` exists.
- **MCP proxy backend:** it proxies only to a server on the same workspace. If the proxied server dies mid-session, it re-probes ports 7420-7440 for a server on the same workspace; otherwise it hosts one itself on that workspace. Each switch is logged to stderr, and the failed call is retried once.
- `lathe` simplifies its profile before revolving: collinear runs are merged, then Douglas-Peucker runs with `simplify` px (default 0.75). Flat steps keep their texture rows.
- Overlay shells are tessellated adaptively: `detail` defaults from the falloff and face size (16-64 px). Uniform areas, such as `where:"all"` or a constant weight, are not split.
- glTF alpha MASK is used only when a triangle samples a transparent texel. Unused CTM atlas slots no longer force MASK.
- Rhythm perception gates kicks and snares:
  - An absolute level gate.
  - Transient sharpness and noisiness.
  - A 35-110 Hz filter-bank low band.
  - Percussive-only snare and hat onsets.
- Distortion is measured from harmonic and intermodulation structure on loud, pitched frames, discounting reverb tails. Spectral flatness is no longer used, and drum stems are excluded from the mix distortion verdict.
- The reverb RT60 is estimated from free decays (note endings) per octave band, with a confidence value. The space description says when confidence is low.
- The critique `loop_seam` is reported only for a real waveform discontinuity. A level change at the seam is a low-weight `loop_level_change`.
- The SFX classifier separates pitch sweeps from impact transients. A sweep is a steady one-way glide while the level holds, so lasers and power-ups are no longer called impacts and impacts with a falling body are no longer called falling tones.
- Docs: the music topic and the `music-track` skill explain that song `text` plus JSON `tracks`/`buses`/`master` deep-merge.

### Fixed

- `model_create` keeps the model-level options `overlays` and `uv_origin` (and `grid`, `scale`, `origin`, `notes`, `project`). `update` can set them, and `null` clears them.
- CTM `random` with only `variants` uses `variants[0]` as the base.
- The `emissive` layer is left out of the albedo and used only for the emissive texture.
- `line` and `curve` no longer report `width`, `brush` or `pixel_perfect` as ignored fields. They always worked; the warning was wrong.
- In CLI `batch`, an absolute `out` path is used as is instead of being joined to `--out-dir`.
- Choir, wind, organ, drones and sub bass no longer read as `double_kick` or `backbeat`.
