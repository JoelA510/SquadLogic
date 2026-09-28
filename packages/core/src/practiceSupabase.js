import { expandPracticeSlotsForSeason } from './practiceSlotExpansion.js';

const DAY_MAP = {
  sun: 'Sun',
  sunday: 'Sun',
  mon: 'Mon',
  monday: 'Mon',
  tue: 'Tue',
  tuesday: 'Tue',
  wed: 'Wed',
  wednesday: 'Wed',
  thu: 'Thu',
  thursday: 'Thu',
  fri: 'Fri',
  friday: 'Fri',
  sat: 'Sat',
  saturday: 'Sat',
};

function normalizeDay(dayValue, index) {
  if (!dayValue || typeof dayValue !== 'string') {
    throw new TypeError(`rows[${index}] must include a day`);
  }

  const normalized = DAY_MAP[dayValue.trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`rows[${index}] has an unsupported day value: ${dayValue}`);
  }

  return normalized;
}

function normalizeTime(value, label) {
  if (value instanceof Date) {
    return {
      minutes: value.getUTCHours() * 60 + value.getUTCMinutes(),
      formatted: `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`,
    };
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string or Date`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  const parts = trimmed.split(':');
  const hours = Number(parts[0]);
  const minutes = Number(parts[1] ?? 0);

  if (!Number.isInteger(hours) || hours < 0 || hours >= 24) {
    throw new Error(`${label} contains an invalid hour component: ${value}`);
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 60) {
    throw new Error(`${label} contains an invalid minute component: ${value}`);
  }

  return {
    minutes: hours * 60 + minutes,
    formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

function normalizeDate(value, label, index) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string or Date for rows[${index}]`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty for rows[${index}]`);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is not a valid date for rows[${index}]: ${value}`);
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeId(row, index) {
  const id = row.id ?? row.slotId ?? row.slot_id;
  if (!id || typeof id !== 'string') {
    throw new TypeError(`rows[${index}] requires an id`);
  }
  return id;
}

function normalizeCapacity(row, index) {
  const capacity = row.capacity ?? row.slotCapacity;
  const numeric = Number(capacity);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`rows[${index}] capacity must be a positive number`);
  }

  return Math.trunc(numeric);
}

function selectField(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function normalizeSeasonOverrides(overrides, index) {
  if (overrides === undefined || overrides === null) {
    return null;
  }

  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError(`rows[${index}] seasonOverrides must be an object when provided`);
  }

  const normalized = {};

  for (const [phaseId, rawOverride] of Object.entries(overrides)) {
    if (!rawOverride || typeof rawOverride !== 'object') {
      throw new TypeError(`rows[${index}] seasonOverrides for phase ${phaseId} must be an object`);
    }

    const startTime = rawOverride.startTime ?? rawOverride.start_time;
    const endTime = rawOverride.endTime ?? rawOverride.end_time;
    const durationMinutes = rawOverride.durationMinutes ?? rawOverride.duration_minutes;
    const capacity = rawOverride.capacity ?? rawOverride.slotCapacity;

    normalized[phaseId] = {
      ...(startTime != null ? { startTime } : {}),
      ...(endTime != null ? { endTime } : {}),
      ...(durationMinutes != null ? { durationMinutes } : {}),
      ...(capacity != null ? { capacity } : {}),
    };
  }

  return normalized;
}

export function buildPracticeSlotsFromSupabaseRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`rows[${index}] must be an object`);
    }

    const id = normalizeId(row, index);
    const day = normalizeDay(row.day ?? row.dayOfWeek ?? row.day_of_week, index);
    const start = normalizeTime(
      row.start ?? row.startTime ?? row.start_time,
      `rows[${index}] start`
    );
    const end = normalizeTime(row.end ?? row.endTime ?? row.end_time, `rows[${index}] end`);

    if (end.minutes <= start.minutes) {
      throw new Error(`rows[${index}] end must be after start`);
    }

    const validFrom = normalizeDate(row.validFrom ?? row.valid_from, 'validFrom', index);
    const validUntil = normalizeDate(row.validUntil ?? row.valid_until, 'validUntil', index);

    const seasonOverrides = normalizeSeasonOverrides(
      row.seasonOverrides ?? row.season_overrides,
      index
    );

    if (validUntil < validFrom) {
      throw new Error(`rows[${index}] validUntil precedes validFrom`);
    }

    const capacity = normalizeCapacity(row, index);

    return {
      id,
      day,
      start: start.formatted,
      end: end.formatted,
      capacity,
      validFrom,
      validUntil,
      fieldId: selectField(row.fieldId ?? row.field_id),
      fieldSubunitId: selectField(row.fieldSubunitId ?? row.field_subunit_id),
      location: row.location ?? row.fieldLabel ?? null,
      ...(seasonOverrides ? { seasonOverrides } : {}),
    };
  });
}

