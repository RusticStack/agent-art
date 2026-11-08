// 3D model viewer (three.js, vendored in public/vendor/three, loaded on first use): the model's
// in-memory .glb from the server (same scene as art_model export). Orbit, wireframe, vertex
// normals, UV checker, clips (glTF animations), sockets and pivots, triangle / node stats.
// Without WebGL it falls back to the server's software preview.
import { el, enc, getJSON, fmtBytes } from '../util.js';

let threeP = null;
function loadThree() {
  threeP ||= Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/helpers/VertexNormalsHelper.js'),
  ]).then(([THREE, oc, gl, vn]) => ({ THREE, OrbitControls: oc.OrbitControls, GLTFLoader: gl.GLTFLoader, VertexNormalsHelper: vn.VertexNormalsHelper }));
  return threeP;
}

function checkerTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    x.fillStyle = (i + j) % 2 ? '#e6e9ef' : '#e5484d';
    if ((i + j) % 2 === 0 && j % 2) x.fillStyle = '#38bdf8';
    x.fillRect(i * 32, j * 32, 32, 32);
    x.fillStyle = '#111'; x.font = 'bold 11px monospace';
    x.fillText(`${i}${j}`, i * 32 + 8, j * 32 + 20);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ModelViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.model-viewer');
    host.append(this.root);
    const cb = (label, title, fn, checked = false) => { const i = el('input', { type: 'checkbox', checked, on: { change: () => fn(i.checked) } }); return [i, el('label.toggle', { title }, i, ' ' + label)]; };
    let w, n, u, s, p, g;
    [this.wireCb, w] = cb('Wireframe', 'Wireframe (W)', () => this.applyToggles());
    [this.normCb, n] = cb('Normals', 'Vertex normals', () => this.applyToggles());
    [this.uvCb, u] = cb('UV checker', 'Replace textures with a UV checker', () => this.applyToggles());
    [this.sockCb, s] = cb('Sockets', 'Socket nodes (socket_*) with axes', () => this.applyToggles(), true);
    [this.pivCb, p] = cb('Pivots', 'Part pivots (node origins)', () => this.applyToggles());
    [this.gridCb, g] = cb('Grid', 'Ground grid', () => this.applyToggles(), true);
    this.clipSel = el('select', { on: { change: () => this.playClip() } });
    this.playBtn = el('button.btn', { text: '▶', title: 'Play / pause clip (Space)', on: { click: () => this.togglePlay() } });
    this.loopCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.playClip() } });
    this.glbA = el('a.btn', { text: 'GLB', download: '' });
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, w, n, u), el('div.group', {}, s, p, g),
      el('div.group', {}, el('span.muted', { text: 'Clip' }), this.clipSel, this.playBtn, el('label.toggle', {}, this.loopCb, ' Loop')),
      el('button.btn', { text: 'Reset view', on: { click: () => this.frameCamera() } }),
      el('div.spacer'), this.glbA));
    this.stage = el('div.model-stage');
    this.labels = el('div.model-labels');
    this.stage.append(this.labels);
    this.root.append(this.stage);
    this.status = el('div.vstatus.mono');
    this.root.append(this.status);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
  }

  async init() {
    if (this.T || this.failed) return !!this.T;
    try {
      this.T = await loadThree();
      const { THREE, OrbitControls } = this.T;
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer.setClearColor(0x15171c);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.stage.prepend(this.renderer.domElement);
      // review mode: a click marks the model as seen from this camera (crop of the view attached)
      this.renderer.domElement.addEventListener('click', (e) => {
        if (!this.ctx.app.reviewMode || !this.target) return;
        const cv = this.renderer.domElement, r = cv.getBoundingClientRect(), k = cv.width / r.width;
        const S = Math.round(160 * k), cx = (e.clientX - r.left) * k, cy = (e.clientY - r.top) * k;
        const crop = document.createElement('canvas');
        crop.width = crop.height = S;
        crop.getContext('2d').drawImage(cv, cx - S / 2, cy - S / 2, S, S, 0, 0, S, S);
        this.ctx.app.reviewPrompt({ asset: `model:${this.target.name}`, view: 'orbit', clip: this.clipSel.value || undefined, image: crop.toDataURL('image/png'), where: `screen ${Math.round(((e.clientX - r.left) / r.width) * 100)}%,${Math.round(((e.clientY - r.top) / r.height) * 100)}%` });
      });
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.8);
      sun.position.set(3, 6, 4);
      this.scene.add(sun);
      this.clock = new THREE.Clock();
      this.checker = checkerTexture(THREE);
      this.resize();
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        const dt = this.clock.getDelta();
        if (this.mixer && this.playing) this.mixer.update(dt);
        this.controls.update();
        for (const h of this.normalHelpers || []) h.update();
        this.renderer.render(this.scene, this.camera);
        this.placeLabels();
      };
      loop();
      return true;
    } catch (e) {
      this.failed = e.message || String(e);
      return false;
    }
  }
  resize() {
    if (!this.renderer) return;
    const r = this.stage.getBoundingClientRect();
    this.renderer.setSize(Math.max(1, r.width), Math.max(1, r.height));
    this.camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  async open(target) {
    const keepCam = this.target && this.target.name === target.name && this.target.kind === target.kind;
    this.target = target;
    const url = target.kind === 'export' ? `/api/export-file?path=${enc(target.name)}` : `/api/model/${enc(target.name)}/glb${target.snap ? `?snap=${target.snap}` : ''}`;
    this.glbA.href = url + (url.includes('?') ? '&' : '?') + 'download=1';
    this.glbA.setAttribute('download', `${target.name.split('/').pop().replace(/\.glb$/i, '')}.glb`);
    const ok = await this.init();
    this.info = target.kind === 'model' ? await getJSON(`/api/model/${enc(target.name)}/info`).catch(() => null) : null;
    if (!ok) { this.fallback(); return; }
    let buf;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      buf = await r.arrayBuffer();
    } catch (e) { this.status.textContent = `${target.name}: ${e.message}`; return; }
    const { GLTFLoader } = this.T;
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej)).catch((e) => ({ error: e.message || String(e) }));
    if (gltf.error) { this.status.textContent = `GLB load failed: ${gltf.error}`; return; }
    this.setModel(gltf, buf.byteLength, keepCam);
  }
  fallback() {
    this.stage.querySelector('img.fallback')?.remove();
    const src = this.target.kind === 'model' ? `/api/model/${enc(this.target.name)}/thumb.png?size=384${this.target.snap ? `&snap=${this.target.snap}` : ''}` : null;
    if (src) this.stage.append(el('img.fallback', { src, alt: 'software preview' }));
    this.status.textContent = `WebGL unavailable (${this.failed}); showing the server preview.`;
  }

  setModel(gltf, bytes, keepCam) {
    const { THREE } = this.T;
    if (this.model) { this.scene.remove(this.model); this.disposeHelpers(); }
    this.model = gltf.scene;
    this.scene.add(this.model);
    this.gltf = gltf;
    // remember original maps for the UV checker
    const mats = new Set();
    let tris = 0, verts = 0, meshes = 0;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      verts += g.attributes.position.count;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) { mats.add(m); if (m.userData.origMap === undefined) m.userData.origMap = m.map || null; }
    });
    this.materials = [...mats];
    const box = new THREE.Box3().setFromObject(this.model);
    this.box = box;
    const size = box.getSize(new THREE.Vector3()), diag = size.length() || 1;
    this.diag = diag;
    // helpers
    const nodeNames = (gltf.parser?.json?.nodes || []).map((n) => n.name).filter(Boolean);
    this.sockets = []; this.pivots = [];
    for (const n of new Set(nodeNames)) {
      const o = this.model.getObjectByName(n);
      if (!o) continue;
      if (n.startsWith('socket_')) {
        const ax = new THREE.AxesHelper(diag * 0.08);
        ax.material.depthTest = false; ax.renderOrder = 10;
        o.add(ax);
        this.sockets.push({ o, ax, name: n.slice(7) });
      } else if (o !== this.model) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf5a524, depthTest: false }));
        m.renderOrder = 11;
        const ax = new THREE.AxesHelper(diag * 0.04);
        ax.material.depthTest = false; ax.renderOrder = 11;
        o.add(m); o.add(ax);
        this.pivots.push({ o, m, ax, name: n });
      }
    }
    this.grid = new THREE.GridHelper(Math.ceil(Math.max(size.x, size.z) * 2 + 1), Math.ceil(Math.max(size.x, size.z) * 2 + 1), 0x3b4252, 0x262a33);
    this.grid.position.y = box.min.y;
    this.scene.add(this.grid);
    this.normalHelpers = null;
    // clips
    this.mixer = gltf.animations.length ? new THREE.AnimationMixer(this.model) : null;
    const k = gltf.animations.map((a) => a.name).join('|');
    if (this.clipSel.dataset.k !== k) {
      const cur = this.target.clip || this.clipSel.value;
      this.clipSel.innerHTML = '';
      this.clipSel.append(el('option', { value: '', text: gltf.animations.length ? 'rest pose' : 'no clips' }), ...gltf.animations.map((a) => el('option', { value: a.name, text: `${a.name} (${a.duration.toFixed(2)} s)` })));
      this.clipSel.value = gltf.animations.some((a) => a.name === cur) ? cur : '';
      this.clipSel.dataset.k = k;
    }
    this.playClip();
    if (!keepCam) this.frameCamera();
    this.applyToggles();
    const i = this.info;
    const rig = i?.rig;
    this.status.textContent = [
      this.target.name + (this.target.snap ? ` (snapshot ${this.target.snap})` : ''),
      `${Math.round(tris)} tris`, `${verts} verts`, `${meshes} meshes`, `${this.materials.length} materials`,
      `${nodeNames.length} nodes`, `${this.sockets.length} sockets`, `${gltf.animations.length} clips`,
      i?.size_units ? `size ${i.size_units.join('×')} u` : `size ${size.toArray().map((v) => v.toFixed(2)).join('×')} u`,
      rig ? `rig ${rig.nodes?.length ?? ''} nodes` : '', fmtBytes(bytes), ...(i?.warnings || []).map((w) => '⚠ ' + w),
    ].filter(Boolean).join(' · ');
  }
  frameCamera() {
    if (!this.box) return;
    const { THREE } = this.T;
    const c = this.box.getCenter(new THREE.Vector3());
    const d = this.diag;
    this.camera.near = d / 200; this.camera.far = d * 200; this.camera.updateProjectionMatrix();
    this.camera.position.set(c.x + d * 0.9, c.y + d * 0.6, c.z + d * 1.1);
    this.controls.target.copy(c);
    this.controls.update();
  }
  applyToggles() {
    if (!this.model) return;
    for (const m of this.materials) {
      m.wireframe = this.wireCb.checked;
      const want = this.uvCb.checked ? this.checker : m.userData.origMap;
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
    }
    for (const s of this.sockets) s.ax.visible = this.sockCb.checked;
    for (const p of this.pivots) { p.m.visible = this.pivCb.checked; p.ax.visible = this.pivCb.checked; }
    this.grid.visible = this.gridCb.checked;
    if (this.normCb.checked && !this.normalHelpers) {
      const { VertexNormalsHelper } = this.T;
      this.normalHelpers = [];
      this.model.traverse((o) => { if (o.isMesh) { const h = new VertexNormalsHelper(o, this.diag * 0.03, 0x22c55e); this.scene.add(h); this.normalHelpers.push(h); } });
    } else if (!this.normCb.checked && this.normalHelpers) {
      for (const h of this.normalHelpers) { this.scene.remove(h); h.dispose?.(); }
      this.normalHelpers = null;
    }
    this.labels.innerHTML = '';
    this.labelEls = [];
    const add = (o, text, cls) => { const l = el(`span.mlabel.${cls}`, { text }); this.labels.append(l); this.labelEls.push({ o, l }); };
    if (this.sockCb.checked) for (const s of this.sockets) add(s.o, s.name, 'socket');
    if (this.pivCb.checked) for (const p of this.pivots) add(p.o, p.name, 'pivot');
  }
  placeLabels() {
    if (!this.labelEls?.length) return;
    const { THREE } = this.T;
    const v = new THREE.Vector3();
    const r = this.renderer.domElement;
    const w = r.clientWidth, h = r.clientHeight;
    for (const { o, l } of this.labelEls) {
      o.getWorldPosition(v).project(this.camera);
      const vis = v.z < 1;
      l.style.display = vis ? '' : 'none';
      if (vis) l.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 8}px)`;
    }
  }
  playClip() {
    if (!this.mixer) { this.playBtn.disabled = true; return; }
    this.playBtn.disabled = false;
    this.mixer.stopAllAction();
    const clip = this.gltf.animations.find((a) => a.name === this.clipSel.value);
    if (!clip) { this.playing = false; this.playBtn.textContent = '▶'; this.mixer.update(0); return; }
    const act = this.mixer.clipAction(clip);
    act.setLoop(this.loopCb.checked ? this.T.THREE.LoopRepeat : this.T.THREE.LoopOnce);
    act.clampWhenFinished = true;
    act.reset().play();
    this.playing = true;
    this.playBtn.textContent = '❚❚';
  }
  togglePlay() {
    if (!this.mixer) return;
    if (!this.clipSel.value && this.gltf.animations[0]) { this.clipSel.value = this.gltf.animations[0].name; this.playClip(); return; }
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? '❚❚' : '▶';
  }
  disposeHelpers() {
    for (const h of this.normalHelpers || []) this.scene.remove(h);
    this.normalHelpers = null;
    if (this.grid) this.scene.remove(this.grid);
  }
  onEvent(ev) {
    if (!this.target || this.target.snap || this.target.kind !== 'model') return;
    // the model changed, or one of its texture canvases did
    const texHit = ev.type === 'change' && this.info?.materials?.some((m) => String(m).replace(/^overlay:/, '') === ev.canvas);
    if ((ev.type === 'model' && ev.model === this.target.name && !ev.deleted) || texHit) {
      clearTimeout(this.rt);
      this.rt = setTimeout(() => this.open(this.target), 200);
    }
  }
  keydown(e, k) {
    if (k === ' ') { this.togglePlay(); return true; }
    if (k === 'w') { this.wireCb.checked = !this.wireCb.checked; this.applyToggles(); return true; }
    if (k === '0') { this.frameCamera(); return true; }
    return false;
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.rt);
    this.ro.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.root.remove();
  }
}
