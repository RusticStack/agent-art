// Step 10: asset graph (TS port, canvas renderer). Step 10b: Cards renderer (Svelte Flow) and Hierarchy layout.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.ts';

interface GraphDebug { renderer: 'cards' | 'canvas'; nodes: number; edges: number; layout: string; settled: boolean; selected: string | null; positions: Record<string, [number, number]> }
const nameOf = (id: string) => id.slice(id.indexOf(':') + 1);

test('graph: settles, find selects, 0 fits, relation chips, tag filter, keyboard list', async ({ app, page }) => {
  // the parity checks are for the canvas renderer (the default View is Auto = Cards for the seed graph)
  await page.addInitScript(() => { try { localStorage.setItem('agent-art:graphRenderer', '"canvas"'); if (!sessionStorage.getItem('e2e-graph')) { sessionStorage.setItem('e2e-graph', '1'); localStorage.removeItem('agent-art:graphCollapsed'); } } catch { /* ignore */ } });
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

test('graph cards: Auto opens the seed graph as cards with thumbnails, minimap and controls', async ({ app, page }) => {
  const chunks: string[] = [];
  page.on('request', (r) => { if (/\/assets\/graph-(cards|layout)-/.test(r.url())) chunks.push(r.url()); });
  await app.goto();
  await app.openAsset('spark');
  expect(chunks, 'no graph library before the graph opens').toEqual([]);
  await app.blur();
  await app.press('Shift+G');
  const g = app.graph();
  await expect(app.graphFlow()).toBeVisible();
  await expect(app.graphCounts()).toContainText('· cards');
  await expect(g.locator('.graph-stage')).toHaveAttribute('data-settled', 'true', { timeout: 2_500 });
  expect(chunks.some((u) => /graph-cards-/.test(u))).toBe(true);
  expect(chunks.some((u) => /graph-layout-/.test(u)), 'dagre only when Hierarchy is chosen').toBe(false);
  const n = Number((await app.graphCounts().textContent())?.match(/(\d+) nodes/)?.[1]);
  await expect(app.graphCards()).toHaveCount(n);
  const img = app.graphCard('canvas:helmet_front').locator('img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(g.locator('.svelte-flow__minimap')).toBeVisible();
  await expect(g.locator('.svelte-flow__controls-button')).toHaveCount(3);
  await expect(g.getByRole('button', { name: 'List' })).toBeHidden();
  const dbg = await app.viewerDebug<GraphDebug>();
  if (dbg) expect(dbg.renderer).toBe('cards');
});

test('graph cards: click selects, double-click opens; Tab reaches a card and Enter twice opens it', async ({ app }) => {
  await app.goto('graph');
  await expect(app.graph().locator('.graph-stage')).toHaveAttribute('data-settled', 'true');
  const card = app.graphCard('canvas:helmet_side');
  await card.locator('.aa-name').click();
  await expect(app.inspectorTitle()).toContainText('helmet_side');
  await card.locator('.aa-name').dblclick();
  await expect(app.slotTitle('A')).toContainText('helmet_side');
  await app.goto('graph');
  await expect(app.graph().locator('.graph-stage')).toHaveAttribute('data-settled', 'true');
  await app.graphViewSelect().focus();
  let onNode = false;
  for (let i = 0; i < 40 && !onNode; i++) {
    await app.press('Tab');
    onNode = await app.page.evaluate(() => !!document.activeElement?.classList.contains('svelte-flow__node'));
  }
  expect(onNode, 'a card is in the tab order').toBe(true);
  const id = await app.page.evaluate(() => (document.activeElement as HTMLElement).dataset.id ?? '');
  await app.press('Enter');
  await expect(app.inspectorTitle()).toContainText(nameOf(id));
  await app.press('Enter');
  if (id.startsWith('group:')) await expect(app.graphCounts()).toContainText('1 collapsed');
  else await expect(app.slotTitle('A')).toContainText(nameOf(id));
});

test('graph cards: hover toolbar pins the asset (browser Pinned section)', async ({ app }) => {
  await app.goto('graph');
  await expect(app.graph().locator('.graph-stage')).toHaveAttribute('data-settled', 'true');
  const card = app.graphCard('canvas:pauldron');
  await card.hover();
  const pin = card.getByRole('button', { name: 'Pin' });
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(app.pinnedRow('canvas:pauldron')).toBeVisible();
  await card.hover();
  await pin.click(); // leave the shared workspace as it was
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
});

test('graph view switch keeps positions and the selection; Hierarchy ranks the project left of its canvases', async ({ app, page }) => {
  const layoutChunk: string[] = [];
  page.on('request', (r) => { if (/\/assets\/graph-layout-/.test(r.url())) layoutChunk.push(r.url()); });
  await app.goto('graph');
  await expect(app.graph().locator('.graph-stage')).toHaveAttribute('data-settled', 'true');
  await app.graphCard('canvas:helmet_front').locator('.aa-name').click();
  const before = await app.viewerDebug<GraphDebug>();
  await app.graphViewSelect().selectOption('canvas');
  await expect(app.graph().locator('canvas.graph-canvas')).toBeVisible();
  await expect(app.graphCounts()).toContainText('· canvas');
  await app.graphViewSelect().selectOption('cards');
  await expect(app.graphFlow()).toBeVisible();
  await expect(app.graphCard('canvas:helmet_front').locator('.aa-card.sel')).toBeVisible();
  if (before) {
    const after = (await app.viewerDebug<GraphDebug>())!;
    expect(after.selected).toBe('canvas:helmet_front');
    const [x0, y0] = before.positions['canvas:pauldron'], [x1, y1] = after.positions['canvas:pauldron'];
    expect(Math.abs(x1 - x0)).toBeLessThanOrEqual(1);
    expect(Math.abs(y1 - y0)).toBeLessThanOrEqual(1);
  }
  expect(layoutChunk).toEqual([]);
  await app.graphLayoutSelect().selectOption('hierarchy');
  await expect(app.graphCounts()).not.toContainText('laying out', { timeout: 5_000 });
  expect(layoutChunk.length).toBeGreaterThan(0);
  await app.blur();
  await app.press('0');
  const left = async (id: string) => (await app.graphCard(id).boundingBox())?.x ?? NaN;
  await expect.poll(async () => (await left('project:severance')) < (await left('canvas:helmet_front'))).toBe(true);
  await expect(app.graphCounts()).toContainText('· cards');
});

test('graph cards: axe finds no serious issues', async ({ app, page }) => {
  await app.goto('graph');
  await expect(app.graph().locator('.graph-stage')).toHaveAttribute('data-settled', 'true');
  const r = await new AxeBuilder({ page }).include('#slotA .graph-viewer').analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
