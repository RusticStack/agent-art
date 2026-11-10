// Step 15: the Svelte asset browser (tree, filter, pins, keyboard, context menu, drag to a slot,
// virtualised rows on a big workspace).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.ts';
import { runBatch, readState } from './cli.ts';
import { freePort, startServer, stopServer } from './server.ts';

test('the / key focuses the filter; the filter narrows the tree', async ({ app, page }) => {
  await app.goto('helmet_front');
  await app.blur();
  await app.press('/');
  await expect(app.filterInput()).toBeFocused();
  await page.keyboard.type('pauld');
  await expect(app.browserRow('pauldron')).toBeVisible();
  await expect(app.browserRow('crate_tex')).toHaveCount(0);
  await app.filterInput().fill('');
  await expect(app.browserRow('crate_tex')).toBeVisible();
  await expect(app.browserRow('pauldron')).toHaveCount(0); // projects start collapsed again (legacy B3)
});

test('pin and hide survive a reload; a second window sees the pin', async ({ app, page, browser }) => {
  await app.goto('helmet_front');
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(`http://127.0.0.1:${readState().port}/#helmet_front`);
  await expect(page2.locator('#statusText')).toHaveText(/live|agent is working/, { timeout: 15_000 });
  try {
    await app.clickRowAction('spark', 'pin');
    await expect(app.pinnedRow('canvas:spark')).toBeVisible();
    // the other window gets the ui-state event
    await expect(page2.locator('#browser .row[data-section="pinned"][data-id="canvas:spark"]')).toBeVisible({ timeout: 5000 });
    await app.clickRowAction('scratch', 'eye');
    await page.reload();
    await app.goto('helmet_front');
    await expect(app.pinnedRow('canvas:spark')).toBeVisible();
    await expect(app.browserRow('scratch')).toHaveCount(0); // hidden (show hidden is off)
  } finally {
    await other.close();
    // restore the shared state through the same buttons
    const showHidden = app.showHiddenButton();
    await showHidden.click();
    await app.clickRowAction('scratch', 'eye');
    await showHidden.click();
    if (await app.pinnedRow('canvas:spark').count()) { await app.pinnedRow('canvas:spark').hover(); await app.pinnedRow('canvas:spark').locator('[data-act="pin"]').click(); }
  }
  await expect(app.pinnedRow('canvas:spark')).toHaveCount(0);
  await expect(app.browserRow('scratch')).toBeVisible();
});

test('Alt+click opens in slot B; double-click opens the Canvas tab', async ({ app }) => {
  await app.goto('helmet_front');
  await app.browserRow('spark').locator('.label').click({ modifiers: ['Alt'] });
  await expect(app.slotTitle('B')).toContainText('spark');
  await expect(app.slotTitle('A')).toContainText('helmet_front');
  await app.blur();
  await app.press('Escape');
  await expect(app.slotWrap('B')).toBeHidden();
  await app.browserRow('crate_tex').locator('.label').dblclick();
  await expect(app.slotTitle('A')).toContainText('crate_tex');
  await expect(app.tab('Canvas')).toHaveClass(/on|active/);
});

test('arrow keys move through the tree and Enter opens', async ({ app, page }) => {
  await app.goto('helmet_front');
  await app.browserRow('crate_tex').focus();
  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#browser [role=treeitem]:focus');
  await expect(focused).toHaveCount(1);
  const id = await focused.getAttribute('data-id');
  expect(id).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(app.slotTitle('A')).toContainText(id!.split(':').slice(1).join(':'));
});

test('row context menu: items, Open in compare, Copy link, Shift+F10 and Esc', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await app.goto('helmet_front');
  await app.browserRow('spark').click({ button: 'right' });
  for (const name of ['Open', 'Open in compare', 'Animation', 'Pin', 'Hide', 'Solo', 'Show in graph', 'Add review note…', 'Copy name', 'Copy link', 'Select', 'Plan cleanup…']) {
    await expect(app.menuItem(name)).toBeVisible();
  }
  await app.menuItem('Open in compare').click();
  await expect(app.slotTitle('B')).toContainText('spark');
  await app.blur();
  await app.press('Escape');

  await app.browserRow('spark').click({ button: 'right' });
  await app.menuItem('Copy link').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/#spark$/);

  await app.browserRow('crate_tex').focus();
  await page.keyboard.press('Shift+F10');
  await expect(app.menuItem('Open in compare')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(app.menu()).toHaveCount(0);
  await expect(app.browserRow('crate_tex')).toBeFocused();
});

test('dragging a row onto "Compare here" opens it in slot B', async ({ app, page }) => {
  await app.goto('helmet_front');
  const src = (await app.browserRow('spark').boundingBox())!;
  const area = (await app.viewers().boundingBox())!;
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.5, area.y + area.height / 2, { steps: 6 });
  await expect(app.dropCompare()).toBeVisible();
  await page.mouse.move(area.x + area.width * 0.9, area.y + area.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(app.slotTitle('B')).toContainText('spark');
  await expect(app.dropCompare()).toBeHidden();
  await app.blur();
  await app.press('Escape');
});

test('300 canvases: End then Enter opens the last asset; the DOM stays small', async ({ app, page }) => {
  test.setTimeout(180_000);
  const st = readState();
  const home = path.join(path.dirname(st.home), `big-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const names = Array.from({ length: 300 }, (_, i) => `bulk_${String(i).padStart(3, '0')}`);
  runBatch(names.map((name) => ({ op: 'create', args: { name, width: 8, height: 8 } })), { home, port });
  const pid = await startServer(home, port, path.join(path.dirname(st.log), `big-${port}.log`));
  try {
    await page.goto(`http://127.0.0.1:${port}/#bulk_000`);
    await expect(app.status()).toHaveText(/live|agent is working/, { timeout: 15_000 });
    await expect(app.slotTitle('A')).toContainText('bulk_000');
    await app.browserRow('bulk_000').focus();
    await page.keyboard.press('End');
    await expect(app.browserRow('bulk_299')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(app.slotTitle('A')).toContainText('bulk_299');
    expect(await app.treeRows().count()).toBeLessThan(400);
    expect(await page.locator('#browser .row').count()).toBeLessThan(120);
  } finally {
    stopServer(pid);
  }
});
