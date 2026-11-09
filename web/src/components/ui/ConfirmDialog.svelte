<!--
  Styled replacement for window.confirm (Bits UI AlertDialog). Destructive confirms use .danger and focus
  Cancel first; others focus the confirm button. Esc / Cancel -> onresult(false).
-->
<script lang="ts">
  import { AlertDialog } from 'bits-ui';

  let { open = true, title, body, confirmLabel, danger = false, onresult }: {
    open?: boolean; title: string; body?: string; confirmLabel: string; danger?: boolean; onresult: (ok: boolean) => void;
  } = $props();

  let content: HTMLElement | null = $state(null);
  let done = false;
  const finish = (ok: boolean) => { if (done) return; done = true; onresult(ok); };

  function onOpenAutoFocus(e: Event) {
    e.preventDefault();
    const node = content;
    requestAnimationFrame(() => node?.querySelector<HTMLElement>(danger ? '[data-dlg-cancel]' : '[data-dlg-confirm]')?.focus());
  }
</script>

<AlertDialog.Root {open} onOpenChange={(o) => { if (!o) finish(false); }}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="dlg-scrim" />
    <AlertDialog.Content bind:ref={content} class="dlg dlg-md" {onOpenAutoFocus}>
      <div class="dlg-head"><AlertDialog.Title class="dlg-title" level={2}>{title}</AlertDialog.Title></div>
      {#if body}<AlertDialog.Description class="dlg-body">{body}</AlertDialog.Description>{/if}
      <div class="dlg-foot">
        <AlertDialog.Cancel class="btn" data-dlg-cancel="" onclick={() => finish(false)}>Cancel</AlertDialog.Cancel>
        <AlertDialog.Action class="btn {danger ? 'danger' : 'primary'}" data-dlg-confirm="" onclick={() => finish(true)}>{confirmLabel}</AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