export function expandSupabasePracticeSlots({ rows, seasonPhases }) {
  const normalizedSlots = buildPracticeSlotsFromSupabaseRows(rows);
  return expandPracticeSlotsForSeason({ slots: normalizedSlots, seasonPhases });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One assignment's date window: its own `effectiveFrom`/`effectiveUntil` when
 * given, each defaulting to the slot's bound, validated to lie inside the
 * slot's window. ISO dates compare correctly as strings.
 */
function resolveAssignmentWindow(assignment, slot, index) {
  // null means "the slot's bound", as in PracticeAssignmentSchema and materialise.js.
  const ownFrom = assignment.effectiveFrom ?? undefined;
  const ownUntil = assignment.effectiveUntil ?? undefined;
  if (ownFrom === undefined && ownUntil === undefined) {
    return { from: slot.effectiveFrom, until: slot.effectiveUntil };
  }
  for (const [name, value] of [
    ['effectiveFrom', ownFrom],
    ['effectiveUntil', ownUntil],
  ]) {
    if (value !== undefined && (typeof value !== 'string' || !ISO_DATE.test(value))) {
      throw new Error(`assignments[${index}].${name} must be an ISO date (YYYY-MM-DD)`);
    }
  }
  const from = ownFrom ?? slot.effectiveFrom;
  const until = ownUntil ?? slot.effectiveUntil;
  if (from < slot.effectiveFrom || until > slot.effectiveUntil || from > until) {
    throw new Error(
      `assignments[${index}] range [${from},${until}] must lie inside slot "${slot.id}" ` +
        `window [${slot.effectiveFrom},${slot.effectiveUntil}]`
    );
  }
  return { from, until };
}

/**
 * Build Supabase-ready `practice_assignments` rows from scheduler outputs.
 *
 * @param {Object} params
 * @param {Array<{ teamId: string, slotId: string, source?: string, effectiveFrom?: string, effectiveUntil?: string }>} params.assignments
 *   `effectiveFrom`/`effectiveUntil` (ISO dates, 8.6 PR 3b plan §3) narrow one
 *   assignment's range inside its slot's window -- a repair placement starts
 *   mid-season. Absent, the row spans the slot's window as before.
 * @param {Array<Object>} params.slots - Slot definitions that include `effectiveFrom` and `effectiveUntil`.
 * @param {string} [params.runId] - Optional scheduler run identifier to persist alongside assignments.
 * @returns {Array<Object>} Row payloads keyed `team_id`, `practice_slot_id`,
 *   `effective_date_range`, `source` and `run_id` — the first four are what
 *   `persist_practice_schedule` declares in its `jsonb_to_recordset`, and
 *   `run_id` is a real `practice_assignments` column that the RPC drops from
 *   the payload and fills from `run_data` instead, so no writer reads this key.
 *   Nothing else may be added without a receiver.
 */
export function buildPracticeAssignmentRows(
  { assignments, slots, runId } = { assignments: [], slots: [] }
) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  const slotById = new Map();
  slots.forEach((slot, index) => {
    if (!slot || typeof slot !== 'object') {
      throw new TypeError(`slots[${index}] must be an object`);
    }
    if (!slot.id) {
      throw new TypeError(`slots[${index}] requires an id`);
    }
    if (!slot.effectiveFrom || !slot.effectiveUntil) {
      throw new Error(
        `slot "${slot.id}" at slots[${index}] requires effectiveFrom and effectiveUntil`
      );
    }
    if (slotById.has(slot.id)) {
      throw new Error(`duplicate slot id detected: "${slot.id}" at slots[${index}]`);
    }

    // `baseSlotId`/`seasonPhaseId` were defaulted here for the two row keys
    // removed below. With nothing reading them, defaulting them would be the
    // same unread-field habit one step earlier, so they go with the keys.
    slotById.set(slot.id, { ...slot });
  });

  const normalizeSource = (value, index) => {
    if (value === 'locked' || value === 'manual') {
      return 'manual';
    }
    if (value === undefined || value === null || value === 'auto') {
      return 'auto';
    }
    throw new Error(`assignments[${index}] has an unsupported source: ${value}`);
  };

  return assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== 'object') {
      throw new TypeError(`assignments[${index}] must be an object`);
    }
    if (!assignment.teamId) {
      throw new TypeError(`assignments[${index}] requires a teamId`);
    }
    if (!assignment.slotId) {
      throw new TypeError(`assignments[${index}] requires a slotId`);
    }

    const slot = slotById.get(assignment.slotId);
    if (!slot) {
      throw new Error(`assignments[${index}] references unknown slotId: ${assignment.slotId}`);
    }

    const normalizedSource = normalizeSource(assignment.source, index);
    const { from, until } = resolveAssignmentWindow(assignment, slot, index);

    // Every key here must be received by something. `base_slot_id`,
    // `season_phase_id`, `effective_from` and `effective_until` were not:
    // `persist_practice_schedule` declares only `team_id`,
    // `practice_slot_id`, `slot_id`, `effective_date_range` and `source` in
    // its `jsonb_to_recordset`, which drops every key it does not name, and
    // the `practice_assignments` table has no such columns at all.
    // `effective_from`/`effective_until` were the misleading pair: they read
    // as an alternative the RPC might accept instead of
    // `effective_date_range`, which is composed from those same two values
    // and is the only form anything reads.
    // `tests/practiceSupabase.test.js` now checks this key set against the
    // recordset parsed out of the migration, so the two cannot drift again.
    return {
      team_id: assignment.teamId,
      practice_slot_id: slot.id,
      effective_date_range: `[${from},${until}]`,
      source: normalizedSource,
      run_id: runId ?? null,
    };
  });
}

