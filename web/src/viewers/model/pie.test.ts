// @vitest-environment jsdom
// The Z pie: Blender's layout (left Wireframe, right Solid, top Rendered, bottom Material preview), keys, DOM.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIE_HALF, PIE_LAYOUT, buildPie, pieDirOf, pieKey, pieOffset, piePosition } from './pie';

afterEach(() => { document.body.replaceChildren(); });

describe('pie layout', () => {
  it('wedges in the corrected Blender layout', () => {
    expect(PIE_LAYOUT).toEqual({ left: 'wire', right: 'solid', top: 'rendered', bottom: 'material' });
    expect(pieDirOf('material')).toBe('bottom');
    expect(pieOffset('left', 10)).toEqual({ x: -10, y: 0 });
    expect(pieOffset('top', 10)).toEqual({ x: 0, y: -10 });
    expect(pieOffset('bottom', 10)).toEqual({ x: 0, y: 10 });
  });
  it('position: pointer, else stage centre; clamped inside the stage', () => {
    expect(piePosition(null, 800, 600)).toEqual({ x: 400, y: 300 });
    expect(piePosition({ x: 500, y: 300 }, 800, 600)).toEqual({ x: 500, y: 300 });
    expect(piePosition({ x: 5, y: 590 }, 800, 600)).toEqual({ x: PIE_HALF, y: 600 - PIE_HALF });
    expect(piePosition({ x: 5, y: 5 }, 200, 100)).toEqual({ x: 100, y: 50 });   // stage smaller than the pie: centre
  });
  it('keys: digits pick by Digit code, arrows move the highlight to that wedge, Enter picks it, Esc closes', () => {
    expect(pieKey('4', 'Digit4', null)).toEqual({ pick: 'rendered' });
    expect(pieKey('1', '', null)).toEqual({ pick: 'wire' });
    expect(pieKey('1', 'Numpad1', null)).toBeNull();
    expect(pieKey('ArrowLeft', 'ArrowLeft', null)).toEqual({ focus: 'wire' });
    expect(pieKey('ArrowUp', 'ArrowUp', null)).toEqual({ focus: 'rendered' });
    expect(pieKey('ArrowDown', 'ArrowDown', null)).toEqual({ focus: 'material' });
    expect(pieKey('ArrowRight', 'ArrowRight', null)).toEqual({ focus: 'solid' });
    expect(pieKey('Enter', 'Enter', 'solid')).toEqual({ pick: 'solid' });
    expect(pieKey('Enter', 'Enter', null)).toBeNull();
    expect(pieKey('Escape', 'Escape', 'solid')).toEqual({ close: true });
    expect(pieKey('q', 'KeyQ', null)).toBeNull();
  });
});

describe('pie DOM', () => {
  it('role=menu with 4 items placed by direction; click, keys and outside press', async () => {
    const pick = vi.fn();
    const p = buildPie({ x: 100, y: 80 }, 'material', pick);
    document.body.append(p.el);
    expect(p.el.getAttribute('role')).toBe('menu');
    const items = [...p.el.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
    expect(items.map((b) => [b.dataset.dir, b.dataset.mode])).toEqual([['left', 'wire'], ['right', 'solid'], ['top', 'rendered'], ['bottom', 'material']]);
    expect(items.find((b) => b.dataset.mode === 'material')!.getAttribute('aria-checked')).toBe('true');
    expect(p.el.style.left).toBe('100px');
    p.focus('solid');
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }));
    expect(p.focused()).toBe('rendered');
    items[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    expect(pick).toHaveBeenLastCalledWith('rendered');
    items[0].click();
    expect(pick).toHaveBeenLastCalledWith('wire');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    items[0].dispatchEvent(esc);
    expect(pick).toHaveBeenLastCalledWith(null);
    expect(esc.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    pick.mockClear();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pick).toHaveBeenCalledWith(null);
    p.destroy();
    expect(p.el.isConnected).toBe(false);
  });
});
