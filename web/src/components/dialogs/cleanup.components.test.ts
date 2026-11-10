// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { op } from '@/lib/api/client';
import type { CleanupConfig, CleanupPlan, DiskUsage, TrashList } from '@/lib/api/types';
import { dialogs, type DialogSpec } from '@/state/dialogs.svelte';
import { toasts } from '@/state/toasts.svelte';
import { workspace } from '@/state/workspace.svelte';
import TrashTab from './TrashTab.svelte';
import UsageTab from './UsageTab.svelte';
import SettingsTab from './SettingsTab.svelte';
import PlanCleanupDialog from './PlanCleanupDialog.svelte';
import CleanupDialog from './CleanupDialog.svelte';

vi.mock('@/lib/api/client', () => ({ op: vi.fn() }));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const calls = (name: string) => vi.mocked(op).mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
function serve(h: Record<string, Handler>) {
  handlers = h;
  vi.mocked(op).mockImplementation((async (name: string, args: Record<string, unknown>) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`unexpected op ${name}`);
    return fn(args);
  }) as unknown as typeof op);
}
const toastTexts = () => toasts.list.map((t) => `${t.kind}:${t.text}`);

const TRASH: TrashList = {
  batches: 1, bytes: 120, size: '120 B',
  trash: [{
    id: 't-1', ts: Date.UTC(2026, 0, 2), age: '5m', via: 'apply', plan: 'p-9', items: 2, bytes: 120, size: '120 B',
    assets: [{ id: 'canvas:throwaway', bytes: 100, files: ['canvases/throwaway.json', 'canvases/throwaway.png'] }, { id: 'model:old', bytes: 20, files: [] }],
    edges: 2, reviews: 1, manifests: [],
  }],
};
const EMPTY_TRASH: TrashList = { batches: 0, bytes: 0, size: '0 B', trash: [] };
const USAGE: DiskUsage = {
  total: '3.0 KB', other: { trash: 1024 },
  by_kind: { canvas: { count: 2, bytes: 2048 }, model: { count: 1, bytes: 1024 } }, by_project: {}, by_group: { g1: { count: 1, bytes: 10 } },
  biggest: [{ id: 'canvas:big', bytes: 2000 }, { id: 'model:m', bytes: 1024 }],
};
const CONFIG: CleanupConfig = { exports: 'W:/ws/exports', allow_paths: ['E:\\Games\\x'], trash_deletes: true, file: 'W:/ws/cleanup.json' };
const PLAN: CleanupPlan = { plan_id: 'p1', remove: { count: 1, bytes: 100, size: '100 B', by_kind: { canvas: 1 } }, items: [{ id: 'canvas:throwaway', bytes: 100, reason: 'selected' }] };
const BLOCKED: CleanupPlan = {
  plan_id: 'p2', remove: { count: 1, bytes: 100, size: '100 B', by_kind: { canvas: 1 } }, items: [{ id: 'canvas:tex', bytes: 100 }],
  blocked: [{ id: 'canvas:tex', why: 'needed', by: ['model:crate'] }], next: 'Turn on include_dependents to remove them too.',
};

beforeEach(() => { vi.mocked(op).mockReset(); toasts.reset(); });
afterEach(() => { cleanup(); dialogs.closeAll(); vi.restoreAllMocks(); });

