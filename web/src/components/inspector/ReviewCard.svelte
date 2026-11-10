<!--
  R4 review card: id, category, priority (when not normal), status text, note or "(approval)", where line,
  "compare with" link, last reply, last 3 history images, actions Show / Side by side / Accept / Reopen /
  Delete. Left border colour by status (.st-<status>). `onnavigate` runs before any button or link acts
  (the review list dialog closes itself with it, R6). Reopen and Delete use the styled dialogs.
-->
<script lang="ts">
  import { op } from '@/lib/api/client';
  import type { Review } from '@/lib/api/types';
  import { reviewImage } from '@/lib/api/urls';
  import { dialogs } from '@/state/dialogs.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import Icon from '../ui/Icon.svelte';
  import { linkHash, reviewActions, reviewExtras, STATUS_LABEL, whereLine } from './logic';

  let { review, showAsset = false, onnavigate }: { review: Review; showAsset?: boolean; onnavigate?: () => void } = $props();

  const r = $derived(review);
  const where = $derived(whereLine(r.target));
  const acts = $derived(reviewActions(r));
  const extras = $derived(reviewExtras(r));

  const go = (fn: () => void | Promise<void>) => () => { onnavigate?.(); void fn(); };
  const show = go(() => workspace.openReview(r));
  const sideBySide = go(() => workspace.openReviewCompare(r));
  const accept = go(() => op('review_update', { id: r.id, status: 'accepted' }).then(() => {}, () => {}));
  const reopen = go(async () => {
    const reply = await dialogs.prompt({ title: `Reopen ${r.id}`, label: 'What is still wrong?' });
    if (reply === null) return;
    await op('review_update', { id: r.id, status: 'reopened', ...(reply.trim() ? { reply: reply.trim() } : {}) }).catch(() => {});
  });
  const del = go(async () => {
    if (!(await dialogs.confirm({ title: `Delete ${r.id}?`, confirmLabel: 'Delete', danger: true }))) return;
    await op('review_delete', { id: r.id }).catch(() => {});
  });
</script>

{#if showAsset}<div class="mono small muted rc-asset">{r.asset}</div>{/if}
<article class="review-card st-{r.status}" data-review={r.id} aria-label="Review note {r.id}">
  <div class="rc-head">
    <span class="rc-id mono">{r.id}</span>
    <span class="rc-cat">{r.category}</span>
    {#if r.priority !== 'normal'}<span class="rc-pri">{r.priority}</span>{/if}
    <span class="spacer"></span>
    <span class="rc-status">{STATUS_LABEL[r.status] || r.status}</span>
  </div>
  <div class="rc-note">{r.note || '(approval)'}</div>
  {#if where}<div class="rc-where muted small">{where}</div>{/if}
  {#if r.compare_with}
    <div class="rc-where small">compare with <a href={linkHash(r.compare_with.asset)} onclick={(e) => { e.preventDefault(); sideBySide(); }}>{r.compare_with.asset}</a></div>
  {/if}
  {#if extras.reply}<div class="rc-reply">{extras.reply}</div>{/if}
  {#if extras.images.length}
    <div class="rc-imgs">
      {#each extras.images as im (im.img)}
        <figure><img src={reviewImage(im.img)} alt="{r.id} {im.caption}" loading="lazy" /><figcaption>{im.caption}</figcaption></figure>
      {/each}
    </div>
  {/if}
  <div class="rc-actions">
    <button type="button" class="btn small" onclick={show}>Show</button>
    {#if acts.sideBySide}<button type="button" class="btn small" onclick={sideBySide}>Side by side</button>{/if}
    {#if acts.accept}<button type="button" class="btn small ok" onclick={accept}>Accept</button>{/if}
    {#if acts.reopen}<button type="button" class="btn small warn" onclick={reopen}>Reopen</button>{/if}
    <button type="button" class="btn small icon ghost" title="Delete note" aria-label="Delete note {r.id}" onclick={del}><Icon name="x" size={14} /></button>
  </div>
</article>
