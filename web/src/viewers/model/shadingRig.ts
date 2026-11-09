// The shading rig (plan 5.7b): lights, environment, shadows, GTAO, baked maps, probes. It only runs once
// three.js is loaded, so it ships inside the lazy three chunk (vite.config.js group "three"); the
// settings helpers it shares with the toolbar stay in ./shading (the model viewer chunk).
import type * as ThreeNS from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';
import type { ThreeBundle } from './three';
import { type ShadingMode, type Tier, type Baked, type ShadingSettings, DEFAULT_SETTINGS, sunDirection, sunVector, type TierSpec, TIERS, tierFor, tierBelow, type DegradeStep, DEGRADE_REASONS, nextDegradeStep, FrameMeter, FrameCostWatch, type ProbeData, probePositions, probeCoeffs, type ShadingInfo, drawMatcap } from './shading';

// clusters and disposal run only with three loaded too: the model viewer reaches them through this module
export { buildClusters } from './clusters';
export { disposeModel, disposeObject } from './dispose';
export { FS, SWIZZLE, VS } from './shaders';
export { buildPie, pieKey, piePosition } from './pie';

// ---------------------------------------------------------------- rig
type Mat = ThreeNS.Material & {
  map?: ThreeNS.Texture | null; color?: ThreeNS.Color; wireframe?: boolean;
  aoMap?: ThreeNS.Texture | null; aoMapIntensity?: number; lightMap?: ThreeNS.Texture | null; lightMapIntensity?: number;
};
type Twin = ThreeNS.MeshMatcapMaterial | ThreeNS.MeshBasicMaterial;
interface LightmapExtras { index?: unknown; texCoord?: number; intensity?: number }
const asArr = <T>(m: T | T[]): T[] => (Array.isArray(m) ? m : [m]);
const solidish = (m: ShadingMode) => m === 'wire' || m === 'solid';
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** The composer is released after this long without use (plan 5.7b disposal). */
export const COMPOSER_IDLE_MS = 10_000;

export interface ShadingRigOptions { slotB?: boolean; onDegrade?(step: DegradeStep): void }

export class ShadingRig {
  private readonly THREE: typeof ThreeNS;
  private s: ShadingSettings = { ...DEFAULT_SETTINGS };
  private appliedOnce = false;
  // model
  private root: ThreeNS.Object3D | null = null;
  private gltf: GLTF | null = null;
  private center: ThreeNS.Vector3;
  private radius = 1;
  private diag = 1;
  private minY = 0;
  private meshes: ThreeNS.Mesh[] = [];
  private originals: Mat[] = [];
  private matcapTwins = new Map<ThreeNS.Material, ThreeNS.MeshMatcapMaterial>();
  private flatTwins = new Map<ThreeNS.Material, ThreeNS.MeshBasicMaterial>();
  private lightmaps = new Map<Mat, ThreeNS.Texture | null>();
  private lightmapSeq = 0;
  private lightmapsShown = 0;
  private extraTextures: Set<ThreeNS.Texture> | null = null;
  // shared resources
  private matcapTex: ThreeNS.CanvasTexture | null = null;
  private studioLights: [ThreeNS.HemisphereLight, ThreeNS.DirectionalLight] | null = null;
  private sun: ThreeNS.DirectionalLight | null = null;
  private ground: ThreeNS.Mesh<ThreeNS.PlaneGeometry, ThreeNS.ShadowMaterial> | null = null;
  private envRT: ThreeNS.WebGLRenderTarget | null = null;
  private bgColor: ThreeNS.Color;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtao: GTAOPass | null = null;
  private outputPass: OutputPass | null = null;
  private composerMsaa = -1;
  private gtaoKey = '';
  private composerUsed = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private probeGroup: ThreeNS.Group | null = null;
  private probeHelpers: LightProbeHelper[] = [];
  private probesVisible = false;
  // state
  private channelView = false;
  private wire = false;
  private checker = false;
  private interacting = false;
  private shadowsEnabled = false;
  private autoTier: Tier;
  private degraded: DegradeStep[] = [];
  private watch = new FrameCostWatch();
  private size = { w: 1, h: 1, dpr: 1 };
  private dead = false;
  canFallback = false;

