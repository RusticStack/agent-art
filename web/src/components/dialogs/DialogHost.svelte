<!--
  Renders the dialog stack of state/dialogs. Help, confirm and prompt are rendered here from step 13;
  the review dialogs arrive in step 16, cleanup in step 17, the command palette in step 18b (its own
  lazy chunk, loaded the first time a palette spec is on the stack).
-->
<script lang="ts">
  import { toast } from '@/lib/util/notify';
  import { paletteContext, runPaletteAction } from '@/state/actions';
  import { dialogs } from '@/state/dialogs.svelte';
  import { loadPalette } from './loadPalette';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import PromptDialog from '../ui/PromptDialog.svelte';
  import HelpDialog from './HelpDialog.svelte';
  import PlanCleanupDialog from './PlanCleanupDialog.svelte';
  import CleanupDialog from './CleanupDialog.svelte';
  import ReviewNoteDialog from './ReviewNoteDialog.svelte';
  import ReviewListDialog from './ReviewListDialog.svelte';

  type PaletteModule = Awaited<ReturnType<typeof loadPalette>>;
  let Palette: PaletteModule['default'] | null = $state(null);
  let paletteLoading = false;
  const context = $derived(paletteContext());

  $effect(() => {
    if (!dialogs.isOpen('palette') || Palette || paletteLoading) return;
    paletteLoading = true;
    loadPalette().then(
      (m) => { Palette = m.default; paletteLoading = false; },
      (e: unknown) => {
        paletteLoading = false;
        toast(`Could not load the command palette (${e instanceof Error ? e.message : String(e)}). Reload the page.`, 'error');
        for (const d of dialogs.stack) if (d.type === 'palette') dialogs.close(d);
      },
    );
  });
</script>

{#each dialogs.stack as spec (spec)}
  {#if spec.type === 'help'}
    <HelpDialog onclose={() => dialogs.close(spec)} />
  {:else if spec.type === 'confirm'}
    <ConfirmDialog title={spec.title} body={spec.body} confirmLabel={spec.confirmLabel} danger={spec.danger} onresult={(ok) => dialogs.close(spec, ok)} />
  {:else if spec.type === 'prompt'}
    <PromptDialog title={spec.title} label={spec.label} placeholder={spec.placeholder} value={spec.value} confirmLabel={spec.confirmLabel} onresult={(v) => dialogs.close(spec, v)} />
  {:else if spec.type === 'planCleanup'}
    <PlanCleanupDialog {spec} onclose={(done) => dialogs.close(spec, done)} />
  {:else if spec.type === 'cleanup'}
    <CleanupDialog {spec} onclose={() => dialogs.close(spec)} />
  {:else if spec.type === 'reviewNote'}
    <ReviewNoteDialog {spec} onclose={(r) => dialogs.close(spec, r)} />
  {:else if spec.type === 'reviewList'}
    <ReviewListDialog {spec} onclose={() => dialogs.close(spec)} />
  {:else if spec.type === 'palette'}
    {#if Palette}<Palette {spec} onclose={() => dialogs.close(spec)} {context} runAction={runPaletteAction} />{/if}
  {/if}
{/each}
