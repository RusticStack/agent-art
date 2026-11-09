// Step 6: animation player and sheet preview (TS ports).
import { test, expect } from './fixtures.ts';

test('animation: rig output plays every view; Space pauses', async ({ app, page }) => {
  await app.goto('hero');
  await app.tab('Animation').click();
  await expect(app.animCells()).toHaveCount(3);
  await expect(app.viewerStatus()).toContainText(/3 views/);
  await app.blur();
  await page.keyboard.press(' ');
  await expect(app.animPlayButton()).toHaveAttribute('aria-pressed', 'false');
  const shot = () => app.animCells().first().evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const a = await shot();
  await page.waitForTimeout(300);
  expect(await shot()).toBe(a);
});

test('sheet: canvas cells and the exported spritesheet', async ({ app }) => {
  await app.goto('spark');
  await app.tab('Sheet').click();
  await expect(app.sheetCanvas()).toHaveAttribute('aria-label', /spark sprite sheet, 4 frames/);
  await expect(app.viewerStatus()).toContainText(/4 cells/);
  await app.goto('export:spark.png');
  await expect(app.sheetCanvas()).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/frame/);
});
