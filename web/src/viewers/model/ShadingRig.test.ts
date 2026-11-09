// @vitest-environment jsdom
// ShadingRig on the real three scene graph with a fake renderer and fake GPU addons (./testFakes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DEFAULT_SETTINGS, type DegradeStep, type ShadingSettings } from './shading';
import { ShadingRig } from './shadingRig';
import { FakeRenderer, fakeBundle, made } from './testFakes';

interface Fixture { root: THREE.Group; gltf: GLTF; mat: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; tex: THREE.Texture; ao: THREE.Texture; lm: THREE.Texture; meshes: THREE.Mesh[]; box: THREE.Box3 }
function fixture(): Fixture {
  const tex = new THREE.Texture(); tex.magFilter = THREE.NearestFilter;
  const ao = new THREE.Texture(); ao.channel = 1;
  const lm = new THREE.Texture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, aoMap: ao });
  mat.userData.lightMap = { index: 3, texCoord: 1, intensity: 6.28 };
  const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat), b = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), mat), c = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glass);
  const pivot = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshBasicMaterial()); pivot.userData.helper = true;
  const root = new THREE.Group(); root.add(a, b, c, pivot);
  const getDependency = vi.fn(async (_t: string, i: number) => (i === 3 ? lm : null));
  const gltf = { scene: root, animations: [], parser: { json: {}, getDependency } } as unknown as GLTF;
  return { root, gltf, mat, glass, tex, ao, lm, meshes: [a, b, c], box: new THREE.Box3().setFromObject(root) };
}

let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: FakeRenderer, rig: ShadingRig, f: Fixture;
const T = fakeBundle();
const S = (p: Partial<ShadingSettings> = {}): ShadingSettings => ({ ...DEFAULT_SETTINGS, ...p });
function make(o: { slotB?: boolean; gpu?: string; onDegrade?: (s: DegradeStep) => void } = {}): void {
  FakeRenderer.gpuName = o.gpu ?? 'ANGLE (SwiftShader)';
  renderer = new FakeRenderer();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();
  rig = new ShadingRig(T, renderer as unknown as THREE.WebGLRenderer, scene, camera, { slotB: o.slotB, onDegrade: o.onDegrade });
  f = fixture();
  scene.add(f.root);
  rig.setModel(f.root, f.gltf, f.box, 2, new Set());
  rig.setSize(800, 600, 2);
}

