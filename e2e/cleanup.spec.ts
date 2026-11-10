import { test, expect } from './fixtures.ts';
import path from 'node:path';
import { runTool, readState } from './cli.ts';

test('select a throwaway canvas, plan cleanup, apply, then restore it from the trash', async ({ app }) => {
  runTool('art_create_canvas', { name: 'throwaway', width: 8, height: 8 });
  await app.goto('helmet_front');
  await expect(app.browserRow('throwaway')).toBeVisible({ timeout: 5000 });
  await app.enterSelectMode();
  await expect(app.selectionBar()).toBeVisible();
  await app.browserRow('throwaway').locator('.label').click();
  await expect(app.selectionBar()).toContainText('1 selected');
  await app.selectionBar().getByRole('button', { name: 'Plan cleanup…' }).click();
  const dlg = app.dialog();
  await expect(dlg).toContainText('Plan cleanup · 1 selected');
  const apply = dlg.getByRole('button', { name: /Move 1 to trash/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(app.toasts().filter({ hasText: /moved to the trash/ })).toBeVisible();
  await expect(app.browserRow('throwaway')).toHaveCount(0, { timeout: 5000 });

  await app.openCleanup();
  const c = app.dialog();
  await expect(c).toContainText('canvas:throwaway');
  await c.getByRole('button', { name: 'Restore all' }).first().click();
  await expect(app.toasts().filter({ hasText: /restored 1 asset/ })).toBeVisible();
  await app.press('Escape');
  await expect(app.browserRow('throwaway')).toBeVisible({ timeout: 5000 });
});

// Step 17: the Svelte cleanup dialogs
test('a blocked plan disables Apply until "Dependents too"; disk usage lists canvases', async ({ app, page }) => {
  await app.goto('helmet_front');
  await app.enterSelectMode();
  await app.browserRow('crate_tex').locator('.label').click();
  await app.selectionBar().getByRole('button', { name: 'Plan cleanup…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Plan cleanup · 1 selected' });
  await expect(dlg.getByRole('region', { name: 'Blocked' })).toContainText('needed by model:crate_v2');
  await expect(dlg.getByRole('button', { name: 'Blocked' })).toBeDisabled();
  await dlg.getByRole('checkbox', { name: 'Dependents too' }).check();
  await expect(dlg.getByRole('button', { name: /^Move \d+ to trash$/ })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Cancel' }).click(); // never apply: the seed is shared
  await expect(dlg).toHaveCount(0);
  await app.enterSelectMode();

  await app.openCleanup();
  const c = page.getByRole('dialog', { name: 'Cleanup' });
  await c.getByRole('tab', { name: 'Disk usage' }).click();
  await expect(c.getByRole('region', { name: 'By kind' }).locator('[data-bar="canvas"]')).toBeVisible();
  await app.press('Escape');
});

test('cleanup settings: an existing folder saves, a missing one shows the server error', async ({ app, page, guard }) => {
  guard.allow(/Failed to load resource: the server responded with a status of 4\d\d/); // the refused save
  const { home } = readState();
  await app.goto('helmet_front');
  await app.openCleanup();
  const c = page.getByRole('dialog', { name: 'Cleanup' });
  await c.getByRole('tab', { name: 'Settings' }).click();
  const ta = c.getByRole('textbox', { name: 'Export folders cleanup may touch' });
  await ta.fill(home);
  await c.getByRole('button', { name: 'Save' }).click();
  await expect(app.toasts().filter({ hasText: 'cleanup settings saved' })).toBeVisible();
  await ta.fill(path.join(home, 'does-not-exist'));
  await c.getByRole('button', { name: 'Save' }).click();
  await expect(app.toasts().filter({ hasText: /^cleanup_config: / })).toBeVisible();
  await ta.fill('');
  await c.getByRole('button', { name: 'Save' }).click();
  await expect(app.toasts().filter({ hasText: 'cleanup settings saved' }).last()).toBeVisible();
  await app.press('Escape');
});
