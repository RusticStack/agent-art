// Canvas document: layers, palette, undo history, frames, and all drawing commands.
import { parseColor, toHex, colorsEqual, blendOver, adjustColor, rgbToHsl, hslToRgb } from './color.js';
import { encodePNG, decodePNG } from './png.js';
import { mulberry32, hash3, smooth, BAYER4, int, BLEND_MODES, blendChannel } from './util.js';
import { EFFECTS } from './effects.js';
import { ISO, ISO_FIELDS } from './iso.js';
import { SHADING } from './shading.js';
import { opUsage } from './docs.js';
import { rotsprite, upscale } from './pixelops.js';
export { mulberry32 };

export const MAX_SIZE = 8192;
export const MAX_PIXELS = 4096 * 4096;
const HISTORY_LIMIT = 200;
const HISTORY_BYTES = 256 * 1024 * 1024;

export class Layer {
  constructor(name, width, height, data = null) {
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.blend = 'normal';
    this.data = data ? new Uint8ClampedArray(data) : new Uint8ClampedArray(width * height * 4);
  }
  clone() {
    const l = new Layer(this.name, 0, 0, this.data);
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.blend = this.blend;
    return l;
  }
}

export class Doc {
  constructor({ name, width, height, frameHeight = null }) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.frameHeight = frameHeight && frameHeight < height ? frameHeight : null;
    this.layers = [new Layer('base', width, height)];
    this.active = 0;
    this.palette = {};
    this.project = null;
    this.meta = {};
    this.animations = {}; // name -> { frames:[i...], durations:[ms...], loop, direction }
    this.inherit = null; // () => inherited palette (from the project)
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this.updated = Date.now();
  }

  /** Project palette overlaid with the canvas's own palette. */
  get fullPalette() {
    const base = this.inherit ? this.inherit() : null;
    return base ? { ...base, ...this.palette } : this.palette;
  }

  get frames() {
    return this.frameHeight ? Math.floor(this.height / this.frameHeight) : 1;
  }

  // ---------- history ----------
  snapshot() {
    return {
      width: this.width,
      height: this.height,
      frameHeight: this.frameHeight,
      active: this.active,
      palette: { ...this.palette },
      animations: JSON.parse(JSON.stringify(this.animations)),
      layers: this.layers.map((l) => l.clone()),
    };
  }
  restore(s) {
    this.width = s.width;
    this.height = s.height;
    this.frameHeight = s.frameHeight;
    this.active = s.active;
    this.palette = { ...s.palette };
    this.animations = JSON.parse(JSON.stringify(s.animations || {}));
    this.layers = s.layers.map((l) => l.clone());
  }
  checkpoint(label) {
    const snap = this.snapshot();
    snap.label = label;
    this.undoStack.push(snap);
    this.redoStack = [];
    const bytes = (s) => s.layers.reduce((n, l) => n + l.data.length, 0);
    let total = this.undoStack.reduce((n, s) => n + bytes(s), 0);
    while (this.undoStack.length > HISTORY_LIMIT || (total > HISTORY_BYTES && this.undoStack.length > 1)) {
      total -= bytes(this.undoStack.shift());
    }
  }
  touch() {
    this.version++;
    this.updated = Date.now();
  }
  undo(steps = 1) {
    const labels = [];
    for (let i = 0; i < steps && this.undoStack.length; i++) {
      const s = this.undoStack.pop();
      const cur = this.snapshot();
      cur.label = s.label;
      this.redoStack.push(cur);
      this.restore(s);
      labels.push(s.label);
    }
    if (labels.length) this.touch();
    return labels;
  }
  redo(steps = 1) {
    const labels = [];
    for (let i = 0; i < steps && this.redoStack.length; i++) {
      const s = this.redoStack.pop();
      const cur = this.snapshot();
      cur.label = s.label;
      this.undoStack.push(cur);
      this.restore(s);
      labels.push(s.label);
    }
    if (labels.length) this.touch();
    return labels;
  }

  // ---------- layers ----------
  layerIndex(ref) {
    if (ref === undefined || ref === null || ref === '') return this.active;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const i = Number(ref);
      if (i < 0 || i >= this.layers.length) throw new Error(`No layer #${i} (have ${this.layers.length})`);
      return i;
    }
    const i = this.layers.findIndex((l) => l.name === ref);
    if (i < 0) throw new Error(`No layer named "${ref}" (layers: ${this.layers.map((l) => l.name).join(', ')})`);
    return i;
  }

  /** Where a new layer goes: index, or position top|bottom|above|below (relative to the active layer; default above). */
  insertIndex(a) {
    if (a.index !== undefined) return Math.max(0, Math.min(this.layers.length, int(a.index, 'index')));
    const pos = a.position || 'above';
    if (pos === 'top') return this.layers.length;
    if (pos === 'bottom') return 0;
    if (pos === 'below') return this.active;
    if (pos === 'above') return this.active + 1;
    throw new Error('position must be top, bottom, above or below');
  }

  layerAction(a) {
    const action = a.action;
    const uniqueName = (base) => {
      let n = base, k = 2;
      while (this.layers.some((l) => l.name === n)) n = `${base} ${k++}`;
      return n;
    };
    switch (action) {
      case 'add': {
        const l = new Layer(uniqueName(a.name || `layer ${this.layers.length + 1}`), this.width, this.height);
        const at = this.insertIndex(a);
        this.layers.splice(at, 0, l);
        if (a.blend) {
          if (!BLEND_MODES.includes(a.blend)) throw new Error(`blend must be one of ${BLEND_MODES.join(', ')}`);
          l.blend = a.blend;
        }
        if (a.opacity !== undefined) l.opacity = Math.max(0, Math.min(1, Number(a.opacity)));
        const prev = this.layers[this.active >= at ? this.active + 1 : this.active];
        this.active = a.select === false ? this.layers.indexOf(prev) : at;
        return `Added layer "${l.name}" at #${at} of ${this.layers.length} (${a.select === false ? `active stays "${prev.name}"` : 'now active'})`;
      }
      case 'stamp_visible': {
        // new layer holding the composite of all visible layers (for whole-image quantize/glow/grade)
        const l = new Layer(uniqueName(a.name || 'stamp'), this.width, this.height, this.composite());
        const at = this.insertIndex({ position: 'top', ...a });
        this.layers.splice(at, 0, l);
        const hide = a.hide_others !== false;
        if (hide) this.layers.forEach((o) => { if (o !== l) o.visible = false; });
        this.active = at;
        return `Stamped visible layers into "${l.name}" at #${at}${hide ? ' (other layers hidden; flatten or remove them when happy)' : ''}`;
      }
      case 'remove': {
        if (this.layers.length === 1) throw new Error('Cannot remove the last layer');
        const i = this.layerIndex(a.layer);
        const [l] = this.layers.splice(i, 1);
        this.active = Math.min(this.active, this.layers.length - 1);
        return `Removed layer "${l.name}"`;
      }
      case 'select': {
        this.active = this.layerIndex(a.layer);
        return `Active layer: "${this.layers[this.active].name}"`;
      }
      case 'rename': {
        const i = this.layerIndex(a.layer);
        if (!a.name) throw new Error('rename needs "name"');
        this.layers[i].name = uniqueName(a.name);
        return `Renamed layer #${i} to "${this.layers[i].name}"`;
      }
      case 'visibility': {
        const i = this.layerIndex(a.layer);
        this.layers[i].visible = a.visible ?? !this.layers[i].visible;
        return `Layer "${this.layers[i].name}" ${this.layers[i].visible ? 'shown' : 'hidden'}`;
      }
      case 'opacity': {
        const i = this.layerIndex(a.layer);
        this.layers[i].opacity = Math.max(0, Math.min(1, Number(a.opacity)));
        return `Layer "${this.layers[i].name}" opacity ${this.layers[i].opacity}`;
      }
      case 'move': {
        const i = this.layerIndex(a.layer);
        const last = this.layers.length - 1;
        const to = a.position === 'top' ? last : a.position === 'bottom' ? 0 : Math.max(0, Math.min(last, int(a.index, 'index')));
        const activeLayer = this.layers[this.active];
        const [l] = this.layers.splice(i, 1);
        this.layers.splice(to, 0, l);
        this.active = this.layers.indexOf(a.select ? l : activeLayer);
        return `Moved layer "${l.name}" to #${to}; active layer "${this.layers[this.active].name}"`;
      }
      case 'duplicate': {
        const i = this.layerIndex(a.layer);
        const l = this.layers[i].clone();
        l.name = uniqueName(a.name || `${l.name} copy`);
        this.layers.splice(i + 1, 0, l);
        this.active = i + 1;
        return `Duplicated to "${l.name}" (now active)`;
      }
      case 'merge_down': {
        const i = this.layerIndex(a.layer);
        if (i === 0) throw new Error('Bottom layer has nothing below to merge into');
        const top = this.layers[i], bot = this.layers[i - 1];
        if (top.visible) bot.data = compositeLayers([{ ...bot, visible: true, opacity: 1, blend: 'normal' }, top], bot.data.length);
        this.layers.splice(i, 1);
        this.active = i - 1;
        return `Merged "${top.name}" into "${bot.name}"`;
      }
      case 'blend': {
        const i = this.layerIndex(a.layer);
        const mode = a.blend || a.mode;
        if (!BLEND_MODES.includes(mode)) throw new Error(`blend must be one of ${BLEND_MODES.join(', ')}`);
        this.layers[i].blend = mode;
        return `Layer "${this.layers[i].name}" blend ${mode}`;
      }
      case 'flatten': {
        const hidden = this.layers.filter((l) => !l.visible);
        if (hidden.length && a.discard_hidden !== true && a.keep_hidden !== true) {
          throw new Error(`flatten would discard hidden layer(s): ${hidden.map((l) => `"${l.name}"`).join(', ')}. Pass keep_hidden:true to keep them (above the result) or discard_hidden:true to drop them`);
        }
        const data = this.composite();
        const base = new Layer(this.layers[0].name, this.width, this.height, data);
        this.layers = a.keep_hidden ? [base, ...hidden] : [base];
        this.active = 0;
        return `Flattened the visible layers into one${a.keep_hidden && hidden.length ? `; kept ${hidden.length} hidden layer(s)` : hidden.length ? `; discarded ${hidden.length} hidden layer(s)` : ''}`;
      }
      default:
        throw new Error(`Unknown layer action "${action}" (add, remove, select, rename, visibility, opacity, blend, move, duplicate, merge_down, flatten, stamp_visible)`);
    }
  }

  // ---------- canvas transforms ----------
  resize(width, height, anchor = 'top-left') {
    width = int(width, 'width');
    height = int(height, 'height');
    checkSize(width, height);
    const ax = anchor.includes('right') ? 1 : anchor.includes('left') ? 0 : 0.5;
    const ay = anchor.includes('bottom') ? 1 : anchor.includes('top') ? 0 : 0.5;
    const ox = Math.round((width - this.width) * ax);
    const oy = Math.round((height - this.height) * ay);
    for (const l of this.layers) {
      const nd = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < this.height; y++) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let x = 0; x < this.width; x++) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const s = (y * this.width + x) * 4;
          nd.set(l.data.subarray(s, s + 4), (ny * width + nx) * 4);
        }
      }
      l.data = nd;
    }
    this.width = width;
    this.height = height;
    if (this.frameHeight && this.frameHeight >= height) this.frameHeight = null;
  }

  /** Pixel-art upscale (Scale2x/3x family), per frame so frames never bleed into each other. */
  upscaleEPX(factor) {
    factor = int(factor, 'factor');
    const fh = this.frameHeight || this.height, n = this.frames;
    checkSize(this.width * factor, this.height * factor);
    for (const l of this.layers) {
      const nd = new Uint8ClampedArray(this.width * factor * this.height * factor * 4);
      for (let f = 0; f < n; f++) {
        const block = l.data.subarray(f * fh * this.width * 4, (f + 1) * fh * this.width * 4);
        const up = upscale(block, this.width, fh, factor);
        nd.set(up.data, f * up.width * up.height * 4);
      }
      l.data = nd;
    }
    if (this.frameHeight) this.frameHeight *= factor;
    this.width *= factor;
    this.height *= factor;
  }

  scaleTo(width, height) {
    width = int(width, 'width');
    height = int(height, 'height');
    checkSize(width, height);
    for (const l of this.layers) {
      const nd = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const sy = Math.min(this.height - 1, Math.floor((y * this.height) / height));
        for (let x = 0; x < width; x++) {
          const sx = Math.min(this.width - 1, Math.floor((x * this.width) / width));
          const s = (sy * this.width + sx) * 4;
          nd.set(l.data.subarray(s, s + 4), (y * width + x) * 4);
        }
      }
      l.data = nd;
    }
    if (this.frameHeight) this.frameHeight = Math.round((this.frameHeight * height) / this.height);
    this.width = width;
    this.height = height;
  }

  crop(x, y, w, h) {
    x = int(x, 'x'); y = int(y, 'y'); w = int(w, 'w'); h = int(h, 'h');
    checkSize(w, h);
    for (const l of this.layers) {
      const nd = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const sx = x + xx, sy = y + yy;
          if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue;
          const s = (sy * this.width + sx) * 4;
          nd.set(l.data.subarray(s, s + 4), (yy * w + xx) * 4);
        }
      }
      l.data = nd;
    }
    this.width = w;
    this.height = h;
    if (this.frameHeight && this.frameHeight >= h) this.frameHeight = null;
  }

  // ---------- compositing & rendering ----------
  /** exclude: layer names left out of the composite (3D textures leave out "emissive"). */
  composite({ layer, exclude } = {}) {
    let list = layer !== undefined && layer !== null ? [{ ...this.layers[this.layerIndex(layer)], visible: true, blend: 'normal' }] : this.layers;
    if (exclude && exclude.length && (layer === undefined || layer === null)) list = list.filter((l) => !exclude.includes(l.name));
    return compositeLayers(list, this.width * this.height * 4);
  }

  /** Composite one frame only (Uint8ClampedArray of width x frameHeight). */
  frameData(f, opts = {}) {
    const all = this.composite(opts);
    if (!this.frameHeight) return all;
    const n = this.width * this.frameHeight * 4;
    return all.slice(f * n, (f + 1) * n);
  }

  // ---------- frames ----------
  /**
   * Rebuild the frame strip from `order`: each entry is a source frame index or -1 for a
   * blank frame. Animation tags are remapped (frames that no longer exist are dropped).
   */
  reorderFrames(order) {
    const fh = this.frameHeight || this.height;
    const n = this.width * fh * 4;
    checkSize(this.width, fh * order.length);
    for (const l of this.layers) {
      const nd = new Uint8ClampedArray(n * order.length);
      order.forEach((src, i) => {
        if (src >= 0) nd.set(l.data.subarray(src * n, (src + 1) * n), i * n);
      });
      l.data = nd;
    }
    this.height = fh * order.length;
    this.frameHeight = order.length > 1 ? fh : null;
    if (order.length === 1) this.frameHeight = fh === this.height ? null : fh;
    // remap tags: old index -> first new position that copies it
    const map = new Map();
    order.forEach((src, i) => { if (src >= 0 && !map.has(src)) map.set(src, i); });
    for (const [name, t] of Object.entries(this.animations)) {
      const keep = t.frames.map((f, k) => [map.get(f), t.durations[k]]).filter(([f]) => f !== undefined);
      if (!keep.length) delete this.animations[name];
      else { t.frames = keep.map((k) => k[0]); t.durations = keep.map((k) => k[1]); }
    }
  }

  /** Make the canvas a frame strip (if it is not one) so frame ops work. */
  ensureFrames() {
    if (!this.frameHeight) this.frameHeight = this.height;
  }

  setAnimation(name, { frames, from, to, durations, duration, fps, loop = true, direction = 'forward' } = {}) {
    if (!name) throw new Error('animation needs a "name"');
    let list = frames;
    if (!list) {
      if (from === undefined || to === undefined) throw new Error('give "frames": [...] or "from" and "to"');
      list = [];
      for (let i = int(from, 'from'); i <= int(to, 'to'); i++) list.push(i);
    }
    list = list.map((f) => int(f, 'frame'));
    for (const f of list) if (f < 0 || f >= this.frames) throw new Error(`frame ${f} out of range (0..${this.frames - 1})`);
    if (!list.length) throw new Error('animation has no frames');
    let durs;
    if (Array.isArray(durations)) {
      if (durations.length !== list.length) throw new Error('"durations" must have one entry per frame');
      durs = durations.map((d) => Math.max(10, int(d, 'duration')));
    } else {
      const d = duration ?? (fps ? 1000 / fps : 100);
      durs = list.map(() => Math.max(10, Math.round(d)));
    }
    if (!['forward', 'reverse', 'pingpong'].includes(direction)) throw new Error('direction must be forward, reverse or pingpong');
    this.animations[name] = { frames: list, durations: durs, loop: loop !== false, direction };
    return this.animations[name];
  }

  /** Frames + durations of an animation in playback order (pingpong/reverse expanded). */
  playback(name) {
    let frames, durations;
    if (name) {
      const t = this.animations[name];
      if (!t) throw new Error(`No animation "${name}" (have: ${Object.keys(this.animations).join(', ') || 'none'})`);
      frames = [...t.frames]; durations = [...t.durations];
      if (t.direction === 'reverse') { frames.reverse(); durations.reverse(); }
      if (t.direction === 'pingpong' && frames.length > 2) {
        frames = frames.concat(frames.slice(1, -1).reverse());
        durations = durations.concat(durations.slice(1, -1).reverse());
      }
    } else {
      frames = [...Array(this.frames).keys()];
      durations = frames.map(() => Number(this.meta?.frame_ms) || 100);
    }
    return { frames, durations };
  }

  /**
   * Render to an RGBA image. Options: scale (int), layer, frame, tile (NxN repeat),
   * grid (pixel grid lines, needs scale>=4), background ('none'|'checker'|color).
   */
  render({ scale = 1, layer, frame, tile = 1, grid = false, background = 'none', region, tint, onion = 0, guide } = {}) {
    let src = this.composite({ layer });
    let w = this.width, h = this.height;
    if (frame !== undefined && frame !== null && this.frameHeight) {
      const f = int(frame, 'frame');
      if (f < 0 || f >= this.frames) throw new Error(`Frame ${f} out of range (0..${this.frames - 1})`);
      h = this.frameHeight;
      const n = h * w * 4;
      const cur = src.slice(f * n, (f + 1) * n);
      if (onion > 0) {
        // ghost neighbouring frames under the current one: previous = red, next = blue
        const ghost = new Uint8ClampedArray(n);
        for (let k = Math.min(3, int(onion, 'onion')); k >= 1; k--) {
          for (const [ff, col] of [[f - k, [255, 70, 70]], [f + k, [70, 140, 255]]]) {
            if (ff < 0 || ff >= this.frames) continue;
            for (let p = 0; p < n; p += 4) {
              const a = src[ff * n + p + 3];
              if (!a) continue;
              const g = blendOver([ghost[p], ghost[p + 1], ghost[p + 2], ghost[p + 3]], [col[0], col[1], col[2], Math.round(90 / k)]);
              ghost.set(g, p);
            }
          }
        }
        for (let p = 0; p < n; p += 4) ghost.set(blendOver([ghost[p], ghost[p + 1], ghost[p + 2], ghost[p + 3]], [cur[p], cur[p + 1], cur[p + 2], cur[p + 3]]), p);
        src = ghost;
      } else src = cur;
    }
    if (tint) {
      const t = parseColor(tint, this.fullPalette);
      src = src.slice();
      for (let p = 0; p < src.length; p += 4) {
        src[p] = (src[p] * t[0]) / 255; src[p + 1] = (src[p + 1] * t[1]) / 255; src[p + 2] = (src[p + 2] * t[2]) / 255;
      }
    }
    if (region) {
      const rx = Math.max(0, int(region.x ?? 0, 'x')), ry = Math.max(0, int(region.y ?? 0, 'y'));
      const rw = Math.min(w - rx, int(region.w ?? w - rx, 'w')), rh = Math.min(h - ry, int(region.h ?? h - ry, 'h'));
      if (rw <= 0 || rh <= 0) throw new Error('Empty render region');
      const out = new Uint8ClampedArray(rw * rh * 4);
      for (let y = 0; y < rh; y++) out.set(src.subarray(((ry + y) * w + rx) * 4, ((ry + y) * w + rx + rw) * 4), y * rw * 4);
      src = out; w = rw; h = rh;
    }
    scale = Math.max(1, Math.min(64, int(scale, 'scale')));
    tile = Math.max(1, Math.min(8, int(tile, 'tile')));
    const tw = w * tile, th = h * tile;
    const W = tw * scale, H = th * scale;
    if (W * H > MAX_PIXELS) throw new Error('Render too large; lower scale or tile, or view a region (x,y,w,h)');
    const out = new Uint8ClampedArray(W * H * 4);
    const bg = background && background !== 'none' && background !== 'checker' ? parseColor(background, this.fullPalette) : null;
    const checkSize = Math.max(4, Math.min(16, scale * 2)); // checker cell in output pixels
    for (let oy = 0; oy < H; oy++) {
      const sy = Math.floor(oy / scale) % h;
      for (let ox = 0; ox < W; ox++) {
        const sx = Math.floor(ox / scale) % w;
        const s = (sy * w + sx) * 4;
        const o = (oy * W + ox) * 4;
        let c = [src[s], src[s + 1], src[s + 2], src[s + 3]];
        if (background === 'checker') {
          const light = ((Math.floor(ox / checkSize) + Math.floor(oy / checkSize)) & 1) === 0;
          c = blendOver(light ? [204, 204, 204, 255] : [153, 153, 153, 255], c);
        } else if (bg) c = blendOver(bg, c);
        if (grid && scale >= 4) {
          const px = ox % scale === 0, py = oy % scale === 0;
          if (px || py) {
            const major = (px && (Math.floor(ox / scale) % w) % 4 === 0) || (py && (Math.floor(oy / scale) % h) % 4 === 0);
            c = blendOver(c, major ? [0, 0, 0, 110] : [0, 0, 0, 45]);
            if (c[3] < 255 && background === 'none') c[3] = Math.max(c[3], major ? 110 : 45);
          }
        }
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
      }
    }
    if (guide) drawGuide(out, W, H, scale, guide);
    return { width: W, height: H, data: out };
  }

  toPNG(opts = {}) {
    const img = this.render(opts);
    return encodePNG(img.width, img.height, img.data);
  }

  // ---------- inspection ----------
  colorStats(limit = 32) {
    const counts = new Map();
    const d = this.composite();
    for (let p = 0; p < d.length; p += 4) {
      if (!d[p + 3]) continue;
      const k = toHex([d[p], d[p + 1], d[p + 2], d[p + 3]]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return { unique: counts.size, top: sorted.slice(0, limit).map(([color, count]) => ({ color, count })) };
  }

  /** Read a region as a character grid plus legend (or hex rows when too many colors). */
  read({ x = 0, y = 0, w, h, layer, frame } = {}) {
    let oy = 0;
    if (frame !== undefined && frame !== null && this.frameHeight) oy = int(frame, 'frame') * this.frameHeight;
    const fh = this.frameHeight && frame !== undefined && frame !== null ? this.frameHeight : this.height;
    x = int(x, 'x'); y = int(y, 'y');
    w = w === undefined ? this.width - x : int(w, 'w');
    h = h === undefined ? fh - y : int(h, 'h');
    if (w <= 0 || h <= 0) throw new Error('Empty region');
    if (w * h > 128 * 128) throw new Error('Region too large to read as text (max 128x128 pixels); read a smaller part');
    const d = layer !== undefined && layer !== null ? this.layers[this.layerIndex(layer)].data : this.composite();
    const at = (xx, yy) => {
      const gx = x + xx, gy = y + yy + oy;
      if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) return null;
      const p = (gy * this.width + gx) * 4;
      return [d[p], d[p + 1], d[p + 2], d[p + 3]];
    };
    // char assignment: '.' transparent, palette single-char keys reused, then a pool
    const hexToChar = new Map();
    const used = new Set(['.']);
    for (const [k, v] of Object.entries(this.fullPalette)) {
      if ([...k].length !== 1 || k === '.' || k === ' ') continue;
      try {
        const hx = toHex(parseColor(v));
        if (!hexToChar.has(hx)) { hexToChar.set(hx, k); used.add(k); }
      } catch { /* ignore */ }
    }
    const pool = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?<>!^~:;'].filter((c) => !used.has(c));
    const rows = [];
    let overflow = false;
    for (let yy = 0; yy < h && !overflow; yy++) {
      let row = '';
      for (let xx = 0; xx < w; xx++) {
        const c = at(xx, yy);
        if (!c || c[3] === 0) { row += '.'; continue; }
        const hx = toHex(c);
        if (!hexToChar.has(hx)) {
          if (!pool.length) { overflow = true; break; }
          hexToChar.set(hx, pool.shift());
        }
        row += hexToChar.get(hx);
      }
      rows.push(row);
    }
    if (overflow) {
      const hexRows = [];
      for (let yy = 0; yy < h; yy++) {
        const r = [];
        for (let xx = 0; xx < w; xx++) {
          const c = at(xx, yy);
          r.push(!c || c[3] === 0 ? '-' : toHex(c));
        }
        hexRows.push(r.join(' '));
      }
      return { x, y, w, h, format: 'hex', rows: hexRows };
    }
    const legend = { '.': 'transparent' };
    for (const [hx, ch] of hexToChar) if (rows.some((r) => r.includes(ch))) legend[ch] = hx;
    return { x, y, w, h, format: 'grid', rows, legend };
  }

  // ---------- serialization ----------
  toJSON() {
    return {
      name: this.name,
      width: this.width,
      height: this.height,
      frameHeight: this.frameHeight,
      active: this.active,
      palette: this.palette,
      project: this.project,
      meta: this.meta,
      animations: this.animations,
      layers: this.layers.map((l) => ({
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        blend: l.blend,
        png: encodePNG(this.width, this.height, l.data).toString('base64'),
      })),
    };
  }
  static fromJSON(j) {
    const d = new Doc({ name: j.name, width: j.width, height: j.height, frameHeight: j.frameHeight });
    d.palette = j.palette || {};
    d.project = j.project || null;
    d.meta = j.meta || {};
    d.animations = j.animations || {};
    d.layers = j.layers.map((lj) => {
      const img = decodePNG(Buffer.from(lj.png, 'base64'));
      const l = new Layer(lj.name, j.width, j.height, img.data);
      l.visible = lj.visible !== false;
      l.opacity = lj.opacity ?? 1;
      l.blend = lj.blend || 'normal';
      return l;
    });
    d.active = Math.min(j.active || 0, d.layers.length - 1);
    return d;
  }

  info() {
    return {
      name: this.name,
      width: this.width,
      height: this.height,
      frames: this.frames,
      frameHeight: this.frameHeight,
      activeLayer: this.active,
      layers: this.layers.map((l, i) => ({ index: i, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend })),
      animations: this.animations,
      project: this.project,
      meta: this.meta,
      palette: this.palette,
      inheritedPalette: this.inherit ? this.inherit() : undefined,
      undo: this.undoStack.length,
      redo: this.redoStack.length,
      version: this.version,
    };
  }

  // ---------- drawing ----------
  /**
   * Execute a batch of drawing commands atomically (one undo step).
   * resolveDoc(name) lets `copy` read from other canvases.
   */
  execute(commands, { layer, frame, label, resolveDoc } = {}) {
    if (!Array.isArray(commands) || !commands.length) throw new Error('"commands" must be a non-empty array');
    const before = this.snapshot();
    this.checkpoint(label || commands.map((c) => c.op).join(', '));
    const dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const notes = [];
    try {
      commands.forEach((cmd, i) => {
        try {
          const ctx = new Ctx(this, {
            layer: cmd.layer ?? layer,
            frame: cmd.frame ?? frame,
            mask: cmd.mask,
            blend: cmd.blend,
            symmetry: cmd.symmetry,
            dirty,
            resolveDoc,
          });
          const fn = COMMANDS[cmd.op];
          if (!fn) throw new Error(`Unknown op "${cmd.op}". Valid: ${Object.keys(COMMANDS).join(', ')}`);
          const unknown = Object.keys(cmd).filter((k) => !knownFields(cmd.op).has(k));
          if (unknown.length) notes.push(`#${i} ${cmd.op}: ignored unknown field(s) ${unknown.join(', ')} — see art_help {op:"${cmd.op}"}`);
          const note = fn(ctx, cmd);
          if (note) notes.push(note);
        } catch (e) {
          const usage = cmd && COMMANDS[cmd.op] ? opUsage(cmd.op) : null;
          throw new Error(`command #${i} (${cmd && cmd.op}): ${e.message}${usage ? `
usage: ${usage}` : ''}`);
        }
      });
    } catch (e) {
      this.restore(before);
      this.undoStack.pop();
      throw e;
    }
    this.touch();
    // dirty is always in canvas coordinates; for frame strips also report which frames changed
    const rect = dirty.x0 === Infinity ? null : { x: dirty.x0, y: dirty.y0, w: dirty.x1 - dirty.x0 + 1, h: dirty.y1 - dirty.y0 + 1 };
    let frames;
    if (rect && this.frameHeight) {
      const f0 = Math.floor(rect.y / this.frameHeight), f1 = Math.floor((rect.y + rect.h - 1) / this.frameHeight);
      frames = { first: f0, last: f1 };
      if (f0 === f1) frames.local = { x: rect.x, y: rect.y - f0 * this.frameHeight, w: rect.w, h: rect.h };
    }
    return { dirty: rect, frames, notes };
  }
}

