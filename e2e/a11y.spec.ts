// Step 19: automated accessibility pass (axe: no critical or serious findings) on the main view, the
// review note dialog, the cleanup dialog and the narrow layout with a drawer open; and a keyboard-only
// walk through the shell.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/** Critical and serious axe findings on the page, as "rule: targets" lines (nothing is allow-listed). */
async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 8).join(', ')}`);
}

test('axe: main view', async ({ app, page }) => {
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  await expect(app.timelineEntries().first()).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test('axe: review note dialog', async ({ app, page }) => {
  await app.goto('scratch');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.blur();
  await app.press('m');
  const box = (await app.pixelCanvas().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(app.reviewDialog()).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await app.reviewDialog().getByRole('button', { name: 'Cancel' }).click();
  await expect(app.reviewDialog()).toHaveCount(0);
  await app.topButton('review').click();
});

test('axe: cleanup dialog', async ({ app, page }) => {
  await app.goto('spark');
  await app.openCleanup();
  await expect(app.dialog().getByRole('tab').first()).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test.describe('narrow', () => {
  test.use({ viewport: { width: 430, height: 900 } });
  test('axe: narrow view with the assets drawer open', async ({ app, page }) => {
    await app.goto('spark');
    await expect(app.pixelCanvas()).toBeVisible();
    await app.topButton('toggleBrowser').click();
    await expect(app.browserPane()).toBeVisible();
    await expect(app.treeRows().first()).toBeVisible();
    expect(await serious(page)).toEqual([]);
  });
});

test('keyboard only: Tab reaches the browser, Enter opens an asset, Tab reaches the viewer toolbar, Help opens and closes back to its button', async ({ app, page }) => {
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  // from the page start
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
  await page.keyboard.press('Tab');
  let steps = 0;
  while (!(await app.focused()).inBrowser && steps++ < 40) await page.keyboard.press('Tab');
  expect((await app.focused()).inBrowser, 'Tab reaches the asset browser').toBe(true);
  // into the tree: Tab until a tree row has focus, move to another canvas row, Enter opens it
  steps = 0;
  while (!(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'treeitem')) && steps++ < 20) await page.keyboard.press('Tab');
  await expect(app.treeRows().and(page.locator(':focus'))).toHaveCount(1);
  const before = (await app.slotTitle('A').textContent()) ?? '';
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id ?? '');
    if (id.startsWith('canvas:') && !before.includes(id.slice(7))) break;
  }
  const target = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id ?? '');
  expect(target).toMatch(/^canvas:/);
  await page.keyboard.press('Enter');
  await expect(app.slotTitle('A')).toContainText(target.slice(7));
  // on to the viewer toolbar
  steps = 0;
  while (!(await app.focused()).inSlotAToolbar && steps++ < 80) await page.keyboard.press('Tab');
  expect((await app.focused()).inSlotAToolbar, 'Tab reaches the viewer toolbar').toBe(true);
  // back to the Help button, open with Enter, close with Esc: focus returns to it
  steps = 0;
  while ((await app.focused()).id !== 'helpBtn' && steps++ < 120) await page.keyboard.press('Shift+Tab');
  await expect(app.topButton('help')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(app.helpDialog()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(app.helpDialog()).toHaveCount(0);
  await expect(app.topButton('help')).toBeFocused();
});
