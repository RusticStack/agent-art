import { describe, expect, it } from 'vitest';
import {
  AUTO_CARDS_MAX_EDGES, AUTO_CARDS_MAX_NODES, CARDS_MAX_NODES, CARD_H, CARD_W, cardData, chooseRenderer, clipToBoxes, foldedCounts,
  fromCards, parseRendererPref, relData, relatedTo, relationCounts, rendererSuffix, toCards, type CardContext,
} from './cards';
import { makeRep, type SimNode, type VisEdge } from './sim';

const node = (id: string, extra: Partial<SimNode> = {}): SimNode => {
  const i = id.indexOf(':');
  return { id, kind: id.slice(0, i), name: id.slice(i + 1), x: 0, y: 0, vx: 0, vy: 0, deg: 0, ...extra };
};
const edge = (a: SimNode, rel: string, b: SimNode, derived = false): VisEdge => ({ from: a.id, rel, to: b.id, derived, a, b });
const ctx = (over: Partial<CardContext> = {}): CardContext => ({
  thumb: (n) => `/thumb/${n.name}.png`, isPinned: () => false, isHidden: () => false, collapsed: new Set(), ...over,
});

describe('chooseRenderer', () => {
  it.each([
    // pref, nodes, edges, broken -> kind, large, refused
    ['auto', 10, 20, false, 'cards', false, false],
    ['auto', AUTO_CARDS_MAX_NODES, AUTO_CARDS_MAX_EDGES, false, 'cards', false, false],
    ['auto', AUTO_CARDS_MAX_NODES + 1, 10, false, 'canvas', true, false],
    ['auto', 10, AUTO_CARDS_MAX_EDGES + 1, false, 'canvas', true, false],
    ['auto', 10, 20, true, 'canvas', false, false],
    ['cards', 1000, 3000, false, 'cards', false, false],
    ['cards', CARDS_MAX_NODES, 0, false, 'cards', false, false],
    ['cards', CARDS_MAX_NODES + 1, 0, false, 'canvas', false, true],
    ['cards', 10, 0, true, 'canvas', false, false],
    ['canvas', 1, 0, false, 'canvas', false, false],
  ] as const)('%s with %i nodes / %i edges (broken %s) -> %s', (pref, n, e, broken, kind, large, refused) => {
    expect(chooseRenderer(pref, n, e, broken)).toEqual({ kind, large, refused });
  });

  it('suffix and stored value', () => {
    expect(rendererSuffix(chooseRenderer('auto', 3, 2))).toBe(' · cards');
    expect(rendererSuffix(chooseRenderer('auto', 3000, 2))).toBe(' · canvas (large graph)');
    expect(rendererSuffix(chooseRenderer('canvas', 3000, 2))).toBe(' · canvas');
    expect(parseRendererPref('cards')).toBe('cards');
    expect(parseRendererPref('canvas')).toBe('canvas');
    expect(parseRendererPref('bogus')).toBe('auto');
    expect(parseRendererPref(null)).toBe('auto');
  });
});

describe('card scale', () => {
  it('toCards then fromCards is the identity; x is stretched 2.2×', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 123.4, y: -56.7 }, { x: -1e4, y: 3e3 }]) {
      const q = fromCards(toCards(p));
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    }
    expect(toCards({ x: 10, y: 10 })).toEqual({ x: 22, y: 10 });
  });
});

