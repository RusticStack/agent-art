import { describe, expect, it } from 'vitest';
import { extOf, prettyText, previewKindFor } from './logic';

describe('export preview kind', () => {
  const files = ['spark.png', 'spark.json', 'helmet.png', 'notes.txt', 'pack.mcmeta', 'lone.json', 'anim.gif', 'sub/dir/x.png', 'sub/dir/x.json', 'm.glb'];
  it.each([
    ['spark.png', 'sheet'], ['spark.json', 'sheet-json'], ['helmet.png', 'image'], ['anim.gif', 'gif'], ['notes.txt', 'text'],
    ['pack.mcmeta', 'text'], ['lone.json', 'text'], ['sub/dir/x.png', 'sheet'], ['m.glb', 'none'], ['README', 'none'], ['UPPER.PNG', 'image'],
  ])('%s -> %s', (p, k) => expect(previewKindFor(p, files)).toBe(k));
  it('extOf', () => { expect(extOf('a/b.JSON')).toBe('json'); expect(extOf('noext')).toBe(''); });
  it('prettyText re-indents JSON and caps length', () => {
    expect(prettyText('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(prettyText('plain')).toEqual({ text: 'plain', json: false });
    const big = prettyText('x'.repeat(400_010));
    expect(big.text.length).toBe(400_002);
    expect(big.text.endsWith('\n…')).toBe(true);
  });
});
