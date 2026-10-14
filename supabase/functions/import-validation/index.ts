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
import { checkRateLimit, rateLimitExceededResponse } from '../_shared/rateLimit.ts';
import { logFailure, withFailureLogging } from '../_shared/logtail.ts';

// --- Constants ---
const MAX_ROWS = 5000;
const MAX_STRING_LENGTH = 500;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// --- Sanitization ---
function sanitizeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return (
    str
      .replace(/<[^>]*>/g, '') // Strip HTML tags
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Strip control chars
      .trim()
      .slice(0, MAX_STRING_LENGTH)
  );
}

// --- Schema Definitions ---
const REQUIRED_FIELDS: Record<string, string[]> = {
  players: ['first_name', 'last_name', 'date_of_birth'],
  coaches: ['full_name', 'email'],
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
  medical: 'medical_info',
  'medical info': 'medical_info',
  allergy: 'medical_info',
  allergies: 'medical_info',
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
        message: `Invalid date format: ${row['date_of_birth']}`,
      });
    }
  }

  if (importType === 'coaches' && row['email']) {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(row['email'])) {
      errors.push({
        row: rowIndex + 1,
        field: 'email',
        message: `Invalid email format: ${row['email']}`,
      });
    }
  }

  if (
    row['skill_tier'] &&
    !['novice', 'developing', 'advanced'].includes(row['skill_tier'].toLowerCase())
  ) {
    errors.push({
      row: rowIndex + 1,
      field: 'skill_tier',
      message: `Invalid skill tier: ${row['skill_tier']}. Must be novice, developing, or advanced.`,
    });
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
  import_type: z.enum(['players', 'coaches', 'fields', 'field_availability']),
  organization_id: z.string().uuid(),
  rows: z.array(z.record(z.unknown())).max(MAX_ROWS, `Maximum ${MAX_ROWS} rows per import`),
  file_name: z.string().max(255),
  import_job_id: z.string().uuid().optional(),
  row_offset: z.number().int().min(0).optional().default(0),
});

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

  // 3. Parse and validate request body
  let body: z.infer<typeof ImportValidationPayload>;
  try {
    const raw = await req.json();
    const parsed = ImportValidationPayload.safeParse(raw);
    if (!parsed.success) {
      return jsonResponse(
        { status: 'error', message: 'Invalid payload', issues: parsed.error.issues },
        400
      );
    }
    body = parsed.data;
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid JSON' }, 400);
  }

  // 4. Verify org admin access before staging or validating import payloads.
  const isOrgAdmin = await verifyOrgAdmin(serviceClient, user.id, body.organization_id);
  if (!isOrgAdmin) {
    return jsonResponse(
      { status: 'error', message: 'Access denied: not an admin of this organization' },
      403
    );
  }
  logCtx.organizationId = body.organization_id;

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

  for (let i = 0; i < body.rows.length; i++) {
    const rawRow = body.rows[i] as Record<string, unknown>;

    // Normalize headers via alias map
    const normalizedRow: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawRow)) {
      const normalizedKey = normalizeHeader(key);
      normalizedRow[normalizedKey] = sanitizeString(value);
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
          raw_payload: Object.fromEntries(
            Object.entries(rawRow).map(([key, value]) => [key, sanitizeString(value)])
          ),
          normalized_payload: normalizedRow,
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
  await recordAuditNow(createUserClient(req, supabaseUrl, anonKey), {
    organizationId: body.organization_id,
    action: allErrors.length > 0 && validatedRows.length === 0 ? 'import.failed' : 'import.started',
    resourceType: 'import_job',
    metadata: {
      import_type: body.import_type,
      file_name: body.file_name,
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
