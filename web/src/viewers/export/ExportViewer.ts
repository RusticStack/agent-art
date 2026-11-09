// Exported file preview (workspace/exports): images zoom like canvases, spritesheet PNG + JSON show
// frames and anchors, GIFs animate, JSON is pretty-printed and syntax-coloured; .glb and audio files
// open in the 3D and audio viewers (the registry routes those).
import { api } from '@/lib/api/client';
import { getBitmap, getText, isAbort } from '@/lib/api/http';
import { exportFile } from '@/lib/api/urls';
import { h, renderJson } from '@/lib/util/dom';
import { fmtBytes } from '@/lib/util/format';
import { BaseViewer } from '../base';
import { button, link, spacer } from '../controls';
import { PixelView } from '../pixel/PixelView';
import { SheetViewer } from '../sheet/SheetViewer';
import type { Target } from '../types';
import { extOf, prettyText, previewKindFor } from './logic';

export class ExportViewer extends BaseViewer {
  private pv: PixelView | null = null;
  private sheet: SheetViewer | null = null;
  private abort: AbortController | null = null;
  private dims: HTMLElement | null = null;

  protected build(): HTMLElement {
    this.addCleanup(() => this.clear());
    return h('div', { class: 'viewer export-viewer' });
  }

  private clear(): void {
    this.abort?.abort();
    this.pv?.destroy(); this.pv = null;
    this.sheet?.destroy(); this.sheet = null;
    this.root?.replaceChildren();
  }

  protected async load(target: Target): Promise<void> {
    const token = this.nextLoad();
    this.clear();
    const ac = (this.abort = new AbortController());
    const p = (target as { name: string }).name;
    const url = exportFile(p);
    const exportsList = this.host.assets()?.exports || [];
    const meta = exportsList.find((x) => x.path === p);
    this.dims = h('span', { class: 'muted' });
    this.root.append(h('div', { class: 'vtoolbar' },
      h('span', { class: 'mono', text: p }),
      h('span', { class: 'muted', text: meta ? `${fmtBytes(meta.size)} · ${new Date(meta.mtime).toLocaleString()}` : '' }),
      this.dims, spacer(),
      Object.assign(link({ text: 'Download', download: p.split('/').pop() }), { href: exportFile(p, { download: true }) })));
    const kind = previewKindFor(p, exportsList.map((x) => x.path));
    try {
      if (kind === 'sheet' || kind === 'sheet-json') {
        const j = kind === 'sheet-json' ? await api.exportJSON<{ frames?: unknown }>(p, ac.signal).catch(() => null) : null;
        if (!this.isCurrent(token)) return;
        if (kind === 'sheet' || j?.frames) {
          const host = h('div', { class: 'fill' });
          this.root.append(host);
          this.sheet = new SheetViewer(this.host);
          await this.sheet.mount(host, { target: { kind: 'export', name: p }, env: this.env });
          return;
        }
      }
      if (kind === 'image') {
        const host = h('div', { class: 'stage' });
        this.root.append(host);
        this.pv = new PixelView(host, { editable: false });
        const bmp = await getBitmap(url, { signal: ac.signal });
        if (!this.isCurrent(token)) { bmp.close?.(); return; }
        this.pv.setImage(bmp);
        this.pv.setLabel(p);
        this.dims.textContent = `${bmp.width}×${bmp.height}`;
        return;
      }
      if (kind === 'gif') {
        const img = h('img', { class: 'pixelated big', src: url, alt: p });
        img.addEventListener('load', () => { if (this.dims) this.dims.textContent = `${img.naturalWidth}×${img.naturalHeight}`; }, { once: true });
        this.root.append(h('div', { class: 'center-scroll' }, img));
        return;
      }
      if (kind === 'text' || kind === 'sheet-json') {
        const raw = await getText(url, { signal: ac.signal });
        if (!this.isCurrent(token)) return;
        const { text, json } = prettyText(raw);
        const pre = h('pre', { class: 'file-text' });
        if (json) renderJson(pre, text); else pre.textContent = text;
        const copy = button({ text: 'Copy', small: true, title: 'Copy the text', onClick: () => { void navigator.clipboard?.writeText(text).then(() => this.host.toast('Copied', 'ok'), () => this.host.toast('Could not copy', 'error')); } });
        this.root.querySelector('.vtoolbar')?.append(copy);
        this.root.append(pre);
        return;
      }
      this.root.append(h('div', { class: 'empty-note', text: `No preview for .${extOf(p)} files.` }));
    } catch (e) {
      if (isAbort(e) || !this.isCurrent(token)) return;
      this.root.append(h('div', { class: 'empty-note', text: (e as Error).message }));
      throw e;
    }
  }

  onEvent(): void { /* exports are static files; resync is ignored */ }
  onKey(e: KeyboardEvent, k: string): boolean { return this.sheet?.onKey?.(e, k) ?? false; }
}
