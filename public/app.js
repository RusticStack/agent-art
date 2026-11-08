// Agent Art web UI: live view of the agent's canvases + simple paint tools for the user.
const $ = (id) => document.getElementById(id);
const view = $('view'), overlay = $('overlay');
const vctx = view.getContext('2d'), octx = overlay.getContext('2d');

const state = {
  name: null,
  info: null,
  bitmap: null,
  pixels: null, // ImageData of composite
  zoom: 16,
  autoFit: true,
  tool: 'pencil',
  stroke: null,
  flash: null,
  lastAgent: 0,
  frame: 0,
  canvases: [],
  projects: [],
  mode: 'canvas', // 'canvas' | 'overview'
  project: null,
  projectInfo: null,
  ovTiles: new Map(),
  booted: false,
  strip: null, // full frame-strip bitmap (previews, timeline)
  curFrame: 0,
  playIdx: 0,
};
const frameViewActive = () => $('frameView').checked && (state.info?.frames || 1) > 1;

// ---------- API ----------
async function api(op, args) {
  const r = await fetch('/api/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args, source: 'user' }),
  });
  const j = await r.json();
  if (!j.ok) {
    toastLog(`error: ${j.error}`);
    throw new Error(j.error);
  }
  return j.result;
}
const enc = encodeURIComponent;

// ---------- canvas list (grouped by project) ----------
function canvasItem(c, child) {
  const li = document.createElement('li');
  li.dataset.name = c.name;
  if (child) li.classList.add('child');
  if (c.name === state.name && state.mode === 'canvas') li.classList.add('active');
  li.innerHTML = `<img alt=""><div style="min-width:0"><div class="name"></div><div class="meta"></div></div>`;
  li.querySelector('img').src = `/api/canvas/${enc(c.name)}/png?v=${c.version}`;
  li.querySelector('.name').textContent = c.name;
  const size = `${c.width}×${c.frames > 1 ? c.height / c.frames : c.height}`;
  li.querySelector('.meta').textContent = c.texture ? `${size} · ${c.texture}` : `${size}${c.frames > 1 ? ` · ${c.frames} frames` : ''} · ${c.layers} layer${c.layers > 1 ? 's' : ''}`;
  li.onclick = () => openCanvas(c.name);
  return li;
}

async function refreshList() {
  const j = await (await fetch('/api/canvases')).json();
  state.canvases = j.canvases;
  state.projects = j.projects || [];
  const ul = $('canvasList');
  ul.innerHTML = '';
  $('emptyHint').hidden = j.canvases.length > 0 || state.projects.length > 0;
  const groups = new Map(state.projects.map((p) => [p.name, []]));
  const loose = [];
  for (const c of j.canvases) (c.project && groups.has(c.project) ? groups.get(c.project) : loose).push(c);
  for (const [pname, items] of groups) {
    const head = document.createElement('li');
    head.className = 'proj' + (state.mode === 'overview' && state.project === pname ? ' active' : '');
    head.innerHTML = `<span>▦</span><span class="pn"></span><span class="count"></span>`;
    head.querySelector('.pn').textContent = pname;
    head.querySelector('.count').textContent = items.length;
    head.title = 'Open project overview';
    head.onclick = () => openProject(pname);
    ul.appendChild(head);
    if (pname !== state.project) continue; // only expand the current project
    const MAX = 40;
    items.slice(0, MAX).forEach((c) => ul.appendChild(canvasItem(c, true)));
    if (items.length > MAX) {
      const more = document.createElement('li');
      more.className = 'more';
      more.textContent = `+${items.length - MAX} more — open overview`;
      more.onclick = () => openProject(pname);
      ul.appendChild(more);
    }
  }
  if (loose.length && groups.size) {
    const head = document.createElement('li');
    head.className = 'proj';
    head.textContent = 'Other canvases';
    ul.appendChild(head);
  }
  loose.forEach((c) => ul.appendChild(canvasItem(c, false)));

  if (!state.booted) {
    state.booted = true;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('project:') && groups.has(h.slice(8))) openProject(h.slice(8));
    else if (j.canvases.some((c) => c.name === h)) openCanvas(h);
    else if (j.canvases.length) openCanvas(j.canvases[0].name);
  }
  if (state.mode === 'canvas' && state.name && !j.canvases.some((c) => c.name === state.name)) {
    state.name = null;
    state.info = null;
    showEmpty(true);
  }
}
let listTimer;
const refreshListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(refreshList, 300); };

