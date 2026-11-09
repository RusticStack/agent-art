// Vitest setup (test.setupFiles). jsdom has no ResizeObserver; virtua (VirtualList) and Bits UI create
// one on mount. The stub observes nothing; a test that needs sizes installs its own (see ui.test.ts).
class InertResizeObserver {
  constructor(_cb: ResizeObserverCallback) { void _cb; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = InertResizeObserver;
  globalThis.ResizeObserver = InertResizeObserver;
}
// jsdom has no Element.scrollTo (virtua's scrollToIndex calls it).
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function scrollTo(): void {};
}
