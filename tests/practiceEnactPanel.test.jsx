/**
 * 8.6 3b PR 11c: the practice repair panel's Enact button, its disabled
 * reasons, and the confirmation dialog (the ruling-2 override prompt).
 *
 * docs/PHASE_8_6_PR11_ENACT_PLAN.md §6: witness 24's panel part (Plant C),
 * the confirm gate, a stale response shown with no retry, a double click
 * making ONE write, blackout enact disabled, and witness 23 (the prompt's
 * count). Every subject set is enumerated from the PRE-ENACT snapshot (the
 * rows the fake client serves, `displacedFromRows`), never from the DOM.
 *
 * Synthetic rows only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  /** @type {any} */
  client: null,
  /** @type {any} */
  send: null,
  org: /** @type {any} */ ({}),
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

import PracticeRepairPanel from '../frontend/src/components/scheduling/PracticeRepairPanel.jsx';
import RetireEstateNodeDialog from '../frontend/src/components/setup/RetireEstateNodeDialog.jsx';
import { ENACT_PREVIEW_TEXT } from '../frontend/src/utils/practiceRepairEnact.js';
import {
  D,
  F1,
  F2,
  RETIRED_AFTER,
  RETIREMENT,
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
];
const ROWS = [assignment(601, 301, 501), assignment(602, 302, 502)];
const world = (fields = fieldsWith()) => rowsOf({ slots: SLOTS, assignments: ROWS, fields });

let db;
let sends;
function serve(rows, send = null) {
  db = enactDbOf(rows);
  h.client = fakeClientOf(db, []);
  sends = vi.fn(send ?? sendThroughMock(h.client));
  h.send = sends;
}

beforeEach(() => {
  h.org = {
    currentOrganization: { id: ORG },
    currentSeasonSetting: { id: SEASON, timezone: null },
  };
  serve(world());
});

const teamOf = (id) =>
  `Team ${Number(db.practice_assignments.find((a) => a.id === id).team_id.slice(-3))}`;

async function openPanel(loss = RETIREMENT, props = {}) {
  render(<PracticeRepairPanel loss={loss} subject="Field 1" isAdmin {...props} />);
  await screen.findByTestId('practice-repair-rows');
}
const enactButton = (id) =>
  screen.getByRole('button', { name: `Enact the recommendation for ${teamOf(id)}` });

