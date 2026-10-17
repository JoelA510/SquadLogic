/**
 * `frontend:build` and `frontend:preview` (scripts/runViteWithPersistenceEndpoint.js)
 * derive the persistence Edge Function base from the Supabase URL and hand it
 * to Vite through the child's environment.
 *
 * They used to write it to `frontend/.env.local` as well, on every run. Vite's
 * `envDir` is the repository root (vite.config.js), and no script, test or CI
 * step reads that file, so it was a stray file in every working tree and CI
 * runner (remediation plan, Discovered during execution, #558). It is no longer
 * written.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePersistenceEndpoint } from '../scripts/configurePersistenceEndpoint.js';

const derivedEndpoint = 'https://example.supabase.co/functions/v1';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('configurePersistenceEndpoint', () => {
  it('derives the Functions URL into the environment it is given', () => {
    const env = { SUPABASE_URL: 'https://example.supabase.co/' };
    expect(configurePersistenceEndpoint(env)).toBe(derivedEndpoint);
    expect(env).toMatchObject({ VITE_SUPABASE_PERSISTENCE_URL: derivedEndpoint });
  });

  it('prefers VITE_SUPABASE_URL, and keeps an explicit value as it is', () => {
    const env = {
      SUPABASE_URL: 'https://other.supabase.co',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
    };
    expect(configurePersistenceEndpoint(env)).toBe(derivedEndpoint);
    const explicit = { VITE_SUPABASE_PERSISTENCE_URL: 'https://edge.example.org/functions/v1' };
    expect(configurePersistenceEndpoint(explicit)).toBe('https://edge.example.org/functions/v1');
  });

  it('leaves the value unset with no Supabase URL', () => {
    const env = /** @type {NodeJS.ProcessEnv} */ ({});
    expect(configurePersistenceEndpoint(env)).toBeUndefined();
    expect(env).toEqual({});
  });

  it('writes no file, even for the process environment (what the build wrapper passes)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const writes = [
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {}),
      vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {}),
    ];
    vi.stubEnv('VITE_SUPABASE_PERSISTENCE_URL', '');
    delete process.env.VITE_SUPABASE_PERSISTENCE_URL;
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');

    // Meta: the call derived a value, so a file write was due if one existed.
    expect(configurePersistenceEndpoint(process.env)).toBe(derivedEndpoint);
    expect(process.env.VITE_SUPABASE_PERSISTENCE_URL).toBe(derivedEndpoint);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});
