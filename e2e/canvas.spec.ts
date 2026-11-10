// Canvas editor (5.2): painting, undo, zoom keys, grid persistence, frame stepping, read-only snapshots,
// and the colour picker popover (RV5).
import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';

interface Entry { id: number; type: string; op?: string; source: string; args: { canvas?: string } }
async function lastUserOp(page: Page, op: string): Promise<Entry | undefined> {
  const r = await page.request.get('/api/activity?limit=50');
  const { entries } = (await r.json()) as { entries: Entry[] };
  return entries.filter((e) => e.type === 'op' && e.op === op && e.source === 'user').sort((a, b) => b.id - a.id)[0];
}

test('paint a pencil stroke, see the user draw in the timeline, undo it', async ({ app, page }) => {
  await app.goto('scratch');
  await expect(app.viewerStatus()).toContainText('scratch');
  await expect(app.toolButton('pencil')).toHaveAttribute('aria-checked', 'true');
  await app.pixelCanvas().click();
  await expect(app.timelineEntries().first()).toContainText('draw');
  await expect(app.timelineEntries().first()).toContainText('scratch');
  const drawn = await lastUserOp(page, 'draw');
  expect(drawn?.args.canvas).toBe('scratch');
  await app.blur();
  await app.press('Control+z');
  await expect.poll(async () => (await lastUserOp(page, 'undo'))?.args.canvas).toBe('scratch');
});

test('zoom keys, grid toggle persists across reload', async ({ app, page }) => {
  await app.goto('scratch');
  await app.blur();
  await app.press('0'); // fit first: reading the label right after open can race the initial fit
  await expect(app.zoomLabel()).not.toHaveText('');
  await app.page.waitForTimeout(150);
  const z0 = await app.zoomLabel().textContent();
  await app.press('-');
  await expect(app.zoomLabel()).not.toHaveText(z0 ?? '');
  await app.press('0');
  await expect(app.zoomLabel()).toHaveText(z0 ?? '');
  await expect(app.gridToggle()).toBeChecked();
  await app.press('#');
  await expect(app.gridToggle()).not.toBeChecked();
  await page.reload();
  await app.goto('scratch');
  await expect(app.gridToggle()).not.toBeChecked();
  await app.gridToggle().click();
  await expect(app.gridToggle()).toBeChecked();
});

test('frame stepping with , and .', async ({ app }) => {
  await app.goto('spark');
  await expect(app.frameLabel()).toHaveText('0 / 3');
  await app.blur();
  await app.press('.');
  await expect(app.frameLabel()).toHaveText('1 / 3');
  await app.press(',');
  await app.press(',');
  await expect(app.frameLabel()).toHaveText('3 / 3');
});

test('a snapshot is read-only (no paint tools)', async ({ app }) => {
  await app.goto('helmet_side');
  await expect(app.toolGroup()).toBeVisible();
  await app.timelineEntries().filter({ hasText: 'canvas=helmet_side' }).first().locator('.tl-line').first().click();
  await expect(app.slotTitle('A')).toContainText('state');
  await expect(app.toolGroup()).toBeHidden();
  await expect(app.viewerStatus()).toContainText('read-only snapshot');
});

test('colour picker: lazy chunk, hex entry, paint with it, recent colours, Esc returns focus', async ({ app, page }) => {
  const pickerRequests: string[] = [];
  page.on('request', (r) => { if (/hex-alpha-color-picker/.test(r.url())) pickerRequests.push(r.url()); });
  await app.goto('scratch');
  expect(pickerRequests, 'the picker chunk is not part of the initial load').toEqual([]);
  await app.colorSwatch().click();
  await expect(app.colorPopover()).toBeVisible();
  expect(pickerRequests.length).toBe(1);
  await app.hexInput().fill('#ff000080');
  await expect(app.colorSwatch()).toHaveAttribute('data-color', '#ff000080');
  await app.press('Escape');
  await expect(app.colorPopover()).toBeHidden();
  await expect(app.colorSwatch()).toBeFocused();
  const box = await app.pixelCanvas().boundingBox();
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/op') && r.postDataJSON()?.op === 'draw');
  await app.pixelCanvas().click({ position: { x: box!.width / 2 + 5, y: box!.height / 2 + 5 } });
  const req = await sent;
  expect(req.postDataJSON().args.commands[0].color).toBe('#ff000080');
  expect((await (await req.response())!.json()).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('agent-art:recentColors') ?? '')).toContain('#ff000080');
  await page.reload();
  await app.goto('scratch');
  await app.colorSwatch().click();
  await expect(app.colorPopover().locator('.recent .swatch[data-color="#ff000080"]')).toBeVisible();
  await app.press('Escape');
});
