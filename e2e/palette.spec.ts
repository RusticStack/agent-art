// Step 18b: the command palette (Ctrl/Cmd+K, top bar search button): assets and actions, compare with
// Alt+Enter, blocked by other dialogs, its own lazy chunk, Esc returns focus, axe.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.ts';
import { AppPage } from './app.page.ts';

test('palette: Ctrl+K, type, Enter opens an asset in slot A; "graph" opens the graph', async ({ app }) => {
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.blur();
  await app.openPalette();
  // empty query: Recent (spark was just opened) then Actions
  await expect(app.paletteOptions().first()).toContainText('spark');
  await app.paletteInput().fill('pauld');
  await expect(app.paletteActive()).toContainText('pauldron');
  await app.press('Enter');
  await expect(app.palette()).toHaveCount(0);
  await expect(app.slotTitle('A')).toContainText('pauldron');

  await app.blur();
  await app.openPalette();
  await app.paletteInput().fill('graph');
  await expect(app.paletteActive()).toContainText('Asset graph');
  await app.press('Enter');
  await expect(app.graph()).toBeVisible();
});

test('palette: Alt+Enter on an asset fills slot B', async ({ app }) => {
  await app.goto('pauldron');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.blur();
  await app.openPalette();
  await app.paletteInput().fill('spark');
  await expect(app.paletteActive()).toContainText('spark');
  await app.press('Alt+Enter');
  await expect(app.palette()).toHaveCount(0);
  await expect(app.slotTitle('B')).toContainText('spark');
  await expect(app.slotTitle('A')).toContainText('pauldron');
});

test('palette: does not open while the review note dialog is open', async ({ app, page }) => {
  await app.goto('scratch');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.blur();
  await app.press('m');
  const box = (await app.pixelCanvas().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const dlg = app.reviewDialog();
  await expect(dlg).toBeVisible();
  // in the note's text field, and on a button of the dialog
  await dlg.locator('textarea').focus();
  await app.press('ControlOrMeta+k');
  await dlg.getByRole('button', { name: 'Cancel' }).focus();
  await app.press('ControlOrMeta+k');
  await page.waitForTimeout(200);
  await expect(app.palette()).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  if (await app.topButton('review').getAttribute('aria-pressed') === 'true') await app.topButton('review').click();
});

test('palette: also opens over Help; Esc closes it and Help stays', async ({ app }) => {
  await app.goto('spark');
  await app.blur();
  await app.press('?');
  await expect(app.helpDialog()).toBeVisible();
  await app.openPalette();
  await app.press('Escape');
  await expect(app.palette()).toHaveCount(0);
  await expect(app.helpDialog()).toBeVisible();
});

test('palette: its chunk is fetched only on the first hover / open of the search button', async ({ app, page }) => {
  const seen: string[] = [];
  page.on('request', (r) => { if (AppPage.PALETTE_CHUNK.test(r.url())) seen.push(r.url()); });
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  // another dialog (the lazy DialogHost) does not bring the palette with it
  await app.blur();
  await app.press('?');
  await expect(app.helpDialog()).toBeVisible();
  await app.press('?');
  await expect(app.helpDialog()).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(seen).toEqual([]);
  await app.paletteButton().hover();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  await app.paletteButton().click();
  await expect(app.paletteInput()).toBeFocused();
});

test('palette: Esc closes it and focus returns to the search button', async ({ app }) => {
  await app.goto('spark');
  await app.paletteButton().click();
  await expect(app.paletteInput()).toBeFocused();
  await app.paletteInput().fill('help');
  await expect(app.paletteOptions().first()).toBeVisible();
  await app.press('Escape');
  await expect(app.palette()).toHaveCount(0);
  await expect(app.paletteButton()).toBeFocused();
});

test('palette: axe finds no serious issues with the palette open', async ({ app, page }) => {
  await app.goto('spark');
  await app.blur();
  await app.openPalette();
  await app.paletteInput().fill('helm');
  await expect(app.paletteOptions().first()).toBeVisible();
  const r = await new AxeBuilder({ page }).include('.palette-dlg').analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
