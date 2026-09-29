import '@testing-library/jest-dom';
import { afterAll, vi } from 'vitest';

// jsdom lacks ResizeObserver; @dnd-kit relies on it.
globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// jsdom lacks IntersectionObserver.
globalThis.IntersectionObserver =
  globalThis.IntersectionObserver ||
  class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };

// jsdom doesn't always stub scrollIntoView on Element.prototype.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Wait for every in-flight module load before the file's environment is torn
// down. Importing frontend/src/lib/supabaseClient.js starts the lazy mock-client
// import (`supabaseReady`) at module load, and a file that never awaits it can
// end with that chain still loading; Vitest then rejects the pending fetch with
// an EnvironmentTeardownError and the run exits 1 (CI run 1138, #509, #77).
// `vi.dynamicImportSettled()` waits for any module still being fetched or
// evaluated, so it covers this chain and any other lazy import already in flight
// (an import a timer has not yet started is not seen), and it loads nothing
// itself; with nothing loading it returns after one timer tick.
// Registered here, before any test file's hooks, so under Vitest's default
// `sequence.hooks: 'stack'` it runs after the file's own afterAll hooks.
afterAll(async () => {
  await vi.dynamicImportSettled();
});
