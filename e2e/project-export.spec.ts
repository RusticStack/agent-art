// Step 11: project overview (live tiles) and export previews (TS ports).
import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

test('project overview: tiles, size slider persists, an agent draw flashes its tile', async ({ app, page }) => {
  await app.goto('project:severance');
  const tiles = app.slot('A').locator('.ov-grid[role=list] button.ov-tile');
  await expect(tiles).toHaveCount(3);
  await expect(app.slot('A').locator('.ov-scroll p')).toContainText('3 canvases');
  await app.followMode().selectOption('project');
  const tile = tiles.filter({ hasText: 'pauldron' });
  const src = await tile.locator('img').getAttribute('src');
  runTool('art_draw', { canvas: 'pauldron', commands: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#f5a524' }] });
  await expect(tile).toHaveClass(/flash/);
  await expect(tile.locator('img')).not.toHaveAttribute('src', src ?? '');
  await expect(app.slotTitle('A')).toContainText('severance');
  await app.followMode().selectOption('canvas');
  const size = app.slot('A').locator('.vtoolbar input[type=range]');
  await size.fill('160');
  await page.reload();
  await expect(app.slot('A').locator('.vtoolbar input[type=range]')).toHaveValue('160');
  await app.slot('A').locator('.vtoolbar input[type=range]').fill('96');
});

test('export preview: image size, download link, JSON sidecar opens the sheet', async ({ app }) => {
  await app.goto('export:helmet_front.png');
  await expect(app.pixelCanvas()).toBeVisible();
  const bar = app.slot('A').locator('.vtoolbar');
  await expect(bar).toContainText('24×24');
  await expect(bar.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /helmet_front\.png.*download/);
  await app.goto('export:spark.json');
  await expect(app.sheetCanvas()).toBeVisible();
});
