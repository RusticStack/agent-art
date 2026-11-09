import { describe, expect, it } from 'vitest';
import type { GraphDoc, GraphEdge } from '@/lib/api/types';
import {
  MAX_TICKS, SETTLE_ALPHA, applyFilter, buildGraph, centerOn, countsText, edgeLabel, findNode, fitView, hitTest, layeredLayout, makeRep,
  parseLayout, radius, reloadsOn, seedPos, stepForce, tipText, zoomAt, type FilterOpts, type SimNode,
} from './sim';

const doc = (ids: string[], edges: [string, string, string][] = [], extra: Partial<Record<string, Partial<GraphDoc['nodes'][number]>>> = {}): GraphDoc => ({
  nodes: ids.map((id) => ({ id, kind: id.split(':')[0], ...extra[id] })),
  edges: edges.map(([from, rel, to]) => ({ from, rel, to })),
  rels: ['part_of'],
});
const opts = (o: Partial<FilterOpts> = {}): FilterOpts => ({ tag: '', showSub: false, hiddenRels: new Set(), collapsed: new Set(), ...o });
const ids = (ns: { id: string }[]) => ns.map((n) => n.id).sort();

describe('graph sim', () => {
  it('seeds positions deterministically from the id and keeps surviving positions on reload', () => {
    expect(seedPos('canvas:a')).toEqual(seedPos('canvas:a'));
    expect(seedPos('canvas:a')).not.toEqual(seedPos('canvas:b'));
    const p = seedPos('canvas:a');
    expect(Math.abs(p.x)).toBeLessThanOrEqual(300);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(300);
    const g1 = buildGraph(doc(['canvas:a', 'canvas:b']));
    expect(g1.nodes.get('canvas:a')).toMatchObject({ x: p.x, y: p.y, name: 'a', kind: 'canvas' });
    const a = g1.nodes.get('canvas:a')!;
    a.x = 5; a.y = 6; a.pinned = true;
    const g2 = buildGraph(doc(['canvas:a', 'canvas:c']), g1.nodes);
    expect(g2.nodes.get('canvas:a')).toMatchObject({ x: 5, y: 6, pinned: true });
    expect(g2.nodes.get('canvas:c')).toMatchObject(seedPos('canvas:c'));
  });

  it('buildGraph drops dangling edges, counts degrees, lists relations and sorted tags', () => {
    const g = buildGraph(doc(['canvas:a', 'canvas:b'], [['canvas:a', 'variant_of', 'canvas:b'], ['canvas:a', 'x', 'canvas:gone']], { 'canvas:a': { tags: ['z', 'a'] }, 'canvas:b': { tags: ['a'] } }));
    expect(g.edges).toHaveLength(1);
    expect(g.nodes.get('canvas:a')!.deg).toBe(1);
    expect(g.rels).toEqual(['part_of', 'variant_of', 'x']);
    expect(g.tags).toEqual(['a', 'z']);
  });

  describe('applyFilter', () => {
    it('hides sub-assets unless shown', () => {
      const g = buildGraph(doc(['canvas:a', 'layer:a/base'], [['layer:a/base', 'layer_of', 'canvas:a']]));
      expect(ids(applyFilter(g.nodes, g.edges, opts()).vis)).toEqual(['canvas:a']);
      const r = applyFilter(g.nodes, g.edges, opts({ showSub: true }));
      expect(ids(r.vis)).toEqual(['canvas:a', 'layer:a/base']);
      expect(r.edges).toHaveLength(1);
    });
    it('tag filter keeps groups, but drops isolated ones', () => {
      const g = buildGraph(doc(['canvas:a', 'canvas:b', 'group:g', 'group:empty'], [['canvas:a', 'part_of', 'group:g'], ['canvas:b', 'part_of', 'group:g']], { 'canvas:a': { tags: ['hero'] } }));
      const r = applyFilter(g.nodes, g.edges, opts({ tag: 'hero' }));
      expect(ids(r.vis)).toEqual(['canvas:a', 'group:g']);
      expect(r.edges.map((e) => e.from)).toEqual(['canvas:a']);
    });
    it('hidden relations drop their edges', () => {
      const g = buildGraph(doc(['canvas:a', 'canvas:b'], [['canvas:a', 'variant_of', 'canvas:b'], ['canvas:a', 'depends_on', 'canvas:b']]));
      const r = applyFilter(g.nodes, g.edges, opts({ hiddenRels: new Set(['variant_of']) }));
      expect(r.edges.map((e) => e.rel)).toEqual(['depends_on']);
      expect(r.vis).toHaveLength(2);
    });
    it('nested collapsed groups fold into the outermost one, edges re-pointed and de-duplicated', () => {
      const g = buildGraph(doc(['canvas:a', 'canvas:b', 'canvas:x', 'group:inner', 'group:outer'], [
        ['canvas:a', 'part_of', 'group:inner'], ['canvas:b', 'part_of', 'group:inner'], ['group:inner', 'part_of', 'group:outer'],
        ['canvas:a', 'depends_on', 'canvas:x'], ['canvas:b', 'depends_on', 'canvas:x'],
      ]));
      const r = applyFilter(g.nodes, g.edges, opts({ collapsed: new Set(['group:inner', 'group:outer']) }));
      expect(ids(r.vis)).toEqual(['canvas:x', 'group:outer']);
      expect(r.edges.map((e) => `${e.a.id} ${e.rel} ${e.b.id}`)).toEqual(['group:outer depends_on canvas:x']);
      // only the inner one collapsed
      const r2 = applyFilter(g.nodes, g.edges, opts({ collapsed: new Set(['group:inner']) }));
      expect(ids(r2.vis)).toEqual(['canvas:x', 'group:inner', 'group:outer']);
      expect(r2.edges.map((e) => `${e.a.id} ${e.rel} ${e.b.id}`).sort()).toEqual(['group:inner depends_on canvas:x', 'group:inner part_of group:outer']);
    });
    it('a group cycle does not hang', () => {
      const edges: GraphEdge[] = [{ from: 'group:a', rel: 'part_of', to: 'group:b' }, { from: 'group:b', rel: 'part_of', to: 'group:a' }];
      const rep = makeRep(edges, new Set(['group:a', 'group:b']));
      expect(['group:a', 'group:b']).toContain(rep('group:a'));
      const g = buildGraph({ nodes: [{ id: 'group:a', kind: 'group' }, { id: 'group:b', kind: 'group' }], edges, rels: [] });
      expect(() => applyFilter(g.nodes, g.edges, opts({ collapsed: new Set(['group:a', 'group:b']) }))).not.toThrow();
    });
  });

  it('fitView frames every node with padding, zoom at most 2', () => {
    expect(fitView([], 100, 100)).toBeNull();
    const v = fitView([{ x: 0, y: 0 }, { x: 100, y: 50 }], 480, 380)!;
    expect(v.k).toBe(2); // min(400/100, 300/50) capped at 2
    expect(v.x + 50 * v.k).toBe(240);
    expect(v.y + 25 * v.k).toBe(190);
    const w = fitView([{ x: 0, y: 0 }, { x: 1000, y: 0 }], 580, 400)!;
    expect(w.k).toBe(0.5);
  });

  it('hitTest: nearest wins, misses return null', () => {
    const ns = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }];
    expect(hitTest(ns, 7, 0, 1, () => 11)?.id).toBe('b');
    expect(hitTest(ns, 2, 0, 1, () => 11)?.id).toBe('a');
    expect(hitTest(ns, 200, 0, 1, () => 11)).toBeNull();
  });

  it('layeredLayout puts kinds in column order and sorts rows by id', () => {
    const g = buildGraph(doc(['canvas:b', 'canvas:a', 'group:g', 'project:p', 'weird:x']));
    const vis = [...g.nodes.values()];
    layeredLayout(vis);
    const at = (id: string) => g.nodes.get(id)!;
    expect(at('group:g').x).toBe(0);
    expect(at('project:p').x).toBe(220);
    expect(at('canvas:a').x).toBe(440);
    expect(at('canvas:a').y).toBeLessThan(at('canvas:b').y);
    expect(at('weird:x').x).toBe(660); // unknown kind -> 'file' column
  });

  it('force step: moves free nodes, keeps pinned and dragged nodes fixed, cools down', () => {
    const g = buildGraph(doc(['canvas:a', 'canvas:b', 'canvas:c'], [['canvas:a', 'variant_of', 'canvas:b'], ['canvas:b', 'variant_of', 'canvas:c']]));
    const vis = [...g.nodes.values()];
    const r = applyFilter(g.nodes, g.edges, opts());
    const a = g.nodes.get('canvas:a')!, b = g.nodes.get('canvas:b')!, c = g.nodes.get('canvas:c')!;
    a.pinned = true;
    const [ax, ay, bx, by, cx] = [a.x, a.y, b.x, b.y, c.x];
    const next = stepForce(vis, r.edges, 1, 'canvas:b');
    expect(next).toBeCloseTo(0.985);
    expect([a.x, a.y]).toEqual([ax, ay]);
    expect([b.x, b.y]).toEqual([bx, by]);
    expect(c.x).not.toBe(cx);
    expect(stepForce(vis, r.edges, SETTLE_ALPHA / 2)).toBe(SETTLE_ALPHA / 2);
    // a full run settles within the tick cap
    let alpha = 1, n = 0;
    while (alpha >= SETTLE_ALPHA && n < 1000) { alpha = stepForce(vis, r.edges, alpha); n++; }
    expect(n).toBeGreaterThan(MAX_TICKS - 10);
  });

  it('force step is deterministic for coincident nodes', () => {
    const mk = () => { const g = buildGraph(doc(['canvas:a', 'canvas:b'])); for (const n of g.nodes.values()) { n.x = 0; n.y = 0; } return [...g.nodes.values()]; };
    const v1 = mk(), v2 = mk();
    stepForce(v1, [], 1); stepForce(v2, [], 1);
    expect(v1.map((n) => [n.x, n.y])).toEqual(v2.map((n) => [n.x, n.y]));
    expect(v1[0].x).not.toBe(v1[1].x);
  });

  it('zoom, centre, radius, text helpers', () => {
    const v = zoomAt({ x: 0, y: 0, k: 1 }, 100, 100, 2);
    expect(v).toEqual({ k: 2, x: -100, y: -100 });
    expect(zoomAt({ x: 0, y: 0, k: 5 }, 0, 0, 10).k).toBe(6);
    expect(centerOn({ x: 0, y: 0, k: 0.5 }, 10, 20, 200, 100, 1.2)).toEqual({ k: 1.2, x: 100 - 12, y: 50 - 24 });
    expect(centerOn({ x: 0, y: 0, k: 3 }, 0, 0, 200, 100, 1.2).k).toBe(3);
    expect(radius({ kind: 'group', deg: 9 })).toBe(16);
    expect(radius({ kind: 'layer', deg: 9 })).toBe(6);
    expect(radius({ kind: 'canvas', deg: 4 })).toBe(13);
    expect(countsText(3, 2, 0)).toBe('3 nodes · 2 edges');
    expect(countsText(3, 2, 1)).toBe('3 nodes · 2 edges · 1 collapsed');
    expect(tipText({ id: 'canvas:a', kind: 'canvas', note: 'n', reviews: 2, approved: true, orphan: true })).toBe('canvas:a — n · 2 open review · approved · orphan');
    expect(edgeLabel({ rel: 'view_of', attrs: { side: 'left', n: 2 } })).toBe('view_of side:left,n:2');
    const vis = [{ id: 'canvas:helmet', kind: 'canvas' }, { id: 'canvas:pauldron', kind: 'canvas', note: 'Left shoulder' }] as SimNode[];
    expect(findNode(vis, 'HELM')?.id).toBe('canvas:helmet');
    expect(findNode(vis, 'shoulder')?.id).toBe('canvas:pauldron');
    expect(findNode(vis, '  ')).toBeNull();
    expect(parseLayout('layered')).toBe('layered');
    expect(parseLayout('hierarchy')).toBe('force');
  });

  it('reload events: structural changes only', () => {
    expect(reloadsOn({ type: 'graph' })).toBe(true);
    expect(reloadsOn({ type: 'change' })).toBe(false);
    expect(reloadsOn({ type: 'change', structural: true })).toBe(true);
    expect(reloadsOn({ type: 'resync' })).toBe(true);
    expect(reloadsOn({ type: 'activity' })).toBe(false);
  });
});
