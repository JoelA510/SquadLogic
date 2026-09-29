/**
 * 8.6 3b PR 11c: the retired field card's "Repair practices" launcher
 * (witness 25) and the un-retire confirmation's enacted count
 * (`docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1, "The commit gate").
 *
 * Subjects are enumerated from the fields and audit rows this file serves,
 * never from the rendered page. Synthetic rows only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ audit: /** @type {any[]} */ ([]), fail: false }));

vi.mock('../frontend/src/hooks/useFields.js', () => ({ useFields: vi.fn() }));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => true }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1' } }),
}));
// The launcher is probed: what it is handed is the witness.
vi.mock('../frontend/src/components/scheduling/PracticeRepairLauncher.jsx', () => ({
  default: (props) => (
    <div
      data-testid="launcher-probe"
      data-loss={JSON.stringify(props.loss)}
      data-label={props.label ?? ''}
      data-preview={String(props.preview === true)}
    />
  ),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      const filters = [];
      const q = {
        select: () => q,
        eq: (col, val) => {
          filters.push([col, val]);
          return q;
        },
        order: () => q,
        range: (lo, hi) =>
          Promise.resolve(
            h.fail
              ? { data: null, error: { message: `${table}: permission denied` } }
              : {
                  data: h.audit
                    .filter((row) => filters.every(([c, v]) => String(row[c]) === String(v)))
                    .slice(lo, hi + 1),
                  error: null,
                }
          ),
      };
      return q;
    },
  },
}));

import FieldManagementPage from '../frontend/src/pages/FieldManagementPage.jsx';
import { useFields } from '../frontend/src/hooks/useFields.js';

const field = (id, name, effectiveTo) => ({
  id,
  location_id: 'loc-1',
  name,
  active: true,
  surface_type: 'Grass',
  size: '11v11',
  priority_rating: 1,
  supports_halves: false,
  field_subunits: [],
  practice_slots: [],
  effective_to: effectiveTo,
});
const FIELDS = [
  field('f-east', 'East Pitch', '2026-10-14'),
  field('f-west', 'West Pitch', '2026-11-02'),
  field('f-open', 'Open Pitch', null),
];
const hook = {
  locations: [{ id: 'loc-1', name: 'Test Complex' }],
  fields: FIELDS,
  availabilityProfiles: [],
  loading: false,
  error: null,
  unretireField: vi.fn(async () => ({})),
};
const storedOf = (fieldId) => FIELDS.find((f) => f.id === fieldId).effective_to;
const enactRow = (n, fieldId, seriesId, stored = storedOf(fieldId)) => ({
  id: `audit-${n}`,
  organization_id: 'org-1',
  action: 'practice.recommendation_enacted',
  metadata: {
    cause: { kind: 'retirement', id: fieldId, stored_effective_to: stored },
    series: { assignment_id: seriesId },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.fail = false;
  h.audit = [
    enactRow(1, 'f-east', 's-1'),
    enactRow(2, 'f-east', 's-2'),
    enactRow(3, 'f-west', 's-3'),
    { ...enactRow(4, 'f-east', 's-4'), organization_id: 'org-2' },
    { ...enactRow(5, 'f-east', 's-5'), action: 'practice.saved' },
    // An earlier retire / un-retire cycle of the same field: not this retirement.
    enactRow(6, 'f-east', 's-6', '2026-08-31'),
    // Another field retired on the SAME date: the field id, not the date, decides.
    enactRow(7, 'f-west', 's-7', '2026-10-14'),
  ];
  vi.mocked(useFields).mockReturnValue(/** @type {any} */ (hook));
});

describe('field card :: 25, the post-commit launcher uses the STORED date', () => {
  it('hands every retired card its own stored effective_to, and no launcher to a live field', () => {
    render(<FieldManagementPage />);
    const retired = FIELDS.filter((f) => f.effective_to);
    expect(retired.length).toBe(2);
    for (const f of retired) {
      const probe = within(screen.getByTestId(`retired-${f.id}`)).getByTestId('launcher-probe');
      expect(JSON.parse(probe.getAttribute('data-loss'))).toEqual({
        kind: 'retirement',
        field: { id: f.id, effective_to: f.effective_to },
      });
      expect(probe).toHaveAttribute('data-label', 'Repair practices');
      expect(probe).toHaveAttribute('data-preview', 'false');
    }
    expect(screen.getAllByTestId('launcher-probe')).toHaveLength(retired.length);
  });
});

describe('field card :: the un-retire confirmation counts the series enacted off the field', () => {
  it('states the count from this org’s enact audit rows for THIS field, and moves nothing', async () => {
    for (const f of FIELDS.filter((x) => x.effective_to)) {
      const expected = new Set(
        h.audit
          .filter(
            (r) =>
              r.organization_id === 'org-1' &&
              r.action === 'practice.recommendation_enacted' &&
              r.metadata.cause.id === f.id &&
              r.metadata.cause.stored_effective_to === f.effective_to
          )
          .map((r) => r.metadata.series.assignment_id)
      ).size;
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { unmount } = render(<FieldManagementPage />);
      fireEvent.click(screen.getByRole('button', { name: `Clear the end date on ${f.name}` }));
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(confirm.mock.calls[0][0]).toContain(
        `${expected} practice series ${expected === 1 ? 'was' : 'were'} enacted off this field`
      );
      expect(confirm.mock.calls[0][0]).toContain('will not move back');
      // Declined: nothing is cleared.
      expect(hook.unretireField).not.toHaveBeenCalled();
      confirm.mockRestore();
      unmount();
    }
  });

  it('says the count could not be read rather than claiming none', async () => {
    h.fail = true;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FieldManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the end date on East Pitch' }));
    await waitFor(() => expect(hook.unretireField).toHaveBeenCalledWith('f-east'));
    expect(confirm.mock.calls[0][0]).toContain('could not be read');
    expect(confirm.mock.calls[0][0]).not.toMatch(/\b0 practice series/);
    confirm.mockRestore();
  });
});
