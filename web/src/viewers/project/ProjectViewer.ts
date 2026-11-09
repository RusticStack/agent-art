// Project overview: every canvas of a project as a grid of lazily loaded thumbnails (live: the tile the
// agent changes flashes and scrolls into view; new canvases appear with a green outline).
import type { AnyEvent, ProjectInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { thumbUrl } from '@/lib/api/urls';
import { h } from '@/lib/util/dom';
import { store } from '@/lib/util/storage';
import { BaseViewer } from '../base';
import { range, spacer } from '../controls';
import type { Target } from '../types';
import { descriptionLine, planTileUpdate, shouldAutoScroll } from './logic';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ProjectViewer extends BaseViewer {
  private name = '';
  private p: ProjectInfo | null = null;
  private tiles = new Map<string, HTMLButtonElement>();
  private titleEl!: HTMLElement;
  private desc!: HTMLElement;
  private grid!: HTMLElement;
  private scroll!: HTMLElement;
  private lastUserScroll = 0;
  private programmaticScroll = false;

  protected build(): HTMLElement {
    const size = range({ min: 32, max: 256, step: 16, value: store.get('ovSize', 96), title: 'Tile size', onInput: (v) => { this.grid.style.setProperty('--ov', v + 'px'); store.set('ovSize', v); } });
    this.titleEl = h('h1');
    this.desc = h('p', { class: 'muted' });
    this.grid = h('div', { class: 'ov-grid', role: 'list' });
    this.grid.style.setProperty('--ov', size.value + 'px');
    this.scroll = h('div', { class: 'ov-scroll', on: { scroll: () => { if (!this.programmaticScroll) this.lastUserScroll = Date.now(); }, wheel: () => { this.lastUserScroll = Date.now(); } } }, this.desc, this.grid);
    return h('div', { class: 'viewer project-viewer' },
      h('div', { class: 'vtoolbar' }, this.titleEl, spacer(), h('label', { class: 'toggle' }, 'Size ', size)),
      this.scroll);
  }

  protected async load(target: Target): Promise<void> {
    const token = this.nextLoad();
    this.name = (target as { name: string }).name;
    let p: ProjectInfo;
    try { p = await api.project(this.name); } catch (e) {
      if (!this.isCurrent(token)) return;
      this.titleEl.textContent = (e as Error).message;
      throw e;
    }
    if (!this.isCurrent(token)) return;
    this.p = p;
    this.titleEl.textContent = p.name;
    this.grid.replaceChildren();
    this.tiles.clear();
    const versions = new Map((this.host.assets()?.canvases || []).map((c) => [c.name, c.version]));
    let hidden = 0;
    for (const c of p.canvases) {
      if (this.host.isHidden(`canvas:${c.name}`)) { hidden++; continue; }
      this.tile(c.name, versions.get(c.name), c.meta?.texture);
    }
    this.desc.textContent = descriptionLine(p, hidden);
  }

  private tile(name: string, version: string | number | undefined, texture?: string | string[] | null, isNew = false): HTMLButtonElement {
    let t = this.tiles.get(name);
    if (!t) {
      t = h('button', { type: 'button', class: 'ov-tile' + (isNew ? ' new' : ''), title: name, on: { click: () => this.host.open({ kind: 'canvas', name }) } },
        h('img', { alt: '', loading: 'lazy' }), h('span', { class: 'n', text: name }), h('span', { class: 't' }));
      t.style.setProperty('content-visibility', 'auto');
      this.grid.append(h('div', { role: 'listitem', class: 'ov-item' }, t));
      this.tiles.set(name, t);
    }
    if (texture !== undefined) t.querySelector('.t')!.textContent = ([] as string[]).concat(texture || []).join(', ');
    t.querySelector('img')!.src = thumbUrl('canvas', name, version ?? Date.now())!;
    return t;
  }

  onEvent(ev: AnyEvent): void {
    if (!this.name) return;
    const plan = planTileUpdate(ev, this.name, new Set(this.tiles.keys()), (id) => this.host.isHidden(id));
    if (plan.action === 'reload') { this.later(300, () => { void Promise.resolve(this.load({ kind: 'project', name: this.name })).catch(() => {}); }, 'reload'); return; }
    if (plan.action === 'remove') { this.tiles.get(plan.name)?.parentElement?.remove(); this.tiles.delete(plan.name); return; }
    if (plan.action !== 'update') return;
    const t = this.tile(plan.name, plan.version, undefined, plan.isNew);
    if (!plan.flash) return;
    t.classList.add('flash');
    this.later(900, () => t.classList.remove('flash'));
    if (shouldAutoScroll(this.host.followMode?.() ?? 'canvas', this.lastUserScroll, Date.now()) && typeof t.scrollIntoView === 'function') {
      this.programmaticScroll = true;
      t.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      this.later(600, () => { this.programmaticScroll = false; }, 'pscroll');
    }
  }

  onKey(): boolean { return false; }
  debugInfo(): unknown { return { name: this.name, tiles: this.tiles.size }; }
}
