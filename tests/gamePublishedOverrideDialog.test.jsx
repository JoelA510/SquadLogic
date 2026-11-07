/**
 * PR 3 task C3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.4 and 3.6; owner decision
 * 1): the "Allow changes" dialog. Turning Published off is deliberate and audited, so the dialog holds Confirm until
 * a reason from the closed list AND the tick are given, says why while it waits, sends nothing before Confirm, puts
 * focus on its heading and gives it back, shows a refusal as an alert, and carries the optional note with its helper
 * text and a counter of 200.
 *
 * The pattern is `GridOverrideDialog`'s (tests/gridOverridePrompt.test.jsx); the plant of this PR (Confirm enabled
 * with no reason) turns the "Confirm is disabled until a reason" cases red.
 */
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import AllowChangesDialog from '../frontend/src/components/scheduling/AllowChangesDialog.jsx';
import { GAME_PUBLISH_NOTE_MAX, GAME_PUBLISH_REASONS } from '../packages/core/src/gamePublished.js';

const HELPER = 'Optional. Do not enter player names or other personal information.';

const game = (n) => ({
  id: `ga-${n}`,
  homeTeamName: `Synthetic Home ${n}`,
  awayTeamName: `Synthetic Away ${n}`,
  whenText: `Sat ${n}`,
});
const games = (count) => Array.from({ length: count }, (_, i) => game(i + 1));

function renderDialog(props = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <AllowChangesDialog
      open
      games={games(2)}
      busy={false}
      notice={null}
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />
  );
  return { ...view, onConfirm, onClose };
}

const noteField = () =>
  /** @type {HTMLTextAreaElement} */ (screen.getByLabelText('Note (optional)'));
const confirmButton = () => screen.getByRole('button', { name: 'Confirm and allow changes' });
const choose = (code) =>
  fireEvent.change(screen.getByLabelText('Reason for allowing changes'), {
    target: { value: code },
  });
const tick = () => fireEvent.click(screen.getByRole('checkbox'));

describe('what the dialog shows', () => {
  it('names how many games, lists them by name, and says what allowing changes does', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Allow changes to Published games' });
    expect(within(dialog).getByTestId('allow-changes-heading')).toHaveTextContent(
      'Allow changes to 2 Published games'
    );
    const listed = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(listed).toEqual([
      'Synthetic Home 1 vs Synthetic Away 1 · Sat 1',
      'Synthetic Home 2 vs Synthetic Away 2 · Sat 2',
    ]);
    expect(within(dialog).queryByTestId('allow-changes-more')).not.toBeInTheDocument();
    // Two meanings of "published" meet here (the switch and an export's baseline); the dialog says which is which.
    expect(dialog).toHaveTextContent(
      'The published baseline that an export records is a separate record of what went out, and it is not changed.'
    );
  });

  it('says "1 Published game" in the singular', () => {
    renderDialog({ games: games(1) });
    expect(screen.getByTestId('allow-changes-heading')).toHaveTextContent(
      'Allow changes to 1 Published game'
    );
    expect(screen.getByRole('checkbox')).toHaveAccessibleName(
      'I understand this game is no longer held in place until I publish it again.'
    );
  });

  it('lists the first ten games and counts the rest', () => {
    renderDialog({ games: games(574) });
    expect(screen.getByTestId('allow-changes-heading')).toHaveTextContent(
      'Allow changes to 574 Published games'
    );
    expect(within(screen.getByTestId('allow-changes-games')).getAllByRole('listitem')).toHaveLength(
      10
    );
    expect(screen.getByTestId('allow-changes-more')).toHaveTextContent('and 564 more');
  });

  it('says once, truthfully, that a game moved to another slot or week is a new record', () => {
    renderDialog();
    const note = screen.getByTestId('allow-changes-moved-note');
    expect(note).toHaveTextContent(/saved as a new game/);
    expect(note).toHaveTextContent(/starts not Published/);
    expect(note).toHaveTextContent(/history stays with the old record/);
    // It does not promise that anything survives the move.
    expect(note).not.toHaveTextContent(/keeps its history|history is kept|remains Published/i);
  });

  it('offers the closed list of reasons, "Published in error" among them, and nothing free-text', () => {
    renderDialog();
    const options = within(screen.getByLabelText('Reason for allowing changes'))
      .getAllByRole('option')
      .map((option) => [/** @type {HTMLOptionElement} */ (option).value, option.textContent]);
    expect(options).toEqual([
      ['', 'Choose a reason'],
      ...GAME_PUBLISH_REASONS.map((reason) => [reason.code, reason.label]),
    ]);
    expect(options.map(([code]) => code)).toContain('published-in-error');
  });
});

