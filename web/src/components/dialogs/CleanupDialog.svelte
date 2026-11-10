<!--
  Cleanup dialog (C4): tabs Trash, Disk usage, Settings. The tab starts at spec.tab and is then local, so
  switching tabs does not replace the dialog spec; dialogs.openCleanup(tab) while open swaps the spec and
  the tab follows it. "Biggest" rows close the dialog and open the asset (C6).
-->
<script lang="ts">
  import Dialog from '../ui/Dialog.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import TrashTab from './TrashTab.svelte';
  import UsageTab from './UsageTab.svelte';
  import SettingsTab from './SettingsTab.svelte';
  import type { CleanupTab, DialogSpec } from '@/state/dialogs.svelte';
  import { workspace } from '@/state/workspace.svelte';

  let { spec, onclose }: { spec: Extract<DialogSpec, { type: 'cleanup' }>; onclose: () => void } = $props();

  const TABS: readonly { id: CleanupTab; label: string }[] = [{ id: 'trash', label: 'Trash' }, { id: 'usage', label: 'Disk usage' }, { id: 'settings', label: 'Settings' }];
  const prefix = 'cleanup';
  // a tab picked here wins until the spec is swapped by dialogs.openCleanup(tab)
  let picked = $state.raw<{ tab: CleanupTab; spec: DialogSpec } | null>(null);
  const tab = $derived(picked && picked.spec === spec ? picked.tab : spec.tab);

  function openAsset(id: string) { onclose(); workspace.openNode(id); }
</script>

<Dialog open title="Cleanup" size="lg" class="cleanup-dialog" {onclose}>
  <div class="cu-body">
    <Tabs tabs={TABS} value={tab} onchange={(id) => (picked = { tab: id as CleanupTab, spec })} label="Cleanup" idPrefix={prefix} />
    <div class="cu-pane" role="tabpanel" aria-labelledby="{prefix}-tab-{tab}" data-tab={tab}>
      {#key tab}
        {#if tab === 'trash'}<TrashTab />
        {:else if tab === 'usage'}<UsageTab onopen={openAsset} />
        {:else}<SettingsTab />{/if}
      {/key}
    </div>
  </div>
</Dialog>
