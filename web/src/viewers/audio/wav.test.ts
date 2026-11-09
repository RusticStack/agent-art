import { describe, expect, it } from 'vitest';
import { wavSampleRate } from './wav';

type Chunk = [string, Uint8Array];

function riff(chunks: Chunk[], form = 'WAVE'): ArrayBuffer {
  const body = chunks.reduce((n, [, d]) => n + 8 + d.length + (d.length & 1), 4);
  const buf = new ArrayBuffer(8 + body), v = new DataView(buf), u = new Uint8Array(buf);
  const put = (off: number, s: string) => { for (let i = 0; i < 4; i++) u[off + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, body, true); put(8, form);
  let off = 12;
  for (const [id, d] of chunks) { put(off, id); v.setUint32(off + 4, d.length, true); u.set(d, off + 8); off += 8 + d.length + (d.length & 1); }
  return buf;
}
function fmt(rate: number, channels = 2, bits = 16): Uint8Array {
  const d = new Uint8Array(16), v = new DataView(d.buffer);
  v.setUint16(0, 1, true); v.setUint16(2, channels, true); v.setUint32(4, rate, true);
  v.setUint32(8, (rate * channels * bits) / 8, true); v.setUint16(12, (channels * bits) / 8, true); v.setUint16(14, bits, true);
  return d;
}

describe('wavSampleRate', () => {
  it('reads a canonical 44-byte header', () => {
    const buf = riff([['fmt ', fmt(48000)], ['data', new Uint8Array(8)]]);
    expect(new Uint8Array(buf).length).toBe(44 + 8);
    expect(wavSampleRate(buf)).toBe(48000);
  });
  it('walks past a LIST chunk (odd size, padded) before fmt', () => {
    const list = new TextEncoder().encode('INFOISFT\x05\x00\x00\x00Lavf\x00');   // 17 bytes: odd
    expect(list.length % 2).toBe(1);
    expect(wavSampleRate(riff([['LIST', list], ['fmt ', fmt(22050, 1)], ['data', new Uint8Array(4)]]))).toBe(22050);
  });
  it('null for non-WAV or truncated data', () => {
    expect(wavSampleRate(new ArrayBuffer(4))).toBeNull();
    expect(wavSampleRate(riff([['fmt ', fmt(44100)]], 'AVI '))).toBeNull();
    expect(wavSampleRate(new TextEncoder().encode('OggS\x00\x02 not a wav at all').buffer as ArrayBuffer)).toBeNull();
    expect(wavSampleRate(riff([['data', new Uint8Array(6)]]))).toBeNull();
    const cut = riff([['fmt ', fmt(44100)]]).slice(0, 26);
    expect(wavSampleRate(cut)).toBeNull();
  });
});
