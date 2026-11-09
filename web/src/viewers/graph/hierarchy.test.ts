// Runs the real dagre in Node. The first test checks that the limits short-circuit before dagre is imported.
import { describe, expect, it, vi } from 'vitest';
import { CARD_BOX, HIER_MAX_EDGES, HIER_MAX_NODES, HIER_OPTS, hierarchyFits, hierarchyLayout, layoutEdges, type HierEdge, type HierNode } from './hierarchy';

const imported = vi.hoisted(() => ({ n: 0 }));
vi.mock('@dagrejs/dagre', async (importOriginal) => {
  imported.n++;
  return await importOriginal<typeof import('@dagrejs/dagre')>();
});

const card = (id: string, kind = id.slice(0, id.indexOf(':'))): HierNode => ({ id, kind, w: CARD_BOX.w, h: CARD_BOX.h });
function overlaps(pos: Map<string, { x: number; y: number }>, nodes: HierNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], p = pos.get(a.id)!, q = pos.get(b.id)!;
    if (Math.abs(p.x - q.x) < (a.w + b.w) / 2 && Math.abs(p.y - q.y) < (a.h + b.h) / 2) return true;
  }
  return false;
}

describe('hierarchyLayout', () => {
  it('over the node / edge limits: returns the fallback signal without importing dagre', async () => {
    const many = Array.from({ length: HIER_MAX_NODES + 1 }, (_, i) => card(`canvas:c${i}`));
    expect(await hierarchyLayout(many, [{ from: many[0].id, to: many[1].id, rel: 'depends_on' }])).toBeNull();
    const few = [card('canvas:a'), card('canvas:b')];
    const edges = Array.from({ length: HIER_MAX_EDGES + 1 }, (): HierEdge => ({ from: 'canvas:a', to: 'canvas:b', rel: 'depends_on' }));
    expect(await hierarchyLayout(few, edges)).toBeNull();
    expect(imported.n).toBe(0);
    expect(hierarchyFits(HIER_MAX_NODES, HIER_MAX_EDGES)).toBe(true);
    expect(hierarchyFits(HIER_MAX_NODES + 1, 0)).toBe(false);
  });

  it('ranks a project → canvas → layer chain left to right (containment reversed), no overlaps', async () => {
    const nodes = [card('layer:helmet_front/base'), card('canvas:helmet_front'), card('canvas:helmet_side'), card('project:severance'), card('palette:steel')];
    const edges: HierEdge[] = [
      { from: 'canvas:helmet_front', to: 'project:severance', rel: 'part_of' },
      { from: 'canvas:helmet_side', to: 'project:severance', rel: 'part_of' },
      { from: 'layer:helmet_front/base', to: 'canvas:helmet_front', rel: 'layer_of' },
      { from: 'canvas:helmet_side', to: 'canvas:helmet_front', rel: 'variant_of' },
      { from: 'canvas:helmet_front', to: 'palette:steel', rel: 'uses_palette' },
    ];
    const pos = (await hierarchyLayout(nodes, edges))!;
    expect(imported.n).toBe(1);
    const x = (id: string) => pos.get(id)!.x;
    expect(x('project:severance')).toBeLessThan(x('canvas:helmet_front'));
    expect(x('canvas:helmet_front')).toBeLessThan(x('layer:helmet_front/base'));
    // variant_of keeps its direction: the variant is left of the original
    expect(x('canvas:helmet_side')).toBeLessThan(x('canvas:helmet_front'));
    expect(x('canvas:helmet_front')).toBeLessThan(x('palette:steel'));
    expect(pos.size).toBe(nodes.length);
    expect(overlaps(pos, nodes)).toBe(false);
    // deterministic
    const again = (await hierarchyLayout([...nodes].reverse(), edges))!;
    for (const n of nodes) expect(again.get(n.id)).toEqual(pos.get(n.id));
  });

  it('a cycle does not throw; parallel edges are added once', async () => {
    const nodes = [card('canvas:a'), card('canvas:b'), card('canvas:c')];
    const edges: HierEdge[] = [
      { from: 'canvas:a', to: 'canvas:b', rel: 'depends_on' }, { from: 'canvas:b', to: 'canvas:c', rel: 'depends_on' },
      { from: 'canvas:c', to: 'canvas:a', rel: 'depends_on' }, { from: 'canvas:a', to: 'canvas:b', rel: 'rendered_from' },
      { from: 'canvas:a', to: 'canvas:a', rel: 'replaces' },
    ];
    const pos = (await hierarchyLayout(nodes, edges))!;
    expect(pos.size).toBe(3);
    expect(overlaps(pos, nodes)).toBe(false);
    expect(layoutEdges(new Set(nodes.map((n) => n.id)), edges)).toEqual([['canvas:a', 'canvas:b'], ['canvas:b', 'canvas:c'], ['canvas:c', 'canvas:a']]);
    // part_of + a reversed duplicate collapse to one container -> part edge
    expect(layoutEdges(new Set(['canvas:a', 'group:g']), [{ from: 'canvas:a', to: 'group:g', rel: 'part_of' }, { from: 'canvas:a', to: 'group:g', rel: 'part_of' }])).toEqual([['group:g', 'canvas:a']]);
  });

  it('unconnected nodes are stacked in a last column, kind order then id', async () => {
    const nodes = [card('canvas:a'), card('canvas:b'), card('palette:zz'), card('canvas:loose2'), card('project:p'), card('canvas:loose1')];
    const edges: HierEdge[] = [{ from: 'canvas:a', to: 'canvas:b', rel: 'depends_on' }];
    const pos = (await hierarchyLayout(nodes, edges))!;
    const right = Math.max(pos.get('canvas:a')!.x, pos.get('canvas:b')!.x);
    const col = ['project:p', 'canvas:loose1', 'canvas:loose2', 'palette:zz'];
    for (const id of col) expect(pos.get(id)!.x).toBeCloseTo(right + CARD_BOX.w + HIER_OPTS.ranksep);
    const ys = col.map((id) => pos.get(id)!.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(CARD_BOX.h + HIER_OPTS.nodesep);
    expect(overlaps(pos, nodes)).toBe(false);
    // only isolated nodes: one column, dagre not needed
    const solo = (await hierarchyLayout([card('canvas:x'), card('audio:y')], []))!;
    expect(solo.get('canvas:x')!.y).toBeLessThan(solo.get('audio:y')!.y);
    expect(await hierarchyLayout([], [])).toEqual(new Map());
  });
});
