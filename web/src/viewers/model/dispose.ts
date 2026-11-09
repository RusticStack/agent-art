// GPU resource disposal for a loaded model (structural types, so tests can pass a fake scene graph).
// Every geometry / material / texture is disposed once, even when shared between meshes.

export interface DisposableLike { dispose(): void }
export interface TextureLike extends DisposableLike { isTexture?: boolean }
export interface MaterialLike extends DisposableLike { userData?: { origMap?: TextureLike | null; [k: string]: unknown }; [k: string]: unknown }
export interface NodeLike {
  isMesh?: boolean; isLine?: boolean; isPoints?: boolean;
  geometry?: DisposableLike;
  skeleton?: DisposableLike;
  material?: MaterialLike | MaterialLike[];
  userData?: { origMat?: MaterialLike | MaterialLike[]; [k: string]: unknown };
  traverse(fn: (o: NodeLike) => void): void;
}

/** Texture properties a glTF material can carry. */
export const TEXTURE_KEYS = ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap', 'lightMap', 'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap', 'specularIntensityMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap'] as const;

const isTex = (v: unknown): v is TextureLike => !!v && typeof v === 'object' && typeof (v as TextureLike).dispose === 'function' && (v as TextureLike).isTexture !== false;

/**
 * Dispose every geometry, material and material texture under root, plus the extra textures
 * (handed to shader uniforms via parser.getDependency). `skip` holds resources that must survive
 * (e.g. the UV checker texture shared by all models). Materials whose map was swapped for the checker
 * get their original map back first so it is disposed and the checker is not.
 * Returns the number of distinct resources disposed.
 */
export function disposeModel(root: NodeLike, extraTextures: Iterable<TextureLike> = [], skip: ReadonlySet<unknown> = new Set()): number {
  const done = new Set<unknown>(skip);
  let n = 0;
  const once = (r: DisposableLike | null | undefined) => { if (!r || done.has(r)) return; done.add(r); r.dispose(); n++; };
  const mat = (m: MaterialLike) => {
    if (!m || done.has(m)) return;
    if (m.userData && m.userData.origMap !== undefined) { m.map = m.userData.origMap; }
    for (const k of TEXTURE_KEYS) { const t = m[k]; if (isTex(t)) once(t); }
    once(m);
  };
  root.traverse((o) => {
    if (o.geometry && (o.isMesh || o.isLine || o.isPoints)) once(o.geometry);
    if (o.skeleton) once(o.skeleton);
    for (const m of ([] as MaterialLike[]).concat(o.material ?? [])) mat(m);
    for (const m of ([] as MaterialLike[]).concat(o.userData?.origMat ?? [])) mat(m);
  });
  for (const t of extraTextures) once(t);
  return n;
}

/** Dispose a helper object (grid, axes, normals helper, cluster group): geometry + material of every node. */
export function disposeObject(root: NodeLike | null | undefined): void {
  if (!root) return;
  const done = new Set<unknown>();
  const once = (r: DisposableLike | null | undefined) => { if (!r || done.has(r)) return; done.add(r); r.dispose(); };
  root.traverse((o) => {
    once(o.geometry);
    for (const m of ([] as MaterialLike[]).concat(o.material ?? [])) once(m);
  });
}
