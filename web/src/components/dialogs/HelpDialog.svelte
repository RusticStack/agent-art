<!--
  Keyboard shortcuts, rendered from the SHORTCUTS table (4.4). Esc is left to the global Esc chain (K5:
  review mode is left before Help closes), so the dialog does not close itself on Esc.
-->
<script lang="ts">
  import Dialog from '../ui/Dialog.svelte';
  import Kbd from '../ui/Kbd.svelte';
  import { HELP_FOOTER, HELP_GROUP_NOTES, SHORTCUT_GROUPS, SHORTCUTS } from '@/state/shortcuts';

  let { onclose }: { onclose: () => void } = $props();
  const groups = SHORTCUT_GROUPS.map((g) => ({ name: g, rows: SHORTCUTS.filter((s) => s.group === g), note: HELP_GROUP_NOTES[g] }))
    .filter((g) => g.rows.length);
</script>

<Dialog open title="Keyboard shortcuts" size="lg" closeOnEscape={false} class="help-dialog" {onclose}>
  <div class="help-grid">
    {#each groups as g (g.name)}
      <section class="help-group" aria-label={g.name}>
        <h3>{g.name}</h3>
        <ul>
          {#each g.rows as s (s.id)}
            <li class="help-row" data-id={s.id}>{#if s.keys}<Kbd keys={s.keys} />{' '}{/if}<span>{s.label}</span></li>
          {/each}
        </ul>
        {#if g.note}<p class="help-note">{g.note}</p>{/if}
      </section>
    {/each}
  </div>
  <p class="muted small help-foot">{HELP_FOOTER}</p>
</Dialog>

<style>
  .help-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--s-6); }
  h3 { margin: 0 0 var(--s-2); font-size: var(--fs-4); color: var(--accent); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s-2); }
  .help-row { line-height: 1.6; color: var(--text2); }
  .help-note { margin: var(--s-4) 0 0; color: var(--muted); }
  .help-foot { margin: var(--s-6) 0 0; }
</style>
