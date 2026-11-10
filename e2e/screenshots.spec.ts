// Documentation screenshots (@shots, excluded from the normal run): `npm run docs:ui-shots`.
// Writes to SHOTS_DIR (default docs/ui). Same seed as the e2e run; shots that need more data add it
// through e2e/shots-seed.ts, so the tests run in file order (one worker) and the order matters:
// plain-seed shots first, then the trooper rig, the cleanup data, and last the 300-canvas project.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.ts';
import { ROOT, runTool } from './cli.ts';
import type { AppPage } from './app.page.ts';
import { seedCleanup, seedKiosk, seedManyCanvases, seedTrooper, trashSome } from './shots-seed.ts';

const dir = () => path.resolve(ROOT, process.env.SHOTS_DIR || 'docs/ui');

interface Settle {
  /** Keep the focused element (the focus is the point: a menu, the palette input). */
  keepFocus?: boolean;
  /** Keep the mouse where it is (a hover readout). */
  keepMouse?: boolean;
  /** The slot A viewer has no status line in this shot (or it is covered by a dialog). */
  noStatus?: boolean;
}

/** Everything a shot waits for: live status, fonts, the viewer status line, decoded images, a settled
 *  graph, one more 3D frame, no toast / spinner / skeleton, and no stray focus. */
