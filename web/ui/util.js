// Shared helpers for the legacy web UI: a thin re-export of the TypeScript modules in web/src/lib,
// so legacy and new code share one implementation.
import { h } from '../src/lib/util/dom.ts';
import { op } from '../src/lib/api/client.ts';
import { getBitmap } from '../src/lib/api/http.ts';

export const $ = (id) => document.getElementById(id);
export const enc = encodeURIComponent;

/** el('div.cls#id', {attrs, on:{click}}, ...children) */
export const el = h;

export { toast, onToast } from '../src/lib/util/notify.ts';
export { getJSON, postJSON } from '../src/lib/api/http.ts';
export { store } from '../src/lib/util/storage.ts';
export { debounce, clamp, fmtMs, fmtTime, fmtBytes } from '../src/lib/util/format.ts';
export { assetId, splitId } from '../src/lib/util/ids.ts';
export { thumbUrl as thumbURL } from '../src/lib/api/urls.ts';
export { KIND_ICON, KIND_COLOR } from '../src/lib/util/kinds.ts';
export { checker } from '../src/lib/util/checker.ts';
export { playList } from '../src/lib/util/playlist.ts';

/** POST an engine op as the user (legacy signature: api(op, args) -> result; toasts and throws on failure). */
export const api = (name, args) => op(name, args);
export const loadBitmap = (url) => getBitmap(url);
