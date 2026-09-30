/**
 * The exports stay series-level and say what they do not show (8.6 3b PR 12c,
 * plan §4 R9, operator answer Q6): "N practices have temporary changes not
 * shown in this export", N from `applyPracticeExceptions`' `meta`.
 *
 * N is checked against a count taken from the seed by hand (the series dates
 * that fall inside a live window), never against the helper's own output.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import OutputGenerationPanel from '../frontend/src/components/OutputGenerationPanel.jsx';
import {
  EXPORT_PRACTICE_CHANGES_UNREAD_TEXT,
  practiceChangesNoteOf,
  readUnshownPracticeChanges,
  unshownPracticeChangesOf,
} from '../frontend/src/utils/practiceExportChanges.js';

// Camel-cased, as `usePracticeAssignments` hands them to the export.
const ASSIGNMENTS = [
  {
    id: 'pa-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    effectiveDateRange: '[2026-11-02,2026-12-01)',
    practiceSlots: { dayOfWeek: 'mon', startTime: '17:00', endTime: '18:00' },
    day: 'Monday',
    fieldId: 'Field 1',
    slotId: 'practice_17:00',
  },
  {
    id: 'pa-2',
    organizationId: 'org-1',
    teamId: 'team-1',
    effectiveDateRange: '[2026-11-04,2026-11-19)',
    practiceSlots: { dayOfWeek: 'wed', startTime: '16:00', endTime: '17:00' },
    day: 'Wednesday',
    fieldId: 'Field 2',
    slotId: 'practice_16:00',
  },
];

const EXCEPTIONS = [
  // Two Mondays (11-09, 11-16) TIME TBD.
  {
    id: 'e1',
    assignment_id: 'pa-1',
    window: '[2026-11-09,2026-11-17)',
    kind: 'time_tbd',
    tbd_reason: 'contended',
    withdrawn_at: null,
  },
  // One Wednesday (11-11) moved.
  {
    id: 'e2',
    assignment_id: 'pa-2',
    window: '[2026-11-11,2026-11-12)',
    kind: 'relocated',
    tbd_reason: null,
    withdrawn_at: null,
  },
  // Withdrawn: changes nothing.
  {
    id: 'e3',
    assignment_id: 'pa-1',
    window: '[2026-11-23,2026-11-24)',
    kind: 'time_tbd',
    tbd_reason: 'declined',
    withdrawn_at: '2026-11-01T00:00:00Z',
  },
  // Another run's row: not this export's.
  {
    id: 'e4',
    assignment_id: 'pa-other',
    window: '[2026-11-02,2026-11-30)',
    kind: 'time_tbd',
    tbd_reason: 'contended',
    withdrawn_at: null,
  },
];

/** Series dates inside a live window of their own row, from the seed alone. */
function changedBySeed() {
  const ms = (d) => Date.parse(`${d}T00:00:00Z`);
  const days = { mon: 1, wed: 3 };
  let n = 0;
  for (const a of ASSIGNMENTS) {
    const [lo, hi] = a.effectiveDateRange.slice(1, -1).split(',');
    for (let t = ms(lo); t < ms(hi); t += 864e5) {
      if (new Date(t).getUTCDay() !== days[a.practiceSlots.dayOfWeek]) continue;
      const d = new Date(t).toISOString().slice(0, 10);
      const inLive = EXCEPTIONS.some((e) => {
        if (e.assignment_id !== a.id || e.withdrawn_at != null) return false;
        const [wlo, whi] = e.window.slice(1, -1).split(',');
        return d >= wlo && d < whi;
      });
      if (inLive) n += 1;
    }
  }
  return n;
}

