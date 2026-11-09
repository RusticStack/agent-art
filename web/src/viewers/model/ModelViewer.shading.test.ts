// @vitest-environment jsdom
// Viewport shading in the viewer (plan 5.7b): mode switcher, keys, pie, GLB needs, persistence, views, overlays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fakeFetch } from '@/test/fakes';
import type { Target, ViewerEnv, ViewerHostApi } from '../types';
import { FakeRenderer, fakeBundle, made } from './testFakes';

vi.mock('./three', () => ({ loadThree: vi.fn(), resetThree: vi.fn() }));
import { loadThree } from './three';
import { ModelViewer } from './ModelViewer';

let built: { gltf: GLTF; mat: THREE.MeshStandardMaterial; tex: THREE.Texture; mesh: THREE.Mesh }[] = [];
function buildGltf(): GLTF {
  const tex = new THREE.Texture(); tex.magFilter = THREE.NearestFilter;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData.lightMap = { index: 1, texCoord: 1, intensity: 2 };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), mat);
  mesh.name = 'body';
  const sock = new THREE.Object3D(); sock.name = 'socket_muzzle';
  const scene = new THREE.Group();
  scene.add(mesh, sock);
  const gltf = { scene, scenes: [scene], animations: [], cameras: [], asset: {}, userData: {}, parser: { json: { nodes: [{ name: 'body' }, { name: 'socket_muzzle' }] }, getDependency: vi.fn(async () => new THREE.Texture()) } } as unknown as GLTF;
  built.push({ gltf, mat, tex, mesh });
  return gltf;
}
class FakeGLTFLoader { parseAsync = async (): Promise<GLTF> => buildGltf(); }
const bundle = fakeBundle({ GLTFLoader: FakeGLTFLoader as unknown as ReturnType<typeof fakeBundle>['GLTFLoader'] });

const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };
const host: ViewerHostApi = {
  slot: 'A', readOnly: false, assets: () => null, isHidden: () => false, reviewMarks: () => [], open: vi.fn(), openNode: vi.fn(), inspectNode: vi.fn(),
  requestReview: vi.fn(), setTool: vi.fn(), setColor: vi.fn(), canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(),
  compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
};
interface Dbg { mode: string; frames: number; environment: boolean; toneMapping: string; lights: number; shadowMap: number; composer: boolean; lightmaps: number; overlays: boolean; turntable: boolean; pie: boolean; camera: { azimuth: number; polar: number; distance: number }; maps: { count: number; nearest: boolean }; settings: { mode: string; bg: string } }
let viewer: ModelViewer, el: HTMLElement, calls: { url: string }[];
const dbg = () => viewer.debugInfo() as Dbg;
const status = () => el.querySelector('.vstatus span')!.textContent!;
const radios = () => [...el.querySelectorAll<HTMLButtonElement>('.vtoolbar.shading [role=radiogroup] [role=radio]')];
const checkedMode = () => radios().find((b) => b.getAttribute('aria-checked') === 'true')!.dataset.mode;
const key = (k: string, code = '', o: KeyboardEventInit = {}) => viewer.onKey(new KeyboardEvent('keydown', { key: k, code, ...o }), k.length === 1 ? k.toLowerCase() : k);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupOf = (text: string) => [...el.querySelectorAll<HTMLElement>('.vtoolbar.shading .group')].find((g) => g.textContent!.includes(text))!;
const shadeSel = (title: string) => el.querySelector<HTMLSelectElement>(`.vtoolbar.shading select[title^="${title}"]`)!;
const shadeToggle = (text: string) => [...el.querySelectorAll<HTMLLabelElement>('label.toggle')].find((l) => l.textContent!.trim() === text)!.querySelector('input')!;

async function mount(target: Target = { kind: 'model', name: 'rifle' }): Promise<void> {
  viewer = new ModelViewer(host);
  el = document.createElement('div');
  document.body.append(el);
  await viewer.mount(el, { target, env });
}

