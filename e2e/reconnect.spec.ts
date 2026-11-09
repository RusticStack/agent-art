// Step 12: the server goes away and comes back on the same port: the UI reconnects, resyncs the
// timeline, and user ops still work (the per-process UI token was refreshed).
import { test, expect } from './fixtures.ts';
import { readState, runTool, STATE_FILE } from './cli.ts';
import { restartServer, stopServer, waitDown } from './server.ts';
import { LIVE_SEED, seed } from './seed.ts';

test('server restart: disconnected, then live; new ops show up; cleanup settings save', async ({ app, guard }) => {
  test.setTimeout(60_000);
  guard.allow(/net::ERR_CONNECTION_(RESET|REFUSED)|net::ERR_EMPTY_RESPONSE|Failed to load resource/);
  await app.goto('helmet_front');
  const st = readState();
  stopServer(st.pid);
  await waitDown(st.port);
  await expect(app.status()).toHaveText('disconnected — retrying', { timeout: 10_000 });
  await restartServer(st, STATE_FILE);
  await expect(app.status()).toHaveText(/^live$|agent is working/, { timeout: 20_000 });
  runTool('art_draw', { canvas: 'scratch', commands: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#38bdf8' }] });
  await expect(app.timelineEntries().first()).toContainText('scratch', { timeout: 10_000 });
  await app.openCleanup();
  const dlg = app.dialog();
  await dlg.getByRole('button', { name: 'Settings' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(app.toasts().filter({ hasText: /saved|Saved/ })).toBeVisible();
  await expect(app.toasts().filter({ hasText: /cleanup_config/ })).toHaveCount(0);
  // the activity log lives in the server process: put the live seed back for the specs that run later
  seed(st.home, st.port, LIVE_SEED);
});