describe('card data', () => {
  const helmet = node('canvas:helmet_front', { tags: ['armour', 'head', 'metal'], note: 'ignored when tags exist', reviews: 2, approved: true });
  const side = node('canvas:helmet_side', { note: 'Side view' });
  const grp = node('group:Severance armour');
  const audio = node('audio:clank', { missing: true, superseded: true, orphan: true });
  const edges = [edge(side, 'variant_of', helmet), edge(helmet, 'part_of', grp), edge(side, 'part_of', grp)];

  it('maps a node to what the card shows', () => {
    const d = cardData(helmet, 2, null, ctx());
    expect(d).toMatchObject({
      id: 'canvas:helmet_front', kind: 'canvas', kindLabel: 'canvas', label: 'helmet_front', sub: '#armour #head',
      icon: 'image', thumb: '/thumb/helmet_front.png', reviews: 2, approved: true, superseded: false, orphan: false,
      missing: false, group: false, folded: 0, dim: false, relations: 2, aria: 'canvas helmet_front, 2 relations',
    });
    expect(d.color).toMatch(/^#/);
    expect(cardData(side, 1, null, ctx()).sub).toBe('Side view');
    expect(cardData(side, 1, null, ctx()).aria).toBe('canvas helmet_side, 1 relation');
  });

  it('thumbnails only for canvas / model / rig and never for missing nodes; badges and flags', () => {
    const a = cardData(audio, 0, null, ctx({ isPinned: (id) => id === 'audio:clank', isHidden: () => true }));
    expect(a).toMatchObject({ thumb: null, icon: 'music', missing: true, superseded: true, orphan: true, pinned: true, hidden: true });
    expect(cardData(node('model:crate'), 0, null, ctx()).thumb).toBe('/thumb/crate.png');
    expect(cardData(node('rig:knight'), 0, null, ctx()).thumb).toBe('/thumb/knight.png');
    expect(cardData(node('palette:warm'), 0, null, ctx()).thumb).toBeNull();
  });

  it('groups show the full id and "+N" when collapsed', () => {
    const collapsed = new Set([grp.id]);
    const ids = [helmet.id, side.id, grp.id];
    const folded = foldedCounts(ids, makeRep(edges, collapsed), collapsed);
    expect(folded.get(grp.id)).toBe(2);
    const d = cardData(grp, 0, null, ctx({ collapsed, folded }));
    expect(d).toMatchObject({ label: 'group:Severance armour', group: true, collapsed: true, folded: 2, icon: 'group' });
    expect(cardData(grp, 0, null, ctx()).folded).toBe(0);
  });

  it('dims nodes unrelated to the selection; relation counts; edge data', () => {
    const lone = node('canvas:pauldron');
    const related = relatedTo(side.id, edges)!;
    expect([...related].sort()).toEqual([grp.id, helmet.id, side.id].sort());
    expect(relatedTo(null, edges)).toBeNull();
    expect(cardData(lone, 0, related, ctx()).dim).toBe(true);
    expect(cardData(helmet, 0, related, ctx()).dim).toBe(false);
    const counts = relationCounts(edges);
    expect([counts.get(helmet.id), counts.get(side.id), counts.get(grp.id), counts.get(lone.id)]).toEqual([2, 2, 2, undefined]);
    const r = relData(edges[0], side.id, edges.length);
    expect(r).toMatchObject({ rel: 'variant_of', label: 'variant_of', sel: true, dim: false, derived: false, labelOk: true });
    expect(relData(edges[1], side.id, edges.length)).toMatchObject({ sel: false, dim: true });
    expect(relData(edge(helmet, 'part_of', grp, true), null, 3).labelOk).toBe(false);
    expect(relData(edges[0], null, 600).labelOk).toBe(false);
  });
});

describe('clipToBoxes', () => {
  it('runs from border to border, stopping short of the target for the arrow', () => {
    const s = clipToBoxes(0, 0, 400, 0)!;
    expect(s.x1).toBeCloseTo(CARD_W / 2);
    expect(s.x2).toBeCloseTo(400 - CARD_W / 2 - 2);
    expect(s.y1).toBeCloseTo(0);
    const v = clipToBoxes(0, 0, 0, 300)!;
    expect(v.y1).toBeCloseTo(CARD_H / 2);
    expect(v.y2).toBeCloseTo(300 - CARD_H / 2 - 2);
  });
  it('null for coincident or overlapping boxes', () => {
    expect(clipToBoxes(5, 5, 5, 5)).toBeNull();
    expect(clipToBoxes(0, 0, 100, 0)).toBeNull();
  });
});
