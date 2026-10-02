import React, { useEffect } from 'react';
import { useFeatures } from '../../hooks/useFeatures.js';
import { ALL_FLAGS } from '../../constants/featureFlags.js';

/**
 * FeatureGuard Component
 *
 * Conditionally renders children based on the state of an organization's feature flags.
 *
 * Reads through `useFeatures`, so an absent key takes its `FEATURE_DEFAULTS`
 * value exactly as every other reader sees it. It used to read the raw stored
 * JSONB, so a default-on feature an org had never touched rendered as off here
 * and on everywhere else.
 *
 * @param {Object} props
 * @param {string} props.flag - The key of the feature flag to check (e.g., 'advanced_fairness').
 * @param {React.ReactNode} props.children - The content to show if the flag is enabled.
 * @param {React.ReactNode} [props.fallback] - Optional content to show if the flag is disabled.
 * @param {boolean} [props.inverted] - If true, shows children when the flag is FALSE.
 */
export const FeatureGuard = ({ flag, children, fallback = null, inverted = false }) => {
  const { isEnabled: isFlagEnabled, loading } = useFeatures();

  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && !ALL_FLAGS.includes(flag)) {
      console.warn(
        `[FeatureGuard] Warning: The flag "${flag}" is not recognized in constants/featureFlags.js. This may be a typo.`
      );
    }
  }, [flag]);

  // Handle loading state - we don't want to flicker, but for safety return null
  if (loading) return null;

  const isEnabled = isFlagEnabled(flag);
  const shouldShow = inverted ? !isEnabled : isEnabled;

  if (shouldShow) {
    return <>{children}</>;
  }

  return <>{fallback}</>;
};
