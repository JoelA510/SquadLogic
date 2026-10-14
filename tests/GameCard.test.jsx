import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { DndContext } from '@dnd-kit/core';
import GameCard, {
  GameCardPreview,
  GameMoveContext,
} from '../frontend/src/components/scheduling/GameCard.jsx';
import GameScheduleGrid from '../frontend/src/components/scheduling/GameScheduleGrid.jsx';
import { useGameGridSensors } from '../frontend/src/pages/GameSchedulingPage.jsx';

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

// ── Keyboard moves (plan item M4.3) ─────────────────────────────────────────
//
// The grid used to be drag-only: its DndContext took the default sensors, whose
// keyboard step is 25px, and a game card is a plain draggable, which the
// roster manager's `sortableKeyboardCoordinates` cannot move. These cases run
// the page's own sensors (`useGameGridSensors`) over the real grid.

const FIELDS = [
  { id: 'v1', name: 'North Field' },
  { id: 'v2', name: 'South Field' },
];
const SLOTS = [
  { id: 'gs-1', label: 'Sat 8:00 AM' },
  { id: 'gs-2', label: 'Sat 9:30 AM' },
];

/**
 * jsdom has no layout, so every rect is zero and no cell is "below" another.
 * The grid's geometry is given here: field columns 240px apart, time slots
 * 120px apart, the card inside its cell.
 */
const CELL_RECTS = {
  'drop-zone-v1:gs-1': { left: 0, top: 0, width: 200, height: 100 },
  'drop-zone-v1:gs-2': { left: 0, top: 120, width: 200, height: 100 },
  'drop-zone-v2:gs-1': { left: 240, top: 0, width: 200, height: 100 },
  'drop-zone-v2:gs-2': { left: 240, top: 120, width: 200, height: 100 },
};

/** A card sits inset in its cell (padding, then the slot label). */
function cardRect(card) {
  const cell = CELL_RECTS[card.closest('[data-testid^="drop-zone-"]')?.getAttribute('data-testid')];
  return cell ? { left: cell.left + 10, top: cell.top + 24, width: 180, height: 60 } : null;
}

function rectOf(element) {
  const testId = element.getAttribute?.('data-testid') ?? '';
  const box = (testId.startsWith('game-card-') ? cardRect(element) : CELL_RECTS[testId]) ?? {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  };
  return {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  };
}

/** Let dnd-kit's deferred listeners and measurements run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function GridWithPageSensors({ onDragEnd, assignment = ASSIGNMENT }) {
  const sensors = useGameGridSensors();
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <GameScheduleGrid fields={FIELDS} timeSlots={SLOTS} assignments={[assignment]} />
    </DndContext>
  );
}

/** Pick the game up from its grip, press `keys`, drop it; resolve with where it landed. */
async function keyboardMove(onDragEnd, keys, { pickUp = 'Space' } = {}) {
  const handle = screen.getByRole('button', { name: 'Drag team-1 vs team-2' });
  handle.focus();
  fireEvent.keyDown(handle, { code: pickUp });
  await settle();
  for (const code of keys) {
    fireEvent.keyDown(handle, { code });
    await settle();
  }
  fireEvent.keyDown(handle, { code: pickUp });
  await settle();
  expect(onDragEnd).toHaveBeenCalledTimes(1);
  return onDragEnd.mock.calls[0][0].over?.id;
}

