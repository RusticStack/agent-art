// Connection status: the SSE phase, agent activity (busy pill), server restarts and stale builds.
export type ConnStatus = 'connecting' | 'live' | 'busy' | 'down';
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
  attempt = $state(0);

  get status(): ConnStatus {
    if (this.phase === 'down') return 'down';
    if (this.phase === 'connecting') return 'connecting';
    return this.now - this.lastAgentAt < BUSY_MS ? 'busy' : 'live';
  }
  get label(): string {
    return { connecting: 'connecting…', live: 'live', busy: 'agent is working…', down: 'disconnected — retrying' }[this.status];
  }
  /** CSS class of the legacy status pill. */
  get pillClass(): string {
    return { connecting: 'status', live: 'status ok', busy: 'status busy', down: 'status down' }[this.status];
  }
  agentActive(at = Date.now()): void { this.lastAgentAt = at; this.now = at; }
  tick(at = Date.now()): void { this.now = at; }
}

export const connection = new Connection();
