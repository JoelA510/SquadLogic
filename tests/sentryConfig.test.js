// @vitest-environment node
/**
 * Sentry release tag and privacy options. docs/operations/sentry-smoke.md
 * expects every event tagged with package.json's version, so the chain is
 * pinned link by link: vite.config.js defines the version, main.jsx passes it
 * as `release`, and sentryInitOptions puts it on the options it returns.
 * The environment is pinned the same way: Vercel's VERCEL_ENV, defined by
 * name, so a preview deploy's events read `preview`, not `production`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config.js';
import { sentryEnvironment, sentryInitOptions } from '../frontend/src/lib/sentryOptions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const options = (overrides = {}) =>
  sentryInitOptions({
    dsn: 'https://public@o0.ingest.us.sentry.io/0',
    dev: false,
    release: VERSION,
    integrations: [],
    ...overrides,
  });

describe('Sentry release', () => {
  it('package.json carries a semver version to tag with', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('vite.config.js defines VITE_APP_VERSION as the package.json version', () => {
    const define = /** @type {Record<string, string>} */ (viteConfig.define);
    expect(define['import.meta.env.VITE_APP_VERSION']).toBe(JSON.stringify(VERSION));
  });

  it('main.jsx passes VITE_APP_VERSION as the release, behind the DSN gate', () => {
    const main = readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
    expect(main).toContain('release: import.meta.env.VITE_APP_VERSION');
    const gate = main.indexOf('if (SENTRY_DSN) {');
    expect(gate).toBeGreaterThan(-1);
    // Calls, not the header comment that mentions Sentry.init().
    const calls = [...main.matchAll(/^\s+Sentry\.init\($/gm)];
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBeGreaterThan(gate);
  });

  it('the options carry the release they are given', () => {
    expect(options().release).toBe(VERSION);
    expect(options({ release: '9.9.9' }).release).toBe('9.9.9');
  });
});

describe('Sentry privacy and sampling', () => {
  it('states sendDefaultPii: false explicitly', () => {
    expect(Object.hasOwn(options(), 'sendDefaultPii')).toBe(true);
    expect(options().sendDefaultPii).toBe(false);
  });

  it('keeps the existing sample rates and environment', () => {
    expect(options()).toMatchObject({
      environment: 'production',
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0.5,
    });
    expect(options({ dev: true })).toMatchObject({
      environment: 'development',
      tracesSampleRate: 1.0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
    });
  });

  it('drops console breadcrumbs in dev only', () => {
    const crumb = { category: 'console' };
    expect(options({ dev: true }).beforeBreadcrumb(crumb)).toBeNull();
    expect(options().beforeBreadcrumb(crumb)).toBe(crumb);
  });
});

describe('Sentry environment', () => {
  it('a Vercel preview build reports preview, never production', () => {
    expect(options({ deployEnv: 'preview' }).environment).toBe('preview');
    expect(options({ deployEnv: 'production' }).environment).toBe('production');
  });

  it('a dev server is development whatever Vercel says', () => {
    expect(sentryEnvironment({ dev: true, deployEnv: 'preview' })).toBe('development');
    expect(sentryEnvironment({ dev: true, deployEnv: 'production' })).toBe('development');
  });

  it('a build outside Vercel, or with a value Vercel does not use, keeps production', () => {
    expect(sentryEnvironment({ dev: false, deployEnv: '' })).toBe('production');
    expect(sentryEnvironment({ dev: false, deployEnv: undefined })).toBe('production');
    expect(sentryEnvironment({ dev: false, deployEnv: 'staging-ish' })).toBe('production');
  });

  it('vite.config.js defines exactly VERCEL_ENV, by name, and no other process.env', () => {
    const define = /** @type {Record<string, string>} */ (viteConfig.define);
    expect(define['import.meta.env.VITE_VERCEL_ENV']).toBe(
      JSON.stringify(process.env.VERCEL_ENV ?? '')
    );
    // Only the two keys this file pins, and nothing that exposes process.env
    // as a whole (a `define` of `process.env` would inline every build secret).
    expect(Object.keys(define).sort()).toEqual([
      'import.meta.env.VITE_APP_VERSION',
      'import.meta.env.VITE_VERCEL_ENV',
    ]);
    const config = readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    expect(config.match(/process\.env\b(?!\.VERCEL_ENV\b)/g) ?? []).toEqual([]);
  });

  it('main.jsx passes VITE_VERCEL_ENV as the deploy environment', () => {
    const main = readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
    expect(main).toContain('deployEnv: import.meta.env.VITE_VERCEL_ENV');
  });
});