// ---------- open / load ----------
async function openCanvas(name) {
  if (state.name !== name) state.autoFit = true;
  state.name = name;
  state.mode = 'canvas';
  $('overview').hidden = true;
  history.replaceState(null, '', `#${enc(name)}`);
  if (state.name !== state.lastOpened) { state.curFrame = 0; state.lastOpened = name; }
  await loadInfo();
  await loadImage();
  showEmpty(false);
  const proj = state.info?.project || null;
  const changedProject = proj !== state.project;
  state.project = proj;
  $('overviewBtn').hidden = !proj;
  if (changedProject) loadProjectPanel();
  refreshListSoon();
}
function showEmpty(empty) {
  $('stageEmpty').hidden = !empty;
  $('canvasHolder').hidden = empty;
}

// ---------- project overview ----------
async function openProject(name) {
  state.mode = 'overview';
  state.project = name;
  state.ovTiles = new Map();
  history.replaceState(null, '', `#project:${enc(name)}`);
  $('canvasHolder').hidden = true;
  $('stageEmpty').hidden = true;
  $('overview').hidden = false;
  $('timeline').hidden = true;
  $('overviewBtn').hidden = false;
  $('ovGrid').innerHTML = '';
  await loadProjectPanel();
  refreshList();
}

async function loadProjectPanel() {
  if (!state.project) { $('projectPanel').hidden = true; return; }
  const r = await fetch(`/api/project/${enc(state.project)}`);
  if (!r.ok) { $('projectPanel').hidden = true; return; }
  const p = await r.json();
  state.projectInfo = p;
  $('projectPanel').hidden = false;
  $('projName').textContent = p.name;
  $('projNotes').textContent = [p.description, p.notes].filter(Boolean).join('\n\n') || 'No notes yet.';
  if (state.mode !== 'overview') return;
  $('ovTitle').textContent = p.name;
  const fmt = p.meta?.minecraft ? ` · Minecraft ${p.meta.minecraft}` : '';
  $('ovDesc').textContent = `${p.canvases.length} canvases${fmt}${p.description ? ' — ' + p.description : ''}`;
  $('canvasMeta').textContent = `project ${p.name} · ${p.canvases.length} canvases`;
  // project palette in the side panel
  const pal = $('palette');
  pal.innerHTML = '';
  for (const [k, v] of Object.entries(p.palette || {})) pal.appendChild(swatch(v, `${k}  ${v}`, k));
  $('usedColors').innerHTML = '';
  $('layers').innerHTML = '';
  const listed = new Map(state.canvases.map((c) => [c.name, c]));
  for (const c of p.canvases) ovTile(c.name, listed.get(c.name)?.version ?? 0, c.meta?.texture, false);
}

function ovTile(name, version, texture, isNew) {
  let el = state.ovTiles.get(name);
  if (!el) {
    el = document.createElement('div');
    el.className = 'ov-tile' + (isNew ? ' new' : '');
    el.innerHTML = `<img alt=""><span class="n"></span><span class="t"></span>`;
    el.querySelector('.n').textContent = name;
    el.title = name;
    el.onclick = () => openCanvas(name);
    $('ovGrid').appendChild(el);
    state.ovTiles.set(name, el);
  }
  if (texture !== undefined) el.querySelector('.t').textContent = Array.isArray(texture) ? texture.join(', ') : texture || '';
  el.querySelector('img').src = `/api/canvas/${enc(name)}/png?v=${version}`;
  return el;
}
$('ovSize').oninput = () => $('ovGrid').style.setProperty('--ov', $('ovSize').value + 'px');
$('overviewBtn').onclick = () => state.project && openProject(state.project);

