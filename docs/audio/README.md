# Sound effects and music: `art_audio`

[Back to the README](../../README.md)

Agents cannot hear, so `art_audio` turns audio into things they can read: an analysis image (waveform with beat grid and onsets, log spectrogram, loudness and energy per section, goniometer, band balance; `view:"mix"` overlays stem spectra and marks masking) and a **listener report** in plain words: what a listener taps along to versus the written BPM, the drum feel per section (half-time, blast, double-kick, four-on-the-floor, ...), the key/mode and chord progression, timbre words (dark, muddy, harsh, distorted and which stem, reverb size), what stands out or is buried, what gets repetitive, and how it compares with a genre profile and the stated intent. `critique` ranks issues by audibility and names the parameter to change.

- **SFX:** 58 seeded recipes (gore, combat, holy, UI, monsters, sfxr classics, plus FPS/sci-fi below) with `vars` (pitch, length, intensity, variation, wet, target) and `variants` for batches; or sfxr params, or your own layers. Normalised to the peak `target` (default -1 dBFS), head silence trimmed.
- **FPS and sci-fi SFX:** firearms (`gunshot_rifle`, `_pistol`, `_revolver`, `_marksman`, `_shotgun`, `_smg`, `_lmg`, `_suppressed`) are real CC0 field recordings ([credits](../../src/audio/samples/CREDITS.md)). The seed picks the shot, `vars.distance: "near"|"far"` picks the close or distant recording, and `vars.environment: "outdoor"|"indoor"|"canyon"` keeps the recorded outdoor tail or adds a room or canyon echoes. The synthesized versions (crack, body, thump, sub, mechanics, environment tail) stay as `gunshot_*_synth`. Weapon handling: `mag_out`, `mag_in`, `bolt_rack`, `dry_fire`, `shotgun_pump`, `casing_drop`. Sci-fi: `laser_bolt`, `plasma_shot`, `shield_hit`, `glitch_tear`, `teleport_swell`, `servo`, `drone_rotor` (loop), `hologram_ui`, `alarm_klaxon` (loop), `radio_squelch_on`/`_off`, `bullet_whiz`, `ricochet`, and `footstep` (`vars.surface: metal|dirt|concrete|snow|grate`).
- **SFX options:** `fx:[{type:"dc"|"eq"|"comp"|...}]`, `reverb:{preset, wet}`, `target` and `loop:true` (a seamless crossfaded loop with loop points on export) work on recipes and custom layers alike. Extra layer kinds: `sample` (a bundled recording such as `guns/rifle_1`, your own absolute `.wav` path, or a list the seed picks from; `pitch`, `start`, `dur`), `glide` (a tone or noise band along a frequency path, with AM, vibrato and a swell) and `glitch` (stutter, bitcrush shards, dropouts). `info` on a recipe asset shows the resolved layers to copy and edit; `delete` takes wildcards and `names:[...]`.
- **Song updates:** re-sending a saved song with only `tracks` or only `sections` merges them in (`null` removes one).
- **Music:** a compact text notation (`tempo`, `key e phrygian`, `track gtr metal_guitar gain=-3 hp=80`, `section verse 8`, `gtr: E5' E5' _ F5!`), generators (`@doom_riff`, `@organ_progression`, `@blast_beat`, `@dread_ambient`), instrument presets as JSON patches (pipe organ with wind and chiff, formant choir, modal bells, Karplus-Strong guitars double-tracked through amp and cab, bowed strings, metal and industrial kits), humanised timing, round robin, sends, buses, automation, sidechain, a cathedral reverb, and a mastering chain to a LUFS target with a true-peak ceiling. Loops wrap their reverb tail so the seam is clean.
- **Song text + JSON:** send `text` together with JSON `tracks`, `buses` or `master`; the JSON deep-merges over the parsed text, so notes stay in the text and mix tweaks go in JSON.
- **Analysis:** kick and snare detection is gated (a low-band transient with a sharp, noisy attack near the loudest hits), so choirs, wind, organ, drones and sub bass do not read as double-kick or backbeat. Distortion is measured from harmonic and intermodulation structure on loud, pitched frames, not spectral flatness, so reverb tails and drum kits do not count. The reverb RT60 comes from free decays and has a `reverb_confidence`. `loop_seam` is only reported for a real discontinuity; a level change at the seam is `loop_level_change`. One-shots get `sweep_octaves`, which tells a laser or power-up glide from an impact.
- **Export:** WAV 16/24/32-bit float with a `smpl` loop chunk and a JSON sidecar; mp3/ogg/opus through ffmpeg (`AGENT_ART_FFMPEG` or PATH). Stems and adaptive-music intensity layers with a crossfade manifest. Renders run at 44.1 kHz; `sample_rate:48000` delivers 48 kHz through a windowed-sinc resampler with sample-exact loop points.

```js
art_audio { action:"sfx", name:"gib", recipe:"gib_burst", variants:3 }
art_audio { action:"song", name:"crypt", text:"<notation>", intent:"gothic cathedral doom", genre:"cathedral_doom" }
art_audio { action:"analyze", name:"crypt" }        // image + listener report
art_audio { action:"export", name:"gib_*", format:"ogg" }
art_audio { action:"sfx", recipe:"gunshot_marksman", variants:4, vars:{ environment:"canyon" } }
art_audio { action:"sfx", name:"rifle_in", recipe:"gunshot_rifle", vars:{ environment:"indoor", intensity:0.8 }, reverb:{ preset:"room", wet:0.2 } }
art_audio { action:"sfx", name:"hum", recipe:"drone_rotor", loop:true }
art_audio { action:"sfx", name:"zap", layers:[{ kind:"glide", pts:[[0,2400],[0.25,300]], dur:0.3 }, { kind:"glitch", at:0.05, dur:0.2, gain:-9 }], fx:["dc", { comp:{ ratio:4 } }], target:-3 }
```

`art_help {topic:"music"}` has the full worked "gothic cathedral doom" track; topics `audio`, `mixing` and `perception` cover the rest.

The SFX recipe list: `art_help {topic:"audio"}`. Skills: `sfx-pack`, `music-track`.
