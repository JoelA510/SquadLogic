// #77: every test file waits for in-flight module loads before its environment
// is torn down. The teardown error itself only shows up when a chain is still
// loading at the instant Vitest closes the worker, so it cannot be forced from
// inside a test. These tests pin the two things the guard relies on: the hook
// is wired into the setup file every test file runs, and the Vitest API it
// calls really does wait out the supabaseReady chain.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

describe('test-teardown import race guard (#77)', () => {
  it('vitest.config.js runs tests/setup.js and keeps the default hook order', () => {
    const config = read('vitest.config.js');
    expect(config).toMatch(/setupFiles:[^\n]*['"]\.\/tests\/setup\.js['"]/);
    // The hook is registered first so it runs last only under the default
    // `sequence.hooks: 'stack'`; overriding it would need this guard revisited.
    expect(config).not.toMatch(/\bhooks\s*:/);
  });

  it('tests/setup.js awaits vi.dynamicImportSettled() in a file-level afterAll', () => {
    const setup = read('tests/setup.js');
    expect(setup).toMatch(/^afterAll\([\s\S]*?await vi\.dynamicImportSettled\(\)/m);
  });

  it('vi.dynamicImportSettled() waits for the lazy mock-client import supabaseClient.js starts', async () => {
    const client = await import('../frontend/src/lib/supabaseClient.js');
    // Control: the module has evaluated, but the mock chain it started is
    // still loading, so the client is not assigned yet. Without this, the
    // assertion below could pass without the settle doing anything.
    expect(client.supabase).toBeUndefined();

    await vi.dynamicImportSettled();

    expect(client.supabase).toBeDefined();
    expect(typeof client.supabase.from).toBe('function');
  });
});
