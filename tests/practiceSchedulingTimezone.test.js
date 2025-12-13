import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedulePractices } from '../packages/core/src/practiceScheduling.js';

test('schedulePractices filters slots before school day end', async (t) => {
    const teams = [{ id: 't1', division: 'd1' }];

    // Create slots: one early (2 PM), one late (5 PM)
    // Using ISO strings for simplicity, assuming UTC or local doesn't matter for raw hour check
    // if timezone is not provided (logic falls back to skipping or simple check??)
    // Wait, my logic requires schoolDayEnd to split by ':' and check against Date object.
    // I need to be careful with Date construction in test.

    const baseDate = '2025-01-01T'; // A Wednesday
    const earlySlot = {
        id: 's1',
        start: new Date(`${baseDate}14:00:00`), // 2 PM
        end: new Date(`${baseDate}15:00:00`),
        capacity: 1,
        day: 'Wednesday'
    };
    const lateSlot = {
        id: 's2',
        start: new Date(`${baseDate}17:00:00`), // 5 PM
        end: new Date(`${baseDate}18:00:00`),
        capacity: 1,
        day: 'Wednesday'
    };

    // Case 1: No filter (should assign to early slot if it's first/best)
    // Actually, schedulePractices assigns to *best* slot.
    // We need to make early slot preferred or just check availability.
    // The function returns 'unassigned' if no slots available.

    const slots = [earlySlot, lateSlot];

    // Run with schoolDayEnd = '16:00'
    // But wait, my implementation of filtering in practiceScheduling.js uses `timezone`!
    // If timezone is NOT provided, it currently (in my code) skips filtering or does a fallback?
    // Let's check my implementation logic... "Fallback: If no timezone... We will skip filtering".
    // So I MUST provide a timezone to test the filtering.

    // using America/Los_Angeles to match the Date objects created locally (PST)

    const result = schedulePractices({
        teams,
        slots,
        schoolDayEnd: '16:00',
        timezone: 'America/Los_Angeles',
        scoringWeights: {}
    });

    // Expectation: earlySlot (14:00) should be filtered out.
    // Only lateSlot (17:00) should be available.
    // t1 should be assigned to s2.

    const assignment = result.assignments.find(a => a.teamId === 't1');
    assert.ok(assignment, 'Team should be assigned');
    assert.equal(assignment.slotId, 's2', 'Team should be assigned to late slot');
});


test('schedulePractices allow early slots on weekends', async (t) => {
    const teams = [{ id: 't1', division: 'd1' }];
    const baseDate = '2025-01-04T'; // Saturday
    const earlySlot = {
        id: 's1',
        start: new Date(`${baseDate}10:00:00`), // 10 AM
        end: new Date(`${baseDate}11:00:00`),
        capacity: 1,
        day: 'Saturday'
    };

    const result = schedulePractices({
        teams,
        slots: [earlySlot],
        schoolDayEnd: '16:00',
        timezone: 'UTC'
    });

    const assignment = result.assignments.find(a => a.teamId === 't1');
    assert.ok(assignment, 'Team should be assigned on Saturday morning');
    assert.equal(assignment.slotId, 's1');
});
