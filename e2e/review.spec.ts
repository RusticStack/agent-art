import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

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

// Step 16: the Svelte inspector and review dialogs
test('review card: Accept a fixed note, Reopen with a reply, Delete with confirm', async ({ app }) => {
  const note = `step16 card ${Date.now()}`;
  const out = runTool('art_review', { action: 'add', asset: 'scratch', note, category: 'fix' });
  const id = out.match(/\br\d+\b/)?.[0];
  expect(id, out).toBeTruthy();
  await app.goto('scratch');
  const card = app.reviewCards().filter({ hasText: note });
  await expect(card).toBeVisible();
  await expect(card.locator('.rc-id')).toHaveText(id!);
  runTool('art_review', { action: 'update', id, status: 'fixed', reply: 'done' });
  await expect(card.locator('.rc-status')).toHaveText('fixed');
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(card.locator('.rc-status')).toHaveText('accepted');
  await card.getByRole('button', { name: 'Reopen' }).click();
  const ask = app.alertDialog(new RegExp(`^Reopen ${id}$`));
  await ask.getByRole('textbox', { name: 'What is still wrong?' }).fill('still too dark');
  await ask.getByRole('button', { name: 'OK' }).click();
  await expect(card.locator('.rc-status')).toHaveText('reopened');
  await expect(card.locator('.rc-reply')).toContainText('user: still too dark');
  await card.getByRole('button', { name: `Delete note ${id}` }).click();
  await app.alertDialog(`Delete ${id}?`).getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
});

test('inspector: layer eye makes a user layer entry; a palette swatch sets the colour; a relation opens', async ({ app }) => {
  await app.goto('helmet_side');
  const eye = app.inspectorSection('Layers').locator('li button.eye').first();
  const was = await eye.getAttribute('aria-pressed');
  await eye.click();
  await expect(eye).not.toHaveAttribute('aria-pressed', was!);
  await expect(app.timelineEntries().first()).toHaveClass(/\buser\b/);
  await expect(app.timelineEntries().first()).toContainText('layer');
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', was!);

  const sw = app.inspectorSection('Palette').locator('.palette:not(.used) .swatch').nth(1);
  const c = (await sw.getAttribute('data-color'))!.toLowerCase();
  await sw.click();
  await expect.poll(async () => ((await app.colorSwatch().getAttribute('data-color')) ?? '').toLowerCase().slice(0, 7)).toBe(c.slice(0, 7));

  await app.inspectorSection('Relations').getByRole('link', { name: 'canvas:helmet_front' }).click();
  await expect(app.slotTitle('A')).toContainText('helmet_front');
});

test('the Notes button opens the review list dialog', async ({ app }) => {
  await app.goto('helmet_front');
  await app.topButton('notes').click();
  const dlg = app.reviewListDialog();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('canvas:helmet_side');
  await app.press('Escape');
  await expect(dlg).toHaveCount(0);
});
