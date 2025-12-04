import {
  parseTimeOfDay,
  parseDateOnly,
  normalizeDayOfWeek,
  intersectDateRanges,
  findFirstWeekdayOnOrAfter,
  applyMinutesToDate,
  formatDate,
  DAY_NAMES,
} from './utils/date.js';

/**
 * Expand practice slots into season-phase aware "effective" slots that account for daylight adjustments.
 *
 * Each input slot represents a canonical weekly time window (e.g., Monday 7–8pm). Season phases describe
 * the early/late season boundaries so slots can be split into separate records when their validity ranges
 * intersect different phases. Optional per-phase overrides can adjust start/end times, capacity, or
 * duration minutes when the league shortens practices later in the season.
 *
 * @param {Object} params
 * @param {Array<Object>} params.slots - Base slot definitions. Supported fields include:
 *   - `id` (string, required)
 *   - `day` (string, required) – accepts shorthand (e.g., "Mon") or full names (e.g., "Monday").
 *   - `start` (Date|string, required) – baseline start timestamp or time-of-day.
 *   - `end` (Date|string, optional) – baseline end timestamp. Required when `durationMinutes` missing.
 *   - `durationMinutes` (number, optional) – fallback duration when `end` omitted.
 *   - `capacity` (number, required) – teams that can share the slot.
 *   - `validFrom`/`validUntil` (Date|string, optional) – constrain the slot's active range.
 *   - `seasonOverrides` (object, optional) – keyed by seasonPhaseId with overrides for `startTime`,
 *     `endTime`, `durationMinutes`, or `capacity`. A `default` key applies to all phases when a
 *     phase-specific override is not provided.
 *   - Additional metadata (fieldId, location, etc.) is preserved in the output.
 * @param {Array<Object>} params.seasonPhases - Ordered season phases with:
 *   - `id` (string, required)
 *   - `startDate` (Date|string, required)
 *   - `endDate` (Date|string, required)
 *   - `label` (string, optional)
 * @returns {Array<Object>} Expanded slots preserving metadata plus:
 *   - `baseSlotId` (string)
 *   - `seasonPhaseId` (string)
 *   - `effectiveFrom` / `effectiveUntil` (ISO date strings `YYYY-MM-DD`)
 *   - `start` / `end` (Date objects anchored to the first matching weekday within the phase)
 */
export function expandPracticeSlotsForSeason({ slots, seasonPhases }) {
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }
  if (!Array.isArray(seasonPhases) || seasonPhases.length === 0) {
    throw new TypeError('seasonPhases must be a non-empty array');
  }

  const normalizedPhases = seasonPhases.map((phase, index) => normalizePhase(phase, index));
  normalizedPhases.sort((a, b) => a.startDate - b.startDate);

  const seasonStart = normalizedPhases[0].startDate;
  const seasonEnd = normalizedPhases.reduce(
    (latest, phase) => (phase.endDate > latest ? phase.endDate : latest),
    normalizedPhases[0].endDate,
  );

  const expanded = [];

  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') {
      throw new TypeError('each slot must be an object');
    }
    if (!slot.id) {
      throw new TypeError('each slot requires an id');
    }
    if (slot.capacity === undefined) {
      throw new TypeError(`slot ${slot.id} requires a capacity`);
    }

    const capacity = Number(slot.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`slot ${slot.id} must define a positive capacity`);
    }

    const dayIndex = normalizeDayOfWeek(slot.day, `slot ${slot.id}`);
    const baseTimeRange = resolveBaseTimeRange(slot);
    const slotValidFrom = slot.validFrom ? parseDateOnly(slot.validFrom, `slot ${slot.id} validFrom`) : seasonStart;
    const slotValidUntil = slot.validUntil ? parseDateOnly(slot.validUntil, `slot ${slot.id} validUntil`) : seasonEnd;

    if (slotValidUntil < slotValidFrom) {
      throw new Error(`slot ${slot.id} validUntil precedes validFrom`);
    }

    for (const phase of normalizedPhases) {
      const effectiveRange = intersectDateRanges(slotValidFrom, slotValidUntil, phase.startDate, phase.endDate);
      if (!effectiveRange) {
        continue;
      }

      const override = selectOverride(slot.seasonOverrides, phase.id);
      const { startMinutes, endMinutes } = resolveTimeRange({
        baseTimeRange,
        override,
        slotId: slot.id,
        phaseId: phase.id,
      });
      const resolvedCapacity = override?.capacity !== undefined ? normalizeCapacity(override.capacity, slot.id, phase.id) : capacity;

      const firstOccurrence = findFirstWeekdayOnOrAfter(effectiveRange.start, dayIndex);
      if (!firstOccurrence || firstOccurrence > effectiveRange.end) {
        continue;
      }

      const startDateTime = applyMinutesToDate(firstOccurrence, startMinutes);
      const endDateTime = applyMinutesToDate(firstOccurrence, endMinutes);

      const { seasonOverrides, validFrom, validUntil, ...metadata } = slot;

      expanded.push({
        ...metadata,
        id: `${slot.id}::${phase.id}`,
        baseSlotId: slot.id,
        seasonPhaseId: phase.id,
        day: DAY_NAMES[dayIndex],
        capacity: resolvedCapacity,
        start: startDateTime,
        end: endDateTime,
        effectiveFrom: formatDate(effectiveRange.start),
        effectiveUntil: formatDate(effectiveRange.end),
      });
    }
  }

  expanded.sort((a, b) => {
    if (a.baseSlotId !== b.baseSlotId) {
      return a.baseSlotId.localeCompare(b.baseSlotId);
    }
    if (a.seasonPhaseId !== b.seasonPhaseId) {
      return a.seasonPhaseId.localeCompare(b.seasonPhaseId);
    }
    return a.start - b.start;
  });

  return expanded;
}