  constructor(private readonly T: ThreeBundle, private readonly renderer: ThreeNS.WebGLRenderer, private readonly scene: ThreeNS.Scene, private readonly camera: ThreeNS.PerspectiveCamera, private readonly opts: ShadingRigOptions = {}) {
    this.THREE = T.THREE;
    this.center = new T.THREE.Vector3();
    this.bgColor = new T.THREE.Color(0x3c3f45);
    let name = '', maxTex = 16384;
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      maxTex = renderer.capabilities?.maxTextureSize ?? maxTex;
    } catch { /* fake or lost context: keep the defaults */ }
    const t = tierFor(name, maxTex);
    this.autoTier = opts.slotB ? tierBelow(t) : t;
  }

  // ---- quality ----
  private get tier(): Tier { return this.s.quality === 'auto' ? this.autoTier : this.s.quality; }
  private spec(): TierSpec {
    const base = TIERS[this.tier];
    if (this.s.quality !== 'auto' || !this.degraded.length) return base;
    const d = new Set(this.degraded);
    return { ...base, dprCap: d.has('dpr') ? 1 : base.dprCap, gtaoSamples: d.has('gtao-samples') ? 8 : base.gtaoSamples, pdSamples: d.has('gtao-samples') ? 8 : base.pdSamples, shadowMap: d.has('shadow-map') ? 1024 : base.shadowMap };
  }
  private effectiveDpr(): number {
    const dpr = this.size.dpr || 1;
    if (this.s.quality === 'auto' && this.degraded.includes('dpr')) return 1;
    return this.s.mode === 'rendered' ? Math.min(dpr, this.spec().dprCap) : Math.min(dpr, 2);
  }
  private shadowsWanted(): boolean {
    return this.s.mode === 'rendered' && !this.channelView && this.s.shadows && !this.degraded.includes('shadows-off') && !this.lightmapsShown;
  }
  private aoWanted(): boolean {
    return this.s.mode === 'rendered' && !this.channelView && this.s.ao && !this.degraded.includes('ao-off') && !this.lightmapsShown;
  }
  private aoActive(): boolean { return this.aoWanted() && !(this.interacting && !this.spec().aoWhileOrbit); }

  // ---- model ----
  /** New model: remember its meshes and materials, fit the shadow camera and the ground catcher. Call apply() next. */
  setModel(root: ThreeNS.Object3D, gltf: GLTF, box: ThreeNS.Box3, diag: number, extraTextures?: Set<ThreeNS.Texture>): void {
    this.clearModel();
    const { THREE } = this;
    this.root = root; this.gltf = gltf; this.extraTextures = extraTextures ?? null;
    this.diag = diag || 1;
    box.getCenter(this.center);
    this.radius = Math.max(1e-3, (box.getSize(new THREE.Vector3()).length() || 1) / 2);
    this.minY = box.min.y;
    const mats = new Set<Mat>();
    root.traverse((o) => {
      const m = o as ThreeNS.Mesh;
      if (!m.isMesh || m.userData.helper) return;
      this.meshes.push(m);
      if (!m.userData.origMat) m.userData.origMat = m.material;
      const src = asArr(m.userData.origMat as Mat | Mat[]);
      for (const mm of src) mats.add(mm);
      m.castShadow = !src.some((mm) => mm.transparent);
      m.receiveShadow = true;
    });
    this.originals = [...mats];
    for (const m of this.originals) {
      // baked AO (occlusion on TEXCOORD_1) is shown only by Rendered › Baked; authored AO (uv 0) always
      if (m.aoMap && m.aoMap.channel === 1) { m.userData.bakedAo = m.aoMap; }
    }
    this.fitGround();
    this.fitSun();
    this.appliedOnce = false;
  }
  /** Put the source materials back, dispose the twins, drop lightmaps and probes. The model itself is the viewer's to dispose. */
  clearModel(): void {
    for (const m of this.meshes) if (m.userData.origMat) m.material = m.userData.origMat as ThreeNS.Material | ThreeNS.Material[];
    for (const t of this.matcapTwins.values()) t.dispose();
    for (const t of this.flatTwins.values()) t.dispose();
    this.matcapTwins.clear(); this.flatTwins.clear();
    for (const m of this.originals) {
      if (m.userData.bakedAo) { m.aoMap = m.userData.bakedAo as ThreeNS.Texture; delete m.userData.bakedAo; }
    }
    this.lightmaps.clear();
    this.lightmapSeq++;
    this.lightmapsShown = 0;
    this.clearProbes();
    this.meshes = []; this.originals = []; this.root = null; this.gltf = null; this.extraTextures = null;
  }

  private fitGround(): void {
    const { THREE } = this;
    const s = Math.max(4, this.radius * 8);
    if (!this.ground) {
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.4 }));
      this.ground.rotation.x = -Math.PI / 2;
      this.ground.receiveShadow = true;
      this.ground.userData.helper = true;
      this.ground.visible = false;
      this.scene.add(this.ground);
    }
    this.ground.scale.set(s, s, 1);
    this.ground.position.set(this.center.x, this.minY - this.diag * 1e-4, this.center.z);
  }
  private fitSun(): void {
    const sun = this.sun;
    if (!sun) return;
    const d = sunDirection(this.s.sun, this.s.rotate), v = sunVector(d.azimuth, d.elevation), r = this.radius;
    sun.color.setHex(d.color);
    sun.intensity = d.intensity;
    sun.position.set(this.center.x + v.x * r * 3, this.center.y + v.y * r * 3, this.center.z + v.z * r * 3);
    sun.target.position.copy(this.center);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = -1.2 * r; cam.right = 1.2 * r; cam.top = 1.2 * r; cam.bottom = -1.2 * r;
    cam.near = 0.1; cam.far = 6 * r;
    cam.updateProjectionMatrix();
  }
  private ensureSun(): ThreeNS.DirectionalLight {
    if (!this.sun) {
      const sun = new this.THREE.DirectionalLight(0xffffff, 2);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
      sun.visible = false;
      this.scene.add(sun, sun.target);
      this.sun = sun;
      this.fitSun();
    }
    return this.sun;
  }
  private ensureStudio(): [ThreeNS.HemisphereLight, ThreeNS.DirectionalLight] {
    if (!this.studioLights) {
      // the legacy viewer's lights, unchanged (web/ui/viewers/model.js before the TS port)
      const hemi = new this.THREE.HemisphereLight(0xffffff, 0x445066, 1.6);
      const dir = new this.THREE.DirectionalLight(0xffffff, 1.8);
      dir.position.set(3, 6, 4);
      hemi.visible = dir.visible = false;
      this.scene.add(hemi, dir);
      this.studioLights = [hemi, dir];
    }
    return this.studioLights;
  }
  private ensureMatcap(): ThreeNS.CanvasTexture {
    if (!this.matcapTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const x = c.getContext('2d');
      if (x) drawMatcap(x, 256);
      const t = new this.THREE.CanvasTexture(c);
      t.colorSpace = this.THREE.SRGBColorSpace;
      this.matcapTex = t;
    }
    return this.matcapTex;
  }
  private ensureEnv(): ThreeNS.Texture | null {
    if (this.envRT) return this.envRT.texture;
    try {
      const pm = new this.THREE.PMREMGenerator(this.renderer);
      const room = new this.T.RoomEnv();
      this.envRT = pm.fromScene(room, 0.04);
      pm.dispose();
      room.dispose();
    } catch { this.envRT = null; }
    return this.envRT?.texture ?? null;
  }
  private twinFor(src: Mat, kind: 'matcap' | 'flat'): Twin {
    const { THREE } = this;
    const p = { map: src.map ?? null, vertexColors: src.vertexColors, side: src.side, transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest };
    if (kind === 'matcap') {
      let t = this.matcapTwins.get(src);
      if (!t) {
        t = new THREE.MeshMatcapMaterial({ ...p, matcap: this.ensureMatcap(), flatShading: false });
        if (src.color) t.color.copy(src.color);
        this.matcapTwins.set(src, t);
      }
      return t;
    }
    let t = this.flatTwins.get(src);
    if (!t) {
      t = new THREE.MeshBasicMaterial(p);
      if (src.color) t.color.copy(src.color);
      this.flatTwins.set(src, t);
    }
    return t;
  }
  /** Mesh materials for the current mode (channel views take precedence: nothing is swapped then). */
  private assign(): void {
    if (this.channelView) return;
    const kind = solidish(this.s.mode) && this.s.solidLight !== 'studio' ? this.s.solidLight : null;
    for (const m of this.meshes) {
      const src = m.userData.origMat as Mat | Mat[] | undefined;
      if (!src) continue;
      const want = kind ? (Array.isArray(src) ? src.map((x) => this.twinFor(x, kind)) : this.twinFor(src, kind)) : src;
      if (m.material !== want) m.material = want;
    }
    this.syncTwins();
  }
  /** Texture toggle, UV checker and wireframe on the twins. */
  private syncTwins(): void {
    for (const [src, t] of [...this.matcapTwins, ...this.flatTwins] as [Mat, Twin][]) {
      const map = this.s.texture || this.checker ? src.map ?? null : null;
      if (t.map !== map) { t.map = map; t.needsUpdate = true; }
      // MeshMatcapMaterial declares no `wireframe`, but WebGLRenderer honours the flag on every material
      (t as Twin & { wireframe?: boolean }).wireframe = this.wire;
    }
  }

  /** Idempotent: brings materials, lights, environment, background, shadows, baked maps and size in line with `settings`. */
  async apply(settings: ShadingSettings): Promise<void> {
    if (this.dead) return;
    const prev = this.s;
    this.s = { ...settings };
    if (prev.mode !== settings.mode || prev.quality !== settings.quality) { this.watch.reset(); }
    if (prev.quality !== settings.quality && settings.quality !== 'auto') this.degraded = this.degraded.filter((d) => d === 'solid-studio');
    const { THREE } = this;
    const mode = settings.mode;
    this.assign();
    // baked maps (Rendered only) before lights: a shown lightmap turns the sun and GTAO off
    await this.applyBaked();
    if (this.dead) return;
    // lights
    const studio = solidish(mode) && settings.solidLight === 'studio';
    if (studio || this.studioLights) { const [hemi, dir] = this.ensureStudio(); hemi.visible = dir.visible = studio && !this.channelView; }
    if (mode === 'rendered' || this.sun) { const sun = this.ensureSun(); sun.visible = mode === 'rendered' && !this.lightmapsShown && !this.channelView; this.fitSun(); }
    // environment + tone mapping
    const pbr = mode === 'material' || mode === 'rendered';
    const env = pbr ? this.ensureEnv() : null;
    this.scene.environment = env;
    this.scene.environmentIntensity = mode === 'rendered' ? 0.35 : 1;
    this.scene.environmentRotation.y = (settings.rotate * Math.PI) / 180;
    this.renderer.toneMapping = pbr ? THREE.NeutralToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    // background
    if (settings.bg === 'studio') this.scene.background = this.bgColor;
    else if (settings.bg === 'env' && env) {
      this.scene.background = env;
      this.scene.backgroundBlurriness = 0.6;
      this.scene.backgroundIntensity = 0.6;
      this.scene.backgroundRotation.y = (settings.rotate * Math.PI) / 180;
    } else this.scene.background = null;
    // shadows + ground
    this.applyShadows();
    if (this.ground) this.ground.visible = mode === 'rendered' && !this.channelView;
    if (this.probeGroup) this.probeGroup.visible = this.probesVisible && mode === 'rendered';
    // composer: idle outside Rendered + AO, released later
    if (!this.aoWanted()) this.scheduleRelease();
    else this.updateGtao();
    this.setSize(this.size.w, this.size.h, this.size.dpr);
    this.appliedOnce = true;
  }
  private applyShadows(): void {
    const want = this.shadowsWanted();
    const sun = this.sun;
    if (sun) {
      sun.castShadow = want;
      const size = this.spec().shadowMap;
      if (sun.shadow.mapSize.x !== size) { sun.shadow.map?.dispose(); sun.shadow.map = null; sun.shadow.mapSize.set(size, size); }
      if (!want && sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    if (want !== this.shadowsEnabled) {
      this.shadowsEnabled = want;
      this.renderer.shadowMap.enabled = want;
      this.renderer.shadowMap.type = this.THREE.PCFSoftShadowMap;
      this.renderer.shadowMap.needsUpdate = true;
      for (const m of this.originals) m.needsUpdate = true;
    }
  }
  private async applyBaked(): Promise<void> {
    const on = this.s.mode === 'rendered' && !this.channelView;
    const ao = on && this.s.baked !== 'off', lm = on && this.s.baked === 'ao+lightmap';
    for (const m of this.originals) {
      const baked = m.userData.bakedAo as ThreeNS.Texture | undefined;
      if (!baked) continue;
      const want = ao ? baked : null;
      if (m.aoMap !== want) { m.aoMap = want; m.aoMapIntensity = 1; m.needsUpdate = true; }
    }
    const seq = ++this.lightmapSeq;
    if (lm) {
      for (const m of this.originals) {
        if (this.lightmaps.has(m)) continue;
        const ex = m.userData.lightMap as LightmapExtras | undefined;
        let tex: ThreeNS.Texture | null = null;
        if (ex && Number.isInteger(ex.index) && this.gltf) {
          tex = await (this.gltf.parser.getDependency('texture', ex.index as number) as Promise<ThreeNS.Texture>).catch(() => null);
          if (seq !== this.lightmapSeq || this.dead) return;
          if (tex) { tex.channel = ex.texCoord ?? 1; tex.colorSpace = this.THREE.SRGBColorSpace; this.extraTextures?.add(tex); }
        }
        this.lightmaps.set(m, tex);
      }
    }
    let shown = 0;
    for (const m of this.originals) {
      const tex = lm ? this.lightmaps.get(m) ?? null : null;
      if (m.lightMap !== tex) {
        m.lightMap = tex;
        if (tex) m.lightMapIntensity = (m.userData.lightMap as LightmapExtras | undefined)?.intensity ?? 1;
        m.needsUpdate = true;
      }
    }
    if (lm) for (const mesh of this.meshes) if (asArr(mesh.userData.origMat as Mat | Mat[]).some((m) => m.lightMap)) shown++;
    this.lightmapsShown = shown;
  }

  /** Pixel ratio follows the tier in Rendered (legacy min(dpr, 2) elsewhere). */
  setSize(w: number, h: number, dpr: number): void {
    this.size = { w: Math.max(1, w), h: Math.max(1, h), dpr: dpr || 1 };
    const pr = this.effectiveDpr();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.size.w, this.size.h);
    if (this.composer) { this.composer.setPixelRatio(pr); this.composer.setSize(this.size.w, this.size.h); }
  }

  private ensureComposer(): EffectComposer {
    const spec = this.spec();
    if (this.composer && this.composerMsaa !== spec.msaa) this.releaseComposer();
    if (!this.composer) {
      const { THREE } = this;
      const pr = this.effectiveDpr(), { w, h } = this.size;
      const rt = new THREE.WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), { type: THREE.HalfFloatType, samples: spec.msaa });
      const c = new this.T.EffectComposer(this.renderer, rt);
      c.setPixelRatio(pr);
      c.setSize(w, h);
      this.renderPass = new this.T.RenderPass(this.scene, this.camera);
      this.gtao = new this.T.AOPass(this.scene, this.camera, w, h);
      this.gtao.output = this.T.AOPass.OUTPUT.Default;
      this.outputPass = new this.T.OutputPass();
      c.addPass(this.renderPass); c.addPass(this.gtao); c.addPass(this.outputPass);
      this.composer = c;
      this.composerMsaa = spec.msaa;
      this.gtaoKey = '';
    }
    this.updateGtao();
    return this.composer;
  }
  private updateGtao(): void {
    const g = this.gtao;
    if (!g) return;
    const spec = this.spec();
    const key = `${spec.gtaoSamples}/${spec.pdSamples}/${spec.pdRings}/${this.diag}`;
    if (key !== this.gtaoKey) {
      g.updateGtaoMaterial({ radius: 0.12 * this.diag, distanceFallOff: 1, thickness: 1, samples: spec.gtaoSamples });
      g.updatePdMaterial({ samples: spec.pdSamples, rings: spec.pdRings });
      this.gtaoKey = key;
    }
    g.blendIntensity = this.s.aoStrength;
  }
  private scheduleRelease(): void {
    if (!this.composer || this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.dead || !this.composer) return;
      if (!this.aoWanted() && nowMs() - this.composerUsed >= COMPOSER_IDLE_MS - 50) this.releaseComposer();
      else if (!this.aoWanted()) this.scheduleRelease();
    }, COMPOSER_IDLE_MS);
  }
  private releaseComposer(): void {
    this.gtao?.dispose();
    this.outputPass?.dispose();
    this.renderPass?.dispose();
    this.composer?.dispose();   // renderTarget1 (our MSAA target), renderTarget2 and the copy pass
    this.composer = null; this.gtao = null; this.outputPass = null; this.renderPass = null;
    this.composerMsaa = -1; this.gtaoKey = '';
  }

  /** Composer in Rendered with AO, else a plain render (the renderer's own MSAA and tone mapping apply). */
  render(): void {
    if (this.dead) return;
    if (this.aoActive()) {
      const c = this.ensureComposer();
      this.composerUsed = nowMs();
      c.render();
      return;
    }
    if (this.composer) this.scheduleRelease();
    this.renderer.render(this.scene, this.camera);
  }

  /** One frame interval (ms) from the viewer's FrameMeter; may step quality down once (auto only). */
  frameCost(ms: number): void {
    if (this.dead || this.s.quality !== 'auto') return;
    if (!this.watch.push(ms)) return;
    const spec = this.spec();
    const step = nextDegradeStep({
      mode: this.s.mode, dpr: this.effectiveDpr(), ao: this.aoWanted(), gtaoSamples: spec.gtaoSamples, shadows: this.shadowsWanted(), shadowMap: spec.shadowMap,
      canFallback: this.canFallback && !this.degraded.includes('solid-studio'),
    });
    if (!step) return;
    this.degraded.push(step);
    if (step === 'solid-studio') { this.opts.onDegrade?.(step); return; }
    this.applyShadows();
    this.updateGtao();
    if (!this.aoWanted()) this.scheduleRelease();
    this.setSize(this.size.w, this.size.h, this.size.dpr);
    this.opts.onDegrade?.(step);
  }

  /** While orbiting, Low turns AO off (back 150 ms after the controls' end; the viewer times that). */
  setInteracting(on: boolean): void { this.interacting = on; }
  /** A channel view (debug shader) overrides the shading mode: no swaps, no lights, no composer. */
  async setChannelView(on: boolean): Promise<void> {
    if (this.channelView === on) { if (!on) this.assign(); return; }
    this.channelView = on;
    if (this.appliedOnce) await this.apply(this.s);
  }
  /** Wireframe (overlay or mode) and UV checker state, mirrored onto the Solid twins. */
  setOverlay(wire: boolean, checker: boolean): void {
    this.wire = wire; this.checker = checker;
    this.syncTwins();
  }

  // ---- probes ----
  /** Probe helpers for an exported .glb whose meta has SH9 probes (drawn in Rendered when visible). */
  setProbes(data: ProbeData | null): number {
    this.clearProbes();
    if (!data || !this.T.LightProbeHelper) return 0;
    const { THREE } = this;
    const g = new THREE.Group();
    g.userData.helper = true;
    const sp = Array.isArray(data.spacing) ? Math.min(...data.spacing) : data.spacing;
    const size = Math.max(1e-3, (sp || this.diag * 0.1) * 0.15);
    for (const p of probePositions(data)) {
      const c = probeCoeffs(data.coefficients, p.i);
      if (!c) continue;
      const probe = new THREE.LightProbe(new THREE.SphericalHarmonics3().fromArray(c), Math.PI);
      const hp = new this.T.LightProbeHelper(probe, size);
      hp.position.set(p.x, p.y, p.z);
      hp.castShadow = false;
      hp.userData.helper = true;
      g.add(hp);
      this.probeHelpers.push(hp);
    }
    g.visible = this.probesVisible && this.s.mode === 'rendered';
    this.scene.add(g);
    this.probeGroup = g;
    return this.probeHelpers.length;
  }
  showProbes(on: boolean): void {
    this.probesVisible = on;
    if (this.probeGroup) this.probeGroup.visible = on && this.s.mode === 'rendered';
  }
  private clearProbes(): void {
    for (const hp of this.probeHelpers) hp.dispose();
    this.probeHelpers = [];
    if (this.probeGroup) { this.scene.remove(this.probeGroup); this.probeGroup = null; }
  }

  /** After a WebGL context restore: render targets are gone, rebuild them on next use. */
  resetGpu(): void {
    this.releaseComposer();
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    this.appliedOnce = false;
  }

  info(): ShadingInfo {
    const spec = this.spec();
    let lights = 0;
    if (this.studioLights) for (const l of this.studioLights) if (l.visible) lights++;
    if (this.sun?.visible) lights++;
    return {
      mode: this.s.mode, solidLight: this.s.solidLight, tier: this.tier, auto: this.s.quality === 'auto', shadowMap: spec.shadowMap, gtaoSamples: spec.gtaoSamples,
      composer: !!this.composer && this.aoActive(), degraded: this.degraded.map((d) => DEGRADE_REASONS[d]),
      environment: !!this.scene.environment, toneMapping: this.renderer.toneMapping === this.THREE.NeutralToneMapping ? 'Neutral' : 'None', lights,
      shadows: this.shadowsWanted(), ao: this.aoWanted(), dpr: this.effectiveDpr(),
      lightmaps: this.lightmapsShown, withoutLightmap: this.lightmapsShown ? this.meshes.length - this.lightmapsShown : 0,
      bakedAo: this.originals.filter((m) => m.userData.bakedAo && m.aoMap).length, probes: this.probeHelpers.length, channelView: this.channelView,
    };
  }
  get settings(): Readonly<ShadingSettings> { return this.s; }

  dispose(): void {
    if (this.dead) return;
    this.clearModel();
    this.dead = true;
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    this.releaseComposer();
    this.matcapTex?.dispose(); this.matcapTex = null;
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    this.scene.environment = null;
    this.scene.background = null;
    if (this.sun) {
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.sun.dispose();
      this.scene.remove(this.sun, this.sun.target);
      this.sun = null;
    }
    if (this.studioLights) { for (const l of this.studioLights) { l.dispose(); this.scene.remove(l); } this.studioLights = null; }
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose(); this.ground.material.dispose(); this.ground = null; }
    if (this.shadowsEnabled) { this.renderer.shadowMap.enabled = false; this.shadowsEnabled = false; }
  }
}
