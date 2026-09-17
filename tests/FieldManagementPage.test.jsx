import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FieldManagementPage from '../frontend/src/pages/FieldManagementPage.jsx';

vi.mock('../frontend/src/hooks/useFields.js', () => ({ useFields: vi.fn() }));

import { useFields } from '../frontend/src/hooks/useFields.js';

const baseHook = {
  locations: [{ id: 'loc-1', name: 'Main Complex' }],
  fields: [
    {
      id: 'field-1',
      location_id: 'loc-1',
      name: 'North Field',
      active: true,
      surface_type: 'Grass',
      size: '11v11',
      priority_rating: 1,
      supports_halves: false,
      field_subunits: [],
      practice_slots: [
        { id: 'ps-1', day_of_week: 'mon', start_time: '17:00:00', end_time: '18:00:00' },
      ],
    },
  ],
  availabilityProfiles: [],
  loading: false,
  error: null,
  addLocation: vi.fn(),
  addField: vi.fn(),
  updateField: vi.fn(),
  deleteField: vi.fn(),
  retireField: vi.fn(),
  unretireField: vi.fn(),
  retireLocation: vi.fn(),
  unretireLocation: vi.fn(),
  retireFieldSubunit: vi.fn(),
  unretireFieldSubunit: vi.fn(),
  refresh: vi.fn(),
};

describe('FieldManagementPage seasonal availability panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFields).mockReturnValue(baseHook);
  });

  it('renders empty seasonal state and keeps slot grid', () => {
    render(<FieldManagementPage />);
    expect(screen.getByText('No seasonal availability profiles imported yet.')).toBeInTheDocument();
    expect(screen.getByText('North Field')).toBeInTheDocument();
    expect(screen.getByText('mon')).toBeInTheDocument();
  });

  it('renders imported seasonal profiles and badge text content', () => {
    vi.mocked(useFields).mockReturnValue({
      ...baseHook,
      availabilityProfiles: [
        {
          id: 'ap-1',
          season_label: 'Fall 2026',
          location: 'Canyon',
          field_name: 'Turf 11v11 Pods',
          record_status: 'potential',
          approval_status: 'pending',
          available_from: '2026-08-01',
          available_until: '2026-11-30',
          blackout_months: 'Aug, Sep',
          teams_per_hour: 2,
          aggregate_teams_per_hour: 8,
          day_constraints: 'Sat/Sun',
          move_to_location: 'Vannoy',
          lighted: true,
          restroom: false,
          potty: true,
          field_availability_profile_formats: [
            { id: 'f1', format_code: '11v11', format_quantity: 4 },
          ],
          field_blackout_windows: [
            {
              id: 'b1',
              blackout_from: '2026-09-01',
              blackout_until: '2026-09-30',
              reason: 'Maintenance',
            },
          ],
          field_equipment_requirements: [
            { id: 'e1', goal_equipment: 'sturdy goals', requirement_status: 'required' },
          ],
        },
      ],
    });

    render(<FieldManagementPage />);
    expect(screen.getByText('Fall 2026')).toBeInTheDocument();
    expect(screen.getByText('Status: potential')).toBeInTheDocument();
    expect(screen.getByText('Approval: pending')).toBeInTheDocument();
    expect(screen.getByText('Potential state')).toBeInTheDocument();
    expect(screen.getByText(/Blackouts: 2026-09-01 to 2026-09-30/)).toBeInTheDocument();
    expect(screen.getByText(/Equipment flags: sturdy goals \(required\)/)).toBeInTheDocument();
    expect(screen.getByText('Aug: Yes')).toBeInTheDocument();
  });

  it('shows conditional and excluded state badges', () => {
    vi.mocked(useFields).mockReturnValue({
      ...baseHook,
      availabilityProfiles: [
        {
          id: 'ap-2',
          season_label: 'Fall 2026',
          location: 'A',
          field_name: 'B',
          record_status: 'conditional',
          field_availability_profile_formats: [],
          field_blackout_windows: [],
          field_equipment_requirements: [],
        },
        {
          id: 'ap-3',
          season_label: 'Fall 2026',
          location: 'C',
          field_name: 'D',
          record_status: 'excluded',
          field_availability_profile_formats: [],
          field_blackout_windows: [],
          field_equipment_requirements: [],
        },
      ],
    });

    render(<FieldManagementPage />);
    expect(screen.getByText('Conditional state')).toBeInTheDocument();
    expect(screen.getByText('Excluded state')).toBeInTheDocument();
  });
});

