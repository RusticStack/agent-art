<!--
  Page-wide notice under the top bar: a newer build of the web UI is being served (after a server
  restart, 3.5). Dismissible for the session.
-->
<script lang="ts">
  import { connection } from '@/state/connection.svelte';
  import Icon from '../ui/Icon.svelte';

  let dismissed = $state(false);
</script>

{#if connection.uiOutdated && !dismissed}
  <div class="banner" role="alert">
    <Icon name="triangle-alert" size={14} />
    <span>The server was restarted with a newer web UI. Reload the page to use it.</span>
    <button type="button" class="btn small" onclick={() => location.reload()}>Reload</button>
    <button type="button" class="btn small icon ghost" aria-label="Dismiss" title="Dismiss" onclick={() => { dismissed = true; }}><Icon name="x" size={14} /></button>
  </div>
{/if}

<style>
  .banner { flex: none; display: flex; align-items: center; gap: var(--s-4); padding: var(--s-2) var(--s-5); background: var(--accent-bg); color: var(--accent-fg); border-bottom: 1px solid var(--accent); font-size: var(--fs-3); }
  .banner span:not(:global(.icon)) { flex: 1; }
</style>
