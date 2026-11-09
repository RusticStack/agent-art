// Audio critique: actionable issues ranked by how audible they are, with concrete fixes that
// name art_audio parameters. Targets: music -14 LUFS (streaming) / -16 to -18 (game), SFX peak -1 dBFS.
import { GENRES } from './genres.js';

const r1 = (v) => Math.round(v * 10) / 10;

export function critiqueAudio(stats, { kind = 'music', target_lufs, target_peak = null, loop = false, perception = null, recipe = null, genre = null, intent = null, vars = null } = {}) {
  const issues = [];
  const add = (id, audibility, message, fix) => issues.push({ id, audibility: r1(audibility), message, fix });
  if (stats.clipped_samples > 0 || stats.true_peak_dbtp > 0) add('clipping', 0.95, `${stats.clipped_samples} clipped samples, true peak ${stats.true_peak_dbtp} dBTP (audible crackle/distortion)`, kind === 'music' ? 'lower track gains or keep master ceiling at -1 (master:{ceiling:-1})' : 'lower layer gains; the sfx normaliser targets -1 dBFS (target:-1)');
  if (Math.abs(stats.dc_offset) > 0.003) add('dc_offset', 0.3, `DC offset ${stats.dc_offset} (wastes headroom, clicks on start/stop)`, 'add fx {type:"dc"} or a highpass {type:"eq",bands:[{type:"hp",f:25}]}');
  const b = stats.bands;
  if (kind === 'music') {
    const t = target_lufs ?? -14;
    if (stats.lufs < t - 2) add('too_quiet', 0.5, `integrated ${stats.lufs} LUFS, target ${t}`, `raise master target_lufs (master:{target_lufs:${t}})`);
    if (stats.lufs > t + 2) add('too_loud', 0.5, `integrated ${stats.lufs} LUFS, target ${t} (streaming services turn it down and it sounds squashed)`, `master:{target_lufs:${t}}`);
    if (stats.true_peak_dbtp > -1 && stats.true_peak_dbtp <= 0) add('true_peak', 0.35, `true peak ${stats.true_peak_dbtp} dBTP > -1 (lossy encoders may clip)`, 'master:{ceiling:-1.5}');
    if (stats.crest_db < 7 && stats.duration > 5) add('over_compressed', 0.4, `crest factor ${stats.crest_db} dB: squashed, transients flattened`, 'lower target_lufs or glue_ratio; less drive on drums');
    if (b.low_mid > 22) add('muddy', 0.55, `low-mids (250-500 Hz) are ${b.low_mid}% of the energy: boxy, muddy`, 'cut 250-500 Hz on guitars/organ/pads: fx {type:"eq",bands:[{type:"peak",f:350,q:1,gain:-3}]}; highpass pads at 120-200 Hz');
    if (b.presence > 26) add('harsh', 0.5, `presence (2-5 kHz) is ${b.presence}% of the energy: harsh, fatiguing`, 'cut 2.5-4 kHz on guitars/cymbals: {type:"peak",f:3200,q:1.2,gain:-3}; lower cab lp');
    // dark genres (doom, dark ambient, cathedral) are expected to sit lower; still flag a real muffle
    const darkG = genre && GENRES[genre] && GENRES[genre].centroid && GENRES[genre].centroid[1] <= 2000;
    if (b.high + b.air < (darkG ? 0.5 : 1.2) && stats.duration > 5) add('dull', 0.3, `almost no energy above 5 kHz (${r1(b.high + b.air)}%): dull, muffled`, 'raise hats/cymbals, open filters or add a highshelf +2 dB at 8 kHz');
    if (b.sub > 32) add('boomy', 0.4, `sub (<60 Hz) is ${b.sub}% of the energy: boomy, eats headroom`, 'lower sub/kick, highpass non-bass tracks at 80-120 Hz');
    if (b.sub + b.low < 8) add('thin', 0.4, `little low end (${r1(b.sub + b.low)}% below 250 Hz): thin`, 'add bass/sub_bass, raise kick');
    if (!loop && stats.tail_silence_ms < 5 && stats.duration > 2) add('abrupt_end', 0.5, 'ends abruptly (no fade or decay at the end)', 'add an outro section or loop:true; fx {type:"fade", out:2}');
    if (stats.head_silence_ms > 600) add('head_silence', 0.2, `${stats.head_silence_ms} ms of silence before the music starts`, 'start notes on bar 1');
    // a click needs a real waveform discontinuity at the loop point; a level change there is
    // usually just the last section leading back into the first, so it is reported separately
    if (loop && stats.seam?.click) add('loop_seam', 0.8, `loop seam has a discontinuity (sample jump ${stats.seam.jump}, ${stats.seam.jump_ratio}x the local slope): audible click each loop`, 'keep loop:true (tail wraps automatically); avoid hard-cut fx at the end; make the last bar lead into the first');
    else if (loop && stats.seam && stats.seam.level_jump_db > 9) add('loop_level_change', 0.2, `level changes ${stats.seam.level_jump_db} dB at the loop point (no click: a section change)`, 'fine if intended; for a smoother wrap make the last bar lead into the first (same density/chord)');
  } else {
    const dur = stats.duration;
    // a quiet peak is only an issue when it misses the asked-for target (UI sounds often sit at -6..-9)
    const tp = target_peak ?? -1;
    if (stats.peak_dbfs < Math.min(-4, tp - 3)) add('too_quiet', 0.5, `peak ${stats.peak_dbfs} dBFS (SFX target ${tp} dBFS)`, `target:${tp}`);
    if (loop && stats.seam?.click) add('loop_seam', 0.8, `loop seam has a discontinuity (sample jump ${stats.seam.jump}): audible click each loop`, 'loop:{crossfade:0.2} or a longer, steadier body');
    if (stats.true_peak_dbtp > -0.3) add('too_hot', 0.35, `true peak ${stats.true_peak_dbtp} dBTP`, 'target:-1.5');
    if (stats.head_silence_ms > 20) add('head_silence', 0.5, `${stats.head_silence_ms} ms of silence before the sound (feels laggy in game)`, 'move layer "at" times to 0');
    const ui = recipe && /click|hover|confirm|ui/.test(recipe);
    if (ui && dur > 0.6) add('too_long', 0.4, `${dur} s is long for a UI sound (aim < 0.4 s)`, 'vars:{length:0.5}');
    else if (!ui && dur > 6 && !/bell|chant|choir|drone|ambient/.test(recipe || '')) add('too_long', 0.3, `${dur} s is long for a one-shot`, 'vars:{length:0.7} or less reverb');
    if (dur < 0.03) add('too_short', 0.4, `${dur} s is too short to read as a sound (a click)`, 'vars:{length:1.5}');
    if (b.sub > 45) add('sub_heavy', 0.35, `${b.sub}% of energy is sub-bass: vanishes on laptop/phone speakers`, 'add mid content (a burst or crackle layer 300 Hz-3 kHz)');
    if (b.presence > 35 && !ui) add('harsh', 0.35, `presence band ${b.presence}%: harsh`, 'fx {type:"eq",bands:[{type:"peak",f:3200,gain:-3}]}');
  }
  // gunshots / firearms (by recipe or stated intent). Calibrated on the bundled CC0 field recordings (approved by ear)
  // vs the 0.9 synthesized shots: recordings ring 5-10 dB (12.8 max, indoor), the synth 12.5-41 dB; recordings peak
  // within 0.02-4.4 ms of the onset (distant ones later: their loudest moment is the reflections), the synth 3.5-9 ms;
  // close-mic recordings can be dark (snap >= 0.02) and stop fast (30 dB down after >= 30 ms), so those two checks
  // only catch a pure tonal thump and a bare click.
  const gunText = `${recipe || ''} ${intent || ''}`;
  const tr = perception?.sfx?.transient;
  // a gun = a gunshot_* recipe, or an intent naming a gun / gunfire (word-bounded: not shotgun_pump, plasma_shot, one-shot, screenshot)
  const gunIntent = (intent || '').replace(/\bone[- ]?shot\b/gi, '');
  const isGun = /^gunshot_/i.test(recipe || '') || /\b(gun ?shots?|gunfire|guns?|rifles?|pistols?|revolvers?|smgs?|lmgs?|carbines?|shotguns?|snipers?|marksman|firearms?|muzzle)\b/i.test(gunIntent);
  if (kind !== 'music' && tr && isGun) {
    const far = vars?.distance === 'far' || /distant|far away|far-off/i.test(gunText), quiet = /suppress|silenc/i.test(gunText);
    if (tr.ring_db > 13) add('pitched_ring', 0.85, `a pitched ring at ${tr.ring_hz} Hz, ${tr.ring_db} dB above the surrounding noise: it sounds like a drum, bell or instrument, not a gunshot (recorded shots measure 5-10 dB)`, 'use a recorded shot (recipes gunshot_*, layer kind "sample") or build it from noise bursts; remove tonal layers (voice / note / modal clank / sine thump)');
    if (!quiet && tr.snap < 0.015) add('no_crack', 0.6, `${Math.round(tr.snap * 1000) / 10}% of the first 20 ms is above 2 kHz: a dull tonal thump with no crack (recorded shots: 2-55%)`, 'start with a recorded shot or a 2-5 ms noise burst high-passed at ~2 kHz; raise vars.intensity');
    if (!far && tr.attack_ms > 5) add('soft_attack', 0.55, `${tr.attack_ms} ms from onset to peak: a near gunshot peaks within ~1-4 ms`, 'remove attack ramps / pre-delay on the blast layer; fx {type:"transient", attack:8}');
    if (!quiet && tr.decay30_s < 0.02) add('no_tail', 0.4, `it is 30 dB down after ${Math.round(tr.decay30_s * 1000)} ms: a bare click, no body or tail`, 'vars.environment "outdoor"|"canyon", or a reverb / noise tail layer');
  }
  if (stats.channels === 2 && stats.stereo && (stats.stereo.correlation < 0.1 || stats.stereo.mono_loss_db < -4)) add('mono_collapse', 0.55, `stereo correlation ${stats.stereo.correlation}, mono fold-down loses ${-stats.stereo.mono_loss_db} dB: parts vanish in mono`, 'reduce width / double-tracking spread, avoid inverting one side');
  if (perception) {
    const p = perception;
    if (p.mix) {
      for (const m of p.mix.masking.slice(0, 2)) if (m.severity >= 2) add('masking', 0.35 + Math.min(0.2, m.severity / 40), `${m.stems.join(' and ')} mask each other in the ${m.region} (${m.range_hz.join('-')} Hz)`, `carve: eq cut on one of them around ${Math.round(Math.sqrt(m.range_hz[0] * m.range_hz[1]))} Hz (-3 dB), or pan them apart`);
      for (const s of p.mix.buried) add('buried', 0.45, `"${s}" is buried (barely audible in the mix)`, `raise "${s}" gain by 3-6 dB or cut competing stems in its range`);
      for (const pm of p.mix.pumping) add('pumping', 0.3, `"${pm.stem}" pumps ${pm.depth_db} dB with the beat`, 'lower duck amount or slow its release if not intended');
    }
    for (const n of p.repetition?.notes || []) add('repetitive', 0.3, n, 'vary the phrase: new generator seed, fills (blast_beat fill:true), transposition, or a different section');
    for (const n of p.energy?.notes || []) if (/does not|flat/.test(n)) add('arrangement', 0.35, n, 'contrast sections: add/remove layers, change drum style, raise/lower gains per section');
    if (p.intent) for (const m of p.intent.missing) add('intent_gap', 0.6, `intent says "${m}" but the audio does not read that way`, 'see listener report / genre gaps');
    if (genre && p.genre?.target && p.genre.target.match < 0.75) for (const g of p.genre.target.gaps.slice(0, 3)) add('genre_gap', 0.5, g, `art_help {topic:"music"} has the ${genre} recipe`);
  }
  issues.sort((a, b2) => b2.audibility - a.audibility);
  const score = Math.max(0, Math.round(100 - issues.reduce((s, i) => s + i.audibility * 18, 0)));
  return { score, issues, summary: issues.length ? `${issues.length} issue(s), most audible first: ${issues.map((i) => i.id).join(', ')}` : 'No automatic issues. Read the listener report to check it sounds like the intent.' };
}