async function loadInfo() {
  if (!state.name) return;
  const r = await fetch(`/api/canvas/${enc(state.name)}`);
  if (!r.ok) return;
  state.info = await r.json();
  renderSide();
}

let imgBusy = false, imgPending = false;
async function loadImage() {
  if (!state.name) return;
  if (imgBusy) { imgPending = true; return; }
  imgBusy = true;
  try {
    const name = state.name;
    const get = async (q) => createImageBitmap(await (await fetch(`/api/canvas/${enc(name)}/png?t=${Date.now()}${q}`)).blob());
    const strip = await get('');
    let bmp = strip;
    if (frameViewActive()) {
      state.curFrame = Math.min(state.curFrame, state.info.frames - 1);
      bmp = await get(`&frame=${state.curFrame}${$('onion').checked ? '&onion=1' : ''}`);
    }
    if (name !== state.name) return;
    state.strip = strip;
    state.bitmap = bmp;
    renderTimeline();
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    state.pixels = cx.getImageData(0, 0, bmp.width, bmp.height);
    if (state.autoFit) fitZoom();
    render();
  } finally {
    imgBusy = false;
    if (imgPending) { imgPending = false; loadImage(); }
  }
}

// ---------- rendering ----------
const tiles = () => ($('tileToggle').checked ? 3 : 1);

function fitZoom() {
  if (!state.bitmap) return;
  const st = $('stage');
  const t = tiles();
  const z = Math.floor(Math.min((st.clientWidth - 48) / (state.bitmap.width * t), (st.clientHeight - 48) / (state.bitmap.height * t)));
  state.zoom = Math.max(1, Math.min(64, z));
}

function render() {
  const b = state.bitmap;
  if (!b) return;
  const z = state.zoom, t = tiles();
  const W = b.width * z * t, H = b.height * z * t;
  for (const c of [view, overlay]) {
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  }
  $('canvasHolder').style.width = W + 'px';
  $('canvasHolder').style.height = H + 'px';
  // center when smaller than the stage
  const st = $('stage');
  $('canvasHolder').style.left = Math.max(0, (st.clientWidth - W - 48) / 2) + 'px';
  $('canvasHolder').style.top = Math.max(0, (st.clientHeight - H - 48) / 2) + 'px';
  $('zoomLabel').textContent = `${z}×`;

  // checkerboard
  const cell = Math.max(4, Math.min(16, z / 2));
  vctx.fillStyle = '#c8c8c8';
  vctx.fillRect(0, 0, W, H);
  vctx.fillStyle = '#9a9a9a';
  for (let y = 0; y < H; y += cell) for (let x = (Math.floor(y / cell) % 2) * cell; x < W; x += cell * 2) vctx.fillRect(x, y, cell, cell);

  vctx.imageSmoothingEnabled = false;
  for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) vctx.drawImage(b, tx * b.width * z, ty * b.height * z, b.width * z, b.height * z);

  if ($('gridToggle').checked && z >= 6) {
    const pw = b.width * t, ph = b.height * t;
    for (let i = 0; i <= pw; i++) {
      vctx.fillStyle = i % 4 === 0 ? 'rgba(0,0,0,.32)' : 'rgba(0,0,0,.12)';
      vctx.fillRect(i * z, 0, 1, H);
    }
    for (let i = 0; i <= ph; i++) {
      vctx.fillStyle = i % 4 === 0 ? 'rgba(0,0,0,.32)' : 'rgba(0,0,0,.12)';
      vctx.fillRect(0, i * z, W, 1);
    }
  }
  const fh = frameViewActive() ? null : state.info?.frameHeight;
  if (fh) {
    vctx.fillStyle = 'rgba(245,165,36,.8)';
    for (let ty = 0; ty < t; ty++) for (let f = 1; f < b.height / fh; f++) vctx.fillRect(0, (ty * b.height + f * fh) * z - 1, W, 2);
  }
  if (t > 1) {
    vctx.strokeStyle = 'rgba(245,165,36,.9)';
    vctx.lineWidth = 2;
    vctx.strokeRect(b.width * z + 1, b.height * z + 1, b.width * z - 2, b.height * z - 2);
  }
  drawOverlay();
  renderPreviews();
}

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const z = state.zoom, b = state.bitmap;
  if (!b) return;
  const t = tiles();
  // live stroke preview
  const s = state.stroke;
  if (s) {
    octx.fillStyle = s.erase ? 'rgba(255,255,255,.6)' : s.color;
    for (const [x, y] of s.preview()) {
      for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) octx.fillRect((x + tx * b.width) * z, (y + ty * b.height) * z, z, z);
    }
  }
  // agent change highlight
  const f = state.flash;
  if (f) {
    const age = (performance.now() - f.t) / 1200;
    if (age < 1) {
      octx.strokeStyle = `rgba(56,189,248,${1 - age})`;
      octx.lineWidth = 2;
      const ox = t > 1 ? b.width * z : 0, oy = t > 1 ? b.height * z : 0;
      octx.strokeRect(ox + f.x * z - 1, oy + f.y * z - 1, f.w * z + 2, f.h * z + 2);
      requestAnimationFrame(drawOverlay);
    } else state.flash = null;
  }
}

