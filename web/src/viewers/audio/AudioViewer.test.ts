// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasStub, sizeElement, type StubCtx } from '@/test/canvasStub';
import { fakeFetch } from '@/test/fakes';
import type { ReviewMark } from '@/lib/api/types';
import type { ReviewDraft, Target, ViewerEnv, ViewerHostApi } from '../types';
import { AudioViewer } from './AudioViewer';

// ---- Web Audio fakes ----
function fakeBuffer(duration: number, channels: number, sampleRate: number): AudioBuffer {
  const length = Math.round(duration * sampleRate);
  const data = Array.from({ length: channels }, (_, k) => Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sampleRate) * (k ? 0.5 : 0.9)));
  return { duration, length, numberOfChannels: channels, sampleRate, getChannelData: (k: number) => data[k] } as unknown as AudioBuffer;
}
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
class FakeSource {
  buffer: AudioBuffer | null = null; loop = false; loopStart = 0; loopEnd = 0;
  onended: (() => void) | null = null;
  connect = vi.fn(); disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => { this.onended?.(); });   // onended also fires on stop()
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0; state: AudioContextState = 'running'; sampleRate = 48000; destination = {};
  sources: FakeSource[] = [];
  gainNode = { ...node(), gain: { value: 1 } };
  analyserNode = { ...node(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 1024, getFloatFrequencyData: (a: Float32Array) => a.fill(-60) };
  constructor() { FakeAudioContext.instances.push(this); }
  createGain() { return this.gainNode; }
  createAnalyser() { return this.analyserNode; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
}
class FakeOfflineContext {
  static args: number[][] = [];
  constructor(...a: number[]) { FakeOfflineContext.args.push(a); }
  async decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
    const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 3)));
    if (head === 'BAD') throw new Error('Unable to decode audio data');
    return fakeBuffer(0.5, 2, this.rate);
  }
  get rate() { return FakeOfflineContext.args.at(-1)![2]; }
}

function wavBytes(rate: number): Uint8Array {
  const u = new Uint8Array(44), v = new DataView(u.buffer);
  const put = (off: number, s: string) => { for (let i = 0; i < 4; i++) u[off + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36, true); put(8, 'WAVE'); put(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); put(36, 'data');
  return u;
}

// ---- host ----
const env = (o: Partial<ViewerEnv> = {}): ViewerEnv => ({
  tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: true, reviewsRev: 0, assetsRev: 0,
  compareLink: false, compareOverlay: 'off', peerRev: 0, ...o,
});
function makeHost(marks: ReviewMark[] = []) {
  const requestReview = vi.fn<(d: ReviewDraft) => void>();
  const host: ViewerHostApi = {
    slot: 'A', readOnly: false, assets: () => null, isHidden: () => false, reviewMarks: () => marks,
    open: vi.fn(), openNode: vi.fn(), inspectNode: vi.fn(), requestReview, setTool: vi.fn(), setColor: vi.fn(),
    canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(), compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
  };
  return Object.assign(host, { requestReview });
}

const ANALYSIS = { name: 'rifle_shot', image: 'iVBORw0KGgo=', report: 'Sharp attack, short tail.', stats: { lufs: -12.3456, peak_dbfs: -0.5, label: 'gun', arr: [1] } };
function routes(o: { wav?: Uint8Array } = {}) {
  return fakeFetch({
    '/api/audio/rifle_shot.wav': { bytes: o.wav ?? wavBytes(48000), contentType: 'audio/wav' },
    '/api/audio/rifle_shot/analysis': { json: ANALYSIS },
    '/api/audio/rifle_shot': { json: { name: 'rifle_shot', kind: 'sfx', recipe: 'gunshot', stats: { lufs: -12.3, peak_dbfs: -0.5, score: 88 } } },
    '/api/export-file': { bytes: new TextEncoder().encode('ID3 mp3 bytes'), contentType: 'audio/mpeg' },
  });
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = <T extends Element = HTMLElement>(root: Element, sel: string) => root.querySelector(sel) as T;
const ctxOf = (c: HTMLCanvasElement) => (c as HTMLCanvasElement & { _ctx?: StubCtx })._ctx;

let el: HTMLElement;
let host: ReturnType<typeof makeHost>;
let viewer: AudioViewer;

async function mount(target: Target = { kind: 'audio', name: 'rifle_shot' }, e = env()): Promise<void> {
  viewer = new AudioViewer(host);
  await viewer.mount(el, { target, env: e });
  await flush();
}
const wave = () => $<HTMLCanvasElement>(el, 'canvas.wave');
const playBtn = () => $<HTMLButtonElement>(el, '.vtoolbar .btn.primary');
const ptr = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true });

