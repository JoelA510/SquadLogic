/**
 * Shared date and time utilities.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME_SET = new Set(DAY_NAMES);

export function parseTimeOfDay(value, context) {
    if (value instanceof Date) {
        return value.getUTCHours() * 60 + value.getUTCMinutes();
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            throw new TypeError(`${context} numeric value must be non-negative`);
        }
        return Math.trunc(value);
    }

    if (typeof value !== 'string') {
        throw new TypeError(`${context} must be a string, Date, or number`);
    }

    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${context} cannot be empty`);
    }

    if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`${context} could not be parsed as a timestamp`);
        }
        return parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
    }

    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        throw new Error(`${context} must be formatted as HH:MM or a full timestamp`);
    }

    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        throw new Error(`${context} contains an invalid time`);
    }

    return hours * 60 + minutes;
}

export function parseDateOnly(value, context) {
    let date;
    if (value instanceof Date) {
        date = value;
    } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error(`${context} cannot be empty`);
        }
        date = new Date(trimmed);
    } else {
        throw new TypeError(`${context} must be a string or Date`);
    }

    if (Number.isNaN(date.getTime())) {
        throw new Error(`${context} is not a valid date`);
    }

    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function normalizeDayOfWeek(dayValue, context) {
    if (!dayValue || typeof dayValue !== 'string') {
        throw new TypeError(`${context} must include a day string`);
    }

    const trimmed = dayValue.trim();
    if (!trimmed) {
        throw new Error(`${context} day cannot be empty`);
    }

    const normalized = trimmed.slice(0, 3).toLowerCase();
    const mapped =
        {
            sun: 'Sun',
            mon: 'Mon',
            tue: 'Tue',
            wed: 'Wed',
            thu: 'Thu',
            fri: 'Fri',
            sat: 'Sat',
        }[normalized] ?? null;

    if (!mapped || !DAY_NAME_SET.has(mapped)) {
        throw new Error(`${context} has an unrecognised day value: ${dayValue}`);
    }

    return DAY_NAMES.indexOf(mapped);
}

export function intersectDateRanges(aStart, aEnd, bStart, bEnd) {
    const start = aStart > bStart ? aStart : bStart;
    const end = aEnd < bEnd ? aEnd : bEnd;
    if (end < start) {
        return null;
    }
    return { start, end };
}

export function findFirstWeekdayOnOrAfter(startDate, targetDayIndex) {
    const result = new Date(startDate.getTime());
    const delta = (targetDayIndex - result.getUTCDay() + 7) % 7;
    result.setUTCDate(result.getUTCDate() + delta);
    return result;
}

export function applyMinutesToDate(date, minutes) {
    const result = new Date(date.getTime());
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    result.setUTCHours(hours, mins, 0, 0);
    return result;
}

export function formatDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export { DAY_NAMES };
