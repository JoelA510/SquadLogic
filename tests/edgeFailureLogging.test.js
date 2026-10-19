// @vitest-environment node
/**
 * M1.5: an Edge Function failure reaches BetterStack with the function's name,
 * the organization it was for (when known) and a request ID, and nothing that
 * could carry a person's details.
 *
 * Two halves:
 *  - the real `_shared/logtail.ts` helpers, run under Node with a stand-in
 *    `Deno.env` (a BetterStack token, so the transport path runs) and a
 *    stubbed `fetch` that records what would have been sent;
 *  - every function on disk, enumerated by directory (the registry a missed
 *    wiring leaves intact, never a hand-kept list), checked to serve its
 *    handler through `withFailureLogging` under its own directory name.
 *
 * Proven able to fail (2026-10-13, see the PR): with `serve(handler)` in one
 * function changed back to an unwrapped handler, or its name misspelt, the
 * per-function check fails; with `describeError` returning the error object
 * whole, the `details` assertion fails; with `redactMessage` returning its
 * input, the redaction test fails; with the rethrow removed from
 * `withFailureLogging`, the rethrow assertion fails.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS = path.join(ROOT, 'supabase/functions');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORG = '00000000-0000-4000-8000-00000000000a';

// Loaded by a computed path so `tsc` (which has no Deno types) does not follow
// it into a module that reads the `Deno` global; Deno's own `deno check` in CI
// type-checks it. Typed loosely here for the same reason.
const LOGTAIL = '../supabase/functions/_shared/logtail.ts';
/** @type {any} */
let logtail;
const fetchMock = vi.fn(
  /** @param {string} _url @param {RequestInit} _init */
  async (_url, _init) => new Response('', { status: 202 })
);

