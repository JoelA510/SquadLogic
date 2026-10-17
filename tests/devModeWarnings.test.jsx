/**
 * The feature-flag warnings (an unknown flag in `<FeatureGuard>`, an unknown or
 * malformed key in the stored flags) are for the dev server only: not a
 * production build, and not Vitest, where they would bury real output.
 *
 * They read env.js's `IS_DEV_SERVER` (`DEV`, and `MODE` not `test`), not
 * `process.env.NODE_ENV` (AGENTS.md rule 3; plan M6). `IS_DEV` alone would not
 * do: Vitest sets `DEV` true and `MODE` to `test`. So each warning is checked
 * on the dev server (in its default mode and a custom `--mode`), in Vitest and
 * in a build, through modules loaded fresh after `DEV` and `MODE` are set.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ featureFlags: {}, loading: false }),
}));

/** featureFlags.js and FeatureGuard.jsx, loaded fresh with `MODE` and `DEV` set. */
async function loadIn(/** @type {string} */ mode, /** @type {boolean} */ dev) {
  vi.resetModules();
  vi.stubEnv('MODE', mode);
  vi.stubEnv('DEV', dev);
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

  /**
   * [mode, DEV, warnings expected]: the dev server, a custom dev mode, Vitest, a build.
   * @type {[string, boolean, number][]}
   */
  const MODES = [
    ['development', true, 1],
    ['staging', true, 1],
    ['test', true, 0],
    ['production', false, 0],
  ];

  it.each(MODES)(
    'an unrecognized FeatureGuard flag, mode %s, DEV %s: %i warning',
    async (mode, dev, count) => {
      const { FeatureGuard } = await loadIn(mode, dev);
      const warn = warnings();
      render(<FeatureGuard flag="not_a_real_flag">x</FeatureGuard>);
      const calls = warn.mock.calls.filter(([message]) =>
        String(message).includes('[FeatureGuard]')
      );
      expect(calls).toHaveLength(count);
    }
  );

  it.each(MODES)(
    'unknown stored keys, mode %s, DEV %s: %i warning each',
    async (mode, dev, count) => {
      const { flags } = await loadIn(mode, dev);
      const warn = warnings();
      const parsed = flags.FeatureFlagSchema.parse({
        [flags.FEATURE_FLAGS.WAITLIST]: true,
        not_a_real_flag: true,
        [flags.GENDER_MODEL_KEY]: 'not-a-model',
      });
      // The warnings change nothing but the console: the known flag survives.
      expect(parsed).toEqual({ [flags.FEATURE_FLAGS.WAITLIST]: true });
      const calls = warn.mock.calls.filter(([message]) =>
        String(message).includes('[FeatureFlag]')
      );
      // One for the unknown key, one for the malformed gender_model.
      expect(calls).toHaveLength(count * 2);
    }
  );
});
