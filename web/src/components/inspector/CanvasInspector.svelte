<!--
  I4 live canvas: Preview, Canvas table, Layers (top first; name = select, eye = visibility, blend select),
  Palette + Used colours, Animations, Meta (JsonView, anchors / rig summarised, 4000 chars), Project block.
  Layer changes use the same ops as the agent (O3), so they show up as user entries in the timeline.
-->
<script lang="ts">
  import { op } from '@/lib/api/client';
  import type { CanvasInfo, ProjectInfo } from '@/lib/api/types';
  import type { Target } from '@/viewers/types';
  import Chip from '../ui/Chip.svelte';
  import Icon from '../ui/Icon.svelte';
  import JsonView from '../ui/JsonView.svelte';
  import KV from '../ui/KV.svelte';
  import PreviewCanvas from './PreviewCanvas.svelte';
  import Section from './Section.svelte';
  import Swatches from './Swatches.svelte';
  import { animChips, BLENDS, canvasRows, metaSummary, paletteSwatches, usedSwatches } from './logic';

  let { info, project = null, onsetcolor, onopen }: {
    info: CanvasInfo;
    project?: ProjectInfo | null;
    onsetcolor: (hex: string) => void;
    onopen: (t: Target) => void;
  } = $props();

  const name = $derived(info.name);
  const layers = $derived([...info.layers].reverse());
  const chips = $derived(animChips(info));
  const meta = $derived(metaSummary(info.meta));

  const layerOp = (action: 'select' | 'visibility' | 'blend', layer: number, blend?: string) =>
    op('layer', { canvas: name, action, layer, ...(blend ? { blend } : {}) }).catch(() => {});
</script>

<Section title="Preview"><PreviewCanvas {info} /></Section>

<Section title="Canvas"><KV rows={canvasRows(info)} /></Section>

<Section title="Layers">
  <ul class="layers">
    {#each layers as l (l.index)}
      {@const active = l.index === info.activeLayer}
      <li class={[active && 'active', !l.visible && 'hidden']} data-layer={l.index}>
        <button type="button" class="eye" title="Toggle visibility" aria-label="Toggle visibility of {l.name}" aria-pressed={l.visible}
          onclick={() => layerOp('visibility', l.index)}><Icon name={l.visible ? 'eye' : 'eye-off'} size={14} /></button>
        <button type="button" class="lname" aria-pressed={active} title="Select layer {l.name}" onclick={() => layerOp('select', l.index)}>
          {l.name}{l.opacity < 1 ? ` (${Math.round(l.opacity * 100)}%)` : ''}
        </button>
        <select class="lblend" title="Blend mode" aria-label="Blend mode of {l.name}"
          onchange={(e) => layerOp('blend', l.index, e.currentTarget.value)}>
          {#each BLENDS as m (m)}<option value={m} selected={m === (l.blend || 'normal')}>{m}</option>{/each}
        </select>
      </li>
    {/each}
  </ul>
  <button type="button" class="btn small" onclick={() => onopen({ kind: 'canvas', name, view: 'layers' })}><Icon name="layers" />Layer stack / debug</button>
</Section>

<Section title="Palette">
  <Swatches swatches={paletteSwatches(info)} onpick={onsetcolor} />
  <div class="muted small">Used colours</div>
  <Swatches swatches={usedSwatches(info)} used onpick={onsetcolor} />
</Section>

{#if chips.length}
  <Section title="Animations">
    <div class="tag-list">
      {#each chips as c (c.tag)}
        <Chip title={c.title} onclick={() => onopen({ kind: 'canvas', name, view: 'anim', tag: c.tag })}>{c.label}</Chip>
      {/each}
    </div>
  </Section>
{/if}

{#if meta}
  <Section title="Meta"><div class="meta-json"><JsonView text={meta} /></div></Section>
{/if}

{#if project}
  <Section title="Project {project.name}">
    <div class="notes">{[project.description, project.notes].filter(Boolean).join('\n\n') || 'No notes yet.'}</div>
    <button type="button" class="btn small" onclick={() => onopen({ kind: 'project', name: project.name })}><Icon name="folder-kanban" />Overview (O)</button>
  </Section>
{/if}
