/**
 * Shared normalization utilities for data persistence and processing.
 */

export function normalizeString(value, label, index) {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string${index !== undefined ? ` at index ${index}` : ''}`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${label} cannot be empty${index !== undefined ? ` at index ${index}` : ''}`);
    }
    return trimmed;
}

export function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new TypeError('Value must be a string when provided');
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function normalizeId(value, label, index) {
    return normalizeString(value, label ?? 'id', index);
}

export function normalizeTimestamp(value, label, fallbackIso) {
    if (value === undefined || value === null) {
        return fallbackIso;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError(`${label} must be a valid date or timestamp string`);
    }

    return date.toISOString();
}

export function normalizeJsonObject(value, label) {
    if (value === undefined || value === null) {
        return {};
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }

    return value;
}
