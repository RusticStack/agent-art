// The command palette chunk (step 18b): fetched on first open, or earlier as a warm-up when the
// pointer enters / focus reaches the top bar search button. A failed import is forgotten so the
// next try fetches again.
let p: Promise<typeof import('./CommandPalette.svelte')> | null = null;
export const loadPalette = (): Promise<typeof import('./CommandPalette.svelte')> =>
  (p ??= import('./CommandPalette.svelte').catch((e: unknown) => { p = null; throw e; }));
