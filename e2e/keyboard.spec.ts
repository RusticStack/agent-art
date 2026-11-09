import { test, expect } from './fixtures.ts';

test('global shortcuts: C M ? [ ] P Shift+G / 1-3 and the Esc chain', async ({ app, page }) => {
  await app.goto('spark');
  await app.pixelCanvas().click({ position: { x: 5, y: 5 }, button: 'middle' });
  await app.blur();

  await app.press('c');
  await expect(app.slotWrap('B')).toBeVisible();
  await app.press('c');
  await expect(app.slotWrap('B')).toBeHidden();

  await app.press('m');
  await expect(app.topButton('review')).toHaveClass(/\bon\b/);
  await expect(page.locator('body')).toHaveClass(/review-mode/);
  await app.press('Escape');
  await expect(app.topButton('review')).not.toHaveClass(/\bon\b/);

  await app.press('?');
  await expect(app.helpDialog()).toBeVisible();
  await expect(app.helpDialog()).toContainText('Keyboard shortcuts');
  // focus is trapped inside Help
  await expect.poll(() => app.helpDialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 3; i++) {
    await app.press('Tab');
    expect(await app.helpDialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await app.press('Shift+Tab');
  expect(await app.helpDialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await app.press('Escape');
  await expect(app.helpDialog()).toBeHidden();

  await app.press('[');
  await expect(app.browserPane()).toBeHidden();
  await app.press('[');
  await expect(app.browserPane()).toBeVisible();
  await app.press(']');
  await expect(app.inspector()).toBeHidden();
  await app.press(']');
  await expect(app.inspector()).toBeVisible();

  const tlBox = async () => (await app.timelinePane().boundingBox())!;
  const right = await tlBox();
  await app.press('p');
  await expect.poll(async () => (await tlBox()).x).toBeLessThan(right.x);
  await app.press('p');
  await expect.poll(async () => (await tlBox()).x).toBe(right.x);

  await app.press('2');
  await expect(app.slot('A').locator('.anim-viewer')).toBeVisible();
  await app.press('3');
  await expect(app.slot('A').locator('.sheet-viewer')).toBeVisible();
  await app.press('1');
  await expect(app.slot('A').locator('.canvas-viewer')).toBeVisible();

  await app.press('Shift+G');
  await expect(app.slot('A').locator('.graph-viewer')).toBeVisible();

  await app.press('/');
  await expect(app.filterInput()).toBeFocused();
  await app.press('Escape');
  await expect(app.filterInput()).not.toBeFocused();

  // Esc chain: compare -> close; snapshot -> back to live
  await app.goto('spark');
  await app.press('c');
  await expect(app.slotWrap('B')).toBeVisible();
  await app.press('Escape');
  await expect(app.slotWrap('B')).toBeHidden();
});

test('K2: global keys still work while Help is open (C toggles compare)', async ({ app }) => {
  await app.goto('spark');
  await app.blur();
  await app.press('?');
  await expect(app.helpDialog()).toBeVisible();
  await app.press('c');
  await expect(app.slotWrap('B')).toBeVisible();
  await expect(app.helpDialog()).toBeVisible();
  await app.press('c');
  await expect(app.slotWrap('B')).toBeHidden();
  // Esc closes Help first (K5), not the comparison
  await app.press('c');
  await expect(app.slotWrap('B')).toBeVisible();
  await app.press('Escape');
  await expect(app.helpDialog()).toBeHidden();
  await expect(app.slotWrap('B')).toBeVisible();
  await app.press('Escape');
  await expect(app.slotWrap('B')).toBeHidden();
  // the top bar button toggles it too
  await app.topButton('help').click();
  await expect(app.helpDialog()).toBeVisible();
  await app.helpDialog().getByRole('button', { name: 'Close' }).click();
  await expect(app.helpDialog()).toBeHidden();
});
