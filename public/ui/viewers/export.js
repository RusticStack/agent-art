// Exported file preview (workspace/exports): images zoom like canvases, spritesheet PNG + JSON
// show frames and anchors, GIFs animate, JSON is pretty-printed; .glb and audio files open in the
// 3D and audio viewers (the app routes those).
import { el, enc, getJSON, loadBitmap, fmtBytes } from '../util.js';
import { PixelView } from './pixel.js';
import { SheetViewer } from './sheet.js';

export class ExportViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.host = host;
    this.root = el('div.viewer.export-viewer');
    host.append(this.root);
  }
  async open(target) {
    this.root.innerHTML = '';
    this.pv?.destroy(); this.pv = null;
    this.sheet?.destroy(); this.sheet = null;
    const p = target.name;
    const url = `/api/export-file?path=${enc(p)}`;
    const meta = (this.ctx.app.assets?.exports || []).find((x) => x.path === p);
    const head = el('div.vtoolbar', {}, el('span.mono', { text: p }), el('span.muted', { text: meta ? `${fmtBytes(meta.size)} · ${new Date(meta.mtime).toLocaleString()}` : '' }), el('div.spacer'), el('a.btn', { href: url + '&download=1', download: p.split('/').pop(), text: 'Download' }));
    this.root.append(head);
    const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const sibling = (e) => (this.ctx.app.assets?.exports || []).some((x) => x.path === p.replace(/\.[a-z0-9]+$/i, '.' + e));
    if ((ext === 'png' && sibling('json')) || (ext === 'json' && sibling('png'))) {
      const j = ext === 'json' ? await getJSON(url).catch(() => null) : null;
      if (ext === 'png' || j?.frames) {
        const host = el('div.fill');
        this.root.append(host);
        this.sheet = new SheetViewer(host, this.ctx);
        await this.sheet.open({ kind: 'export', name: p });
        return;
      }
    }
    if (ext === 'png') {
      const host = el('div.stage');
      this.root.append(host);
      this.pv = new PixelView(host, { editable: false });
      this.pv.setImage(await loadBitmap(url));
      return;
    }
    if (ext === 'gif') { this.root.append(el('div.center-scroll', {}, el('img.pixelated.big', { src: url, alt: p }))); return; }
    if (['json', 'mcmeta', 'txt'].includes(ext)) {
      const text = await (await fetch(url)).text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* plain text */ }
      this.root.append(el('pre.file-text', { text: pretty.length > 400000 ? pretty.slice(0, 400000) + '\n…' : pretty }));
      return;
    }
    this.root.append(el('div.empty-note', { text: `No preview for .${ext} files.` }));
  }
  onEvent() {}
  keydown() { return false; }
  destroy() { this.pv?.destroy(); this.sheet?.destroy(); this.root.remove(); }
}
