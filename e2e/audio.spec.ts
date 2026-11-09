// Step 9: audio viewer (TS port): waveform, analysis report, Space play / pause, keyboard seek.
import { test, expect, nonBackgroundShare } from './fixtures.ts';

test('audio: waveform, analysis, Space toggles play, End seeks to the end', async ({ app, page }) => {
  await app.goto('audio:rifle_shot');
  await expect(app.audioWave()).toBeVisible();
  await expect(app.viewerStatus()).toContainText(/rifle_shot .* Hz/);
  await expect.poll(() => nonBackgroundShare(page, '#slotA canvas.wave')).toBeGreaterThan(0.01);
  const img = app.audioReport().locator('img.analysis-img');
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect(img).toHaveAttribute('alt', /Analysis image the agent reads/);
  await expect(app.audioPlay()).toContainText('Play');
  await app.blur();
  await page.keyboard.press('Space');
  await expect(app.audioPlay()).toContainText('Pause');
  await page.keyboard.press('Space');
  await expect(app.audioPlay()).toContainText('Play');
  await app.audioWave().focus();
  await page.keyboard.press('End');
  await expect(app.audioWave()).toHaveAttribute('aria-valuetext', /^(\d+\.\d\d) of \1 seconds$/);
});
