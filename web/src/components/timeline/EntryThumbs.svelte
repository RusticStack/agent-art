<!--
  TL7: up to 3 snapshot thumbnails of an entry (before → after pair or one image). Each pair is a
  button; the box has a fixed height so a late (or expired, hidden) image never changes the row height.
-->
<script lang="ts">
  import { snapshotPng } from '@/lib/api/urls';
  import type { Thumb, Hit } from './timeline';

  let { thumbs, onopen }: { thumbs: Thumb[]; onopen: (hit: Hit) => void } = $props();
  let gone = $state<Record<string, true>>({});

  function click(ev: MouseEvent, t: Thumb): void {
    ev.stopPropagation();
    const img = ev.target instanceof Element ? ev.target.closest('img') : null;
    const i = img?.dataset.i;
    onopen({ pairName: t.asset.name, imageIndex: i === '0' ? 0 : i === '1' ? 1 : undefined });
  }
</script>

<div class="tl-thumbs">
  {#each thumbs as t (t.asset.kind + ':' + t.asset.name)}
    <button type="button" class="tl-pair" title={t.title} aria-label={t.title}
      data-kind={t.asset.kind} data-name={t.asset.name} data-snap={t.asset.after || t.asset.before || ''}
      onclick={(ev) => click(ev, t)}>
      {#each t.images as id, i (i)}
        {#if i === 1}<span class="arrow" aria-hidden="true">→</span>{/if}
        <img src={snapshotPng(id)} loading="lazy" alt="" data-i={i} class:gone={gone[id]} onerror={() => { gone = { ...gone, [id]: true }; }} />
      {/each}
      <span class="tl-asset">{t.asset.name}</span>
    </button>
  {/each}
</div>

<style>
  /* fixed height: one line of pairs, never wraps (TL7 + step 14: images loading late keep the row height) */
  .tl-thumbs { display: flex; gap: 8px; padding: 4px 0 0 14px; height: 48px; box-sizing: border-box; flex-wrap: nowrap; overflow: hidden; }
  .tl-pair { display: inline-flex; align-items: center; gap: 3px; flex: none; height: 44px; box-sizing: border-box; background: var(--bg2); border: 1px solid var(--line); border-radius: 5px; padding: 2px 4px; color: inherit; font: inherit; cursor: pointer; }
  .tl-pair:hover { border-color: var(--line2); }
  .tl-pair img { height: 36px; width: auto; max-width: 72px; object-fit: contain; image-rendering: pixelated; background: repeating-conic-gradient(#2c2f35 0 25%, #3a3d44 0 50%) 0 0 / 6px 6px; border-radius: 2px; }
  .tl-pair img.gone { display: none; }
  .arrow { color: var(--dim); font-size: 11px; }
  .tl-asset { font-size: 10px; color: var(--muted); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
