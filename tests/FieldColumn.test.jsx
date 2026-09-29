import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { DndContext } from '@dnd-kit/core';
import FieldColumn from '../frontend/src/components/scheduling/FieldColumn.jsx';

// Mocked like the sibling component tests: the real module starts the lazy
// mock-client import (`supabaseReady`) on load, and nothing here awaits it, so
// it can outlive this file's jsdom environment (EnvironmentTeardownError).
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

function DndWrapper({ children }) {
  return <DndContext>{children}</DndContext>;
}

const FIELD = {
  id: 'v1',
  name: 'Field A',
  surface_type: 'Grass',
  size: '11v11',
};

const TIME_SLOTS = [
  { id: 'gs-1', label: '8:00 AM' },
  { id: 'gs-2', label: '9:30 AM' },
  { id: 'gs-3', label: '11:00 AM' },
];

const ASSIGNMENT_1 = {
  id: 'ga-1',
  slotId: 'gs-1',
  homeTeamId: 'team-1',
  awayTeamId: 'team-2',
  start: '2026-04-04T08:00:00Z',
  end: '2026-04-04T09:00:00Z',
  fieldId: 'v1',
  division: 'U10',
  assignmentSource: 'auto',
};

describe('FieldColumn', () => {
  test('renders field header with name', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByText('Field A')).toBeInTheDocument();
  });

  test('renders field metadata (surface type and size)', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByText('Grass • 11v11')).toBeInTheDocument();
  });

  test('renders correct data-testid', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByTestId('field-column-v1')).toBeInTheDocument();
  });

  test('renders a TimeSlotDropZone for each time slot', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByTestId('drop-zone-v1:gs-1')).toBeInTheDocument();
    expect(screen.getByTestId('drop-zone-v1:gs-2')).toBeInTheDocument();
    expect(screen.getByTestId('drop-zone-v1:gs-3')).toBeInTheDocument();
  });

  test('renders slot labels', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByText('8:00 AM')).toBeInTheDocument();
    expect(screen.getByText('9:30 AM')).toBeInTheDocument();
    expect(screen.getByText('11:00 AM')).toBeInTheDocument();
  });

  test('places assignment in the correct slot', () => {
    const assignmentsBySlot = { 'gs-1': ASSIGNMENT_1 };
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={TIME_SLOTS} assignmentsBySlot={assignmentsBySlot} />
      </DndWrapper>
    );
    // gs-1 should have a game card
    expect(screen.getByTestId('game-card-ga-1')).toBeInTheDocument();
    // gs-2 and gs-3 should be empty
    expect(screen.getByTestId('empty-slot-v1:gs-2')).toBeInTheDocument();
    expect(screen.getByTestId('empty-slot-v1:gs-3')).toBeInTheDocument();
  });

  test('shows empty message when no time slots', () => {
    render(
      <DndWrapper>
        <FieldColumn field={FIELD} timeSlots={[]} />
      </DndWrapper>
    );
    expect(screen.getByText('No time slots available')).toBeInTheDocument();
  });

  test('field without surface_type omits metadata line', () => {
    const minimalField = { id: 'v2', name: 'Field B' };
    render(
      <DndWrapper>
        <FieldColumn field={minimalField} timeSlots={TIME_SLOTS} />
      </DndWrapper>
    );
    expect(screen.getByText('Field B')).toBeInTheDocument();
    expect(screen.queryByText(/Grass/)).not.toBeInTheDocument();
  });
});
