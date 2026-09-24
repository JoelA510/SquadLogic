/**
 * The team portal renders an unexpandable practice row as TIME TBD (fix #64).
 *
 * The calendar feed already reports a practice assignment it cannot expand
 * (no slot, an unreadable or unbounded range) as TIME TBD with a reason. The
 * portal logged the same row and showed nothing, so a family on the portal
 * saw no practice at all where the feed said TBD. CLAUDE.md: never silently
 * drop an unplaceable fixture, and adopt the sibling's contract.
 *
 * `expandPractices` is the real one (`importOriginal`); only the hook is
 * replaced, so the page renders exactly what the expansion produced.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TeamRecordPage from '../frontend/src/pages/TeamRecordPage.jsx';
import { expandPractices } from '../frontend/src/hooks/useTeamPortal.js';
import {
  PRACTICE_OCCURRENCE_REFUSAL,
  PRACTICE_TBD_CAUSES,
} from '@squadlogic/core/utils/practiceOccurrences.js';
import { UNPLACEABLE_CAUSES } from '../supabase/functions/_shared/calendar/icsFeed.ts';

const mocks = vi.hoisted(() => ({ portalState: null }));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ teamId: 'team-1' }),
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}));

vi.mock('../frontend/src/hooks/useTeamPortal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useTeamPortal: () => mocks.portalState,
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => false,
    role: 'coach',
    PERMISSIONS: { MANAGE_ALL_TEAMS: 'manage_all_teams' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

const monday = {
  day_of_week: 'mon',
  start_time: '17:00:00',
  end_time: '18:30:00',
  field: { name: 'Field A', location: { name: 'Test Park' } },
};

/** One expandable row and two unexpandable ones, for one team. */
const ROWS = [
  { id: 'pa-ok', effective_date_range: '[2026-11-02,2026-11-17)', slot: monday },
  { id: 'pa-open', effective_date_range: '[2026-11-02,)', slot: monday },
  { id: 'pa-noslot', effective_date_range: '[2026-11-02,2026-11-17)', slot: null },
];

/**
 * What each row must produce, decided from the ROW (never from the output):
 * a bounded range with a slot gives its Mondays, anything else one TBD entry.
 */
function expectedFor(row) {
  if (!row.slot) return { tbd: PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING };
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(row.effective_date_range);
  if (!m) return { tbd: PRACTICE_OCCURRENCE_REFUSAL.RANGE_UNREADABLE };
  const dates = [];
  for (let t = Date.parse(`${m[1]}T00:00:00Z`); t < Date.parse(`${m[2]}T00:00:00Z`); t += 864e5) {
    if (new Date(t).getUTCDay() === 1) dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return { dates };
}

const tbdRows = ROWS.filter((row) => expectedFor(row).tbd);
const datedRows = ROWS.filter((row) => expectedFor(row).dates);

beforeEach(() => {
  mocks.portalState = {
    loading: false,
    error: null,
    team: { name: 'Tigers', division: { name: 'U10', season: {} } },
    roster: [],
    events: expandPractices(ROWS),
    rsvps: [],
    messages: [],
    myPlayers: [],
    updateRsvp: vi.fn(),
    sendMessage: vi.fn(),
  };
});

describe('team portal: an unexpandable practice row is TIME TBD, not absent', () => {
  it('the fixture has both kinds of row (meta)', () => {
    expect(tbdRows.length).toBe(2);
    expect(datedRows.length).toBe(1);
    expect(expectedFor(datedRows[0]).dates).toHaveLength(3);
  });

  it('expandPractices returns every expected entry, one TBD per unexpandable row', () => {
    const events = expandPractices(ROWS);
    for (const row of ROWS) {
      const expected = expectedFor(row);
      const got = events.filter((e) => e.id === row.id);
      if (expected.tbd) {
        expect(got, row.id).toHaveLength(1);
        expect(got[0]).toMatchObject({
          timeTbd: true,
          date: null,
          reasonCode: expected.tbd,
          reason: PRACTICE_TBD_CAUSES[expected.tbd],
        });
      } else {
        expect(
          got.map((e) => e.date),
          row.id
        ).toEqual(expected.dates);
      }
    }
  });

  it('the page renders each TBD entry with its reason, beside the dated practices', () => {
    render(<TeamRecordPage />);
    expect(screen.getAllByText('TIME TBD - Practice')).toHaveLength(tbdRows.length);
    for (const row of tbdRows) {
      const cause = PRACTICE_TBD_CAUSES[expectedFor(row).tbd];
      expect(screen.getByText(`Date and time TBD: ${cause}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/^Monday, /)).toHaveLength(expectedFor(datedRows[0]).dates.length);
  });

  it("uses the feed's reason wording", () => {
    const codes = Object.values(PRACTICE_OCCURRENCE_REFUSAL);
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(PRACTICE_TBD_CAUSES[code], code).toBe(UNPLACEABLE_CAUSES[code]);
    }
  });
});
