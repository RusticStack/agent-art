<!--
  Bits UI Tooltip: label + optional <kbd> shortcut, 500 ms delay. The trigger snippet gets the props to
  spread on its element (never combine with a native title on the same element).
-->
<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Kbd from './Kbd.svelte';

  let { label, shortcut, disabled = false, trigger }: {
    label: string;
    shortcut?: string;
    disabled?: boolean;
    trigger: Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

<Tooltip.Provider delayDuration={500} {disabled}>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content class="tooltip" sideOffset={6}>
        <span>{label}</span>{#if shortcut}<Kbd keys={shortcut} />{/if}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>
