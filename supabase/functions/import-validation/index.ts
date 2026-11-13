/**
 * Import Validation Edge Function (Phase 2.1, Finding H-1)
 *
 * Server-side validation layer for CSV import data. The frontend sends
 * parsed CSV rows here BEFORE inserting into import_jobs. This function:
 *   1. Validates the user's JWT and org membership
 *   2. Enforces schema rules (required fields, data types, length limits)
 *   3. Sanitizes all string values (strips HTML, limits length)
 *   4. Returns validated + sanitized rows or structured validation errors
 *
 * The frontend import flow remains identical — this runs transparently
 * between client-side parsing and the Supabase insert.
 */
import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import {
  createUserClient,
  getUserFromRequest,
  verifyOrgAdmin,
  recordAuditNow,
  corsHeaders,
  jsonResponse,
} from '../_shared/auth.ts';
import { asDemoClient, readDemoState } from '../_shared/demo.ts';
import { checkRateLimit, rateLimitExceededResponse } from '../_shared/rateLimit.ts';
import { logFailure, withFailureLogging } from '../_shared/logtail.ts';
import { SENSITIVE_IMPORT_TYPES, stripSensitiveColumns } from '../_shared/sensitive-headers.ts';
import {
  ALLOWLIST_ENTITY_TYPES,
  isAllowedImportKey,
  isAllowlistedImportType,
  keepAllowedColumns,
  withDeclaredColumns,
  withoutBirthKeys,
} from '../_shared/import-allowlist.ts';
import {
  importNaturalAge,
  type ImportSeason,
  type WindowedDivision,
} from '../_shared/natural-age.ts';
import { composeFullName, normalizeImportRow, sanitizeImportText } from '../_shared/import-rows.ts';
import { validateEvaluationRow } from '../_shared/import-evaluations.ts';
import { loadImportAgeRule } from '../_shared/import-age-rule.ts';
import {
  applyGameImportConfirmed,
  GAME_IMPORT_LIMITS,
  isGameImportConfirmCounts,
  loadGameImportSeason,
  type SeasonReader,
  stageGameChunk,
} from '../_shared/schedule-import.ts';
import {
  applyPracticeImportConfirmed,
  isPracticeImportConfirmCounts,
  PRACTICE_IMPORT_LIMITS,
  PracticeImportDateError,
  stagePracticeFile,
} from '../_shared/practice-import.ts';

// --- Constants ---
const MAX_ROWS = 5000;
const MAX_STRING_LENGTH = 500;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// --- Sanitization ---
function sanitizeString(value: unknown): string {
  return sanitizeImportText(value, MAX_STRING_LENGTH);
}

// --- Schema Definitions ---
const REQUIRED_FIELDS: Record<string, string[]> = {
  players: ['first_name', 'last_name', 'date_of_birth'],
  coaches: ['full_name', 'email'],
  practice_preferences: ['email'],
  fields: ['location', 'name', 'type', 'start', 'end'],
  field_availability: [
    'season_label',
    'location',
    'field_name',
    'available_from',
    'available_until',
  ],
};

// GotSport header alias map (strict matching, not fuzzy .includes())
const HEADER_ALIASES: Record<string, string> = {
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
  // The evaluations import's 1-5 rating (E3c); the player import does not keep it.
  rating: 'rating',
  'skill rating': 'rating',
  'player rating': 'rating',
  id: 'gotsport_id',
  pid: 'gotsport_id',
  'official id': 'gotsport_id',
  'gotsport id': 'gotsport_id',
  gotsport_id: 'gotsport_id',
  'registration id': 'external_registration_id',
  registration_id: 'external_registration_id',
  external_registration_id: 'external_registration_id',
  // The coach import's optional link to a coach's children: player registration ids (S7). A bare
  // `player id` is not aliased: a player file uses it as a registration-id column (player_id).
  'child registration id': 'child_registration_id',
  'child id': 'child_registration_id',
  child_registration_id: 'child_registration_id',
  // The practice preference import (Phase D C1): one row is one rule. The finalizer reads these
  // canonical keys (`team` is read as it is, `start time` and `valid from` already have aliases).
  'coach email': 'email',
  'request level': 'request_level',
  'request type': 'request_level',
  'preference level': 'request_level',
  'prefer or must': 'request_level',
  strength: 'request_level',
  request_level: 'request_level',
  days: 'weekdays',
  weekdays: 'weekdays',
  'practice days': 'weekdays',
  'preferred days': 'weekdays',
  'start times': 'start_times',
  start_times: 'start_times',
  'practice start times': 'start_times',
  'preferred start times': 'start_times',
  venues: 'venues',
  'preferred venues': 'venues',
  'preferred locations': 'venues',
  'effective from': 'effective_from',
  effective_from: 'effective_from',
  'from date': 'effective_from',
  from: 'effective_from',
  'effective to': 'effective_to',
  'effective until': 'effective_to',
  effective_to: 'effective_to',
  'to date': 'effective_to',
  until: 'effective_to',
  priority: 'coach_priority',
  'coach priority': 'coach_priority',
  coach_priority: 'coach_priority',
  group: 'division_name',
  division: 'division_name',
  division_name: 'division_name',
  program: 'division_name',
  grade: 'grade',
  gender: 'gender',
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

  season_label: 'season_label',
  'season label': 'season_label',
  record_status: 'record_status',
  'record status': 'record_status',
  blackout_months: 'blackout_months',
  'blackout months': 'blackout_months',
  teams_per_hour: 'teams_per_hour',
  'teams per hour': 'teams_per_hour',
  aggregate_teams_per_hour: 'aggregate_teams_per_hour',
  'aggregate teams per hour': 'aggregate_teams_per_hour',
  capacity_basis: 'capacity_basis',
  'capacity basis': 'capacity_basis',
  restroom_potty: 'restroom_potty',
  'restroom potty': 'restroom_potty',
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
  available_from: 'available_from',
  'available from': 'available_from',
  available_until: 'available_until',
  'available until': 'available_until',
  availability_rule: 'availability_rule',
  'availability rule': 'availability_rule',
  primary_format: 'primary_format',
  'primary format': 'primary_format',
  format_quantity: 'format_quantity',
  'format quantity': 'format_quantity',
  secondary_format: 'secondary_format',
  'secondary format': 'secondary_format',
};

