// 3D model viewer (three.js, vendored in public/vendor/three, loaded on first use): the model's
// in-memory .glb from the server (same scene as art_model export). Orbit, wireframe, vertex
// normals, UV checker, clips (glTF animations), sockets and pivots, triangle / node stats, and a
// channel dropdown (materials v2: albedo, normal, ORM, metal, rough, AO, emissive, height, lightmap,
// bent normals, tangents, lightmap UVs, detail) that reloads the .glb with profile=three (and a
// quick bake for the TEXCOORD_1 channels). Without WebGL it falls back to the server's software preview.
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

/** Channel views: [label, texture source, swizzle (rgb|r|g|b), needs] (needs: three = v2 glb, bake = baked TEXCOORD_1). */
const CHANNELS = {
  lit: ['Lit', null], albedo: ['Albedo', 'map'], normal: ['Normal', 'normalMap', 'rgb', 'three'], orm: ['ORM', 'metalnessMap', 'rgb', 'three'],
  metal: ['Metal', 'metalnessMap', 'b', 'three'], rough: ['Rough', 'roughnessMap', 'g', 'three'], ao: ['AO', 'aoMap', 'r', 'bake'], emissive: ['Emissive', 'emissiveMap', 'rgb', 'three'],
  height: ['Height', 'x:heightTexture', 'r', 'three'], detail: ['Detail', 'x:detail.texture', 'rgb', 'three'], lightmap: ['Lightmap', 'x:lightMap', 'rgb', 'bake'],
  bent: ['Bent normals', 'x:bentNormalTexture', 'rgb', 'bake'], tangent: ['Tangents', 'tangent', 'rgb', 'three'], uv1: ['Lightmap UVs', 'uv1', 'rgb', 'bake'],
};
const VS = `precision highp float;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
attribute vec3 position; attribute vec2 uv; attribute vec2 uv1; attribute vec4 tangent;
varying vec2 vUv; varying vec2 vUv1; varying vec4 vT;
void main() { vUv = uv; vUv1 = uv1; vT = tangent; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `precision highp float;
uniform sampler2D map; uniform int useMap; uniform int useUv1; uniform int mode; uniform int swz; uniform int toSrgb; uniform vec3 color; uniform float scale;
varying vec2 vUv; varying vec2 vUv1; varying vec4 vT;
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 c = color;
  if (mode == 1) c = vT.xyz * 0.5 + 0.5;
  else if (mode == 2) { vec2 g = floor(vUv1 * 64.0); c = vec3(vUv1, mod(g.x + g.y, 2.0) * 0.6 + 0.2); }
  else if (useMap == 1) {
    vec4 t = texture2D(map, (useUv1 == 1 ? vUv1 : vUv) * scale);
    vec3 v = swz == 1 ? vec3(t.r) : swz == 2 ? vec3(t.g) : swz == 3 ? vec3(t.b) : t.rgb;
    c = (toSrgb == 1 ? srgb(v) : v) * color;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

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
    let w, n, u, s, p, g, c;
    [this.wireCb, w] = cb('Wireframe', 'Wireframe (W)', () => this.applyToggles());
    [this.clusCb, c] = cb('Clusters', 'Colour ~128-triangle clusters (spatially ordered meshlets, like art_model cluster_lod)', () => this.applyToggles());
    [this.normCb, n] = cb('Normals', 'Vertex normals', () => this.applyToggles());
    [this.uvCb, u] = cb('UV checker', 'Replace textures with a UV checker', () => this.applyToggles());
    [this.sockCb, s] = cb('Sockets', 'Socket nodes (socket_*) with axes', () => this.applyToggles(), true);
    [this.pivCb, p] = cb('Pivots', 'Part pivots (node origins)', () => this.applyToggles());
    [this.gridCb, g] = cb('Grid', 'Ground grid', () => this.applyToggles(), true);
    this.clipSel = el('select', { on: { change: () => this.playClip() } });
    this.playBtn = el('button.btn', { text: '▶', title: 'Play / pause clip (Space)', on: { click: () => this.togglePlay() } });
    this.loopCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.playClip() } });
    this.glbA = el('a.btn', { text: 'GLB', download: '' });
    this.chanSel = el('select', { title: 'Material channel (materials v2): reloads the model with profile three; lightmap / AO / bent / lightmap UVs run a quick bake', on: { change: () => this.setChannel() } },
      ...Object.entries(CHANNELS).map(([k, [label]]) => el('option', { value: k, text: label })));
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, w, c, n, u), el('div.group', {}, s, p, g),
      el('div.group', {}, el('span.muted', { text: 'Channel' }), this.chanSel),
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
    const need = CHANNELS[this.chanSel.value]?.[3];
    const q = [target.snap ? `snap=${target.snap}` : '', target.kind === 'model' && need ? `profile=three${need === 'bake' ? '&bake=1' : ''}` : ''].filter(Boolean).join('&');
    this.loadedNeed = target.kind === 'model' ? need || '' : '';
    const url = target.kind === 'export' ? `/api/export-file?path=${enc(target.name)}` : `/api/model/${enc(target.name)}/glb${q ? `?${q}` : ''}`;
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
    await this.applyChannel();
  }
  /** Channel dropdown: reload when the channel needs a richer .glb, else swap the materials. */
  async setChannel() {
    const need = CHANNELS[this.chanSel.value]?.[3] || '';
    const rank = { '': 0, three: 1, bake: 2 };
    if (this.target && this.target.kind === 'model' && rank[need] > rank[this.loadedNeed || '']) { await this.open(this.target); return; }
    await this.applyChannel();
  }
  async applyChannel() {
    if (!this.model || !this.T) return;
    const { THREE } = this.T;
    const ch = this.chanSel.value, spec = CHANNELS[ch] || CHANNELS.lit;
    const meshes = [];
    this.model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    let missing = 0;
    for (const o of meshes) {
      if (!o.userData.origMat) o.userData.origMat = o.material;
      if (ch === 'lit') { o.material = o.userData.origMat; continue; }
      const m = o.userData.origMat;
      let tex = null, scale = 1, uv1 = false, mode = 0, color = new THREE.Color(1, 1, 1);
      const src = spec[1];
      if (src === 'tangent') { mode = 1; if (!o.geometry.attributes.tangent) missing++; }
      else if (src === 'uv1') { mode = 2; if (!o.geometry.attributes.uv1) missing++; }
      else if (src.startsWith('x:')) {
        const path = src.slice(2).split('.'), ex = path.reduce((v, k) => (v ? v[k] : null), m.userData || {});
        if (ex && Number.isInteger(ex.index)) { tex = await this.gltf.parser.getDependency('texture', ex.index).catch(() => null); uv1 = ex.texCoord === 1; if (src === 'x:detail.texture') scale = m.userData.detail.scale || 1; }
      } else { tex = m[src] || null; if (tex) uv1 = tex.channel === 1; }
      if (src === 'emissiveMap' && m.emissive) color = m.emissive.clone().multiplyScalar(Math.min(1, m.emissiveIntensity || 1));
      if (!tex && mode === 0) {
        missing++;
        if (src === 'normalMap') color = new THREE.Color(0.5, 0.5, 1);
        else if (src === 'metalnessMap') color = ch === 'orm' ? new THREE.Color(1, m.roughness, m.metalness) : new THREE.Color(m.metalness, m.metalness, m.metalness);
        else if (src === 'roughnessMap') color = new THREE.Color(m.roughness, m.roughness, m.roughness);
        else if (src === 'map' && m.color) color = m.color.clone();
        else if (src !== 'emissiveMap' && src !== 'aoMap') color = new THREE.Color(0.25, 0.1, 0.25);
        else if (src === 'aoMap') color = new THREE.Color(1, 1, 1);
        else color = new THREE.Color(0, 0, 0);
      }
      const swz = { rgb: 0, r: 1, g: 2, b: 3 }[spec[2] || 'rgb'];
      o.material = new THREE.RawShaderMaterial({
        vertexShader: VS, fragmentShader: FS, side: m.side,
        uniforms: { map: { value: tex }, useMap: { value: tex ? 1 : 0 }, useUv1: { value: uv1 ? 1 : 0 }, mode: { value: mode }, swz: { value: swz }, toSrgb: { value: tex && tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0 }, color: { value: color }, scale: { value: scale } },
      });
    }
    this.chanNote = ch === 'lit' ? '' : `channel ${spec[0]}${missing ? ` (${missing} mesh${missing > 1 ? 'es' : ''} without it)` : ''}`;
    if (this.statusBase) this.status.textContent = [this.statusBase, this.chanNote].filter(Boolean).join(' · ');
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
    this.statusBase = this.status.textContent = [
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
    this.model.traverse((o) => { if (o.isMesh && o.material && o.material.isRawShaderMaterial) o.material.wireframe = this.wireCb.checked; });
    for (const m of this.materials) {
      m.wireframe = this.wireCb.checked;
      const want = this.uvCb.checked ? this.checker : m.userData.origMap;
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
    }
    for (const s of this.sockets) s.ax.visible = this.sockCb.checked;
    for (const p of this.pivots) { p.m.visible = this.pivCb.checked; p.ax.visible = this.pivCb.checked; }
    this.grid.visible = this.gridCb.checked;
    this.applyClusters(this.clusCb.checked);
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
  /** Cluster view: per mesh, triangles in Morton order cut into runs of 128, one flat colour each. */
  applyClusters(on) {
    const { THREE } = this.T;
    if (this.clusterGroup && (!on || this.clusterFor !== this.model)) {
      this.scene.remove(this.clusterGroup);
      this.clusterGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      this.clusterGroup = null;
    }
    if (on && !this.clusterGroup) {
      const grp = new THREE.Group();
      let id = 0;
      this.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.model), mn = box.min, sz = box.getSize(new THREE.Vector3());
      const q = (v, i) => Math.max(0, Math.min(1023, Math.floor(((v - mn.getComponent(i)) / (sz.getComponent(i) || 1)) * 1023)));
      const spread = (x) => { x &= 1023; x = (x | (x << 16)) & 0x30000ff; x = (x | (x << 8)) & 0x300f00f; x = (x | (x << 4)) & 0x30c30c3; return (x | (x << 2)) & 0x9249249; };
      const colour = (k) => { let h = Math.imul((k + 1) ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.65, 0.55); };
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        let hidden = false;
        for (let a = o; a; a = a.parent) if (a.visible === false) hidden = true;
        if (hidden) return;
        const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        const P = g.attributes.position, nt = P.count / 3, v = new THREE.Vector3(), c = new THREE.Vector3();
        const keys = [];
        for (let t = 0; t < nt; t++) {
          c.set(0, 0, 0);
          for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(P, t * 3 + k).applyMatrix4(o.matrixWorld));
          c.multiplyScalar(1 / 3);
          keys.push([(spread(q(c.x, 0)) | (spread(q(c.y, 1)) << 1) | (spread(q(c.z, 2)) << 2)) >>> 0, t]);
        }
        keys.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        const col = new Float32Array(P.count * 3);
        keys.forEach(([, t], r) => { const cc = colour(id + Math.floor(r / 128)); for (let k = 0; k < 3; k++) col.set([cc.r, cc.g, cc.b], (t * 3 + k) * 3); });
        id += Math.ceil(nt / 128);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: this.wireCb.checked, side: o.material?.side ?? THREE.FrontSide }));
        m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld);
        grp.add(m);
      });
      this.clusterGroup = grp; this.clusterFor = this.model; this.clusterCount = id;
      this.scene.add(grp);
    }
    if (this.clusterGroup) this.clusterGroup.traverse((o) => { if (o.isMesh) o.material.wireframe = this.wireCb.checked; });
    this.model.visible = !on;
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
