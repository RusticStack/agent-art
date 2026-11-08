// Minimal, dependency-free PNG encoder/decoder (RGBA8 out, most common formats in).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA8 pixels into a PNG buffer. */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG buffer into { width, height, data: Uint8ClampedArray RGBA8 }. */
export function decodePNG(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let pos = 8;
  let width, height, bitDepth, colorType, interlace;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width) throw new Error('PNG missing IHDR');
  if (interlace) throw new Error('Interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  const bitsPP = channels * bitDepth;
  const bpp = Math.max(1, bitsPP >> 3);
  const stride = Math.ceil((width * bitsPP) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      out[i] = v & 0xff;
    }
    prev = out;
  }
  const outData = new Uint8ClampedArray(width * height * 4);
  const sample = (row, idx) => {
    // read sample #idx in a row (for any bit depth); 16-bit returns high byte
    if (bitDepth === 8) return row[idx];
    if (bitDepth === 16) return row[idx * 2];
    const perByte = 8 / bitDepth;
    const byte = row[Math.floor(idx / perByte)];
    const shift = 8 - bitDepth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const scaleGray = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;
  const trnsGray = trns && colorType === 0 ? trns.readUInt16BE(0) : -1;
  const trnsRGB = trns && colorType === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const i = sample(row, x);
        r = palette[i * 3]; g = palette[i * 3 + 1]; b = palette[i * 3 + 2];
        if (trns && i < trns.length) a = trns[i];
      } else if (colorType === 0 || colorType === 4) {
        const raw0 = sample(row, x * channels);
        r = g = b = Math.round(raw0 * scaleGray);
        if (colorType === 4) a = sample(row, x * channels + 1);
        else if (trnsGray >= 0 && raw0 === (bitDepth === 16 ? trnsGray >> 8 : trnsGray)) a = 0;
      } else {
        r = sample(row, x * channels);
        g = sample(row, x * channels + 1);
        b = sample(row, x * channels + 2);
        if (colorType === 6) a = sample(row, x * channels + 3);
        else if (trnsRGB) {
          const sh = bitDepth === 16 ? 8 : 0;
          if (r === trnsRGB[0] >> sh && g === trnsRGB[1] >> sh && b === trnsRGB[2] >> sh) a = 0;
        }
      }
      outData[o] = r; outData[o + 1] = g; outData[o + 2] = b; outData[o + 3] = a;
    }
  }
  return { width, height, data: outData };
}
