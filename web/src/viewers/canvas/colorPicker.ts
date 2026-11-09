// Colour picker (RV5): a swatch button in the canvas toolbar that opens a popover with
// <hex-alpha-color-picker> (vanilla-colorful, loaded on first open), a hex field, palette and recent
// colours, the EyeDropper (when the browser has one) and the system colour dialog.
import { h } from '@/lib/util/dom';
import { store } from '@/lib/util/storage';

/** '#rgb' | '#rrggbb' | '#rrggbbaa' (with or without '#', any case) -> '#rrggbbaa', else null. */
export function parseHex(text: string): string | null {
  const s = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return '#' + [...s].map((c) => c + c).join('') + 'ff';
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s + 'ff';
  if (/^[0-9a-f]{8}$/.test(s)) return '#' + s;
  return null;
}

/** Newest first, deduplicated (case-insensitive), at most max. */
export function pushRecent(list: readonly string[], hex: string, max = 12): string[] {
  const v = hex.toLowerCase();
  return [v, ...list.filter((x) => x.toLowerCase() !== v)].slice(0, max);
}

export const RECENT_KEY = 'recentColors';
export const readRecent = (): string[] => { const v = store.get<unknown>(RECENT_KEY, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!parseHex(x)).slice(0, 12) : []; };
export function rememberColor(hex8: string): void { store.set(RECENT_KEY, pushRecent(readRecent(), hex8)); }

let pickerChunk: Promise<unknown> | null = null;
const loadPicker = () => (pickerChunk ??= import('vanilla-colorful/hex-alpha-color-picker.js'));

type PickerEl = HTMLElement & { color: string };
type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

export interface ColorPickerOptions {
  getColor(): string;                   // #rrggbbaa
  setColor(hex8: string): void;
  palette(): { name: string; hex: string }[];
  toast(text: string, kind?: 'info' | 'ok' | 'error'): void;
}

export class ColorPicker {
  readonly button: HTMLButtonElement;
  private pop: HTMLElement;
  private native: HTMLInputElement;
  private hexIn: HTMLInputElement;
  private pickerHost: HTMLElement;
  private picker: PickerEl | null = null;
  private palRow: HTMLElement;
  private recentRow: HTMLElement;
  private failed = false;
  private abort = new AbortController();

