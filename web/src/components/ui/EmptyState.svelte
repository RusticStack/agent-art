<!-- Centred empty / unavailable state with optional icon, title and actions. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '@/lib/util/icons';
  import Icon from './Icon.svelte';

  let { title, text, icon, children }: { title?: string; text: string; icon?: IconName; children?: Snippet } = $props();
</script>

<div class="empty-state">
  {#if icon}<Icon name={icon} size={24} />{/if}
  {#if title}<h2>{title}</h2>{/if}
  <p class="muted">{text}</p>
  {#if children}<div class="empty-actions">{@render children()}</div>{/if}
</div>

<style>
  .empty-state { margin: auto; max-width: 460px; padding: var(--s-8); display: flex; flex-direction: column; align-items: center; gap: var(--s-4); text-align: center; }
  h2 { margin: 0; font-size: var(--fs-6); }
  p { margin: 0; }
  .empty-actions { display: flex; gap: var(--s-4); }
</style>