// ---------- previews (actual size + animated) ----------
const p1 = $('preview1'), p2 = $('preview2');
function renderPreviews() {
  const b = state.strip || state.bitmap;
  if (!b) return;
  const fh = state.info?.frameHeight || b.height;
  const frames = Math.max(1, Math.floor(b.height / fh));
  $('fpsWrap').hidden = frames <= 1 || !!$('animSelect').value;
  const f = state.frame % frames;
  const big = Math.max(1, Math.floor(128 / Math.max(b.width, fh)));
  const small = Math.max(1, Math.floor(big / 4));
  for (const [c, s] of [[p1, small], [p2, big]]) {
    c.width = b.width * s;
    c.height = fh * s;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, c.width, c.height);
    cx.drawImage(b, 0, f * fh, b.width, fh, 0, 0, c.width, c.height);
  }
}
/** Frames + durations to preview: the selected animation tag, or every frame at the fps slider. */
function playList() {
  const info = state.info;
  const sel = $('animSelect').value;
  const t = sel && info?.animations?.[sel];
  if (t) {
    let frames = [...t.frames], durations = [...t.durations];
    if (t.direction === 'reverse') { frames.reverse(); durations.reverse(); }
    if (t.direction === 'pingpong' && frames.length > 2) {
      frames = frames.concat(frames.slice(1, -1).reverse());
      durations = durations.concat(durations.slice(1, -1).reverse());
    }
    return { frames, durations };
  }
  const n = info?.frames || 1;
  return { frames: [...Array(n).keys()], durations: Array(n).fill(1000 / Number($('fps').value)) };
}
let animTimer = null;
function restartAnim() {
  clearTimeout(animTimer);
  const tick = () => {
    const pl = playList();
    if (state.info?.frameHeight && pl.frames.length) {
      state.playIdx = (state.playIdx + 1) % pl.frames.length;
      state.frame = pl.frames[state.playIdx];
      renderPreviews();
    }
    animTimer = setTimeout(tick, pl.durations[state.playIdx] || 100);
  };
  tick();
}
$('fps').oninput = restartAnim;
$('animSelect').onchange = () => { state.playIdx = 0; updateGifLink(); restartAnim(); renderTimeline(); };
$('frameView').onchange = () => { state.autoFit = true; loadImage(); };
$('onion').onchange = () => loadImage();

function updateGifLink() {
  if (!state.info) return;
  const sel = $('animSelect').value;
  $('gifBtn').href = `/api/canvas/${enc(state.info.name)}/anim.gif?scale=4&download=1${sel ? '&animation=' + enc(sel) : ''}`;
}

