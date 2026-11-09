import { describe, expect, it } from 'vitest';
import {
  ariaTime, autoAnalyze, computePeaks, decodeRate, downloadInfo, normSel, playbackPlan, playheadAt, rulerStep, rulerTicks, seekKey,
  selText, statRows, statusText,
} from './logic';

describe('playbackPlan', () => {
  it('whole clip, from the start or the playhead, once', () => {
    expect(playbackPlan(undefined, null, 3, false)).toEqual({ from: 0, range: [0, 3], loop: false, duration: 3, offset: 0 });
    expect(playbackPlan(1.25, null, 3, false)).toEqual({ from: 1.25, range: [0, 3], loop: false, duration: 1.75, offset: 1.25 });
  });
  it('a playhead at or past the end restarts at the range start', () => {
    expect(playbackPlan(3, null, 3, false).from).toBe(0);
    expect(playbackPlan(-1, null, 3, false).from).toBe(0);
  });
  it('looping the whole clip has no loop points and no duration', () => {
    const p = playbackPlan(1, null, 3, true);
    expect(p).toEqual({ from: 1, range: [0, 3], loop: true, duration: undefined, offset: 1 });
    expect(p.loopStart).toBeUndefined();
  });
  it('selection: loop points, playhead inside or outside, one pass without loop', () => {
    expect(playbackPlan(undefined, [1, 2], 3, true)).toEqual({ from: 1, range: [1, 2], loop: true, loopStart: 1, loopEnd: 2, duration: undefined, offset: 0 });
    expect(playbackPlan(1.5, [1, 2], 3, true)).toMatchObject({ from: 1.5, offset: 0.5 });
    expect(playbackPlan(0.5, [1, 2], 3, false)).toMatchObject({ from: 1, duration: 1, offset: 0 });
    expect(playbackPlan(2.5, [1, 2], 3, false)).toMatchObject({ from: 1, duration: 1 });
  });
  it('a reversed selection is normalised', () => {
    expect(normSel(2, 1)).toEqual([1, 2]);
    expect(playbackPlan(undefined, [2, 1], 3, false)).toMatchObject({ from: 1, range: [1, 2], loopStart: 1, loopEnd: 2 });
  });
});

describe('playheadAt', () => {
  it('wraps when looping, stops at the end otherwise', () => {
    expect(playheadAt(0.5, [1, 2], true)).toBeCloseTo(1.5);
    expect(playheadAt(2.25, [1, 2], true)).toBeCloseTo(1.25);
    expect(playheadAt(5, [1, 2], false)).toBe(2);
    expect(playheadAt(0.3, [0, 0], true)).toBe(0);
  });
});

describe('waveform helpers', () => {
  it('ruler step by duration and ticks to the end', () => {
    expect([0.5, 3, 10, 30].map(rulerStep)).toEqual([0.1, 0.25, 1, 5]);
    expect(rulerTicks(1).map((t) => t[1])).toHaveLength(11);
    expect(rulerTicks(1.5).map((t) => t[1])).toEqual(['0.00', '0.25', '0.50', '0.75', '1.00', '1.25', '1.50']);
    expect(rulerTicks(0.3).map((t) => t[1])).toEqual(['0.00', '0.10', '0.20', '0.30']);
    expect(rulerTicks(12).at(-1)).toEqual([12, '12']);
  });
  it('peaks are the exact min / max per column', () => {
    const d = new Float32Array([0, 0.5, -0.25, 0, 0, 1, -1, 0]);
    const p = computePeaks(d, 2);   // a column also takes the first sample of the next one (no gaps)
    expect([...p.max]).toEqual([0.5, 1]);
    expect([...p.min]).toEqual([-0.25, -1]);
    const wide = computePeaks(new Float32Array([0.5, -0.5]), 4);
    expect(wide.max.length).toBe(4);
    expect([...wide.max].every((v, i) => v >= wide.min[i] && v !== 0)).toBe(true);   // more columns than samples: no empty column
    expect([...computePeaks(new Float32Array(0), 3).max]).toEqual([0, 0, 0]);
  });
});

describe('keyboard and texts', () => {
  it('seek keys: 5%, Shift 1%, Home, End, clamped; others null', () => {
    expect(seekKey('ArrowRight', false, 1, 10)).toBeCloseTo(1.5);
    expect(seekKey('ArrowLeft', true, 1, 10)).toBeCloseTo(0.9);
    expect(seekKey('ArrowLeft', false, 0.2, 10)).toBe(0);
    expect(seekKey('ArrowRight', false, 9.9, 10)).toBe(10);
    expect(seekKey('Home', false, 5, 10)).toBe(0);
    expect(seekKey('End', false, 5, 10)).toBe(10);
    expect(seekKey('a', false, 5, 10)).toBeNull();
  });
  it('aria and selection text', () => {
    expect(ariaTime(1.25, 3.4)).toBe('1.25 of 3.40 seconds');
    expect(selText([0.5, 1])).toBe('sel 0.50–1.00 s');
    expect(selText(null)).toBe('');
  });
  it('status line', () => {
    const meta = { duration: 0.5, channels: 2, sampleRate: 48000 };
    expect(statusText('shot', { name: 'shot', kind: 'sfx', recipe: 'gunshot', stats: { lufs: -14.2, peak_dbfs: -1, score: 82, issues: ['clip', 'dc'] } }, meta))
      .toBe('shot · sfx · recipe gunshot · 0.50 s · 2 ch · 48000 Hz · -14.2 LUFS · peak -1 dBFS · score 82 · issues: clip, dc');
    expect(statusText('a.mp3', null, { duration: 2, channels: 1, sampleRate: 44100 })).toBe('a.mp3 · 2.00 s · 1 ch · 44100 Hz');
    expect(statusText('c', { name: 'c', cache: { lufs: 0 } }, meta)).toContain('0 LUFS');
  });
  it('stat rows: first 24 scalars, numbers to 3 decimals', () => {
    const stats: Record<string, unknown> = { a: 1.23456, b: 'x', c: [1], d: { e: 1 }, f: true };
    for (let i = 0; i < 30; i++) stats[`n${i}`] = i;
    const rows = statRows(stats);
    expect(rows.slice(0, 2)).toEqual([['a', '1.235'], ['b', 'x']]);
    expect(rows.length).toBe(24);
    expect(statRows(undefined)).toEqual([]);
  });
  it('download link per kind, auto-analysis rule, decode rate', () => {
    expect(downloadInfo('audio', 'rifle_shot')).toEqual({ text: 'WAV', file: 'rifle_shot.wav' });
    expect(downloadInfo('export', 'sfx/boom.mp3')).toEqual({ text: 'MP3', file: 'boom.mp3' });
    expect(downloadInfo('export', 'a/b.wav')).toEqual({ text: 'WAV', file: 'b.wav' });
    expect(autoAnalyze('audio', 3)).toBe(true);
    expect(autoAnalyze('audio', 60)).toBe(false);
    expect(autoAnalyze('export', 3)).toBe(false);
    expect(decodeRate(48000)).toBe(48000);
    expect(decodeRate(null)).toBe(44100);
    expect(decodeRate(1000)).toBe(44100);
  });
});
