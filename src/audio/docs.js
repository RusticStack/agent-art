// art_help topics (audio, music, mixing, perception) and skills (sfx-pack, music-track).
import { RECIPE_GROUPS } from './sfx.js';
import { PRESETS, DRUMS } from './presets.js';
import { GENRES } from './genres.js';
import { REVERBS } from './fx.js';

const J = (o) => JSON.stringify(o);

/** The worked "gothic cathedral doom" track (also the demo). 100 BPM, 32 bars = 76.8 s, loops. */
export const DOOM_CATHEDRAL = `tempo 100
time 4/4
key e phrygian
reverb cathedral
loop all
master target_lufs=-14
track organ cathedral_organ:full gain=-5 reverb=0.6 hp=220 cut=900 cut_db=-6 cut_q=0.7
track pedal cathedral_organ:pedal gain=-3 reverb=0.5 octave=2 root_only=true
track choir choir_pad gain=-5 reverb=0.7
track bells church_bells gain=-3 reverb=0.6 hp=300
track gtr metal_guitar gain=-3 octave=2
track bass bass_guitar gain=-8 octave=1 root_only=true
track drums metal_kit gain=-5
track drone dread_drone gain=-6 reverb=0.4
section intro 4
organ: Em _ | Em _ | C _ | B _
pedal: e2 | e2 | c2 | b1
bells: e4 . . . | . . . . | e4 . . . | . . bb4 .
drone: e1 | _ | _ | _
drums.tom3: ................|................|................|........x.x.xXxX
drums.crash: ................|................|................|...............X
section verse 8
gtr: @doom_riff style=chug seed=4 bars=2
bass: @doom_riff style=chug seed=4 bars=2
drums: @blast_beat style=half_time seed=2 bars=4 fill=true
organ: Em _ | F _ | Em _ | Bb _
section blast 4
gtr: E5% _ _ _ | F5% _ _ _ | G5% _ _ _ | F5% _ _ _
bass: E5 _ _ _ | F5 _ _ _ | G5 _ _ _ | F5 _ _ _
drums: @blast_beat style=blast seed=3 bars=4 fill=true
choir: Em | F | G | F
organ: Em | F | G | F
section breakdown 4
gtr: @doom_riff style=doom seed=7 bars=4
bass: @doom_riff style=doom seed=7 bars=4
drums: @blast_beat style=doom seed=5 bars=4
bells: e4 . . . | . . . . | e4 . . . | . . . .
section verse2 8
gtr: @doom_riff style=gallop seed=9 bars=2
bass: @doom_riff style=gallop seed=9 bars=2
drums: @blast_beat style=double_kick seed=6 bars=4 fill=true
choir: Em | F | Em | Bb
organ: Em _ | F _ | Em _ | Bb _
section outro 4
organ: Em _ | C _ | F _ | B _
pedal: e2 | c2 | f2 | b1
choir: Em | C | F | B
gtr: E5! _ _ _ | C5 _ _ _ | F5 _ _ _ | B5 _ _ _
bass: E5 _ _ _ | C5 _ _ _ | F5 _ _ _ | B5 _ _ _
drums: @blast_beat style=doom seed=8 bars=4
drone: e1 | _ | _ | _
arrange intro verse blast breakdown verse2 outro`;