function setFrame(i) {
  if (i === state.curFrame) return;
  state.curFrame = i;
  if (frameViewActive()) loadImage();
  else renderTimeline();
}

/** Frame thumbnails under the stage. */
function renderTimeline() {
  const info = state.info;
  const tl = $('timeline');
  const n = info?.frames || 1;
  const tags = Object.keys(info?.animations || {});
  tl.hidden = state.mode !== 'canvas' || (n <= 1 && !tags.length);
  if (tl.hidden || !state.strip) return;
  // animation select
  const sel = $('animSelect');
  const cur = sel.value;
  const want = ['', ...tags].join('|');
  if (sel.dataset.opts !== want) {
    sel.innerHTML = '<option value="">all frames</option>' + tags.map((t) => `<option></option>`).join('');
    tags.forEach((t, i) => { sel.options[i + 1].value = t; sel.options[i + 1].textContent = t; });
    sel.value = tags.includes(cur) ? cur : '';
    sel.dataset.opts = want;
  }
  updateGifLink();
  const tagged = new Set(sel.value ? info.animations[sel.value].frames : []);
  const fh = info.frameHeight || state.strip.height, w = state.strip.width;
  const s = Math.max(1, Math.floor(44 / Math.max(w, fh)));
  const box = $('frames');
  if (box.children.length !== n) {
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'frame-thumb';
      el.innerHTML = `<canvas></canvas><span>${i}</span>`;
      el.onclick = () => setFrame(i);
      box.appendChild(el);
    }
  }
  [...box.children].forEach((el, i) => {
    const c = el.querySelector('canvas');
    const dw = Math.max(1, Math.round(w * s * Math.min(1, 44 / (w * s)))), dh = Math.max(1, Math.round(fh * s * Math.min(1, 44 / (fh * s))));
    c.width = dw; c.height = dh;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(state.strip, 0, i * fh, w, fh, 0, 0, dw, dh);
    el.classList.toggle('active', i === state.curFrame);
    el.classList.toggle('tagged', tagged.has(i));
  });
  $('frameLabel').textContent = frameViewActive() ? `frame ${state.curFrame} / ${n - 1}` : `${n} frames`;
}

// ---------- side panels ----------
function renderSide() {
  const info = state.info;
  if (!info) return;
  const fh = info.frameHeight;
  $('canvasMeta').textContent = `${info.name} · ${info.width}×${fh || info.height}${info.frames > 1 ? ` × ${info.frames} frames` : ''} · ${info.colors?.unique ?? 0} colors · undo ${info.undo}`;
  $('exportBtn').href = `/api/canvas/${enc(info.name)}/png?download=1`;
  $('exportBtn').setAttribute('download', `${info.name}.png`);

  const pal = $('palette');
  pal.innerHTML = '';
  for (const [k, v] of Object.entries({ ...(info.inheritedPalette || {}), ...(info.palette || {}) })) pal.appendChild(swatch(v, `${k}  ${v}`, k));
  const used = $('usedColors');
  used.innerHTML = '';
  for (const { color, count } of info.colors?.top || []) used.appendChild(swatch(color, `${color} · ${count} px`));

  const ul = $('layers');
  ul.innerHTML = '';
  for (const l of info.layers) {
    const li = document.createElement('li');
    li.className = (l.index === info.activeLayer ? 'active ' : '') + (l.visible ? '' : 'hidden');
    li.innerHTML = `<button class="eye" title="Toggle visibility">${l.visible ? '◉' : '○'}</button><span class="lname"></span><select class="lblend" title="Blend mode">${['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten', 'soft-light'].map((m) => `<option${m === (l.blend || 'normal') ? ' selected' : ''}>${m}</option>`).join('')}</select>`;
    li.querySelector('.lblend').onclick = (e) => e.stopPropagation();
    li.querySelector('.lblend').onchange = (e) => api('layer', { canvas: info.name, action: 'blend', layer: l.index, blend: e.target.value });
    li.querySelector('.lname').textContent = l.name + (l.opacity < 1 ? ` (${Math.round(l.opacity * 100)}%)` : '');
    li.querySelector('.eye').onclick = (e) => { e.stopPropagation(); api('layer', { canvas: info.name, action: 'visibility', layer: l.index }); };
    li.onclick = () => api('layer', { canvas: info.name, action: 'select', layer: l.index });
    ul.appendChild(li);
  }
}
function swatch(color, title, key) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.setProperty('--c', color);
  b.title = title;
  if (key && [...key].length <= 2) b.innerHTML = `<span class="k"></span>`, (b.querySelector('.k').textContent = key);
  b.onclick = () => setColor(color);
  return b;
}
function setColor(hex) {
  $('color').value = hex.slice(0, 7);
  $('alpha').value = hex.length === 9 ? parseInt(hex.slice(7), 16) : 255;
  if (state.tool === 'eraser' || state.tool === 'picker') setTool('pencil');
}
const currentColor = () => $('color').value + Number($('alpha').value).toString(16).padStart(2, '0');

