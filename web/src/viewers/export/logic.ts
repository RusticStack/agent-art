// Pure export-preview logic (unit-tested): which preview a file gets.
export type PreviewKind = 'sheet' | 'sheet-json' | 'image' | 'gif' | 'text' | 'none';

export const extOf = (path: string): string => (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const siblingPath = (path: string, ext: string): string => path.replace(/\.[a-z0-9]+$/i, '.' + ext);

/**
 * siblings: every export path. 'sheet' = a .png with a sibling .json; 'sheet-json' = a .json with a sibling .png
 * (a sheet only when its JSON has frames: the caller checks after loading it).
 */
export function previewKindFor(path: string, siblings: readonly string[]): PreviewKind {
  const ext = extOf(path);
  const has = (e: string) => siblings.includes(siblingPath(path, e));
  if (ext === 'png' && has('json')) return 'sheet';
  if (ext === 'json' && has('png')) return 'sheet-json';
  if (ext === 'png') return 'image';
  if (ext === 'gif') return 'gif';
  if (ext === 'json' || ext === 'mcmeta' || ext === 'txt') return 'text';
  return 'none';
}

export const MAX_TEXT = 400_000;
/** JSON re-indented (else the text as is), capped. */
export function prettyText(text: string): { text: string; json: boolean } {
  let pretty = text, json = false;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); json = true; } catch { /* plain text */ }
  return { text: pretty.length > MAX_TEXT ? pretty.slice(0, MAX_TEXT) + '\n…' : pretty, json };
}
