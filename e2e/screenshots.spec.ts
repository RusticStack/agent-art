// Documentation screenshots (@shots, excluded from the normal run): `npm run docs:ui-shots`.
// Writes to SHOTS_DIR (default docs/ui). Same seed as the e2e run. More shots are added in step 22.
import path from 'node:path';
import { test, expect } from './fixtures.ts';
import { ROOT } from './cli.ts';
import type { AppPage } from './app.page.ts';

const dir = () => path.resolve(ROOT, process.env.SHOTS_DIR || 'docs/ui');

async function settle(app: AppPage) {
  await app.page.evaluate(() => document.fonts.ready);
  await expect(app.viewerStatus()).not.toHaveText('');
  await app.imagesDecoded();
  await app.page.mouse.move(0, 0);
  await app.blur();
  await app.page.waitForTimeout(300);
}
async function shot(app: AppPage, name: string) {
  await settle(app);
  await app.page.screenshot({ path: path.join(dir(), `${name}.png`), mask: app.volatile(), maskColor: '#15171c' });
}

test.describe('@shots', () => {
  test('01-overview', async ({ app }) => {
    await app.goto('helmet_side');
    await expect(app.pixelCanvas()).toBeVisible();
    await shot(app, '01-overview');
  });

  test.describe('narrow', () => {
    test.use({ viewport: { width: 430, height: 900 } });
    test('18-narrow', async ({ app }) => {
      await app.goto('helmet_side');
      await expect(app.pixelCanvas()).toBeVisible();
      await shot(app, '18-narrow');
    });
  });
});
