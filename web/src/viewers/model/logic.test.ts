import { describe, expect, it, vi } from 'vitest';
import { modelGlb } from '@/lib/api/urls';
import { CHANNELS, CHANNEL_IDS, channelNote, downloadHref, downloadName, fallbackColor, glbQuery, glbUrl, loadedNeed, needOf, needRank, needsReload, type Need } from './channels';
import { CLUSTER_SIZE, clusterColorIndex, clusterHue, mortonKey, mortonOrder, quantize, spread } from './clusters';
import { disposeModel, disposeObject, type MaterialLike, type NodeLike, type TextureLike } from './dispose';
import { ORBIT_STEP, clampDt, composeStatus, orbitKey, orbitOffset, statusLine, usesCanvas } from './status';

describe('channels', () => {
  const model = { kind: 'model', name: 'rifle' } as const;
  const snap = { kind: 'model', name: 'rifle', snap: 's1' } as const;
  const exp = { kind: 'export', name: 'out/rifle.glb' } as const;

  it('glbQuery for each need and snapshot combination', () => {
    expect(glbQuery(model, '')).toBe('');
    expect(glbQuery(model, 'three')).toBe('profile=three');
    expect(glbQuery(model, 'bake')).toBe('profile=three&bake=1');
    expect(glbQuery(snap, '')).toBe('snap=s1');
    expect(glbQuery(snap, 'three')).toBe('snap=s1&profile=three');
    expect(glbQuery(snap, 'bake')).toBe('snap=s1&profile=three&bake=1');
    expect(glbQuery(exp, 'bake')).toBe('');
  });
  it('glbUrl matches the shared URL builders', () => {
    for (const need of ['', 'three', 'bake'] as Need[]) {
      expect(glbUrl(model, need)).toBe(modelGlb('rifle', { profile: need ? 'three' : undefined, bake: need === 'bake' }));
      expect(glbUrl(snap, need)).toBe(modelGlb('rifle', { snap: 's1', profile: need ? 'three' : undefined, bake: need === 'bake' }));
    }
    expect(glbUrl({ kind: 'model', name: 'a b' }, '')).toBe('/api/model/a%20b/glb');
    expect(glbUrl(exp, 'bake')).toBe('/api/export-file?path=out%2Frifle.glb');
    expect(downloadHref('/api/model/rifle/glb')).toBe('/api/model/rifle/glb?download=1');
    expect(downloadHref('/api/model/rifle/glb?profile=three')).toBe('/api/model/rifle/glb?profile=three&download=1');
    expect(downloadName('out/rifle.GLB')).toBe('rifle.glb');
    expect(downloadName('rifle')).toBe('rifle.glb');
  });
  it('needRank and the reload decision', () => {
    expect([needRank(''), needRank('three'), needRank('bake')]).toEqual([0, 1, 2]);
    expect(needsReload(model, 'three', '')).toBe(true);
    expect(needsReload(model, 'bake', 'three')).toBe(true);
    expect(needsReload(model, 'three', 'bake')).toBe(false);   // the baked GLB already has the v2 maps
    expect(needsReload(model, '', 'three')).toBe(false);
    expect(needsReload(exp, 'bake', '')).toBe(false);          // exports carry what was exported
    expect(needsReload(null, 'bake', '')).toBe(false);
    expect(loadedNeed(exp, 'bake')).toBe('');
    expect(loadedNeed(model, 'bake')).toBe('bake');
  });
  it('channel table: needs, labels, fallbacks and the note', () => {
    expect(CHANNEL_IDS).toHaveLength(14);
    expect(needOf('lit')).toBe('');
    expect(needOf('albedo')).toBe('');
    expect(needOf('normal')).toBe('three');
    expect(needOf('lightmap')).toBe('bake');
    expect(needOf('bogus')).toBe('');
    expect(CHANNELS.bent.source).toBe('x:bentNormalTexture');
    expect(fallbackColor('normal', 'normalMap', {})).toEqual([0.5, 0.5, 1]);
    expect(fallbackColor('orm', 'metalnessMap', { metalness: 0.2, roughness: 0.7 })).toEqual([1, 0.7, 0.2]);
    expect(fallbackColor('metal', 'metalnessMap', { metalness: 0.2 })).toEqual([0.2, 0.2, 0.2]);
    expect(fallbackColor('rough', 'roughnessMap', { roughness: 0.4 })).toEqual([0.4, 0.4, 0.4]);
    expect(fallbackColor('albedo', 'map', { color: [1, 0, 0] })).toEqual([1, 0, 0]);
    expect(fallbackColor('ao', 'aoMap', {})).toEqual([1, 1, 1]);
    expect(fallbackColor('emissive', 'emissiveMap', {})).toEqual([0, 0, 0]);
    expect(fallbackColor('height', 'x:heightTexture', {})).toEqual([0.25, 0.1, 0.25]);
    expect(channelNote('lit', 3)).toBe('');
    expect(channelNote('normal', 0)).toBe('channel Normal');
    expect(channelNote('bent', 1)).toBe('channel Bent normals (1 mesh without it)');
    expect(channelNote('ao', 2)).toBe('channel AO (2 meshes without it)');
  });
});

