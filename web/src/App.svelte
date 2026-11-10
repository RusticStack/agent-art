<!--
  The shell (plan step 18): top bar, the three-column layout with splitters (L1–L5), the viewers
  (slot A, slot B while comparing), the inspector, the timeline in the right or bottom dock, dialogs and
  toasts; global listeners (keys, hash, narrow layout). The timeline moves between the docks by
  conditional rendering; its state lives in the activity store, so nothing is lost.
-->
<script lang="ts">
  import { onMount, tick, type Component } from 'svelte';
  import { hashToTarget } from '@/lib/util/hash';
  import { idOfTarget } from '@/lib/util/ids';
  import { assets } from '@/state/assets.svelte';
  import { bootState, openInitial } from '@/state/boot.svelte';
  import { dialogs } from '@/state/dialogs.svelte';
  import { editor } from '@/state/editor.svelte';
  import { layout, NARROW_PX, type SizeKey } from '@/state/layout.svelte';
  import { installShortcuts, shellHooks } from '@/state/actions';
  import { workspace } from '@/state/workspace.svelte';
  import AssetBrowser from './components/browser/AssetBrowser.svelte';
  import { reviewPrompt } from './components/inspector/actions';
  import Inspector from './components/inspector/Inspector.svelte';
  import Banner from './components/shell/Banner.svelte';
  import TopBar from './components/shell/TopBar.svelte';
  import Timeline from './components/timeline/Timeline.svelte';
  import Splitter from './components/ui/Splitter.svelte';
  import Toasts from './components/ui/Toasts.svelte';
  import Viewers from './components/viewers/Viewers.svelte';

  let browser: ReturnType<typeof AssetBrowser> | undefined = $state();
  // DialogHost (Bits UI dialogs) is a lazy chunk, loaded when the first dialog opens.
  let DialogHost: Component | null = $state(null);
  let dialogHostLoading = false;

  const SPLIT_LABEL: Record<SizeKey, string> = {
    'browser-w': 'Resize the assets pane', 'side-w': 'Resize the inspector / activity pane',
    'insp-h': 'Resize the inspector', 'bottom-h': 'Resize the activity dock',
  };
  const sizeStyle = (k: SizeKey): string | undefined => (layout.sizes[k] === null ? undefined : `${layout.sizes[k]}px`);

  /** L5: after a layout change the viewers re-fit (they also watch their own size). */
  function relayout(): void { void tick().then(() => window.dispatchEvent(new Event('resize'))); }
  function commit(): void { layout.commitSizes(); relayout(); }

  $effect(() => { document.body.classList.toggle('review-mode', editor.reviewMode); });
  $effect(() => {
    if (!dialogs.stack.length || DialogHost || dialogHostLoading) return;
    dialogHostLoading = true;
    import('./components/dialogs/DialogHost.svelte').then((m) => { DialogHost = m.default; }, () => { dialogHostLoading = false; });
  });
  $effect(() => {
    void layout.panes.browser; void layout.panes.side; void layout.dock; void layout.drawer; void workspace.comparing;
    relayout();
  });
  // narrow drawers (2.6, step 19): when a drawer closes (Esc, scrim, an opened asset) while focus is
  // inside it, focus goes to its top bar toggle instead of being lost with the hidden pane
  $effect(() => {
    const d = layout.drawer;
    if (!d) return;
    return () => {
      const pane = document.getElementById(d === 'browser' ? 'browser' : 'side');
      if (pane?.contains(document.activeElement)) document.getElementById(d === 'browser' ? 'toggleBrowser' : 'toggleSide')?.focus();
    };
  });
  // the server came back after a failed boot (resync refreshed the assets): open the first target now
  $effect(() => {
    if (bootState.phase === 'failed' && assets.index) { bootState.phase = 'ready'; if (!workspace.current) openInitial(); }
  });

  onMount(() => {
    performance.mark('aa:shell');
    shellHooks.focusSearch = () => browser?.focusSearch();
    shellHooks.newCanvas = () => browser?.openNewCanvas();
    const offKeys = installShortcuts();
    // U3: another hash opens its target (without rewriting the hash)
    const onHash = () => {
      const t = hashToTarget(location.hash);
      if (t && idOfTarget(t) !== workspace.currentId) workspace.open(t, { history: false });
    };
    window.addEventListener('hashchange', onHash);
    const mq = matchMedia(`(max-width: ${NARROW_PX}px)`);
    const onMq = () => layout.setNarrow(mq.matches);
    onMq();
    mq.addEventListener('change', onMq);
    const onResize = () => layout.setViewport(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => {
      offKeys();
      window.removeEventListener('hashchange', onHash);
      mq.removeEventListener('change', onMq);
      window.removeEventListener('resize', onResize);
      shellHooks.focusSearch = () => {};
      shellHooks.newCanvas = () => {};
    };
  });
</script>

{#snippet timeline()}
  <div id="timelinePane" class="timeline-pane"><Timeline ontoggleDock={() => layout.toggleDock()} /></div>
{/snippet}

{#snippet splitter(key: SizeKey, orientation: 'vertical' | 'horizontal', sign: 1 | -1)}
  <Splitter {orientation} {sign} sizeKey={key} label={SPLIT_LABEL[key]} min={orientation === 'vertical' ? 140 : 120} value={layout.px(key)}
    onchange={(px) => layout.setSize(key, px)} oncommit={commit} onreset={() => { layout.resetSize(key); relayout(); }} />
{/snippet}

<div class="shell">
  <TopBar />
  <Banner />
  <div
    class={['layout', layout.narrow && 'narrow', !layout.narrow && !layout.panes.browser && 'no-browser', !layout.narrow && !layout.panes.side && 'no-side',
      layout.dock === 'bottom' && 'tl-bottom', layout.drawer && `drawer-${layout.drawer}`]}
    style:--browser-w={sizeStyle('browser-w')} style:--side-w={sizeStyle('side-w')} style:--insp-h={sizeStyle('insp-h')} style:--bottom-h={sizeStyle('bottom-h')}
  >
    <nav id="browser" class="pane browser" aria-label="Assets">
      <AssetBrowser bind:this={browser} narrow={layout.narrow} reviewNote={(d) => { void reviewPrompt(d); }}
        onopen={() => { if (layout.narrow) layout.closeDrawer(); }} />
    </nav>
    <div class="split-col browser-split">{@render splitter('browser-w', 'vertical', 1)}</div>

    <main class="center">
      <Viewers />
      {#if layout.dock === 'bottom'}
        {@render splitter('bottom-h', 'horizontal', -1)}
        <div id="bottomDock" class="bottom-dock">{@render timeline()}</div>
      {/if}
    </main>

    <div class="split-col side-split">{@render splitter('side-w', 'vertical', -1)}</div>
    <div id="side" class="pane side">
      <aside id="inspector" class="inspector" aria-label="Inspector"><Inspector /></aside>
      {#if layout.dock === 'right'}
        {@render splitter('insp-h', 'horizontal', 1)}
        <div id="sideDock" class="side-dock">{@render timeline()}</div>
      {/if}
    </div>
  </div>
  {#if layout.narrow && layout.drawer}
    <!-- the scrim behind a narrow drawer: a click closes it (Esc does too; not a tab stop) -->
    <button type="button" class="drawer-scrim" tabindex="-1" aria-label="Close the {layout.drawer === 'browser' ? 'assets' : 'inspector / activity'} pane"
      onmousedown={(e) => e.preventDefault()} onclick={() => layout.closeDrawer()}></button>
  {/if}
  {#if DialogHost}<DialogHost />{/if}
  <Toasts />
</div>

<style>
  .shell { height: 100%; display: flex; flex-direction: column; }
  .layout { flex: 1; min-height: 0; display: grid; grid-template-columns: var(--browser-w) 4px minmax(0, 1fr) 4px var(--side-w); grid-template-rows: minmax(0, 1fr); }
  .layout.no-browser { grid-template-columns: 0 0 minmax(0, 1fr) 4px var(--side-w); }
  .layout.no-side { grid-template-columns: var(--browser-w) 4px minmax(0, 1fr) 0 0; }
  .layout.no-browser.no-side { grid-template-columns: 0 0 minmax(0, 1fr) 0 0; }
  .layout.no-browser .browser, .layout.no-side .side, .layout.no-browser .browser-split, .layout.no-side .side-split { display: none; }
  /* explicit columns: a hidden pane must not shift the others into its track (L3) */
  .browser { grid-column: 1; } .browser-split { grid-column: 2; } .center { grid-column: 3; } .side-split { grid-column: 4; } .side { grid-column: 5; }
  .browser, .browser-split, .center, .side-split, .side { grid-row: 1; }
  .pane { background: var(--panel); min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .split-col { display: flex; min-height: 0; }
  .split-col :global(.ui-splitter) { flex: 1; }
  .center { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .bottom-dock { display: flex; height: var(--bottom-h); min-height: 120px; background: var(--panel); flex: none; }
  .inspector { height: var(--insp-h); min-height: 120px; overflow: auto; display: flex; flex-direction: column; flex: none; }
  .tl-bottom .inspector { flex: 1; height: auto; }
  .side-dock { flex: 1; min-height: 0; display: flex; }
  .timeline-pane { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }

  /* narrow (N2, 2.6): both panes are drawers under the top bar; one open at a time, never persisted */
  .layout.narrow { grid-template-columns: 0 0 minmax(0, 1fr) 0 0; }
  .layout.narrow .split-col { display: none; }
  .layout.narrow .browser, .layout.narrow .side { position: fixed; top: var(--h-topbar, 42px); bottom: 0; width: min(86vw, 340px); z-index: var(--z-drawer, 20); box-shadow: var(--shadow-drawer); display: none; }
  .layout.narrow .browser { left: 0; } .layout.narrow .side { right: 0; }
  .layout.drawer-browser .browser, .layout.drawer-side .side { display: flex; }
  .drawer-scrim { position: fixed; inset: var(--h-topbar, 42px) 0 0 0; z-index: var(--z-scrim, 19); background: var(--scrim); border: 0; padding: 0; margin: 0; cursor: default; }
</style>
