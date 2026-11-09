// Test doubles: a scripted fetch and a controllable EventSource.
import { vi } from 'vitest';
import type { AssetIndex, CanvasSummary } from '@/lib/api/types';

export interface FakeResponse { status?: number; json?: unknown; text?: string; contentType?: string; body?: Blob; bytes?: Uint8Array }
type Route = FakeResponse | ((url: string, init?: RequestInit) => FakeResponse);

/** Install a fetch that answers by URL prefix (longest match first). Returns the calls. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const r = routes[key];
    const spec = typeof r === 'function' ? r(url, init) : r;
    const status = spec.status ?? 200;
    if (spec.json !== undefined) return new Response(JSON.stringify(spec.json), { status, headers: { 'content-type': spec.contentType ?? 'application/json' } });
    if (spec.bytes) return new Response(spec.bytes as unknown as BodyInit, { status, headers: { 'content-type': spec.contentType ?? 'application/octet-stream' } });
    if (spec.body) return new Response(spec.body, { status, headers: { 'content-type': spec.contentType ?? 'application/octet-stream' } });
    return new Response(spec.text ?? '', { status, headers: { 'content-type': spec.contentType ?? 'text/plain' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent); }
  hello() { this.emit({ type: 'hello', ts: 1 }); }
  error() { this.onerror?.(new Event('error')); }
  static last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]; }
  static reset() { FakeEventSource.instances = []; }
  static make = (url: string) => new FakeEventSource(url) as unknown as EventSource;
}

export function canvasSummary(name: string, o: Partial<CanvasSummary> = {}): CanvasSummary {
  return { name, project: null, width: 16, height: 16, frames: 1, layers: [{ name: 'base', visible: true }], animations: [], version: '1', updated: 0, kind: 'canvas', ...o };
}

export function assetIndex(o: Partial<AssetIndex> = {}): AssetIndex {
  return { canvases: [], rigs: [], models: [], audio: [], projects: [], groups: [], exports: [], home: '/h', flags: { superseded: [], orphans: [] }, tags: {}, ...o };
}
