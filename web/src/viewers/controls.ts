// Toolbar building blocks for viewer-built DOM (classes styled by base.css / viewers.css).
import { h, icon } from '@/lib/util/dom';
import type { IconName } from '@/lib/util/icons';

export function button(o: { text?: string; icon?: IconName; title: string; small?: boolean; variant?: 'primary' | 'warn' | 'ok'; className?: string; onClick(e: MouseEvent): void }): HTMLButtonElement {
  const cls = ['btn', o.small ? 'small' : '', o.variant ?? '', o.icon && !o.text ? 'icon' : '', o.className ?? ''].filter(Boolean).join(' ');
  const b = h('button', { type: 'button', class: cls, title: o.title, on: { click: (e: Event) => o.onClick(e as MouseEvent) } });
  if (o.icon) b.append(icon(o.icon));
  if (o.text) b.append(o.icon ? ' ' + o.text : o.text);
  if (o.icon && !o.text) b.setAttribute('aria-label', o.title);
  return b;
}

/** a.btn with download; set href later. */
export function link(o: { text: string; title?: string; download?: string; small?: boolean }): HTMLAnchorElement {
  return h('a', { class: o.small ? 'btn small' : 'btn', text: o.text, title: o.title, download: o.download ?? '' });
}

export function toggle(o: { label: string; title?: string; checked?: boolean; onChange(checked: boolean): void }): { el: HTMLLabelElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', on: { change: () => o.onChange(input.checked) } });
  input.checked = !!o.checked;
  const el = h('label', { class: 'toggle', title: o.title }, input, ' ' + o.label);
  return { el, input };
}

export function select(o: { title?: string; className?: string; onChange(value: string): void }): HTMLSelectElement {
  const s = h('select', { title: o.title, 'aria-label': o.title, class: o.className, on: { change: () => o.onChange(s.value) } });
  return s;
}

export interface Option { value: string; label: string }

/** Replace the options unless the list is unchanged; keeps the current (or `keep`) value when still valid. */
export function fillSelect(sel: HTMLSelectElement, items: Option[], o: { keep?: string; first?: Option } = {}): void {
  const all = o.first ? [o.first, ...items] : items;
  const sig = JSON.stringify(all.map((i) => [i.value, i.label]));
  const want = o.keep ?? sel.value;
  if ((sel as HTMLSelectElement & { _sig?: string })._sig === sig) {
    if (o.keep !== undefined && all.some((i) => i.value === o.keep)) sel.value = o.keep;
    return;
  }
  (sel as HTMLSelectElement & { _sig?: string })._sig = sig;
  sel.replaceChildren(...all.map((i) => h('option', { value: i.value, text: i.label })));
  sel.value = all.some((i) => i.value === want) ? want : all[0]?.value ?? '';
}

export function range(o: { min: number; max: number; step?: number; value: number; title?: string; className?: string; onInput(value: number): void }): HTMLInputElement {
  const r = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: o.step !== undefined ? String(o.step) : undefined, title: o.title, 'aria-label': o.title, class: o.className, on: { input: () => o.onInput(Number(r.value)) } });
  r.value = String(o.value);
  return r;
}

export function group(...kids: (Node | null | false | undefined)[]): HTMLDivElement {
  return h('div', { class: 'group' }, ...kids);
}
export const spacer = (): HTMLDivElement => h('div', { class: 'spacer' });
export const label = (text: string): HTMLSpanElement => h('span', { class: 'muted', text });
