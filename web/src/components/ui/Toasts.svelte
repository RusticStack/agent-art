<!--
  Toast stack, bottom centre (O1). The newest MAX_VISIBLE are shown, older ones collapse into a count.
  Hovering or focusing the stack pauses every timer; errors are role=alert and have a dismiss button.
-->
<script lang="ts">
  import { toasts } from '@/state/toasts.svelte';
  // Plain button + Icon (not IconButton): keeps Bits UI's Tooltip out of the initial chunk.
  import Icon from './Icon.svelte';

  let hovered = false;
  let focused = false;
  const sync = () => toasts.hold(hovered || focused);
</script>

<div
  class="toasts-stack"
  role="status"
  aria-live="polite"
  aria-label="Notifications"
  onpointerenter={() => { hovered = true; sync(); }}
  onpointerleave={() => { hovered = false; sync(); }}
  onfocusin={() => { focused = true; sync(); }}
  onfocusout={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) { focused = false; sync(); } }}
>
  {#if toasts.collapsed}<div class="toast-more">+{toasts.collapsed} earlier</div>{/if}
  {#each toasts.visible as t (t.id)}
    <div class={['toast', t.kind, t.leaving && 'out']} role={t.kind === 'error' ? 'alert' : undefined} data-kind={t.kind}>
      <span class="toast-text">{t.text}</span>
      {#if t.kind === 'error'}<button type="button" class="btn icon sm ghost" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}><Icon name="x" size={14} /></button>{/if}
    </div>
  {/each}
</div>

<style>
  .toasts-stack {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: var(--z-toast);
    display: flex; flex-direction: column; align-items: center; gap: var(--s-3); max-width: 80vw;
  }
  .toasts-stack { pointer-events: none; }
  .toast { pointer-events: auto; }
  .toast {
    display: flex; align-items: center; gap: var(--s-4); max-width: 80vw;
    background: var(--panel2); border: 1px solid var(--line2); border-radius: var(--r-4); padding: var(--s-3) var(--s-6);
    box-shadow: var(--shadow-1); transition: opacity var(--t-slow);
  }
  .toast.ok { border-color: var(--green); }
  .toast.error { border-color: var(--red); color: var(--red-fg); padding-right: var(--s-3); }
  .toast.out { opacity: 0; }
  .toast-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .toast-more { font-size: var(--fs-2); color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
</style>
