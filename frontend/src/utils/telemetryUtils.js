import { logger } from '../lib/logger.js';

/**
 * Standard Header Aliases (Static Fallback).
 * Mirrors server-side validation logic.
 */
export const HEADER_ALIASES = {
  'first name': 'first_name',
  first_name: 'first_name',
  firstname: 'first_name',
  'last name': 'last_name',
  last_name: 'last_name',
  lastname: 'last_name',
  'date of birth': 'date_of_birth',
  date_of_birth: 'date_of_birth',
  dob: 'date_of_birth',
  birthdate: 'date_of_birth',
  'full name': 'full_name',
  full_name: 'full_name',
  'coach name': 'full_name',
  'coach first name': 'first_name',
  'coach last name': 'last_name',
  email: 'email',
  'email address': 'email',
  'email/userid': 'email',
  'email/user id': 'email',
  email_userid: 'email',
  'contact email': 'email',
  name: 'name',
  field: 'name',
  'field name': 'name',
  field_name: 'name',
  location: 'location',
  'location name': 'location',
  location_name: 'location',
  venue: 'location',
  subunit: 'subunit',
  'field subunit': 'subunit',
  field_subunit: 'subunit',
  day: 'day',
  'day of week': 'day',
  day_of_week: 'day',
  start: 'start',
  'start time': 'start',
  start_time: 'start',
  end: 'end',
  'end time': 'end',
  end_time: 'end',
  type: 'type',
  'slot type': 'type',
  slot_type: 'type',
  capacity: 'capacity',
  'valid from': 'valid_from',
  valid_from: 'valid_from',
  'valid until': 'valid_until',
  valid_until: 'valid_until',
  date: 'slot_date',
  'slot date': 'slot_date',
  slot_date: 'slot_date',
  week: 'week_index',
  week_index: 'week_index',
  surface: 'surface_type',
  'surface type': 'surface_type',
  surface_type: 'surface_type',
  size: 'size',
  'supports halves': 'supports_halves',
  supports_halves: 'supports_halves',
  lights: 'lighting_available',
  lighted: 'lighting_available',
  'lighting available': 'lighting_available',
  lighting_available: 'lighting_available',
  'coach willing': 'willing_to_coach',
  'willing to coach': 'willing_to_coach',
  buddy: 'buddy_request',
  'buddy request': 'buddy_request',
  'buddy id': 'buddy_request',
  buddy_id: 'buddy_request',
  'buddy external id': 'buddy_request',
  'buddy registration id': 'buddy_request',
  friend: 'buddy_request',
  'friend request': 'buddy_request',
  'mutual buddy code': 'mutual_buddy_code',
  mutual_buddy_code: 'mutual_buddy_code',
  'buddy code': 'mutual_buddy_code',
  buddy_code: 'mutual_buddy_code',
  skill: 'skill_tier',
  'skill level': 'skill_tier',
  'skill tier': 'skill_tier',
  level: 'skill_tier',
  id: 'gotsport_id',
  pid: 'gotsport_id',
  'official id': 'gotsport_id',
  'gotsport id': 'gotsport_id',
  gotsport_id: 'gotsport_id',
  'registration id': 'external_registration_id',
  registration_id: 'external_registration_id',
  external_registration_id: 'external_registration_id',
  group: 'division_name',
  division: 'division_name',
  division_name: 'division_name',
  program: 'division_name',
  grade: 'grade',
  gender: 'gender',
  'preferred name': 'preferred_name',
  preferred_name: 'preferred_name',
  nickname: 'nickname',
  phone: 'phone',
  'contact phone': 'contact_phone',
  contact_phone: 'contact_phone',
  'guardian name': 'guardian_name',
  guardian_name: 'guardian_name',
  'parent name': 'parent_name',
  parent_name: 'parent_name',
  'guardian email': 'guardian_email',
  guardian_email: 'guardian_email',
  'parent email': 'parent_email',
  parent_email: 'parent_email',
  'guardian phone': 'guardian_phone',
  guardian_phone: 'guardian_phone',
  'parent phone': 'parent_phone',
  parent_phone: 'parent_phone',
  // GotSport registration export (redesign Phase 4 expanded mapping)
  'age group': 'age_group',
  age_group: 'age_group',
  'years played': 'years_played',
  years_played: 'years_played',
  'how many years has your player played in an organized soccer program?': 'years_played',
  'payment status': 'payment_status',
  payment_status: 'payment_status',
  waitlist: 'waitlist',
  waitlisted: 'waitlist',
  'play up': 'play_up',
  play_up: 'play_up',
  'are you coaching so this player can play up a division?': 'play_up',
  "can you coach for this player's team?": 'willing_to_coach',
  'if you have a buddy request for this player enter their first and last name exactly as it is entered on their registration. example samantha brown.':
    'buddy_request',
  'guardian 1 first name': 'guardian_1_first_name',
  guardian_1_first_name: 'guardian_1_first_name',
  'guardian 1 last name': 'guardian_1_last_name',
  guardian_1_last_name: 'guardian_1_last_name',
  'guardian 1 email address': 'guardian_1_email',
  'guardian 1 email': 'guardian_1_email',
  guardian_1_email: 'guardian_1_email',
  'guardian 1 alternate email': 'guardian_1_alternate_email',
  guardian_1_alternate_email: 'guardian_1_alternate_email',
  'guardian 2 first name': 'guardian_2_first_name',
  guardian_2_first_name: 'guardian_2_first_name',
  'guardian 2 last name': 'guardian_2_last_name',
  guardian_2_last_name: 'guardian_2_last_name',
  'guardian 2 email address': 'guardian_2_email',
  'guardian 2 email': 'guardian_2_email',
  guardian_2_email: 'guardian_2_email',
  'guardian 2 alternate email': 'guardian_2_alternate_email',
  guardian_2_alternate_email: 'guardian_2_alternate_email',
  season_label: 'season_label',
  'season label': 'season_label',
  record_status: 'record_status',
  'record status': 'record_status',
  primary_format: 'primary_format',
  'primary format': 'primary_format',
  format_quantity: 'format_quantity',
  'format quantity': 'format_quantity',
  secondary_format: 'secondary_format',
  'secondary format': 'secondary_format',
  available_from: 'available_from',
  'available from': 'available_from',
  available_until: 'available_until',
  'available until': 'available_until',
  availability_rule: 'availability_rule',
  'availability rule': 'availability_rule',
  blackout_months: 'blackout_months',
  'blackout months': 'blackout_months',
  teams_per_hour: 'teams_per_hour',
  'teams per hour': 'teams_per_hour',
  aggregate_teams_per_hour: 'aggregate_teams_per_hour',
  'aggregate teams per hour': 'aggregate_teams_per_hour',
  capacity_basis: 'capacity_basis',
  'capacity basis': 'capacity_basis',
  restroom_potty: 'restroom_potty',
  'restroom/potty': 'restroom_potty',
  goal_equipment: 'goal_equipment',
  'goal equipment': 'goal_equipment',
  goal_status: 'goal_status',
  'goal status': 'goal_status',
  approval_status: 'approval_status',
  'approval status': 'approval_status',
  use_context: 'use_context',
  'use context': 'use_context',
  day_constraints: 'day_constraints',
  'day constraints': 'day_constraints',
  move_to_location: 'move_to_location',
  'move to location': 'move_to_location',
  current_app_import_status: 'current_app_import_status',
  'current app import status': 'current_app_import_status',
  notes: 'notes',
};

