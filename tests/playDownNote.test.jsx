/**
 * What the Teams page says about whether play-down is available, from the one place that words it
 * (`playDownNote.js`; play-down plan, 2026-11-03, PR 3). The Play-up section's sentence takes the
 * Play-down setting as a boolean the page reads once; off is the default and the words it has always
 * carried. The page test (`playDownSetting.test.jsx`) shows the setting reaching it from a stored
 * value; this file holds the component to the words in both states.
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PlayUpList from '../frontend/src/components/teaming/PlayUpList.jsx';
import { playUpPlaysWhereNote } from '../frontend/src/utils/playDownNote.js';

afterEach(() => cleanup());

const results = {
  playUpByDivision: {
    U10: [
      {
        playerId: 'p1',
        name: 'Pia',
        kind: 'play-up',
        requested: true,
        naturalAge: 9,
        registeredDivision: 'U10',
        registeredDivisionName: 'U10',
        playedDivision: 'U10',
        playedDivisionName: 'U10',
        coachId: null,
        buddyId: null,
      },
    ],
  },
};
const sentence = () =>
  /** @type {HTMLElement} */ (document.querySelector('#play-up-heading + p')).textContent;

describe('the words', () => {
  it('name where a play-down plays only while the setting is on', () => {
    expect(playUpPlaysWhereNote(false)).toBe(
      'players play in their own age division unless a play-up was requested'
    );
    expect(playUpPlaysWhereNote(true)).toBe(
      'players play in their own age division unless a play-up was requested or, with Play-down on, they registered in a younger division'
    );
  });
});

describe('the Play-up section sentence', () => {
  it('is the one it always was by default, and when the setting is off', () => {
    render(<PlayUpList results={results} />);
    expect(sentence()).toContain(
      "Nothing here is approved or refused: players play in their own age division unless a play-up was requested. Check each against your club's rules."
    );
    cleanup();
    render(<PlayUpList results={results} playDown={false} />);
    expect(sentence()).not.toContain('with Play-down on');
  });

  it('says where a play-down plays while the setting is on', () => {
    render(<PlayUpList results={results} playDown />);
    expect(sentence()).toContain(
      `Nothing here is approved or refused: ${playUpPlaysWhereNote(true)}. Check each against your club's rules.`
    );
  });

  it('words a play-down the setting seated where it registered, and a held seat, in plain words', () => {
    const rows = {
      playUpByDivision: {
        U10: [
          { ...results.playUpByDivision.U10[0], playerId: 'a', name: 'Alex', kind: 'play-down' },
          {
            ...results.playUpByDivision.U10[0],
            playerId: 'b',
            name: 'Blake',
            kind: 'play-down',
            playedDivision: 'U12',
            playedDivisionName: 'U12',
          },
          {
            ...results.playUpByDivision.U10[0],
            playerId: 'c',
            name: 'Casey',
            kind: 'play-up',
            requested: false,
            heldSeat: true,
            ruleDivision: 'U12',
            ruleDivisionName: 'U12',
          },
        ],
      },
    };
    render(<PlayUpList results={rows} playDown />);
    const text = (name) =>
      /** @type {HTMLElement} */ (
        [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(name))
      ).textContent;
    expect(text('Alex')).toContain('Plays in U10, the younger division they registered for.');
    expect(text('Blake')).toContain('Registered in U10 but plays in U12.');
    expect(text('Casey')).toContain(
      'Stays on the roster they are on in U10: a team that exists is not reshuffled. A new roster would place them in U12.'
    );
  });
});
