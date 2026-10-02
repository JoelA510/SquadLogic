/**
 * FeatureGuard reads flags the way every other reader does: through
 * `useFeatures`, defaults applied. It used to read the raw stored JSONB, so a
 * default-on feature an org had never stored rendered as off here only.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FeatureGuard } from '../frontend/src/components/ui/FeatureGuard.jsx';
import { FEATURE_DEFAULTS, FEATURE_FLAGS } from '../frontend/src/constants/featureFlags.js';

const org = vi.hoisted(() => ({ value: { featureFlags: {}, loading: false } }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => org.value,
}));

const guard = (props) =>
  render(
    <FeatureGuard {...props} fallback={<span>fallback</span>}>
      <span>shown</span>
    </FeatureGuard>
  );

beforeEach(() => {
  org.value = { featureFlags: {}, loading: false };
});

describe('FeatureGuard', () => {
  it('a default-on feature the org never stored is on', () => {
    expect(FEATURE_DEFAULTS[FEATURE_FLAGS.WAITLIST]).toBe(true);
    guard({ flag: FEATURE_FLAGS.WAITLIST });
    expect(screen.getByText('shown')).toBeTruthy();
  });

  it('a stored false overrides the default', () => {
    org.value = { featureFlags: { [FEATURE_FLAGS.WAITLIST]: false }, loading: false };
    guard({ flag: FEATURE_FLAGS.WAITLIST });
    expect(screen.getByText('fallback')).toBeTruthy();
  });

  it('a feature with no default and no stored value is off', () => {
    guard({ flag: FEATURE_FLAGS.HEAT_FORECAST });
    expect(screen.getByText('fallback')).toBeTruthy();
  });

  it('inverted shows children when the feature is off', () => {
    guard({ flag: FEATURE_FLAGS.HEAT_FORECAST, inverted: true });
    expect(screen.getByText('shown')).toBeTruthy();
  });

  it('renders nothing while the organization is loading', () => {
    org.value = { featureFlags: {}, loading: true };
    const { container } = guard({ flag: FEATURE_FLAGS.WAITLIST });
    expect(container.textContent).toBe('');
  });
});