/**
 * Core Immortality: System-critical fields that cannot be shadowed.
 */
export const RESERVED_KEYS = new Set([
  'id',
  'org_id',
  'organization_id',
  'created_at',
  'updated_at',
  'email',
  'first_name',
  'last_name',
  'phone',
  'full_name',
  'status',
  'profile_id',
  'user_id',
  'team_id',
  'division_id',
]);

// Phase 5 Hardening: Explicit list of native database columns for Players, Coaches, and Teams
export const SYSTEM_COLUMNS = new Set([
  ...Object.values(HEADER_ALIASES),
  ...RESERVED_KEYS,
  // Add additional mission-critical native columns not in the alias map
  'org_id',
  'id',
  'created_at',
  'updated_at',
  'status',
  'willing_to_coach',
  'buddy_request',
  'mutual_buddy_code',
  'skill_tier',
  'gotsport_id',
  'division_name',
  'organization_name',
]);

/**
 * Levenshtein distance for fuzzy header matching.
 * Returns a similarity score between 0 and 1.
 */
function getSimilarity(s1, s2) {
  let longer = s1;
  let shorter = s2;
  if (s1.length < s2.length) {
    longer = s2;
    shorter = s1;
  }
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;

  const distance = editDistance(longer, shorter);
  return (longerLength - distance) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

/**
 * Profile-specific biases.
 * Triggered when specific configurations are detected in telemetry.
 */
const PROFILE_BIASES = {
  gotsport_legacy: {
    id: 'gotsport_id',
    pid: 'gotsport_id',
    'official id': 'gotsport_id',
    group: 'division_name',
    division: 'division_name',
    org: 'organization_name',
  },
};

/**
 * Smart Header Matcher Engine.
 * Implements a 50ms circuit breaker and confidence scoring.
 *
 * @param {string[]} headers - The raw headers from the CSV.
 * @param {any[]} telemetryLogs - Historical telemetry logs for the organization.
 * @param {Object} customSchema - Organization-specific custom schema { field: type }.
 * @returns {Object} { mappings, confidence, rationales, timing, isFallback, needsConfirmation }
 */
export function matchHeaders(headers, telemetryLogs = [], customSchema = {}) {
  const startTime = performance.now();
  const mappings = {};
  const confidence = {};
  const rationales = {};
  const needsConfirmation = new Set();

  // 1. Detect Profile Hints from Telemetry
  const activeProfiles = new Set();
  telemetryLogs.forEach((log) => {
    const selections = log.payload?.selected || log.payload?.final_flags || {};
    if (Array.isArray(selections)) {
      if (selections.includes('gotsport_legacy')) activeProfiles.add('gotsport_legacy');
    } else if (selections.gotsport_legacy) {
      activeProfiles.add('gotsport_legacy');
    }
  });

  // Prepare custom keys for O(1) exact checks and fuzzy iteration
  const customKeys = Object.keys(customSchema);

  // 2. Matching Loop
  for (const rawHeader of headers) {
    // CIRCUIT BREAKER CHECK (Governance: < 50ms)
    const elapsed = performance.now() - startTime;
    if (elapsed > 50) {
      logger.warn(`[SmartIngestion] Circuit Breaker Tripped at ${elapsed.toFixed(2)}ms.`);
      return {
        mappings: simpleStaticMatch(headers),
        confidence: {},
        rationales: {},
        timing: elapsed,
        isFallback: true,
        needsConfirmation: [],
      };
    }

    const h = rawHeader.toLowerCase().trim();
    let bestMatch = h;
    let maxScore = 0;
    let reason = 'No match found';

    // A. RESERVED KEYS PROTECTION (Highest Priority 1.0)
    if (RESERVED_KEYS.has(h)) {
      bestMatch = h;
      maxScore = 1.0;
      reason = `System Reserved Key: '${h}'`;
    }

    // B. Profile Bias
    if (maxScore < 1.0) {
      activeProfiles.forEach((profile) => {
        const bias = PROFILE_BIASES[profile]?.[h];
        if (bias) {
          bestMatch = bias;
          maxScore = 0.95;
          reason = `Matched: '${rawHeader}' via ${profile} Profile`;
        }
      });
    }

    // C. Static Alias (High Priority)
    if (maxScore < 0.9 && HEADER_ALIASES[h]) {
      bestMatch = HEADER_ALIASES[h];
      maxScore = 0.9;
      reason = `Matched: '${rawHeader}' via Standard Alias`;
    }

    // D. Exact Match (Universal System Keys) - O(1)
    if (maxScore < 1.0 && SYSTEM_COLUMNS.has(h)) {
      bestMatch = h;
      maxScore = 1.0;
      reason = `Exact System Match: '${rawHeader}'`;
    }

    // E. Custom Attribute Matching (Fuzzy)
    if (maxScore < 0.9) {
      for (const customKey of customKeys) {
        // Skip if shadowed by a reserved key (Double insurance)
        if (RESERVED_KEYS.has(customKey)) continue;

        const similarity = getSimilarity(h, customKey.toLowerCase());

        // Governance: Levenshtein threshold 0.85
        if (similarity > 0.85 && similarity > maxScore) {
          bestMatch = customKey;
          maxScore = similarity;
          reason = `Fuzzy Match to Custom Attribute: '${customKey}' (${(similarity * 100).toFixed(0)}%)`;
        }
      }
    }

    // F. Final Confirmation Check (Governance: Match < 0.95)
    if (maxScore > 0 && maxScore < 0.95) {
      needsConfirmation.add(rawHeader);
    }

    // Save results
    mappings[rawHeader] = bestMatch;
    confidence[rawHeader] = maxScore;
    rationales[rawHeader] = reason;
  }

  const endTime = performance.now();
  return {
    mappings,
    confidence,
    rationales,
    timing: endTime - startTime,
    isFallback: false,
    needsConfirmation: Array.from(needsConfirmation),
  };
}

/**
 * Legacy static matching for fallback scenarios.
 */
function simpleStaticMatch(headers) {
  const result = {};
  headers.forEach((h) => {
    const normalized = h.toLowerCase().trim();
    result[h] = HEADER_ALIASES[normalized] ?? normalized;
  });
  return result;
}
