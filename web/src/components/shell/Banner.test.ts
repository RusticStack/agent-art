// @vitest-environment jsdom
// Step 21: the stale-build banner (health.ui.stale) next to the newer-build one (3.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { fakeFetch } from '@/test/fakes';
import { BANNER_TEXT, Connection, connection } from '@/state/connection.svelte';
import { assets } from '@/state/assets.svelte';
import { reviews } from '@/state/reviews.svelte';
import { uiState } from '@/state/uiState.svelte';
import { resync } from '@/state/live.svelte';
import Banner from './Banner.svelte';

const reset = () => {
  connection.uiOutdated = false;
  connection.uiStale = false;
  connection.dismissed = { outdated: false, stale: false };
};
beforeEach(reset);
afterEach(() => { cleanup(); reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Connection banner state', () => {
  it('setUiStatus reads health.ui; a missing ui (older server) is not stale', () => {
    const c = new Connection();
    c.setUiStatus({ built: true, stale: true });
    expect(c.uiStale).toBe(true);
    expect(c.banner).toBe('stale');
    c.setUiStatus(undefined);
    expect(c.uiStale).toBe(false);
    expect(c.banner).toBe(null);
  });
  it('a newer build wins over a stale one; dismissing one shows the other, both stay dismissed', () => {
    const c = new Connection();
    c.uiStale = true;
    c.uiOutdated = true;
    expect(c.banner).toBe('outdated');
    c.dismiss('outdated');
    expect(c.banner).toBe('stale');
    c.dismiss('stale');
    expect(c.banner).toBe(null);
    c.setUiStatus({ built: true, stale: true });
    expect(c.banner).toBe(null);
  });
});

describe('Banner', () => {
  it('shows the stale text when health.ui.stale and hides it for the session after Dismiss', async () => {
    render(Banner);
    expect(screen.queryByRole('alert')).toBeNull();
    connection.setUiStatus({ built: true, stale: true });
    await tick();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(BANNER_TEXT.stale);
    expect(alert.textContent).toContain('npm run build:ui');
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(screen.queryByRole('alert')).toBeNull();
    // a later health answer that is still stale does not bring it back
    connection.setUiStatus({ built: true, stale: true });
    await tick();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('the restart banner keeps its text', async () => {
    connection.uiOutdated = true;
    render(Banner);
    await tick();
    expect(screen.getByRole('alert').textContent).toContain('The server was restarted with a newer web UI');
  });
  it('resync applies health.ui (a rebuild clears it)', async () => {
    vi.spyOn(assets, 'refresh').mockResolvedValue();
    vi.spyOn(reviews, 'refresh').mockResolvedValue();
    vi.spyOn(uiState, 'load').mockResolvedValue();
    connection.serverPid = 5;
    fakeFetch({ '/api/health': { json: { pid: 5, ui: { built: true, stale: true } } }, '/api/activity': { json: { entries: [], seq: 0 } } });
    await resync();
    expect(connection.uiStale).toBe(true);
    fakeFetch({ '/api/health': { json: { pid: 5, ui: { built: true, stale: false } } }, '/api/activity': { json: { entries: [], seq: 0 } } });
    await resync();
    expect(connection.uiStale).toBe(false);
  });
});
