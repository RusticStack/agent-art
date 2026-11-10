<!-- I7 rig: table, Parts chips `name ← parent · zN`, Poses (open pose mode) and presets (dim), Layer stack. -->
<script lang="ts">
  import type { RigInfo } from '@/lib/api/types';
  import type { Target } from '@/viewers/types';
  import Chip from '../ui/Chip.svelte';
  import Icon from '../ui/Icon.svelte';
  import KV from '../ui/KV.svelte';
  import Section from './Section.svelte';
  import { rigPartChips, rigRows } from './logic';

  let { name, info, onopen }: { name: string; info: RigInfo; onopen: (t: Target) => void } = $props();
</script>

<Section title="Rig"><KV rows={rigRows(info)} /></Section>
<Section title="Parts (parent · z)">
  <div class="tag-list">{#each rigPartChips(info) as c, i (i)}<Chip>{c}</Chip>{/each}</div>
</Section>
<Section title="Poses / presets">
  <div class="tag-list">
    {#each Object.keys(info.poses || {}) as p (p)}<Chip onclick={() => onopen({ kind: 'rig', name, mode: 'pose' })}>{p}</Chip>{/each}
    {#each Object.keys(info.presets || {}) as p (p)}<Chip dim>{p}</Chip>{/each}
  </div>
</Section>
<button type="button" class="btn small" onclick={() => onopen({ kind: 'rig', name, view: 'layers' })}><Icon name="layers" />Layer stack / debug</button>
