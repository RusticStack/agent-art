// localStorage that never throws (private windows, blocked storage). Keys are prefixed "agent-art:".
export const PREFIX = 'agent-art:';

function ls(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export const store = {
  get<T>(k: string, d: T): T {
    try { const v = ls()?.getItem(PREFIX + k); return v === null || v === undefined ? d : (JSON.parse(v) as T); } catch { return d; }
  },
  set(k: string, v: unknown): void {
    try { ls()?.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* ignore */ }
  },
  /** Plain (unprefixed, unencoded) key, for the legacy "agent-art-follow". */
  getRaw(k: string): string | null {
    try { return ls()?.getItem(k) ?? null; } catch { return null; }
  },
  setRaw(k: string, v: string): void {
    try { ls()?.setItem(k, v); } catch { /* ignore */ }
  },
};

export type FollowMode = 'canvas' | 'project' | 'off';

/** Follow mode: agent-art:follow, else the legacy plain key agent-art-follow ("asset" = canvas), else canvas. */
export function readFollowMode(): FollowMode {
  let m: string | null = store.get<string | null>('follow', null);
  if (m === null) m = store.getRaw('agent-art-follow');
  if (m === 'asset') m = 'canvas';
  return m === 'project' || m === 'off' || m === 'canvas' ? m : 'canvas';
}
