// Toast bus: lib code (API client, viewers through the host) reports here; the toast store listens.
export type ToastKind = 'info' | 'ok' | 'error';
type Handler = (text: string, kind: ToastKind) => void;
let handler: Handler | null = null;
export const onToast = (fn: Handler | null) => { handler = fn; };
export const toast = (text: string, kind: ToastKind = 'info') => { handler?.(text, kind); };
