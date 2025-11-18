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
    };
  });
}
