// Cleanup UI (art_cleanup): the "Plan cleanup…" dry run for a browser selection (what goes, sizes,
// blockers, warnings, refused export files, then Apply), and the Cleanup panel: Trash (restore /
// empty, with sizes), Disk usage (by kind, project, group, biggest offenders) and Settings (the
// export folders cleanup may touch). Everything goes through the same ops as the agent.
import { el, api, toast, fmtBytes, splitId, KIND_ICON } from './util.js';

const modal = (title, wide = true) => {
  const body = el('div.cleanup-body');
  const close = el('button.btn.small', { text: '✕', title: 'Close (Esc)' });
  const dlg = el('div.modal.cleanup-modal', {}, el(`div.modal-card${wide ? '.wide' : ''}`, {}, el('div.pane-head', {}, el('h3', { text: title }), el('div.spacer'), close), body));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
  close.onclick = () => dlg.remove();
  document.body.append(dlg);
  return { dlg, body };
};
const kicon = (id) => el('span.kicon', { text: KIND_ICON[splitId(id)[0]] || '•', style: { color: `var(--k-${splitId(id)[0]}, #94a3b8)` } });
const stat = (label, value, cls = '') => el(`div.cl-stat${cls ? '.' + cls : ''}`, {}, el('div.cl-stat-v', { text: value }), el('div.cl-stat-l.muted.small', { text: label }));

/** Dry run for a selection, then Apply. Resolves true when something was moved to the trash. */
export function planDialog(app, ids) {
  return new Promise((resolve) => {
    const { dlg, body } = modal(`Plan cleanup · ${ids.length} selected`);
    const opt = { include_exports: true, include_dependents: false, allow_approved: false };
    const box = (k, label, title) => el('label.toggle', { title }, el('input', { type: 'checkbox', checked: opt[k], on: { change: (e) => { opt[k] = e.target.checked; run(); } } }), ' ' + label);
    const opts = el('div.cl-opts', {}, box('include_exports', 'Exported files', 'Also move the files these assets exported (only inside workspace/exports or an allowed folder)'),
      box('include_dependents', 'Dependents too', 'Also remove the kept assets that need these (a model using a texture, canvases of a project)'),
      box('allow_approved', 'Allow approved', 'Approved assets are protected unless this is on'));
    const out = el('div.cl-plan');
    let plan = null;
    let ok = false;
    const apply = el('button.btn.primary', { text: 'Move to trash', disabled: true, on: { click: async () => {
      if (!plan) return;
      apply.disabled = true;
      try {
        const r = await api('cleanup_apply', { plan_id: plan.plan_id, confirm: true });
        toast(`${r.removed} asset(s), ${r.size} moved to the trash (${r.trash}): Cleanup › Trash restores them`, 'ok');
        ok = true;
        dlg.remove();
      } catch { apply.disabled = false; }
    } } });
    const foot = el('div.cl-foot', {}, el('span.muted.small', { text: 'Soft delete: files, graph links, review notes and pins go to the trash and can be restored.' }), el('div.spacer'), el('button.btn', { text: 'Cancel', on: { click: () => dlg.remove() } }), apply);
    body.append(opts, out, foot);
    const obs = new MutationObserver(() => { if (!dlg.isConnected) { obs.disconnect(); resolve(ok); } });
    obs.observe(document.body, { childList: true });
    async function run() {
      out.replaceChildren(el('div.muted', { text: 'planning…' }));
      try { plan = await api('cleanup_plan', { select: { ids }, ...opt, full: true }); } catch (e) { out.replaceChildren(el('div.error', { text: e.message })); return; }
      const blocked = plan.blocked || [];
      out.replaceChildren(...[ // (replaceChildren would print a null)
        el('div.cl-stats', {}, stat('assets', String(plan.remove.count)), stat('on disk', plan.remove.size), ...Object.entries(plan.remove.by_kind).map(([k, n]) => stat(k, String(n))),
          blocked.length ? stat('blocked', String(blocked.length), 'bad') : stat('blocked', '0', 'good')),
        blocked.length ? el('div.cl-section', {}, el('h4.bad', { text: `Blocked (${blocked.length})` }),
          ...blocked.map((b) => el('div.cl-line.bad', {}, kicon(b.id), el('span.mono', { text: b.id }), el('span.muted', { text: b.why === 'approved' ? ' approved in review' : ` needed by ${b.by.join(', ')}` }))),
          el('div.muted.small', { text: plan.next })) : null,
        plan.warnings?.length ? el('div.cl-section', {}, el('h4.warn', { text: `Warnings (${plan.warnings.length})` }), ...plan.warnings.map((w) => el('div.cl-line.warn.small', { text: w }))) : null,
        plan.refused_files?.length ? el('div.cl-section', {}, el('h4.warn', { text: 'Export files kept (path rules)' }), ...plan.refused_files.map((w) => el('div.cl-line.small.mono', { text: w }))) : null,
        el('div.cl-section', {}, el('h4', { text: 'Will move to the trash' }),
          el('div.cl-items', {}, ...plan.items.map((it) => el('div.cl-item', { dataset: { id: it.id } }, kicon(it.id), el('span.mono.grow', { text: it.id }), it.reason ? el('span.badge', { text: it.reason }) : null, el('span.mono.muted', { text: fmtBytes(it.bytes) }))))),
        plan.unknown?.length ? el('div.muted.small', { text: `not removable / unknown: ${plan.unknown.join(', ')}` }) : null,
      ].filter(Boolean));
      apply.disabled = !plan.items.length || !!blocked.length;
      apply.textContent = blocked.length ? 'Blocked' : `Move ${plan.items.length} to trash`;
    }
    run();
  });
}

