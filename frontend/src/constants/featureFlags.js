import { z } from 'zod';
import {
  Clock,
  History,
  ShieldCheck,
  Star,
  ThermometerSun,
  UserRoundCheck,
  Users,
} from 'lucide-react';

/**
 * Centralized registry of organization-level feature flags.
 * Use these constants throughout the application to ensure consistency
 * and avoid typos when using FeatureGuard or useOrganization context.
 */

export const FEATURE_FLAGS = {
  // Advanced scheduling complexities (Phase 1.2+)
  ADVANCED_FAIRNESS: 'advanced_fairness',
  COACH_OVERLAP_STRICT: 'coach_overlap_strict',

  // High-impact UI features (Phase 4)
  SPATIAL_CANVAS: 'spatial_canvas',
  SCHEDULE_MINIMAP: 'schedule_minimap',
  ENTERPRISE_OVERLAYS: 'enterprise_overlays',

  // Accessibility & Fallbacks (User Feedback)
  LIST_VIEW_TOGGLE: 'list_view_toggle',
  ACCESSIBILITY_LIST_VIEW: 'accessibility_list_view',

  // Management & Automation
  GHOST_ROSTERS: 'ghost_rosters',
  PIM_GUARDRAILS: 'pim_guardrails',
  FUZZY_IMPORT_MAPPING: 'fuzzy_import_mapping',

  // Org feature configuration ("Choose your tools" — redesign)
  YEARS_PLAYED: 'years_played',
  PLAYER_RATING: 'player_rating',
  BUDDY_REQUESTS: 'buddy_requests',
  COACHING_INTEREST: 'coaching_interest',
  MEDICAL_FORMS: 'medical_forms',
  WAITLIST: 'waitlist',

  // Field heat-stress (WBGT) forecast; off unless an admin turns it on.
  HEAT_FORECAST: 'heat_forecast',
};

/** String-valued org setting stored alongside the boolean flags. */
export const GENDER_MODEL_KEY = 'gender_model';
export const GENDER_MODELS = ['split', 'coed'];

// For development convenience, a list of all known flag names
export const ALL_FLAGS = Object.values(FEATURE_FLAGS);

/**
 * Defaults applied on top of the stored JSONB (absent key = default).
 * Recreational-league posture: Years Played on, 1–5 rating off.
 */
export const FEATURE_DEFAULTS = {
  [FEATURE_FLAGS.YEARS_PLAYED]: true,
  [FEATURE_FLAGS.PLAYER_RATING]: false,
  [FEATURE_FLAGS.BUDDY_REQUESTS]: true,
  [FEATURE_FLAGS.COACHING_INTEREST]: true,
  [FEATURE_FLAGS.MEDICAL_FORMS]: true,
  [FEATURE_FLAGS.WAITLIST]: true,
  [GENDER_MODEL_KEY]: 'split',
};

/**
 * User-facing catalog for the Features settings panel and the
 * "Choose your tools" setup step. `column` marks features that surface
 * as a Players-grid column.
 */
export const FEATURE_CATALOG = [
  {
    key: FEATURE_FLAGS.YEARS_PLAYED,
    label: 'Years Played',
    description:
      'Track how many seasons each player has played. Common in rec leagues that don’t rate players.',
    icon: History,
    column: true,
  },
  {
    key: FEATURE_FLAGS.PLAYER_RATING,
    label: 'Player Rating',
    description: '1–5 skill rating used for balanced teaming. Often left off in recreational play.',
    icon: Star,
    column: true,
  },
  {
    key: FEATURE_FLAGS.BUDDY_REQUESTS,
    label: 'Buddy Requests',
    description: 'Honor mutual friend requests during team generation.',
    icon: Users,
    column: true,
  },
  {
    key: FEATURE_FLAGS.COACHING_INTEREST,
    label: 'Coaching Interest',
    description: 'Capture parents willing to coach, pulled from registration.',
    icon: UserRoundCheck,
    column: true,
  },
  {
    key: FEATURE_FLAGS.MEDICAL_FORMS,
    label: 'Medical Forms',
    description: 'Track medical / consent form receipt in the compliance dashboard.',
    icon: ShieldCheck,
    column: false,
  },
  {
    key: FEATURE_FLAGS.WAITLIST,
    label: 'Waitlist',
    description: 'Flag and manage waitlisted registrants separately from active players.',
    icon: Clock,
    column: false,
  },
  {
    key: FEATURE_FLAGS.HEAT_FORECAST,
    label: 'Heat Forecast',
    description:
      'Forecast field WBGT per venue and kickoff from the NWS forecast, banded by U.S. Soccer heat guidelines. Decision support; on-site readings govern.',
    icon: ThermometerSun,
    column: false,
  },
];

/**
 * Zod schema for validating the feature_flags JSONB object from Supabase.
 * Known boolean flags must be booleans; `gender_model` must be a known
 * model string. Unknown keys are ignored (selective ignore).
 */
export const FeatureFlagSchema = z
  .record(z.string(), z.union([z.boolean(), z.string()]))
  .transform((flags) => {
    const validated = {};
    Object.keys(flags).forEach((key) => {
      const value = flags[key];
      if (key === GENDER_MODEL_KEY) {
        if (typeof value === 'string' && GENDER_MODELS.includes(value)) {
          validated[key] = value;
        } else if (process.env.NODE_ENV === 'development') {
          console.warn(`[FeatureFlag] Ignoring invalid gender_model value: "${value}"`);
        }
        return;
      }
      if (ALL_FLAGS.includes(key) && typeof value === 'boolean') {
        validated[key] = value;
      } else if (process.env.NODE_ENV === 'development') {
        console.warn(`[FeatureFlag] Ignoring an unknown feature flag in database: "${key}"`);
      }
    });
    return validated;
  });
