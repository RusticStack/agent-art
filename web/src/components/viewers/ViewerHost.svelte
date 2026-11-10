<!--
  The only bridge between Svelte and the viewer classes (plan 2.6). Keeps one viewer per slot: the same
  viewer kind is updated in place (zoom, toggles, camera survive, L10), another kind is destroyed and
  the new class loaded (lazy chunk; a generation counter drops a load that a newer target overtook).
  Load errors toast "<name>: <message>" and keep the viewer mounted; a chunk that fails to load shows
  "Could not load this viewer" with a Reload button.
-->
<script module lang="ts">
  /** First slot A viewer drawn after boot: performance.mark('aa:ready') (7.1). */
  let readyMarked = false;
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { toast } from '@/lib/util/notify';
  import { assets } from '@/state/assets.svelte';
  import { editor } from '@/state/editor.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import { loadViewer, viewerKindFor } from '@/viewers/registry';
  import type { SlotId, Target, Viewer, ViewerEnv, ViewerKind, ViewerProps } from '@/viewers/types';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let { slot, target }: { slot: SlotId; target: Target } = $props();

  let el: HTMLElement | undefined = $state();
  let viewer: Viewer | null = null;
  let kind: ViewerKind | null = null;
  let gen = 0;
  let phase = $state<'loading' | 'ready' | 'chunk-error'>('loading');
  let slow = $state(false);
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const env = $derived<ViewerEnv>({
    tool: editor.tool,
    color: editor.color,
    reviewMode: editor.reviewMode,
    following: workspace.following,
    reviewsRev: reviews.rev,
    assetsRev: assets.rev,
    compareLink: workspace.comparing && workspace.compareLink,
    compareOverlay: workspace.comparing && slot === 'A' ? workspace.compareOverlay : 'off',
    peerRev: workspace.peerRev[slot],
  });

  const nameOf = (t: Target): string => ('name' in t && t.name) || t.kind;
  function fail(e: unknown, t: Target): void {
    const msg = e instanceof Error ? e.message : String(e);
    toast(`${nameOf(t)}: ${msg}`, 'error');
  }
  function setLoading(on: boolean): void {
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
    slow = false;
    if (on) slowTimer = setTimeout(() => { slow = true; }, 200);
  }

  async function apply(props: ViewerProps): Promise<void> {
    const k = viewerKindFor(props.target);
    if (k !== kind || !viewer) {
      const my = ++gen;
      viewer?.destroy();
      viewer = null;
      workspace.registerViewer(slot, null);
      kind = k;
      if (!k || !el) return;
      phase = 'loading';
      setLoading(true);
      let Ctor;
      try { Ctor = await loadViewer(k); } catch (e) {
        if (my !== gen) return;
        setLoading(false);
        phase = 'chunk-error';
        kind = null;
        toast(`${nameOf(props.target)}: could not load the viewer (${e instanceof Error ? e.message : String(e)})`, 'error');
        return;
      }
      if (my !== gen || !el) return; // a newer target won while the chunk loaded
      const v = new Ctor(workspace.hostApi(slot));
      viewer = v;
      workspace.registerViewer(slot, v);
      try {
        await v.mount(el, props);
      } catch (e) { if (my === gen) fail(e, props.target); }
      if (my !== gen) return;
      setLoading(false);
      phase = 'ready';
      if (slot === 'A' && !readyMarked && typeof performance !== 'undefined') { readyMarked = true; performance.mark('aa:ready'); }
    } else {
      try { await viewer.update(props); } catch (e) { fail(e, props.target); }
    }
  }

  $effect(() => {
    const props: ViewerProps = { target, env }; // tracked
    if (!el) return;
    untrack(() => { void apply(props); });
  });

  onDestroy(() => {
    gen++;
    setLoading(false);
    viewer?.destroy();
    viewer = null;
    if (workspace.viewer(slot)) workspace.registerViewer(slot, null);
  });
</script>

<div class="viewer-host" bind:this={el}></div>
{#if phase === 'chunk-error'}
  <div class="host-overlay">
    <EmptyState text="Could not load this viewer. Reload the page." icon="circle-alert">
      <button type="button" class="btn" onclick={() => location.reload()}>Reload</button>
    </EmptyState>
  </div>
{:else if phase === 'loading' && slow}
  <div class="host-overlay spin"><Spinner label="Loading viewer" size={20} /></div>
{/if}

<style>
  .viewer-host { flex: 1; min-width: 0; min-height: 0; display: flex; position: relative; }
  .host-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--bg); z-index: 3; }
  .host-overlay.spin { background: transparent; pointer-events: none; }
</style>
