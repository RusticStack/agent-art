// Cluster view (like art_model cluster_lod): per mesh, triangles in Morton order cut into runs of 128,
// one flat colour each. The maths is pure; buildClusters takes the three bundle as an argument.
import type * as ThreeNS from 'three';

export const CLUSTER_SIZE = 128;

/** Spread the low 10 bits of x so there are two zero bits between each. */
export function spread(x: number): number {
  x &= 1023;
  x = (x | (x << 16)) & 0x30000ff;
  x = (x | (x << 8)) & 0x300f00f;
  x = (x | (x << 4)) & 0x30c30c3;
  return (x | (x << 2)) & 0x9249249;
}
/** 30-bit Morton key from three 10-bit cell coordinates (x lowest). */
export function mortonKey(x: number, y: number, z: number): number { return (spread(x) | (spread(y) << 1) | (spread(z) << 2)) >>> 0; }
/** Position along one axis of the bounding box to a 0..1023 cell. */
export function quantize(v: number, min: number, size: number): number { return Math.max(0, Math.min(1023, Math.floor(((v - min) / (size || 1)) * 1023))); }
/** Global cluster index of the triangle at this rank in its mesh's sorted order. */
export function clusterColorIndex(sortedRank: number, base: number): number { return Math.floor(sortedRank / CLUSTER_SIZE) + base; }
/** Triangle indices sorted by Morton key, ties by index. */
export function mortonOrder(keys: ArrayLike<number>): number[] {
  const idx = Array.from({ length: keys.length }, (_, i) => i);
  return idx.sort((a, b) => keys[a] - keys[b] || a - b);
}
/** Stable hue (0..1) for a cluster index. */
export function clusterHue(k: number): number {
  let h = Math.imul((k + 1) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) % 360) / 360;
}

/** Build the flat-coloured cluster meshes for every visible mesh under model (world transforms baked into matrix). */
export function buildClusters(THREE: typeof ThreeNS, model: ThreeNS.Object3D, wireframe: boolean): { group: ThreeNS.Group; count: number } {
  const grp = new THREE.Group();
  let id = 0;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model), mn = box.min, sz = box.getSize(new THREE.Vector3());
  const colour = new THREE.Color();
  model.traverse((o) => {
    const mesh = o as ThreeNS.Mesh;
    if (!mesh.isMesh) return;
    for (let a: ThreeNS.Object3D | null = o; a; a = a.parent) if (a.visible === false) return;
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const P = g.attributes.position as ThreeNS.BufferAttribute, nt = Math.floor(P.count / 3);
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    const keys = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
      c.set(0, 0, 0);
      for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(P, t * 3 + k).applyMatrix4(mesh.matrixWorld));
      c.multiplyScalar(1 / 3);
      keys[t] = mortonKey(quantize(c.x, mn.x, sz.x), quantize(c.y, mn.y, sz.y), quantize(c.z, mn.z, sz.z));
    }
    const col = new Float32Array(P.count * 3);
    mortonOrder(keys).forEach((t, r) => {
      colour.setHSL(clusterHue(clusterColorIndex(r, id)), 0.65, 0.55);
      for (let k = 0; k < 3; k++) col.set([colour.r, colour.g, colour.b], (t * 3 + k) * 3);
    });
    id += Math.ceil(nt / CLUSTER_SIZE);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const side = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.side ?? THREE.FrontSide;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, wireframe, side }));
    m.matrixAutoUpdate = false; m.matrix.copy(mesh.matrixWorld);
    grp.add(m);
  });
  return { group: grp, count: id };
}