describe('clusters', () => {
  it('Morton keys interleave x, y, z bits', () => {
    expect(spread(0b11)).toBe(0b1001);
    expect(mortonKey(1, 0, 0)).toBe(1);
    expect(mortonKey(0, 1, 0)).toBe(2);
    expect(mortonKey(0, 0, 1)).toBe(4);
    expect(mortonKey(1023, 1023, 1023)).toBe(2 ** 30 - 1);
    expect(quantize(5, 0, 10)).toBe(511);
    expect(quantize(-1, 0, 10)).toBe(0);
    expect(quantize(99, 0, 0)).toBe(1023);
  });
  it('Morton order on a small fixture keeps spatial neighbours together', () => {
    // 2×2×1 grid of cells listed in scan order; Morton visits (0,0) (1,0) (0,1) (1,1)
    const cells: [number, number, number][] = [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0], [2, 0, 0]];
    const keys = cells.map(([x, y, z]) => mortonKey(x, y, z));
    expect(mortonOrder(keys)).toEqual([3, 2, 0, 1, 4]);
    expect(mortonOrder([5, 5, 1])).toEqual([2, 0, 1]);   // ties by index
  });
  it('cluster colour index', () => {
    expect(clusterColorIndex(0, 0)).toBe(0);
    expect(clusterColorIndex(CLUSTER_SIZE - 1, 0)).toBe(0);
    expect(clusterColorIndex(CLUSTER_SIZE, 3)).toBe(4);
    const h = clusterHue(7);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(clusterHue(7)).toBe(h);
  });
});

