import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SvelteOk from './SvelteOk.svelte';

describe('svelte toolchain', () => {
  it('compiles and renders a Svelte 5 + TypeScript component', () => {
    const { body } = render(SvelteOk, { props: { name: 'ok' } });
    expect(body).toContain('ok x1');
  });
});
