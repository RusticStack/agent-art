// Shared test fixture: base URL from the e2e state file, a page object, and guards that fail a test
// on any console error, page error, or request to another host (the UI must never call out).
import { test as base, expect, type Page } from '@playwright/test';
import { readState } from './cli.ts';
import { AppPage } from './app.page.ts';

export interface Guard { errors: string[]; foreign: string[]; allow(re: RegExp): void }

export const test = base.extend<{ app: AppPage; guard: Guard }>({
  baseURL: async ({}, use) => { await use(`http://127.0.0.1:${readState().port}`); },
  guard: [async ({ page }, use) => {
    const errors: string[] = [];
    const foreign: string[] = [];
    const allowed: RegExp[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()} @ ${m.location().url}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (/^(data|blob|about):/.test(u.protocol)) return;
      if (!['127.0.0.1', 'localhost'].includes(u.hostname)) foreign.push(r.url());
    });
    const g: Guard = { errors, foreign, allow: (re) => allowed.push(re) };
    await use(g);
    const real = errors.filter((e) => !allowed.some((re) => re.test(e)));
    expect(real, 'console / page errors').toEqual([]);
    expect(foreign, 'requests to other hosts').toEqual([]);
  }, { auto: true }],
  app: async ({ page }, use) => { await use(new AppPage(page)); },
});

export { expect };
export type { Page };

/** Poll the canvas element's pixels: share of pixels that differ from the first pixel (0..1). */
export async function nonBackgroundShare(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return 0;
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const x = t.getContext('2d')!;
    x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, t.width, t.height).data;
    let n = 0;
    const [r, g, b, a] = [d[0], d[1], d[2], d[3]];
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) + Math.abs(d[i + 3] - a) > 12) n++;
    return n / (d.length / 4);
  }, selector);
}
