/**
 * 8.6 3b PR 11d-3: blackout enact in the panel and its two launchers.
 *
 * docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §5 B8 (client, Plant C: the
 * blackout editor's launcher is always a preview), §2.6 (the Blackout Dates
 * stored-row launcher), §2.5/Q4 (the dialog: heading from the STORED row,
 * one row that keeps its range, the count, the per-team tick, no unlock),
 * Q8 (a saved move on the lost ground is its own row, Enact disabled, never
 * dropped), `declared.exceptions` printed beside the closures, and Q11 (the
 * count on the edit and delete confirmations). Every subject set is
 * enumerated from the SEEDED rows, never from the DOM.
 *
 * Synthetic rows only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  /** @type {any} */ client: null,
  /** @type {any} */ send: null,
  org: /** @type {any} */ ({}),
  /** @type {any} */ closures: null,
  /** @type {any} */ fieldsHook: null,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  get supabase() {
    return h.client;
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => h.org,
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => true }),
}));
vi.mock('../frontend/src/utils/practicePersistenceClient.js', () => ({
  persistPracticeEnact: (...args) => h.send(...args),
}));
vi.mock('../frontend/src/hooks/useFields.js', () => ({ useFields: () => h.fieldsHook }));
vi.mock('../frontend/src/hooks/useFieldClosures.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useFieldClosures: () => h.closures,
}));

import BlackoutsPage from '../frontend/src/pages/BlackoutsPage.jsx';
import BlackoutEditor from '../frontend/src/components/setup/BlackoutEditor.jsx';
import {
  ENACT_BLACKOUT_PREVIEW_TEXT,
  ENACT_TARGET_LOST_TEXT,
} from '../frontend/src/utils/practiceRepairEnact.js';
import {
  F1,
  F2,
  LOC_A,
  SEASON,
  assignment,
  displacedFromRows,
  fieldsWith,
  requireExamined,
  rowsOf,
  slot,
  uuid,
} from './helpers/practiceEnactWorld.js';
import { ORG, enactDbOf, fakeClientOf, sendThroughMock } from './helpers/practiceEnactDb.js';

const SLOTS = [
  slot(501, F1, 'mon', '17:00', '18:00'),
  slot(502, F1, 'wed', '17:00', '18:00'),
  slot(503, F2, 'mon', '17:00', '18:00'),
  slot(504, F2, 'wed', '17:00', '18:00'),
  slot(506, F1, 'tue', '17:00', '18:00'),
  slot(507, F2, 'thu', '17:00', '18:00'),
];
const ROWS = [assignment(601, 301, 501), assignment(602, 302, 502), assignment(604, 304, 507)];

const STORED = Object.freeze({
  id: uuid(701),
  field_id: F1,
  location_id: null,
  blackout_from: '2026-10-19',
  blackout_until: '2026-11-01',
  start_minutes: 1020,
  end_minutes: 1140,
  reason: 'maintenance',
});
/** The same stored row as `useFieldClosures` hands the page (camelCase). */
const CLOSURE = Object.freeze({
  id: STORED.id,
  source: 'field_blackouts',
  closesFieldId: F1,
  closesLocationId: null,
  blackoutFrom: STORED.blackout_from,
  blackoutUntil: STORED.blackout_until,
  startMinutes: STORED.start_minutes,
  endMinutes: STORED.end_minutes,
  reason: STORED.reason,
  note: null,
  sourceReasonText: null,
});

/**
 * Team 304's saved move: Thursday on F2 moved to Tuesday on F1 for the week
 * of 10-20, inside the blackout, on the ground it closes (Q8). And a
 * withdrawn exception, which never applies.
 */
const LOST_MOVE = {
  id: uuid(801),
  assignment_id: uuid(604),
  team_id: uuid(304),
  window: '[2026-10-20,2026-10-26]',
  kind: 'relocated',
  practice_slot_id: uuid(506),
  tbd_reason: null,
  cause_kind: 'retirement',
  cause_id: uuid(299),
  withdrawn_at: null,
};
const WITHDRAWN = {
  ...LOST_MOVE,
  id: uuid(802),
  window: '[2026-11-05,2026-11-05]',
  withdrawn_at: '2026-10-01T00:00:00Z',
};

let db;
function serve({ exceptions = [], audit = [] } = {}) {
  const rows = rowsOf({ slots: SLOTS, assignments: ROWS, fields: fieldsWith(null) });
  rows.fieldClosures = [
    {
      id: STORED.id,
      source: 'field_blackouts',
      closes_field_id: STORED.field_id,
      closes_location_id: STORED.location_id,
      blackout_from: STORED.blackout_from,
      blackout_until: STORED.blackout_until,
      start_minutes: STORED.start_minutes,
      end_minutes: STORED.end_minutes,
      reason: STORED.reason,
    },
  ];
  db = enactDbOf(rows);
  db.field_blackouts = [{ ...STORED, organization_id: ORG }];
  db.practice_exceptions = exceptions.map((e) => ({ ...e, organization_id: ORG }));
  db.audit_log = audit;
  h.client = fakeClientOf(db, []);
  h.send = vi.fn(sendThroughMock(h.client));
}