function fakeClient(rows, { fail = false } = {}) {
  return {
    from: () => {
      const filters = [];
      let span = null;
      const q = {
        select: () => q,
        eq: (col, val) => (filters.push((r) => String(r[col]) === String(val)), q),
        order: () => q,
        range: (lo, hi) => ((span = [lo, hi]), q),
        then: (resolve, reject) =>
          Promise.resolve(
            fail
              ? { data: null, error: { message: 'unreadable' } }
              : {
                  data: rows.filter((r) => filters.every((f) => f(r))).slice(span[0], span[1] + 1),
                  error: null,
                }
          ).then(resolve, reject),
      };
      return q;
    },
  };
}

const tagged = EXCEPTIONS.map((e) => ({ ...e, organization_id: 'org-1' }));

describe('export practice-change count (R9)', () => {
  it('the seed changes series dates, and not through the withdrawn row (meta)', () => {
    expect(changedBySeed()).toBe(3);
    // The meter can fail: with no live window nothing is changed.
    const saved = EXCEPTIONS.map((e) => e.withdrawn_at);
    EXCEPTIONS.forEach((e) => (e.withdrawn_at = 'x'));
    expect(changedBySeed()).toBe(0);
    EXCEPTIONS.forEach((e, i) => (e.withdrawn_at = saved[i]));
  });

  it("counts the series dates the saved exceptions change, from the helper's meta", () => {
    expect(unshownPracticeChangesOf(ASSIGNMENTS, EXCEPTIONS)).toBe(changedBySeed());
    expect(unshownPracticeChangesOf(ASSIGNMENTS, [])).toBe(0);
  });

  it('reads by organization and never reports a failed read as no changes', async () => {
    await expect(readUnshownPracticeChanges(fakeClient(tagged), ASSIGNMENTS)).resolves.toEqual({
      ok: true,
      count: changedBySeed(),
    });
    await expect(
      readUnshownPracticeChanges(fakeClient(tagged, { fail: true }), ASSIGNMENTS)
    ).resolves.toEqual({ ok: false });
    await expect(readUnshownPracticeChanges(null, ASSIGNMENTS)).resolves.toEqual({ ok: false });
    const orgless = ASSIGNMENTS.map(({ organizationId: _o, ...a }) => a);
    await expect(readUnshownPracticeChanges(fakeClient(tagged), orgless)).resolves.toEqual({
      ok: false,
    });
  });

  it('words the note as the plan states it', () => {
    expect(practiceChangesNoteOf({ ok: true, count: 3 })).toBe(
      '3 practices have temporary changes not shown in this export.'
    );
    expect(practiceChangesNoteOf({ ok: true, count: 1 })).toBe(
      '1 practice has temporary changes not shown in this export.'
    );
    expect(practiceChangesNoteOf({ ok: true, count: 0 })).toBeNull();
    expect(practiceChangesNoteOf({ ok: false })).toBe(EXPORT_PRACTICE_CHANGES_UNREAD_TEXT);
  });

  it('the panel states the count beside the CSV message', async () => {
    render(
      <OutputGenerationPanel
        teams={[{ id: 'team-1', name: 'Tigers', division: 'U10' }]}
        practiceAssignments={ASSIGNMENTS}
        supabaseClient={fakeClient(tagged)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(await screen.findByText('CSVs generated successfully.')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      `${changedBySeed()} practices have temporary changes not shown in this export.`
    );
  });

  it('counts only the rows the CSV holds: a row the export drops is not counted', async () => {
    // pa-2 has no time, so `buildExportPayload` leaves it out of the CSV.
    const [first, second] = ASSIGNMENTS;
    const timeless = { ...second, practiceSlots: { dayOfWeek: 'wed' } };
    const onlyFirst = unshownPracticeChangesOf([first], EXCEPTIONS);
    expect(onlyFirst).toBeGreaterThan(0);
    expect(onlyFirst).toBeLessThan(changedBySeed());
    render(
      <OutputGenerationPanel
        teams={[{ id: 'team-1', name: 'Tigers', division: 'U10' }]}
        practiceAssignments={[first, timeless]}
        supabaseClient={fakeClient(tagged)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      `${onlyFirst} practices have temporary changes not shown in this export.`
    );
  });
});
