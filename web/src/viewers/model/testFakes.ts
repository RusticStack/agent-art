// Test-only fakes for the shading tests: the real three scene graph with a fake WebGL renderer and fake
// GPU-bound addons (composer passes, PMREM, room environment, view helper). Never imported by app code.
import { vi } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';
import type { ThreeBundle } from './three';

export class FakeRenderer {
  static last: FakeRenderer;
  static gpuName = 'ANGLE (SwiftShader)';
  domElement = document.createElement('canvas');
  outputColorSpace = '';
  toneMapping: THREE.ToneMapping = THREE.NoToneMapping;
  toneMappingExposure = 1;
  autoClear = true;
  shadowMap = { enabled: false, type: THREE.PCFShadowMap as THREE.ShadowMapType, needsUpdate: false };
  capabilities = { maxTextureSize: 16384 };
  info = { memory: { geometries: 0, textures: 0 }, programs: [] as unknown[] };
  render = vi.fn();
  dispose = vi.fn();
  forceContextLoss = vi.fn();
  forceContextRestore = vi.fn();
  setPixelRatio = vi.fn();
  setClearColor = vi.fn();
  setSize = vi.fn();
  constructor(readonly opts: { preserveDrawingBuffer?: boolean } = {}) { FakeRenderer.last = this; }
  getContext() {
    return { RENDERER: 0x1f01, getExtension: (n: string) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null), getParameter: () => FakeRenderer.gpuName };
  }
}

export const made = {
  pmrem: [] as FakePMREM[], rooms: [] as FakeRoom[], envTargets: [] as THREE.WebGLRenderTarget[], composers: [] as FakeComposer[],
  renderPasses: [] as FakePass[], gtao: [] as FakeGTAO[], output: [] as FakePass[], viewHelpers: [] as FakeViewHelper[],
  reset(): void { for (const k of ['pmrem', 'rooms', 'envTargets', 'composers', 'renderPasses', 'gtao', 'output', 'viewHelpers'] as const) made[k].length = 0; },
};
export class FakePMREM {
  dispose = vi.fn();
  constructor() { made.pmrem.push(this); }
  fromScene(): THREE.WebGLRenderTarget { const rt = new THREE.WebGLRenderTarget(4, 4); vi.spyOn(rt, 'dispose'); made.envTargets.push(rt); return rt; }
}
export class FakeRoom extends THREE.Scene { disposeSpy = vi.fn(); constructor() { super(); made.rooms.push(this); } dispose(): void { this.disposeSpy(); } }
export class FakePass { enabled = true; dispose = vi.fn(); constructor() { made.renderPasses.push(this); } }
export class FakeOutputPass { enabled = true; dispose = vi.fn(); constructor() { made.output.push(this as unknown as FakePass); } }
export class FakeGTAO {
  static OUTPUT = { Off: -1, Default: 0, Diffuse: 1, Depth: 2, Normal: 3, AO: 4, Denoise: 5 };
  enabled = true; output = -1; blendIntensity = 1;
  updateGtaoMaterial = vi.fn(); updatePdMaterial = vi.fn(); dispose = vi.fn();
  constructor() { made.gtao.push(this); }
}
export class FakeComposer {
  passes: unknown[] = [];
  addPass = vi.fn((p: unknown) => { this.passes.push(p); });
  setPixelRatio = vi.fn(); setSize = vi.fn(); render = vi.fn(); dispose = vi.fn();
  constructor(readonly renderer: unknown, readonly target?: THREE.WebGLRenderTarget) { made.composers.push(this); }
}
export class FakeViewHelper {
  animating = false; center = new THREE.Vector3();
  render = vi.fn(); handleClick = vi.fn(() => false); update = vi.fn(); dispose = vi.fn();
  constructor() { made.viewHelpers.push(this); }
}

/** The real three namespace with the GPU parts replaced. */
export function fakeBundle(extra: Partial<ThreeBundle> = {}): ThreeBundle {
  return {
    THREE: { ...THREE, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM },
    OrbitControls, VertexNormalsHelper, LightProbeHelper,
    GLTFLoader: class {},
    EffectComposer: FakeComposer, RenderPass: FakePass, AOPass: FakeGTAO, OutputPass: FakeOutputPass, RoomEnv: FakeRoom, ViewHelper: FakeViewHelper,
    ...extra,
  } as unknown as ThreeBundle;
}
