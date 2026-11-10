// Default inspector actions on the stores. The legacy App passes its own (they also re-render its DOM)
// until the Svelte shell owns the page (step 18).
import { toast } from '@/lib/util/notify';
import { dialogs } from '@/state/dialogs.svelte';
import { editor } from '@/state/editor.svelte';
import { workspace } from '@/state/workspace.svelte';
import type { ReviewDraft, Target } from '@/viewers/types';

/** R3: open the review note dialog; on success toast and leave review mode. Resolves with the new note. */
export async function reviewPrompt(draft: ReviewDraft, leaveReviewMode: () => void = () => editor.setReviewMode(false)): Promise<{ id: string } | null> {
  const r = await dialogs.reviewNote(draft);
  if (r) {
    toast(`Review note ${r.id} added — the agent sees it in art_review list and in replies about this asset`, 'ok');
    leaveReviewMode();
  }
  return r;
}

/** Open a target in slot A through whoever performs navigation (the legacy App until step 18). */
export function openTarget(t: Target): void {
  if (workspace.navigator) workspace.navigator(t);
  else workspace.open(t);
}