beforeEach(() => {
  built = [];
  made.reset();
  localStorage.clear();
  vi.mocked(loadThree).mockResolvedValue(bundle);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 5) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  calls = fakeFetch({ '/api/model/rifle/info': { json: {} }, '/api/model/rifle/glb': { bytes: new Uint8Array(64) } }).calls;
});
afterEach(() => { viewer?.destroy(); el?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ModelViewer shading', () => {
  it('defaults to Material preview: profile=three GLB, environment, Neutral tone mapping, mode in the status', async () => {
    await mount();
    expect(calls.some((c) => c.url === '/api/model/rifle/glb?profile=three')).toBe(true);
    expect(radios()).toHaveLength(4);
    expect(checkedMode()).toBe('material');
    expect(status()).toContain('Material preview');
    expect(dbg()).toMatchObject({ mode: 'material', environment: true, toneMapping: 'Neutral', lights: 0 });
    expect(el.querySelector('.model-viewer')!.getAttribute('data-shading-mode')).toBe('material');
    // the GLB download stays the plain file (channel need only)
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/api/model/rifle/glb?download=1');
  });

  it('Digit1-4 select the modes (aria-checked, status, persisted); Numpad digits do not', async () => {
    await mount();
    const names = ['Wireframe', 'Solid', 'Material preview', 'Rendered'];
    for (const [i, m] of ['wire', 'solid', 'material', 'rendered'].entries()) {
      expect(key(String(i + 1), `Digit${i + 1}`)).toBe(true);
      expect(checkedMode()).toBe(m);
      await vi.waitFor(() => expect(status()).toContain(names[i]));
      expect(JSON.parse(localStorage.getItem('agent-art:modelView')!).mode).toBe(m);
    }
    key('2', 'Digit2');
    const az = dbg().camera.azimuth;
    key('1', 'Digit1');
    expect(checkedMode()).toBe('wire');
    expect(dbg().camera.azimuth).toBeCloseTo(az);   // a shading key never moves the camera
    await vi.waitFor(() => expect(built.at(-1)!.mat.wireframe).toBe(true));
    radios()[1].click();
    expect(checkedMode()).toBe('solid');
  });

  it('controls that do not apply to the mode are hidden', async () => {
    await mount();
    key('2', 'Digit2');
    expect(groupOf('Lighting').hidden).toBe(false);
    expect(groupOf('Sun').hidden).toBe(true);
    expect(groupOf('Rotate').hidden).toBe(true);
    key('3', 'Digit3');
    expect(groupOf('Rotate').hidden).toBe(false);
    expect(groupOf('Lighting').hidden).toBe(true);
    expect(groupOf('Sun').hidden).toBe(true);
    key('4', 'Digit4');
    for (const g of ['Sun', 'Rotate', 'Baked', 'Quality', 'Background']) expect(groupOf(g).hidden, g).toBe(false);
    expect(groupOf('Lighting').hidden).toBe(true);
  });

  it('Z opens the pie (role=menu, 4 items); 4 picks Rendered and closes it; Shift+Z does not open', async () => {
    await mount();
    expect(key('Z', 'KeyZ', { shiftKey: true })).toBe(false);
    expect(el.querySelector('[role=menu]')).toBeNull();
    expect(key('z', 'KeyZ')).toBe(true);
    const pie = el.querySelector('.model-stage [role=menu]')!;
    expect(pie.querySelectorAll('[role=menuitemradio]')).toHaveLength(4);
    expect(dbg().pie).toBe(true);
    key('4', 'Digit4');
    expect(el.querySelector('[role=menu]')).toBeNull();
    expect(checkedMode()).toBe('rendered');
    key('z', 'KeyZ');
    key('Escape', 'Escape');
    expect(el.querySelector('[role=menu]')).toBeNull();
    expect(checkedMode()).toBe('rendered');
  });

  it('Rendered › Baked AO + lightmap reloads with bake=1 and shows baked lighting', async () => {
    await mount();
    key('4', 'Digit4');
    const sel = shadeSel('Baked');
    sel.value = 'ao+lightmap';
    sel.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/model/rifle/glb?profile=three&bake=1')).toBe(true));
    await vi.waitFor(() => expect(dbg().lightmaps).toBe(1));
    expect(status()).toContain('baked lighting');
    const n = calls.length;
    sel.value = 'off';
    sel.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(dbg().lightmaps).toBe(0));
    expect(calls.length).toBe(n);   // never fetches a poorer GLB
  });

  it('Quality High = 4096 shadow map; Auto on SwiftShader is Low (1024)', async () => {
    await mount();
    key('4', 'Digit4');
    await vi.waitFor(() => expect(dbg().shadowMap).toBe(1024));
    const q = shadeSel('Quality');
    q.value = 'high';
    q.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(dbg().shadowMap).toBe(4096));
    expect(status()).toContain('shadows 4096');
  });

  it('view presets by numpad code: front 0, right π/2, top, opposite after front = π; Frame model keeps the direction', async () => {
    await mount();
    key('1', 'Numpad1');
    await wait(300);
    expect(Math.abs(dbg().camera.azimuth)).toBeLessThan(0.02);
    expect(checkedMode()).toBe('material');            // not Wireframe
    key('9', 'Numpad9');
    await wait(300);
    expect(Math.abs(Math.abs(dbg().camera.azimuth) - Math.PI)).toBeLessThan(0.02);
    key('3', 'Numpad3');
    await wait(300);
    expect(dbg().camera.azimuth).toBeCloseTo(Math.PI / 2, 1);
    key('7', 'Numpad7');
    await wait(300);
    expect(dbg().camera.polar).toBeLessThan(0.05);
    key('3', 'Numpad3');
    await wait(300);
    const before = dbg().camera;
    const cam = (viewer as unknown as { camera: THREE.PerspectiveCamera }).camera;
    cam.position.multiplyScalar(3);
    const vs = el.querySelector<HTMLSelectElement>('.vtoolbar.shading select[title^="View"]')!;
    vs.value = 'frame';
    vs.dispatchEvent(new Event('change'));
    await wait(300);
    expect(dbg().camera.azimuth).toBeCloseTo(before.azimuth, 2);
    expect(dbg().camera.distance).not.toBeCloseTo(before.distance * 3, 1);
    expect(vs.value).toBe('');
  });

  it('Overlays off hides grid, labels and gizmo without changing their toggles; on restores', async () => {
    await mount();
    const labels = el.querySelector<HTMLElement>('.model-labels')!;
    const ov = shadeToggle('Overlays');
    ov.checked = false; ov.dispatchEvent(new Event('change'));
    expect(labels.hidden).toBe(true);
    expect(shadeToggle('Grid').checked).toBe(true);
    expect(shadeToggle('Sockets').checked).toBe(true);
    const grid = (viewer as unknown as { grid: THREE.GridHelper }).grid;
    expect(grid.visible).toBe(false);
    const vh = made.viewHelpers[0];
    vh.render.mockClear();
    viewer.onKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), 'ArrowLeft');
    (viewer as unknown as { requestRender(): void }).requestRender();
    await wait(30);
    expect(vh.render).not.toHaveBeenCalled();
    ov.checked = true; ov.dispatchEvent(new Event('change'));
    expect(labels.hidden).toBe(false);
    expect(grid.visible).toBe(true);
    await wait(30);
    expect(vh.render).toHaveBeenCalled();
    expect(vh.center).toBe((viewer as unknown as { controls: OrbitControls }).controls.target);
  });

  it('a channel view dims the mode switcher; Solid keeps nearest-filtered textures', async () => {
    await mount();
    key('2', 'Digit2');
    expect(dbg().maps).toEqual({ count: 1, nearest: true });
    const ch = el.querySelector<HTMLSelectElement>('select[title^="Material channel"]')!;
    ch.value = 'albedo'; ch.dispatchEvent(new Event('change'));
    const grp = el.querySelector<HTMLElement>('[role=radiogroup]')!;
    await vi.waitFor(() => expect(grp.classList.contains('dimmed')).toBe(true));
    expect(grp.title).toBe('Channel view active');
    ch.value = 'lit'; ch.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(grp.classList.contains('dimmed')).toBe(false));
    expect((built.at(-1)!.mesh.material as THREE.Material).type).toBe('MeshMatcapMaterial');
  });

  it('turntable runs continuously and stops on a pointer down on the stage', async () => {
    await mount();
    const tt = [...el.querySelectorAll<HTMLButtonElement>('.vtoolbar.shading button')].find((b) => b.textContent === 'Turntable')!;
    tt.click();
    expect(tt.getAttribute('aria-pressed')).toBe('true');
    const controls = (viewer as unknown as { controls: OrbitControls }).controls;
    expect(controls.autoRotate).toBe(true);
    const f0 = dbg().frames;
    await wait(80);
    expect(dbg().frames).toBeGreaterThan(f0 + 3);
    const cv = FakeRenderer.last.domElement as HTMLCanvasElement & { setPointerCapture(): void; releasePointerCapture(): void };
    cv.setPointerCapture = () => {}; cv.releasePointerCapture = () => {};
    cv.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(controls.autoRotate).toBe(false);
    expect(dbg().turntable).toBe(false);
  });

  it('settings persist across viewers (mode + background); live reload waits 400 ms in Material / Rendered', async () => {
    await mount();
    key('4', 'Digit4');
    const bg = shadeSel('Background');
    bg.value = 'studio'; bg.dispatchEvent(new Event('change'));
    viewer.destroy(); el.remove();
    await mount();
    expect(checkedMode()).toBe('rendered');
    expect(shadeSel('Background').value).toBe('studio');
    expect(dbg().settings).toMatchObject({ mode: 'rendered', bg: 'studio' });
    const n = built.length;
    viewer.onEvent({ type: 'model', model: 'rifle', ts: 1 });
    await wait(250);
    expect(built.length).toBe(n);
    await vi.waitFor(() => expect(built.length).toBe(n + 1), { timeout: 1000 });
  });

  it('destroy disposes the shading resources once (environment, view helper)', async () => {
    await mount();
    await vi.waitFor(() => expect(made.envTargets).toHaveLength(1));
    viewer.destroy();
    viewer.destroy();
    expect(made.envTargets[0].dispose).toHaveBeenCalledTimes(1);
    expect(made.viewHelpers[0].dispose).toHaveBeenCalledTimes(1);
  });
});
