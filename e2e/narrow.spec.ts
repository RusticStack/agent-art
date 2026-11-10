// Narrow layout (N2–N4, 2.6, 4.5): drawers with a scrim, the top bar overflow menu, stacked compare,
// the bottom dock, no horizontal scrolling. Step 19.
import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

test.use({ viewport: { width: 430, height: 900 } });

test('narrow layout: pane toggles, assets drawer opens and closes, canvas renders', async ({ app }) => {
  await app.goto('helmet_front');
  await expect(app.topButton('toggleBrowser')).toBeVisible();
  await expect(app.topButton('toggleSide')).toBeVisible();
  await expect(app.pixelCanvas()).toBeVisible();
  await expect(app.browserPane()).toBeHidden();
  await app.topButton('toggleBrowser').click();
  await expect(app.browserPane()).toBeVisible();
  await expect(app.topButton('toggleBrowser')).toHaveAttribute('aria-expanded', 'true');
  await app.topButton('toggleBrowser').click();
  await expect(app.browserPane()).toBeHidden();
});

test('narrow drawers: [ opens, the scrim and Esc close, one at a time, opening an asset closes it', async ({ app, page }) => {
  await app.goto('helmet_front');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.blur();
  await expect(app.drawerScrim()).toHaveCount(0);
  // [ and the scrim
  await app.press('[');
  await expect(app.browserPane()).toBeVisible();
  await expect(app.drawerScrim()).toBeVisible();
  const vp = page.viewportSize()!;
  await app.drawerScrim().click({ position: { x: vp.width - 20, y: 300 } });
  await expect(app.browserPane()).toBeHidden();
  await expect(app.drawerScrim()).toHaveCount(0);
  // ] and Esc; only one drawer at a time
  await app.press(']');
  await expect(app.sidePane()).toBeVisible();
  await app.press('[');
  await expect(app.browserPane()).toBeVisible();
  await expect(app.sidePane()).toBeHidden();
  await app.press('Escape');
  await expect(app.browserPane()).toBeHidden();
  // Esc with focus inside the drawer: focus goes back to its toggle
  await app.topButton('toggleBrowser').click();
  await app.browserRow('spark').focus();
  await app.press('Escape');
  await expect(app.browserPane()).toBeHidden();
  await expect(app.topButton('toggleBrowser')).toBeFocused();
  // opening an asset from the drawer closes it
  await app.topButton('toggleBrowser').click();
  await app.browserRow('spark').locator('.label').click();
  await expect(app.slotTitle('A')).toContainText('spark');
  await expect(app.browserPane()).toBeHidden();
});

test('narrow overflow menu: the actions and follow mode, each works; the Notes count shows', async ({ app, page }) => {
  runTool('art_review', { action: 'add', asset: 'scratch', note: `narrow count ${Date.now()}`, category: 'fix' });
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  // the wide buttons are in the menu now
  await expect(app.topButton('compare')).toHaveCount(0);
  await expect(app.moreButton()).toHaveAttribute('aria-haspopup', 'menu');
  await app.openMore();
  await expect(app.moreButton()).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['search', 'compare', 'review', 'notes', 'graph', 'cleanup', 'help', 'follow-canvas', 'follow-project', 'follow-off']) await expect(app.moreItem(id)).toBeVisible();
  await expect(app.moreItem('notes').locator('.count-badge')).toHaveText(/^\d+$/);
  await expect(app.moreButton().locator('.count-badge')).toHaveText(/^\d+ open notes$/);
  await expect(app.moreButton()).toHaveAccessibleName(/^More actions \d+ open notes$/);
  // Esc closes the menu and focus returns to its button
  await app.press('Escape');
  await expect(app.moreMenu()).toHaveCount(0);
  await expect(app.moreButton()).toBeFocused();

  await app.openMore();
  await app.moreItem('search').click();
  await expect(app.paletteInput()).toBeFocused();
  await app.press('Escape');
  await expect(app.palette()).toHaveCount(0);

  await app.openMore();
  await expect(app.moreItem('compare')).toHaveAttribute('aria-checked', 'false');
  await app.moreItem('compare').click();
  await expect(app.slotWrap('B')).toBeVisible();
  await app.openMore();
  await expect(app.moreItem('compare')).toHaveAttribute('aria-checked', 'true');
  await app.moreItem('compare').click();
  await expect(app.slotWrap('B')).toBeHidden();

  await app.openMore();
  await app.moreItem('review').click();
  await expect(page.locator('body')).toHaveClass(/review-mode/);
  await app.openMore();
  await app.moreItem('review').click();
  await expect(page.locator('body')).not.toHaveClass(/review-mode/);

  await app.openMore();
  await app.moreItem('notes').click();
  await expect(app.reviewListDialog()).toBeVisible();
  await app.press('Escape');
  await expect(app.reviewListDialog()).toHaveCount(0);

  await app.openMore();
  await app.moreItem('cleanup').click();
  await expect(app.dialog()).toBeVisible();
  await app.press('Escape');
  await expect(app.dialog()).toHaveCount(0);

  await app.openMore();
  await app.moreItem('help').click();
  await expect(app.helpDialog()).toBeVisible();
  await app.press('Escape');
  await expect(app.helpDialog()).toHaveCount(0);

  // follow mode radios (the wide layout's select)
  await app.openMore();
  await app.moreItem('follow-project').click();
  await app.openMore();
  await expect(app.moreItem('follow-project')).toHaveAttribute('aria-checked', 'true');
  await expect(app.moreItem('follow-canvas')).toHaveAttribute('aria-checked', 'false');
  await app.moreItem('follow-canvas').click();
  await app.openMore();
  await expect(app.moreItem('follow-canvas')).toHaveAttribute('aria-checked', 'true');
  // keyboard: Down moves, Enter runs (Graph)
  await app.press('End');
  await app.press('Escape');
  await app.moreButton().focus();
  await app.press('ArrowDown');
  await expect(app.moreMenu()).toBeVisible();
  await expect(app.moreItem('search')).toBeFocused();
  await app.press('g');
  await expect(app.moreItem('graph')).toBeFocused();
  await app.press('Enter');
  await expect(app.graph()).toBeVisible();
});

test('narrow: compare stacks vertically and the bottom dock works', async ({ app }) => {
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  await app.openTarget({ kind: 'canvas', name: 'pauldron' }, 'B');
  await expect(app.slotWrap('B')).toBeVisible();
  const a = (await app.slotWrap('A').boundingBox())!;
  const b = (await app.slotWrap('B').boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  await app.blur();
  await app.press('Escape');
  await expect(app.slotWrap('B')).toBeHidden();
  // P: the timeline moves to the bottom dock, which shows in the narrow layout too (N4)
  await app.press('p');
  await expect(app.bottomDock()).toBeVisible();
  await expect(app.bottomDock().locator('#timelinePane')).toBeVisible();
  await app.press('p');
  await expect(app.bottomDock()).toHaveCount(0);
});

for (const width of [360, 430, 860]) {
  test(`no horizontal scrollbar at ${width} px`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 800 });
    await app.goto('spark');
    await expect(app.pixelCanvas()).toBeVisible();
    expect(await app.hasHorizontalScroll()).toBe(false);
    await app.topButton('toggleBrowser').click();
    await expect(app.browserPane()).toBeVisible();
    expect(await app.hasHorizontalScroll()).toBe(false);
    // the top bar keeps every control on screen (nothing pushed past the right edge)
    const bar = await page.locator('header.topbar').evaluate((h) => ({ sw: h.scrollWidth, cw: h.clientWidth }));
    expect(bar.sw).toBeLessThanOrEqual(bar.cw);
  });
}
