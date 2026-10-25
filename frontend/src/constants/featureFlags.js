import { z } from 'zod';
import {
  Clock,
  Flag,
  History,
  Star,
  ThermometerSun,
  Trophy,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { IS_DEV_SERVER } from '../env.js';

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
  // Retired with the Compliance page (plan docs/changes/2026-10-22-admin-focus.md,
  // R1): nothing reads it and the settings page no longer offers it. The key
  // stays so an organization that stored it still parses (skill
  // squadlogic-feature-guardians, "Retiring").
  MEDICAL_FORMS: 'medical_forms',
  WAITLIST: 'waitlist',

  // Field heat-stress (WBGT) forecast; off unless an admin turns it on.
  HEAT_FORECAST: 'heat_forecast',

  // Score entry and standings: admin functions the league turns on, off
  // unless set (plan docs/changes/2026-10-22-admin-focus.md, R6, owner
  // decision 4). `update_game_score` reads `score_entry` itself
  // (`org_flag(org, 'score_entry', false)`, 20261028010000) and refuses 55000
  // while it is off; `standings` hides the standings page only (standings are
  // computed from games every member reads, so it is presentation, not
  // authorization).
  SCORE_ENTRY: 'score_entry',
  STANDINGS: 'standings',

  // Retired with the coach directory (plan docs/changes/2026-10-22-admin-focus.md,
  // R4; migration 20261025010000): coaches see no contact details, so nothing
  // reads it and the settings page no longer offers it. The key stays so an
  // organization that stored it still parses (skill
  // squadlogic-feature-guardians, "Retiring").
  COACH_DIRECTORY: 'coach_directory',
  // Retired with the guardian view (plan docs/changes/2026-10-22-admin-focus.md,
  // R3; migration 20261024010000): nothing reads it and the settings page no
  // longer offers it. The key stays so an organization that stored it still
  // parses (skill squadlogic-feature-guardians, "Retiring").
  GUARDIAN_CONTACT_SHARING: 'guardian_contact_sharing',
};

/** String-valued org setting stored alongside the boolean flags. */
export const GENDER_MODEL_KEY = 'gender_model';
export const GENDER_MODELS = ['split', 'coed'];

/**
 * String-valued org setting: the league's buddy rule (Phase B1). `mutual` pairs two players
 * only when each names the other, one buddy per player; `one_way_best_effort` also scores a
 * one-way request best effort when the named player listed no buddy. The same values as
 * `BUDDY_RULES` in `packages/core/src/buddyLinking.js` (`tests/buddyRuleSetting.test.jsx`).
 */
export const BUDDY_RULE_KEY = 'buddy_rule';
/** Each rule as the settings page offers it and the Teams page's buddy list names it. */
export const BUDDY_RULE_CHOICES = Object.freeze([
  {
    value: 'mutual',
    label: 'Mutual requests only',
    description:
      'Two players are kept together only when each names the other. One-way requests are listed for review.',
  },
  {
    value: 'one_way_best_effort',
    label: 'One-way requests, best effort',
    description:
      'A one-way request is also placed together where the roster allows, when the named player listed no buddy.',
  },
]);
export const BUDDY_RULE_OPTIONS = BUDDY_RULE_CHOICES.map((choice) => choice.value);

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
  [FEATURE_FLAGS.WAITLIST]: true,
  [GENDER_MODEL_KEY]: 'split',
  [BUDDY_RULE_KEY]: 'mutual',
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
  {
    key: FEATURE_FLAGS.SCORE_ENTRY,
    label: 'Score Entry',
    description:
      'Admins enter game scores (Scores & Results). Coaches do not enter scores. Off unless turned on.',
    icon: Flag,
    column: false,
  },
  {
    key: FEATURE_FLAGS.STANDINGS,
    label: 'Standings',
    description:
      'Show league standings to admins, ranked from the entered scores. Off unless turned on.',
    icon: Trophy,
    column: false,
  },
];

/**
 * Zod schema for validating the feature_flags JSONB object from Supabase.
 * Known boolean flags must be booleans; `gender_model` and `buddy_rule` must
 * each be one of their known strings, exactly (anything else is refused, not
 * coerced). Unknown keys are ignored (selective ignore).
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
        } else if (IS_DEV_SERVER) {
          console.warn(`[FeatureFlag] Ignoring invalid gender_model value: "${value}"`);
        }
        return;
      }
      if (key === BUDDY_RULE_KEY) {
        if (typeof value === 'string' && BUDDY_RULE_OPTIONS.includes(value)) {
          validated[key] = value;
        } else if (IS_DEV_SERVER) {
          console.warn(`[FeatureFlag] Ignoring invalid buddy_rule value: "${value}"`);
        }
        return;
      }
      if (ALL_FLAGS.includes(key) && typeof value === 'boolean') {
        validated[key] = value;
      } else if (IS_DEV_SERVER) {
        console.warn(`[FeatureFlag] Ignoring an unknown feature flag in database: "${key}"`);
      }
    });
    return validated;
  });
