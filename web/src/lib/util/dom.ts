// DOM helpers for viewer-built DOM: h() element builder, SVG icons, theme colours, JSON rendering.
import { ICONS, type IconName } from './icons';
import { JSON_CLASS, tokenizeJson } from './jsonTokens';

type Listener = (e: Event) => void;
export interface HProps {
  text?: string | number;
  on?: Record<string, Listener | ((e: never) => void)>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string | undefined>;
  [attr: string]: unknown;
}
export type HChild = Node | string | number | null | undefined | false | HChild[];

/**
 * h('div.cls#id', {attrs, on:{click}}, ...children). Text always goes through textContent.
 * Props whose value is undefined / null / false are skipped; true sets an empty attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}${'.' | '#'}${string}`, props?: HProps | null, ...kids: HChild[]): HTMLElementTagNameMap[K];
export function h(spec: string, props?: HProps | null, ...kids: HChild[]): HTMLElement;
export function h(spec: string, props: HProps | null = {}, ...kids: HChild[]): HTMLElement {
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, Listener>)) node.addEventListener(ev, fn);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v as Record<string, string | undefined>)) if (dv !== undefined) node.dataset[dk] = dv; }
    else if (k === 'class') node.className = String(v);
    else if (k in node && typeof v !== 'string') (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  appendKids(node, kids);
  return node;
}

function appendKids(node: Node, kids: HChild[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) appendKids(node, k);
    else node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/** span.icon with an inline Lucide SVG (a build-time constant). */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'icon' + (cls ? ' ' + cls : '');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

export interface ThemeColors {
  stage: string; canvasBg: string; checkerA: string; checkerB: string; accent: string; blue: string; green: string; red: string;
  muted: string; text: string; line: string; line2: string; panel: string; bg2: string;
}
const FALLBACK: ThemeColors = { stage: '#101216', canvasBg: '#15171c', checkerA: '#3a3d44', checkerB: '#2c2f35', accent: '#f5a524', blue: '#38bdf8', green: '#22c55e', red: '#e5484d', muted: '#8b93a1', text: '#e6e9ef', line: '#2a2f38', line2: '#353b46', panel: '#1a1d23', bg2: '#15171c' };

/** Chrome colours for canvas drawing, read from the CSS tokens once per call. */
export function themeColors(): ThemeColors {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return { ...FALLBACK };
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, d: string) => cs.getPropertyValue(name).trim() || d;
  return {
    stage: v('--stage', FALLBACK.stage), canvasBg: v('--canvas-bg', FALLBACK.canvasBg), checkerA: v('--checker-a', FALLBACK.checkerA), checkerB: v('--checker-b', FALLBACK.checkerB),
    accent: v('--accent', FALLBACK.accent), blue: v('--blue', FALLBACK.blue), green: v('--green', FALLBACK.green), red: v('--red', FALLBACK.red),
    muted: v('--muted', FALLBACK.muted), text: v('--text', FALLBACK.text), line: v('--line', FALLBACK.line), line2: v('--line2', FALLBACK.line2),
    panel: v('--panel', FALLBACK.panel), bg2: v('--bg2', FALLBACK.bg2),
  };
}

/** Fill a <pre> with syntax-coloured JSON (one span per token, textContent only). */
export function renderJson(pre: HTMLElement, text: string, maxChars = 200_000): void {
  pre.replaceChildren();
  pre.classList.add('json');
  if (text.length > maxChars) { pre.textContent = text; return; }
  const frag = document.createDocumentFragment();
  for (const tok of tokenizeJson(text)) {
    const cls = JSON_CLASS[tok.t];
    if (!cls) { frag.appendChild(document.createTextNode(tok.v)); continue; }
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = tok.v;
    frag.appendChild(s);
  }
  pre.appendChild(frag);
}
