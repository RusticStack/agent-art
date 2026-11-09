// HTTP helpers: JSON GET / POST with error mapping, the per-process UI token, binary loads.

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly op?: string) { super(message); this.name = 'ApiError'; }
}

const TOKEN_HEADER = 'x-agent-art-ui';
const TOKEN_META = /<meta name="agent-art-ui-token" content="([^"]*)"/;
let tokenOverride: string | null = null;

/** In-memory override (after a server restart), else the page's meta tag, else ''. Read at call time. */
export function uiToken(): string {
  if (tokenOverride !== null) return tokenOverride;
  if (typeof document === 'undefined') return '';
  return document.querySelector<HTMLMetaElement>('meta[name="agent-art-ui-token"]')?.content || '';
}

/** GET / and take the token from its meta tag; true when it changed. Also returns the entry script URL. */
export async function refreshUiToken(): Promise<boolean> {
  const before = uiToken();
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    lastIndexHtml = html;
    const m = html.match(TOKEN_META);
    if (m) tokenOverride = m[1];
  } catch { return false; }
  return uiToken() !== before;
}
let lastIndexHtml = '';
/** The last page HTML fetched by refreshUiToken (used to detect a newer UI build). */
export const lastFetchedIndex = () => lastIndexHtml;
/** Tests only. */
export function _resetToken() { tokenOverride = null; lastIndexHtml = ''; }

async function readJson(r: Response): Promise<unknown> {
  try { return await r.json(); } catch { return undefined; }
}

export async function getJSON<T>(url: string, init: { signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(url, { signal: init.signal });
  const j = (await readJson(r)) as { ok?: boolean; error?: string } | undefined;
  if (j === undefined) throw new ApiError(`HTTP ${r.status}`, r.status);
  if (!r.ok || (j && typeof j === 'object' && j.ok === false)) throw new ApiError((j && typeof j === 'object' && j.error) || `HTTP ${r.status}`, r.status);
  return j as T;
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: uiToken() }, body: JSON.stringify(body) });
  const j = (await readJson(r)) as T | undefined;
  if (j === undefined) throw new ApiError(`HTTP ${r.status}`, r.status);
  if (!r.ok) throw new ApiError(((j as { error?: string })?.error) || `HTTP ${r.status}`, r.status);
  return j;
}

async function errorOf(r: Response, url: string): Promise<ApiError> {
  let msg = `HTTP ${r.status} for ${url}`;
  if ((r.headers.get('content-type') || '').includes('json')) { const j = (await readJson(r)) as { error?: string } | undefined; if (j?.error) msg = j.error; }
  return new ApiError(msg, r.status);
}

export async function getBitmap(url: string, init: { signal?: AbortSignal } = {}): Promise<ImageBitmap> {
  const r = await fetch(url, { signal: init.signal });
  if (!r.ok) throw await errorOf(r, url);
  return createImageBitmap(await r.blob());
}

export async function getArrayBuffer(url: string, init: { signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal: init.signal });
  if (!r.ok) throw await errorOf(r, url);
  return r.arrayBuffer();
}

export async function getText(url: string, init: { signal?: AbortSignal } = {}): Promise<string> {
  const r = await fetch(url, { signal: init.signal });
  if (!r.ok) throw await errorOf(r, url);
  return r.text();
}

export const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
