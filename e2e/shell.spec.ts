// Step 18: the Svelte shell. Deep links, hashchange, compare / swap / close, timeline snapshot + Esc,
// persisted layout (splitter, dock), follow mode, and the first-paint marks.
import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

test('hash deep links open every target kind', async ({ app }) => {
  const cases: [string, () => Promise<void>][] = [
    ['spark', async () => { await expect(app.slotTitle('A')).toContainText('spark'); await expect(app.slot('A').locator('.canvas-viewer')).toBeVisible(); }],
    ['canvas:spark', async () => { await expect(app.slotTitle('A')).toContainText('spark'); await expect(app.pixelCanvas()).toBeVisible(); }],
    ['model:rifle', async () => { await expect(app.modelViewer()).toBeVisible({ timeout: 20_000 }); await expect(app.slotTitle('A')).toContainText('rifle'); }],
    ['rig:hero', async () => { await expect(app.rigCanvas()).toBeVisible(); await expect(app.slotTitle('A')).toContainText('hero'); }],
    ['audio:rifle_shot', async () => { await expect(app.audioWave()).toBeVisible(); }],
    ['project:severance', async () => { await expect(app.slot('A').locator('.ov-tile')).toHaveCount(3); }],
    ['export:helmet_front.png', async () => { await expect(app.slot('A').locator('.vtoolbar')).toContainText('helmet_front.png'); }],
    ['graph', async () => { await expect(app.graph()).toBeVisible(); await expect(app.slotTitle('A')).toContainText('Asset graph'); }],
  ];
  for (const [hash, check] of cases) {
    await app.goto(hash);
    await check();
  }
});

test('hashchange opens the new target without rewriting the hash', async ({ app, page }) => {
  await app.goto('spark');
  await page.evaluate(() => { location.hash = '#pauldron'; });
  await expect(app.slotTitle('A')).toContainText('pauldron');
  await page.evaluate(() => { location.hash = '#rig:hero'; });
  await expect(app.rigCanvas()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('#rig:hero');
});

test('compare: Alt+click opens slot B, Swap exchanges the sides, Close ends compare', async ({ app }) => {
  await app.goto('spark');
  await app.topButton('compare').click();
  await expect(app.slotWrap('B')).toBeVisible();
  await expect(app.slot('B')).toContainText('Alt+click');
  await app.browserRow('scratch').locator('.label').click({ modifiers: ['Alt'] });
  await expect(app.slotTitle('B')).toContainText('scratch');
  await expect(app.pixelCanvas('B')).toBeVisible();
  await app.swapButton().click();
  await expect(app.slotTitle('A')).toContainText('scratch');
  await expect(app.slotTitle('B')).toContainText('spark');
  await app.closeCompareButton().click();
  await expect(app.slotWrap('B')).toBeHidden();
  await expect(app.topButton('compare')).toHaveAttribute('aria-pressed', 'false');
  await expect(app.slotTitle('A')).toContainText('scratch');
});

test('a timeline entry opens its snapshot; Esc goes back to live', async ({ app }) => {
  await app.goto('helmet_side');
  runTool('art_draw', { canvas: 'helmet_side', commands: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#22c55e' }] });
  const entry = app.timelineEntry(/helmet_side/);
  await expect(entry).toContainText('draw', { timeout: 5000 });
  await app.timelineOpen(entry).click();
  await expect(app.stateBadge('A')).toBeVisible();
  await expect(app.backToLive()).toBeVisible();
  await app.blur();
  await app.press('Escape');
  await expect(app.stateBadge('A')).toBeHidden();
  await expect(app.slotTitle('A')).toContainText('helmet_side');
  // the Back to live button does the same
  await app.timelineOpen(entry).click();
  await expect(app.stateBadge('A')).toBeVisible();
  await app.backToLive().click();
  await expect(app.stateBadge('A')).toBeHidden();
});

test('a splitter drag and the timeline dock persist across a reload', async ({ app, page }) => {
  await app.goto('spark');
  const split = app.splitter('Resize the assets pane');
  const before = (await app.browserPane().boundingBox())!.width;
  const s = (await split.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + 200);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 40, s.y + 200, { steps: 4 });
  await page.mouse.move(s.x + s.width / 2 + 80, s.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await app.browserPane().boundingBox())!.width).toBeGreaterThan(before + 60);
  const after = Math.round((await app.browserPane().boundingBox())!.width);

  await app.dockButton().click();
  await expect(app.bottomDock()).toBeVisible();

  await page.reload();
  await expect(app.status()).toHaveText(/live|agent is working/, { timeout: 15_000 });
  await expect.poll(async () => Math.round((await app.browserPane().boundingBox())!.width)).toBe(after);
  await expect(app.bottomDock()).toBeVisible();
  await expect(app.bottomDock().locator('#timelinePane')).toBeVisible();

  // double-click resets the size; the dock goes back to the right
  await split.dblclick();
  await expect.poll(async () => Math.round((await app.browserPane().boundingBox())!.width)).toBe(Math.round(before));
  await app.dockButton().click();
  await expect(app.bottomDock()).toBeHidden();
  await page.reload();
  await expect(app.status()).toHaveText(/live|agent is working/, { timeout: 15_000 });
  await expect(app.bottomDock()).toBeHidden();
});

test('follow mode: the choice persists; project overview opens the project on an agent draw', async ({ app, page }) => {
  await app.goto('spark');
  await app.followMode().selectOption('project');
  await page.reload();
  await expect(app.status()).toHaveText(/live|agent is working/, { timeout: 15_000 });
  await expect(app.followMode()).toHaveValue('project');
  await expect(app.topButton('follow')).toHaveAttribute('aria-pressed', 'true');
  runTool('art_draw', { canvas: 'pauldron', commands: [{ op: 'rect', x: 15, y: 15, w: 1, h: 1, color: '#38bdf8' }] });
  await expect(app.slotTitle('A')).toContainText('severance', { timeout: 5000 });
  await expect(app.slot('A').locator('.ov-tile')).toHaveCount(3);
  await app.followMode().selectOption('off');
  await expect(app.topButton('follow')).toHaveAttribute('aria-pressed', 'false');
});

test('first paint: FCP, the shell mark and the first viewer mark are in budget', async ({ app }) => {
  await app.goto('spark');
  await expect(app.pixelCanvas()).toBeVisible();
  await expect.poll(() => app.perfMark('aa:ready')).not.toBeNull();
  const fcp = await app.perfMark('first-contentful-paint');
  const shell = await app.perfMark('aa:shell');
  const ready = await app.perfMark('aa:ready');
  expect(fcp, 'first-contentful-paint').not.toBeNull();
  expect(fcp!).toBeLessThanOrEqual(1000);
  expect(shell!).toBeLessThanOrEqual(800);
  expect(ready!).toBeLessThanOrEqual(2500);
  expect(shell!).toBeLessThanOrEqual(ready!);
});