// ---------- activity log ----------
function logEntry(ev) {
  const li = document.createElement('li');
  const src = ev.source || 'agent';
  li.innerHTML = `<span class="src ${src}"></span><span class="what"></span><span class="when"></span>`;
  li.querySelector('.src').textContent = src;
  const what = ev.type === 'deleted' ? `${ev.canvas}: deleted` : `${ev.canvas}: ${ev.label || ev.op}`;
  li.querySelector('.what').textContent = what;
  li.querySelector('.when').textContent = new Date(ev.ts).toLocaleTimeString();
  li.querySelector('.what').style.cursor = 'pointer';
  li.querySelector('.what').onclick = () => ev.type !== 'deleted' && openCanvas(ev.canvas);
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 200) log.lastChild.remove();
}
function toastLog(text) {
  logEntry({ type: 'note', canvas: 'ui', label: text, source: 'user', ts: Date.now() });
}

// ---------- live events ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setStatus();
  es.onerror = () => { $('status').className = 'status down'; $('statusText').textContent = 'disconnected — retrying'; };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'hello') return setStatus();
    if (ev.type === 'project') {
      logEntry({ ...ev, canvas: ev.project });
      refreshListSoon();
      if (ev.project === state.project) loadProjectPanel();
      return;
    }
    if (ev.type === 'change' || ev.type === 'deleted') {
      logEntry(ev);
      refreshListSoon();
      const follow = $('followMode').value;
      if (ev.source === 'agent') {
        state.lastAgent = Date.now();
        setStatus();
        const li = document.querySelector(`#canvasList li[data-name="${CSS.escape(ev.canvas)}"]`);
        if (li) { li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 800); }
      }
      if (ev.type === 'deleted') {
        const t = state.ovTiles?.get(ev.canvas);
        if (t) { t.remove(); state.ovTiles.delete(ev.canvas); }
        return;
      }
      const agent = ev.source === 'agent';
      if (agent && follow === 'project' && ev.project && (state.mode !== 'overview' || state.project !== ev.project)) {
        openProject(ev.project);
        return;
      }
      if (agent && follow === 'canvas' && (state.mode !== 'canvas' || ev.canvas !== state.name)) {
        openCanvas(ev.canvas);
        return;
      }
      if (state.mode === 'overview' && ev.project === state.project) {
        const isNew = !state.ovTiles.has(ev.canvas);
        const el = ovTile(ev.canvas, ev.version, undefined, isNew);
        if (agent) {
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 900);
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (isNew || ev.op === 'meta') loadProjectPanel();
      }
      if (state.mode === 'canvas' && ev.canvas === state.name) {
        if (ev.dirty && agent) {
          const fh = state.info?.frameHeight;
          if (frameViewActive() && fh) {
            const f = Math.floor(ev.dirty.y / fh);
            if (follow !== 'off' && ev.dirty.y + ev.dirty.h <= (f + 1) * fh) state.curFrame = f;
            if (f === state.curFrame) state.flash = { ...ev.dirty, y: ev.dirty.y - f * fh, t: performance.now() };
            const th = $('frames').children[f];
            if (th) { th.classList.add('flash'); setTimeout(() => th.classList.remove('flash'), 700); }
          } else state.flash = { ...ev.dirty, t: performance.now() };
        }
        if (ev.structural) state.autoFit = state.autoFit || ev.op === 'transform';
        loadImage();
        loadInfo();
      }
    }
  };
}
function setStatus() {
  const busy = Date.now() - state.lastAgent < 2500;
  $('status').className = 'status ' + (busy ? 'busy' : 'ok');
  $('statusText').textContent = busy ? 'agent is drawing…' : 'live';
}
setInterval(setStatus, 1000);

