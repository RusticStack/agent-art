<!--
  Top bar (T1–T13): pane toggles (narrow layout), brand, connection status, workspace path, follow
  button + mode, Search (command palette, Ctrl+K), Compare, Review, Notes (open count), Graph, Cleanup, Help.
-->
<script lang="ts">
  import { assets } from '@/state/assets.svelte';
  import { dialogs } from '@/state/dialogs.svelte';
  import { editor } from '@/state/editor.svelte';
  import { layout } from '@/state/layout.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { FollowMode } from '@/lib/util/storage';
  import { loadPalette } from '../dialogs/loadPalette';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import StatusPill from './StatusPill.svelte';

  const home = $derived(assets.index?.home ?? '');
  const open = $derived(reviews.openCount);

  // Warm-up: start fetching the palette chunk when the pointer enters or focus reaches the search
  // button (IconButton's element belongs to its Tooltip, so the listeners sit on a display:contents wrapper).
  function warm(node: HTMLElement) {
    const go = () => { void loadPalette().catch(() => {}); };
    node.addEventListener('pointerenter', go, { once: true });
    node.addEventListener('focusin', go, { once: true });
    return { destroy() { node.removeEventListener('pointerenter', go); node.removeEventListener('focusin', go); } };
  }
</script>

<header class="topbar">
  <button type="button" class="btn icon pane-toggle" id="toggleBrowser" title="Assets pane ([)" aria-label="Assets pane ([)"
    aria-expanded={layout.shown('browser')} onclick={() => layout.togglePane('browser')}><Icon name="panel-left" /></button>
  <div class="brand"><span class="logo" aria-hidden="true"></span>Agent Art</div>
  <StatusPill />
  <span id="wsPath" class="ws mono" title={home ? `workspace: ${home}` : undefined}>{home}</span>
  <div class="spacer"></div>
  <div class="group">
    <button type="button" class={['btn', workspace.following && 'on']} id="followBtn" aria-pressed={workspace.following}
      title="Follow mode (F): the viewer switches to whatever the agent touches" onclick={() => workspace.toggleFollow()}>
      <Icon name={workspace.following ? 'circle-dot' : 'circle'} />Follow
    </button>
    <select id="followMode" title="What follow mode opens" aria-label="What follow mode opens" value={workspace.followMode}
      onchange={(e) => workspace.setFollowMode((e.currentTarget as HTMLSelectElement).value as FollowMode)}>
      <option value="canvas">asset</option>
      <option value="project">project overview</option>
      <option value="off">off</option>
    </select>
  </div>
  <span class="warm" use:warm><IconButton icon="search" label="Search assets and actions (Ctrl+K)" onclick={() => dialogs.openPalette()} /></span>
  <button type="button" class={['btn', workspace.comparing && 'on']} id="compareBtn" aria-pressed={workspace.comparing}
    title="Compare two assets or states side by side (C)" onclick={() => workspace.setCompare(!workspace.comparing)}><Icon name="columns-2" />Compare</button>
  <button type="button" class={['btn', editor.reviewMode && 'on']} id="reviewBtn" aria-pressed={editor.reviewMode}
    title="Review mode (M): drag a box or click a pin to leave a note for the agent" onclick={() => editor.setReviewMode(!editor.reviewMode)}><Icon name="flag" />Review</button>
  <button type="button" class="btn" id="reviewListBtn" title="All review notes" onclick={() => dialogs.openReviewList()}>
    <Icon name="message-square" />Notes <span id="reviewCount" class="count-badge" hidden={!open}>{open || ''}</span>
  </button>
  <button type="button" class="btn" id="graphBtn" title="Asset graph (Shift+G)" onclick={() => workspace.open({ kind: 'graph' })}><Icon name="waypoints" />Graph</button>
  <button type="button" class="btn" id="cleanupBtn" title="Trash, disk usage and cleanup settings" onclick={() => dialogs.openCleanup()}><Icon name="trash-2" />Cleanup</button>
  <button type="button" class={['btn', 'icon', dialogs.helpOpen && 'on']} id="helpBtn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts (?)"
    onclick={() => dialogs.toggleHelp()}><Icon name="circle-help" /></button>
  <button type="button" class="btn icon pane-toggle" id="toggleSide" title="Inspector / activity pane (])" aria-label="Inspector / activity pane (])"
    aria-expanded={layout.shown('side')} onclick={() => layout.togglePane('side')}><Icon name="panel-right" /></button>
</header>

<style>
  .topbar { height: var(--h-topbar, 42px); flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .brand { font-weight: 700; display: flex; align-items: center; gap: 8px; letter-spacing: .2px; white-space: nowrap; }
  .logo { width: 16px; height: 16px; image-rendering: pixelated; background: conic-gradient(from 90deg, #22c55e 0 25%, #38bdf8 0 50%, #e5484d 0 75%, #f5a524 0); border-radius: 3px; }
  .ws { color: var(--dim); max-width: 26vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
  .pane-toggle { display: none; }
  .warm { display: contents; }
  @media (max-width: 1100px) {
    .ws { display: none; }
  }
  @media (max-width: 860px) {
    .pane-toggle { display: inline-flex; }
    .topbar { overflow-x: auto; }
    .topbar :global(.btn) { padding: 3px 6px; }
    .brand { display: none; }
  }
</style>
