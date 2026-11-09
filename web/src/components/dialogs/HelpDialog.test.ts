// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import HelpDialog from './HelpDialog.svelte';
import DialogHost from './DialogHost.svelte';
import { SHORTCUTS } from '@/state/shortcuts';
import { dialogs } from '@/state/dialogs.svelte';

// Frozen copy of the text of the legacy #help markup (web/index.html before step 13), one paragraph each.
const LEGACY = {
  Everywhere: 'F follow the agent · C compare · M review mode · / filter assets · Shift+G asset graph · O project overview · P timeline right / bottom · [ ] side panes · 1–5 viewer tabs · Esc back to live / close · ? this help',
  Canvas: 'B pencil · E eraser · G fill · L line · R rectangle (Shift = filled) · I pick · H pan · Ctrl+Z/Y undo/redo'
    + ' · Wheel = zoom at cursor · Space/middle drag = pan · + - 0 zoom/fit · # grid · T tile 3×3 · , . frames · N onion skin',
  Players: 'Space play / pause (animation, rig clip, 3D clip, audio) · W wireframe (3D) · 0 reset view',
};
const LEGACY_NOTES = [
  'Alt/Shift+click an asset = open it in the comparison pane.',
  'Your edits use the same API as the agent, so it sees them. Hidden / pinned assets are saved per workspace.',
];

afterEach(() => { cleanup(); dialogs.closeAll(); });

describe('HelpDialog', () => {
  it('lists the legacy shortcuts verbatim, in order, per group', async () => {
    render(HelpDialog, { props: { onclose: () => {} } });
    const dlg = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const [group, legacy] of Object.entries(LEGACY)) {
      const section = dlg.querySelector(`section[aria-label="${group}"]`)!;
      const rows = [...section.querySelectorAll<HTMLElement>('.help-row')]
        .filter((r) => !SHORTCUTS.find((s) => s.id === r.dataset.id)?.isNew)
        .map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
      expect(rows.join(' · ')).toBe(legacy);
    }
    for (const note of LEGACY_NOTES) expect(dlg.textContent).toContain(note);
  });

  it('adds the new rows in their own groups', async () => {
    render(HelpDialog, { props: { onclose: () => {} } });
    const dlg = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const s of SHORTCUTS.filter((x) => x.isNew)) expect(dlg.querySelector(`section[aria-label="${s.group}"] [data-id="${s.id}"]`)).not.toBeNull();
    expect(dlg.querySelectorAll('kbd').length).toBeGreaterThan(30);
  });

  it('DialogHost renders Help from the store and closes it through the store', async () => {
    render(DialogHost);
    flushSync(() => dialogs.toggleHelp());
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    screen.getByRole('button', { name: 'Close' }).click();
    flushSync();
    expect(dialogs.helpOpen).toBe(false);
  });

  it('DialogHost resolves confirm and prompt through their buttons', async () => {
    render(DialogHost);
    const ok = dialogs.confirm({ title: 'Delete r1?', confirmLabel: 'Delete', danger: true });
    flushSync();
    await screen.findByRole('alertdialog', { name: 'Delete r1?' });
    screen.getByRole('button', { name: 'Delete' }).click();
    await expect(ok).resolves.toBe(true);
    const text = dialogs.prompt({ title: 'Reopen', label: 'What is still wrong?', value: 'blurry' });
    flushSync();
    await screen.findByRole('alertdialog', { name: 'Reopen' });
    expect((screen.getByLabelText('What is still wrong?') as HTMLInputElement).value).toBe('blurry');
    screen.getByRole('button', { name: 'Cancel' }).click();
    await expect(text).resolves.toBeNull();
  });
});
