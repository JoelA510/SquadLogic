/**
 * The feature-flag warnings (an unknown flag in `<FeatureGuard>`, an unknown or
 * malformed key in the stored flags) are for the dev server only: not a
 * production build, and not Vitest, where they would bury real output.
 *
 * They read env.js's `IS_DEVELOPMENT_MODE` (`import.meta.env.MODE`), not
 * `process.env.NODE_ENV` (AGENTS.md rule 3; plan M6). `IS_DEV` would not do:
 * Vitest sets `DEV` true, but `MODE` to `test`. So each warning is checked in
 * both modes, through modules loaded fresh after the mode is set.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ featureFlags: {}, loading: false }),
}));

/** featureFlags.js and FeatureGuard.jsx, loaded fresh with `MODE` set to `mode`. */
async function loadIn(/** @type {string} */ mode) {
  vi.resetModules();
  vi.stubEnv('MODE', mode);
  const flags = await import('../frontend/src/constants/featureFlags.js');
  const { FeatureGuard } = await import('../frontend/src/components/ui/FeatureGuard.jsx');
  return { flags, FeatureGuard };
}

const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('feature-flag warnings', () => {
  it('Vitest runs in test mode, not development', () => {
    expect(import.meta.env.MODE).toBe('test');
    expect(import.meta.env.DEV).toBe(true);
  });

  it.each([
    ['development', 1],
    ['test', 0],
    ['production', 0],
  ])('an unrecognized FeatureGuard flag warns in %s mode: %i', async (mode, count) => {
    const { FeatureGuard } = await loadIn(mode);
    const warn = warnings();
    render(<FeatureGuard flag="not_a_real_flag">x</FeatureGuard>);
    const calls = warn.mock.calls.filter(([message]) => String(message).includes('[FeatureGuard]'));
    expect(calls).toHaveLength(count);
  });

  it.each([
    ['development', 2],
    ['test', 0],
    ['production', 0],
  ])('unknown stored keys warn in %s mode: %i', async (mode, count) => {
    const { flags } = await loadIn(mode);
    const warn = warnings();
    const parsed = flags.FeatureFlagSchema.parse({
      [flags.FEATURE_FLAGS.WAITLIST]: true,
      not_a_real_flag: true,
      [flags.GENDER_MODEL_KEY]: 'not-a-model',
    });
    // The warnings change nothing but the console: the known flag survives.
    expect(parsed).toEqual({ [flags.FEATURE_FLAGS.WAITLIST]: true });
    const calls = warn.mock.calls.filter(([message]) => String(message).includes('[FeatureFlag]'));
    expect(calls).toHaveLength(count);
  });
});
