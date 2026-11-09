import { describe, expect, it } from 'vitest';
import { tokenizeJson } from './jsonTokens';

describe('tokenizeJson', () => {
  it('classifies keys, strings, numbers, literals', () => {
    const text = JSON.stringify({ a: 'x"y', n: -1.5e3, t: true, z: null, l: [1, false] }, null, 2);
    const toks = tokenizeJson(text);
    expect(toks.map((t) => t.v).join('')).toBe(text);
    expect(toks.filter((t) => t.t === 'key').map((t) => t.v)).toEqual(['"a"', '"n"', '"t"', '"z"', '"l"']);
    expect(toks.filter((t) => t.t === 'str').map((t) => t.v)).toEqual(['"x\\"y"']);
    expect(toks.filter((t) => t.t === 'num').map((t) => t.v)).toEqual(['-1500', '1']);
    expect(toks.filter((t) => t.t === 'lit').map((t) => t.v)).toEqual(['true', 'null', 'false']);
  });
  it('invalid JSON is one plain token', () => {
    expect(tokenizeJson('{nope')).toEqual([{ t: 'ws', v: '{nope' }]);
  });
});
