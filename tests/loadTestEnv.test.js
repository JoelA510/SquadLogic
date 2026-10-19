// @vitest-environment node
/**
 * `playwright.config.ts` loads the E2E environment through `loadTestEnv`
 * (audit finding DD-9): `.env.test`, the documented home of the `TEST_*`
 * credentials, used to be skipped because the config read only `.env`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTestEnv } from './e2e/loadTestEnv.js';

/** @type {string[]} */
const dirs = [];
/** @param {Record<string, string>} files */
const repoWith = (files) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'load-test-env-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('loadTestEnv', () => {
  it('reads TEST_* from .env.test, which the config used to skip', () => {
    const dir = repoWith({ '.env.test': 'TEST_PASSWORD=from-env-test\n' });
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    loadTestEnv(dir, env);
    expect(env.TEST_PASSWORD).toBe('from-env-test');
  });

  it('ranks the shell over .env.test over .env', () => {
    const dir = repoWith({
      '.env': 'TEST_PASSWORD=from-env\nTEST_ADMIN_EMAIL=from-env\nVITE_ONLY=from-env\n',
      '.env.test': 'TEST_PASSWORD=from-env-test\nTEST_ADMIN_EMAIL=from-env-test\n',
    });
    /** @type {NodeJS.ProcessEnv} */
    const env = { TEST_ADMIN_EMAIL: 'from-shell' };
    loadTestEnv(dir, env);
    expect(env.TEST_ADMIN_EMAIL).toBe('from-shell');
    expect(env.TEST_PASSWORD).toBe('from-env-test');
    // .env still supplies what .env.test does not name.
    expect(env.VITE_ONLY).toBe('from-env');
  });

  it('is not an error when neither file exists (the mock run, CI)', () => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    expect(() => loadTestEnv(repoWith({}), env)).not.toThrow();
    expect(env).toEqual({});
  });
});
