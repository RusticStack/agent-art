<!-- Square icon button (.btn.icon): aria-label + tooltip from `label`, optional toggle state. -->
<script lang="ts">
  import type { IconName } from '@/lib/util/icons';
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';

  let { icon, label, shortcut, active, size = 'md', variant = 'default', disabled = false, tooltip = true, onclick }: {
    icon: IconName;
    label: string;
    shortcut?: string;
    active?: boolean;
    size?: 'sm' | 'md';
    variant?: 'default' | 'ghost' | 'danger';
    disabled?: boolean;
    /** false: aria-label only (e.g. inside a toast, where a tooltip would cover the text) */
    tooltip?: boolean;
    onclick?: (e: MouseEvent) => void;
  } = $props();

  const cls = $derived(['btn', 'icon', variant !== 'default' && variant, size === 'sm' && 'sm', active && 'on']);
</script>

{#snippet body(extra: Record<string, unknown>)}
  <button {...extra} type="button" class={cls} aria-label={label} aria-pressed={active === undefined ? undefined : active} {disabled} {onclick}>
    <Icon name={icon} size={size === 'sm' ? 14 : 16} />
  </button>
{/snippet}

{#if tooltip}
  <Tooltip {label} {shortcut} trigger={body} />
{:else}
  {@render body({})}
{/if}
