// Shared helpers for the Agent Art web UI.
export const $ = (id) => document.getElementById(id);
export const enc = encodeURIComponent;

/** el('div.cls#id', {attrs, on:{click}}, ...children) */
export function el(spec, props = {}, ...kids) {
  const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) node.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return node;
}

let toastFn = null;
export const onToast = (fn) => (toastFn = fn);
export const toast = (text, kind = 'info') => toastFn?.(text, kind);

/** The per-process UI token the server embeds in the page: it lets the server trust source "user". */
const uiToken = () => document.querySelector('meta[name="agent-art-ui-token"]')?.content || '';
/** POST an engine op as the user (goes through the same API as the agent). */
export async function api(op, args) {
  const r = await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-art-ui': uiToken() }, body: JSON.stringify({ op, args, source: 'user' }) });
  const j = await r.json();
  if (!j.ok) { toast(`${op}: ${j.error}`, 'error'); throw new Error(j.error); }
  return j.result;
}
export async function getJSON(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}
export async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
export async function loadBitmap(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return createImageBitmap(await r.blob());
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(k, d) { try { const v = localStorage.getItem('agent-art:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('agent-art:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const fmtMs = (ms) => (ms === undefined || ms === null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Asset ids shared by the browser, timeline, graph and UI state: "canvas:name", "model:name", ... */
export const assetId = (kind, name) => `${kind}:${name}`;
export const splitId = (id) => { const i = id.indexOf(':'); return i < 0 ? ['canvas', id] : [id.slice(0, i), id.slice(i + 1)]; };

/** Thumbnail URL for an asset (cacheable, version keyed). */
export function thumbURL(kind, name, version) {
  if (kind === 'canvas') return `/api/canvas/${enc(name)}/png?v=${enc(version ?? '0')}`;
  if (kind === 'model') return `/api/model/${enc(name)}/thumb.png?v=${enc(version ?? '0')}`;
  if (kind === 'rig') return `/api/canvas/${enc(name + '_parts')}/png?v=${enc(version ?? '0')}`;
  return null;
}

export const KIND_ICON = { canvas: '▦', layer: '≡', anim: '▶', frame: '▫', rig: '☍', rigpart: '◌', model: '◆', modelpart: '◇', palette: '◍', audio: '♪', export: '⤓', project: '▣', group: '◎', file: '▤', graph: '⬡' };
export const KIND_COLOR = { canvas: '#38bdf8', layer: '#64748b', anim: '#a78bfa', frame: '#64748b', rig: '#f472b6', rigpart: '#f9a8d4', model: '#f5a524', modelpart: '#fcd34d', palette: '#22c55e', audio: '#2dd4bf', export: '#94a3b8', project: '#e5484d', group: '#c084fc', file: '#94a3b8', graph: '#c084fc' };

/** Checkerboard behind transparent pixels. */
export function checker(ctx, x, y, w, h, cell = 8) {
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2c2f35';
  const x0 = Math.floor(x / cell), y0 = Math.floor(y / cell);
  for (let j = y0; j * cell < y + h; j++) for (let i = x0 + ((x0 + j) & 1); i * cell < x + w; i += 2) {
    const px = Math.max(x, i * cell), py = Math.max(y, j * cell);
    ctx.fillRect(px, py, Math.min(x + w, i * cell + cell) - px, Math.min(y + h, j * cell + cell) - py);
  }
}

/** Animation frames + durations of a tag (direction expanded), or all frames at fps. */
export function playList(info, tag, fps = 10) {
  const t = tag && info?.animations?.[tag];
  if (t) {
    let frames = [...t.frames], durations = [...t.durations];
    if (t.direction === 'reverse') { frames.reverse(); durations.reverse(); }
    if (t.direction === 'pingpong' && frames.length > 2) {
      frames = frames.concat(frames.slice(1, -1).reverse());
      durations = durations.concat(durations.slice(1, -1).reverse());
    }
    return { frames, durations, loop: t.loop !== false };
  }
  const n = info?.frames || 1;
  return { frames: [...Array(n).keys()], durations: Array(n).fill(1000 / fps), loop: true };
}
