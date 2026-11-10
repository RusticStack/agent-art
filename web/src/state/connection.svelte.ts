// Connection status: the SSE phase, agent activity (busy pill), server restarts and stale builds.
export type ConnStatus = 'connecting' | 'live' | 'busy' | 'down';
export type BannerKind = 'outdated' | 'stale';
export const BANNER_TEXT: Record<BannerKind, string> = {
  outdated: 'The server was restarted with a newer web UI. Reload the page to use it.',
  stale: 'This web UI build is older than the sources. Run npm run build:ui and reload.',
};
export const BUSY_MS = 2500;

export class Connection {
  phase = $state<'connecting' | 'open' | 'down'>('connecting');
  lastAgentAt = $state(0);
  /** Ticked every 1000 ms (boot), so the busy pill decays without an event. */
  now = $state(Date.now());
  serverPid = $state<number | null>(null);
  /** The server pid changed since boot. */
  restarted = $state(false);
  /** A newer build of the web UI is being served. */
  uiOutdated = $state(false);
  /** `health.ui.stale`: the served build is older than the web/ sources of a source checkout (step 21). */
  uiStale = $state(false);
  /** Banners the user closed; they stay closed until the page reloads. */
  dismissed = $state<Record<BannerKind, boolean>>({ outdated: false, stale: false });
  attempt = $state(0);

  get status(): ConnStatus {
    if (this.phase === 'down') return 'down';
    if (this.phase === 'connecting') return 'connecting';
    return this.now - this.lastAgentAt < BUSY_MS ? 'busy' : 'live';
  }
  get label(): string {
    return { connecting: 'connecting…', live: 'live', busy: 'agent is working…', down: 'disconnected — retrying' }[this.status];
  }
  /** CSS class of the status pill (components/shell/StatusPill). */
  get pillClass(): string {
    return { connecting: 'status', live: 'status ok', busy: 'status busy', down: 'status down' }[this.status];
  }
  /** The page-wide banner to show (components/shell/Banner): a newer build first, then a stale one. */
  get banner(): BannerKind | null {
    if (this.uiOutdated && !this.dismissed.outdated) return 'outdated';
    if (this.uiStale && !this.dismissed.stale) return 'stale';
    return null;
  }
  /** `GET /api/health` `ui` (older servers have none: not stale). */
  setUiStatus(ui: { built: boolean; stale: boolean } | null | undefined): void { this.uiStale = !!ui?.stale; }
  dismiss(kind: BannerKind): void { this.dismissed = { ...this.dismissed, [kind]: true }; }
  agentActive(at = Date.now()): void { this.lastAgentAt = at; this.now = at; }
  tick(at = Date.now()): void { this.now = at; }
}

export const connection = new Connection();
