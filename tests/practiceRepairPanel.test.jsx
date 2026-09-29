/**
 * 8.6 3b PR 10: the read-only practice repair recommendation panel.
 *
 * Every witness enumerates its subjects from the INPUT snapshot (the rows the
 * fake client serves), never from what the panel rendered. Synthetic data
 * only: no real venue, club, person or coordinate.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  /** @type {Record<string, any[]>} */
  tables: {},
  /** @type {string|null} */
  fail: null,
  /** @type {Array<[string, string]>} */
  writes: [],
  /** @type {string[]} */
  reads: [],
  org: /** @type {any} */ ({}),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const WRITES = ['insert', 'update', 'upsert', 'delete'];
  const from = (table) => {
    let rows = h.tables[table] ?? [];
    const q = {
      select: () => q,
      eq: (col, val) => {
        // An embedded filter (`teams.divisions.season_settings_id`) is the
        // server's; every served row is in the season.
        if (!col.includes('.')) rows = rows.filter((r) => String(r[col]) === String(val));
        return q;
      },
      order: () => q,
      range: (lo, hi) => {
        h.reads.push(table);
        return Promise.resolve(
          h.fail === table
            ? { data: null, error: { message: `${table}: permission denied` } }
            : { data: rows.slice(lo, hi + 1), error: null }
        );
      },
    };
    for (const method of WRITES) {
      q[method] = () => {
        h.writes.push([table, method]);
        return q;
      };
    }
    return q;
  };
  const supabase = {
    from,
    rpc: (name) => {
      // 8.6 3b PR 11c: the loader reads the writer fingerprint first. It is
      // a read (STABLE, SECURITY INVOKER); any other RPC is counted a write.
      if (name === 'practice_schedule_fingerprint') {
        h.reads.push(`rpc:${name}`);
        return Promise.resolve({ data: '0123456789abcdef0123456789abcdef', error: null });
      }
      h.writes.push(['rpc', name]);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { supabase };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => h.org,
}));

import PracticeRepairPanel from '../frontend/src/components/scheduling/PracticeRepairPanel.jsx';
import PracticeRepairLauncher from '../frontend/src/components/scheduling/PracticeRepairLauncher.jsx';
import { PRACTICE_TBD_REASON } from '@squadlogic/core/practice/index.js';

/* -- synthetic rows ------------------------------------------------------- */
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = uuid(1);
const SEASON = uuid(2);
const LOC = uuid(101);
const [F1, F2] = [uuid(201), uuid(202)];
const [T1, T2, T3] = [uuid(301), uuid(302), uuid(303)];
const [SL1, SL2, SL3, SL4] = [uuid(501), uuid(502), uuid(503), uuid(504)];
const [A1, A2, A3] = [uuid(601), uuid(602), uuid(603)];
const RANGE = '[2026-09-01,2026-12-01)';

const slot = (id, field, day, start, end) => ({
  id,
  organization_id: ORG,
  field_id: field,
  field_subunit_id: null,
  day_of_week: day,
  start_time: start,
  end_time: end,
  valid_from: '2026-09-01',
  valid_until: '2026-11-30',
});
const assignment = (id, team, slotId) => ({
  id,
  organization_id: ORG,
  team_id: team,
  practice_slot_id: slotId,
  effective_date_range: RANGE,
  source: 'auto',
});

/** F1 is the ground lost. SL2 is 90 minutes, a length nothing else offers. */
function seed({ coordinates = false, lit = false, locationId = LOC } = {}) {
  h.tables = {
    locations: [
      {
        id: locationId,
        organization_id: ORG,
        name: 'Venue One',
        lighting_available: lit,
        latitude: coordinates ? '40.00' : null,
        longitude: coordinates ? '-75.00' : null,
      },
    ],
    fields: [
      {
        id: F1,
        organization_id: ORG,
        location_id: locationId,
        name: 'Pitch 1',
        effective_to: null,
      },
      {
        id: F2,
        organization_id: ORG,
        location_id: locationId,
        name: 'Pitch 2',
        effective_to: null,
      },
    ],
    field_subunits: [],
    practice_slots: [
      slot(SL1, F1, 'mon', '17:00:00', '18:00:00'),
      slot(SL2, F1, 'wed', '17:00:00', '18:30:00'),
      slot(SL3, F2, 'mon', '17:00:00', '18:00:00'),
      slot(SL4, F2, 'wed', '18:00:00', '19:00:00'),
    ],
    practice_assignments: [
      assignment(A1, T1, SL1),
      assignment(A2, T2, SL2),
      assignment(A3, T3, SL4),
    ],
    teams: [
      { id: T1, organization_id: ORG, name: 'Team One' },
      { id: T2, organization_id: ORG, name: 'Team Two' },
      { id: T3, organization_id: ORG, name: 'Team Three' },
    ],
    team_coach_assignments: [],
    coach_practice_preferences: [],
  };
}