describe('GameCard :: keyboard moves (M4.3)', () => {
  let rectSpy;
  beforeEach(() => {
    rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function boundingRect() {
        return rectOf(this);
      });
  });
  afterEach(() => rectSpy.mockRestore());

  test('the grid geometry is in place (or no keyboard case below means anything)', () => {
    render(<GridWithPageSensors onDragEnd={() => {}} />);
    // Meta-assertion: four cells, each with the rect the cases rely on.
    for (const id of ['v1:gs-1', 'v1:gs-2', 'v2:gs-1', 'v2:gs-2']) {
      const cell = screen.getByTestId(`drop-zone-${id}`);
      expect(cell.getBoundingClientRect().width).toBe(200);
    }
  });

  test('a game is dragged with the keyboard alone: space, an arrow, space', async () => {
    const onDragEnd = vi.fn();
    render(<GridWithPageSensors onDragEnd={onDragEnd} />);
    expect(screen.getByRole('button', { name: 'Drag team-1 vs team-2' })).toBeInTheDocument();
    // One arrow press is one cell: the next time slot on the same field.
    expect(await keyboardMove(onDragEnd, ['ArrowDown'])).toBe('v1:gs-2');
    expect(onDragEnd.mock.calls[0][0].active.id).toBe('ga-1');
  });

  test('the right arrow moves a game to the next field at the same time (enter works too)', async () => {
    const onDragEnd = vi.fn();
    render(<GridWithPageSensors onDragEnd={onDragEnd} />);
    expect(await keyboardMove(onDragEnd, ['ArrowRight'], { pickUp: 'Enter' })).toBe('v2:gs-1');
  });

  test.each([
    ['ArrowLeft', 'v1:gs-2'],
    ['ArrowUp', 'v2:gs-1'],
  ])('from the far cell, %s goes to %s, not along its own column or row', async (key, landed) => {
    const onDragEnd = vi.fn();
    // The card sits inset in v2:gs-2, so its own column is "left" of the card
    // and its own row "above" it: read from the card, not the cell, the
    // first press went the wrong way.
    render(
      <GridWithPageSensors
        onDragEnd={onDragEnd}
        assignment={{ ...ASSIGNMENT, fieldId: 'v2', slotId: 'gs-2' }}
      />
    );
    expect(await keyboardMove(onDragEnd, [key])).toBe(landed);
  });

  test('picked up and put down without an arrow, the game is dropped where it was', async () => {
    const onDragEnd = vi.fn();
    render(<GridWithPageSensors onDragEnd={onDragEnd} />);
    expect(await keyboardMove(onDragEnd, [])).toBe('v1:gs-1');
  });

  test('focus follows the dragged game, not the game left showing in its old cell', async () => {
    // Two games in one cell (a conflict): the grid shows the later one. Once it
    // moves, the other shows there, and must not inherit the moved game's focus.
    const other = { ...ASSIGNMENT, id: 'ga-0', homeTeamId: 'team-8', awayTeamId: 'team-9' };
    function Harness() {
      const sensors = useGameGridSensors();
      const [assignments, setAssignments] = React.useState([other, ASSIGNMENT]);
      return (
        <DndContext
          sensors={sensors}
          onDragEnd={({ active, over }) => {
            const [fieldId, slotId] = String(over?.id ?? '').split(':');
            setAssignments((list) =>
              list.map((a) => (a.id === active.id ? { ...a, fieldId, slotId } : a))
            );
          }}
        >
          <GameScheduleGrid fields={FIELDS} timeSlots={SLOTS} assignments={assignments} />
        </DndContext>
      );
    }
    render(<Harness />);
    const handle = screen.getByRole('button', { name: 'Drag team-1 vs team-2' });
    handle.focus();
    fireEvent.keyDown(handle, { code: 'Space' });
    await settle();
    fireEvent.keyDown(handle, { code: 'ArrowRight' });
    await settle();
    fireEvent.keyDown(handle, { code: 'Space' });
    // dnd-kit restores focus on the next animation frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(
      within(screen.getByTestId('drop-zone-v2:gs-1')).getByTestId('game-card-ga-1')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag team-8 vs team-9' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Drag team-1 vs team-2' })).toHaveFocus();
  });

  test('a key pressed in the Move to control never starts a drag', async () => {
    const onDragStart = vi.fn();
    function Harness() {
      const sensors = useGameGridSensors();
      return (
        <DndContext sensors={sensors} onDragStart={onDragStart}>
          <GameMoveContext.Provider value={moveContext({ moveGame: () => {} })}>
            <GameScheduleGrid fields={FIELDS} timeSlots={SLOTS} assignments={[ASSIGNMENT]} />
          </GameMoveContext.Provider>
        </DndContext>
      );
    }
    render(<Harness />);
    const select = screen.getByRole('combobox', { name: /Move team-1 vs team-2/ });
    fireEvent.keyDown(select, { code: 'Space', key: ' ' });
    fireEvent.keyDown(select, { code: 'Enter', key: 'Enter' });
    await settle();
    expect(onDragStart).not.toHaveBeenCalled();
  });
});