/** Trash / Disk usage / Settings. */
export function cleanupPanel(app, tab = 'trash') {
  const { body } = modal('Cleanup');
  const tabs = el('div.tabs.cl-tabs');
  const pane = el('div.cl-pane');
  body.append(tabs, pane);
  const show = (t) => {
    tab = t;
    tabs.replaceChildren(...[['trash', 'Trash'], ['usage', 'Disk usage'], ['settings', 'Settings']].map(([k, l]) => el(`button.tab${k === t ? '.on' : ''}`, { text: l, on: { click: () => show(k) } })));
    ({ trash: trashTab, usage: usageTab, settings: settingsTab })[t](app, pane, () => show(tab));
  };
  show(tab);
}

async function trashTab(app, pane, again) {
  pane.replaceChildren(el('div.muted', { text: 'loading…' }));
  let t;
  try { t = await api('cleanup_trash', { full: true }); } catch (e) { pane.replaceChildren(el('div.error', { text: e.message })); return; }
  const age = el('select', {}, ...[['', 'everything'], ['1d', 'older than 1 day'], ['7d', 'older than 7 days'], ['30d', 'older than 30 days']].map(([v, l]) => el('option', { value: v, text: l })));
  const empty = el('button.btn.warn', { text: 'Empty…', disabled: !t.batches, on: { click: async () => {
    const what = age.value ? `trash batches ${age.selectedOptions[0].text}` : `all ${t.batches} trash batch(es), ${t.size}`;
    if (!confirm(`Permanently delete ${what}? This cannot be undone.`)) return;
    const r = await api('cleanup_empty', { confirm: true, ...(age.value ? { older_than: age.value } : {}) }).catch(() => null);
    if (r) toast(`emptied ${r.emptied} batch(es), ${r.size} freed`, 'ok');
    again();
  } } });
  const head = el('div.cl-stats', {}, stat('batches', String(t.batches)), stat('in the trash', t.size), el('div.spacer'), el('div.group', {}, age, empty));
  if (!t.batches) { pane.replaceChildren(head, el('div.empty-note', { text: 'The trash is empty. Removed assets (art_cleanup apply, and single deletes) land here and can be restored.' })); return; }
  const card = (b) => {
    const list = el('div.cl-items', { hidden: true }, ...b.assets.map((x) => el('div.cl-item', {}, kicon(x.id), el('span.mono.grow', { text: x.id, title: x.files.join('\n') }), el('span.mono.muted', { text: fmtBytes(x.bytes) }),
      el('button.btn.small', { text: 'Restore', title: 'Restore only this asset', on: { click: async () => { const r = await api('cleanup_restore', { ids: [x.id] }).catch(() => null); if (r) toastRestore(r); again(); } } }))));
    const twist = el('button.act', { text: '▸', on: { click: () => { list.hidden = !list.hidden; twist.textContent = list.hidden ? '▸' : '▾'; } } });
    return el('div.cl-batch', {},
      el('div.cl-batch-head', {}, twist, el('span.mono', { text: b.id }), el('span.badge', { text: b.via }), b.plan ? el('span.muted.small.mono', { text: `plan ${b.plan}` }) : null,
        el('span.muted.small', { text: `${b.age} ago · ${new Date(b.ts).toLocaleString()}` }), el('div.spacer'),
        el('span.mono', { text: `${b.items} · ${b.size}` }),
        el('button.btn.small.ok', { text: 'Restore all', on: { click: async () => { const r = await api('cleanup_restore', { ids: [b.id] }).catch(() => null); if (r) toastRestore(r); again(); } } })),
      el('div.cl-batch-sum.small.muted', { text: `${b.assets.slice(0, 6).map((x) => splitId(x.id)[1]).join(', ')}${b.assets.length > 6 ? `, +${b.assets.length - 6}` : ''}${b.edges ? ` · ${b.edges} graph link(s)` : ''}${b.reviews ? ` · ${b.reviews} review note(s)` : ''}${b.manifests?.length ? ` · manifest ${b.manifests.join(', ')}` : ''}` }),
      list);
  };
  pane.replaceChildren(head, el('div.cl-batches', {}, ...t.trash.map(card)));
}
function toastRestore(r) {
  toast(`restored ${r.restored} asset(s)${r.conflicts?.length ? ` · ${r.conflicts.length} conflict(s): ${r.conflicts[0]}` : ''}`, r.conflicts?.length ? 'error' : 'ok');
}