const removeBlackout = vi.fn(async () => {});
beforeEach(() => {
  h.org = {
    currentOrganization: { id: ORG },
    currentSeasonSetting: { id: SEASON, timezone: null },
  };
  h.fieldsHook = {
    locations: [{ id: LOC_A, name: 'Venue A' }],
    fields: fieldsWith(null),
    availabilityProfiles: [],
    loading: false,
    error: null,
  };
  removeBlackout.mockClear();
  h.closures = {
    closures: [CLOSURE],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createBlackout: vi.fn(),
    updateBlackout: vi.fn(),
    removeBlackout,
  };
  serve();
});
afterEach(() => vi.restoreAllMocks());

/** The series this blackout displaces, from the rows alone (F1, a weekday inside the window). */
const SUBJECTS = displacedFromRows(
  rowsOf({ slots: SLOTS, assignments: ROWS, fields: fieldsWith(null) }),
  F1,
  STORED.blackout_from
);
const teamOf = (id) => `Team ${Number(ROWS.find((r) => r.id === id).team_id.slice(-3))}`;
const windowRow = (id) =>
  screen
    .getAllByTestId('practice-repair-window')
    .find((r) => r.getAttribute('data-assignment-id') === id);

const ROW_LABEL = 'Field 1, 2026-10-19 to 2026-11-01, 17:00–19:00';

async function openFromPage() {
  render(
    <MemoryRouter>
      <BlackoutsPage />
    </MemoryRouter>
  );
  fireEvent.click(
    await screen.findByRole('button', { name: `Repair practices for the blackout on ${ROW_LABEL}` })
  );
  await screen.findByTestId('practice-repair-rows', {}, { timeout: 5000 });
}

describe('blackout enact panel :: the subject set', () => {
  it('displaces both F1 series, from the rows alone', () => {
    expect(requireExamined(SUBJECTS.length, 'displaced series')).toBe(2);
  });
});

