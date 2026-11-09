import { describe, expect, it } from 'vitest';
import { assetId, idOfTarget, splitId } from './ids';

describe('ids', () => {
  it('splitId', () => {
    expect(splitId('a')).toEqual(['canvas', 'a']);
    expect(splitId('model:rifle')).toEqual(['model', 'rifle']);
    expect(splitId('canvas:a:b')).toEqual(['canvas', 'a:b']);
    expect(splitId('layer:hero/base')).toEqual(['layer', 'hero/base']);
    expect(splitId('export:sub/dir/x.png')).toEqual(['export', 'sub/dir/x.png']);
  });
  it('assetId round trip', () => {
    expect(splitId(assetId('rig', 'a:b/c'))).toEqual(['rig', 'a:b/c']);
  });
  it('idOfTarget', () => {
    expect(idOfTarget({ kind: 'graph' })).toBe('graph');
    expect(idOfTarget({ kind: 'canvas', name: 'x', view: 'anim' })).toBe('canvas:x');
    expect(idOfTarget({ kind: 'model', name: 'm' })).toBe('model:m');
  });
});