const RETIRE_F1 = { kind: 'retirement', field: { id: F1, effective_to: '2026-10-14' } };
const BLACKOUT_F1 = {
  kind: 'blackout',
  blackout: {
    id: 'draft',
    field_id: F1,
    location_id: null,
    blackout_from: '2026-10-05',
    blackout_until: '2026-10-11',
    start_minutes: null,
    end_minutes: null,
    reason: 'maintenance',
  },
};

/**
 * The displaced series, from the SNAPSHOT: every row whose slot is on the
 * lost field. (Each runs the whole season, so each meets any window.)
 */
function displacedFromSnapshot() {
  const lost = new Set(h.tables.practice_slots.filter((s) => s.field_id === F1).map((s) => s.id));
  return h.tables.practice_assignments
    .filter((row) => lost.has(row.practice_slot_id))
    .map((row) => row.id)
    .sort();
}

const renderedIds = () =>
  screen
    .getAllByTestId('practice-repair-window')
    .map((row) => row.getAttribute('data-assignment-id'));

/** @param {Object} [loss] */
async function openPanel(loss = /** @type {Object} */ (RETIRE_F1)) {
  render(<PracticeRepairPanel loss={loss} subject="Pitch 1" />);
  await screen.findByTestId('practice-repair-count');
}

beforeEach(() => {
  h.fail = null;
  h.writes = [];
  h.reads = [];
  h.org = {
    currentOrganization: { id: ORG },
    currentSeasonSetting: { id: SEASON, timezone: 'America/New_York' },
    orgMember: { role: 'admin' },
  };
  seed();
});

describe('practice repair panel :: every displaced series-window, once', () => {
  it('renders exactly the snapshot-derived displaced set, each once (retirement)', async () => {
    await openPanel();
    const expected = displacedFromSnapshot();
    // Meta-assertion: the fixture displaces more than one series.
    expect(expected.length).toBe(2);
    const ids = renderedIds();
    expect(ids.length).toBe(expected.length);
    expect([...ids].sort()).toEqual(expected);
    expect(screen.getByTestId('practice-repair-count')).toHaveTextContent(
      '2 practice series-windows'
    );
  });

  it('renders exactly the snapshot-derived displaced set, each once (blackout)', async () => {
    await openPanel(BLACKOUT_F1);
    const ids = renderedIds();
    expect(ids.length).toBe(displacedFromSnapshot().length);
    expect([...ids].sort()).toEqual(displacedFromSnapshot());
  });
});

describe('practice repair panel :: TIME TBD is never hidden', () => {
  it('shows every TIME TBD window with its reason', async () => {
    await openPanel();
    // From the snapshot: A2's slot is the only 90-minute shape in the plan,
    // so nothing can re-home it -- it must be TIME TBD, and shown.
    const ninetyMinute = h.tables.practice_assignments.filter(
      (row) => row.practice_slot_id === SL2
    );
    expect(ninetyMinute.length).toBe(1);
    for (const row of ninetyMinute) {
      const tr = screen
        .getAllByTestId('practice-repair-window')
        .find((el) => el.getAttribute('data-assignment-id') === row.id);
      expect(tr).toBeDefined();
      const tbd = within(/** @type {HTMLElement} */ (tr)).getByTestId('practice-repair-time-tbd');
      expect(tbd).toHaveAttribute('data-tbd-reason', PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE);
      expect(tbd).toHaveTextContent('TIME TBD');
      expect(tbd).toHaveTextContent(/no free, legal slot/);
    }
  });

  it('shows every blackout window refused for saving, with its reason, TBD or not', async () => {
    await openPanel(BLACKOUT_F1);
    for (const id of displacedFromSnapshot()) {
      const tr = screen
        .getAllByTestId('practice-repair-window')
        .find((el) => el.getAttribute('data-assignment-id') === id);
      const refused = within(/** @type {HTMLElement} */ (tr)).getAllByTestId(
        'practice-repair-save-refused'
      );
      expect(refused.length).toBeGreaterThan(0);
      for (const r of refused) expect(r.getAttribute('data-refusal')).toMatch(/window/);
    }
  });
});

