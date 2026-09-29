import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { DndContext } from '@dnd-kit/core';
import GameCard, { GameCardPreview } from '../frontend/src/components/scheduling/GameCard.jsx';

// Mocked like the sibling component tests: the real module starts the lazy
// mock-client import (`supabaseReady`) on load, and nothing here awaits it, so
// it can outlive this file's jsdom environment (EnvironmentTeardownError).
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

/** Wrap components that use useDraggable in a DndContext. */
function DndWrapper({ children }) {
  return <DndContext>{children}</DndContext>;
}

const ASSIGNMENT = {
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

const MANUAL_ASSIGNMENT = {
  ...ASSIGNMENT,
  id: 'ga-manual',
  assignmentSource: 'manual',
};

// ── GameCard ────────────────────────────────────────────────────────────────

describe('GameCard', () => {
  test('renders team matchup', () => {
    render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} />
      </DndWrapper>
    );
    expect(screen.getByText('team-1')).toBeInTheDocument();
    expect(screen.getByText('team-2')).toBeInTheDocument();
    expect(screen.getByText('vs')).toBeInTheDocument();
  });

  test('renders correct data-testid', () => {
    render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} />
      </DndWrapper>
    );
    expect(screen.getByTestId('game-card-ga-1')).toBeInTheDocument();
  });

  test('shows field and division info', () => {
    render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} />
      </DndWrapper>
    );
    expect(screen.getByText('Field v1')).toBeInTheDocument();
    expect(screen.getByText('U10')).toBeInTheDocument();
  });

  test('shows manual badge when assignmentSource is manual', () => {
    render(
      <DndWrapper>
        <GameCard assignment={MANUAL_ASSIGNMENT} />
      </DndWrapper>
    );
    expect(screen.getByTestId('manual-badge')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
  });

  test('does not show manual badge for auto assignments', () => {
    render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} />
      </DndWrapper>
    );
    expect(screen.queryByTestId('manual-badge')).not.toBeInTheDocument();
  });

  test('applies conflict styling when hasConflict is true', () => {
    render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} hasConflict={true} />
      </DndWrapper>
    );
    const card = screen.getByTestId('game-card-ga-1');
    expect(card.className).toContain('border-status-error');
  });

  test('does not show grip handle when drag is disabled', () => {
    const { container: _container } = render(
      <DndWrapper>
        <GameCard assignment={ASSIGNMENT} isDragDisabled={true} />
      </DndWrapper>
    );
    // GripVertical is wrapped in a div that's conditionally rendered
    // When disabled, cursor should be default
    const card = screen.getByTestId('game-card-ga-1');
    expect(card.className).toContain('cursor-default');
    expect(card.className).not.toContain('cursor-grab');
  });
});

// ── GameCardPreview ─────────────────────────────────────────────────────────

describe('GameCardPreview', () => {
  test('renders team matchup text', () => {
    render(<GameCardPreview assignment={ASSIGNMENT} />);
    expect(screen.getByText('team-1 vs team-2')).toBeInTheDocument();
  });

  test('shows moving indicator text', () => {
    render(<GameCardPreview assignment={ASSIGNMENT} />);
    expect(screen.getByText('Moving game...')).toBeInTheDocument();
  });

  test('has preview test id', () => {
    render(<GameCardPreview assignment={ASSIGNMENT} />);
    expect(screen.getByTestId('game-card-preview')).toBeInTheDocument();
  });

  test('has drag styling (rotation, shadow)', () => {
    render(<GameCardPreview assignment={ASSIGNMENT} />);
    const preview = screen.getByTestId('game-card-preview');
    expect(preview.className).toContain('rotate-2');
    expect(preview.className).toContain('shadow-md');
    expect(preview.className).toContain('border-blue-500');
  });
});
