// Step 8b: 3D viewport shading modes (plan 5.7b, checks 1-14). SwiftShader in CI: thresholds are lenient.
import { test, expect, type Page } from './fixtures.ts';
import type { Locator } from '@playwright/test';

type Dbg = Record<string, unknown> & { gl?: { textures: number; geometries: number; programs: number }; maps?: { nearest?: boolean } };
const dbg = (page: Page) => page.evaluate(() => (window as unknown as { agentArt: { debug: { viewer(s: string): unknown } } }).agentArt.debug.viewer('A') as Dbg);

async function png(el: Locator, clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
  return (await (clip ? el.page().screenshot({ clip }) : el.screenshot())).toString('base64');
}
/** Share of pixels that differ by more than 12 (sum of RGB deltas) between two screenshots. */
function diffShare(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(async ([x, y]) => {
    const load = async (s: string) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const [p, q] = await Promise.all([load(x), load(y)]);
    if (p.length !== q.length) return 1;
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 12) n++;
    return n / (p.length / 4);
  }, [a, b]);
}
const settle = (page: Page) => page.waitForTimeout(350);

test.describe('3D viewport shading', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('e2e-shading')) { sessionStorage.setItem('e2e-shading', '1'); localStorage.removeItem('agent-art:modelView'); } } catch { /* ignore */ } });
  });

  test('modes, pie, textures, environment, shadows, AO, sun, bake, background, turntable, quality, leaks, review, persistence', async ({ app, page }) => {
    test.setTimeout(120_000);
    const shading = app.slot('A').locator('.model-viewer .vtoolbar.shading');
    const radio = (m: string) => shading.locator(`[role=radiogroup] [role=radio][data-mode="${m}"]`);
    const sel = (t: string) => shading.locator(`select[title^="${t}"]`);
    const canvas = app.modelCanvas();
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });

    // 1. keys 1-4 and the Z pie
    const names: Record<string, RegExp> = { '1': /Wireframe/, '2': /Solid/, '3': /Material preview/, '4': /Rendered/ };
    const modes: Record<string, string> = { '1': 'wire', '2': 'solid', '3': 'material', '4': 'rendered' };
    const shots: string[] = [];
    for (const k of ['1', '2', '3', '4']) {
      await app.blur();
      await app.press(k);
      await expect(radio(modes[k])).toHaveAttribute('aria-checked', 'true');
      await expect(app.viewerStatus()).toContainText(names[k]);
      await settle(page);
      shots.push(await png(canvas));
    }
    await app.blur();
    await app.press('z');
    await expect(page.locator('[role=menu] [role=menuitemradio]').first()).toBeVisible();
    await expect(page.locator('[role=menu] [role=menuitemradio]')).toHaveCount(4);
    await app.press('2');
    await expect(page.locator('[role=menu]')).toHaveCount(0);
    await expect(radio('solid')).toHaveAttribute('aria-checked', 'true');
    await app.press('z');
    await app.press('Escape');
    await expect(page.locator('[role=menu]')).toHaveCount(0);

    // 2. each mode draws something, and differs from the previous one
    for (let i = 1; i < shots.length; i++) expect(await diffShare(page, shots[i - 1], shots[i])).toBeGreaterThan(0.02);

    // 3. Solid: texture toggle, nearest filtering kept
    await app.press('2');
    await settle(page);
    const tex = app.modelToggle('Texture');
    const withTex = await png(canvas);
    await tex.click();
    await settle(page);
    expect(await diffShare(page, withTex, await png(canvas))).toBeGreaterThan(0.005);
    await tex.click();
    expect((await dbg(page)).maps?.nearest).toBe(true);

    // 4. Material preview: environment, neutral tone mapping, rotate
    await app.blur();
    await app.press('3');
    await settle(page);
    let d = await dbg(page);
    expect(d.environment).toBe(true);
    expect(d.toneMapping).toBe('Neutral');
    const rotate = shading.locator('input[title^="Rotate"]');
    const r0 = await png(canvas);
    await rotate.fill('180');
    await settle(page);
    expect(await diffShare(page, r0, await png(canvas))).toBeGreaterThan(0.005);
    await rotate.fill('0');

    // 5. Rendered: shadows on the ground (lower third), low quality for SwiftShader
    await app.blur();
    await app.press('4');
    await sel('Quality').selectOption('low');
    await settle(page);
    const box = (await canvas.boundingBox())!;
    const lower = { x: box.x, y: box.y + box.height * 2 / 3, width: box.width, height: box.height / 3 };
    const shadowsOn = await png(canvas, lower);
    await app.modelToggle('Shadows').click();
    await settle(page);
    expect(await diffShare(page, shadowsOn, await png(canvas, lower))).toBeGreaterThan(0.005);
    await app.modelToggle('Shadows').click();
    expect((await dbg(page)).shadowMap).toBe(1024);

    // 6. AO strength vs AO off; the composer only while AO is on
    const ao = app.modelToggle('AO');
    if (!(await ao.isChecked())) await ao.click();
    await shading.locator('input[title="AO strength"]').fill('1.5');
    await settle(page);
    const aoOn = await png(canvas);
    expect((await dbg(page)).composer).toBe(true);
    await ao.click();
    await settle(page);
    expect(await diffShare(page, aoOn, await png(canvas))).toBeGreaterThan(0.002);
    expect((await dbg(page)).composer).toBe(false);

    // 7. sun position
    const sun = shading.locator('input[title^="Sun"]').first();
    await sun.fill('7');
    await settle(page);
    const s7 = await png(canvas);
    await sun.fill('12');
    await settle(page);
    expect(await diffShare(page, s7, await png(canvas))).toBeGreaterThan(0.005);

    // 8. baked AO + lightmap
    const bake = page.waitForRequest((r) => /bake=1/.test(r.url()), { timeout: 30_000 });
    await sel('Baked').selectOption('ao+lightmap');
    await bake;
    await expect(app.viewerStatus()).toContainText('baked lighting', { timeout: 20_000 });
    expect(Number((await dbg(page)).lightmaps)).toBeGreaterThan(0);
    const baked = await png(canvas);
    await sel('Baked').selectOption('off');
    await settle(page);
    expect(await diffShare(page, baked, await png(canvas))).toBeGreaterThan(0.002);

    // 9. background
    const corner = { x: box.x + 2, y: box.y + 2, width: 4, height: 4 };
    const bg: string[] = [];
    for (const v of ['dark', 'studio', 'env']) { await sel('Background').selectOption(v); await settle(page); bg.push(await png(canvas, corner)); }
    expect(new Set(bg).size).toBe(3);
    await sel('Background').selectOption('dark');

    // 10. turntable, stopped by a click
    await shading.getByRole('button', { name: /Turntable/ }).click();
    const t1 = await png(canvas);
    await page.waitForTimeout(400);
    expect(await diffShare(page, t1, await png(canvas))).toBeGreaterThan(0.002);
    await canvas.click();
    await expect.poll(async () => (await dbg(page)).turntable).toBe(false);

    // 11. quality tiers
    await sel('Quality').selectOption('high');
    await expect.poll(async () => (await dbg(page)).shadowMap).toBe(4096);
    await sel('Quality').selectOption('auto');
    await expect.poll(async () => (await dbg(page)).tier).toBe('low');

    // 12. no GPU resource leaks across mode switches and reopen
    const gl0 = (await dbg(page)).gl!;
    const canvases0 = await page.evaluate(() => document.querySelectorAll('canvas').length);
    for (let i = 0; i < 10; i++) for (const k of ['1', '2', '3', '4']) { await app.blur(); await app.press(k); }
    for (let i = 0; i < 3; i++) {
      await app.goto('spark');
      await app.goto('model:crate_v2');
      await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    }
    await app.blur();
    await app.press('4');
    await settle(page);
    d = await dbg(page);
    expect(d.gl!.textures).toBeLessThanOrEqual(gl0.textures + 2);
    expect(d.gl!.geometries).toBeLessThanOrEqual(gl0.geometries + 2);
    expect(d.gl!.programs).toBeLessThanOrEqual(gl0.programs + 2);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBeLessThanOrEqual(canvases0);

    // 13. review mode in Rendered: a click opens the note dialog (the rendered crop is attached as
    // draft.image; the legacy dialog does not show it, the image check arrives with step 16)
    await app.press('m');
    await canvas.click();
    await expect(app.dialog()).toContainText('Review note');
    await app.press('Escape');
    await app.press('Escape');

    // 14. persistence: Rendered + studio background survive a reload
    await sel('Background').selectOption('studio');
    await page.reload();
    await app.goto('model:crate_v2');
    await expect(app.viewerStatus()).toContainText(/\d+ tris/, { timeout: 20_000 });
    await expect(radio('rendered')).toHaveAttribute('aria-checked', 'true');
    await expect(sel('Background')).toHaveValue('studio');

    // idle: no frames drawn while nothing changes
    await page.waitForTimeout(600);
    const f0 = (await dbg(page)).frames;
    await page.waitForTimeout(1000);
    expect((await dbg(page)).frames).toBe(f0);
  });
});