describe('TrashTab', () => {
  it('lists batches: tiles, card head, summary, hidden asset list with files in the title', async () => {
    serve({ cleanup_trash: () => TRASH });
    const { container } = render(TrashTab);
    expect(screen.getByText('loading…')).toBeTruthy();
    const card = await waitFor(() => { const c = container.querySelector<HTMLElement>('[data-batch="t-1"]'); if (!c) throw new Error('no card'); return c; });
    expect(calls('cleanup_trash')).toEqual([{ full: true }]);
    expect(container.querySelector('[data-tile="batches"]')!.textContent).toContain('1');
    expect(container.querySelector('[data-tile="in the trash"]')!.textContent).toContain('120 B');
    const head = within(card);
    expect(head.getByText('apply')).toBeTruthy();
    expect(head.getByText('plan p-9')).toBeTruthy();
    expect(head.getByText(/^5m ago · /)).toBeTruthy();
    expect(head.getByText('2 · 120 B')).toBeTruthy();
    expect(card.querySelector('.cu-batch-sum')!.textContent).toBe('throwaway, old · 2 graph link(s) · 1 review note(s)');
    const list = card.querySelector<HTMLElement>('ul.cu-items')!;
    expect(list.hidden).toBe(true);
    expect(list.textContent).toContain('canvas:throwaway');
    expect(head.getByText('canvas:throwaway').getAttribute('title')).toBe('canvases/throwaway.json\ncanvases/throwaway.png');
    const twisty = head.getByRole('button', { name: 'Assets of t-1' });
    await fireEvent.click(twisty);
    expect(twisty.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Empty…' }).hasAttribute('disabled')).toBe(false);
  });

  it('Restore all restores the batch, toasts and reloads; per-asset Restore sends the asset id', async () => {
    serve({ cleanup_trash: () => TRASH, cleanup_restore: () => ({ restored: 1 }) });
    render(TrashTab);
    await fireEvent.click(await screen.findByRole('button', { name: 'Restore all' }));
    await waitFor(() => expect(calls('cleanup_trash')).toHaveLength(2));
    expect(calls('cleanup_restore')).toEqual([{ ids: ['t-1'] }]);
    expect(toastTexts()).toContain('ok:restored 1 asset(s)');
    expect(screen.queryAllByRole('button', { name: 'Restore' })).toHaveLength(0); // collapsed list
    await fireEvent.click(screen.getByRole('button', { name: 'Assets of t-1' }));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]);
    await waitFor(() => expect(calls('cleanup_restore')).toEqual([{ ids: ['t-1'] }, { ids: ['canvas:throwaway'] }]));
  });

  it('restore conflicts toast as an error', async () => {
    serve({ cleanup_trash: () => TRASH, cleanup_restore: () => ({ restored: 0, conflicts: ['canvas:throwaway exists'] }) });
    render(TrashTab);
    await fireEvent.click(await screen.findByRole('button', { name: 'Restore all' }));
    await waitFor(() => expect(toastTexts()).toContain('error:restored 0 asset(s) · 1 conflict(s): canvas:throwaway exists'));
  });

  it('empty trash: the legacy text and a disabled Empty…', async () => {
    serve({ cleanup_trash: () => EMPTY_TRASH });
    render(TrashTab);
    expect(await screen.findByText('The trash is empty. Removed assets (art_cleanup apply, and single deletes) land here and can be restored.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Empty…' }).hasAttribute('disabled')).toBe(true);
  });

  it('Empty… asks a danger confirm, then empties with the chosen age', async () => {
    serve({ cleanup_trash: () => TRASH, cleanup_empty: () => ({ emptied: 1, size: '120 B' }) });
    const confirm = vi.spyOn(dialogs, 'confirm').mockResolvedValue(true);
    render(TrashTab);
    const select = await screen.findByRole('combobox', { name: 'Empty which batches' });
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(['everything', 'older than 1 day', 'older than 7 days', 'older than 30 days']);
    await fireEvent.change(select, { target: { value: '7d' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Empty…' }));
    await waitFor(() => expect(calls('cleanup_empty')).toEqual([{ confirm: true, older_than: '7d' }]));
    expect(confirm).toHaveBeenCalledWith({ title: 'Permanently delete trash batches older than 7 days?', body: 'This cannot be undone.', confirmLabel: 'Delete permanently', danger: true });
    await waitFor(() => expect(toastTexts()).toContain('ok:emptied 1 batch(es), 120 B freed'));
  });

  it('Empty… cancelled does nothing; "everything" sends no older_than', async () => {
    serve({ cleanup_trash: () => TRASH, cleanup_empty: () => ({ emptied: 1, size: '120 B' }) });
    const confirm = vi.spyOn(dialogs, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(TrashTab);
    await fireEvent.click(await screen.findByRole('button', { name: 'Empty…' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0].title).toBe('Permanently delete all 1 trash batch(es), 120 B?');
    expect(calls('cleanup_empty')).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Empty…' }));
    await waitFor(() => expect(calls('cleanup_empty')).toEqual([{ confirm: true }]));
  });

  it('a failed load shows the error with Retry', async () => {
    let fail = true;
    serve({ cleanup_trash: () => { if (fail) throw new Error('trash unreadable'); return EMPTY_TRASH; } });
    render(TrashTab);
    expect((await screen.findByRole('alert')).textContent).toContain('trash unreadable');
    fail = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/The trash is empty/)).toBeTruthy();
  });
});

describe('UsageTab', () => {
  it('tiles, bars (kind colour, count · size, none), biggest opens the asset', async () => {
    serve({ cleanup_usage: () => USAGE });
    const onopen = vi.fn();
    const { container } = render(UsageTab, { props: { onopen } });
    expect(screen.getByText('measuring…')).toBeTruthy();
    const kind = await screen.findByRole('region', { name: 'By kind' });
    expect(calls('cleanup_usage')).toEqual([{ full: true }]);
    expect(container.querySelector('[data-tile="assets + exports"]')!.textContent).toContain('3.0 KB');
    expect(container.querySelector('[data-tile="trash"]')!.textContent).toContain('1.0 KB');
    const canvas = kind.querySelector<HTMLElement>('[data-bar="canvas"]')!;
    expect(canvas.textContent).toContain('2 · 2.0 KB');
    expect(canvas.querySelector<HTMLElement>('.cu-bar-fill')!.style.width).toBe('100%');
    expect(kind.querySelector<HTMLElement>('[data-bar="model"] .cu-bar-fill')!.style.width).toBe('50%');
    expect(within(screen.getByRole('region', { name: 'By project' })).getByText('none')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'By group' })).getByText('g1')).toBeTruthy();
    await fireEvent.click(within(screen.getByRole('region', { name: 'Biggest' })).getByRole('button', { name: /canvas:big/ }));
    expect(onopen).toHaveBeenCalledWith('canvas:big');
    expect(screen.getByText(/to retire them; superseded and orphan assets carry badges\./)).toBeTruthy();
  });

  it('a failed measurement shows the error', async () => {
    serve({ cleanup_usage: () => { throw new Error('disk walk failed'); } });
    render(UsageTab, { props: { onopen: () => {} } });
    expect((await screen.findByRole('alert')).textContent).toContain('disk walk failed');
  });
});

