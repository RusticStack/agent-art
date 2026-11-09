// One test per viewer: open it and check its main surface and status text.
import { test, expect, nonBackgroundShare } from './fixtures.ts';

test('canvas editor', async ({ app }) => {
  await app.goto('helmet_front');
  await expect(app.pixelCanvas()).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/helmet_front · 24×24/);
  await expect(app.toolButton('pencil')).toBeVisible();
});

test('animation player', async ({ app, page }) => {
  await app.goto('spark');
  await app.tab('Animation').click();
  await expect(app.slot('A').locator('canvas.anim-cell').first()).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/spin/);
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.anim-cell')).toBeGreaterThan(0.01);
});

test('sheet preview', async ({ app }) => {
  await app.goto('spark');
  await app.tab('Sheet').click();
  await expect(app.slot('A').locator('canvas.sheet-canvas')).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/4 cells/);
});

test('layers view (canvas)', async ({ app }) => {
  await app.goto('helmet_front');
  await app.tab('Layers').click();
  await expect(app.slot('A').locator('canvas.layers-canvas')).toBeVisible();
  await expect(app.slot('A').locator('.stack-list > *')).toHaveCount(2);
});

test('rig viewer', async ({ app, page }) => {
  await app.goto('rig:hero');
  await expect(app.slot('A').locator('canvas.rig-canvas')).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/walk_/);
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.rig-canvas')).toBeGreaterThan(0.01);
});

test('3D model viewer opens', async ({ app }) => {
  await app.goto('model:rifle');
  await expect(app.slot('A').locator('.model-stage canvas')).toBeVisible({ timeout: 20_000 });
  await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
});

test('audio player', async ({ app, page }) => {
  await app.goto('audio:rifle_shot');
  await expect(app.slot('A').locator('canvas.wave')).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/rifle_shot/);
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.wave')).toBeGreaterThan(0.01);
});

test('asset graph', async ({ app }) => {
  await app.goto('graph');
  await expect(app.slot('A').locator('.graph-viewer')).toBeVisible();
  await expect(app.slot('A').locator('.vtoolbar')).toContainText(/\d+ nodes/);
});

test('export preview: PNG', async ({ app }) => {
  await app.goto('export:helmet_front.png');
  await expect(app.slot('A').locator('canvas.pixel-canvas')).toBeVisible();
  await expect(app.slot('A').locator('.vtoolbar')).toContainText('helmet_front.png');
});

test('export preview: spritesheet', async ({ app }) => {
  await app.goto('export:spark.png');
  await expect(app.slot('A').locator('canvas.sheet-canvas')).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/frame/);
});

test('export preview: JSON text', async ({ app }) => {
  await app.goto('export:spark.json');
  await expect(app.slot('A').locator('canvas.sheet-canvas, pre.file-text').first()).toBeVisible();
});

test('project overview', async ({ app }) => {
  await app.goto('project:severance');
  await expect(app.slot('A').locator('.ov-tile')).toHaveCount(3);
  await app.slot('A').locator('.ov-tile', { hasText: 'pauldron' }).click();
  await expect(app.slotTitle('A')).toContainText('pauldron');
});
