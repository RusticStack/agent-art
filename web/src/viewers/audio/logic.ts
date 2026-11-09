// Pure audio-viewer logic: playback range maths, waveform peaks, ruler steps, keyboard seeking and the
// status / download texts. Unit-tested; AudioViewer only wires these to the DOM and Web Audio.
import type { AudioInfo } from '@/lib/api/types';

export type Range = [number, number];

export interface PlaybackPlan {
  /** Start offset in the buffer (s). */
  from: number;
  /** Played range: the selection, else the whole clip. */
  range: Range;
  loop: boolean;
  /** Loop points to set on the source (only with a selection; else the source loops the whole buffer). */
  loopStart?: number;
  loopEnd?: number;
  /** Duration to pass to start(); undefined while looping. */
  duration?: number;
  /** Elapsed time within the range at the start: startedAt = now - offset. */
  offset: number;
}

/** Normalise a selection so that start <= end. */
export const normSel = (a: number, b: number): Range => [Math.min(a, b), Math.max(a, b)];

/**
 * What play() does: plays the selection (or the clip) from the playhead when it is inside the range,
 * else from the range start; loops the range when loop is on, else plays it once.
 */
export function playbackPlan(pos: number | undefined, sel: Range | null, duration: number, loop: boolean): PlaybackPlan {
  const [a, b] = sel ? normSel(sel[0], sel[1]) : [0, duration];
  let from = pos ?? a;
  if (from < a || from >= b) from = a;
  return {
    from, range: [a, b], loop,
    ...(sel ? { loopStart: a, loopEnd: b } : {}),
    duration: loop ? undefined : b - from,
    offset: from - a,
  };
}

/** Playhead (s) for elapsed playback time: wraps within the range when looping, else stops at its end. */
export function playheadAt(elapsed: number, range: Range, loop: boolean): number {
  const len = range[1] - range[0];
  let e = elapsed;
  if (loop && len > 0) e %= len;
  return Math.min(range[1], range[0] + e);
}

/** Ruler step (s) for a clip duration. */
export const rulerStep = (duration: number): number => (duration > 20 ? 5 : duration > 5 ? 1 : duration > 1 ? 0.25 : 0.1);

/** Ruler ticks: [time, label] from 0 to duration. */
export function rulerTicks(duration: number): [number, string][] {
  const step = rulerStep(duration), out: [number, string][] = [];
  for (let k = 0; k * step <= duration + 1e-9; k++) out.push([k * step, (k * step).toFixed(step < 1 ? 2 : 0)]);
  return out;
}

export interface Peaks { min: Float32Array; max: Float32Array }

/** Exact min / max of the samples under each of `width` columns (computed once per buffer and width). */
export function computePeaks(data: Float32Array, width: number): Peaks {
  const W = Math.max(1, Math.floor(width)), min = new Float32Array(W), max = new Float32Array(W);
  const per = data.length / W;
  for (let i = 0; i < W; i++) {
    const s0 = Math.floor(i * per), s1 = Math.min(data.length, Math.floor((i + 1) * per) + 1);
    let mn = 1, mx = -1;
    for (let s = s0; s < s1; s++) { const v = data[s]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx < mn) { mn = 0; mx = 0; }
    min[i] = mn; max[i] = mx;
  }
  return { min, max };
}

/** Keyboard seeking on the waveform: Left / Right 5% (Shift 1%), Home, End; null for other keys. */
export function seekKey(key: string, shift: boolean, pos: number, duration: number): number | null {
  const step = duration * (shift ? 0.01 : 0.05);
  if (key === 'ArrowLeft') return Math.max(0, pos - step);
  if (key === 'ArrowRight') return Math.min(duration, pos + step);
  if (key === 'Home') return 0;
  if (key === 'End') return duration;
  return null;
}

/** aria-valuetext of the waveform slider. */
export const ariaTime = (pos: number, duration: number): string => `${pos.toFixed(2)} of ${duration.toFixed(2)} seconds`;

export const selText = (sel: Range | null): string => (sel ? `sel ${sel[0].toFixed(2)}–${sel[1].toFixed(2)} s` : '');

export interface BufferMeta { duration: number; channels: number; sampleRate: number }

/** Status line: name · kind · recipe · duration · channels · rate · LUFS · peak · score · issues. */
export function statusText(name: string, info: AudioInfo | null, b: BufferMeta): string {
  const st = info?.stats || info?.cache || {};
  return [
    name, info?.kind, info?.recipe && `recipe ${info.recipe}`,
    `${b.duration.toFixed(2)} s`, `${b.channels} ch`, `${b.sampleRate} Hz`,
    st.lufs !== undefined && `${st.lufs} LUFS`,
    st.peak_dbfs !== undefined && `peak ${st.peak_dbfs} dBFS`,
    st.score !== undefined && `score ${st.score}`,
    st.issues?.length ? `issues: ${st.issues.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/** First 24 scalar stats, numbers rounded to 3 decimals. */
export function statRows(stats: Record<string, unknown> | undefined): [string, string][] {
  return Object.entries(stats || {})
    .filter((e): e is [string, number | string] => typeof e[1] === 'number' || typeof e[1] === 'string')
    .slice(0, 24)
    .map(([k, v]) => [k, typeof v === 'number' ? String(+v.toFixed(3)) : v]);
}

const AUDIO_EXT = /\.(wav|mp3|ogg|opus)$/i;

/** Download link text and file name: workspace audio is a WAV; an export keeps its own file and type. */
export function downloadInfo(kind: 'audio' | 'export', name: string): { text: string; file: string } {
  const base = name.split('/').pop() || name;
  if (kind === 'export') return { text: (base.match(AUDIO_EXT)?.[1] || 'file').toUpperCase(), file: base };
  return { text: 'WAV', file: `${base.replace(AUDIO_EXT, '')}.wav` };
}

/** Auto-run the server analysis only for workspace clips under 12 s (not long music, not exports). */
export const autoAnalyze = (kind: 'audio' | 'export', duration: number): boolean => kind === 'audio' && duration < 12;

/** Sample rate for the decode context: the file's own rate when the browser accepts it, else 44100. */
export const decodeRate = (fileRate: number | null): number => (fileRate && fileRate >= 8000 && fileRate <= 384000 ? fileRate : 44100);