describe('SettingsTab', () => {
  it('shows the config and saves the edited folders and toggle', async () => {
    serve({ cleanup_config: (a) => (a.allow_paths ? { ...CONFIG, allow_paths: a.allow_paths as string[], trash_deletes: a.trash_deletes as boolean } : CONFIG) });
    render(SettingsTab);
    const ta = await screen.findByRole('textbox', { name: 'Export folders cleanup may touch' });
    expect((ta as HTMLTextAreaElement).value).toBe('E:\\Games\\x');
    expect(screen.getByText(/only moved to the trash when they are inside W:\/ws\/exports or a folder listed here/)).toBeTruthy();
    expect(screen.getByText('W:/ws/cleanup.json')).toBeTruthy();
    const toggle = screen.getByRole('checkbox', { name: /Single deletes .* go to the trash too/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await fireEvent.input(ta, { target: { value: ' D:\\a \n\n/tmp/b ' } });
    await fireEvent.click(toggle);
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastTexts()).toContain('ok:cleanup settings saved'));
    expect(calls('cleanup_config')[1]).toEqual({ allow_paths: ['D:\\a', '/tmp/b'], trash_deletes: false });
    await waitFor(() => expect(calls('cleanup_config')).toHaveLength(3));
  });

  it('a refused save keeps the text and does not claim success', async () => {
    serve({ cleanup_config: (a) => { if (a.allow_paths) throw new Error('folder does not exist'); return CONFIG; } });
    render(SettingsTab);
    const ta = await screen.findByRole('textbox', { name: 'Export folders cleanup may touch' });
    await fireEvent.input(ta, { target: { value: 'Z:\\nope' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('cleanup_config')).toHaveLength(2));
    expect(toastTexts()).not.toContain('ok:cleanup settings saved');
    expect((ta as HTMLTextAreaElement).value).toBe('Z:\\nope');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('a failed load shows the error', async () => {
    serve({ cleanup_config: () => { throw new Error('config unreadable'); } });
    render(SettingsTab);
    expect((await screen.findByRole('alert')).textContent).toContain('config unreadable');
  });
});

describe('PlanCleanupDialog', () => {
  const spec = (ids: string[]): Extract<DialogSpec, { type: 'planCleanup' }> => ({ type: 'planCleanup', ids, resolve: () => {} });

  it('dry run with the default options, apply, toast, onclose(true)', async () => {
    serve({ cleanup_plan: () => PLAN, cleanup_apply: () => ({ removed: 1, size: '100 B', trash: 't-1' }) });
    const onclose = vi.fn();
    render(PlanCleanupDialog, { props: { spec: spec(['canvas:throwaway']), onclose } });
    const dlg = await screen.findByRole('dialog', { name: 'Plan cleanup · 1 selected' });
    expect(within(dlg).getByText('planning…')).toBeTruthy();
    const apply = await within(dlg).findByRole('button', { name: /Move 1 to trash/ });
    expect(apply.hasAttribute('disabled')).toBe(false);
    expect(calls('cleanup_plan')).toEqual([{ select: { ids: ['canvas:throwaway'] }, include_exports: true, include_dependents: false, allow_approved: false, full: true }]);
    expect(within(dlg).getByRole('checkbox', { name: 'Exported files' })).toBeTruthy();
    expect(within(dlg).getByText('Soft delete: files, graph links, review notes and pins go to the trash and can be restored.')).toBeTruthy();
    const items = within(dlg).getByRole('region', { name: 'Will move to the trash' });
    expect(items.textContent).toContain('canvas:throwaway');
    expect(items.textContent).toContain('selected');
    await fireEvent.click(apply);
    await waitFor(() => expect(onclose).toHaveBeenCalledWith(true));
    expect(calls('cleanup_apply')).toEqual([{ plan_id: 'p1', confirm: true }]);
    expect(toastTexts()).toContain('ok:1 asset(s), 100 B moved to the trash (t-1): Cleanup › Trash restores them');
  });

  it('blocked: "Blocked" disabled; "Dependents too" re-plans and unblocks', async () => {
    serve({ cleanup_plan: (a) => (a.include_dependents ? { ...BLOCKED, blocked: [], plan_id: 'p3', items: [...BLOCKED.items, { id: 'model:crate', bytes: 50, reason: 'dependent' }] } : BLOCKED) });
    render(PlanCleanupDialog, { props: { spec: spec(['canvas:tex']), onclose: () => {} } });
    const dlg = await screen.findByRole('dialog', { name: 'Plan cleanup · 1 selected' });
    const blocked = await within(dlg).findByRole('button', { name: 'Blocked' });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    const section = within(dlg).getByRole('region', { name: 'Blocked' });
    expect(section.textContent).toContain('Blocked (1)');
    expect(section.textContent).toContain('canvas:tex needed by model:crate');
    expect(section.textContent).toContain('Turn on include_dependents');
    await fireEvent.click(within(dlg).getByRole('checkbox', { name: 'Dependents too' }));
    const apply = await within(dlg).findByRole('button', { name: 'Move 2 to trash' });
    expect(apply.hasAttribute('disabled')).toBe(false);
    expect(calls('cleanup_plan').at(-1)).toMatchObject({ include_dependents: true, include_exports: true, allow_approved: false });
  });

  it('a failed dry run shows the error and disables apply; Cancel closes with false', async () => {
    serve({ cleanup_plan: () => { throw new Error('unknown asset'); } });
    const onclose = vi.fn();
    render(PlanCleanupDialog, { props: { spec: spec(['x', 'y']), onclose } });
    const dlg = await screen.findByRole('dialog', { name: 'Plan cleanup · 2 selected' });
    expect((await within(dlg).findByRole('alert')).textContent).toContain('unknown asset');
    expect(within(dlg).getByRole('button', { name: 'Move to trash' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(onclose).toHaveBeenCalledWith(false);
  });
});

describe('CleanupDialog', () => {
  it('opens on the spec tab, switches tabs, Biggest closes and opens the asset', async () => {
    serve({ cleanup_trash: () => EMPTY_TRASH, cleanup_usage: () => USAGE, cleanup_config: () => CONFIG });
    const openNode = vi.spyOn(workspace, 'openNode').mockImplementation(() => {});
    const onclose = vi.fn();
    render(CleanupDialog, { props: { spec: { type: 'cleanup', tab: 'usage' }, onclose } });
    const dlg = await screen.findByRole('dialog', { name: 'Cleanup' });
    expect(within(dlg).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Trash', 'Disk usage', 'Settings']);
    expect(within(dlg).getByRole('tab', { name: 'Disk usage' }).getAttribute('aria-selected')).toBe('true');
    expect(within(dlg).getByRole('tabpanel', { name: 'Disk usage' })).toBeTruthy();
    await within(dlg).findByRole('region', { name: 'By kind' });
    await fireEvent.click(within(dlg).getByRole('tab', { name: 'Settings' }));
    expect(await within(dlg).findByRole('button', { name: 'Save' })).toBeTruthy();
    await fireEvent.click(within(dlg).getByRole('tab', { name: 'Trash' }));
    expect(await within(dlg).findByText(/The trash is empty/)).toBeTruthy();
    await fireEvent.click(within(dlg).getByRole('tab', { name: 'Disk usage' }));
    await fireEvent.click(await within(dlg).findByRole('button', { name: /canvas:big/ }));
    expect(onclose).toHaveBeenCalled();
    expect(openNode).toHaveBeenCalledWith('canvas:big');
  });
});
