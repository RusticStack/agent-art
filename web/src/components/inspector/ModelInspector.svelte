<!-- I6 model: table, Rig (nodes, sockets, poses, clips), Warnings, Notes. -->
<script lang="ts">
  import type { ModelInfo } from '@/lib/api/types';
  import KV from '../ui/KV.svelte';
  import Section from './Section.svelte';
  import { modelRigRows, modelRows } from './logic';

  let { info }: { info: ModelInfo } = $props();
</script>

<Section title="Model"><KV rows={modelRows(info)} /></Section>
{#if info.rig}<Section title="Rig"><KV rows={modelRigRows(info.rig)} /></Section>{/if}
{#if info.warnings?.length}
  <Section title="Warnings">{#each info.warnings as w, i (i)}<div class="warn-line">{w}</div>{/each}</Section>
{/if}
{#if info.notes}<Section title="Notes"><div class="notes">{info.notes}</div></Section>{/if}
