import { useMemo } from 'react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { BUDDY_RULE_OPTIONS, FEATURE_DEFAULTS, GENDER_MODELS } from '../constants/featureFlags.js';

/**
 * Org feature configuration with defaults applied.
 *
 * `isEnabled(key)` for boolean features; `genderModel` is the division
 * format ('split' | 'coed', default 'split'); `buddyRule` is the league's
 * buddy rule ('mutual' | 'one_way_best_effort', default 'mutual').
 */
export function useFeatures() {
  // Tolerate render outside OrganizationProvider (isolated component tests).
  const { featureFlags = {}, updateFeatureFlags, loading } = useOrganization() || {};

  return useMemo(() => {
    const effective = { ...FEATURE_DEFAULTS, ...featureFlags };
    const genderModel = GENDER_MODELS.includes(effective.gender_model)
      ? effective.gender_model
      : 'split';
    const buddyRule = BUDDY_RULE_OPTIONS.includes(effective.buddy_rule)
      ? effective.buddy_rule
      : 'mutual';
    return {
      features: effective,
      isEnabled: (key) => !!effective[key],
      genderModel,
      buddyRule,
      updateFeatureFlags,
      loading,
    };
  }, [featureFlags, updateFeatureFlags, loading]);
}
