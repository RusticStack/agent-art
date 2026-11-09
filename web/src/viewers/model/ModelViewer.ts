// 3D model viewer: the model's in-memory .glb from the server (same scene as art_model export), an
// exported .glb, or a model snapshot. Orbit (mouse, or arrow keys / + - on the focused canvas),
// wireframe, clusters, vertex normals, UV checker, sockets and pivots, grid, clips, triangle / node
// stats, and a channel dropdown (chanSel; materials v2) that reloads the .glb with profile=three (and a
// quick bake for the TEXCOORD_1 channels). three.js comes from the lazy chunk (./three). Renders on
// demand. Without WebGL, or when the chunk fails to load, it shows the server's software preview.
// Viewport shading (plan 5.7b, ./shading): Wireframe / Solid / Material preview / Rendered from the
// second toolbar row, keys 1-4 and the Z pie; view presets (numpad), axis gizmo, Overlays, turntable.
import type * as ThreeNS from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import type { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import type { AnyEvent, ModelInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getArrayBuffer, getJSON, isAbort } from '@/lib/api/http';
import { exportFile, modelThumb } from '@/lib/api/urls';
import { h, icon } from '@/lib/util/dom';
import type { IconName } from '@/lib/util/icons';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, link, range, select, spacer, toggle } from '../controls';
import type { Target } from '../types';
import { CHANNELS, CHANNEL_IDS, channelNote, downloadHref, downloadName, fallbackColor, glbUrl, isChannel, loadedNeed, needOf, needsReload, type ChannelId, type Need } from './channels';
import type { NodeLike } from './dispose';
import type { PieHandle } from './pie';
import {
  BACKGROUNDS, BAKED, BAKED_LABELS, BG_LABELS, FrameMeter, MODES, MODE_LABELS, QUALITIES, QUALITY_LABELS, SOLID_LABELS, SOLID_LIGHTS,
  loadSettings, needFor, saveSettings, shadingNote, type DegradeStep, type ProbeData, type ShadingMode, type ShadingSettings,
} from './shading';
import type * as ThreeSide from './shadingRig';
type ShadingRig = ThreeSide.ShadingRig;
import { clampDt, orbitKey, orbitOffset, statusLine, usesCanvas } from './status';
import { loadThree, resetThree, type ThreeBundle } from './three';
import { VIEW_LABELS, VIEW_PRESETS, easeInOut, frameDistance, fromSpherical, isPreset, lerpSpherical, opposite, presetAngles, toSpherical, viewKey, wrapPi, type Spherical, type ViewPreset } from './views';

type MapMaterial = ThreeNS.Material & { map?: ThreeNS.Texture | null };
type StdMaterial = ThreeNS.Material & { map?: ThreeNS.Texture | null; color?: ThreeNS.Color; emissive?: ThreeNS.Color; emissiveIntensity?: number; metalness?: number; roughness?: number };
interface Socket { o: ThreeNS.Object3D; ax: ThreeNS.AxesHelper; name: string }
interface Pivot { o: ThreeNS.Object3D; m: ThreeNS.Mesh; ax: ThreeNS.AxesHelper; name: string }
interface Tween { from: Spherical; to: Spherical; fromTarget: ThreeNS.Vector3; toTarget: ThreeNS.Vector3; start: number; dur: number }

