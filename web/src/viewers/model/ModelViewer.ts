// 3D model viewer: the model's in-memory .glb from the server (same scene as art_model export), an
// exported .glb, or a model snapshot. Orbit (mouse, or arrow keys / + - on the focused canvas),
// wireframe, clusters, vertex normals, UV checker, sockets and pivots, grid, clips, triangle / node
// stats, and a channel dropdown (chanSel; materials v2) that reloads the .glb with profile=three (and a
// quick bake for the TEXCOORD_1 channels). three.js comes from the lazy chunk (./three). Renders on
// demand. Without WebGL, or when the chunk fails to load, it shows the server's software preview.
import type * as ThreeNS from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import type { AnyEvent, ModelInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getArrayBuffer, isAbort } from '@/lib/api/http';
import { modelThumb } from '@/lib/api/urls';
import { h, icon } from '@/lib/util/dom';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, link, select, spacer, toggle } from '../controls';
import type { Target } from '../types';
import { CHANNELS, CHANNEL_IDS, FS, SWIZZLE, VS, channelNote, downloadHref, downloadName, fallbackColor, glbUrl, isChannel, loadedNeed, needOf, needsReload, type ChannelId, type Need } from './channels';
import { buildClusters } from './clusters';
import { disposeModel, disposeObject, type NodeLike } from './dispose';
import { clampDt, composeStatus, orbitKey, orbitOffset, statusLine, usesCanvas } from './status';
import { loadThree, resetThree, type ThreeBundle } from './three';

type MapMaterial = ThreeNS.Material & { map?: ThreeNS.Texture | null };
type StdMaterial = ThreeNS.Material & { map?: ThreeNS.Texture | null; color?: ThreeNS.Color; emissive?: ThreeNS.Color; emissiveIntensity?: number; metalness?: number; roughness?: number };
interface Socket { o: ThreeNS.Object3D; ax: ThreeNS.AxesHelper; name: string }
interface Pivot { o: ThreeNS.Object3D; m: ThreeNS.Mesh; ax: ThreeNS.AxesHelper; name: string }

const CLEAR = 0x15171c;
const nameOf = (t: Target): string => ('name' in t ? t.name : '');
const msgOf = (e: unknown): string => (e as Error)?.message || String(e);
const asNode = (o: ThreeNS.Object3D): NodeLike => o as unknown as NodeLike;