export const AUDIO_TOPICS = {
  audio: `AUDIO (art_audio): SFX, instruments, songs, analysis you can SEE and READ (you cannot hear).
LOOP: create (sfx/song) -> analyze (image + listener report) -> critique (ranked issues + fixes) -> edit the definition -> re-render -> export.
SFX: art_audio {action:"sfx", recipe:"gib_burst", seed:1, variants:3, vars:{pitch:0 (semitones), length:1, intensity:0.6, variation:0.5, wet:0.7, reverb?}} -> assets gib_burst_1..3. Recipes:
${Object.entries(RECIPE_GROUPS).map(([g, l]) => `  ${g}: ${l.join(' ')}`).join('\n')}
  sfxr: {params:{wave:"square|saw|sine|noise", freq:0.3, slide:-0.2, attack, sustain, punch, decay, lpf_freq, hpf_freq, vib_strength, arp_mod, repeat_speed, phaser_offset, duty...}} (sfxr ranges 0..1 / -1..1).
  Custom layers: {layers:[{kind:"voice"|"note"|"sfxr"|"crackle"|"drops"|"squelch"|"growl"|"whoosh"|"glide"|"glitch"|"sample"|"recipe", at:s, gain:dB, pan, ...}], fx:[...], reverb:{preset, wet}}.
  SFX are trimmed (no head silence), faded and normalised to peak -1 dBFS (target:-3 for UI).
FPS / SCI-FI SFX (firearms, weapon_handling, scifi, movement groups above):
  Firearms gunshot_rifle|pistol|marksman|shotgun|smg|lmg|suppressed layer a transient crack, body, thump, sub, mechanical click and an environment tail: vars.environment "outdoor" (slapback; marksman = long slapback) | "indoor" (room) | "canyon" (long repeating echoes). vars.wet scales the tail, intensity the crack/drive.
  Handling: mag_out mag_in bolt_rack dry_fire shotgun_pump casing_drop (vars.surface "metal"|"concrete"). footstep vars.surface "metal"|"dirt"|"concrete"|"snow"|"grate".
  Sci-fi: laser_bolt plasma_shot shield_hit glitch_tear teleport_swell servo drone_rotor hologram_ui alarm_klaxon radio_squelch_on radio_squelch_off bullet_whiz ricochet. drone_rotor and alarm_klaxon are loops by default (loop:false = one-shot).
  Steam (art_fx steam): steam_hiss (one-shot burst: a valve opening, a pipe bursting), steam_vent (steady roar, loop), steam_leak (thin sputtering jet, loop); the loops are seamless by default.
  Example: {action:"sfx", recipe:"gunshot_rifle", variants:4, vars:{environment:"canyon", intensity:0.8}}.
SFX OPTIONS (recipes and custom layers alike):
  fx:[{type:"dc"|"eq"|"comp"|"drive"|"delay"|...}] runs on the mixed layers (also "dc", ["dc","comp"] or {comp:{ratio:4}}). reverb:{preset:"room"|"studio"|"hall"|"plate"|"crypt"|"cathedral", wet:0.3} | "hall" | false. target:-3 or vars.target = peak dBFS. tail:s = padding for delay/reverb tails.
  loop:true | {length:s, crossfade:s} = seamless loop: the end crossfades (equal power) into the start and export writes loop points (WAV smpl, OGG tags).
  Layer kinds also: sample {sample:"C:/sfx/shot.wav" (an absolute .wav path, stereo is mixed to mono) | [several paths] (the seed picks one), pitch semitones, start s, dur s} layers your own recording with the synth layers; glide {wave|noise:true, pts:[[t,hz],...] or f, dur, a, r, decay, env:"swell", am:{rate,depth}, vib:{rate,depth cents}, lp, bp, q, track} and glitch {dur, density, f}.
  note/voice layers without instrument/patch use a plain triangle tone; pitch_env/amp/filter/vibrato set on the layer override the patch. pitch_env.amount = start offset in semitones gliding back to the note: positive falls, negative rises; shape:"linear" sweeps evenly over time.
  sfxr layers are DC-blocked (20 Hz high-pass) when they carry an offset; dc:false keeps the raw output.
  info {name} on a recipe asset shows resolved:{layers, fx, reverb, target}: send them back as {layers, fx, reverb, seed} to reproduce and edit the sound. delete {name:"pew_*"} takes wildcards.
INSTRUMENTS: art_audio {action:"instrument"} lists presets; {name:"metal_guitar"} shows the patch JSON; save a tweak {name:"my_gtr", patch:{base:"metal_guitar", fx:[{gain:40}]}}; audition {name, notes:"E5 _ F5 _"}.
Presets: ${Object.keys(PRESETS).filter((k) => !DRUMS[k]).join(' ')}; drums: ${Object.keys(DRUMS).join(' ')}.
Patch = {sources:[{type:osc|additive|modal|fm|pluck|bowed|noise|metal|sample, ...}], amp:{a,d,s,r}, filter:{type,cutoff,q,keytrack,env,env_amount,lfo}, pitch_env, vibrato, mute:{...palm-mute overrides}, layers:[{max_vel, ...velocity layer}], hits, oneshot, fx:[...], gain, pan, width, reverb (send), double (L/R takes), humanize:{time,vel}, round_robin, octave}.
SAMPLES: art_audio {action:"import", path:"kick.wav"} (mp3/ogg via ffmpeg) -> instrument {name:"my_kick", patch:{base:"sampler", sources:[{zones:[{sample:"kick", root:"c3", lo:"c0", hi:"c8", vel:[0,1]}]}]}}.
EXPORT: {action:"export", name:"gib_burst_*", format:"wav|mp3|ogg|opus", bits:16|24|32, bitrate:192, stems:true, layers:true, path:"sfx/"} -> files + <name>.json sidecar (seed + recipe to re-render). Loops get a WAV smpl chunk and OGG LOOPSTART/LOOPLENGTH tags. mp3/ogg/opus need ffmpeg (AGENT_ART_FFMPEG or PATH).
SAMPLE RATE: renders run at 44100 Hz; sample_rate:48000 (on export, or stored on song/sfx/render) delivers 48 kHz through a windowed-sinc resampler. Loop points stay sample-exact (the loop body is resampled as a seamless periodic segment); the sidecar/manifest report the delivered rate, samples and loop.
Topics: music (notation + genre recipes), mixing (chains, buses, mastering), perception (how to read analyze/critique).`,

  music: `MUSIC NOTATION (art_audio song). JSON {name, tempo, time:"4/4", key:"e phrygian", tracks:{...}, sections:{...}, arrangement:[...], loop} or {name, text:"..."} (same thing as lines).
TEXT + JSON: send both and they deep-merge: the text is parsed first, then every JSON key is merged on top (objects merge key by key, scalars and plain arrays replace, null deletes a key). So {text:"...", tracks:{gtr:{fx:[...], gain:-4}}, buses:{drums:{fx:[{type:"comp",ratio:4}]}}, master:{target_lufs:-16}} keeps the text's notes and instruments and only adds/overrides those fields; tracks.<t>.instrument in JSON replaces the text's instrument for that track.
TRACKS: {gtr:{instrument:"metal_guitar", gain:-6, pan:0, reverb:0.1 (send), octave:2, root_only, transpose, double, humanize:{time:0.006,vel:0.06}, fx:[...appended inserts], bus:"music"|"drums", automation:{gain:[[bar,dB],...], pan, cutoff}}}.
SECTIONS: {verse:{bars:8, <track>: <pattern>, transpose?, vel?}}. Missing track = silent. Patterns repeat to fill the bars.
- Step pattern (drums, one char per 16th): "x...x...x.x.x..." X accent, x hit, o ghost, 1-9 velocity, . rest, | ignored.
- Kit tracks take an object: {kick:"x...x...", snare:"....x...", hat:"x.x.x.x.", ohat, crash, ride, china, tom1-3, clap}.
- Note line: bars split by "|", tokens share their bar evenly: "Em | C" one chord per bar; "e2 e2 f2 e2" quarters; 16 tokens = 16ths.
  lowercase = note (e2 f#3 bb1); Uppercase = chord at the track octave (Em C5 Bdim Am7 Fsus4; X5 = power chord); roman numerals vs key (i iv bVI V7); stacks e2+b2+e3;
  "_" holds the previous note, "." rests, tok*4 repeats. Suffixes: ! accent, ? ghost, ' palm-mute/staccato, ~ legato, % tremolo picking, < swell, @0.6 velocity.
- Generators inline: {gen:"doom_riff", style:"chug|gallop|doom|breakdown|tremolo", seed}, {gen:"organ_progression", style:"dirge|phrygian|liturgical|harmonic"}, {gen:"blast_beat", style:"blast|hammer|gravity|double_kick|dbeat|half_time|doom|four_floor|breakbeat|trap|rock", fill}, {gen:"dread_ambient", part:"drone|bells|heartbeat|wind"}. art_audio {action:"generate", generator, ...} returns the text to edit.
PARTIAL UPDATE: re-send a saved song (same name) with only tracks or only sections: they merge into it per track/section (null removes one); everything else is kept.
ARRANGEMENT: ["intro","verse","verse","chorus"] or "intro verse*2 chorus". loop: true (whole song loops seamlessly: tails wrap to the start) | "verse" (intro plays once) | false. swing: 0..0.5. layers:{explore:["organ","drone"], combat:["gtr","bass","drums"], boss:["choir"]} -> export {layers:true} = one file per intensity layer + manifest.
SCALES: ${['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic_minor', 'melodic_minor', 'phrygian_dominant', 'hungarian_minor', 'double_harmonic', 'pentatonic_minor', 'blues', 'diminished'].join(' ')}.
GENRE RECIPES (compare with critique {genre}):
${Object.entries(GENRES).map(([k, g]) => `- ${k}: ${g.tempo ? g.tempo.join('-') + ' BPM; ' : ''}${g.needs.join('; ')}`).join('\n')}
WORKED: gothic cathedral doom (organ intro, doom-riff verse, blast section, choir breakdown, loopable, 76.8 s): art_audio {action:"song", name:"cathedral_doom", intent:"gothic cathedral doom: slow-to-mid heavy riffs, organ and choir, cathedral reverb, brutal drums", genre:"cathedral_doom", text:<below>}
${DOOM_CATHEDRAL}`,

  mixing: `MIXING + MASTERING
Signal flow: voice -> track inserts (patch.fx + track.fx) -> pan/width/gain/automation -> bus ("drums" for kits, else "music"; song.buses:{drums:{fx:[...], gain}}) -> master. Sends: track.reverb (0..1) into ONE shared song reverb (song.reverb: ${Object.keys(REVERBS).join('|')}, or {preset, type:"convolution"} for a generated impulse response, return:dB), track.delay into song.delay {time:"1/8d", feedback}.
Carving shorthands on a track (also in song text): hp=Hz lp=Hz cut=Hz cut_db=-3 cut_q=1.2 boost=Hz boost_db=2, e.g. "track organ cathedral_organ hp=220 cut=900 cut_db=-6". analyze view:"mix" shows which stems mask each other and where.
FX (any numeric param in songs may be an automation curve [[bar, value], ...]; in sfx seconds; every fx takes mix 0..1):
 eq {bands:[{type:peak|lowshelf|highshelf|hp|lp|notch|bp, f, q, gain, poles}]}  filter {ftype, f, q, lfo:{rate,depth}}  drive/saturate {drive dB, shape:tanh|tube|soft|hard|fold|fuzz}
 amp {gain, tight, mid, mid_gain, bass, scoop, treble, presence, level}  cab {lp, hp, res}  bitcrush {bits, rate}  chorus {voices, delay, depth, rate}  flanger  delay {time, feedback, pingpong}
 reverb {preset, wet, conv:true}  comp {threshold, ratio, attack, release, knee, makeup, auto_makeup, key:"<track>"}  duck {from:"kick", amount:6, release:0.18} (sidechain)
 gate {threshold, range, hold}  transient {attack, sustain}  multiband {crossovers:[150,2500], bands:[{threshold,ratio,gain}...]}  limit {ceiling}  formant {vowel, voice, morph:[...], rate}
 tremolo {rate|"1/8", depth}  width {amount}  gain {db}  pan {pan}  fade {in, out}  dc.
MASTER (song.master): {target_lufs:-14 (streaming) | -16..-18 (game music), ceiling:-1 (dBTP), glue:true, glue_threshold, glue_ratio, eq:[bands], bypass}. Chain: HP 25 Hz -> glue comp -> gain to target -> lookahead true-peak-safe limiter. 16-bit export is TPDF-dithered. SFX: peak -1 dBFS.
Metal guitars: 2 takes (double:true) panned L/R, amp gain 30-40, tight 100-130 Hz, cab lp ~5 kHz, cut 300-500 Hz; bass under them, drier; organ/choir HP at 100-200 Hz in dense sections so the guitars keep the low-mids; reverb on organ/choir, little on guitars/kick.
Fixing masking: carve one side (eq peak -3 dB at the overlap), pan apart, or arrange them in different registers. Fixing "buried": +3..6 dB or cut the masker.`,

  perception: `READING ANALYSIS (you cannot hear: these fields say what a human hears)
analyze {name, view?:"overview"|"mix", intent?, genre?} -> image + stats + report + perception; critique {name, intent?, genre?} -> issues ranked by audibility + fixes + report.
IMAGE overview: waveform (L top / R bottom, white lines = bars, ticks = beats), HITS strip (red kick, yellow snare, cyan hats onsets), log spectrogram 30 Hz-16 kHz (guitar body 100 Hz-5 kHz, kick in the sub, organ = stacked horizontal harmonic lines, cymbals = noise above 5 kHz), LUFS (grey momentary, yellow short-term, green dashed target, pink = energy per section), goniometer (vertical line = mono, wide blob = wide), band bars, facts. view:"mix" = each stem's spectrum, red bands = masking, stem balance + masked %.
RHYTHM: perceived_bpm = what a listener taps (tactus), feel says double/half-time vs written; kick_pattern (four_on_the_floor, backbeat, half_time, blast, double_kick, breakbeat, dbeat, trap, sparse, none); patterns = 16-step occupancy (X always, x often, o sometimes); hits_per_bar; swing; timing_spread_ms (<1 ms = machine-tight); syncopation; drive_words. Writing 175 BPM does not make it techno: a four_on_the_floor kick + offbeat hats + rumble bass does.
TONAL: key + mode estimate, progression per bar, distinct chords, tension curve (roughness + loudness).
TIMBRE: brightness; distortion (0..1) + distortion_words come from harmonic structure on pitched, loud frames (energy pushed into upper harmonics / intermodulation, harmonic_extension_db), so reverb wash, drones and drum kits no longer read as distortion; space + reverb_rt60_s (dry < 0.35 s, room, hall, church, cathedral > 3.5 s) measured from free decays (note endings) with reverb_confidence 0..1 (< 0.35 = few free decays, e.g. a dense mix: treat the RT60 as a guess); stereo, organic vs synthetic cues.
SFX (one-shots): reads_as, attack/decay/hits words, pitch_clarity, sweep_octaves (pitch glide while the sound holds its level: a laser/fail falls, a power-up rises; an impact's body drop as it dies away is not a sweep).
GUNSHOTS (recipe or intent names a gun): sfx.transient = attack_ms, snap (share of the first 20 ms above 2 kHz; a near shot is 0.25-0.45), body, ring_db (strongest spectral peak over the noise; real shots 5-10 dB, a pitched drum / bell / modal ring 15+), decay30_s. critique flags pitched_ring, no_crack, soft_attack and no_tail; a score of 100 only means none of these faults were found, not that it sounds right.
KICK/SNARE detection is gated: a kick needs a low-band (35-110 Hz) transient with a sharp, noisy attack and a level near the loudest hits, so sustained choir, wind, organ, drones and sub bass do not read as kicks or backbeats.
MIX (songs): dominant, balance (rel LU, masked %), masking pairs with Hz range, buried, pumping. ENERGY: per-section loudness/density/energy + lift/drop notes. REPETITION: repeated phrases, variety.
GENRE: verdict + gaps vs profiles (${Object.keys(GENRES).join(', ')}). INTENT: words from your intent that the audio does or does not support.
REFERENCE: art_audio compare {name, reference:"<asset or file.wav/mp3>"} = spectrum/loudness/dynamics/tempo/groove/stereo differences.
Iterate until critique has no intent_gap/genre_gap and the report describes what you meant.`,
};

