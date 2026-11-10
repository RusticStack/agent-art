<!--
  I4 Preview: the canvas at a small and a big integer scale, nearest-neighbour, animated with the first
  tag's playlist (or all frames at 10 fps). One timer chain per `info`: the effect's cleanup clears it
  when the canvas info changes and on destroy (legacy leaked a chain when switching quickly).
-->
<script lang="ts">
  import type { CanvasInfo } from '@/lib/api/types';
  import { canvasPng } from '@/lib/api/urls';
  import { playList } from '@/lib/util/playlist';
  import { previewScales } from './logic';

  let { info }: { info: CanvasInfo } = $props();

  let small: HTMLCanvasElement | null = $state(null);
  let big: HTMLCanvasElement | null = $state(null);

  /** Loads the strip without fetch(): an <img> decoded off the DOM. */
  function loadStrip(i: CanvasInfo): { img: HTMLImageElement; ready: Promise<void> } {
    const img = new Image();
    img.src = canvasPng(i.name, { t: `${i.version}-${Date.now()}` });
    const ready = typeof img.decode === 'function'
      ? img.decode()
      : new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('image')); });
    return { img, ready };
  }

  $effect(() => {
    const i = info, c1 = small, c2 = big;
    if (!c1 || !c2) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    const { img, ready } = loadStrip(i);
    ready.then(() => {
      if (dead || !img.naturalWidth) return;
      const w = img.naturalWidth, fh = i.frameHeight || img.naturalHeight;
      const { small: s1, big: s2 } = previewScales(w, fh);
      const pl = playList(i, Object.keys(i.animations || {})[0], 10);
      let n = 0;
      const draw = () => {
        for (const [c, s] of [[c1, s1], [c2, s2]] as const) {
          c.width = w * s; c.height = fh * s;
          const cx = c.getContext('2d');
          if (!cx) continue;
          cx.imageSmoothingEnabled = false;
          cx.drawImage(img, 0, (pl.frames[n] ?? 0) * fh, w, fh, 0, 0, c.width, c.height);
        }
      };
      const tick = () => {
        timer = null;
        if (dead) return;
        draw();
        if (pl.frames.length > 1) { n = (n + 1) % pl.frames.length; timer = setTimeout(tick, pl.durations[n] || 100); }
      };
      tick();
    }, () => { /* no preview */ });
    return () => { dead = true; if (timer) clearTimeout(timer); timer = null; };
  });
</script>

<div class="preview-row">
  <canvas class="preview" bind:this={small} aria-label="{info.name} preview, small"></canvas>
  <canvas class="preview" bind:this={big} aria-label="{info.name} preview"></canvas>
</div>