async function usageTab(app, pane) {
  pane.replaceChildren(el('div.muted', { text: 'measuring…' }));
  let u;
  try { u = await api('cleanup_usage', { full: true }); } catch (e) { pane.replaceChildren(el('div.error', { text: e.message })); return; }
  const bars = (title, obj, color) => {
    const rows = Object.entries(obj);
    if (!rows.length) return el('div.cl-section', {}, el('h4', { text: title }), el('div.muted.small', { text: 'none' }));
    const max = Math.max(1, ...rows.map(([, v]) => v.bytes));
    return el('div.cl-section', {}, el('h4', { text: title }), ...rows.slice(0, 14).map(([k, v]) => el('div.cl-bar', {},
      el('span.cl-bar-name.mono', { text: k, title: k }), el('span.cl-bar-track', {}, el('span.cl-bar-fill', { style: { width: `${Math.max(1, (v.bytes / max) * 100)}%`, background: color(k) } })),
      el('span.mono.muted.cl-bar-v', { text: `${v.count} · ${fmtBytes(v.bytes)}` }))));
  };
  const other = Object.entries(u.other).map(([k, v]) => stat(k.replace('_', ' '), fmtBytes(v)));
  pane.replaceChildren(
    el('div.cl-stats', {}, stat('assets + exports', u.total), ...other),
    el('div.cl-grid', {},
      bars('By kind', u.by_kind, (k) => `var(--k-${k}, #94a3b8)`),
      bars('By project', u.by_project, () => 'var(--k-project)'),
      bars('By group', u.by_group, () => 'var(--k-group)'),
      el('div.cl-section', {}, el('h4', { text: 'Biggest' }), ...u.biggest.slice(0, 14).map((b) => el('div.cl-item.click', { on: { click: () => { pane.closest('.modal')?.remove(); app.openNode(b.id); } } },
        kicon(b.id), el('span.mono.grow', { text: b.id }), el('span.mono.muted', { text: fmtBytes(b.bytes) }))))),
    el('div.muted.small', { text: 'Select assets in the browser (☐ Select) and "Plan cleanup…" to retire them; superseded and orphan assets carry badges.' }));
}

async function settingsTab(app, pane, again) {
  let c;
  try { c = await api('cleanup_config', {}); } catch (e) { pane.replaceChildren(el('div.error', { text: e.message })); return; }
  const ta = el('textarea.mono', { rows: 4, placeholder: 'one absolute folder per line, e.g. E:\\Games\\MyGame\\assets', value: c.allow_paths.join('\n') });
  const trash = el('input', { type: 'checkbox', checked: c.trash_deletes });
  pane.replaceChildren(
    el('div.cl-section', {}, el('h4', { text: 'Export folders cleanup may touch' }),
      el('p.muted.small', { text: `Exported files (PNGs, strips, .glb, manifests) are only moved to the trash when they are inside ${c.exports} or a folder listed here. Symlinks and paths that resolve outside are always refused. Only you can change this list (the agent cannot).` }), ta),
    el('div.cl-section', {}, el('label.toggle', {}, trash, ' Single deletes (art_canvas / art_model / art_audio / art_project delete) go to the trash too')),
    el('div.cl-foot', {}, el('span.muted.small.mono', { text: c.file }), el('div.spacer'), el('button.btn.primary', { text: 'Save', on: { click: async () => {
      const r = await api('cleanup_config', { allow_paths: ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), trash_deletes: trash.checked }).catch(() => null);
      if (r) { toast('cleanup settings saved', 'ok'); again(); }
    } } })));
}
