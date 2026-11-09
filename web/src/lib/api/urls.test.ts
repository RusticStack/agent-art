import { describe, expect, it } from 'vitest';
import * as u from './urls';

describe('urls', () => {
  it('canvas', () => {
    expect(u.canvasPng('a b/c')).toBe('/api/canvas/a%20b%2Fc/png');
    expect(u.canvasPng('x', { v: '3', layer: 1, frame: 2, scale: 4, download: true })).toBe('/api/canvas/x/png?v=3&layer=1&frame=2&scale=4&download=1');
    expect(u.canvasPng('x', { t: '5-99' })).toBe('/api/canvas/x/png?t=5-99');
    expect(u.canvasPng('x', { frame: 0 })).toBe('/api/canvas/x/png?frame=0');
    expect(u.canvasInfo('a b')).toBe('/api/canvas/a%20b');
    expect(u.canvasGif('x')).toBe('/api/canvas/x/anim.gif?scale=4');
    expect(u.canvasGif('x', { animation: 'walk side', scale: 2, download: true })).toBe('/api/canvas/x/anim.gif?scale=2&download=1&animation=walk%20side');
  });
  it('snapshots', () => {
    expect(u.snapshotPng('s12')).toBe('/api/snapshot/s12.png');
    expect(u.snapshotMeta('s12')).toBe('/api/snapshot/s12');
  });
  it('model', () => {
    expect(u.modelGlb('m')).toBe('/api/model/m/glb');
    expect(u.modelGlb('m n', { snap: 's1', profile: 'three', bake: true, download: true })).toBe('/api/model/m%20n/glb?snap=s1&profile=three&bake=1&download=1');
    expect(u.modelThumb('m', { v: 3, size: 512 })).toBe('/api/model/m/thumb.png?v=3&size=512');
    expect(u.modelThumb('m', { snap: 's2' })).toBe('/api/model/m/thumb.png?snap=s2');
  });
  it('rig', () => {
    expect(u.rigPreview('r', { pose: 'idle', view: 'side', scale: 3, t: 9 })).toBe('/api/rig/r/preview.png?pose=idle&view=side&scale=3&t=9');
    expect(u.rigWeights('r', { mesh: 'body/torso', bone: 'spine' })).toBe('/api/rig/r/weights.png?mesh=body%2Ftorso&bone=spine');
  });
  it('audio, export, review', () => {
    expect(u.audioWav('a b')).toBe('/api/audio/a%20b.wav');
    expect(u.audioWav('a', { t: 1, download: true })).toBe('/api/audio/a.wav?t=1&download=1');
    expect(u.exportFile('sub/x y.png')).toBe('/api/export-file?path=sub%2Fx%20y.png');
    expect(u.exportFile('x.png', { download: true, m: 7 })).toBe('/api/export-file?path=x.png&download=1&m=7');
    expect(u.reviewImage('r1-2.png')).toBe('/api/review-image/r1-2.png');
  });
  it('thumbUrl', () => {
    expect(u.thumbUrl('canvas', 'a b', '7')).toBe('/api/canvas/a%20b/png?v=7');
    expect(u.thumbUrl('canvas', 'a')).toBe('/api/canvas/a/png?v=0');
    expect(u.thumbUrl('model', 'm', 2)).toBe('/api/model/m/thumb.png?v=2');
    expect(u.thumbUrl('rig', 'hero', '1')).toBe('/api/canvas/hero_parts/png?v=1');
    expect(u.thumbUrl('audio', 'x')).toBeNull();
  });
});
