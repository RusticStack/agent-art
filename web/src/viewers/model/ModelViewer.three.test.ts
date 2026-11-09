// @vitest-environment jsdom
// The WebGL path with the real three.js scene graph, a fake renderer and a fake GLTF loader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fakeFetch } from '@/test/fakes';
import type { ReviewDraft, Target, ViewerEnv, ViewerHostApi } from '../types';

vi.mock('./three', () => ({ loadThree: vi.fn(), resetThree: vi.fn() }));
import { loadThree, type ThreeBundle } from './three';
import { ModelViewer } from './ModelViewer';

class FakeRenderer {
  static last: FakeRenderer;
  domElement = document.createElement('canvas');
  outputColorSpace = '';
  info = { memory: { geometries: 0, textures: 0 }, programs: [] as unknown[] };
  render = vi.fn();
  dispose = vi.fn();
  forceContextLoss = vi.fn();
  forceContextRestore = vi.fn();
  setPixelRatio = vi.fn();
  setClearColor = vi.fn();
  setSize = vi.fn();
  constructor(readonly opts: { preserveDrawingBuffer?: boolean }) { FakeRenderer.last = this; }
}

interface Built { gltf: GLTF; geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; tex: THREE.Texture; mesh: THREE.Mesh }
let built: Built[] = [];
function buildGltf(): GLTF {
  const tex = new THREE.Texture();
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  const geo = new THREE.BoxGeometry(1, 2, 3);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'body';
  const sock = new THREE.Object3D(); sock.name = 'socket_muzzle'; sock.position.set(0, 0, 1.5);
  const grip = new THREE.Object3D(); grip.name = 'grip';
  const scene = new THREE.Group();
  scene.add(mesh, sock, grip);
  const clip = new THREE.AnimationClip('fire', 0.5, [new THREE.VectorKeyframeTrack('grip.position', [0, 0.5], [0, 0, 0, 1, 0, 0])]);
  const gltf = { scene, scenes: [scene], animations: [clip], cameras: [], asset: {}, userData: {}, parser: { json: { nodes: [{ name: 'body' }, { name: 'socket_muzzle' }, { name: 'grip' }] }, getDependency: vi.fn(async () => null) } } as unknown as GLTF;
  built.push({ gltf, geo, mat, tex, mesh });
  return gltf;
}
class FakeGLTFLoader { parseAsync = async (): Promise<GLTF> => buildGltf(); }

const bundle = { THREE: { ...THREE, WebGLRenderer: FakeRenderer }, OrbitControls, GLTFLoader: FakeGLTFLoader, VertexNormalsHelper } as unknown as ThreeBundle;
const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };
const reviews: ReviewDraft[] = [];
const host: ViewerHostApi = {
  slot: 'A', readOnly: false, assets: () => null, isHidden: () => false, reviewMarks: () => [], open: vi.fn(), openNode: vi.fn(), inspectNode: vi.fn(),
  requestReview: (d) => { reviews.push(d); }, setTool: vi.fn(), setColor: vi.fn(), canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(),
  compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
};
let viewer: ModelViewer;
let el: HTMLElement;
let calls: { url: string }[];
const status = () => el.querySelector('.vstatus span')!.textContent!;
const chan = () => el.querySelector('select')!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const info = () => viewer.debugInfo() as { frames: number; loaded: string; playing: boolean; contextLost: boolean };

async function mount(target: Target = { kind: 'model', name: 'rifle' }): Promise<void> {
  viewer = new ModelViewer(host);
  el = document.createElement('div');
  document.body.append(el);
  await viewer.mount(el, { target, env });
}

