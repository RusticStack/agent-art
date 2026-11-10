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
      '--k-frame', '--k-graph', '--tooltip-bg', '--select-bg', '--violet-bg', '--orphan-fg', '--orphan-bg', '--orphan-line', '--s-9', '--r-pill', '--font-ui', '--font-mono', '--fs-6', '--h-control', '--hit-min', '--shadow-drawer', '--ease', '--z-tooltip']) t(n);
  });

  // step 20: --muted (#9aa3b2, was #8b93a1) and --dim (#828b9b, was #5b6372) reach AA too
  for (const fg of ['--text', '--text2', '--muted', '--dim']) {
    for (const bg of SURFACES) it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(t(fg), t(bg))).toBeGreaterThanOrEqual(4.5));
  }
  it('step 20 values of --muted and --dim', () => {
    expect(t('--muted').toLowerCase()).toBe('#9aa3b2');
    expect(t('--dim').toLowerCase()).toBe('#828b9b');   // 4.1's #7f8898 is 4.36:1 on --panel2
  });
  // text drawn on the step 20 surface tokens
  it('--text on --tooltip-bg and --select-bg >= 4.5', () => {
    for (const bg of ['--tooltip-bg', '--select-bg']) expect(contrast(t('--text'), t(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it('--orphan-fg on --orphan-bg >= 4.5', () => expect(contrast(t('--orphan-fg'), t('--orphan-bg'))).toBeGreaterThanOrEqual(4.5));
  for (const [fg, bg] of [['--blue-fg', '--blue-bg'], ['--green-fg', '--green-bg'], ['--red-fg', '--red-bg'], ['--accent-fg', '--accent-bg2']]) {
    it(`${fg} on ${bg} >= 4.5 (badges)`, () => expect(contrast(t(fg), t(bg))).toBeGreaterThanOrEqual(4.5));
  }
  it('--accent-fg on --accent-bg >= 4.5', () => expect(contrast(t('--accent-fg'), t('--accent-bg'))).toBeGreaterThanOrEqual(4.5));
  it('--accent-ink on --accent >= 4.5', () => expect(contrast(t('--accent-ink'), t('--accent'))).toBeGreaterThanOrEqual(4.5));
  for (const bg of SURFACES) it(`--focus on ${bg} >= 3`, () => expect(contrast(t('--focus'), t(bg))).toBeGreaterThanOrEqual(3));
});

describe('canvas chrome colours (themeColors)', () => {
  it('the no-DOM fallbacks match tokens.css', async () => {
    const { themeColors } = await import('@/lib/util/dom');
    const fb = themeColors();
    const map: Record<string, string> = {
      stage: '--stage', canvasBg: '--canvas-bg', checkerA: '--checker-a', checkerB: '--checker-b', accent: '--accent', blue: '--blue', green: '--green', red: '--red',
      muted: '--muted', text: '--text', line: '--line', line2: '--line2', panel: '--panel', bg2: '--bg2', accentInk: '--accent-ink', redFg: '--red-fg', kAudio: '--k-audio',
      text2: '--text2', dim: '--dim', orphanFg: '--orphan-fg',
    };
    expect(Object.keys(fb).sort()).toEqual(Object.keys(map).sort());
    for (const [k, n] of Object.entries(map)) expect(fb[k as keyof typeof fb].toLowerCase(), k).toBe(t(n).toLowerCase());
  });
  it('withAlpha', async () => {
    const { withAlpha } = await import('@/lib/util/dom');
    expect(withAlpha('#f5a524', 0.5)).toBe('rgba(245,165,36,0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255,255,255,1)');
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });
});