describe('disposeModel', () => {
  const tex = (): TextureLike => ({ isTexture: true, dispose: vi.fn() });
  const mat = (o: Record<string, unknown> = {}): MaterialLike => ({ dispose: vi.fn(), userData: {}, ...o });
  const node = (o: Partial<NodeLike>, kids: NodeLike[] = []): NodeLike => {
    const n: NodeLike = { ...o, traverse(fn) { fn(n); for (const k of kids) k.traverse(fn); } };
    return n;
  };
  it('disposes every geometry, material and texture exactly once', () => {
    const albedo = tex(), normal = tex(), shared = tex(), dep = tex(), checker = tex(), orig = tex();
    const sharedMat = mat({ map: albedo, normalMap: normal });
    const other = mat({ map: checker, lightMap: shared, aoMap: shared, userData: { origMap: orig } });   // UV checker on
    const g1 = { dispose: vi.fn() }, g2 = { dispose: vi.fn() }, g3 = { dispose: vi.fn() }, skel = { dispose: vi.fn() };
    const axesMat = mat();
    const root = node({}, [
      node({ isMesh: true, geometry: g1, material: sharedMat }),
      node({ isMesh: true, geometry: g2, material: sharedMat, skeleton: skel }),
      node({ isMesh: true, geometry: g3, material: [other, sharedMat] }, [node({ isLine: true, geometry: g1, material: axesMat })]),
    ]);
    const n = disposeModel(root, [dep, shared], new Set([checker]));
    for (const r of [albedo, normal, shared, dep, orig, g1, g2, g3, skel, sharedMat, other, axesMat]) expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(checker.dispose).not.toHaveBeenCalled();
    expect(other.map).toBe(orig);   // original restored before disposal
    expect(n).toBe(12);
  });
  it('disposes the original material kept by a channel view', () => {
    const origMat = mat({ map: tex() });
    const root = node({}, [node({ isMesh: true, geometry: { dispose: vi.fn() }, material: mat(), userData: { origMat } })]);
    disposeModel(root);
    expect(origMat.dispose).toHaveBeenCalledTimes(1);
    expect((origMat.map as TextureLike).dispose).toHaveBeenCalledTimes(1);
  });
  it('disposeObject frees helper geometry and materials once', () => {
    const g = { dispose: vi.fn() }, m = mat();
    disposeObject(node({ geometry: g, material: m }, [node({ geometry: g, material: m })]));
    expect(g.dispose).toHaveBeenCalledTimes(1);
    expect(m.dispose).toHaveBeenCalledTimes(1);
    expect(() => disposeObject(null)).not.toThrow();
  });
});

describe('status and orbit', () => {
  const stats = { name: 'rifle', tris: 120.0001, verts: 96, meshes: 3, materials: 2, nodes: 5, sockets: 1, clips: 0, size: [2, 1, 6] as [number, number, number], bytes: 2048 };
  it('status line formatting', () => {
    expect(statusLine(stats, null)).toBe('rifle · 120 tris · 96 verts · 3 meshes · 2 materials · 5 nodes · 1 sockets · 0 clips · size 2.00×1.00×6.00 u · 2.0 KB');
    expect(statusLine({ ...stats, snap: 'v3' }, { size_units: [2, 1, 6], rig: { nodes: [{ name: 'a' }, 'b'] }, warnings: ['no texture'] }))
      .toBe('rifle (snapshot v3) · 120 tris · 96 verts · 3 meshes · 2 materials · 5 nodes · 1 sockets · 0 clips · size 2×1×6 u · rig 2 nodes · 2.0 KB · ⚠ no texture');
    expect(composeStatus('base', '')).toBe('base');
    expect(composeStatus('base', 'channel Normal')).toBe('base · channel Normal');
    expect(usesCanvas({ materials: ['overlay:rifle_tex', 'wood'] }, 'rifle_tex')).toBe(true);
    expect(usesCanvas({ materials: ['wood'] }, 'rifle_tex')).toBe(false);
    expect(usesCanvas(null, 'x')).toBe(false);
  });
  it('keyboard orbit keeps the distance and stays off the poles; dolly scales it', () => {
    const o = orbitOffset({ x: 0, y: 0, z: 10 }, Math.PI / 2, 0);
    expect(o.x).toBeCloseTo(10); expect(o.z).toBeCloseTo(0); expect(o.y).toBeCloseTo(0);
    const up = orbitOffset({ x: 0, y: 9.99, z: 0.1 }, 0, -1);
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(Math.hypot(9.99, 0.1));
    expect(up.y).toBeLessThan(Math.hypot(9.99, 0.1));
    const d = orbitOffset({ x: 3, y: 4, z: 0 }, 0, 0, 0.5);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(2.5);
    expect(orbitKey('ArrowLeft')).toEqual([-ORBIT_STEP, 0, 1]);
    expect(orbitKey('+')?.[2]).toBeLessThan(1);
    expect(orbitKey('-')?.[2]).toBeGreaterThan(1);
    expect(orbitKey('a')).toBeNull();
  });
  it('clock delta is clamped', () => {
    expect(clampDt(5)).toBe(0.1);
    expect(clampDt(0.016)).toBe(0.016);
    expect(clampDt(-1)).toBe(0);
  });
});
