// Step 8: runtime check of the 3D viewer (plan, "e2e/model3d.spec.ts").
import { test, expect, type Page } from './fixtures.ts';
import type { Locator } from '@playwright/test';

/** Screenshot the element and return the share of pixels that differ from the clear colour #15171c. */
async function litShare(page: Page, el: Locator): Promise<number> {
  const png = (await el.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0x15) + Math.abs(d[i + 1] - 0x17) + Math.abs(d[i + 2] - 0x1c) > 12) n++;
    return n / (d.length / 4);
  }, png);
}
const shot = async (el: Locator) => (await el.screenshot()).toString('base64');

test('3D viewer: lazy three chunk, renders, wireframe, channel, clip plays, no context leak', async ({ app, page }) => {
  const threeLoads: number[] = [];
  let openedAt = Infinity;
  page.on('response', (r) => { if (/\/assets\/three-.*\.js/.test(r.url()) && r.status() === 200) threeLoads.push(Date.now()); });
  await app.goto('spark');
  expect(threeLoads).toHaveLength(0);
  openedAt = Date.now();
  await app.openAsset('rifle', 'model');
  await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
  await expect(app.modelFallback()).toHaveCount(0);
  expect(threeLoads.length).toBeGreaterThan(0);
  expect(Math.min(...threeLoads)).toBeGreaterThanOrEqual(openedAt);
  await expect.poll(() => litShare(page, app.modelCanvas())).toBeGreaterThan(0.01);

  await app.blur();
  await app.press('w');
  await expect(app.modelToggle('Wireframe')).toBeChecked();
  await app.press('w');
  await expect(app.modelToggle('Wireframe')).not.toBeChecked();

  const profile = page.waitForRequest((r) => r.url().includes('profile=three'));
  await app.modelChannel().selectOption('normal');
  await profile;
  await expect(app.viewerStatus()).toContainText('channel Normal');
  await app.modelChannel().selectOption({ index: 0 });

  // the longest clip, so two reads 300 ms apart are at different phases
  const clip = await app.modelClip().evaluate((s: HTMLSelectElement) => [...s.options].map((o) => o.value).filter(Boolean).at(-1) ?? '');
  test.skip(!clip, 'model has no clips');
  await app.modelClip().selectOption(clip);
  await app.blur();
  await expect.poll(async () => { const a = await shot(app.modelCanvas()); await page.waitForTimeout(300); return a !== await shot(app.modelCanvas()); }, { timeout: 10_000 }).toBe(true);

  const count = () => page.evaluate(() => document.querySelectorAll('canvas').length);
  const before = await count();
  for (let i = 0; i < 5; i++) {
    await app.openAsset('spark');
    await app.openAsset('rifle', 'model');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
  }
  expect(await count()).toBeLessThanOrEqual(before);
});