function normalizeHeader(header: string): string {
  const lower = header.toLowerCase().trim();
  return HEADER_ALIASES[lower] ?? lower;
}

function parseTimeMinutes(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = match[3]?.toLowerCase();

  if (minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}

// --- Validation ---
interface ValidationError {
  row: number;
  field: string;
  message: string;
}

function validateRow(
  row: Record<string, string>,
  importType: string,
  rowIndex: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  const required = REQUIRED_FIELDS[importType] ?? [];

  for (const field of required) {
    if (!row[field] || row[field].trim() === '') {
      errors.push({
        row: rowIndex + 1,
        field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // Type-specific validation
  if (importType === 'players' && row['date_of_birth']) {
    const dob = new Date(row['date_of_birth']);
    if (isNaN(dob.getTime())) {
      errors.push({
        row: rowIndex + 1,
        field: 'date_of_birth',
        // The row and field say where; the value stays out of the message,
        // which is stored in import_jobs.error_summary (R0).
        message: 'Invalid date format',
      });
    }
  }

  if ((importType === 'coaches' || importType === 'practice_preferences') && row['email']) {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(row['email'])) {
      errors.push({
        row: rowIndex + 1,
        field: 'email',
        message: 'Invalid email format',
      });
    }
  }

  // The evaluations import judges the tier itself (`validateEvaluationRow`), with a message that
  // points a number at the Rating column; a second error for the same cell would only repeat it.
  if (
    importType !== 'evaluations' &&
    row['skill_tier'] &&
    !['novice', 'developing', 'advanced'].includes(row['skill_tier'].toLowerCase())
  ) {
    errors.push({
      row: rowIndex + 1,
      field: 'skill_tier',
      message: `Invalid skill tier: ${row['skill_tier']}. Must be novice, developing, or advanced.`,
    });
  }

  // E3c: a registration id, and each value within its range (nothing quotes the value).
  if (importType === 'evaluations') {
    for (const error of validateEvaluationRow(row)) {
      errors.push({ row: rowIndex + 1, field: error.field, message: error.message });
    }
  }

  if (importType === 'fields') {
    const slotType = row['type']?.toLowerCase();
    if (slotType && !['practice', 'game'].includes(slotType)) {
      errors.push({
        row: rowIndex + 1,
        field: 'type',
        message: `Invalid field slot type: ${row['type']}. Must be practice or game.`,
      });
    }

    const start = parseTimeMinutes(row['start']);
    const end = parseTimeMinutes(row['end']);
    if (row['start'] && start === null) {
      errors.push({
        row: rowIndex + 1,
        field: 'start',
        message: `Invalid start time: ${row['start']}`,
      });
    }
    if (row['end'] && end === null) {
      errors.push({
        row: rowIndex + 1,
        field: 'end',
        message: `Invalid end time: ${row['end']}`,
      });
    }
    if (start !== null && end !== null && end <= start) {
      errors.push({
        row: rowIndex + 1,
        field: 'end',
        message: 'End time must be after start time',
      });
    }

    if (row['capacity']) {
      const capacity = Number.parseInt(row['capacity'], 10);
      if (!Number.isInteger(capacity) || capacity < 1) {
        errors.push({
          row: rowIndex + 1,
          field: 'capacity',
          message: `Invalid capacity: ${row['capacity']}. Must be at least 1.`,
        });
      }
    }

    if (slotType === 'practice') {
      if (!row['day']) {
        errors.push({
          row: rowIndex + 1,
          field: 'day',
          message: 'Practice field rows require day',
        });
      }
      if (!row['valid_from'] || !row['valid_until']) {
        errors.push({
          row: rowIndex + 1,
          field: 'valid_from',
          message: 'Practice field rows require valid_from and valid_until',
        });
      }
    }

    if (slotType === 'game' && !row['slot_date'] && !row['valid_from']) {
      errors.push({
        row: rowIndex + 1,
        field: 'slot_date',
        message: 'Game field rows require slot_date',
      });
    }
  }

  if (importType === 'field_availability') {
    const availableFrom = row['available_from'];
    const availableUntil = row['available_until'];
    if (availableFrom && Number.isNaN(new Date(availableFrom).getTime())) {
      errors.push({
        row: rowIndex + 1,
        field: 'available_from',
        message: `Invalid available_from date: ${availableFrom}`,
      });
    }
    if (availableUntil && Number.isNaN(new Date(availableUntil).getTime())) {
      errors.push({
        row: rowIndex + 1,
        field: 'available_until',
        message: `Invalid available_until date: ${availableUntil}`,
      });
    }
    if (availableFrom && availableUntil && new Date(availableUntil) < new Date(availableFrom)) {
      errors.push({
        row: rowIndex + 1,
        field: 'available_until',
        message: 'available_until must be on/after available_from',
      });
    }
    const tph = row['teams_per_hour'];
    if (tph) {
      const n = Number.parseInt(tph, 10);
      if (!Number.isInteger(n) || n < 1)
        errors.push({
          row: rowIndex + 1,
          field: 'teams_per_hour',
          message: 'teams_per_hour must be a positive integer',
        });
    }
    const atph = row['aggregate_teams_per_hour'];
    if (atph) {
      const n = Number.parseInt(atph, 10);
      if (!Number.isInteger(n) || n < 1)
        errors.push({
          row: rowIndex + 1,
          field: 'aggregate_teams_per_hour',
          message: 'aggregate_teams_per_hour must be a positive integer',
        });
    }
  }
  return errors;
}

// --- Request Schema ---
const ImportValidationPayload = z.object({
  import_type: z.enum([
    'players',
    'coaches',
    'fields',
    'field_availability',
    'practice_preferences',
    'evaluations',
  ]),
  organization_id: z.string().uuid(),
  rows: z.array(z.record(z.unknown())).max(MAX_ROWS, `Maximum ${MAX_ROWS} rows per import`),
  // `file_name` is no longer read: it went only into the audit row, and the
  // audit log does not keep upload file names (data minimisation, owner
  // decision 2026-10-14). A client that still sends it has it stripped.
  import_job_id: z.string().uuid().optional(),
  row_offset: z.number().int().min(0).optional().default(0),
});

/**
 * A games import (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.2, PR 6). Its own shape, because a schedule
 * file is not a people file: the header row travels with each chunk (the allowlist is by header name, and there is no
 * alias map), a chunk is at most 500 rows of a file of at most 2,400, and the confirm is a second action.
 *
 * - `action: 'stage'` (the default): read one chunk and stage it. The season, and so the clock, is the JOB's.
 * - `action: 'apply'`: the confirm. `confirmed` is the counts the admin saw; the dry run is run again and the apply
 *   is refused with `game_import_preview_stale` when its counts differ (task F7).
 */
const GamesImportPayload = z.object({
  import_type: z.literal('games'),
  action: z.enum(['stage', 'apply']).optional().default('stage'),
  organization_id: z.string().uuid(),
  import_job_id: z.string().uuid(),
  headers: z
    .array(z.string().max(GAME_IMPORT_LIMITS.MAX_CELL_LENGTH))
    .max(GAME_IMPORT_LIMITS.MAX_COLUMNS)
    .optional()
    .default([]),
  rows: z
    .array(z.record(z.unknown()))
    .max(
      GAME_IMPORT_LIMITS.MAX_CHUNK_ROWS,
      `Maximum ${GAME_IMPORT_LIMITS.MAX_CHUNK_ROWS} rows per request`
    )
    .optional()
    .default([]),
  row_offset: z.number().int().min(0).max(GAME_IMPORT_LIMITS.MAX_ROWS).optional().default(0),
  confirmed: z.record(z.union([z.number(), z.boolean()])).optional(),
});

/**
 * A practice schedule import (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11; PR 11, task L1). The mapping and
 * the preview are the database's own RPCs, called by the admin's client.
 *
 * - `action: 'stage'` (the default): read the file and stage it, into a job that is still `importing` (a staged job is
 *   never staged again: a new file is a new job, so a ready job cannot be left with no rows).
 * - `action: 'apply'`: the confirm. `confirmed` is the counts the admin saw; the dry run is run again AS THE CALLER and
 *   the apply is refused with `practice_import_preview_stale` when its counts differ (`applyPracticeImportConfirmed`).
 * - **The whole file in one request** (at most 2,400 rows): the parse judges the file as a whole and a row key is
 *   unique in it; it converts no instant, so the cap is a few milliseconds of CPU (`_shared/practice-import.ts`).
 * - `dates`: the confirm step's two dates (decision 25), which stand in for a row's blank `Valid From`/`Valid Until`
 *   ahead of the season's. A date that is not a calendar date is refused here, before anything is read.
 */
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const PracticeImportPayload = z.object({
  import_type: z.literal('practice_schedule'),
  action: z.enum(['stage', 'apply']).optional().default('stage'),
  organization_id: z.string().uuid(),
  import_job_id: z.string().uuid(),
  headers: z
    .array(z.string().max(PRACTICE_IMPORT_LIMITS.MAX_CELL_LENGTH))
    .max(PRACTICE_IMPORT_LIMITS.MAX_COLUMNS)
    .optional()
    .default([]),
  rows: z
    .array(z.record(z.unknown()))
    .max(
      PRACTICE_IMPORT_LIMITS.MAX_ROWS,
      `One import takes at most ${PRACTICE_IMPORT_LIMITS.MAX_ROWS} rows`
    )
    .optional()
    .default([]),
  confirmed: z.record(z.number()).optional(),
  dates: z
    .object({
      valid_from: z.string().regex(ISO_DATE_TEXT).nullable().optional(),
      valid_until: z.string().regex(ISO_DATE_TEXT).nullable().optional(),
    })
    .strict()
    .nullable()
    .optional(),
});

/** The HTTP status a database refusal of the games RPCs is answered with. */
function statusOfDatabaseError(code: string | undefined): number {
  if (code === '42501') return 403;
  if (code === 'P0002') return 404;
  if (code === '22023' || code === '23505') return 409;
  return 500;
}

// --- Handler ---
const handler = withFailureLogging('import-validation', async (req: Request, logCtx) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  // The audit row is written AS THE CALLER (`record_audit_event` attributes it
  // to auth.uid()), which needs the anon key.
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonResponse({ status: 'error', message: 'Server configuration error' }, 500);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 1. Authenticate
  const user = await getUserFromRequest(req, serviceClient);
  if (!user) {
    return jsonResponse({ status: 'error', message: 'Unauthorized' }, 401);
  }

  // 1b. Rate limit (Phase 3.2, M-4) — imports limited to 10/min (heavier operation)
  const rateCheck = checkRateLimit(user.id, { maxRequests: 10, windowMs: 60_000 });
  if (!rateCheck.allowed) {
    return rateLimitExceededResponse(rateCheck);
  }

  // 2. Check Content-Length (DoS protection)
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return jsonResponse(
      {
        status: 'error',
        message: `Payload too large. Maximum size is ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB.`,
      },
      413
    );
  }

  // 3. Parse and validate request body. A games import and a practice schedule import have their own shapes (see
  // `GamesImportPayload` and `PracticeImportPayload`).
  let parsedGeneric: z.infer<typeof ImportValidationPayload> | null = null;
  let parsedGames: z.infer<typeof GamesImportPayload> | null = null;
  let parsedPractices: z.infer<typeof PracticeImportPayload> | null = null;
  try {
    const raw = await req.json();
    const type =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>).import_type
        : undefined;
    const isGames = type === 'games';
    const isPractices = type === 'practice_schedule';
    const parsed = isGames
      ? GamesImportPayload.safeParse(raw)
      : isPractices
        ? PracticeImportPayload.safeParse(raw)
        : ImportValidationPayload.safeParse(raw);
    if (!parsed.success) {
      return jsonResponse(
        { status: 'error', message: 'Invalid payload', issues: parsed.error.issues },
        400
      );
    }
    if (isGames) parsedGames = parsed.data as z.infer<typeof GamesImportPayload>;
    else if (isPractices) parsedPractices = parsed.data as z.infer<typeof PracticeImportPayload>;
    else parsedGeneric = parsed.data as z.infer<typeof ImportValidationPayload>;
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid JSON' }, 400);
  }
  // Constants from here on: a callback below reads them, and only a constant keeps its narrowing inside one.
  const games = parsedGames;
  const practices = parsedPractices;
  const generic = parsedGeneric;
  const organizationId = (games ?? practices ?? generic)?.organization_id;
  if (!organizationId) {
    return jsonResponse({ status: 'error', message: 'Invalid payload' }, 400);
  }

  // 4. Verify org admin access before staging or validating import payloads.
  const isOrgAdmin = await verifyOrgAdmin(serviceClient, user.id, organizationId);
  if (!isOrgAdmin) {
    return jsonResponse(
      { status: 'error', message: 'Access denied: not an admin of this organization' },
      403
    );
  }
  logCtx.organizationId = organizationId;

  // The demo league imports nothing (D3): no file is validated or staged for it. The database
  // refuses its import jobs and staged rows too; this is the early answer.
  const demo = await readDemoState(asDemoClient(serviceClient), organizationId);
  if (demo === null || demo.isDemo) {
    return jsonResponse(
      {
        status: 'error',
        code: 'demo_import_refused',
        message: 'The demo league cannot import files. Create an account to import your own.',
      },
      403
    );
  }

  // ---------------------------------------------------------------------------------------------- games
  if (games) {
    const { data: job, error: jobError } = await serviceClient
      .from('import_jobs')
      .select('id, organization_id, job_type, status, season_settings_id')
      .eq('id', games.import_job_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (jobError) {
      await logFailure(logCtx, 'Import job lookup failed', jobError);
      return jsonResponse({ status: 'error', message: 'Import job lookup failed' }, 500);
    }
    if (!job) {
      return jsonResponse(
        { status: 'error', message: 'Import job not found for organization' },
        404
      );
    }
    if (job.job_type !== 'games') {
      return jsonResponse(
        { status: 'error', message: `Import job type ${job.job_type} does not match games` },
        409
      );
    }

    // The confirm (F7): the database is asked AS THE CALLER, so `auth.uid()` is the admin, the
    // function's own checks hold, and the audit rows it writes are theirs.
    if (games.action === 'apply') {
      if (!isGameImportConfirmCounts(games.confirmed)) {
        return jsonResponse(
          {
            status: 'error',
            code: 'confirmed_counts_required',
            message:
              'The confirm must carry the counts of the preview it confirms. Preview the import again.',
          },
          400
        );
      }
      const userClient = createUserClient(req, supabaseUrl, anonKey);
      const outcome = await applyGameImportConfirmed({
        rpc: (name, params) => userClient.rpc(name, params),
        jobId: games.import_job_id,
        confirmed: games.confirmed,
      });
      if (outcome.kind === 'stale') {
        return jsonResponse(
          {
            status: 'error',
            code: outcome.code,
            message: outcome.message,
            differing: outcome.differing,
            confirmed: outcome.confirmed,
            current: outcome.current,
            preview: outcome.preview,
          },
          409
        );
      }
      if (outcome.kind === 'error') {
        const status = statusOfDatabaseError(outcome.error.code);
        if (status === 500) {
          await logFailure(logCtx, `Games import ${outcome.stage} failed`, outcome.error);
        }
        return jsonResponse(
          {
            status: 'error',
            code: outcome.error.details || outcome.error.code || 'game_import_failed',
            message:
              status === 500
                ? 'The import could not be applied.'
                : (outcome.error.message ?? 'The import was refused.'),
          },
          status
        );
      }
      return jsonResponse({ status: 'success', import_type: 'games', result: outcome.result });
    }

    if (['completed', 'completed_with_warnings', 'failed', 'needs_fix'].includes(job.status)) {
      return jsonResponse(
        { status: 'error', message: `Import job cannot accept staged rows while ${job.status}` },
        409
      );
    }
    if (games.row_offset + games.rows.length > GAME_IMPORT_LIMITS.MAX_ROWS) {
      // Said by the parse too, from the offset; this is the answer when the chunk itself is empty.
      return jsonResponse(
        {
          status: 'refused',
          import_type: 'games',
          code: 'too-many-rows',
          message: `One import takes at most ${GAME_IMPORT_LIMITS.MAX_ROWS} rows. Split the file and import the parts one after the other.`,
        },
        200
      );
    }

    // The clock and the window are the season the JOB imports into: never the request's word.
    // Read by the shared module: the handler itself reads no season (the player arm's rule is one call, and
    // `_shared/tests/import-age-rule_test.ts` holds the handler to that).
    const { data: seasonRow, error: seasonError } = await loadGameImportSeason(
      // The client's own query types are wider than the three calls this read makes.
      serviceClient as unknown as SeasonReader,
      { seasonSettingsId: job.season_settings_id, organizationId }
    );
    if (seasonError) {
      await logFailure(logCtx, 'Season lookup failed', seasonError);
      return jsonResponse({ status: 'error', message: 'Season lookup failed' }, 500);
    }
    if (!seasonRow) {
      return jsonResponse(
        {
          status: 'error',
          code: 'season_missing',
          message: 'This import has no season to import into. Start the import again.',
        },
        409
      );
    }

    let chunk: ReturnType<typeof stageGameChunk>;
    try {
      chunk = stageGameChunk({
        headers: games.headers,
        rows: games.rows as Array<Record<string, unknown>>,
        season: {
          timeZone: seasonRow.timezone ?? null,
          startDate: seasonRow.season_start ?? null,
          endDate: seasonRow.season_end ?? null,
        },
        rowOffset: games.row_offset,
      });
    } catch (error) {
      // The parse throws only on a season date that is not a date: a defect in stored data, not in the file.
      if (!(error instanceof TypeError)) throw error;
      await logFailure(logCtx, 'Season dates could not be read for a games import', error);
      return jsonResponse(
        { status: 'error', message: 'The season’s dates could not be read.' },
        500
      );
    }

    const userClient = createUserClient(req, supabaseUrl, anonKey);
    if (chunk.refusal) {
      await recordAuditNow(userClient, logCtx, {
        organizationId,
        action: 'import.failed',
        resourceType: 'import_job',
        metadata: {
          import_type: 'games',
          total_rows: games.rows.length,
          valid_rows: 0,
          error_rows: games.rows.length,
          staged_rows: 0,
          refusal: chunk.refusal.code,
        },
      });
      return jsonResponse({
        status: 'refused',
        import_type: 'games',
        code: chunk.refusal.code,
        message: chunk.refusal.message,
        column: chunk.refusal.column ?? null,
      });
    }

    // The first chunk starts the file over: nothing a previous attempt staged under this job stays.
    const stale = serviceClient
      .from('staging_import_rows')
      .delete()
      .eq('import_job_id', games.import_job_id)
      .eq('import_type', 'games');
    const { error: deleteError } =
      games.row_offset === 0
        ? await stale
        : await stale.in(
            'source_row_number',
            chunk.staged.map((row) => row.source_row_number)
          );
    if (deleteError) {
      await logFailure(logCtx, 'Failed to replace staged games rows', deleteError);
      return jsonResponse(
        { status: 'error', message: 'Failed to replace staged import rows' },
        500
      );
    }
    if (chunk.staged.length > 0) {
      const { error: stageError } = await serviceClient.from('staging_import_rows').insert(
        chunk.staged.map((row) => ({
          import_job_id: games.import_job_id,
          organization_id: organizationId,
          import_type: 'games',
          source_row_number: row.source_row_number,
          raw_payload: row.raw_payload,
          normalized_payload: row.normalized_payload,
          validation_errors: row.validation_errors,
        }))
      );
      if (stageError) {
        await logFailure(logCtx, 'Failed to stage games rows', stageError);
        return jsonResponse({ status: 'error', message: 'Failed to stage import rows' }, 500);
      }
    }

    await recordAuditNow(userClient, logCtx, {
      organizationId,
      action: 'import.started',
      resourceType: 'import_job',
      metadata: {
        import_type: 'games',
        total_rows: chunk.summary.rows,
        valid_rows: chunk.summary.ok + chunk.summary.tbd,
        error_rows: chunk.summary.refused,
        staged_rows: chunk.staged.length,
        row_offset: games.row_offset,
      },
    });

    return jsonResponse({
      status: 'success',
      import_type: 'games',
      row_offset: games.row_offset,
      total_rows: chunk.summary.rows,
      staged_rows: chunk.staged.length,
      valid_rows: chunk.summary.ok + chunk.summary.tbd,
      error_rows: chunk.summary.refused,
      summary: chunk.summary,
    });
  }

  // ---------------------------------------------------------------------------------------------- practice schedule
  if (practices) {
    const { data: job, error: jobError } = await serviceClient
      .from('import_jobs')
      .select('id, organization_id, job_type, status, season_settings_id')
      .eq('id', practices.import_job_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (jobError) {
      await logFailure(logCtx, 'Import job lookup failed', jobError);
      return jsonResponse({ status: 'error', message: 'Import job lookup failed' }, 500);
    }
    if (!job) {
      return jsonResponse(
        { status: 'error', message: 'Import job not found for organization' },
        404
      );
    }
    if (job.job_type !== 'practice_schedule') {
      return jsonResponse(
        {
          status: 'error',
          message: `Import job type ${job.job_type} does not match practice_schedule`,
        },
        409
      );
    }
    // The confirm: the database is asked AS THE CALLER, so `auth.uid()` is the admin, the function's own checks hold,
    // and the audit rows it writes are theirs.
    if (practices.action === 'apply') {
      if (!isPracticeImportConfirmCounts(practices.confirmed)) {
        return jsonResponse(
          {
            status: 'error',
            code: 'confirmed_counts_required',
            message:
              'The confirm must carry the counts of the preview it confirms. Preview the import again.',
          },
          400
        );
      }
      const userClient = createUserClient(req, supabaseUrl, anonKey);
      const outcome = await applyPracticeImportConfirmed({
        rpc: (name, params) => userClient.rpc(name, params),
        jobId: practices.import_job_id,
        confirmed: practices.confirmed,
      });
      if (outcome.kind === 'stale') {
        return jsonResponse(
          {
            status: 'error',
            code: outcome.code,
            message: outcome.message,
            differing: outcome.differing,
            confirmed: outcome.confirmed,
            current: outcome.current,
            preview: outcome.preview,
          },
          409
        );
      }
      if (outcome.kind === 'error') {
        const status = statusOfDatabaseError(outcome.error.code);
        if (status === 500) {
          await logFailure(logCtx, `Practice import ${outcome.stage} failed`, outcome.error);
        }
        return jsonResponse(
          {
            status: 'error',
            code: outcome.error.details || outcome.error.code || 'practice_import_failed',
            message:
              status === 500
                ? 'The import could not be applied.'
                : (outcome.error.message ?? 'The import was refused.'),
          },
          status
        );
      }
      return jsonResponse({
        status: 'success',
        import_type: 'practice_schedule',
        result: outcome.result,
      });
    }

    // A file is staged once, into a job still importing: a staged (ready) job is never emptied and staged again.
    if (job.status !== 'importing') {
      return jsonResponse(
        {
          status: 'error',
          code: 'import_not_importing',
          message: `Import job cannot accept staged rows while ${job.status}: a new file is a new import.`,
        },
        409
      );
    }
    // The season's window is the JOB's season, never the request's word (the games import's shared read; it is
    // read here, not changed).
    const { data: seasonRow, error: seasonError } = await loadGameImportSeason(
      serviceClient as unknown as SeasonReader,
      { seasonSettingsId: job.season_settings_id, organizationId }
    );
    if (seasonError) {
      await logFailure(logCtx, 'Season lookup failed', seasonError);
      return jsonResponse({ status: 'error', message: 'Season lookup failed' }, 500);
    }
    if (!seasonRow) {
      return jsonResponse(
        {
          status: 'error',
          code: 'season_missing',
          message: 'This import has no season to import into. Start the import again.',
        },
        409
      );
    }

    const userClient = createUserClient(req, supabaseUrl, anonKey);
    let staged: ReturnType<typeof stagePracticeFile>;
    try {
      staged = stagePracticeFile({
        headers: practices.headers,
        rows: practices.rows as Array<Record<string, unknown>>,
        season: {
          startDate: seasonRow.season_start ?? null,
          endDate: seasonRow.season_end ?? null,
        },
        dates: {
          validFrom: practices.dates?.valid_from ?? null,
          validUntil: practices.dates?.valid_until ?? null,
        },
        clean: sanitizeImportText,
      });
    } catch (error) {
      // Only a date it was given that is not a calendar date (the request's, or the season's) is the file's answer;
      // anything else is a defect: audited as a failed import and rethrown, so the failure log has it too.
      await recordAuditNow(userClient, logCtx, {
        organizationId,
        action: 'import.failed',
        resourceType: 'import_job',
        metadata: {
          import_type: 'practice_schedule',
          total_rows: practices.rows.length,
          valid_rows: 0,
          error_rows: practices.rows.length,
          staged_rows: 0,
          refusal: error instanceof PracticeImportDateError ? 'bad-date' : 'stage_error',
        },
      });
      if (!(error instanceof PracticeImportDateError)) throw error;
      return jsonResponse(
        {
          status: 'refused',
          import_type: 'practice_schedule',
          code: 'bad-date',
          message:
            'A date chosen for the import, or one of the season’s, is not a calendar date. Choose the dates again.',
        },
        200
      );
    }

    if (staged.refusal) {
      await recordAuditNow(userClient, logCtx, {
        organizationId,
        action: 'import.failed',
        resourceType: 'import_job',
        metadata: {
          import_type: 'practice_schedule',
          total_rows: practices.rows.length,
          valid_rows: 0,
          error_rows: practices.rows.length,
          staged_rows: 0,
          refusal: staged.refusal.code,
        },
      });
      return jsonResponse({
        status: 'refused',
        import_type: 'practice_schedule',
        code: staged.refusal.code,
        message: staged.refusal.message,
        column: staged.refusal.column ?? null,
      });
    }
    // The allowlist, asserted: a staged key it does not hold is a defect of the stage, never stored.
    const stray = staged.staged
      .flatMap((row) => Object.keys(row.normalized_payload ?? {}))
      .find((key) => !isAllowedImportKey('practice_schedule', key));
    if (stray !== undefined) {
      await logFailure(logCtx, 'A practice row carried a key the allowlist does not hold', {
        message: stray,
      });
      return jsonResponse({ status: 'error', message: 'Failed to stage import rows' }, 500);
    }

    // The file is one request, so what an earlier attempt staged under this job goes first.
    const { error: deleteError } = await serviceClient
      .from('staging_import_rows')
      .delete()
      .eq('import_job_id', practices.import_job_id)
      .eq('import_type', 'practice_schedule');
    if (deleteError) {
      await logFailure(logCtx, 'Failed to replace staged practice rows', deleteError);
      return jsonResponse(
        { status: 'error', message: 'Failed to replace staged import rows' },
        500
      );
    }
    if (staged.staged.length > 0) {
      const { error: stageError } = await serviceClient.from('staging_import_rows').insert(
        staged.staged.map((row) => ({
          import_job_id: practices.import_job_id,
          organization_id: organizationId,
          import_type: 'practice_schedule',
          source_row_number: row.source_row_number,
          raw_payload: row.raw_payload,
          normalized_payload: row.normalized_payload,
          validation_errors: row.validation_errors,
        }))
      );
      if (stageError) {
        await logFailure(logCtx, 'Failed to stage practice rows', stageError);
        return jsonResponse({ status: 'error', message: 'Failed to stage import rows' }, 500);
      }
    }

    const s = staged.summary;
    await recordAuditNow(userClient, logCtx, {
      organizationId,
      action: 'import.started',
      resourceType: 'import_job',
      metadata: {
        import_type: 'practice_schedule',
        total_rows: s.rows,
        valid_rows: s.placements + s.open + s.holds,
        error_rows: s.refused,
        staged_rows: staged.staged.length,
      },
    });

    return jsonResponse({
      status: 'success',
      import_type: 'practice_schedule',
      total_rows: s.rows,
      staged_rows: staged.staged.length,
      valid_rows: s.placements + s.open + s.holds,
      error_rows: s.refused,
      summary: s,
    });
  }

  if (!generic) {
    return jsonResponse({ status: 'error', message: 'Invalid payload' }, 400);
  }
  const body = generic;

  if (body.import_job_id) {
    const { data: job, error: jobError } = await serviceClient
      .from('import_jobs')
      .select('id, organization_id, job_type, status')
      .eq('id', body.import_job_id)
      .eq('organization_id', body.organization_id)
      .maybeSingle();

    if (jobError) {
      await logFailure(logCtx, 'Import job lookup failed', jobError);
      return jsonResponse({ status: 'error', message: 'Import job lookup failed' }, 500);
    }

    if (!job) {
      return jsonResponse(
        { status: 'error', message: 'Import job not found for organization' },
        404
      );
    }

    const expectedJobType =
      body.import_type === 'fields'
        ? 'fields'
        : body.import_type === 'field_availability'
          ? 'field_availability'
          : body.import_type === 'evaluations'
            ? 'evaluations'
            : 'registration';
    if (job.job_type !== expectedJobType) {
      return jsonResponse(
        {
          status: 'error',
          message: `Import job type ${job.job_type} does not match ${body.import_type}`,
        },
        409
      );
    }

    if (['completed', 'completed_with_warnings', 'failed'].includes(job.status)) {
      return jsonResponse(
        { status: 'error', message: `Import job cannot accept staged rows while ${job.status}` },
        409
      );
    }
  }

  // 5. Normalize headers and sanitize all rows
  const validatedRows: Record<string, string>[] = [];
  const stagedRows: Record<string, unknown>[] = [];
  const stagedImportRows: Record<string, unknown>[] = [];
  const allErrors: ValidationError[] = [];

  // People imports drop the sensitive columns (medical, emergency, financial,
  // identity documents...) before anything is validated, staged or returned.
  // The browser strips them too, but this function is callable directly.
  const stripsSensitive = SENSITIVE_IMPORT_TYPES.includes(body.import_type);

  // People imports then keep only the allowlisted columns: the keys the
  // finalizer reads, team placement for players, and the fields the
  // organization declared for the entity (`_shared/import-allowlist.ts`). A
  // failed schema read fails the request: guessing "no declared fields" would
  // drop the organization's own columns without saying so.
  const allowlisted = isAllowlistedImportType(body.import_type);
  let declaredFields: string[] = [];
  // A preference file (Phase D C1) and an evaluations file (E3c) declare no fields: their entity is not
  // in Settings, so only the keys of their own lists stay.
  if (allowlisted && ALLOWLIST_ENTITY_TYPES[body.import_type] !== undefined) {
    const { data: schemaRow, error: schemaError } = await serviceClient
      .from('organization_schemas')
      .select('schema_definition')
      .eq('organization_id', body.organization_id)
      .eq('entity_type', ALLOWLIST_ENTITY_TYPES[body.import_type])
      .maybeSingle();
    if (schemaError) {
      await logFailure(logCtx, 'Organization schema lookup failed', schemaError);
      return jsonResponse({ status: 'error', message: 'Organization schema lookup failed' }, 500);
    }
    const definition = schemaRow?.schema_definition;
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
      declaredFields = Object.keys(definition);
    }
  }

  // A player's natural age (admin-focus plan R5) is counted in the season the
  // finalizer attaches the import's divisions to (the job's own, else the
  // active one: Phase E1), with that season's cutoff.
  // The file's birth date is read for it here and never staged: the staged
  // row carries the age, and the browser keeps the date for the session.
  let season: ImportSeason | null = null;
  // The season's divisions with a birthdate window (Phase E3b): a birth date in one counts as
  // that division's age. Read for the season the import adds to, and only when it has any.
  let windowedDivisions: WindowedDivision[] = [];
  if (body.import_type === 'players') {
    // The whole rule, and its revision, in one call that also stamps the job with that revision;
    // the ages below are counted from what it returned and from nothing read separately, so a
    // change made after it cannot be missed (finalization refuses a stale stamp: age_rule_changed).
    const loaded = await loadImportAgeRule(serviceClient, {
      organizationId: body.organization_id,
      importJobId: body.import_job_id,
      rowOffset: body.row_offset,
    });
    if (loaded.error) {
      await logFailure(logCtx, 'Age rule lookup failed', loaded.error);
      return jsonResponse({ status: 'error', message: 'Age rule lookup failed' }, 500);
    }
    season = loaded.rule.season;
    windowedDivisions = loaded.rule.windowedDivisions;
  }

  for (let i = 0; i < body.rows.length; i++) {
    const strippedRow = stripsSensitive
      ? stripSensitiveColumns(body.rows[i] as Record<string, unknown>)
      : (body.rows[i] as Record<string, unknown>);
    const rawRow = allowlisted
      ? keepAllowedColumns(body.import_type, strippedRow, normalizeHeader, declaredFields)
      : strippedRow;

    // Normalize headers via alias map; a blank never replaces a value two columns share, and a
    // coach row with first and last names but no full name gets one (_shared/import-rows.ts)
    let normalizedRow = normalizeImportRow(rawRow, normalizeHeader, sanitizeString);
    if (body.import_type === 'coaches') {
      normalizedRow = composeFullName(normalizedRow, sanitizeString);
    }
    // A declared field whose header is also a global alias (`Skill` ->
    // `skill_tier`) is carried under its own identity too, for
    // custom_attributes; the system field keeps its reading.
    if (allowlisted) {
      normalizedRow = withDeclaredColumns(
        body.import_type,
        normalizedRow,
        rawRow,
        normalizeHeader,
        declaredFields,
        sanitizeString
      );
    }

    if (body.import_type === 'players') {
      // Never read from the file: the birth date with the season's cutoff, else
      // the age group (the first non-blank of the keys the finalizer reads it under).
      const rest = { ...normalizedRow };
      delete rest['natural_age'];
      const ageGroup = ['age group', 'age_group', 'age']
        .map((key) => rest[key])
        .find((value) => value !== undefined && value !== null && String(value).trim() !== '');
      const naturalAge = importNaturalAge({
        ageGroup,
        dob: rest['date_of_birth'],
        seasonYear: season?.season_year ?? null,
        cutoffMode: season?.age_cutoff_mode ?? null,
        cutoffMonth: season?.age_cutoff_month ?? null,
        cutoffDay: season?.age_cutoff_day ?? null,
        divisions: windowedDivisions,
      });
      normalizedRow = naturalAge === null ? rest : { ...rest, natural_age: String(naturalAge) };
    }

    // Validate
    const rowErrors = validateRow(normalizedRow, body.import_type, i);
    if (rowErrors.length > 0) {
      allErrors.push(...rowErrors);
    } else {
      validatedRows.push(normalizedRow);
      if (body.import_type === 'players' && body.import_job_id) {
        stagedRows.push({
          import_job_id: body.import_job_id,
          organization_id: body.organization_id,
          source_row_number: body.row_offset + i + 1,
          // No birth key is staged (R5): the natural age stands in for it.
          raw_payload: Object.fromEntries(
            Object.entries(withoutBirthKeys('players', rawRow, normalizeHeader)).map(
              ([key, value]) => [key, sanitizeString(value)]
            )
          ),
          normalized_payload: withoutBirthKeys('players', normalizedRow, normalizeHeader),
          validation_errors: [],
        });
      } else if (body.import_type !== 'players' && body.import_job_id) {
        stagedImportRows.push({
          import_job_id: body.import_job_id,
          organization_id: body.organization_id,
          import_type: body.import_type,
          source_row_number: body.row_offset + i + 1,
          raw_payload: Object.fromEntries(
            Object.entries(rawRow).map(([key, value]) => [key, sanitizeString(value)])
          ),
          normalized_payload: normalizedRow,
          validation_errors: [],
        });
      }
    }
  }

  if (stagedRows.length > 0) {
    const sourceRowNumbers = stagedRows.map((row) => row.source_row_number);
    const { error: deleteError } = await serviceClient
      .from('staging_players')
      .delete()
      .eq('import_job_id', body.import_job_id)
      .in('source_row_number', sourceRowNumbers);

    if (deleteError) {
      await logFailure(logCtx, 'Failed to replace staged import rows', deleteError);
      return jsonResponse(
        { status: 'error', message: 'Failed to replace staged import rows' },
        500
      );
    }

    const { error: stageError } = await serviceClient.from('staging_players').insert(stagedRows);
    if (stageError) {
      await logFailure(logCtx, 'Failed to stage import rows', stageError);
      return jsonResponse({ status: 'error', message: 'Failed to stage import rows' }, 500);
    }
  }

  if (stagedImportRows.length > 0) {
    const sourceRowNumbers = stagedImportRows.map((row) => row.source_row_number);
    const { error: deleteError } = await serviceClient
      .from('staging_import_rows')
      .delete()
      .eq('import_job_id', body.import_job_id)
      .in('source_row_number', sourceRowNumbers);

    if (deleteError) {
      await logFailure(logCtx, 'Failed to replace staged non-player import rows', deleteError);
      return jsonResponse(
        { status: 'error', message: 'Failed to replace staged import rows' },
        500
      );
    }

    const { error: stageError } = await serviceClient
      .from('staging_import_rows')
      .insert(stagedImportRows);
    if (stageError) {
      await logFailure(logCtx, 'Failed to stage non-player import rows', stageError);
      return jsonResponse({ status: 'error', message: 'Failed to stage import rows' }, 500);
    }
  }

  // 6. Audit log (Phase 4), as the caller. Awaited: the response follows
  //    immediately, and the isolate can be frozen once it is sent.
  await recordAuditNow(createUserClient(req, supabaseUrl, anonKey), logCtx, {
    organizationId: body.organization_id,
    action: allErrors.length > 0 && validatedRows.length === 0 ? 'import.failed' : 'import.started',
    resourceType: 'import_job',
    metadata: {
      import_type: body.import_type,
      total_rows: body.rows.length,
      valid_rows: validatedRows.length,
      error_rows: allErrors.length,
      staged_rows: stagedRows.length + stagedImportRows.length,
    },
  });

  // 7. Return results
  return jsonResponse({
    status: 'success',
    import_type: body.import_type,
    total_rows: body.rows.length,
    valid_rows: validatedRows.length,
    error_rows: allErrors.length,
    staged_rows: stagedRows.length + stagedImportRows.length,
    validated_data: validatedRows,
    validation_errors: allErrors,
  });
});

serve(handler);