describe('Confirm waits for a reason AND the tick, and says why', () => {
  it('starts disabled, with the visible reason "Choose a reason."', () => {
    renderDialog();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent('Choose a reason.');
    expect(confirmButton()).toHaveAccessibleDescription(/Choose a reason\./);
  });

  it('a reason alone is not enough: still disabled, now asking for the tick', () => {
    const { onConfirm } = renderDialog();
    choose('coach-request');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent('Tick the box to confirm.');
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the tick alone is not enough: still disabled, still asking for a reason', () => {
    const { onConfirm } = renderDialog();
    tick();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent('Choose a reason.');
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('with both, Confirm is enabled and sends the reason and the note, once', () => {
    const { onConfirm } = renderDialog();
    choose('field-change');
    tick();
    expect(confirmButton()).toBeEnabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent(/^Ready/);
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Field 2 is closed' },
    });
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      reasonCode: 'field-change',
      note: 'Field 2 is closed',
    });
  });

  it('un-ticking, or choosing no reason again, holds Confirm again', () => {
    renderDialog();
    choose('other');
    tick();
    expect(confirmButton()).toBeEnabled();
    tick();
    expect(confirmButton()).toBeDisabled();
    tick();
    choose('');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent('Choose a reason.');
  });

  it('with no games it cannot be confirmed and says so', () => {
    renderDialog({ games: [] });
    choose('other');
    tick();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent(/no Published games here/);
  });

  it('while saving it holds everything and says Saving', () => {
    renderDialog({ busy: true });
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByLabelText('Reason for allowing changes')).toBeDisabled();
    expect(screen.getByTestId('allow-changes-why')).toHaveTextContent('Saving…');
  });

  it('Escape closes it, unless it is saving', () => {
    const first = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = renderDialog({ busy: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second.onClose).not.toHaveBeenCalled();
  });
});

describe('the optional note: helper text, a counter of 200, and no 201st character', () => {
  it('the helper text is rendered and is the note field’s description', () => {
    renderDialog();
    const note = noteField();
    expect(screen.getByTestId('allow-changes-note-help')).toHaveTextContent(HELPER);
    expect(screen.getByTestId('allow-changes-note-help').textContent).toBe(HELPER);
    expect(note).toHaveAccessibleDescription(expect.stringContaining(HELPER));
  });

  it('the counter starts at 0 / 200, follows what is typed, and is part of the description', () => {
    renderDialog();
    const note = noteField();
    expect(screen.getByTestId('allow-changes-note-count')).toHaveTextContent('0 / 200');
    fireEvent.change(note, { target: { value: 'twelve chars' } });
    expect(screen.getByTestId('allow-changes-note-count')).toHaveTextContent('12 / 200');
    expect(note).toHaveAccessibleDescription(expect.stringContaining('12 / 200'));
    expect(GAME_PUBLISH_NOTE_MAX).toBe(200);
  });

  it('a 200-character note is accepted whole', () => {
    renderDialog();
    const note = noteField();
    fireEvent.change(note, { target: { value: 'a'.repeat(200) } });
    expect(note.value).toHaveLength(200);
    expect(screen.getByTestId('allow-changes-note-count')).toHaveTextContent('200 / 200');
  });

  it('a 201st character is not accepted (typed or pasted)', () => {
    renderDialog();
    const note = noteField();
    fireEvent.change(note, { target: { value: 'a'.repeat(200) } });
    fireEvent.change(note, { target: { value: `${'a'.repeat(200)}b` } });
    expect(note.value).toBe('a'.repeat(200));
    fireEvent.change(note, { target: { value: 'c'.repeat(500) } });
    expect(note.value).toBe('c'.repeat(200));
    expect(screen.getByTestId('allow-changes-note-count')).toHaveTextContent('200 / 200');
  });

  it('counts characters the way the database does (code points, not UTF-16 units)', () => {
    renderDialog();
    const note = noteField();
    // 150 emoji are 300 UTF-16 units and 150 characters: the database accepts them.
    fireEvent.change(note, { target: { value: '\u{1F600}'.repeat(150) } });
    expect([...note.value]).toHaveLength(150);
    expect(screen.getByTestId('allow-changes-note-count')).toHaveTextContent('150 / 200');
    fireEvent.change(note, { target: { value: '\u{1F600}'.repeat(250) } });
    expect([...note.value]).toHaveLength(200);
  });

  it('the note is optional: a reason and the tick are enough', () => {
    const { onConfirm } = renderDialog();
    choose('conflict-fix');
    tick();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ reasonCode: 'conflict-fix', note: '' });
  });

  it('says the note is kept in the audit history, so the helper text is not mistaken for a guarantee', () => {
    renderDialog();
    expect(screen.getByText(/kept in the audit history/)).toBeInTheDocument();
  });
});

describe('a refusal after Confirm stays in the dialog, as an alert', () => {
  it('shows the database’s words in an alert and moves focus to it', () => {
    renderDialog({
      notice: {
        tone: 'alert',
        text: 'game 11111111-1111-4111-8111-111111111111 does not exist in this organization',
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/does not exist in this organization/);
    expect(alert).toHaveFocus();
  });

  it('no notice, no alert', () => {
    renderDialog();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('focus goes to the heading and back to what opened the dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open the dialog
        </button>
        {open && (
          <AllowChangesDialog
            open
            games={games(1)}
            busy={false}
            notice={null}
            onConfirm={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  it('heading on open, the opener on Cancel', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open the dialog' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByTestId('allow-changes-heading')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('choosing a reason or typing a note never moves focus off the control being used', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open the dialog' });
    opener.focus();
    fireEvent.click(opener);
    const note = noteField();
    note.focus();
    fireEvent.change(note, { target: { value: 'typing' } });
    expect(note).toHaveFocus();
    const reason = screen.getByLabelText('Reason for allowing changes');
    reason.focus();
    choose('other');
    expect(reason).toHaveFocus();
  });
});
