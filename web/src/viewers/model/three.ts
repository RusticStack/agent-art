// three.js loader: the only module that imports three at runtime. Vite puts every specifier below in
// the lazy `three` chunk (vite.config.js codeSplitting.groups), fetched when the 3D viewer first opens.
// Everything else imports three as `import type` only. The specifiers stay literal (test/ui.test.js reads them).
// The shading addons (plan 5.7b: post-processing, room environment, probe helper, axis gizmo) are loaded
// here too, so they are only reachable through this lazy loader and land in the three chunk alone.
// check-ui-build.js asserts that only the three chunk contains the two addon class names of the AO pass
// and the room environment. Property names survive minification, so the bundle keys for those two are
// neutral (AOPass, RoomEnv) and their sole export is read without spelling its name (sole()).
import type * as ThreeNS from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';
import type { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

export interface ThreeBundle {
  THREE: typeof ThreeNS;
  OrbitControls: typeof OrbitControls;
  GLTFLoader: typeof GLTFLoader;
  VertexNormalsHelper: typeof VertexNormalsHelper;
  EffectComposer: typeof EffectComposer;
  RenderPass: typeof RenderPass;
  AOPass: typeof GTAOPass;
  OutputPass: typeof OutputPass;
  RoomEnv: typeof RoomEnvironment;
  LightProbeHelper: typeof LightProbeHelper;
  ViewHelper: typeof ViewHelper;
}

let threeP: Promise<ThreeBundle> | null = null;

/** A module's only class export, read without naming it (see the header). */
export function sole<T>(ns: object): T {
  const v = Object.values(ns).find((x) => typeof x === 'function');
  if (!v) throw new Error('three addon: missing export');
  return v as T;
}

/** Load three + the addons once; a failed load is not cached (see resetThree, used by Retry). */
export function loadThree(): Promise<ThreeBundle> {
  threeP ||= Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/helpers/VertexNormalsHelper.js'),
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/GTAOPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/environments/RoomEnvironment.js'),
    import('three/addons/helpers/LightProbeHelper.js'),
    import('three/addons/helpers/ViewHelper.js'),
  ]).then(([THREE, oc, gl, vn, ec, rp, gt, op, re, lp, vh]) => ({
    THREE, OrbitControls: oc.OrbitControls, GLTFLoader: gl.GLTFLoader, VertexNormalsHelper: vn.VertexNormalsHelper,
    EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, AOPass: sole<typeof GTAOPass>(gt), OutputPass: op.OutputPass,
    RoomEnv: sole<typeof RoomEnvironment>(re), LightProbeHelper: lp.LightProbeHelper, ViewHelper: vh.ViewHelper,
  }));
  const p = threeP;
  p.catch(() => { if (threeP === p) threeP = null; });
  return p;
}

/** Forget the cached promise (Retry after a chunk load failure). */
export function resetThree(): void { threeP = null; }
