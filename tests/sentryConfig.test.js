// @vitest-environment node
/**
 * Sentry release tag and privacy options. docs/operations/sentry-smoke.md
 * expects every event tagged with package.json's version, so the chain is
 * pinned link by link: vite.config.js defines the version, env.js (the only
 * reader of import.meta.env, M2.2) exports it as APP_VERSION, main.jsx passes
 * that as `release`, and sentryInitOptions puts it on the options it returns.
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

  it('main.jsx passes VITE_APP_VERSION (via env.js) as the release, behind the DSN gate', () => {
    const env = readFileSync(path.join(ROOT, 'frontend/src/env.js'), 'utf8');
    expect(env).toContain('export const APP_VERSION = import.meta.env.VITE_APP_VERSION;');
    const main = readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
    expect(main).toMatch(/^import \{[^}]*\bAPP_VERSION\b[^}]*\} from '\.\/env\.js';$/m);
    expect(main).toContain('release: APP_VERSION,');
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

describe('Sentry Session Replay', () => {
  // Replay is ~40 KB gzip. It loads as its own chunk after init (plan M6), so
  // the main entry carries only the SDK core and tracing; the bundle budget
  // fails a build where Replay is back in the entry.
  const main = readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
  const gate = main.indexOf('if (SENTRY_DSN) {');
  const gateEnd = main.indexOf('\n}\n', gate);

  it('init passes tracing only; Replay is not imported statically', () => {
    expect(main).toContain('integrations: [Sentry.browserTracingIntegration()],');
    expect(main).not.toMatch(/Sentry\.replayIntegration\(/);
    expect(main).not.toMatch(/^import[^;]*sentryReplay/m);
  });

  it('main.jsx adds Replay from its lazy chunk, inside the DSN gate, and reports a failed load', () => {
    expect(gate).toBeGreaterThan(-1);
    const block = main.slice(gate, gateEnd);
    const lazy = block.indexOf("import('./lib/sentryReplay.js')");
    expect(lazy).toBeGreaterThan(block.indexOf('Sentry.init('));
    expect(block).toContain(
      '({ replayIntegration }) => Sentry.addIntegration(replayIntegration())'
    );
    expect(block).toMatch(/\(error\) => logger\.error\(/);
  });

  it('sentryReplay.js re-exports the SDK replay integration and nothing else', async () => {
    const lazy = await import('../frontend/src/lib/sentryReplay.js');
    const sdk = await import('@sentry/react');
    expect(Object.keys(lazy)).toEqual(['replayIntegration']);
    expect(lazy.replayIntegration).toBe(sdk.replayIntegration);
  });
});

describe('Sentry privacy and sampling', () => {
  // SDK v11 removed `sendDefaultPii`; an unset `dataCollection` collects user
  // info, cookies and bodies by default, so the v10 baseline is stated.
  it('states dataCollection explicitly, with every v10-restrictive category off', () => {
    expect(Object.hasOwn(options(), 'sendDefaultPii')).toBe(false);
    expect(options().dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    });
  });

  it('the SDK resolves that baseline, not its permissive v11 defaults', async () => {
    // The SDK's own resolver, so a renamed or ignored key shows here: an
    // object that only looks right would resolve to the defaults.
    const { BrowserClient, defaultStackParser, makeFetchTransport } = await import('@sentry/react');
    const client = new BrowserClient({
      ...options(),
      integrations: [],
      stackParser: defaultStackParser,
      transport: makeFetchTransport,
    });
    expect(client.getDataCollectionOptions()).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      urlQueryParams: true,
    });
    // Without its own deny list the SDK default is `true`: all headers.
    const httpHeaders = /** @type {{ request: unknown, response: unknown }} */ (
      client.getDataCollectionOptions().httpHeaders
    );
    for (const side of [httpHeaders.request, httpHeaders.response]) {
      expect(side).toEqual({
        deny: expect.arrayContaining(['forwarded', '-ip', 'remote-', 'via']),
      });
    }
  });

  it('hands each init its own dataCollection objects', () => {
    const a = /** @type {any} */ (options().dataCollection);
    const b = /** @type {any} */ (options().dataCollection);
    expect(a).not.toBe(b);
    expect(a.httpHeaders.request).not.toBe(a.httpHeaders.response);
    expect(a.httpHeaders.request.deny).not.toBe(b.httpHeaders.request.deny);
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

  it('main.jsx passes VITE_VERCEL_ENV (via env.js) as the deploy environment', () => {
    const env = readFileSync(path.join(ROOT, 'frontend/src/env.js'), 'utf8');
    expect(env).toContain('export const DEPLOY_ENV = import.meta.env.VITE_VERCEL_ENV;');
    const main = readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
    expect(main).toMatch(/^import \{[^}]*\bDEPLOY_ENV\b[^}]*\} from '\.\/env\.js';$/m);
    expect(main).toContain('deployEnv: DEPLOY_ENV,');
  });
});
