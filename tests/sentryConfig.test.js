// @vitest-environment node
/**
 * Sentry release tag and privacy options. docs/operations/sentry-smoke.md
 * expects every event tagged with package.json's version, so the chain is
 * pinned link by link: vite.config.js defines the version, main.jsx passes it
 * as `release`, and sentryInitOptions puts it on the options it returns.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config.js';
import { sentryInitOptions } from '../frontend/src/lib/sentryOptions.js';

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