export function checkSize(w, h) {
  if (!(w >= 1 && h >= 1 && w <= MAX_SIZE && h <= MAX_SIZE)) throw new Error(`Size must be 1..${MAX_SIZE} per side (got ${w}x${h})`);
  if (w * h > MAX_PIXELS) throw new Error(`Canvas too large: ${w}x${h} exceeds ${MAX_PIXELS} pixels`);
}

/** Paint context for one command: target layer, clip (frame), mask, blend, symmetry. */
class Ctx {
  constructor(doc, { layer, frame, mask, blend, symmetry, dirty, resolveDoc }) {
    this.doc = doc;
    this.pal = doc.fullPalette;
    this.layerIdx = doc.layerIndex(layer);
    this.data = doc.layers[this.layerIdx].data;
    this.W = doc.width;
    this.oy = 0;
    this.w = doc.width;
    this.h = doc.height;
    if (frame !== undefined && frame !== null) {
      if (!doc.frameHeight) throw new Error('This canvas has no frames (create it with "frames")');
      const f = int(frame, 'frame');
      if (f < 0 || f >= doc.frames) throw new Error(`Frame ${f} out of range (0..${doc.frames - 1})`);
      this.oy = f * doc.frameHeight;
      this.h = doc.frameHeight;
    }
    this.blend = blend || 'replace';
    if (!['replace', 'over'].includes(this.blend)) throw new Error('blend must be "replace" or "over"');
    this.symmetry = symmetry || null;
    if (this.symmetry && !['x', 'y', 'xy'].includes(this.symmetry)) throw new Error('symmetry must be "x", "y" or "xy"');
    this.mask = null;
    if (mask && mask !== 'all') {
      if (mask === 'opaque' || mask === 'transparent') this.mask = mask;
      else if (typeof mask === 'string' && /^!?layer:/.test(mask)) {
        // clip to another layer's painted pixels ("layer:body") or its empty pixels ("!layer:body")
        this.maskInvert = mask.startsWith('!');
        this.maskLayer = doc.layers[doc.layerIndex(mask.replace(/^!?layer:/, ''))].data;
      } else this.mask = this.color(mask);
    }
    this.dirty = dirty;
    this.resolveDoc = resolveDoc;
  }
  color(c) {
    return parseColor(c, this.pal);
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const p = ((y + this.oy) * this.W + x) * 4;
    const d = this.data;
    return [d[p], d[p + 1], d[p + 2], d[p + 3]];
  }
  /** Region in local coords, defaulting to the whole clip area. */
  region(a) {
    // also accept region:[x,y,w,h] or region:{x,y,w,h} (models often send that form)
    const R = Array.isArray(a.region) ? { x: a.region[0], y: a.region[1], w: a.region[2], h: a.region[3] } : a.region && typeof a.region === 'object' ? a.region : null;
    if (R) a = { ...a, x: a.x ?? R.x, y: a.y ?? R.y, w: a.w ?? R.w, h: a.h ?? R.h };
    const x = a.x === undefined ? 0 : int(a.x, 'x');
    const y = a.y === undefined ? 0 : int(a.y, 'y');
    const w = a.w === undefined ? this.w - x : int(a.w, 'w');
    const h = a.h === undefined ? this.h - y : int(a.h, 'h');
    return { x, y, w, h };
  }
  set(x, y, c) {
    this.put(x, y, c);
    if (!this.symmetry) return;
    const mx = this.w - 1 - x, my = this.h - 1 - y;
    if (this.symmetry.includes('x')) this.put(mx, y, c);
    if (this.symmetry.includes('y')) this.put(x, my, c);
    if (this.symmetry === 'xy') this.put(mx, my, c);
  }
  /** mode: undefined = mask + blend, 'mask' = mask only, 'force' = neither. */
  put(x, y, c, mode) {
    const force = mode === 'force';
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const gy = y + this.oy;
    const p = (gy * this.W + x) * 4;
    const d = this.data;
    if (!force && this.mask) {
      const ea = d[p + 3];
      if (this.mask === 'opaque' && ea === 0) return;
      if (this.mask === 'transparent' && ea !== 0) return;
      if (Array.isArray(this.mask) && !colorsEqual([d[p], d[p + 1], d[p + 2], ea], this.mask)) return;
    }
    if (!force && this.maskLayer && (this.maskLayer[p + 3] === 0) !== !!this.maskInvert) return;
    if (!mode && this.blend === 'over' && c[3] < 255) c = blendOver([d[p], d[p + 1], d[p + 2], d[p + 3]], c);
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
    const D = this.dirty;
    if (x < D.x0) D.x0 = x;
    if (x > D.x1) D.x1 = x;
    if (gy < D.y0) D.y0 = gy;
    if (gy > D.y1) D.y1 = gy;
  }
  /** Copy of the current layer pixels within the clip, for ops that read-before-write. */
  copyLocal() {
    const out = new Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) out[y * this.w + x] = this.get(x, y);
    return out;
  }
}

