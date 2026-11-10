<!--
  Inspector (I1..I14): what workspace.inspected shows, its review notes and its relations. Data comes from
  a keyed Resource on (inspected id, snap, inspectorTick): abortable, last-wins, and the previous content
  stays (dimmed, aria-busy) until the next arrives; a spinner after 150 ms (2.7). Mounted into #inspector.
  The callbacks default to the stores; the legacy App passes its own while it still owns the DOM.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { op } from '@/lib/api/client';
  import { KIND_ICON_NAME } from '@/lib/util/kinds';
  import { assets } from '@/state/assets.svelte';
  import { editor } from '@/state/editor.svelte';
  import { signals } from '@/state/live.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import { uiState } from '@/state/uiState.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { ReviewDraft, Target } from '@/viewers/types';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import KV from '../ui/KV.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import CanvasInspector from './CanvasInspector.svelte';
  import ModelInspector from './ModelInspector.svelte';
  import ProjectInspector from './ProjectInspector.svelte';
  import Relations from './Relations.svelte';
  import ReviewSection from './ReviewSection.svelte';
  import RigInspector from './RigInspector.svelte';
  import Section from './Section.svelte';
  import { openTarget, reviewPrompt } from './actions';
  import { inspectKey, loadInspector, type InspectorData } from './load';
  import { audioRows, exportRows, snapshotRows } from './logic';
  import { Resource } from './resource.svelte';

  let {
    onsetcolor = (hex: string) => editor.setColor(hex),
    ontogglepinned = (id: string) => { void uiState.togglePinned(id); },
    ontogglehidden = (id: string) => { void uiState.toggleHidden(id); },
    onnote = (d: ReviewDraft) => { void reviewPrompt(d); },
    onopen = openTarget,
    onopennode = (id: string) => workspace.openNode(id),
  }: {
    onsetcolor?: (hex: string) => void;
    ontogglepinned?: (id: string) => void;
    ontogglehidden?: (id: string) => void;
    onnote?: (draft: ReviewDraft) => void;
    onopen?: (t: Target) => void;
    onopennode?: (id: string) => void;
  } = $props();

  const res = new Resource<InspectorData>(150);
  const target = $derived(workspace.inspected);
  const key = $derived(inspectKey(target, signals.inspectorTick));
  const currentId = $derived(target && target.kind !== 'graph' ? `${target.kind}:${target.name}` : null);

  $effect(() => {
    const k = key, t = target;
    untrack(() => res.load(k, (signal) => loadInspector(t as Target, signal)));
  });
  onDestroy(() => res.dispose());

  const d = $derived(key === null ? null : res.data);
  /** The previous asset's content while the next one loads (not for a refresh of the same asset). */
  const stale = $derived(!!d && res.loading && d.id !== currentId);
  const snapLabel = (t: Target): string | null => ('snap' in t && t.snap ? `snapshot ${('label' in t && t.label) || t.snap}` : null);
  const exportFile = (path: string) => assets.index?.exports.find((x) => x.path === path);

  function approve(id: string) {
    op('review_approve', { asset: id, approved: !reviews.approved.has(id) }).catch(() => {});
  }
</script>

<div class="pane-head">
  <h2>Inspector</h2>
  <div class="spacer"></div>
  {#if res.slow}<Spinner label="Loading the inspector" />{/if}
</div>
<div class={['insp-body', stale && 'stale']} aria-busy={res.loading}>
  {#if !target || target.kind === 'graph'}
    <div class="muted pad">{target?.kind === 'graph' ? 'Select a node in the graph to see its relations.' : 'Nothing open.'}</div>
  {:else if d}
    {@const id = d.id}
    {@const snap = snapLabel(d.target)}
    {@const pinned = uiState.isPinned(id)}
    {@const hidden = uiState.isHidden(id)}
    {@const approved = reviews.approved.has(id)}
    <div class="insp-title">
      <span class="kicon">{#if KIND_ICON_NAME[d.kind]}<Icon name={KIND_ICON_NAME[d.kind]} />{:else}•{/if}</span>
      <span class="name">{d.name}</span>
      {#if snap}<Badge tone="state">{snap}</Badge>{/if}
    </div>
    <div class="insp-actions">
      <button type="button" class={['btn', 'small', pinned && 'on']} aria-pressed={pinned} onclick={() => ontogglepinned(id)}><Icon name="star" />{pinned ? 'Pinned' : 'Pin'}</button>
      <button type="button" class="btn small" aria-pressed={!hidden} onclick={() => ontogglehidden(id)}><Icon name={hidden ? 'eye-off' : 'eye'} />{hidden ? 'Hidden' : 'Visible'}</button>
      <button type="button" class={['btn', 'small', approved && 'ok']} aria-pressed={approved} title="Approve this asset (the agent is warned before changing it)" onclick={() => approve(id)}>
        {#if approved}<Icon name="check" />Approved{:else}Approve{/if}
      </button>
      <button type="button" class="btn small" title="Add a review note to this asset (M = review mode: mark a region in the viewer)" onclick={() => onnote({ asset: id })}><Icon name="flag" />Note</button>
    </div>

    {#if d.data.kind === 'canvas'}
      <CanvasInspector info={d.data.info} project={d.data.project} {onsetcolor} {onopen} />
    {:else if d.data.kind === 'snapshot'}
      <Section title="Snapshot">
        <KV rows={snapshotRows(d.name, d.data.meta)} />
        <button type="button" class="btn small" onclick={() => onopen({ kind: 'canvas', name: d.name })}>Open live</button>
      </Section>
    {:else if d.data.kind === 'model'}
      <ModelInspector info={d.data.info} />
    {:else if d.data.kind === 'rig'}
      <RigInspector name={d.name} info={d.data.info} {onopen} />
    {:else if d.data.kind === 'audio'}
      <Section title="Audio"><KV rows={audioRows(d.data.info)} /></Section>
    {:else if d.data.kind === 'project'}
      <ProjectInspector info={d.data.info} {onsetcolor} />
    {:else if d.kind === 'export'}
      <Section title="File"><KV rows={exportRows(d.name, exportFile(d.name))} /></Section>
    {/if}
    {#if d.error}<div class="error" role="alert">{d.error}</div>{/if}

    <ReviewSection {id} />
    <Relations {id} node={d.node} {onopennode} {onopen} />
  {:else if res.error}
    <div class="error" role="alert">{res.error}</div>
  {/if}
</div>
