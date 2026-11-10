<!-- TL8: expanded entry: pretty args JSON (syntax-coloured, RV9) + one line per child op. -->
<script lang="ts">
  import type { ActivityEntry } from '@/lib/api/types';
  import JsonView from '@/components/ui/JsonView.svelte';
  import { fmtMs } from '@/lib/util/format';
  import { keyArgs } from './timeline';

  let { entry, ops }: { entry: ActivityEntry; ops: readonly ActivityEntry[] } = $props();
  const json = $derived(JSON.stringify(entry.args, null, 1) ?? '');
</script>

<div class="tl-details">
  <JsonView text={json} />
  {#each ops as o (o.id)}
    {@const st = o.ok === false ? 'err' : 'ok'}
    <div class="tl-op" data-id={o.id}>
      <span class="tl-status {st}" title={st}></span>
      <span class="mono">{o.type === 'op' ? o.op : o.tool}</span>
      <span class="tl-args">{keyArgs(o.args)}</span>
      <span class="spacer"></span>
      <span class="tl-ms mono">{fmtMs(o.ms)}</span>
      {#if o.error}<div class="tl-error">{o.error}</div>{:else if o.summary}<div class="tl-summary">{o.summary}</div>{/if}
    </div>
  {/each}
</div>

<style>
  .tl-details { margin: 4px 0 0 14px; border-left: 2px solid var(--line2); padding-left: 8px; }
  .tl-details :global(pre.json) { margin: 0 0 4px; font: 11px ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
  .tl-op { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 0; flex-wrap: wrap; }
  .tl-status { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--green); }
  .tl-status.err { background: var(--red); }
  .tl-args { color: var(--muted); font: 11px ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
  .tl-ms { color: var(--muted); flex: none; font-size: 11px; }
  .tl-summary { width: 100%; color: var(--text2); font-size: 12px; padding-left: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-error { width: 100%; color: var(--red-fg); font-size: 12px; padding-left: 14px; white-space: pre-wrap; }
</style>
