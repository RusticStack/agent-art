<!--
  Cleanup › Trash (C5): tiles, age select, "Empty…" (styled danger confirm instead of window.confirm), one
  card per batch with Restore all, the summary line and a collapsible asset list (kept in the DOM, hidden)
  with per-asset Restore and the file list in the title. Reloads after each action.
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import Select from '../ui/Select.svelte';
  import ErrorNote from '../ui/ErrorNote.svelte';
  import Icon from '../ui/Icon.svelte';
  import CleanupTiles from './CleanupTiles.svelte';
  import KindIcon from './KindIcon.svelte';
  import { op } from '@/lib/api/client';
  import type { TrashList } from '@/lib/api/types';
  import { fmtBytes } from '@/lib/util/format';
  import { dialogs } from '@/state/dialogs.svelte';
  import { toasts } from '@/state/toasts.svelte';
  import { AGE_OPTIONS, batchSummary, emptyWhat, restoreToast, type TrashAge } from './cleanup';

  let t = $state.raw<TrashList | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let age = $state<TrashAge>('');
  let open = $state<Record<string, boolean>>({});

  async function load() {
    loading = true;
    error = null;
    try { t = await op('cleanup_trash', { full: true }); } catch (e) { error = (e as Error).message; } finally { loading = false; }
  }

  async function empty() {
    if (!t) return;
    const ok = await dialogs.confirm({ title: `Permanently delete ${emptyWhat(t, age)}?`, body: 'This cannot be undone.', confirmLabel: 'Delete permanently', danger: true });
    if (!ok) return;
    busy = true;
    const r = await op('cleanup_empty', { confirm: true, ...(age ? { older_than: age } : {}) }).catch(() => null);
    if (r) toasts.push(`emptied ${r.emptied} batch(es), ${r.size} freed`, 'ok');
    busy = false;
    await load();
  }

  async function restore(id: string) {
    busy = true;
    const r = await op('cleanup_restore', { ids: [id] }).catch(() => null);
    if (r) { const m = restoreToast(r); toasts.push(m.text, m.kind); }
    busy = false;
    await load();
  }

  void load();
</script>

{#if loading && !t && !error}
  <div class="muted">loading…</div>
{:else if error}
  <ErrorNote text={error} onretry={load} />
{:else if t}
  <CleanupTiles tiles={[{ label: 'batches', value: String(t.batches) }, { label: 'in the trash', value: t.size }]}>
    <div class="spacer"></div>
    <div class="group">
      <Select bind:value={age} options={AGE_OPTIONS} label="Empty which batches" />
      <Button variant="warn" disabled={!t.batches || busy} onclick={empty}>Empty…</Button>
    </div>
  </CleanupTiles>
  {#if !t.batches}
    <div class="empty-note">The trash is empty. Removed assets (art_cleanup apply, and single deletes) land here and can be restored.</div>
  {:else}
    <ul class="cu-batches" aria-busy={loading}>
      {#each t.trash as b (b.id)}
        <li class="cu-batch" data-batch={b.id}>
          <div class="cu-batch-head">
            <button type="button" class="cu-twisty" aria-expanded={!!open[b.id]} aria-label="Assets of {b.id}" onclick={() => (open[b.id] = !open[b.id])}><Icon name="chevron-right" size={14} /></button>
            <span class="mono">{b.id}</span>
            <Badge>{b.via}</Badge>
            {#if b.plan}<span class="muted small mono">plan {b.plan}</span>{/if}
            <span class="muted small">{b.age} ago · {new Date(b.ts).toLocaleString()}</span>
            <div class="spacer"></div>
            <span class="mono">{b.items} · {b.size}</span>
            <Button size="sm" variant="ok" disabled={busy} onclick={() => restore(b.id)}>Restore all</Button>
          </div>
          <div class="small muted cu-batch-sum">{batchSummary(b)}</div>
          <ul class="cu-items" hidden={!open[b.id]}>
            {#each b.assets as x (x.id)}
              <li class="cu-item">
                <KindIcon id={x.id} /><span class="mono grow" title={x.files.join('\n')}>{x.id}</span>
                <span class="mono muted">{fmtBytes(x.bytes)}</span>
                <Button size="sm" disabled={busy} title="Restore only this asset" onclick={() => restore(x.id)}>Restore</Button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
