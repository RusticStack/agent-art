// Paint tool, colour and review mode.
import type { Tool } from '@/viewers/types';

/** '#rgb' / '#rrggbb' / '#rrggbbaa' -> { hex: '#rrggbb', hex8: '#rrggbbaa' } (lower case). */
export function normColor(input: string): { hex: string; hex8: string } {
  let s = input.trim().toLowerCase();
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9a-f]{3,4}$/.test(s)) s = '#' + [...s.slice(1)].map((c) => c + c).join('');
  const h8 = s.length === 9 ? s : s.slice(0, 7) + 'ff';
  return { hex: h8.slice(0, 7), hex8: h8 };
}

export class Editor {
  tool = $state<Tool>('pencil');
  color = $state.raw({ hex: '#4a7c3a', hex8: '#4a7c3aff' });
  reviewMode = $state(false);
  setTool(t: Tool): void { this.tool = t; }
  /** Picking a colour while erasing / picking / panning switches back to the pencil. */
  setColor(hex: string): void {
    this.color = normColor(hex);
    if (this.tool === 'eraser' || this.tool === 'picker' || this.tool === 'hand') this.tool = 'pencil';
  }
  setReviewMode(on: boolean): void { this.reviewMode = on; }
}

export const editor = new Editor();
