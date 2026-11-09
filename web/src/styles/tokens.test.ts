/// <reference types="node" />
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, rootTokens } from '@/lib/util/contrast';

const tokens = rootTokens(fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8'));
const t = (n: string) => { const v = tokens[n]; if (!v) throw new Error(`missing token ${n}`); return v; };
const SURFACES = ['--bg', '--bg2', '--panel', '--panel2'];

describe('contrast helper', () => {
  it('known ratios', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
    expect(contrast('rgba(255,255,255,0)', '#000')).toBeCloseTo(1, 5);
  });
});

describe('tokens', () => {
  it('has every token of plan 4.1', () => {
    for (const n of ['--panel3', '--stage', '--canvas-bg', '--checker-a', '--checker-b', '--line3', '--scrim', '--text2', '--accent-fg', '--accent-bg', '--accent-bg2', '--accent-ink',
      '--blue-fg', '--blue-bg', '--blue-line', '--green-fg', '--green-bg', '--green-line', '--red-fg', '--red-bg', '--red-line', '--warn-fg', '--warn-line', '--focus',
      '--k-frame', '--k-graph', '--s-9', '--r-pill', '--font-ui', '--font-mono', '--fs-6', '--h-control', '--hit-min', '--shadow-drawer', '--ease', '--z-tooltip']) t(n);
  });

  for (const fg of ['--text', '--text2']) {
    for (const bg of SURFACES) it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(t(fg), t(bg))).toBeGreaterThanOrEqual(4.5));
  }
  // --muted and --dim reach AA in step 20 (#9aa3b2 / #7f8898)
  for (const fg of ['--muted', '--dim']) {
    for (const bg of SURFACES) it.todo(`${fg} on ${bg} >= 4.5 (step 20)`);
  }
  it('--accent-fg on --accent-bg >= 4.5', () => expect(contrast(t('--accent-fg'), t('--accent-bg'))).toBeGreaterThanOrEqual(4.5));
  it('--accent-ink on --accent >= 4.5', () => expect(contrast(t('--accent-ink'), t('--accent'))).toBeGreaterThanOrEqual(4.5));
  for (const bg of SURFACES) it(`--focus on ${bg} >= 3`, () => expect(contrast(t('--focus'), t(bg))).toBeGreaterThanOrEqual(3));
});
