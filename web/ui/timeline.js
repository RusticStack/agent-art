// Activity timeline: every MCP tool call (and every UI / CLI op) as an entry, live: tool, action,
// key args, duration, result summary or error, before/after thumbnails of the canvases and models
// it changed. Filter by tool, current asset, errors, source; search. Click opens the asset at that
// state (snapshot) when one exists, else the current asset; ⇆ compares before / after.
import { el, fmtMs, fmtTime, store, debounce } from './util.js';

const KEY_ARGS = ['canvas', 'name', 'new_name', 'action', 'label', 'preset', 'animation', 'clip', 'pose', 'view', 'recipe', 'node', 'from', 'rel', 'to', 'id', 'status', 'asset', 'commands', 'path'];
const MAX_ROWS = 400;

export class Timeline {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.entries = new Map();
    this.order = [];
    this.open = new Set();
    this.f = store.get('tlFilter', { tool: '', errors: false, current: false, agent: false });
    this.search = el('input.search', { type: 'search', placeholder: 'Search activity', on: { input: () => this.renderSoon() } });
    this.toolSel = el('select', { title: 'Filter by tool', on: { change: () => { this.f.tool = this.toolSel.value; this.save(); } } });
    const chip = (key, text, title) => { const b = el('button.chip', { text, title, on: { click: () => { this.f[key] = !this.f[key]; b.classList.toggle('on', this.f[key]); this.save(); } } }); b.classList.toggle('on', !!this.f[key]); return b; };
    this.count = el('span.muted.mono');
    root.append(
      el('div.pane-head', {}, el('h2', { text: 'Activity' }), el('div.spacer'), this.count, el('button.btn.small.icon', { title: 'Move timeline (P): right / bottom', text: '⇅', on: { click: () => app.toggleTimelineDock() } })),
      el('div.tl-filters', {}, this.search, this.toolSel, chip('errors', 'Errors', 'Only failed calls'), chip('current', 'This asset', 'Only entries touching the open asset'), chip('agent', 'Agent', 'Only the agent (hide your own edits)')));
    this.list = el('ol.tl-list');
    root.append(this.list);
    this.list.addEventListener('click', (e) => this.onClick(e));
    this.renderSoon = debounce(() => this.render(), 80);
  }
  save() { store.set('tlFilter', this.f); this.render(); }

  load(entries) {
    for (const e of entries) this.upsert(e, true);
    this.render();
  }
  upsert(e, quiet) {
    if (!this.entries.has(e.id)) this.order.push(e.id);
    this.entries.set(e.id, e);
    if (this.order.length > 3000) for (const id of this.order.splice(0, this.order.length - 3000)) this.entries.delete(id);
    if (!quiet) this.renderSoon();
  }
  tools() { return [...new Set(this.order.map((id) => this.label(this.entries.get(id))).filter(Boolean))].sort(); }
  label(e) { return e ? (e.type === 'tool' ? e.tool : e.op) : ''; }
  /** Top-level entries: tool calls, and ops that are not part of a known tool call. */
  topLevel() {
    const calls = new Set();
    for (const id of this.order) { const e = this.entries.get(id); if (e?.type === 'tool') calls.add(e.call); }
    return this.order.map((id) => this.entries.get(id)).filter((e) => e && (e.type === 'tool' || !e.call || !calls.has(e.call)));
  }
  passes(e) {
    if (this.f.tool && this.label(e) !== this.f.tool) return false;
    if (this.f.errors && e.ok !== false) return false;
    if (this.f.agent && e.source === 'user') return false;
    if (this.f.current) {
      const cur = this.app.current;
      if (!cur || !e.assets?.some((a) => a.name === cur.name || `${a.name}_parts` === cur.name || a.name === `${cur.name}_parts`)) return false;
    }
    const q = this.search.value.trim().toLowerCase();
    if (q && !JSON.stringify([e.tool, e.op, e.args, e.summary, e.error, e.assets?.map((a) => a.name)]).toLowerCase().includes(q)) return false;
    return true;
  }
  keyArgs(a = {}, skip) {
    const out = [];
    for (const k of KEY_ARGS) if (k !== skip && a[k] !== undefined && a[k] !== null && a[k] !== '' && out.length < 4) out.push(k === 'commands' ? String(a[k]) : `${k}=${typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k])}`);
    return out.join('  ');
  }
  thumbs(e) {
    const box = el('div.tl-thumbs');
    let n = 0;
    for (const a of e.assets || []) {
      if (n >= 3) break;
      if (!a.before && !a.after) continue;
      n++;
      const pair = el('div.tl-pair', { title: `${a.kind} ${a.name}${a.created ? ' (new)' : ''}`, dataset: { kind: a.kind, name: a.name, snap: a.after || a.before || '' } });
      if (a.before && a.after) pair.append(this.img(a.before), el('span.arrow', { text: '→' }), this.img(a.after));
      else pair.append(this.img(a.after || a.before));
      pair.append(el('span.tl-asset', { text: a.name }));
      box.append(pair);
    }
    return n ? box : null;
  }
  img(id) {
    const i = el('img', { src: `/api/snapshot/${id}.png`, loading: 'lazy', alt: '' });
    i.onerror = () => i.classList.add('gone');
    return i;
  }
  row(e) {
    const ops = e.type === 'tool' ? (e.ops || []).map((id) => this.entries.get(id)).filter(Boolean) : [];
    const st = e.running ? 'running' : e.ok === false ? 'err' : 'ok';
    const hidden = e.assets?.length && e.assets.every((a) => this.app.isHidden(`${a.kind}:${a.name}`));
    const li = el(`li.tl-entry.${st}${e.source === 'user' ? '.user' : ''}${hidden ? '.is-hidden' : ''}`, { dataset: { id: e.id } },
      el('div.tl-line', {},
        el('span.tl-status', { title: st }),
        el('span.tl-tool', { text: e.type === 'tool' ? e.tool.replace(/^art_/, '') : e.op }),
        e.action ? el('span.tl-action', { text: e.action }) : null,
        el('span.tl-args', { text: this.keyArgs(e.args, e.action ? 'action' : null) }),
        el('span.spacer'),
        e.assets?.some((a) => a.before && a.after) ? el('button.act', { text: '⇆', title: 'Compare before / after', dataset: { act: 'compare' } }) : null,
        (ops.length || Object.keys(e.args || {}).length) ? el('button.act', { text: this.open.has(e.id) ? '▾' : '▸', title: 'Details', dataset: { act: 'expand' } }) : null,
        el('span.tl-ms.mono', { text: e.running ? '…' : fmtMs(e.ms) }),
        el('span.tl-time.mono', { text: fmtTime(e.ts), title: new Date(e.ts).toLocaleString() })),
      e.error ? el('div.tl-error', { text: e.error }) : e.summary ? el('div.tl-summary', { text: e.summary }) : null,
      this.thumbs(e));
    if (this.open.has(e.id)) {
      const det = el('div.tl-details');
      det.append(el('pre', { text: JSON.stringify(e.args, null, 1) }));
      for (const o of ops) det.append(el('div.tl-op', { dataset: { id: o.id } }, el('span.tl-status.' + (o.ok === false ? 'err' : 'ok')), el('span.mono', { text: o.op }), el('span.tl-args', { text: this.keyArgs(o.args) }), el('span.spacer'), el('span.tl-ms.mono', { text: fmtMs(o.ms) }), o.error ? el('div.tl-error', { text: o.error }) : o.summary ? el('div.tl-summary', { text: o.summary }) : null));
      li.append(det);
    }
    return li;
  }
  render() {
    const tools = this.tools();
    const k = tools.join('|');
    if (this.toolSel.dataset.k !== k) {
      this.toolSel.innerHTML = '';
      this.toolSel.append(el('option', { value: '', text: 'all tools' }), ...tools.map((t) => el('option', { value: t, text: t })));
      this.toolSel.dataset.k = k;
    }
    this.toolSel.value = this.f.tool;
    const top = this.topLevel();
    const shown = top.filter((e) => this.passes(e)).reverse().slice(0, MAX_ROWS);
    const errs = top.filter((e) => e.ok === false).length;
    this.count.textContent = `${shown.length}/${top.length}${errs ? ` · ${errs} err` : ''}`;
    const st = this.list.scrollTop;
    const firstId = this.list.firstElementChild?.dataset.id;
    this.list.replaceChildren(...shown.map((e) => this.row(e)));
    if (!shown.length) this.list.append(el('li.empty-row', { text: top.length ? 'No entries match the filters.' : 'Waiting for the agent… every tool call shows up here.' }));
    // keep the reading position when new entries arrive above
    if (st > 0 && firstId) { const old = this.list.querySelector(`[data-id="${firstId}"]`); if (old) this.list.scrollTop = st + old.offsetTop - (this.list.firstElementChild?.offsetTop || 0); }
  }
  onClick(ev) {
    const li = ev.target.closest('.tl-entry');
    if (!li) return;
    const e = this.entries.get(Number(li.dataset.id));
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'expand') { this.open.has(e.id) ? this.open.delete(e.id) : this.open.add(e.id); this.render(); return; }
    if (act === 'compare') {
      const a = e.assets.find((x) => x.before && x.after);
      this.app.compare(this.snapTarget(a, a.before, 'before'), this.snapTarget(a, a.after, 'after'));
      return;
    }
    const pair = ev.target.closest('.tl-pair');
    const a = pair ? e.assets.find((x) => x.name === pair.dataset.name) : e.assets?.find((x) => x.after) || e.assets?.find((x) => !x.deleted && ['canvas', 'model', 'rig', 'audio', 'project'].includes(x.kind));
    if (!a) return;
    const snap = pair && ev.target.tagName === 'IMG' ? (ev.target === pair.querySelector('img') && a.before && a.after ? a.before : a.after || a.before) : a.after;
    this.app.open(snap && !a.deleted ? this.snapTarget(a, snap, `#${e.id}`) : this.app.targetFor(a.kind, a.name));
  }
  snapTarget(a, snap, when) {
    const kind = a.kind === 'rig' ? 'canvas' : a.kind;
    const name = a.kind === 'rig' ? `${a.name}_parts` : a.name;
    return { kind, name, snap, label: when };
  }
}
