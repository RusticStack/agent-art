<!--
  .btn wrapper (4.3). `active` makes it a toggle (aria-pressed + .on); `href` renders a link. A title or
  shortcut shows as a tooltip (label + <kbd>).
-->
<script module lang="ts">
  export type ButtonVariant = 'default' | 'primary' | 'ok' | 'warn' | 'danger' | 'ghost';
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '@/lib/util/icons';
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';

  let {
    variant = 'default', size = 'md', active, disabled = false, icon, href, download, title, shortcut,
    type = 'button', label, onclick, children,
  }: {
    variant?: ButtonVariant;
    size?: 'sm' | 'md';
    active?: boolean;
    disabled?: boolean;
    icon?: IconName;
    href?: string;
    download?: string;
    title?: string;
    shortcut?: string;
    type?: 'button' | 'submit';
    /** aria-label, when the visible text is not enough */
    label?: string;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();

  const cls = $derived(['btn', variant !== 'default' && variant, size === 'sm' && 'sm', active && 'on']);
</script>

{#snippet body(extra: Record<string, unknown>)}
  {#if href && !disabled}
    <a {...extra} class={cls} {href} {download} aria-label={label} {onclick}>
      {#if icon}<Icon name={icon} />{/if}{@render children?.()}
    </a>
  {:else}
    <button {...extra} class={cls} {type} {disabled} aria-label={label} aria-pressed={active === undefined ? undefined : active} {onclick}>
      {#if icon}<Icon name={icon} />{/if}{@render children?.()}
    </button>
  {/if}
{/snippet}

{#if title || shortcut}
  <Tooltip label={title ?? label ?? ''} {shortcut} trigger={body} />
{:else}
  {@render body({})}
{/if}