function normalizePhase(phase, index) {
  if (!phase || typeof phase !== 'object') {
    throw new TypeError(`seasonPhases[${index}] must be an object`);
  }
  if (!phase.id) {
    throw new TypeError(`seasonPhases[${index}] requires an id`);
  }
  if (!phase.startDate) {
    throw new TypeError(`seasonPhases[${index}] requires a startDate`);
  }
  if (!phase.endDate) {
    throw new TypeError(`seasonPhases[${index}] requires an endDate`);
  }

  const startDate = parseDateOnly(phase.startDate, `seasonPhases[${index}].startDate`);
  const endDate = parseDateOnly(phase.endDate, `seasonPhases[${index}].endDate`);

  if (endDate < startDate) {
    throw new Error(`season phase ${phase.id} has endDate before startDate`);
  }

  return { id: phase.id, startDate, endDate, label: phase.label ?? null };
}

function resolveBaseTimeRange(slot) {
  if (!slot.start) {
    throw new TypeError(`slot ${slot.id} requires a start time`);
  }

  const startMinutes = parseTimeOfDay(slot.start, `slot ${slot.id} start`);
  let endMinutes;

  if (slot.end !== undefined) {
    endMinutes = parseTimeOfDay(slot.end, `slot ${slot.id} end`);
  } else if (slot.durationMinutes !== undefined) {
    if (!Number.isFinite(slot.durationMinutes) || slot.durationMinutes <= 0) {
      throw new TypeError(`slot ${slot.id} durationMinutes must be a positive number`);
    }
    endMinutes = startMinutes + Math.trunc(slot.durationMinutes);
  } else {
    throw new TypeError(`slot ${slot.id} requires either an end time or durationMinutes`);
  }

  if (endMinutes <= startMinutes) {
    throw new Error(`slot ${slot.id} end time must be after start time`);
  }

  return { startMinutes, endMinutes };
}

function selectOverride(overrides, phaseId) {
  if (!overrides || typeof overrides !== 'object') {
    return null;
  }
  return overrides[phaseId] ?? overrides.default ?? null;
}

function resolveTimeRange({ baseTimeRange, override, slotId, phaseId }) {
  let startMinutes = baseTimeRange.startMinutes;
  let endMinutes = baseTimeRange.endMinutes;

  if (override) {
    if (override.startTime !== undefined) {
      startMinutes = parseTimeOfDay(override.startTime, `override for slot ${slotId} phase ${phaseId} startTime`);
    }
    if (override.endTime !== undefined) {
      endMinutes = parseTimeOfDay(override.endTime, `override for slot ${slotId} phase ${phaseId} endTime`);
    } else if (override.durationMinutes !== undefined) {
      const duration = Number(override.durationMinutes);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new TypeError(`override for slot ${slotId} phase ${phaseId} durationMinutes must be positive`);
      }
      endMinutes = startMinutes + Math.trunc(duration);
    }
  }

  if (endMinutes <= startMinutes) {
    throw new Error(`slot ${slot.id} phase ${phaseId} end time must be after start time`);
  }

  return { startMinutes, endMinutes };
}

function normalizeCapacity(value, slotId, phaseId) {
  const capacity = Number(value);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`override for slot ${slotId} phase ${phaseId} capacity must be positive`);
  }
  return Math.trunc(capacity);
}