/** Every entry the stubbed transport was handed, across all flushes. */
const sentEntries = () =>
  fetchMock.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body ?? '[]')));

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k) => (k === 'BETTERSTACK_SOURCE_TOKEN' ? 'fake-source-token' : undefined) },
  });
  vi.stubGlobal('fetch', fetchMock);
  logtail = await import(/* @vite-ignore */ LOGTAIL);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('withFailureLogging', () => {
  it('logs an escaping error with function name, request ID and organization, then rethrows it', async () => {
    const boom = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const handler = logtail.withFailureLogging('game-persistence', async (_req, ctx) => {
      ctx.organizationId = ORG;
      throw boom;
    });

    await expect(handler(new Request('https://edge.example/'))).rejects.toBe(boom);

    const entries = sentEntries();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.level).toBe('error');
    expect(entry.function_name).toBe('game-persistence');
    expect(entry.message).toBe('game-persistence: unhandled error');
    expect(entry.context.function_name).toBe('game-persistence');
    expect(entry.context.organization_id).toBe(ORG);
    expect(entry.context.request_id).toMatch(UUID);
    expect(entry.context.error).toMatchObject({
      name: 'Error',
      message: 'relation does not exist',
      code: '42P01',
    });
    const headers = /** @type {Record<string, string>} */ (fetchMock.mock.calls[0][1].headers);
    expect(headers.Authorization).toBe('Bearer fake-source-token');
  });

  it('a handler that answers is passed through and logs nothing', async () => {
    const res = new Response('ok', { status: 201 });
    const handler = logtail.withFailureLogging('team-persistence', () => res);
    expect(await handler(new Request('https://edge.example/'))).toBe(res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives every request its own ID, and the handler sees it', async () => {
    /** @type {string[]} */
    const seen = [];
    const handler = logtail.withFailureLogging('auto-scheduler', (_req, ctx) => {
      seen.push(ctx.requestId);
      return new Response('ok');
    });
    await handler(new Request('https://edge.example/'));
    await handler(new Request('https://edge.example/'));
    expect(seen).toHaveLength(2);
    seen.forEach((id) => expect(id).toMatch(UUID));
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('logFailure', () => {
  it('says organization_id null when the organization was not yet known', async () => {
    await logtail.logFailure(
      { functionName: 'calendar-feed', requestId: 'r-1' },
      'Calendar feed failed',
      new Error('x')
    );
    const [entry] = sentEntries();
    expect(entry.context).toMatchObject({
      function_name: 'calendar-feed',
      request_id: 'r-1',
      organization_id: null,
    });
  });

  it('logs a PostgREST error by message and code only, never its details or hint', async () => {
    const pgError = {
      message: 'duplicate key value violates unique constraint "staging_players_pkey"',
      code: '23505',
      details: 'Key (email)=(pat.parent@example.test) already exists.',
      hint: 'Pat Parent',
    };
    await logtail.logFailure(
      { functionName: 'import-validation', requestId: 'r-2', organizationId: ORG },
      'Failed to stage import rows',
      pgError
    );
    const [entry] = sentEntries();
    expect(entry.context.error).toEqual({
      name: 'NonError',
      message: 'duplicate key value violates unique constraint "[redacted]"',
      code: '23505',
    });
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).not.toContain('example.test');
    expect(sent).not.toContain('Pat Parent');
  });

  it('redacts the values a message or stack quotes, keeping its shape', async () => {
    const err = new Error('invalid input syntax for type date: "Pat Parent"');
    err.stack =
      'Error: invalid input syntax for type date: "Pat Parent"\n' +
      '    at persist (https://esm.sh/@supabase/supabase-js@2.45.3/dist/module.mjs:1:2)';
    const raise = { message: "player pat.parent@example.test already on 'Club A'", code: 'P0001' };
    await logtail.logFailure(
      { functionName: 'import-validation', requestId: 'r-3', organizationId: ORG },
      'Failed to stage import rows',
      err
    );
    await logtail.logFailure(
      { functionName: 'import-validation', requestId: 'r-4', organizationId: ORG },
      'Failed to stage import rows',
      raise
    );
    const [first, second] = sentEntries();
    expect(first.context.error.message).toBe('invalid input syntax for type date: "[redacted]"');
    // A module URL with an @version is a stack frame, not an email: kept.
    expect(first.context.error.stack).toContain('esm.sh/@supabase/supabase-js@2.45.3/dist');
    expect(second.context.error).toEqual({
      name: 'NonError',
      message: "player [redacted-email] already on '[redacted]'",
      code: 'P0001',
    });
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).not.toContain('Pat Parent');
    expect(sent).not.toContain('example.test');
    expect(sent).not.toContain('Club A');
  });

  it('describes a thrown non-object', () => {
    expect(logtail.describeError('plain')).toEqual({ name: 'NonError', message: 'plain' });
  });
});

describe('logRequest', () => {
  it('carries the function name, request ID and organization beside the details it was given', async () => {
    const ctx = { functionName: 'auto-scheduler', requestId: 'r-9', organizationId: ORG };
    logtail.logRequest(ctx, 'error', 'Auto-scheduler refused: slots could not be placed', {
      orgId: ORG,
      refusedCount: 2,
    });
    await logtail.edgeLogger.flush();
    const [entry] = sentEntries();
    expect(entry.level).toBe('error');
    expect(entry.function_name).toBe('auto-scheduler');
    expect(entry.message).toBe('Auto-scheduler refused: slots could not be placed');
    expect(entry.context).toEqual({
      orgId: ORG,
      refusedCount: 2,
      function_name: 'auto-scheduler',
      request_id: 'r-9',
      organization_id: ORG,
    });
  });

  it('says organization_id null before the organization is known, and cannot be overridden by details', async () => {
    logtail.logRequest({ functionName: 'fairness-scoring', requestId: 'r-10' }, 'info', 'x', {
      request_id: 'spoofed',
    });
    await logtail.edgeLogger.flush();
    const [entry] = sentEntries();
    expect(entry.context.request_id).toBe('r-10');
    expect(entry.context.organization_id).toBeNull();
  });
});

describe('flush', () => {
  it('gives up on a BetterStack that does not answer, so a failing response is not held', async () => {
    // A transport that only ends when its signal aborts, as a hung one would.
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logtail.logRequest({ functionName: 'auto-scheduler', requestId: 'r-11' }, 'error', 'held');
    const started = Date.now();
    await logtail.edgeLogger.flush(50);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to flush'));
    // The batch was taken off the buffer, not retried forever.
    fetchMock.mockClear();
    await logtail.edgeLogger.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends with a timeout signal by default', async () => {
    logtail.logRequest({ functionName: 'auto-scheduler', requestId: 'r-12' }, 'info', 'x');
    await logtail.edgeLogger.flush();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('every Edge Function serves its handler through withFailureLogging', () => {
  const functionDirs = readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .filter((name) => existsSync(path.join(FUNCTIONS, name, 'index.ts')));

  it('finds the functions (a floor, stated: seven at M1.5)', () => {
    expect(functionDirs.length).toBeGreaterThanOrEqual(7);
  });

  it.each(functionDirs)('%s', (name) => {
    const src = readFileSync(path.join(FUNCTIONS, name, 'index.ts'), 'utf8');
    expect(src).toMatch(
      /import \{[^}]*\bwithFailureLogging\b[^}]*\} from '\.\.\/_shared\/logtail\.ts';/
    );
    // Wrapped under its own directory name, so entries are attributable.
    const names = [...src.matchAll(/withFailureLogging\('([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set([name]));
    // Every handler the file can serve is wrapped, including the stand-in the
    // persistence functions serve when their Supabase variables are missing.
    const assigned = [...src.matchAll(/\bhandler = ([^\n]*)/g)].map((m) => m[1]);
    assigned.forEach((rhs) => expect(rhs).toMatch(/^withFailureLogging\(/));
    // No direct edgeLogger call: it carries no request ID and its entries read
    // `function_name: "unknown"`. `logRequest` is the call that does.
    expect(src).not.toMatch(/\bedgeLogger\.(info|warn|error)\(/);
    // The wrapped handler is the one served.
    expect(src).toMatch(/\nserve\(handler\);\n/);
    expect(src).not.toMatch(/\nserve\(async/);
    // The organization is recorded once the function has verified it.
    expect(src).toMatch(/logCtx\.organizationId = /);
  });
});
