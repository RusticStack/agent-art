// WAV header reading: the file's own sample rate (decodeAudioData resamples to the context's rate).

const tag = (v: DataView, off: number): string =>
  String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));

/** Sample rate from the `fmt ` chunk of a RIFF/WAVE file (walks the chunks), or null when not a WAV. */
export function wavSampleRate(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 12) return null;
  const v = new DataView(buf);
  if (tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(v, off), size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      if (size < 16 || off + 16 > buf.byteLength) return null;
      const rate = v.getUint32(off + 12, true);
      return rate > 0 ? rate : null;
    }
    off += 8 + size + (size & 1);   // chunks are padded to an even size
  }
  return null;
}
