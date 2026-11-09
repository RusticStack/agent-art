import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

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
