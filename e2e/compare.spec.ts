// Step 18c: compare tools (RV7). Timeline ⇆ puts before / after side by side; D cycles the overlay;
// Link mirrors zoom; the swipe bar drags; a non-canvas slot B removes the tools and A edits again.
import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

interface Dbg { zoom: number; overlay: string | null; split: number }

test('compare tools: Difference, linked zoom, Link off, swipe drag, model in B', async ({ app, page }) => {
  await app.goto('pauldron');
  runTool('art_draw', { canvas: 'pauldron', commands: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#123456' }] });
  const entry = app.timelineEntry(/pauldron/);
  await expect(entry).toContainText('draw', { timeout: 5000 });
  await app.timelineCompare(entry).click();
  await expect(app.slotWrap('B')).toBeVisible();
  await expect(app.stateBadge('A')).toContainText('before');
  await expect(app.stateBadge('B')).toContainText('after');
  await expect(app.compareTools()).toBeVisible();
  await expect(app.overlaySelect()).toHaveValue('off');

  // D: Difference, and the status counts the one changed pixel
  await app.blur();
  await app.press('d');
  await expect(app.overlaySelect()).toHaveValue('diff');
  await expect(app.overlaySelect().locator('option:checked')).toHaveText('Difference');
  await expect(app.compareStatus()).toHaveText(/^1 px differ/);
  await expect(app.toolGroup()).toHaveAttribute('aria-disabled', 'true');
  await expect(app.toolButton('pencil')).toBeDisabled();

  // + zooms both while linked
  const z = async (s: 'A' | 'B') => (await app.viewerDebug<Dbg>(s))!.zoom;
  const z0 = await z('A');
  await app.press('+');
  await expect.poll(() => z('A')).toBeGreaterThan(z0);
  await expect.poll(() => z('B')).toBe(await z('A'));

  // Link off: A zooms alone
  await app.compareLink().click();
  await expect(app.compareLink()).toHaveAttribute('aria-pressed', 'false');
  const zb = await z('B');
  const za = await z('A');
  await app.blur();
  await app.press('-');
  await expect.poll(() => z('A')).toBeLessThan(za);
  expect(await z('B')).toBe(zb);

  // Swipe: dragging the bar moves the split and changes what is drawn
  await app.overlaySelect().selectOption('swipe');
  await expect(app.compareStatus()).toContainText(/drag the bar/);
  await expect.poll(async () => (await app.viewerDebug<Dbg>('A'))!.overlay).toBe('swipe');
  const split0 = (await app.viewerDebug<Dbg>('A'))!.split;
  const before = await app.canvasHash('A');
  const bar = await app.swipeBar();
  await page.mouse.down();
  await page.mouse.move(bar.x - 60, bar.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await app.viewerDebug<Dbg>('A'))!.split).toBeLessThan(split0);
  await expect.poll(() => app.canvasHash('A')).not.toBe(before);

  // a model in slot B: no compare tools, A's paint tools work again
  await app.openTarget({ kind: 'model', name: 'rifle' }, 'B');
  await expect(app.slotTitle('B')).toContainText('rifle');
  await expect(app.compareTools()).toBeHidden();
  await expect.poll(async () => (await app.viewerDebug<Dbg>('A'))!.overlay).toBeNull();
  await expect(app.toolGroup()).toHaveAttribute('aria-disabled', 'false');
  await expect(app.toolButton('pencil')).toBeEnabled();
});
