import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

test('an agent draw shows up live, the status pulses, follow opens it, the row flashes', async ({ app, page }) => {
  await app.goto('helmet_front');
  await expect(app.followMode()).toHaveValue('canvas');
  const before = await app.timelineEntries().count();
  // watch for the flash class on the browser row (it lasts 0.9 s)
  await page.evaluate(() => {
    (window as unknown as { __flashed: boolean }).__flashed = false;
    new MutationObserver(() => { if (document.querySelector('[data-id="canvas:spark"].flash')) (window as unknown as { __flashed: boolean }).__flashed = true; })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  });
  runTool('art_draw', { canvas: 'spark', commands: [{ op: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#e5484d', frame: 1 }] });
  await expect(app.timelineEntries().first()).toContainText('draw', { timeout: 3000 });
  await expect(app.timelineEntries().first()).toContainText('spark');
  expect(await app.timelineEntries().count()).toBeGreaterThan(before);
  await expect(app.status()).toHaveText('agent is working…');
  await expect(app.slotTitle('A')).toContainText('spark');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __flashed: boolean }).__flashed)).toBe(true);
  await expect(app.status()).toHaveText('live', { timeout: 5000 });
});

test('the seeded error is in the timeline and the counter shows it', async ({ app }) => {
  await app.goto('helmet_front');
  await expect(app.timelineCount()).toContainText(/\d+\/\d+ · \d+ err/);
  await app.timelineChip('Errors').click();
  await expect(app.timelineEntries().first()).toContainText('No canvas');
  await app.timelineChip('Errors').click();
});
