// Step 10: asset graph (TS port, canvas renderer). Step 10b adds the Cards / Hierarchy checks here.
import { test, expect } from './fixtures.ts';

test('graph: settles, find selects, 0 fits, relation chips, tag filter, keyboard list', async ({ app, page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('e2e-graph')) { sessionStorage.setItem('e2e-graph', '1'); localStorage.removeItem('agent-art:graphCollapsed'); } } catch { /* ignore */ } });
  await app.goto('graph');
  const g = app.graph();
  await expect(g.locator('.vtoolbar')).toContainText(/\d+ nodes/);
  await expect(g.locator('canvas.graph-canvas')).toHaveAttribute('aria-label', /Asset graph: \d+ nodes, \d+ edges/);
  await expect(g.locator('.graph-stage')).toHaveAttribute('data-settled', 'true', { timeout: 15_000 });
  await g.locator('input.search').fill('pauldron');
  await expect(app.inspectorTitle()).toContainText('pauldron');
  await g.locator('input.search').fill('');
  await app.blur();
  await app.press('0');
  await expect(g.locator('canvas.graph-canvas')).toBeVisible();
  await expect(g.locator('.rel-chip[data-rel="layer_of"]')).toHaveAttribute('aria-pressed', 'false');
  const chip = g.locator('.rel-chip[data-rel="variant_of"]');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await g.locator('.vtoolbar select').first().selectOption('armour');
  await expect(g.locator('.vtoolbar')).toContainText(/\d+ nodes/);
  await g.locator('.vtoolbar select').first().selectOption('');
  await g.getByRole('button', { name: 'List' }).click();
  const list = g.getByRole('listbox', { name: 'Visible nodes' });
  await list.getByRole('option', { name: /helmet_side/ }).click();
  await expect(app.inspectorTitle()).toContainText('helmet_side');
  await list.getByRole('option', { name: /Severance armour/ }).dblclick();
  await expect(g.locator('.vtoolbar')).toContainText('1 collapsed');
  await page.reload();
  await expect(app.graph().locator('.vtoolbar')).toContainText('1 collapsed');
});