beforeEach(() => {
  built = [];
  reviews.length = 0;
  vi.mocked(loadThree).mockResolvedValue(bundle);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 5) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  calls = fakeFetch({
    '/api/model/rifle/info': { json: { warnings: ['thin wall'] } },
    '/api/model/rifle/glb': { bytes: new Uint8Array(2048) },
    '/api/export-file': { bytes: new Uint8Array(10) },
  }).calls;
});
afterEach(() => { viewer?.destroy(); el?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ModelViewer with three', () => {
  it('loads the model: stats, socket label, clips, keeps preserveDrawingBuffer, renders on demand', async () => {
    await mount();
    const r = FakeRenderer.last;
    expect(r.opts.preserveDrawingBuffer).toBe(true);
    expect(r.setPixelRatio).toHaveBeenCalled();
    expect(r.domElement.getAttribute('aria-label')).toBe('3D view of rifle');
    expect(r.domElement.tabIndex).toBe(0);
    expect(status()).toBe('rifle · 12 tris · 24 verts · 1 meshes · 1 materials · 3 nodes · 1 sockets · 1 clips · size 1.00×2.00×3.00 u · 2.0 KB · ⚠ thin wall');
    expect([...el.querySelectorAll('.model-labels .mlabel.socket')].map((l) => l.textContent)).toEqual(['muzzle']);
    const clipSel = el.querySelectorAll('select')[1];
    expect([...clipSel.options].map((o) => o.text)).toEqual(['rest pose', 'fire (0.50 s)']);
    await vi.waitFor(() => expect(r.render).toHaveBeenCalled());
    await wait(40);
    const n = info().frames;
    await wait(60);
    expect(info().frames).toBe(n);   // idle: no rendering
    expect(el.querySelector('img.fallback')).toBeNull();
  });

  it('Space plays the first clip (renders every frame while playing); W sets wireframe on the materials', async () => {
    await mount();
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: ' ' }), ' ')).toBe(true);
    expect(el.querySelectorAll('select')[1].value).toBe('fire');
    expect(info().playing).toBe(true);
    const n = info().frames;
    await wait(60);
    expect(info().frames).toBeGreaterThan(n + 2);
    viewer.onKey(new KeyboardEvent('keydown', { key: ' ' }), ' ');
    expect(info().playing).toBe(false);
    viewer.onKey(new KeyboardEvent('keydown', { key: 'w' }), 'w');
    expect(built[0].mat.wireframe).toBe(true);
  });

  it('channel views swap in RawShaderMaterials and dispose them; v2 channels reload with profile=three and dispose the old model', async () => {
    await mount();
    const b0 = built[0];
    chan().value = 'albedo';
    chan().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(status()).toContain('channel Albedo'));
    const raw = b0.mesh.material as THREE.RawShaderMaterial;
    expect(raw.isRawShaderMaterial).toBe(true);
    expect(raw.uniforms.map.value).toBe(b0.tex);
    const rawDispose = vi.spyOn(raw, 'dispose');
    chan().value = 'lit';
    chan().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(b0.mesh.material).toBe(b0.mat));
    expect(rawDispose).toHaveBeenCalledTimes(1);
    expect(status()).not.toContain('channel');

    const geoDispose = vi.spyOn(b0.geo, 'dispose'), matDispose = vi.spyOn(b0.mat, 'dispose'), texDispose = vi.spyOn(b0.tex, 'dispose');
    chan().value = 'normal';
    chan().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(built.length).toBe(2));
    await vi.waitFor(() => expect(status()).toContain('channel Normal (1 mesh without it)'));
    expect(calls.some((c) => c.url === '/api/model/rifle/glb?profile=three')).toBe(true);
    expect(info().loaded).toBe('three');
    expect([geoDispose, matDispose, texDispose].map((s) => s.mock.calls.length)).toEqual([1, 1, 1]);
    // ORM needs no richer GLB than the one loaded: no new request
    const n = calls.length;
    chan().value = 'orm';
    chan().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(status()).toContain('channel ORM'));
    expect(calls.length).toBe(n);
  });

  it('UV checker swaps the map and restores the original; clusters hide the model', async () => {
    await mount();
    const b = built[0];
    const inputs = [...el.querySelectorAll<HTMLInputElement>('label.toggle input')];
    inputs[3].checked = true; inputs[3].dispatchEvent(new Event('change'));
    expect(b.mat.map).not.toBe(b.tex);
    inputs[3].checked = false; inputs[3].dispatchEvent(new Event('change'));
    expect(b.mat.map).toBe(b.tex);
    inputs[1].checked = true; inputs[1].dispatchEvent(new Event('change'));
    expect(b.gltf.scene.visible).toBe(false);
    inputs[1].checked = false; inputs[1].dispatchEvent(new Event('change'));
    expect(b.gltf.scene.visible).toBe(true);
    inputs[5].checked = true; inputs[5].dispatchEvent(new Event('change'));
    expect([...el.querySelectorAll('.mlabel.pivot')].map((l) => l.textContent)).toEqual(['body', 'grip']);
  });

  it('keyboard orbit and dolly when the canvas has focus', async () => {
    await mount();
    const cv = FakeRenderer.last.domElement;
    cv.focus();
    expect(document.activeElement).toBe(cv);
    const cam = (viewer as unknown as { camera: THREE.PerspectiveCamera }).camera;
    const before = cam.position.clone();
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), 'ArrowLeft')).toBe(true);
    expect(cam.position.distanceTo(before)).toBeGreaterThan(0.01);
    const tg = (viewer as unknown as { controls: OrbitControls }).controls.target;
    const d0 = cam.position.distanceTo(tg);
    viewer.onKey(new KeyboardEvent('keydown', { key: '+' }), '+');
    expect(cam.position.distanceTo(tg)).toBeLessThan(d0);
  });

  it('review mode click sends a crop; context loss shows the note and a click restores', async () => {
    await mount();
    const cv = FakeRenderer.last.domElement;
    cv.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1 }));
    expect(reviews).toHaveLength(0);
    await viewer.update({ target: { kind: 'model', name: 'rifle' }, env: { ...env, reviewMode: true } });
    cv.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1 }));
    expect(reviews[0]).toMatchObject({ asset: 'model:rifle', view: 'orbit', image: 'data:image/png;base64,AAAA' });
    const lost = new Event('webglcontextlost', { cancelable: true });
    cv.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(status()).toBe('WebGL context lost — click to restore');
    cv.dispatchEvent(new MouseEvent('click'));
    expect(FakeRenderer.last.forceContextRestore).toHaveBeenCalledTimes(1);
    expect(reviews).toHaveLength(1);
    cv.dispatchEvent(new Event('webglcontextrestored'));
    await vi.waitFor(() => expect(built.length).toBe(2));
    expect(info().contextLost).toBe(false);
  });

  it('keeps the camera when the same model reloads; a superseded load never reaches setModel', async () => {
    await mount();
    const cam = (viewer as unknown as { camera: THREE.PerspectiveCamera }).camera;
    cam.position.set(5, 5, 5);
    viewer.onEvent({ type: 'model', model: 'rifle', ts: 1 });
    await vi.waitFor(() => expect(built.length).toBe(2), { timeout: 1000 });
    expect(cam.position.x).toBeCloseTo(5);
    const p1 = viewer.update({ target: { kind: 'export', name: 'a.glb' }, env });
    const p2 = viewer.update({ target: { kind: 'model', name: 'rifle' }, env });
    await Promise.all([p1, p2]);
    expect(built.length).toBe(3);   // only the latest load parsed
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/api/model/rifle/glb?download=1');
  });

  it('destroy disposes the model, checker, controls and renderer, and removes the canvas', async () => {
    await mount();
    const b = built[0], r = FakeRenderer.last;
    const geoDispose = vi.spyOn(b.geo, 'dispose'), texDispose = vi.spyOn(b.tex, 'dispose');
    viewer.destroy();
    viewer.destroy();
    expect(geoDispose).toHaveBeenCalledTimes(1);
    expect(texDispose).toHaveBeenCalledTimes(1);
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(r.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(r.domElement.isConnected).toBe(false);
    expect(el.children.length).toBe(0);
  });
});