function linePoints(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

function colorList(ctx, a, key = 'colors') {
  const list = a[key] ?? (a.color !== undefined ? [a.color] : null);
  if (!Array.isArray(list) || !list.length) throw new Error(`needs "${key}" (array of colors)`);
  return list.map((c) => ctx.color(c));
}

function pickWeighted(colors, weights, v) {
  if (!weights) return colors[Math.min(colors.length - 1, Math.floor(v * colors.length))];
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (let i = 0; i < colors.length; i++) {
    acc += (weights[i] ?? 0) / total;
    if (v < acc) return colors[i];
  }
  return colors[colors.length - 1];
}

/** Tileable value noise in [0,1). period in lattice cells. */
function valueNoise(x, y, periodX, periodY, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const m = (v, p) => ((v % p) + p) % p;
  const v = (ix, iy) => hash3(m(ix, periodX), m(iy, periodY), seed);
  const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}


/** Remove L-shaped corners from a 1px path (classic pixel-perfect line cleanup). */
function pixelPerfect(path) {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const p = out[out.length - 1], c = path[i], n = path[i + 1];
    const corner = (p[0] === c[0] || p[1] === c[1]) && (n[0] === c[0] || n[1] === c[1]) && p[0] !== n[0] && p[1] !== n[1];
    if (!corner) out.push(c);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Stroke a pixel path. Options: width, brush ('round' default | 'square'), pixel_perfect. */
function strokePath(ctx, path, col, a = {}) {
  const width = Math.max(1, int(a.width ?? 1, 'width'));
  if (width === 1 && a.pixel_perfect) path = pixelPerfect(path);
  const round = (a.brush || 'round') === 'round' && width > 2;
  const off = Math.floor((width - 1) / 2);
  const r2 = (width / 2) ** 2;
  const seen = new Set();
  for (const [x, y] of path) {
    for (let dy = 0; dy < width; dy++) for (let dx = 0; dx < width; dx++) {
      if (round && (dx - (width - 1) / 2) ** 2 + (dy - (width - 1) / 2) ** 2 > r2) continue;
      const k = `${x + dx - off},${y + dy - off}`;
      if (seen.has(k)) continue; // avoid double-blending on 'over'
      seen.add(k);
      ctx.set(x + dx - off, y + dy - off, col);
    }
  }
}

// 3x5 pixel font (a few glyphs are wider)
const FONT_H = 5;
const FONT = Object.fromEntries(Object.entries({
  A: '010 101 111 101 101', B: '110 101 110 101 110', C: '011 100 100 100 011', D: '110 101 101 101 110',
  E: '111 100 110 100 111', F: '111 100 110 100 100', G: '011 100 101 101 011', H: '101 101 111 101 101',
  I: '111 010 010 010 111', J: '001 001 001 101 010', K: '101 101 110 101 101', L: '100 100 100 100 111',
  M: '10001 11011 10101 10001 10001', N: '1001 1101 1011 1001 1001', O: '010 101 101 101 010', P: '110 101 110 100 100',
  Q: '010 101 101 110 011', R: '110 101 110 101 101', S: '011 100 010 001 110', T: '111 010 010 010 010',
  U: '101 101 101 101 111', V: '101 101 101 101 010', W: '10001 10001 10101 11011 10001', X: '101 101 010 101 101',
  Y: '101 101 010 010 010', Z: '111 001 010 100 111',
  0: '111 101 101 101 111', 1: '010 110 010 010 111', 2: '110 001 010 100 111', 3: '110 001 010 001 110',
  4: '101 101 111 001 001', 5: '111 100 110 001 110', 6: '011 100 111 101 111', 7: '111 001 010 010 010',
  8: '111 101 111 101 111', 9: '111 101 111 001 110',
  ' ': '00 00 00 00 00', '.': '0 0 0 0 1', ',': '00 00 00 01 10', '!': '1 1 1 0 1', '?': '110 001 010 000 010',
  '-': '000 000 111 000 000', _: '000 000 000 000 111', ':': '0 1 0 1 0', ';': '00 01 00 01 10', '/': '001 001 010 100 100',
  "'": '1 1 0 0 0', '"': '101 101 000 000 000', '(': '01 10 10 10 01', ')': '10 01 01 01 10', '+': '000 010 111 010 000',
  '=': '000 111 000 111 000', '#': '101 111 101 111 101', '%': '101 001 010 100 101', '*': '000 101 010 101 000',
  '<': '001 010 100 010 001', '>': '100 010 001 010 100', '&': '010 101 010 101 011', '@': '111 101 111 100 111',
  '[': '11 10 10 10 11', ']': '11 01 01 01 11', '|': '1 1 1 1 1', '^': '010 101 000 000 000', '~': '0000 0101 1010 0000 0000',
  '♥': '01010 11111 11111 01110 00100',
}).map(([k, v]) => [k, v.split(' ')]));

export function textWidth(text, scale = 1, spacing = 1) {
  const chars = [...String(text).toUpperCase()];
  if (!chars.length) return 0;
  return chars.reduce((w, ch) => w + ((FONT[ch] || FONT['?'])[0].length + spacing) * scale, 0) - spacing * scale;
}
export { FONT, FONT_H };

const COMMANDS = {
  pixels(ctx, a) {
    if (!Array.isArray(a.points)) throw new Error('needs "points": [[x,y], ...] or [[x,y,color], ...]');
    const def = a.color !== undefined ? ctx.color(a.color) : null;
    for (const p of a.points) {
      const [x, y, c] = Array.isArray(p) ? p : [p.x, p.y, p.color];
      const col = c !== undefined ? ctx.color(c) : def;
      if (!col) throw new Error('point without color and no default "color"');
      ctx.set(int(x, 'x'), int(y, 'y'), col);
    }
  },

  grid(ctx, a) {
    let rows = a.rows;
    if (typeof rows === 'string') rows = rows.split(/\r?\n/);
    if (!Array.isArray(rows)) throw new Error('needs "rows": array of strings');
    const legend = a.legend || {};
    const ox = int(a.x ?? 0, 'x'), oy = int(a.y ?? 0, 'y');
    const cpp = Math.max(1, int(a.cpp ?? 1, 'cpp')); // chars per pixel: 2 allows keys like "s1", "g2"
    const cache = new Map();
    const lookup = (ch) => {
      if (cache.has(ch)) return cache.get(ch);
      let col;
      if (Object.prototype.hasOwnProperty.call(legend, ch)) col = ctx.color(legend[ch]);
      else if (/^[. ]+$/.test(ch)) col = null;
      else if (Object.prototype.hasOwnProperty.call(ctx.pal, ch)) col = ctx.color(ctx.pal[ch]);
      else if (cpp > 1 && Object.prototype.hasOwnProperty.call(ctx.pal, ch.trim())) col = ctx.color(ctx.pal[ch.trim()]);
      else throw new Error(`grid ${cpp > 1 ? 'cell' : 'char'} "${ch}" is not in legend or palette`);
      cache.set(ch, col);
      return col;
    };
    rows.forEach((row, y) => {
      const chars = [...row];
      for (let x = 0; x * cpp < chars.length; x++) {
        const col = lookup(chars.slice(x * cpp, x * cpp + cpp).join(''));
        if (col) ctx.set(ox + x, oy + y, col);
      }
    });
  },

  line(ctx, a) {
    const col = ctx.color(a.color);
    const pts = a.points ? a.points.map((p) => [int(p[0], 'x'), int(p[1], 'y')]) : [[int(a.x1, 'x1'), int(a.y1, 'y1')], [int(a.x2, 'x2'), int(a.y2, 'y2')]];
    let path = [];
    for (let i = 0; i < pts.length - 1; i++) path.push(...linePoints(...pts[i], ...pts[i + 1]).slice(i ? 1 : 0));
    if (pts.length === 1) path = [pts[0]];
    strokePath(ctx, path, col, a);
  },

  curve(ctx, a) {
    const col = ctx.color(a.color);
    const P = (a.points || []).map((p) => [Number(p[0]), Number(p[1])]);
    if (P.length < 3 || P.length > 4) throw new Error('curve needs 3 (quadratic) or 4 (cubic) bezier "points"');
    const at = (t) => {
      const u = 1 - t;
      if (P.length === 3) return [0, 1].map((k) => u * u * P[0][k] + 2 * u * t * P[1][k] + t * t * P[2][k]);
      return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]);
    };
    const len = P.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - P[i][0], p[1] - P[i][1]), 0);
    const steps = Math.max(8, Math.ceil(len * 3));
    const path = [];
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const [x, y] = at(i / steps).map(Math.round);
      if (prev && prev[0] === x && prev[1] === y) continue;
      if (prev) path.push(...linePoints(prev[0], prev[1], x, y).slice(1));
      else path.push([x, y]);
      prev = [x, y];
    }
    strokePath(ctx, path, col, { pixel_perfect: true, ...a });
  },

  polygon(ctx, a) {
    const pts = (a.points || []).map((p) => [Number(p[0]), Number(p[1])]);
    if (pts.length < 3) throw new Error('polygon needs at least 3 "points"');
    const fill = a.fill === false ? null : a.color !== undefined ? ctx.color(a.color) : null;
    const outline = a.outline !== undefined ? ctx.color(a.outline) : a.fill === false ? ctx.color(a.color) : null;
    if (fill) {
      const ys = pts.map((p) => p[1]);
      const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5, xs = [];
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
          if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((m, n) => m - n);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) ctx.set(x, y, fill);
        }
      }
    }
    if (outline) {
      const ip = pts.map((p) => p.map(Math.round));
      const path = [];
      for (let i = 0; i < ip.length; i++) path.push(...linePoints(...ip[i], ...ip[(i + 1) % ip.length]).slice(1));
      strokePath(ctx, path, outline, { width: a.width });
    }
  },

  text(ctx, a) {
    const col = ctx.color(a.color);
    const scale = Math.max(1, int(a.scale ?? 1, 'scale'));
    const spacing = int(a.spacing ?? 1, 'spacing');
    const lineH = (FONT_H + int(a.line_spacing ?? 2, 'line_spacing')) * scale;
    const shadow = a.shadow !== undefined ? ctx.color(a.shadow) : null;
    const lines = String(a.text ?? '').toUpperCase().split(/\r?\n/);
    let y = int(a.y ?? 0, 'y');
    for (const line of lines) {
      let x = int(a.x ?? 0, 'x');
      const w = textWidth(line, scale, spacing);
      if (a.align === 'center') x -= Math.floor(w / 2);
      else if (a.align === 'right') x -= w;
      for (const ch of line) {
        const g = FONT[ch] || FONT['?'];
        for (const [c, d] of shadow ? [[shadow, scale], [col, 0]] : [[col, 0]]) {
          for (let gy = 0; gy < FONT_H; gy++) for (let gx = 0; gx < g[gy].length; gx++) {
            if (g[gy][gx] !== '1') continue;
            for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) ctx.set(x + gx * scale + sx + d, y + gy * scale + sy + d, c);
          }
        }
        x += (g[0].length + spacing) * scale;
      }
      y += lineH;
    }
  },

  remap(ctx, a) {
    if (!a.map || typeof a.map !== 'object') throw new Error('needs "map": {fromColor: toColor}');
    const pairs = Object.entries(a.map).map(([f, t]) => [ctx.color(f), ctx.color(t)]);
    const tol = a.tolerance ?? 0;
    const { x, y, w, h } = ctx.region(a);
    let n = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const c = ctx.get(xx, yy);
      if (!c) continue;
      const hit = pairs.find(([f]) => colorsEqual(c, f, tol));
      if (hit) { ctx.put(xx, yy, hit[1], 'mask'); n++; }
    }
    if (n === 0 && !a.allow_none) {
      const present = new Map();
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        const c = ctx.get(xx, yy);
        if (c && c[3]) { const k = toHex(c); present.set(k, (present.get(k) || 0) + 1); }
      }
      const top = [...present.entries()].sort((m, q) => q[1] - m[1]).slice(0, 16).map(([k]) => k);
      throw new Error(`remap matched no pixels (none of the "from" colors are present). Colors present: ${top.join(' ')} (pass allow_none:true to ignore)`);
    }
    return `remapped ${n} px`;
  },

  rect(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const fill = a.fill === false ? null : a.color !== undefined ? ctx.color(a.color) : null;
    const outline = a.outline !== undefined ? ctx.color(a.outline) : a.fill === false ? ctx.color(a.color) : null;
    const t = Math.max(1, int(a.thickness ?? 1, 'thickness'));
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const edge = xx < x + t || xx >= x + w - t || yy < y + t || yy >= y + h - t;
      if (edge && outline) ctx.set(xx, yy, outline);
      else if (fill) ctx.set(xx, yy, fill);
    }
  },

  ellipse(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const fill = a.fill === false ? null : a.color !== undefined ? ctx.color(a.color) : null;
    const outline = a.outline !== undefined ? ctx.color(a.outline) : a.fill === false ? ctx.color(a.color) : null;
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const inside = (px, py) => {
      if (px < x || py < y || px >= x + w || py >= y + h) return false;
      const nx = (px + 0.5 - cx) / rx, ny = (py + 0.5 - cy) / ry;
      return nx * nx + ny * ny <= 1.0001;
    };
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (!inside(xx, yy)) continue;
      const edge = !inside(xx - 1, yy) || !inside(xx + 1, yy) || !inside(xx, yy - 1) || !inside(xx, yy + 1);
      if (edge && outline) ctx.set(xx, yy, outline);
      else if (fill) ctx.set(xx, yy, fill);
    }
  },

  fill(ctx, a) {
    const col = ctx.color(a.color);
    const sx = int(a.x, 'x'), sy = int(a.y, 'y');
    const target = ctx.get(sx, sy);
    if (!target) throw new Error(`start point ${sx},${sy} is outside the canvas`);
    const tol = a.tolerance ?? 0;
    const visited = new Uint8Array(ctx.w * ctx.h);
    if (a.contiguous === false) {
      for (let y = 0; y < ctx.h; y++) for (let x = 0; x < ctx.w; x++) if (colorsEqual(ctx.get(x, y), target, tol)) ctx.set(x, y, col);
      return;
    }
    const diag = !!a.diagonal;
    const stack = [[sx, sy]];
    const matches = [];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) continue;
      const i = y * ctx.w + x;
      if (visited[i]) continue;
      visited[i] = 1;
      if (!colorsEqual(ctx.get(x, y), target, tol)) continue;
      matches.push([x, y]);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      if (diag) stack.push([x + 1, y + 1], [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1]);
    }
    for (const [x, y] of matches) ctx.set(x, y, col);
    return `filled ${matches.length} px`;
  },

  replace(ctx, a) {
    const from = ctx.color(a.from), to = ctx.color(a.to);
    const tol = a.tolerance ?? 0;
    const { x, y, w, h } = ctx.region(a);
    let n = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const c = ctx.get(xx, yy);
      if (c && colorsEqual(c, from, tol)) { ctx.put(xx, yy, to, 'mask'); n++; }
    }
    return `replaced ${n} px`;
  },

  gradient(ctx, a) {
    const colors = colorList(ctx, a);
    const { x, y, w, h } = ctx.region(a);
    const dir = a.direction || 'vertical';
    const dither = a.dither || 'bayer';
    const seed = int(a.seed ?? 1, 'seed');
    const n = colors.length;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let t;
      const u = w > 1 ? xx / (w - 1) : 0, v = h > 1 ? yy / (h - 1) : 0;
      if (dir === 'horizontal') t = u;
      else if (dir === 'vertical') t = v;
      else if (dir === 'diagonal') t = (u + v) / 2;
      else if (dir === 'diagonal-reverse') t = ((1 - u) + v) / 2;
      else if (dir === 'radial') {
        const dx = (xx + 0.5) / w - 0.5, dy = (yy + 0.5) / h - 0.5;
        t = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      } else throw new Error('direction must be vertical, horizontal, diagonal, diagonal-reverse or radial');
      const pos = t * (n - 1);
      let idx = Math.floor(pos);
      const frac = pos - idx;
      let thr = 0.5;
      if (dither === 'bayer') thr = (BAYER4[(y + yy) & 3][(x + xx) & 3] + 0.5) / 16;
      else if (dither === 'noise') thr = hash3(x + xx, y + yy, seed);
      else if (dither !== 'none') throw new Error('dither must be none, bayer or noise');
      if (frac > thr) idx++;
      ctx.set(x + xx, y + yy, colors[Math.min(n - 1, idx)]);
    }
  },

  noise(ctx, a) {
    const colors = colorList(ctx, a);
    const { x, y, w, h } = ctx.region(a);
    const seed = int(a.seed ?? 1, 'seed');
    const scale = Math.max(1, Number(a.scale ?? 1));
    const octaves = Math.max(1, Math.min(6, int(a.octaves ?? 1, 'octaves')));
    const weights = a.weights;
    if (weights && weights.length !== colors.length) throw new Error('"weights" must match "colors" length');
    const vals = new Float64Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let v;
      if (scale <= 1 && octaves === 1) v = hash3(x + xx, y + yy, seed);
      else {
        v = 0;
        let amp = 1, total = 0;
        for (let o = 0; o < octaves; o++) {
          const cells = Math.max(1, Math.round((w / scale) * 2 ** o));
          const cellsY = Math.max(1, Math.round((h / scale) * 2 ** o));
          v += amp * valueNoise((xx / w) * cells, (yy / h) * cellsY, cells, cellsY, seed + o * 7919);
          total += amp;
          amp *= 0.5;
        }
        v /= total;
      }
      vals[yy * w + xx] = v;
    }
    // rank-equalize so weights map to exact pixel proportions
    const order = [...vals.keys()].sort((i, j) => vals[i] - vals[j] || i - j);
    const ranks = new Float64Array(w * h);
    order.forEach((idx, r) => (ranks[idx] = (r + 0.5) / order.length));
    const pick = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) pick[i] = colors.indexOf(pickWeighted(colors, weights, ranks[i]));
    // despeckle: lone pixels (no same-colored 4-neighbour, wrapping) take the majority neighbour color
    const passes = a.despeckle === true ? 1 : Math.max(0, int(a.despeckle ?? 0, 'despeckle'));
    for (let p = 0; p < passes; p++) {
      const src = pick.slice();
      const at = (xx, yy) => src[((yy + h) % h) * w + ((xx + w) % w)];
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const me = src[yy * w + xx];
        const nb = [at(xx + 1, yy), at(xx - 1, yy), at(xx, yy + 1), at(xx, yy - 1)];
        if (nb.includes(me)) continue;
        const cnt = new Map();
        for (const c of nb) cnt.set(c, (cnt.get(c) || 0) + 1);
        pick[yy * w + xx] = [...cnt.entries()].sort((q, r) => r[1] - q[1] || q[0] - r[0])[0][0];
      }
    }
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) ctx.set(x + xx, y + yy, colors[pick[yy * w + xx]]);
  },

  scatter(ctx, a) {
    const colors = colorList(ctx, a);
    const { x, y, w, h } = ctx.region(a);
    const rnd = mulberry32(int(a.seed ?? 1, 'seed'));
    const size = Math.max(1, int(a.size ?? 1, 'size'));
    const count = a.count !== undefined ? int(a.count, 'count') : Math.round(w * h * Number(a.density ?? 0.1) / size);
    for (let i = 0; i < count; i++) {
      let px = x + Math.floor(rnd() * w), py = y + Math.floor(rnd() * h);
      const col = colors[Math.floor(rnd() * colors.length)];
      for (let k = 0; k < size; k++) {
        ctx.set(px, py, col);
        const dir = Math.floor(rnd() * 4);
        px += dir === 0 ? 1 : dir === 1 ? -1 : 0;
        py += dir === 2 ? 1 : dir === 3 ? -1 : 0;
        px = Math.max(x, Math.min(x + w - 1, px));
        py = Math.max(y, Math.min(y + h - 1, py));
      }
    }
    return `scattered ${count}`;
  },

  adjust(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const rnd = mulberry32(int(a.seed ?? 1, 'seed'));
    const jitter = Number(a.jitter ?? 0);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const c = ctx.get(xx, yy);
      if (!c || c[3] === 0) continue;
      const j = jitter ? (rnd() * 2 - 1) * jitter : 0;
      let nc = adjustColor(c, { hue: Number(a.hue ?? 0), saturation: Number(a.saturation ?? 0), lightness: Number(a.lightness ?? 0) + j });
      if (a.alpha !== undefined) nc[3] = Math.max(0, Math.min(255, Math.round(Number(a.alpha) * 255)));
      ctx.put(xx, yy, nc, 'mask');
    }
  },

  outline(ctx, a) {
    const col = ctx.color(a.color);
    const mode = a.mode || 'outer';
    if (!['outer', 'inner'].includes(mode)) throw new Error('outline mode must be "outer" or "inner"');
    const diag = !!a.diagonal;
    // shapes come from this layer, or from_layer (outline a part onto a separate layer)
    let src;
    if (a.from_layer !== undefined) {
      const L = ctx.doc.layers[ctx.doc.layerIndex(a.from_layer)].data;
      src = new Array(ctx.w * ctx.h);
      for (let y = 0; y < ctx.h; y++) for (let x = 0; x < ctx.w; x++) {
        const p = ((y + ctx.oy) * ctx.W + x) * 4;
        src[y * ctx.w + x] = [L[p], L[p + 1], L[p + 2], L[p + 3]];
      }
    } else src = ctx.copyLocal();
    // of: only pixels of these colors count as the shape (selective outline, e.g. just the hair)
    const of = a.of === undefined ? null : (Array.isArray(a.of) ? a.of : [a.of]).map((c) => ctx.color(c));
    const tol = Number(a.tolerance ?? 0);
    const solid = (c) => c[3] > 0 && (!of || of.some((o) => colorsEqual(c, o, tol)));
    const op = (x, y) => x >= 0 && y >= 0 && x < ctx.w && y < ctx.h && solid(src[y * ctx.w + x]);
    const nb = diag ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // region limits where outline pixels are written; the canvas mask (if any) is honoured
    const r = ctx.region(a);
    const putMode = ctx.mask || ctx.maskLayer ? 'mask' : 'force';
    let n = 0;
    for (let y = Math.max(0, r.y); y < Math.min(ctx.h, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(ctx.w, r.x + r.w); x++) {
      const me = op(x, y);
      let hit = false;
      if (mode === 'outer' && !me) hit = nb.some(([dx, dy]) => op(x + dx, y + dy)) && (!of || !src[y * ctx.w + x][3] || a.over_other !== false);
      if (mode === 'inner' && me) hit = nb.some(([dx, dy]) => !op(x + dx, y + dy));
      if (hit) { ctx.put(x, y, col, putMode); n++; }
    }
    return `outlined ${n} px`;
  },

  bevel(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const light = a.light !== undefined ? ctx.color(a.light) : null;
    const dark = a.dark !== undefined ? ctx.color(a.dark) : null;
    const s = Math.max(1, int(a.size ?? 1, 'size'));
    for (let k = 0; k < s; k++) {
      if (light) {
        for (let xx = x + k; xx < x + w - k; xx++) ctx.set(xx, y + k, light);
        for (let yy = y + k; yy < y + h - k; yy++) ctx.set(x + k, yy, light);
      }
      if (dark) {
        for (let xx = x + k; xx < x + w - k; xx++) ctx.set(xx, y + h - 1 - k, dark);
        for (let yy = y + k; yy < y + h - k; yy++) ctx.set(x + w - 1 - k, yy, dark);
      }
    }
  },

  flip(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const axis = a.axis || 'x';
    const src = ctx.copyLocal();
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const sx = axis === 'x' ? x + w - 1 - xx : x + xx;
      const sy = axis === 'y' ? y + h - 1 - yy : y + yy;
      const c = src[sy * ctx.w + sx];
      if (c) ctx.put(x + xx, y + yy, c, 'force');
    }
  },

  rotate(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    if (a.angle !== undefined) {
      // any angle, RotSprite-style (no new colors); pivot cx,cy in canvas/frame coords
      const deg = Number(a.angle);
      if (!Number.isFinite(deg)) throw new Error('"angle" must be a number (degrees, clockwise)');
      const block = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const c = ctx.get(x + xx, y + yy);
        if (c) block.set(c, (yy * w + xx) * 4);
      }
      const cx = a.cx !== undefined ? Number(a.cx) - x : w / 2, cy = a.cy !== undefined ? Number(a.cy) - y : h / 2;
      const out = rotsprite(block, w, h, deg, cx, cy);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = (yy * w + xx) * 4;
        ctx.put(x + xx, y + yy, [out[p], out[p + 1], out[p + 2], out[p + 3]], 'mask');
      }
      return `rotated ${deg}° (pixels leaving the ${w}x${h} region are cut: give it margin)`;
    }
    const turns = ((int(a.turns ?? 1, 'turns') % 4) + 4) % 4;
    if (turns % 2 === 1 && w !== h) throw new Error('90° rotation needs a square region');
    const src = ctx.copyLocal();
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let sx, sy; // destination (xx,yy) pulls from source
      if (turns === 0) [sx, sy] = [xx, yy];
      else if (turns === 1) [sx, sy] = [yy, w - 1 - xx];
      else if (turns === 2) [sx, sy] = [w - 1 - xx, h - 1 - yy];
      else [sx, sy] = [h - 1 - yy, xx];
      const c = src[(y + sy) * ctx.w + x + sx];
      if (c) ctx.put(x + xx, y + yy, c, 'force');
    }
  },

  shift(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const dx = int(a.dx ?? 0, 'dx'), dy = int(a.dy ?? 0, 'dy');
    const wrap = a.wrap !== false;
    const src = ctx.copyLocal();
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let sx = xx - dx, sy = yy - dy;
      if (wrap) { sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h; }
      const c = sx >= 0 && sy >= 0 && sx < w && sy < h ? src[(y + sy) * ctx.w + x + sx] : [0, 0, 0, 0];
      if (c) ctx.put(x + xx, y + yy, c, 'force');
    }
  },

  mirror(ctx, a) {
    const axis = a.axis || 'x';
    const source = a.source || (axis === 'x' ? 'left' : 'top');
    const src = ctx.copyLocal();
    for (let y = 0; y < ctx.h; y++) for (let x = 0; x < ctx.w; x++) {
      if (axis === 'x') {
        const half = x < ctx.w / 2 ? 'left' : 'right';
        if (half === source) continue;
        if (ctx.w % 2 === 1 && x === (ctx.w - 1) / 2) continue;
        ctx.put(x, y, src[y * ctx.w + (ctx.w - 1 - x)], 'force');
      } else {
        const half = y < ctx.h / 2 ? 'top' : 'bottom';
        if (half === source) continue;
        if (ctx.h % 2 === 1 && y === (ctx.h - 1) / 2) continue;
        ctx.put(x, y, src[(ctx.h - 1 - y) * ctx.w + x], 'force');
      }
    }
  },

  copy(ctx, a) {
    // read source: another canvas/layer/frame, or this layer
    let srcDoc = ctx.doc;
    if (a.from_canvas) {
      if (!ctx.resolveDoc) throw new Error('cross-canvas copy unavailable');
      srcDoc = ctx.resolveDoc(a.from_canvas);
    }
    const srcLayer = a.from_layer !== undefined ? srcDoc.layerIndex(a.from_layer) : srcDoc === ctx.doc ? ctx.layerIdx : null;
    const srcData = srcLayer === null ? srcDoc.composite() : srcDoc.layers[srcLayer].data;
    const soy = a.from_frame !== undefined && srcDoc.frameHeight ? int(a.from_frame, 'from_frame') * srcDoc.frameHeight : srcDoc === ctx.doc ? ctx.oy : 0;
    const sx0 = int(a.x ?? 0, 'x'), sy0 = int(a.y ?? 0, 'y');
    const w = a.w === undefined ? srcDoc.width - sx0 : int(a.w, 'w');
    const h = a.h === undefined ? (srcDoc.frameHeight || srcDoc.height) - sy0 : int(a.h, 'h');
    const tx = int(a.to_x ?? sx0, 'to_x'), ty = int(a.to_y ?? sy0, 'to_y');
    const buf = [];
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const gx = sx0 + xx, gy = sy0 + yy + soy;
      if (gx < 0 || gy < 0 || gx >= srcDoc.width || gy >= srcDoc.height) { buf.push(null); continue; }
      const p = (gy * srcDoc.width + gx) * 4;
      buf.push([srcData[p], srcData[p + 1], srcData[p + 2], srcData[p + 3]]);
    }
    const skipT = a.skip_transparent !== false;
    const sx = Number(a.scale_x ?? a.scale ?? (a.to_w ? a.to_w / w : 1));
    const sy = Number(a.scale_y ?? a.scale ?? (a.to_h ? a.to_h / h : sx));
    if (!(sx > 0 && sy > 0)) throw new Error('scale must be > 0');
    const dw = Math.max(1, Math.round(w * sx)), dh = Math.max(1, Math.round(h * sy));
    const tint = a.tint !== undefined ? ctx.color(a.tint) : null;
    const opacity = a.opacity !== undefined ? Math.max(0, Math.min(1, Number(a.opacity))) : 1;
    const adj = a.lightness || a.saturation || a.hue ? { hue: Number(a.hue || 0), saturation: Number(a.saturation || 0), lightness: Number(a.lightness || 0) } : null;
    const blend = ctx.blend;
    if (opacity < 1) ctx.blend = 'over';
    for (let yy = 0; yy < dh; yy++) for (let xx = 0; xx < dw; xx++) {
      const ux = Math.min(w - 1, Math.floor(xx / sx)), uy = Math.min(h - 1, Math.floor(yy / sy));
      const bx = a.flip_x ? w - 1 - ux : ux, by = a.flip_y ? h - 1 - uy : uy;
      let c = buf[by * w + bx];
      if (!c || (skipT && c[3] === 0)) continue;
      if (adj) c = adjustColor(c, adj);
      if (tint) c = [(c[0] * tint[0]) / 255, (c[1] * tint[1]) / 255, (c[2] * tint[2]) / 255, c[3]].map(Math.round);
      if (opacity < 1) c = [c[0], c[1], c[2], Math.round(c[3] * opacity)];
      ctx.set(tx + xx, ty + yy, c);
    }
    ctx.blend = blend;
  },

  clear(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) ctx.put(xx, yy, [0, 0, 0, 0], 'mask');
  },
};

