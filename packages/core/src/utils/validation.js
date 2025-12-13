/**
 * Shared validation utilities for scheduling entities.
 */

export function validateTeam(team, index) {
    if (!team || typeof team !== 'object') {
        throw new TypeError(`each team must be an object${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (!team.id) {
        throw new TypeError(`each team requires an id${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (!team.division) {
        throw new TypeError(`team ${team.id} is missing a division`);
    }
}

export function validateSlot(slot, index) {
    if (!slot || typeof slot !== 'object') {
        throw new TypeError(`each slot must be an object${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (!slot.id) {
        throw new TypeError(`each slot requires an id${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (typeof slot.capacity !== 'number' || slot.capacity < 0) {
        throw new TypeError(`slot ${slot.id} must define a non-negative capacity`);
    }
    if (!slot.start || !slot.end) {
        throw new TypeError(`slot ${slot.id} must define start and end timestamps`);
    }

    const start = new Date(slot.start);
    const end = new Date(slot.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error(`slot ${slot.id} includes an invalid timestamp`);
    }
    if (end <= start) {
        throw new Error(`slot ${slot.id} must end after it starts`);
    }
}

export function validateAssignment(assignment, index) {
    if (!assignment || typeof assignment !== 'object') {
        throw new TypeError(`assignments must contain objects${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (typeof assignment.weekIndex !== 'number' || assignment.weekIndex <= 0) {
        throw new TypeError(`assignment.weekIndex must be a positive number${index !== undefined ? ` at index ${index}` : ''}`);
    }
    if (!assignment.division) {
        throw new TypeError('assignment.division is required');
    }
    if (!assignment.slotId) {
        throw new TypeError('assignment.slotId is required');
    }
    if (!assignment.homeTeamId || !assignment.awayTeamId) {
        throw new TypeError('assignments require homeTeamId and awayTeamId');
    }
    if (!assignment.start || !assignment.end) {
        throw new TypeError('assignments require start and end timestamps');
    }
    const start = new Date(assignment.start);
    const end = new Date(assignment.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TypeError('assignments must have valid ISO timestamps');
    }
    if (end <= start) {
        throw new TypeError('assignment end time must be after the start time');
    }
}
