<!-- Palette swatches (I4, I9): click sets the paint colour; a key of at most 2 characters is printed on it. -->
<script lang="ts">
  import { swatchKey, type SwatchSpec } from './logic';

  let { swatches, used = false, onpick }: { swatches: readonly SwatchSpec[]; used?: boolean; onpick: (color: string) => void } = $props();
</script>

<div class={['palette', used && 'used']}>
  {#each swatches as s, i (i)}
    {@const k = swatchKey(s.key)}
    <button type="button" class="swatch" title={s.title} aria-label={s.title} data-color={s.color} style:--c={s.color} onclick={() => onpick(s.color)}>
      {#if k}<span class="k" aria-hidden="true">{k}</span>{/if}
    </button>
  {/each}
</div>
