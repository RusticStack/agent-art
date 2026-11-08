# Changelog

## Unreleased

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
