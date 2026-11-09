// Animation frames + durations of a tag (direction expanded), or all frames at fps.
import type { AnimTag } from '@/lib/api/types';

export interface PlayList { frames: number[]; durations: number[]; loop: boolean }

export function playList(info: { frames?: number; animations?: Record<string, AnimTag> } | null | undefined, tag?: string | null, fps = 10): PlayList {
  const t = tag ? info?.animations?.[tag] : undefined;
  if (t) {
    let frames = [...t.frames], durations = [...t.durations];
    if (t.direction === 'reverse') { frames.reverse(); durations.reverse(); }
    if (t.direction === 'pingpong' && frames.length > 2) {
      frames = frames.concat(frames.slice(1, -1).reverse());
      durations = durations.concat(durations.slice(1, -1).reverse());
    }
    return { frames, durations, loop: t.loop !== false };
  }
  const n = info?.frames || 1;
  return { frames: [...Array(n).keys()], durations: Array(n).fill(1000 / fps), loop: true };
}
