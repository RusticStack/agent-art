// Minimal animated GIF89a encoder (LZW), with exact palettes for pixel art.

/** Build a <=256 color palette for all frames. Transparent (alpha<128) gets index 0. */
function buildPalette(frames) {
  let shift = 0;
  for (;;) {
    const map = new Map();
    let overflow = false;
    for (const f of frames) {
      const d = f.data;
      for (let p = 0; p < d.length; p += 4) {
        if (d[p + 3] < 128) continue;
        const key = ((d[p] >> shift) << 16) | ((d[p + 1] >> shift) << 8) | (d[p + 2] >> shift);
        if (!map.has(key)) {
          if (map.size >= 255) { overflow = true; break; }
          map.set(key, map.size + 1);
        }
      }
      if (overflow) break;
    }
    if (!overflow) return { map, shift };
    shift++; // too many colors: drop precision until it fits (rare for pixel art)
  }
}

function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const bytes = [];
  let cur = 0, bits = 0;
  const write = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(cur & 0xff); cur >>>= 8; bits -= 8; }
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
  };
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    write(prefix);
    if (next < 4096) dict.set(key, next++);
    else {
      write(clear);
      dict = new Map();
      codeSize = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(eoi);
  if (bits > 0) bytes.push(cur & 0xff);
  return bytes;
}

/**
 * frames: [{ data: RGBA Uint8ClampedArray (width*height*4), delay: ms }]
 * Returns a Buffer with an infinitely looping (unless loop:false) GIF.
 */
export function encodeGIF(width, height, frames, { loop = true } = {}) {
  const { map, shift } = buildPalette(frames);
  let tableBits = 1;
  while (1 << tableBits < map.size + 1) tableBits++;
  const tableSize = 1 << tableBits;
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  out.push(...Buffer.from('GIF89a'));
  u16(width); u16(height);
  out.push(0x80 | ((tableBits - 1) << 4) | (tableBits - 1), 0, 0);
  const table = new Array(tableSize * 3).fill(0);
  for (const [key, idx] of map) {
    const unshift = (v) => Math.min(255, (v << shift) | (shift ? (1 << (shift - 1)) : 0));
    table[idx * 3] = unshift((key >> 16) & 0xff);
    table[idx * 3 + 1] = unshift((key >> 8) & 0xff);
    table[idx * 3 + 2] = unshift(key & 0xff);
  }
  out.push(...table);
  if (loop) out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0);
  const minCode = Math.max(2, tableBits);
  for (const f of frames) {
    const cs = Math.max(2, Math.round((f.delay ?? 100) / 10));
    out.push(0x21, 0xf9, 0x04, (2 << 2) | 0x01); // disposal: restore to background; transparent index
    u16(cs);
    out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    const d = f.data;
    const idx = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < idx.length; i++, p += 4) {
      idx[i] = d[p + 3] < 128 ? 0 : map.get(((d[p] >> shift) << 16) | ((d[p + 1] >> shift) << 8) | (d[p + 2] >> shift));
    }
    out.push(minCode);
    const data = lzw(idx, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}