Object.assign(COMMANDS, EFFECTS, ISO, SHADING);
export const COMMAND_NAMES = Object.keys(COMMANDS);

// Known fields per command, read from each command's own source, so typos / invented options
// get reported instead of silently ignored (weak models do this a lot).
const COMMON_FIELDS = ['op', 'layer', 'frame', 'mask', 'blend', 'symmetry', 'comment', 'note', 'label'];
const fieldCache = new Map();
export function knownFields(op) {
  if (fieldCache.has(op)) return fieldCache.get(op);
  const src = String(COMMANDS[op]);
  const set = new Set([...COMMON_FIELDS, ...[...src.matchAll(/(?<![\w$.])a\.(\w+)/g)].map((m) => m[1])]);
  if (/region\(a\)|regionOf\(ctx, a\)/.test(src)) for (const f of ['x', 'y', 'w', 'h', 'rx', 'ry', 'rw', 'rh', 'region']) set.add(f);
  // options read by strokePath when a command passes its args through (line, curve): width, brush,
  // pixel_perfect were reported as "ignored" although they work
  if (/strokePath\([^)]*\ba\s*\}?\)|strokePath\([^)]*\.\.\.a\b/.test(src)) for (const f of ['width', 'brush', 'pixel_perfect']) set.add(f);
  if (/colorList\(/.test(src)) { set.add('colors'); set.add('color'); }
  if (/rampOf\(/.test(src)) { set.add('colors'); set.add('ramp'); }
  if (/drawBox\(/.test(src)) for (const f of ISO_FIELDS) set.add(f);
  fieldCache.set(op, set);
  return set;
}

/** Composite layers (with visibility, opacity and blend modes) into a new RGBA buffer. */
export function compositeLayers(layers, length) {
  const out = new Uint8ClampedArray(length);
  for (const l of layers) {
    if (!l.visible) continue;
    const d = l.data, mode = l.blend || 'normal', op = l.opacity ?? 1;
    for (let p = 0; p < length; p += 4) {
      const sa = d[p + 3];
      if (!sa) continue;
      if (mode === 'normal' || out[p + 3] === 0) {
        if (mode !== 'normal' && out[p + 3] === 0) continue; // blend layers only affect what is below
        if (sa === 255 && op >= 1) { out[p] = d[p]; out[p + 1] = d[p + 1]; out[p + 2] = d[p + 2]; out[p + 3] = 255; continue; }
        const c = blendOver([out[p], out[p + 1], out[p + 2], out[p + 3]], [d[p], d[p + 1], d[p + 2], sa], op);
        out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = c[3];
        continue;
      }
      const a = (sa / 255) * op;
      for (let k = 0; k < 3; k++) out[p + k] = out[p + k] * (1 - a) + blendChannel(mode, out[p + k], d[p + k]) * a;
    }
  }
  return out;
}

/** Overlay guides on a rendered image: "grid:16", "iso:32" (2:1 diamonds), "center". */
function drawGuide(out, W, H, scale, guide) {
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    out.set(blendOver([out[o], out[o + 1], out[o + 2], out[o + 3] || 255], c), o);
  };
  const col = [0, 230, 255, 120];
  for (const g of String(guide).split(',')) {
    const [kind, arg] = g.trim().split(':');
    const n = Math.max(2, Number(arg) || 16);
    if (kind === 'grid') {
      for (let x = 0; x < W; x += n * scale) for (let y = 0; y < H; y++) put(x, y, col);
      for (let y = 0; y < H; y += n * scale) for (let x = 0; x < W; x++) put(x, y, col);
    } else if (kind === 'iso') {
      // lines with slope 1/2 in both directions; tile width n px => tile height n/2
      const th = n / 2;
      for (let ox = 0; ox < W; ox++) for (let oy = 0; oy < H; oy++) {
        const x = ox / scale, y = oy / scale;
        const u = (x / 2 + y) / th, v = (y - x / 2) / th;
        const du = Math.abs(u - Math.round(u)) * th, dv = Math.abs(v - Math.round(v)) * th;
        if (du < 0.5 / scale * 1.5 || dv < 0.5 / scale * 1.5) put(ox, oy, col);
      }
    } else if (kind === 'center') {
      for (let y = 0; y < H; y++) put(Math.floor(W / 2), y, [255, 0, 200, 120]);
      for (let x = 0; x < W; x++) put(x, Math.floor(H / 2), [255, 0, 200, 120]);
    }
  }
}
export { hslToRgb, rgbToHsl };
