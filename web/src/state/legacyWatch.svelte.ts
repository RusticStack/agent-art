// Temporary (deleted in step 18): lets the legacy App (plain JS, no components) re-render its DOM when
// a store value changes. watch(() => assets.rev, () => browser.render()).
export function watch<T>(read: () => T, fn: (v: T) => void): () => void {
  return $effect.root(() => {
    let first = true;
    $effect(() => {
      const v = read();
      if (first) { first = false; return; }
      fn(v);
    });
  });
}
