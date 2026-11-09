<!--
  Styled replacement for window.prompt (Bits UI AlertDialog): one labelled text field, Enter submits.
  Cancel / Esc -> onresult(null); OK -> onresult(text) (may be '').
-->
<script lang="ts">
  import { AlertDialog } from 'bits-ui';

  let { open = true, title, label, placeholder, value = '', confirmLabel = 'OK', onresult }: {
    open?: boolean; title: string; label: string; placeholder?: string; value?: string; confirmLabel?: string;
    onresult: (v: string | null) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(value);
  let input: HTMLInputElement | null = $state(null);
  let done = false;
  const finish = (v: string | null) => { if (done) return; done = true; onresult(v); };
  const id = $props.id();

  function onOpenAutoFocus(e: Event) {
    e.preventDefault();
    const node = input;
    requestAnimationFrame(() => { node?.focus(); node?.select(); });
  }
</script>

<AlertDialog.Root {open} onOpenChange={(o) => { if (!o) finish(null); }}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="dlg-scrim" />
    <AlertDialog.Content class="dlg dlg-md" {onOpenAutoFocus}>
      <div class="dlg-head"><AlertDialog.Title class="dlg-title" level={2}>{title}</AlertDialog.Title></div>
      <form class="dlg-body prompt-form" onsubmit={(e) => { e.preventDefault(); finish(text); }}>
        <label for={id}>{label}</label>
        <input {id} type="text" bind:this={input} bind:value={text} {placeholder} autocomplete="off" />
      </form>
      <div class="dlg-foot">
        <AlertDialog.Cancel class="btn" onclick={() => finish(null)}>Cancel</AlertDialog.Cancel>
        <AlertDialog.Action class="btn primary" onclick={() => finish(text)}>{confirmLabel}</AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<style>
  .prompt-form { display: flex; flex-direction: column; gap: var(--s-2); }
  .prompt-form label { color: var(--muted); font-size: var(--fs-3); }
  .prompt-form input { width: 100%; height: var(--h-control); }
</style>