beforeEach(() => {
  made.reset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { rig?.dispose(); vi.restoreAllMocks(); });

describe('ShadingRig', () => {
  it('Solid MatCap: twins keep the pixel texture object (nearest), one per source material; Texture off = clay; back to originals', async () => {
    make();
    await rig.apply(S({ mode: 'solid' }));
    const [a, b, c] = f.meshes;
    const tw = a.material as THREE.MeshMatcapMaterial;
    expect(tw.isMeshMatcapMaterial).toBe(true);
    expect(b.material).toBe(tw);                      // shared source → shared twin
    expect(tw.map).toBe(f.tex);
    expect(tw.map!.magFilter).toBe(THREE.NearestFilter);
    expect((c.material as THREE.MeshMatcapMaterial).transparent).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(scene.environment).toBeNull();
    expect(rig.info().lights).toBe(0);
    await rig.apply(S({ mode: 'solid', texture: false }));
    expect(tw.map).toBeNull();
    rig.setOverlay(true, false);
    expect((tw as THREE.MeshMatcapMaterial & { wireframe?: boolean }).wireframe).toBe(true);
    await rig.apply(S({ mode: 'material' }));
    expect(a.material).toBe(f.mat);
    expect(c.material).toBe(f.glass);
  });

  it('Material preview: room environment through PMREM (built once, generator and room disposed), Neutral tone mapping, no lights', async () => {
    make();
    await rig.apply(S({ mode: 'material', rotate: 90 }));
    expect(made.pmrem).toHaveLength(1);
    expect(made.pmrem[0].dispose).toHaveBeenCalledTimes(1);
    expect(made.rooms[0].disposeSpy).toHaveBeenCalledTimes(1);
    expect(scene.environment).toBe(made.envTargets[0].texture);
    expect(scene.environmentIntensity).toBe(1);
    expect(scene.environmentRotation.y).toBeCloseTo(Math.PI / 2);
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(rig.info()).toMatchObject({ environment: true, toneMapping: 'Neutral', lights: 0, composer: false });
    await rig.apply(S({ mode: 'rendered' }));
    await rig.apply(S({ mode: 'material' }));
    expect(made.pmrem).toHaveLength(1);
    expect(f.ao.channel).toBe(1);
    expect(f.mat.aoMap).toBeNull();                  // baked (uv 1) AO only in Rendered › Baked
  });

  it('Solid › Studio restores the originals and adds exactly the two legacy lights; Flat twins are disposed once', async () => {
    make();
    await rig.apply(S({ mode: 'solid', solidLight: 'flat' }));
    const flat = f.meshes[0].material as THREE.MeshBasicMaterial;
    expect(flat.isMeshBasicMaterial).toBe(true);
    expect(flat.map).toBe(f.tex);
    const spy = vi.spyOn(flat, 'dispose');
    await rig.apply(S({ mode: 'solid', solidLight: 'studio' }));
    expect(f.meshes[0].material).toBe(f.mat);
    const info = rig.info();
    expect(info.lights).toBe(2);
    expect(info.environment).toBe(false);
    const lights = scene.children.filter((o): o is THREE.Light => (o as THREE.Light).isLight && o.visible);
    expect(lights.map((l) => l.type).sort()).toEqual(['DirectionalLight', 'HemisphereLight']);
    const hemi = lights.find((l) => l.type === 'HemisphereLight') as THREE.HemisphereLight, dir = lights.find((l) => l.type === 'DirectionalLight') as THREE.DirectionalLight;
    expect([hemi.color.getHex(), hemi.groundColor.getHex(), hemi.intensity]).toEqual([0xffffff, 0x445066, 1.6]);
    expect([dir.intensity, dir.position.x, dir.position.y, dir.position.z]).toEqual([1.8, 3, 6, 4]);
    rig.clearModel();
    rig.clearModel();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(f.meshes[0].material).toBe(f.mat);
  });

  it('apply is idempotent: no new resources and no material recompiles on a repeat', async () => {
    make();
    const s = S({ mode: 'rendered', quality: 'low' });
    await rig.apply(s);
    rig.render();
    const v = f.mat.version, children = scene.children.length;
    await rig.apply(s);
    await rig.apply({ ...s });
    rig.render();
    expect(f.mat.version).toBe(v);
    expect(scene.children.length).toBe(children);
    expect(made.pmrem).toHaveLength(1);
    expect(made.composers).toHaveLength(1);
  });

  it('Rendered: sun casts PCF soft shadows fitted to the model, ground catcher, glass casts none; the composer only with AO', async () => {
    make();
    await rig.apply(S({ mode: 'rendered', ao: false, quality: 'low' }));
    rig.render();
    expect(made.composers).toHaveLength(0);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(f.meshes[0].castShadow).toBe(true);
    expect(f.meshes[2].castShadow).toBe(false);
    expect(f.meshes[0].receiveShadow).toBe(true);
    const sun = scene.children.find((o): o is THREE.DirectionalLight => (o as THREE.DirectionalLight).isDirectionalLight && o.visible)!;
    expect(sun.castShadow).toBe(true);
    expect(sun.shadow.mapSize.x).toBe(1024);
    expect(sun.shadow.bias).toBe(-0.0004);
    expect(sun.shadow.camera.right).toBeGreaterThan(0);
    const ground = scene.children.find((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).type === 'ShadowMaterial')!;
    expect(ground.visible).toBe(true);
    expect(ground.receiveShadow).toBe(true);
    expect(scene.environmentIntensity).toBe(0.35);
    expect(rig.info()).toMatchObject({ shadows: true, ao: false, composer: false, shadowMap: 1024, lights: 1 });

    await rig.apply(S({ mode: 'rendered', ao: true, aoStrength: 1.5, quality: 'low' }));
    rig.render();
    expect(made.composers).toHaveLength(1);
    expect(made.composers[0].render).toHaveBeenCalledTimes(1);
    expect(made.composers[0].passes).toEqual([made.renderPasses[0], made.gtao[0], made.output[0]]);
    expect(made.composers[0].target!.samples).toBe(0);
    expect(made.gtao[0].output).toBe(0);
    expect(made.gtao[0].blendIntensity).toBe(1.5);
    expect(made.gtao[0].updateGtaoMaterial).toHaveBeenCalledWith(expect.objectContaining({ samples: 8, distanceFallOff: 1, thickness: 1 }));
    expect(made.gtao[0].updatePdMaterial).toHaveBeenCalledWith({ samples: 8, rings: 2 });
    expect(rig.info().composer).toBe(true);
    // Low turns AO off while orbiting
    rig.setInteracting(true);
    expect(rig.info().composer).toBe(false);
    rig.setInteracting(false);

    await rig.apply(S({ mode: 'material' }));
    rig.render();
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(ground.visible).toBe(false);
    expect(made.composers[0].render).toHaveBeenCalledTimes(1);
  });

  it('quality: High = 4096 shadow map, 24 GTAO samples, MSAA 4; Auto on SwiftShader = Low; slot B one tier below', async () => {
    make({ gpu: 'NVIDIA GeForce RTX 4080' });
    expect(rig.info().tier).toBe('medium');
    await rig.apply(S({ mode: 'rendered', quality: 'high' }));
    rig.render();
    expect(rig.info()).toMatchObject({ tier: 'high', shadowMap: 4096, gtaoSamples: 24 });
    expect(made.composers[0].target!.samples).toBe(4);
    await rig.apply(S({ mode: 'rendered', quality: 'medium' }));
    rig.render();
    expect(made.composers).toHaveLength(2);           // MSAA changed: composer rebuilt, the old one released
    expect(made.composers[0].dispose).toHaveBeenCalledTimes(1);
    expect(made.gtao[0].dispose).toHaveBeenCalledTimes(1);
    rig.dispose();
    make();
    expect(rig.info().tier).toBe('low');
    rig.dispose();
    make({ gpu: 'NVIDIA', slotB: true });
    expect(rig.info().tier).toBe('low');
  });

  it('auto-degrade steps down once per sustained slow period, in order, and never on a manual quality', async () => {
    const steps: DegradeStep[] = [];
    make({ gpu: 'NVIDIA GeForce', onDegrade: (s) => steps.push(s) });
    await rig.apply(S({ mode: 'rendered' }));
    const slow = () => { for (let i = 0; i < 40; i++) rig.frameCost(60); };   // 2.4 s of 60 ms frames: one step each
    slow();
    expect(steps).toEqual(['dpr']);
    expect(rig.info().dpr).toBe(1);
    slow(); slow(); slow(); slow();
    expect(steps).toEqual(['dpr', 'gtao-samples', 'shadow-map', 'ao-off', 'shadows-off']);
    expect(rig.info()).toMatchObject({ shadows: false, ao: false, composer: false });
    expect(rig.info().degraded).toEqual(['pixel ratio 1', 'GTAO 8 samples', 'shadow map 1024', 'AO off', 'shadows off']);
    slow();
    expect(steps).toHaveLength(5);
    await rig.apply(S({ mode: 'rendered', quality: 'high' }));
    expect(rig.info().degraded).toEqual([]);
    slow();
    expect(steps).toHaveLength(5);
  });

  it('a default Material preview falls back to Solid › Studio when slow (the viewer switches)', async () => {
    const steps: DegradeStep[] = [];
    make({ onDegrade: (s) => steps.push(s) });
    rig.setSize(800, 600, 1);
    rig.canFallback = true;
    await rig.apply(S({ mode: 'material' }));
    for (let i = 0; i < 80; i++) rig.frameCost(60);
    expect(steps).toEqual(['solid-studio']);
  });

  it('Baked AO + lightmap: resolved through parser.getDependency, uv 1, sun and GTAO off; Off restores real-time', async () => {
    make();
    const extra = new Set<THREE.Texture>();
    rig.setModel(f.root, f.gltf, f.box, 2, extra);
    await rig.apply(S({ mode: 'rendered', baked: 'ao+lightmap', quality: 'low' }));
    expect(f.gltf.parser.getDependency).toHaveBeenCalledWith('texture', 3);
    expect(f.mat.lightMap).toBe(f.lm);
    expect(f.lm.channel).toBe(1);
    expect(f.lm.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(f.mat.lightMapIntensity).toBeCloseTo(6.28);
    expect(f.mat.aoMap).toBe(f.ao);
    expect(extra.has(f.lm)).toBe(true);
    expect(rig.info()).toMatchObject({ lightmaps: 2, withoutLightmap: 1, shadows: false, ao: false, lights: 0, bakedAo: 1 });
    rig.render();
    expect(made.composers).toHaveLength(0);
    await rig.apply(S({ mode: 'rendered', baked: 'ao', quality: 'low' }));
    expect(f.mat.lightMap).toBeNull();
    expect(f.mat.aoMap).toBe(f.ao);
    expect(rig.info()).toMatchObject({ lightmaps: 0, shadows: true, ao: true, lights: 1 });
    await rig.apply(S({ mode: 'rendered', baked: 'off', quality: 'low' }));
    expect(f.mat.aoMap).toBeNull();
    expect(f.gltf.parser.getDependency).toHaveBeenCalledTimes(1);   // cached per model
  });

  it('channel view: no swaps, no lights, no composer', async () => {
    make();
    await rig.apply(S({ mode: 'rendered', quality: 'low' }));
    const raw = new THREE.RawShaderMaterial();
    f.meshes[0].material = raw;
    await rig.setChannelView(true);
    expect(f.meshes[0].material).toBe(raw);
    rig.render();
    expect(made.composers).toHaveLength(0);
    expect(rig.info()).toMatchObject({ channelView: true, lights: 0, shadows: false });
    f.meshes[0].material = f.mat;
    await rig.setChannelView(false);
    expect(rig.info().lights).toBe(1);
  });

  it('probes: one helper per probe with SH9 coefficients, shown in Rendered when checked', async () => {
    make();
    await rig.apply(S({ mode: 'rendered', quality: 'low' }));
    const coeffs = Array.from({ length: 54 }, () => 0.1);
    expect(rig.setProbes({ origin: [0, 0, 0], spacing: 1, dims: [2, 1, 1], coefficients: coeffs })).toBe(2);
    const g = scene.children.find((o) => o.type === 'Group' && o !== f.root)!;
    expect(g.visible).toBe(false);
    rig.showProbes(true);
    expect(g.visible).toBe(true);
    expect(rig.info().probes).toBe(2);
    const spies = g.children.map((c) => vi.spyOn(c as THREE.Mesh & { dispose(): void }, 'dispose'));
    rig.setProbes(null);
    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1]);
    expect(scene.children.includes(g)).toBe(false);
  });

  it('dispose releases every resource exactly once', async () => {
    make();
    await rig.apply(S({ mode: 'solid' }));
    const twin = f.meshes[0].material as THREE.MeshMatcapMaterial;
    const twinSpy = vi.spyOn(twin, 'dispose'), matcapSpy = vi.spyOn(twin.matcap!, 'dispose');
    await rig.apply(S({ mode: 'solid', solidLight: 'studio' }));
    await rig.apply(S({ mode: 'rendered', quality: 'low' }));
    rig.render();
    const sun = scene.children.find((o): o is THREE.DirectionalLight => (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow)!;
    const sunSpy = vi.spyOn(sun, 'dispose');
    const shadowMap = new THREE.WebGLRenderTarget(4, 4);
    sun.shadow.map = shadowMap;
    const smSpy = vi.spyOn(shadowMap, 'dispose');
    const ground = scene.children.find((o): o is THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).type === 'ShadowMaterial')!;
    const gSpy = vi.spyOn(ground.geometry, 'dispose'), gmSpy = vi.spyOn(ground.material, 'dispose');
    rig.dispose();
    rig.dispose();
    expect(twinSpy).toHaveBeenCalledTimes(1);
    expect(matcapSpy).toHaveBeenCalledTimes(1);
    expect(made.envTargets[0].dispose).toHaveBeenCalledTimes(1);
    expect([made.gtao[0].dispose, made.output[0].dispose, made.renderPasses[0].dispose, made.composers[0].dispose].map((s) => s.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(sunSpy).toHaveBeenCalledTimes(1);
    expect(smSpy).toHaveBeenCalledTimes(1);
    expect(gSpy).toHaveBeenCalledTimes(1);
    expect(gmSpy).toHaveBeenCalledTimes(1);
    expect(scene.environment).toBeNull();
    expect(scene.background).toBeNull();
    expect(scene.children.filter((o) => (o as THREE.Light).isLight)).toHaveLength(0);
    expect(scene.children.includes(ground)).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(f.meshes[0].material).toBe(f.mat);
    expect(f.mat.aoMap).toBe(f.ao);                 // put back so the model's own disposal finds it
  });

  it('background: dark = clear colour, studio grey, environment (Material / Rendered only)', async () => {
    make();
    await rig.apply(S({ mode: 'solid', bg: 'studio' }));
    expect((scene.background as THREE.Color).getHex()).toBe(0x3c3f45);
    await rig.apply(S({ mode: 'solid', bg: 'env' }));
    expect(scene.background).toBeNull();
    await rig.apply(S({ mode: 'material', bg: 'env' }));
    expect(scene.background).toBe(made.envTargets[0].texture);
    expect(scene.backgroundBlurriness).toBe(0.6);
    expect(scene.backgroundIntensity).toBe(0.6);
    await rig.apply(S({ mode: 'material', bg: 'dark' }));
    expect(scene.background).toBeNull();
  });
});