describe('FieldManagementPage delete flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * `deleteField` returns the RPC's payload; a refusal is `{deleted:false}`
   * with no error. This mirrors that so the page is exercised against the
   * contract the hook actually has.
   *
   * @param {Array<any>} outcomes one per call, in order
   */
  const hookWith = (outcomes) => {
    const deleteField = vi.fn();
    for (const outcome of outcomes) deleteField.mockResolvedValueOnce(outcome);
    vi.mocked(useFields).mockReturnValue({ ...baseHook, deleteField });
    return deleteField;
  };

  const REFUSAL = {
    deleted: false,
    reason: 'bookings_exist',
    affected_count: 3,
    affected: [
      { kind: 'game_slot', id: 'gs-1', disposition: 'deleted' },
      { kind: 'practice_slot', id: 'ps-1', disposition: 'deleted' },
      { kind: 'practice_assignment', id: 'pa-1', disposition: 'unassigned' },
    ],
  };

  it('shows the operator what is booked and only deletes when they confirm again', async () => {
    // **The status the page used to swallow.** Before the guard, deleting
    // booked ground cascaded its slots away and left its assignments without a
    // venue, silently. A page that ignored `{deleted:false}` would put that
    // silence back one level up: the operator would click Delete, see nothing
    // happen, and have no idea why.
    const deleteField = hookWith([REFUSAL, { deleted: true }]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FieldManagementPage />);

    fireEvent.click(screen.getByLabelText('Delete North Field'));

    await waitFor(() => expect(deleteField).toHaveBeenCalledTimes(2));
    expect(deleteField).toHaveBeenNthCalledWith(1, 'field-1');
    expect(deleteField).toHaveBeenNthCalledWith(2, 'field-1', { confirm: true });

    // The second prompt carries the count and both consequences, from the
    // payload rather than from a sentence written here.
    const consequence = confirmSpy.mock.calls[1][0];
    expect(consequence).toContain('3 booking(s)');
    expect(consequence).toContain('permanently removes 2 of them');
    expect(consequence).toContain('leaves 1 without a venue');
    confirmSpy.mockRestore();
  });

  it('does not delete when the operator declines the consequence prompt', async () => {
    // The other direction, so the test above is about the confirmation and not
    // about the page calling delete twice whatever the operator says.
    const deleteField = hookWith([REFUSAL]);
    const confirmSpy = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    render(<FieldManagementPage />);

    fireEvent.click(screen.getByLabelText('Delete North Field'));

    await waitFor(() => expect(deleteField).toHaveBeenCalledTimes(1));
    expect(deleteField).toHaveBeenCalledWith('field-1');
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });

  it('does not promise a survival for bookings the database will destroy', async () => {
    // **The disposition is per ROW, not per table.** A refusal naming two game
    // assignments -- one slot-linked, one free-standing -- must be summarised
    // as one destroyed and one left venueless. Counting by TABLE would report
    // "leaves 2 without a venue" and promise the operator that a scheduled
    // game survives, which it does not.
    const deleteField = hookWith([
      {
        deleted: false,
        reason: 'bookings_exist',
        affected_count: 2,
        affected: [
          { kind: 'game_assignment', id: 'ga-slotted', disposition: 'deleted' },
          { kind: 'game_assignment', id: 'ga-free', disposition: 'unassigned' },
        ],
      },
    ]);
    const confirmSpy = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    render(<FieldManagementPage />);

    fireEvent.click(screen.getByLabelText('Delete North Field'));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(2));
    const consequence = confirmSpy.mock.calls[1][0];
    expect(consequence).toContain('permanently removes 1 of them');
    expect(consequence).toContain('leaves 1 without a venue');
    expect(deleteField).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('asks only once when nothing is booked', async () => {
    const deleteField = hookWith([{ deleted: true, affected_count: 0, affected: [] }]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FieldManagementPage />);

    fireEvent.click(screen.getByLabelText('Delete North Field'));

    await waitFor(() => expect(deleteField).toHaveBeenCalledTimes(1));
    // One prompt, not two: a guard that refused unbooked ground would be a
    // different defect, and this is where the page would show it.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});

describe('FieldManagementPage: the two new estate depths', () => {
  /** Venue and sub-surface state the page has to render controls for. */
  const ESTATE = {
    locations: [
      { id: 'loc-1', name: 'Canyon Park', effective_to: null },
      { id: 'loc-2', name: 'Closed Site', effective_to: '2026-08-31' },
    ],
    subunits: [
      { id: 'su-1', label: 'North A', effective_to: null },
      { id: 'su-2', label: 'North B', effective_to: '2026-08-31' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFields).mockReturnValue({
      ...baseHook,
      locations: ESTATE.locations,
      fields: [
        {
          ...baseHook.fields[0],
          supports_halves: true,
          field_subunits: ESTATE.subunits,
        },
      ],
    });
  });

  it('offers a control at venue depth for every venue, keyed on its own end date', () => {
    render(<FieldManagementPage />);
    // **Enumerated from ESTATE, not from the rendered list.** A venue dropped
    // by the renderer is a control that cannot be found, not an expectation
    // that quietly went away.
    expect(ESTATE.locations.length).toBeGreaterThan(0);
    for (const loc of ESTATE.locations) {
      expect(screen.getByTestId(`venue-${loc.id}`)).toBeInTheDocument();
      if (loc.effective_to) {
        expect(screen.getByTestId(`venue-retired-${loc.id}`)).toHaveTextContent(loc.effective_to);
        // A retired venue offers the reversal, never a second retirement.
        expect(
          screen.getByRole('button', { name: `Clear the end date on ${loc.name}` })
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: `Retire ${loc.name}` })).toBeNull();
      } else {
        expect(screen.getByRole('button', { name: `Retire ${loc.name}` })).toBeInTheDocument();
      }
    }
  });

  it('offers a control at sub-surface depth for every sub-surface', () => {
    render(<FieldManagementPage />);
    expect(ESTATE.subunits.length).toBeGreaterThan(0);
    for (const su of ESTATE.subunits) {
      expect(screen.getByTestId(`subunit-${su.id}`)).toBeInTheDocument();
      const name = `${su.label} of North Field`;
      if (su.effective_to) {
        expect(
          screen.getByRole('button', {
            name: `Clear the end date on ${su.label} of North Field`,
          })
        ).toBeInTheDocument();
      } else {
        expect(screen.getByRole('button', { name: `Retire ${name}` })).toBeInTheDocument();
      }
    }
  });

  it('opens the venue dialog on the venue RPC, and the sub-surface dialog on its own', async () => {
    const retireLocation = vi.fn().mockResolvedValue({ retired: true, contained: [] });
    const retireFieldSubunit = vi.fn().mockResolvedValue({ retired: true });
    vi.mocked(useFields).mockReturnValue({
      ...baseHook,
      locations: ESTATE.locations,
      fields: [{ ...baseHook.fields[0], supports_halves: true, field_subunits: ESTATE.subunits }],
      retireLocation,
      retireFieldSubunit,
    });

    render(<FieldManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Retire Canyon Park' }));
    // The dialog is the VENUE one: its date label names the depth.
    expect(await screen.findByLabelText(/Last day this venue is usable/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() =>
      expect(retireLocation).toHaveBeenCalledWith('loc-1', {
        effectiveTo: expect.any(String),
        confirm: false,
      })
    );
    // A venue that holds nothing still reports that it holds nothing.
    expect(await screen.findByTestId('contained-none')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retire North A of North Field' }));
    expect(await screen.findByLabelText(/Last day this sub-surface is usable/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() =>
      expect(retireFieldSubunit).toHaveBeenCalledWith('su-1', {
        effectiveTo: expect.any(String),
        confirm: false,
      })
    );
    // **The two depths did not cross.** The venue RPC was not called a second
    // time by the sub-surface control.
    expect(retireLocation).toHaveBeenCalledTimes(1);
  });

  it('clears an end date through the RPC for that depth', async () => {
    const unretireLocation = vi.fn().mockResolvedValue({ retired: false, location: {} });
    const unretireFieldSubunit = vi.fn().mockResolvedValue({ retired: false, field_subunit: {} });
    vi.mocked(useFields).mockReturnValue({
      ...baseHook,
      locations: ESTATE.locations,
      fields: [{ ...baseHook.fields[0], supports_halves: true, field_subunits: ESTATE.subunits }],
      unretireLocation,
      unretireFieldSubunit,
    });

    render(<FieldManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the end date on Closed Site' }));
    await waitFor(() => expect(unretireLocation).toHaveBeenCalledWith('loc-2'));
    expect(unretireFieldSubunit).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear the end date on North B of North Field' })
    );
    await waitFor(() => expect(unretireFieldSubunit).toHaveBeenCalledWith('su-2'));
  });
});