export const SEASON_PRACTICE_PAGE_SIZE = 1000;
export const SEASON_PRACTICE_MAX_PAGES = 1000;

/**
 * Every CURRENT `practice_assignments` row of one season -- the page's side
 * of the auto-scheduler's lock cross-check (8.6 PR 3b PR 7).
 *
 * **Why a season read, not a run read.** Writer v3 is add-only: rows placed
 * by every earlier save stay in the season carrying their own `run_id`. A
 * reader keyed on the latest run therefore stops listing them from the second
 * run on, while the auto-scheduler loads by season and refuses the run.
 *
 * **One contract with the Edge loader.** Same table, same season scope (org +
 * season through teams -> divisions, the writer's `scope`), same slot reading
 * (`practice_slot_id ?? slot_id`, the writer's COALESCE), same paging: advance
 * by the rows actually returned and stop only on an EMPTY page, so a server
 * `max-rows` cap below `pageSize` is never read as the end. The twin is
 * `loadSeasonPracticeLock` in `supabase/functions/_shared/engines/practice-lock.ts`;
 * `tests/practiceSeasonLock.test.jsx` holds the two to one recorded query.
 *
 * Never partial: any failed page, or a read that does not end within
 * `maxPages`, is `{ ok: false }` -- a caller must not lock against half a season.
 *
 * @param {{ from: (table: string) => any }} client - the caller's Supabase client (RLS applies)
 * @param {{ organizationId: string, seasonSettingsId: string, pageSize?: number, maxPages?: number }} params
 * @returns {Promise<{ ok: true, rows: Array<{ id: string, teamId: string, slotId: string|null,
 *   effectiveDateRange: string|null, assignedVia: string|null, source: string|null,
 *   runId: string|null }> } | { ok: false, message: string }>}
 */
export async function loadSeasonPracticeAssignments(client, params) {
  const {
    organizationId,
    seasonSettingsId,
    pageSize = SEASON_PRACTICE_PAGE_SIZE,
    maxPages = SEASON_PRACTICE_MAX_PAGES,
  } = params ?? {};
  if (!organizationId || !seasonSettingsId) {
    return { ok: false, message: 'an organization and a season are required' };
  }
  const raw = [];
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      return { ok: false, message: `practice_assignments: no end after ${maxPages} pages` };
    }
    const from = raw.length;
    const { data, error } = await client
      .from('practice_assignments')
      .select(
        'id, team_id, practice_slot_id, slot_id, effective_date_range, assigned_via, source, ' +
          'run_id, teams!inner(divisions!inner(season_settings_id))'
      )
      .eq('organization_id', organizationId)
      .eq('teams.divisions.season_settings_id', seasonSettingsId)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      return { ok: false, message: `practice_assignments: ${error.message ?? 'unknown error'}` };
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) break;
    raw.push(...rows);
  }
  const text = (value) => (value === null || value === undefined ? null : String(value));
  return {
    ok: true,
    rows: raw.map((row) => ({
      id: String(row.id),
      teamId: String(row.team_id),
      slotId: text(row.practice_slot_id ?? row.slot_id),
      effectiveDateRange: text(row.effective_date_range),
      assignedVia: text(row.assigned_via),
      source: text(row.source),
      runId: text(row.run_id),
    })),
  };
}
