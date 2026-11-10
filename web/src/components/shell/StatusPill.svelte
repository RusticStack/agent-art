<!--
  Connection status (T3): connecting… / live / agent is working… (pulsing) / disconnected — retrying.
  The visible text changes with every busy flicker; screen readers only hear live <-> disconnected (4.4).
-->
<script lang="ts">
  import { connection } from '@/state/connection.svelte';

  const announce = $derived(connection.status === 'down' ? 'disconnected — retrying' : connection.phase === 'open' ? 'live' : '');
</script>

<div id="status" class={connection.pillClass} title="Connection to the Agent Art server">
  <span class="dot" aria-hidden="true"></span><span id="statusText">{connection.label}</span>
  <span class="sr-only" role="status" aria-live="polite">{announce}</span>
</div>

<style>
  .status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
  .status:global(.ok) .dot { background: var(--green); }
  .status:global(.busy) .dot { background: var(--accent); animation: pulse 1s infinite; }
  .status:global(.down) .dot { background: var(--red); }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .status:global(.busy) .dot { animation: none; } }
  /* 4.5: below 420 px only the dot shows; the text stays for screen readers (and the e2e page object) */
  @media (max-width: 420px) {
    #statusText { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }
</style>
