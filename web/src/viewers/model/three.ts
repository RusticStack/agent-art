// three.js loader: the only module that imports three at runtime. Vite puts every specifier below in
// the lazy `three` chunk (vite.config.js codeSplitting.groups), fetched when the 3D viewer first opens.
// Everything else imports three as `import type` only. The specifiers stay literal (test/ui.test.js reads them).
import type * as ThreeNS from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';

export interface ThreeBundle {
  THREE: typeof ThreeNS;
  OrbitControls: typeof OrbitControls;
  GLTFLoader: typeof GLTFLoader;
  VertexNormalsHelper: typeof VertexNormalsHelper;
}

let threeP: Promise<ThreeBundle> | null = null;

/** Load three + the addons once; a failed load is not cached (see resetThree, used by Retry). */
export function loadThree(): Promise<ThreeBundle> {
  threeP ||= Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/helpers/VertexNormalsHelper.js'),
  ]).then(([THREE, oc, gl, vn]) => ({ THREE, OrbitControls: oc.OrbitControls, GLTFLoader: gl.GLTFLoader, VertexNormalsHelper: vn.VertexNormalsHelper }));
  const p = threeP;
  p.catch(() => { if (threeP === p) threeP = null; });
  return p;
}

/** Forget the cached promise (Retry after a chunk load failure). */
export function resetThree(): void { threeP = null; }
