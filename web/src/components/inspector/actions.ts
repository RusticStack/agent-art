// Default inspector actions on the stores.
import { workspace } from '@/state/workspace.svelte';
import type { ReviewDraft, Target } from '@/viewers/types';

/** R3: open the review note dialog; on success toast and leave review mode. Resolves with the new note. */
export function reviewPrompt(draft: ReviewDraft, leaveReviewMode?: () => void): Promise<{ id: string } | null> {
  return workspace.requestReview(draft, leaveReviewMode);
}

/** Open a target in slot A (through the workspace's navigation interceptor when one is set). */
export function openTarget(t: Target): void {
  if (workspace.navigator) workspace.navigator(t);
  else workspace.open(t);
}
