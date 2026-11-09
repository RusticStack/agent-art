import { test, expect } from './fixtures.ts';

test.use({ viewport: { width: 430, height: 900 } });

test('narrow layout: pane toggles, assets drawer opens and closes, canvas renders', async ({ app }) => {
  await app.goto('helmet_front');
  await expect(app.topButton('toggleBrowser')).toBeVisible();
  await expect(app.topButton('toggleSide')).toBeVisible();
  await expect(app.pixelCanvas()).toBeVisible();
  await expect(app.browserPane()).toBeHidden();
  await app.topButton('toggleBrowser').click();
  await expect(app.browserPane()).toBeVisible();
  await app.topButton('toggleBrowser').click();
  await expect(app.browserPane()).toBeHidden();
});
