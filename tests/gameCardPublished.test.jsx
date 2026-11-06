/**
 * PR 3 task C1 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.6): the Published switch and
 * the card's text. A saved game's card says its state in words (never colour alone), carries a switch whose name is
 * "Published: home versus away" and whose state is `aria-checked`, and a Published card is held: no grip, not
 * draggable, no "Move to", and an "Allow changes" button in their place.
 *
 * What jsdom cannot see, and where it is held instead: contrast and the rest of axe run on the real page in both themes
 * in `tests/e2e/features/published_games.feature` (this repository has no jsdom axe, and adding one is a dependency).
 * Here: role, name, state, label-in-name (WCAG 2.5.3), keyboard operation, and that the new components hold no literal
 * colour (tokens only, so both themes follow).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import GameCard from '../frontend/src/components/scheduling/GameCard.jsx';
import PublishedControls, {
  GamePublishedContext,
} from '../frontend/src/components/scheduling/PublishedSwitch.jsx';
import { expectVisibleTextInName } from './helpers/index.js';

// Mocked like the sibling component tests: the real module starts the lazy mock-client import on load.
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

const BASE = {
  id: 'ga-1',
  slotId: 'gs-1',
  homeTeamId: 'team-1',
  awayTeamId: 'team-2',
  start: '2026-04-04T08:00:00Z',
  end: '2026-04-04T09:00:00Z',
  fieldId: 'v1',
  division: 'U10',
  assignmentSource: 'auto',
  persisted: true,
};
const NOT_PUBLISHED = { ...BASE, published: false };
const PUBLISHED = { ...BASE, published: true, publishedAt: '2026-10-01T12:00:00Z' };
const CHANGES_ALLOWED = { ...BASE, published: false, publishedAt: '2026-10-01T12:00:00Z' };
const UNSAVED = { ...BASE, id: 'review-team-1-team-2', persisted: false };

function context(overrides = {}) {
  return {
    canChange: true,
    canReadHistory: true,
    disabledReason: null,
    reasonId: 'published-reason',
    publish: vi.fn(),
    allowChanges: vi.fn(),
    showHistory: vi.fn(),
    ...overrides,
  };
}

function renderCard(assignment, ctx = context()) {
  const view = render(
    <DndContext>
      <GamePublishedContext.Provider value={ctx}>
        <p id="published-reason">The reason, said once</p>
        <GameCard assignment={assignment} />
      </GamePublishedContext.Provider>
    </DndContext>
  );
  return { ...view, ctx };
}

describe('the switch: role, name and state', () => {
  it('a game that is not Published: a switch named "Published: home versus away", off, with the state in words', () => {
    renderCard(NOT_PUBLISHED);
    const toggle = screen.getByRole('switch', { name: 'Published: team-1 versus team-2' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // The state is also in words, not only the switch's position or a colour.
    expect(
      within(screen.getByTestId('game-card-ga-1')).getByTestId('published-state')
    ).toHaveTextContent('Not published');
  });

  it('a Published game: the switch is on and the words say Published', () => {
    renderCard(PUBLISHED);
    expect(screen.getByRole('switch', { name: 'Published: team-1 versus team-2' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId('published-state')).toHaveTextContent('Published');
  });

  it('a game with changes allowed: the switch is off and the words say Changes allowed, not Not published', () => {
    renderCard(CHANGES_ALLOWED);
    expect(screen.getByRole('switch', { name: 'Published: team-1 versus team-2' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByTestId('published-state')).toHaveTextContent('Changes allowed');
    expect(screen.getByTestId('published-state')).not.toHaveTextContent('Not published');
  });

  it('names the teams when the game has names', () => {
    renderCard({
      ...NOT_PUBLISHED,
      homeTeamName: 'Synthetic Comets',
      awayTeamName: 'Synthetic Rockets',
    });
    expect(
      screen.getByRole('switch', { name: 'Published: Synthetic Comets versus Synthetic Rockets' })
    ).toBeInTheDocument();
  });

  it('a game with no row yet (a staged review) has no switch and says to apply the schedule first', () => {
    renderCard(UNSAVED);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('published-state')).toHaveTextContent('Apply the schedule first');
  });
});

describe('turning it on needs nothing; turning it off is the dialog', () => {
  it('pressing the off switch publishes, once, with no dialog step', () => {
    const { ctx } = renderCard(NOT_PUBLISHED);
    fireEvent.click(screen.getByRole('switch', { name: /^Published:/ }));
    expect(ctx.publish).toHaveBeenCalledTimes(1);
    expect(ctx.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'ga-1' }));
    expect(ctx.allowChanges).not.toHaveBeenCalled();
  });

  it('a game with changes allowed is published again the same way', () => {
    const { ctx } = renderCard(CHANGES_ALLOWED);
    fireEvent.click(screen.getByRole('switch', { name: /^Published:/ }));
    expect(ctx.publish).toHaveBeenCalledTimes(1);
  });

  it('pressing the on switch asks to allow changes and does not change the flag itself', () => {
    const { ctx } = renderCard(PUBLISHED);
    fireEvent.click(screen.getByRole('switch', { name: /^Published:/ }));
    expect(ctx.allowChanges).toHaveBeenCalledTimes(1);
    expect(ctx.publish).not.toHaveBeenCalled();
    // Still on: it turns off only when the database says so.
    expect(screen.getByRole('switch', { name: /^Published:/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('is operable from the keyboard: the switch is a focusable button that Enter and Space press', () => {
    const { ctx } = renderCard(NOT_PUBLISHED);
    const toggle = screen.getByRole('switch', { name: /^Published:/ });
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(toggle.tagName).toBe('BUTTON');
    // A native button turns Enter and Space into a click; jsdom does not, so the click is the proof of the handler.
    fireEvent.click(toggle);
    expect(ctx.publish).toHaveBeenCalledTimes(1);
  });
});

describe('a Published card is held where it is', () => {
  it('has no grip, no "Move to", and says why; "Allow changes" takes their place', () => {
    const { ctx } = renderCard(PUBLISHED);
    expect(screen.queryByRole('button', { name: /^Drag / })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move$/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('published-hold-note')).toHaveTextContent(
      'Published: allow changes to move it.'
    );
    const allow = screen.getByRole('button', { name: 'Allow changes: team-1 versus team-2' });
    fireEvent.click(allow);
    expect(ctx.allowChanges).toHaveBeenCalledWith(expect.objectContaining({ id: 'ga-1' }));
  });

  it('control: a game that is not Published still has its grip and "Move to" (the hold is not a blanket)', () => {
    renderCard(NOT_PUBLISHED, context());
    expect(screen.getByRole('button', { name: 'Drag team-1 vs team-2' })).toBeInTheDocument();
    expect(screen.queryByTestId('published-hold-note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Allow changes/ })).not.toBeInTheDocument();
  });

  it('a game with changes allowed is movable again (grip back)', () => {
    renderCard(CHANGES_ALLOWED);
    expect(screen.getByRole('button', { name: 'Drag team-1 vs team-2' })).toBeInTheDocument();
  });

  it('is held even with no provider at all (a card rendered on its own)', () => {
    render(
      <DndContext>
        <GameCard assignment={PUBLISHED} />
      </DndContext>
    );
    expect(screen.queryByRole('button', { name: /^Drag / })).not.toBeInTheDocument();
    expect(screen.getByTestId('published-state')).toHaveTextContent('Published');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('who sees which controls', () => {
  it('a person who may not change it sees the state in words and no switch or button', () => {
    renderCard(PUBLISHED, context({ canChange: false, canReadHistory: false }));
    expect(screen.getByTestId('published-state')).toHaveTextContent('Published');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Allow changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
  });

  it('while the controls are off the switch is disabled and points at the reason that is on the page', () => {
    renderCard(NOT_PUBLISHED, context({ disabledReason: 'The reason, said once' }));
    const toggle = screen.getByRole('switch', { name: /^Published:/ });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-describedby', 'published-reason');
    expect(document.getElementById('published-reason')).toHaveTextContent('The reason, said once');
  });

  it('History is offered once a game has been Published, and not before', () => {
    const { unmount } = renderCard(NOT_PUBLISHED);
    expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
    unmount();
    const { ctx } = renderCard(CHANGES_ALLOWED);
    fireEvent.click(screen.getByRole('button', { name: 'History: team-1 versus team-2' }));
    expect(ctx.showHistory).toHaveBeenCalledWith(expect.objectContaining({ id: 'ga-1' }));
  });
});

describe('label in name (WCAG 2.5.3)', () => {
  it('"Allow changes" and "History" carry their visible text in their accessible names', () => {
    renderCard(PUBLISHED);
    expectVisibleTextInName(screen.getByRole('button', { name: /^Allow changes:/ }));
    expectVisibleTextInName(screen.getByRole('button', { name: /^History:/ }));
  });
});

describe('the list row uses the same control', () => {
  it('PublishedControls alone renders the same switch, name and words', () => {
    const ctx = context();
    render(
      <GamePublishedContext.Provider value={ctx}>
        <PublishedControls assignment={PUBLISHED} />
      </GamePublishedContext.Provider>
    );
    expect(screen.getByRole('switch', { name: 'Published: team-1 versus team-2' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

describe('both themes: tokens only', () => {
  // A literal colour in a component does not follow the theme. The same shape as tests/chartColorTokens.test.js.
  const LITERAL_COLOUR =
    /(['"`\s{(:,=])(#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?|(?:rgba?|hsla?)\([^)]*\))/gi;
  const FILES = [
    'frontend/src/components/scheduling/PublishedSwitch.jsx',
    'frontend/src/components/scheduling/AllowChangesDialog.jsx',
    'frontend/src/components/scheduling/GamePublishedBar.jsx',
    'frontend/src/components/scheduling/GameHistoryDialog.jsx',
    'frontend/src/utils/gamePublishedText.js',
  ];
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  it('finds the files and recognises a literal colour (the scan is not matching nothing)', () => {
    expect(readFileSync(path.join(root, FILES[0]), 'utf8').length).toBeGreaterThan(500);
    expect([...'color: #fff;'.matchAll(LITERAL_COLOUR)]).toHaveLength(1);
    expect([...'className="bg-bg-surface text-text-muted"'.matchAll(LITERAL_COLOUR)]).toHaveLength(
      0
    );
  });

  for (const file of FILES) {
    it(`${file} holds no literal colour and no inline style`, () => {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect([...text.matchAll(LITERAL_COLOUR)].map((m) => m[2])).toEqual([]);
      expect(text).not.toMatch(/style=\{\{/);
    });
  }
});