function checkerTexture(THREE: typeof ThreeNS): ThreeNS.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  if (x) {
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      x.fillStyle = (i + j) % 2 ? '#e6e9ef' : '#e5484d';
      if ((i + j) % 2 === 0 && j % 2) x.fillStyle = '#38bdf8';
      x.fillRect(i * 32, j * 32, 32, 32);
      x.fillStyle = '#111'; x.font = 'bold 11px monospace';
      x.fillText(`${i}${j}`, i * 32 + 8, j * 32 + 20);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ModelViewer extends BaseViewer {
  // three
  private T: ThreeBundle | null = null;
  private failed: { kind: 'chunk' | 'webgl'; message: string } | null = null;
  private renderer: ThreeNS.WebGLRenderer | null = null;
  private scene!: ThreeNS.Scene;
  private camera!: ThreeNS.PerspectiveCamera;
  private controls!: OrbitControls;
  private clock!: ThreeNS.Clock;
  private checker: ThreeNS.Texture | null = null;
  private loopStop: (() => void) | null = null;
  private needsRender = true;
  private frames = 0;
  private contextLost = false;
  // model
  private model: ThreeNS.Object3D | null = null;
  private gltf: GLTF | null = null;
  private materials: MapMaterial[] = [];
  private box: ThreeNS.Box3 | null = null;
  private diag = 1;
  private sockets: Socket[] = [];
  private pivots: Pivot[] = [];
  private grid: ThreeNS.GridHelper | null = null;
  private normalHelpers: VertexNormalsHelper[] | null = null;
  private mixer: ThreeNS.AnimationMixer | null = null;
  private playing = false;
  private clusterGroup: ThreeNS.Group | null = null;
  private clusterFor: ThreeNS.Object3D | null = null;
  private channelMats: ThreeNS.RawShaderMaterial[] = [];
  private depTextures = new Set<ThreeNS.Texture>();
  private chanSeq = 0;
  private labelEls: { o: ThreeNS.Object3D; l: HTMLElement }[] = [];
  private info: ModelInfo | null = null;
  private loaded: Need = '';
  private statusBase = '';
  private chanNote = '';
  private fetchAbort: AbortController | null = null;
  private pendingClip: string | undefined;
  // DOM
  private wireCb!: HTMLInputElement;
  private clusCb!: HTMLInputElement;
  private normCb!: HTMLInputElement;
  private uvCb!: HTMLInputElement;
  private sockCb!: HTMLInputElement;
  private pivCb!: HTMLInputElement;
  private gridCb!: HTMLInputElement;
  private clipSel!: HTMLSelectElement;
  private playBtn!: HTMLButtonElement;
  private loopCb!: HTMLInputElement;
  private glbA!: HTMLAnchorElement;
  private chanSel!: HTMLSelectElement;
  private stage!: HTMLElement;
  private labels!: HTMLElement;
  private statusText!: HTMLElement;
  private retryBtn!: HTMLButtonElement;

  protected key(t: Target): string {
    return JSON.stringify([t.kind, nameOf(t), t.kind === 'model' ? t.snap ?? null : null]);
  }

  // ---- DOM ----
  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer model-viewer' });
    const cb = (lbl: string, title: string, checked = false) => toggle({ label: lbl, title, checked, onChange: () => this.applyToggles() });
    const w = cb('Wireframe', 'Wireframe (W)'), c = cb('Clusters', 'Colour ~128-triangle clusters (spatially ordered meshlets, like art_model cluster_lod)');
    const n = cb('Normals', 'Vertex normals'), u = cb('UV checker', 'Replace textures with a UV checker');
    const s = cb('Sockets', 'Socket nodes (socket_*) with axes', true), p = cb('Pivots', 'Part pivots (node origins)'), g = cb('Grid', 'Ground grid', true);
    this.wireCb = w.input; this.clusCb = c.input; this.normCb = n.input; this.uvCb = u.input; this.sockCb = s.input; this.pivCb = p.input; this.gridCb = g.input;
    this.clipSel = select({ title: 'Clip (glTF animation)', onChange: () => this.playClip() });
    this.playBtn = button({ icon: 'play', title: 'Play / pause clip (Space)', onClick: () => this.togglePlay() });
    const loop = toggle({ label: 'Loop', checked: true, onChange: () => this.playClip() });
    this.loopCb = loop.input;
    this.glbA = link({ text: 'GLB', title: 'Download the .glb' });
    this.chanSel = select({ title: 'Material channel (materials v2): reloads the model with profile three; lightmap / AO / bent / lightmap UVs run a quick bake', onChange: () => { void this.setChannel().catch(() => {}); } });
    fillSelect(this.chanSel, CHANNEL_IDS.map((k) => ({ value: k, label: CHANNELS[k].label })));
    root.append(h('div', { class: 'vtoolbar' },
      group(w.el, c.el, n.el, u.el), group(s.el, p.el, g.el),
      group(label('Channel'), this.chanSel),
      group(label('Clip'), this.clipSel, this.playBtn, loop.el),
      button({ text: 'Reset view', title: 'Reset view (0)', onClick: () => this.frameCamera() }),
      spacer(), this.glbA));
    this.stage = h('div', { class: 'model-stage' });
    this.labels = h('div', { class: 'model-labels' });
    this.stage.append(this.labels);
    root.append(this.stage);
    this.statusText = h('span');
    this.retryBtn = button({ text: 'Retry', small: true, title: 'Load the 3D viewer again', onClick: () => this.retry() });
    this.retryBtn.hidden = true;
    root.append(h('div', { class: 'vstatus mono' }, this.statusText, this.retryBtn));
    this.addCleanup(() => { this.fetchAbort?.abort(); this.fetchAbort = null; });
    return root;
  }
  private setStatus(text: string): void { this.statusText.textContent = text; }
  private setPlaying(on: boolean): void {
    this.playing = on;
    this.playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
    this.playBtn.setAttribute('aria-pressed', String(on));
    this.requestRender();
  }

  // ---- three / renderer ----
  private async init(): Promise<boolean> {
    if (this.renderer) return true;
    if (this.failed) return false;
    let T: ThreeBundle;
    try { T = await loadThree(); } catch (e) {
      if (!this.dead) this.failed = { kind: 'chunk', message: msgOf(e) };
      return false;
    }
    if (this.dead) return false;
    if (this.renderer) return true;   // a concurrent open() finished init first
    const { THREE, OrbitControls: Orbit } = T;
    let renderer: ThreeNS.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true }); } catch (e) {
      this.failed = { kind: 'webgl', message: msgOf(e) };
      return false;
    }
    this.T = T;
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(CLEAR);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const cv = renderer.domElement;
    cv.tabIndex = 0;
    cv.setAttribute('aria-label', `3D view of ${nameOf(this.target)}`);
    this.stage.prepend(cv);
    const signal = this.dispose.signal;
    cv.addEventListener('click', (e) => this.onCanvasClick(e), { signal });
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.setStatus('WebGL context lost — click to restore');
    }, { signal });
    cv.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.setStatus(this.statusBase || 'Restoring…');
      void this.open(true).catch(() => {});
    }, { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.requestRender(); }, { signal });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.controls = new Orbit(this.camera, cv);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);
    this.clock = new THREE.Clock();
    this.checker = checkerTexture(THREE);
    this.addCleanup(() => this.teardown());
    this.onResize(this.stage, () => this.resize());
    this.onDprChange(() => { this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); this.resize(); });
    this.resize();
    return true;
  }
  private teardown(): void {
    this.loopStop?.();
    this.loopStop = null;
    this.clearModel();
    this.checker?.dispose();
    this.checker = null;
    this.controls?.dispose();
    const r = this.renderer;
    this.renderer = null;
    if (r) { r.dispose(); r.forceContextLoss(); r.domElement.remove(); }
  }
  private resize(): void {
    if (!this.renderer) return;
    const r = this.stage.getBoundingClientRect();
    const w = Math.max(1, r.width), hh = Math.max(1, r.height);
    this.renderer.setSize(w, hh);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // ---- render on demand ----
  private requestRender(): void {
    this.needsRender = true;
    if (!this.loopStop && this.renderer && !this.dead && !this.contextLost && !(typeof document !== 'undefined' && document.hidden)) this.loopStop = this.animate(() => this.tick());
  }
  /** One rAF loop: renders only when something changed, a clip plays or damping settles; stops while hidden. */
  private tick(): boolean {
    if (!this.renderer || document.hidden || this.contextLost) { this.loopStop = null; return false; }
    const dt = clampDt(this.clock.getDelta());
    if (this.mixer && this.playing) { this.mixer.update(dt); this.needsRender = true; }
    if (this.controls.update()) this.needsRender = true;
    if (!this.needsRender) return true;
    this.needsRender = false;
    for (const hh of this.normalHelpers || []) hh.update();
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.placeLabels();
    return true;
  }
  private placeLabels(): void {
    if (!this.labelEls.length || !this.T || !this.renderer) return;
    const v = new this.T.THREE.Vector3();
    const r = this.renderer.domElement;
    const w = r.clientWidth, hh = r.clientHeight;
    for (const { o, l } of this.labelEls) {
      o.getWorldPosition(v).project(this.camera);
      const vis = v.z < 1;
      l.style.display = vis ? '' : 'none';
      if (vis) l.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * hh - 8}px)`;
    }
  }

  // ---- loading ----
  protected async load(target: Target, prev: Target | null): Promise<void> {
    const keepCam = !!prev && prev.kind === target.kind && nameOf(prev) === nameOf(target);
    if (target.kind === 'model' && target.clip) this.pendingClip = target.clip;
    this.renderer?.domElement.setAttribute('aria-label', `3D view of ${nameOf(target)}`);
    await this.open(keepCam);
  }
  protected targetChanged(prev: Target, next: Target): void {
    if (next.kind !== 'model' || !next.clip || (prev.kind === 'model' && prev.clip === next.clip)) return;
    if (this.gltf?.animations.some((a) => a.name === next.clip)) { this.clipSel.value = next.clip; this.playClip(); } else this.pendingClip = next.clip;
  }

  /** (Re)load the current target. Errors are shown in the status line and rethrown. */
  private async open(keepCam: boolean): Promise<void> {
    const token = this.nextLoad();
    const t = this.target, name = nameOf(t);
    const ch = this.chanSel.value, need = needOf(ch);
    const url = glbUrl(t, need);
    this.glbA.href = downloadHref(url);
    this.glbA.setAttribute('download', downloadName(name));
    this.fetchAbort?.abort();
    const ac = (this.fetchAbort = new AbortController());
    const ok = await this.init();
    if (!this.isCurrent(token)) return;
    const info = t.kind === 'model' ? await api.modelInfo(name, ac.signal).catch(() => null) : null;
    if (!this.isCurrent(token)) return;
    this.info = info;
    if (!ok) { this.fallback(); return; }
    this.retryBtn.hidden = true;
    this.stage.querySelector('img.fallback')?.remove();
    let buf: ArrayBuffer;
    try { buf = await getArrayBuffer(url, { signal: ac.signal }); } catch (e) {
      if (isAbort(e) || !this.isCurrent(token)) return;
      this.setStatus(`${name}: ${msgOf(e)}`);
      throw e;
    }
    if (!this.isCurrent(token) || !this.T) return;
    let gltf: GLTF;
    try { gltf = await new this.T.GLTFLoader().parseAsync(buf, ''); } catch (e) {
      if (!this.isCurrent(token)) return;
      const msg = `GLB load failed: ${msgOf(e)}`;
      this.setStatus(msg);
      throw new Error(msg);
    }
    if (!this.isCurrent(token)) { disposeModel(asNode(gltf.scene)); return; }
    this.loaded = loadedNeed(t, need);
    this.setModel(gltf, buf.byteLength, keepCam);
    await this.applyChannel();
  }
  private reload(): void { void this.open(true).catch(() => {}); }

  private fallback(): void {
    this.stage.querySelector('img.fallback')?.remove();
    const t = this.target;
    if (t.kind === 'model') this.stage.append(h('img', { class: 'fallback', src: modelThumb(t.name, { size: 384, snap: t.snap }), alt: 'software preview' }));
    const f = this.failed ?? { kind: 'webgl', message: 'unknown error' };
    const tail = t.kind === 'model' ? '; showing the server preview.' : '.';
    if (f.kind === 'chunk') this.setStatus(`3D viewer failed to load (${f.message})${tail}`);
    else this.setStatus(`WebGL unavailable (${f.message})${tail}`);
    this.retryBtn.hidden = f.kind !== 'chunk';
  }
  private retry(): void {
    resetThree();
    this.failed = null;
    this.retryBtn.hidden = true;
    this.setStatus('Loading the 3D viewer…');
    this.reload();
  }

  private setModel(gltf: GLTF, bytes: number, keepCam: boolean): void {
    const { THREE } = this.T!;
    this.clearModel();
    const model = gltf.scene;
    this.model = model;
    this.gltf = gltf;
    this.scene.add(model);
    // remember original maps for the UV checker
    const mats = new Set<MapMaterial>();
    let tris = 0, verts = 0, meshes = 0;
    model.traverse((o) => {
      const m = o as ThreeNS.Mesh;
      if (!m.isMesh) return;
      meshes++;
      const g = m.geometry;
      verts += g.attributes.position.count;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const mm of ([] as ThreeNS.Material[]).concat(m.material) as MapMaterial[]) { mats.add(mm); if (mm.userData.origMap === undefined) mm.userData.origMap = mm.map || null; }
    });
    this.materials = [...mats];
    const box = new THREE.Box3().setFromObject(model);
    this.box = box;
    const size = box.getSize(new THREE.Vector3()), diag = size.length() || 1;
    this.diag = diag;
    // helpers (children of the model's nodes, disposed with it)
    const json = gltf.parser?.json as { nodes?: { name?: string }[] } | undefined;
    const nodeNames = (json?.nodes || []).map((nd) => nd.name).filter((x): x is string => !!x);
    for (const nm of new Set(nodeNames)) {
      const o = model.getObjectByName(nm);
      if (!o) continue;
      if (nm.startsWith('socket_')) {
        const ax = new THREE.AxesHelper(diag * 0.08);
        (ax.material as ThreeNS.Material).depthTest = false; ax.renderOrder = 10; ax.userData.helper = true;
        o.add(ax);
        this.sockets.push({ o, ax, name: nm.slice(7) });
      } else if (o !== model) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf5a524, depthTest: false }));
        m.renderOrder = 11; m.userData.helper = true;
        const ax = new THREE.AxesHelper(diag * 0.04);
        (ax.material as ThreeNS.Material).depthTest = false; ax.renderOrder = 11; ax.userData.helper = true;
        o.add(m); o.add(ax);
        this.pivots.push({ o, m, ax, name: nm });
      }
    }
    const gs = Math.ceil(Math.max(size.x, size.z) * 2 + 1);
    this.grid = new THREE.GridHelper(gs, gs, 0x3b4252, 0x262a33);
    this.grid.position.y = box.min.y;
    this.scene.add(this.grid);
    // clips
    this.mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : null;
    fillSelect(this.clipSel, gltf.animations.map((a) => ({ value: a.name, label: `${a.name} (${a.duration.toFixed(2)} s)` })),
      { first: { value: '', label: gltf.animations.length ? 'rest pose' : 'no clips' }, keep: this.pendingClip ?? this.clipSel.value });
    this.pendingClip = undefined;
    this.playClip();
    if (!keepCam) this.frameCamera();
    this.applyToggles();
    this.statusBase = statusLine({
      name: nameOf(this.target), snap: this.target.kind === 'model' ? this.target.snap : undefined,
      tris, verts, meshes, materials: this.materials.length, nodes: nodeNames.length, sockets: this.sockets.length, clips: gltf.animations.length,
      size: [size.x, size.y, size.z], bytes,
    }, this.info);
    this.setStatus(this.statusBase);
    this.requestRender();
  }

  /** Remove and dispose the current model with everything built for it. */
  private clearModel(): void {
    const model = this.model;
    this.restoreChannel();
    this.applyClusters(false);
    this.disposeNormals();
    if (this.grid) { this.scene.remove(this.grid); this.grid.dispose(); this.grid = null; }
    if (this.mixer && model) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(model); }
    this.mixer = null;
    this.playing = false;
    if (model) {
      this.scene.remove(model);
      disposeModel(asNode(model), this.depTextures, new Set([this.checker]));
    }
    this.depTextures.clear();
    this.model = null; this.gltf = null; this.box = null;
    this.materials = []; this.sockets = []; this.pivots = [];
    this.labels.replaceChildren();
    this.labelEls = [];
  }

  frameCamera(): void {
    if (!this.box || !this.T) return;
    const c = this.box.getCenter(new this.T.THREE.Vector3());
    const d = this.diag;
    this.camera.near = d / 200; this.camera.far = d * 200; this.camera.updateProjectionMatrix();
    this.camera.position.set(c.x + d * 0.9, c.y + d * 0.6, c.z + d * 1.1);
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }

  // ---- channels ----
  /** Channel dropdown: reload when the channel needs a richer .glb, else swap the materials. */
  private async setChannel(): Promise<void> {
    if (needsReload(this.target, needOf(this.chanSel.value), this.loaded)) { await this.open(true); return; }
    await this.applyChannel();
  }
  private meshes(): ThreeNS.Mesh[] {
    const out: ThreeNS.Mesh[] = [];
    this.model?.traverse((o) => { const m = o as ThreeNS.Mesh; if (m.isMesh && !m.userData.helper) out.push(m); });
    return out;
  }
  /** Put the original materials back and dispose the channel shader materials. */
  private restoreChannel(): void {
    for (const o of this.meshes()) if (o.userData.origMat) o.material = o.userData.origMat as ThreeNS.Material;
    for (const m of this.channelMats.splice(0)) m.dispose();
  }
  private async applyChannel(): Promise<void> {
    const model = this.model, gltf = this.gltf, T = this.T;
    if (!model || !gltf || !T) return;
    const seq = ++this.chanSeq;
    const { THREE } = T;
    const v = this.chanSel.value, ch: ChannelId = isChannel(v) ? v : 'lit', spec = CHANNELS[ch];
    const meshes = this.meshes();
    for (const o of meshes) if (!o.userData.origMat) o.userData.origMat = o.material;
    const built: [ThreeNS.Mesh, ThreeNS.RawShaderMaterial][] = [];
    const stale = () => seq !== this.chanSeq || this.model !== model || this.dead;
    let missing = 0;
    if (ch !== 'lit') {
      for (const o of meshes) {
        const orig = o.userData.origMat as ThreeNS.Material | ThreeNS.Material[];
        if (Array.isArray(orig)) continue;
        const m = orig as StdMaterial;
        let tex: ThreeNS.Texture | null = null, scale = 1, uv1 = false, mode = 0, color: ThreeNS.Color | null = new THREE.Color(1, 1, 1);
        const src = spec.source ?? '';
        if (src === 'tangent') { mode = 1; if (!o.geometry.attributes.tangent) missing++; }
        else if (src === 'uv1') { mode = 2; if (!o.geometry.attributes.uv1) missing++; }
        else if (src.startsWith('x:')) {
          const path = src.slice(2).split('.');
          const ex = path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : null), m.userData || {}) as { index?: unknown; texCoord?: number } | null;
          if (ex && Number.isInteger(ex.index)) {
            tex = await (gltf.parser.getDependency('texture', ex.index as number) as Promise<ThreeNS.Texture>).catch(() => null);
            if (stale()) { for (const [, mm] of built) mm.dispose(); return; }
            if (tex) this.depTextures.add(tex);
            uv1 = ex.texCoord === 1;
            if (src === 'x:detail.texture') scale = (m.userData.detail as { scale?: number } | undefined)?.scale || 1;
          }
        } else {
          const cand = (m as unknown as Record<string, unknown>)[src] as ThreeNS.Texture | null | undefined;
          tex = cand && cand.isTexture ? cand : null;
          if (src === 'map' && m.userData.origMap !== undefined) tex = (m.userData.origMap as ThreeNS.Texture | null) ?? null;
          if (tex) uv1 = tex.channel === 1;
        }
        if (src === 'emissiveMap' && m.emissive) color = m.emissive.clone().multiplyScalar(Math.min(1, m.emissiveIntensity || 1));
        if (!tex && mode === 0) {
          missing++;
          const rgb = fallbackColor(ch, src, { metalness: m.metalness, roughness: m.roughness, color: m.color ? [m.color.r, m.color.g, m.color.b] : null });
          color = new THREE.Color(rgb[0], rgb[1], rgb[2]);
        }
        const mat = new THREE.RawShaderMaterial({
          vertexShader: VS, fragmentShader: FS, side: m.side, wireframe: this.wireCb.checked,
          uniforms: {
            map: { value: tex }, useMap: { value: tex ? 1 : 0 }, useUv1: { value: uv1 ? 1 : 0 }, mode: { value: mode },
            swz: { value: SWIZZLE[spec.swizzle ?? 'rgb'] }, toSrgb: { value: tex && tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0 }, color: { value: color }, scale: { value: scale },
          },
        });
        built.push([o, mat]);
      }
    }
    if (stale()) { for (const [, mm] of built) mm.dispose(); return; }
    this.restoreChannel();
    for (const [o, mm] of built) { o.material = mm; this.channelMats.push(mm); }
    this.chanNote = channelNote(ch, missing);
    if (this.statusBase) this.setStatus(composeStatus(this.statusBase, this.chanNote));
    this.requestRender();
  }

  // ---- toggles ----
  private applyToggles(): void {
    const model = this.model, T = this.T;
    if (!model || !T) return;
    const wire = this.wireCb.checked;
    for (const m of this.channelMats) m.wireframe = wire;
    for (const m of this.materials) {
      (m as ThreeNS.Material & { wireframe?: boolean }).wireframe = wire;
      const want = this.uvCb.checked ? this.checker : (m.userData.origMap as ThreeNS.Texture | null);
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
    }
    for (const s of this.sockets) s.ax.visible = this.sockCb.checked;
    for (const p of this.pivots) { p.m.visible = this.pivCb.checked; p.ax.visible = this.pivCb.checked; }
    if (this.grid) this.grid.visible = this.gridCb.checked;
    this.applyClusters(this.clusCb.checked);
    if (this.normCb.checked && !this.normalHelpers) {
      const helpers: VertexNormalsHelper[] = [];
      for (const o of this.meshes()) { const hh = new T.VertexNormalsHelper(o, this.diag * 0.03, 0x22c55e); this.scene.add(hh); helpers.push(hh); }
      this.normalHelpers = helpers;
    } else if (!this.normCb.checked) this.disposeNormals();
    this.labels.replaceChildren();
    this.labelEls = [];
    const add = (o: ThreeNS.Object3D, text: string, cls: string) => { const l = h('span', { class: `mlabel ${cls}`, text }); this.labels.append(l); this.labelEls.push({ o, l }); };
    if (this.sockCb.checked) for (const s of this.sockets) add(s.o, s.name, 'socket');
    if (this.pivCb.checked) for (const p of this.pivots) add(p.o, p.name, 'pivot');
    this.requestRender();
  }
  private disposeNormals(): void {
    for (const hh of this.normalHelpers || []) { this.scene.remove(hh); hh.dispose(); }
    this.normalHelpers = null;
  }
  /** Cluster view: a separate flat-coloured mesh group; the model is hidden while it shows. */
  private applyClusters(on: boolean): void {
    if (this.clusterGroup && (!on || this.clusterFor !== this.model)) {
      this.scene.remove(this.clusterGroup);
      disposeObject(asNode(this.clusterGroup));
      this.clusterGroup = null;
      this.clusterFor = null;
    }
    if (!this.model || !this.T) return;
    if (on && !this.clusterGroup) {
      const { group: grp } = buildClusters(this.T.THREE, this.model, this.wireCb.checked);
      this.clusterGroup = grp; this.clusterFor = this.model;
      this.scene.add(grp);
    }
    this.clusterGroup?.traverse((o) => { const m = o as ThreeNS.Mesh; if (m.isMesh) (m.material as ThreeNS.MeshBasicMaterial).wireframe = this.wireCb.checked; });
    this.model.visible = !on;
  }

  // ---- clips ----
  private playClip(): void {
    const mixer = this.mixer, gltf = this.gltf, T = this.T;
    if (!mixer || !gltf || !T) { this.playBtn.disabled = true; this.setPlaying(false); return; }
    this.playBtn.disabled = false;
    mixer.stopAllAction();
    const clip = gltf.animations.find((a) => a.name === this.clipSel.value);
    if (!clip) { this.setPlaying(false); mixer.update(0); return; }
    const act = mixer.clipAction(clip);
    act.setLoop(this.loopCb.checked ? T.THREE.LoopRepeat : T.THREE.LoopOnce, Infinity);
    act.clampWhenFinished = true;
    act.reset().play();
    this.clock?.getDelta();
    this.setPlaying(true);
  }
  togglePlay(): void {
    if (!this.mixer || !this.gltf) return;
    if (!this.clipSel.value && this.gltf.animations[0]) { this.clipSel.value = this.gltf.animations[0].name; this.playClip(); return; }
    if (!this.playing) this.clock?.getDelta();
    this.setPlaying(!this.playing);
  }

  // ---- input ----
  private onCanvasClick(e: MouseEvent): void {
    const r0 = this.renderer;
    if (!r0) return;
    if (this.contextLost) { r0.forceContextRestore(); return; }
    // review mode: a click marks the model as seen from this camera (crop of the view attached)
    if (!this.env.reviewMode || !this.model) return;
    const cv = r0.domElement, r = cv.getBoundingClientRect(), k = cv.width / (r.width || 1);
    const S = Math.round(160 * k), cx = (e.clientX - r.left) * k, cy = (e.clientY - r.top) * k;
    const crop = document.createElement('canvas');
    crop.width = crop.height = S;
    crop.getContext('2d')?.drawImage(cv, cx - S / 2, cy - S / 2, S, S, 0, 0, S, S);
    this.host.requestReview({
      asset: `model:${nameOf(this.target)}`, view: 'orbit', clip: this.clipSel.value || undefined, image: crop.toDataURL('image/png'),
      where: `screen ${Math.round(((e.clientX - r.left) / (r.width || 1)) * 100)}%,${Math.round(((e.clientY - r.top) / (r.height || 1)) * 100)}%`,
    });
  }

  onEvent(ev: AnyEvent): void {
    const t = this.target;
    if (!t || t.kind !== 'model' || t.snap) return;
    // the model changed, or one of its texture canvases did
    const e = ev as { type: string; model?: unknown; canvas?: unknown; deleted?: unknown };
    const texHit = e.type === 'change' && typeof e.canvas === 'string' && usesCanvas(this.info, e.canvas);
    if ((e.type === 'model' && e.model === t.name && !e.deleted) || texHit) this.later(200, () => this.reload(), 'reload');
  }

  onKey(e: KeyboardEvent, k: string): boolean {
    if (k === ' ') { this.togglePlay(); return true; }
    if (k === 'w') { this.wireCb.checked = !this.wireCb.checked; this.applyToggles(); return true; }
    if (k === '0') { this.frameCamera(); return true; }
    const step = this.renderer && document.activeElement === this.renderer.domElement ? orbitKey(e.key) : null;
    if (step) { this.orbitBy(step[0], step[1], step[2]); return true; }
    return false;
  }
  /** Keyboard orbit / dolly around the controls target. */
  private orbitBy(dAz: number, dPolar: number, dolly: number): void {
    if (!this.model) return;
    const tg = this.controls.target, p = this.camera.position;
    const off = orbitOffset({ x: p.x - tg.x, y: p.y - tg.y, z: p.z - tg.z }, dAz, dPolar, dolly);
    p.set(tg.x + off.x, tg.y + off.y, tg.z + off.z);
    this.controls.update();
    this.requestRender();
  }

  debugInfo(): unknown {
    const r = this.renderer;
    return {
      name: nameOf(this.target), frames: this.frames, loaded: this.loaded, channel: this.chanSel.value, playing: this.playing,
      contextLost: this.contextLost, failed: this.failed, webgl: !!r,
      gl: r ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? 0 } : null,
    };
  }
}
