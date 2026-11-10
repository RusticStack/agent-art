// Tiny shared signals (plan 2.5): browser rows that should flash (the agent changed them) and the
// inspector refetch counter. Their own module so the workspace (viewer host API) can bump the inspector
// without importing live.svelte.ts (which imports the workspace).
class Signals {
  flash = $state.raw<{ id: string; n: number }>({ id: '', n: 0 });
  inspectorTick = $state(0);
}
export const signals = new Signals();

let inspectTimer: ReturnType<typeof setTimeout> | null = null;
/** Refetch the inspector, debounced 150 ms (I13). */
export function bumpInspector(): void {
  if (inspectTimer) return;
  inspectTimer = setTimeout(() => { inspectTimer = null; signals.inspectorTick++; }, 150);
}
