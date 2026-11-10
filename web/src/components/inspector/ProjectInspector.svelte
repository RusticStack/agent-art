<!-- I9 project: table, Notes, Palette (click sets the paint colour). -->
<script lang="ts">
  import type { ProjectInfo } from '@/lib/api/types';
  import KV from '../ui/KV.svelte';
  import Section from './Section.svelte';
  import Swatches from './Swatches.svelte';
  import { paletteSwatches, projectRows } from './logic';

  let { info, onsetcolor }: { info: ProjectInfo; onsetcolor: (hex: string) => void } = $props();
</script>

<Section title="Project"><KV rows={projectRows(info)} /></Section>
<Section title="Notes"><div class="notes">{info.notes || 'No notes yet.'}</div></Section>
<Section title="Palette"><Swatches swatches={paletteSwatches({ palette: info.palette })} onpick={onsetcolor} /></Section>