describe('blackout enact panel :: B8 Plant C, the editor launcher is always a preview', () => {
  it('disables every Enact opened from the editor on the stored row, unchanged', async () => {
    render(
      <BlackoutEditor
        open
        onClose={() => {}}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        editing={CLOSURE}
        locations={[{ id: LOC_A, name: 'Venue A' }]}
        fields={fieldsWith(null)}
        dated={[]}
        recurring={[]}
        defaultDate="2026-10-13"
      />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show practice repair recommendations' })
    );
    await screen.findByTestId('practice-repair-rows', {}, { timeout: 5000 });
    for (const id of SUBJECTS) {
      const row = windowRow(id);
      expect(within(row).getByTestId('practice-repair-enact')).toBeDisabled();
      expect(within(row).getByTestId('practice-repair-enact-why')).toHaveTextContent(
        ENACT_BLACKOUT_PREVIEW_TEXT
      );
    }
    expect(requireExamined(SUBJECTS.length, 'series-window')).toBe(2);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('enables the same recommendations from the stored row on Blackout Dates (the control)', async () => {
    await openFromPage();
    for (const id of SUBJECTS) {
      expect(within(windowRow(id)).getByTestId('practice-repair-enact')).toBeEnabled();
    }
    expect(requireExamined(SUBJECTS.length, 'series-window')).toBe(2);
  });
});

describe('blackout enact panel :: Q4, the dialog and the one write', () => {
  it('heads with the stored blackout, keeps the range, counts the window, and sends no unlock', async () => {
    await openFromPage();
    const [id] = SUBJECTS;
    const enact = within(windowRow(id)).getByTestId('practice-repair-enact');
    enact.focus();
    fireEvent.click(enact);
    const dialog = await screen.findByRole('dialog', {
      name: 'Enact: Field 1 closed 2026-10-19 to 2026-11-01, 17:00-19:00',
    });
    const heading = within(dialog).getByTestId('practice-enact-heading');
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('data-stored', '2026-10-19/2026-11-01, 17:00-19:00');
    const [row] = within(dialog).getAllByTestId('practice-enact-row');
    expect(row).toHaveAttribute('data-effect', 'temporarily moved');
    expect(row).toHaveTextContent('keeps its range');
    expect(row).toHaveTextContent('from 2026-10-19 to 2026-11-01');
    // Mondays 10-19 and 10-26, by hand.
    expect(within(dialog).getByTestId('practice-enact-affected')).toHaveAttribute(
      'data-count',
      '2'
    );
    expect(within(dialog).getByTestId('practice-enact-moves')).toHaveTextContent(
      '2 practices on Mon move to 2 on Mon.'
    );
    const confirm = within(dialog).getByTestId('practice-enact-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: new RegExp(`Move and lock ${teamOf(id)}`) })
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    expect(h.send).toHaveBeenCalledTimes(1);
    const body = h.send.mock.calls[0][0];
    expect(body.payload.repair.unlock).toEqual([]);
    expect(body.enact.unlock).toEqual([]);
    expect(body.payload.repair.exceptions).toHaveLength(1);
    const shown = await screen.findByTestId('practice-repair-enacted-temporary');
    expect(shown).toHaveTextContent('temporarily moved to');
    expect(shown).toHaveTextContent('Locked');
    expect(screen.getByTestId('practice-repair-announce')).toHaveTextContent(
      `Enacted the recommendation for ${teamOf(id)}. Its temporary change is saved and locked.`
    );
  });
});

describe('blackout enact panel :: Q8, a saved move on the lost ground is its own row', () => {
  it('lists it with Enact disabled and the reason, beside the displaced series', async () => {
    serve({ exceptions: [LOST_MOVE, WITHDRAWN] });
    await openFromPage();
    // From the SEED: live relocations whose slot is on F1 and whose window meets the blackout.
    const slotField = new Map(SLOTS.map((s) => [s.id, s.field_id]));
    const expected = [LOST_MOVE, WITHDRAWN].filter(
      (e) =>
        e.withdrawn_at === null &&
        slotField.get(e.practice_slot_id) === F1 &&
        e.window.slice(1, 11) <= STORED.blackout_until &&
        e.window.slice(12, 22) >= STORED.blackout_from
    );
    expect(requireExamined(expected.length, 'saved move on the lost ground')).toBe(1);
    const rows = screen.getAllByTestId('practice-repair-target-lost');
    expect(rows.map((r) => r.getAttribute('data-exception-id'))).toEqual(expected.map((e) => e.id));
    for (const row of rows) {
      expect(within(row).getByTestId('practice-repair-enact')).toBeDisabled();
      expect(within(row).getByTestId('practice-repair-enact-why')).toHaveTextContent(
        ENACT_TARGET_LOST_TEXT
      );
      expect(row).toHaveTextContent('Team 304');
    }
    expect(screen.getByTestId('practice-repair-target-lost-count')).toHaveTextContent('1 saved');
    // The displaced series are still listed beside it.
    expect(screen.getAllByTestId('practice-repair-window')).toHaveLength(SUBJECTS.length);
  });

  it('prints declared.exceptions beside the closures, counted from the seed', async () => {
    serve({ exceptions: [LOST_MOVE, WITHDRAWN] });
    await openFromPage();
    const declared = screen.getByTestId('practice-repair-exceptions-declared');
    expect(declared).toHaveAttribute('data-supplied', 'true');
    expect(declared).toHaveTextContent('Saved temporary changes read: 2 (1 live, 1 withdrawn)');
    expect(declared).toHaveTextContent('1 holding ground as a moved practice');
  });
});

/** An enact audit row for this blackout. */
const enactOf = (n, series) => ({
  id: uuid(880000 + n),
  organization_id: ORG,
  action: 'practice.recommendation_enacted',
  metadata: { cause: { kind: 'blackout', id: STORED.id }, series: { assignment_id: series } },
});

describe('blackout enact panel :: Q11, the count on the edit and delete confirmations', () => {
  it('shows the count in the edit dialog', async () => {
    serve({ audit: [enactOf(1, uuid(601)), enactOf(2, uuid(602))] });
    render(
      <MemoryRouter>
        <BlackoutsPage />
      </MemoryRouter>
    );
    fireEvent.click(
      await screen.findByRole('button', { name: `Edit the blackout on ${ROW_LABEL}` })
    );
    expect(
      await screen.findByText(/2 practice series were enacted off this blackout/)
    ).toHaveAttribute('data-testid', 'blackout-enacted-count');
    expect(screen.getByTestId('blackout-enacted-count')).toHaveTextContent(
      'moves none of them back'
    );
  });

  it('asks before removing a blackout something was enacted off, and keeps it on Cancel', async () => {
    serve({ audit: [enactOf(1, uuid(601))] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <MemoryRouter>
        <BlackoutsPage />
      </MemoryRouter>
    );
    fireEvent.click(
      await screen.findByRole('button', { name: `Remove the blackout on ${ROW_LABEL}` })
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toContain('1 practice series was enacted off this blackout');
    expect(removeBlackout).not.toHaveBeenCalled();
  });

  it('removes one nothing was enacted off without asking (the count read 0)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <MemoryRouter>
        <BlackoutsPage />
      </MemoryRouter>
    );
    fireEvent.click(
      await screen.findByRole('button', { name: `Remove the blackout on ${ROW_LABEL}` })
    );
    await waitFor(() => expect(removeBlackout).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
});
