<!--
  Modal dialog over Bits UI Dialog: scrim, focus trap, labelled by its title, Esc and a click on the scrim
  close it (onclose), focus returns to the opener. `initialFocus` is a selector inside the dialog.
  `closeOnEscape={false}` leaves Esc to the caller (Help: the legacy Esc chain decides, K5).
-->
<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  // A plain close button (no Tooltip): keeps floating-ui out of the dialog chunk; Esc and the label suffice.
  import Icon from './Icon.svelte';

  let { open, title, size = 'md', onclose, initialFocus, closeOnEscape = true, class: cls = '', children, footer }: {
    open: boolean;
    title: string;
    size?: 'md' | 'lg';
    onclose: () => void;
    initialFocus?: string;
    closeOnEscape?: boolean;
    class?: string;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  let content: HTMLElement | null = $state(null);

  function onOpenAutoFocus(e: Event) {
    if (!initialFocus) return;
    e.preventDefault();
    const node = content;
    requestAnimationFrame(() => { (node?.querySelector<HTMLElement>(initialFocus) ?? node)?.focus(); });
  }
</script>

<Dialog.Root {open} onOpenChange={(o) => { if (!o) onclose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="dlg-scrim" />
    <Dialog.Content
      bind:ref={content}
      class="dlg dlg-{size} {cls}"
      escapeKeydownBehavior={closeOnEscape ? 'close' : 'ignore'}
      {onOpenAutoFocus}
    >
      <div class="dlg-head">
        <Dialog.Title class="dlg-title" level={2}>{title}</Dialog.Title>
        <div class="spacer"></div>
        <button type="button" class="btn icon sm ghost" aria-label="Close" onclick={onclose}><Icon name="x" size={14} /></button>
      </div>
      <div class="dlg-body">{@render children()}</div>
      {#if footer}<div class="dlg-foot">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.dlg-scrim) { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-dialog); }
  :global(.dlg) {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: var(--z-dialog);
    display: flex; flex-direction: column; gap: var(--s-4); max-height: 88vh;
    background: var(--panel); border: 1px solid var(--line2); border-radius: var(--r-5); box-shadow: var(--shadow-2);
    padding: var(--s-7); width: min(520px, 94vw);
  }
  :global(.dlg.dlg-lg) { width: min(900px, 96vw); }
  :global(.dlg[data-state='open']) { animation: dlg-in 120ms var(--ease); }
  :global(.dlg-head) { display: flex; align-items: center; gap: var(--s-4); }
  :global(.dlg-title) { margin: 0; font-size: var(--fs-5); font-weight: 600; }
  :global(.dlg-body) { min-height: 0; overflow: auto; }
  :global(.dlg-foot) { display: flex; justify-content: flex-end; gap: var(--s-4); }
  @keyframes -global-dlg-in { from { opacity: 0; transform: translate(-50%, calc(-50% + 4px)); } }
  @media (prefers-reduced-motion: reduce) { :global(.dlg[data-state='open']) { animation: none; } }
  @media (max-width: 860px) { :global(.dlg), :global(.dlg.dlg-lg) { width: 94vw; max-height: 92vh; } }
</style>