export const AUDIO_SKILLS = {
  'sfx-pack': {
    title: 'Sound-effect pack with variants (gore, combat, holy, UI, monsters, FPS firearms, sci-fi)',
    when: 'Game SFX: hits, gore, weapons, gunshots, reloads, lasers, explosions, bells, UI clicks, level-up, roars, footsteps; N variants each.',
    desc: 'Generates game sound effects with seeded variants (gore, hits, gunshots, reloads, lasers, explosions, UI clicks, monsters, footsteps) and checks them with analysis images and critiques you can read (art_audio). Use when asked for SFX, sound effects or a sound pack.',
    body: `1. One call per sound, 3 variants each (different seeds = different takes):
   art_audio ${J({ action: 'sfx', recipe: 'gib_burst', seed: 1, variants: 3 })}
   Other recipes: ${Object.values(RECIPE_GROUPS).flat().slice(0, 30).join(' ')}.
2. Shape with vars (same seed = same take): ${J({ action: 'sfx', recipe: 'bone_crunch', seed: 4, variants: 3, vars: { pitch: -3, length: 1.2, intensity: 0.9, wet: 0.5 } })}
3. LOOK at each: art_audio ${J({ action: 'analyze', name: 'gib_burst_1' })} (spectrogram: gore = broadband burst + low thump + wet squelch band 300-1500 Hz; UI = short, mid/high only).
4. art_audio ${J({ action: 'critique', name: 'gib_burst_1' })} -> fix head_silence / too_long / sub_heavy / harsh with vars or fx, re-run step 1 with the same seed.
5. Custom layered sound: ${J({ action: 'sfx', name: 'censer_hit', layers: [{ kind: 'recipe', recipe: 'censer_whoosh' }, { kind: 'recipe', recipe: 'hit_heavy', at: 0.45 }, { kind: 'note', instrument: 'church_bells', note: 'e4', at: 0.45, gain: -12 }], reverb: { preset: 'hall', wet: 0.15 } })}
6. FPS / sci-fi: art_audio ${J({ action: 'sfx', recipe: 'gunshot_rifle', variants: 4, vars: { environment: 'indoor', intensity: 0.8 } })} (gunshot_pistol|marksman|shotgun|smg|lmg|suppressed; environment outdoor|indoor|canyon). Handling: mag_out mag_in bolt_rack dry_fire shotgun_pump casing_drop; footstep vars.surface metal|dirt|concrete|snow|grate. Sci-fi: laser_bolt plasma_shot shield_hit glitch_tear teleport_swell servo hologram_ui radio_squelch_on/_off bullet_whiz ricochet; loops: ${J({ action: 'sfx', name: 'hum', recipe: 'drone_rotor', loop: true })} (also alarm_klaxon).
   Own sci-fi layers: ${J({ action: 'sfx', name: 'zap', layers: [{ kind: 'glide', pts: [[0, 2400], [0.25, 300]], dur: 0.3 }, { kind: 'glitch', at: 0.05, dur: 0.2, gain: -9 }], fx: ['dc', { comp: { ratio: 4 } }], target: -3 })}. fx, reverb {preset, wet}, target, loop and tail work on recipes and layers alike; info {name} on a recipe asset shows resolved layers to edit.
7. Batch export: art_audio ${J({ action: 'export', name: 'gib_burst_*', format: 'ogg', path: 'sfx/gore/' })} (also wav 16/24-bit; JSON sidecars hold seed+recipe).`,
  },
  'music-track': {
    title: 'Loopable game music track (any genre), checked with the listener report',
    when: 'Background music, boss themes, ambience; anything with tempo, sections and instruments.',
    desc: 'Composes a loopable game music track in any genre with the art_audio notation and generators, then checks it against the intent with the listener report and critique. Use when asked for background music, a boss theme, ambience or a song.',
    body: `1. Pick the genre profile and read its needs: art_help ${J({ topic: 'music' })} (GENRE RECIPES). Copy the worked cathedral-doom text if it fits.
2. Generate parts you can edit: art_audio ${J({ action: 'generate', generator: 'doom_riff', style: 'chug', key: 'e phrygian', bars: 2, seed: 4 })} (also organ_progression, blast_beat, dread_ambient).
3. Write the song (text or JSON, or both: JSON tracks/buses/master deep-merge over the text, so keep notes in text and put fx/gain/bus tweaks in JSON), with intent + genre so critique can check them:
   art_audio ${J({ action: 'song', name: 'boss', intent: 'brutal fast boss fight, blast beats, choir', genre: 'death_metal', tempo: 180, key: 'e phrygian', loop: true, tracks: { gtr: { instrument: 'metal_guitar' }, bass: { instrument: 'bass_guitar', root_only: true }, drums: { instrument: 'metal_kit' }, choir: { instrument: 'choir_pad' } }, sections: { a: { bars: 4, gtr: { gen: 'doom_riff', style: 'tremolo', seed: 2 }, bass: { gen: 'doom_riff', style: 'tremolo', seed: 2 }, drums: { gen: 'blast_beat', style: 'blast' }, choir: 'Em | F | G | F' } }, arrangement: ['a', 'a'] })}
4. art_audio ${J({ action: 'analyze', name: 'boss' })}: read "report" first (what a listener hears), then perception.rhythm (felt BPM, kick pattern), genre.verdict, mix.masking.
5. art_audio ${J({ action: 'critique', name: 'boss' })}: fix the top issues (most audible first). Typical: intent_gap -> change drum style/tempo/instrument; masking -> eq carve; buried -> +gain; repetitive -> vary seeds/sections; arrangement -> contrast sections.
   Text + JSON example: art_audio ${J({ action: 'song', name: 'boss', text: '<the text>', tracks: { gtr: { gain: -4, fx: [{ type: 'eq', bands: [{ type: 'peak', f: 400, gain: -3 }] }] } }, buses: { drums: { fx: [{ type: 'comp', ratio: 4 }] } } })}
6. Re-send the song (same name) and repeat 4-5 until the report matches the intent. Then export ${J({ action: 'export', name: 'boss', format: 'ogg', stems: true })} or layers:true for adaptive music; add sample_rate:48000 for 48 kHz delivery (loop points stay sample-exact).`,
  },
};