async function settle(app: AppPage, o: Settle = {}) {
  const { page } = app;
  await expect(app.status()).toHaveText('live', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const graph = await app.graphStage().isVisible();
  if (graph) {
    // the graph's status line is the counts text in its toolbar
    await expect(app.graphCounts()).toContainText(/\d+ nodes/, { timeout: 15_000 });
    await expect(app.graphCounts()).not.toContainText('laying out', { timeout: 15_000 });
  } else if (!o.noStatus) await expect(app.viewerStatus()).not.toHaveText('', { timeout: 15_000 });
  await app.imagesDecoded();
  if (graph) await expect(app.graphStage()).toHaveAttribute('data-settled', 'true', { timeout: 30_000 });
  if (await app.modelCanvas().isVisible()) {
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(250);
  }
  if (!o.keepMouse) await page.mouse.move(0, 0);
  if (!o.keepFocus) await app.blur();
  await expect(app.toasts()).toHaveCount(0, { timeout: 10_000 });
  await expect(app.busy()).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(300);
}
async function shot(app: AppPage, name: string, o: Settle = {}) {
  await settle(app, o);
  await app.page.screenshot({ path: path.join(dir(), `${name}.png`), mask: app.volatile(), maskColor: '#15171c' });
}

async function openTrooperLayers(app: AppPage) {
  seedTrooper();
  await app.goto('rig:trooper');
  await app.tab('Layers').click();
  await expect(app.layersCanvas()).toBeVisible();
  await app.layersViewSelect().selectOption('front_side');
  await expect.poll(() => app.layersClipSelect().evaluate((s: HTMLSelectElement) => [...s.options].map((x) => x.value))).toContain('trooper/walk_front_side');
  await app.layersClipSelect().selectOption('trooper/walk_front_side');
  await expect.poll(() => app.stackRows().count()).toBeGreaterThanOrEqual(10);
  // two parts selected: the Flag button names them
  await app.stackRows().filter({ hasText: 'hand_f' }).first().locator('.sname').click();
  await app.stackRows().filter({ hasText: 'chest' }).first().locator('.sname').click();
  await expect(app.flagButton()).toBeEnabled();
}

/** Select mode with the retire candidates ticked (20-22). */
async function selectForCleanup(app: AppPage) {
  seedCleanup();
  await app.goto('helmet_old');
  await expect(app.browserRow('decal_test')).toBeVisible({ timeout: 5000 });
  await app.expandRow('severance', 'project');
  await app.enterSelectMode();
  await expect(app.selectionBar()).toBeVisible();
  for (const n of ['helmet_old', 'pauldron_v1', 'visor_wip', 'decal_test', 'crate_tex']) await app.browserRow(n).locator('.label').click();
  await expect(app.selectionBar()).toContainText('5 selected');
}

test.describe('@shots', () => {
  test.beforeAll(() => { fs.mkdirSync(dir(), { recursive: true }); });

  test('01-overview', async ({ app }) => {
    // a few one-line agent entries (read-only graph ops), so the overview shows a full timeline as before
    // (plan step 20 density check: at least 8 entries visible at 1680x980)
    for (const args of [{ action: 'summary' }, { action: 'query', node: 'helmet_front' }, { action: 'query', node: 'helmet_side' }, { action: 'query', node: 'pauldron' }, { action: 'query', node: 'hero' }, { action: 'summary' }]) runTool('art_graph', args);
    await app.goto('helmet_front');
    await expect.poll(() => app.timelineEntries().count()).toBeGreaterThanOrEqual(8);
    await expect(app.pixelCanvas()).toBeVisible();
    await shot(app, '01-overview');
  });

  test('02-timeline', async ({ app }) => {
    await app.goto('helmet_front');
    await expect(app.timelineEntries().first()).toBeVisible();
    await settle(app);
    await app.timelinePane().screenshot({ path: path.join(dir(), '02-timeline.png'), mask: app.volatile(), maskColor: '#15171c' });
  });

  test('07-model-viewer', async ({ app }) => {
    await app.goto('model:rifle');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await shot(app, '07-model-viewer');
  });

  test('08-model-wire-uv-normals', async ({ app }) => {
    await app.goto('model:rifle');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    for (const t of ['Wireframe', 'Normals', 'UV checker', 'Pivots']) await app.modelToggle(t).check();
    await shot(app, '08-model-wire-uv-normals');
  });

  test('09-audio-player', async ({ app }) => {
    await app.goto('audio:rifle_shot');
    await expect(app.audioWave()).toBeVisible();
    await expect(app.audioReport().locator('img.analysis-img')).toBeVisible({ timeout: 20_000 });
    await shot(app, '09-audio-player');
  });

  test('12-asset-graph', async ({ app }) => {
    await app.goto('graph');
    await expect(app.graphFlow()).toBeVisible();
    await expect(app.graphCounts()).toContainText('· cards');
    await shot(app, '12-asset-graph');
  });

  test('31-graph-hierarchy', async ({ app }) => {
    await app.goto('graph');
    await expect(app.graphFlow()).toBeVisible();
    await app.graphLayoutSelect().selectOption('hierarchy');
    await expect(app.graphCounts()).not.toContainText('laying out', { timeout: 5_000 });
    await app.blur();
    await app.press('0');
    await shot(app, '31-graph-hierarchy');
  });

  test('13-review-mark-dialog', async ({ app, page }) => {
    await app.goto('helmet_side');
    await expect(app.pixelCanvas()).toBeVisible();
    await expect(app.viewerStatus()).toContainText('helmet_side');
    await app.blur();
    await app.press('m');
    const box = (await app.pixelCanvas().boundingBox())!;
    const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
    await page.mouse.move(...at(0.56, 0.44));
    await page.mouse.down();
    await page.mouse.move(...at(0.7, 0.52), { steps: 5 });
    await page.mouse.move(...at(0.84, 0.62), { steps: 5 });
    await page.mouse.up();
    await expect(app.reviewDialog()).toBeVisible();
    await app.reviewField('Category').selectOption('inconsistent');
    await app.reviewField('Priority').selectOption('high');
    await app.reviewField('Note').fill('Visor sits 3 px lower than on the front view; line it up with helmet_front');
    await app.reviewField('Compare with').fill('canvas:helmet_front');
    await app.reviewField('Compare view').fill('front');
    await shot(app, '13-review-mark-dialog', { noStatus: true });
  });

  test('15-art-review-get', async () => {
    runTool('art_review', { action: 'get', id: 'r1' }, { out: path.join(dir(), '15-art-review-get.png') });
    expect(fs.statSync(path.join(dir(), '15-art-review-get.png')).size).toBeGreaterThan(500);
  });

  test('14-review-notes', async ({ app }) => {
    runTool('art_draw', { canvas: 'helmet_side', commands: [{ op: 'rect', x: 15, y: 12, w: 4, h: 2, color: '#1b1f2a' }, { op: 'rect', x: 15, y: 11, w: 4, h: 2, color: '#38bdf8' }] });
    runTool('art_review', { action: 'update', id: 'r1', status: 'fixed', reply: 'visor moved up 1 px to match the front view' });
    await app.goto('helmet_side');
    await expect(app.pixelCanvas()).toBeVisible();
    const card = app.reviewCards().first();
    await expect(card).toBeVisible();
    await expect(card.locator('.rc-status')).toHaveText('fixed');
    await card.scrollIntoViewIfNeeded();
    await shot(app, '14-review-notes');
  });

  test('16-compare-side-by-side', async ({ app }) => {
    await app.goto('helmet_side');
    await expect(app.pixelCanvas()).toBeVisible();
    await app.openTarget({ kind: 'canvas', name: 'helmet_front' }, 'B');
    await expect(app.slotTitle('B')).toContainText('helmet_front');
    await expect(app.pixelCanvas('B')).toBeVisible();
    await expect(app.viewerStatus('B')).not.toHaveText('');
    await shot(app, '16-compare-side-by-side');
  });

  test('34-compare-difference', async ({ app }) => {
    await app.goto('helmet_side');
    const entry = app.timelineEntry(/draw[\s\S]*helmet_side/);
    await expect(entry).toBeVisible();
    await app.timelineCompare(entry).click();
    await expect(app.slotWrap('B')).toBeVisible();
    await expect(app.compareTools()).toBeVisible();
    await app.blur();
    await app.press('d');
    await expect(app.overlaySelect()).toHaveValue('diff');
    await expect(app.compareStatus()).toHaveText(/px differ/);
    await shot(app, '34-compare-difference');
  });

  test('17-follow-timeline-bottom', async ({ app }) => {
    await app.goto('helmet_front');
    await expect(app.followMode()).toHaveValue('canvas');
    await app.dockButton().click();
    await expect(app.bottomDock()).toBeVisible();
    runTool('art_draw', { canvas: 'pauldron', commands: [{ op: 'ellipse', x: 4, y: 5, w: 8, h: 4, color: '#f5a524', outline: '#1b1f2a' }] });
    await expect(app.slotTitle('A')).toContainText('pauldron', { timeout: 5000 });
    await expect(app.timelineEntries().first()).toContainText('pauldron');
    await shot(app, '17-follow-timeline-bottom');
  });

  test('26-model-solid', async ({ app }) => {
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await app.blur();
    await app.press('2');
    await expect(app.shadingRadio('solid')).toHaveAttribute('aria-checked', 'true');
    await shot(app, '26-model-solid');
  });

  test('27-model-material-preview', async ({ app }) => {
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await app.blur();
    await app.press('3');
    await expect(app.shadingRadio('material')).toHaveAttribute('aria-checked', 'true');
    await expect(app.viewerStatus()).toContainText('Material preview');
    await shot(app, '27-model-material-preview');
  });

  test('28-model-rendered-shadows-ao', async ({ app }) => {
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await app.blur();
    await app.press('4');
    await expect(app.shadingRadio('rendered')).toHaveAttribute('aria-checked', 'true');
    await app.modelToggle('Shadows').check();
    await app.modelToggle('AO').check();
    await expect(app.viewerStatus()).toContainText('Rendered');
    await shot(app, '28-model-rendered-shadows-ao');
  });

  test('29-model-baked-lightmap', async ({ app }) => {
    test.setTimeout(90_000);
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await app.blur();
    await app.press('4');
    await expect(app.shadingRadio('rendered')).toHaveAttribute('aria-checked', 'true');
    await app.shadingSelect('Baked').selectOption('ao+lightmap');
    await expect(app.viewerStatus()).toContainText('baked lighting', { timeout: 45_000 });
    await shot(app, '29-model-baked-lightmap');
  });

  test('30-model-shading-pie', async ({ app }) => {
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await settle(app);
    const box = (await app.modelCanvas().boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // a mode key first (Material preview, the default): the shading side of the viewer is ready then
    await app.press('3');
    await expect(app.shadingRadio('material')).toHaveAttribute('aria-checked', 'true');
    await app.press('z');
    // the pie element is a zero-size anchor: its items are what shows
    await expect(app.shadingPie().locator('[role=menuitemradio]').first()).toBeVisible();
    await expect(app.shadingPie().locator('[role=menuitemradio]')).toHaveCount(4);
    await shot(app, '30-model-shading-pie', { keepFocus: true, keepMouse: true });
  });

  test('33-command-palette', async ({ app }) => {
    await app.goto('helmet_side');
    await expect(app.pixelCanvas()).toBeVisible();
    await settle(app);
    await app.openPalette();
    await app.paletteInput().fill('helm');
    await expect(app.paletteOptions().first()).toBeVisible();
    await shot(app, '33-command-palette', { keepFocus: true });
  });

  test('35-colour-picker', async ({ app }) => {
    await app.goto('helmet_front');
    await expect(app.pixelCanvas()).toBeVisible();
    await settle(app);
    await app.colorSwatch().click();
    await expect(app.colorPopover()).toBeVisible();
    await expect(app.hexInput()).toBeVisible();
    await shot(app, '35-colour-picker', { keepFocus: true });
  });

  test('36-asset-context-menu', async ({ app }) => {
    await app.goto('helmet_front');
    await expect(app.pixelCanvas()).toBeVisible();
    await settle(app);
    await app.browserRow('spark').click({ button: 'right' });
    await expect(app.menuItem('Open in compare')).toBeVisible();
    await shot(app, '36-asset-context-menu', { keepFocus: true, keepMouse: true });
  });

  test.describe('narrow', () => {
    test.use({ viewport: { width: 430, height: 900 } });
    test('18-narrow', async ({ app }) => {
      await app.goto('helmet_side');
      await expect(app.pixelCanvas()).toBeVisible();
      await shot(app, '18-narrow');
    });
    test('18b-narrow-assets-drawer', async ({ app }) => {
      await app.goto('helmet_side');
      await expect(app.pixelCanvas()).toBeVisible();
      await app.topButton('toggleBrowser').click();
      await expect(app.topButton('toggleBrowser')).toHaveAttribute('aria-expanded', 'true');
      await expect(app.browserPane()).toBeVisible();
      await shot(app, '18b-narrow-assets-drawer');
    });
  });

  // ---- the 8-direction trooper rig (shots-seed) ----
  test('03-animation-8-directions', async ({ app }) => {
    test.setTimeout(90_000);
    seedTrooper();
    await app.goto('trooper');
    await app.tab('Animation').click();
    await expect(app.animCells()).toHaveCount(8);
    await expect(app.viewerStatus()).toContainText(/8 views/);
    await shot(app, '03-animation-8-directions');
  });

  test('04-rig-skeleton', async ({ app }) => {
    seedTrooper();
    await app.goto('rig:trooper');
    await expect(app.rigCanvas()).toBeVisible();
    await expect(app.viewerStatus()).toContainText(/walk_/);
    await shot(app, '04-rig-skeleton');
  });

  test('05-layers-debug', async ({ app }) => {
    await openTrooperLayers(app);
    await settle(app, { noStatus: true });
    const box = (await app.layersCanvas().boundingBox())!;
    await app.layersCanvas().hover({ position: { x: box.width / 2, y: box.height * 0.42 } });
    await expect(app.hoverInfo()).toContainText(/x \d+ y \d+: (drawn by|empty)/);
    // the Layers view has no status line: the hover readout is its status
    await shot(app, '05-layers-debug', { keepMouse: true, noStatus: true });
  });

  test('06-layering-review-dialog', async ({ app }) => {
    await openTrooperLayers(app);
    const flag = (await app.flagButton().textContent()) ?? '';
    await app.flagButton().click();
    await expect(app.reviewDialog()).toBeVisible();
    await expect(app.reviewField('Category')).toHaveValue('layering');
    const [, a, b] = flag.match(/^Flag: (.+) above (.+)\?$/) ?? [];
    await app.reviewField('Note').fill(a && b ? `${a} should be above ${b} in this view` : 'Wrong draw order in this view');
    await shot(app, '06-layering-review-dialog', { noStatus: true });
  });

  test('10-sheet-anchors', async ({ app }) => {
    seedTrooper();
    await app.goto('trooper');
    await app.tab('Sheet').click();
    await expect(app.sheetCanvas()).toBeVisible();
    await expect(app.viewerStatus()).toContainText(/cells/);
    await shot(app, '10-sheet-anchors');
  });

  test('11-export-preview', async ({ app }) => {
    seedTrooper();
    await app.goto('export:trooper.png');
    await expect(app.sheetCanvas()).toBeVisible();
    await expect(app.viewerStatus()).toContainText(/frame/);
    await shot(app, '11-export-preview');
  });

  // ---- cleanup (shots-seed adds retire candidates; 23+ trash some of them) ----
  test('20-cleanup-select', async ({ app }) => {
    await selectForCleanup(app);
    await shot(app, '20-cleanup-select');
  });

  test('21-cleanup-plan-blocked', async ({ app }) => {
    await selectForCleanup(app);
    await app.planCleanupButton().click();
    const dlg = app.planDialog();
    await expect(dlg.getByRole('region', { name: 'Blocked' })).toContainText('needed by model:crate_v2');
    await expect(dlg.getByRole('button', { name: 'Blocked' })).toBeDisabled();
    await shot(app, '21-cleanup-plan-blocked', { noStatus: true });
  });

  test('22-cleanup-plan', async ({ app }) => {
    await selectForCleanup(app);
    await app.planCleanupButton().click();
    const dlg = app.planDialog();
    await expect(dlg.getByRole('region', { name: 'Blocked' })).toBeVisible();
    await dlg.getByRole('checkbox', { name: 'Dependents too' }).check();
    await expect(dlg.getByRole('button', { name: /^Move \d+ to trash$/ })).toBeEnabled();
    await shot(app, '22-cleanup-plan', { noStatus: true });
  });

  test('23-cleanup-trash', async ({ app }) => {
    seedCleanup();
    trashSome();
    await app.goto('helmet_front');
    await app.openCleanup();
    const c = app.cleanupDialog();
    await expect(c.getByRole('button', { name: 'Restore all' }).first()).toBeVisible();
    await shot(app, '23-cleanup-trash', { noStatus: true });
  });

  test('24-cleanup-usage', async ({ app }) => {
    seedCleanup();
    trashSome();
    await app.goto('helmet_front');
    await app.openCleanup();
    const c = app.cleanupDialog();
    await c.getByRole('tab', { name: 'Disk usage' }).click();
    await expect(c.getByRole('region', { name: 'By kind' }).locator('[data-bar="canvas"]')).toBeVisible();
    await shot(app, '24-cleanup-usage', { noStatus: true });
  });

  test('25-cleanup-graph-badges', async ({ app }) => {
    seedCleanup();
    await app.goto('graph');
    await expect(app.graphFlow()).toBeVisible();
    await expect(app.graphCard('canvas:helmet_old')).toBeVisible();
    await shot(app, '25-cleanup-graph-badges');
  });

  // ---- a multi-part prop on the default unwrap path: the model and its one atlas canvas ----
  test('37-model-uv-atlas', async ({ app }) => {
    seedKiosk();
    await app.goto('model:kiosk');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await app.blur();
    await app.press('4');
    await expect(app.shadingRadio('rendered')).toHaveAttribute('aria-checked', 'true');
    await app.modelToggle('Shadows').check();
    await app.modelToggle('AO').check();
    await expect(app.viewerStatus()).toContainText('Rendered');
    await shot(app, '37-model-uv-atlas');
  });

  test('38-model-uv-canvas', async ({ app }) => {
    seedKiosk();
    await app.goto('kiosk_uv');
    await expect(app.pixelCanvas()).toBeVisible();
    await shot(app, '38-model-uv-canvas');
  });

  // ---- last: 300 extra canvases in a second project (one agent-art batch call) ----
  test('19-many-canvases', async ({ app }) => {
    test.setTimeout(180_000);
    seedManyCanvases();
    await app.goto('prop_299');
    await expect(app.slotTitle('A')).toContainText('prop_299');
    await app.expandRow('props', 'project');
    await expect(app.browserRow('prop_000')).toBeVisible();
    await shot(app, '19-many-canvases');
  });

  test('32-graph-canvas-large', async ({ app }) => {
    test.setTimeout(120_000);
    seedManyCanvases();
    await app.goto('graph');
    await expect(app.graphCounts()).toContainText(/3\d\d nodes/, { timeout: 20_000 });
    // 326 nodes is still under the Auto limit for cards: pick the Canvas renderer explicitly, once the
    // cards have mounted (switching while the cards chunk is still loading can leave the stage empty)
    await expect(app.graphFlow()).toBeVisible({ timeout: 20_000 });
    await expect(app.graphStage()).toHaveAttribute('data-settled', 'true', { timeout: 30_000 });
    await app.graphViewSelect().selectOption('canvas');
    await expect(app.graphCounts()).toContainText('· canvas');
    await expect(app.graph().locator('canvas.graph-canvas')).toBeVisible({ timeout: 30_000 });
    await expect(app.graphFlow()).toHaveCount(0, { timeout: 30_000 });
    await shot(app, '32-graph-canvas-large');
  });
});
