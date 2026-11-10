<!--
  R2 / R3 review note dialog: asset id, where line, the attached crop (draft.image, new), Category,
  Priority, note (focused), compare-with asset (native <input list> + <datalist>), compare view / frame.
  "Add note" or Ctrl+Enter (new) sends op review_add; success -> onclose({ id }); an error keeps the dialog
  open (op() toasts it). Cancel, Esc and a click on the scrim -> onclose(null).
-->
<script lang="ts">
  import { op } from '@/lib/api/client';
  import { assets } from '@/state/assets.svelte';
  import type { DialogSpec } from '@/state/dialogs.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { defaultCategory, defaultPriority, draftWhereLine, imageSrc, PRIORITIES, REVIEW_CATS, reviewAddArgs } from '../inspector/logic';

  let { spec, onclose }: {
    spec: Extract<DialogSpec, { type: 'reviewNote' }>;
    onclose: (result: { id: string } | null) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const draft = spec.draft;
  let category = $state(defaultCategory(draft));
  let priority = $state<string>(defaultPriority(draft));
  let note = $state(draft.note ?? '');
  let compareWith = $state(draft.compare_with ?? '');
  let compareView = $state(draft.compare_view ?? '');
  let compareFrame = $state<number | null>(null);
  let busy = $state(false);
  let done = false;

  const where = draftWhereLine(draft);
  const choices = $derived.by(() => { void assets.rev; return assets.choices(); });
  const uid = $props.id();

  function finish(r: { id: string } | null) {
    if (done) return;
    done = true;
    onclose(r);
  }

  async function submit() {
    if (busy || done) return;
    busy = true;
    try {
      const r = await op('review_add', reviewAddArgs(draft, { category, priority, note, compareWith, compareView, compareFrame }));
      finish({ id: r.id });
    } catch { /* op() showed the error toast; the dialog stays open */ } finally { busy = false; }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  }
</script>

<Dialog open title="Review note" onclose={() => finish(null)} initialFocus="textarea" class="review-note-dlg">
  <form id="{uid}-form" class="rn-form" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <div class="mono small rn-asset">{draft.asset}</div>
    {#if where}<div class="muted small rn-where">{where}</div>{/if}
    {#if draft.image}<img class="rn-crop" src={imageSrc(draft.image)} alt="Attached view of {draft.asset}" />{/if}
    <div class="form-row">
      <label>Category
        <select bind:value={category} {onkeydown}>{#each REVIEW_CATS as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</select>
      </label>
      <label>Priority
        <select bind:value={priority} {onkeydown}>{#each PRIORITIES as p (p)}<option value={p}>{p}</option>{/each}</select>
      </label>
    </div>
    <textarea rows="3" placeholder="What is wrong / what should change?" aria-label="Note" {onkeydown} bind:value={note}></textarea>
    <div class="form-row">
      <input class="rn-cmp" list="{uid}-assets" placeholder="compare with (optional): asset" aria-label="Compare with" autocomplete="off" {onkeydown} bind:value={compareWith} />
      <input class="small-in" placeholder="view" aria-label="Compare view" {onkeydown} bind:value={compareView} />
      <input class="small-in" type="number" min="0" placeholder="frame" aria-label="Compare frame" {onkeydown} bind:value={compareFrame} />
    </div>
    <datalist id="{uid}-assets">{#each choices as a (a)}<option value={a}></option>{/each}</datalist>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => finish(null)}>Cancel</button>
    <button type="submit" form="{uid}-form" class="btn primary" disabled={busy} title="Add note (Ctrl+Enter)">Add note</button>
  {/snippet}
</Dialog>

<style>
  .rn-form { display: flex; flex-direction: column; gap: var(--s-4); }
  .rn-form textarea { width: 100%; resize: vertical; }
  .form-row { display: flex; gap: var(--s-4); align-items: center; flex-wrap: wrap; }
  .form-row label { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--muted); font-size: var(--fs-3); }
  .rn-cmp { flex: 1; min-width: 160px; }
  .small-in { width: 80px; }
  .rn-crop { align-self: flex-start; max-width: 160px; max-height: 160px; image-rendering: pixelated; border: 1px solid var(--line2); border-radius: var(--r-1); }
</style>
