// Entry: styles, the Svelte shell, the toast bus, boot, and the small debug handle window.agentArt (P4).
import './styles/tokens.css';
import './styles/base.css';
import './styles/viewers.css';
import { mount } from 'svelte';
import { op, type OpMap, type OpName } from '@/lib/api/client';
import type { Target } from '@/viewers/types';
import { activity } from '@/state/activity.svelte';
import { boot } from '@/state/boot.svelte';
import { connection } from '@/state/connection.svelte';
import { layout } from '@/state/layout.svelte';
import * as live from '@/state/live.svelte';
import { connectToastBus } from '@/state/toasts.svelte';
import { workspace } from '@/state/workspace.svelte';
import App from './App.svelte';

connectToastBus();
const app = mount(App, { target: document.getElementById('app')! });

/**
 * Debug / test handle (documented as unstable): open a target, read a state snapshot, run an engine op
 * as the user, and read a slot viewer's debugInfo().
 */
const handle = {
  version: __AGENT_ART_VERSION__,
  open: (target: Target, opts?: { slot?: 'A' | 'B' }) => workspace.open(target, opts),
  state: () => ({
    slots: { A: workspace.slots.A.target, B: workspace.slots.B.target },
    comparing: workspace.comparing,
    compare: { link: workspace.compareLink, overlay: workspace.compareOverlay, status: workspace.compareStatus },
    followMode: workspace.followMode,
    layout: { panes: layout.panes, dock: layout.dock, sizes: layout.sizes, narrow: layout.narrow, drawer: layout.drawer },
    status: connection.status,
    activity: activity.lastId,
  }),
  api: <K extends OpName>(name: K, args: OpMap[K]['args']) => op(name, args),
  debug: { viewer: (slot: 'A' | 'B') => workspace.viewer(slot)?.debugInfo?.() ?? null },
};
(window as unknown as { agentArt: typeof handle }).agentArt = handle;

void boot();

if (import.meta.hot) {
  import.meta.hot.dispose(() => { live.stop(); void app; });
}
