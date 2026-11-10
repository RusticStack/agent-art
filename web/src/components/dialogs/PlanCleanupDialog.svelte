<!--
  "Plan cleanup · N selected" (C1-C3): dry run of art_cleanup for a browser selection, re-run on every
  option change, then Apply. onclose(true) only after a successful apply (the dialogs.planCleanup promise).
  Initial focus: Cancel (4.4). Stale dry runs are dropped; Apply waits for the current one (new).
-->
<script lang="ts">
  import Dialog from '../ui/Dialog.svelte';
  import Button from '../ui/Button.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Badge from '../ui/Badge.svelte';
  import ErrorNote from '../ui/ErrorNote.svelte';
  import CleanupTiles from './CleanupTiles.svelte';
  import KindIcon from './KindIcon.svelte';
  import { op } from '@/lib/api/client';
  import type { CleanupPlan } from '@/lib/api/types';
  import type { DialogSpec } from '@/state/dialogs.svelte';
  import { toasts } from '@/state/toasts.svelte';
  import { applyToast, planView } from './cleanup';

  let { spec, onclose }: { spec: Extract<DialogSpec, { type: 'planCleanup' }>; onclose: (done: boolean) => void } = $props();

  let includeExports = $state(true);
  let includeDependents = $state(false);
  let allowApproved = $state(false);
  let plan = $state.raw<CleanupPlan | null>(null);
  let planning = $state(true);
  let error = $state<string | null>(null);
  let applying = $state(false);
  let seq = 0;

  const view = $derived(plan ? planView(plan) : null);

  async function run() {
    const my = ++seq;
    planning = true;
    error = null;
    try {
      const p = await op('cleanup_plan', { select: { ids: spec.ids }, include_exports: includeExports, include_dependents: includeDependents, allow_approved: allowApproved, full: true });
      if (my !== seq) return;
      plan = p;
    } catch (e) {
      if (my !== seq) return;
      plan = null;
      error = (e as Error).message;
    } finally {
      if (my === seq) planning = false;
    }
  }

  async function apply() {
    if (!plan || applying) return;
    applying = true;
    try {
      const r = await op('cleanup_apply', { plan_id: plan.plan_id, confirm: true });
      toasts.push(applyToast(r), 'ok');
      onclose(true);
    } catch {
      applying = false;
    }
  }

  void run();
</script>

<Dialog open title="Plan cleanup · {spec.ids.length} selected" size="lg" class="plan-cleanup-dialog" initialFocus=".dlg-foot .btn" onclose={() => onclose(false)}>
  <div class="cu-body">
    <div class="cu-opts">
      <Toggle bind:checked={includeExports} label="Exported files" title="Also move the files these assets exported (only inside workspace/exports or an allowed folder)" onchange={run} />
      <Toggle bind:checked={includeDependents} label="Dependents too" title="Also remove the kept assets that need these (a model using a texture, canvases of a project)" onchange={run} />
      <Toggle bind:checked={allowApproved} label="Allow approved" title="Approved assets are protected unless this is on" onchange={run} />
    </div>
    <div class="cu-plan" aria-busy={planning}>
      {#if planning}
        <div class="muted">planning…</div>
      {:else if error}
        <ErrorNote text={error} onretry={run} />
      {:else if view}
        <CleanupTiles tiles={view.tiles} />
        {#if view.blocked.length}
          <section class="cu-section" aria-label="Blocked">
            <h4 class="bad">Blocked ({view.blocked.length})</h4>
            {#each view.blocked as b (b.id)}
              <div class="cu-line bad"><KindIcon id={b.id} /><span class="mono">{b.id}</span><span class="muted">{b.why}</span></div>
            {/each}
            {#if view.next}<div class="muted small">{view.next}</div>{/if}
          </section>
        {/if}
        {#if view.warnings.length}
          <section class="cu-section" aria-label="Warnings">
            <h4 class="warn">Warnings ({view.warnings.length})</h4>
            {#each view.warnings as w, i (i)}<div class="cu-line warn small">{w}</div>{/each}
          </section>
        {/if}
        {#if view.refused.length}
          <section class="cu-section" aria-label="Export files kept">
            <h4 class="warn">Export files kept (path rules)</h4>
            {#each view.refused as f, i (i)}<div class="cu-line small mono">{f}</div>{/each}
          </section>
        {/if}
        <section class="cu-section" aria-label="Will move to the trash">
          <h4>Will move to the trash</h4>
          <ul class="cu-items">
            {#each view.items as it (it.id)}
              <li class="cu-item" data-id={it.id}>
                <KindIcon id={it.id} /><span class="mono grow">{it.id}</span>
                {#if it.reason}<Badge>{it.reason}</Badge>{/if}
                <span class="mono muted">{it.size}</span>
              </li>
            {/each}
          </ul>
        </section>
        {#if view.unknown}<div class="muted small">{view.unknown}</div>{/if}
      {/if}
    </div>
  </div>
  {#snippet footer()}
    <div class="cu-foot plan-foot">
      <span class="muted small">Soft delete: files, graph links, review notes and pins go to the trash and can be restored.</span>
      <div class="spacer"></div>
      <Button onclick={() => onclose(false)}>Cancel</Button>
      <Button variant="primary" disabled={!view || view.applyDisabled || planning || applying} onclick={apply}>{view ? view.applyLabel : 'Move to trash'}</Button>
    </div>
  {/snippet}
</Dialog>

<style>
  .cu-plan { display: flex; flex-direction: column; gap: var(--s-5); }
  .plan-foot { width: 100%; }
</style>