const CLEAR = 0x15171c;
/** The axis gizmo's corner (ViewHelper draws 128 × 128 px at the bottom right). */
const GIZMO = 128;
const MODE_ICONS: Record<ShadingMode, IconName> = { wire: 'box', solid: 'circle', material: 'circle-dot', rendered: 'sun' };
const nameOf = (t: Target): string => ('name' in t ? t.name : '');
const msgOf = (e: unknown): string => (e as Error)?.message || String(e);
const asNode = (o: ThreeNS.Object3D): NodeLike => o as unknown as NodeLike;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const hhmm = (t: number): string => `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.round((t % 1) * 60)).padStart(2, '0')}`;

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
  // shading (plan 5.7b)
  private rig: ShadingRig | null = null;
  /** The three-side modules (shading rig, clusters, disposal): loaded with three, shipped in its chunk. */
  private side: typeof ThreeSide | null = null;
  private settings!: ShadingSettings;
  private explicitMode = false;
  private meter = new FrameMeter();
  private viewHelper: ViewHelper | null = null;
  private tween: Tween | null = null;
  private lastPreset: ViewPreset | null = null;
  private overlays = true;
  private turntable = false;
  private pie: PieHandle | null = null;
  private pointer: { x: number; y: number } | null = null;
  private probeCount = 0;
  private loading = false;
  private reloadPending = false;
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
  private rootEl!: HTMLElement;
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
  // DOM: shading row
  private modeGroup!: HTMLElement;
  private modeBtns = new Map<ShadingMode, HTMLButtonElement>();
  private shadeGroups: { el: HTMLElement; modes: readonly ShadingMode[] }[] = [];
  private lightSel!: HTMLSelectElement;
  private texCb!: HTMLInputElement;
  private sunIn!: HTMLInputElement;
  private sunOut!: HTMLElement;
  private rotIn!: HTMLInputElement;
  private shadowCb!: HTMLInputElement;
  private aoCb!: HTMLInputElement;
  private aoIn!: HTMLInputElement;
  private bakedSel!: HTMLSelectElement;
  private probesCb!: HTMLInputElement;
  private probesEl!: HTMLElement;
  private bgSel!: HTMLSelectElement;
  private qualSel!: HTMLSelectElement;
  private viewSel!: HTMLSelectElement;
  private ttBtn!: HTMLButtonElement;
  private ovCb!: HTMLInputElement;

  protected key(t: Target): string {
    return JSON.stringify([t.kind, nameOf(t), t.kind === 'model' ? t.snap ?? null : null]);
  }

  // ---- DOM ----
  protected build(): HTMLElement {
    const st = loadSettings();
    this.settings = st.settings;
    this.explicitMode = st.explicitMode;
    const root = h('div', { class: 'viewer model-viewer' });
    this.rootEl = root;
    const cb = (lbl: string, title: string, checked = false) => toggle({ label: lbl, title, checked, onChange: () => this.applyToggles() });
    const w = cb('Wireframe', 'Wireframe overlay (W)'), c = cb('Clusters', 'Colour ~128-triangle clusters (spatially ordered meshlets, like art_model cluster_lod)');
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
    root.append(this.buildShadingRow());
    this.stage = h('div', { class: 'model-stage' });
    this.labels = h('div', { class: 'model-labels' });
    this.stage.append(this.labels);
    root.append(this.stage);
    this.statusText = h('span');
    this.retryBtn = button({ text: 'Retry', small: true, title: 'Load the 3D viewer again', onClick: () => this.retry() });
    this.retryBtn.hidden = true;
    root.append(h('div', { class: 'vstatus mono' }, this.statusText, this.retryBtn));
    this.addCleanup(() => { this.fetchAbort?.abort(); this.fetchAbort = null; });
    this.addCleanup(() => this.closePie());
    this.syncShadingUI();
    return root;
  }

  /** Second toolbar row: shading mode radio group + the controls of the current mode (others hidden). */
  private buildShadingRow(): HTMLElement {
    const s = this.settings;
    const row = h('div', { class: 'vtoolbar shading', role: 'toolbar', 'aria-label': 'Viewport shading' });
    this.modeGroup = h('div', { class: 'group seg shading-modes', role: 'radiogroup', 'aria-label': 'Shading mode', on: { keydown: (e: KeyboardEvent) => this.modeKeys(e) } });
    MODES.forEach((m, i) => {
      const b = h('button', {
        type: 'button', class: 'btn icon', role: 'radio', 'aria-label': MODE_LABELS[m], title: `${MODE_LABELS[m]} (${i + 1})`, dataset: { mode: m },
        on: { click: () => this.setMode(m) },
      }, icon(MODE_ICONS[m]));
      this.modeBtns.set(m, b);
      this.modeGroup.append(b);
    });
    const add = (el: HTMLElement, modes: readonly ShadingMode[]) => { this.shadeGroups.push({ el, modes }); return el; };
    // Solid
    this.lightSel = select({ title: 'Solid lighting: MatCap (studio sphere), Studio (the classic lights), Flat (unlit texture colours)', onChange: (v) => this.set({ solidLight: SOLID_LIGHTS.find((x) => x === v) ?? 'matcap' }) });
    fillSelect(this.lightSel, SOLID_LIGHTS.map((v) => ({ value: v, label: SOLID_LABELS[v] })));
    const tex = toggle({ label: 'Texture', title: 'Show the model textures in MatCap / Flat (off = plain clay)', checked: s.texture, onChange: (on) => this.set({ texture: on }) });
    this.texCb = tex.input;
    // Rendered / Material
    this.sunOut = h('span', { class: 'mono sun-time' });
    this.sunIn = range({ min: 6, max: 18, step: 0.25, value: s.sun, title: 'Sun: time of day', onInput: (v) => this.set({ sun: v }) });
    this.rotIn = range({ min: 0, max: 360, step: 1, value: s.rotate, title: 'Rotate the sun and the environment (also Shift + drag on the view)', onInput: (v) => this.set({ rotate: v }) });
    const sh = toggle({ label: 'Shadows', title: 'Real-time sun shadows on a ground catcher', checked: s.shadows, onChange: (on) => this.set({ shadows: on }) });
    this.shadowCb = sh.input;
    const ao = toggle({ label: 'AO', title: 'Ambient occlusion (GTAO)', checked: s.ao, onChange: (on) => this.set({ ao: on }) });
    this.aoCb = ao.input;
    this.aoIn = range({ min: 0, max: 1.5, step: 0.05, value: s.aoStrength, title: 'AO strength', onInput: (v) => this.set({ aoStrength: v }) });
    this.bakedSel = select({ title: 'Baked lighting: AO / lightmap from a quick bake (workspace models) or what the exported file contains', onChange: (v) => this.set({ baked: BAKED.find((x) => x === v) ?? 'off' }) });
    fillSelect(this.bakedSel, BAKED.map((v) => ({ value: v, label: BAKED_LABELS[v] })));
    const pr = toggle({ label: 'Probes', title: 'SH9 light probes of this export (spheres shaded by each probe)', onChange: (on) => { this.rig?.showProbes(on); this.requestRender(); } });
    this.probesCb = pr.input; this.probesEl = pr.el; this.probesEl.hidden = true;
    this.qualSel = select({ title: 'Quality: Auto starts Low on integrated / software GPUs and steps down under load', onChange: (v) => this.set({ quality: QUALITIES.find((x) => x === v) ?? 'auto' }) });
    fillSelect(this.qualSel, QUALITIES.map((v) => ({ value: v, label: QUALITY_LABELS[v] })));
    // every mode
    this.bgSel = select({ title: 'Background', onChange: (v) => this.set({ bg: BACKGROUNDS.find((x) => x === v) ?? 'dark' }) });
    fillSelect(this.bgSel, BACKGROUNDS.map((v) => ({ value: v, label: BG_LABELS[v] })));
    this.viewSel = select({ title: 'View: Numpad 1 front, 3 right, 7 top, 9 opposite, . or Home frame', onChange: (v) => { this.viewSel.value = ''; if (v) this.viewCmd(v === 'frame' ? 'frame' : isPreset(v) ? v : 'frame'); } });
    fillSelect(this.viewSel, [...VIEW_PRESETS, 'frame' as const].map((v) => ({ value: v, label: VIEW_LABELS[v] })), { first: { value: '', label: 'View…' } });
    this.ttBtn = button({ text: 'Turntable', title: 'Turntable (stops on a click in the view)', onClick: () => this.setTurntable(!this.turntable) });
    this.ttBtn.setAttribute('aria-pressed', 'false');
    const ov = toggle({ label: 'Overlays', title: 'Grid, sockets, pivots, normals, labels and the axis gizmo (their own toggles are kept)', checked: true, onChange: (on) => { this.overlays = on; this.applyToggles(); } });
    this.ovCb = ov.input;
    const all = MODES, solid: ShadingMode[] = ['wire', 'solid'], rendered: ShadingMode[] = ['rendered'], pbr: ShadingMode[] = ['material', 'rendered'];
    row.append(
      this.modeGroup,
      add(group(label('Lighting'), this.lightSel, tex.el), solid),
      add(group(label('Sun'), this.sunIn, this.sunOut), rendered),
      add(group(label('Rotate'), this.rotIn), pbr),
      add(group(sh.el, ao.el, this.aoIn), rendered),
      add(group(label('Baked'), this.bakedSel, pr.el), rendered),
      add(group(label('Quality'), this.qualSel), rendered),
      add(group(label('Background'), this.bgSel), all),
      add(group(this.viewSel, this.ttBtn, ov.el), all),
    );
    return row;
  }
  /** Reflect the settings in the shading row (checked radio, values, which groups show). */
  private syncShadingUI(): void {
    const s = this.settings;
    for (const [m, b] of this.modeBtns) {
      const on = m === s.mode;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
      b.tabIndex = on ? 0 : -1;
    }
    for (const g of this.shadeGroups) g.el.hidden = !g.modes.includes(s.mode);
    this.lightSel.value = s.solidLight;
    this.texCb.checked = s.texture;
    this.sunIn.value = String(s.sun);
    this.sunOut.textContent = hhmm(s.sun);
    this.rotIn.value = String(s.rotate);
    this.shadowCb.checked = s.shadows;
    this.aoCb.checked = s.ao;
    this.aoIn.value = String(s.aoStrength);
    this.aoIn.hidden = !s.ao;
    this.bakedSel.value = s.baked;
    this.bgSel.value = s.bg;
    const envOpt = [...this.bgSel.options].find((o) => o.value === 'env');
    if (envOpt) envOpt.hidden = !(s.mode === 'material' || s.mode === 'rendered');
    this.qualSel.value = s.quality;
    this.probesEl.hidden = !this.probeCount;
    this.rootEl.dataset.shadingMode = s.mode;
  }
  /** Roving focus in the mode radio group: arrows move and select. */
  private modeKeys(e: KeyboardEvent): void {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    const next = MODES[(MODES.indexOf(this.settings.mode) + d + MODES.length) % MODES.length];
    this.setMode(next);
    this.modeBtns.get(next)?.focus();
  }

  private setStatus(text: string): void { this.statusText.textContent = text; }
  /** Base stats · channel note · shading note. */
  private updateStatus(): void {
    if (!this.statusBase) return;
    const info = this.rig?.info();
    if (info) { this.rootEl.dataset.qualityTier = info.tier; this.rootEl.dataset.composer = String(info.composer); }
    this.setStatus([this.statusBase, this.chanNote, info ? shadingNote(info) : ''].filter(Boolean).join(' · '));
  }
  private setPlaying(on: boolean): void {
    this.playing = on;
    this.playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
    this.playBtn.setAttribute('aria-pressed', String(on));
    this.requestRender();
  }

  // ---- shading settings ----
  setMode(mode: ShadingMode): void {
    this.explicitMode = true;
    if (this.rig) this.rig.canFallback = false;
    this.set({ mode });
  }
  /** Change settings (persisted unless told otherwise), update the row, re-apply the rig (reloading a richer GLB when needed). */
  private set(patch: Partial<ShadingSettings>, persist = true): void {
    this.settings = { ...this.settings, ...patch };
    if (persist) saveSettings(this.settings);
    this.syncShadingUI();
    void this.applyShading().catch(() => {});
  }
  private async applyShading(): Promise<void> {
    if (!this.rig || !this.model) return;
    if (needsReload(this.target, needFor(this.settings, this.chanSel.value), this.loaded)) { await this.open(true); return; }
    await this.rig.apply(this.settings);
    this.applyToggles();
    this.updateStatus();
  }
  private onDegrade(step: DegradeStep): void {
    if (step === 'solid-studio') { this.set({ mode: 'solid', solidLight: 'studio' }, false); return; }
    this.updateStatus();
    this.requestRender();
  }
  private setTurntable(on: boolean): void {
    this.turntable = on;
    this.ttBtn.setAttribute('aria-pressed', String(on));
    this.ttBtn.classList.toggle('active', on);
    if (this.renderer) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = 5; }
    this.requestRender();
  }

  // ---- three / renderer ----
  private async init(): Promise<boolean> {
    if (this.renderer) return true;
    if (this.failed) return false;
    let T: ThreeBundle;
    let side: typeof ThreeSide;
    // the shading rig ships in the lazy three chunk (it only runs with three loaded)
    try { [T, side] = await Promise.all([loadThree(), import('./shadingRig')]); } catch (e) {
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
      this.rig?.resetGpu();
      this.setStatus(this.statusBase || 'Restoring…');
      void this.open(true).catch(() => {});
    }, { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.requestRender(); }, { signal });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.controls = new Orbit(this.camera, cv);
    this.controls.enableDamping = true;
    this.controls.autoRotate = this.turntable;
    this.controls.autoRotateSpeed = 5;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => { this.cancelLater('aoBack'); this.rig?.setInteracting(true); });
    this.controls.addEventListener('end', () => this.later(150, () => { this.rig?.setInteracting(false); this.requestRender(); }, 'aoBack'));
    this.clock = new THREE.Clock();
    this.checker = checkerTexture(THREE);
    // lights, environment, shadows, post-processing: the shading rig (Solid › Studio holds the legacy lights)
    this.side = side;
    this.rig = new side.ShadingRig(T, renderer, this.scene, this.camera, { slotB: this.host.slot === 'B', onDegrade: (s) => this.onDegrade(s) });
    this.rig.canFallback = !this.explicitMode && this.settings.mode === 'material';
    try {
      const vh = new T.ViewHelper(this.camera, cv);
      vh.center = this.controls.target;
      this.viewHelper = vh;
    } catch { this.viewHelper = null; }
    this.stageInput(signal);
    this.addCleanup(() => this.teardown());
    this.onResize(this.stage, () => this.resize());
    this.onDprChange(() => this.resize());
    this.resize();
    return true;
  }
  /** Stage pointer handling: turntable stop, Shift + drag rotate, gizmo clicks, pointer position for the pie. */
  private stageInput(signal: AbortSignal): void {
    let down: { x: number; y: number; gizmo: boolean } | null = null;
    let rot: { x: number; rotate: number; id: number } | null = null;
    const local = (e: PointerEvent) => { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    this.stage.addEventListener('pointerdown', (e) => {
      if (!(e.target instanceof HTMLCanvasElement)) return;
      if (this.turntable) this.setTurntable(false);
      const p = local(e);
      down = { x: e.clientX, y: e.clientY, gizmo: this.overlays && !!this.viewHelper && p.x >= p.w - GIZMO && p.y >= p.h - GIZMO };
      if (e.shiftKey && e.button === 0 && (this.settings.mode === 'material' || this.settings.mode === 'rendered')) {
        rot = { x: e.clientX, rotate: this.settings.rotate, id: e.pointerId };
        this.controls.enabled = false;
        e.stopPropagation();
      }
    }, { signal, capture: true });
    window.addEventListener('pointermove', (e) => {
      if (!rot || e.pointerId !== rot.id) return;
      const v = Math.round((((rot.rotate + (e.clientX - rot.x) * 0.5) % 360) + 360) % 360);
      if (v !== this.settings.rotate) this.set({ rotate: v }, false);
    }, { signal });
    window.addEventListener('pointerup', (e) => {
      if (rot && e.pointerId === rot.id) { rot = null; this.controls.enabled = !this.tween; saveSettings(this.settings); }
      const d = down;
      down = null;
      if (d?.gizmo && this.viewHelper && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4 && this.viewHelper.handleClick(e)) {
        this.lastPreset = null;
        this.requestRender();
      }
    }, { signal });
    this.stage.addEventListener('pointermove', (e) => { const p = local(e); this.pointer = { x: p.x, y: p.y }; }, { signal });
    this.stage.addEventListener('pointerleave', () => { this.pointer = null; }, { signal });
  }
  private teardown(): void {
    this.loopStop?.();
    this.loopStop = null;
    this.clearModel();
    this.rig?.dispose();
    this.rig = null;
    this.viewHelper?.dispose();
    this.viewHelper = null;
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
    if (this.rig) this.rig.setSize(w, hh, window.devicePixelRatio || 1);
    else this.renderer.setSize(w, hh);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // ---- render on demand ----
  private requestRender(): void {
    this.needsRender = true;
    if (!this.loopStop && this.renderer && !this.dead && !this.contextLost && !(typeof document !== 'undefined' && document.hidden)) this.loopStop = this.animate((t) => this.tick(t));
  }
  /** One rAF loop: renders only when something changed, a clip / tween / turntable runs or damping settles; stops while hidden. */
  private tick(t: number): boolean {
    if (!this.renderer || document.hidden || this.contextLost) { this.loopStop = null; this.meter.reset(); return false; }
    const dt = clampDt(this.clock.getDelta());
    if (this.mixer && this.playing) { this.mixer.update(dt); this.needsRender = true; }
    if (this.tween) { this.stepTween(); this.needsRender = true; }
    const vh = this.viewHelper;
    if (vh?.animating) {
      vh.update(dt);
      this.needsRender = true;
      if (!vh.animating) this.controls.update();
    }
    // during a view tween the camera is placed directly (no damping residue from an earlier drag)
    if (!this.tween && this.controls.update()) this.needsRender = true;
    const ms = this.meter.sample(t, this.needsRender, !document.hidden);
    if (ms !== null) this.rig?.frameCost(ms);
    if (!this.needsRender) return true;
    this.needsRender = false;
    for (const hh of this.normalHelpers || []) hh.update();
    if (this.rig) this.rig.render(); else this.renderer.render(this.scene, this.camera);
    if (vh && this.overlays && this.model) {
      const r = this.renderer;
      r.autoClear = false;
      vh.render(r);
      r.autoClear = true;
    }
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
    this.loading = true;
    try { await this.openInner(token, keepCam); } finally {
      if (this.isCurrent(token)) {
        this.loading = false;
        if (this.reloadPending) { this.reloadPending = false; this.reload(); }
      }
    }
  }
  private async openInner(token: number, keepCam: boolean): Promise<void> {
    const t = this.target, name = nameOf(t);
    const ch = this.chanSel.value, need = needFor(this.settings, ch);
    const url = glbUrl(t, need);
    this.glbA.href = downloadHref(glbUrl(t, needOf(ch)));
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
    if (!this.isCurrent(token)) { this.side?.disposeModel(asNode(gltf.scene)); return; }
    this.loaded = loadedNeed(t, need);
    this.setModel(gltf, buf.byteLength, keepCam);
    await this.rig?.apply(this.settings);
    if (!this.isCurrent(token)) return;
    await this.applyChannel();
    if (t.kind === 'export' && /\.glb$/i.test(name)) void this.loadProbes(name, ac.signal, token);
  }
  /** Live-reload: never starts while a load is in flight (the latest request runs when it lands). */
  private reload(): void {
    if (this.loading) { this.reloadPending = true; return; }
    void this.open(true).catch(() => {});
  }
  /** SH9 probes of an exported .glb: `<base>.meta.json` → probes (inline, or the `<base>.probes.json` side file). */
  private async loadProbes(path: string, signal: AbortSignal, token: number): Promise<void> {
    try {
      const meta = await getJSON<{ probes?: ProbeData }>(exportFile(path.replace(/\.glb$/i, '.meta.json')), { signal });
      let p = meta?.probes ?? null;
      if (p && !p.coefficients && p.file) {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const side = await getJSON<{ coefficients?: number[] | number[][] }>(exportFile(dir + p.file), { signal });
        p = { ...p, coefficients: side.coefficients };
      }
      if (!this.isCurrent(token) || !this.rig || !p) return;
      this.probeCount = this.rig.setProbes(p);
      this.rig.showProbes(this.probesCb.checked);
    } catch { if (this.isCurrent(token)) this.probeCount = 0; }
    this.syncShadingUI();
    this.updateStatus();
    this.requestRender();
  }

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
        m.renderOrder = 11; m.userData.helper = true; m.castShadow = false;
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
    this.rig?.setModel(model, gltf, box, diag, this.depTextures);
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
    this.updateStatus();
    this.requestRender();
  }

  /** Remove and dispose the current model with everything built for it. */
  private clearModel(): void {
    const model = this.model;
    this.restoreChannel();
    this.rig?.clearModel();
    this.probeCount = 0;
    this.applyClusters(false);
    this.disposeNormals();
    if (this.grid) { this.scene.remove(this.grid); this.grid.dispose(); this.grid = null; }
    if (this.mixer && model) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(model); }
    this.mixer = null;
    this.playing = false;
    if (model) {
      this.scene.remove(model);
      this.side?.disposeModel(asNode(model), this.depTextures, new Set([this.checker]));
    }
    this.depTextures.clear();
    this.model = null; this.gltf = null; this.box = null;
    this.materials = []; this.sockets = []; this.pivots = [];
    this.labels.replaceChildren();
    this.labelEls = [];
  }

  frameCamera(): void {
    if (!this.box || !this.T) return;
    this.endTween();
    const c = this.box.getCenter(new this.T.THREE.Vector3());
    const d = this.diag;
    this.camera.near = d / 200; this.camera.far = d * 200; this.camera.updateProjectionMatrix();
    this.camera.position.set(c.x + d * 0.9, c.y + d * 0.6, c.z + d * 1.1);
    this.controls.target.copy(c);
    this.controls.update();
    this.lastPreset = null;
    this.requestRender();
  }

  // ---- view presets (numpad / View select / gizmo) ----
  private viewCmd(cmd: ViewPreset | 'opposite' | 'frame'): void {
    if (!this.box || !this.T) return;
    const tg = this.controls.target, p = this.camera.position;
    const cur = toSpherical({ x: p.x - tg.x, y: p.y - tg.y, z: p.z - tg.z });
    if (cmd === 'frame') {
      const sphere = this.box.getBoundingSphere(new this.T.THREE.Sphere());
      const dist = frameDistance(sphere.radius, this.camera.fov, this.camera.aspect) * 1.05;
      this.flyTo({ ...cur, radius: dist }, sphere.center);
      return;
    }
    const name = cmd === 'opposite' ? opposite(this.lastPreset ?? this.nearestPreset(cur)) : cmd;
    this.lastPreset = name;
    this.flyTo({ ...presetAngles(name), radius: cur.radius }, null);
  }
  private nearestPreset(s: Spherical): ViewPreset {
    if (s.polar < Math.PI / 4) return 'top';
    if (s.polar > (3 * Math.PI) / 4) return 'bottom';
    let best: ViewPreset = 'front', bd = Infinity;
    for (const v of ['front', 'back', 'right', 'left'] as ViewPreset[]) { const d = Math.abs(wrapPi(presetAngles(v).azimuth - s.azimuth)); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  /** Move the camera to a spherical offset around the (new) target in 200 ms (0 with reduced motion). */
  private flyTo(to: Spherical, target: ThreeNS.Vector3 | null): void {
    const tg = this.controls.target, p = this.camera.position;
    const from = toSpherical({ x: p.x - tg.x, y: p.y - tg.y, z: p.z - tg.z });
    this.tween = { from, to, fromTarget: tg.clone(), toTarget: (target ?? tg).clone(), start: performance.now(), dur: reducedMotion() ? 0 : 200 };
    this.controls.enabled = false;
    this.stepTween();
    this.requestRender();
  }
  private stepTween(): void {
    const tw = this.tween;
    if (!tw) return;
    const k = tw.dur > 0 ? Math.min(1, (performance.now() - tw.start) / tw.dur) : 1;
    const e = easeInOut(k);
    const s = lerpSpherical(tw.from, tw.to, e);
    this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    const o = fromSpherical(s), tg = this.controls.target;
    this.camera.position.set(tg.x + o.x, tg.y + o.y, tg.z + o.z);
    this.camera.lookAt(tg);
    if (k >= 1) { this.endTween(); this.controls.update(); }
  }
  private endTween(): void {
    if (!this.tween) return;
    this.tween = null;
    this.controls.enabled = true;
  }

  // ---- channels ----
  /** Channel dropdown: reload when the channel needs a richer .glb, else swap the materials. */
  private async setChannel(): Promise<void> {
    if (needsReload(this.target, needFor(this.settings, this.chanSel.value), this.loaded)) { await this.open(true); return; }
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
          // AO channel: the baked occlusion map is held aside by the shading rig while Baked is off
          if (src === 'aoMap' && !tex && m.userData.bakedAo) tex = m.userData.bakedAo as ThreeNS.Texture;
          if (tex) uv1 = tex.channel === 1;
        }
        if (src === 'emissiveMap' && m.emissive) color = m.emissive.clone().multiplyScalar(Math.min(1, m.emissiveIntensity || 1));
        if (!tex && mode === 0) {
          missing++;
          const rgb = fallbackColor(ch, src, { metalness: m.metalness, roughness: m.roughness, color: m.color ? [m.color.r, m.color.g, m.color.b] : null });
          color = new THREE.Color(rgb[0], rgb[1], rgb[2]);
        }
        const mat = new THREE.RawShaderMaterial({
          vertexShader: this.side!.VS, fragmentShader: this.side!.FS, side: m.side, wireframe: this.wireOn(),
          uniforms: {
            map: { value: tex }, useMap: { value: tex ? 1 : 0 }, useUv1: { value: uv1 ? 1 : 0 }, mode: { value: mode },
            swz: { value: this.side!.SWIZZLE[spec.swizzle ?? 'rgb'] }, toSrgb: { value: tex && tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0 }, color: { value: color }, scale: { value: scale },
          },
        });
        built.push([o, mat]);
      }
    }
    if (stale()) { for (const [, mm] of built) mm.dispose(); return; }
    this.restoreChannel();
    for (const [o, mm] of built) { o.material = mm; this.channelMats.push(mm); }
    this.modeGroup.classList.toggle('dimmed', ch !== 'lit');
    if (ch !== 'lit') this.modeGroup.title = 'Channel view active'; else this.modeGroup.removeAttribute('title');
    this.chanNote = channelNote(ch, missing);
    this.updateStatus();
    this.requestRender();
    await this.rig?.setChannelView(ch !== 'lit');
    if (stale()) return;
    this.updateStatus();
    this.requestRender();
  }

  // ---- toggles ----
  /** Wireframe: the overlay checkbox (W) or the Wireframe shading mode. */
  private wireOn(): boolean { return this.wireCb.checked || this.settings.mode === 'wire'; }
  private applyToggles(): void {
    const model = this.model, T = this.T;
    if (!model || !T) return;
    const wire = this.wireOn(), ov = this.overlays;
    for (const m of this.channelMats) m.wireframe = wire;
    for (const m of this.materials) {
      (m as ThreeNS.Material & { wireframe?: boolean }).wireframe = wire;
      const want = this.uvCb.checked ? this.checker : (m.userData.origMap as ThreeNS.Texture | null);
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
    }
    this.rig?.setOverlay(wire, this.uvCb.checked);
    for (const s of this.sockets) s.ax.visible = ov && this.sockCb.checked;
    for (const p of this.pivots) { p.m.visible = ov && this.pivCb.checked; p.ax.visible = ov && this.pivCb.checked; }
    if (this.grid) this.grid.visible = ov && this.gridCb.checked;
    this.applyClusters(this.clusCb.checked);
    if (this.normCb.checked && !this.normalHelpers) {
      const helpers: VertexNormalsHelper[] = [];
      for (const o of this.meshes()) { const hh = new T.VertexNormalsHelper(o, this.diag * 0.03, 0x22c55e); this.scene.add(hh); helpers.push(hh); }
      this.normalHelpers = helpers;
    } else if (!this.normCb.checked) this.disposeNormals();
    for (const hh of this.normalHelpers || []) hh.visible = ov;
    this.labels.hidden = !ov;
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
      this.side?.disposeObject(asNode(this.clusterGroup));
      this.clusterGroup = null;
      this.clusterFor = null;
    }
    if (!this.model || !this.T) return;
    if (on && !this.clusterGroup) {
      const { group: grp } = this.side!.buildClusters(this.T.THREE, this.model, this.wireOn());
      this.clusterGroup = grp; this.clusterFor = this.model;
      this.scene.add(grp);
    }
    this.clusterGroup?.traverse((o) => { const m = o as ThreeNS.Mesh; if (m.isMesh) (m.material as ThreeNS.MeshBasicMaterial).wireframe = this.wireOn(); });
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
    // the profile=three GLB is assembled on every request: a longer debounce in Material / Rendered
    const ms = this.settings.mode === 'material' || this.settings.mode === 'rendered' ? 400 : 200;
    if ((e.type === 'model' && e.model === t.name && !e.deleted) || texHit) this.later(ms, () => this.reload(), 'reload');
  }

  // ---- pie ----
  private openPie(): void {
    if (this.pie || !this.renderer || !this.side) return;
    const r = this.stage.getBoundingClientRect();
    const at = this.side.piePosition(this.pointer, r.width, r.height);
    this.pie = this.side.buildPie(at, this.settings.mode, (m) => { this.closePie(); if (m) this.setMode(m); this.renderer?.domElement.focus(); });
    this.stage.append(this.pie.el);
    this.pie.focus(this.settings.mode);
  }
  private closePie(): void {
    const p = this.pie;
    this.pie = null;
    p?.destroy();
  }

  onKey(e: KeyboardEvent, k: string): boolean {
    if (this.pie) {
      const a = this.side!.pieKey(e.key, e.code, this.pie.focused());
      if (a && 'pick' in a) { this.closePie(); this.setMode(a.pick); }
      else if (a && 'focus' in a) this.pie.focus(a.focus);
      else if (a) this.closePie();
      return true;
    }
    if (k === ' ') { this.togglePlay(); return true; }
    if (k === 'w') { this.wireCb.checked = !this.wireCb.checked; this.applyToggles(); return true; }
    const vk = viewKey(e.code, e.key);
    if (vk) { this.viewCmd(vk); return true; }
    if (k === '0') { this.frameCamera(); return true; }
    // shading modes on the digit row only (Digit1-4), so numpad view keys never collide
    const digit = /^Digit([1-4])$/.exec(e.code)?.[1] ?? (!e.code && /^[1-4]$/.test(k) ? k : null);
    if (digit) { this.setMode(MODES[Number(digit) - 1]); return true; }
    if (k === 'z' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { this.openPie(); return true; }
    const step = this.renderer && document.activeElement === this.renderer.domElement ? orbitKey(e.key) : null;
    if (step) { this.orbitBy(step[0], step[1], step[2]); return true; }
    return false;
  }
  /** Keyboard orbit / dolly around the controls target. */
  private orbitBy(dAz: number, dPolar: number, dolly: number): void {
    if (!this.model) return;
    this.endTween();
    const tg = this.controls.target, p = this.camera.position;
    const off = orbitOffset({ x: p.x - tg.x, y: p.y - tg.y, z: p.z - tg.z }, dAz, dPolar, dolly);
    p.set(tg.x + off.x, tg.y + off.y, tg.z + off.z);
    this.controls.update();
    this.requestRender();
  }

  debugInfo(): unknown {
    const r = this.renderer;
    const tg = this.renderer ? this.controls.target : null, p = this.renderer ? this.camera.position : null;
    const cam = tg && p ? toSpherical({ x: p.x - tg.x, y: p.y - tg.y, z: p.z - tg.z }) : null;
    const maps: ThreeNS.Texture[] = [];
    for (const m of this.meshes()) for (const mm of ([] as ThreeNS.Material[]).concat(m.material) as MapMaterial[]) if (mm.map) maps.push(mm.map);
    const nearest = this.T ? this.T.THREE.NearestFilter : -1;
    return {
      name: nameOf(this.target), frames: this.frames, loaded: this.loaded, channel: this.chanSel.value, playing: this.playing,
      contextLost: this.contextLost, failed: this.failed, webgl: !!r,
      gl: r ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? 0 } : null,
      ...(this.rig?.info() ?? { mode: this.settings.mode }),
      settings: { ...this.settings }, overlays: this.overlays, turntable: this.turntable, pie: !!this.pie,
      camera: cam ? { azimuth: cam.azimuth, polar: cam.polar, distance: cam.radius } : null,
      maps: { count: maps.length, nearest: maps.length > 0 && maps.every((t) => t.magFilter === nearest) },
    };
  }
}
