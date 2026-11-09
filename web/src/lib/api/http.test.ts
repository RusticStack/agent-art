// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '@/test/fakes';
import { onToast } from '@/lib/util/notify';
import { ApiError, _resetToken, getArrayBuffer, getJSON, getText, postJSON, refreshUiToken, uiToken } from './http';
import { api, op } from './client';

function setMeta(v: string | null) {
  document.head.querySelector('meta[name="agent-art-ui-token"]')?.remove();
  if (v !== null) { const m = document.createElement('meta'); m.name = 'agent-art-ui-token'; m.content = v; document.head.appendChild(m); }
}
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string>)[name];

describe('http', () => {
  beforeEach(() => { _resetToken(); setMeta('tok1'); });
  afterEach(() => { vi.unstubAllGlobals(); onToast(null); });

  it('getJSON maps errors', async () => {
    fakeFetch({
      '/ok': { json: { a: 1 } },
      '/bad': { status: 400, json: { ok: false, error: 'bad thing' } },
      '/soft': { json: { ok: false, error: 'soft fail' } },
      '/boom': { status: 500, text: '<html>oops' },
    });
    expect(await getJSON('/ok')).toEqual({ a: 1 });
    await expect(getJSON('/bad')).rejects.toMatchObject({ message: 'bad thing', status: 400 });
    await expect(getJSON('/soft')).rejects.toMatchObject({ message: 'soft fail', status: 200 });
    await expect(getJSON('/missing')).rejects.toMatchObject({ message: 'HTTP 404', status: 404 });
    await expect(getJSON('/boom')).rejects.toMatchObject({ message: 'HTTP 500', status: 500 });
    await expect(getJSON('/boom')).rejects.toBeInstanceOf(ApiError);
  });

  it('binary loads read a JSON error body', async () => {
    fakeFetch({ '/t': { text: 'hello' }, '/e': { status: 404, json: { error: 'snapshot expired' } }, '/b': { bytes: new Uint8Array([1, 2, 3]) } });
    expect(await getText('/t')).toBe('hello');
    expect(new Uint8Array(await getArrayBuffer('/b'))).toEqual(new Uint8Array([1, 2, 3]));
    await expect(getText('/e')).rejects.toMatchObject({ message: 'snapshot expired', status: 404 });
    await expect(getArrayBuffer('/nope')).rejects.toMatchObject({ message: 'HTTP 404 for /nope' });
  });

  it('postJSON sends content type and the token, read at call time', async () => {
    const { calls } = fakeFetch({ '/p': { json: { ok: true } } });
    await postJSON('/p', { x: 1 });
    expect(header(calls[0].init, 'content-type')).toBe('application/json');
    expect(header(calls[0].init, 'x-agent-art-ui')).toBe('tok1');
    expect(calls[0].init?.body).toBe('{"x":1}');
    setMeta('tok2');
    await postJSON('/p', {});
    expect(header(calls[1].init, 'x-agent-art-ui')).toBe('tok2');
    setMeta(null);
    await postJSON('/p', {});
    expect(header(calls[2].init, 'x-agent-art-ui')).toBe('');
  });

  it('refreshUiToken parses the meta tag and overrides the page', async () => {
    fakeFetch({ '/': { text: '<html><head><meta name="agent-art-ui-token" content="fresh"></head></html>', contentType: 'text/html' } });
    expect(uiToken()).toBe('tok1');
    expect(await refreshUiToken()).toBe(true);
    expect(uiToken()).toBe('fresh');
    expect(await refreshUiToken()).toBe(false);
  });

  it('op: success, failure toasts once with ApiError.op', async () => {
    const toasts: [string, string][] = [];
    onToast((t, k) => toasts.push([t, k]));
    const { calls } = fakeFetch({ '/api/op': (_u, init) => {
      const b = JSON.parse(String(init?.body));
      return b.op === 'undo' ? { json: { ok: true, result: { done: 1 } } } : { json: { ok: false, error: 'no such canvas' } };
    } });
    expect(await op('undo', { canvas: 'a' })).toEqual({ done: 1 });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ op: 'undo', args: { canvas: 'a' }, source: 'user' });
    const err = await op('draw', { canvas: 'x', commands: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.op).toBe('draw');
    expect(err.message).toBe('no such canvas');
    expect(toasts).toEqual([['draw: no such canvas', 'error']]);
    await op('draw', { canvas: 'x', commands: [] }, { quiet: true }).catch(() => null);
    expect(toasts.length).toBe(1);
  });

  it('cleanup_config refreshes the token once and retries once', async () => {
    let n = 0;
    const { calls } = fakeFetch({
      '/api/op': (_u, init) => (header(init, 'x-agent-art-ui') === 'new' ? { json: { ok: true, result: { allow_paths: [] } } } : (n++, { json: { ok: false, error: 'allow_paths can only be set by the user' } })),
      '/': { text: '<meta name="agent-art-ui-token" content="new">' },
    });
    expect(await op('cleanup_config', { trash_deletes: true })).toEqual({ allow_paths: [] });
    expect(n).toBe(1);
    expect(calls.filter((c) => c.url === '/api/op').length).toBe(2);
  });

  it('cleanup_config gives up when the token does not change', async () => {
    onToast(() => {});
    const { calls } = fakeFetch({ '/api/op': { json: { ok: false, error: 'set by the user only' } }, '/': { text: '<meta name="agent-art-ui-token" content="tok1">' } });
    await expect(op('cleanup_config', {})).rejects.toBeInstanceOf(ApiError);
    expect(calls.filter((c) => c.url === '/api/op').length).toBe(1);
  });

  it('api builds endpoint URLs', async () => {
    const { calls } = fakeFetch({ '/api/': { json: { entries: [], seq: 0 } } });
    await api.activity({ since: 5, limit: 1500 });
    await api.activity();
    await api.rigLayers('my rig', { view: 'side', tag: undefined });
    await api.graphNode('canvas:a b');
    await api.audioAnalysis('s', 'spectrum');
    await api.exportJSON('sub/a.json');
    expect(calls.map((c) => c.url)).toEqual([
      '/api/activity?since=5&limit=1500', '/api/activity', '/api/rig/my%20rig/layers?view=side', '/api/graph/node?id=canvas%3Aa%20b',
      '/api/audio/s/analysis?view=spectrum', '/api/export-file?path=sub%2Fa.json',
    ]);
  });
});