// ---------- user tools ----------
function setTool(t) {
  state.tool = t;
  document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}
document.querySelectorAll('#tools .tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

const frameArg = () => (frameViewActive() ? { frame: state.curFrame } : {});
function pixelAt(e) {
  const b = state.bitmap;
  const rect = overlay.getBoundingClientRect();
  const gx = Math.floor((e.clientX - rect.left) / state.zoom), gy = Math.floor((e.clientY - rect.top) / state.zoom);
  const t = tiles();
  if (gx < 0 || gy < 0 || gx >= b.width * t || gy >= b.height * t) return null;
  return [((gx % b.width) + b.width) % b.width, ((gy % b.height) + b.height) % b.height];
}
function colorAt(x, y) {
  const d = state.pixels?.data;
  if (!d) return null;
  const p = (y * state.pixels.width + x) * 4;
  const h = (v) => v.toString(16).padStart(2, '0');
  return { hex: `#${h(d[p])}${h(d[p + 1])}${h(d[p + 2])}${d[p + 3] < 255 ? h(d[p + 3]) : ''}`, a: d[p + 3] };
}
function bresenham(x0, y0, x1, y1) {
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

overlay.addEventListener('pointerdown', (e) => {
  if (!state.bitmap || !state.name) return;
  const p = pixelAt(e);
  if (!p) return;
  overlay.setPointerCapture(e.pointerId);
  const tool = state.tool;
  if (tool === 'picker') {
    const c = colorAt(...p);
    if (c && c.a) setColor(c.hex);
    return;
  }
  if (tool === 'fill') {
    api('draw', { canvas: state.name, label: 'user fill', ...frameArg(), commands: [{ op: 'fill', x: p[0], y: p[1], color: currentColor() }] });
    return;
  }
  const color = tool === 'eraser' ? 'transparent' : currentColor();
  if (tool === 'pencil' || tool === 'eraser') {
    const pts = new Map([[p.join(','), p]]);
    state.stroke = { tool, color: $('color').value, erase: tool === 'eraser', last: p, pts, preview: () => pts.values(), send: () => [{ op: 'pixels', color, points: [...pts.values()] }] };
  } else {
    const s = { tool, color: $('color').value, start: p, end: p };
    s.preview = () => {
      if (tool === 'line') return bresenham(...s.start, ...s.end);
      const [x0, x1] = [Math.min(s.start[0], s.end[0]), Math.max(s.start[0], s.end[0])];
      const [y0, y1] = [Math.min(s.start[1], s.end[1]), Math.max(s.start[1], s.end[1])];
      const out = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (e.shiftKey || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y]);
      return out;
    };
    s.send = () => {
      if (tool === 'line') return [{ op: 'line', x1: s.start[0], y1: s.start[1], x2: s.end[0], y2: s.end[1], color }];
      const x = Math.min(s.start[0], s.end[0]), y = Math.min(s.start[1], s.end[1]);
      return [{ op: 'rect', x, y, w: Math.abs(s.end[0] - s.start[0]) + 1, h: Math.abs(s.end[1] - s.start[1]) + 1, ...(e.shiftKey ? { color } : { fill: false, color }) }];
    };
    state.stroke = s;
  }
  drawOverlay();
});
overlay.addEventListener('pointermove', (e) => {
  if (!state.bitmap) return;
  const p = pixelAt(e);
  if (p) {
    const c = colorAt(...p);
    const fh = state.info?.frameHeight;
    const fr = fh ? `  frame ${Math.floor(p[1] / fh)} (y ${p[1] % fh})` : '';
    $('cursorInfo').textContent = `x ${p[0]}  y ${p[1]}${fr}  ${c && c.a ? c.hex : 'transparent'}`;
  }
  const s = state.stroke;
  if (!s || !p) return;
  if (s.pts) {
    for (const q of bresenham(...s.last, ...p)) s.pts.set(q.join(','), q);
    s.last = p;
  } else s.end = p;
  drawOverlay();
});
overlay.addEventListener('pointerleave', () => ($('cursorInfo').textContent = ''));
overlay.addEventListener('pointerup', async () => {
  const s = state.stroke;
  if (!s) return;
  const label = `user ${s.tool}`;
  try {
    await api('draw', { canvas: state.name, label, ...frameArg(), commands: s.send() });
  } finally {
    state.stroke = null;
    drawOverlay();
  }
});

// ---------- buttons & keys ----------
$('undoBtn').onclick = () => state.name && api('undo', { canvas: state.name });
$('redoBtn').onclick = () => state.name && api('undo', { canvas: state.name, redo: true });
const zoomBy = (d) => { state.autoFit = false; state.zoom = Math.max(1, Math.min(64, state.zoom + d * Math.max(1, Math.round(state.zoom / 6)))); render(); };
$('zoomIn').onclick = () => zoomBy(1);
$('zoomOut').onclick = () => zoomBy(-1);
$('zoomFit').onclick = () => { state.autoFit = true; fitZoom(); render(); };
$('gridToggle').onchange = render;
$('tileToggle').onchange = () => { if (state.autoFit) fitZoom(); render(); };
$('stage').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
window.addEventListener('resize', () => { if (state.autoFit) fitZoom(); render(); });
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? $('redoBtn').click() : $('undoBtn').click(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); $('redoBtn').click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tools = { b: 'pencil', e: 'eraser', g: 'fill', l: 'line', r: 'rect', i: 'picker' };
  if (tools[k]) setTool(tools[k]);
  else if (k === '+' || k === '=') zoomBy(1);
  else if (k === '-') zoomBy(-1);
  else if (k === '0') $('zoomFit').click();
  else if (k === '#') { $('gridToggle').checked = !$('gridToggle').checked; render(); }
  else if (k === 'o') $('overviewBtn').click();
  else if (k === 't') { $('tileToggle').checked = !$('tileToggle').checked; $('tileToggle').onchange(); }
});

$('newBtn').onclick = () => { $('newForm').hidden = false; $('newName').focus(); };
$('newCancel').onclick = () => ($('newForm').hidden = true);
$('newForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('newName').value.trim();
  await api('create', { name, width: Number($('newW').value), height: Number($('newH').value) });
  $('newForm').hidden = true;
  $('newName').value = '';
  openCanvas(name);
};
window.addEventListener('hashchange', () => {
  const n = decodeURIComponent(location.hash.slice(1));
  if (n.startsWith('project:')) { if (state.mode !== 'overview' || state.project !== n.slice(8)) openProject(n.slice(8)); }
  else if (n && n !== state.name) openCanvas(n);
});
try {
  const saved = localStorage.getItem('agent-art-follow');
  if (saved) $('followMode').value = saved;
} catch { /* storage unavailable */ }
$('followMode').onchange = () => { try { localStorage.setItem('agent-art-follow', $('followMode').value); } catch { /* ignore */ } };

// ---------- boot ----------
(async () => {
  showEmpty(true);
  restartAnim();
  try {
    const { log } = await (await fetch('/api/log')).json();
    for (const ev of log) logEntry(ev);
  } catch { /* ignore */ }
  await refreshList();
  connect();
})();
