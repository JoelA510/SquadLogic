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
    const start = normalizeTime(row.start ?? row.startTime ?? row.start_time, `rows[${index}] start`);
    const end = normalizeTime(row.end ?? row.endTime ?? row.end_time, `rows[${index}] end`);

    if (end.minutes <= start.minutes) {
      throw new Error(`rows[${index}] end must be after start`);
    }

    const validFrom = normalizeDate(row.validFrom ?? row.valid_from, 'validFrom', index);
    const validUntil = normalizeDate(row.validUntil ?? row.valid_until, 'validUntil', index);

    const seasonOverrides = normalizeSeasonOverrides(
      row.seasonOverrides ?? row.season_overrides,
      index,
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

/**
 * Build Supabase-ready `practice_assignments` rows from scheduler outputs.
 *
 * @param {Object} params
 * @param {Array<{ teamId: string, slotId: string, source?: string }>} params.assignments
 * @param {Array<Object>} params.slots - Slot definitions that include `effectiveFrom` and `effectiveUntil`.
 * @param {string} [params.runId] - Optional scheduler run identifier to persist alongside assignments.
 * @returns {Array<Object>} Supabase row payloads with snake_case keys.
 */
export function buildPracticeAssignmentRows({ assignments, slots, runId } = {}) {
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
        `slot "${slot.id}" at slots[${index}] requires effectiveFrom and effectiveUntil`,
      );
    }
    if (slotById.has(slot.id)) {
      throw new Error(
        `duplicate slot id detected: "${slot.id}" at slots[${index}]`,
      );
    }

    slotById.set(slot.id, {
      ...slot,
      baseSlotId: slot.baseSlotId ?? slot.id,
      seasonPhaseId: slot.seasonPhaseId ?? null,
    });
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

    return {
      team_id: assignment.teamId,
      practice_slot_id: slot.id,
      base_slot_id: slot.baseSlotId,
      season_phase_id: slot.seasonPhaseId,
      effective_from: slot.effectiveFrom,
      effective_until: slot.effectiveUntil,
      effective_date_range: `[${slot.effectiveFrom},${slot.effectiveUntil}]`,
      source: normalizedSource,
      run_id: runId ?? null,
    };
  });
}

export async function persistPracticeAssignments({
  supabaseClient,
  assignments,
  slots,
  runId,
  upsert = false,
} = {}) {
  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    throw new TypeError('supabaseClient with a from() method is required');
  }

  const rows = buildPracticeAssignmentRows({ assignments, slots, runId });
  if (rows.length === 0) {
    return [];
  }

  const table = supabaseClient.from('practice_assignments');

  if (!table || typeof table !== 'object') {
    throw new TypeError('supabaseClient.from must return a query builder object');
  }

  const action = upsert ? table.upsert : table.insert;
  const actionName = upsert ? 'upsert' : 'insert';

  if (typeof action !== 'function') {
    throw new TypeError(`practice_assignments builder must expose a ${actionName}() method`);
  }

  const { data, error } = await action.call(table, rows);

  if (error) {
    const message = error.message ?? String(error);
    throw new Error(`Failed to persist practice assignments: ${message}`);
  }

  return data ?? null;
}
