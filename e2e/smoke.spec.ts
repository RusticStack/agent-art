import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures.ts';
import { readState } from './cli.ts';

test('the e2e run is isolated: temp workspace, not port 7420', async () => {
  const st = readState();
  expect(st.port).not.toBe(7420);
  expect(path.resolve(st.home).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())).toBe(true);
});

test('page loads live with the seeded assets and a canvas open', async ({ page, app }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle('Agent Art');
  await expect(app.status()).toHaveText(/^(live|agent is working…)$/, { timeout: 15_000 });
  for (const [name, kind] of [['spark', 'canvas'], ['hero', 'rig'], ['rifle', 'model'], ['rifle_shot', 'audio'], ['severance', 'project']] as const) {
    await expect(app.browserRow(name, kind)).toBeAttached();
  }
  await expect(app.pixelCanvas()).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe('');
  await expect(app.workspacePath()).toHaveText(readState().home);
});

test('a failed op shows an error toast with role=alert', async ({ page, app }) => {
  await app.goto('spark');
  await page.evaluate(() => {
    const w = window as unknown as { agentArt: { api(op: string, args: object): Promise<unknown> } };
    void w.agentArt.api('undo', { canvas: 'no_such_canvas_e2e' }).catch(() => {});
  });
  const alert = app.errorToasts().filter({ hasText: /^undo: / });
  await expect(alert).toBeVisible();
  await expect(app.toastRegion()).toHaveAttribute('aria-live', 'polite');
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alert).toHaveCount(0);
});