describe('practice repair panel :: decline and undo', () => {
  it('decline changes the render, stamps LOCAL, and undo restores it', async () => {
    await openPanel();
    const table = () => screen.getByTestId('practice-repair-rows').textContent;
    const before = table();
    const a1 = () =>
      screen
        .getAllByTestId('practice-repair-window')
        .find((el) => el.getAttribute('data-assignment-id') === A1);
    // A1 is placed (the witness needs something to decline).
    expect(
      within(/** @type {HTMLElement} */ (a1())).getByTestId('practice-repair-to')
    ).toBeTruthy();
    expect(screen.queryByTestId('practice-repair-local')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Decline the recommendation for Team One' })
    );
    expect(table()).not.toBe(before);
    const declined = within(/** @type {HTMLElement} */ (a1())).getByTestId(
      'practice-repair-time-tbd'
    );
    expect(declined).toHaveAttribute('data-tbd-reason', PRACTICE_TBD_REASON.DECLINED);
    expect(screen.getByTestId('practice-repair-local')).toHaveAttribute(
      'data-reason-code',
      'PRACTICE_REPAIR_RECOMMENDATION_LOCAL'
    );
    // Every window is still there after a decline.
    expect([...renderedIds()].sort()).toEqual(displacedFromSnapshot());

    fireEvent.click(screen.getByRole('button', { name: /^Undo the decline of .* for Team One$/ }));
    expect(table()).toBe(before);
    // The stamp stays: the result is still locally repaired, not proven optimal.
    expect(screen.getByTestId('practice-repair-local')).toHaveTextContent(/2 declines or undos/);
  });
});

describe('practice repair panel :: a failed read shows no recommendations', () => {
  for (const table of [
    'practice_slots',
    'locations',
    'practice_assignments',
    'teams',
    'field_closures',
  ]) {
    it(`fails loudly when ${table} cannot be read`, async () => {
      h.fail = table;
      render(<PracticeRepairPanel loss={RETIRE_F1} subject="Pitch 1" />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(table);
      // Meta-assertion: the failing table was actually asked for.
      expect(h.reads).toContain(table);
      expect(screen.queryAllByTestId('practice-repair-window')).toHaveLength(0);
      expect(screen.queryByTestId('practice-repair-rows')).toBeNull();
    });
  }

  it('refuses a snapshot the adapter refuses (a non-uuid location), with no partial panel', async () => {
    seed({ locationId: 'loc-not-a-uuid' });
    render(<PracticeRepairPanel loss={RETIRE_F1} subject="Pitch 1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not a uuid/);
    expect(screen.queryAllByTestId('practice-repair-window')).toHaveLength(0);
  });
});

describe('practice repair panel :: daylight', () => {
  it('shows DAYLIGHT_UNCHECKED, at compromise, when no venue has coordinates', async () => {
    // From the snapshot: no location carries coordinates.
    expect(h.tables.locations.every((l) => l.latitude === null)).toBe(true);
    await openPanel();
    const finding = screen
      .getByTestId('practice-repair-findings')
      .querySelector('[data-reason-code="PRACTICE_REPAIR_DAYLIGHT_UNCHECKED"]');
    expect(finding).not.toBeNull();
    expect(finding).toHaveAttribute('data-severity', 'compromise');
    expect(screen.getByTestId('practice-repair-daylight-why')).toHaveTextContent(
      'no venue has coordinates'
    );
  });

  it('control: with coordinates (lit ground) the calendar is passed and nothing is unchecked', async () => {
    seed({ coordinates: true, lit: true });
    await openPanel();
    expect(
      screen
        .getByTestId('practice-repair-findings')
        .querySelector('[data-reason-code="PRACTICE_REPAIR_DAYLIGHT_UNCHECKED"]')
    ).toBeNull();
    expect(screen.queryByTestId('practice-repair-daylight-why')).toBeNull();
  });

  it('shows the undeclared lighting overrides rather than assuming none', async () => {
    await openPanel();
    expect(screen.getByTestId('practice-repair-lighting-declared')).toHaveTextContent(
      /no portable-lighting windows supplied/
    );
  });
});

describe('practice repair panel :: read-only', () => {
  it('makes no write call through the client: zero rpc/insert/update/upsert/delete', async () => {
    await openPanel();
    fireEvent.click(
      screen.getByRole('button', { name: 'Decline the recommendation for Team One' })
    );
    fireEvent.click(screen.getByRole('button', { name: /^Undo the decline of .* for Team One$/ }));
    // Meta-assertion: the client was exercised (every table read), so zero
    // writes is a measurement, not a spy nobody reached.
    for (const table of Object.keys(h.tables)) expect(h.reads).toContain(table);
    expect(h.writes).toEqual([]);
  });
});

describe('practice repair launcher', () => {
  it('opens the lazy panel for an admin, keyboard-operable, with aria-expanded', async () => {
    render(<PracticeRepairLauncher loss={RETIRE_F1} subject="Pitch 1" />);
    const button = screen.getByRole('button', { name: 'Show practice repair recommendations' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByTestId('practice-repair-panel')).toBeInTheDocument());
    await screen.findByTestId('practice-repair-count');
  });

  it('is disabled for a non-admin, with the reason beside it', () => {
    h.org = { ...h.org, orgMember: { role: 'coach' } };
    render(<PracticeRepairLauncher loss={RETIRE_F1} subject="Pitch 1" />);
    const button = screen.getByRole('button', { name: 'Show practice repair recommendations' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'practice-repair-admin-only');
    expect(screen.getByText(/Only an organization admin/)).toBeInTheDocument();
  });
});
