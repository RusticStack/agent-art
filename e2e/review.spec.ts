import { test, expect } from './fixtures.ts';

test('review mode: drag a box on the canvas, add a note, it shows up', async ({ app, page }) => {
  await app.goto('pauldron');
  await expect(app.pixelCanvas()).toBeVisible();
  await expect(app.viewerStatus()).toContainText('pauldron');
  const before = Number((await app.notesCount().textContent()) || 0);
  await app.blur();
  await app.press('m');
  const box = (await app.pixelCanvas().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.up();
  const dlg = app.dialog();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('canvas:pauldron');
  await expect(dlg).toContainText(/box \[\d+,\d+,\d+,\d+\]/);
  await dlg.locator('textarea').fill('Rim highlight is too bright');
  await dlg.getByRole('button', { name: 'Add note' }).click();
  await expect(app.toasts().filter({ hasText: /Review note r\d+ added/ })).toBeVisible();
  await expect(app.notesCount()).toHaveText(String(before + 1));
  await expect(app.reviewCards().filter({ hasText: 'Rim highlight is too bright' })).toBeVisible();
  await expect(app.topButton('review')).not.toHaveClass(/\bon\b/);
});
