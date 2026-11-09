// Syntax-coloured JSON without a library: one regex pass over already pretty-printed text.
export type JsonTokenType = 'key' | 'str' | 'num' | 'lit' | 'punct' | 'ws';
export interface JsonToken { t: JsonTokenType; v: string }

const RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/gs;

/** Never throws: text that is not valid JSON comes back as one 'ws' token. */
export function tokenizeJson(text: string): JsonToken[] {
  try { JSON.parse(text); } catch { return [{ t: 'ws', v: text }]; }
  const out: JsonToken[] = [];
  const push = (t: JsonTokenType, v: string) => { const last = out[out.length - 1]; if (last && last.t === t && (t === 'ws' || t === 'punct')) last.v += v; else out.push({ t, v }); };
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text))) {
    if (m[1] !== undefined) {
      if (m[2] !== undefined) { push('key', m[1]); const colon = m[2]; const ws = colon.slice(0, -1); if (ws) push('ws', ws); push('punct', ':'); } else push('str', m[1]);
    } else if (m[3] !== undefined) push('num', m[3]);
    else if (m[4] !== undefined) push('lit', m[4]);
    else if (m[5] !== undefined) push('punct', m[5]);
    else if (m[6] !== undefined) push('ws', m[6]);
    else push('ws', m[7]);
  }
  return out;
}

export const JSON_CLASS: Record<JsonTokenType, string> = { key: 'j-key', str: 'j-str', num: 'j-num', lit: 'j-lit', punct: 'j-punct', ws: '' };