/** Weekday occurrences in [from, until], counted day by day (independent of the core expander). */
function occurrences(from, until, day) {
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  let n = 0;
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${until}T00:00:00Z`);
    t += 86400000
  ) {
    if (names[new Date(t).getUTCDay()] === day) n += 1;
  }
  return n;
}

describe('enact panel :: 24, Plant C: the preview never enables Enact', () => {
  for (const stored of [null, RETIRED_AFTER]) {
    it(`disables every recommendation in the retirement preview (stored effective_to ${stored})`, async () => {
      // A stored date equal to the preview's is the case only the preview flag catches.
      serve(world(fieldsWith(stored)));
      const onRetire = vi.fn(async () => ({
        retired: false,
        reason: 'bookings_after_effective_to',
        affected_count: 2,
        affected: [],
      }));
      render(
        <RetireEstateNodeDialog
          open
          node={{ id: F1, name: 'Field 1' }}
          kind="field"
          defaultDate={RETIRED_AFTER}
          onRetire={onRetire}
          onClose={() => {}}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Check and retire' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Show practice repair recommendations' })
      );
      await screen.findByTestId('practice-repair-rows', {}, { timeout: 5000 });
      const subjects = displacedFromRows(world(), F1);
      for (const id of subjects) {
        const row = screen
          .getAllByTestId('practice-repair-window')
          .find((r) => r.getAttribute('data-assignment-id') === id);
        const button = within(row).getByTestId('practice-repair-enact');
        expect(button).toBeDisabled();
        expect(within(row).getByTestId('practice-repair-enact-why')).toHaveTextContent(
          ENACT_PREVIEW_TEXT
        );
      }
      expect(requireExamined(subjects.length, 'recommendation')).toBe(2);
      expect(sends).not.toHaveBeenCalled();
    });
  }

  it('enables the same recommendations once the retirement is committed (the control)', async () => {
    await openPanel();
    const subjects = displacedFromRows(world(), F1);
    for (const id of subjects) expect(enactButton(id)).toBeEnabled();
    expect(requireExamined(subjects.length, 'recommendation')).toBe(2);
  });
});

describe('enact panel :: the confirm gate, the stored date, and witness 23', () => {
  it('keeps Confirm disabled until every team box is ticked, and heads with the STORED date', async () => {
    await openPanel();
    for (const id of displacedFromRows(world(), F1)) {
      // As a keyboard user reaches it: focused, then activated.
      enactButton(id).focus();
      fireEvent.click(enactButton(id));
      const dialog = await screen.findByRole('dialog');
      const heading = within(dialog).getByTestId('practice-enact-heading');
      expect(heading).toHaveAttribute('data-stored-date', RETIRED_AFTER);
      expect(dialog).toHaveAccessibleName(`Enact: Field 1 retires after ${RETIRED_AFTER}`);
      expect(document.activeElement).toBe(heading);
      const confirm = within(dialog).getByTestId('practice-enact-confirm');
      const boxes = within(dialog).getAllByRole('checkbox');
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) expect(box).toHaveAccessibleName(/Move and lock Team \d+/);
      expect(confirm).toBeDisabled();
      expect(within(dialog).getByTestId('practice-enact-why')).toHaveTextContent('Tick the box');
      boxes[0].focus();
      fireEvent.click(boxes[0]);
      // Ticking never moves focus off the box (a stable Modal onClose).
      expect(document.activeElement).toBe(boxes[0]);
      expect(confirm).toBeEnabled();
      fireEvent.click(boxes[0]);
      expect(confirm).toBeDisabled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // Focus returns to the row's Enact button.
      expect(document.activeElement).toBe(enactButton(id));
    }
    expect(sends).not.toHaveBeenCalled();
  });

  it('counts the published practices that could change as weekday occurrences in [D, until]', async () => {
    await openPanel();
    const subjects = displacedFromRows(world(), F1);
    for (const id of subjects) {
      const row = ROWS.find((r) => r.id === id);
      const day = SLOTS.find((s) => s.id === row.practice_slot_id).day_of_week;
      // RANGE is [2026-09-01,2026-12-01): its last day is 2026-11-30.
      const expected = occurrences(D, '2026-11-30', day);
      fireEvent.click(enactButton(id));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('practice-enact-affected')).toHaveAttribute(
        'data-count',
        String(expected)
      );
      expect(within(dialog).getByTestId('practice-enact-latency')).toHaveTextContent(
        'Declared, not enforced'
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(requireExamined(subjects.length, 'prompt')).toBe(2);
  });
});

async function confirmFor(id) {
  fireEvent.click(enactButton(id));
  const dialog = await screen.findByRole('dialog');
  for (const box of within(dialog).getAllByRole('checkbox')) fireEvent.click(box);
  return { dialog, confirm: within(dialog).getByTestId('practice-enact-confirm') };
}

describe('enact panel :: stale, double click, and the enacted row', () => {
  it('shows a stale response in an alert and never retries the write', async () => {
    serve(world(), async () => ({
      status: 'stale',
      code: 'PRACTICE_SCHEDULE_STALE',
      message: 'x',
    }));
    await openPanel();
    const { dialog, confirm } = await confirmFor(uuid(601));
    fireEvent.click(confirm);
    const notice = await within(dialog).findByTestId('practice-enact-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('The season changed since this was shown.');
    expect(notice).toHaveTextContent('It still stands');
    // Settle every pending read: still ONE send.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sends).toHaveBeenCalledTimes(1);
    // A second write needs a second, ticked Confirm.
    expect(confirm).toBeDisabled();
  });

  it('makes ONE write for a double click, then shows the series enacted and locked', async () => {
    await openPanel();
    const { confirm } = await confirmFor(uuid(601));
    // Two clicks before React renders the busy state.
    act(() => {
      confirm.click();
      confirm.click();
    });
    const enacted = await screen.findByTestId('practice-repair-enacted-row');
    expect(sends).toHaveBeenCalledTimes(1);
    expect(enacted).toHaveAttribute('data-assignment-id', uuid(601));
    expect(within(enacted).getByTestId('practice-repair-enacted-locked')).toHaveTextContent(
      'Locked'
    );
    expect(screen.getByTestId('practice-repair-announce')).toHaveTextContent(
      `Enacted the recommendation for ${teamOf(uuid(601))}`
    );
    // The DB holds exactly one new row, the recommendation's.
    expect(db.practice_assignments.filter((a) => a.assigned_via === 'recommendation')).toHaveLength(
      1
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('enact panel :: blackout enact is disabled (Q1)', () => {
  it('disables every blackout recommendation with the save refusal as its reason', async () => {
    serve(world(fieldsWith(null)));
    const loss = {
      kind: 'blackout',
      blackout: {
        id: uuid(701),
        field_id: F1,
        location_id: null,
        blackout_from: D,
        blackout_until: '2026-10-31',
        start_minutes: null,
        end_minutes: null,
        reason: 'maintenance',
      },
    };
    await openPanel(loss);
    const subjects = displacedFromRows(world(), F1, D);
    for (const id of subjects) {
      const row = screen
        .getAllByTestId('practice-repair-window')
        .find((r) => r.getAttribute('data-assignment-id') === id);
      expect(within(row).getByTestId('practice-repair-enact')).toBeDisabled();
      const why = within(row).getByTestId('practice-repair-enact-why');
      expect(why).toHaveAttribute('data-enact-gate', 'blackout');
      const refusal = within(row).getAllByTestId('practice-repair-save-refused')[0];
      expect(why.textContent).toContain(refusal.textContent.replace(/^Refused\s*/, '').trim());
    }
    expect(requireExamined(subjects.length, 'series-window')).toBe(2);
    expect(sends).not.toHaveBeenCalled();
  });
});
