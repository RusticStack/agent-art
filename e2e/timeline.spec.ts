import { test, expect } from './fixtures.ts';
import { runTool } from './cli.ts';

test('an agent draw shows up live, the status pulses, follow opens it, the row flashes', async ({ app, page }) => {
  await app.goto('helmet_front');
  await expect(app.followMode()).toHaveValue('canvas');
  // the list is virtualised: count with the counter's total, not the DOM rows
  const total = async () => Number((await app.timelineCount().textContent())!.split('/')[1].split(' ')[0]);
  const before = await total();
  // watch for the flash class on the browser row (it lasts 0.9 s)
  await page.evaluate(() => {
    (window as unknown as { __flashed: boolean }).__flashed = false;
    new MutationObserver(() => { if (document.querySelector('[data-id="canvas:spark"].flash')) (window as unknown as { __flashed: boolean }).__flashed = true; })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  });
  runTool('art_draw', { canvas: 'spark', commands: [{ op: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#e5484d', frame: 1 }] });
  await expect(app.timelineEntries().first()).toContainText('draw', { timeout: 3000 });
  await expect(app.timelineEntries().first()).toContainText('spark');
  await expect.poll(total).toBeGreaterThan(before);
  await expect(app.status()).toHaveText('agent is working…');
  await expect(app.slotTitle('A')).toContainText('spark');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __flashed: boolean }).__flashed)).toBe(true);
  await expect(app.status()).toHaveText('live', { timeout: 5000 });
});

test('the seeded error is in the timeline and the counter shows it', async ({ app }) => {
  await app.goto('helmet_front');
  await expect(app.timelineCount()).toContainText(/\d+\/\d+ · \d+ err/);
  await app.timelineChip('Errors').click();
  await expect(app.timelineEntries().first()).toContainText('No canvas');
  await app.timelineChip('Errors').click();
});

// Step 14: the Svelte timeline (virtualised, filters, stable scroll position)
test('the Errors chip filters to the seeded failing op', async ({ app }) => {
  await app.goto('helmet_front');
  await app.timelineChip('Errors').click();
  // only failing ops are left (other specs add their own errors to the shared server)
  await expect(app.timelineEntries().filter({ hasText: /canvas=no_such_canvas(?!_)/ })).toHaveCount(1);
  const n = await app.timelineEntries().count();
  for (let i = 0; i < n; i++) await expect(app.timelineEntries().nth(i).locator('.tl-line')).toContainText('err');
  await expect(app.timelineCount()).toHaveText(new RegExp(`^${n}/\\d+ · ${n} err$`));
  await app.timelineChip('Errors').click();
  await expect.poll(() => app.timelineEntries().count()).toBeGreaterThan(1);
});

test('"This asset" narrows to the open asset and follows slot A', async ({ app }) => {
  await app.goto('spark');
  const shown = async () => Number((await app.timelineCount().textContent())!.split('/')[0]);
  await app.timelineChip('This asset').click();
  try {
    await expect(app.timelineEntries().first()).toContainText('spark');
    const nSpark = await shown();
    await app.openAsset('helmet_side');
    await expect(app.timelineEntries().first()).toContainText('helmet_side');
    await expect(app.timelineEntries().filter({ hasText: 'canvas=spark' })).toHaveCount(0);
    await expect.poll(shown).not.toBe(nSpark);
  } finally {
    await app.timelineChip('This asset').click();
  }
});

test('a new entry keeps the scrolled position; at the top it appears first', async ({ app, page }) => {
  await app.goto('helmet_front');
  // enough entries to scroll 300 px (rows are 46 px)
  for (let i = 0; i < 14; i++) runTool('art_draw', { canvas: 'spark', commands: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: i % 2 ? '#38bdf8' : '#e5484d', frame: 1 }] });
  const total = async () => Number((await app.timelineCount().textContent())!.split('/')[1].split(' ')[0]);
  const list = app.timelineList();
  await list.evaluate((el) => { el.scrollTop = 300; });
  await page.waitForTimeout(250);
  const scrolled = await list.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(100); // enough seeded entries to scroll
  const probe = () => list.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('.tl-entry')].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return row ? { id: row.dataset.id ?? '', y: row.getBoundingClientRect().y } : null;
  });
  const a = (await probe())!;
  expect(a.id).not.toBe('');
  const n0 = await total();
  runTool('art_draw', { canvas: 'spark', commands: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#38bdf8', frame: 1 }] });
  await expect.poll(total).toBeGreaterThan(n0);
  await page.waitForTimeout(250);
  const y = await list.evaluate((el, id) => el.querySelector<HTMLElement>(`.tl-entry[data-id="${id}"]`)?.getBoundingClientRect().y ?? null, a.id);
  expect(y).not.toBeNull();
  expect(Math.abs(y! - a.y)).toBeLessThanOrEqual(2);

  await list.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(150);
  const n1 = await total();
  const first = await app.timelineEntries().first().getAttribute('data-id');
  runTool('art_draw', { canvas: 'spark', commands: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#38bdf8', frame: 1 }] });
  await expect.poll(total).toBeGreaterThan(n1);
  await expect.poll(() => app.timelineEntries().first().getAttribute('data-id')).not.toBe(first);
  await expect(app.timelineEntries().first()).toContainText('spark');
});
