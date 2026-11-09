// Step 7: rig viewer modes and the layers view (TS ports).
import { test, expect, nonBackgroundShare } from './fixtures.ts';

test('rig viewer: clip, pose (zoomable), parts, back to clip', async ({ app, page }) => {
  await app.goto('rig:hero');
  await expect(app.rigCanvas()).toBeVisible();
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.rig-canvas')).toBeGreaterThan(0.01);
  await app.rigMode().selectOption('pose');
  await expect(app.pixelCanvas()).toHaveAttribute('aria-label', 'pose preview');
  await expect(app.viewerStatus()).toContainText('red dashes = ground line');
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.pixel-canvas')).toBeGreaterThan(0.01);
  await app.rigMode().selectOption('parts');
  await expect(app.viewerStatus()).toContainText('parts canvas hero_parts');
  await expect(app.slot('A').locator('canvas.pixel-canvas')).toHaveCount(1);
  await app.rigMode().selectOption('clip');
  await expect(app.rigCanvas()).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/walk_/);
});

test('layers view (rig): stack, hover readout, flag two parts', async ({ app }) => {
  await app.goto('rig:hero');
  await app.tab('Layers').click();
  await expect(app.layersCanvas()).toBeVisible();
  await expect.poll(() => app.stackRows().count()).toBeGreaterThanOrEqual(3);
  const box = (await app.layersCanvas().boundingBox())!;
  await app.layersCanvas().hover({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(app.hoverInfo()).toContainText(/x \d+ y \d+: (drawn by|empty)/);
  await expect(app.flagButton()).toBeDisabled();
  await app.stackRows().nth(0).locator('.sname').click();
  await app.stackRows().nth(1).locator('.sname').click();
  await expect(app.flagButton()).toBeEnabled();
  await expect(app.flagButton()).toHaveText(/^Flag: .+ above .+\?$/);
  await app.flagButton().click();
  await expect(app.dialog()).toBeVisible();
  const selects = app.dialog().locator('select');
  await expect(selects.nth(0)).toHaveValue('layering');
  await expect(selects.nth(1)).toHaveValue('high');
  await app.press('Escape');
  await expect(app.dialog()).toBeHidden();
});