  constructor(private root: HTMLElement, private o: ColorPickerOptions) {
    const signal = this.abort.signal;
    this.button = h('button', { type: 'button', class: 'btn color-swatch', 'aria-haspopup': 'dialog', on: { click: () => this.toggle() } }, h('span', { class: 'color-chip' }));
    this.native = h('input', { type: 'color', class: 'native-color', tabindex: '-1', 'aria-hidden': 'true', on: { input: () => this.o.setColor(this.native.value + this.o.getColor().slice(7, 9)) } });
    this.hexIn = h('input', { class: 'mono hex-in', 'aria-label': 'Hex colour', spellcheck: 'false', autocomplete: 'off', on: {
      input: () => {
        const v = parseHex(this.hexIn.value);
        this.hexIn.setAttribute('aria-invalid', v ? 'false' : 'true');
        if (v) this.o.setColor(v);
      },
      keydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); this.hide(); } },
    } });
    this.pickerHost = h('div', { class: 'picker-host' });
    this.palRow = h('div', { class: 'palette' });
    this.recentRow = h('div', { class: 'palette recent' });
    const eye = 'EyeDropper' in window ? h('button', { type: 'button', class: 'btn small', text: 'Pick from screen', on: { click: () => void this.eyeDrop() } }) : null;
    this.pop = h('div', { class: 'color-pop', popover: 'auto', role: 'dialog', 'aria-label': 'Colour' },
      this.pickerHost,
      h('label', { class: 'row-inline' }, h('span', { class: 'muted small', text: 'Hex' }), this.hexIn),
      h('div', { class: 'panel-label', text: 'Palette' }), this.palRow,
      h('div', { class: 'panel-label', text: 'Recent' }), this.recentRow,
      h('div', { class: 'row-inline' }, eye, h('button', { type: 'button', class: 'btn small ghost', text: 'System picker…', on: { click: () => this.native.click() } })),
    );
    this.pop.addEventListener('toggle', (e) => {
      const open = (e as ToggleEvent).newState === 'open';
      this.button.setAttribute('aria-expanded', String(open));
      const a = document.activeElement;
      if (!open && (!a || a === document.body || this.pop.contains(a))) this.button.focus();
    }, { signal });
    root.append(this.pop, this.native);
    this.sync(this.o.getColor());
  }

  get isOpen(): boolean { try { return this.pop.matches(':popover-open'); } catch { return false; } }

  async toggle(): Promise<void> {
    if (this.isOpen) { this.hide(); return; }
    if (this.failed) { this.native.click(); return; }
    try { await loadPicker(); } catch {
      this.failed = true;
      this.o.toast('Colour picker could not load; using the system colour dialog', 'error');
      this.native.click();
      return;
    }
    if (!this.picker) {
      this.picker = document.createElement('hex-alpha-color-picker') as PickerEl;
      this.picker.addEventListener('color-changed', (e) => {
        const v = parseHex(String((e as CustomEvent<{ value: string }>).detail?.value ?? ''));
        if (v && v !== this.o.getColor()) this.o.setColor(v);
      }, { signal: this.abort.signal });
      this.pickerHost.append(this.picker);
    }
    this.fillRows();
    this.sync(this.o.getColor());
    try { this.pop.showPopover(); } catch { this.pop.setAttribute('data-open', ''); }
    this.place();
    this.picker.focus?.();
  }
  hide(): void { try { this.pop.hidePopover(); } catch { this.pop.removeAttribute('data-open'); } }

  private place(): void {
    const b = this.button.getBoundingClientRect(), p = this.pop.getBoundingClientRect();
    let top = b.bottom + 4;
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, b.top - p.height - 4);
    const left = Math.max(8, Math.min(b.left, window.innerWidth - p.width - 8));
    Object.assign(this.pop.style, { position: 'fixed', top: `${top}px`, left: `${left}px`, margin: '0' });
  }

  private fillRows(): void {
    const sw = (hex: string, title: string) => h('button', { type: 'button', class: 'swatch', title, 'aria-label': title, style: { '--c': hex } as Record<string, string>, dataset: { color: hex }, on: { click: () => { const v = parseHex(hex); if (v) this.o.setColor(v); } } });
    this.palRow.replaceChildren(...this.o.palette().map((p) => sw(p.hex, `${p.name}  ${p.hex}`)));
    const rec = readRecent();
    this.recentRow.replaceChildren(...(rec.length ? rec.map((x) => sw(x, x)) : [h('span', { class: 'muted small', text: 'Colours you paint with show up here.' })]));
  }

  /** Show a colour (from the app) in the swatch, the picker (when open) and the hex field (unless focused). */
  sync(hex8: string): void {
    this.button.dataset.color = hex8;
    this.button.setAttribute('aria-label', `Colour ${hex8}`);
    this.button.title = `Colour ${hex8}`;
    (this.button.firstElementChild as HTMLElement).style.setProperty('--c', hex8);
    this.native.value = hex8.slice(0, 7);
    if (document.activeElement !== this.hexIn) { this.hexIn.value = hex8; this.hexIn.setAttribute('aria-invalid', 'false'); }
    if (this.picker && this.isOpen && parseHex(this.picker.color || '') !== hex8) this.picker.color = hex8;
  }

  /** After a successful draw: refresh the recent row if it is visible. */
  painted(hex8: string): void { rememberColor(hex8); if (this.isOpen) this.fillRows(); }

  private async eyeDrop(): Promise<void> {
    try {
      const ED = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
      const r = await new ED().open();
      const v = parseHex(r.sRGBHex);
      if (v) this.o.setColor(v.slice(0, 7) + this.o.getColor().slice(7, 9));
    } catch { /* cancelled */ }
  }

  destroy(): void { this.abort.abort(); this.hide(); this.pop.remove(); this.native.remove(); this.picker = null; }
}
