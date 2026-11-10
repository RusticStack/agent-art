<!--
  Cleanup › Settings (C7): allowed export folders (one per line), "single deletes go to the trash" and
  Save through op('cleanup_config') (a user-only write; the client refreshes a stale UI token once, 3.2).
  A refused save keeps the edited text (op() toasts the server's error).
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import ErrorNote from '../ui/ErrorNote.svelte';
  import { op } from '@/lib/api/client';
  import type { CleanupConfig } from '@/lib/api/types';
  import { toasts } from '@/state/toasts.svelte';
  import { parseAllowPaths } from './cleanup';

  let c = $state.raw<CleanupConfig | null>(null);
  let error = $state<string | null>(null);
  let paths = $state('');
  let trashDeletes = $state(false);
  let saving = $state(false);
  const PLACEHOLDER = 'one absolute folder per line, e.g. E:\\Games\\MyGame\\assets';

  async function load() {
    error = null;
    try {
      const r = await op('cleanup_config', {});
      c = r;
      paths = r.allow_paths.join('\n');
      trashDeletes = r.trash_deletes;
    } catch (e) { error = (e as Error).message; }
  }

  async function save() {
    saving = true;
    const r = await op('cleanup_config', { allow_paths: parseAllowPaths(paths), trash_deletes: trashDeletes }).catch(() => null);
    saving = false;
    if (r) { toasts.push('cleanup settings saved', 'ok'); await load(); }
  }

  void load();
</script>

{#if error}
  <ErrorNote text={error} onretry={load} />
{:else if !c}
  <div class="muted">loading…</div>
{:else}
  <div class="cu-settings">
    <section class="cu-section">
      <h4 id="cu-allow-h">Export folders cleanup may touch</h4>
      <p class="muted small" id="cu-allow-p">Exported files (PNGs, strips, .glb, manifests) are only moved to the trash when they are inside {c.exports} or a folder listed here. Symlinks and paths that resolve outside are always refused. Only you can change this list (the agent cannot).</p>
      <textarea class="mono" rows="4" aria-labelledby="cu-allow-h" aria-describedby="cu-allow-p" placeholder={PLACEHOLDER} bind:value={paths}></textarea>
    </section>
    <section class="cu-section">
      <Toggle bind:checked={trashDeletes} label="Single deletes (art_canvas / art_model / art_audio / art_project delete) go to the trash too" />
    </section>
  </div>
  <div class="cu-foot">
    <span class="muted small mono">{c.file}</span>
    <div class="spacer"></div>
    <Button variant="primary" disabled={saving} onclick={save}>Save</Button>
  </div>
{/if}
