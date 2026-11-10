<!--
  Page-wide notice under the top bar: a newer build of the web UI is being served (after a server
  restart, 3.5), or the served build is older than the web/ sources of a source checkout (step 21,
  `health.ui.stale`). Each is dismissible for the session.
-->
<script lang="ts">
  import { BANNER_TEXT, connection } from '@/state/connection.svelte';
  import Icon from '../ui/Icon.svelte';

  const kind = $derived(connection.banner);
</script>

{#if kind}
  <div class="banner" role="alert" data-banner={kind}>
    <Icon name="triangle-alert" size={14} />
    <span>{BANNER_TEXT[kind]}</span>
    <button type="button" class="btn small" onclick={() => location.reload()}>Reload</button>
    <button type="button" class="btn small icon ghost" aria-label="Dismiss" title="Dismiss" onclick={() => connection.dismiss(kind)}><Icon name="x" size={14} /></button>
  </div>
{/if}

<style>
  .banner { flex: none; display: flex; align-items: center; gap: var(--s-4); padding: var(--s-2) var(--s-5); background: var(--accent-bg); color: var(--accent-fg); border-bottom: 1px solid var(--accent); font-size: var(--fs-3); }
  .banner span:not(:global(.icon)) { flex: 1; }
</style>