beforeEach(() => {
  installCanvasStub();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineContext);
  FakeAudioContext.instances = [];
  FakeOfflineContext.args = [];
  localStorage.clear();
  el = document.createElement('div');
  document.body.append(el);
  host = makeHost();
  routes();
});
afterEach(() => {
  viewer?.destroy();
  el.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AudioViewer', () => {
  it('builds the legacy DOM, decodes at the file rate without an AudioContext, draws and auto-analyses', async () => {
    await mount();
    for (const sel of ['.viewer.audio-viewer', '.vtoolbar', '.group', '.vstatus', '.audio-body', '.wave-wrap', 'canvas.wave', '.spec-wrap .panel-label', 'canvas.spectrum', '.audio-report']) {
      expect(el.querySelector(sel), sel).not.toBeNull();
    }
    expect(FakeOfflineContext.args).toEqual([[1, 1, 48000]]);
    expect(FakeAudioContext.instances.length).toBe(0);
    expect($(el, '.vstatus').textContent).toBe('rifle_shot · sfx · recipe gunshot · 0.50 s · 2 ch · 48000 Hz · -12.3 LUFS · peak -0.5 dBFS · score 88');
    expect(ctxOf(wave())!.calls.some((c) => c.fn === 'drawImage')).toBe(true);
    expect(ctxOf($<HTMLCanvasElement>(el, 'canvas.spectrum'))!.calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0])).toContain('average');
    const img = $<HTMLImageElement>(el, '.audio-report img.analysis-img');
    expect(img.getAttribute('alt')).toBe('Analysis image the agent reads: waveform, spectrogram, loudness');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect($(el, '.report-text').textContent).toBe('Sharp attack, short tail.');
    expect([...el.querySelectorAll('table.kv th')].map((t) => t.textContent)).toEqual(['lufs', 'peak_dbfs', 'label']);
    expect($(el, 'table.kv td').textContent).toBe('-12.346');
    const a = $<HTMLAnchorElement>(el, '.vtoolbar a.btn');
    expect(a.getAttribute('href')).toBe('/api/audio/rifle_shot.wav?download=1');
    expect(a.getAttribute('download')).toBe('rifle_shot.wav');
    expect(wave().getAttribute('role')).toBe('slider');
    expect(wave().getAttribute('aria-valuemax')).toBe('0.50');
  });

  it('Space toggles Play / Pause; the AudioContext is created on the first Play; each play uses a new source', async () => {
    await mount();
    expect(playBtn().textContent).toContain('Play');
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: ' ' }), ' ')).toBe(true);
    expect(playBtn().textContent).toContain('Pause');
    const ac = FakeAudioContext.instances[0];
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(ac.analyserNode.fftSize).toBe(2048);
    expect(ac.gainNode.gain.value).toBeCloseTo(0.7);
    const s1 = ac.sources[0];
    expect(s1.loop).toBe(true);
    expect(s1.start).toHaveBeenCalledWith(0, 0, undefined);
    expect(ctxOf($<HTMLCanvasElement>(el, 'canvas.spectrum'))!.calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0])).toContain('live');
    viewer.onKey(new KeyboardEvent('keydown', { key: ' ' }), ' ');
    expect(playBtn().textContent).toContain('Play');
    expect(s1.stop).toHaveBeenCalled();
    viewer.onKey(new KeyboardEvent('keydown', { key: ' ' }), ' ');
    expect(ac.sources.length).toBe(2);
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: 'x' }), 'x')).toBe(false);
  });

  it('a natural end resets the button; a stale onended does not', async () => {
    await mount();
    $<HTMLInputElement>(el, 'label.toggle input').click();   // loop off
    viewer.toggle();
    const ac = FakeAudioContext.instances[0];
    const s1 = ac.sources[0];
    expect(s1.start).toHaveBeenCalledWith(0, 0, 0.5);
    viewer.toggle();
    viewer.toggle();
    s1.onended?.();   // the old source ending must not reset the new one
    expect(playBtn().textContent).toContain('Pause');
    ac.sources[1].onended?.();
    expect(playBtn().textContent).toContain('Play');
  });

  it('click seeks, drag selects, and review mode turns a drag into a time-range review', async () => {
    await mount();
    sizeElement(wave(), 100, 180);
    const w = wave();
    w.dispatchEvent(ptr('pointerdown', 40)); w.dispatchEvent(ptr('pointerup', 40));
    expect(w.getAttribute('aria-valuenow')).toBe('0.20');
    expect(w.getAttribute('aria-valuetext')).toBe('0.20 of 0.50 seconds');
    w.dispatchEvent(ptr('pointerdown', 50)); w.dispatchEvent(ptr('pointermove', 10)); w.dispatchEvent(ptr('pointerup', 10));
    expect($(el, '.vtoolbar .mono.muted').textContent).toBe('sel 0.05–0.25 s');
    expect(host.requestReview).not.toHaveBeenCalled();
    viewer.toggle();
    const s = FakeAudioContext.instances[0].sources[0];
    expect(s.loopStart).toBeCloseTo(0.05); expect(s.loopEnd).toBeCloseTo(0.25);
    viewer.stop(true);
    await viewer.update({ target: { kind: 'audio', name: 'rifle_shot' }, env: env({ reviewMode: true }) });
    w.dispatchEvent(ptr('pointerdown', 20)); w.dispatchEvent(ptr('pointermove', 60)); w.dispatchEvent(ptr('pointerup', 60));
    expect(host.requestReview).toHaveBeenCalledTimes(1);
    const d = host.requestReview.mock.calls[0][0];
    expect(d.asset).toBe('audio:rifle_shot');
    expect(d.time![0]).toBeCloseTo(0.1); expect(d.time![1]).toBeCloseTo(0.3);
  });

  it('keyboard seeking on the focused waveform stays inside the viewer', async () => {
    await mount();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    wave().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(wave().getAttribute('aria-valuenow')).toBe('0.50');
    wave().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(wave().getAttribute('aria-valuenow')).toBe('0.00');
    wave().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(wave().getAttribute('aria-valuenow')).toBe('0.01');
    expect(outside).not.toHaveBeenCalled();
    wave().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(outside).toHaveBeenCalledTimes(1);   // Space reaches the app (it calls onKey)
    window.removeEventListener('keydown', outside);
  });

  it('volume and loop persist', async () => {
    await mount();
    const vol = $<HTMLInputElement>(el, 'input[type=range]');
    vol.value = '30'; vol.dispatchEvent(new Event('input'));
    $<HTMLInputElement>(el, 'label.toggle input').click();
    expect(localStorage.getItem('agent-art:volume')).toBe('30');
    expect(localStorage.getItem('agent-art:audioLoop')).toBe('false');
    viewer.destroy();
    await mount();
    expect($<HTMLInputElement>(el, 'input[type=range]').value).toBe('30');
    expect($<HTMLInputElement>(el, 'label.toggle input').checked).toBe(false);
    viewer.toggle();
    expect(FakeAudioContext.instances[0].gainNode.gain.value).toBeCloseTo(0.3);
  });

  it('review time ranges are drawn with their ids and redrawn when reviews reload', async () => {
    host = makeHost([{ id: 'R7', status: 'open', time: [0.1, 0.2] }]);
    await mount();
    const base = (viewer as unknown as { base: HTMLCanvasElement }).base;
    expect(ctxOf(base)!.calls.some((c) => c.fn === 'fillText' && c.args[0] === 'R7')).toBe(true);
    const n = ctxOf(base)!.calls.length;
    await viewer.update({ target: { kind: 'audio', name: 'rifle_shot' }, env: env({ reviewsRev: 1 }) });
    expect(ctxOf(base)!.calls.length).toBeGreaterThan(n);
  });

  it('destroy releases the source, the nodes and the AudioContext; twice is safe', async () => {
    await mount();
    viewer.toggle();
    const ac = FakeAudioContext.instances[0], s = ac.sources[0];
    viewer.destroy();
    expect(s.stop).toHaveBeenCalled();
    expect(ac.gainNode.disconnect).toHaveBeenCalled();
    expect(ac.analyserNode.disconnect).toHaveBeenCalled();
    expect(ac.close).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.audio-viewer')).toBeNull();
    expect(() => viewer.destroy()).not.toThrow();
    expect((viewer.debugInfo() as { duration: number | null }).duration).toBeNull();
  });

  it('destroy during a pending load is safe and nothing is shown afterwards', async () => {
    routes();
    viewer = new AudioViewer(host);
    const p = viewer.mount(el, { target: { kind: 'audio', name: 'rifle_shot' }, env: env() });
    viewer.destroy();
    await expect(Promise.resolve(p)).resolves.toBeUndefined();
    await flush();
    expect(el.childElementCount).toBe(0);
    expect(FakeAudioContext.instances.length).toBe(0);
  });

  it('plays exported files: no info, no analysis, own download name', async () => {
    const f = fakeFetch({ '/api/export-file': { bytes: wavBytes(22050), contentType: 'audio/wav' } });
    await mount({ kind: 'export', name: 'sfx/boom.wav' });
    expect(f.calls.map((c) => c.url)).toEqual(['/api/export-file?path=sfx%2Fboom.wav']);
    expect($(el, '.vstatus').textContent).toBe('sfx/boom.wav · 0.50 s · 2 ch · 22050 Hz');
    expect(el.querySelector('.analysis-img')).toBeNull();
    const a = $<HTMLAnchorElement>(el, '.vtoolbar a.btn');
    expect(a.getAttribute('href')).toBe('/api/export-file?path=sfx%2Fboom.wav&download=1');
    expect(a.getAttribute('download')).toBe('boom.wav');
    expect([...el.querySelectorAll<HTMLButtonElement>('.vtoolbar button')].find((b) => b.textContent === 'Analyze')!.disabled).toBe(true);
  });

  it('a decode failure is shown in the status line, rethrown, and keeps the download link', async () => {
    routes({ wav: new TextEncoder().encode('BAD!') });
    viewer = new AudioViewer(host);
    await expect(viewer.mount(el, { target: { kind: 'audio', name: 'rifle_shot' }, env: env() })).rejects.toThrow('Unable to decode');
    expect($(el, '.vstatus').textContent).toBe('rifle_shot: Unable to decode audio data');
    expect($<HTMLAnchorElement>(el, '.vtoolbar a.btn').getAttribute('href')).toBe('/api/audio/rifle_shot.wav?download=1');
    expect(FakeOfflineContext.args).toEqual([[1, 1, 44100]]);
  });

  it('reloads 300 ms after an audio event for this name only', async () => {
    const f = routes();
    await mount();
    const wavLoads = () => f.calls.filter((c) => c.url.startsWith('/api/audio/rifle_shot.wav')).length;
    expect(wavLoads()).toBe(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    viewer.onEvent({ type: 'audio', name: 'other', source: 'agent', ts: 1 });
    viewer.onEvent({ type: 'audio', name: 'rifle_shot', source: 'agent', deleted: true, ts: 1 });
    viewer.onEvent({ type: 'audio', name: 'rifle_shot', source: 'agent', ts: 1 });
    viewer.onEvent({ type: 'audio', name: 'rifle_shot', source: 'agent', ts: 2 });
    vi.advanceTimersByTime(299);
    expect(wavLoads()).toBe(1);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await flush();
    expect(wavLoads()).toBe(2);
  });
});