/** The page's move context over the four cells above, with ga-1 in v1:gs-1. */
function moveContext({
  moveGame,
  claimFocus = (_gameId) => false,
  emptyIds = ['v1:gs-2', 'v2:gs-1', 'v2:gs-2'],
}) {
  const cellLabels = new Map(
    FIELDS.flatMap((field) =>
      SLOTS.map((slot) => [`${field.id}:${slot.id}`, `${field.name}, ${slot.label}`])
    )
  );
  return {
    cellLabels,
    emptyCells: emptyIds.map((id) => ({ id, label: cellLabels.get(id) })),
    moveGame,
    claimFocus,
  };
}

describe('GameCard :: Move to control (M4.3)', () => {
  test("names the game and where it is now, and lists the page's empty cells once reached", () => {
    render(
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame: () => {} })}>
          <GameCard assignment={ASSIGNMENT} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    const select = screen.getByRole('combobox', {
      name: 'Move team-1 vs team-2, now at North Field, Sat 8:00 AM, to',
    });
    const offered = () => [...select.querySelectorAll('option')].map((option) => option.value);
    // Rendered once the list is reached, not with every card.
    expect(offered()).toEqual(['']);
    fireEvent.focus(select);
    // Enumerated from the context's empty cells, not from what the control rendered.
    expect(offered()).toEqual(['', 'v1:gs-2', 'v2:gs-1', 'v2:gs-2']);
  });

  test('moves the game through the page handler, naming the cell as a drop does', () => {
    const moveGame = vi.fn();
    render(
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame })}>
          <GameCard assignment={ASSIGNMENT} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    const move = screen.getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    const select = screen.getByRole('combobox', { name: /Move team-1 vs team-2/ });
    fireEvent.focus(select);
    fireEvent.change(select, { target: { value: 'v2:gs-2' } });
    fireEvent.click(move);
    expect(moveGame).toHaveBeenCalledWith('ga-1', 'v2:gs-2', { focusMoved: true });
  });

  test('forgets a choice that another move has since filled', () => {
    const moveGame = vi.fn();
    const card = (emptyIds) => (
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame, emptyIds })}>
          <GameCard assignment={ASSIGNMENT} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    const { rerender } = render(card(['v1:gs-2', 'v2:gs-2']));
    const select = screen.getByRole('combobox', { name: /Move team-1 vs team-2/ });
    fireEvent.focus(select);
    fireEvent.change(select, { target: { value: 'v2:gs-2' } });
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();

    rerender(card(['v1:gs-2']));
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(moveGame).not.toHaveBeenCalled();
  });

  test('says when there is nowhere to move to', () => {
    render(
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame: () => {}, emptyIds: [] })}>
          <GameCard assignment={ASSIGNMENT} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    expect(screen.getByRole('combobox', { name: /Move team-1 vs team-2/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'No empty slot' })).toBeInTheDocument();
  });

  test('takes focus where it lands when the page says it was just moved', () => {
    const claimFocus = vi.fn((gameId) => gameId === 'ga-1');
    render(
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame: () => {}, claimFocus })}>
          <GameCard assignment={ASSIGNMENT} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    expect(claimFocus).toHaveBeenCalledWith('ga-1');
    expect(screen.getByRole('combobox', { name: /Move team-1 vs team-2/ })).toHaveFocus();
  });

  test('is absent when the card cannot be moved', () => {
    render(
      <DndWrapper>
        <GameMoveContext.Provider value={moveContext({ moveGame: () => {} })}>
          <GameCard assignment={ASSIGNMENT} isDragDisabled={true} />
        </GameMoveContext.Provider>
      </DndWrapper>
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Drag/ })).not.toBeInTheDocument();
  });
});
